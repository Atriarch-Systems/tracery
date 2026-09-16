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
  assert.equal(config.sqlitePath, '/data/activity.db');
  assert.equal(config.apiKeys, undefined);
  assert.equal(config.retentionHours, 72);
  assert.equal(config.maxEventsPerWorkspace, 500_000);
  assert.equal(config.metricsToken, undefined);
  assert.equal(config.logLevel, 'info');
  assert.ok(config.uiDir.endsWith(path.join('web', 'dist')));
});

test('loadConfig: every documented env var overrides its default', () => {
  const config = loadConfig({
    ACTIVITY_PORT: '9000',
    ACTIVITY_HOST: '127.0.0.1',
    ACTIVITY_STORE: 'sqlite',
    ACTIVITY_SQLITE_PATH: '/tmp/x.db',
    ACTIVITY_API_KEYS: JSON.stringify([{ key: 'k', workspace: 'w', roles: ['read'] }]),
    ACTIVITY_RETENTION_HOURS: '24',
    ACTIVITY_MAX_EVENTS_PER_WORKSPACE: '10',
    ACTIVITY_METRICS_TOKEN: 'tok',
    ACTIVITY_LOG_LEVEL: 'debug',
    ACTIVITY_UI_DIR: '/somewhere',
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
  assert.throws(() => loadConfig({ ACTIVITY_PORT: 'not-a-number' }), /ACTIVITY_PORT/);
});

test('parseApiKeys: rejects malformed entries with a precise reason', () => {
  assert.throws(() => parseApiKeys('not json', 'SRC'), /not valid JSON/);
  assert.throws(() => parseApiKeys('{}', 'SRC'), /must be a JSON array/);
  assert.throws(() => parseApiKeys('[{"workspace":"w","roles":["read"]}]', 'SRC'), /\.key must be/);
  assert.throws(() => parseApiKeys('[{"key":"k","roles":["read"]}]', 'SRC'), /\.workspace must be/);
  assert.throws(() => parseApiKeys('[{"key":"k","workspace":"w","roles":["bogus"]}]', 'SRC'), /\.roles must be/);
});

test('loadConfig: ACTIVITY_API_KEYS_FILE is read and parsed when ACTIVITY_API_KEYS is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-hub-keys-'));
  const file = path.join(dir, 'keys.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'ops', key: 'opkey', workspace: '*', roles: ['ingest', 'read', 'admin'] }]));
  try {
    const config = loadConfig({ ACTIVITY_API_KEYS_FILE: file });
    assert.deepEqual(config.apiKeys, [{ id: 'ops', key: 'opkey', workspace: '*', roles: ['ingest', 'read', 'admin'] }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
