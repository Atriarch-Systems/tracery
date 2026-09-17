/**
 * Pure scope logic for `ActivityExplorer` (SPEC.md §4 "scope switch ... 1/2/3
 * ... Double-clicking a child flow's group ... switches scope to that flow").
 * `ActivityExplorer` keeps two pieces of state -- `activeFlow` (the flow the
 * user is focused on) and `mode` (This flow / With ancestors / Whole trace)
 * -- and derives the `Scope` core's `project()` wants from them here, so the
 * derivation and the node-activation rule are unit-testable without React.
 */
import type { ActivityNode, Flow, NodeData, Scope } from '@atriarch/tracery-core';

export type ScopeMode = Scope['mode'];

export const SCOPE_LABELS: Readonly<Record<ScopeMode, string>> = {
  flow: 'This flow',
  ancestors: 'With ancestors',
  trace: 'Whole trace',
};

/** Keyboard shortcuts 1/2/3 (SPEC.md §4 "Keyboard: 1/2/3 switch scope"). */
export const SCOPE_MODE_KEYS: Readonly<Record<string, ScopeMode>> = {
  '1': 'flow',
  '2': 'ancestors',
  '3': 'trace',
};

export function scopeModeForKey(key: string): ScopeMode | undefined {
  return SCOPE_MODE_KEYS[key];
}

/** Derives the `Scope` core's `project()` expects from the explorer's (mode, activeFlow) state. */
export function computeScope(mode: ScopeMode, activeFlow: string, flows: ReadonlyMap<string, Flow>): Scope {
  if (mode === 'trace') {
    const flow = flows.get(activeFlow);
    return { mode: 'trace', trace: flow?.trace ?? activeFlow };
  }
  if (mode === 'ancestors') return { mode: 'ancestors', flow: activeFlow };
  return { mode: 'flow', flow: activeFlow };
}

/** A stable, comparable key for a Scope value -- handy as a React dependency or a test fixture id. */
export function scopeKey(scope: Scope): string {
  return scope.mode === 'trace' ? `trace:${scope.trace}` : `${scope.mode}:${scope.flow}`;
}

/**
 * SPEC.md §4: "Double-clicking a child flow's group ... switches scope to
 * that flow." A projected node's `data.flow` names the flow it belongs to
 * (SPEC.md §2 `NodeData`); when that differs from the flow currently focused,
 * activating the node should jump the explorer into that flow (drilling into
 * `{ mode: 'flow', flow }`). Returns the flow id to switch to, or null when
 * the node already belongs to the active flow (no-op).
 */
export function activatedFlow(node: ActivityNode<NodeData>, activeFlow: string): string | null {
  const flow = node.data?.flow;
  if (!flow || flow === activeFlow) return null;
  return flow;
}
