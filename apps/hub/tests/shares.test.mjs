// Share links (docs/SHARING.md): auth matrix, snapshot cap, redaction,
// expiry/revoke, preview upload limits, rate limiting, and OG injection on
// the share page. WS live reuse is covered separately in shares-live.test.mjs
// (needs a real listening socket, like tests/live.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core/contract';
import { createTestServer, bearer, makeUiDir } from './route-helpers.mjs';

const KEYS = [
  { id: 'alice', key: 'key-alice', workspace: 'default', roles: ['ingest', 'read'] },
  { id: 'bob', key: 'key-bob', workspace: 'default', roles: ['ingest', 'read'] },
  { id: 'admin', key: 'key-admin', workspace: 'default', roles: ['ingest', 'read', 'admin'] },
];

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

async function ingest(app, key, events) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/events',
    headers: bearer(key),
    payload: { v: ACTIVITY_CONTRACT_VERSION, events },
  });
  assert.ok(res.statusCode === 200 || res.statusCode === 207, `ingest failed: ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body);
}

async function createFlow(app, key = 'key-alice', label = 'Alpha run') {
  await ingest(app, key, [oneEvent({ id: 'e1', label, context: { secret: 'shh' } })]);
  return 'f1';
}

async function createShare(app, key, body) {
  const res = await app.inject({ method: 'POST', url: '/v1/shares', headers: bearer(key), payload: body });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

// A tiny, valid 1x1 PNG (the smallest possible signature + IHDR/IDAT/IEND).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

// ---------------------------------------------------------------------------
// Authenticated routes: auth matrix, validation, ownership
// ---------------------------------------------------------------------------

test('shares: creating a share requires a read-role key', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    const noKey = await created.app.inject({ method: 'POST', url: '/v1/shares', payload: { target: { type: 'flow', id: 'f1' } } });
    assert.equal(noKey.statusCode, 401);
  } finally {
    await created.close();
  }
});

test('shares: POST validates target shape, mode, includeContext and expiresInDays', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);

    const badTarget = await createShare(created.app, 'key-alice', { target: { type: 'nope', id: 'f1' } });
    assert.equal(badTarget.status, 400);

    const badMode = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, mode: 'eventually' });
    assert.equal(badMode.status, 400);

    const badContext = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, includeContext: 'yes' });
    assert.equal(badContext.status, 400);

    const badExpiry = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, expiresInDays: -1 });
    assert.equal(badExpiry.status, 400);

    const unknownFlow = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'no-such-flow' } });
    assert.equal(unknownFlow.status, 404);
  } finally {
    await created.close();
  }
});

test('shares: POST defaults to a 30-day snapshot share and returns id/token/url built from the request origin', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const res = await created.app.inject({
      method: 'POST',
      url: '/v1/shares',
      headers: { ...bearer('key-alice'), host: 'hub.example.test' },
      payload: { target: { type: 'flow', id: 'f1' } },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.ok(body.id);
    assert.ok(body.token.length >= 40);
    assert.equal(body.url, `http://hub.example.test/s/${body.token}`);
  } finally {
    await created.close();
  }
});

test('shares: TRACERY_PUBLIC_URL overrides the request origin in the returned url', async () => {
  const created = await createTestServer({ apiKeys: KEYS, publicUrl: 'https://tracery.example' });
  try {
    await createFlow(created.app);
    const { body } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });
    assert.equal(body.url, `https://tracery.example/s/${body.token}`);
  } finally {
    await created.close();
  }
});

test('shares: expiresInDays "never" creates a share with expiresAt null', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, expiresInDays: 'never' });
    const list = await created.app.inject({ method: 'GET', url: '/v1/shares', headers: bearer('key-alice') });
    const share = JSON.parse(list.body).shares.find((s) => s.id === body.id);
    assert.equal(share.expiresAt, null);
  } finally {
    await created.close();
  }
});

