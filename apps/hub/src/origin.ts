import type { FastifyRequest } from 'fastify';
import { isLoopbackHost, type Config } from './config.js';

/** Native SDKs omit Origin. Browser clients must use the hub or an explicit allowlist. */
export function allowsBrowserRequest(request: FastifyRequest, config: Config): boolean {
  // A rebinding site can present its own Host and matching Origin while connecting to
  // loopback. Only known local hostnames (or the configured reverse-proxy URL) are valid.
  if (config.authMode === 'none' && isLoopbackHost(config.host)) {
    const hostname = request.hostname.replace(/^\[|\]$/g, '');
    const publicHost = config.publicUrl ? new URL(config.publicUrl).hostname : undefined;
    if (!isLoopbackHost(hostname) && request.hostname !== publicHost) return false;
  }
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin) || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    return origin === `${request.protocol}://${request.headers.host}` ||
      origin === config.publicUrl || (config.allowedOrigins ?? []).includes(origin);
  } catch { return false; }
}
