/**
 * Share links (docs/SHARING.md): sharing is the viral loop, so every public
 * route here takes no API key at all -- the token in the path is the whole
 * credential -- and a share that is unknown, expired or revoked 404s
 * identically, so a scan can never distinguish "never existed" from "existed
 * once". Authenticated routes (`POST`/`GET`/`DELETE`/`PUT` under
 * `/v1/shares`) manage the capability; public routes (`/v1/shares/:token/*`,
 * `WS /v1/shares/:token/live`) read through it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { buildFlow, buildFlows, assembleTrace } from '@atriarch-systems/tracery-core';
import type { ActivityFrame, StoredEvent } from '@atriarch-systems/tracery-core/contract';
import type { HubContext } from '../server-context.js';
import type { AuthContext } from '../auth.js';
import { errorBody } from './errors.js';
import { InvalidQueryError, parseCursor } from './query.js';
import { attachLiveSocket, type LiveFilter } from '../live.js';
import { toFlowSummary, type FlowSummary, type TraceSummary } from '../store/types.js';
import {
  isShareUsable,
  DEFAULT_SHARE_EXPIRY_DAYS,
  SHARE_PREVIEW_MAX_BYTES,
  type ShareMode,
  type ShareRecord,
  type ShareTargetType,
} from '../store/share-types.js';
import { redactFlowSummary, redactFrame, redactTraceSummary } from './redact.js';
import { TokenBucketLimiter } from './rate-limit.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_RATE_LIMIT = { capacity: 60, windowMs: 60_000 }; // 60/min per IP (docs/SHARING.md "Rate limits")
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Public base URL / share URL (shared with routes/share-page.ts)
// ---------------------------------------------------------------------------

function requestOrigin(request: FastifyRequest): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() || request.protocol;
  const forwardedHost = request.headers['x-forwarded-host'];
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() ||
    (Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host) ||
    request.hostname;
  return `${proto}://${host}`;
}

/** `TRACERY_PUBLIC_URL` when set, else the inbound request's own origin (README.md / docs/SHARING.md "TRACERY_PUBLIC_URL"). */
export function resolvePublicBaseUrl(ctx: HubContext, request: FastifyRequest): string {
  return ctx.config.publicUrl ?? requestOrigin(request).replace(/\/+$/, '');
}

export function shareUrl(ctx: HubContext, request: FastifyRequest, token: string): string {
  return `${resolvePublicBaseUrl(ctx, request)}/s/${token}`;
}

// ---------------------------------------------------------------------------
// Snapshot-capped, redaction-aware reads (shared by the authed "own share"
// preview affordances and the public token routes)
// ---------------------------------------------------------------------------

/** `undefined` for a `'live'` share (no cap), or one created before any events existed. */
function cappedEvents(events: readonly StoredEvent[], share: ShareRecord): readonly StoredEvent[] {
  if (share.mode !== 'snapshot' || share.snapshotCursor === undefined) return events;
  return events.filter((event) => event.cursor <= share.snapshotCursor!);
}

/** `store.flowEvents`/`traceFrame` never actually resolve to the `'heartbeat'` variant of `ActivityFrame` (only `live.ts` constructs those) -- this just gives the type checker that same guarantee at the two call sites below. */
function frameEvents(frame: ActivityFrame): readonly StoredEvent[] {
  return frame.type === 'heartbeat' ? [] : frame.events;
}

/** Reduces the share's flow target as of its `snapshotCursor` in `'snapshot'` mode, or reads the live summary in `'live'` mode. `undefined` when the target isn't a flow, or a snapshot cursor predates every event the flow ever had. */
export async function flowSummaryForShare(ctx: HubContext, share: ShareRecord): Promise<FlowSummary | undefined> {
  if (share.target.type !== 'flow') return undefined;
  if (share.mode !== 'snapshot' || share.snapshotCursor === undefined) {
    return ctx.store.flowSummary(share.workspace, share.target.id);
  }
  const frame = await ctx.store.flowEvents(share.workspace, share.target.id);
  const events = cappedEvents(frameEvents(frame), share);
  if (events.length === 0) return undefined;
  return toFlowSummary(buildFlow(events));
}

/** Same idea as `flowSummaryForShare`, for a `'trace'` target. */
export async function traceSummaryForShare(ctx: HubContext, share: ShareRecord): Promise<TraceSummary | undefined> {
  if (share.target.type !== 'trace') return undefined;
  if (share.mode !== 'snapshot' || share.snapshotCursor === undefined) {
    return ctx.store.getTrace(share.workspace, share.target.id);
  }
  const events = cappedEvents(await ctx.store.traceEvents(share.workspace, share.target.id), share);
  if (events.length === 0) return undefined;
  const flows = buildFlows(events);
  const trace = assembleTrace(flows, share.target.id);
  if (trace.flows.length === 0) return undefined;
  return { root: trace.root, flows: trace.flows.map(toFlowSummary), links: trace.links, missing: trace.missing };
}

