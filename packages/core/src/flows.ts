/**
 * Reduces a flat event log into Flows: op lifecycle, node histories and edges
 * (SPEC.md §1 "Op lifecycle" / "Flow" and §2). Pure and renderer-free.
 */
import type {
  ActivityActor,
  ActivityContext,
  ActivityEvent,
  ActivityEventType,
  ActivityJson,
  ActivityLink,
  ActivityStatus,
} from './contract.js';

export type FlowStatus = 'running' | 'error' | 'unknown' | 'complete';
export type NodeStatus = 'error' | 'running' | 'idle';

export interface TimelineEntry {
  readonly ts: number;
  readonly type: ActivityEventType;
  readonly status?: ActivityStatus;
  readonly context?: ActivityContext;
  readonly eventId: string;
}

export interface OpRecord {
  readonly id: string;
  readonly node: string;
  readonly name: string;
  readonly kind?: string;
  readonly status: ActivityStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly parentOp?: string;
  readonly parentNode?: string;
  /** True when the op's start (or its creating event) declared root: true. */
  readonly root: boolean;
  readonly relation: string;
  readonly dataFrom?: string;
  readonly context: ActivityContext;
  readonly timeline: readonly TimelineEntry[];
  readonly tags: readonly string[];
}

export interface NodeRecord {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly ops: readonly string[];
  readonly status: NodeStatus;
  readonly running: number;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
  readonly lastOpName?: string;
  readonly errorCount: number;
}

export interface EdgeRecord {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  /** Number of distinct start ops observed on this edge. update/end never add to it. */
  readonly count: number;
  readonly ops: readonly string[];
  readonly lastAt: number;
  readonly kind: 'call' | 'data';
}

export interface Flow {
  readonly id: string;
  readonly label: string;
  readonly actor?: ActivityActor;
  readonly status: FlowStatus;
  readonly partial: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly link?: ActivityLink;
  readonly trace: string;
  readonly ops: ReadonlyMap<string, OpRecord>;
  readonly nodes: ReadonlyMap<string, NodeRecord>;
  readonly edges: readonly EdgeRecord[];
}

// ---------------------------------------------------------------------------
// Working (mutable) shapes used only while reducing one flow's events.
// ---------------------------------------------------------------------------

interface MutableOp {
  id: string;
  node: string;
  name: string;
  kind?: string;
  status: ActivityStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  parentOp?: string;
  parentNode?: string;
  root: boolean;
  relation: string;
  dataFrom?: string;
  context: Record<string, ActivityJson>;
  timeline: TimelineEntry[];
  tags: Set<string>;
  hasStart: boolean;
}

interface MutableNode {
  id: string;
  label: string;
  kind?: string;
  ops: string[];
  opSet: Set<string>;
  firstSeenAt: number;
  lastSeenAt: number;
  lastOpName?: string;
}

interface MutableEdge {
  source: string;
  target: string;
  relation: string;
  kind: 'call' | 'data';
  ops: string[];
  opSet: Set<string>;
  lastAt: number;
}

type FlowWithoutTrace = Omit<Flow, 'trace'>;

function mergeContext(target: Record<string, ActivityJson>, source: ActivityContext | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) target[key] = value;
}

function edgeKey(source: string, target: string, relation: string, kind: 'call' | 'data'): string {
  return `${kind}|${source}|${target}|${relation}`;
}

