import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlows, buildFlow } from '../dist/flows.js';
import { evt } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Op lifecycle table (SPEC.md §1)
// ---------------------------------------------------------------------------

test('start creates a running op with startedAt and merged context', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'llm.plan', root: true, context: { a: 1 } }),
  ]);
  const op = flows.get('f1').ops.get('o1');
  assert.equal(op.status, 'running');
  assert.equal(op.startedAt, 1000);
  assert.equal(op.endedAt, undefined);
  assert.deepEqual(op.context, { a: 1 });
});

test('update shallow-merges context and applies status when given', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', root: true, context: { a: 1, b: 1 } }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'update', name: 'x', context: { b: 2, c: 3 } }),
  ]);
  const op = flows.get('f1').ops.get('o1');
  assert.deepEqual(op.context, { a: 1, b: 2, c: 3 });
  assert.equal(op.status, 'running'); // no status on the update

  const flows2 = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'update', name: 'x', status: 'error' }),
  ]);
  assert.equal(flows2.get('f1').ops.get('o1').status, 'error');
});

test('end sets endedAt, defaults status to success, computes durationMs, merges context', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', root: true, context: { a: 1 } }),
    evt({ id: '2', ts: 1400, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'x', context: { b: 2 } }),
  ]);
  const op = flows.get('f1').ops.get('o1');
  assert.equal(op.status, 'success');
  assert.equal(op.endedAt, 1400);
  assert.equal(op.durationMs, 400);
  assert.deepEqual(op.context, { a: 1, b: 2 });
});

test('end honours an explicit status and durationMs', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', root: true }),
    evt({ id: '2', ts: 1400, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'x', status: 'cancelled', durationMs: 999 }),
  ]);
  const op = flows.get('f1').ops.get('o1');
  assert.equal(op.status, 'cancelled');
  assert.equal(op.durationMs, 999);
});

test('annotate is appended verbatim and never merges into context or changes status', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', root: true, context: { a: 1 } }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'annotate', name: 'x', status: 'error', context: { note: 'fyi' } }),
  ]);
  const op = flows.get('f1').ops.get('o1');
  assert.deepEqual(op.context, { a: 1 }); // annotate's context did not merge
  assert.equal(op.status, 'running'); // annotate's status did not apply
  assert.deepEqual(op.timeline.at(-1), { ts: 1100, type: 'annotate', status: 'error', context: { note: 'fyi' }, eventId: '2' });
});

test('a later start for the same op is ignored: first wins', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'first', root: true, context: { a: 1 } }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'second', context: { a: 2 } }),
  ]);
  const op = flows.get('f1').ops.get('o1');
  assert.equal(op.name, 'first');
  assert.equal(op.startedAt, 1000);
  assert.deepEqual(op.context, { a: 1 });
  assert.equal(op.timeline.length, 1);
});

test('a later end for the same op is ignored: first wins', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x', root: true }),
    evt({ id: '2', ts: 1200, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'x', status: 'success' }),
    evt({ id: '3', ts: 1300, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'x', status: 'error' }),
  ]);
  const op = flows.get('f1').ops.get('o1');
  assert.equal(op.status, 'success');
  assert.equal(op.endedAt, 1200);
  assert.equal(op.timeline.length, 2);
});

// ---------------------------------------------------------------------------
// end/update/annotate without a start: creates the op, marks the flow partial
// ---------------------------------------------------------------------------

test('end without start creates the op with startedAt undefined and marks the flow partial', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'orphan', status: 'success', context: { a: 1 } }),
  ]);
  const flow = flows.get('f1');
  const op = flow.ops.get('o1');
  assert.equal(op.startedAt, undefined);
  assert.equal(op.endedAt, 1100);
  assert.equal(op.status, 'success');
  assert.deepEqual(op.context, { a: 1 });
  assert.equal(flow.partial, true);
  // No invented call count or edge visit for the orphaned op.
  assert.equal(flow.edges.length, 0);
});

test('update without start creates the op and marks the flow partial', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'update', name: 'orphan', context: { a: 1 } }),
  ]);
  const flow = flows.get('f1');
  const op = flow.ops.get('o1');
  assert.equal(op.startedAt, undefined);
  assert.equal(flow.partial, true);
});

