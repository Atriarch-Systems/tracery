// Store-contract suite run against `PostgresStore` (SPEC.md §6 "Storage":
// "Postgres is a documented follow-up behind the same interface"), using a
// throwaway `postgres:16-alpine` container started with `docker run`. Skips
// cleanly (via `test.skip`) instead of failing the run when docker isn't
// available in this environment.
//
// One Postgres server backs the whole file; each test gets its own schema
// (`PostgresStore.connect(url, { schema })`) so the shared store-contract
// suite's "fresh, empty store per test" assumption holds without paying for
// a fresh container per test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import { registerStoreContractSuite, startEvt, endEvt } from './store-contract-suite.mjs';
import { PostgresStore } from '../dist/store/postgres.js';

function dockerAvailable() {
  try {
    const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForReady(url, deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const probe = await PostgresStore.connect(url, { schema: `probe_${randomBytes(4).toString('hex')}` });
      await probe.close();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`postgres did not become ready in time: ${lastErr}`);
}

async function dropSchema(url, schema) {
  const { Client } = pg;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

// `PostgresStore.connect` validates `schema` against a plain-identifier
// charset (no hyphens) since it's interpolated into SQL text -- sanitise
// whatever tag is passed (a counter, or a hyphenated `Date.now()`-based
// label) down to that charset. Leading `t_` guarantees the result never
// starts with a digit, which Postgres identifiers disallow unquoted (and
// `assertIdent` disallows outright).
function nextSchemaName(tag) {
  return `t_${process.pid}_${String(tag).replace(/[^a-zA-Z0-9]/g, '_')}_${randomBytes(3).toString('hex')}`;
}

if (!dockerAvailable()) {
  test('PostgresStore store-contract suite', { skip: 'docker is not available in this environment' }, () => {});
} else {
  const containerName = `tracery-pg-test-${randomBytes(4).toString('hex')}`;
  let url;
  let containerStarted = false;
  let schemaCounter = 0;

  test.before(async () => {
    const port = await findFreePort();
    url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
    const run = spawnSync(
      'docker',
      ['run', '-d', '--rm', '--name', containerName, '-e', 'POSTGRES_PASSWORD=test', '-p', `${port}:5432`, 'postgres:16-alpine'],
      { stdio: 'inherit' },
    );
    if (run.status !== 0) {
      throw new Error(`docker run failed for ${containerName} (exit ${run.status}); is the postgres:16-alpine image reachable?`);
    }
    containerStarted = true;
    await waitForReady(url, Date.now() + 60_000);
  });

  test.after(() => {
    if (containerStarted) spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  });

  registerStoreContractSuite('PostgresStore', async () => {
    schemaCounter += 1;
    const schema = nextSchemaName(schemaCounter);
    const store = await PostgresStore.connect(url, { schema });
    return {
      store,
      cleanup: async () => {
        await store.close();
        await dropSchema(url, schema);
      },
    };
  });

  // Postgres-specific coverage mirroring SqliteStore's own persistence/rebuild tests.

  test('PostgresStore: a late-arriving parent\'s trace correction survives a restart, not just the in-process append that made it', async () => {
    const schema = nextSchemaName(`restart-${Date.now()}`);
    let store = await PostgresStore.connect(url, { schema });
    try {
      // Grandchild links to "parent1", not yet observed.
      await store.append('ws', [startEvt({ id: 'c1', flow: 'child', op: 'co', ts: 1000, link: { parentFlow: 'parent1' } })]);
      // parent1 arrives, itself linking to "grandparent1" (also not yet observed) --
      // this corrects child's trace to "grandparent1" before the store ever restarts.
      await store.append('ws', [startEvt({ id: 'p1', flow: 'parent1', op: 'po', ts: 990, link: { parentFlow: 'grandparent1' } })]);

      let child = await store.flowSummary('ws', 'child');
      assert.equal(child.trace, 'grandparent1');
      await store.close();

      // Reopen against the same schema: the corrected trace must have been persisted, not just held in memory.
      store = await PostgresStore.connect(url, { schema });
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
      await dropSchema(url, schema);
    }
  });

  test('PostgresStore: a missing flows table (a schema from before the materialised index existed) is rebuilt from events on open', async () => {
    const schema = nextSchemaName(`rebuild-${Date.now()}`);
    try {
      // Hand-build a pre-materialised-index schema: only `events` + `workspace_meta`, no `flows`/`schema_version` at all.
      const { Client } = pg;
      const raw = new Client({ connectionString: url });
      await raw.connect();
      try {
        await raw.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        await raw.query(`
          CREATE TABLE "${schema}".events (
            cursor BIGINT PRIMARY KEY, workspace TEXT NOT NULL, id TEXT NOT NULL, flow TEXT NOT NULL, json JSONB NOT NULL,
            UNIQUE (workspace, id)
          )
        `);
        await raw.query(`CREATE TABLE "${schema}".workspace_meta (workspace TEXT PRIMARY KEY, floor_cursor BIGINT)`);
        const rows = [
          startEvt({ id: 'p1', flow: 'old-flow', op: 'op', ts: 1000, label: 'Old run' }),
          endEvt({ id: 'p2', flow: 'old-flow', op: 'op', ts: 1010 }),
        ];
        let cursor = 0;
        for (const event of rows) {
          cursor += 1;
          const stored = { ...event, workspace: 'ws', cursor, receivedAt: Date.now() };
          await raw.query(`INSERT INTO "${schema}".events (cursor, workspace, id, flow, json) VALUES ($1, $2, $3, $4, $5)`, [
            stored.cursor,
            'ws',
            stored.id,
            stored.flow,
            JSON.stringify(stored),
          ]);
        }
      } finally {
        await raw.end();
      }

      const store = await PostgresStore.connect(url, { schema });
      try {
        const listed = await store.listFlows('ws', {});
        assert.deepEqual(listed.flows.map((f) => f.id), ['old-flow']);
        const summary = await store.flowSummary('ws', 'old-flow');
        assert.equal(summary.label, 'Old run');
        assert.equal(summary.status, 'complete');
      } finally {
        await store.close();
      }

      // And the rebuild is durable: a schema_version row now marks the table current.
      const check = new Client({ connectionString: url });
      await check.connect();
      try {
        const { rows } = await check.query(`SELECT value FROM "${schema}".schema_version WHERE key = 'flows_schema_version'`);
        assert.equal(rows.length, 1, 'load() must write a schema-version row once the flows table is rebuilt');
      } finally {
        await check.end();
      }
    } finally {
      await dropSchema(url, schema);
    }
  });
}
