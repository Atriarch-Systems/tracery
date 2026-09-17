/**
 * In-memory `EventStore` (SPEC.md §6 "Storage"). Default store; bounded by
 * the periodic sweeper rather than by a hard per-append cap, so a burst
 * briefly over `maxEventsPerWorkspace` is trimmed on the next sweep instead
 * of rejecting the ingest.
 *
 * Flow state is materialised incrementally (hub-2): `append`/`deleteFlow`
 * only re-reduce the flow(s) actually touched, via `@atriarch/tracery-core`'s
 * single-flow `buildFlow` fast path, and only re-resolve trace ids (an
 * O(#flows) walk over `{id, link}` pairs -- see `./trace-ids.js`) rather than
 * re-running `buildFlows`/`assembleTrace` over the workspace's full retained
 * event set on every call. This keeps late-arriving-parent trace correction
 * (SPEC.md §1 "Trace resolution") working exactly as before -- it is still
 * never reimplemented at the event-reduction level -- without ingest cost
 * scaling with the number of events already retained.
 */
import { buildFlow, assembleTrace, type Flow } from '@atriarch/tracery-core';
import type { ActivityEvent, StoredEvent } from '@atriarch/tracery-core/contract';
import { buildFrame } from './frame.js';
import { resolveTraceIds } from './trace-ids.js';
import { isSweepProtected, isOverRetention, orderSweepCandidates, type SweepCandidate } from './sweep.js';
import {
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

interface WorkspaceState {
  /** All currently retained events, ordered by cursor ascending. */
  events: StoredEvent[];
  eventsById: Map<string, StoredEvent>;
  eventsByFlow: Map<string, StoredEvent[]>;
  flows: Map<string, Flow>;
  /** Smallest cursor still retained; `undefined` until the first eviction. */
  floorCursor: number | undefined;
}

function matchesQuery(flow: Flow, query: ListFlowsQuery): boolean {
  if (query.status && flow.status !== query.status) return false;
  if (query.actor && flow.actor?.id !== query.actor) return false;
  if (query.trace && flow.trace !== query.trace) return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    if (!flow.label.toLowerCase().includes(needle)) return false;
  }
  return true;
}

export class MemoryStore implements EventStore {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly subscribers = new Set<StoreSubscriber>();
  private cursor = 0;

  private state(workspace: string): WorkspaceState {
    let state = this.workspaces.get(workspace);
    if (!state) {
      state = { events: [], eventsById: new Map(), eventsByFlow: new Map(), flows: new Map(), floorCursor: undefined };
      this.workspaces.set(workspace, state);
    }
    return state;
  }

  /**
   * hub-2: re-reduces only `touchedFlowIds` (each via core's O(events-in-that-
   * flow) `buildFlow`), then re-resolves trace ids for the whole workspace --
   * O(#flows), not O(#events) -- so a late parent still corrects every
   * descendant's trace exactly as `buildFlows`/`assembleTrace` would.
   */
  private reduceTouchedFlows(state: WorkspaceState, touchedFlowIds: ReadonlySet<string>): void {
    for (const flowId of touchedFlowIds) {
      const flowEvents = state.eventsByFlow.get(flowId);
      if (flowEvents && flowEvents.length > 0) state.flows.set(flowId, buildFlow(flowEvents));
    }
    this.reResolveTraceIds(state);
  }

  private reResolveTraceIds(state: WorkspaceState): void {
    const traceIds = resolveTraceIds(state.flows);
    for (const [id, flow] of state.flows) {
      const trace = traceIds.get(id)!;
      if (flow.trace !== trace) state.flows.set(id, { ...flow, trace });
    }
  }

