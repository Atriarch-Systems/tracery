/**
 * Test helpers for anything that builds a hub server in a test process --
 * this package's own `tests/*.test.mjs`, and (via the `"./test-helpers"`
 * export) an extensions package's tests, e.g. `@atriarch/tracery-cloud-ee`
 * in the private `tracery-cloud` repo. Ported to TypeScript from
 * `tests/route-helpers.mjs` and `tests/helpers.mjs` specifically so an
 * external package can `import` these from the published package instead of
 * reaching into this package's `tests/` directory (which ships source, not
 * `dist`, and is not part of `files` in `package.json`).
 *
 * This module is intentionally not used by `tests/*.test.mjs` itself --
 * those still import the original `.mjs` helpers next to them, unchanged --
 * so this file is purely the external-facing surface, kept in sync with the
 * `.mjs` originals by hand.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_CONTRACT_VERSION, type ActivityEvent } from '@atriarch-systems/tracery-core/contract';
import { createServer } from './server.js';
import type { CreatedServer, HubExtensions } from './server.js';
import type { Config } from './config.js';
import { MemoryStore } from './store/memory.js';
import { SqliteStore } from './store/sqlite.js';
import type { EventStore } from './store/types.js';

/**
 * Builds a `Config` (SPEC.md §6) for tests, overriding only what a test
 * cares about. `authMode` defaults to `'keys'` (matching every existing hub
 * route test, which passes `apiKeys` explicitly) -- pass
 * `{ authMode: 'none' }` explicitly (with `apiKeys` left `undefined`) to
 * exercise local mode instead.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const uiDir = overrides.uiDir ?? path.join(os.tmpdir(), 'tracery-hub-test-ui-missing');
  return {
    port: 0,
    host: '127.0.0.1',
    store: 'memory',
    sqlitePath: ':memory:',
    postgresUrl: undefined,
    apiKeys: undefined,
    authMode: 'keys',
    authWarning: undefined,
    retentionHours: 72,
    maxEventsPerWorkspace: 500_000,
    metricsToken: undefined,
    logLevel: 'silent',
    uiDir,
    publicUrl: undefined,
    ...overrides,
  };
}

/** Creates a server with a fixed, known set of API keys (or any other `testConfig` override) plus optional `extensions`, and returns the created server. */
export async function createTestServer(overrides: Partial<Config> & { readonly extensions?: HubExtensions } = {}): Promise<CreatedServer> {
  const { extensions, ...configOverrides } = overrides;
  const config = testConfig(configOverrides);
  return createServer(config, extensions);
}

export function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** A built UI dist directory with a minimal `index.html`, for the SPA-fallback test. */
export function makeUiDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hub-test-ui-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Tracery</title></head><body>ui-shell</body></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("ui");');
  return dir;
}

/** A minimal, spec-valid `ActivityEvent`, with `overrides` merged in. */
export function evt(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    v: ACTIVITY_CONTRACT_VERSION,
    id: 'e1',
    ts: 1000,
    flow: 'f1',
    op: 'o1',
    node: 'n1',
    type: 'start',
    name: 'x',
    ...overrides,
  } as ActivityEvent;
}

export interface StoreEngine {
  readonly name: string;
  create(): Promise<{ readonly store: EventStore; readonly cleanup: () => Promise<void> }>;
}

/** The two store engines under test, each producing a fresh, isolated instance. */
export const storeEngines: readonly StoreEngine[] = [
  {
    name: 'MemoryStore',
    async create() {
      const store = new MemoryStore();
      return { store, cleanup: async () => store.close() };
    },
  },
  {
    name: 'SqliteStore',
    async create() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hub-sqlite-'));
      const file = path.join(dir, 'test.db');
      const store = new SqliteStore(file);
      return {
        store,
        cleanup: async () => {
          await store.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

/** Runs `fn(store)` against a fresh store instance, cleaning up afterwards even on failure. */
export async function withStore(create: StoreEngine['create'], fn: (store: EventStore) => Promise<void>): Promise<void> {
  const { store, cleanup } = await create();
  try {
    await fn(store);
  } finally {
    await cleanup();
  }
}

/** Package root, i.e. `apps/hub`, resolved from the compiled `dist/test-helpers.js` -- for a caller (e.g. `tmpSqlitePath`-style helpers) that needs a scratch directory relative to this package rather than its own. */
export function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}