/** Reduces one flow's events (already filtered to a single `flow` id) into its parts. */
function reduceFlow(flowId: string, rawEvents: readonly ActivityEvent[]): FlowWithoutTrace {
  const events = rawEvents
    .map((event, arrival) => ({ event, arrival }))
    .sort((a, b) => a.event.ts - b.event.ts || (a.event.seq ?? 0) - (b.event.seq ?? 0) || a.arrival - b.arrival)
    .map((entry) => entry.event);

  const ops = new Map<string, MutableOp>();
  const nodes = new Map<string, MutableNode>();
  const edges = new Map<string, MutableEdge>();
  /** op id -> edge keys it participates in, so later events can refresh edge.lastAt. */
  const opEdgeKeys = new Map<string, string[]>();

  let rootEvent: ActivityEvent | undefined;
  let firstActor: ActivityActor | undefined;

  const touchNode = (nodeId: string, ts: number, kind: string | undefined, label: string | undefined, opName: string): MutableNode => {
    let node = nodes.get(nodeId);
    if (!node) {
      node = { id: nodeId, label: nodeId, kind: undefined, ops: [], opSet: new Set(), firstSeenAt: ts, lastSeenAt: ts, lastOpName: undefined };
      nodes.set(nodeId, node);
    }
    if (ts < node.firstSeenAt) node.firstSeenAt = ts;
    if (ts >= node.lastSeenAt) {
      node.lastSeenAt = ts;
      node.lastOpName = opName;
    }
    if (kind !== undefined) node.kind = kind;
    if (label !== undefined && label !== '') node.label = label;
    return node;
  };

  const linkEdge = (source: string, target: string, relation: string, kind: 'call' | 'data', opId: string, ts: number): void => {
    const key = edgeKey(source, target, relation, kind);
    let edge = edges.get(key);
    if (!edge) {
      edge = { source, target, relation, kind, ops: [], opSet: new Set(), lastAt: ts };
      edges.set(key, edge);
    }
    if (!edge.opSet.has(opId)) {
      edge.opSet.add(opId);
      edge.ops.push(opId);
    }
    if (ts > edge.lastAt) edge.lastAt = ts;
    const keys = opEdgeKeys.get(opId);
    if (keys) {
      if (!keys.includes(key)) keys.push(key);
    } else {
      opEdgeKeys.set(opId, [key]);
    }
  };

  const touchOpEdges = (opId: string, ts: number): void => {
    const keys = opEdgeKeys.get(opId);
    if (!keys) return;
    for (const key of keys) {
      const edge = edges.get(key);
      if (edge && ts > edge.lastAt) edge.lastAt = ts;
    }
  };

  const addTag = (op: MutableOp, tags: readonly string[] | undefined): void => {
    if (!tags) return;
    for (const tag of tags) op.tags.add(tag);
  };

  const registerOpOnNode = (nodeId: string, opId: string): void => {
    const node = nodes.get(nodeId);
    if (node && !node.opSet.has(opId)) {
      node.opSet.add(opId);
      node.ops.push(opId);
    }
  };

  for (const event of events) {
    const { type, op: opId, node: nodeId, ts } = event;
    touchNode(nodeId, ts, event.kind, event.label, event.name);

    const parentOp = event.parentOp === null ? undefined : event.parentOp;
    const parentNode = event.parentNode === null ? undefined : event.parentNode;
    let op = ops.get(opId);

    if (type === 'start') {
      if (op && op.hasStart) {
        // Later starts for the same op are ignored: first wins.
        continue;
      }
      if (!op) {
        op = {
          id: opId, node: nodeId, name: event.name, kind: event.kind, status: 'running',
          root: false, relation: event.relation ?? 'invoke', dataFrom: undefined,
          parentOp, parentNode, context: {}, timeline: [], tags: new Set(), hasStart: false,
        };
        ops.set(opId, op);
      }
      registerOpOnNode(nodeId, opId);
      op.startedAt = ts;
      op.status = 'running';
      op.hasStart = true;
      op.name = event.name;
      if (event.kind !== undefined) op.kind = event.kind;
      op.relation = event.relation ?? op.relation;
      op.root = event.root === true;
      op.parentOp = parentOp;
      op.parentNode = parentNode;
      op.dataFrom = event.dataFrom;
      mergeContext(op.context, event.context);
      addTag(op, event.tags);
      op.timeline.push({ ts, type: 'start', context: event.context, eventId: event.id });

      if (event.root === true && !rootEvent) rootEvent = event;
      if (!firstActor && event.actor) firstActor = event.actor;

      if (op.parentNode !== undefined) linkEdge(op.parentNode, nodeId, op.relation, 'call', opId, ts);
      if (op.dataFrom !== undefined) linkEdge(op.dataFrom, nodeId, 'data', 'data', opId, ts);
      continue;
    }

    // update / end / annotate: create the op on demand if it has never been started.
    // Per SPEC.md, this is evidence of a node only -- never an invented call count
    // or edge visit, so no edge is created here (edges are created on `start`).
    if (!op) {
      op = {
        id: opId, node: nodeId, name: event.name, kind: event.kind, status: 'running',
        root: false, relation: event.relation ?? 'invoke', dataFrom: undefined,
        parentOp, parentNode, context: {}, timeline: [], tags: new Set(), hasStart: false,
      };
      ops.set(opId, op);
      registerOpOnNode(nodeId, opId);
    }
    if (!firstActor && event.actor) firstActor = event.actor;
    addTag(op, event.tags);

    if (type === 'update') {
      mergeContext(op.context, event.context);
      if (event.status !== undefined) op.status = event.status;
      op.timeline.push({ ts, type: 'update', status: event.status, context: event.context, eventId: event.id });
    } else if (type === 'end') {
      if (op.endedAt !== undefined) {
        // Later ends for the same op are ignored: first wins.
        continue;
      }
      op.endedAt = ts;
      op.status = event.status ?? 'success';
      op.durationMs = event.durationMs ?? (op.startedAt !== undefined ? ts - op.startedAt : undefined);
      mergeContext(op.context, event.context);
      op.timeline.push({ ts, type: 'end', status: op.status, context: event.context, eventId: event.id });
    } else {
      // annotate: appended verbatim, never merged into context, never changes status.
      op.timeline.push({ ts, type: 'annotate', status: event.status, context: event.context, eventId: event.id });
    }

    touchOpEdges(opId, ts);
  }

  const hasRootStart = rootEvent !== undefined;
  let anyOpWithoutStart = false;
  for (const op of ops.values()) if (op.startedAt === undefined) anyOpWithoutStart = true;
  const partial = !hasRootStart || anyOpWithoutStart;

  let anyError = false;
  let anyOpen = false;
  for (const op of ops.values()) {
    if (op.status === 'error') anyError = true;
    if (op.endedAt === undefined) anyOpen = true;
  }
  const status: FlowStatus = anyError ? 'error' : anyOpen ? 'running' : partial ? 'unknown' : 'complete';

  let endedAt: number | undefined;
  if (!anyOpen && ops.size > 0) {
    for (const op of ops.values()) endedAt = endedAt === undefined ? op.endedAt : Math.max(endedAt, op.endedAt!);
  }

  const finalNodes = new Map<string, NodeRecord>();
  for (const [id, node] of nodes) {
    let running = 0;
    let errorCount = 0;
    for (const opId of node.ops) {
      const op = ops.get(opId)!;
      if (op.endedAt === undefined) running++;
      if (op.status === 'error') errorCount++;
    }
    const nodeStatus: NodeStatus = errorCount > 0 ? 'error' : running > 0 ? 'running' : 'idle';
    finalNodes.set(id, {
      id: node.id, label: node.label, kind: node.kind, ops: [...node.ops], status: nodeStatus,
      running, firstSeenAt: node.firstSeenAt, lastSeenAt: node.lastSeenAt, lastOpName: node.lastOpName, errorCount,
    });
  }

  const finalOps = new Map<string, OpRecord>();
  for (const [id, op] of ops) {
    finalOps.set(id, {
      id: op.id, node: op.node, name: op.name, kind: op.kind, status: op.status,
      startedAt: op.startedAt, endedAt: op.endedAt, durationMs: op.durationMs,
      parentOp: op.parentOp, parentNode: op.parentNode, root: op.root, relation: op.relation, dataFrom: op.dataFrom,
      context: { ...op.context }, timeline: [...op.timeline], tags: [...op.tags],
    });
  }

  const finalEdges: EdgeRecord[] = [...edges.values()].map((edge) => ({
    source: edge.source, target: edge.target, relation: edge.relation, count: edge.ops.length,
    ops: [...edge.ops], lastAt: edge.lastAt, kind: edge.kind,
  }));

  return {
    id: flowId,
    label: rootEvent ? (rootEvent.label ?? rootEvent.name) : flowId,
    actor: rootEvent?.actor ?? firstActor,
    status,
    partial,
    startedAt: rootEvent?.ts,
    endedAt,
    link: rootEvent?.link,
    ops: finalOps,
    nodes: finalNodes,
    edges: finalEdges,
  };
}

