// Shared helpers for the HTTP/route tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../dist/server.js';

/** Builds a `Config` (SPEC.md §6) for tests, overriding only what a test cares about. */
export function testConfig(overrides = {}) {
  const uiDir = overrides.uiDir ?? path.join(os.tmpdir(), 'tracery-hub-test-ui-missing');
  return {
    port: 0,
    host: '127.0.0.1',
    store: 'memory',
    sqlitePath: ':memory:',
    apiKeys: undefined,
    retentionHours: 72,
    maxEventsPerWorkspace: 500_000,
    metricsToken: undefined,
    logLevel: 'silent',
    uiDir,
    ...overrides,
  };
}

/** Creates a server with a fixed, known set of API keys and returns it plus a `close()`. */
export async function createTestServer(overrides = {}) {
  const config = testConfig(overrides);
  const created = await createServer(config, overrides.extensions);
  return created;
}

export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}

/** A built UI dist directory with a minimal `index.html`, for the SPA-fallback test. */
export function makeUiDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hub-test-ui-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>ui-shell</body></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("ui");');
  return dir;
}
