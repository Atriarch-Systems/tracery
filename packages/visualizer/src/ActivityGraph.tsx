"use client";
import { useEffect, useMemo, useRef, useState, useImperativeHandle, type ComponentType } from 'react';
import type { ForceGraphMethods, ForceGraphProps } from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import type { ActivityGraphProps, ActivityNode, ActivityGroup } from './types.js';
import { emptyGraph, reconcile, box, isNodeActive, type RuntimeGraph, type RuntimeNode, type RuntimeEdge } from './model.js';
import { drawNode, drawLink } from './drawing.js';
import { drawGroups, groupAlpha, groupMembers, hitTestGroup } from './groups.js';
import { resolveGraphTheme } from './theme.js';
import { detectDoubleClick, emptyDoubleClickState, type DoubleClickState } from './activate.js';
import { renderCapture, captureToBlob, type CaptureOptions } from './capture.js';

function waitOneFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/** Graph-space movement past which a pointer-down-then-move inside a group's hull commits to a
 * group drag rather than a click. `screen2GraphCoords` already divides by the current zoom
 * scale, so a flat graph-unit threshold behaves like a few screen pixels at any zoom level. */
const GROUP_DRAG_THRESHOLD = 4;

type GroupDragState = {
  readonly pointerId: number;
  readonly group: ActivityGroup;
  readonly members: readonly { readonly id: string; readonly x: number; readonly y: number }[];
  readonly startX: number;
  readonly startY: number;
  dragging: boolean;
};

/** Whether `point` (graph coordinates) lands on any node's own hit box -- the same rectangle
 * `nodePointerAreaPaint` paints for the library's hit canvas -- across every node currently on
 * the graph, not just a candidate group's own members: a node from a different group, or an
 * unaffiliated node, sitting visually inside this group's hull must still block a group drag. */
function pointHitsAnyNode(nodes: readonly RuntimeNode[], point: { x: number; y: number }): boolean {
  return nodes.some(n => {
    const { w, h } = box(n);
    return point.x >= n.x - w / 2 && point.x <= n.x + w / 2 && point.y >= n.y - h / 2 && point.y <= n.y + h / 2;
  });
}

