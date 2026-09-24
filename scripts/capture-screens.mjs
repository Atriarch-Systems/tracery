#!/usr/bin/env node
/**
 * One-off screenshot capture for docs/DEMOS.md. Not a test -- a small,
 * throwaway driver script using @playwright/test's `chromium` (already a
 * devDependency of apps/hub/web; browsers are installed there).
 *
 * Captures, at 1440x900:
 *   - docs/images/hub-flows.png  -- the hosted UI's flow list, against a
 *     hub that already holds a real trace (run `npm run demo` first).
 *   - docs/images/hub-flow.png   -- a single flow's graph with a node
 *     selected and the inspector showing its context.
 *   - docs/images/hub-trace.png -- whole-trace scope with three groups in
 *     the legend.
 *   - docs/images/embedded.png  -- the examples/embedded app (`vite
 *     preview`, screenshotted ~10s in so the scripted agent has animated).
 *   - docs/images/share.png    -- a share page (docs/SHARING.md), captured
 *     against a throwaway hub this script spawns and kills itself (its own
 *     random port, `apps/hub/bin/hub.mjs`) -- deliberately independent of
 *     `TRACERY_HUB_URL`/the `tracery-demo` container the other captures use,
 *     since this one creates and revokes a share and must never touch
 *     shared/production state.
 *
 * Usage: `node scripts/capture-screens.mjs` (all captures), or
 * `CAPTURE_ONLY=share node scripts/capture-screens.mjs` for just the share
 * screenshot (the only one that needs no already-running hub at all).
 * Env: TRACERY_HUB_URL (default http://127.0.0.1:8971), TRACERY_API_KEY
 * (default the demo hub's dev key, tdk_a7f3c9e2b1d4); CAPTURE_ONLY
 * (comma-separated subset of `hub`, `embedded`, `share`; default `all`).
 */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_CONTRACT_VERSION } from '@atriarch-systems/tracery-core/contract';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(REPO_ROOT, 'docs', 'images');
mkdirSync(IMAGES_DIR, { recursive: true });

const HUB_URL = (process.env.TRACERY_HUB_URL || 'http://127.0.0.1:8971').replace(/\/+$/, '');
const API_KEY = process.env.TRACERY_API_KEY || 'tdk_a7f3c9e2b1d4';
const EMBEDDED_PORT = 4312;
const EMBEDDED_URL = `http://localhost:${EMBEDDED_PORT}/`;
const VIEWPORT = { width: 1440, height: 900 };

