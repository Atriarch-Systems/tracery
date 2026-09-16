/**
 * Wraps `@atriarch/activity-core`'s `project()` as a memoized hook (SPEC.md
 * §4 `useProjection(source, scope, options)`).
 */
import { useMemo } from 'react';
import { project, type Flow, type NodeRecord, type NodePresentation, type Projection, type Scope } from '@atriarch/activity-core';
import type { ActivitySource } from './source.js';
import { scopeKey } from './scope.js';

export interface UseProjectionOptions {
  readonly catalog?: (node: NodeRecord, flow: Flow) => NodePresentation;
  readonly now?: number;
  readonly history?: { readonly keepCompletedMs?: number };
}

export function useProjection(source: ActivitySource, scope: Scope, options?: UseProjectionOptions): Projection {
  const key = scopeKey(scope);
  const keepCompletedMs = options?.history?.keepCompletedMs;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is scope's stable identity; `catalog`/`now` are read directly.
  return useMemo(
    () => project(source.flows, scope, options),
    [source.flows, key, options?.catalog, options?.now, keepCompletedMs],
  );
}
