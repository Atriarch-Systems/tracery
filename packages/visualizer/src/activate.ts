/** Pure double-click tracking so it is testable without a browser or pointer events. */
export interface DoubleClickState {
  readonly lastId: string | null;
  readonly lastTs: number;
}
export const emptyDoubleClickState = (): DoubleClickState => ({ lastId: null, lastTs: -Infinity });

/** react-force-graph-2d has no dblclick event; two `onNodeClick`s on the same node within
 * `windowMs` (default 350) count as one activation. A slow second click, or a click on a
 * different node, starts a fresh tracking window instead of activating. */
export function detectDoubleClick(
  state: DoubleClickState,
  id: string,
  now: number,
  windowMs = 350,
): { activated: boolean; next: DoubleClickState } {
  if (state.lastId === id && now - state.lastTs <= windowMs) {
    return { activated: true, next: emptyDoubleClickState() };
  }
  return { activated: false, next: { lastId: id, lastTs: now } };
}
