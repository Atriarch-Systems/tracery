import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestServer } from './route-helpers.mjs';
import { loadConfig } from '../dist/config.js';

test('local mode rejects foreign, opaque and rebinding origins before reads, writes or preflights', async t => {
  const server = await createTestServer({ authMode: 'none' });
  t.after(() => server.close());
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    for (const origin of ['https://untrusted.example', 'null']) {
      const res = await server.app.inject({ method, url: '/v1/events', headers: { origin } });
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  }
  const rebound = await server.app.inject({ url: '/v1/flows', headers: { host: 'untrusted.example', origin: 'http://untrusted.example' } });
  assert.equal(rebound.statusCode, 403);
  const native = await server.app.inject({ url: '/v1/flows' });
  assert.equal(native.statusCode, 200);
  const local = await server.app.inject({ url: '/v1/flows', headers: { host: 'localhost:8971', origin: 'http://localhost:8971' } });
  assert.equal(local.statusCode, 200);
});

test('only exact configured origins pass; they do not bypass API key authentication', async t => {
  const server = await createTestServer({ apiKeys: [{ id: 'test', key: 'test', workspace: 'default', roles: ['read'] }], allowedOrigins: ['https://app.example'] });
  t.after(() => server.close());
  const headers = { origin: 'https://app.example' };
  assert.equal((await server.app.inject({ url: '/v1/flows', headers })).statusCode, 401);
  assert.equal((await server.app.inject({ url: '/v1/flows', headers: { ...headers, authorization: 'Bearer test' } })).statusCode, 200);
  assert.equal((await server.app.inject({ url: '/v1/flows', headers: { ...headers, origin: 'https://app.example.attacker.test', authorization: 'Bearer test' } })).statusCode, 403);
});

test('foreign browser WebSockets are rejected before upgrade, including share routes', { timeout: 5000 }, async t => {
  const server = await createTestServer({ authMode: 'none' });
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());
  for (const route of ['/v1/live', '/v1/shares/unknown/live']) {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(address + route, { headers: { origin: 'https://untrusted.example',
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('foreign origin upgraded')); });
      req.on('error', err => err.code === 'ECONNRESET' ? resolve('closed-before-upgrade') : reject(err));
    });
    assert.ok(status === 403 || status === 'closed-before-upgrade', String(status));
  }
});

test('allowed-origin configuration rejects wildcards, paths, and opaque origins', () => {
  for (const origin of ['*', 'null', 'https://app.example/path', 'https://user:pass@app.example']) {
    assert.throws(() => loadConfig({ TRACERY_ALLOWED_ORIGINS: origin }), /TRACERY_ALLOWED_ORIGINS/);
  }
  assert.deepEqual(loadConfig({ TRACERY_ALLOWED_ORIGINS: 'https://app.example,http://localhost:5173' }).allowedOrigins,
    ['https://app.example', 'http://localhost:5173']);
});
