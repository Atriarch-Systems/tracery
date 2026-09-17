/**
 * Shared `ActivityFrame` construction used by both `MemoryStore` and
 * `SqliteStore` for `flowEvents` / `traceFrame` / `workspaceFrame` and by
 * `live.ts` for WS snapshot/reconnect framing (SPEC.md §6 "Live feed").
 */
import type { ActivityFrame, StoredEvent } from '@atriarch/tracery-core/contract';

export interface FloorInfo {
  /** Smallest cursor still retained for the scope's workspace, or `undefined` if nothing has ever been evicted. */
  readonly floorCursor: number | undefined;
}

/**
 * hub-13: `floorCursor` is the smallest cursor the store still holds, not the
 * largest one it dropped, so a client sitting exactly at the eviction
 * boundary (`after === floorCursor - 1`) has lost nothing -- the very next
 * event it needs, `floorCursor`, is still retained. Comparing `after` against
 * `floorCursor - 1` (the highest cursor definitely evicted) instead of
 * `floorCursor` itself keeps `truncated` true only when data is actually gone.
 */
function isTruncated(after: number, floorCursor: number | undefined): boolean {
  return floorCursor !== undefined && after < floorCursor - 1;
}

/**
 * `scoped` must already be filtered to the requested flow/trace/workspace
 * and sorted by `cursor` ascending. `currentCursor` is the hub-wide cursor
 * at the moment of the read.
 */
export function buildFrame(
  scoped: readonly StoredEvent[],
  currentCursor: number,
  floor: FloorInfo,
  after: number | undefined,
): ActivityFrame {
  if (after === undefined) {
    return { type: 'snapshot', cursor: currentCursor, events: scoped, truncated: false };
  }

  const truncated = isTruncated(after, floor.floorCursor);
  if (truncated) {
    return { type: 'snapshot', cursor: currentCursor, events: scoped, truncated: true };
  }

  const delta = scoped.filter((event) => event.cursor > after);
  return { type: 'events', cursor: currentCursor, events: delta };
}
