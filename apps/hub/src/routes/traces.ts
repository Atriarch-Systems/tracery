/** `GET /traces/:id`, `GET /traces/:id/events` (SPEC.md §6 HTTP API table). */
import type { FastifyInstance } from 'fastify';
import type { HubContext } from '../server-context.js';
import { errorBody } from './errors.js';

export function registerTracesRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get<{ Params: { id: string } }>(
    '/v1/traces/:id',
    { schema: { summary: 'Trace: all member flows and their spawn links', tags: ['traces'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const trace = await ctx.store.getTrace(auth.workspace, request.params.id);
      if (!trace) return reply.code(404).send(errorBody('not_found', `no such trace: ${request.params.id}`));
      reply.send(trace);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/traces/:id/events',
    { schema: { summary: 'Every event for every flow in the trace', tags: ['traces'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const events = await ctx.store.traceEvents(auth.workspace, request.params.id);
      reply.send(events);
    },
  );
}
