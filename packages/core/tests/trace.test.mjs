import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlows } from '../dist/flows.js';
import { assembleTrace, ancestors } from '../dist/trace.js';
import { evt } from './helpers.mjs';

const root = (flow, id, ts, extra = {}) => evt({ id, ts, flow, op: 'root', node: 'n0', type: 'start', name: 'root', root: true, ...extra });

test('trace resolution: explicit link.trace wins outright', () => {
  const flows = buildFlows([
    root('child', '1', 1000, { link: { parentFlow: 'unknown-parent', trace: 'explicit-trace' } }),
  ]);
  assert.equal(flows.get('child').trace, 'explicit-trace');
});

test('trace resolution: unknown parent uses the parentFlow id as a placeholder, corrected once the parent arrives', () => {
  const childOnly = buildFlows([
    root('child', '1', 1000, { link: { parentFlow: 'parent' } }),
  ]);
  assert.equal(childOnly.get('child').trace, 'parent');

  // Once the parent is known and itself belongs to a different trace, the
  // child's resolved trace is corrected to match -- this is the "late parent"
  // case from SPEC.md §1: a flow's trace = the trace of its parentFlow once known.
  const withParent = buildFlows([
    root('parent', 'p1', 900, { link: { parentFlow: 'grandparent', trace: 'external-trace-99' } }),
    root('child', '1', 1000, { link: { parentFlow: 'parent' } }),
  ]);
  assert.equal(withParent.get('parent').trace, 'external-trace-99');
  assert.equal(withParent.get('child').trace, 'external-trace-99');
});

test('trace resolution: no link makes a flow its own trace root', () => {
  const flows = buildFlows([root('solo', '1', 1000)]);
  assert.equal(flows.get('solo').trace, 'solo');
});

test('trace resolution: cycles are broken by treating the first-seen flow as the root', () => {
  // Flow "a"'s events come first in the input, so it is the first flow seen
  // while resolving the a -> b -> a cycle.
  const flows = buildFlows([
    root('a', '1', 1000, { link: { parentFlow: 'b' } }),
    root('b', '2', 1000, { link: { parentFlow: 'a' } }),
  ]);
  assert.equal(flows.get('a').trace, 'a');
  assert.equal(flows.get('b').trace, 'a');
});

test('core-7: buildFlows resolves a 50k-deep parentFlow chain without overflowing the stack', () => {
  const depth = 50_000;
  const events = [];
  for (let i = 0; i < depth; i++) {
    events.push(
      i === 0
        ? root(`f${i}`, `e${i}`, 1000)
        : root(`f${i}`, `e${i}`, 1000 + i, { link: { parentFlow: `f${i - 1}` } }),
    );
  }

  let flows;
  assert.doesNotThrow(() => {
    flows = buildFlows(events);
  });
  assert.equal(flows.size, depth);
  // Every flow in the chain resolves to the same root trace id (the first flow).
  assert.equal(flows.get('f0').trace, 'f0');
  assert.equal(flows.get(`f${depth - 1}`).trace, 'f0');
  assert.equal(flows.get(`f${Math.floor(depth / 2)}`).trace, 'f0');
});

test('assembleTrace groups every flow sharing a resolved trace id, root-first-ish ordering by startedAt', () => {
  const flows = buildFlows([
    root('parent', 'p', 1000),
    root('child1', 'c1', 1100, { link: { parentFlow: 'parent' } }),
    root('child2', 'c2', 1200, { link: { parentFlow: 'parent' } }),
  ]);
  const trace = assembleTrace(flows, 'child1');
  assert.equal(trace.root, 'parent');
  assert.deepEqual(trace.flows.map((f) => f.id), ['parent', 'child1', 'child2']);
  assert.deepEqual(trace.links, [
    { parent: 'parent', child: 'child1', parentOp: undefined, parentNode: undefined },
    { parent: 'parent', child: 'child2', parentOp: undefined, parentNode: undefined },
  ]);
  assert.deepEqual(trace.missing, []);
});

test('assembleTrace reports missing parents referenced by a member but never observed', () => {
  const flows = buildFlows([
    root('child', 'c', 1000, { link: { parentFlow: 'ghost-parent' } }),
  ]);
  const trace = assembleTrace(flows, 'child');
  assert.deepEqual(trace.missing, ['ghost-parent']);
  assert.deepEqual(trace.flows.map((f) => f.id), ['child']);
});

test('assembleTrace works when queried from any member, not just the root', () => {
  const flows = buildFlows([
    root('parent', 'p', 1000),
    root('child', 'c', 1100, { link: { parentFlow: 'parent' } }),
  ]);
  const fromRoot = assembleTrace(flows, 'parent');
  const fromChild = assembleTrace(flows, 'child');
  assert.deepEqual(fromRoot.flows.map((f) => f.id), fromChild.flows.map((f) => f.id));
});

test('ancestors: root-first chain excluding the flow itself', () => {
  const flows = buildFlows([
    root('grandparent', 'g', 900),
    root('parent', 'p', 1000, { link: { parentFlow: 'grandparent' } }),
    root('child', 'c', 1100, { link: { parentFlow: 'parent' } }),
  ]);
  assert.deepEqual(ancestors(flows, 'child'), ['grandparent', 'parent']);
  assert.deepEqual(ancestors(flows, 'grandparent'), []);
});

test('ancestors: stops at a parent that has not been observed yet (late parent)', () => {
  const flows = buildFlows([
    root('child', 'c', 1000, { link: { parentFlow: 'unseen-parent' } }),
  ]);
  assert.deepEqual(ancestors(flows, 'child'), []);
});

test('ancestors: stops rather than looping forever on a cycle', () => {
  const flows = buildFlows([
    root('a', '1', 1000, { link: { parentFlow: 'b' } }),
    root('b', '2', 1000, { link: { parentFlow: 'a' } }),
  ]);
  const chain = ancestors(flows, 'a');
  assert.ok(chain.length <= 2, 'must terminate');
  assert.deepEqual(new Set(chain), new Set(chain)); // no throw / no infinite loop is the real assertion
});

test('ancestors: unknown flow returns an empty chain', () => {
  const flows = buildFlows([root('solo', '1', 1000)]);
  assert.deepEqual(ancestors(flows, 'does-not-exist'), []);
});
