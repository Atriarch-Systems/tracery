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

import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInitialState, mapHookToEvents } from './map.mjs';

const MAX_BATCH = 1000;
const POST_TIMEOUT_MS = 2000;

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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
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

async function appendToSpool(spoolPath, events) {
  if (events.length === 0) return;
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await appendFile(spoolPath, lines, 'utf8');
}

async function postBatch(hubUrl, apiKey, workspace, events) {
  if (events.length === 0) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${hubUrl}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ v: 1, workspace, events }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function drainSpool(spoolPath, hubUrl, apiKey, workspace) {
  let content;
  try {
    content = await readFile(spoolPath, 'utf8');
  } catch {
    return;
  }
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;

  let idx = 0;
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
    const ok = await postBatch(hubUrl, apiKey, workspace, events);
    if (!ok) return; // leave this chunk and everything after it spooled
    idx += chunkLines.length;
    const remaining = lines.slice(idx);
    await writeFile(spoolPath, remaining.length > 0 ? remaining.join('\n') + '\n' : '', 'utf8');
  }
}

function warn(message) {
  process.stderr.write(`tracery: ${message}\n`);
}

async function main() {
  const env = process.env;
  const config = readConfig(env);

  const hasHubUrl = config.hubUrl.length > 0;
  const hasApiKey = config.apiKey.length > 0;
  if (!hasHubUrl && !hasApiKey) {
    // Not configured at all: silent no-op, this is the common case for
    // anyone who installed the plugin but hasn't set it up yet.
    return;
  }
  if (!hasHubUrl || !hasApiKey) {
    warn(`missing ${!hasHubUrl ? 'hub_url' : 'api_key'} configuration, skipping`);
    return;
  }

  let raw;
  try {
    raw = await readStdin();
  } catch {
    warn('failed to read hook payload from stdin');
    return;
  }

  let payload;
  try {
    payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
  } catch {
    warn('failed to parse hook payload JSON');
    return;
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  if (sessionId.length === 0) {
    warn('hook payload missing session_id, skipping');
    return;
  }

  const dataDir = dataDirFor(env);
  const stateDir = join(dataDir, 'state');
  const statePath = join(stateDir, `${sessionId}.json`);
  const spoolPath = join(dataDir, 'spool.ndjson');

  await mkdir(stateDir, { recursive: true });

  const loaded = await loadState(statePath);
  const stateForMap = { ...loaded, config: { includePrompts: config.includePrompts } };

  const { events, state: newState } = mapHookToEvents(payload, stateForMap, Date.now());

  await appendToSpool(spoolPath, events);
  await drainSpool(spoolPath, config.hubUrl, config.apiKey, config.workspace);

  if (payload.hook_event_name === 'SessionEnd') {
    await rm(statePath, { force: true });
  } else {
    await saveState(statePath, newState);
  }
}

try {
  await main();
} catch (err) {
  warn(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(0);
