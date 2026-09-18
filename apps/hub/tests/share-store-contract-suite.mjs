// Shared ShareStore-contract assertions (docs/SHARING.md), run against every
// engine that implements it (`MemoryStore`, `SqliteStore` here;
// `PostgresStore` from `postgres.test.mjs`) -- same "one place, three
// engines" pattern as `store-contract-suite.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withStore } from './helpers.mjs';

export function registerShareStoreContractSuite(name, create) {
  test(`${name} (shares): createShare returns a random token and defaults to an active, preview-less record`, () =>
    withStore(create, async (store) => {
      const a = await store.createShare({
        workspace: 'ws',
        target: { type: 'flow', id: 'f1' },
        mode: 'snapshot',
        snapshotCursor: 5,
        includeContext: false,
        createdBy: 'key-1',
        expiresAt: null,
      });
      const b = await store.createShare({
        workspace: 'ws',
        target: { type: 'flow', id: 'f1' },
        mode: 'snapshot',
        snapshotCursor: 5,
        includeContext: false,
        createdBy: 'key-1',
        expiresAt: null,
      });
      assert.notEqual(a.id, b.id);
      assert.notEqual(a.token, b.token);
      assert.ok(a.token.length >= 40, 'expected a long, unguessable token');
      assert.equal(a.revokedAt, null);
      assert.equal(a.preview, null);
      assert.equal(a.workspace, 'ws');
      assert.equal(a.snapshotCursor, 5);
    }));

  test(`${name} (shares): getShareByToken finds a share by its token only, and getShareById is workspace-scoped`, () =>
    withStore(create, async (store) => {
      const share = await store.createShare({
        workspace: 'ws1',
        target: { type: 'trace', id: 't1' },
        mode: 'live',
        snapshotCursor: undefined,
        includeContext: true,
        createdBy: 'local',
        expiresAt: null,
      });

      const byToken = await store.getShareByToken(share.token);
      assert.equal(byToken.id, share.id);

      assert.equal(await store.getShareByToken('not-a-real-token'), undefined);

      const byId = await store.getShareById('ws1', share.id);
      assert.equal(byId.id, share.id);

      // Workspace-scoped: the same id looked up under a different workspace is not found.
      assert.equal(await store.getShareById('ws2', share.id), undefined);
    }));

  test(`${name} (shares): listShares is newest-first, workspace-scoped, and can filter by createdBy`, () =>
    withStore(create, async (store) => {
      const mk = (createdBy) =>
        store.createShare({
          workspace: 'ws',
          target: { type: 'flow', id: 'f1' },
          mode: 'snapshot',
          snapshotCursor: 1,
          includeContext: false,
          createdBy,
          expiresAt: null,
        });
      const a = await mk('key-a');
      await new Promise((resolve) => setTimeout(resolve, 2));
      const b = await mk('key-b');
      await store.createShare({
        workspace: 'other-ws',
        target: { type: 'flow', id: 'f1' },
        mode: 'snapshot',
        snapshotCursor: 1,
        includeContext: false,
        createdBy: 'key-a',
        expiresAt: null,
      });

      const all = await store.listShares('ws');
      assert.deepEqual(all.map((s) => s.id), [b.id, a.id]); // newest first

      const onlyA = await store.listShares('ws', { createdBy: 'key-a' });
      assert.deepEqual(onlyA.map((s) => s.id), [a.id]);
    }));

  test(`${name} (shares): revokeShare is idempotent and reports false for an unknown or foreign-workspace id`, () =>
    withStore(create, async (store) => {
      const share = await store.createShare({
        workspace: 'ws',
        target: { type: 'flow', id: 'f1' },
        mode: 'snapshot',
        snapshotCursor: 1,
        includeContext: false,
        createdBy: 'key-1',
        expiresAt: null,
      });

      assert.equal(await store.revokeShare('ws', 'no-such-id', Date.now()), false);
      assert.equal(await store.revokeShare('other-ws', share.id, Date.now()), false);

      const firstRevoke = Date.now();
      assert.equal(await store.revokeShare('ws', share.id, firstRevoke), true);
      let reloaded = await store.getShareById('ws', share.id);
      assert.equal(reloaded.revokedAt, firstRevoke);

      // Idempotent: revoking again still reports true, and does not move the timestamp.
      assert.equal(await store.revokeShare('ws', share.id, firstRevoke + 1000), true);
      reloaded = await store.getShareById('ws', share.id);
      assert.equal(reloaded.revokedAt, firstRevoke);
    }));

  test(`${name} (shares): setSharePreview/getSharePreview round-trip PNG bytes and can be cleared`, () =>
    withStore(create, async (store) => {
      const share = await store.createShare({
        workspace: 'ws',
        target: { type: 'flow', id: 'f1' },
        mode: 'snapshot',
        snapshotCursor: 1,
        includeContext: false,
        createdBy: 'key-1',
        expiresAt: null,
      });

      assert.equal(await store.getSharePreview('ws', share.id), undefined);

      const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
      assert.equal(await store.setSharePreview('ws', share.id, { contentType: 'image/png', data: png }), true);

      const stored = await store.getSharePreview('ws', share.id);
      assert.deepEqual([...stored.data], [...png]);
      assert.equal(stored.contentType, 'image/png');

      const withMeta = await store.getShareById('ws', share.id);
      assert.deepEqual(withMeta.preview, { contentType: 'image/png', bytes: png.byteLength });

      assert.equal(await store.setSharePreview('ws', share.id, null), true);
      assert.equal(await store.getSharePreview('ws', share.id), undefined);
      const cleared = await store.getShareById('ws', share.id);
      assert.equal(cleared.preview, null);

      assert.equal(await store.setSharePreview('ws', 'no-such-id', { contentType: 'image/png', data: png }), false);
    }));
}
