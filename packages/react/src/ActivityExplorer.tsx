/**
 * The composite explorer (SPEC.md §4): connection status, flow picker
 * (active-first, "follow latest" default), scope switch (This flow / With
 * ancestors / Whole trace, keys 1/2/3), `ActivityGraph` in guided layout, an
 * inspector panel, and a group legend in trace mode. Double-clicking (or
 * `Enter`-activating) a node that belongs to a different flow's group drills
 * into that flow.
 *
 * The graph is canvas-drawn (`@atriarch/activity-visualizer`), so alongside
 * it this component also renders a small accessible node list per group --
 * the same selection/activation affordance as clicking/double-clicking a
 * card, reachable by keyboard and by automated testing without canvas hit
 * testing (`data-testid="node-item"`).
 */
import { useEffect, useMemo, useState } from 'react';
import { ActivityGraph, placeBranches } from '@atriarch/activity-visualizer';
import type { ActivityNode, NodeData, NodePresentation, NodeRecord, Flow, Scope } from '@atriarch/activity-core';
import type { ReactNode, CSSProperties } from 'react';
import type { ActivitySource } from './source.js';
import { useProjection } from './useProjection.js';
import { computeScope, scopeModeForKey, activatedFlow, SCOPE_LABELS, type ScopeMode } from './scope.js';
import { latestFlows, latestFlowId } from './flow-order.js';
import { Inspector, type InspectorSelection } from './Inspector.js';
import { rootStyle, styles, type ActivityThemeVars } from './style.js';

export interface ActivityExplorerProps {
  readonly source: ActivitySource;
  readonly initialScope?: Scope;
  readonly catalog?: (node: NodeRecord, flow: Flow) => NodePresentation;
  readonly renderInspector?: (selection: InspectorSelection | null) => ReactNode;
  readonly theme?: ActivityThemeVars;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly ariaLabel?: string;
}

const SCOPE_MODES: readonly ScopeMode[] = ['flow', 'ancestors', 'trace'];

