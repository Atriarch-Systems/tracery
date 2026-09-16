import type { ApiKeyConfig, Role } from './config.js';
export interface AuthContext {
    readonly keyId: string;
    /** Resolved workspace for this request. Never `*`. */
    readonly workspace: string;
    readonly roles: readonly Role[];
    /** True when the presented key is the `*`-workspace operator key. */
    readonly isOperator: boolean;
}
export declare class AuthError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
export interface DevKey {
    readonly key: string;
    readonly config: ApiKeyConfig;
}
/** Generates the dev key used when no `ACTIVITY_API_KEYS*` is configured: all roles, workspace `default`. */
export declare function generateDevKey(): DevKey;
/** Finds the configured key matching `presented`, comparing every candidate in constant time. */
export declare function findApiKey(keys: readonly ApiKeyConfig[], presented: string): ApiKeyConfig | undefined;
/**
 * Authenticates a request: finds the key, checks the required role, and
 * resolves the workspace (the key's own workspace, or the caller-supplied
 * `requestedWorkspace` when the key is the `*` operator key). Throws
 * `AuthError` on any failure; callers turn that into the `{ error }` body.
 */
export declare function authenticate(keys: readonly ApiKeyConfig[], headers: Record<string, string | string[] | undefined>, queryToken: string | undefined, requiredRole: Role, requestedWorkspace: string | undefined, options?: {
    readonly operatorWorkspaceOptional?: boolean;
}): AuthContext;
