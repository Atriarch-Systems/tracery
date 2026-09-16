/**
 * Projects Flows onto the visualizer contract (SPEC.md §2 "projection to the
 * visualizer contract" and "Projection rules"). Pure; never mutates a Flow.
 */
import type { ActivityActor } from './contract.js';
import { ancestors, assembleTrace } from './trace.js';
import type { EdgeRecord, Flow, NodeRecord, OpRecord } from './flows.js';
import { defaultCatalog } from './catalog.js';
import type { ActivityEdge, ActivityNode, NodePresentation } from './visualizer-ext.js';

export type Scope =
  | { readonly mode: 'flow'; readonly flow: string }
  | { readonly mode: 'ancestors'; readonly flow: string }
  | { readonly mode: 'trace'; readonly trace: string };

export interface ProjectOptions {
  readonly catalog?: (node: NodeRecord, flow: Flow) => NodePresentation;
  readonly now?: number;
  readonly history?: { readonly keepCompletedMs?: number };
}

export interface NodeData {
  readonly flow: string;
  readonly node: NodeRecord;
  readonly ops: OpRecord[];
}

export interface EdgeData {
  readonly flow: string;
  readonly edge: EdgeRecord;
}

export interface FlowGroup {
  readonly id: string;
  readonly label: string;
  readonly flow: string;
  readonly nodeIds: string[];
  readonly actor?: ActivityActor;
  readonly status: Flow['status'];
}

export interface Projection {
  readonly nodes: ActivityNode<NodeData>[];
  readonly edges: ActivityEdge<EdgeData>[];
  readonly groups: FlowGroup[];
}

interface SpawnInfo {
  readonly sourceId: string;
  readonly targetId: string;
  readonly parentNodeId: string;
  readonly childRootNodeId: string;
  readonly parentFlowId: string;
  readonly childOpId?: string;
}

function namespacedId(flow: Flow, nodeId: string, namespaced: boolean): string {
  return namespaced ? `${flow.actor?.id ?? flow.id}::${nodeId}` : nodeId;
}

function rootOpNodeId(flow: Flow): string | undefined {
  for (const op of flow.ops.values()) if (op.root) return op.node;
  return undefined;
}

function rootOpId(flow: Flow): string | undefined {
  for (const op of flow.ops.values()) if (op.root) return op.id;
  return undefined;
}

/**
 * Resolves scope to the set of flows to render, whether node ids should be
 * namespaced by actor, and which flows count as "in scope" (highlighted) vs.
 * present only for context (dimmed via activity.highlighted = false).
 */
function resolveScope(flows: ReadonlyMap<string, Flow>, scope: Scope): { scopeFlows: Flow[]; namespaced: boolean; highlighted: Set<string> } {
  if (scope.mode === 'flow') {
    const flow = flows.get(scope.flow);
    const scopeFlows = flow ? [flow] : [];
    return { scopeFlows, namespaced: false, highlighted: new Set(scopeFlows.map((f) => f.id)) };
  }
  if (scope.mode === 'ancestors') {
    const flow = flows.get(scope.flow);
    if (!flow) return { scopeFlows: [], namespaced: true, highlighted: new Set() };
    const chain = ancestors(flows, scope.flow);
    const ancestorFlows = chain.map((id) => flows.get(id)).filter((f): f is Flow => f !== undefined);
    return { scopeFlows: [...ancestorFlows, flow], namespaced: true, highlighted: new Set([flow.id]) };
  }
  const trace = assembleTrace(flows, scope.trace);
  return { scopeFlows: [...trace.flows], namespaced: true, highlighted: new Set(trace.flows.map((f) => f.id)) };
}