test('annotate without start creates the op and marks the flow partial', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'annotate', name: 'orphan' }),
  ]);
  const flow = flows.get('f1');
  assert.equal(flow.ops.get('o1').startedAt, undefined);
  assert.equal(flow.partial, true);
});

test('a flow with events but no root start is partial', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x' }), // no root: true
  ]);
  assert.equal(flows.get('f1').partial, true);
});

test('a late start reopens/fills the gap when re-run with the fuller event set', () => {
  const withoutStart = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1200, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'x', status: 'success' }),
  ]);
  assert.equal(withoutStart.get('f1').partial, true);

  const withStart = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '3', ts: 1050, flow: 'f1', op: 'root', node: 'n0', type: 'end', name: 'root', status: 'success' }),
    evt({ id: '0', ts: 1100, flow: 'f1', op: 'o1', node: 'n1', type: 'start', name: 'x' }),
    evt({ id: '2', ts: 1200, flow: 'f1', op: 'o1', node: 'n1', type: 'end', name: 'x', status: 'success' }),
  ]);
  assert.equal(withStart.get('f1').partial, false);
  assert.equal(withStart.get('f1').status, 'complete');
});

// ---------------------------------------------------------------------------
// Flow status matrix
// ---------------------------------------------------------------------------

const rootStart = (ts = 1000) => evt({ id: 'r', ts, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true });

test('status: complete when every op ended and the flow is not partial', () => {
  const flows = buildFlows([
    rootStart(),
    evt({ id: 'e', ts: 1200, flow: 'f1', op: 'root', node: 'n0', type: 'end', name: 'root', status: 'success' }),
  ]);
  assert.equal(flows.get('f1').status, 'complete');
});

test('status: running when any op is open', () => {
  const flows = buildFlows([rootStart()]);
  assert.equal(flows.get('f1').status, 'running');
});

test('status: error when any op errored, even if others are open', () => {
  const flows = buildFlows([
    rootStart(),
    evt({ id: 'a', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'a' }),
    evt({ id: 'b', ts: 1200, flow: 'f1', op: 'a', node: 'n1', type: 'end', name: 'a', status: 'error' }),
  ]);
  assert.equal(flows.get('f1').status, 'error');
});

test('status: unknown when partial (no root) and no op is open', () => {
  const flows = buildFlows([
    evt({ id: 'a', ts: 1000, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'a' }), // root not true
    evt({ id: 'b', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'end', name: 'a', status: 'success' }),
  ]);
  assert.equal(flows.get('f1').status, 'unknown');
});

// ---------------------------------------------------------------------------
// Flow fields, node records, edge records
// ---------------------------------------------------------------------------

test('flow label falls back to name, actor comes from the root event', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'llm.plan', root: true, actor: { id: 'agent:a' } }),
  ]);
  const flow = flows.get('f1');
  assert.equal(flow.label, 'llm.plan');
  assert.deepEqual(flow.actor, { id: 'agent:a' });
  assert.equal(flow.startedAt, 1000);
});

test('flow label prefers an explicit label over the op name', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'llm.plan', label: 'Plan it', root: true }),
  ]);
  assert.equal(flows.get('f1').label, 'Plan it');
});

test('actor falls back to the first actor seen when the root start has none', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'a', actor: { id: 'agent:fallback' } }),
  ]);
  assert.deepEqual(flows.get('f1').actor, { id: 'agent:fallback' });
});

test('node label: first non-empty wins, later non-empty updates it, empty never erases', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'a', label: 'First' }),
    evt({ id: '3', ts: 1200, flow: 'f1', op: 'a', node: 'n1', type: 'update', name: 'a', label: '' }),
    evt({ id: '4', ts: 1300, flow: 'f1', op: 'a', node: 'n1', type: 'end', name: 'a', status: 'success', label: 'Second' }),
  ]);
  assert.equal(flows.get('f1').nodes.get('n1').label, 'Second');
});

