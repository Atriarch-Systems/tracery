/**
 * Sharing end-to-end (docs/SHARING.md), against a real hub -- same
 * spawn-a-throwaway-hub pattern as `explorer.real-hub.spec.ts`, on its own
 * fixed port so the two specs never collide even though the config runs
 * with `workers: 1`.
 *
 * Covers: creating a share through the UI (with context hidden), opening
 * `/s/<token>` in a completely fresh, unauthenticated browser context and
 * seeing the graph plus the "Context hidden by the sharer" notice, then
 * revoking it through the "Manage shares" list and confirming the share
 * page now 404s.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch/tracery-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(__dirname, '../../'); // apps/hub
const hubBin = path.join(hubRoot, 'bin', 'hub.mjs');
const hubDistExists = fs.existsSync(path.join(hubRoot, 'dist')) && fs.existsSync(hubBin);

const PORT = 18973;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_KEY = 'share-e2e-test-key';
const WORKSPACE = 'default';
const FLOW_ID = 'share-e2e-flow';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      srv.close((err) => (err || port === undefined ? reject(err ?? new Error('no port')) : resolve(port)));
    });
    srv.on('error', reject);
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

async function seedFlow(): Promise<void> {
  const res = await fetch(`${BASE_URL}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      v: ACTIVITY_CONTRACT_VERSION,
      workspace: WORKSPACE,
      events: [
        {
          v: ACTIVITY_CONTRACT_VERSION,
          id: 'share-e2e-e1',
          ts: Date.now(),
          flow: FLOW_ID,
          op: 'share-e2e-op',
          node: 'share-e2e-node',
          type: 'start',
          name: 'do-the-thing',
          label: 'Share E2E Flow',
          root: true,
          status: 'success',
          context: { secretNote: 'this must never reach the shared viewer' },
        },
        {
          v: ACTIVITY_CONTRACT_VERSION,
          id: 'share-e2e-e2',
          ts: Date.now() + 10,
          flow: FLOW_ID,
          op: 'share-e2e-op',
          node: 'share-e2e-node',
          type: 'end',
          name: 'do-the-thing',
          status: 'success',
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`seeding the fixture flow failed: ${res.status} ${await res.text()}`);
}

async function primeSession(page: Page): Promise<void> {
  await page.addInitScript(
    (session) => window.sessionStorage.setItem('atriarch-tracery-hub-session', JSON.stringify(session)),
    { baseUrl: BASE_URL, apiKey: API_KEY, workspace: WORKSPACE },
  );
}

test.describe('sharing', () => {
  test.skip(!hubDistExists, 'apps/hub is not built yet (no dist/ or bin/hub.mjs)');

  let hub: ChildProcess | undefined;

  test.beforeAll(async () => {
    hub = spawn(process.execPath, [hubBin], {
      cwd: hubRoot,
      env: {
        ...process.env,
        TRACERY_PORT: String(PORT),
        TRACERY_API_KEYS: JSON.stringify([{ id: 'e2e', key: API_KEY, workspace: WORKSPACE, roles: ['ingest', 'read', 'admin'] }]),
      },
      stdio: 'pipe',
    });
    await waitForHealthy(BASE_URL);
    await seedFlow();
  });

  test.afterAll(async () => {
    if (hub && !hub.killed) hub.kill();
  });

  test('create a share with context hidden, open it unauthenticated, see the graph and the redaction notice, then revoke it and see a 404', async ({ browser }) => {
    // --- Step 1: create the share through the UI, as an authenticated key holder. ---
    const authedContext = await browser.newContext();
    const authedPage = await authedContext.newPage();
    await primeSession(authedPage);
    await authedPage.goto(`${BASE_URL}/ui/flows/${FLOW_ID}`);

    await expect(authedPage.getByTestId('share-button')).toBeVisible();
    await authedPage.getByTestId('share-button').click();
    await expect(authedPage.getByTestId('share-dialog')).toBeVisible();

    // Hide context (the default is already unchecked/off, but be explicit
    // and resilient to that default ever changing).
    const includeContextCheckbox = authedPage.getByTestId('share-include-context');
    if (await includeContextCheckbox.isChecked()) await includeContextCheckbox.uncheck();

    await authedPage.getByTestId('create-share-button').click();
    const shareUrlInput = authedPage.getByTestId('share-url');
    await expect(shareUrlInput).toBeVisible({ timeout: 10_000 });
    const shareUrl = await shareUrlInput.inputValue();
    expect(shareUrl).toMatch(new RegExp(`^${BASE_URL}/s/[A-Za-z0-9_-]{20,}$`));

    await authedPage.getByTestId('close-share-dialog').click();

    // --- Step 2: open the share link in a completely fresh, unauthenticated context. ---
    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(shareUrl);

    await expect(viewerPage.getByTestId('share-label')).toHaveText('Share E2E Flow');
    await expect(viewerPage.getByTestId('header-connection-status')).toHaveText('live', { timeout: 10_000 });
    // No flow picker in share mode (docs/SHARING.md "no flow picker").
    await expect(viewerPage.getByTestId('flow-picker')).toHaveCount(0);
    // The read-only footer names Tracery and links back to it.
    await expect(viewerPage.getByTestId('share-footer')).toContainText('Shared from Tracery');

    // Select the node to open the inspector, which should show the redacted-context notice.
    const nodeItem = viewerPage.getByTestId('node-item').first();
    await expect(nodeItem).toBeVisible();
    await nodeItem.click();
    await expect(viewerPage.getByTestId('context-redacted-notice')).toBeVisible();
    await expect(viewerPage.locator('body')).not.toContainText('this must never reach the shared viewer');

    await viewerContext.close();

    // --- Step 3: revoke the share via "Manage shares", then confirm the link 404s. ---
    await authedPage.getByTestId('share-button').click();
    await authedPage.getByTestId('manage-shares-button').click();
    await expect(authedPage.getByTestId('manage-shares-item').first()).toBeVisible();
    await authedPage.getByTestId('revoke-share-button').first().click();
    await expect(authedPage.getByTestId('manage-shares-item').first()).toContainText('revoked', { timeout: 10_000 });

    const revokedResponse = await authedPage.request.get(shareUrl);
    expect(revokedResponse.status()).toBe(404);

    await authedContext.close();
  });
});