/** Projects `flows` in `scope` onto nodes/edges/groups the visualizer can draw. */
export function project(flows: ReadonlyMap<string, Flow>, scope: Scope, options?: ProjectOptions): Projection {
  const now = options?.now ?? Date.now();
  const catalogFor = options?.catalog ?? ((node: NodeRecord) => defaultCatalog(node.kind));
  const keepCompletedMs = options?.history?.keepCompletedMs;

  const { scopeFlows, namespaced, highlighted } = resolveScope(flows, scope);
  const scopeFlowIds = new Set(scopeFlows.map((f) => f.id));

  // Pass 1: for namespaced scopes, resolve spawn links whose parent flow is also in scope.
  const spawns = new Map<string, SpawnInfo>();
  if (namespaced) {
    for (const flow of scopeFlows) {
      if (!flow.link) continue;
      const parent = flows.get(flow.link.parentFlow);
      if (!parent || !scopeFlowIds.has(parent.id)) continue;
      const childRootNodeId = rootOpNodeId(flow);
      if (childRootNodeId === undefined) continue;
      const parentNodeId = flow.link.parentNode ?? rootOpNodeId(parent);
      if (parentNodeId === undefined) continue;
      spawns.set(flow.id, {
        sourceId: namespacedId(parent, parentNodeId, true),
        targetId: namespacedId(flow, childRootNodeId, true),
        parentNodeId,
        childRootNodeId,
        parentFlowId: parent.id,
        childOpId: rootOpId(flow),
      });
    }
  }

  const nodes: ActivityNode<NodeData>[] = [];
  const edges: ActivityEdge<EdgeData>[] = [];
  const groups: FlowGroup[] = [];

  for (const flow of scopeFlows) {
    const isHighlighted = highlighted.has(flow.id);
    const groupNodeIds: string[] = [];
    const spawn = spawns.get(flow.id);

    for (const node of flow.nodes.values()) {
      if (keepCompletedMs !== undefined && node.status !== 'running' && now - node.lastSeenAt > keepCompletedMs) continue;

      const id = namespacedId(flow, node.id, namespaced);
      groupNodeIds.push(id);
      const ops = node.ops.map((opId) => flow.ops.get(opId)).filter((op): op is OpRecord => op !== undefined);
      const isSpawnTarget = spawn !== undefined && node.id === spawn.childRootNodeId;

      nodes.push({
        id,
        label: node.label,
        detail: node.lastOpName,
        footer: node.errorCount > 0 ? `${node.errorCount} errors` : `${node.ops.length} ops`,
        status: node.status,
        active: node.running > 0,
        ...(isSpawnTarget ? { layout: { parentId: spawn!.sourceId } } : {}),
        presentation: catalogFor(node, flow),
        activity: { highlighted: isHighlighted, completedAt: flow.endedAt, updatedAt: node.lastSeenAt },
        ...(namespaced ? { group: flow.id } : {}),
        data: { flow: flow.id, node, ops },
      });
    }

    groups.push({ id: flow.id, label: flow.label, flow: flow.id, nodeIds: groupNodeIds, actor: flow.actor, status: flow.status });

    for (const edge of flow.edges) {
      if (edge.source === edge.target) continue; // self-edges suppressed; the op stays in node history
      const sourceId = namespacedId(flow, edge.source, namespaced);
      const targetId = namespacedId(flow, edge.target, namespaced);
      edges.push({
        id: `${flow.id}:${edge.kind}:${edge.source}->${edge.target}:${edge.relation}`,
        source: sourceId,
        target: targetId,
        label: edge.relation,
        count: edge.count,
        showLabel: edge.kind === 'call',
        activity: { highlighted: isHighlighted, updatedAt: edge.lastAt },
        kind: edge.kind,
        data: { flow: flow.id, edge },
      });
    }
  }

  for (const [childFlowId, spawn] of spawns) {
    const child = flows.get(childFlowId)!;
    edges.push({
      id: `spawn:${spawn.parentFlowId}->${childFlowId}`,
      source: spawn.sourceId,
      target: spawn.targetId,
      label: 'spawn',
      count: 1,
      showLabel: true,
      activity: { highlighted: highlighted.has(childFlowId), updatedAt: child.startedAt },
      kind: 'spawn',
      data: {
        flow: childFlowId,
        // Synthesized: spawn links are cross-flow and have no EdgeRecord of their
        // own (EdgeRecord.kind has no 'spawn' variant; that is an
        // ActivityEdge-only distinction added by the visualizer, SPEC.md §3).
        edge: {
          source: spawn.parentNodeId, target: spawn.childRootNodeId, relation: 'spawn',
          count: 1, ops: spawn.childOpId ? [spawn.childOpId] : [], lastAt: child.startedAt ?? now, kind: 'call',
        },
      },
    });
  }

  return { nodes, edges, groups };
}
