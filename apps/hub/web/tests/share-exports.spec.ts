/**
 * Image export (docs/SHARING.md "Share as image") and standalone HTML
 * export (docs/SHARING.md "Standalone HTML export") against a real hub --
 * same spawn-a-throwaway-hub pattern as `share.spec.ts`, on its own fixed
 * port. Two hubs: one with API keys (exercises "Download image" and the
 * authenticated "Export .html" path), one in local mode (exercises "Export
 * .html" shown first, since a share link is useless there) -- then the
 * downloaded `.html` file is reopened via `file://` in a brand-new context
 * with no server at all, proving it is genuinely self-contained.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch/tracery-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(__dirname, '../../'); // apps/hub
const hubBin = path.join(hubRoot, 'bin', 'hub.mjs');
const hubDistExists = fs.existsSync(path.join(hubRoot, 'dist')) && fs.existsSync(hubBin);

const PORT = 18975;
const LOCAL_PORT = 18976;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const LOCAL_BASE_URL = `http://127.0.0.1:${LOCAL_PORT}`;
const API_KEY = 'export-e2e-test-key';
const WORKSPACE = 'default';
const FLOW_ID = 'export-e2e-flow';

async function freePortIsAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
  });
}

async function waitForHealthy(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`hub did not become healthy at ${baseUrl}/healthz: ${String(lastError)}`);
}

async function seedFlow(baseUrl: string, apiKey: string | undefined): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      v: ACTIVITY_CONTRACT_VERSION,
      ...(apiKey ? { workspace: WORKSPACE } : {}),
      events: [
        {
          v: ACTIVITY_CONTRACT_VERSION,
          id: 'export-e2e-e1',
          ts: Date.now(),
          flow: FLOW_ID,
          op: 'export-e2e-op',
          node: 'export-e2e-node',
          type: 'start',
          name: 'do-the-thing',
          label: 'Export E2E Flow',
          root: true,
          status: 'success',
        },
        {
          v: ACTIVITY_CONTRACT_VERSION,
          id: 'export-e2e-e2',
          ts: Date.now() + 10,
          flow: FLOW_ID,
          op: 'export-e2e-op',
          node: 'export-e2e-node',
          type: 'end',
          name: 'do-the-thing',
          status: 'success',
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`seeding the fixture flow failed: ${res.status} ${await res.text()}`);
}

test.describe('image and HTML export', () => {
  test.skip(!hubDistExists, 'apps/hub is not built yet (no dist/ or bin/hub.mjs)');

  let hub: ChildProcess | undefined;
  let localHub: ChildProcess | undefined;

  test.beforeAll(async () => {
    await freePortIsAvailable(PORT);
    await freePortIsAvailable(LOCAL_PORT);

    hub = spawn(process.execPath, [hubBin], {
      cwd: hubRoot,
      env: {
        ...process.env,
        TRACERY_PORT: String(PORT),
        TRACERY_API_KEYS: JSON.stringify([{ id: 'e2e', key: API_KEY, workspace: WORKSPACE, roles: ['ingest', 'read', 'admin'] }]),
      },
      stdio: 'pipe',
    });

    const localEnv: NodeJS.ProcessEnv = { ...process.env };
    delete localEnv.TRACERY_API_KEYS;
    delete localEnv.TRACERY_API_KEYS_FILE;
    delete localEnv.TRACERY_HOST;
    delete localEnv.TRACERY_AUTH;
    localEnv.TRACERY_PORT = String(LOCAL_PORT);
    localEnv.TRACERY_STORE = 'memory';
    localEnv.TRACERY_LOG_LEVEL = 'silent';
    localHub = spawn(process.execPath, [hubBin], { cwd: hubRoot, env: localEnv, stdio: 'pipe' });

    await Promise.all([waitForHealthy(BASE_URL), waitForHealthy(LOCAL_BASE_URL)]);
    await Promise.all([seedFlow(BASE_URL, API_KEY), seedFlow(LOCAL_BASE_URL, undefined)]);
  });

  test.afterAll(async () => {
    if (hub && !hub.killed) hub.kill();
    if (localHub && !localHub.killed) localHub.kill();
  });

  test('Download image (header button) saves a non-trivial PNG', async ({ page }) => {
    await page.addInitScript(
      (session) => window.sessionStorage.setItem('atriarch-tracery-hub-session', JSON.stringify(session)),
      { baseUrl: BASE_URL, apiKey: API_KEY, workspace: WORKSPACE },
    );
    await page.goto(`${BASE_URL}/ui/flows/${FLOW_ID}`);
    await expect(page.getByTestId('flow-picker-item')).toHaveCount(1);

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('header-download-image').click();
    const download = await downloadPromise;

    const savePath = path.join(os.tmpdir(), `tracery-e2e-${Date.now()}.png`);
    await download.saveAs(savePath);
    const stat = fs.statSync(savePath);
    expect(stat.size).toBeGreaterThan(1000); // a real rendered PNG, not an empty/error stub
    const header = fs.readFileSync(savePath).subarray(0, 8);
    expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.rmSync(savePath, { force: true });
  });

  test('Export .html appears first in local mode, downloads, and reopens offline via file:// with the graph rendered', async ({ page, browser }) => {
    await page.goto(`${LOCAL_BASE_URL}/ui/flows/${FLOW_ID}`);
    await expect(page.getByTestId('local-mode-badge')).toBeVisible();

    await page.getByTestId('share-button').click();
    await expect(page.getByTestId('share-dialog')).toBeVisible();

    // "shown first when the hub is in local mode": it is the first
    // data-testid button inside the dialog, above the mode/context/expiry form.
    const dialogButtons = page.getByTestId('share-dialog').locator('button');
    await expect(dialogButtons.nth(1)).toHaveAttribute('data-testid', 'export-html-button'); // nth(0) is the "✕" close button

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-html-button').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^tracery-.*\.html$/);

    const savePath = path.join(os.tmpdir(), `tracery-e2e-export-${Date.now()}.html`);
    await download.saveAs(savePath);
    const html = fs.readFileSync(savePath, 'utf8');
    expect(html).toMatch(/id="tracery-data"/);
    expect(html).toMatch(/"label":"Export E2E Flow"/);
    // Fully self-contained: no reference to any file this test didn't ship with the download itself.
    expect(html).not.toMatch(/<script[^>]+src=/);

    // Reopen from disk, in a fresh context, no server involved at all.
    const offlineContext = await browser.newContext();
    const offlinePage = await offlineContext.newPage();
    await offlinePage.goto(pathToFileURL(savePath).toString());

    await expect(offlinePage.getByTestId('share-label')).toHaveText('Export E2E Flow');
    await expect(offlinePage.getByTestId('flow-picker')).toHaveCount(0);
    const nodeItem = offlinePage.getByTestId('node-item').first();
    await expect(nodeItem).toBeVisible();

    await offlineContext.close();
    fs.rmSync(savePath, { force: true });
  });
});
