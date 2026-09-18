/**
 * Thin client for the `/v1/auth/*` SSO routes an extensions module may
 * register (SPEC.md §7 "Extensions and Tracery Cloud" -- Tracery Cloud is
 * one such module). This package ships no SSO implementation of its own;
 * `GET /v1/auth/me` simply returns `{ sso: { configured: false, ... },
 * authenticated: false }`-shaped data (or 404s) when no module registers it,
 * which `fetchAuthMe`'s `null`-on-failure handling already treats as "no SSO
 * session". `App.tsx` uses this both to decide whether to show KeyEntry's
 * "Sign in with SSO" button and to detect an already-established session
 * cookie (e.g. right after an OIDC callback redirects the browser back to
 * `/ui/`).
 */

export interface AuthMeResponse {
  readonly sso: { readonly configured: boolean; readonly licensed: boolean };
  readonly authenticated: boolean;
  readonly user?: { readonly sub: string; readonly email?: string; readonly workspace: string; readonly role: string };
}

function isAuthMeResponse(value: unknown): value is AuthMeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.authenticated !== 'boolean') return false;
  if (typeof v.sso !== 'object' || v.sso === null) return false;
  const sso = v.sso as Record<string, unknown>;
  return typeof sso.configured === 'boolean' && typeof sso.licensed === 'boolean';
}

/** `GET /v1/auth/me`, same-origin (cookies included automatically). Returns `null` on any network/parse failure rather than throwing -- callers treat that the same as "no SSO session". */
export async function fetchAuthMe(): Promise<AuthMeResponse | null> {
  try {
    const res = await fetch('/v1/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isAuthMeResponse(body) ? body : null;
  } catch {
    return null;
  }
}

/** `POST /v1/auth/logout`. Best-effort: swallows failures since sign-out already clears the client-side session regardless. */
export async function logout(): Promise<void> {
  try {
    await fetch('/v1/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // ignored -- see doc comment
  }
}
