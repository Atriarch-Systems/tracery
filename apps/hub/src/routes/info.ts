/**
 * `GET /v1/info` (task: "local mode" -- lets a client, the hosted UI or the
 * demo script included, discover the hub's identity and auth requirements
 * with a single unauthenticated call before deciding whether to show a
 * key-entry screen at all). Public: no `ctx.requireAuth` call, same as
 * `/healthz`/`/readyz`.
 */
import type { FastifyInstance } from 'fastify';
import { hubVersion } from '../config.js';
import { LOCAL_MODE_WORKSPACE } from '../auth.js';
import type { HubContext } from '../server-context.js';

export interface HubInfoBody {
  readonly product: 'tracery';
  readonly version: string;
  readonly edition: 'community' | 'licensed';
  readonly auth: 'none' | 'keys';
  /** Present only in `authMode: 'none'` -- the single workspace it serves. */
  readonly workspace?: string;
}

export function registerInfoRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get('/v1/info', { schema: { summary: 'Hub identity: product, version, edition, auth mode', tags: ['info'] } }, async (_request, reply) => {
    const body: HubInfoBody = {
      product: 'tracery',
      version: hubVersion(),
      edition: ctx.isLicensed() ? 'licensed' : 'community',
      auth: ctx.config.authMode,
      ...(ctx.config.authMode === 'none' ? { workspace: LOCAL_MODE_WORKSPACE } : {}),
    };
    reply.send(body);
  });
}
