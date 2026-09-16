/**
 * The context every route module (and the enterprise extension hooks) is
 * handed. Kept in its own module so `routes/*.ts` can import the type
 * without creating a cycle back through `server.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActivityFrame } from '@atriarch/activity-core/contract';
import type { AuthContext } from './auth.js';
import type { ApiKeyConfig, Config, Role } from './config.js';
import type { EventStore } from './store/types.js';
import type { MetricsRegistry } from './metrics.js';

export interface HubContext {
  readonly config: Config;
  readonly store: EventStore;
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
}

export interface HubExtensions {
  /** Runs after every successful authentication, before the route handler. Lets ee append an audit log entry. */
  onRequestAuthed?(ctx: { readonly request: FastifyRequest; readonly auth: AuthContext }): void | Promise<void>;
  /** Runs once at boot with the live app and hub context, so ee can register its own routes (e.g. `/v1/license`) or add RBAC filtering via fastify hooks. */
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
}
