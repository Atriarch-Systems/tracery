/**
 * API-key auth (SPEC.md §6 "Auth"). Keys are compared in constant time via
 * `crypto.timingSafeEqual` over a fixed-length hash of the presented key, so
 * comparisons never leak timing information about key length or prefix.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyConfig, Role } from './config.js';

export interface AuthContext {
  readonly keyId: string;
  /** Resolved workspace for this request. Never `*`. */
  readonly workspace: string;
  readonly roles: readonly Role[];
  /** True when the presented key is the `*`-workspace operator key. */
  readonly isOperator: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The one workspace `authMode: 'none'` (local mode) ever serves -- see `localModeAuth`. */
export const LOCAL_MODE_WORKSPACE = 'default';

const LOCAL_MODE_ROLES: readonly Role[] = ['ingest', 'read', 'admin'];

/**
 * `config.authMode === 'none'` (task: "local mode", `npx @atriarch-systems/tracery-hub`
 * with no env): every request and WS connection is a full-access principal on
 * the single `default` workspace -- no key, no header, no `Authorization`
 * ever consulted. `requireAuth`/`registerLive` call this instead of
 * `authenticate` below whenever `config.authMode` is `'none'`.
 *
 * The single-workspace promise is enforced here: a batch/query naming any
 * workspace other than `default` is rejected outright (400), not silently
 * redirected to `default` and not silently allowed.
 */
export function localModeAuth(requestedWorkspace?: string): AuthContext {
  if (requestedWorkspace !== undefined && requestedWorkspace !== LOCAL_MODE_WORKSPACE) {
    throw new AuthError(
      400,
      'workspace_not_local',
      `local mode (no auth) only serves workspace "${LOCAL_MODE_WORKSPACE}"; set TRACERY_API_KEYS to use more than one workspace`,
    );
  }
  return { keyId: 'local', workspace: LOCAL_MODE_WORKSPACE, roles: LOCAL_MODE_ROLES, isOperator: false };
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time string equality (hub-14): hashes both sides to a fixed
 * length first so `timingSafeEqual` never throws on a length mismatch, and
 * the early-exit that a plain `===` on the raw strings would give an
 * attacker (leaking how many leading bytes matched) never happens. Used for
 * every bearer credential the hub compares -- API keys (`findApiKey`) and the
 * `/metrics` token (`routes/health.ts`) alike.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(hash(a), hash(b));
}

/** Finds the configured key matching `presented`, comparing every candidate in constant time. */
export function findApiKey(keys: readonly ApiKeyConfig[], presented: string): ApiKeyConfig | undefined {
  let found: ApiKeyConfig | undefined;
  for (const candidate of keys) {
    if (constantTimeEquals(candidate.key, presented)) found = candidate;
  }
  return found;
}

function extractPresentedKey(headers: Record<string, string | string[] | undefined>, queryToken: string | undefined): string | undefined {
  const authorization = headers['authorization'];
  const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (authValue && authValue.toLowerCase().startsWith('bearer ')) {
    return authValue.slice('bearer '.length).trim();
  }
  const apiKeyHeader = headers['x-api-key'];
  const apiKeyValue = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (apiKeyValue) return apiKeyValue;
  if (queryToken) return queryToken;
  return undefined;
}

/**
 * Extensions-SSO seam: lets an extensions module's own session cookie stand
 * in for an API key on requests carrying no credential at all (SPEC.md §7
 * "Extensions and Tracery Cloud" -- Tracery Cloud's OIDC SSO is one such
 * module). `authenticate` is a pure function called from two places outside
 * this package's control -- `server.ts`'s `requireAuth` closure and
 * `live.ts`'s WS upgrade handler -- neither of which this task may edit, so
 * there is no call site to thread a new "also check the module's session
 * cookie" parameter through. Both call sites already pass this function the
 * request's raw headers (which carry any `Cookie` header verbatim), so a
 * settable resolver here is the smallest seam that lets an extensions module
 * participate in authentication itself, not just observe it after the fact
 * the way `HubExtensions.onRequestAuthed` does (that hook only runs *after*
 * `authenticate` has already returned an `AuthContext`, so it cannot
 * manufacture one when no API key was presented at all).
 *
 * `resolver` gets the same header record `authenticate` was called with and
 * returns a ready-made `AuthContext` (or `undefined` -- no session, an
 * invalid/expired one, or the feature isn't currently licensed; the
 * extensions module decides all of that itself) synchronously, since
 * verifying a self-contained, signed session cookie needs no I/O. An
 * extensions module installs its resolver once at construction and clears
 * it (passes `undefined`) when it shuts down, so a closed-out instance never
 * keeps authenticating requests for a server that no longer exists --
 * important in tests, which construct many short-lived servers in one
 * process. At most one resolver is active at a time, matching every other
 * piece of process-wide hub state (there is exactly one hub per process).
 * The community edition (no extensions module configured) never calls this,
 * so `authenticate` behaves exactly as it always has with nothing installed.
 */
