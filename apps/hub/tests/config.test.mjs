import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseApiKeys } from '../dist/config.js';

test('loadConfig: every documented default applies when the environment is empty', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8971);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.store, 'memory');
  assert.equal(config.sqlitePath, '/data/tracery.db');
  assert.equal(config.apiKeys, undefined);
  assert.equal(config.retentionHours, 72);
  assert.equal(config.maxEventsPerWorkspace, 500_000);
  assert.equal(config.metricsToken, undefined);
  assert.equal(config.logLevel, 'info');
  assert.ok(config.uiDir.endsWith(path.join('web', 'dist')));
});

test('loadConfig: every documented env var overrides its default', () => {
  const config = loadConfig({
    TRACERY_PORT: '9000',
    TRACERY_HOST: '127.0.0.1',
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
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.store, 'sqlite');
  assert.equal(config.sqlitePath, '/tmp/x.db');
  assert.deepEqual(config.apiKeys, [{ id: 'key-0', key: 'k', workspace: 'w', roles: ['read'] }]);
  assert.equal(config.retentionHours, 24);
  assert.equal(config.maxEventsPerWorkspace, 10);
  assert.equal(config.metricsToken, 'tok');
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.uiDir, '/somewhere');
});

test('loadConfig: an unparseable numeric env var throws with the variable name', () => {
  assert.throws(() => loadConfig({ TRACERY_PORT: 'not-a-number' }), /TRACERY_PORT/);
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
