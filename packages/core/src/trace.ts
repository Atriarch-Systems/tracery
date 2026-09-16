/**
 * Groups flows that share a resolved trace id (SPEC.md §1 "Trace resolution")
 * and walks parent chains. Flow.trace is already resolved by flows.ts (it must
 * always be populated, including cycle-broken and "parent not yet observed"
 * cases); this module only gathers and orders what flows.ts already computed.
 */
import type { Flow } from './flows.js';

export interface TraceLink {
  readonly parent: string;
  readonly child: string;
  readonly parentOp?: string;
  readonly parentNode?: string;
}

export interface Trace {
  readonly root: string;
  readonly flows: readonly Flow[];
  readonly links: readonly TraceLink[];
  /** parentFlow ids referenced by a member's link but never observed as a flow. */
  readonly missing: readonly string[];
}

/**
 * Assembles every flow sharing `anyFlowInTrace`'s resolved trace id. `flows`
 * may or may not itself resolve if unknown; the whole map is walked so the
 * result reflects the flows that are actually present.
 */
export function assembleTrace(flows: ReadonlyMap<string, Flow>, anyFlowInTrace: string): Trace {
  const anchor = flows.get(anyFlowInTrace);
  const traceId = anchor ? anchor.trace : anyFlowInTrace;

  const members: Flow[] = [];
  for (const flow of flows.values()) if (flow.trace === traceId) members.push(flow);
  members.sort((a, b) => {
    const aStart = a.startedAt ?? Number.POSITIVE_INFINITY;
    const bStart = b.startedAt ?? Number.POSITIVE_INFINITY;
    return aStart - bStart || a.id.localeCompare(b.id);
  });

  const links: TraceLink[] = [];
  const missing = new Set<string>();
  for (const flow of members) {
    if (!flow.link) continue;
    const parentId = flow.link.parentFlow;
    links.push({ parent: parentId, child: flow.id, parentOp: flow.link.parentOp, parentNode: flow.link.parentNode });
    if (!flows.has(parentId)) missing.add(parentId);
  }

  const root = (members.find((flow) => flow.id === traceId) ?? members.find((flow) => !flow.link) ?? members[0])?.id ?? traceId;

  return { root, flows: members, links, missing: [...missing] };
}

/** The root-first chain of ancestor flow ids for `flow` (excluding `flow` itself). Stops at the first unobserved or cyclic parent. */
export function ancestors(flows: ReadonlyMap<string, Flow>, flow: string): readonly string[] {
  const chain: string[] = [];
  const visited = new Set<string>([flow]);
  let current = flows.get(flow);

  while (current && current.link) {
    const parentId = current.link.parentFlow;
    if (visited.has(parentId)) break; // cycle guard
    const parent = flows.get(parentId);
    if (!parent) break; // parent not observed yet (late parent)
    chain.push(parentId);
    visited.add(parentId);
    current = parent;
  }

  return chain.reverse();
}
