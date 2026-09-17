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

/** Seeds the session (skips the key-entry screen) and installs a mock WebSocket delivering `snapshotFrame` once, immediately. */
async function primeMockedHub(page: Page): Promise<void> {
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
    { session: MOCK_SESSION, frame: snapshotFrame },
  );
  await page.goto(`${BASE_URL}/ui/`);
}

test('key entry is skipped once a session is stored, and the flow list shows the fixture\'s three flows', async ({ page }) => {
  await primeMockedHub(page);
  await expect(page.getByTestId('key-entry-form')).toHaveCount(0);
  await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);
  await expect(page.getByTestId('header-connection-status')).toHaveText('live');
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
