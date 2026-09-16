/** `GET /healthz`, `GET /readyz`, `GET /metrics` (SPEC.md §6 HTTP API table). */
import type { FastifyInstance } from 'fastify';
import type { HubContext } from '../server-context.js';
import { errorBody } from './errors.js';

function extractToken(request: { headers: Record<string, string | string[] | undefined>; query: unknown }): string | undefined {
  const query = request.query as { token?: string } | undefined;
  if (query?.token) return query.token;
  const header = request.headers['x-metrics-token'];
  if (typeof header === 'string') return header;
  const authorization = request.headers['authorization'];
  const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (authValue?.toLowerCase().startsWith('bearer ')) return authValue.slice('bearer '.length).trim();
  return undefined;
}

export function registerHealthRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get('/healthz', { schema: { summary: 'Liveness', tags: ['health'] } }, async (_request, reply) => {
    reply.send({ status: 'ok' });
  });

  app.get('/readyz', { schema: { summary: 'Readiness (store responsive)', tags: ['health'] } }, async (_request, reply) => {
    try {
      await ctx.store.stats();
      reply.send({ status: 'ready' });
    } catch (err) {
      reply.code(503).send(errorBody('not_ready', (err as Error).message));
    }
  });

  app.get('/metrics', { schema: { summary: 'Prometheus text exposition', tags: ['health'] } }, async (request, reply) => {
    if (ctx.config.metricsToken) {
      const token = extractToken(request as never);
      if (token !== ctx.config.metricsToken) {
        return reply.code(401).send(errorBody('unauthorized', 'invalid or missing metrics token'));
      }
    }
    const body = await ctx.metrics.render(ctx.store);
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(body);
  });
}
