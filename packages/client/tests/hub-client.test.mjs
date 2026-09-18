import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HubClient } from '../dist/index.js';

function startFakeHub(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers });
    handler(req, res, url, requests[requests.length - 1]);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

function closeHub(hub) {
  return new Promise((resolve) => hub.server.close(resolve));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('listFlows: GET /v1/flows with query + workspace + Bearer auth', async () => {
  const flows = [{ id: 'f1', status: 'complete', partial: false, trace: 'f1', ops: {}, nodes: {}, edges: [] }];
  const hub = await startFakeHub((req, res, url) => sendJson(res, 200, { flows, nextBefore: undefined }));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'secret', workspace: 'default' });

  const result = await client.listFlows({ limit: 10, status: 'running' });

  assert.equal(hub.requests.length, 1);
  const req = hub.requests[0];
  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/v1/flows');
  assert.equal(req.query.get('workspace'), 'default');
  assert.equal(req.query.get('limit'), '10');
  assert.equal(req.query.get('status'), 'running');
  assert.equal(req.query.has('before'), false);
  assert.equal(req.headers.authorization, 'Bearer secret');
  assert.deepEqual(result.flows, flows);

  await closeHub(hub);
});

test('getFlow: GET /v1/flows/:id, id url-encoded round trip', async () => {
  const hub = await startFakeHub((req, res, url) => {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    sendJson(res, 200, { id, status: 'running', partial: false, trace: id, ops: {}, nodes: {}, edges: [] });
  });
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  const flow = await client.getFlow('agent:saga/flow 1');

  assert.equal(hub.requests[0].path, '/v1/flows/agent%3Asaga%2Fflow%201');
  assert.equal(flow.id, 'agent:saga/flow 1');

  await closeHub(hub);
});

test('getTrace: GET /v1/traces/:id', async () => {
  const hub = await startFakeHub((req, res) =>
    sendJson(res, 200, { root: 't1', flows: [], links: [], missing: [] }),
  );
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  const trace = await client.getTrace('t1');

  assert.equal(hub.requests[0].method, 'GET');
  assert.equal(hub.requests[0].path, '/v1/traces/t1');
  assert.equal(trace.root, 't1');

  await closeHub(hub);
});

test('events: GET /v1/flows/:id/events, omits `after` when not given and includes it when given', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 200, { type: 'snapshot', cursor: 5, events: [], truncated: false }));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  await client.events('f1');
  assert.equal(hub.requests[0].path, '/v1/flows/f1/events');
  assert.equal(hub.requests[0].query.has('after'), false);

  await client.events('f1', 42);
  assert.equal(hub.requests[1].query.get('after'), '42');

  await closeHub(hub);
});

test('traceEvents: GET /v1/traces/:id/events returns the raw array', async () => {
  const events = [{ v: 1, id: 'e1', ts: 1, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', workspace: 'default', cursor: 1, receivedAt: 1 }];
  const hub = await startFakeHub((req, res) => sendJson(res, 200, events));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  const result = await client.traceEvents('t1');
  assert.equal(hub.requests[0].path, '/v1/traces/t1/events');
  assert.deepEqual(result, events);

  await closeHub(hub);
});

// Task ("local mode"): a hub running with `authMode: 'none'` needs no
// credential at all -- HubClient must not send an `Authorization` header (or
// a `?token=` on the WS URL, tested below) when no `apiKey` is configured.
test('getFlow: with no apiKey configured, no Authorization header is sent at all', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 200, { id: 'f1', status: 'running', partial: false, trace: 'f1', ops: {}, nodes: {}, edges: [] }));
  const client = new HubClient({ baseUrl: hub.baseUrl });

  await client.getFlow('f1');

  assert.equal(hub.requests[0].headers.authorization, undefined);

  await closeHub(hub);
});

test('a non-ok response rejects with the hub-provided error message', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 404, { error: { code: 'not_found', message: 'no such flow' } }));
  const client = new HubClient({ baseUrl: hub.baseUrl, apiKey: 'k' });

  await assert.rejects(() => client.getFlow('missing'), /no such flow/);

  await closeHub(hub);
});

// ---------------------------------------------------------------------------
// live(): reconnect-from-cursor with backoff, driven by a fake WebSocket.
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

test('live(): connects with ws(s) URL carrying token/flow/after, reconnects from the last cursor on close', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new HubClient({ baseUrl: 'http://hub.example', apiKey: 'tok', WebSocket: FakeWebSocket });
  const frames = [];

  const dispose = client.live({ flow: 'f1', after: 5 }, (frame) => frames.push(frame));

  await waitFor(() => FakeWebSocket.instances.length === 1);
  const first = FakeWebSocket.instances[0];
  assert.match(first.url, /^ws:\/\/hub\.example\/v1\/live\?/);
  const firstQuery = new URL(first.url.replace(/^ws/, 'http')).searchParams;
  assert.equal(firstQuery.get('flow'), 'f1');
  assert.equal(firstQuery.get('after'), '5');
  assert.equal(firstQuery.get('token'), 'tok');

  first._emit('open', {});
  first._emit('message', { data: JSON.stringify({ type: 'snapshot', cursor: 10, events: [], truncated: false }) });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].cursor, 10);

  // Server drops the connection; the client should reconnect using the last cursor it saw.
  first._emit('close', {});
  await waitFor(() => FakeWebSocket.instances.length === 2, 3000);
  const second = FakeWebSocket.instances[1];
  const secondQuery = new URL(second.url.replace(/^ws/, 'http')).searchParams;
  assert.equal(secondQuery.get('after'), '10');

  dispose();
  assert.equal(second.closed, true);

  // Disposed: no further reconnect even after another close.
  const countBeforeExtraWait = FakeWebSocket.instances.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(FakeWebSocket.instances.length, countBeforeExtraWait);
});

