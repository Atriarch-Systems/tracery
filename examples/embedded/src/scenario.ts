/**
 * A scripted synthetic agent for the library-mode example: no hub, no
 * network, just a `Journal` fed directly in-process (the "library" usage
 * mode from the root README).
 *
 * Story, one loop: agent:orchestrator plans (llm), searches (tool), spawns
 * two subagent flows from that search op via `link` (mirroring
 * `packages/core/src/fixtures.ts`'s sampleTraceEvents), then runs a guard
 * check, a human approval and a final report while both children run
 * concurrently. `subagent:research-2`'s search fails, so that child flow
 * ends in `error`. Every step is driven by `setTimeout` at realistic
 * delays so the graph visibly animates over roughly 20 seconds; once a
 * loop's slowest branch finishes, a short pause and a new loop starts with
 * fresh flow/op/event ids so the explorer keeps showing new activity.
 */
import { ACTIVITY_CONTRACT_VERSION, type ActivityEvent } from '@atriarch-systems/tracery-core';
import type { Journal } from '@atriarch-systems/tracery-core';

const orchestrator = { id: 'agent:orchestrator', name: 'Orchestrator', kind: 'agent' } as const;
const research1Actor = { id: 'subagent:research-1', name: 'Research Agent 1', kind: 'subagent' } as const;
const research2Actor = { id: 'subagent:research-2', name: 'Research Agent 2', kind: 'subagent' } as const;

interface Scheduled {
  readonly at: number;
  readonly build: () => readonly ActivityEvent[];
}

function evt(partial: Omit<ActivityEvent, 'v'>): ActivityEvent {
  return { v: ACTIVITY_CONTRACT_VERSION, ...partial };
}

