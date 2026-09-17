/**
 * PostgreSQL-backed `EventStore` (SPEC.md §6 "Storage": "Postgres is a
 * documented follow-up behind the same interface"). Uses the `pg` package
 * (`^8`) against a plain connection string (`TRACERY_POSTGRES_URL`).
 *
 * Mirrors `SqliteStore`'s design (see `./sqlite.ts`'s module doc first):
 *
 * - Events are the durable source of truth, one row per event, in an
 *   `events` table.
 * - Flow/trace reduction is kept as an in-memory index (the exact same
 *   `@atriarch/tracery-core` `buildFlow`/`buildFlows`/`assembleTrace`
 *   reduction `MemoryStore` and `SqliteStore` use) AND materialised into a
 *   `flows` table, one row per flow, kept current incrementally on every
 *   write -- so `listFlows`/`flowSummary` are genuinely SQL-backed (indexed
 *   `WHERE`/`ORDER BY`) and a reconnecting store restores its in-memory
 *   index in O(flows), not O(events).
 * - A `schema_version` table records the materialised `flows` table's
 *   row shape; a missing table or a version mismatch triggers a one-time
 *   O(events) rebuild from `events`, exactly like `SqliteStore`.
 * - `append` (and, for the same reason, `deleteFlow` and `sweep`) runs its
 *   writes inside one `BEGIN`/COMMIT` transaction, so an event batch's rows
 *   and the flow rows it materialises land together or not at all. Every
 *   query is parameterised (`$1`, `$2`, ...) -- no interpolated values.
 *
 * Unlike `SqliteStore` (whose constructor is synchronous, because
 * `node:sqlite` is), opening a Postgres connection is inherently
 * asynchronous, so there is no plain `new PostgresStore(...)`: use the
 * static `PostgresStore.connect(url)` factory instead.
 *
 * All tables for one store instance live in a single Postgres *schema*
 * (namespace) -- `public` by default, overridable via `PostgresStoreOptions.
 * schema` -- so several independent stores (e.g. one per test) can share one
 * Postgres server without seeing each other's data or colliding on table
 * names.
 */
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { buildFlow, buildFlows, assembleTrace, type Flow } from '@atriarch/tracery-core';
import type { ActivityEvent, ActivityFrame, StoredEvent } from '@atriarch/tracery-core/contract';
import { buildFrame } from './frame.js';
import { resolveTraceIds } from './trace-ids.js';
import { isSweepProtected, isOverRetention, orderSweepCandidates, type SweepCandidate } from './sweep.js';
import {
  flowFromSummary,
  toFlowSummary,
  type AppendResult,
  type EventStore,
  type FlowSummary,
  type ListFlowsQuery,
  type ListFlowsResult,
  type StoreSubscriber,
  type SweepOptions,
  type SweepResult,
  type TraceSummary,
  type Unsubscribe,
  type WorkspaceStats,
} from './types.js';

// `pg` is CommonJS; under NodeNext + verbatimModuleSyntax the reliable way to
// get its runtime value is a default import destructured after the fact --
// `import { Pool } from 'pg'` depends on Node's CJS-named-export detection,
// which is not guaranteed for every build of `pg`. Types come from a
// separate `import type`, which is erased before runtime and so is
// unaffected by that concern.
const { Pool: PoolCtor } = pg;

/** Bump when the `flows` table's columns or `data_json` shape change; `load()` rebuilds from events on a mismatch. Intentionally the same value as `SqliteStore.FLOWS_SCHEMA_VERSION` -- both stores materialise the identical `FlowSummary` row shape. */
const FLOWS_SCHEMA_VERSION = 1;
const FLOWS_SCHEMA_VERSION_KEY = 'flows_schema_version';

/** Postgres identifiers (schema/table/index names) can't be parameterised -- they have to be interpolated into the SQL text. This is the only user-influenced identifier (`PostgresStoreOptions.schema`), so it's validated against a safe charset before ever reaching a query string. */
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(name: string, what: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`${what} must match ${IDENT_RE.source}, got ${JSON.stringify(name)}`);
  return name;
}

interface WorkspaceState {
  events: StoredEvent[];
  eventsById: Map<string, StoredEvent>;
  eventsByFlow: Map<string, StoredEvent[]>;
  flows: Map<string, Flow>;
  floorCursor: number | undefined;
}

interface EventRow {
  cursor: string;
  workspace: string;
  id: string;
  flow: string;
  /** `jsonb` column: the driver already parses this into a plain object. */
  json: StoredEvent;
}

