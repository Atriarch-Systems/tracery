/**
 * `WS /v1/live` (SPEC.md §6 "Live feed"): snapshot then events, heartbeat
 * every 15s, a slow client gets a 2s send deadline then is dropped, and
 * reconnect from `after=` replays from the store (or sends a truncated
 * snapshot when the store no longer holds that far back).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { ActivityFrame, StoredEvent } from '@atriarch/activity-core/contract';
import { authenticate, AuthError, type AuthContext } from './auth.js';
import type { ApiKeyConfig } from './config.js';
import type { EventStore } from './store/types.js';
import type { MetricsRegistry } from './metrics.js';

const HEARTBEAT_MS = 15_000;
const SEND_DEADLINE_MS = 2_000;

export interface LiveDeps {
  readonly store: EventStore;
  readonly keys: readonly ApiKeyConfig[];
  readonly metrics: MetricsRegistry;
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
      auth = authenticate(deps.keys, request.headers as Record<string, string | string[] | undefined>, query.token, 'read', query.workspace);
    } catch (err) {
      const message = err instanceof AuthError ? err.message : 'unauthorized';
      socket.close(4401, message);
      return;
    }

    const filter = { flow: query.flow, trace: query.trace };
    const initialAfter = query.after !== undefined && query.after !== '' ? Number(query.after) : undefined;

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
      request.log.warn({ keyId: auth.keyId }, 'activity live: slow client dropped after 2s send deadline');
      socket.terminate();
    };

    const send = (frame: ActivityFrame): void => {
      if (closed || socket.readyState !== socket.OPEN) return;
      sendWithDeadline(socket, frame, drop);
    };

    void frameFor(initialAfter).then(send);

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
      void belongsToFilter(event).then((matches) => {
        if (matches) send({ type: 'events', cursor: event.cursor, events: [event] });
      });
    });

    const heartbeat = setInterval(() => {
      void frameFor(undefined).then((current) => send({ type: 'heartbeat', cursor: current.cursor }));
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
