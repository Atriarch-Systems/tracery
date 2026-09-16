/** `GET /workspaces` (SPEC.md §6 HTTP API table, admin-only). */
import type { FastifyInstance } from 'fastify';
import type { HubContext } from '../server-context.js';

export function registerWorkspacesRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get('/v1/workspaces', { schema: { summary: 'List workspaces and their stats', tags: ['workspaces'] } }, async (request, reply) => {
    const query = request.query as { workspace?: string };
    // Admin role required; a non-operator admin key only ever sees its own workspace's stats.
    // The operator key may omit `?workspace=` here to mean "all of them".
    const auth = await ctx.requireAuth(request, 'admin', query.workspace, { operatorWorkspaceOptional: true });
    const stats = await ctx.store.stats();
    const visible = auth.isOperator ? stats : stats.filter((entry) => entry.workspace === auth.workspace);
    reply.send({ workspaces: visible });
  });
}
