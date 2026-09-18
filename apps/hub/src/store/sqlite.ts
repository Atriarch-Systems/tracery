/**
 * SQLite-backed `EventStore` (SPEC.md §6 "Storage"), using Node's built-in
 * `node:sqlite` (`DatabaseSync`, WAL mode). Events are the durable source of
 * truth, persisted one row per event. Flow/trace reduction is kept as an
 * in-memory index (identical algorithm to `MemoryStore`, built from
 * `@atriarch/tracery-core`'s `buildFlow`/`buildFlows` and `assembleTrace`)
 * so `listFlows` and friends never touch disk on the read path -- but unlike
 * `MemoryStore`, that index is ALSO materialised into a `flows` table (hub-22),
 * one row per flow, kept current incrementally on every write the exact same
 * way the in-memory index is (via core's single-flow `buildFlow` fast path on
 * the touched flow(s), plus whichever other flows' `trace` the late-parent
 * correction actually changed -- see `reduceTouchedFlows`/`reResolveTraceIds`).
 *
 * That materialised table is what makes `listFlows`/`flowSummary` genuinely
 * SQL-backed (indexed `WHERE`/`ORDER BY`, not an in-memory array scan) and,
 * more importantly, what lets `load()` restore the in-memory flow index on
 * boot in O(flows) -- one row read + `JSON.parse` per flow -- instead of
 * O(events): re-deriving every flow from its entire event history via
 * `buildFlows(state.events)`, as this store used to do (and as `MemoryStore`,
 * which has no disk to persist a materialised index to, still must). The
 * events table is still scanned into memory at boot (`flowEvents`/
 * `traceEvents`/`workspaceFrame`/sweep candidates need the raw events), but
 * that scan no longer feeds a `buildFlows` reduction -- it is cheap
 * object-copy work, not graph reduction over the whole retained log.
 *
 * If the `flows` table is missing (a database written before hub-22) or its
 * schema-version row doesn't match `FLOWS_SCHEMA_VERSION` (a future format
 * change), `load()` falls back to the old O(events) `buildFlows` reduction
 * once, then repopulates `flows` from the result so every later boot is fast
 * again.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
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
import {
  generateShareId,
  generateShareToken,
  type CreateShareInput,
  type ListSharesQuery,
  type ShareRecord,
  type SharePreviewData,
  type ShareStore,
  type ShareTargetType,
} from './share-types.js';

/** Bump when the `flows` table's columns or `data_json` shape change; `load()` rebuilds from events on a mismatch. */
const FLOWS_SCHEMA_VERSION = 1;
const FLOWS_SCHEMA_VERSION_KEY = 'flows_schema_version';

interface WorkspaceState {
  events: StoredEvent[];
  eventsById: Map<string, StoredEvent>;
  eventsByFlow: Map<string, StoredEvent[]>;
  flows: Map<string, Flow>;
  floorCursor: number | undefined;
}

interface EventRow {
  cursor: number;
  workspace: string;
  id: string;
  flow: string;
  json: string;
}

interface FlowRow {
  workspace: string;
  data_json: string;
}

/** Union of every op's tags in a flow, deduped and sorted for a deterministic `tags_json` column. */
function collectTags(flow: Flow): string[] {
  const tags = new Set<string>();
  for (const op of flow.ops.values()) for (const tag of op.tags) tags.add(tag);
  return [...tags].sort();
}

/** The node of the op whose `start` declared `root: true` -- ops are keyed in event-processing order, so the first one found is the flow's actual root (SPEC.md §1 "Flow"). `undefined` for a partial flow with no root start yet. */
function rootNodeOf(flow: Flow): string | undefined {
  for (const op of flow.ops.values()) if (op.root) return op.node;
  return undefined;
}

