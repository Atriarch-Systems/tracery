/**
 * A tiny hand-rolled history router (SPEC.md §6 "Deep links: /ui/flows/:id,
 * /ui/traces/:id"; PLAN.md workstream E "a tiny hand-rolled history router or
 * react-router ^7" -- this app takes the hand-rolled option to keep the
 * hosted UI's dependency surface to just React + the explorer package).
 * `parseRoute` is pure and exported separately so it is unit-testable
 * without a DOM; `useRoute` is the only piece that touches `window`.
 */
import { useEffect, useState } from 'react';

export type Route =
  | { readonly type: 'root' }
  | { readonly type: 'flow'; readonly id: string }
  | { readonly type: 'trace'; readonly id: string }
  | { readonly type: 'not-found'; readonly path: string };

/** Parses a pathname served under the hub's `/ui` mount point into a Route. */
export function parseRoute(pathname: string): Route {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const rel = trimmed === '/ui' || trimmed === '' ? '' : trimmed.startsWith('/ui/') ? trimmed.slice(3) : trimmed;

  if (rel === '' || rel === '/') return { type: 'root' };

  const flowMatch = /^\/flows\/([^/]+)$/.exec(rel);
  if (flowMatch) return { type: 'flow', id: decodeURIComponent(flowMatch[1]!) };

  const traceMatch = /^\/traces\/([^/]+)$/.exec(rel);
  if (traceMatch) return { type: 'trace', id: decodeURIComponent(traceMatch[1]!) };

  return { type: 'not-found', path: pathname };
}

/** Pushes a history entry for a path under `/ui` and notifies listeners. */
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return route;
}