// ---------------------------------------------------------------------------
// Trace id resolution (SPEC.md §1 "Trace resolution"), shared by buildFlows and
// buildFlow so a Flow's `trace` field is always populated.
// ---------------------------------------------------------------------------

function resolveTraceIds(flows: ReadonlyMap<string, Pick<FlowWithoutTrace, 'id' | 'link'>>): Map<string, string> {
  const resolved = new Map<string, string>();

  const resolveOne = (id: string, stack: string[]): string => {
    const cached = resolved.get(id);
    if (cached !== undefined) return cached;
    const flow = flows.get(id);
    if (!flow || !flow.link) {
      resolved.set(id, id);
      return id;
    }
    if (flow.link.trace) {
      resolved.set(id, flow.link.trace);
      return flow.link.trace;
    }
    const parentId = flow.link.parentFlow;
    const parent = flows.get(parentId);
    if (!parent) {
      // Parent may arrive later; use its id as the trace id placeholder.
      resolved.set(id, parentId);
      return parentId;
    }
    const cycleIndex = stack.indexOf(parentId);
    if (cycleIndex !== -1) {
      // Cycle: the first flow seen in this walk is treated as the root.
      const root = stack[0]!;
      resolved.set(id, root);
      return root;
    }
    stack.push(id);
    const result = resolveOne(parentId, stack);
    stack.pop();
    resolved.set(id, result);
    return result;
  };

  for (const id of flows.keys()) resolveOne(id, []);
  return resolved;
}

/** Builds every flow found in `events`. */
export function buildFlows(events: readonly ActivityEvent[]): ReadonlyMap<string, Flow> {
  const byFlow = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const list = byFlow.get(event.flow);
    if (list) list.push(event);
    else byFlow.set(event.flow, [event]);
  }

  const built = new Map<string, FlowWithoutTrace>();
  for (const [flowId, flowEvents] of byFlow) built.set(flowId, reduceFlow(flowId, flowEvents));

  const traceIds = resolveTraceIds(built);

  const result = new Map<string, Flow>();
  for (const [id, flow] of built) result.set(id, { ...flow, trace: traceIds.get(id)! });
  return result;
}

/** Single-flow fast path. `events` should already be filtered to one flow; any events for a different flow are ignored. */
export function buildFlow(events: readonly ActivityEvent[]): Flow {
  if (events.length === 0) throw new Error('buildFlow: at least one event is required');
  const flowId = events[0]!.flow;
  const relevant = events.filter((event) => event.flow === flowId);
  const built = reduceFlow(flowId, relevant);
  const traceIds = resolveTraceIds(new Map([[flowId, built]]));
  return { ...built, trace: traceIds.get(flowId)! };
}
