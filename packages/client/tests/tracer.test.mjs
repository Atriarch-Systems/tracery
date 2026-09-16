import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracer, memoryTransport } from '../dist/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClock(startMonotonic = 0) {
  let m = startMonotonic;
  return { now: () => Date.now(), monotonic: () => (m += 10) };
}

test('batches by interval and chunks by maxBatch, draining the whole queue per flush', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({
    transport,
    flushIntervalMs: 30,
    maxBatch: 3,
    actor: { id: 'agent:test', kind: 'agent' },
  });
  const flow = tracer.startFlow({ label: 'batch test' }); // 1 event: root start
  for (let i = 0; i < 5; i++) {
    const op = flow.start({ node: `tool:${i}`, name: 'tool.call' });
    op.end();
  }
  // 1 root start + 5 * (start + end) = 11 events total.
  await sleep(80);
  const flat = transport.batches.flat();
  assert.equal(flat.length, 11);
  assert.equal(transport.batches.length, Math.ceil(11 / 3));
  for (const batch of transport.batches) assert.ok(batch.length <= 3);
  await tracer.close();
});

test('queue bound drops events past maxQueue and counts them', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000, maxQueue: 5 });
  const flow = tracer.startFlow({}); // 1 event
  for (let i = 0; i < 10; i++) {
    const op = flow.start({ node: `tool:${i}`, name: 'tool.call' });
    op.end();
  } // 20 more attempted events; total attempted = 21
  assert.equal(tracer.dropped, 21 - 5);
  await tracer.flush();
  assert.equal(transport.batches.flat().length, 5);
  await tracer.close();
});

test('durationMs is present on end, computed from the clock, and overridable', async () => {
  const transport = memoryTransport();
  const clock = fakeClock();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000, clock });
  const flow = tracer.startFlow({}); // consumes one monotonic tick for the root op
  const op = flow.start({ node: 'llm:main', name: 'llm.provider' }); // another tick
  op.end(); // another tick; duration = 10
  const op2 = flow.start({ node: 'llm:main', name: 'llm.provider' });
  op2.end({ durationMs: 555 });
  await tracer.close();

  const events = transport.batches.flat();
  const end1 = events.find((e) => e.op === op.id && e.type === 'end');
  const end2 = events.find((e) => e.op === op2.id && e.type === 'end');
  assert.equal(end1.durationMs, 10);
  assert.equal(typeof end1.durationMs, 'number');
  assert.equal(end1.status, 'success');
  assert.equal(end2.durationMs, 555);
});

test('spawnLink returns parentFlow/parentOp/parentNode, and trace only when this flow can resolve its own trace', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000 });

  // No link at all: this flow is its own trace root, so trace is known.
  const rootFlow = tracer.startFlow({});
  const linkFromRoot = rootFlow.spawnLink();
  assert.deepEqual(linkFromRoot, {
    parentFlow: rootFlow.id,
    parentOp: rootFlow.rootOp.id,
    parentNode: rootFlow.rootOp.node,
    trace: rootFlow.id,
  });

  const op = rootFlow.start({ node: 'tool:search', name: 'tool.call' });
  const linkFromOp = rootFlow.spawnLink(op);
  assert.deepEqual(linkFromOp, {
    parentFlow: rootFlow.id,
    parentOp: op.id,
    parentNode: 'tool:search',
    trace: rootFlow.id,
  });

  // Linked but no explicit trace: only the hub can resolve it by walking
  // ancestry, so the client must not guess and must omit the key entirely.
  const childNoTrace = tracer.startFlow({ link: { parentFlow: 'parent-1', parentOp: 'p-op', parentNode: 'p-node' } });
  const grandchildLink = childNoTrace.spawnLink();
  assert.deepEqual(grandchildLink, {
    parentFlow: childNoTrace.id,
    parentOp: childNoTrace.rootOp.id,
    parentNode: childNoTrace.rootOp.node,
  });
  assert.equal('trace' in grandchildLink, false);

  // Linked with an explicit trace: propagate it.
  const childWithTrace = tracer.startFlow({ link: { parentFlow: 'parent-2', trace: 'root-trace-id' } });
  assert.equal(childWithTrace.spawnLink().trace, 'root-trace-id');

  await tracer.close();
});

