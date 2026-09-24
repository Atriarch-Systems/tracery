/**
 * SPEC.md §8 acceptance 5, run against a *mocked* hub (PLAN.md workstream E:
 * "if D is not done when you start, develop against `useJournalSource` with
 * the fixture and leave the Playwright test ready to run" -- `apps/hub`,
 * workstream D's server, has no `dist/` yet at the time this was written, so
 * this spec serves the real built UI (`vite preview`) but fakes the hub's
 * WebSocket with core's fixture trace instead of a live server. See
 * `explorer.real-hub.spec.ts` for the same assertions against an actual
 * `@atriarch-systems/tracery-hub` process, which self-skips until that exists.
 */
import { test, expect, type Page } from '@playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleTraceEvents, sampleFlowIds } from '@atriarch-systems/tracery-core/fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const PORT = 4331;
const BASE_URL = `http://localhost:${PORT}`;

const MOCK_SESSION = { baseUrl: 'http://mock-hub.local', apiKey: 'test-key', workspace: 'default' };

// StoredEvent = ActivityEvent + hub bookkeeping (SPEC.md §6). One snapshot
// frame carrying the whole fixture trace is enough to exercise every
// acceptance assertion below without a real server round trip.
const storedEvents = sampleTraceEvents.map((event, index) => ({
  ...event,
  workspace: 'default',
  cursor: index + 1,
  receivedAt: event.ts,
}));
const snapshotFrame = { type: 'snapshot', cursor: storedEvents.length, events: storedEvents, truncated: false };

let server: PreviewServer;

test.beforeAll(async () => {
  server = await preview({ root: webRoot, base: '/ui/', preview: { port: PORT, strictPort: true } });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    const httpServer = server.httpServer;
    if (!httpServer) return resolve();
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

/** Seeds the session (skips the key-entry screen) and installs a mock WebSocket delivering `frame` once, immediately. */
async function primeMockedHubWithFrame(page: Page, frame: unknown, path = '/ui/'): Promise<void> {
  await page.addInitScript(
    ({ session, frame }) => {
      window.sessionStorage.setItem('atriarch-tracery-hub-session', JSON.stringify(session));

      class MockWebSocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readyState = 0;
        url: string;
        constructor(url: string) {
          super();
          this.url = url;
          (window as unknown as { __sendTraceryFrame: (frame: unknown) => void }).__sendTraceryFrame = (next) => {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(next) }));
          };
          setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event('open'));
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
          }, 0);
        }
        send(): void {
          /* the explorer's read-side client never sends over the socket */
        }
        close(): void {
          this.readyState = 3;
          this.dispatchEvent(new Event('close'));
        }
      }

      (window as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    },
    { session: MOCK_SESSION, frame },
  );
  await page.goto(`${BASE_URL}${path}`);
}

/** Seeds the session and installs a mock WebSocket delivering the fixture trace's `snapshotFrame`. */
async function primeMockedHub(page: Page): Promise<void> {
  await primeMockedHubWithFrame(page, snapshotFrame);
}

test('key entry is skipped once a session is stored, and the flow list shows the fixture\'s three flows', async ({ page }) => {
  await primeMockedHub(page);
  await expect(page.getByTestId('key-entry-form')).toHaveCount(0);
  await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);
  await expect(page.getByTestId('header-connection-status')).toHaveText('live');
});

// Funding: the hosted UI's static footer (apps/hub/web/src/Footer.tsx) must
// always render, with the Ko-fi tip-jar link shown since this preview server
// has no /v1/info route at all (fetch fails -> treated as community).
test('the static footer is present with the product name and a Ko-fi link', async ({ page }) => {
  await primeMockedHub(page);
  await expect(page.getByTestId('hub-footer')).toBeVisible();
  await expect(page.getByTestId('hub-footer')).toContainText('Tracery Graph by Atriarch Systems');
  await expect(page.getByTestId('hub-footer-kofi')).toHaveAttribute('href', 'https://ko-fi.com/demonslyr');
});

// Footer now reads `edition` from GET /v1/info (task: "local mode") instead
// of its own separate GET /v1/license call -- a licensed hub gets the
// white-label footer, no Ko-fi link.
test('the footer is white-label (no Ko-fi link) when GET /v1/info reports edition "licensed"', async ({ page }) => {
  await page.route('**/v1/info', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ product: 'tracery', version: '0.1.0', edition: 'licensed', auth: 'keys' }),
    }),
  );
  await primeMockedHub(page);
  await expect(page.getByTestId('hub-footer')).toContainText('Tracery Graph by Atriarch Systems');
  await expect(page.getByTestId('hub-footer-kofi')).toHaveCount(0);
});