test('shares: GET /v1/shares omits tokens and only lists the caller\'s own shares unless admin', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const aliceShare = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });
    const bobShare = await createShare(created.app, 'key-bob', { target: { type: 'flow', id: 'f1' } });

    const aliceList = await created.app.inject({ method: 'GET', url: '/v1/shares', headers: bearer('key-alice') });
    const aliceShares = JSON.parse(aliceList.body).shares;
    assert.deepEqual(
      aliceShares.map((s) => s.id),
      [aliceShare.body.id],
    );
    assert.equal(aliceShares[0].token, undefined);

    const adminList = await created.app.inject({ method: 'GET', url: '/v1/shares', headers: bearer('key-admin') });
    const adminShares = JSON.parse(adminList.body).shares;
    assert.deepEqual(
      adminShares.map((s) => s.id).sort(),
      [aliceShare.body.id, bobShare.body.id].sort(),
    );
  } finally {
    await created.close();
  }
});

test('shares: DELETE (revoke) is creator-or-admin only, 404s an unknown id, and is idempotent', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });

    const notFound = await created.app.inject({ method: 'DELETE', url: '/v1/shares/no-such-id', headers: bearer('key-alice') });
    assert.equal(notFound.statusCode, 404);

    const forbidden = await created.app.inject({ method: 'DELETE', url: `/v1/shares/${share.id}`, headers: bearer('key-bob') });
    assert.equal(forbidden.statusCode, 403);

    const ok = await created.app.inject({ method: 'DELETE', url: `/v1/shares/${share.id}`, headers: bearer('key-alice') });
    assert.equal(ok.statusCode, 204);

    // Idempotent: revoking again still succeeds.
    const again = await created.app.inject({ method: 'DELETE', url: `/v1/shares/${share.id}`, headers: bearer('key-alice') });
    assert.equal(again.statusCode, 204);

    // Public reads now 404.
    const publicRead = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/meta` });
    assert.equal(publicRead.statusCode, 404);
  } finally {
    await created.close();
  }
});

test('shares: an admin may revoke a share it did not create', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });
    const res = await created.app.inject({ method: 'DELETE', url: `/v1/shares/${share.id}`, headers: bearer('key-admin') });
    assert.equal(res.statusCode, 204);
  } finally {
    await created.close();
  }
});

test('shares: PUT preview accepts a valid PNG, rejects a non-PNG body, an oversized body, and a non-owner', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });

    const notPng = await created.app.inject({
      method: 'PUT',
      url: `/v1/shares/${share.id}/preview`,
      headers: { ...bearer('key-alice'), 'content-type': 'image/png' },
      payload: Buffer.from('not a png'),
    });
    assert.equal(notPng.statusCode, 400);

    const forbidden = await created.app.inject({
      method: 'PUT',
      url: `/v1/shares/${share.id}/preview`,
      headers: { ...bearer('key-bob'), 'content-type': 'image/png' },
      payload: TINY_PNG,
    });
    assert.equal(forbidden.statusCode, 403);

    const oversized = await created.app.inject({
      method: 'PUT',
      url: `/v1/shares/${share.id}/preview`,
      headers: { ...bearer('key-alice'), 'content-type': 'image/png' },
      payload: Buffer.concat([TINY_PNG, Buffer.alloc(3 * 1024 * 1024)]),
    });
    assert.equal(oversized.statusCode, 413);

    const ok = await created.app.inject({
      method: 'PUT',
      url: `/v1/shares/${share.id}/preview`,
      headers: { ...bearer('key-alice'), 'content-type': 'image/png' },
      payload: TINY_PNG,
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(JSON.parse(ok.body).preview, { contentType: 'image/png', bytes: TINY_PNG.byteLength });

    const preview = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/preview.png` });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.headers['content-type'], 'image/png');
    assert.equal(preview.rawPayload.length, TINY_PNG.byteLength);
  } finally {
    await created.close();
  }
});

// ---------------------------------------------------------------------------
// Public routes: identical 404s, snapshot cap, redaction, expiry
// ---------------------------------------------------------------------------

