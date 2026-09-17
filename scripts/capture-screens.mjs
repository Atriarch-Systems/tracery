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
 *
 * Usage: `node scripts/capture-screens.mjs`
 * Env: TRACERY_HUB_URL (default http://127.0.0.1:8971), TRACERY_API_KEY
 * (default the demo hub's dev key, tdk_a7f3c9e2b1d4).
 */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

await captureHubScreens();
await captureEmbeddedScreen();
console.log('[capture-screens] done');
