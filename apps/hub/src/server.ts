/**
 * Builds the Fastify app (SPEC.md §6 "Hub"). `createServer` is the seam the
 * enterprise layer (`apps/hub/ee`, SPEC.md §7) extends through: it never
 * edits this file, only passes `extensions` in.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import swaggerPlugin from '@fastify/swagger';
import { authenticate, AuthError, generateDevKey, type AuthContext } from './auth.js';
import type { ApiKeyConfig, Config, Role } from './config.js';
import { MemoryStore } from './store/memory.js';
import { SqliteStore } from './store/sqlite.js';
import type { EventStore } from './store/types.js';
import { MetricsRegistry } from './metrics.js';
import { startRetention, type RetentionHandle } from './retention.js';
import { registerLive } from './live.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerFlowsRoutes } from './routes/flows.js';
import { registerTracesRoutes } from './routes/traces.js';
import { registerWorkspacesRoutes } from './routes/workspaces.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerUiRoutes } from './routes/ui.js';
import type { HubContext, HubExtensions } from './server-context.js';

export type { HubContext, HubExtensions } from './server-context.js';

export interface CreatedServer {
  readonly app: FastifyInstance;
  readonly store: EventStore;
  readonly metrics: MetricsRegistry;
  readonly keys: readonly ApiKeyConfig[];
  /** The generated dev key, when no `ACTIVITY_API_KEYS*` was configured. Log it; it is never persisted. */
  readonly devKey: string | undefined;
  readonly retention: RetentionHandle;
  close(): Promise<void>;
}

function openStore(config: Config): EventStore {
  return config.store === 'sqlite' ? new SqliteStore(config.sqlitePath) : new MemoryStore();
}

export async function createServer(config: Config, extensions?: HubExtensions): Promise<CreatedServer> {
  const store = openStore(config);
  const metrics = new MetricsRegistry();

  let keys: readonly ApiKeyConfig[] = config.apiKeys ?? [];
  let devKey: string | undefined;
  if (keys.length === 0) {
    const dev = generateDevKey();
    keys = [dev.config];
    devKey = dev.key;
  }

  const app = Fastify({ logger: { level: config.logLevel } });

  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    const requestId = (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
    reply.header('x-request-id', requestId);
  });

  app.setErrorHandler((error: Error, request, reply) => {
    if (error instanceof AuthError) {
      reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: { code: 'internal_error', message: error.message || 'internal server error' } });
  });

  await app.register(websocketPlugin);
  await app.register(swaggerPlugin, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Atriarch Activity Hub', version: '0.1.0', description: 'SPEC.md §6 HTTP API.' },
    },
  });

  const requireAuth = async (
    request: FastifyRequest,
    role: Role,
    requestedWorkspace?: string,
    options?: { readonly operatorWorkspaceOptional?: boolean },
  ): Promise<AuthContext> => {
    const auth = authenticate(keys, request.headers as Record<string, string | string[] | undefined>, undefined, role, requestedWorkspace, options);
    await extensions?.onRequestAuthed?.({ request, auth });
    return auth;
  };

  const ctx: HubContext = { config, store, metrics, keys, requireAuth };

  registerHealthRoutes(app, ctx);
  registerEventsRoutes(app, ctx);
  registerFlowsRoutes(app, ctx);
  registerTracesRoutes(app, ctx);
  registerWorkspacesRoutes(app, ctx);
  registerLive(app, { store, keys, metrics, extensions });

  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // Registered last so ee's routes (e.g. /v1/license) and the UI's SPA
  // catch-all 404 handler see every built-in route already defined.
  await extensions?.registerRoutes?.(app, ctx);
  await registerUiRoutes(app, ctx);

  await app.ready();

  const retention = startRetention(store, metrics, {
    retentionHours: config.retentionHours,
    maxEventsPerWorkspace: config.maxEventsPerWorkspace,
  });

  return {
    app,
    store,
    metrics,
    keys,
    devKey,
    retention,
    close: async () => {
      retention.stop();
      await app.close();
      await store.close();
    },
  };
}
