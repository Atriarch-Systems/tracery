// WS /v1/shares/:token/live (docs/SHARING.md): only serves a `mode: 'live'`
// share, reuses live.ts's snapshot/events/heartbeat framing and drop rules
// (see tests/live.test.mjs), and redacts context the same way the public
// HTTP routes do when includeContext is false. Uses the `ws` package against
// an actually-listening server, same pattern as live.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch/tracery-core/contract';
import { createTestServer, bearer } from './route-helpers.mjs';

const KEYS = [{ id: 'full', key: 'key-full', workspace: 'default', roles: ['ingest', 'read', 'admin'] }];

function oneEvent(overrides = {}) {
  return {
    v: ACTIVITY_CONTRACT_VERSION,
    id: 'e1',
    ts: 1000,
    flow: 'f1',
    op: 'o1',
    node: 'n1',
    type: 'start',
    name: 'x',
    root: true,
    ...overrides,
  };
}

async function ingest(app, events) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: bearer('key-full'),
    payload: { v: ACTIVITY_CONTRACT_VERSION, events },
  });
  assert.ok(res.statusCode === 200 || res.statusCode === 207, `ingest failed: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body);
}

async function createShare(app, body) {
  const res = await app.inject({ method: 'POST', url: '/v1/shares', headers: bearer('key-full'), payload: body });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body);
}

function frameQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(frame);
    else queue.push(frame);
  });
  return {
    next(timeoutMs = 5000) {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a WS frame')), timeoutMs);
        waiters.push({ resolve: (frame) => (clearTimeout(timer), resolve(frame)) });
      });
    },
  };
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitClose(ws) {
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

test('shares live: a live-mode share streams a snapshot then fans out new events, redacted when includeContext is false', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => created.close());

  await ingest(created.app, [oneEvent({ context: { secret: 'shh' } })]);
  const share = await createShare(created.app, { target: { type: 'flow', id: 'f1' }, mode: 'live', includeContext: false });

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/shares/${share.token}/live`);
  const frames = frameQueue(ws);
  t.after(() => ws.close());
  await waitOpen(ws);

  const snapshot = await frames.next();
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.events[0].context._redacted, true);
  assert.equal(JSON.stringify(snapshot).includes('shh'), false);

  await ingest(created.app, [oneEvent({ id: 'e2', ts: 1100, type: 'end', status: 'success' })]);
  const pushed = await frames.next();
  assert.equal(pushed.type, 'events');
  assert.deepEqual(pushed.events.map((e) => e.id), ['e2']);
});

test('shares live: includeContext true streams unredacted context', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => created.close());

  await ingest(created.app, [oneEvent({ context: { secret: 'shh' } })]);
  const share = await createShare(created.app, { target: { type: 'flow', id: 'f1' }, mode: 'live', includeContext: true });

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/shares/${share.token}/live`);
  const frames = frameQueue(ws);
  t.after(() => ws.close());
  await waitOpen(ws);

  const snapshot = await frames.next();
  assert.equal(snapshot.events[0].context.secret, 'shh');
});

test('shares live: a snapshot-mode share closes the socket instead of streaming', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => created.close());

  await ingest(created.app, [oneEvent()]);
  const share = await createShare(created.app, { target: { type: 'flow', id: 'f1' }, mode: 'snapshot' });

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/shares/${share.token}/live`);
  t.after(() => ws.close());
  const { code } = await waitClose(ws);
  assert.equal(code, 4400);
});

test('shares live: an unknown token closes the socket with a not-found code', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => created.close());

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/shares/not-a-real-token/live`);
  t.after(() => ws.close());
  const { code } = await waitClose(ws);
  assert.equal(code, 4404);
});

test('shares live: reconnecting with after=<cursor> replays only newer events', async (t) => {
  const created = await createTestServer({ apiKeys: KEYS });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => created.close());

  const r1 = await ingest(created.app, [oneEvent({ id: 'a' })]);
  await ingest(created.app, [oneEvent({ id: 'b', ts: 1100, type: 'update' })]);
  const share = await createShare(created.app, { target: { type: 'flow', id: 'f1' }, mode: 'live' });

  const ws = new WebSocket(`${address.replace('http', 'ws')}/v1/shares/${share.token}/live?after=${r1.cursor}`);
  const frames = frameQueue(ws);
  t.after(() => ws.close());
  await waitOpen(ws);

  const frame = await frames.next();
  assert.equal(frame.type, 'events');
  assert.deepEqual(frame.events.map((e) => e.id), ['b']);
});
