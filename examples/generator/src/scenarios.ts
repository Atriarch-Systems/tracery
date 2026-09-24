/**
 * Two sample flows, generated on demand rather than looped automatically
 * (compare examples/embedded/src/scenario.ts, which runs one of these
 * forever with no UI). Every event carries a `runId` suffix on every id so
 * clicking "Generate" repeatedly never collides with a prior run's ids --
 * the wire contract's dedupe-by-id rule (SPEC.md §1) would otherwise treat a
 * second click's identical schedule as a no-op resend.
 */
import { ACTIVITY_CONTRACT_VERSION, type ActivityEvent } from '@atriarch-systems/tracery-core';

export interface ScheduledStep {
  readonly at: number;
  readonly build: () => readonly ActivityEvent[];
}

export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Total wall-clock time the schedule takes to finish, for UI feedback. */
  readonly durationMs: number;
  readonly build: (runId: string) => readonly ScheduledStep[];
}

function evt(partial: Omit<ActivityEvent, 'v'>): ActivityEvent {
  return { v: ACTIVITY_CONTRACT_VERSION, ...partial };
}

const orchestrator = { id: 'agent:orchestrator', name: 'Orchestrator', kind: 'agent' } as const;
const research1Actor = { id: 'subagent:research-1', name: 'Research Agent 1', kind: 'subagent' } as const;
const research2Actor = { id: 'subagent:research-2', name: 'Research Agent 2', kind: 'subagent' } as const;