test('an explicit parent op sets parentOp/parentNode on the child start event; omitting it sets neither', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000 });
  const flow = tracer.startFlow({});
  const parentOp = flow.start({ node: 'agent:main', name: 'agent.step' });
  const childOp = flow.start({ node: 'tool:search', name: 'tool.call', parent: parentOp });
  const unrelatedOp = flow.start({ node: 'tool:other', name: 'tool.call' });
  await tracer.close();

  const events = transport.batches.flat();
  const childStart = events.find((e) => e.op === childOp.id && e.type === 'start');
  assert.equal(childStart.parentOp, parentOp.id);
  assert.equal(childStart.parentNode, 'agent:main');

  const unrelatedStart = events.find((e) => e.op === unrelatedOp.id && e.type === 'start');
  assert.equal('parentOp' in unrelatedStart, false);
  assert.equal('parentNode' in unrelatedStart, false);
});

test('close() flushes remaining events, stops the timer, and further activity is silently dropped', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000 });
  const flow = tracer.startFlow({});
  const op = flow.start({ node: 'n', name: 'x' });
  op.end();

  assert.equal(transport.batches.length, 0, 'nothing flushed before close');
  await tracer.close();
  assert.equal(transport.batches.flat().length, 3); // root start + op start + op end

  // Idempotent.
  await tracer.close();
  assert.equal(transport.batches.flat().length, 3);

  // Post-close activity does not resurrect the tracer.
  const lateOp = flow.start({ node: 'late', name: 'late.call' });
  lateOp.end();
  await tracer.flush();
  assert.equal(transport.batches.flat().length, 3);
});

test('root start event: root=true, actor-derived node/kind, and configurable label', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({
    transport,
    flushIntervalMs: 1_000_000,
    actor: { id: 'agent:saga', kind: 'agent' },
  });
  const flow = tracer.startFlow({ label: 'Triage CVE-2026-1234' });
  await tracer.close();

  const rootStart = transport.batches.flat().find((e) => e.op === flow.rootOp.id && e.type === 'start');
  assert.equal(rootStart.root, true);
  assert.equal(rootStart.node, 'agent:saga');
  assert.equal(rootStart.name, 'flow');
  assert.equal(rootStart.kind, 'agent');
  assert.equal(rootStart.label, 'Triage CVE-2026-1234');
  assert.deepEqual(rootStart.actor, { id: 'agent:saga', kind: 'agent' });
});

test('flow with no configured actor defaults root node to "flow"', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000 });
  const flow = tracer.startFlow({});
  await tracer.close();
  const rootStart = transport.batches.flat().find((e) => e.op === flow.rootOp.id && e.type === 'start');
  assert.equal(rootStart.node, 'flow');
  assert.equal(rootStart.kind, 'agent');
});

test('flow.end() ends the root op once, defaulting status to success', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000 });
  const flow = tracer.startFlow({});
  flow.end();
  flow.end({ status: 'error' }); // ignored: root op already ended
  await tracer.close();

  const ends = transport.batches.flat().filter((e) => e.op === flow.rootOp.id && e.type === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].status, 'success');
  assert.equal(typeof ends[0].durationMs, 'number');
});

test('event ids are unique across a busy tracer (duplicate-safe)', async () => {
  const transport = memoryTransport();
  const tracer = new ActivityTracer({ transport, flushIntervalMs: 1_000_000, maxQueue: 10_000 });
  const flow = tracer.startFlow({});
  for (let i = 0; i < 200; i++) {
    const op = flow.start({ node: `tool:${i}`, name: 'tool.call' });
    op.update({ context: { i } });
    op.annotate({ context: { note: 'x' } });
    op.end();
  }
  await tracer.close();

  const ids = transport.batches.flat().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 1 + 200 * 4);
});
