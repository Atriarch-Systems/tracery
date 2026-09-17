/**
 * Pure connection/cursor state machine for `useHubSource` (SPEC.md §4). Kept
 * free of WebSocket/timer/DOM code so it is testable without a browser: the
 * hook owns the socket and the poll timer, and only ever calls `feedReducer`.
 *
 * States: `connecting` (initial, no frame yet) -> `live` (a frame has been
 * applied) -> on disconnect, `reconnecting` for the first WS failure, then
 * `polling` from the second failure onward (SPEC.md §4 "falls back to polling
 * ... when WS fails twice"). A frame applied while `polling` keeps the status
 * `polling` -- this reducer never moves the feed back to `live` on its own;
 * the hook may start a fresh socket and feed a `frame` action to recover.
 */
import type { ActivityFrame } from '@atriarch/tracery-client';

export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

export interface FeedState {
  readonly status: FeedStatus;
  /** Hub cursor of the last applied frame; the reconnect/poll `after` value. */
  readonly cursor?: number;
  /** Consecutive WS close/error events since the last successfully applied WS frame. */
  readonly wsFailures: number;
  /** True once a `snapshot` frame arrived with `truncated: true` (the store no longer holds the requested `after`). */
  readonly truncated: boolean;
}

/** WS failures at which the feed gives up on the socket and falls back to polling. */
export const WS_FAILURES_BEFORE_POLLING = 2;

export function initialFeedState(after?: number): FeedState {
  return { status: 'connecting', cursor: after, wsFailures: 0, truncated: false };
}

export type FeedAction =
  /** A frame arrived over the live WebSocket: snapshot, events, or heartbeat. */
  | { readonly type: 'frame'; readonly frame: ActivityFrame }
  /** The WebSocket closed or errored. */
  | { readonly type: 'disconnect' }
  /** A polling GET succeeded and returned a frame-shaped result. */
  | { readonly type: 'poll-ok'; readonly frame: ActivityFrame }
  /** A polling GET failed; the feed stays in `polling` and the hook will retry on its interval. */
  | { readonly type: 'poll-error' }
  /** Start over (e.g. the hook's inputs changed and it tore down and rebuilt the source). */
  | { readonly type: 'reset'; readonly after?: number };

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case 'frame': {
      const { frame } = action;
      const truncated = frame.type === 'snapshot' ? frame.truncated : state.truncated;
      return { status: 'live', cursor: frame.cursor, wsFailures: 0, truncated };
    }
    case 'disconnect': {
      const wsFailures = state.wsFailures + 1;
      const status: FeedStatus = wsFailures >= WS_FAILURES_BEFORE_POLLING ? 'polling' : 'reconnecting';
      return { ...state, wsFailures, status };
    }
    case 'poll-ok': {
      const { frame } = action;
      const truncated = frame.type === 'snapshot' ? frame.truncated : state.truncated;
      return { ...state, status: 'polling', cursor: frame.cursor, truncated };
    }
    case 'poll-error':
      return state.status === 'polling' ? state : { ...state, status: 'polling' };
    case 'reset':
      return initialFeedState(action.after);
    default:
      return state;
  }
}

/** The cursor a reconnect or the next poll should resume from. */
export function reconnectAfter(state: FeedState): number | undefined {
  return state.cursor;
}

/** True once the feed has given up on the socket and the hook should be driving a poll timer. */
export function shouldPoll(state: FeedState): boolean {
  return state.status === 'polling';
}
