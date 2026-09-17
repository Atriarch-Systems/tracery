// hub-9: a rejected sweep must not be an unhandled promise rejection -- that
// would crash the whole hub process under Node's default
// --unhandled-rejections=throw over one transient store hiccup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRetention } from '../dist/retention.js';

function fakeMetrics() {
  return { recordSweep: () => {} };
}

test('startRetention: a rejecting store.sweep on the interval is caught and logged, not an unhandled rejection', async () => {
  const rejection = new Error('sqlite: SQLITE_BUSY');
  const store = { sweep: async () => Promise.reject(rejection) };
  const errors = [];
  const logger = { error: (...args) => errors.push(args) };

  let unhandled;
  const onUnhandledRejection = (err) => {
    unhandled = err;
  };
  process.on('unhandledRejection', onUnhandledRejection);

  const handle = startRetention(store, fakeMetrics(), {
    retentionHours: 72,
    maxEventsPerWorkspace: 500_000,
    intervalMs: 5,
    logger,
  });

  try {
    // Let the interval fire at least once; give the microtask/rejection queue
    // a real chance to surface an unhandled rejection if the fix regresses.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(errors.length > 0, 'expected the sweep failure to be logged');
    assert.equal(errors[0][0].err, rejection);
  } finally {
    handle.stop();
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }

  assert.equal(unhandled, undefined, 'a rejecting sweep must not surface as an unhandled promise rejection');
});

test('startRetention: runOnce() (used directly by tests) still rejects for the caller to handle -- only the interval-driven call is caught here', async () => {
  const rejection = new Error('boom');
  const store = { sweep: async () => Promise.reject(rejection) };
  const handle = startRetention(store, fakeMetrics(), { retentionHours: 72, maxEventsPerWorkspace: 500_000, intervalMs: 60_000 });
  try {
    await assert.rejects(() => handle.runOnce(), /boom/);
  } finally {
    handle.stop();
  }
});
