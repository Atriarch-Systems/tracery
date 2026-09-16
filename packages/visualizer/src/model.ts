import type { Activity, ActivityNode, ActivityEdge } from './types.js';
export type RuntimeNode = {
  id: string; spec: ActivityNode; x: number; y: number; vx?: number; vy?: number;
  fx?: number; fy?: number; homeX: number; homeY: number; placed?: boolean;
};
export type RuntimeEdge = { id: string; spec: ActivityEdge; source: string | RuntimeNode; target: string | RuntimeNode };
export type RuntimeGraph = { nodes: RuntimeNode[]; links: RuntimeEdge[] };
export const emptyGraph = (): RuntimeGraph => ({ nodes: [], links: [] });
export const box = (n: RuntimeNode) => ({ w: Math.max(70, n.spec.presentation?.width ?? 138), h: Math.max(62, n.spec.presentation?.height ?? 62) });
export const edgeWidth = (count = 1) => Math.min(7, 1.2 + Math.log2(Math.max(1, count)) * 1.8);
export const intensity = (a: Activity | undefined, now: number) => !a?.highlighted ? 0 : a.completedAt === undefined ? 1
  : Math.max(0, 1 - Math.max(0, now - a.completedAt - 250) / 750);
export const opacity = (a: Activity | undefined, now: number) => a?.removedAt === undefined
  ? a?.enteredAt === undefined ? 1 : Math.min(1, Math.max(0, (now - a.enteredAt) / 450))
  : Math.max(0, 1 - (now - a.removedAt) / 1000);

/** Mutations belong to private wrappers, never consumer objects or live d3 arrays. */
export function reconcile(previous: RuntimeGraph, nodes: readonly ActivityNode[], edges: readonly ActivityEdge[]): RuntimeGraph {
  const old = new Map(previous.nodes.map(n => [n.id, n]));
  const ids = new Set<string>();
  const next = nodes.map(spec => {
    if (ids.has(spec.id)) throw new Error('Duplicate activity node ID: ' + spec.id);
    ids.add(spec.id);
    const node: RuntimeNode = old.get(spec.id) ?? { id: spec.id, spec, x: spec.position?.x ?? 0, y: spec.position?.y ?? 0, homeX: 0, homeY: 0 };
    node.spec = spec;
    node.homeX = spec.position?.x ?? 0; node.homeY = spec.position?.y ?? 0;
    node.fx = spec.position?.anchored ? node.homeX : node.placed ? node.x : undefined;
    node.fy = spec.position?.anchored ? node.homeY : node.placed ? node.y : undefined;
    return node;
  });
  const edgeIds = new Set<string>();
  const links: RuntimeEdge[] = [];
  for (const spec of edges) {
    if (edgeIds.has(spec.id)) throw new Error('Duplicate activity edge ID: ' + spec.id);
    edgeIds.add(spec.id);
    // Partial streams can deliver edges first. Render once both nodes exist.
    if (ids.has(spec.source) && ids.has(spec.target)) links.push({ id: spec.id, source: spec.source, target: spec.target, spec });
  }
  return { nodes: next, links };
}

/** Only executing, highlighted nodes animate; completion stops the pulse immediately. */
export const isNodeActive = (node: ActivityNode, now: number): boolean =>
  (node.active ?? node.status === 'running') && node.activity?.completedAt === undefined &&
  node.activity?.removedAt === undefined && intensity(node.activity, now) > 0;