interface FlowRow {
  workspace: string;
  /** `jsonb` column: the driver already parses this into a plain object. */
  data_json: FlowSummary;
}

/** Union of every op's tags in a flow, deduped and sorted for a deterministic `tags_json` column -- same as `SqliteStore`. */
function collectTags(flow: Flow): string[] {
  const tags = new Set<string>();
  for (const op of flow.ops.values()) for (const tag of op.tags) tags.add(tag);
  return [...tags].sort();
}

/** The node of the op whose `start` declared `root: true` (SPEC.md §1 "Flow"); `undefined` for a partial flow with no root start yet. */
function rootNodeOf(flow: Flow): string | undefined {
  for (const op of flow.ops.values()) if (op.root) return op.node;
  return undefined;
}

/** Escapes `%`, `_` and `\` so a user-supplied `q` substring is matched literally by `ILIKE ... ESCAPE '\'`. */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface PostgresStoreOptions {
  /** Postgres schema (namespace) to create/use for all of this store's tables. Defaults to `public`. Lets several isolated stores share one Postgres server -- used by the store-contract test suite so each test gets its own tables without a fresh container per test. */
  readonly schema?: string;
}

export class PostgresStore implements EventStore {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly subscribers = new Set<StoreSubscriber>();
  private cursor = 0;
  private readonly pool: Pool;
  private readonly schema: string;

  private constructor(pool: Pool, schema: string) {
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Opens a connection pool, ensures the schema/tables exist (rebuilding the
   * materialised `flows` table from `events` when needed), restores the
   * in-memory flow index, and returns a ready-to-use store. Postgres
   * connections are inherently async, so this stands in for the synchronous
   * constructor `MemoryStore`/`SqliteStore` have.
   */
  static async connect(connectionString: string, options: PostgresStoreOptions = {}): Promise<PostgresStore> {
    const schema = assertIdent(options.schema ?? 'public', 'PostgresStoreOptions.schema');
    const pool = new PoolCtor({ connectionString });
    const store = new PostgresStore(pool, schema);
    try {
      await store.init();
    } catch (err) {
      await pool.end().catch(() => {});
      throw err;
    }
    return store;
  }

  /** Schema-qualifies a table name for interpolation into SQL text (never a query parameter -- Postgres can't parameterise identifiers). `this.schema` was validated against `IDENT_RE` in `connect`. */
  private t(name: string): string {
    return `"${this.schema}"."${name}"`;
  }

  private async init(): Promise<void> {
    const client = await this.pool.connect();
    let needsFlowsRebuild: boolean;
    try {
      await client.query('BEGIN');
      needsFlowsRebuild = await this.ensureSchema(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await this.load(needsFlowsRebuild);
  }

  private async tableExists(client: PoolClient, name: string): Promise<boolean> {
    const { rows } = await client.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [
      this.schema,
      name,
    ]);
    return rows.length > 0;
  }

  private async readSchemaVersion(client: PoolClient): Promise<string | undefined> {
    const { rows } = await client.query(`SELECT value FROM ${this.t('schema_version')} WHERE key = $1`, [FLOWS_SCHEMA_VERSION_KEY]);
    return (rows[0] as { value: string } | undefined)?.value;
  }

  private async writeSchemaVersion(client: PoolClient, value: string): Promise<void> {
    await client.query(
      `INSERT INTO ${this.t('schema_version')} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [FLOWS_SCHEMA_VERSION_KEY, value],
    );
  }

  /**
   * Creates the schema and every table/index if they don't already exist,
   * and returns whether the materialised `flows` table needs a one-time
   * rebuild from `events` -- mirrors `SqliteStore`'s constructor-time check:
   * true when `flows` didn't exist yet (a brand-new schema, or one created
   * before this table existed) or its recorded `schema_version` doesn't
   * match `FLOWS_SCHEMA_VERSION` (a future row-shape change). On a version
   * mismatch the stale table is dropped first so the `CREATE TABLE` below
   * lays down the current column set.
   */
  private async ensureSchema(client: PoolClient): Promise<boolean> {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);

    const flowsTableExisted = await this.tableExists(client, 'flows');
    const schemaVersionTableExisted = await this.tableExists(client, 'schema_version');

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.t('schema_version')} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const storedVersion = schemaVersionTableExisted ? await this.readSchemaVersion(client) : undefined;
    const needsFlowsRebuild = !flowsTableExisted || storedVersion !== String(FLOWS_SCHEMA_VERSION);
    if (needsFlowsRebuild && flowsTableExisted) await client.query(`DROP TABLE IF EXISTS ${this.t('flows')}`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.t('events')} (
        cursor BIGINT PRIMARY KEY,
        workspace TEXT NOT NULL,
        id TEXT NOT NULL,
        flow TEXT NOT NULL,
        json JSONB NOT NULL,
        UNIQUE (workspace, id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_workspace_flow ON ${this.t('events')} (workspace, flow)`);

    // hub-6 (see SqliteStore): persists the eviction floor per workspace so a
    // restart doesn't forget what the sweeper (or an admin delete) already
    // dropped.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.t('workspace_meta')} (
        workspace TEXT PRIMARY KEY,
        floor_cursor BIGINT
      )
    `);

    // hub-22 (see SqliteStore): materialised flow index. `data_json` is the
    // full `FlowSummary` (ops/nodes/edges included); the other columns exist
    // so `listFlows`/`flowSummary` can filter, sort and page in SQL without
    // deserialising every candidate row first.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.t('flows')} (
        workspace TEXT NOT NULL,
        id TEXT NOT NULL,
        trace TEXT NOT NULL,
        label TEXT NOT NULL,
        actor_id TEXT,
        actor_kind TEXT,
        status TEXT NOT NULL,
        partial BOOLEAN NOT NULL,
        started_at BIGINT,
        ended_at BIGINT,
        first_cursor BIGINT NOT NULL,
        last_cursor BIGINT NOT NULL,
        tags_json JSONB NOT NULL,
        root_node TEXT,
        data_json JSONB NOT NULL,
        PRIMARY KEY (workspace, id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flows_workspace_last_cursor ON ${this.t('flows')} (workspace, last_cursor)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flows_workspace_status ON ${this.t('flows')} (workspace, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flows_workspace_actor ON ${this.t('flows')} (workspace, actor_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_flows_workspace_trace ON ${this.t('flows')} (workspace, trace)`);

    return needsFlowsRebuild;
  }

