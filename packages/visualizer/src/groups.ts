import { box, type RuntimeNode } from './model.js';
import type { ActivityGroup } from './types.js';

type Point = { x: number; y: number };

const HULL_PAD = 28;
const HULL_RADIUS = 16;

const hex = (color: string | undefined, fallback = '#8bb971') => /^#[0-9a-f]{6}$/i.test(color ?? '') ? color! : fallback;
const rgb = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));

/** Members currently on the graph for each configured group, keyed by group id. Groups with no
 * live members are omitted; membership never feeds back into layout. */
export function groupMembers(nodes: readonly RuntimeNode[], groups: readonly ActivityGroup[]): Map<string, RuntimeNode[]> {
  const byGroup = new Map<string, RuntimeNode[]>();
  const known = new Set(groups.map(g => g.id));
  for (const node of nodes) {
    const id = node.spec.group;
    if (id === undefined || !known.has(id)) continue;
    const list = byGroup.get(id);
    if (list) list.push(node); else byGroup.set(id, [node]);
  }
  return byGroup;
}

/** Andrew's monotone-chain convex hull. Input order is irrelevant; output is counter-clockwise. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return [...lower, ...upper];
}

/** Traces a rounded polygon path (Canvas 2D `arcTo` trick) into the current path. Assumes a
 * convex, counter-clockwise `points` list with at least 3 vertices. */
function roundedPolygonPath(ctx: CanvasRenderingContext2D, points: readonly Point[], radius: number) {
  const n = points.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]!, cur = points[i]!, next = points[(i + 1) % n]!;
    const v1x = prev.x - cur.x, v1y = prev.y - cur.y, len1 = Math.hypot(v1x, v1y) || 1;
    const v2x = next.x - cur.x, v2y = next.y - cur.y, len2 = Math.hypot(v2x, v2y) || 1;
    const r = Math.min(radius, len1 / 2, len2 / 2);
    const a1 = { x: cur.x + (v1x / len1) * r, y: cur.y + (v1y / len1) * r };
    const a2 = { x: cur.x + (v2x / len2) * r, y: cur.y + (v2y / len2) * r };
    if (i === 0) ctx.moveTo(a1.x, a1.y); else ctx.lineTo(a1.x, a1.y);
    ctx.arcTo(cur.x, cur.y, a2.x, a2.y, r);
  }
  ctx.closePath();
}

/** Padded corners of a node's card box, used as hull input so the hull clears the cards. */
const paddedCorners = (node: RuntimeNode): Point[] => {
  const { w, h } = box(node);
  const x0 = node.x - w / 2 - HULL_PAD, x1 = node.x + w / 2 + HULL_PAD;
  const y0 = node.y - h / 2 - HULL_PAD, y1 = node.y + h / 2 + HULL_PAD;
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
};

/** Draws one group's hull (filled at low alpha, stroked faintly) and its label. One and two
 * member groups use a padded, rounded bounding rectangle (a proper hull looks like a sliver at
 * that size); three or more members get a rounded convex hull around the padded card corners. */
export function drawGroupHull(ctx: CanvasRenderingContext2D, group: ActivityGroup, members: readonly RuntimeNode[]) {
  if (members.length === 0) return;
  const color = hex(group.accent);
  const [r, g, b] = rgb(color);
  let labelX: number, labelY: number;
  ctx.save();
  ctx.globalAlpha = group.dimmed ? 0.45 : 1;
  ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.35)`;
  ctx.lineWidth = 1;
  if (members.length <= 2) {
    const boxes = members.map(n => ({ n, ...box(n) }));
    const x0 = Math.min(...boxes.map(({ n, w }) => n.x - w / 2)) - HULL_PAD;
    const x1 = Math.max(...boxes.map(({ n, w }) => n.x + w / 2)) + HULL_PAD;
    const y0 = Math.min(...boxes.map(({ n, h }) => n.y - h / 2)) - HULL_PAD;
    const y1 = Math.max(...boxes.map(({ n, h }) => n.y + h / 2)) + HULL_PAD;
    ctx.beginPath();
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, HULL_RADIUS);
    ctx.fill(); ctx.stroke();
    labelX = x0 + 10; labelY = y0 + 12;
  } else {
    const hull = convexHull(members.flatMap(paddedCorners));
    roundedPolygonPath(ctx, hull, HULL_RADIUS);
    ctx.fill(); ctx.stroke();
    labelX = Math.min(...hull.map(p => p.x)) + 10;
    labelY = Math.min(...hull.map(p => p.y)) + 12;
  }
  ctx.font = '10px system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
  ctx.fillText(group.label, labelX, labelY);
  ctx.restore();
}

/** Draws every configured group with live members, beneath the nodes. Call from
 * `onRenderFramePre` so hulls land under the node/link canvas objects. */
export function drawGroups(ctx: CanvasRenderingContext2D, groups: readonly ActivityGroup[], nodes: readonly RuntimeNode[]) {
  if (groups.length === 0) return;
  const members = groupMembers(nodes, groups);
  for (const group of groups) drawGroupHull(ctx, group, members.get(group.id) ?? []);
}

/** Per-node alpha multiplier so a dimmed group's member cards render at 45% alpha too. */
export function groupAlpha(node: RuntimeNode, groups: readonly ActivityGroup[]): number {
  const id = node.spec.group;
  if (id === undefined) return 1;
  const group = groups.find(g => g.id === id);
  return group?.dimmed ? 0.45 : 1;
}
