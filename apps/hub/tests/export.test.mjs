// GET /v1/flows/:id/export.html and /v1/traces/:id/export.html
// (docs/SHARING.md "HTML export"): auth, 404s, redaction, the
// Content-Disposition filename, and safe embedding of producer data that
// contains a literal `</script>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core/contract';
import { createTestServer, bearer, makeUiDir } from './route-helpers.mjs';

const KEYS = [{ id: 'alice', key: 'key-alice', workspace: 'default', roles: ['ingest', 'read'] }];

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
    headers: bearer('key-alice'),
    payload: { v: ACTIVITY_CONTRACT_VERSION, events },
  });
  assert.ok(res.statusCode === 200 || res.statusCode === 207, `ingest failed: ${res.statusCode} ${res.body}`);
}

/** `makeUiDir()` gives a minimal index.html but no viewer.html -- add one matching the real template's data-block marker so export.ts's replace can find it. */
function makeUiDirWithViewer() {
  const dir = makeUiDir();
  fs.writeFileSync(
    path.join(dir, 'viewer.html'),
    '<!doctype html><html><head><title>Tracery viewer</title></head><body><div id="root"></div>' +
      '<script id="tracery-data" type="application/json">{"meta":null,"events":[]}</script>' +
      '<script type="module">/* inlined app */</script></body></html>',
  );
  return dir;
}

function extractDataBlock(html) {
  const match = /<script id="tracery-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, 'expected a tracery-data script block in the export');
  return JSON.parse(match[1]);
}

test('export: requires a read-role key', async () => {
  const created = await createTestServer({ apiKeys: KEYS, uiDir: makeUiDirWithViewer() });
  try {
    const res = await created.app.inject({ method: 'GET', url: '/v1/flows/f1/export.html' });
    assert.equal(res.statusCode, 401);
  } finally {
    await created.close();
  }
});

test('export: 404s for an unknown flow/trace', async () => {
  const created = await createTestServer({ apiKeys: KEYS, uiDir: makeUiDirWithViewer() });
  try {
    const flowRes = await created.app.inject({ method: 'GET', url: '/v1/flows/no-such/export.html', headers: bearer('key-alice') });
    assert.equal(flowRes.statusCode, 404);
    assert.equal(JSON.parse(flowRes.body).error.code, 'not_found');

    const traceRes = await created.app.inject({ method: 'GET', url: '/v1/traces/no-such/export.html', headers: bearer('key-alice') });
    assert.equal(traceRes.statusCode, 404);
  } finally {
    await created.close();
  }
});

test('export: 404s with a clear message when the viewer template has not been built', async () => {
  // makeUiDir() (no viewer.html) -- the ordinary "not built" case.
  const created = await createTestServer({ apiKeys: KEYS, uiDir: makeUiDir() });
  try {
    await ingest(created.app, [oneEvent({ label: 'Alpha run' })]);
    const res = await created.app.inject({ method: 'GET', url: '/v1/flows/f1/export.html', headers: bearer('key-alice') });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error.code, 'viewer_not_built');
  } finally {
    await created.close();
  }
});

test('export: a flow export embeds its events, a Content-Disposition attachment filename, and defaults to including context', async () => {
  const created = await createTestServer({ apiKeys: KEYS, uiDir: makeUiDirWithViewer() });
  try {
    await ingest(created.app, [oneEvent({ label: 'Alpha run', context: { secret: 'shh' } })]);
    const res = await created.app.inject({ method: 'GET', url: '/v1/flows/f1/export.html', headers: bearer('key-alice') });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.headers['content-disposition'], /^attachment; filename="tracery-Alpha-run-f1\.html"$/);

    const data = extractDataBlock(res.body);
    assert.deepEqual(data.meta.target, { type: 'flow', id: 'f1' });
    assert.equal(data.meta.includeContext, true);
    assert.equal(data.meta.label, 'Alpha run');
    assert.deepEqual(data.events.map((e) => e.id), ['e1']);
    assert.equal(data.events[0].context.secret, 'shh');
  } finally {
    await created.close();
  }
});

test('export: ?context=false redacts every embedded event\'s context', async () => {
  const created = await createTestServer({ apiKeys: KEYS, uiDir: makeUiDirWithViewer() });
  try {
    await ingest(created.app, [oneEvent({ label: 'Alpha run', context: { secret: 'shh' } })]);
    const res = await created.app.inject({ method: 'GET', url: '/v1/flows/f1/export.html?context=false', headers: bearer('key-alice') });
    assert.equal(res.statusCode, 200);
    const data = extractDataBlock(res.body);
    assert.equal(data.meta.includeContext, false);
    assert.equal(data.events[0].context._redacted, true);
    assert.equal(res.body.includes('shh'), false);
  } finally {
    await created.close();
  }
});

test('export: a trace export embeds every member flow\'s events', async () => {
  const created = await createTestServer({ apiKeys: KEYS, uiDir: makeUiDirWithViewer() });
  try {
    await ingest(created.app, [oneEvent({ id: 'p1', flow: 'parent', op: 'po', label: 'Parent run' })]);
    await ingest(created.app, [oneEvent({ id: 'c1', flow: 'child', op: 'co', link: { parentFlow: 'parent' } })]);

    const res = await created.app.inject({ method: 'GET', url: '/v1/traces/parent/export.html', headers: bearer('key-alice') });
    assert.equal(res.statusCode, 200);
    const data = extractDataBlock(res.body);
    assert.deepEqual(data.meta.target, { type: 'trace', id: 'parent' });
    assert.equal(data.meta.label, 'Parent run');
    assert.deepEqual(data.events.map((e) => e.id).sort(), ['c1', 'p1']);
  } finally {
    await created.close();
  }
});

test('export: a literal "</script>" inside event context cannot break out of the embedded data block', async () => {
  const created = await createTestServer({ apiKeys: KEYS, uiDir: makeUiDirWithViewer() });
  try {
    await ingest(created.app, [oneEvent({ label: 'Alpha run', context: { payload: '</script><script>alert(1)</script>' } })]);
    const res = await created.app.inject({ method: 'GET', url: '/v1/flows/f1/export.html', headers: bearer('key-alice') });
    assert.equal(res.statusCode, 200);

    // Exactly one data-block script tag survives, and it still parses as JSON.
    const openings = (res.body.match(/<script id="tracery-data"/g) ?? []).length;
    assert.equal(openings, 1);
    const data = extractDataBlock(res.body);
    assert.equal(data.events[0].context.payload, '</script><script>alert(1)</script>');
    // No raw, unescaped "</script>" sneaks into the document -- every
    // occurrence of the producer's literal string was backslash-escaped.
    assert.equal(res.body.includes('</script><script>alert'), false);
  } finally {
    await created.close();
  }
});
