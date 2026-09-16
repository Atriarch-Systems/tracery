/**
 * In-memory `EventStore` (SPEC.md §6 "Storage"). Default store; bounded by
 * the periodic sweeper rather than by a hard per-append cap, so a burst
 * briefly over `maxEventsPerWorkspace` is trimmed on the next sweep instead
 * of rejecting the ingest.
 *
 * Flow reduction always goes through `@atriarch/activity-core`'s
 * `buildFlows`/`assembleTrace` over the workspace's full retained event set,
 * which is what gives late-arriving parents correct trace resolution
 * (SPEC.md §1 "Trace resolution") for free -- it is never reimplemented here.
 */
import { buildFlows, assembleTrace, type Flow } from '@atriarch/activity-core';
import type { ActivityEvent, StoredEvent } from '@atriarch/activity-core/contract';
import { buildFrame } from './frame.js';
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

  private rebuildFlows(state: WorkspaceState): void {
    state.flows = new Map(buildFlows(state.events));
  }

  async append(workspace: string, events: readonly ActivityEvent[]): Promise<AppendResult> {
    const state = this.state(workspace);
    const accepted: StoredEvent[] = [];
    let duplicates = 0;

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
    }

    if (accepted.length > 0) {
      this.rebuildFlows(state);
      for (const event of accepted) for (const subscriber of this.subscribers) subscriber(event);
    }

    return { accepted, duplicates, cursor: this.cursor };
  }

  private floorInfo(state: WorkspaceState): { floorCursor: number | undefined } {
    return { floorCursor: state.floorCursor };
  }

  async flowEvents(workspace: string, flowId: string, after?: number): Promise<import('@atriarch/activity-core/contract').ActivityFrame> {
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

  async traceFrame(workspace: string, traceId: string, after?: number): Promise<import('@atriarch/activity-core/contract').ActivityFrame> {
    const scoped = await this.traceEvents(workspace, traceId);
    const state = this.state(workspace);
    return buildFrame(scoped, this.cursor, this.floorInfo(state), after);
  }

  async workspaceFrame(workspace: string, after?: number): Promise<import('@atriarch/activity-core/contract').ActivityFrame> {
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
    const flowEvents = state.eventsByFlow.get(flowId);
    if (!flowEvents) return false;

    for (const event of flowEvents) state.eventsById.delete(event.id);
    state.eventsByFlow.delete(flowId);
    const removedIds = new Set(flowEvents.map((event) => event.id));
    state.events = state.events.filter((event) => !removedIds.has(event.id));

    state.floorCursor = state.events.length > 0 ? state.events[0]!.cursor : this.cursor;
    this.rebuildFlows(state);
    return true;
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
      const isProtected = (flow: Flow): boolean =>
        flow.status === 'running' && flow.startedAt !== undefined && flow.startedAt >= cutoff;

      const candidates = [...state.flows.values()]
        .filter((flow) => !isProtected(flow))
        .sort((a, b) => (a.startedAt ?? -Infinity) - (b.startedAt ?? -Infinity));

      let totalEvents = state.events.length;
      for (const flow of candidates) {
        const overRetention = flow.startedAt !== undefined ? flow.startedAt < cutoff : true;
        const overCount = totalEvents > options.maxEventsPerWorkspace;
        if (!overRetention && !overCount) break;

        const count = state.eventsByFlow.get(flow.id)?.length ?? 0;
        // eslint-disable-next-line no-await-in-loop
        await this.deleteFlow(workspace, flow.id);
        totalEvents -= count;
        sweptFlows += 1;
        sweptEvents += count;
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
  }
}
