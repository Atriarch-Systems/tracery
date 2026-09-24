/**
 * Trace id resolution (SPEC.md §1 "Trace resolution"), operating only on
 * already-reduced flows' `{ id, link }` -- never on the raw event log.
 *
 * `@atriarch-systems/tracery-core`'s `buildFlows` computes this internally but does
 * not export it standalone, and re-running `buildFlows` over a workspace's
 * entire event log on every append/delete is exactly the O(events) cost
 * hub-2 removes (see `memory.ts`/`sqlite.ts`). This is the same algorithm
 * (walk the `parentFlow` chain, breaking cycles by treating the first flow
 * seen as the root, memoising as it goes), scoped down to the small
 * `{id, link}` shape so it costs O(flows) -- typically far fewer than
 * O(events) -- and can be re-run after every incremental flow update without
 * reintroducing a whole-workspace event reduction.
 */
import type { Flow } from '@atriarch-systems/tracery-core';

export type LinkedFlow = Pick<Flow, 'id' | 'link'>;

export function resolveTraceIds(flows: ReadonlyMap<string, LinkedFlow>): Map<string, string> {
  const resolved = new Map<string, string>();

  const resolveOne = (startId: string): string => {
    const path: string[] = [];
    const pathSet = new Set<string>();
    let id = startId;

    const finish = (result: string): string => {
      resolved.set(id, result);
      for (const p of path) resolved.set(p, result);
      return result;
    };

    for (;;) {
      const cached = resolved.get(id);
      if (cached !== undefined) return finish(cached);

      const flow = flows.get(id);
      if (!flow || !flow.link) return finish(id);
      if (flow.link.trace) return finish(flow.link.trace);

      const parentId = flow.link.parentFlow;
      const parent = flows.get(parentId);
      if (!parent) {
        // Parent may arrive later; use its id as the trace id placeholder.
        return finish(parentId);
      }
      if (pathSet.has(parentId)) {
        // Cycle: the first flow seen in this walk is treated as the root.
        return finish(path[0]!);
      }

      path.push(id);
      pathSet.add(id);
      id = parentId;
    }
  };

  for (const id of flows.keys()) resolveOne(id);
  return resolved;
}
