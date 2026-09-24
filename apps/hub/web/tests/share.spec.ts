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
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core';

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

/** Creates a share directly against the hub API (bypassing the UI dialog), for tests that only need a link to open. */
async function createShare(mode: 'snapshot' | 'live', includeContext = true): Promise<{ url: string }> {
  const res = await fetch(`${BASE_URL}/v1/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ target: { type: 'flow', id: FLOW_ID }, mode, includeContext }),
  });
  if (!res.ok) throw new Error(`creating a ${mode} share failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Whether two DOMRect-shaped boxes overlap at all (edge-touching does not count as overlap). */
function boxesIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
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
    // The seeded flow already completed (start+end), so ShareDialog defaults
    // to a snapshot share -- it never streams once loaded, so the
    // connection badge (distinct from the "snapshot"/"live" mode badge)
    // must be gone entirely by now, not just relabeled.
    await expect(viewerPage.getByTestId('share-mode')).toHaveText('snapshot');
    await expect(viewerPage.getByTestId('node-item').first()).toBeVisible({ timeout: 10_000 });
    await expect(viewerPage.getByTestId('header-connection-status')).toHaveCount(0);
    // No flow picker in share mode (docs/SHARING.md "no flow picker").
    await expect(viewerPage.getByTestId('flow-picker')).toHaveCount(0);
    // The read-only footer names Tracery Graph and links back to it.
    await expect(viewerPage.getByTestId('share-footer')).toContainText('Shared from Tracery Graph');

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

  // Regression: the accessible node list used to sit in normal document
  // flow below a full-height canvas, so it (and its highlighted selected
  // row) spilled out of the explorer's own box and overlapped the page
  // footer beneath it. It must now stay inside the explorer's own scroll
  // area at every viewport this checks -- a short desktop height (the
  // failure mode in docs/images/share.png) and a phone-width viewport.
  test('the node list stays inside the explorer and never overlaps the page footer', async ({ page }) => {
    const share = await createShare('live');

    for (const viewport of [
      { width: 1280, height: 700 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(share.url);
      await expect(page.getByTestId('node-item').first()).toBeVisible();

      const nodeList = await page.getByTestId('node-list').boundingBox();
      expect(nodeList).not.toBeNull();

      // Both footers stacked at the bottom of the page: the explorer's own
      // read-only "Shared from Tracery Graph" line, and the hub's static footer.
      const footers = page.locator('[data-testid="share-footer"], [data-testid="hub-footer"]');
      const footerCount = await footers.count();
      expect(footerCount).toBeGreaterThan(0);
      for (let i = 0; i < footerCount; i += 1) {
        const footerBox = await footers.nth(i).boundingBox();
        expect(footerBox).not.toBeNull();
        if (nodeList && footerBox) expect(boxesIntersect(nodeList, footerBox)).toBe(false);
      }
    }
  });

  // The header shows the share MODE ("snapshot"/"live") and, separately, the
  // feed CONNECTION state -- they must never read as the same fact twice,
  // and a snapshot (which never streams once loaded) must not show a
  // connection badge at all once it has loaded.
  test('the connection badge is distinct from the mode badge, and disappears once a snapshot has loaded', async ({ page }) => {
    const liveShare = await createShare('live');
    await page.goto(liveShare.url);
    await expect(page.getByTestId('share-mode')).toHaveText('live');
    await expect(page.getByTestId('header-connection-status')).toHaveText('connected', { timeout: 10_000 });
    await expect(page.getByTestId('header-connection-status')).toHaveAttribute('title', 'feed connection');
    await expect(page.locator('body')).not.toContainText('status:');

    const snapshotShare = await createShare('snapshot');
    await page.goto(snapshotShare.url);
    await expect(page.getByTestId('share-mode')).toHaveText('snapshot');
    await expect(page.getByTestId('node-item').first()).toBeVisible();
    // Nothing streams after a snapshot has loaded -- the connection badge is gone, not just relabeled.
    await expect(page.getByTestId('header-connection-status')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('status:');
  });
});