test('shares: unknown, expired and revoked tokens all 404 identically', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);

    const unknown = await created.app.inject({ method: 'GET', url: '/v1/shares/not-a-real-token/meta' });
    assert.equal(unknown.statusCode, 404);
    const unknownBody = JSON.parse(unknown.body);

    const { body: expiring } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, expiresInDays: 0.0000001 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = await created.app.inject({ method: 'GET', url: `/v1/shares/${expiring.token}/meta` });
    assert.equal(expired.statusCode, 404);
    assert.deepEqual(JSON.parse(expired.body), unknownBody);

    const { body: revoking } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });
    await created.app.inject({ method: 'DELETE', url: `/v1/shares/${revoking.id}`, headers: bearer('key-alice') });
    const revoked = await created.app.inject({ method: 'GET', url: `/v1/shares/${revoking.token}/meta` });
    assert.equal(revoked.statusCode, 404);
    assert.deepEqual(JSON.parse(revoked.body), unknownBody);
  } finally {
    await created.close();
  }
});

test('shares: GET .../meta reports target, mode, includeContext and a label', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app, 'key-alice', 'Alpha run');
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });
    const res = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/meta` });
    assert.equal(res.statusCode, 200);
    const meta = JSON.parse(res.body);
    assert.deepEqual(meta.target, { type: 'flow', id: 'f1' });
    assert.equal(meta.mode, 'snapshot');
    assert.equal(meta.includeContext, false);
    assert.equal(meta.label, 'Alpha run');
  } finally {
    await created.close();
  }
});

test('shares: a snapshot share never reflects events ingested after it was created', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app); // f1 started
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });

    // Ingest more events for f1 AFTER the share's snapshot cursor.
    await ingest(created.app, 'key-alice', [{ v: ACTIVITY_CONTRACT_VERSION, id: 'e2', ts: 2000, flow: 'f1', op: 'o2', node: 'n2', type: 'start', name: 'later' }]);

    const flowRes = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/flow` });
    const summary = JSON.parse(flowRes.body);
    assert.ok(!('o2' in summary.ops), 'a snapshot share must not see events ingested after its snapshot cursor');

    const eventsRes = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/events` });
    const frame = JSON.parse(eventsRes.body);
    assert.deepEqual(frame.events.map((e) => e.id).sort(), ['e1']);
  } finally {
    await created.close();
  }
});

test('shares: a live share always reflects the current state, uncapped', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, mode: 'live' });

    await ingest(created.app, 'key-alice', [{ v: ACTIVITY_CONTRACT_VERSION, id: 'e2', ts: 2000, flow: 'f1', op: 'o2', node: 'n2', type: 'start', name: 'later' }]);

    const flowRes = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/flow` });
    const summary = JSON.parse(flowRes.body);
    assert.ok('o2' in summary.ops, 'a live share must reflect events ingested after creation');
  } finally {
    await created.close();
  }
});

test('shares: includeContext false redacts context in /flow, /trace and /events; true leaves it intact', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app); // context: { secret: 'shh' }
    const { body: hidden } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, includeContext: false });
    const { body: shown } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' }, includeContext: true });

    const hiddenFlow = JSON.parse((await created.app.inject({ method: 'GET', url: `/v1/shares/${hidden.token}/flow` })).body);
    const hiddenOp = Object.values(hiddenFlow.ops)[0];
    assert.equal(hiddenOp.context._redacted, true);
    assert.deepEqual(hiddenOp.context.keys, ['secret']);
    assert.equal(JSON.stringify(hiddenFlow).includes('shh'), false);

    const hiddenEvents = JSON.parse((await created.app.inject({ method: 'GET', url: `/v1/shares/${hidden.token}/events` })).body);
    assert.equal(hiddenEvents.events[0].context._redacted, true);

    const shownFlow = JSON.parse((await created.app.inject({ method: 'GET', url: `/v1/shares/${shown.token}/flow` })).body);
    const shownOp = Object.values(shownFlow.ops)[0];
    assert.equal(shownOp.context.secret, 'shh');

    // Trace target too.
    const { body: traceShare } = await createShare(created.app, 'key-alice', { target: { type: 'trace', id: 'f1' } });
    const trace = JSON.parse((await created.app.inject({ method: 'GET', url: `/v1/shares/${traceShare.token}/trace` })).body);
    const traceOp = Object.values(trace.flows[0].ops)[0];
    assert.equal(traceOp.context._redacted, true);
  } finally {
    await created.close();
  }
});

