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

export type StoreKind = 'memory' | 'sqlite' | 'postgres';

export type Role = 'ingest' | 'read' | 'admin';

export interface ApiKeyConfig {
  readonly id: string;
  readonly key: string;
  /** `*` marks the operator key: any workspace, request supplies it explicitly. */
  readonly workspace: string;
  readonly roles: readonly Role[];
}

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly store: StoreKind;
  readonly sqlitePath: string;
  /** `postgres://...` connection string for `PostgresStore`. Required when `store === 'postgres'` (validated eagerly by `loadConfig`); otherwise `undefined`. */
  readonly postgresUrl: string | undefined;
  /** Configured keys, or `undefined` when none were configured (dev key mode). */
  readonly apiKeys: readonly ApiKeyConfig[] | undefined;
  readonly retentionHours: number;
  readonly maxEventsPerWorkspace: number;
  readonly metricsToken: string | undefined;
  readonly logLevel: string;
  readonly uiDir: string;
  /**
   * Fastify request body size cap, in bytes (hub-4). No env var: it always
   * defaults to `ACTIVITY_LIMITS.maxEventsPerBatch * ACTIVITY_LIMITS.maxEventBytes`
   * in `server.ts` so a spec-legal max-size batch is never rejected by
   * Fastify's much smaller 1 MiB built-in default. Overridable here only for
   * tests that need a small, deterministic limit to exercise the 413 path
   * without sending tens of megabytes.
   */
  readonly bodyLimitBytes?: number;
}

const ROLES: readonly Role[] = ['ingest', 'read', 'admin'];

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * hub-16: `!Number.isFinite` alone let `TRACERY_RETENTION_HOURS=-1` (a cutoff
 * in the future -- every flow instantly over-retention),
 * `TRACERY_MAX_EVENTS_PER_WORKSPACE=0` (`overCount` permanently true), and
 * `TRACERY_PORT=0.5`/`-1` all through, each silently wiping data or failing
 * to bind on the very first sweep/boot after startup. `bounds` lets each
 * call site state its own valid range instead of every one growing its own
 * ad hoc check.
 */
