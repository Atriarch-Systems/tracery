/**
 * `GET /v1/flows/:id/export.html` and `GET /v1/traces/:id/export.html`
 * (docs/SHARING.md "HTML export"): a single downloadable file that renders
 * `ActivityExplorer` in share mode with the data embedded, no network call
 * of any kind -- the point being local mode, where a share *link* is
 * useless (nobody outside the machine can reach it), still gets a way to
 * hand someone the graph. `?context=false` applies the same redaction a
 * share with `includeContext: false` gets (`./redact.js`).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { StoredEvent } from '@atriarch/tracery-core/contract';
import type { HubContext } from '../server-context.js';
import { errorBody } from './errors.js';
import { redactEvent } from './redact.js';

interface EmbeddedMeta {
  readonly target: { readonly type: 'flow' | 'trace'; readonly id: string };
  readonly mode: 'snapshot';
  readonly includeContext: boolean;
  readonly createdAt: number;
  readonly label: string;
}

const DATA_BLOCK_RE = /<script id="tracery-data" type="application\/json">[\s\S]*?<\/script>/;

function viewerTemplatePath(ctx: HubContext): string {
  return path.join(ctx.config.uiDir, 'viewer.html');
}

/** Loose but sufficient: strips anything not filename-safe rather than trying to be a general slugifier. */
function sanitizeFilenamePart(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'export';
}

/** `undefined` when `apps/hub/web`'s `viewer.html` hasn't been built (dev checkout, or a stripped-down deployment) -- the 404 route handlers below turn that into a clear message rather than a raw file-not-found. */
function buildExportHtml(ctx: HubContext, meta: EmbeddedMeta, events: readonly StoredEvent[]): string | undefined {
  const templatePath = viewerTemplatePath(ctx);
  if (!fs.existsSync(templatePath)) return undefined;
  const template = fs.readFileSync(templatePath, 'utf8');
  const dataJson = JSON.stringify({ meta, events });
  // `</script` inside the JSON payload (a producer's context could legally
  // contain that literal string) would otherwise prematurely close the tag
  // and corrupt the page -- escape the forward slash, which JSON.parse
  // ignores as an unnecessary (but valid) escape.
  const safeDataJson = dataJson.replace(/<\/script/gi, '<\\/script');
  const dataBlock = `<script id="tracery-data" type="application/json">${safeDataJson}</script>`;
  if (!DATA_BLOCK_RE.test(template)) return undefined; // template shape changed unexpectedly; fail closed rather than silently ship an empty viewer
  return template.replace(DATA_BLOCK_RE, dataBlock);
}

function sendExport(reply: FastifyReply, ctx: HubContext, meta: EmbeddedMeta, events: readonly StoredEvent[]): void {
  const html = buildExportHtml(ctx, meta, events);
  if (html === undefined) {
    reply
      .code(404)
      .send(errorBody('viewer_not_built', 'the standalone viewer (apps/hub/webViewer.html, built to web/dist/viewer.html) has not been built -- see apps/hub/README.md'));
    return;
  }
  const filename = `tracery-${sanitizeFilenamePart(meta.label)}-${sanitizeFilenamePart(meta.target.id)}.html`;
  reply
    .type('text/html')
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(html);
}

export function registerExportRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get<{ Params: { id: string } }>(
    '/v1/flows/:id/export.html',
    { schema: { summary: 'Download a standalone, offline HTML export of this flow', tags: ['export'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string; context?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const flow = await ctx.store.flowSummary(auth.workspace, request.params.id);
      if (!flow) return reply.code(404).send(errorBody('not_found', `no such flow: ${request.params.id}`));

      const includeContext = query.context !== 'false';
      const frame = await ctx.store.flowEvents(auth.workspace, request.params.id);
      const events = frame.type === 'heartbeat' ? [] : frame.events;
      const finalEvents = includeContext ? events : events.map(redactEvent);

      sendExport(reply, ctx, { target: { type: 'flow', id: flow.id }, mode: 'snapshot', includeContext, createdAt: Date.now(), label: flow.label }, finalEvents);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/traces/:id/export.html',
    { schema: { summary: 'Download a standalone, offline HTML export of this trace', tags: ['export'] } },
    async (request, reply) => {
      const query = request.query as { workspace?: string; context?: string };
      const auth = await ctx.requireAuth(request, 'read', query.workspace);
      const trace = await ctx.store.getTrace(auth.workspace, request.params.id);
      if (!trace) return reply.code(404).send(errorBody('not_found', `no such trace: ${request.params.id}`));

      const includeContext = query.context !== 'false';
      const events = await ctx.store.traceEvents(auth.workspace, request.params.id);
      const finalEvents = includeContext ? events : events.map(redactEvent);
      const root = trace.flows.find((flow) => flow.id === trace.root) ?? trace.flows[0];

      sendExport(
        reply,
        ctx,
        { target: { type: 'trace', id: request.params.id }, mode: 'snapshot', includeContext, createdAt: Date.now(), label: root?.label ?? request.params.id },
        finalEvents,
      );
    },
  );
}
