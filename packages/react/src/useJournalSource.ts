/**
 * In-process source: the app owns a `Journal` (from `@atriarch/tracery-core`)
 * and appends events to it itself (SPEC.md §4 `useJournalSource(journal)`).
 * `Journal` has no change notification of its own, so this hook re-derives
 * flows on a light poll; it always recomputes at least once synchronously
 * (including during `react-dom/server` rendering, where the poll effect never
 * runs) so a journal that is already populated -- e.g. the fixture trace --
 * renders correctly on the first pass.
 */
import { useEffect, useMemo, useState } from 'react';
import { buildFlows, type Journal } from '@atriarch/tracery-core';
import type { ActivitySource } from './source.js';

export interface UseJournalSourceOptions {
  /** How often to re-derive flows from the journal. Default 250ms. */
  readonly pollIntervalMs?: number;
}

export function useJournalSource(journal: Journal, options?: UseJournalSourceOptions): ActivitySource {
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), pollIntervalMs);
    return () => clearInterval(interval);
  }, [journal, pollIntervalMs]);

  const flows = useMemo(() => buildFlows(journal.events()), [journal, tick]);

  return { flows, status: 'live', cursor: undefined, partial: journal.partial };
}
