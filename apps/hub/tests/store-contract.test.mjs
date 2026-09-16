// Store contract suite: every assertion here runs against BOTH `MemoryStore`
// and `SqliteStore` so the two implementations stay behaviourally identical
// (SPEC.md §6 "Storage").
import test from 'node:test';
import assert from 'node:assert/strict';
import { evt, storeEngines, withStore } from './helpers.mjs';

function startEvt(overrides) {
  return evt({ type: 'start', root: true, ...overrides });
}
function endEvt(overrides) {
  return evt({ type: 'end', status: 'success', ...overrides });
}

for (const { name, create } of storeEngines) {
  test(`${name}: append dedupes by (workspace, id) and assigns a monotonic cursor`, () =>
    withStore(create, async (store) => {
      const r1 = await store.append('ws1', [startEvt({ id: 'e1', flow: 'f1', op: 'o1' })]);
      assert.equal(r1.accepted.length, 1);
      assert.equal(r1.duplicates, 0);
      assert.equal(r1.cursor, 1);
      assert.equal(r1.accepted[0].cursor, 1);
      assert.equal(r1.accepted[0].workspace, 'ws1');

      const r2 = await store.append('ws1', [startEvt({ id: 'e1', flow: 'f1', op: 'o1' })]);
      assert.equal(r2.accepted.length, 0);
      assert.equal(r2.duplicates, 1);
      assert.equal(r2.cursor, 1);

      const r3 = await store.append('ws1', [endEvt({ id: 'e2', flow: 'f1', op: 'o1' })]);
      assert.equal(r3.cursor, 2);

      // Same id in a different workspace is not a duplicate: dedupe is workspace-scoped.
      const r4 = await store.append('ws2', [startEvt({ id: 'e1', flow: 'f1', op: 'o1' })]);
      assert.equal(r4.accepted.length, 1);
      assert.equal(r4.duplicates, 0);
    }));

  test(`${name}: flowEvents gives a full snapshot, then the delta after a cursor`, () =>
    withStore(create, async (store) => {
      await store.append('ws', [startEvt({ id: 'e1', flow: 'f1', op: 'o1', ts: 1000 })]);
      await store.append('ws', [endEvt({ id: 'e2', flow: 'f1', op: 'o1', ts: 1100 })]);

      const snapshot = await store.flowEvents('ws', 'f1');
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.truncated, false);
      assert.equal(snapshot.events.length, 2);

      const afterFirst = await store.flowEvents('ws', 'f1', snapshot.events[0].cursor);
      assert.equal(afterFirst.type, 'events');
      assert.deepEqual(afterFirst.events.map((e) => e.id), ['e2']);

      const afterLast = await store.flowEvents('ws', 'f1', snapshot.events[1].cursor);
      assert.equal(afterLast.events.length, 0);

      const unknownFlow = await store.flowEvents('ws', 'no-such-flow');
      assert.equal(unknownFlow.type, 'snapshot');
      assert.equal(unknownFlow.events.length, 0);
    }));

  test(`${name}: traceEvents gathers every event across every flow sharing the trace, cursor-ordered`, () =>
    withStore(create, async (store) => {
      await store.append('ws', [startEvt({ id: 'p1', flow: 'parent', op: 'po', ts: 1000 })]);
      await store.append('ws', [
        startEvt({ id: 'c1', flow: 'child', op: 'co', ts: 1050, link: { parentFlow: 'parent', parentOp: 'po' } }),
      ]);
      await store.append('ws', [endEvt({ id: 'p2', flow: 'parent', op: 'po', ts: 1100 })]);

      const events = await store.traceEvents('ws', 'parent');
      assert.deepEqual(events.map((e) => e.id), ['p1', 'c1', 'p2']);
      // Ascending by cursor.
      for (let i = 1; i < events.length; i++) assert.ok(events[i].cursor > events[i - 1].cursor);
    }));

  test(`${name}: listFlows pages newest-first and filters by status/actor/trace/q`, () =>
    withStore(create, async (store) => {
      await store.append('ws', [startEvt({ id: 'a1', flow: 'flow-a', op: 'oa', ts: 1000, label: 'Alpha run', actor: { id: 'agent:x' } })]);
      await store.append('ws', [endEvt({ id: 'a2', flow: 'flow-a', op: 'oa', ts: 1010 })]);
      await store.append('ws', [startEvt({ id: 'b1', flow: 'flow-b', op: 'ob', ts: 1020, label: 'Beta run', actor: { id: 'agent:y' } })]);
      await store.append('ws', [endEvt({ id: 'b2', flow: 'flow-b', op: 'ob', ts: 1030, status: 'error' })]);
      await store.append('ws', [startEvt({ id: 'c1', flow: 'flow-c', op: 'oc', ts: 1040, label: 'Gamma run', actor: { id: 'agent:x' } })]);

      const page1 = await store.listFlows('ws', { limit: 2 });
      assert.equal(page1.flows.length, 2);
      assert.deepEqual(page1.flows.map((f) => f.id), ['flow-c', 'flow-b']); // newest (most recent activity) first
      assert.ok(page1.nextBefore);

      const page2 = await store.listFlows('ws', { limit: 2, before: page1.nextBefore });
      assert.deepEqual(page2.flows.map((f) => f.id), ['flow-a']);
      assert.equal(page2.nextBefore, undefined);

      const byStatus = await store.listFlows('ws', { status: 'error' });
      assert.deepEqual(byStatus.flows.map((f) => f.id), ['flow-b']);

      const byActor = await store.listFlows('ws', { actor: 'agent:x' });
      assert.deepEqual(byActor.flows.map((f) => f.id).sort(), ['flow-a', 'flow-c']);

      const byTrace = await store.listFlows('ws', { trace: 'flow-a' });
      assert.deepEqual(byTrace.flows.map((f) => f.id), ['flow-a']);

      const byQ = await store.listFlows('ws', { q: 'beta' });
      assert.deepEqual(byQ.flows.map((f) => f.id), ['flow-b']);
    }));

  test(`${name}: flowSummary matches core's Flow shape with Maps converted to Records`, () =>
    withStore(create, async (store) => {
      await store.append('ws', [startEvt({ id: 'e1', flow: 'f1', op: 'o1', node: 'n1', ts: 1000, label: 'Hello' })]);
      await store.append('ws', [endEvt({ id: 'e2', flow: 'f1', op: 'o1', node: 'n1', ts: 1100 })]);

      const summary = await store.flowSummary('ws', 'f1');
      assert.equal(summary.id, 'f1');
      assert.equal(summary.label, 'Hello');
      assert.equal(summary.status, 'complete');
      assert.equal(summary.trace, 'f1');
      assert.equal(typeof summary.ops, 'object');
      assert.ok(!(summary.ops instanceof Map));
      assert.ok('o1' in summary.ops);
      assert.ok('n1' in summary.nodes);
      assert.equal(JSON.stringify(summary), JSON.stringify(JSON.parse(JSON.stringify(summary))));

      assert.equal(await store.flowSummary('ws', 'no-such-flow'), undefined);
    }));

  test(`${name}: deleteFlow removes the flow and its events`, () =>
    withStore(create, async (store) => {
      await store.append('ws', [startEvt({ id: 'e1', flow: 'f1', op: 'o1' })]);
      assert.equal(await store.deleteFlow('ws', 'no-such-flow'), false);
      assert.equal(await store.deleteFlow('ws', 'f1'), true);
      assert.equal(await store.flowSummary('ws', 'f1'), undefined);
      const events = await store.flowEvents('ws', 'f1');
      assert.equal(events.events.length, 0);
    }));

  test(`${name}: a parent flow arriving after its child corrects the child's (and grandchild's) resolved trace`, () =>
    withStore(create, async (store) => {
      // Grandchild links to "parent1", not yet observed.
      await store.append('ws', [
        startEvt({ id: 'c1', flow: 'child', op: 'co', ts: 1000, link: { parentFlow: 'parent1' } }),
      ]);
      let child = await store.flowSummary('ws', 'child');
      assert.equal(child.trace, 'parent1'); // placeholder: parent not yet known

      // parent1 arrives, itself linking to "grandparent1" (also not yet observed).
      await store.append('ws', [
        startEvt({ id: 'p1', flow: 'parent1', op: 'po', ts: 990, link: { parentFlow: 'grandparent1' } }),
      ]);
      child = await store.flowSummary('ws', 'child');
      assert.equal(child.trace, 'grandparent1'); // corrected once parent1 is known, even before grandparent1 is

      // grandparent1 finally arrives; it has no link, so it is its own trace root.
      await store.append('ws', [startEvt({ id: 'g1', flow: 'grandparent1', op: 'go', ts: 980 })]);
      const grandparent = await store.flowSummary('ws', 'grandparent1');
      const parent1 = await store.flowSummary('ws', 'parent1');
      child = await store.flowSummary('ws', 'child');
      assert.equal(grandparent.trace, 'grandparent1');
      assert.equal(parent1.trace, 'grandparent1');
      assert.equal(child.trace, 'grandparent1');

      const trace = await store.getTrace('ws', 'grandparent1');
      assert.deepEqual(trace.flows.map((f) => f.id).sort(), ['child', 'grandparent1', 'parent1']);
    }));

  test(`${name}: sweep deletes the oldest complete flows first, protecting a running flow younger than the retention window`, () =>
    withStore(create, async (store) => {
      const now = 10_000_000;
      const dayMs = 24 * 60 * 60 * 1000;

      await store.append('ws', [startEvt({ id: 'a1', flow: 'old-complete', op: 'oa', ts: now - 10 * dayMs })]);
      await store.append('ws', [endEvt({ id: 'a2', flow: 'old-complete', op: 'oa', ts: now - 10 * dayMs + 10 })]);

      await store.append('ws', [startEvt({ id: 'b1', flow: 'old-running', op: 'ob', ts: now - 10 * dayMs })]);
      // no end: still running

      await store.append('ws', [startEvt({ id: 'c1', flow: 'young-running', op: 'oc', ts: now - 1000 })]);
      // no end: still running, but well within the retention window -- protected

      await store.append('ws', [startEvt({ id: 'd1', flow: 'young-complete', op: 'od', ts: now - 1000 })]);
      await store.append('ws', [endEvt({ id: 'd2', flow: 'young-complete', op: 'od', ts: now - 900 })]);

      const result = await store.sweep(now, { retentionMs: dayMs, maxEventsPerWorkspace: 1_000_000 });
      assert.equal(result.sweptFlows, 2); // old-complete, old-running
      assert.equal(result.sweptEvents, 3); // a1, a2, b1

      assert.equal(await store.flowSummary('ws', 'old-complete'), undefined);
      assert.equal(await store.flowSummary('ws', 'old-running'), undefined);
      assert.notEqual(await store.flowSummary('ws', 'young-running'), undefined);
      assert.notEqual(await store.flowSummary('ws', 'young-complete'), undefined);
    }));

  test(`${name}: sweep evicts oldest-first once a workspace exceeds maxEventsPerWorkspace, even within the retention window`, () =>
    withStore(create, async (store) => {
      const now = 10_000_000;
      for (const [id, ts] of [
        ['flow-1', now - 300],
        ['flow-2', now - 200],
        ['flow-3', now - 100],
      ]) {
        await store.append('ws', [startEvt({ id: `${id}-s`, flow: id, op: 'o', ts })]);
        await store.append('ws', [endEvt({ id: `${id}-e`, flow: id, op: 'o', ts: ts + 1 })]);
      }

      const result = await store.sweep(now, { retentionMs: 24 * 60 * 60 * 1000, maxEventsPerWorkspace: 4 });
      assert.equal(result.sweptFlows, 1);
      assert.equal(await store.flowSummary('ws', 'flow-1'), undefined);
      assert.notEqual(await store.flowSummary('ws', 'flow-2'), undefined);
      assert.notEqual(await store.flowSummary('ws', 'flow-3'), undefined);
    }));

  test(`${name}: stats reports per-workspace event/flow counts and time bounds`, () =>
    withStore(create, async (store) => {
      await store.append('ws1', [startEvt({ id: 'e1', flow: 'f1', op: 'o1', ts: 1000 })]);
      await store.append('ws1', [endEvt({ id: 'e2', flow: 'f1', op: 'o1', ts: 1500 })]);
      await store.append('ws2', [startEvt({ id: 'e3', flow: 'f2', op: 'o2', ts: 2000 })]);

      const stats = await store.stats();
      const ws1 = stats.find((s) => s.workspace === 'ws1');
      const ws2 = stats.find((s) => s.workspace === 'ws2');
      assert.equal(ws1.events, 2);
      assert.equal(ws1.flows, 1);
      assert.equal(ws1.oldestEventAt, 1000);
      assert.equal(ws1.newestEventAt, 1500);
      assert.equal(ws2.events, 1);
      assert.equal(ws2.flows, 1);
    }));

  test(`${name}: after a sweep evicts a flow, a reconnect from an older cursor gets a truncated snapshot`, () =>
    withStore(create, async (store) => {
      const now = 10_000_000;
      const dayMs = 24 * 60 * 60 * 1000;
      const r1 = await store.append('ws', [startEvt({ id: 'old-1', flow: 'old', op: 'o', ts: now - 10 * dayMs })]);
      await store.append('ws', [endEvt({ id: 'old-2', flow: 'old', op: 'o', ts: now - 10 * dayMs + 5 })]);
      await store.append('ws', [startEvt({ id: 'new-1', flow: 'new', op: 'o', ts: now - 10 })]);

      await store.sweep(now, { retentionMs: dayMs, maxEventsPerWorkspace: 1_000_000 });

      const frame = await store.workspaceFrame('ws', r1.cursor);
      assert.equal(frame.type, 'snapshot');
      assert.equal(frame.truncated, true);
      assert.deepEqual(frame.events.map((e) => e.id), ['new-1']);

      // A fresh (no `after`) request is never truncated: it is authoritative for "now".
      const fresh = await store.workspaceFrame('ws');
      assert.equal(fresh.truncated, false);
    }));
}
