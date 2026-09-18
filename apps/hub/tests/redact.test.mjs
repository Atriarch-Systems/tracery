// Redaction (docs/SHARING.md "Redaction rules"): a share with
// `includeContext: false` must never leak a producer's context values, only
// its shape (key names + serialised size).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactContext,
  redactEvent,
  redactFrame,
  redactOp,
  redactFlowSummary,
  redactTraceSummary,
} from '../dist/routes/redact.js';

test('redactContext replaces a context with { _redacted, keys (sorted), bytes } and leaves undefined alone', () => {
  const redacted = redactContext({ secret: 'shh', b: 1, a: 2 });
  assert.equal(redacted._redacted, true);
  assert.deepEqual(redacted.keys, ['a', 'b', 'secret']);
  assert.equal(redacted.bytes, Buffer.byteLength(JSON.stringify({ secret: 'shh', b: 1, a: 2 }), 'utf8'));
  assert.equal(JSON.stringify(redacted).includes('shh'), false, 'no value may survive redaction');

  assert.equal(redactContext(undefined), undefined);
});

test('redactEvent redacts only the context field, leaving everything else (including a missing context) untouched', () => {
  const event = { id: 'e1', ts: 1, flow: 'f', op: 'o', node: 'n', type: 'start', name: 'x', context: { token: 'abc' } };
  const redacted = redactEvent(event);
  assert.equal(redacted.id, 'e1');
  assert.deepEqual(redacted.context.keys, ['token']);
  assert.equal(JSON.stringify(redacted).includes('abc'), false);

  const noContext = { id: 'e2', ts: 1, flow: 'f', op: 'o', node: 'n', type: 'start', name: 'x' };
  assert.deepEqual(redactEvent(noContext), noContext);
});

test('redactFrame redacts every event in a snapshot/events frame and passes a heartbeat through unchanged', () => {
  const frame = { type: 'snapshot', cursor: 3, truncated: false, events: [{ id: 'e1', context: { k: 'v' } }, { id: 'e2' }] };
  const redacted = redactFrame(frame);
  assert.equal(redacted.events[0].context._redacted, true);
  assert.equal(redacted.events[1].context, undefined);

  const heartbeat = { type: 'heartbeat', cursor: 3 };
  assert.equal(redactFrame(heartbeat), heartbeat);
});

test('redactOp redacts the op context and every timeline entry context, leaving entries with no context alone', () => {
  const op = {
    id: 'o1',
    node: 'n1',
    name: 'x',
    status: 'success',
    root: true,
    relation: 'invoke',
    context: { prompt: 'do the thing' },
    timeline: [
      { ts: 1, type: 'start', eventId: 'e1', context: { prompt: 'do the thing' } },
      { ts: 2, type: 'annotate', eventId: 'e2' },
    ],
    tags: [],
  };
  const redacted = redactOp(op);
  assert.deepEqual(redacted.context.keys, ['prompt']);
  assert.deepEqual(redacted.timeline[0].context.keys, ['prompt']);
  assert.equal(redacted.timeline[1].context, undefined);
  assert.equal(JSON.stringify(redacted).includes('do the thing'), false);
});

test('redactFlowSummary redacts every op; redactTraceSummary redacts every flow', () => {
  const flow = {
    id: 'f1',
    label: 'Flow',
    status: 'complete',
    partial: false,
    trace: 'f1',
    ops: {
      o1: { id: 'o1', node: 'n1', name: 'x', status: 'success', root: true, relation: 'invoke', context: { secret: 1 }, timeline: [], tags: [] },
    },
    nodes: {},
    edges: [],
  };
  const redactedFlow = redactFlowSummary(flow);
  assert.deepEqual(redactedFlow.ops.o1.context.keys, ['secret']);

  const trace = { root: 'f1', flows: [flow], links: [], missing: [] };
  const redactedTrace = redactTraceSummary(trace);
  assert.deepEqual(redactedTrace.flows[0].ops.o1.context.keys, ['secret']);
});
