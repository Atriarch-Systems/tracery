/**
 * Environment-variable configuration for the hub (SPEC.md §6 "Hub"). Every
 * value has a default so `docker run -p 8971:8971 image` works out of the
 * box with an in-memory store and a printed dev API key.
 *
 * `loadConfig` is a pure function of an env record so it is easy to unit
 * test without touching `process.env`.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const ROLES = ['ingest', 'read', 'admin'];
function isRole(value) {
    return typeof value === 'string' && ROLES.includes(value);
}
function parseNumber(raw, fallback, name) {
    if (raw === undefined || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value))
        throw new Error(`${name} must be a finite number, got "${raw}"`);
    return value;
}
/** Package root, i.e. `apps/hub`, resolved from the compiled `dist/config.js`. */
function packageRoot() {
    return fileURLToPath(new URL('..', import.meta.url));
}
function defaultUiDir() {
    return path.join(packageRoot(), 'web', 'dist');
}
/** Parses `ACTIVITY_API_KEYS` (a JSON array) or the contents of `ACTIVITY_API_KEYS_FILE`. */
export function parseApiKeys(json, source) {
    let raw;
    try {
        raw = JSON.parse(json);
    }
    catch (err) {
        throw new Error(`${source} is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(raw))
        throw new Error(`${source} must be a JSON array of API key entries`);
    return raw.map((entry, index) => {
        const item = entry;
        if (typeof item.key !== 'string' || item.key.length === 0) {
            throw new Error(`${source}[${index}].key must be a non-empty string`);
        }
        if (typeof item.workspace !== 'string' || item.workspace.length === 0) {
            throw new Error(`${source}[${index}].workspace must be a non-empty string`);
        }
        if (!Array.isArray(item.roles) || item.roles.length === 0 || !item.roles.every(isRole)) {
            throw new Error(`${source}[${index}].roles must be a non-empty array of "ingest" | "read" | "admin"`);
        }
        const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `key-${index}`;
        return { id, key: item.key, workspace: item.workspace, roles: [...item.roles] };
    });
}
function loadApiKeys(env) {
    const inline = env.ACTIVITY_API_KEYS;
    if (inline !== undefined && inline.trim() !== '') {
        return parseApiKeys(inline, 'ACTIVITY_API_KEYS');
    }
    const file = env.ACTIVITY_API_KEYS_FILE;
    if (file !== undefined && file.trim() !== '') {
        const contents = fs.readFileSync(file, 'utf8');
        return parseApiKeys(contents, `ACTIVITY_API_KEYS_FILE (${file})`);
    }
    return undefined;
}
/** Reads every hub environment variable, applying defaults. Never touches `process.env` directly (pass it in). */
export function loadConfig(env = process.env) {
    const store = env.ACTIVITY_STORE === 'sqlite' ? 'sqlite' : 'memory';
    return {
        port: parseNumber(env.ACTIVITY_PORT, 8971, 'ACTIVITY_PORT'),
        host: env.ACTIVITY_HOST ?? '0.0.0.0',
        store,
        sqlitePath: env.ACTIVITY_SQLITE_PATH ?? '/data/activity.db',
        apiKeys: loadApiKeys(env),
        retentionHours: parseNumber(env.ACTIVITY_RETENTION_HOURS, 72, 'ACTIVITY_RETENTION_HOURS'),
        maxEventsPerWorkspace: parseNumber(env.ACTIVITY_MAX_EVENTS_PER_WORKSPACE, 500_000, 'ACTIVITY_MAX_EVENTS_PER_WORKSPACE'),
        metricsToken: env.ACTIVITY_METRICS_TOKEN && env.ACTIVITY_METRICS_TOKEN.length > 0 ? env.ACTIVITY_METRICS_TOKEN : undefined,
        logLevel: env.ACTIVITY_LOG_LEVEL ?? 'info',
        uiDir: env.ACTIVITY_UI_DIR ?? defaultUiDir(),
    };
}
