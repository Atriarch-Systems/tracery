/**
 * `WS /v1/live` (SPEC.md §6 "Live feed"): snapshot then events, heartbeat
 * every 15s, a slow client gets a 2s send deadline then is dropped, and
 * reconnect from `after=` replays from the store (or sends a truncated
 * snapshot when the store no longer holds that far back).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { ActivityFrame, StoredEvent } from '@atriarch/tracery-core/contract';
import { authenticate, localModeAuth, AuthError, type AuthContext } from './auth.js';
import type { ApiKeyConfig, AuthMode } from './config.js';
import type { EventStore } from './store/types.js';
import type { MetricsRegistry } from './metrics.js';
import type { HubExtensions } from './server-context.js';
import { InvalidQueryError, parseCursor } from './routes/query.js';

const HEARTBEAT_MS = 15_000;
const SEND_DEADLINE_MS = 2_000;

export interface LiveDeps {
  readonly store: EventStore;
  readonly keys: readonly ApiKeyConfig[];
  readonly metrics: MetricsRegistry;
  /** Optional enterprise extensions (SPEC.md §7). Only `onLiveFrame` is used here. */
  readonly extensions?: HubExtensions;
  /** Task ("local mode"): `'none'` bypasses key lookup, same as `server.ts`'s `requireAuth`. */
  readonly authMode: AuthMode;
}

interface LiveQuery {
  readonly workspace?: string;
  readonly flow?: string;
  readonly trace?: string;
  readonly after?: string;
  readonly token?: string;
}

/** Sends a frame; if the client hasn't acked within `SEND_DEADLINE_MS` it is treated as slow and dropped. */
function sendWithDeadline(socket: WebSocket, frame: ActivityFrame, onSlow: () => void): void {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    onSlow();
  }, SEND_DEADLINE_MS);

  try {
    socket.send(JSON.stringify(frame), () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    });
  } catch {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      onSlow();
    }
  }
}

export function registerLive(app: FastifyInstance, deps: LiveDeps): void {
  app.get('/v1/live', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const query = request.query as LiveQuery;

    let auth: AuthContext;
    try {
      auth =
        deps.authMode === 'none'
          ? localModeAuth(query.workspace)
          : authenticate(deps.keys, request.headers as Record<string, string | string[] | undefined>, query.token, 'read', query.workspace);
    } catch (err) {
      const message = err instanceof AuthError ? err.message : 'unauthorized';
      // hub-5-style precision: a local-mode workspace rejection is a 400
      // (bad request -- "you asked for a workspace this hub can't serve"),
      // not a 401/403 (credential problem); distinguish the WS close code so
      // a client can tell the two apart the way an HTTP caller would from
      // the status code.
      const closeCode = err instanceof AuthError && err.status === 400 ? 4400 : 4401;
      socket.close(closeCode, message);
      return;
    }

    let initialAfter: number | undefined;
    try {
      initialAfter = parseCursor(query.after, 'after');
    } catch (err) {
      const message = err instanceof InvalidQueryError ? err.message : 'invalid after cursor';
      socket.close(4400, message);
      return;
    }
    const filter = { flow: query.flow, trace: query.trace };

    deps.metrics.wsClientConnected();
    let closed = false;

    const frameFor = async (after: number | undefined): Promise<ActivityFrame> => {
      if (filter.trace) return deps.store.traceFrame(auth.workspace, filter.trace, after);
      if (filter.flow) return deps.store.flowEvents(auth.workspace, filter.flow, after);
      return deps.store.workspaceFrame(auth.workspace, after);
    };

    const drop = (): void => {
      if (closed) return;
      closed = true;
      request.log.warn({ keyId: auth.keyId }, 'tracery live: slow client dropped after 2s send deadline');
      socket.terminate();
    };

    const send = (frame: ActivityFrame): void => {
      if (closed || socket.readyState !== socket.OPEN) return;
      const filtered = deps.extensions?.onLiveFrame ? deps.extensions.onLiveFrame({ auth, frame }) : frame;
      if (filtered === null) return; // dropped by an extension (e.g. rbac scope filtering)
      sendWithDeadline(socket, filtered, drop);
    };

    // hub-9: a store failure here must close this one connection, not crash the
    // process -- these `void promise.then(...)` calls had no `.catch` at all, so a
    // rejection (e.g. sqlite hitting SQLITE_BUSY) was an unhandled rejection under
    // Node's default `--unhandled-rejections=throw`.
    const onStoreError = (err: unknown): void => {
      request.log.error({ err, keyId: auth.keyId }, 'tracery live: store call failed');
      if (!closed) {
        closed = true;
        socket.close(1011, 'internal error');
      }
    };

    void frameFor(initialAfter).then(send).catch(onStoreError);

    const belongsToFilter = async (event: StoredEvent): Promise<boolean> => {
      if (event.workspace !== auth.workspace) return false;
      if (filter.flow) return event.flow === filter.flow;
      if (filter.trace) {
        const summary = await deps.store.flowSummary(auth.workspace, event.flow);
        return summary?.trace === filter.trace;
      }
      return true;
    };

    const unsubscribe = deps.store.subscribe((event) => {
      void belongsToFilter(event)
        .then((matches) => {
          if (matches) send({ type: 'events', cursor: event.cursor, events: [event] });
        })
        .catch(onStoreError);
    });

    const heartbeat = setInterval(() => {
      void frameFor(undefined)
        .then((current) => send({ type: 'heartbeat', cursor: current.cursor }))
        .catch(onStoreError);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      deps.metrics.wsClientDisconnected();
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}
