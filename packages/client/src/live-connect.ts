/**
 * Reconnect-with-backoff WebSocket driver shared by `HubClient.live` (an
 * authenticated `WS /v1/live` connection) and `ShareClient.live` (a public,
 * token-scoped `WS /v1/shares/:token/live` connection, docs/SHARING.md) --
 * pulled out of `hub-client.ts` so the two never drift apart on backoff,
 * jitter, or the "stable connection resets the floor" rule. Callers differ
 * only in how they build the socket URL for a given resume cursor.
 */
import type { ActivityFrame } from '@atriarch-systems/tracery-core';

export type LiveDisposer = () => void;

export interface LiveStatusEvent {
  readonly status: 'connecting' | 'open' | 'closed' | 'error';
  /** Reconnect attempts made since the backoff last reset (0 on the very first connect). */
  readonly attempt: number;
}

export interface LiveConnectOptions {
  readonly onStatus?: (event: LiveStatusEvent) => void;
  readonly onError?: (error: unknown) => void;
  readonly maxAttempts?: number;
  readonly stableAfterMs?: number;
}

/**
 * Opens a WebSocket built by `urlFor(cursor)` (called again on every
 * (re)connect with the last cursor seen, or `initialCursor` for the very
 * first attempt), calls `onFrame` for every parsed message, and reconnects
 * with capped, jittered exponential backoff on close. The backoff only
 * resets to its floor once a connection has stayed open past
 * `stableAfterMs`, so a socket that completes the upgrade and then
 * immediately closes (a rejected/expired credential, load-shedding, a
 * slow-client drop) backs off instead of reconnecting forever at the 200ms
 * floor. Returns a disposer that stops reconnecting and closes the socket.
 */
export function connectLive(
  WebSocketImpl: typeof WebSocket,
  urlFor: (cursor: number | undefined) => string,
  initialCursor: number | undefined,
  onFrame: (frame: ActivityFrame) => void,
  options: LiveConnectOptions = {},
): LiveDisposer {
  const { onStatus, onError, maxAttempts, stableAfterMs = 1000 } = options;

  let disposed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let cursor = initialCursor;

  const clearStableTimer = (): void => {
    if (stableTimer !== null) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };

  const scheduleReconnect = (): void => {
    clearStableTimer();
    onStatus?.({ status: 'closed', attempt });
    if (disposed) return;
    if (maxAttempts !== undefined && attempt >= maxAttempts) return;
    const capped = Math.min(200 * 2 ** attempt, 10_000);
    // Full jitter: many clients reconnecting after the same hub restart
    // should not all retry in lockstep.
    const delay = Math.random() * capped;
    attempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  function connect(): void {
    if (disposed) return;
    onStatus?.({ status: 'connecting', attempt });
    const ws = new WebSocketImpl(urlFor(cursor));
    socket = ws;
    ws.addEventListener('open', () => {
      onStatus?.({ status: 'open', attempt });
      // Reset the backoff only once the connection has proven itself by
      // staying open a while, not immediately on `open` -- see the doc
      // comment above.
      clearStableTimer();
      stableTimer = setTimeout(() => {
        attempt = 0;
        stableTimer = null;
      }, stableAfterMs);
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      let frame: ActivityFrame;
      try {
        frame = JSON.parse(String(event.data)) as ActivityFrame;
      } catch (err) {
        onError?.(err); // malformed frame; ignore and keep the connection open
        return;
      }
      try {
        // Advance the cursor only once the frame has actually been handed
        // off: if the consumer's own handler throws, the frame is not
        // marked seen, so a reconnect will replay it instead of leaving a
        // silent, permanent gap in the feed.
        onFrame(frame);
        cursor = frame.cursor;
      } catch (err) {
        onError?.(err);
      }
    });
    ws.addEventListener('error', (event) => {
      onError?.(event);
      // the 'close' event that follows drives reconnection
    });
    ws.addEventListener('close', scheduleReconnect);
  }

  connect();

  return () => {
    disposed = true;
    clearStableTimer();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