  /** Mirrors `SqliteStore.load`: restores `events` fully into memory (other read paths need the raw events), then either rebuilds the flow index from them (O(events), once) or loads it straight from the materialised `flows` table (O(flows), the common case). */
  private async load(needsFlowsRebuild: boolean): Promise<void> {
    const { rows: eventRows } = await this.pool.query<EventRow>(
      `SELECT cursor, workspace, id, flow, json FROM ${this.t('events')} ORDER BY cursor ASC`,
    );
    for (const row of eventRows) {
      const stored = row.json;
      const state = this.state(row.workspace);
      state.eventsById.set(row.id, stored);
      state.events.push(stored);
      const forFlow = state.eventsByFlow.get(row.flow);
      if (forFlow) forFlow.push(stored);
      else state.eventsByFlow.set(row.flow, [stored]);
      if (stored.cursor > this.cursor) this.cursor = stored.cursor;
    }

    const { rows: metaRows } = await this.pool.query<{ workspace: string; floor_cursor: string | null }>(
      `SELECT workspace, floor_cursor FROM ${this.t('workspace_meta')}`,
    );
    for (const row of metaRows) {
      if (row.floor_cursor === null) continue;
      this.state(row.workspace).floorCursor = Number(row.floor_cursor);
    }

    if (needsFlowsRebuild) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const [workspace, state] of this.workspaces) {
          state.flows = new Map(buildFlows(state.events));
          for (const flowId of state.flows.keys()) await this.persistFlowRow(client, workspace, state, flowId);
        }
        await this.writeSchemaVersion(client, String(FLOWS_SCHEMA_VERSION));
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      const { rows: flowRows } = await this.pool.query<FlowRow>(`SELECT workspace, data_json FROM ${this.t('flows')}`);
      for (const row of flowRows) {
        const flow = flowFromSummary(row.data_json);
        this.state(row.workspace).flows.set(flow.id, flow);
      }
    }
  }

  private async persistFloorCursor(client: PoolClient, workspace: string, floorCursor: number | undefined): Promise<void> {
    await client.query(
      `INSERT INTO ${this.t('workspace_meta')} (workspace, floor_cursor) VALUES ($1, $2)
       ON CONFLICT (workspace) DO UPDATE SET floor_cursor = excluded.floor_cursor`,
      [workspace, floorCursor ?? null],
    );
  }

  /** Upserts one flow's `flows` row from the current in-memory `state.flows`/`state.eventsByFlow` (or deletes the row if the flow no longer exists in memory) -- same shape as `SqliteStore.persistFlowRow`. */
  private async persistFlowRow(client: PoolClient, workspace: string, state: WorkspaceState, flowId: string): Promise<void> {
    const flow = state.flows.get(flowId);
    if (!flow) {
      await client.query(`DELETE FROM ${this.t('flows')} WHERE workspace = $1 AND id = $2`, [workspace, flowId]);
      return;
    }
    const events = state.eventsByFlow.get(flowId);
    const firstCursor = events && events.length > 0 ? events[0]!.cursor : 0;
    const lastCursor = events && events.length > 0 ? events[events.length - 1]!.cursor : 0;
    await client.query(
      `INSERT INTO ${this.t('flows')}
         (workspace, id, trace, label, actor_id, actor_kind, status, partial, started_at, ended_at, first_cursor, last_cursor, tags_json, root_node, data_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (workspace, id) DO UPDATE SET
         trace = excluded.trace, label = excluded.label, actor_id = excluded.actor_id, actor_kind = excluded.actor_kind,
         status = excluded.status, partial = excluded.partial, started_at = excluded.started_at, ended_at = excluded.ended_at,
         first_cursor = excluded.first_cursor, last_cursor = excluded.last_cursor, tags_json = excluded.tags_json,
         root_node = excluded.root_node, data_json = excluded.data_json`,
      [
        workspace,
        flow.id,
        flow.trace,
        flow.label,
        flow.actor?.id ?? null,
        flow.actor?.kind ?? null,
        flow.status,
        flow.partial,
        flow.startedAt ?? null,
        flow.endedAt ?? null,
        firstCursor,
        lastCursor,
        JSON.stringify(collectTags(flow)),
        rootNodeOf(flow) ?? null,
        JSON.stringify(toFlowSummary(flow)),
      ],
    );
  }

  private async persistFlowRows(client: PoolClient, workspace: string, state: WorkspaceState, flowIds: ReadonlySet<string>): Promise<void> {
    for (const flowId of flowIds) await this.persistFlowRow(client, workspace, state, flowId);
  }

  private state(workspace: string): WorkspaceState {
    let state = this.workspaces.get(workspace);
    if (!state) {
      state = { events: [], eventsById: new Map(), eventsByFlow: new Map(), flows: new Map(), floorCursor: undefined };
      this.workspaces.set(workspace, state);
    }
    return state;
  }

  /** hub-2 (see `MemoryStore`/`SqliteStore`): re-reduces only `touchedFlowIds` via core's single-flow `buildFlow`, then re-resolves trace ids for the whole workspace -- O(#flows), not O(#events). Purely in-memory; callers persist the returned dirty ids afterwards. */
  private reduceTouchedFlows(state: WorkspaceState, touchedFlowIds: ReadonlySet<string>): Set<string> {
    const dirty = new Set<string>();
    for (const flowId of touchedFlowIds) {
      const flowEvents = state.eventsByFlow.get(flowId);
      if (flowEvents && flowEvents.length > 0) {
        state.flows.set(flowId, buildFlow(flowEvents));
        dirty.add(flowId);
      }
    }
    for (const id of this.reResolveTraceIds(state)) dirty.add(id);
    return dirty;
  }

  /** Returns the ids of every flow whose resolved `trace` changed. */
  private reResolveTraceIds(state: WorkspaceState): Set<string> {
    const traceIds = resolveTraceIds(state.flows);
    const changed = new Set<string>();
    for (const [id, flow] of state.flows) {
      const trace = traceIds.get(id)!;
      if (flow.trace !== trace) {
        state.flows.set(id, { ...flow, trace });
        changed.add(id);
      }
    }
    return changed;
  }

  private lastSeenAt(state: WorkspaceState, flowId: string): number {
    const events = state.eventsByFlow.get(flowId);
    if (!events || events.length === 0) return Number.NEGATIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const event of events) if (event.receivedAt > max) max = event.receivedAt;
    return max;
  }

  /** Removes a flow's events and `flows` row (DB + in-memory index) without re-resolving trace ids -- callers batch that and persist it themselves (see `deleteFlow`, `sweep`). Must run inside the caller's transaction. */
  private async removeFlowEvents(client: PoolClient, workspace: string, state: WorkspaceState, flowId: string): Promise<boolean> {
    const flowEvents = state.eventsByFlow.get(flowId);
    if (!flowEvents) return false;

    await client.query(`DELETE FROM ${this.t('events')} WHERE workspace = $1 AND flow = $2`, [workspace, flowId]);
    await client.query(`DELETE FROM ${this.t('flows')} WHERE workspace = $1 AND id = $2`, [workspace, flowId]);

    for (const event of flowEvents) state.eventsById.delete(event.id);
    state.eventsByFlow.delete(flowId);
    const removedIds = new Set(flowEvents.map((event) => event.id));
    state.events = state.events.filter((event) => !removedIds.has(event.id));
    state.flows.delete(flowId);

    state.floorCursor = state.events.length > 0 ? state.events[0]!.cursor : this.cursor;
    await this.persistFloorCursor(client, workspace, state.floorCursor);
    return true;
  }

  /**
   * Appends already-validated events, deduplicating by `(workspace, id)` (an
   * in-memory check against `state.eventsById`, exactly like `MemoryStore`/
   * `SqliteStore` -- no round trip needed to detect a duplicate). The
   * in-memory state is updated first, then every accepted event's row and
   * every flow row it touched (directly, or via a late-parent trace
   * correction) are written inside a single `BEGIN`/`COMMIT` transaction, so
   * the batch's events and their materialised flow rows are durable
   * together or not at all. (A failure between the in-memory update and the
   * `COMMIT` -- a dropped connection mid-batch -- leaves memory ahead of
   * disk until the process restarts and reloads from `events`; this is the
   * same category of risk `SqliteStore` already carries for a mid-write
   * crash, not a new one introduced here.)
   */
  async append(workspace: string, events: readonly ActivityEvent[]): Promise<AppendResult> {
    const state = this.state(workspace);
    const accepted: StoredEvent[] = [];
    let duplicates = 0;
    const touchedFlows = new Set<string>();

    for (const event of events) {
      if (state.eventsById.has(event.id)) {
        duplicates++;
        continue;
      }
      this.cursor += 1;
      const stored: StoredEvent = { ...event, workspace, cursor: this.cursor, receivedAt: Date.now() };
      state.eventsById.set(event.id, stored);
      state.events.push(stored);
      const forFlow = state.eventsByFlow.get(event.flow);
      if (forFlow) forFlow.push(stored);
      else state.eventsByFlow.set(event.flow, [stored]);
      accepted.push(stored);
      touchedFlows.add(event.flow);
    }

    if (accepted.length > 0) {
      const dirty = this.reduceTouchedFlows(state, touchedFlows);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const stored of accepted) {
          await client.query(`INSERT INTO ${this.t('events')} (cursor, workspace, id, flow, json) VALUES ($1, $2, $3, $4, $5)`, [
            stored.cursor,
            workspace,
            stored.id,
            stored.flow,
            JSON.stringify(stored),
          ]);
        }
        await this.persistFlowRows(client, workspace, state, dirty);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      for (const event of accepted) for (const subscriber of this.subscribers) subscriber(event);
    }

    return { accepted, duplicates, cursor: this.cursor };
  }

  private floorInfo(state: WorkspaceState): { floorCursor: number | undefined } {
    return { floorCursor: state.floorCursor };
  }

  async flowEvents(workspace: string, flowId: string, after?: number): Promise<ActivityFrame> {
    const state = this.state(workspace);
    const scoped = state.eventsByFlow.get(flowId) ?? [];
    return buildFrame(scoped, this.cursor, this.floorInfo(state), after);
  }

  async traceEvents(workspace: string, traceId: string): Promise<readonly StoredEvent[]> {
    const state = this.state(workspace);
    const memberFlowIds = [...state.flows.values()].filter((flow) => flow.trace === traceId).map((flow) => flow.id);
    const events: StoredEvent[] = [];
    for (const id of memberFlowIds) events.push(...(state.eventsByFlow.get(id) ?? []));
    events.sort((a, b) => a.cursor - b.cursor);
    return events;
  }

  async traceFrame(workspace: string, traceId: string, after?: number): Promise<ActivityFrame> {
    const scoped = await this.traceEvents(workspace, traceId);
    const state = this.state(workspace);
    return buildFrame(scoped, this.cursor, this.floorInfo(state), after);
  }

  async workspaceFrame(workspace: string, after?: number): Promise<ActivityFrame> {
    const state = this.state(workspace);
    return buildFrame(state.events, this.cursor, this.floorInfo(state), after);
  }

  /** SQL-backed (mirrors `SqliteStore`): filters, sorts and pages entirely in the `flows` table via parameterised `WHERE`/`ORDER BY` -- no in-memory flow scan. */
  async listFlows(workspace: string, query: ListFlowsQuery): Promise<ListFlowsResult> {
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 1000) : 50;

    const conditions = ['workspace = $1'];
    const params: (string | number)[] = [workspace];
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.actor) {
      params.push(query.actor);
      conditions.push(`actor_id = $${params.length}`);
    }
    if (query.trace) {
      params.push(query.trace);
      conditions.push(`trace = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${escapeLikePattern(query.q)}%`);
      conditions.push(`label ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (query.before !== undefined) {
      params.push(Number(query.before));
      conditions.push(`last_cursor < $${params.length}`);
    }

    params.push(limit);
    const sql = `SELECT data_json, last_cursor FROM ${this.t('flows')} WHERE ${conditions.join(' AND ')} ORDER BY last_cursor DESC LIMIT $${params.length}`;
    const { rows } = await this.pool.query<{ data_json: FlowSummary; last_cursor: string }>(sql, params);

    const flows = rows.map((row) => row.data_json);
    const nextBefore = rows.length === limit && rows.length > 0 ? String(rows[rows.length - 1]!.last_cursor) : undefined;

    return { flows, nextBefore };
  }

  /** SQL-backed (mirrors `SqliteStore`): a single indexed row lookup, not a `state.flows.get` + conversion. */
  async flowSummary(workspace: string, flowId: string): Promise<FlowSummary | undefined> {
    const { rows } = await this.pool.query<{ data_json: FlowSummary }>(`SELECT data_json FROM ${this.t('flows')} WHERE workspace = $1 AND id = $2`, [
      workspace,
      flowId,
    ]);
    return rows[0]?.data_json;
  }

  async getTrace(workspace: string, traceId: string): Promise<TraceSummary | undefined> {
    const state = this.state(workspace);
    const trace = assembleTrace(state.flows, traceId);
    if (trace.flows.length === 0) return undefined;
    return { root: trace.root, flows: trace.flows.map(toFlowSummary), links: trace.links, missing: trace.missing };
  }

  async deleteFlow(workspace: string, flowId: string): Promise<boolean> {
    const state = this.state(workspace);
    if (!state.eventsByFlow.has(flowId)) return false;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const removed = await this.removeFlowEvents(client, workspace, state, flowId);
      if (removed) {
        // a deleted parent's children may need a new placeholder trace id
        const dirty = this.reResolveTraceIds(state);
        await this.persistFlowRows(client, workspace, state, dirty);
      }
      await client.query('COMMIT');
      return removed;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  subscribe(subscriber: StoreSubscriber): Unsubscribe {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  async sweep(now: number, options: SweepOptions): Promise<SweepResult> {
    const cutoff = now - options.retentionMs;
    let sweptFlows = 0;
    let sweptEvents = 0;

    for (const [workspace, state] of this.workspaces) {
      const withLastSeen: SweepCandidate[] = [...state.flows.values()].map((flow) => ({
        flow,
        lastSeenAt: this.lastSeenAt(state, flow.id),
      }));
      const candidates = orderSweepCandidates(withLastSeen.filter((c) => !isSweepProtected(c, cutoff)));

      let totalEvents = state.events.length;
      const toRemove: string[] = [];
      for (const candidate of candidates) {
        const overCount = totalEvents > options.maxEventsPerWorkspace;
        // Candidates are ordered oldest-first within (complete, then running/unknown)
        // groups, not globally by age, so a candidate that doesn't qualify yet must
        // not stop the loop -- a later, older candidate in the other group might.
        if (!isOverRetention(candidate, cutoff) && !overCount) continue;

        const count = state.eventsByFlow.get(candidate.flow.id)?.length ?? 0;
        toRemove.push(candidate.flow.id);
        totalEvents -= count;
        sweptEvents += count;
      }

      if (toRemove.length === 0) continue;

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const flowId of toRemove) await this.removeFlowEvents(client, workspace, state, flowId);
        const dirty = this.reResolveTraceIds(state);
        await this.persistFlowRows(client, workspace, state, dirty);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      sweptFlows += toRemove.length;
    }

    return { sweptFlows, sweptEvents };
  }

  async stats(): Promise<readonly WorkspaceStats[]> {
    const result: WorkspaceStats[] = [];
    for (const [workspace, state] of this.workspaces) {
      result.push({
        workspace,
        events: state.events.length,
        flows: state.flows.size,
        oldestEventAt: state.events[0]?.ts,
        newestEventAt: state.events[state.events.length - 1]?.ts,
      });
    }
    return result;
  }

  async close(): Promise<void> {
    this.subscribers.clear();
    await this.pool.end();
  }
}