test('choosing trace scope shows three groups in the legend', async ({ page }) => {
  await primeMockedHub(page);
  await page.getByTestId('scope-trace').click();
  await expect(page.getByTestId('group-legend-item')).toHaveCount(3);
  const groupIds = await page.getByTestId('group-legend-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-flow-id')));
  expect(groupIds.sort()).toEqual([sampleFlowIds.parent, sampleFlowIds.research1, sampleFlowIds.research2].sort());
});

test('clicking a node shows its context in the inspector', async ({ page }) => {
  await primeMockedHub(page);
  await page.getByTestId('scope-trace').click();
  const parentNode = page.locator(`[data-testid="node-item"][data-group-id="${sampleFlowIds.parent}"]`).first();
  await parentNode.click();
  await expect(page.getByTestId('inspector-op-context').first()).toBeVisible();
  await expect(page.getByTestId('inspector-op-context').first()).toContainText('tokens');
});

test('double-clicking a child group\'s node switches scope to that flow', async ({ page }) => {
  await primeMockedHub(page);
  await page.getByTestId('scope-trace').click();
  const childNode = page.locator(`[data-testid="node-item"][data-group-id="${sampleFlowIds.research1}"]`).first();
  await childNode.dblclick();

  // Activating a child-flow node drills into it: scope resets to "This flow" on that flow.
  await expect(page.getByTestId('scope-flow')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[data-testid="flow-picker-item"][data-flow-id="${sampleFlowIds.research1}"]`)).toHaveAttribute(
    'data-active',
    'true',
  );
});

// Regression (ui-1): `Inspector.formatTs` used to call `new Date(ts).toISOString()`
// with no guard. `validateEvent` only requires `ts` to be a finite number, so
// an out-of-range value (still valid per the wire contract) passes ingest and
// reaches the inspector, where `toISOString()` threw `RangeError` during
// render -- and with no error boundary, unmounted the whole hosted UI.
test('an op with an out-of-range ts does not blank the page when inspected', async ({ page }) => {
  const insaneFlowId = 'flow:insane-ts';
  const insaneEvent = {
    v: 1,
    id: 'evt-insane-01',
    ts: 1e18,
    flow: insaneFlowId,
    op: 'op:insane',
    node: 'llm:insane',
    type: 'start',
    name: 'llm.plan',
    kind: 'llm',
    label: 'Out-of-range timestamp',
    root: true,
    actor: { id: 'agent:insane', kind: 'agent' },
  };
  const events = [...storedEvents, { ...insaneEvent, workspace: 'default', cursor: storedEvents.length + 1, receivedAt: Date.now() }];
  await primeMockedHubWithFrame(page, { type: 'snapshot', cursor: events.length, events, truncated: false });

  await expect(page.getByTestId('header-connection-status')).toHaveText('live');
  await page.locator(`[data-testid="flow-picker-item"][data-flow-id="${insaneFlowId}"]`).click();
  await page.locator('[data-testid="node-item"][data-node-id="llm:insane"]').first().click();

  // The page must still be up (header + flow picker intact), not blanked by a thrown RangeError.
  await expect(page.getByText('Tracery Graph', { exact: true })).toBeVisible();
  await expect(page.getByTestId('explorer-crashed')).toHaveCount(0);
  await expect(page.getByTestId('inspector-op').first()).toBeVisible();
  // formatTs falls back to the raw number for a ts outside Date's range.
  await expect(page.getByTestId('inspector-op').first()).toContainText('1000000000000000000');
});

// Regression (ui-2): a namespaced (trace/ancestors) scope resolves node ids
// as `${actor.id}::${node}`. Two flows sharing an actor and a node id (an
// orchestrator's linked child flow reusing the parent's node names, per the
// finding's repro) collapse onto one id; the visualizer's `reconcile` used to
// throw on that duplicate from inside `ActivityGraph`'s effect, unmounting
// the whole hosted UI the moment "Whole trace" scope was chosen.
test('two flows that collapse onto the same namespaced node id in trace scope do not blank the page', async ({ page }) => {
  const sharedActor = { id: 'agent:dup', kind: 'agent' };
  const parentId = 'flow:dup-parent';
  const childId = 'flow:dup-child';
  const dupEvents = [
    { v: 1, id: 'evt-dup-p1', ts: 1_700_000_100_000, flow: parentId, op: 'op:dup-p', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Dup parent', root: true, actor: sharedActor },
    { v: 1, id: 'evt-dup-c1', ts: 1_700_000_100_500, flow: childId, op: 'op:dup-c', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Dup child', root: true, actor: sharedActor, link: { parentFlow: parentId } },
  ];
  const events = [
    ...storedEvents,
    ...dupEvents.map((event, index) => ({ ...event, workspace: 'default', cursor: storedEvents.length + index + 1, receivedAt: Date.now() })),
  ];
  await primeMockedHubWithFrame(page, { type: 'snapshot', cursor: events.length, events, truncated: false });

  await expect(page.getByTestId('header-connection-status')).toHaveText('live');
  await page.locator(`[data-testid="flow-picker-item"][data-flow-id="${parentId}"]`).click();
  await page.getByTestId('scope-trace').click();

  // The page must still be up: the crash used to happen synchronously on switching to trace scope.
  await expect(page.getByText('Tracery Graph', { exact: true })).toBeVisible();
  await expect(page.getByTestId('explorer-crashed')).toHaveCount(0);
  await expect(page.getByTestId('group-legend-item')).toHaveCount(2);
});

// Regression (ui-11): `parseRoute` called `decodeURIComponent` on the flow/
// trace id segment with no guard. A stray `%` in the path (browsers preserve
// it verbatim in `location.pathname`) throws `URIError`, which -- run from
// `useRoute`'s `popstate` handler (also its `useState` initializer, exercised
// via client-side navigation here rather than an initial HTTP request, since
// `vite preview`'s own static-file middleware -- unrelated to this app --
// independently 500s on a raw "%" in the request path) -- used to blank the
// page instead of degrading gracefully.
test('a malformed deep link (stray "%") reached via client-side navigation does not blank the page', async ({ page }) => {
  await primeMockedHub(page);
  await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);

  await page.evaluate(() => {
    window.history.pushState(null, '', '/ui/flows/%');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  // The id segment fails to decode, so the route falls back to the raw,
  // still-encoded segment as a (non-existent) flow id: no flow matches it,
  // so the explorer shows its normal "nothing selected" state -- not a blank page.
  await expect(page.getByText('Tracery Graph', { exact: true })).toBeVisible();
  await expect(page.getByTestId('explorer-crashed')).toHaveCount(0);
  await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);
});

// Draggable group hulls (packages/visualizer README "Draggable groups"): clicking and dragging
// inside a group's hull, away from any node, moves every member node together in guided layout.
// The graph is canvas-drawn, so there is no DOM to read node positions off directly; these specs
// use two oracles instead, both built entirely on top of already-shipped, already-tested
// behavior rather than any new test-only surface on the graph itself:
//   1. The hull hover-cursor affordance (ActivityGraph sets the host element's own CSS `cursor`
//      to "grab" while the pointer is over a hull's background) is probed via cheap in-page
//      `PointerEvent` dispatches -- no real round trip per probe point -- to *locate* a point
//      that is inside a group's hull and away from any node, and later to confirm the hull's hit
//      area actually followed the drag by the expected screen-space delta.
//   2. `App.tsx`'s onNodeMove/onGroupMove wiring (added alongside this feature -- there was no
//      existing placement-persistence code in this app for either callback to plug into) calls an
//      optional `window.__traceryTestOnNodeMove`/`__traceryTestOnGroupMove` hook when one exists,
//      never writing to the global scope itself. These specs inject that hook via `page.evaluate`
//      before each drag, recording into a plain page-local variable the hook closes over, to
//      confirm the callback contract actually fired with real member data.
// Real, trusted pointer input for the drag itself still goes through `page.mouse`, matching an
// actual click-and-drag as closely as Playwright allows.

/** Dispatches a synthetic, bubbling `pointermove` directly on the explorer's `ActivityGraph`
 * host element and reports whatever CSS cursor value that leaves on it. Cheap (no Playwright
 * round trip), safe to call from a tight in-page loop while probing many candidate points. */
async function cursorAt(page: Page, clientX: number, clientY: number): Promise<string> {
  return page.evaluate(
    ([x, y]) => {
      const host = document.querySelector('[role="region"][aria-label="Tracery Graph hosted explorer"]') as HTMLElement | null;
      if (!host) return '';
      host.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: -1, pointerType: 'mouse', buttons: 0 }));
      return host.style.cursor;
    },
    [clientX, clientY] as const,
  );
}

/** Grid-scans the canvas (in a single in-page pass) for a point whose hover cursor is "grab":
 * inside some group's hull, away from every node -- exactly the area a group drag starts from.
 * Retries a few times (`expect.poll`-style) since the guided layout's first fit is staggered
 * (0/200/600ms retries in ActivityExplorer) and the very first probe can land before it settles. */
async function findHullBackgroundPoint(page: Page): Promise<{ x: number; y: number }> {
  // ActivityExplorer's first-fit effect re-centers/re-zooms the graph at 0/200/600ms after the
  // first scope with nodes appears (see its own comment: "a couple of cheap, short retries cover
  // that race"); probing before the last of those lands would find a point the graph then moves
  // out from under before the real drag below acts on it.
  await page.waitForTimeout(750);
  for (let attempt = 0; attempt < 20; attempt++) {
    const point = await page.evaluate(() => {
      const host = document.querySelector('[role="region"][aria-label="Tracery Graph hosted explorer"]') as HTMLElement | null;
      const canvas = host?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!host || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      for (let gy = 4; gy < rect.height; gy += 6) {
        for (let gx = 4; gx < rect.width; gx += 6) {
          const clientX = Math.round(rect.left + gx), clientY = Math.round(rect.top + gy);
          host.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, bubbles: true, cancelable: true, pointerId: -1, pointerType: 'mouse', buttons: 0 }));
          if (host.style.cursor === 'grab') return { x: clientX, y: clientY };
        }
      }
      return null;
    });
    if (point) return point;
    await page.waitForTimeout(150);
  }
  throw new Error('findHullBackgroundPoint: no grab-cursor (hull background) point found on the canvas after retrying');
}

test('dragging inside a group hull, away from any node, moves every member together', async ({ page }) => {
  await primeMockedHub(page);
  await page.getByTestId('scope-trace').click();

  const start = await findHullBackgroundPoint(page);
  const dx = 70, dy = 45;
  await page.evaluate(() => {
    (window as unknown as { __traceryTestOnGroupMove?: unknown; __traceryLastGroupMove?: unknown }).__traceryLastGroupMove = undefined;
    (window as unknown as { __traceryTestOnGroupMove?: (move: unknown) => void }).__traceryTestOnGroupMove = (move: unknown) => {
      (window as unknown as { __traceryLastGroupMove?: unknown }).__traceryLastGroupMove = move;
    };
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 12 });
  await page.mouse.up();

  const groupMove = await page.evaluate(() => (window as unknown as { __traceryLastGroupMove?: { groupId: string; positions: { id: string; x: number; y: number }[] } }).__traceryLastGroupMove);
  expect(groupMove, 'onGroupMove must have fired with the dragged group and its members').toBeTruthy();
  expect(groupMove!.positions.length).toBeGreaterThan(0);

  // The hull's own hit area -- recomputed live from the members' now-mutated positions, the same
  // geometry hitTestGroup/drawGroupHull share -- must have followed the pointer: the drag's
  // start point is no longer inside a hull, and the shifted point now is.
  expect(await cursorAt(page, start.x, start.y)).not.toBe('grab');
  expect(await cursorAt(page, start.x + dx, start.y + dy)).toBe('grab');
});

test('ancestor group positions survive streamed updates, follow-latest switches, and leaving the scope', async ({ page }) => {
  await primeMockedHubWithFrame(page, { ...snapshotFrame, events: storedEvents.filter(e => e.id === 'evt-p-01' || e.id === 'evt-r2-01') });
  await page.getByTestId('scope-trace').click();
  // Let initial framing finish before switching scope, which uses the default viewport.
  await findHullBackgroundPoint(page);
  await page.getByTestId('scope-ancestors').click();
  const start = await findHullBackgroundPoint(page);
  await page.evaluate(() => {
    (window as unknown as { __traceryTestOnGroupMove: (move: unknown) => void }).__traceryTestOnGroupMove = (move) => {
      (window as unknown as { __lastMove: unknown }).__lastMove = move;
    };
  });
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 12 });
    await page.mouse.up();
  };
  const lastMove = () => page.evaluate(() => (window as unknown as {
    __lastMove: { groupId: string; positions: { id: string; x: number; y: number }[] };
  }).__lastMove);
  await drag(start.x, start.y, 70, 45);
  const moved = await lastMove();
  expect(moved.positions.length).toBeGreaterThan(0);
  const selectedFlow = await page.locator('[data-testid="flow-picker-item"][data-active="true"]').getAttribute('data-flow-id');
  const send = async (event: object, cursor: number) => page.evaluate(({ event, cursor }) => {
    (window as unknown as { __sendTraceryFrame: (frame: unknown) => void }).__sendTraceryFrame({
      type: 'events', cursor, events: [{ ...event, cursor, workspace: 'default', receivedAt: Date.now() }],
    });
  }, { event, cursor });
  // A status-only update, followed by a new descendant: Follow latest switches the layout key,
  // while both existing ancestor groups remain part of the projection.
  const ts = 1_700_000_100_000;
  await send({ v: 1, id: 'drag-update', ts, flow: selectedFlow, op: 'drag-op', node: 'llm:main', type: 'annotate', name: 'drag.check' }, storedEvents.length + 1);
  await expect.poll(() => cursorAt(page, start.x + 70, start.y + 45)).toBe('grab');
  await send({ v: 1, id: 'drag-child', ts: ts + 1, flow: 'drag-child', op: 'drag-child-op', node: 'new-node', type: 'start', name: 'new.child', root: true,
    actor: { id: 'drag-child-actor' }, link: { parentFlow: selectedFlow } }, storedEvents.length + 2);
  await expect(page.locator('[data-testid="flow-picker-item"][data-flow-id="drag-child"]')).toHaveAttribute('data-active', 'true');
  await expect.poll(() => cursorAt(page, start.x + 70, start.y + 45)).toBe('grab');
  // A node's position must survive even when a scope temporarily omits it.
  await page.getByTestId('scope-flow').click();
  await page.getByTestId('scope-ancestors').click();
  await expect.poll(() => cursorAt(page, start.x + 70, start.y + 45)).toBe('grab');
  // Scope changes resize the canvas as the accessible node list changes height.
  // Record the actual pointer-to-graph displacement: assuming a fixed viewport
  // mistakes a late ResizeObserver/recentering frame for a lost node position.
  await page.locator('[role="region"][aria-label="Tracery Graph hosted explorer"]').evaluate(el => {
    const canvas = el.querySelector('canvas') as HTMLCanvasElement & { __zoom: { x: number; y: number; k: number } };
    const points = { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } };
    (window as unknown as { __dragPoints: typeof points }).__dragPoints = points;
    const record = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const transform = canvas.__zoom; // d3's live canvas transform, used by screen2GraphCoords
      const point = { x: (event.clientX - rect.left - transform.x) / transform.k, y: (event.clientY - rect.top - transform.y) / transform.k };
      if (event.type === 'pointerdown') points.start = point;
      else points.end = point;
    };
    window.addEventListener('pointerdown', record, { capture: true, once: true });
    window.addEventListener('pointermove', record, true);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', record, true), { capture: true, once: true });
  });
  await drag(start.x + 70, start.y + 45, 10, 10);
  const again = await lastMove();
  const delta = await page.evaluate(() => {
    const { start, end } = (window as unknown as { __dragPoints: { start: { x: number; y: number }; end: { x: number; y: number } } }).__dragPoints;
    return { x: end.x - start.x, y: end.y - start.y };
  });
  expect(again.groupId).toBe(moved.groupId);
  expect(again.positions.length).toBe(moved.positions.length);
  for (const before of moved.positions) {
    const after = again.positions.find(p => p.id === before.id)!;
    expect(after.x).toBeCloseTo(before.x + delta.x, 3);
    expect(after.y).toBeCloseTo(before.y + delta.y, 3);
  }
});

test('a plain click (no movement) inside a hull\'s empty area still deselects the current node', async ({ page }) => {
  await primeMockedHub(page);
  await page.getByTestId('scope-trace').click();

  const parentNode = page.locator(`[data-testid="node-item"][data-group-id="${sampleFlowIds.parent}"]`).first();
  await parentNode.click();
  await expect(page.getByTestId('inspector-op-context').first()).toBeVisible();

  const point = await findHullBackgroundPoint(page);
  await page.mouse.click(point.x, point.y); // mousedown+mouseup at the same coordinates -- never crosses the drag threshold

  await expect(page.getByTestId('inspector-op-context')).toHaveCount(0);
});

/**
 * Locates a node card's own screen position using the same cheap in-page cursor probe as
 * `findHullBackgroundPoint`, but inverted: a node card is a "hole" in its group's hull, so it
 * reads back a "default" cursor at the candidate point itself while a "grab" cursor shows up a
 * short distance to the left and right of it (still inside the same hull's padded background).
 * That combination is specific enough not to also match open space entirely outside any hull
 * (which reads "default" with no nearby "grab" on either side).
 */
async function findNodeInteriorPoint(page: Page): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const point = await page.evaluate(() => {
      const host = document.querySelector('[role="region"][aria-label="Tracery Graph hosted explorer"]') as HTMLElement | null;
      const canvas = host?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!host || !canvas) return null;
      const cursorAtLocal = (clientX: number, clientY: number) => {
        host.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, bubbles: true, cancelable: true, pointerId: -1, pointerType: 'mouse', buttons: 0 }));
        return host.style.cursor;
      };
      const rect = canvas.getBoundingClientRect();
      // ActivityGraph's setHostCursor stores its "default" state as an empty string (it only ever
      // writes '' | 'grab' | 'grabbing' to host.style.cursor), never the literal word "default".
      const reach = 90; // past a default card's own half-width (69) plus HULL_PAD (28), short of a neighboring card
      for (let gy = 8; gy < rect.height; gy += 8) {
        for (let gx = 8; gx < rect.width; gx += 8) {
          const clientX = Math.round(rect.left + gx), clientY = Math.round(rect.top + gy);
          if (cursorAtLocal(clientX, clientY) !== '') continue;
          const left = cursorAtLocal(clientX - reach, clientY) === 'grab';
          const right = cursorAtLocal(clientX + reach, clientY) === 'grab';
          if (left && right) return { x: clientX, y: clientY };
        }
      }
      return null;
    });
    if (point) return point;
    await page.waitForTimeout(150);
  }
  throw new Error('findNodeInteriorPoint: no node-card point found on the canvas after retrying');
}

test('an individual node inside a group can still be dragged independently after a group drag', async ({ page }) => {
  await primeMockedHub(page);
  await page.getByTestId('scope-trace').click();

  // One whole-group drag first, exactly like the first test above, to prove the two interactions
  // don't leave any stuck state (e.g. a dangling window listener) behind for each other.
  const hullPoint = await findHullBackgroundPoint(page);
  await page.mouse.move(hullPoint.x, hullPoint.y);
  await page.mouse.down();
  await page.mouse.move(hullPoint.x + 40, hullPoint.y + 25, { steps: 8 });
  await page.mouse.up();

  // Locate a node's on-canvas position *after* the group drag (it may have carried this node
  // along, if it belonged to the dragged group, so its position is only meaningful post-drag).
  const nodePoint = await findNodeInteriorPoint(page);

  await page.evaluate(() => {
    (window as unknown as { __traceryTestOnNodeMove?: unknown; __traceryLastNodeMove?: unknown }).__traceryLastNodeMove = undefined;
    (window as unknown as { __traceryTestOnNodeMove?: (move: unknown) => void }).__traceryTestOnNodeMove = (move: unknown) => {
      (window as unknown as { __traceryLastNodeMove?: unknown }).__traceryLastNodeMove = move;
    };
  });
  await page.mouse.move(nodePoint.x, nodePoint.y);
  await page.mouse.down();
  await page.mouse.move(nodePoint.x + 35, nodePoint.y + 15, { steps: 8 });
  await page.mouse.up();

  const nodeMove = await page.evaluate(() => (window as unknown as { __traceryLastNodeMove?: { id: string; x: number; y: number } }).__traceryLastNodeMove);
  expect(nodeMove, 'the library\'s own individual node drag must still report onNodeMove after a prior group drag').toBeTruthy();
});

// SPEC.md §7 "Extensions and Tracery Cloud": the SSO-button-seam Playwright
// tests that used to live here (KeyEntry showing/hiding "Sign in with SSO"
// per a mocked GET /v1/auth/me, and skipping KeyEntry for an
// already-authenticated session) now live in the private `tracery-cloud`
// repository, alongside the extensions module (Tracery Cloud's OIDC SSO)
// that actually implements `/v1/auth/*` -- see
// `tracery-cloud/hub-ee/web-tests/sso-button.spec.ts` and its README. This
// package's own `KeyEntry`/`App.tsx` seam (rendering the button based on
// whatever `GET /v1/auth/me` reports, or nothing when no extensions module
// registers that route at all) is otherwise unchanged and untested by this
// file on purpose, to keep this repository's test suite independent of any
// particular extensions module's shape.

// Task ("local mode"): GET /v1/info reporting `auth: 'none'` must skip
// KeyEntry entirely and connect with no API key -- checked ahead of, and
// independent of, the SSO check above. No sessionStorage session is primed:
// KeyEntry must never even flash before the auto-connect happens.
test('GET /v1/info reporting auth "none" skips key entry, connects with no API key, and shows the local-mode badge', async ({ page }) => {
  await page.route('**/v1/info', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ product: 'tracery', version: '0.1.0', edition: 'community', auth: 'none', workspace: 'default' }),
    }),
  );
  await page.addInitScript(({ frame }) => {
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 0;
      constructor(_url: string) {
        super();
        setTimeout(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
        }, 0);
      }
      send(): void {}
      close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
      }
    }
    (window as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  }, { frame: snapshotFrame });
  await page.goto(`${BASE_URL}/ui/`);

  await expect(page.getByTestId('key-entry-form')).toHaveCount(0);
  await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);
  await expect(page.getByTestId('local-mode-badge')).toBeVisible();

  const storedSession = await page.evaluate(() => window.sessionStorage.getItem('atriarch-tracery-hub-session'));
  expect(storedSession).not.toBeNull();
  const parsed = JSON.parse(storedSession!);
  expect(parsed.apiKey).toBe('');
  expect(parsed.local).toBe(true);
  expect(parsed.workspace).toBe('default');
});