async function frameForShare(ctx: HubContext, share: ShareRecord, after: number | undefined): Promise<ActivityFrame> {
  const raw =
    share.target.type === 'trace'
      ? await ctx.store.traceFrame(share.workspace, share.target.id, after)
      : await ctx.store.flowEvents(share.workspace, share.target.id, after);
  if (share.mode !== 'snapshot' || share.snapshotCursor === undefined || raw.type === 'heartbeat') return raw;
  return { ...raw, events: cappedEvents(raw.events, share) };
}

/** `GET /v1/shares/:token/meta`'s `label`: the target flow's label, or the trace root flow's. Falls back to the raw id when nothing has been reduced yet (an empty/expired-cursor snapshot). */
export async function shareLabel(ctx: HubContext, share: ShareRecord): Promise<string> {
  if (share.target.type === 'flow') {
    const summary = await flowSummaryForShare(ctx, share);
    return summary?.label ?? share.target.id;
  }
  const trace = await traceSummaryForShare(ctx, share);
  const root = trace?.flows.find((flow) => flow.id === trace.root) ?? trace?.flows[0];
  return root?.label ?? share.target.id;
}

// ---------------------------------------------------------------------------
// Authenticated routes: POST/GET/DELETE /v1/shares, PUT .../preview
// ---------------------------------------------------------------------------

interface ShareTargetBody {
  readonly type?: unknown;
  readonly id?: unknown;
}

interface CreateShareBody {
  readonly target?: ShareTargetBody;
  readonly mode?: unknown;
  readonly includeContext?: unknown;
  readonly expiresInDays?: unknown;
}

function isShareTargetType(value: unknown): value is ShareTargetType {
  return value === 'flow' || value === 'trace';
}

function isShareMode(value: unknown): value is ShareMode {
  return value === 'snapshot' || value === 'live';
}

/** The public shape of a share for the authenticated list/detail views -- the token is never included (docs/SHARING.md: "list ... tokens omitted"). Callers that just created or fetched-by-id a share get the token separately, once, from that specific response. */
function publicShareView(share: ShareRecord) {
  return {
    id: share.id,
    workspace: share.workspace,
    target: share.target,
    mode: share.mode,
    snapshotCursor: share.snapshotCursor,
    includeContext: share.includeContext,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    preview: share.preview,
  };
}

function canManage(auth: AuthContext, share: ShareRecord): boolean {
  return auth.roles.includes('admin') || share.createdBy === auth.keyId;
}

