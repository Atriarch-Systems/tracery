#!/usr/bin/env node
// Tracery Claude Code plugin: telemetry hook.
//
// Reads one hook payload from stdin, maps it to Activity events (hooks/map.mjs),
// appends them to a durable on-disk spool, then tries to drain the whole spool
// to the hub. Zero runtime dependencies: only node: builtins.
//
// Contract with Claude Code: ALWAYS exit 0, print nothing to stdout, at most
// one line to stderr (config errors only). A telemetry hook that blocks or
// fails the user's turn is a bug.

import { mkdir, readFile, writeFile, appendFile, rm, rename, readdir, stat, open } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInitialState, mapHookToEvents } from './map.mjs';

const MAX_BATCH = 1000;
const POST_TIMEOUT_MS = 2000;
// Hooks run under Claude Code's own timeout budget; a hook process reading an
// unbounded tool_output could otherwise buffer arbitrarily large stdin.
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
// How long to wait for another concurrent hook process to release the
// per-session state lock before giving up and proceeding unlocked. Bounded
// well under Claude Code's hook timeout so a stuck lock never blocks the
// user's turn.
const LOCK_WAIT_MS = 1000;
const LOCK_POLL_MS = 20;
// A lock file older than this is assumed to be left over from a process that
// was killed (hook timeout, crash) rather than one that is still running.
const STALE_LOCK_MS = 5000;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function readConfig(env) {
  const hubUrl = firstNonEmpty(env.CLAUDE_PLUGIN_OPTION_HUB_URL, env.TRACERY_HUB_URL);
  const apiKey = firstNonEmpty(env.CLAUDE_PLUGIN_OPTION_API_KEY, env.TRACERY_API_KEY);
  const workspace = firstNonEmpty(env.CLAUDE_PLUGIN_OPTION_WORKSPACE, env.TRACERY_WORKSPACE) || 'default';
  const includePromptsRaw = firstNonEmpty(env.CLAUDE_PLUGIN_OPTION_INCLUDE_PROMPTS, env.TRACERY_INCLUDE_PROMPTS) || 'false';
  const includePrompts = /^(1|true|yes)$/i.test(includePromptsRaw.trim());
  return { hubUrl: stripTrailingSlash(hubUrl), apiKey, workspace, includePrompts };
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '');
}

function dataDirFor(env) {
  return env.CLAUDE_PLUGIN_DATA && env.CLAUDE_PLUGIN_DATA.length > 0
    ? env.CLAUDE_PLUGIN_DATA
    : join(tmpdir(), 'tracery');
}

/**
 * Identifies one ingest destination (hub + workspace + credential). Spools
 * are keyed by this so a session whose hub/workspace/key changes between
 * invocations (different projects sharing this plugin's per-user data dir)
 * never drains one project's queued events into another project's hub.
 */
function destinationId(hubUrl, workspace, apiKey) {
  return createHash('sha256').update(`${hubUrl}\u0000${workspace}\u0000${apiKey}`).digest('hex').slice(0, 16);
}

function spoolPathFor(dataDir, config) {
  return join(dataDir, 'spool', `${destinationId(config.hubUrl, config.workspace, config.apiKey)}.ndjson`);
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of process.stdin) {
    if (truncated) continue; // keep draining stdin so the writer never blocks on backpressure
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) {
      truncated = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (truncated) return null;
  return Buffer.concat(chunks).toString('utf8');
}

async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...createInitialState(), ...parsed };
  } catch {
    return createInitialState();
  }
}

async function saveState(statePath, state) {
  // Persist only the documented, durable fields -- never the transient
  // per-call `config` (include_prompts can change between invocations via
  // env/userConfig and must not go stale on disk).
  const persisted = {
    counter: state.counter,
    rootStarted: state.rootStarted,
    rootStartedAt: state.rootStartedAt,
    tools: state.tools,
    agentCalls: state.agentCalls,
    subagents: state.subagents,
  };
  await writeFile(statePath, JSON.stringify(persisted), 'utf8');
}

