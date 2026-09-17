/**
 * Sweep eligibility & ordering (SPEC.md §6 "Retention": "deletes the oldest
 * complete flows first, never a running flow younger than the retention
 * window"). Shared by `MemoryStore` and `SqliteStore` so the two engines
 * can't drift.
 *
 * `flow.startedAt` alone is not a safe protection/ordering key: a `partial`
 * flow (an `update`/`end`/`annotate` that arrived before its `start` --
 * SPEC.md §1, explicitly supported and re-projectable) has `startedAt ===
 * undefined` even though it may be brand new. Every candidate therefore also
 * carries `lastSeenAt`, the newest `receivedAt` among its retained events,
 * used as the fallback key so a just-arrived partial flow is protected like
 * any other young flow instead of being swept on the very next tick.
 */
import type { Flow } from '@atriarch/tracery-core';

export interface SweepCandidate {
  readonly flow: Flow;
  readonly lastSeenAt: number;
}

function key(candidate: SweepCandidate): number {
  return candidate.flow.startedAt ?? candidate.lastSeenAt;
}

/** True when `candidate` must survive both retention and max-event-count eviction this sweep. */
export function isSweepProtected(candidate: SweepCandidate, cutoff: number): boolean {
  return candidate.flow.status !== 'complete' && key(candidate) >= cutoff;
}

/** True when `candidate` is old enough (by `startedAt`, falling back to `lastSeenAt`) to be past the retention window. */
export function isOverRetention(candidate: SweepCandidate, cutoff: number): boolean {
  return key(candidate) < cutoff;
}

/**
 * Orders sweep candidates: complete flows first (oldest first), then
 * running/unknown flows (oldest first). Candidates for which
 * `isSweepProtected` holds must be filtered out by the caller before this is
 * of any use -- this function only orders, it does not filter.
 */
export function orderSweepCandidates(candidates: readonly SweepCandidate[]): SweepCandidate[] {
  const byAge = (a: SweepCandidate, b: SweepCandidate): number => key(a) - key(b);
  const complete = candidates.filter((c) => c.flow.status === 'complete').sort(byAge);
  const other = candidates.filter((c) => c.flow.status !== 'complete').sort(byAge);
  return [...complete, ...other];
}