export function ActivityExplorer(props: ActivityExplorerProps) {
  const { source, initialScope, catalog, renderInspector, theme, className, style, ariaLabel } = props;

  const [activeFlow, setActiveFlow] = useState<string | undefined>(
    initialScope ? (initialScope.mode === 'trace' ? undefined : initialScope.flow) : undefined,
  );
  const [mode, setMode] = useState<ScopeMode>(initialScope?.mode ?? 'flow');
  const [followLatest, setFollowLatest] = useState(initialScope === undefined);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [placement, setPlacement] = useState(() => new Map());

  const ordered = useMemo(() => latestFlows(source.flows), [source.flows]);

  // "follow latest" default: keep the active flow pinned to the newest/most
  // active flow until the user picks one explicitly (SPEC.md §4 flow picker).
  useEffect(() => {
    if (!followLatest) return;
    const latest = latestFlowId(source.flows);
    if (latest !== undefined && latest !== activeFlow) setActiveFlow(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followLatest, source.flows]);

  useEffect(() => {
    if (initialScope?.mode === 'trace') {
      const anchor = [...source.flows.values()].find((f) => f.trace === initialScope.trace);
      if (anchor) setActiveFlow(anchor.id);
    }
    // Runs once: only to resolve an initial trace scope's anchor flow once flows are known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialScope, source.flows.size > 0]);

  const scope: Scope | undefined = activeFlow !== undefined ? computeScope(mode, activeFlow, source.flows) : undefined;
  const projection = useProjection(source, scope ?? { mode: 'flow', flow: '' }, { catalog });
  const hasScope = scope !== undefined && (scope.mode === 'trace' ? true : source.flows.has(scope.flow));

  const guided = useMemo(
    () => placeBranches(hasScope ? projection.nodes : [], hasScope ? projection.edges : [], placement),
    [hasScope, projection.nodes, projection.edges],
  );

  useEffect(() => setPlacement(guided.positions), [guided.positions]);

  const selectedNode: InspectorSelection | null = useMemo(
    () => (selectedNodeId ? (guided.nodes.find((n) => n.id === selectedNodeId) as ActivityNode<NodeData> | undefined) ?? null : null),
    [guided.nodes, selectedNodeId],
  );

  const pickFlow = (id: string): void => {
    setFollowLatest(false);
    setActiveFlow(id);
    setSelectedNodeId(null);
  };

  const switchMode = (next: ScopeMode): void => {
    setMode(next);
    setSelectedNodeId(null);
  };

  const activate = (node: ActivityNode<NodeData>): void => {
    if (!activeFlow) return;
    const target = activatedFlow(node, activeFlow);
    if (target) {
      setFollowLatest(false);
      setActiveFlow(target);
      setMode('flow');
      setSelectedNodeId(null);
    } else {
      setSelectedNodeId(node.id);
    }
  };

  return (
    <div
      className={className}
      style={{ ...rootStyle(theme), ...style }}
      onKeyDown={(event) => {
        const next = scopeModeForKey(event.key);
        if (next) {
          switchMode(next);
          event.preventDefault();
        }
      }}
    >
      <div style={styles.header}>
        <span style={styles.statusDot(source.status)} aria-hidden="true" />
        <span style={styles.statusText} data-testid="connection-status">
          {source.status}
          {source.partial ? ' (partial)' : ''}
        </span>
        {source.error && (
          <span style={{ color: 'var(--activity-error, #ff6b6b)' }} role="alert">
            {source.error}
          </span>
        )}
        <div style={styles.scopeSwitch} role="tablist" aria-label="Scope">
          {SCOPE_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              data-testid={`scope-${m}`}
              style={styles.scopeButton(mode === m)}
              onClick={() => switchMode(m)}
            >
              {SCOPE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {mode === 'trace' && projection.groups.length > 0 && (
        <div style={styles.legend} data-testid="group-legend">
          {projection.groups.map((group) => {
            const dimmed = group.flow !== activeFlow;
            return (
              <button
                key={group.id}
                type="button"
                data-testid="group-legend-item"
                data-group-id={group.id}
                data-flow-id={group.flow}
                style={styles.legendItem(dimmed)}
                onClick={() => pickFlow(group.flow)}
              >
                <span style={styles.swatch(group.status === 'error' ? 'var(--activity-error, #ff6b6b)' : 'var(--activity-accent, #7c9cff)')} />
                {group.label}
              </button>
            );
          })}
        </div>
      )}

      <div style={styles.body}>
        <div style={styles.sidebar} data-testid="flow-picker">
          <div style={styles.sidebarHeading}>Flows</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontSize: 12 }}>
            <input type="checkbox" checked={followLatest} onChange={(e) => setFollowLatest(e.target.checked)} />
            Follow latest
          </label>
          {ordered.map((flow) => (
            <button
              key={flow.id}
              type="button"
              data-testid="flow-picker-item"
              data-flow-id={flow.id}
              data-flow-status={flow.status}
              data-active={flow.id === activeFlow ? 'true' : 'false'}
              style={styles.flowItem(flow.id === activeFlow)}
              onClick={() => pickFlow(flow.id)}
            >
              {flow.label} <span style={styles.muted}>({flow.status})</span>
            </button>
          ))}
          {ordered.length === 0 && <div style={{ ...styles.muted, padding: 8 }}>No flows yet.</div>}
        </div>

        <div style={styles.graphArea}>
          {hasScope ? (
            <ActivityGraph
              nodes={guided.nodes}
              edges={projection.edges}
              groups={projection.groups.map((g) => ({ id: g.id, label: g.label, dimmed: g.flow !== activeFlow }))}
              layoutMode="guided"
              layoutKey={scope ? (scope.mode === 'trace' ? `trace:${scope.trace}` : `${scope.mode}:${scope.flow}`) : 'none'}
              selectedNodeId={selectedNodeId}
              onNodeSelect={(node) => setSelectedNodeId(node?.id ?? null)}
              onNodeActivate={(node) => activate(node as ActivityNode<NodeData>)}
              ariaLabel={ariaLabel}
            />
          ) : (
            <div style={{ ...styles.muted, padding: 16 }}>No flow selected.</div>
          )}

          {hasScope && (
            <div style={{ padding: '0 12px 8px' }}>
              {projection.groups.map((group) => (
                <details key={group.id} open>
                  <summary style={styles.muted}>{group.label}</summary>
                  {group.nodeIds.map((id) => {
                    const node = guided.nodes.find((n) => n.id === id);
                    if (!node) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        data-testid="node-item"
                        data-node-id={id}
                        data-group-id={group.id}
                        style={styles.flowItem(id === selectedNodeId)}
                        onClick={() => setSelectedNodeId(id)}
                        onDoubleClick={() => activate(node as ActivityNode<NodeData>)}
                      >
                        {node.label} <span style={styles.muted}>({node.status ?? 'idle'})</span>
                      </button>
                    );
                  })}
                </details>
              ))}
            </div>
          )}
        </div>

        <div style={styles.inspector}>
          {renderInspector ? renderInspector(selectedNode) : <Inspector selection={selectedNode} />}
        </div>
      </div>
    </div>
  );
}