/** Escapes `%`, `_` and `\` so a user-supplied `q` substring is matched literally by SQL `LIKE ... ESCAPE '\'`. */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface ShareRow {
  id: string;
  token: string;
  workspace: string;
  target_type: string;
  target_id: string;
  mode: string;
  snapshot_cursor: number | null;
  include_context: number;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  preview_content_type: string | null;
  preview_bytes: number | null;
}

function shareRowToRecord(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    token: row.token,
    workspace: row.workspace,
    target: { type: row.target_type as ShareTargetType, id: row.target_id },
    mode: row.mode as ShareRecord['mode'],
    snapshotCursor: row.snapshot_cursor ?? undefined,
    includeContext: row.include_context === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    preview:
      row.preview_content_type !== null && row.preview_bytes !== null
        ? { contentType: 'image/png', bytes: row.preview_bytes }
        : null,
  };
}

export class SqliteStore implements EventStore, ShareStore {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly subscribers = new Set<StoreSubscriber>();
  private cursor = 0;
  private readonly db: DatabaseSync;

  private readonly insertEventStmt;
  private readonly upsertFlowStmt;
  private readonly deleteFlowRowStmt;
  private readonly flowSummaryStmt;
  private readonly insertShareStmt;
  private readonly shareByTokenStmt;
  private readonly shareByIdStmt;
  private readonly revokeShareStmt;
  private readonly setSharePreviewMetaStmt;
  private readonly clearSharePreviewMetaStmt;
  private readonly upsertPreviewBlobStmt;
  private readonly deletePreviewBlobStmt;
  private readonly previewBlobStmt;