async function waitForHealthy(url, timeoutMs = 20_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms: ${String(lastError)}`);
}

async function captureHubScreens() {
  console.log(`[capture-screens] hub: ${HUB_URL}`);
  await waitForHealthy(`${HUB_URL}/healthz`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  // --- key entry -------------------------------------------------------
  await page.goto(`${HUB_URL}/ui/`);
  await page.getByTestId('key-input').fill(API_KEY);
  await page.getByTestId('key-submit').click();
  await page.getByTestId('flow-picker-item').first().waitFor();

  // --- hub-flows.png: the flow list -------------------------------------
  await page.waitForTimeout(500); // let the live feed settle to "live"
  const flowsPath = path.join(IMAGES_DIR, 'hub-flows.png');
  await page.screenshot({ path: flowsPath });
  console.log(`[capture-screens] wrote ${flowsPath}`);

  // --- hub-flow.png: one flow, a node selected, inspector context -------
  await page.getByTestId('flow-picker-item').filter({ hasText: 'demo: orchestrator' }).first().click();
  await page.getByTestId('node-item').filter({ hasText: 'llm:main' }).first().click();
  await page.getByTestId('inspector-op-context').first().waitFor();
  const flowPath = path.join(IMAGES_DIR, 'hub-flow.png');
  await page.screenshot({ path: flowPath });
  console.log(`[capture-screens] wrote ${flowPath}`);

  // --- hub-trace.png: whole trace, three groups --------------------------
  await page.getByTestId('scope-trace').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="group-legend-item"]').length === 3);
  const tracePath = path.join(IMAGES_DIR, 'hub-trace.png');
  await page.screenshot({ path: tracePath });
  console.log(`[capture-screens] wrote ${tracePath}`);

  await browser.close();
}

async function captureEmbeddedScreen() {
  console.log('[capture-screens] starting `vite preview` for tracery-example-embedded');
  const preview = spawn('npm', ['run', 'preview', '-w', 'tracery-example-embedded'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    shell: true,
  });
  let previewOutput = '';
  preview.stdout.on('data', (d) => (previewOutput += d.toString()));
  preview.stderr.on('data', (d) => (previewOutput += d.toString()));

  try {
    await waitForHealthy(EMBEDDED_URL);

    const browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    await page.goto(EMBEDDED_URL);

    // Let the scripted agent run for ~10s so the graph has visibly animated.
    await page.waitForTimeout(10_000);

    const embeddedPath = path.join(IMAGES_DIR, 'embedded.png');
    await page.screenshot({ path: embeddedPath });
    console.log(`[capture-screens] wrote ${embeddedPath}`);
    await browser.close();
  } catch (err) {
    console.error('[capture-screens] embedded capture failed. preview output so far:');
    console.error(previewOutput);
    throw err;
  } finally {
    // `spawn(..., { shell: true })` on Windows leaves `npm` (and the `vite
    // preview` grandchild it launches) running after `preview.kill()`, since
    // that only signals the shell -- kill the whole process tree instead.
    if (process.platform === 'win32' && preview.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(preview.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already exited -- fine
      }
    } else {
      preview.kill();
    }
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function captureShareScreen() {
  const hubBin = path.join(REPO_ROOT, 'apps', 'hub', 'bin', 'hub.mjs');
  if (!existsSync(hubBin) || !existsSync(path.join(REPO_ROOT, 'apps', 'hub', 'dist'))) {
    console.warn('[capture-screens] apps/hub is not built (no dist/ or bin/hub.mjs); skipping share.png');
    return;
  }

  const port = await freePort();
  const shareHubUrl = `http://127.0.0.1:${port}`;
  const shareApiKey = 'capture-screens-share-key';
  const hub = spawn(process.execPath, [hubBin], {
    cwd: path.join(REPO_ROOT, 'apps', 'hub'),
    env: {
      ...process.env,
      TRACERY_PORT: String(port),
      TRACERY_API_KEYS: JSON.stringify([{ id: 'capture', key: shareApiKey, workspace: 'default', roles: ['ingest', 'read', 'admin'] }]),
      TRACERY_LOG_LEVEL: 'silent',
    },
    stdio: 'pipe',
  });

  try {
    await waitForHealthy(`${shareHubUrl}/healthz`);

    const now = Date.now();
    const seed = await fetch(`${shareHubUrl}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shareApiKey}` },
      body: JSON.stringify({
        v: ACTIVITY_CONTRACT_VERSION,
        workspace: 'default',
        events: [
          {
            v: ACTIVITY_CONTRACT_VERSION,
            id: 'share-shot-e1',
            ts: now,
            flow: 'triage-cve-2026-1234',
            op: 'plan',
            node: 'agent:saga',
            type: 'start',
            name: 'plan.investigation',
            kind: 'agent',
            label: 'Triage CVE-2026-1234',
            root: true,
            status: 'success',
            context: { severity: 'high', cve: 'CVE-2026-1234' },
          },
          {
            v: ACTIVITY_CONTRACT_VERSION,
            id: 'share-shot-e2',
            ts: now + 5,
            flow: 'triage-cve-2026-1234',
            op: 'search',
            node: 'tool:search',
            type: 'start',
            name: 'tool.call',
            kind: 'tool',
            label: 'Search advisories',
            parentOp: 'plan',
            parentNode: 'agent:saga',
            status: 'success',
          },
          {
            v: ACTIVITY_CONTRACT_VERSION,
            id: 'share-shot-e3',
            ts: now + 40,
            flow: 'triage-cve-2026-1234',
            op: 'search',
            node: 'tool:search',
            type: 'end',
            name: 'tool.call',
            status: 'success',
          },
          {
            v: ACTIVITY_CONTRACT_VERSION,
            id: 'share-shot-e4',
            ts: now + 45,
            flow: 'triage-cve-2026-1234',
            op: 'plan',
            node: 'agent:saga',
            type: 'end',
            name: 'plan.investigation',
            status: 'success',
          },
        ],
      }),
    });
    if (!seed.ok) throw new Error(`seeding the share screenshot fixture failed: ${seed.status} ${await seed.text()}`);

    const createRes = await fetch(`${shareHubUrl}/v1/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shareApiKey}` },
      body: JSON.stringify({ target: { type: 'flow', id: 'triage-cve-2026-1234' }, mode: 'snapshot', includeContext: false }),
    });
    if (!createRes.ok) throw new Error(`creating the demo share failed: ${createRes.status} ${await createRes.text()}`);
    const share = await createRes.json();

    const browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    await page.goto(share.url);
    await page.getByTestId('node-item').first().waitFor();
    await page.getByTestId('node-item').first().click();
    await page.getByTestId('context-redacted-notice').waitFor();
    await page.waitForTimeout(300); // let the graph settle after the click

    const sharePath = path.join(IMAGES_DIR, 'share.png');
    await page.screenshot({ path: sharePath });
    console.log(`[capture-screens] wrote ${sharePath}`);
    await browser.close();
  } finally {
    if (process.platform === 'win32' && hub.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(hub.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already exited -- fine
      }
    } else {
      hub.kill();
    }
  }
}

// CAPTURE_ONLY lets a caller run a subset -- in particular `share`, which
// spawns its own throwaway hub and never touches `TRACERY_HUB_URL`/the
// `tracery-demo` container the other two captures require already running.
const only = (process.env.CAPTURE_ONLY || 'all').split(',').map((s) => s.trim());
const wants = (name) => only.includes('all') || only.includes(name);

if (wants('hub')) await captureHubScreens();
if (wants('embedded')) await captureEmbeddedScreen();
if (wants('share')) await captureShareScreen();
console.log('[capture-screens] done');
