import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, emptyGraph } from '../dist/model.js';
import { drawGroups, groupAlpha, convexHull } from '../dist/groups.js';

const fakeCtx = () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? value => ({ width: value.length * 6 })
      : (...args) => calls.push([key, ...args]),
    set: (_target, key, value) => { calls.push([key, value]); return true; },
  });
  return { ctx, calls };
};

const nodesFor = (specs) => reconcile(emptyGraph(), specs, []).nodes;

test('a group with 1-2 members draws a rounded (roundRect) hull with its label', () => {
  const nodes = nodesFor([
    { id: 'a', label: 'A', group: 'g1', position: { x: 0, y: 0, anchored: true } },
    { id: 'b', label: 'B', group: 'g1', position: { x: 200, y: 0, anchored: true } },
    { id: 'other', label: 'Not in group', position: { x: 900, y: 900, anchored: true } },
  ]);
  const { ctx, calls } = fakeCtx();
  drawGroups(ctx, [{ id: 'g1', label: 'My Group', accent: '#adf17b' }], nodes);
  const roundRectCalls = calls.filter(c => c[0] === 'roundRect');
  assert.ok(roundRectCalls.length > 0, 'expected a roundRect call for a small group');
  const fillCalls = calls.filter(c => c[0] === 'fill');
  assert.ok(fillCalls.length > 0, 'expected a fill call for the hull');
  const labels = calls.filter(c => c[0] === 'fillText').map(c => c[1]);
  assert.ok(labels.includes('My Group'), 'expected the group label to be drawn via fillText');
});

test('a group with 3+ members draws a convex-hull polygon (no roundRect) with its label', () => {
  const nodes = nodesFor([
    { id: 'a', label: 'A', group: 'g2', position: { x: 0, y: 0, anchored: true } },
    { id: 'b', label: 'B', group: 'g2', position: { x: 300, y: 0, anchored: true } },
    { id: 'c', label: 'C', group: 'g2', position: { x: 150, y: 250, anchored: true } },
  ]);
  const { ctx, calls } = fakeCtx();
  drawGroups(ctx, [{ id: 'g2', label: 'Trio' }], nodes);
  assert.equal(calls.filter(c => c[0] === 'roundRect').length, 0, 'hulls of 3+ members should not use roundRect');
  assert.ok(calls.some(c => c[0] === 'arcTo'), 'expected rounded-corner arcTo calls tracing the hull polygon');
  assert.ok(calls.some(c => c[0] === 'fill'));
  assert.ok(calls.filter(c => c[0] === 'fillText').map(c => c[1]).includes('Trio'));
});

test('a group with no live members draws nothing', () => {
  const nodes = nodesFor([{ id: 'a', label: 'A', position: { x: 0, y: 0, anchored: true } }]);
  const { ctx, calls } = fakeCtx();
  drawGroups(ctx, [{ id: 'empty', label: 'Empty group' }], nodes);
  assert.equal(calls.length, 0);
});

test('dimmed groups render at 45% alpha; non-dimmed groups at full alpha', () => {
  const nodes = nodesFor([
    { id: 'a', label: 'A', group: 'g', position: { x: 0, y: 0, anchored: true } },
  ]);
  const { ctx: dimCtx, calls: dimCalls } = fakeCtx();
  drawGroups(dimCtx, [{ id: 'g', label: 'Dim', dimmed: true }], nodes);
  const dimAlpha = dimCalls.filter(c => c[0] === 'globalAlpha').map(c => c[1]);
  assert.ok(dimAlpha.includes(0.45), 'expected globalAlpha 0.45 for a dimmed group hull');

  const { ctx: brightCtx, calls: brightCalls } = fakeCtx();
  drawGroups(brightCtx, [{ id: 'g', label: 'Bright' }], nodes);
  const brightAlpha = brightCalls.filter(c => c[0] === 'globalAlpha').map(c => c[1]);
  assert.ok(brightAlpha.includes(1), 'expected globalAlpha 1 for a non-dimmed group hull');
});

test('groupAlpha returns 0.45 for a dimmed group member, 1 for everything else', () => {
  const [dimmedMember, plainMember, ungrouped] = nodesFor([
    { id: 'a', label: 'A', group: 'dim-group' },
    { id: 'b', label: 'B', group: 'plain-group' },
    { id: 'c', label: 'C' },
  ]);
  const groups = [{ id: 'dim-group', label: 'Dim', dimmed: true }, { id: 'plain-group', label: 'Plain' }];
  assert.equal(groupAlpha(dimmedMember, groups), 0.45);
  assert.equal(groupAlpha(plainMember, groups), 1);
  assert.equal(groupAlpha(ungrouped, groups), 1);
});

test('convexHull wraps every input point (padded card corners stay inside or on the hull)', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 50 }];
  const hull = convexHull(points);
  // The interior point (50,50) must not appear in the hull; the four corners define it.
  assert.equal(hull.length, 4);
  assert.ok(!hull.some(p => p.x === 50 && p.y === 50));
});
