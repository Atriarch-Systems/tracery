import type { CSSProperties, Ref } from 'react';
import type { CaptureOptions } from './capture.js';

/** Presentation contract version, independent of agent transports. */
export const VISUALIZER_CONTRACT_VERSION = 2 as const;
/** Epoch milliseconds. Consumers own activity membership and retention. */
export interface Activity {
  readonly highlighted?: boolean;
  readonly enteredAt?: number;
  readonly updatedAt?: number;
  readonly completedAt?: number;
  readonly removedAt?: number;
}
/** One generic card; consumers own their catalogs of named presets. */
export interface NodePresentation {
  readonly badge?: string;
  readonly icon?: string;
  readonly width?: number;
  readonly height?: number;
  readonly radius?: number;
  /** Six-digit hex color. */
  readonly accent?: string;
}
export interface ActivityNode<Data = unknown> {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly footer?: string;
  readonly status?: 'running' | 'idle' | 'error';
  /** Currently executing; defaults to status === 'running'. Independent of prior errors. */
  readonly active?: boolean;
  /** Optional placement hints; domain catalogs remain in the consumer. */
  readonly layout?: {
    readonly parentId?: string;
    readonly lane?: number;
    readonly group?: string;
    readonly leaf?: boolean;
  };
  readonly presentation?: NodePresentation;
  readonly position?: { readonly x: number; readonly y: number; readonly anchored?: boolean };
  readonly activity?: Activity;
  /** Presentation-only cluster membership; matches `ActivityGraphProps.groups[].id`. Never affects force layout. */
  readonly group?: string;
  readonly data?: Data;
}
export interface ActivityEdge<Data = unknown> {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
  readonly count?: number;
  /** Pixel offset relative to the directed edge. */
  readonly curvature?: number;
  readonly showLabel?: boolean;
  readonly accent?: string;
  /** Defaults to 'call'. 'data' draws dashed and never gains force-link strength or placement parenthood.
   * 'spawn' draws thicker with the accent color and a hollow circle at the source end; also gets force-link strength 0. */
  readonly kind?: 'call' | 'data' | 'spawn';
  readonly activity?: Activity;
  readonly data?: Data;
}
/** A presentation-only cluster drawn as a rounded hull beneath its member nodes. */
export interface ActivityGroup {
  readonly id: string;
  readonly label: string;
  /** Six-digit hex color. */
  readonly accent?: string;
  /** Renders the hull and its member nodes at 45% alpha. */
  readonly dimmed?: boolean;
}
export interface ActivityGraphHandle {
  fitView(durationMs?: number): void;
  /**
   * Renders the current view to a PNG `Blob` (docs/SHARING.md "Image
   * export"): fits the graph, waits a frame, then captures the live canvas
   * onto an offscreen one at `options.scale` (default 2), optionally over an
   * `options.background` fill (the live canvas itself is transparent) and
   * with a small "Tracery" mark in the accent colour (`options.mark`,
   * default `true`). Rejects if the renderer hasn't mounted a canvas yet
   * (nothing to capture) or the browser has no offscreen 2D canvas support.
   */
  toImage(options?: CaptureOptions): Promise<Blob>;
}
export interface ActivityGraphProps<NodeData = unknown, EdgeData = unknown> {
  readonly nodes: readonly ActivityNode<NodeData>[];
  readonly edges: readonly ActivityEdge<EdgeData>[];
  /** Presentation-only clusters; matched against `ActivityNode.group`. Never influences force layout. */
  readonly groups?: readonly ActivityGroup[];
  readonly selectedNodeId?: string | null;
  readonly onNodeSelect?: (node: ActivityNode<NodeData> | null) => void;
  readonly onNodeMove?: (node: ActivityNode<NodeData>, position: { x: number; y: number }) => void;
  /** Fired on double-click of a node (two clicks within 350ms) and on Enter while a node is selected. */
  readonly onNodeActivate?: (node: ActivityNode<NodeData>) => void;
  readonly apiRef?: Ref<ActivityGraphHandle>;
  /** Change to discard layout when switching isolated workspaces. */
  readonly layoutKey?: string;
  readonly view?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Guided layout preserves assigned positions; links do not pull cards together. */
  readonly layoutMode?: 'force' | 'guided';
  readonly reducedMotion?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly ariaLabel?: string;
}
