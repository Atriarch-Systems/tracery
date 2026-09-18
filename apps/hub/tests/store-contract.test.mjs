// Store contract suite: the shared assertions in `./store-contract-suite.mjs`
// run against BOTH `MemoryStore` and `SqliteStore` here so the two
// implementations stay behaviourally identical (SPEC.md §6 "Storage");
// `PostgresStore` gets the same suite from `postgres.test.mjs` (it needs a
// docker-availability guard the other two don't). SqliteStore-only
// persistence/rebuild tests unrelated to the shared contract live below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storeEngines } from './helpers.mjs';
import { registerStoreContractSuite, startEvt, endEvt } from './store-contract-suite.mjs';
import { registerShareStoreContractSuite } from './share-store-contract-suite.mjs';
import { SqliteStore } from '../dist/store/sqlite.js';

for (const { name, create } of storeEngines) {
  registerStoreContractSuite(name, create);
  registerShareStoreContractSuite(name, create);
}

// hub-6: SqliteStore-only -- the eviction floor must survive a restart (a
// fresh `SqliteStore` opened on the same file), since that's exactly when
// clients reconnect with a cursor the store may no longer hold that far back.
test('SqliteStore: the eviction floor (floorCursor) survives a restart, so a pre-sweep cursor still gets a truncated snapshot after reopening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hub-sqlite-restart-'));
  const file = path.join(dir, 'test.db');
  try {
    const now = 10_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    let store = new SqliteStore(file);
    const r1 = await store.append('ws', [startEvt({ id: 'old-1', flow: 'old', op: 'o', ts: now - 10 * dayMs })]);
    await store.append('ws', [endEvt({ id: 'old-2', flow: 'old', op: 'o', ts: now - 10 * dayMs + 5 })]);
    await store.append('ws', [startEvt({ id: 'new-1', flow: 'new', op: 'o', ts: now - 10 })]);
    await store.sweep(now, { retentionMs: dayMs, maxEventsPerWorkspace: 1_000_000 });

    const before = await store.workspaceFrame('ws', r1.cursor);
    assert.equal(before.truncated, true);
    await store.close();

    // Reopen: a fresh instance on the same file, simulating a hub restart.
    store = new SqliteStore(file);
    try {
      const after = await store.workspaceFrame('ws', r1.cursor);
      assert.equal(after.truncated, true, 'floorCursor must survive a restart, or a reconnecting client silently misses evicted events');
      assert.deepEqual(after.events.map((e) => e.id), ['new-1']);
    } finally {
      await store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// hub-22: boot rebuilds the in-memory flow/trace index in O(flows) (one
// materialised `flows` row per flow) instead of O(events) (re-deriving every
// flow from its whole event history via `buildFlows`). These tests are
// SqliteStore-only: `MemoryStore` has nothing to persist a materialised index
// to, so it must always rebuild from its (in-memory) event log.

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hub-sqlite-hub22-'));
  const file = path.join(dir, 'test.db');
  return (async () => {
    try {
      return await fn(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test('SqliteStore: reopening from disk lists flows without scanning events -- listFlows/flowSummary still work after the events table is wiped out from under it', () =>
  withTempDb(async (file) => {
    let store = new SqliteStore(file);
    await store.append('ws', [startEvt({ id: 'a1', flow: 'flow-a', op: 'oa', ts: 1000, label: 'Alpha run' })]);
    await store.append('ws', [endEvt({ id: 'a2', flow: 'flow-a', op: 'oa', ts: 1010 })]);
    await store.append('ws', [startEvt({ id: 'b1', flow: 'flow-b', op: 'ob', ts: 1020, label: 'Beta run' })]);
    await store.append('ws', [endEvt({ id: 'b2', flow: 'flow-b', op: 'ob', ts: 1030, status: 'error' })]);
    await store.close();

    // Simulate a store whose flow index is materialised but whose event log is
    // gone (evicted, corrupted, whatever) -- if `load()` still needed to scan
    // `events` to reconstruct `flows`, this reopen would come back with nothing.
    const raw = new DatabaseSync(file);
    raw.exec('DELETE FROM events;');
    raw.close();

    store = new SqliteStore(file);
    try {
      const listed = await store.listFlows('ws', {});
      assert.deepEqual(
        listed.flows.map((f) => f.id).sort(),
        ['flow-a', 'flow-b'],
        'listFlows must be able to answer from the materialised flows table alone',
      );

      const a = await store.flowSummary('ws', 'flow-a');
      assert.equal(a.label, 'Alpha run');
      assert.equal(a.status, 'complete');
      const b = await store.flowSummary('ws', 'flow-b');
      assert.equal(b.status, 'error');

      // The event log really is gone -- confirms this wasn't secretly served from events.
      const events = await store.flowEvents('ws', 'flow-a');
      assert.equal(events.events.length, 0);
    } finally {
      await store.close();
    }
  }));

test('SqliteStore: a missing flows table (a database from before hub-22) is rebuilt from events on open', () =>
  withTempDb(async (file) => {
    // Hand-build a pre-hub-22 database: only `events` + `workspace_meta`, no
    // `flows`/`schema_meta` tables at all -- exactly what an older SqliteStore left behind.
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE events (
        cursor INTEGER PRIMARY KEY, workspace TEXT NOT NULL, id TEXT NOT NULL, flow TEXT NOT NULL, json TEXT NOT NULL,
        UNIQUE(workspace, id)
      );
    `);
    raw.exec('CREATE INDEX idx_events_workspace_flow ON events(workspace, flow);');
    raw.exec('CREATE TABLE workspace_meta (workspace TEXT PRIMARY KEY, floor_cursor INTEGER);');
    const insert = raw.prepare('INSERT INTO events (cursor, workspace, id, flow, json) VALUES (?, ?, ?, ?, ?)');
    const rows = [startEvt({ id: 'p1', flow: 'old-flow', op: 'op', ts: 1000, label: 'Old run' }), endEvt({ id: 'p2', flow: 'old-flow', op: 'op', ts: 1010 })];
    rows.forEach((event, i) => {
      const stored = { ...event, workspace: 'ws', cursor: i + 1, receivedAt: Date.now() };
      insert.run(stored.cursor, 'ws', stored.id, stored.flow, JSON.stringify(stored));
    });
    raw.close();

    const store = new SqliteStore(file);
    try {
      const listed = await store.listFlows('ws', {});
      assert.deepEqual(listed.flows.map((f) => f.id), ['old-flow']);
      const summary = await store.flowSummary('ws', 'old-flow');
      assert.equal(summary.label, 'Old run');
      assert.equal(summary.status, 'complete');
    } finally {
      await store.close();
    }

    // And the rebuild is durable: a schema_meta row now marks the table current.
    const check = new DatabaseSync(file);
    try {
      const row = check.prepare("SELECT value FROM schema_meta WHERE key = 'flows_schema_version'").get();
      assert.notEqual(row, undefined, 'load() must write a schema-version row once the flows table is rebuilt');
    } finally {
      check.close();
    }
  }));

test('SqliteStore: a flows-table schema-version mismatch is rebuilt from events on open', () =>
  withTempDb(async (file) => {
    let store = new SqliteStore(file);
    await store.append('ws', [startEvt({ id: 'a1', flow: 'flow-a', op: 'oa', ts: 1000, label: 'Alpha run' })]);
    await store.append('ws', [endEvt({ id: 'a2', flow: 'flow-a', op: 'oa', ts: 1010 })]);
    await store.close();

    // Downgrade the recorded schema version and blow away the materialised
    // rows -- if the version check didn't trigger a rebuild, the reopened
    // store would list nothing at all.
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE schema_meta SET value = '0' WHERE key = 'flows_schema_version';");
    raw.exec('DELETE FROM flows;');
    raw.close();

    store = new SqliteStore(file);
    try {
      const listed = await store.listFlows('ws', {});
      assert.deepEqual(listed.flows.map((f) => f.id), ['flow-a']);
      const summary = await store.flowSummary('ws', 'flow-a');
      assert.equal(summary.label, 'Alpha run');
    } finally {
      await store.close();
    }

    const check = new DatabaseSync(file);
    try {
      const row = check.prepare("SELECT value FROM schema_meta WHERE key = 'flows_schema_version'").get();
      assert.notEqual(row.value, '0', 'the stale schema version must have been overwritten by the rebuild');
    } finally {
      check.close();
    }
  }));

test('SqliteStore: a late-arriving parent\'s trace correction survives a restart, not just the in-process append that made it', () =>
  withTempDb(async (file) => {
    let store = new SqliteStore(file);
    // Grandchild links to "parent1", not yet observed.
    await store.append('ws', [startEvt({ id: 'c1', flow: 'child', op: 'co', ts: 1000, link: { parentFlow: 'parent1' } })]);
    // parent1 arrives, itself linking to "grandparent1" (also not yet observed) --
    // this corrects child's trace to "grandparent1" before the store ever restarts.
    await store.append('ws', [startEvt({ id: 'p1', flow: 'parent1', op: 'po', ts: 990, link: { parentFlow: 'grandparent1' } })]);

    let child = await store.flowSummary('ws', 'child');
    assert.equal(child.trace, 'grandparent1');
    await store.close();

    // Reopen: the corrected trace must have been persisted, not just held in memory.
    store = new SqliteStore(file);
    try {
      child = await store.flowSummary('ws', 'child');
      assert.equal(child.trace, 'grandparent1', 'the late-parent trace correction must survive a restart');

      // grandparent1 finally arrives; everything should still resolve together.
      await store.append('ws', [startEvt({ id: 'g1', flow: 'grandparent1', op: 'go', ts: 980 })]);
      const grandparent = await store.flowSummary('ws', 'grandparent1');
      const parent1 = await store.flowSummary('ws', 'parent1');
      child = await store.flowSummary('ws', 'child');
      assert.equal(grandparent.trace, 'grandparent1');
      assert.equal(parent1.trace, 'grandparent1');
      assert.equal(child.trace, 'grandparent1');

      const trace = await store.getTrace('ws', 'grandparent1');
      assert.deepEqual(trace.flows.map((f) => f.id).sort(), ['child', 'grandparent1', 'parent1']);
    } finally {
      await store.close();
    }
  }));