const simpleFlow: Scenario = {
  id: 'simple',
  label: 'Simple flow',
  description: 'One agent: plans, calls a tool, reports. No subagents.',
  durationMs: 3200,
  build: (runId) => {
    const flow = `flow:simple-${runId}`;
    const id = (name: string) => `evt-${runId}-simple-${name}`;
    return [
      { at: 0, build: () => [evt({ id: id('plan-start'), ts: Date.now(), flow, op: 'op:plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Answer the question', root: true, actor: orchestrator })] },
      { at: 900, build: () => [
        evt({ id: id('plan-end'), ts: Date.now(), flow, op: 'op:plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 900, context: { tokens: 84 } }),
        evt({ id: id('tool-start'), ts: Date.now(), flow, op: 'op:tool', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', label: 'Search docs', parentOp: 'op:plan', parentNode: 'llm:main' }),
      ] },
      { at: 2000, build: () => [evt({ id: id('tool-end'), ts: Date.now(), flow, op: 'op:tool', node: 'tool:search', type: 'end', name: 'tool.search', status: 'success', durationMs: 1100, context: { hits: 4 } })] },
      { at: 2200, build: () => [evt({ id: id('report-start'), ts: Date.now(), flow, op: 'op:report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:plan', parentNode: 'llm:main' })] },
      { at: 3200, build: () => [evt({ id: id('report-end'), ts: Date.now(), flow, op: 'op:report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 1000, context: { tokens: 52 } })] },
    ];
  },
};

const subagentsFlow: Scenario = {
  id: 'subagents',
  label: 'Subagents + error',
  description: 'An orchestrator spawns two subagents (one errors) while a guard check and a human approval run alongside them.',
  durationMs: 16000,
  build: (runId) => {
    const parentFlow = `flow:orchestrator-${runId}`;
    const r1Flow = `flow:research-1-${runId}`;
    const r2Flow = `flow:research-2-${runId}`;
    const id = (name: string) => `evt-${runId}-${name}`;
    const now = () => Date.now();

    return [
      { at: 0, build: () => [evt({ id: id('p-plan-start'), ts: now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan the investigation', root: true, actor: orchestrator })] },
      { at: 1200, build: () => [evt({ id: id('p-plan-update'), ts: now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'update', name: 'llm.plan', context: { tokens: 128 } })] },
      { at: 2500, build: () => [
        evt({ id: id('p-plan-end'), ts: now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 2500, context: { tokens: 256 } }),
        evt({ id: id('p-search-start'), ts: now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', label: 'Search prior incidents', parentOp: 'op:p-plan', parentNode: 'llm:main' }),
      ] },
      { at: 4500, build: () => [evt({ id: id('p-search-annotate'), ts: now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'annotate', name: 'tool.search', context: { note: 'expanding query to include closed tickets' } })] },
      { at: 6500, build: () => [evt({ id: id('p-search-end'), ts: now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'success', durationMs: 4000, context: { hits: 7 } })] },
      { at: 6600, build: () => [
        evt({ id: id('p-spawn-r1-start'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r1', node: 'tool:search', type: 'start', name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
        evt({ id: id('p-spawn-r1-end'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r1', node: 'tool:search', type: 'end', name: 'flow.spawn', status: 'success' }),
        evt({ id: id('r1-plan-start'), ts: now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research1Actor, link: { parentFlow, parentOp: 'op:p-spawn-r1', parentNode: 'tool:search' } }),
      ] },
      { at: 6700, build: () => [
        evt({ id: id('p-spawn-r2-start'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r2', node: 'tool:search', type: 'start', name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
        evt({ id: id('p-spawn-r2-end'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r2', node: 'tool:search', type: 'end', name: 'flow.spawn', status: 'success' }),
        evt({ id: id('r2-plan-start'), ts: now(), flow: r2Flow, op: 'op:r2-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research2Actor, link: { parentFlow, parentOp: 'op:p-spawn-r2', parentNode: 'tool:search' } }),
      ] },
      { at: 6800, build: () => [evt({ id: id('p-guard-start'), ts: now(), flow: parentFlow, op: 'op:p-guard', node: 'guard:policy', type: 'start', name: 'guard.check', kind: 'guard', parentOp: 'op:p-search', parentNode: 'tool:search' })] },
      { at: 8200, build: () => [evt({ id: id('p-guard-end'), ts: now(), flow: parentFlow, op: 'op:p-guard', node: 'guard:policy', type: 'end', name: 'guard.check', status: 'success', durationMs: 1400 })] },
      { at: 8400, build: () => [evt({ id: id('p-human-start'), ts: now(), flow: parentFlow, op: 'op:p-human', node: 'human:approval', type: 'start', name: 'human.approve', kind: 'human', parentOp: 'op:p-guard', parentNode: 'guard:policy' })] },
      { at: 10800, build: () => [evt({ id: id('p-human-end'), ts: now(), flow: parentFlow, op: 'op:p-human', node: 'human:approval', type: 'end', name: 'human.approve', status: 'success', durationMs: 2400 })] },
      { at: 11000, build: () => [evt({ id: id('p-report-start'), ts: now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:p-plan', parentNode: 'llm:main' })] },
      { at: 12500, build: () => [evt({ id: id('p-report-update'), ts: now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 96 } })] },
      { at: 14000, build: () => [evt({ id: id('p-report-end'), ts: now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 3000 })] },

      { at: 8000, build: () => [evt({ id: id('r1-plan-update'), ts: now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'update', name: 'llm.plan', context: { tokens: 64 } })] },
      { at: 9000, build: () => [
        evt({ id: id('r1-plan-end'), ts: now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 2200 }),
        evt({ id: id('r1-search-start'), ts: now(), flow: r1Flow, op: 'op:r1-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', parentOp: 'op:r1-plan', parentNode: 'llm:main' }),
      ] },
      { at: 11000, build: () => [evt({ id: id('r1-search-end'), ts: now(), flow: r1Flow, op: 'op:r1-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'success', durationMs: 2000, context: { hits: 3 } })] },
      { at: 11200, build: () => [evt({ id: id('r1-memory-start'), ts: now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'start', name: 'memory.write', kind: 'memory', parentOp: 'op:r1-search', parentNode: 'tool:search', dataFrom: 'tool:search' })] },
      { at: 12500, build: () => [evt({ id: id('r1-memory-annotate'), ts: now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'annotate', name: 'memory.write', context: { note: 'summarised 3 hits into 1 note' } })] },
      { at: 13500, build: () => [
        evt({ id: id('r1-memory-end'), ts: now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'end', name: 'memory.write', status: 'success', durationMs: 2300 }),
        evt({ id: id('r1-report-start'), ts: now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:r1-memory', parentNode: 'memory:notes' }),
      ] },
      { at: 15000, build: () => [evt({ id: id('r1-report-update'), ts: now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 40 } })] },
      { at: 16000, build: () => [evt({ id: id('r1-report-end'), ts: now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 2500 })] },

      { at: 8100, build: () => [
        evt({ id: id('r2-plan-end'), ts: now(), flow: r2Flow, op: 'op:r2-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 1400 }),
        evt({ id: id('r2-search-start'), ts: now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', parentOp: 'op:r2-plan', parentNode: 'llm:main' }),
      ] },
      { at: 9800, build: () => [evt({ id: id('r2-search-update'), ts: now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'update', name: 'tool.search', status: 'error', context: { attempt: 1 } })] },
      { at: 10800, build: () => [evt({ id: id('r2-search-end'), ts: now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'error', durationMs: 1700, context: { error: 'timeout' } })] },
      { at: 11000, build: () => [evt({ id: id('r2-memory-start'), ts: now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'start', name: 'memory.write', kind: 'memory', parentOp: 'op:r2-search', parentNode: 'tool:search' })] },
      { at: 12300, build: () => [evt({ id: id('r2-memory-annotate'), ts: now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'annotate', name: 'memory.write', context: { note: 'recording partial results despite search error' } })] },
      { at: 13300, build: () => [
        evt({ id: id('r2-memory-end'), ts: now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'end', name: 'memory.write', status: 'success', durationMs: 2300 }),
        evt({ id: id('r2-report-start'), ts: now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:r2-memory', parentNode: 'memory:notes' }),
      ] },
      { at: 14800, build: () => [evt({ id: id('r2-report-update'), ts: now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 30 } })] },
      { at: 15800, build: () => [evt({ id: id('r2-report-end'), ts: now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 2500 })] },
    ];
  },
};

export const SCENARIOS: readonly Scenario[] = [simpleFlow, subagentsFlow];

/** The flow id an "open in hub" link should point at -- the root flow's id, which for both scenarios above is deterministic from the scenario id + runId. */
export function rootFlowId(scenarioId: string, runId: string): string {
  return scenarioId === 'simple' ? `flow:simple-${runId}` : `flow:orchestrator-${runId}`;
}

/**
 * Fires each step's events at its `at` offset (real setTimeout, not
 * accelerated), calling `onEvents` for each batch. Returns a `stop()` that
 * clears every pending timer -- call it on unmount or when a new run starts
 * so an abandoned run's stragglers never land after a fresh "Generate" click.
 */
export function runSchedule(schedule: readonly ScheduledStep[], onEvents: (events: readonly ActivityEvent[]) => void): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const step of schedule) {
    timers.push(setTimeout(() => onEvents(step.build()), step.at));
  }
  return () => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  };
}