export type SessionAuthResolver = (headers: Record<string, string | string[] | undefined>) => AuthContext | undefined;

let sessionAuthResolver: SessionAuthResolver | undefined;

export function setSessionAuthResolver(resolver: SessionAuthResolver | undefined): void {
  sessionAuthResolver = resolver;
}

/**
 * Authenticates a request: finds the key, checks the required role, and
 * resolves the workspace (the key's own workspace, or the caller-supplied
 * `requestedWorkspace` when the key is the `*` operator key). Throws
 * `AuthError` on any failure; callers turn that into the `{ error }` body.
 *
 * When the request presents no API key at all (no `Authorization: Bearer`,
 * no `x-api-key`, no `?token=`), and ee has installed a `SessionAuthResolver`
 * (see above), that resolver gets a chance to authenticate the request from
 * a session cookie instead before this falls through to the ordinary
 * "missing API key" error.
 */
export function authenticate(
  keys: readonly ApiKeyConfig[],
  headers: Record<string, string | string[] | undefined>,
  queryToken: string | undefined,
  requiredRole: Role,
  requestedWorkspace: string | undefined,
  options?: { readonly operatorWorkspaceOptional?: boolean },
): AuthContext {
  const presented = extractPresentedKey(headers, queryToken);
  if (!presented) {
    const sessionAuth = sessionAuthResolver?.(headers);
    if (sessionAuth) {
      if (!sessionAuth.roles.includes(requiredRole)) {
        throw new AuthError(403, 'forbidden', `session lacks role "${requiredRole}"`);
      }
      if (!sessionAuth.isOperator && requestedWorkspace && requestedWorkspace !== sessionAuth.workspace) {
        throw new AuthError(403, 'workspace_forbidden', `session is bound to workspace "${sessionAuth.workspace}"`);
      }
      return sessionAuth;
    }
    throw new AuthError(401, 'unauthorized', 'missing API key: use Authorization: Bearer <key> or x-api-key');
  }

  const found = findApiKey(keys, presented);
  if (!found) throw new AuthError(401, 'unauthorized', 'invalid API key');

  if (!found.roles.includes(requiredRole)) {
    throw new AuthError(403, 'forbidden', `key "${found.id}" lacks role "${requiredRole}"`);
  }

  // hub-15: SPEC.md §6 defines the operator key as workspace "*" AND role "admin".
  // `config.ts`'s `parseApiKeys` already rejects a "*" key without "admin" at
  // startup; this mirrors the same rule here so a `*` key built any other way
  // (e.g. constructed directly rather than parsed from TRACERY_API_KEYS) can't
  // get the operator's cross-workspace reach on a lesser role.
  const isOperator = found.workspace === '*' && found.roles.includes('admin');
  if (isOperator) {
    if (!requestedWorkspace) {
      // Some admin endpoints (e.g. GET /v1/workspaces) let the operator key omit a
      // workspace to mean "all of them"; workspace stays the `*` placeholder.
      if (options?.operatorWorkspaceOptional) {
        return { keyId: found.id, workspace: '*', roles: found.roles, isOperator: true };
      }
      throw new AuthError(400, 'workspace_required', 'operator key requires an explicit workspace');
    }
    return { keyId: found.id, workspace: requestedWorkspace, roles: found.roles, isOperator: true };
  }

  if (requestedWorkspace && requestedWorkspace !== found.workspace) {
    throw new AuthError(403, 'workspace_forbidden', `key "${found.id}" is bound to workspace "${found.workspace}"`);
  }

  return { keyId: found.id, workspace: found.workspace, roles: found.roles, isOperator: false };
}