test('live(): reconnecting immediately after every open backs off instead of resetting to the floor each time', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new HubClient({ baseUrl: 'http://hub.example', apiKey: 'tok', WebSocket: FakeWebSocket });
  const connectingAttempts = [];

  // stableAfterMs is set far longer than this test runs, so a connection
  // that opens and is immediately closed again never counts as "proven
  // stable" -- exactly the case (a rejected key, load-shedding, a
  // slow-client drop) that must back off rather than reconnect forever at
  // the 200ms floor.
  const dispose = client.live(
    {},
    () => {},
    {
      stableAfterMs: 10_000,
      onStatus: (event) => {
        if (event.status === 'connecting') connectingAttempts.push(event.attempt);
      },
    },
  );

  await waitFor(() => FakeWebSocket.instances.length === 1);
  for (let i = 0; i < 4; i++) {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws._emit('open', {});
    ws._emit('close', {});
    await waitFor(() => FakeWebSocket.instances.length === i + 2, 3000);
  }
  dispose();

  // Strictly increasing, one connect at a time — never dropping back to the
  // floor just because each socket briefly reached `open` before closing.
  assert.deepEqual(connectingAttempts, [0, 1, 2, 3, 4]);
});

test("live(): onFrame's own exception is reported via onError instead of swallowed, and the frame's cursor is not adopted", async () => {
  FakeWebSocket.instances.length = 0;
  const client = new HubClient({ baseUrl: 'http://hub.example', apiKey: 'tok', WebSocket: FakeWebSocket });
  const frames = [];
  const errors = [];
  let throwNext = false;

  const dispose = client.live(
    {},
    (frame) => {
      frames.push(frame);
      if (throwNext) {
        throwNext = false;
        throw new Error('boom');
      }
    },
    { onError: (err) => errors.push(err) },
  );

  await waitFor(() => FakeWebSocket.instances.length === 1);
  const first = FakeWebSocket.instances[0];
  first._emit('open', {});

  // Baseline: a normal frame is delivered and its cursor adopted.
  first._emit('message', { data: JSON.stringify({ type: 'snapshot', cursor: 5, events: [], truncated: false }) });
  assert.equal(frames.length, 1);

  // Malformed JSON: reported via onError, no frame delivered, connection stays open.
  first._emit('message', { data: 'not json' });
  assert.equal(errors.length, 1);
  assert.equal(frames.length, 1);

  // onFrame itself throws: the exception must be reported (not silently
  // discarded) and this frame's cursor must NOT be adopted, so a reconnect
  // replays it instead of leaving a permanent gap in the feed.
  throwNext = true;
  first._emit('message', { data: JSON.stringify({ type: 'snapshot', cursor: 10, events: [], truncated: false }) });
  assert.equal(frames.length, 2); // onFrame was called...
  assert.equal(errors.length, 2); // ...and its throw was reported...
  assert.equal(errors[1].message, 'boom');

  first._emit('close', {});
  await waitFor(() => FakeWebSocket.instances.length === 2, 3000);
  const second = FakeWebSocket.instances[1];
  const secondQuery = new URL(second.url.replace(/^ws/, 'http')).searchParams;
  assert.equal(secondQuery.get('after'), '5'); // ...cursor 10 was never adopted

  dispose();
});

test('live(): with no apiKey configured, the WS URL carries no token= param at all', async () => {
  FakeWebSocket.instances.length = 0;
  const client = new HubClient({ baseUrl: 'http://hub.example', WebSocket: FakeWebSocket });

  const dispose = client.live({ flow: 'f1' }, () => {});
  await waitFor(() => FakeWebSocket.instances.length === 1);

  const query = new URL(FakeWebSocket.instances[0].url.replace(/^ws/, 'http')).searchParams;
  assert.equal(query.has('token'), false);

  dispose();
});

test('live() throws synchronously when no WebSocket implementation is available', () => {
  // `WebSocket: false` defeats the `options.WebSocket ?? globalThis.WebSocket`
  // fallback (Node 22 has a global WebSocket) without passing null/undefined,
  // which `??` would treat as "not provided".
  const client = new HubClient({ baseUrl: 'http://hub.example', apiKey: 'tok', WebSocket: false });
  assert.throws(() => client.live({}, () => {}), /WebSocket implementation/);
});
