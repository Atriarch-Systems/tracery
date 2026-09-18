#!/usr/bin/env node
/**
 * One-off hero capture for the README's top banner. Not a test -- spins up
 * its own throwaway hub (local mode, memory store, random port) so it never
 * touches the `tracery-demo` container or any real workspace, replays the
 * exact multi-flow scenario from examples/embedded/src/scenario.ts (an
 * orchestrator that plans, searches, spawns two subagents at ~6.6s, runs a
 * guard check and a human approval concurrently with them, then a self-loop
 * report -- one child succeeds, one errors) as real HTTP events against the
 * hub's own /v1/events, while a headless browser sits on the trace view and
 * records video. Produces:
 *
 *   docs/images/hero.png -- a crisp still, taken mid-scenario while both
 *     children are running (visibly pulsing) and the spawn edges are drawn.
 *   docs/images/hero.gif -- the recording, trimmed and palette-encoded with
 *     ffmpeg into a looping GIF sized for a GitHub README hero.
 *
 * Requires ffmpeg on PATH. Usage: `node scripts/capture-hero.mjs`.
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(REPO_ROOT, 'docs', 'images');

// The graph's absolute layout occupies a fixed pixel region regardless of
// viewport size (it is not scaled to fill the canvas), so a tight banner
// crop reads far better as a README hero than the full 1600x900 app chrome
// with a large empty lower canvas.
const HERO_CLIP = { x: 0, y: 0, width: 1600, height: 560 };
mkdirSync(IMAGES_DIR, { recursive: true });

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealthy(baseUrl, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`hub did not become healthy at ${baseUrl} within ${deadlineMs}ms`);
}

// --- the scenario, as raw wire events (mirrors examples/embedded/src/scenario.ts) ---

const orchestrator = { id: 'agent:orchestrator', name: 'Orchestrator', kind: 'agent' };
const research1Actor = { id: 'subagent:research-1', name: 'Research Agent 1', kind: 'subagent' };
const research2Actor = { id: 'subagent:research-2', name: 'Research Agent 2', kind: 'subagent' };

function evt(partial) {
  return { v: 1, ...partial };
}

function buildSchedule(loop) {
  const parentFlow = `flow:orchestrator-${loop}`;
  const r1Flow = `flow:research-1-${loop}`;
  const r2Flow = `flow:research-2-${loop}`;
  const id = (name) => `evt-${loop}-${name}`;
  const now = () => Date.now();

  return [
    { at: 0, build: () => [evt({ id: id('p-plan-start'), ts: now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan the investigation', root: true, actor: orchestrator })] },
    { at: 1200, build: () => [evt({ id: id('p-plan-update'), ts: now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'update', name: 'llm.plan', context: { tokens: 128 } })] },
    { at: 2500, build: () => [
      evt({ id: id('p-plan-end'), ts: now(), flow: parentFlow, op: 'op:p-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 2500, context: { tokens: 256 } }),
      evt({ id: id('p-search-start'), ts: now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', label: 'Search prior incidents', parentOp: 'op:p-plan', parentNode: 'llm:main' }),
    ] },
    { at: 4500, build: () => [evt({ id: id('p-search-annotate'), ts: now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'annotate', name: 'tool.search', context: { note: 'expanding query to include closed tickets' } })] },
    { at: 6500, build: () => [evt({ id: id('p-search-end'), ts: now(), flow: parentFlow, op: 'op:p-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'success', durationMs: 4000, context: { hits: 7 } })] },
    { at: 6600, build: () => [
      evt({ id: id('p-spawn-r1-start'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r1', node: 'tool:search', type: 'start', name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
      evt({ id: id('p-spawn-r1-end'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r1', node: 'tool:search', type: 'end', name: 'flow.spawn', status: 'success' }),
      evt({ id: id('r1-plan-start'), ts: now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research1Actor, link: { parentFlow, parentOp: 'op:p-spawn-r1', parentNode: 'tool:search' } }),
    ] },
    { at: 6700, build: () => [
      evt({ id: id('p-spawn-r2-start'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r2', node: 'tool:search', type: 'start', name: 'flow.spawn', kind: 'tool', parentOp: 'op:p-search', parentNode: 'tool:search' }),
      evt({ id: id('p-spawn-r2-end'), ts: now(), flow: parentFlow, op: 'op:p-spawn-r2', node: 'tool:search', type: 'end', name: 'flow.spawn', status: 'success' }),
      evt({ id: id('r2-plan-start'), ts: now(), flow: r2Flow, op: 'op:r2-plan', node: 'llm:main', type: 'start', name: 'llm.plan', kind: 'llm', label: 'Plan research angle', root: true, actor: research2Actor, link: { parentFlow, parentOp: 'op:p-spawn-r2', parentNode: 'tool:search' } }),
    ] },
    { at: 6800, build: () => [evt({ id: id('p-guard-start'), ts: now(), flow: parentFlow, op: 'op:p-guard', node: 'guard:policy', type: 'start', name: 'guard.check', kind: 'guard', parentOp: 'op:p-search', parentNode: 'tool:search' })] },
    { at: 8200, build: () => [evt({ id: id('p-guard-end'), ts: now(), flow: parentFlow, op: 'op:p-guard', node: 'guard:policy', type: 'end', name: 'guard.check', status: 'success', durationMs: 1400 })] },
    { at: 8400, build: () => [evt({ id: id('p-human-start'), ts: now(), flow: parentFlow, op: 'op:p-human', node: 'human:approval', type: 'start', name: 'human.approve', kind: 'human', parentOp: 'op:p-guard', parentNode: 'guard:policy' })] },
    { at: 10800, build: () => [evt({ id: id('p-human-end'), ts: now(), flow: parentFlow, op: 'op:p-human', node: 'human:approval', type: 'end', name: 'human.approve', status: 'success', durationMs: 2400 })] },
    { at: 11000, build: () => [evt({ id: id('p-report-start'), ts: now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:p-plan', parentNode: 'llm:main' })] },
    { at: 12500, build: () => [evt({ id: id('p-report-update'), ts: now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 96 } })] },
    { at: 14000, build: () => [evt({ id: id('p-report-end'), ts: now(), flow: parentFlow, op: 'op:p-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 3000 })] },

    { at: 8000, build: () => [evt({ id: id('r1-plan-update'), ts: now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'update', name: 'llm.plan', context: { tokens: 64 } })] },
    { at: 9000, build: () => [
      evt({ id: id('r1-plan-end'), ts: now(), flow: r1Flow, op: 'op:r1-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 2200 }),
      evt({ id: id('r1-search-start'), ts: now(), flow: r1Flow, op: 'op:r1-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', parentOp: 'op:r1-plan', parentNode: 'llm:main' }),
    ] },
    { at: 11000, build: () => [evt({ id: id('r1-search-end'), ts: now(), flow: r1Flow, op: 'op:r1-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'success', durationMs: 2000, context: { hits: 3 } })] },
    { at: 11200, build: () => [evt({ id: id('r1-memory-start'), ts: now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'start', name: 'memory.write', kind: 'memory', parentOp: 'op:r1-search', parentNode: 'tool:search', dataFrom: 'tool:search' })] },
    { at: 12500, build: () => [evt({ id: id('r1-memory-annotate'), ts: now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'annotate', name: 'memory.write', context: { note: 'summarised 3 hits into 1 note' } })] },
    { at: 13500, build: () => [
      evt({ id: id('r1-memory-end'), ts: now(), flow: r1Flow, op: 'op:r1-memory', node: 'memory:notes', type: 'end', name: 'memory.write', status: 'success', durationMs: 2300 }),
      evt({ id: id('r1-report-start'), ts: now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:r1-memory', parentNode: 'memory:notes' }),
    ] },
    { at: 15000, build: () => [evt({ id: id('r1-report-update'), ts: now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 40 } })] },
    { at: 16000, build: () => [evt({ id: id('r1-report-end'), ts: now(), flow: r1Flow, op: 'op:r1-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 2500 })] },

    { at: 8100, build: () => [
      evt({ id: id('r2-plan-end'), ts: now(), flow: r2Flow, op: 'op:r2-plan', node: 'llm:main', type: 'end', name: 'llm.plan', status: 'success', durationMs: 1400 }),
      evt({ id: id('r2-search-start'), ts: now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'start', name: 'tool.search', kind: 'tool', parentOp: 'op:r2-plan', parentNode: 'llm:main' }),
    ] },
    { at: 9800, build: () => [evt({ id: id('r2-search-update'), ts: now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'update', name: 'tool.search', status: 'error', context: { attempt: 1 } })] },
    { at: 10800, build: () => [evt({ id: id('r2-search-end'), ts: now(), flow: r2Flow, op: 'op:r2-search', node: 'tool:search', type: 'end', name: 'tool.search', status: 'error', durationMs: 1700, context: { error: 'timeout' } })] },
    { at: 11000, build: () => [evt({ id: id('r2-memory-start'), ts: now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'start', name: 'memory.write', kind: 'memory', parentOp: 'op:r2-search', parentNode: 'tool:search' })] },
    { at: 12300, build: () => [evt({ id: id('r2-memory-annotate'), ts: now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'annotate', name: 'memory.write', context: { note: 'recording partial results despite search error' } })] },
    { at: 13300, build: () => [
      evt({ id: id('r2-memory-end'), ts: now(), flow: r2Flow, op: 'op:r2-memory', node: 'memory:notes', type: 'end', name: 'memory.write', status: 'success', durationMs: 2300 }),
      evt({ id: id('r2-report-start'), ts: now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'start', name: 'llm.report', kind: 'llm', parentOp: 'op:r2-memory', parentNode: 'memory:notes' }),
    ] },
    { at: 14800, build: () => [evt({ id: id('r2-report-update'), ts: now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'update', name: 'llm.report', context: { tokens: 30 } })] },
    { at: 15800, build: () => [evt({ id: id('r2-report-end'), ts: now(), flow: r2Flow, op: 'op:r2-report', node: 'llm:main', type: 'end', name: 'llm.report', status: 'success', durationMs: 2500 })] },
  ];
}

async function postEvents(baseUrl, events) {
  const res = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, workspace: 'default', events }),
  });
  if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[hero] starting throwaway hub on ${baseUrl}`);

  const hub = spawn(process.execPath, [path.join(REPO_ROOT, 'apps', 'hub', 'bin', 'hub.mjs')], {
    cwd: REPO_ROOT,
    env: { ...process.env, TRACERY_PORT: String(port), TRACERY_HOST: '127.0.0.1', TRACERY_STORE: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  hub.stdout.on('data', () => {});
  hub.stderr.on('data', () => {});

  try {
    await waitForHealthy(baseUrl, 15000);
    console.log('[hero] hub healthy');

    // Unique per run rather than a fixed name: a stale file from a prior
    // run can stay locked by the OS/antivirus for a few seconds after the
    // producing process exits, and deleting a locked file throws EBUSY.
    // A fresh directory each run sidesteps that instead of racing it.
    const videoDir = path.join(REPO_ROOT, `.hero-video-tmp-${process.pid}`);
    mkdirSync(videoDir, { recursive: true });

    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      recordVideo: { dir: videoDir, size: { width: 1600, height: 900 } },
    });
    const page = await context.newPage();

    // Open the trace view before any events exist -- the explorer will show
    // "Waiting for activity" for a beat, which is a fine opening frame for
    // the GIF, then populate live as the scenario's events land.
    await page.goto(`${baseUrl}/ui/traces/flow:orchestrator-0`, { waitUntil: 'domcontentloaded' });
    await sleep(600);

    const schedule = buildSchedule(0);
    const start = Date.now();
    let heroShotTaken = false;

    for (const step of schedule.sort((a, b) => a.at - b.at)) {
      const wait = step.at - (Date.now() - start);
      if (wait > 0) await sleep(wait);
      await postEvents(baseUrl, step.build());

      // Take the still around 11s in: both children mid-flight and
      // pulsing (r1's memory write, r2 already errored and writing notes),
      // guard done, human approval in progress, spawn edges all drawn.
      if (!heroShotTaken && Date.now() - start >= 11000) {
        heroShotTaken = true;
        // Select the orchestrator's root node so the inspector shows real
        // context/timeline content instead of the empty "select a node"
        // placeholder -- via the accessible node-list button (same click
        // path the canvas card itself uses), not raw canvas coordinates.
        // Trace scope namespaces node ids as `${actor.id}::${node}`
        // (SPEC.md §2 "Projection rules"), so match on data-node-id ending
        // in the raw node id rather than assuming the bare id.
        const rootNode = page.locator('[data-testid="node-item"][data-node-id$="::llm:main"]').first();
        await rootNode.waitFor({ state: 'visible', timeout: 5000 });
        await rootNode.click();
        await sleep(500); // let the selection highlight + inspector content settle
        // Crop to a tight banner: header, scope tabs, the graph itself
        // (which occupies a modest, non-scaling absolute region regardless
        // of viewport size) and the now-populated inspector, dropping the
        // large empty lower canvas a full-viewport shot would otherwise
        // include.
        await page.screenshot({ path: path.join(IMAGES_DIR, 'hero.png'), clip: HERO_CLIP });
        console.log('[hero] wrote docs/images/hero.png');
      }
    }

    // Let the tail end (report completion, fade-to-gray) play out on camera.
    await sleep(4000);

    await context.close();
    await browser.close();

    // Playwright names the video file after an internal id; find it.
    const [videoFile] = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
    if (!videoFile) throw new Error('no video file produced');
    const webmPath = path.join(videoDir, videoFile);
    console.log(`[hero] recorded ${webmPath}`);

    // Two-pass palette GIF: a generated palette gives far better color
    // fidelity than a naive single-pass gif encode, which matters for a
    // dark UI with saturated accent colors. Trim the first ~1s (page
    // load/settle) and cap width at 960px so the file stays README-sized.
    const palettePath = path.join(videoDir, 'palette.png');
    const gifPath = path.join(IMAGES_DIR, 'hero.gif');
    // Window: skip the first 1s (page load), keep the next 12s -- plan,
    // search, both spawns, guard+human running concurrently with both
    // children mid-flight (pulsing) and the spawn edges drawn. Cuts before
    // the quiet settle/fade-out tail, which makes for a snappier loop.
    const filters = `crop=${HERO_CLIP.width}:${HERO_CLIP.height}:${HERO_CLIP.x}:${HERO_CLIP.y},fps=12,scale=960:-1:flags=lanczos`;
    execFileSync('ffmpeg', ['-y', '-ss', '1', '-t', '12', '-i', webmPath, '-frames:v', '1', '-update', '1', '-vf', `${filters},palettegen=stats_mode=diff`, palettePath], { stdio: 'inherit' });
    execFileSync('ffmpeg', ['-y', '-ss', '1', '-t', '12', '-i', webmPath, '-i', palettePath, '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer`, '-loop', '0', gifPath], { stdio: 'inherit' });
    console.log('[hero] wrote docs/images/hero.gif');

    try { rmSync(videoDir, { recursive: true, force: true }); } catch { /* best effort; a locked temp file is not fatal */ }
  } finally {
    hub.kill();
  }
}

main().catch((err) => {
  console.error('[hero] FAILED:', err);
  process.exitCode = 1;
});