  constructor(filePath: string) {
    const dir = path.dirname(filePath);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');

    const flowsTableExisted = this.tableExists('flows');
    const storedSchemaVersion = this.tableExists('schema_meta') ? this.readSchemaMeta(FLOWS_SCHEMA_VERSION_KEY) : undefined;
    const needsFlowsRebuild = !flowsTableExisted || storedSchemaVersion !== String(FLOWS_SCHEMA_VERSION);
    // A stale-schema table (version mismatch) is dropped so CREATE TABLE IF NOT
    // EXISTS below lays down the current column set instead of leaving the old
    // one in place; a missing table (upgrade from a pre-hub-22 database, or a
    // brand-new one) has nothing to drop.
    if (needsFlowsRebuild && flowsTableExisted) this.db.exec('DROP TABLE IF EXISTS flows;');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY,
        workspace TEXT NOT NULL,
        id TEXT NOT NULL,
        flow TEXT NOT NULL,
        json TEXT NOT NULL,
        UNIQUE(workspace, id)
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_workspace_flow ON events(workspace, flow);');
    // hub-6: persists the eviction floor per workspace so a restart doesn't forget
    // what the sweeper (or an admin delete) already dropped -- without this a
    // client reconnecting post-restart with a pre-eviction cursor gets a plain
    // `events` delta instead of `truncated: true` and silently misses data.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_meta (
        workspace TEXT PRIMARY KEY,
        floor_cursor INTEGER
      );
    `);

    // hub-22: materialised flow index -- see the class doc. `data_json` is the
    // full `FlowSummary` (ops/nodes/edges included); the other columns exist so
    // `listFlows`/`flowSummary` can filter, sort and page in SQL without
    // deserialising every candidate row first.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flows (
        workspace TEXT NOT NULL,
        id TEXT NOT NULL,
        trace TEXT NOT NULL,
        label TEXT NOT NULL,
        actor_id TEXT,
        actor_kind TEXT,
        status TEXT NOT NULL,
        partial INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        first_cursor INTEGER NOT NULL,
        last_cursor INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        root_node TEXT,
        data_json TEXT NOT NULL,
        PRIMARY KEY (workspace, id)
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_flows_workspace_last_cursor ON flows(workspace, last_cursor);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_flows_workspace_status ON flows(workspace, status);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_flows_workspace_actor ON flows(workspace, actor_id);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_flows_workspace_trace ON flows(workspace, trace);');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Share links (docs/SHARING.md). Not part of the flows/events reduction --
    // a plain CRUD table, no in-memory index or rebuild-on-boot needed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        workspace TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        snapshot_cursor INTEGER,
        include_context INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        preview_content_type TEXT,
        preview_bytes INTEGER
      );
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shares_workspace ON shares(workspace);');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_shares_workspace_created_by ON shares(workspace, created_by);');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS share_previews (
        id TEXT PRIMARY KEY,
        data BLOB NOT NULL
      );
    `);

    this.insertEventStmt = this.db.prepare('INSERT INTO events (cursor, workspace, id, flow, json) VALUES (?, ?, ?, ?, ?)');
    this.upsertFlowStmt = this.db.prepare(`
      INSERT INTO flows (workspace, id, trace, label, actor_id, actor_kind, status, partial, started_at, ended_at, first_cursor, last_cursor, tags_json, root_node, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace, id) DO UPDATE SET
        trace = excluded.trace, label = excluded.label, actor_id = excluded.actor_id, actor_kind = excluded.actor_kind,
        status = excluded.status, partial = excluded.partial, started_at = excluded.started_at, ended_at = excluded.ended_at,
        first_cursor = excluded.first_cursor, last_cursor = excluded.last_cursor, tags_json = excluded.tags_json,
        root_node = excluded.root_node, data_json = excluded.data_json
    `);
    this.deleteFlowRowStmt = this.db.prepare('DELETE FROM flows WHERE workspace = ? AND id = ?');
    this.flowSummaryStmt = this.db.prepare('SELECT data_json FROM flows WHERE workspace = ? AND id = ?');

    this.insertShareStmt = this.db.prepare(`
      INSERT INTO shares (id, token, workspace, target_type, target_id, mode, snapshot_cursor, include_context, created_by, created_at, expires_at, revoked_at, preview_content_type, preview_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.shareByTokenStmt = this.db.prepare('SELECT * FROM shares WHERE token = ?');
    this.shareByIdStmt = this.db.prepare('SELECT * FROM shares WHERE workspace = ? AND id = ?');
    this.revokeShareStmt = this.db.prepare('UPDATE shares SET revoked_at = ? WHERE workspace = ? AND id = ? AND revoked_at IS NULL');
    this.setSharePreviewMetaStmt = this.db.prepare('UPDATE shares SET preview_content_type = ?, preview_bytes = ? WHERE workspace = ? AND id = ?');
    this.clearSharePreviewMetaStmt = this.db.prepare('UPDATE shares SET preview_content_type = NULL, preview_bytes = NULL WHERE workspace = ? AND id = ?');
    this.upsertPreviewBlobStmt = this.db.prepare(
      'INSERT INTO share_previews (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    );
    this.deletePreviewBlobStmt = this.db.prepare('DELETE FROM share_previews WHERE id = ?');
    this.previewBlobStmt = this.db.prepare('SELECT data FROM share_previews WHERE id = ?');

    this.load(needsFlowsRebuild);
  }

  private tableExists(name: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return row !== undefined;
  }

  private readSchemaMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as unknown as { value: string } | undefined;
    return row?.value;
  }

  private writeSchemaMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /**
   * `needsFlowsRebuild`: when false (the common case -- every prior boot has
   * already gone through this code), every workspace's flow index is loaded
   * straight from the `flows` table (O(flows): one row + one `JSON.parse`
   * each) via `flowFromSummary`, never touching `buildFlows`. When true (the
   * table was missing or its schema version didn't match), it falls back to
   * the old O(events) `buildFlows(state.events)` reduction once, then writes
   * the result into `flows` so this branch isn't taken again next boot.
   */
  private load(needsFlowsRebuild: boolean): void {
    const rows = this.db.prepare('SELECT cursor, workspace, id, flow, json FROM events ORDER BY cursor ASC').all() as unknown as EventRow[];
    for (const row of rows) {
      const stored = JSON.parse(row.json) as StoredEvent;
      const state = this.state(row.workspace);
      state.eventsById.set(row.id, stored);
      state.events.push(stored);
      const forFlow = state.eventsByFlow.get(row.flow);
      if (forFlow) forFlow.push(stored);
      else state.eventsByFlow.set(row.flow, [stored]);
      if (row.cursor > this.cursor) this.cursor = row.cursor;
    }

    const metaRows = this.db.prepare('SELECT workspace, floor_cursor FROM workspace_meta').all() as unknown as {
      workspace: string;
      floor_cursor: number | null;
    }[];
    for (const row of metaRows) {
      if (row.floor_cursor === null) continue;
      this.state(row.workspace).floorCursor = row.floor_cursor;
    }

    if (needsFlowsRebuild) {
      for (const [workspace, state] of this.workspaces) {
        state.flows = new Map(buildFlows(state.events));
        for (const flowId of state.flows.keys()) this.persistFlowRow(workspace, state, flowId);
      }
      this.writeSchemaMeta(FLOWS_SCHEMA_VERSION_KEY, String(FLOWS_SCHEMA_VERSION));
    } else {
      const flowRows = this.db.prepare('SELECT workspace, data_json FROM flows').all() as unknown as FlowRow[];
      for (const row of flowRows) {
        const summary = JSON.parse(row.data_json) as FlowSummary;
        const flow = flowFromSummary(summary);
        this.state(row.workspace).flows.set(flow.id, flow);
      }
    }
  }

  private persistFloorCursor(workspace: string, floorCursor: number | undefined): void {
    this.db
      .prepare(
        'INSERT INTO workspace_meta (workspace, floor_cursor) VALUES (?, ?) ON CONFLICT(workspace) DO UPDATE SET floor_cursor = excluded.floor_cursor',
      )
      .run(workspace, floorCursor ?? null);
  }

  /** Upserts one flow's `flows` row from the current in-memory `state.flows`/`state.eventsByFlow`. No-op (well, a delete) if the flow no longer exists in memory. */
  private persistFlowRow(workspace: string, state: WorkspaceState, flowId: string): void {
    const flow = state.flows.get(flowId);
    if (!flow) {
      this.deleteFlowRowStmt.run(workspace, flowId);
      return;
    }
    const events = state.eventsByFlow.get(flowId);
    const firstCursor = events && events.length > 0 ? events[0]!.cursor : 0;
    const lastCursor = events && events.length > 0 ? events[events.length - 1]!.cursor : 0;
    this.upsertFlowStmt.run(
      workspace,
      flow.id,
      flow.trace,
      flow.label,
      flow.actor?.id ?? null,
      flow.actor?.kind ?? null,
      flow.status,
      flow.partial ? 1 : 0,
      flow.startedAt ?? null,
      flow.endedAt ?? null,
      firstCursor,
      lastCursor,
      JSON.stringify(collectTags(flow)),
      rootNodeOf(flow) ?? null,
      JSON.stringify(toFlowSummary(flow)),
    );
  }

  private persistFlowRows(workspace: string, state: WorkspaceState, flowIds: ReadonlySet<string>): void {
    for (const flowId of flowIds) this.persistFlowRow(workspace, state, flowId);
  }

  private state(workspace: string): WorkspaceState {
    let state = this.workspaces.get(workspace);
    if (!state) {
      state = { events: [], eventsById: new Map(), eventsByFlow: new Map(), flows: new Map(), floorCursor: undefined };
      this.workspaces.set(workspace, state);
    }
    return state;
  }

  /**
   * hub-2 (see `MemoryStore.reduceTouchedFlows`): re-reduces only
   * `touchedFlowIds` via core's single-flow `buildFlow`, then re-resolves
   * trace ids for the whole workspace -- O(#flows), not O(#events). Returns
   * every flow id whose in-memory record actually changed (touched, or a
   * late-parent trace correction), so the caller persists exactly those rows
   * instead of the whole table.
   */
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

  /** Removes a flow's events and `flows` row (DB + index entries) without re-resolving trace ids -- callers batch that (see `deleteFlow`, `sweep`). */
  private removeFlowEvents(workspace: string, state: WorkspaceState, flowId: string): boolean {
    const flowEvents = state.eventsByFlow.get(flowId);
    if (!flowEvents) return false;

    this.db.prepare('DELETE FROM events WHERE workspace = ? AND flow = ?').run(workspace, flowId);
    this.deleteFlowRowStmt.run(workspace, flowId);

    for (const event of flowEvents) state.eventsById.delete(event.id);
    state.eventsByFlow.delete(flowId);
    const removedIds = new Set(flowEvents.map((event) => event.id));
    state.events = state.events.filter((event) => !removedIds.has(event.id));
    state.flows.delete(flowId);

    state.floorCursor = state.events.length > 0 ? state.events[0]!.cursor : this.cursor;
    this.persistFloorCursor(workspace, state.floorCursor);
    return true;
  }

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
      this.insertEventStmt.run(stored.cursor, workspace, stored.id, stored.flow, JSON.stringify(stored));
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
      this.persistFlowRows(workspace, state, dirty);
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

  /** SQL-backed (hub-22): filters, sorts and pages entirely in the `flows` table -- no in-memory flow scan. */
  async listFlows(workspace: string, query: ListFlowsQuery): Promise<ListFlowsResult> {
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 1000) : 50;

    const conditions = ['workspace = ?'];
    const params: (string | number)[] = [workspace];
    if (query.status) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    if (query.actor) {
      conditions.push('actor_id = ?');
      params.push(query.actor);
    }
    if (query.trace) {
      conditions.push('trace = ?');
      params.push(query.trace);
    }
    if (query.q) {
      conditions.push("label LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(query.q)}%`);
    }
    if (query.before !== undefined) {
      conditions.push('last_cursor < ?');
      params.push(Number(query.before));
    }

    const sql = `SELECT data_json, last_cursor FROM flows WHERE ${conditions.join(' AND ')} ORDER BY last_cursor DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as unknown as { data_json: string; last_cursor: number }[];

    const flows = rows.map((row) => JSON.parse(row.data_json) as FlowSummary);
    const nextBefore = rows.length === limit && rows.length > 0 ? String(rows[rows.length - 1]!.last_cursor) : undefined;

    return { flows, nextBefore };
  }

  /** SQL-backed (hub-22): a single indexed row lookup, not a `state.flows.get` + conversion. */
  async flowSummary(workspace: string, flowId: string): Promise<FlowSummary | undefined> {
    const row = this.flowSummaryStmt.get(workspace, flowId) as unknown as { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as FlowSummary) : undefined;
  }

  async getTrace(workspace: string, traceId: string): Promise<TraceSummary | undefined> {
    const state = this.state(workspace);
    const trace = assembleTrace(state.flows, traceId);
    if (trace.flows.length === 0) return undefined;
    return { root: trace.root, flows: trace.flows.map(toFlowSummary), links: trace.links, missing: trace.missing };
  }

  async deleteFlow(workspace: string, flowId: string): Promise<boolean> {
    const state = this.state(workspace);
    const removed = this.removeFlowEvents(workspace, state, flowId);
    if (removed) {
      // a deleted parent's children may need a new placeholder trace id
      const dirty = this.reResolveTraceIds(state);
      this.persistFlowRows(workspace, state, dirty);
    }
    return removed;
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
      let sweptThisWorkspace = 0;
      for (const candidate of candidates) {
        const overCount = totalEvents > options.maxEventsPerWorkspace;
        // Candidates are ordered oldest-first within (complete, then running/unknown)
        // groups, not globally by age, so a candidate that doesn't qualify yet must
        // not stop the loop -- a later, older candidate in the other group might.
        if (!isOverRetention(candidate, cutoff) && !overCount) continue;

        const count = state.eventsByFlow.get(candidate.flow.id)?.length ?? 0;
        this.removeFlowEvents(workspace, state, candidate.flow.id);
        totalEvents -= count;
        sweptFlows += 1;
        sweptEvents += count;
        sweptThisWorkspace += 1;
      }
      if (sweptThisWorkspace > 0) {
        const dirty = this.reResolveTraceIds(state);
        this.persistFlowRows(workspace, state, dirty);
      }
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
    this.db.close();
  }

  // ---------------------------------------------------------------------
  // ShareStore (docs/SHARING.md)
  // ---------------------------------------------------------------------

  async createShare(input: CreateShareInput): Promise<ShareRecord> {
    const record: ShareRecord = {
      id: generateShareId(),
      token: generateShareToken(),
      workspace: input.workspace,
      target: input.target,
      mode: input.mode,
      snapshotCursor: input.snapshotCursor,
      includeContext: input.includeContext,
      createdBy: input.createdBy,
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      revokedAt: null,
      preview: null,
    };
    this.insertShareStmt.run(
      record.id,
      record.token,
      record.workspace,
      record.target.type,
      record.target.id,
      record.mode,
      record.snapshotCursor ?? null,
      record.includeContext ? 1 : 0,
      record.createdBy,
      record.createdAt,
      record.expiresAt,
      record.revokedAt,
      null,
      null,
    );
    return record;
  }

  async getShareByToken(token: string): Promise<ShareRecord | undefined> {
    const row = this.shareByTokenStmt.get(token) as unknown as ShareRow | undefined;
    return row ? shareRowToRecord(row) : undefined;
  }

  async getShareById(workspace: string, id: string): Promise<ShareRecord | undefined> {
    const row = this.shareByIdStmt.get(workspace, id) as unknown as ShareRow | undefined;
    return row ? shareRowToRecord(row) : undefined;
  }

  async listShares(workspace: string, query: ListSharesQuery = {}): Promise<readonly ShareRecord[]> {
    const rows =
      query.createdBy !== undefined
        ? (this.db
            .prepare('SELECT * FROM shares WHERE workspace = ? AND created_by = ? ORDER BY created_at DESC')
            .all(workspace, query.createdBy) as unknown as ShareRow[])
        : (this.db.prepare('SELECT * FROM shares WHERE workspace = ? ORDER BY created_at DESC').all(workspace) as unknown as ShareRow[]);
    return rows.map(shareRowToRecord);
  }

  async revokeShare(workspace: string, id: string, revokedAt: number): Promise<boolean> {
    const existing = this.shareByIdStmt.get(workspace, id) as unknown as ShareRow | undefined;
    if (!existing) return false;
    this.revokeShareStmt.run(revokedAt, workspace, id); // no-op (0 rows) if already revoked -- idempotent by design
    return true;
  }

  async setSharePreview(workspace: string, id: string, preview: SharePreviewData | null): Promise<boolean> {
    const existing = this.shareByIdStmt.get(workspace, id) as unknown as ShareRow | undefined;
    if (!existing) return false;
    if (preview === null) {
      this.clearSharePreviewMetaStmt.run(workspace, id);
      this.deletePreviewBlobStmt.run(id);
    } else {
      this.setSharePreviewMetaStmt.run(preview.contentType, preview.data.byteLength, workspace, id);
      this.upsertPreviewBlobStmt.run(id, Buffer.from(preview.data));
    }
    return true;
  }

  async getSharePreview(workspace: string, id: string): Promise<SharePreviewData | undefined> {
    const share = this.shareByIdStmt.get(workspace, id) as unknown as ShareRow | undefined;
    if (!share || share.preview_content_type === null) return undefined;
    const row = this.previewBlobStmt.get(id) as unknown as { data: Uint8Array } | undefined;
    if (!row) return undefined;
    return { contentType: 'image/png', data: new Uint8Array(row.data) };
  }
}