/** No transports, agent catalogs, invocation reducers, or business data live here. */
export function ActivityGraph<N = unknown, E = unknown>(props: ActivityGraphProps<N, E>) {
  const { nodes, edges, layoutKey, apiRef, onNodeSelect, onNodeMove } = props;
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<ForceGraphMethods<RuntimeNode, RuntimeEdge> | undefined>(undefined);
  const runtime = useRef<RuntimeGraph>(emptyGraph());
  const lastKey = useRef(layoutKey);
  const lastClick = useRef<DoubleClickState>(emptyDoubleClickState());
  const groupDrag = useRef<GroupDragState | null>(null);
  const dragListeners = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null);
  const hoverCursor = useRef<'default' | 'grab' | 'grabbing'>('default');
  const [graph, setGraph] = useState<RuntimeGraph>(emptyGraph);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [systemReduced, setSystemReduced] = useState(false);
  const [visible, setVisible] = useState(true);
  const [settled, setSettled] = useState(false);
  const [interaction, setInteraction] = useState(0);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [Renderer, setRenderer] = useState<ComponentType<ForceGraphProps<RuntimeNode, RuntimeEdge> & { ref?: typeof api }> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const reduced = props.reducedMotion ?? systemReduced;
  const selected = props.selectedNodeId === undefined ? localSelected : props.selectedNodeId;
  const { x = 0, y = 0, width = 1220, height = 660 } = props.view ?? {};

  useEffect(() => {
    let disposed = false;
    // The package can be imported by SSR consumers; only the canvas loads in a browser.
    import('react-force-graph-2d').then(module => {
      if (!disposed) setRenderer(() => module.default);
    }).catch(() => { if (!disposed) setLoadError(true); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const previous = lastKey.current === layoutKey ? runtime.current : emptyGraph();
    lastKey.current = layoutKey;
    runtime.current = reconcile(previous, nodes, edges, props.layoutMode);
    setGraph(runtime.current); setSettled(false);
  }, [nodes, edges, layoutKey, props.layoutMode]);

  useEffect(() => {
    if (!host.current) return;
    const resize = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    resize.observe(host.current);
    let intersecting = true;
    const updateVisibility = () => setVisible(intersecting && !document.hidden);
    const intersection = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; updateVisibility(); });
    intersection.observe(host.current);
    document.addEventListener('visibilitychange', updateVisibility);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setSystemReduced(media.matches);
    updateMotion(); media.addEventListener('change', updateMotion); updateVisibility();
    return () => { resize.disconnect(); intersection.disconnect(); document.removeEventListener('visibilitychange', updateVisibility); media.removeEventListener('change', updateMotion); };
  }, []);

  useEffect(() => {
    if (!Renderer || !api.current) return;
    const force = api.current;
    force.d3Force('center', null);
    force.d3Force('charge')?.strength(props.layoutMode === 'guided' ? 0 : -90);
    force.d3Force('link')?.distance(180).strength(props.layoutMode === 'guided' ? 0 :
      (link: RuntimeEdge) => (link.spec.kind === 'data' || link.spec.kind === 'spawn') ? 0 : 0.025);
    force.d3Force('collision', forceCollide<RuntimeNode>(n => Math.hypot(box(n).w, box(n).h) / 2 + 9).strength(props.layoutMode === 'guided' ? 0 : .85));
    force.d3Force('home', (alpha: number) => {
      for (const n of runtime.current.nodes) {
        if (n.spec.position?.anchored || n.placed) continue;
        n.vx = (n.vx ?? 0) + (n.homeX - n.x) * alpha * (props.layoutMode === 'guided' ? .8 : .09);
        n.vy = (n.vy ?? 0) + (n.homeY - n.y) * alpha * (props.layoutMode === 'guided' ? .8 : .09);
      }
    });
  }, [Renderer, props.layoutMode]);

  useEffect(() => {
    api.current?.centerAt(x, y);
    api.current?.zoom(Math.min(size.width / Math.max(1, width), size.height / Math.max(1, height)));
  }, [Renderer, size.width, size.height, x, y, width, height, layoutKey]);

  useEffect(() => {
    const force = api.current;
    if (!force) return;
    if (!visible) { force.pauseAnimation(); return; }
    force.resumeAnimation();
    if (!settled) return;
    const now = Date.now();
    const running = graph.nodes.some(n => isNodeActive(n.spec, now));
    if (running && !reduced) return;
    const transitions = [...graph.nodes.map(n => n.spec.activity), ...graph.links.map(l => l.spec.activity)];
    const until = transitions.reduce((max, a) => Math.max(max, (a?.enteredAt ?? 0) + 450,
      (a?.removedAt ?? 0) + 1000, (a?.completedAt ?? 0) + 1000, (a?.updatedAt ?? 0) + 850), now);
    const timer = setTimeout(() => force.pauseAnimation(), Math.max(500, until - now + 30));
    return () => clearTimeout(timer);
  }, [Renderer, graph, visible, settled, reduced, selected, interaction]);

  const fitView = (durationMs = reduced ? 0 : 400) => {
    api.current?.resumeAnimation(); api.current?.zoomToFit(durationMs, 85);
    setInteraction(n => n + 1);
  };
  const toImage = async (options?: CaptureOptions): Promise<Blob> => {
    fitView(0);
    await waitOneFrame();
    const source = host.current?.querySelector('canvas');
    if (!source) throw new Error('ActivityGraph.toImage: no canvas to capture (the renderer has not mounted one yet)');
    const captured = renderCapture(source, (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }, options);
    return captureToBlob(captured);
  };
  useImperativeHandle(apiRef, () => ({ fitView, toImage }), [reduced]);
  const select = (node: ActivityNode | null) => {
    setLocalSelected(node?.id ?? null);
    onNodeSelect?.(node as ActivityNode<N> | null);
  };
  const groups = props.groups ?? [];
  const theme = useMemo(() => resolveGraphTheme(props.theme), [props.theme]);

  // Draggable group hulls (guided layout only): clicking and dragging inside a hull's own area,
  // away from any node, moves every member node of that group together, preserving their
  // relative positions. Removes any dangling window listeners if the component unmounts mid-drag.
  useEffect(() => () => {
    if (dragListeners.current) {
      window.removeEventListener('pointermove', dragListeners.current.move);
      window.removeEventListener('pointerup', dragListeners.current.up);
      dragListeners.current = null;
    }
  }, []);

  const screenToGraphPoint = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const convert = api.current?.screen2GraphCoords;
    const canvasEl = host.current?.querySelector('canvas');
    if (!canvasEl || typeof convert !== 'function') return undefined;
    const rect = canvasEl.getBoundingClientRect();
    return convert.call(api.current, clientX - rect.left, clientY - rect.top);
  };

  const groupAtPoint = (point: { x: number; y: number }): { group: ActivityGroup; members: RuntimeNode[] } | undefined => {
    if (groups.length === 0) return undefined;
    const byGroup = groupMembers(runtime.current.nodes, groups);
    // drawGroups renders groups in array order, so a later group's hull paints over an earlier
    // one's where they overlap; hit-testing in reverse matches whichever hull is visually on top.
    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]!;
      const members = byGroup.get(group.id) ?? [];
      if (hitTestGroup(group, members, point)) return { group, members };
    }
    return undefined;
  };

  const setHostCursor = (cursor: 'default' | 'grab' | 'grabbing') => {
    if (hoverCursor.current === cursor) return;
    hoverCursor.current = cursor;
    if (host.current) host.current.style.cursor = cursor === 'default' ? '' : cursor;
  };

  /** Capture-phase pointerdown on the host div: runs before react-force-graph-2d's own native
   * listeners on the inner canvas/container can start their default pan or node-drag. A point
   * that is on a node, or inside no group's hull, is left completely alone -- propagation
   * continues and the library behaves exactly as it does today. */
  const beginGroupDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (props.layoutMode !== 'guided') return;
    // Feature-detected: an older react-force-graph-2d/force-graph build without
    // screen2GraphCoords simply never attaches this behavior.
    if (typeof api.current?.screen2GraphCoords !== 'function') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return; // left button only; right-click keeps its own menu
    const point = screenToGraphPoint(event.clientX, event.clientY);
    if (!point || pointHitsAnyNode(runtime.current.nodes, point)) return;
    const hit = groupAtPoint(point);
    if (!hit) return;

    // The library's own background-click detection listens on 'pointerdown'/'pointerup' on its
    // inner container -- stopping propagation here (before it ever reaches that element) is
    // enough to suppress it. Its pan (d3-zoom) and node-drag (d3-drag) are both driven by native
    // 'mousedown' listeners attached directly to the canvas, a *separate* event dispatched right
    // after this one for the same physical gesture; the onMouseDownCapture handler below stops
    // that half using the `groupDrag` ref this call is about to set.
    event.stopPropagation();

    const state: GroupDragState = {
      pointerId: event.pointerId,
      group: hit.group,
      members: hit.members.map(m => ({ id: m.id, x: m.x, y: m.y })),
      startX: point.x,
      startY: point.y,
      dragging: false,
    };
    groupDrag.current = state;
    api.current?.resumeAnimation(); // the plain onPointerDown handler below never runs for an intercepted gesture
    setHostCursor('grabbing');

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== state.pointerId) return;
      const p = screenToGraphPoint(moveEvent.clientX, moveEvent.clientY);
      if (!p) return;
      const deltaX = p.x - state.startX, deltaY = p.y - state.startY;
      if (!state.dragging && Math.hypot(deltaX, deltaY) > GROUP_DRAG_THRESHOLD) state.dragging = true;
      if (!state.dragging) return;
      for (const member of state.members) {
        const node = runtime.current.nodes.find(n => n.id === member.id);
        if (!node) continue;
        node.x = member.x + deltaX; node.y = member.y + deltaY;
        node.fx = node.x; node.fy = node.y;
      }
    };

    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== state.pointerId) return;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      dragListeners.current = null;
      groupDrag.current = null;
      setHostCursor('default');

      if (!state.dragging) {
        // A plain click on hull-covered background: the library's own onBackgroundClick never
        // fired (its pointerdown was intercepted), so replicate its one visible effect here.
        select(null);
        return;
      }
      const positions: { id: string; x: number; y: number }[] = [];
      for (const member of state.members) {
        const node = runtime.current.nodes.find(n => n.id === member.id);
        if (!node) continue;
        if (node.spec.position?.anchored) {
          // Matches onNodeDragEnd's existing rule exactly: an anchored node snaps back home and
          // never counts as "moved", group drag or not.
          node.x = node.homeX; node.y = node.homeY; node.fx = node.homeX; node.fy = node.homeY;
        } else {
          node.fx = node.x; node.fy = node.y; node.placed = true;
          positions.push({ id: node.id, x: node.x, y: node.y });
          onNodeMove?.(node.spec as ActivityNode<N>, { x: node.x, y: node.y });
        }
      }
      props.onGroupMove?.(state.group, positions);
      setInteraction(i => i + 1);
    };

    dragListeners.current = { move: handleMove, up: handleUp };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  return <div ref={host} className={props.className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...props.style }}
    role="region" tabIndex={0} aria-label={props.ariaLabel ?? 'Activity graph. Arrow keys select nodes; Enter activates the selected node; Escape clears selection; F fits the view.'}
    onPointerDownCapture={beginGroupDrag}
    onMouseDownCapture={event => { if (groupDrag.current) event.stopPropagation(); }}
    onPointerDown={() => { api.current?.resumeAnimation(); }}
    onPointerMove={event => {
      if (groupDrag.current) return; // the window-level listeners above are driving the live drag
      if (props.layoutMode !== 'guided' || typeof api.current?.screen2GraphCoords !== 'function' || event.buttons !== 0) { setHostCursor('default'); return; }
      const point = screenToGraphPoint(event.clientX, event.clientY);
      if (!point || pointHitsAnyNode(runtime.current.nodes, point)) { setHostCursor('default'); return; }
      setHostCursor(groupAtPoint(point) ? 'grab' : 'default');
    }}
    onPointerUp={() => setInteraction(n => n + 1)} onWheel={() => setInteraction(n => n + 1)}
    onKeyDown={event => {
      if (event.key === 'Escape') { select(null); event.preventDefault(); }
      if (event.key.toLowerCase() === 'f') { fitView(); event.preventDefault(); }
      if (event.key === 'Enter' && selected) {
        const node = nodes.find(n => n.id === selected);
        if (node) props.onNodeActivate?.(node);
        event.preventDefault();
      }
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key) && nodes.length) {
        const index = nodes.findIndex(n => n.id === selected), direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        select(nodes[(index + direction + nodes.length) % nodes.length]); event.preventDefault();
      }
    }}>
    {Renderer && <Renderer ref={api} graphData={graph} width={size.width} height={size.height}
      backgroundColor="rgba(0,0,0,0)" nodeCanvasObject={(n, ctx) => drawNode(n, ctx, selected ?? null, reduced, groupAlpha(n, groups), theme)}
      linkCanvasObject={(l, ctx) => drawLink(l, ctx, selected ?? null, reduced, theme)}
      onRenderFramePre={ctx => drawGroups(ctx, groups, runtime.current.nodes, theme)}
      nodeLabel={() => ''} linkLabel={() => ''} autoPauseRedraw={false}
      nodePointerAreaPaint={(n, color, ctx) => { const {w,h} = box(n); ctx.fillStyle = color; ctx.fillRect(n.x-w/2,n.y-h/2,w,h); }}
      onNodeClick={n => {
        select(n.spec);
        const { activated, next } = detectDoubleClick(lastClick.current, n.id, Date.now());
        lastClick.current = next;
        if (activated) props.onNodeActivate?.(n.spec as ActivityNode<N>);
      }} onBackgroundClick={() => select(null)}
      onNodeDragEnd={n => {
        if (n.spec.position?.anchored) { n.fx = n.homeX; n.fy = n.homeY; }
        if (props.layoutMode === 'guided' && !n.spec.position?.anchored) {
          n.fx = n.x; n.fy = n.y; n.placed = true;
        }
        onNodeMove?.(n.spec as ActivityNode<N>, { x: n.spec.position?.anchored ? n.homeX : n.x, y: n.spec.position?.anchored ? n.homeY : n.y });
        setInteraction(i => i + 1);
      }}
      onEngineStop={() => {
        if (props.layoutMode === 'guided') for (const n of runtime.current.nodes) {
          n.fx = n.x; n.fy = n.y; n.placed = true;
        }
        setSettled(true);
      }}
      d3VelocityDecay={.62} d3AlphaDecay={.035} cooldownTicks={reduced ? 1 : 100} minZoom={.25} maxZoom={2.5} />}
    {loadError && <p role="alert">The graph renderer could not be loaded.</p>}
    <span aria-live="polite" style={{ position:'absolute', width:1, height:1, overflow:'hidden', clipPath:'inset(50%)' }}>
      {nodes.find(n => n.id === selected)?.label ?? 'No node selected'}
    </span>
  </div>;
}
