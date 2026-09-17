/**
 * Pure flow-picker ordering (SPEC.md §4 "flow picker (latest N flows, active
 * ones first, 'follow latest' default)"). No React, no I/O.
 */
import type { Flow } from '@atriarch/tracery-core';

/** Active flows (status `running`) first, then newest-started first. Stable on id as a final tiebreak. */
export function orderFlows(flows: ReadonlyMap<string, Flow>): Flow[] {
  return [...flows.values()].sort((a, b) => {
    const activeRank = (flow: Flow): number => (flow.status === 'running' ? 0 : 1);
    const rankDiff = activeRank(a) - activeRank(b);
    if (rankDiff !== 0) return rankDiff;
    const aStart = a.startedAt ?? 0;
    const bStart = b.startedAt ?? 0;
    if (aStart !== bStart) return bStart - aStart;
    return a.id.localeCompare(b.id);
  });
}

/** `orderFlows`, capped to the first `limit` entries (default 50). */
export function latestFlows(flows: ReadonlyMap<string, Flow>, limit = 50): Flow[] {
  return orderFlows(flows).slice(0, limit);
}

/** The flow "follow latest" should select, or undefined when there are none. */
export function latestFlowId(flows: ReadonlyMap<string, Flow>): string | undefined {
  return orderFlows(flows)[0]?.id;
}