/**
 * Serialises access to one lock-protected section across concurrent emit.mjs
 * processes (Claude Code runs hooks in parallel, and overlapping hooks for
 * the same session otherwise race on the same state file's read-modify-write,
 * silently dropping each other's in-flight tool/agent bookkeeping). Uses an
 * `open(..., 'wx')` lockfile: atomic create-if-absent, no extra dependency.
 * Never blocks the user's turn indefinitely -- gives up after LOCK_WAIT_MS
 * and proceeds unlocked, and reclaims a lock abandoned by a killed process.
 */
async function withLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      acquired = true;
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      const staleAndCleared = await clearIfStale(lockPath);
      if (staleAndCleared) continue; // retry the create immediately
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) await rm(lockPath, { force: true });
  }
}

async function clearIfStale(lockPath) {
  try {
    const st = await stat(lockPath);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      await rm(lockPath, { force: true });
      return true;
    }
    return false;
  } catch {
    return true; // lock vanished between the failed create and this check
  }
}

async function appendToSpool(spoolPath, events) {
  if (events.length === 0) return;
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await appendFile(spoolPath, lines, 'utf8');
}

function batchHeaders(apiKey) {
  // Local hub (task: "local mode", e.g. `npx @atriarch/tracery-hub` with no
  // TRACERY_API_KEYS): needs no credential at all -- omit Authorization
  // entirely rather than send an empty "Bearer ".
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function postBatch(hubUrl, apiKey, workspace, events) {
  if (events.length === 0) return { ok: true, rejectedCount: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${hubUrl}/v1/events`, {
      method: 'POST',
      headers: batchHeaders(apiKey),
      body: JSON.stringify({ v: 1, workspace, events }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, rejectedCount: 0 };
    let rejectedCount = 0;
    if (res.status === 207) {
      try {
        const body = await res.json();
        rejectedCount = Array.isArray(body?.rejected) ? body.rejected.length : 0;
      } catch {
        // Not the documented shape; the hub still returned success overall.
      }
    }
    return { ok: true, rejectedCount };
  } catch {
    return { ok: false, rejectedCount: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Folds any `.inflight` snapshot left behind by a previous drainSpool that
 * was killed mid-flight (Claude Code enforces a hook timeout) back into the
 * live spool, so those events are retried instead of stranded forever.
 */
async function recoverOrphanedInflight(spoolPath) {
  const dir = dirname(spoolPath);
  const prefix = `${basename(spoolPath)}.`;
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.inflight')) continue;
    const orphanPath = join(dir, name);
    try {
      // A `.inflight` file this young almost certainly belongs to another
      // process's drain that is still awaiting its POST response (up to
      // POST_TIMEOUT_MS), not one abandoned by a kill -- recovering it now
      // would duplicate that process's in-flight events onto this drain.
      const st = await stat(orphanPath);
      if (Date.now() - st.mtimeMs <= POST_TIMEOUT_MS + 1000) continue;
      const content = await readFile(orphanPath, 'utf8');
      if (content.length > 0) await appendFile(spoolPath, content, 'utf8');
      await rm(orphanPath, { force: true });
    } catch {
      // Leave it for the next attempt rather than lose it.
    }
  }
}

/**
 * Drains the spool to the hub. The live spool file is never read-then-
 * truncated in place: it is `rename`d (atomic) to a private `.inflight` copy
 * first, so a hook process appending to it concurrently always lands on a
 * fresh file rather than racing the drain's rewrite -- the bug this replaces
 * could erase events another process appended while a POST was in flight.
 */
async function drainSpool(spoolPath, hubUrl, apiKey, workspace) {
  await recoverOrphanedInflight(spoolPath);

  const inflightPath = `${spoolPath}.${process.pid}.${Date.now()}.inflight`;
  try {
    await rename(spoolPath, inflightPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return; // nothing spooled
    throw err;
  }

  let content;
  try {
    content = await readFile(inflightPath, 'utf8');
  } catch {
    return;
  }
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    await rm(inflightPath, { force: true });
    return;
  }

  let idx = 0;
  let warnedRejected = false;
  while (idx < lines.length) {
    const chunkLines = lines.slice(idx, idx + MAX_BATCH);
    const events = [];
    for (const line of chunkLines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Drop an unparseable line rather than blocking the spool forever.
      }
    }
    const result = await postBatch(hubUrl, apiKey, workspace, events);
    if (!result.ok) {
      // Requeue everything not yet delivered onto the live spool. appendFile
      // is atomic against concurrent appenders, so this can never clobber
      // events another hook process wrote in the meantime.
      const remaining = lines.slice(idx).join('\n') + '\n';
      await appendFile(spoolPath, remaining, 'utf8');
      await rm(inflightPath, { force: true });
      return;
    }
    if (result.rejectedCount > 0 && !warnedRejected) {
      warnedRejected = true;
      warn(`hub rejected ${result.rejectedCount} of ${events.length} events in a batch`);
    }
    idx += chunkLines.length;
  }
  await rm(inflightPath, { force: true });
}

function warn(message) {
  process.stderr.write(`tracery: ${message}\n`);
}

/**
 * Debugging aid (see README.md "Troubleshooting"): when
 * TRACERY_PLUGIN_CAPTURE_DIR is set, writes the raw hook payload -- verbatim,
 * unredacted, before mapping -- to `${dir}/${hook_event_name}-${n}.json`.
 * Never active unless the env var is explicitly set; failures here must never
 * affect the hook's always-exit-0 contract, so every error is swallowed.
 */
async function captureRawPayload(captureDir, hookEventName, raw) {
  if (!captureDir || captureDir.length === 0) return;
  try {
    await mkdir(captureDir, { recursive: true });
    const safeName = typeof hookEventName === 'string' && hookEventName.length > 0 ? hookEventName : 'unknown';
    let entries = [];
    try {
      entries = await readdir(captureDir);
    } catch {
      entries = [];
    }
    const prefix = `${safeName}-`;
    let max = 0;
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const n = Number(name.slice(prefix.length, -'.json'.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    const filePath = join(captureDir, `${safeName}-${max + 1}.json`);
    await writeFile(filePath, raw, 'utf8');
  } catch {
    // Capture is best-effort debugging only; never let it break the hook.
  }
}

async function main() {
  const env = process.env;
  const config = readConfig(env);

  // `api_key` is optional (task: "local mode" -- a hub started with no
  // TRACERY_API_KEYS runs with auth off, e.g. `npx @atriarch/tracery-hub`);
  // only `hub_url` is required. With no `hub_url` at all: silent no-op, the
  // common case for anyone who installed the plugin but hasn't set it up yet.
  const hasHubUrl = config.hubUrl.length > 0;
  if (!hasHubUrl) {
    return;
  }

  let raw;
  try {
    raw = await readStdin();
  } catch {
    warn('failed to read hook payload from stdin');
    return;
  }
  if (raw === null) {
    warn('hook payload exceeded the size limit, skipping');
    return;
  }

  let payload;
  try {
    payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    warn('failed to parse hook payload JSON');
    return;
  }

  await captureRawPayload(env.TRACERY_PLUGIN_CAPTURE_DIR, payload.hook_event_name, raw);

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  if (sessionId.length === 0) {
    warn('hook payload missing session_id, skipping');
    return;
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    // session_id becomes a filename component below; reject anything shaped
    // like a path segment (e.g. containing "..") rather than build a path
    // from unvalidated input.
    warn('hook payload session_id has an unexpected shape, skipping');
    return;
  }

  const dataDir = dataDirFor(env);
  const stateDir = join(dataDir, 'state');
  const statePath = join(stateDir, `${sessionId}.json`);
  const lockPath = `${statePath}.lock`;
  const spoolPath = spoolPathFor(dataDir, config);

  await mkdir(stateDir, { recursive: true });
  await mkdir(dirname(spoolPath), { recursive: true });

  await withLock(lockPath, async () => {
    const loaded = await loadState(statePath);
    const stateForMap = { ...loaded, config: { includePrompts: config.includePrompts } };

    const { events, state: newState } = mapHookToEvents(payload, stateForMap, Date.now());

    await appendToSpool(spoolPath, events);

    if (payload.hook_event_name === 'SessionEnd') {
      await rm(statePath, { force: true });
    } else {
      await saveState(statePath, newState);
    }
  });

  // Draining talks to the network (up to POST_TIMEOUT_MS) and only touches
  // the destination-isolated spool file, which has its own rename-based
  // atomicity -- it does not need the per-session state lock held for it.
  await drainSpool(spoolPath, config.hubUrl, config.apiKey, config.workspace);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  try {
    await main();
  } catch (err) {
    warn(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}

export { spoolPathFor, destinationId };
