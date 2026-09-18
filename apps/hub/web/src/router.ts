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
  | { readonly type: 'share'; readonly token: string }
  | { readonly type: 'not-found'; readonly path: string };

/**
 * `decodeURIComponent` throws `URIError` on a malformed escape (a stray or
 * truncated `%`); browsers preserve such bytes verbatim in
 * `location.pathname`, so any deep link with one would otherwise propagate
 * out of `useRoute`'s render with no error boundary above it and blank the
 * page instead of hitting the `not-found` branch below. Fall back to the
 * raw (still-encoded) segment rather than fail the whole route parse over it.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parses a pathname served under the hub's `/ui` mount point into a Route --
 * except `/s/:token` (docs/SHARING.md "Share page"), which `GET /s/:token`
 * (`routes/share-page.ts`) serves this SAME `index.html` from, outside `/ui`
 * entirely, so it is matched against the raw pathname first.
 */
export function parseRoute(pathname: string): Route {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  const shareMatch = /^\/s\/([^/]+)$/.exec(trimmed);
  if (shareMatch) return { type: 'share', token: safeDecode(shareMatch[1]!) };

  const rel = trimmed === '/ui' || trimmed === '' ? '' : trimmed.startsWith('/ui/') ? trimmed.slice(3) : trimmed;

  if (rel === '' || rel === '/') return { type: 'root' };

  const flowMatch = /^\/flows\/([^/]+)$/.exec(rel);
  if (flowMatch) return { type: 'flow', id: safeDecode(flowMatch[1]!) };

  const traceMatch = /^\/traces\/([^/]+)$/.exec(rel);
  if (traceMatch) return { type: 'trace', id: safeDecode(traceMatch[1]!) };

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
