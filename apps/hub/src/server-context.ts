/**
 * The context every route module (and the enterprise extension hooks) is
 * handed. Kept in its own module so `routes/*.ts` can import the type
 * without creating a cycle back through `server.ts`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
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
}