function registerAuthedShareRoutes(app: FastifyInstance, ctx: HubContext, disconnect: (id: string) => void): void {
  app.post(
    '/v1/shares',
    { schema: { summary: 'Create a share link for a flow or trace', tags: ['shares'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);

      const body = request.body as CreateShareBody;
      if (typeof body !== 'object' || body === null || typeof body.target !== 'object' || body.target === null) {
        return reply.code(400).send(errorBody('invalid_body', 'body must be { target: { type, id }, mode?, includeContext?, expiresInDays? }'));
      }
      const { type: targetType, id: targetId } = body.target;
      if (!isShareTargetType(targetType) || typeof targetId !== 'string' || targetId.length === 0) {
        return reply.code(400).send(errorBody('invalid_body', 'target.type must be "flow" or "trace" and target.id a non-empty string'));
      }
      if (body.mode !== undefined && !isShareMode(body.mode)) {
        return reply.code(400).send(errorBody('invalid_body', 'mode must be "snapshot" or "live"'));
      }
      const mode: ShareMode = body.mode ?? 'snapshot';
      if (body.includeContext !== undefined && typeof body.includeContext !== 'boolean') {
        return reply.code(400).send(errorBody('invalid_body', 'includeContext must be a boolean'));
      }
      const includeContext = body.includeContext ?? false;

      let expiresAt: number | null;
      if (body.expiresInDays === undefined) {
        expiresAt = Date.now() + DEFAULT_SHARE_EXPIRY_DAYS * DAY_MS;
      } else if (body.expiresInDays === 'never') {
        expiresAt = null;
      } else if (typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays) && body.expiresInDays > 0) {
        expiresAt = Date.now() + body.expiresInDays * DAY_MS;
      } else {
        return reply.code(400).send(errorBody('invalid_body', 'expiresInDays must be a positive number of days, or the string "never"'));
      }

      const exists =
        targetType === 'flow'
          ? (await ctx.store.flowSummary(auth.workspace, targetId)) !== undefined
          : (await ctx.store.getTrace(auth.workspace, targetId)) !== undefined;
      if (!exists) return reply.code(404).send(errorBody('not_found', `no such ${targetType}: ${targetId}`));

      const snapshotCursor = mode === 'snapshot' ? (await ctx.store.workspaceFrame(auth.workspace)).cursor : undefined;

      const share = await ctx.store.createShare({
        workspace: auth.workspace,
        target: { type: targetType, id: targetId },
        mode,
        snapshotCursor,
        includeContext,
        createdBy: auth.keyId,
        expiresAt,
      });

      reply.code(201).send({ id: share.id, token: share.token, url: shareUrl(ctx, request, share.token) });
    },
  );

  app.get('/v1/shares', { schema: { summary: 'List shares (tokens omitted)', tags: ['shares'] } }, async (request, reply) => {
    const query = request.query as { workspace?: string };
    const auth = await ctx.requireAuth(request, 'read', query.workspace);
    const shares = await ctx.store.listShares(auth.workspace, auth.roles.includes('admin') ? {} : { createdBy: auth.keyId });
    reply.send({ shares: shares.map(publicShareView) });
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/shares/:id',
    { schema: { summary: 'Revoke a share (creator or admin)', tags: ['shares'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const share = await ctx.store.getShareById(auth.workspace, request.params.id);
      if (!share) return reply.code(404).send(errorBody('not_found', `no such share: ${request.params.id}`));
      if (!canManage(auth, share)) return reply.code(403).send(errorBody('forbidden', 'only the share\'s creator or an admin may revoke it'));
      await ctx.store.revokeShare(auth.workspace, share.id, Date.now());
      disconnect(share.id);
      reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string } }>(
    '/v1/shares/:id/preview',
    {
      schema: { summary: 'Upload a PNG preview image for a share', tags: ['shares'] },
      bodyLimit: SHARE_PREVIEW_MAX_BYTES,
    },
    async (request, reply) => {
      const query = request.query as { workspace?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const share = await ctx.store.getShareById(auth.workspace, request.params.id);
      if (!share) return reply.code(404).send(errorBody('not_found', `no such share: ${request.params.id}`));
      if (!canManage(auth, share)) return reply.code(403).send(errorBody('forbidden', 'only the share\'s creator or an admin may set its preview'));

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(415).send(errorBody('unsupported_media_type', 'body must be raw image/png bytes (Content-Type: image/png)'));
      }
      if (body.byteLength > SHARE_PREVIEW_MAX_BYTES) {
        return reply.code(413).send(errorBody('body_too_large', `preview exceeds the ${SHARE_PREVIEW_MAX_BYTES}-byte limit`));
      }
      if (!body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return reply.code(400).send(errorBody('invalid_body', 'preview must be a PNG image'));
      }

      await ctx.store.setSharePreview(auth.workspace, share.id, { contentType: 'image/png', data: new Uint8Array(body) });
      const updated = await ctx.store.getShareById(auth.workspace, share.id);
      reply.send(publicShareView(updated!));
    },
  );
}

// ---------------------------------------------------------------------------
// Public routes: no API key. The token in the path is the credential.
// ---------------------------------------------------------------------------

function notFound(reply: FastifyReply): void {
  // SPEC-analogous "identical 404" rule (docs/SHARING.md): unknown, expired
  // and revoked tokens are indistinguishable from the outside.
  reply.code(404).send(errorBody('not_found', 'no such share'));
}

function tooManyRequests(reply: FastifyReply): void {
  reply.code(429).send(errorBody('rate_limited', 'too many requests; try again shortly'));
}

async function resolveUsableShare(ctx: HubContext, token: string): Promise<ShareRecord | undefined> {
  const share = await ctx.store.getShareByToken(token);
  if (!share || !isShareUsable(share, Date.now())) return undefined;
  return share;
}

function registerPublicShareRoutes(app: FastifyInstance, ctx: HubContext, limiter: TokenBucketLimiter, sockets: Map<string, Set<WebSocket>>): void {
  const guard = async (request: FastifyRequest, reply: FastifyReply, token: string): Promise<ShareRecord | undefined> => {
    if (!limiter.allow(request.ip)) {
      tooManyRequests(reply);
      return undefined;
    }
    const share = await resolveUsableShare(ctx, token);
    if (!share) {
      notFound(reply);
      return undefined;
    }
    return share;
  };

  app.get<{ Params: { token: string } }>('/v1/shares/:token/meta', async (request, reply) => {
    const share = await guard(request, reply, request.params.token);
    if (!share) return;
    reply.send({
      target: share.target,
      mode: share.mode,
      includeContext: share.includeContext,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      label: await shareLabel(ctx, share),
    });
  });

  app.get<{ Params: { token: string } }>('/v1/shares/:token/flow', async (request, reply) => {
    const share = await guard(request, reply, request.params.token);
    if (!share) return;
    if (share.target.type !== 'flow') return notFound(reply);
    const summary = await flowSummaryForShare(ctx, share);
    if (!summary) return notFound(reply);
    reply.send(share.includeContext ? summary : redactFlowSummary(summary));
  });

  app.get<{ Params: { token: string } }>('/v1/shares/:token/trace', async (request, reply) => {
    const share = await guard(request, reply, request.params.token);
    if (!share) return;
    if (share.target.type !== 'trace') return notFound(reply);
    const summary = await traceSummaryForShare(ctx, share);
    if (!summary) return notFound(reply);
    reply.send(share.includeContext ? summary : redactTraceSummary(summary));
  });

  app.get<{ Params: { token: string } }>('/v1/shares/:token/events', async (request, reply) => {
    const share = await guard(request, reply, request.params.token);
    if (!share) return;
    const query = request.query as { after?: string };
    let after: number | undefined;
    try {
      after = parseCursor(query.after, 'after');
    } catch (err) {
      if (err instanceof InvalidQueryError) return reply.code(400).send(errorBody('invalid_query', err.message));
      throw err;
    }
    const frame = await frameForShare(ctx, share, after);
    reply.send(share.includeContext ? frame : redactFrame(frame));
  });

  app.get<{ Params: { token: string } }>('/v1/shares/:token/preview.png', async (request, reply) => {
    const share = await guard(request, reply, request.params.token);
    if (!share) return;
    const preview = await ctx.store.getSharePreview(share.workspace, share.id);
    if (!preview) return reply.code(404).send(errorBody('not_found', 'this share has no preview image'));
    reply.type('image/png').send(Buffer.from(preview.data));
  });

  app.get('/v1/shares/:token/live', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const { token } = request.params as { token: string };

    if (!limiter.allow(request.ip)) {
      socket.close(4429, 'rate limited');
      return;
    }

    void (async () => {
      const share = await resolveUsableShare(ctx, token);
      if (!share) {
        socket.close(4404, 'not found');
        return;
      }
      if (share.mode !== 'live') {
        socket.close(4400, 'this share is a snapshot; live updates are not available -- see GET .../events');
        return;
      }

      let initialAfter: number | undefined;
      try {
        initialAfter = parseCursor((request.query as { after?: string }).after, 'after');
      } catch (err) {
        const message = err instanceof InvalidQueryError ? err.message : 'invalid after cursor';
        socket.close(4400, message);
        return;
      }

      // A synthetic, read-only principal scoped to exactly this share's
      // workspace and target -- never a real API key, never logged.
      const auth: AuthContext = { keyId: `share:${share.id}`, workspace: share.workspace, roles: ['read'], isOperator: false };
      const filter: LiveFilter = share.target.type === 'trace' ? { trace: share.target.id } : { flow: share.target.id };

      if (socket.readyState !== socket.OPEN) return;
      const members = sockets.get(share.id) ?? new Set<WebSocket>();
      sockets.set(share.id, members);
      members.add(socket);
      socket.once('close', () => {
        members.delete(socket);
        if (members.size === 0) sockets.delete(share.id);
      });
      attachLiveSocket(socket, request, {
        store: ctx.store, metrics: ctx.metrics,
        transformFrame: share.includeContext ? undefined : redactFrame,
        authorizeFrame: async () => Boolean(await resolveUsableShare(ctx, token)),
        expiresAt: share.expiresAt,
      }, auth, filter, initialAfter);
    })().catch((err: unknown) => {
      request.log.error({ err }, 'tracery share: live setup failed');
      socket.close(1011, 'internal error');
    });
  });
}

export function registerSharesRoutes(app: FastifyInstance, ctx: HubContext): void {
  // `PUT /v1/shares/:id/preview` is the only route in this hub that accepts a
  // raw binary body; Fastify has no built-in parser for it (only json/text),
  // so without this it 415s before the route handler ever runs.
  app.addContentTypeParser('image/png', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  const limiter = new TokenBucketLimiter(PUBLIC_RATE_LIMIT.capacity, PUBLIC_RATE_LIMIT.windowMs);
  const sockets = new Map<string, Set<WebSocket>>();
  registerAuthedShareRoutes(app, ctx, id => {
    for (const socket of sockets.get(id) ?? []) socket.close(4404, 'not found');
  });
  registerPublicShareRoutes(app, ctx, limiter, sockets);
}
