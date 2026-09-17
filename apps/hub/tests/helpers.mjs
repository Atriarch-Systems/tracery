// Shared test helpers. Not matched by `tests/*.test.mjs` so node:test never
// tries to run it directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../dist/store/memory.js';
import { SqliteStore } from '../dist/store/sqlite.js';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch/tracery-core/contract';

export function evt(overrides) {
  return {
    v: ACTIVITY_CONTRACT_VERSION,
    id: 'e1',
    ts: 1000,
    flow: 'f1',
    op: 'o1',
    node: 'n1',
    type: 'start',
    name: 'x',
    ...overrides,
  };
}

/** The two store engines under test, each producing a fresh, isolated instance. */
export const storeEngines = [
  {
    name: 'MemoryStore',
    async create() {
      const store = new MemoryStore();
      return { store, cleanup: async () => store.close() };
    },
  },
  {
    name: 'SqliteStore',
    async create() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracery-hub-sqlite-'));
      const file = path.join(dir, 'test.db');
      const store = new SqliteStore(file);
      return {
        store,
        cleanup: async () => {
          await store.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

/** Runs `fn(store)` against a fresh store instance, cleaning up afterwards even on failure. */
export async function withStore(create, fn) {
  const { store, cleanup } = await create();
  try {
    await fn(store);
  } finally {
    await cleanup();
  }
}
