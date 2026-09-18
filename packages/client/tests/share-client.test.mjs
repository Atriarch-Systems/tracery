// ShareClient (docs/SHARING.md): public, unauthenticated reads scoped to one
// share token, plus its live() reconnect behaviour via the shared
// live-connect.js driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ShareClient } from '../dist/index.js';

function startFakeHub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers });
    handler(req, res, url, requests[requests.length - 1]);
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

test('meta/flow/trace/events: GET the token-scoped public routes, no Authorization header ever sent', async () => {
  const hub = await startFakeHub((req, res, url) => {
    if (url.pathname.endsWith('/meta')) return sendJson(res, 200, { target: { type: 'flow', id: 'f1' }, mode: 'snapshot', includeContext: false, createdAt: 1, expiresAt: null, label: 'Alpha' });
    if (url.pathname.endsWith('/flow')) return sendJson(res, 200, { id: 'f1', status: 'complete', partial: false, trace: 'f1', ops: {}, nodes: {}, edges: [] });
    if (url.pathname.endsWith('/trace')) return sendJson(res, 200, { root: 'f1', flows: [], links: [], missing: [] });
    if (url.pathname.endsWith('/events')) return sendJson(res, 200, { type: 'snapshot', cursor: 3, events: [], truncated: false });
    res.writeHead(404);
    res.end();
  });
  const client = new ShareClient({ baseUrl: hub.baseUrl, token: 'tok-abc' });

  const meta = await client.meta();
  assert.equal(meta.label, 'Alpha');
  assert.equal(hub.requests[0].path, '/v1/shares/tok-abc/meta');
  assert.equal(hub.requests[0].headers.authorization, undefined);

  const flow = await client.flow();
  assert.equal(flow.id, 'f1');
  assert.equal(hub.requests[1].path, '/v1/shares/tok-abc/flow');

  const trace = await client.trace();
  assert.equal(trace.root, 'f1');
  assert.equal(hub.requests[2].path, '/v1/shares/tok-abc/trace');

  const frame = await client.events(2);
  assert.equal(frame.cursor, 3);
  assert.equal(hub.requests[3].path, '/v1/shares/tok-abc/events');
  assert.equal(hub.requests[3].query.get('after'), '2');

  await closeHub(hub);
});

test('previewUrl: builds the preview.png URL without making a request', async () => {
  const client = new ShareClient({ baseUrl: 'http://hub.example', token: 'tok-abc', fetch: async () => { throw new Error('should not fetch'); } });
  assert.equal(client.previewUrl(), 'http://hub.example/v1/shares/tok-abc/preview.png');
});

test('a non-ok response rejects with the hub-provided error message', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 404, { error: { code: 'not_found', message: 'no such share' } }));
  const client = new ShareClient({ baseUrl: hub.baseUrl, token: 'gone' });

  await assert.rejects(() => client.meta(), /no such share/);

  await closeHub(hub);
});

// ---------------------------------------------------------------------------
// live(): same fake-WebSocket pattern as hub-client.test.mjs
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this._emit('close', {});
  }
  _emit(type, evt) {
    for (const cb of this.listeners.get(type) ?? []) cb(evt);
  }
}

const waitFor = async (predicate, timeoutMs = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('live(): connects to the token-scoped WS URL with no token/apiKey query param, reconnects from the last cursor', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new ShareClient({ baseUrl: 'http://hub.example', token: 'tok-abc', WebSocket: FakeWebSocket });
  const frames = [];

  const dispose = client.live((frame) => frames.push(frame));

  await waitFor(() => FakeWebSocket.instances.length === 1);
  const first = FakeWebSocket.instances[0];
  assert.equal(first.url, 'ws://hub.example/v1/shares/tok-abc/live');

  first._emit('open', {});
  first._emit('message', { data: JSON.stringify({ type: 'snapshot', cursor: 10, events: [], truncated: false }) });
  assert.equal(frames.length, 1);

  first._emit('close', {});
  await waitFor(() => FakeWebSocket.instances.length === 2, 3000);
  const second = FakeWebSocket.instances[1];
  const secondQuery = new URL(second.url.replace(/^ws/, 'http')).searchParams;
  assert.equal(secondQuery.get('after'), '10');

  dispose();
  assert.equal(second.closed, true);
});

test('live() throws synchronously when no WebSocket implementation is available', () => {
  // `WebSocket: false` defeats the `options.WebSocket ?? globalThis.WebSocket`
  // fallback (Node 22 has a global WebSocket) without passing null/undefined,
  // which `??` would treat as "not provided" -- same trick as hub-client.test.mjs.
  const client = new ShareClient({ baseUrl: 'http://hub.example', token: 'tok-abc', WebSocket: false });
  assert.throws(() => client.live(() => {}), /no WebSocket implementation/);
});
