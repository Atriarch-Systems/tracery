/**
 * Default node-kind -> presentation catalog (SPEC.md §2 "catalog lets the
 * caller map kind to NodePresentation; a default catalog ships"). Callers may
 * pass their own `catalog` to `project()` instead.
 */
import type { NodePresentation } from './visualizer-ext.js';

export const DEFAULT_NODE_CATALOG: Readonly<Record<string, NodePresentation>> = {
  agent: { badge: 'AGENT', icon: '◆', accent: '#7c9cff' },
  subagent: { badge: 'SUBAGENT', icon: '◇', accent: '#9fb4ff' },
  llm: { badge: 'LLM', icon: '✳', accent: '#c58aff' },
  tool: { badge: 'TOOL', icon: '⚙', accent: '#5bd1a5' },
  memory: { badge: 'MEMORY', icon: '▤', accent: '#f2c14e' },
  guard: { badge: 'GUARD', icon: '⛨', accent: '#ff8a65' },
  human: { badge: 'HUMAN', icon: '☺', accent: '#8ac6ff' },
  service: { badge: 'SERVICE', icon: '▣', accent: '#8892a6' },
};

export const FALLBACK_NODE_PRESENTATION: NodePresentation = { badge: 'NODE', icon: '•', accent: '#8892a6' };

/** Looks up `kind` in the default catalog, falling back to a generic presentation. */
export function defaultCatalog(kind: string | undefined): NodePresentation {
  if (kind !== undefined && Object.prototype.hasOwnProperty.call(DEFAULT_NODE_CATALOG, kind)) {
    return DEFAULT_NODE_CATALOG[kind]!;
  }
  return FALLBACK_NODE_PRESENTATION;
}