  private lastSeenAt(state: WorkspaceState, flowId: string): number {
    const events = state.eventsByFlow.get(flowId);
    if (!events || events.length === 0) return Number.NEGATIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const event of events) if (event.receivedAt > max) max = event.receivedAt;
    return max;
  }

  /** Removes a flow's events and index entries without re-resolving trace ids -- callers batch that (see `deleteFlow`, `sweep`). */
  private removeFlowEvents(state: WorkspaceState, flowId: string): boolean {
    const flowEvents = state.eventsByFlow.get(flowId);
    if (!flowEvents) return false;

    for (const event of flowEvents) state.eventsById.delete(event.id);
    state.eventsByFlow.delete(flowId);
    const removedIds = new Set(flowEvents.map((event) => event.id));
    state.events = state.events.filter((event) => !removedIds.has(event.id));
    state.flows.delete(flowId);

    state.floorCursor = state.events.length > 0 ? state.events[0]!.cursor : this.cursor;
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
      state.eventsById.set(event.id, stored);
      state.events.push(stored);
      const forFlow = state.eventsByFlow.get(event.flow);
      if (forFlow) forFlow.push(stored);
      else state.eventsByFlow.set(event.flow, [stored]);
      accepted.push(stored);
      touchedFlows.add(event.flow);
    }

    if (accepted.length > 0) {
      this.reduceTouchedFlows(state, touchedFlows);
      for (const event of accepted) for (const subscriber of this.subscribers) subscriber(event);
    }

    return { accepted, duplicates, cursor: this.cursor };
  }

  private floorInfo(state: WorkspaceState): { floorCursor: number | undefined } {
    return { floorCursor: state.floorCursor };
  }

  async flowEvents(workspace: string, flowId: string, after?: number): Promise<import('@atriarch/tracery-core/contract').ActivityFrame> {
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

  async traceFrame(workspace: string, traceId: string, after?: number): Promise<import('@atriarch/tracery-core/contract').ActivityFrame> {
    const scoped = await this.traceEvents(workspace, traceId);
    const state = this.state(workspace);
    return buildFrame(scoped, this.cursor, this.floorInfo(state), after);
  }

  async workspaceFrame(workspace: string, after?: number): Promise<import('@atriarch/tracery-core/contract').ActivityFrame> {
    const state = this.state(workspace);
    return buildFrame(state.events, this.cursor, this.floorInfo(state), after);
  }

  async listFlows(workspace: string, query: ListFlowsQuery): Promise<ListFlowsResult> {
    const state = this.state(workspace);
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 1000) : 50;

    const lastCursorOf = (flow: Flow): number => {
      const events = state.eventsByFlow.get(flow.id);
      if (!events || events.length === 0) return 0;
      return events[events.length - 1]!.cursor;
    };

    let candidates = [...state.flows.values()].filter((flow) => matchesQuery(flow, query));
    candidates.sort((a, b) => lastCursorOf(b) - lastCursorOf(a));

    if (query.before !== undefined) {
      const before = Number(query.before);
      candidates = candidates.filter((flow) => lastCursorOf(flow) < before);
    }

    const page = candidates.slice(0, limit);
    const nextBefore = page.length === limit && page.length > 0 ? String(lastCursorOf(page[page.length - 1]!)) : undefined;

    return { flows: page.map(toFlowSummary), nextBefore };
  }

  async flowSummary(workspace: string, flowId: string): Promise<FlowSummary | undefined> {
    const flow = this.state(workspace).flows.get(flowId);
    return flow ? toFlowSummary(flow) : undefined;
  }

  async getTrace(workspace: string, traceId: string): Promise<TraceSummary | undefined> {
    const state = this.state(workspace);
    const trace = assembleTrace(state.flows, traceId);
    if (trace.flows.length === 0) return undefined;
    return { root: trace.root, flows: trace.flows.map(toFlowSummary), links: trace.links, missing: trace.missing };
  }

  async deleteFlow(workspace: string, flowId: string): Promise<boolean> {
    const state = this.state(workspace);
    const removed = this.removeFlowEvents(state, flowId);
    if (removed) this.reResolveTraceIds(state); // a deleted parent's children may need a new placeholder trace id
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
        this.removeFlowEvents(state, candidate.flow.id);
        totalEvents -= count;
        sweptFlows += 1;
        sweptEvents += count;
        sweptThisWorkspace += 1;
      }
      if (sweptThisWorkspace > 0) this.reResolveTraceIds(state);
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
  }
}
