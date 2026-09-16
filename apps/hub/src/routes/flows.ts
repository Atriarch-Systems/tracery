/**
 * `GET /flows`, `GET /flows/:id`, `GET /flows/:id/events`, `DELETE /flows/:id`
 * (SPEC.md §6 HTTP API table).
 */
import type { FastifyInstance } from 'fastify';
import type { FlowStatus } from '@atriarch/activity-core';
import type { HubContext } from '../server-context.js';
import { errorBody } from './errors.js';

interface ListFlowsQueryString {
  readonly workspace?: string;
  readonly limit?: string;
  readonly before?: string;
  readonly status?: string;
  readonly actor?: string;
  readonly trace?: string;
  readonly q?: string;
}

const FLOW_STATUSES: readonly FlowStatus[] = ['running', 'error', 'unknown', 'complete'];

function isFlowStatus(value: string | undefined): value is FlowStatus {
  return value !== undefined && (FLOW_STATUSES as readonly string[]).includes(value);
}

export function registerFlowsRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get('/v1/flows', { schema: { summary: 'List flows newest first', tags: ['flows'] } }, async (request, reply) => {
    const query = request.query as ListFlowsQueryString;
    const auth = await ctx.requireAuth(request, 'read', query.workspace);

    if (query.status !== undefined && !isFlowStatus(query.status)) {
      return reply.code(400).send(errorBody('invalid_query', `status must be one of ${FLOW_STATUSES.join(', ')}`));
    }

    const result = await ctx.store.listFlows(auth.workspace, {
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      before: query.before,
      status: isFlowStatus(query.status) ? query.status : undefined,
      actor: query.actor,
      trace: query.trace,
      q: query.q,
    });
    reply.send(result);
  });

  app.get<{ Params: { id: string } }>(
    '/v1/flows/:id',
    { schema: { summary: 'Flow summary (ops/nodes/edges, no events)', tags: ['flows'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const flow = await ctx.store.flowSummary(auth.workspace, request.params.id);
      if (!flow) return reply.code(404).send(errorBody('not_found', `no such flow: ${request.params.id}`));
      reply.send(flow);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/flows/:id/events',
    { schema: { summary: 'Flow events: snapshot, or the delta after a cursor', tags: ['flows'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string; after?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const after = query.after !== undefined && query.after !== '' ? Number(query.after) : undefined;
      const frame = await ctx.store.flowEvents(auth.workspace, request.params.id, after);
      reply.send(frame);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/flows/:id',
    { schema: { summary: 'Delete a flow and its events', tags: ['flows'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string };
      const auth = await ctx.requireAuth(request, 'admin', query.workspace);
      const deleted = await ctx.store.deleteFlow(auth.workspace, request.params.id);
      if (!deleted) return reply.code(404).send(errorBody('not_found', `no such flow: ${request.params.id}`));
      reply.code(204).send();
    },
  );
}
