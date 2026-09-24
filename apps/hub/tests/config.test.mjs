import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseApiKeys, isLoopbackHost, hubVersion } from '../dist/config.js';

test('loadConfig: every documented default applies when the environment is empty', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8971);
  // Task ("local mode"): the default host is loopback-only, not 0.0.0.0 --
  // `npx @atriarch-systems/tracery-hub` with no env must bind 127.0.0.1 and run with
  // auth off (authMode 'none'), never mint or print a key. The Dockerfile
  // sets TRACERY_HOST=0.0.0.0 explicitly for the container case.
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.store, 'memory');
  assert.equal(config.sqlitePath, '/data/tracery.db');
  assert.equal(config.postgresUrl, undefined);
  assert.equal(config.apiKeys, undefined);
  assert.equal(config.authMode, 'none');
  assert.equal(config.authWarning, undefined);
  assert.equal(config.retentionHours, 72);
  assert.equal(config.maxEventsPerWorkspace, 500_000);
  assert.equal(config.metricsToken, undefined);
  assert.equal(config.logLevel, 'info');
  assert.ok(config.uiDir.endsWith(path.join('web', 'dist')));
});

test('loadConfig: every documented env var overrides its default', () => {
  const config = loadConfig({
    TRACERY_PORT: '9000',
    TRACERY_HOST: '0.0.0.0',
    TRACERY_STORE: 'sqlite',
    TRACERY_SQLITE_PATH: '/tmp/x.db',
    TRACERY_API_KEYS: JSON.stringify([{ key: 'k', workspace: 'w', roles: ['read'] }]),
    TRACERY_RETENTION_HOURS: '24',
    TRACERY_MAX_EVENTS_PER_WORKSPACE: '10',
    TRACERY_METRICS_TOKEN: 'tok',
    TRACERY_LOG_LEVEL: 'debug',
    TRACERY_UI_DIR: '/somewhere',
  });
  assert.equal(config.port, 9000);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.store, 'sqlite');
  assert.equal(config.sqlitePath, '/tmp/x.db');
  assert.deepEqual(config.apiKeys, [{ id: 'key-0', key: 'k', workspace: 'w', roles: ['read'] }]);
  assert.equal(config.authMode, 'keys');
  assert.equal(config.retentionHours, 24);
  assert.equal(config.maxEventsPerWorkspace, 10);
  assert.equal(config.metricsToken, 'tok');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.uiDir, '/somewhere');
});

// ---------------------------------------------------------------------------
// authMode ("local mode")
// ---------------------------------------------------------------------------

test('isLoopbackHost: exactly 127.0.0.1, ::1, localhost (case-insensitively); 0.0.0.0 and anything else is not', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost('127.0.0.2'), false);
});

test('loadConfig: TRACERY_API_KEYS(_FILE) set -> authMode "keys" regardless of host', () => {
  const keysJson = JSON.stringify([{ key: 'k', workspace: 'w', roles: ['read'] }]);
  assert.equal(loadConfig({ TRACERY_API_KEYS: keysJson }).authMode, 'keys');
  assert.equal(loadConfig({ TRACERY_API_KEYS: keysJson, TRACERY_HOST: '127.0.0.1' }).authMode, 'keys');
  assert.equal(loadConfig({ TRACERY_API_KEYS: keysJson, TRACERY_HOST: '0.0.0.0' }).authMode, 'keys');
});

test('loadConfig: no keys + loopback host -> authMode "none", no warning', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', undefined]) {
    const env = host === undefined ? {} : { TRACERY_HOST: host };
    const config = loadConfig(env);
    assert.equal(config.authMode, 'none', `host ${host}`);
    assert.equal(config.authWarning, undefined, `host ${host}`);
  }
});

test('loadConfig: no keys + non-loopback host + TRACERY_AUTH=none -> authMode "none" with a warning', () => {
  const config = loadConfig({ TRACERY_HOST: '0.0.0.0', TRACERY_AUTH: 'none' });
  assert.equal(config.authMode, 'none');
  assert.match(config.authWarning, /not loopback/);
  assert.match(config.authWarning, /TRACERY_AUTH=none/);
});

test('loadConfig: no keys + non-loopback host + no TRACERY_AUTH=none -> fails to boot with a clear error', () => {
  assert.throws(() => loadConfig({ TRACERY_HOST: '0.0.0.0' }), /TRACERY_HOST is not loopback and no API keys are configured/);
  assert.throws(() => loadConfig({ TRACERY_HOST: 'example.com' }), /TRACERY_HOST is not loopback/);
  // A TRACERY_AUTH value other than exactly "none" does not count as the opt-out.
  assert.throws(() => loadConfig({ TRACERY_HOST: '0.0.0.0', TRACERY_AUTH: 'yes' }), /TRACERY_HOST is not loopback/);
});