// Theming (task: settings UI): the gear button in the explorer header opens
// a panel with a preset picker (`@atriarch-systems/tracery-react`'s `PRESET_NAMES`);
// switching presets must actually repaint the explorer (checked here via the
// `--tracery-accent` CSS custom property on the explorer's root element,
// which `ActivityExplorer`'s `rootStyle` sets from the resolved theme) and
// persist under the documented `tracery.theme` localStorage key so a reload
// keeps the choice.
async function accentOf(page: Page): Promise<string> {
  const value = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Tracery Graph hosted explorer"]');
    return el ? getComputedStyle(el).getPropertyValue('--tracery-accent').trim() : null;
  });
  if (value === null) throw new Error('explorer root element not found');
  return value;
}

test('the theme settings panel switches presets, repaints the explorer, and persists across a reload', async ({ page }) => {
  await primeMockedHub(page);

  const darkAccent = await accentOf(page);

  await page.getByTestId('theme-settings-button').click();
  await expect(page.getByTestId('theme-settings-panel')).toBeVisible();
  await page.getByTestId('theme-preset-select').selectOption('ocean');

  const oceanAccent = await accentOf(page);
  expect(oceanAccent).not.toBe(darkAccent);
  expect(oceanAccent.toLowerCase()).toBe('#3fc6ff');

  const stored = await page.evaluate(() => window.localStorage.getItem('tracery.theme'));
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored!)).toEqual({ preset: 'ocean' });

  await page.reload();
  await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);
  expect(await accentOf(page)).toBe(oceanAccent);
  await expect(page.getByTestId('theme-preset-select')).toHaveCount(0); // panel closes on navigation/reload, not sticky open
});

test('a color override persists alongside the preset and "Reset to preset" clears it', async ({ page }) => {
  await primeMockedHub(page);

  await page.getByTestId('theme-settings-button').click();
  await page.getByTestId('theme-color-accent').fill('#ff00ff');

  expect(await accentOf(page)).toBe('#ff00ff');
  let stored = JSON.parse((await page.evaluate(() => window.localStorage.getItem('tracery.theme')))!);
  expect(stored).toEqual({ preset: 'dark', overrides: { accent: '#ff00ff' } });

  await page.getByTestId('theme-reset').click();
  const darkAccent = await accentOf(page);
  expect(darkAccent).not.toBe('#ff00ff');
  stored = JSON.parse((await page.evaluate(() => window.localStorage.getItem('tracery.theme')))!);
  expect(stored).toEqual({ preset: 'dark' });
});
