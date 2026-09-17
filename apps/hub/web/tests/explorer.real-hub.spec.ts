/**
 * SPEC.md §8 acceptance 5, run against a real `@atriarch/tracery-hub`
 * (workstream D, `apps/hub`) serving this app's built UI at `/ui` -- the
 * scenario `explorer.mocked.spec.ts` fakes with a WebSocket mock. This spec
 * self-skips (the whole `describe` block) until `apps/hub/dist` and
 * `apps/hub/bin/hub.mjs` exist, since workstream D had not shipped a
 * buildable server yet when this was written (PLAN.md workstream E: "if D is
 * not done when you start ... leave the Playwright test ready to run").
 *
 * Once `apps/hub` builds, running `npm run build` at the repo root (which
 * builds `apps/hub/web` first, then `apps/hub`, in workspace dependency
 * order) followed by `npm test` here runs this for real: no code changes
 * needed, it starts detecting `dist/` + `bin/hub.mjs` on its own -- that
 * spawns a throwaway local hub on a fixed test port.
 *
 * SPEC.md §8 acceptance 5 also asks this to run "against the running
 * container" from acceptance step 3. Set `TRACERY_HUB_URL` (and
 * `TRACERY_API_KEY`, needing `ingest`+`read`+`admin` -- the dev key printed
 * in `docker logs` has all three) to point this spec at any already-running
 * hub -- a Docker container, or otherwise -- instead of spawning a local
 * one; it seeds the same fixture trace there and skips the spawn/kill of a
 * child process. The target hub's workspace should be empty (or at least
 * free of any other data in workspace "default") before this runs, since
 * these tests assert exact counts (e.g. "the flow list shows three flows").
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleTraceEvents, sampleFlowIds } from '@atriarch/tracery-core/fixtures';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch/tracery-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(__dirname, '../../'); // apps/hub
const hubBin = path.join(hubRoot, 'bin', 'hub.mjs');
const hubDistExists = fs.existsSync(path.join(hubRoot, 'dist')) && fs.existsSync(hubBin);

const EXTERNAL_HUB_URL = process.env.TRACERY_HUB_URL?.trim();
const EXTERNAL_API_KEY = process.env.TRACERY_API_KEY?.trim();
const useExternalHub = Boolean(EXTERNAL_HUB_URL && EXTERNAL_API_KEY);

const PORT = 18971;
const BASE_URL = useExternalHub ? EXTERNAL_HUB_URL!.replace(/\/+$/, '') : `http://127.0.0.1:${PORT}`;
const API_KEY = useExternalHub ? EXTERNAL_API_KEY! : 'e2e-test-key';
const WORKSPACE = 'default';

async function waitForHealthy(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`hub did not become healthy at ${BASE_URL}/healthz: ${String(lastError)}`);
}

async function seedFixtureTrace(): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ v: ACTIVITY_CONTRACT_VERSION, workspace: WORKSPACE, events: sampleTraceEvents }),
  });
  if (!res.ok) throw new Error(`seeding fixture events failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { accepted: number };
  if (body.accepted !== sampleTraceEvents.length) {
    throw new Error(`expected all ${sampleTraceEvents.length} fixture events accepted, got ${body.accepted}`);
  }
}

async function primeSession(page: Page): Promise<void> {
  await page.addInitScript(
    (session) => window.sessionStorage.setItem('atriarch-tracery-hub-session', JSON.stringify(session)),
    { baseUrl: BASE_URL, apiKey: API_KEY, workspace: WORKSPACE },
  );
  await page.goto(`${BASE_URL}/ui/`);
}

test.describe('real hub', () => {
  test.skip(
    !useExternalHub && !hubDistExists,
    'apps/hub is not built yet (no dist/ or bin/hub.mjs) -- this spec runs once workstream D ships it, or point it at an already-running hub with TRACERY_HUB_URL/TRACERY_API_KEY',
  );

  let hub: ChildProcess | undefined;

  test.beforeAll(async () => {
    if (useExternalHub) {
      console.log(`explorer.real-hub.spec.ts: targeting external hub at ${BASE_URL} (TRACERY_HUB_URL set)`);
    } else {
      hub = spawn(process.execPath, [hubBin], {
        cwd: hubRoot,
        env: {
          ...process.env,
          TRACERY_PORT: String(PORT),
          TRACERY_API_KEYS: JSON.stringify([{ id: 'e2e', key: API_KEY, workspace: WORKSPACE, roles: ['ingest', 'read', 'admin'] }]),
        },
        stdio: 'pipe',
      });
    }
    await waitForHealthy();
    await seedFixtureTrace();
  });

  test.afterAll(async () => {
    if (hub && !hub.killed) hub.kill();
  });

  test('the hub serves the built UI at /ui and the flow list shows three flows', async ({ page }) => {
    await primeSession(page);
    await expect(page.getByTestId('key-entry-form')).toHaveCount(0);
    await expect(page.getByTestId('flow-picker-item')).toHaveCount(3);
  });

  test('choosing trace scope shows three groups in the legend', async ({ page }) => {
    await primeSession(page);
    await page.getByTestId('scope-trace').click();
    await expect(page.getByTestId('group-legend-item')).toHaveCount(3);
  });

  test('clicking a node shows its context in the inspector', async ({ page }) => {
    await primeSession(page);
    await page.getByTestId('scope-trace').click();
    const parentNode = page.locator(`[data-testid="node-item"][data-group-id="${sampleFlowIds.parent}"]`).first();
    await parentNode.click();
    await expect(page.getByTestId('inspector-op-context').first()).toBeVisible();
  });

  test('double-clicking a child group\'s node switches scope to that flow', async ({ page }) => {
    await primeSession(page);
    await page.getByTestId('scope-trace').click();
    const childNode = page.locator(`[data-testid="node-item"][data-group-id="${sampleFlowIds.research1}"]`).first();
    await childNode.dblclick();
    await expect(page.getByTestId('scope-flow')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`[data-testid="flow-picker-item"][data-flow-id="${sampleFlowIds.research1}"]`)).toHaveAttribute(
      'data-active',
      'true',
    );
  });
});
