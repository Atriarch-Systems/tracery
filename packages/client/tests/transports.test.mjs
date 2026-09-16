import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpTransport, memoryTransport, journalTransport } from '../dist/index.js';

function startFakeHub(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      respond(req, res, requests.length);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function closeHub(hub) {
  return new Promise((resolve) => hub.server.close(resolve));
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

const sampleEvents = [
  { v: 1, id: 'e1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', root: true },
];

test('httpTransport posts to /v1/events with Authorization + workspace, retries 5xx with backoff, then succeeds', async () => {
  const hub = await startFakeHub((req, res, n) => {
    if (n < 3) return sendJson(res, 503, { error: { code: 'busy', message: 'retry me' } });
    sendJson(res, 200, { accepted: 1, duplicates: 0, rejected: [], cursor: 7 });
  });
  const transport = httpTransport({ baseUrl: hub.baseUrl, apiKey: 'secret-key', workspace: 'default', retries: 5, backoffMs: 5 });

  await transport.send(sampleEvents);

  assert.equal(hub.requests.length, 3);
  for (const req of hub.requests) {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/events');
    assert.equal(req.headers.authorization, 'Bearer secret-key');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.body.v, 1);
    assert.equal(req.body.workspace, 'default');
    assert.deepEqual(req.body.events, sampleEvents);
  }
  await closeHub(hub);
});

test('httpTransport gives up after exhausting retries on persistent 5xx, never throwing', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 500, { error: { code: 'down', message: 'nope' } }));
  const transport = httpTransport({ baseUrl: hub.baseUrl, apiKey: 'k', retries: 2, backoffMs: 5 });

  await assert.doesNotReject(() => transport.send(sampleEvents));
  assert.equal(hub.requests.length, 3); // 1 initial + 2 retries

  await closeHub(hub);
});

test('httpTransport does not retry a 4xx response', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 400, { error: { code: 'bad', message: 'no' } }));
  const transport = httpTransport({ baseUrl: hub.baseUrl, apiKey: 'k', retries: 5, backoffMs: 5 });

  await transport.send(sampleEvents);
  assert.equal(hub.requests.length, 1);

  await closeHub(hub);
});

test('httpTransport retries a network error (not just HTTP 5xx) before reaching the server', async () => {
  const hub = await startFakeHub((req, res) => sendJson(res, 200, { accepted: 1, duplicates: 0, rejected: [], cursor: 1 }));
  const realFetch = globalThis.fetch;
  let calls = 0;
  const flakyFetch = async (url, init) => {
    calls++;
    if (calls <= 2) throw new TypeError('simulated network failure');
    return realFetch(url, init);
  };
  const transport = httpTransport({ baseUrl: hub.baseUrl, apiKey: 'k', fetch: flakyFetch, retries: 5, backoffMs: 5 });

  await transport.send(sampleEvents);
  assert.equal(calls, 3);
  assert.equal(hub.requests.length, 1); // only the 3rd attempt ever reached the server

  await closeHub(hub);
});

test('memoryTransport records every batch verbatim, in order', () => {
  const transport = memoryTransport();
  transport.send(sampleEvents);
  transport.send([]);
  transport.send(sampleEvents);
  assert.equal(transport.batches.length, 3);
  assert.deepEqual(transport.batches[0], sampleEvents);
  assert.deepEqual(transport.batches[1], []);
});

test('journalTransport forwards batches to journal.append', () => {
  const appended = [];
  const journal = { append: (events) => appended.push(events) };
  const transport = journalTransport(journal);
  transport.send(sampleEvents);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], sampleEvents);
});