test('node kind: last observed value wins', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'a', kind: 'tool' }),
    evt({ id: '3', ts: 1200, flow: 'f1', op: 'a', node: 'n1', type: 'end', name: 'a', status: 'success', kind: 'llm' }),
  ]);
  assert.equal(flows.get('f1').nodes.get('n1').kind, 'llm');
});

test('node bookkeeping: firstSeenAt/lastSeenAt/lastOpName/running/errorCount', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'call-a' }),
    evt({ id: '3', ts: 1200, flow: 'f1', op: 'a', node: 'n1', type: 'end', name: 'call-a', status: 'error' }),
    evt({ id: '4', ts: 1300, flow: 'f1', op: 'b', node: 'n1', type: 'start', name: 'call-b' }),
  ]);
  const node = flows.get('f1').nodes.get('n1');
  assert.equal(node.firstSeenAt, 1100);
  assert.equal(node.lastSeenAt, 1300);
  assert.equal(node.lastOpName, 'call-b');
  assert.equal(node.running, 1); // op b is still open
  assert.equal(node.errorCount, 1); // op a errored
  assert.equal(node.status, 'error'); // error takes precedence over running
});

test('call edges count distinct start ops; update/end never add to the count', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'a', parentNode: 'n0' }),
    evt({ id: '3', ts: 1200, flow: 'f1', op: 'a', node: 'n1', type: 'update', name: 'a' }),
    evt({ id: '4', ts: 1300, flow: 'f1', op: 'a', node: 'n1', type: 'end', name: 'a', status: 'success' }),
    evt({ id: '5', ts: 1400, flow: 'f1', op: 'b', node: 'n1', type: 'start', name: 'b', parentNode: 'n0' }),
  ]);
  const edge = flows.get('f1').edges.find((e) => e.source === 'n0' && e.target === 'n1');
  assert.equal(edge.count, 2);
  assert.deepEqual(edge.ops, ['a', 'b']);
  assert.equal(edge.kind, 'call');
  assert.equal(edge.lastAt, 1400);
});

test('dataFrom creates a data edge distinct from call edges', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'start', name: 'a', parentNode: 'n0', dataFrom: 'n2' }),
  ]);
  const edges = flows.get('f1').edges;
  assert.equal(edges.length, 2);
  const dataEdge = edges.find((e) => e.kind === 'data');
  assert.equal(dataEdge.source, 'n2');
  assert.equal(dataEdge.target, 'n1');
  assert.equal(dataEdge.count, 1);
});

test('self edges (parentNode === node) are still recorded by flows.ts (suppression is a project() concern)', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true, parentNode: 'n0' }),
  ]);
  const edges = flows.get('f1').edges;
  assert.equal(edges.length, 1);
  assert.equal(edges[0].source, 'n0');
  assert.equal(edges[0].target, 'n0');
});

test('an end/update/annotate without a start never creates an edge, even with parentNode/dataFrom set', () => {
  const flows = buildFlows([
    evt({ id: '1', ts: 1000, flow: 'f1', op: 'root', node: 'n0', type: 'start', name: 'root', root: true }),
    evt({ id: '2', ts: 1100, flow: 'f1', op: 'a', node: 'n1', type: 'end', name: 'a', status: 'success', parentNode: 'n0' }),
  ]);
  assert.equal(flows.get('f1').edges.length, 0);
});

// ---------------------------------------------------------------------------
// trace default and buildFlow fast path
// ---------------------------------------------------------------------------

test('trace defaults to the flow\'s own id when it has no link', () => {
  const flows = buildFlows([rootStart()]);
  assert.equal(flows.get('f1').trace, 'f1');
});

test('buildFlow reduces a single flow and ignores events for other flows', () => {
  const flow = buildFlow([
    rootStart(),
    evt({ id: 'x', ts: 1100, flow: 'other', op: 'z', node: 'n9', type: 'start', name: 'z' }),
  ]);
  assert.equal(flow.id, 'f1');
  assert.equal(flow.ops.size, 1);
  assert.equal(flow.trace, 'f1');
});

test('buildFlow throws on an empty event list', () => {
  assert.throws(() => buildFlow([]));
});
