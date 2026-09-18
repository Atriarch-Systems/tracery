/**
 * The context every route module (and an extensions module's hooks) is
 * handed. Kept in its own module so `routes/*.ts` can import the type
 * without creating a cycle back through `server.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActivityFrame } from '@atriarch/tracery-core/contract';
import type { AuthContext } from './auth.js';
import type { ApiKeyConfig, Config, Role } from './config.js';
import type { EventStore } from './store/types.js';
import type { ShareStore } from './store/share-types.js';
import type { MetricsRegistry } from './metrics.js';

export interface HubContext {
  readonly config: Config;
  /** Every store engine implements both (docs/SHARING.md: `ShareStore` is a parallel interface every `EventStore` also implements). */
  readonly store: EventStore & ShareStore;
  readonly metrics: MetricsRegistry;
  readonly keys: readonly ApiKeyConfig[];
  /**
   * Authenticates `request` for `role`, resolving the workspace from the
   * key (or from `requestedWorkspace` for the `*` operator key). Throws
   * `AuthError` (caught by the server's error handler) on any failure.
   * Runs `HubExtensions.onRequestAuthed` before returning, so ee's audit
   * hook observes every authenticated request exactly once.
   */
  requireAuth(
    request: FastifyRequest,
    role: Role,
    requestedWorkspace?: string,
    options?: { readonly operatorWorkspaceOptional?: boolean },
  ): Promise<AuthContext>;
  /**
   * Same "community vs. licensed" check `server.ts` uses for the `X-Ko-fi`
   * header, exposed on the context so route modules (`routes/info.ts`'s
   * `GET /v1/info`) can report `edition` without importing `HubExtensions`
   * directly. Always present; returns `false` when no `extensions` (or no
   * `isLicensed`) was passed to `createServer` at all.
   */
  isLicensed(): boolean;
}

export interface HubExtensions {
  /** Runs after every successful authentication, before the route handler. Lets an extensions module append an audit log entry. */
  onRequestAuthed?(ctx: { readonly request: FastifyRequest; readonly auth: AuthContext }): void | Promise<void>;
  /** Runs once at boot with the live app and hub context, so an extensions module can register its own routes (e.g. `/v1/license`) or add RBAC filtering via fastify hooks. */
  registerRoutes?(app: FastifyInstance, ctx: HubContext): void | Promise<void>;
  /**
   * Called from `live.ts`'s `send()` before every frame goes out over
   * `WS /v1/live` -- the one send path `registerRoutes`'s Fastify `onSend`
   * hook can't reach, since the live feed writes straight to the raw
   * WebSocket outside Fastify's response pipeline. Return the frame
   * (unchanged, or with a filtered `events` array) to send it, or `null` to
   * drop it entirely -- e.g. a delta `events` frame whose one event ends up
   * outside a scoped key's rbac scope. Not invoked for anything but the live
   * feed; ordinary HTTP reads stay filtered through `registerRoutes`'s
   * `onSend` hook.
   */
  onLiveFrame?(ctx: { readonly auth: AuthContext; readonly frame: ActivityFrame }): ActivityFrame | null;
  /**
   * Reports whether a currently-valid license is active. Re-checked on
   * every call (an extensions module is expected to make this "no restart
   * needed", the way Tracery Cloud's feature checks do), not cached at
   * construction time. Absent (community edition, no extensions module
   * configured) or returning `false` both mean "community" -- `server.ts`
   * uses this to decide whether to send the `X-Ko-fi` tip-jar header, and
   * `bin/hub.mjs` uses it for the one-line startup banner.
   */
  isLicensed?(): boolean;
}
