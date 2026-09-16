/**
 * API-key auth (SPEC.md §6 "Auth"). Keys are compared in constant time via
 * `crypto.timingSafeEqual` over a fixed-length hash of the presented key, so
 * comparisons never leak timing information about key length or prefix.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export class AuthError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
/** Generates the dev key used when no `ACTIVITY_API_KEYS*` is configured: all roles, workspace `default`. */
export function generateDevKey() {
    const key = `dev_${randomBytes(24).toString('hex')}`;
    return {
        key,
        config: { id: 'dev', key, workspace: 'default', roles: ['ingest', 'read', 'admin'] },
    };
}
function hash(value) {
    return createHash('sha256').update(value, 'utf8').digest();
}
/** Finds the configured key matching `presented`, comparing every candidate in constant time. */
export function findApiKey(keys, presented) {
    const presentedHash = hash(presented);
    let found;
    for (const candidate of keys) {
        const candidateHash = hash(candidate.key);
        // Both hashes are fixed-length (32 bytes, SHA-256) so timingSafeEqual never throws on length mismatch.
        if (timingSafeEqual(candidateHash, presentedHash))
            found = candidate;
    }
    return found;
}
function extractPresentedKey(headers, queryToken) {
    const authorization = headers['authorization'];
    const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
    if (authValue && authValue.toLowerCase().startsWith('bearer ')) {
        return authValue.slice('bearer '.length).trim();
    }
    const apiKeyHeader = headers['x-api-key'];
    const apiKeyValue = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    if (apiKeyValue)
        return apiKeyValue;
    if (queryToken)
        return queryToken;
    return undefined;
}
/**
 * Authenticates a request: finds the key, checks the required role, and
 * resolves the workspace (the key's own workspace, or the caller-supplied
 * `requestedWorkspace` when the key is the `*` operator key). Throws
 * `AuthError` on any failure; callers turn that into the `{ error }` body.
 */
export function authenticate(keys, headers, queryToken, requiredRole, requestedWorkspace, options) {
    const presented = extractPresentedKey(headers, queryToken);
    if (!presented)
        throw new AuthError(401, 'unauthorized', 'missing API key: use Authorization: Bearer <key> or x-api-key');
    const found = findApiKey(keys, presented);
    if (!found)
        throw new AuthError(401, 'unauthorized', 'invalid API key');
    if (!found.roles.includes(requiredRole)) {
        throw new AuthError(403, 'forbidden', `key "${found.id}" lacks role "${requiredRole}"`);
    }
    const isOperator = found.workspace === '*';
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
