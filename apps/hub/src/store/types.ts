/**
 * The hub's storage engine contract (SPEC.md §6 "Storage"). Two
 * implementations ship: `MemoryStore` (default, bounded) and `SqliteStore`
 * (`node:sqlite`, WAL). Both build on `@atriarch-systems/tracery-core`'s
 * `buildFlows`/`assembleTrace` for every reduction -- never reimplemented
 * here.
 */
import type { ActivityEvent, ActivityFrame, StoredEvent } from '@atriarch-systems/tracery-core/contract';
import type { EdgeRecord, Flow, FlowStatus, NodeRecord, OpRecord } from '@atriarch-systems/tracery-core';

/** `Flow`, with `Map`s replaced by JSON-serialisable `Record`s -- the wire shape for `GET /v1/flows*`. */
export interface FlowSummary {
  readonly id: string;
  readonly label: string;
  readonly actor?: Flow['actor'];
  readonly status: FlowStatus;
  readonly partial: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly link?: Flow['link'];
  readonly trace: string;
  readonly ops: Readonly<Record<string, OpRecord>>;
  readonly nodes: Readonly<Record<string, NodeRecord>>;
  readonly edges: readonly EdgeRecord[];
}

/** Converts a core `Flow` (whose `ops`/`nodes` are `Map`s) into the JSON wire shape. */
export function toFlowSummary(flow: Flow): FlowSummary {
  return {
    id: flow.id,
    label: flow.label,
    actor: flow.actor,
    status: flow.status,
    partial: flow.partial,
    startedAt: flow.startedAt,
    endedAt: flow.endedAt,
    link: flow.link,
    trace: flow.trace,
    ops: Object.fromEntries(flow.ops),
    nodes: Object.fromEntries(flow.nodes),
    edges: flow.edges,
  };
}

/**
 * The inverse of `toFlowSummary`: rebuilds a core `Flow` (with `ops`/`nodes`
 * as `Map`s, as `@atriarch-systems/tracery-core`'s `assembleTrace`/`ancestors`
 * require) from its JSON wire shape. Used by `SqliteStore` to reload its
 * in-memory flow index from a persisted `FlowSummary` row instead of
 * re-deriving every flow from its whole event history on boot.
 */
export function flowFromSummary(summary: FlowSummary): Flow {
  return {
    id: summary.id,
    label: summary.label,
    actor: summary.actor,
    status: summary.status,
    partial: summary.partial,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    link: summary.link,
    trace: summary.trace,
    ops: new Map(Object.entries(summary.ops)),
    nodes: new Map(Object.entries(summary.nodes)),
    edges: summary.edges,
  };
}

export interface AppendResult {
  readonly accepted: readonly StoredEvent[];
  readonly duplicates: number;
  /** Hub cursor after this batch (SPEC.md `ActivityBatchResult.cursor`). */
  readonly cursor: number;
}

export interface ListFlowsQuery {
  readonly limit?: number;
  /** Cursor string from a previous page's `nextBefore`; strictly-older flows are returned. */
  readonly before?: string;
  readonly status?: FlowStatus;
  readonly actor?: string;
  readonly trace?: string;
  /** Case-insensitive substring match against the flow's label. */
  readonly q?: string;
}

export interface ListFlowsResult {
  readonly flows: readonly FlowSummary[];
  readonly nextBefore?: string;
}

/** `GET /v1/traces/:id` response shape: core's `Trace` with `Flow`s converted to `FlowSummary`. */
export interface TraceSummary {
  readonly root: string;
  readonly flows: readonly FlowSummary[];
  readonly links: readonly { readonly parent: string; readonly child: string; readonly parentOp?: string; readonly parentNode?: string }[];
  readonly missing: readonly string[];
}

export interface WorkspaceStats {
  readonly workspace: string;
  readonly events: number;
  readonly flows: number;
  readonly oldestEventAt?: number;
  readonly newestEventAt?: number;
}

export interface SweepOptions {
  readonly retentionMs: number;
  readonly maxEventsPerWorkspace: number;
}

export interface SweepResult {
  readonly sweptFlows: number;
  readonly sweptEvents: number;
}

export type StoreSubscriber = (event: StoredEvent) => void;
export type Unsubscribe = () => void;

/**
 * Storage engine. Every mutation is append-only from the caller's point of
 * view (events are never edited, only appended, and whole flows are deleted
 * by `deleteFlow`/`sweep`). Flow summaries are materialised on `append` so
 * `listFlows` is O(limit) rather than re-deriving from the event log.
 */
export interface EventStore {
  /** Appends already-validated events to `workspace`; deduplicates by `id`. */
  append(workspace: string, events: readonly ActivityEvent[]): Promise<AppendResult>;

  /** `GET /v1/flows/:id/events`: full snapshot, or the delta after `after` (SPEC.md "Live feed" truncation rules apply here too). */
  flowEvents(workspace: string, flowId: string, after?: number): Promise<ActivityFrame>;

  /** `GET /v1/traces/:id/events`: every event for every flow sharing the trace, cursor-ordered. */
  traceEvents(workspace: string, traceId: string): Promise<readonly StoredEvent[]>;

  /**
   * Internal to the hub (used by `live.ts` for WS reconnect): a frame scoped
   * to a trace instead of a single flow, with the same snapshot/events/
   * truncated semantics as `flowEvents`.
   */
  traceFrame(workspace: string, traceId: string, after?: number): Promise<ActivityFrame>;

  /** Internal to the hub: a frame with no flow/trace filter -- every event currently retained for the workspace. */
  workspaceFrame(workspace: string, after?: number): Promise<ActivityFrame>;

  listFlows(workspace: string, query: ListFlowsQuery): Promise<ListFlowsResult>;

  flowSummary(workspace: string, flowId: string): Promise<FlowSummary | undefined>;

  /** `GET /v1/traces/:id`: every flow sharing the resolved trace id (SPEC.md §1 "Trace resolution"), via core's `assembleTrace`. `undefined` when no flow resolves to this trace. */
  getTrace(workspace: string, traceId: string): Promise<TraceSummary | undefined>;

  /** Deletes a flow and its events. Returns `false` when it did not exist. */
  deleteFlow(workspace: string, flowId: string): Promise<boolean>;

  /** Registers a subscriber called with every event immediately after it is committed, across all workspaces. `live.ts` filters. */
  subscribe(subscriber: StoreSubscriber): Unsubscribe;

  /** Deletes the oldest complete flows first; never a running flow younger than the retention window (SPEC.md "Retention"). */
  sweep(now: number, options: SweepOptions): Promise<SweepResult>;

  stats(): Promise<readonly WorkspaceStats[]>;

  close(): Promise<void>;
}