test('shares: /flow 404s for a trace-target share and /trace 404s for a flow-target share', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body: flowShare } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });
    const { body: traceShare } = await createShare(created.app, 'key-alice', { target: { type: 'trace', id: 'f1' } });

    const wrongTrace = await created.app.inject({ method: 'GET', url: `/v1/shares/${flowShare.token}/trace` });
    assert.equal(wrongTrace.statusCode, 404);

    const wrongFlow = await created.app.inject({ method: 'GET', url: `/v1/shares/${traceShare.token}/flow` });
    assert.equal(wrongFlow.statusCode, 404);
  } finally {
    await created.close();
  }
});

test('shares: preview.png 404s when no preview has been set', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });
    const res = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/preview.png` });
    assert.equal(res.statusCode, 404);
  } finally {
    await created.close();
  }
});

test('shares: local mode allows creating a share, attributed to "local"', async () => {
  const created = await createTestServer({ authMode: 'none', apiKeys: undefined });
  try {
    await created.app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { v: ACTIVITY_CONTRACT_VERSION, events: [oneEvent({ label: 'Local run' })] },
    });
    const res = await created.app.inject({ method: 'POST', url: '/v1/shares', payload: { target: { type: 'flow', id: 'f1' } } });
    assert.equal(res.statusCode, 201);
    const list = await created.app.inject({ method: 'GET', url: '/v1/shares' });
    const shares = JSON.parse(list.body).shares;
    assert.equal(shares[0].createdBy, 'local');
  } finally {
    await created.close();
  }
});

test('shares: the public per-IP rate limit (60/min) 429s beyond its capacity', async () => {
  const created = await createTestServer({ apiKeys: KEYS });
  try {
    await createFlow(created.app);
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });

    let sawRateLimited = false;
    for (let i = 0; i < 65; i++) {
      const res = await created.app.inject({ method: 'GET', url: `/v1/shares/${share.token}/meta` });
      if (res.statusCode === 429) {
        sawRateLimited = true;
        assert.equal(JSON.parse(res.body).error.code, 'rate_limited');
        break;
      }
      assert.equal(res.statusCode, 200);
    }
    assert.ok(sawRateLimited, 'expected the 61st+ request within the window to be rate-limited');
  } finally {
    await created.close();
  }
});

// ---------------------------------------------------------------------------
// Share page: GET /s/:token
// ---------------------------------------------------------------------------

test('share page: injects OG tags for a valid share and 404s (HTML) for an unknown token', async () => {
  const uiDir = makeUiDir();
  const created = await createTestServer({ apiKeys: KEYS, uiDir });
  try {
    await createFlow(created.app, 'key-alice', 'Alpha run');
    const { body: share } = await createShare(created.app, 'key-alice', { target: { type: 'flow', id: 'f1' } });

    const page = await created.app.inject({ method: 'GET', url: `/s/${share.token}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /og:title/);
    assert.match(page.body, /Alpha run/);
    assert.match(page.body, /og:title" content="Tracery Graph: Alpha run"/);
    assert.match(page.body, /twitter:card.*summary_large_image/);
    assert.match(page.body, new RegExp(`og:url" content="[^"]*${share.token}`));

    const missing = await created.app.inject({ method: 'GET', url: '/s/not-a-real-token' });
    assert.equal(missing.statusCode, 404);
    assert.match(missing.headers['content-type'], /text\/html/);
  } finally {
    await created.close();
  }
});
