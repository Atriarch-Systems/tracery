/**
 * Framework-free engine behind `useShareSource` (docs/SHARING.md), mirroring
 * `hub-feed-engine.ts`'s design for a token-scoped `ShareClient` instead of
 * an authenticated `HubClient`. Two real differences from the hub engine:
 *
 * - A `'snapshot'`-mode share never changes after creation (every read is
 *   capped at its `snapshotCursor`), so it gets exactly one fetch -- no
 *   WebSocket, no poll timer, nothing left to reconnect.
 * - A `'live'`-mode share has no unscoped case to worry about (`canPoll` is
 *   always true: a share always names one flow or trace), so there is no
 *   `offline` branch here the way `hub-feed-engine.ts` has for a source with
 *   neither a `flow` nor a `trace`.
 */
import { ShareClient, type ActivityFrame } from '@atriarch/tracery-client';
import { feedReducer, initialFeedState, shouldPoll, type FeedState } from './feed.js';
import { instrumentedWebSocket } from './hub-feed-engine.js';

export interface ShareFeedEngineOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Whether the share is `mode: 'live'` -- a `'snapshot'` share skips the socket/poll machinery entirely (see module doc). */
  readonly live: boolean;
  readonly pollIntervalMs: number;
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
  readonly onFrame: (frame: ActivityFrame) => void;
  readonly onFeed: (state: FeedState) => void;
  readonly onError: (message: string | undefined) => void;
}

export interface ShareFeedEngine {
  dispose(): void;
}

export function startShareFeed(options: ShareFeedEngineOptions): ShareFeedEngine {
  const { baseUrl, token, live, pollIntervalMs, fetch: fetchImpl, onFrame, onFeed, onError } = options;

  let disposed = false;
  let feedState = initialFeedState();
  let disposeLive: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let cursor: number | undefined;

  const applyFeed = (next: FeedState): void => {
    feedState = next;
    onFeed(next);
  };

  const startPolling = (): void => {
    if (pollTimer !== undefined || disposed) return;
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          const frame = await client.events(cursor);
          if (disposed) return;
          cursor = frame.cursor;
          onFrame(frame);
          onError(undefined);
          applyFeed(feedReducer(feedState, { type: 'poll-ok', frame }));
        } catch (err) {
          if (disposed) return;
          onError(err instanceof Error ? err.message : String(err));
          applyFeed(feedReducer(feedState, { type: 'poll-error' }));
        }
      })();
    }, pollIntervalMs);
  };

  const onSocketDrop = (): void => {
    if (disposed) return;
    const wasPolling = shouldPoll(feedState);
    applyFeed(feedReducer(feedState, { type: 'disconnect' }));
    if (shouldPoll(feedState) && !wasPolling) {
      disposeLive?.();
      disposeLive = undefined;
      startPolling();
    }
  };

  const RealWebSocket = options.WebSocket ?? (typeof WebSocket === 'function' ? WebSocket : undefined);
  const client = new ShareClient({
    baseUrl,
    token,
    fetch: fetchImpl,
    WebSocket: typeof RealWebSocket === 'function' ? instrumentedWebSocket(RealWebSocket, onSocketDrop) : undefined,
  });

  if (!live) {
    // A snapshot share is immutable from the moment it is created -- one
    // fetch is the whole story.
    void client
      .events()
      .then((frame) => {
        if (disposed) return;
        cursor = frame.cursor;
        onFrame(frame);
        applyFeed(feedReducer(feedState, { type: 'frame', frame }));
      })
      .catch((err) => {
        if (disposed) return;
        onError(err instanceof Error ? err.message : String(err));
        applyFeed({ ...feedState, status: 'offline' });
      });
  } else if (typeof RealWebSocket === 'function') {
    disposeLive = client.live((frame) => {
      cursor = frame.cursor;
      onFrame(frame);
      applyFeed(feedReducer(feedState, { type: 'frame', frame }));
    });
  } else {
    // No WebSocket available at all (SSR, or a Node host with none provided): go straight to polling.
    startPolling();
  }

  return {
    dispose(): void {
      disposed = true;
      disposeLive?.();
      if (pollTimer !== undefined) clearInterval(pollTimer);
    },
  };
}
