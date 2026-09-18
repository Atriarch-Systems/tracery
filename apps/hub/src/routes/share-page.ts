/**
 * `GET /s/:token` (docs/SHARING.md "OG previews"): serves the hosted web
 * app's `index.html` with Open Graph / Twitter Card meta tags injected for
 * this specific share, then the SPA's own `/s/:token` route (apps/hub/web)
 * takes over and loads the explorer in share mode. Unknown/expired/revoked
 * tokens 404 the same way the public API routes do (routes/shares.ts).
 *
 * This is a browser-facing HTML route, not a JSON API one, so its 404 is a
 * plain HTML page rather than `{ error }` -- consistent with `routes/ui.ts`'s
 * own not-built placeholder.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HubContext } from '../server-context.js';
import { isShareUsable } from '../store/share-types.js';
import { resolvePublicBaseUrl, shareLabel } from './shares.js';

/** `apps/hub/web/public/tracery-share-default.png`, copied by Vite straight into `dist/` (served at `/ui/...` -- see `routes/ui.ts`). */
const DEFAULT_PREVIEW_PATH = '/ui/tracery-share-default.png';

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shareNotFoundHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Share not found - Tracery</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">
<h1>This share link isn't available</h1>
<p>It may have been revoked, expired, or never existed.</p>
</body></html>`;
}

export function registerSharePageRoutes(app: FastifyInstance, ctx: HubContext): void {
  app.get<{ Params: { token: string } }>('/s/:token', async (request, reply) => {
    const share = await ctx.store.getShareByToken(request.params.token);
    if (!share || !isShareUsable(share, Date.now())) {
      reply.code(404).type('text/html').send(shareNotFoundHtml());
      return;
    }

    const indexPath = path.join(ctx.config.uiDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      reply.code(404).type('text/html').send('<!doctype html><html><body>The hosted UI is not built; see apps/hub/README.md.</body></html>');
      return;
    }

    const baseUrl = resolvePublicBaseUrl(ctx, request);
    const url = `${baseUrl}/s/${share.token}`;
    const imageUrl = share.preview !== null ? `${baseUrl}/v1/shares/${share.token}/preview.png` : `${baseUrl}${DEFAULT_PREVIEW_PATH}`;
    const label = await shareLabel(ctx, share);
    const title = `Tracery: ${label}`;
    const description = 'An agent activity graph shared from Tracery by Atriarch Systems.';

    const metaTags = [
      `<meta property="og:title" content="${escapeHtmlAttr(title)}">`,
      `<meta property="og:description" content="${escapeHtmlAttr(description)}">`,
      `<meta property="og:image" content="${escapeHtmlAttr(imageUrl)}">`,
      `<meta property="og:url" content="${escapeHtmlAttr(url)}">`,
      `<meta property="og:type" content="website">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].join('\n    ');

    const html = fs.readFileSync(indexPath, 'utf8').replace('</head>', `    ${metaTags}\n  </head>`);
    reply.type('text/html').send(html);
  });
}
