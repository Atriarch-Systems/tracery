/**
 * SPEC.md §8 acceptance 5, run against a *mocked* hub (PLAN.md workstream E:
 * "if D is not done when you start, develop against `useJournalSource` with
 * the fixture and leave the Playwright test ready to run" -- `apps/hub`,
 * workstream D's server, has no `dist/` yet at the time this was written, so
 * this spec serves the real built UI (`vite preview`) but fakes the hub's
 * WebSocket with core's fixture trace instead of a live server. See
 * `explorer.real-hub.spec.ts` for the same assertions against an actual
 * `@atriarch/tracery-hub` process, which self-skips until that exists.
 */
import { test, expect, type Page } from '@playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleTraceEvents, sampleFlowIds } from '@atriarch/tracery-core/fixtures';

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
  await expect(page.getByTestId('hub-footer')).toContainText('Tracery by Atriarch Systems');
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
  await expect(page.getByTestId('hub-footer')).toContainText('Tracery by Atriarch Systems');
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
  await expect(page.getByText('Tracery', { exact: true })).toBeVisible();
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
  await expect(page.getByText('Tracery', { exact: true })).toBeVisible();
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
  await expect(page.getByText('Tracery', { exact: true })).toBeVisible();
  await expect(page.getByTestId('explorer-crashed')).toHaveCount(0);
  await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);
});

// SPEC.md §7 "SSO (OIDC) for the hosted UI": "the key-entry screen shows a
// 'Sign in with SSO' button when GET /v1/auth/me reports sso is configured".
// No sessionStorage session is primed for either test below -- KeyEntry must
// render on its own, exactly like a first-ever visit.

test('key entry shows a "Sign in with SSO" button when GET /v1/auth/me reports sso configured and licensed', async ({ page }) => {
  await page.route('**/v1/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sso: { configured: true, licensed: true }, authenticated: false }),
    }),
  );
  await page.goto(`${BASE_URL}/ui/`);

  await expect(page.getByTestId('key-entry-form')).toBeVisible();
  const ssoButton = page.getByTestId('sso-login-button');
  await expect(ssoButton).toBeVisible();
  await expect(ssoButton).toHaveAttribute('href', /^\/v1\/auth\/oidc\/login\?returnTo=/);
});

test('key entry has no SSO button when GET /v1/auth/me reports sso not configured', async ({ page }) => {
  await page.route('**/v1/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sso: { configured: false, licensed: false }, authenticated: false }),
    }),
  );
  await page.goto(`${BASE_URL}/ui/`);

  await expect(page.getByTestId('key-entry-form')).toBeVisible();
  await expect(page.getByTestId('sso-login-button')).toHaveCount(0);
});

// A valid session cookie already existing on first load (the common case
// right after the OIDC callback redirects the browser back to `/ui/`) must
// skip KeyEntry entirely, with no API key ever touching sessionStorage.
test('key entry is skipped when GET /v1/auth/me reports an already-authenticated SSO session', async ({ page }) => {
  await page.route('**/v1/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sso: { configured: true, licensed: true },
        authenticated: true,
        user: { sub: 'user-1', email: 'user1@example.com', workspace: 'default', role: 'read' },
      }),
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

  const storedSession = await page.evaluate(() => window.sessionStorage.getItem('atriarch-tracery-hub-session'));
  expect(storedSession).not.toBeNull();
  expect(JSON.parse(storedSession!).apiKey).toBe(''); // no API key -- the cookie alone authenticates every request
});

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