function parseNumber(raw: string | undefined, fallback: number, name: string, bounds: { readonly min?: number; readonly max?: number; readonly integer?: boolean } = {}): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number, got "${raw}"`);
  if (bounds.integer && !Number.isInteger(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  if (bounds.min !== undefined && value < bounds.min) throw new Error(`${name} must be >= ${bounds.min}, got "${raw}"`);
  if (bounds.max !== undefined && value > bounds.max) throw new Error(`${name} must be <= ${bounds.max}, got "${raw}"`);
  return value;
}

const STORE_KINDS: readonly StoreKind[] = ['memory', 'sqlite', 'postgres'];

/** hub-16: an unrecognised `TRACERY_STORE` (a typo like "sqllite") silently fell back to `memory`, so an operator who configured durable storage got everything wiped on the next restart with no warning anywhere. */
function parseStoreKind(raw: string | undefined): StoreKind {
  if (raw === undefined || raw === '') return 'memory';
  if ((STORE_KINDS as readonly string[]).includes(raw)) return raw as StoreKind;
  throw new Error(`TRACERY_STORE must be one of ${STORE_KINDS.join(', ')}, got "${raw}"`);
}

/** Package root, i.e. `apps/hub`, resolved from the compiled `dist/config.js`. */
function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

function defaultUiDir(): string {
  return path.join(packageRoot(), 'web', 'dist');
}

interface RawApiKey {
  readonly id?: unknown;
  readonly key?: unknown;
  readonly workspace?: unknown;
  readonly roles?: unknown;
}

/** Parses `TRACERY_API_KEYS` (a JSON array) or the contents of `TRACERY_API_KEYS_FILE`. */
export function parseApiKeys(json: string, source: string): ApiKeyConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new Error(`${source} must be a JSON array of API key entries`);

  return raw.map((entry, index) => {
    const item = entry as RawApiKey;
    if (typeof item.key !== 'string' || item.key.length === 0) {
      throw new Error(`${source}[${index}].key must be a non-empty string`);
    }
    if (typeof item.workspace !== 'string' || item.workspace.length === 0) {
      throw new Error(`${source}[${index}].workspace must be a non-empty string`);
    }
    if (!Array.isArray(item.roles) || item.roles.length === 0 || !item.roles.every(isRole)) {
      throw new Error(`${source}[${index}].roles must be a non-empty array of "ingest" | "read" | "admin"`);
    }
    // hub-15: SPEC.md §6 "Auth" defines the operator key as workspace "*" AND role
    // "admin". A "*" key without "admin" would otherwise still get the operator's
    // cross-workspace reach (auth.ts's `isOperator` is keyed off workspace alone),
    // handing a workspace-scoped role (e.g. a "read *" monitoring key) far more
    // than it asked for. Caught at config-parse time, with a clear message, rather
    // than left as a surprising runtime permission.
    if (item.workspace === '*' && !(item.roles as readonly string[]).includes('admin')) {
      throw new Error(`${source}[${index}]: a key with workspace "*" (the operator key) must include role "admin"`);
    }
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `key-${index}`;
    return { id, key: item.key, workspace: item.workspace, roles: [...item.roles] as Role[] };
  });
}

function loadApiKeys(env: NodeJS.ProcessEnv): readonly ApiKeyConfig[] | undefined {
  const inline = env.TRACERY_API_KEYS;
  if (inline !== undefined && inline.trim() !== '') {
    return parseApiKeys(inline, 'TRACERY_API_KEYS');
  }
  const file = env.TRACERY_API_KEYS_FILE;
  if (file !== undefined && file.trim() !== '') {
    const contents = fs.readFileSync(file, 'utf8');
    return parseApiKeys(contents, `TRACERY_API_KEYS_FILE (${file})`);
  }
  return undefined;
}

/** hub-postgres: `postgres` needs a connection string with nowhere sensible to default it to (unlike `sqlite`'s file path) -- validated here, at config-load time, so a deployment missing it fails at boot with a clear message rather than on the first request that touches storage. */
function loadPostgresUrl(env: NodeJS.ProcessEnv, store: StoreKind): string | undefined {
  const raw = env.TRACERY_POSTGRES_URL;
  const url = raw && raw.trim() !== '' ? raw : undefined;
  if (store === 'postgres' && !url) {
    throw new Error('TRACERY_POSTGRES_URL is required when TRACERY_STORE=postgres');
  }
  return url;
}

/** Reads every hub environment variable, applying defaults. Never touches `process.env` directly (pass it in). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const store = parseStoreKind(env.TRACERY_STORE);
  return {
    port: parseNumber(env.TRACERY_PORT, 8971, 'TRACERY_PORT', { min: 1, max: 65_535, integer: true }),
    host: env.TRACERY_HOST ?? '0.0.0.0',
    store,
    sqlitePath: env.TRACERY_SQLITE_PATH ?? '/data/tracery.db',
    postgresUrl: loadPostgresUrl(env, store),
    apiKeys: loadApiKeys(env),
    // `min: Number.MIN_VALUE` reads oddly but says exactly what's meant: retention
    // must be strictly positive (a zero or negative window makes every flow
    // instantly over-retention -- SPEC.md's "the oldest complete flows first, never
    // a running flow younger than the retention window" only makes sense for a
    // window that actually extends into the past).
    retentionHours: parseNumber(env.TRACERY_RETENTION_HOURS, 72, 'TRACERY_RETENTION_HOURS', { min: Number.MIN_VALUE }),
    maxEventsPerWorkspace: parseNumber(env.TRACERY_MAX_EVENTS_PER_WORKSPACE, 500_000, 'TRACERY_MAX_EVENTS_PER_WORKSPACE', {
      min: 1,
      integer: true,
    }),
    metricsToken: env.TRACERY_METRICS_TOKEN && env.TRACERY_METRICS_TOKEN.length > 0 ? env.TRACERY_METRICS_TOKEN : undefined,
    logLevel: env.TRACERY_LOG_LEVEL ?? 'info',
    uiDir: env.TRACERY_UI_DIR ?? defaultUiDir(),
  };
}
