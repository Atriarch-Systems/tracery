// HubClient.shares.{create,list,revoke,uploadPreview} (docs/SHARING.md):
// same fake-HTTP-server pattern as hub-client.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HubClient } from '../dist/index.js';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function startFakeHub(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    const record = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body };
    requests.push(record);
    handler(req, res, url, record);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function closeHub(hub) {
  return new Promise((resolve) => hub.server.close(resolve));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('shares.create: POST /v1/shares with a JSON body, returns { id, token, url }', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 201, { id: 's1', token: 'tok123', url: 'http://hub.example/s/tok123' }));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'secret', workspace: 'default' });

  const result = await client.shares.create({ target: { type: 'flow', id: 'f1' }, mode: 'snapshot', includeContext: false, expiresInDays: 7 });

  assert.equal(hub.requests[0].method, 'POST');
  assert.equal(hub.requests[0].path, '/v1/shares');
  assert.equal(hub.requests[0].query.get('workspace'), 'default');
  assert.equal(hub.requests[0].headers.authorization, 'Bearer secret');
  assert.equal(hub.requests[0].headers['content-type'], 'application/json');
  const sentBody = JSON.parse(hub.requests[0].body.toString());
  assert.deepEqual(sentBody, { target: { type: 'flow', id: 'f1' }, mode: 'snapshot', includeContext: false, expiresInDays: 7 });
  assert.deepEqual(result, { id: 's1', token: 'tok123', url: 'http://hub.example/s/tok123' });

  await closeHub(hub);
});

test('shares.list: GET /v1/shares returns the shares array', async () => {
  const shares = [{ id: 's1', workspace: 'default', target: { type: 'flow', id: 'f1' }, mode: 'snapshot' }];
  const hub = await startFakeHub((req, res) => sendJson(res, 200, { shares }));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  const result = await client.shares.list();

  assert.equal(hub.requests[0].method, 'GET');
  assert.equal(hub.requests[0].path, '/v1/shares');
  assert.deepEqual(result, shares);

  await closeHub(hub);
});

test('shares.revoke: DELETE /v1/shares/:id, url-encoded', async () => {
  const hub = await startFakeHub((req, res) => {
    res.writeHead(204);
    res.end();
  });
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  await client.shares.revoke('share/with slash');

  assert.equal(hub.requests[0].method, 'DELETE');
  assert.equal(hub.requests[0].path, '/v1/shares/share%2Fwith%20slash');

  await closeHub(hub);
});

test('shares.revoke: a non-ok response rejects with the hub-provided error message', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 403, { error: { code: 'forbidden', message: 'not your share' } }));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  await assert.rejects(() => client.shares.revoke('s1'), /not your share/);

  await closeHub(hub);
});

test('shares.uploadPreview: PUT /v1/shares/:id/preview sends raw bytes with Content-Type: image/png', async () => {
  const hub = await startFakeHub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'secret' });

  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  await client.shares.uploadPreview('s1', png);

  assert.equal(hub.requests[0].method, 'PUT');
  assert.equal(hub.requests[0].path, '/v1/shares/s1/preview');
  assert.equal(hub.requests[0].headers['content-type'], 'image/png');
  assert.equal(hub.requests[0].headers.authorization, 'Bearer secret');
  assert.deepEqual([...hub.requests[0].body], [...png]);

  await closeHub(hub);
});

test('shares.uploadPreview: a non-ok response rejects with the hub-provided error message', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 413, { error: { code: 'body_too_large', message: 'preview too large' } }));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  await assert.rejects(() => client.shares.uploadPreview('s1', new Uint8Array([1, 2, 3])), /preview too large/);

  await closeHub(hub);
});
