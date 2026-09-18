/**
 * Thin client for the public `GET /v1/info` route (task: "local mode").
 * `App.tsx` uses this to skip the key-entry screen entirely when the hub
 * reports `auth: 'none'`; `Footer.tsx` uses `edition` to decide whether to
 * show the Ko-fi tip-jar link, without depending on any extensions-module
 * route (there is no `GET /v1/license` in this package at all -- see
 * `docs/CLOUD.md`). No auth required -- same pattern as `sso.ts`'s
 * `fetchAuthMe`.
 */

export interface HubInfo {
  readonly product: string;
  readonly version: string;
  readonly edition: 'community' | 'licensed';
  readonly auth: 'none' | 'keys';
  /** Present only when `auth` is `'none'` -- the single workspace it serves. */
  readonly workspace?: string;
}

function isHubInfo(value: unknown): value is HubInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.product === 'string' &&
    typeof v.version === 'string' &&
    (v.edition === 'community' || v.edition === 'licensed') &&
    (v.auth === 'none' || v.auth === 'keys')
  );
}

/** `GET /v1/info`, same-origin. Returns `null` on any network/parse failure (or a non-hub server, e.g. a mocked preview with no such route) -- callers fall back to the pre-existing key-entry flow. */
export async function fetchHubInfo(): Promise<HubInfo | null> {
  try {
    const res = await fetch('/v1/info', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isHubInfo(body) ? body : null;
  } catch {
    return null;
  }
}