/** Builds every event this loop will emit, each tagged with the wall-clock offset (ms) it fires at. */
function buildLoopSchedule(loop: number): readonly Scheduled[] {
  const parentFlow = `flow:orchestrator-${loop}`;
  const r1Flow = `flow:research-1-${loop}`;
  const r2Flow = `flow:research-2-${loop}`;
  const id = (name: string) => `evt-${loop}-${name}`;

  return [
    // --- parent: plan --------------------------------------------------
    { at: 0, build: () => [evt({ id: id('p-plan-start'), ts: Date.now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan the investigation', root: true, actor: orchestrator })] },
    { at: 1200, build: () => [evt({ id: id('p-plan-update'), ts: Date.now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'update', name: 'llm.plan', context: { tokens: 128 } })] },
    { at: 2500, build: () => [
      evt({ id: id('p-plan-end'), ts: Date.now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 2500, context: { tokens: 256 } }),
      evt({ id: id('p-search-start'), ts: Date.now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', label: 'Search prior incidents', parentOp: 'op:p-plan', parentNode: 'llm:main' }),
    ] },
    { at: 4500, build: () => [evt({ id: id('p-search-annotate'), ts: Date.now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'annotate', name: 'tool.search', context: { note: 'expanding query to include closed tickets' } })] },
    { at: 6500, build: () => [evt({ id: id('p-search-end'), ts: Date.now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'success', durationMs: 4000, context: { hits: 7 } })] },

    // --- parent: spawn both children from the same search op -----------
    { at: 6600, build: () => [
      evt({ id: id('p-spawn-r1-start'), ts: Date.now(), flow: parentFlow, op: 'op:p-spawn-r1', node: 'tool:search', type: 'start', name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
      evt({ id: id('p-spawn-r1-end'), ts: Date.now(), flow: parentFlow, op: 'op:p-spawn-r1', node: 'tool:search', type: 'end', name: 'flow.spawn', status: 'success' }),
      evt({ id: id('r1-plan-start'), ts: Date.now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research1Actor, link: { parentFlow, parentOp: 'op:p-spawn-r1', parentNode: 'tool:search' } }),
    ] },
    { at: 6700, build: () => [
      evt({ id: id('p-spawn-r2-start'), ts: Date.now(), flow: parentFlow, op: 'op:p-spawn-r2', node: 'tool:search', type: 'start', name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
      evt({ id: id('p-spawn-r2-end'), ts: Date.now(), flow: parentFlow, op: 'op:p-spawn-r2', node: 'tool:search', type: 'end', name: 'flow.spawn', status: 'success' }),
      evt({ id: id('r2-plan-start'), ts: Date.now(), flow: r2Flow, op: 'op:r2-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research2Actor, link: { parentFlow, parentOp: 'op:p-spawn-r2', parentNode: 'tool:search' } }),
    ] },

    // --- parent: guard + human approval, concurrent with both children --
    { at: 6800, build: () => [evt({ id: id('p-guard-start'), ts: Date.now(), flow: parentFlow, op: 'op:p-guard', node: 'guard:policy', type: 'start', name: 'guard.check', kind: 'guard', parentOp: 'op:p-search', parentNode: 'tool:search' })] },
    { at: 8200, build: () => [evt({ id: id('p-guard-end'), ts: Date.now(), flow: parentFlow, op: 'op:p-guard', node: 'guard:policy', type: 'end', name: 'guard.check', status: 'success', durationMs: 1400 })] },
    { at: 8400, build: () => [evt({ id: id('p-human-start'), ts: Date.now(), flow: parentFlow, op: 'op:p-human', node: 'human:approval', type: 'start', name: 'human.approve', kind: 'human', parentOp: 'op:p-guard', parentNode: 'guard:policy' })] },
    { at: 10800, build: () => [evt({ id: id('p-human-end'), ts: Date.now(), flow: parentFlow, op: 'op:p-human', node: 'human:approval', type: 'end', name: 'human.approve', status: 'success', durationMs: 2400 })] },

    // --- parent: final report (self-loop on llm:main) -------------------
    { at: 11000, build: () => [evt({ id: id('p-report-start'), ts: Date.now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:p-plan', parentNode: 'llm:main' })] },
    { at: 12500, build: () => [evt({ id: id('p-report-update'), ts: Date.now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 96 } })] },
    { at: 14000, build: () => [evt({ id: id('p-report-end'), ts: Date.now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 3000 })] },

    // --- child: research-1 (succeeds) -----------------------------------
    { at: 8000, build: () => [evt({ id: id('r1-plan-update'), ts: Date.now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'update', name: 'llm.plan', context: { tokens: 64 } })] },
    { at: 9000, build: () => [
      evt({ id: id('r1-plan-end'), ts: Date.now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 2200 }),
      evt({ id: id('r1-search-start'), ts: Date.now(), flow: r1Flow, op: 'op:r1-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', parentOp: 'op:r1-plan', parentNode: 'llm:main' }),
    ] },
    { at: 11000, build: () => [evt({ id: id('r1-search-end'), ts: Date.now(), flow: r1Flow, op: 'op:r1-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'success', durationMs: 2000, context: { hits: 3 } })] },
    { at: 11200, build: () => [evt({ id: id('r1-memory-start'), ts: Date.now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'start', name: 'memory.write', kind: 'memory', parentOp: 'op:r1-search', parentNode: 'tool:search', dataFrom: 'tool:search' })] },
    { at: 12500, build: () => [evt({ id: id('r1-memory-annotate'), ts: Date.now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'annotate', name: 'memory.write', context: { note: 'summarised 3 hits into 1 note' } })] },
    { at: 13500, build: () => [
      evt({ id: id('r1-memory-end'), ts: Date.now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'end', name: 'memory.write', status: 'success', durationMs: 2300 }),
      evt({ id: id('r1-report-start'), ts: Date.now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:r1-memory', parentNode: 'memory:notes' }),
    ] },
    { at: 15000, build: () => [evt({ id: id('r1-report-update'), ts: Date.now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 40 } })] },
    { at: 16000, build: () => [evt({ id: id('r1-report-end'), ts: Date.now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 2500 })] },

    // --- child: research-2 (search fails) --------------------------------
    { at: 8100, build: () => [
      evt({ id: id('r2-plan-end'), ts: Date.now(), flow: r2Flow, op: 'op:r2-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 1400 }),
      evt({ id: id('r2-search-start'), ts: Date.now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', parentOp: 'op:r2-plan', parentNode: 'llm:main' }),
    ] },
    { at: 9800, build: () => [evt({ id: id('r2-search-update'), ts: Date.now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'update', name: 'tool.search', status: 'error', context: { attempt: 1 } })] },
    { at: 10800, build: () => [evt({ id: id('r2-search-end'), ts: Date.now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'error', durationMs: 1700, context: { error: 'timeout' } })] },
    { at: 11000, build: () => [evt({ id: id('r2-memory-start'), ts: Date.now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'start', name: 'memory.write', kind: 'memory', parentOp: 'op:r2-search', parentNode: 'tool:search' })] },
    { at: 12300, build: () => [evt({ id: id('r2-memory-annotate'), ts: Date.now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'annotate', name: 'memory.write', context: { note: 'recording partial results despite search error' } })] },
    { at: 13300, build: () => [
      evt({ id: id('r2-memory-end'), ts: Date.now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'end', name: 'memory.write', status: 'success', durationMs: 2300 }),
      evt({ id: id('r2-report-start'), ts: Date.now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:r2-memory', parentNode: 'memory:notes' }),
    ] },
    { at: 14800, build: () => [evt({ id: id('r2-report-update'), ts: Date.now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 30 } })] },
    { at: 15800, build: () => [evt({ id: id('r2-report-end'), ts: Date.now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 2500 })] },
  ];
}

const LOOP_END_MS = 16000;
const SETTLE_MS = 4000; // total real time per loop ~20s, matching the graph's own pacing

/**
 * Starts the scripted agent against `journal`, returns a `stop()` that
 * clears every pending timer (call it from a `useEffect` cleanup).
 */
export function runScenario(journal: Journal): () => void {
  let stopped = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  function schedule(delay: number, fn: () => void): void {
    if (stopped) return;
    timers.push(setTimeout(fn, delay));
  }

  function runLoop(loop: number): void {
    if (stopped) return;
    for (const step of buildLoopSchedule(loop)) {
      schedule(step.at, () => journal.append(step.build()));
    }
    schedule(LOOP_END_MS + SETTLE_MS, () => runLoop(loop + 1));
  }

  runLoop(0);

  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };
}