test('hubVersion: reads a non-empty version string from apps/hub/package.json', () => {
  const version = hubVersion();
  assert.equal(typeof version, 'string');
  assert.ok(version.length > 0);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test('loadConfig: an unparseable numeric env var throws with the variable name', () => {
  assert.throws(() => loadConfig({ TRACERY_PORT: 'not-a-number' }), /TRACERY_PORT/);
});

// hub-16: a TRACERY_STORE typo must not silently fall back to the in-memory
// store, and out-of-range numeric env vars must not silently wipe data on the
// first sweep/boot.
test('loadConfig: an unrecognised TRACERY_STORE throws instead of silently falling back to "memory"', () => {
  assert.throws(() => loadConfig({ TRACERY_STORE: 'sqllite' }), /TRACERY_STORE/);
  assert.equal(loadConfig({}).store, 'memory');
  assert.equal(loadConfig({ TRACERY_STORE: 'sqlite' }).store, 'sqlite');
  assert.equal(loadConfig({ TRACERY_STORE: 'memory' }).store, 'memory');
  assert.equal(loadConfig({ TRACERY_STORE: 'postgres', TRACERY_POSTGRES_URL: 'postgres://x/y' }).store, 'postgres');
});

// hub-postgres: TRACERY_STORE=postgres has no sensible default connection string
// (unlike sqlite's file path), so a missing TRACERY_POSTGRES_URL must fail loudly
// at boot instead of the store failing to connect on the first request.
test('loadConfig: TRACERY_STORE=postgres requires TRACERY_POSTGRES_URL', () => {
  assert.throws(() => loadConfig({ TRACERY_STORE: 'postgres' }), /TRACERY_POSTGRES_URL/);
  assert.throws(() => loadConfig({ TRACERY_STORE: 'postgres', TRACERY_POSTGRES_URL: '' }), /TRACERY_POSTGRES_URL/);
  const config = loadConfig({ TRACERY_STORE: 'postgres', TRACERY_POSTGRES_URL: 'postgres://user:pw@host:5432/db' });
  assert.equal(config.postgresUrl, 'postgres://user:pw@host:5432/db');
  // TRACERY_POSTGRES_URL is harmless (and ignored) when the store isn't postgres.
  assert.equal(loadConfig({ TRACERY_POSTGRES_URL: 'postgres://unused' }).store, 'memory');
});

test('loadConfig: a non-positive TRACERY_RETENTION_HOURS or TRACERY_MAX_EVENTS_PER_WORKSPACE throws', () => {
  assert.throws(() => loadConfig({ TRACERY_RETENTION_HOURS: '0' }), /TRACERY_RETENTION_HOURS/);
  assert.throws(() => loadConfig({ TRACERY_RETENTION_HOURS: '-1' }), /TRACERY_RETENTION_HOURS/);
  assert.throws(() => loadConfig({ TRACERY_MAX_EVENTS_PER_WORKSPACE: '0' }), /TRACERY_MAX_EVENTS_PER_WORKSPACE/);
  assert.throws(() => loadConfig({ TRACERY_MAX_EVENTS_PER_WORKSPACE: '-5' }), /TRACERY_MAX_EVENTS_PER_WORKSPACE/);
  assert.throws(() => loadConfig({ TRACERY_MAX_EVENTS_PER_WORKSPACE: '1.5' }), /TRACERY_MAX_EVENTS_PER_WORKSPACE/);
});

test('loadConfig: TRACERY_PORT must be an integer in [1, 65535]', () => {
  assert.throws(() => loadConfig({ TRACERY_PORT: '0' }), /TRACERY_PORT/);
  assert.throws(() => loadConfig({ TRACERY_PORT: '-1' }), /TRACERY_PORT/);
  assert.throws(() => loadConfig({ TRACERY_PORT: '0.5' }), /TRACERY_PORT/);
  assert.throws(() => loadConfig({ TRACERY_PORT: '70000' }), /TRACERY_PORT/);
  assert.equal(loadConfig({ TRACERY_PORT: '65535' }).port, 65535);
});

// hub-15: SPEC.md §6 defines the operator key as workspace "*" AND role "admin".
test('parseApiKeys: a workspace "*" key without role "admin" is rejected at parse time', () => {
  assert.throws(
    () => parseApiKeys('[{"key":"k","workspace":"*","roles":["read"]}]', 'SRC'),
    /workspace "\*".*must include role "admin"/,
  );
  // Still accepted once "admin" is present.
  const ok = parseApiKeys('[{"key":"k","workspace":"*","roles":["read","admin"]}]', 'SRC');
  assert.equal(ok[0].workspace, '*');
});

test('parseApiKeys: rejects malformed entries with a precise reason', () => {
  assert.throws(() => parseApiKeys('not json', 'SRC'), /not valid JSON/);
  assert.throws(() => parseApiKeys('{}', 'SRC'), /must be a JSON array/);
  assert.throws(() => parseApiKeys('[{"workspace":"w","roles":["read"]}]', 'SRC'), /\.key must be/);
  assert.throws(() => parseApiKeys('[{"key":"k","roles":["read"]}]', 'SRC'), /\.workspace must be/);
  assert.throws(() => parseApiKeys('[{"key":"k","workspace":"w","roles":["bogus"]}]', 'SRC'), /\.roles must be/);
});

test('loadConfig: TRACERY_API_KEYS_FILE is read and parsed when TRACERY_API_KEYS is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hub-keys-'));
  const file = path.join(dir, 'keys.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'ops', key: 'opkey', workspace: '*', roles: ['ingest', 'read', 'admin'] }]));
  try {
    const config = loadConfig({ TRACERY_API_KEYS_FILE: file });
    assert.deepEqual(config.apiKeys, [{ id: 'ops', key: 'opkey', workspace: '*', roles: ['ingest', 'read', 'admin'] }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
