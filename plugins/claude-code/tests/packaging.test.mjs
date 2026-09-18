// Validates the plugin packaging itself: the repo-root marketplace manifest
// and the plugin manifest parse as JSON, the marketplace entry's `source`
// resolves to this plugin directory, and every file `plugin.json` /
// `hooks.json` reference by path actually exists on disk. This is what
// catches "renamed hooks/emit.mjs but forgot hooks.json" or "marketplace.json
// points at a plugin dir that moved" before a user's `/plugin install` does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { validateEvent } from '../../../packages/core/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..'); // plugins/claude-code
const repoRoot = resolve(pluginRoot, '..', '..');
const fixturesDir = join(here, 'fixtures');
const emitPath = join(pluginRoot, 'hooks', 'emit.mjs');

// Kebab-case: lowercase alphanumerics, hyphen-separated, no leading/trailing/
// double hyphens. Claude Code plugin names must be shaped like this.
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function assertValidAuthor(author, label) {
  // Regression: an earlier plugin.json shipped `author` as a bare string,
  // which Claude Code's plugin loader rejected -- this was only caught by
  // running a real session, not by any test. `author` must be an object
  // with at least a string `name`.
  assert.ok(author && typeof author === 'object' && !Array.isArray(author), `${label}: author must be an object, not ${JSON.stringify(author)}`);
  assert.equal(typeof author.name, 'string', `${label}: author.name must be a string`);
  assert.ok(author.name.length > 0, `${label}: author.name must not be empty`);
}

async function readJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('repo-root marketplace.json parses and lists the tracery plugin', async () => {
  const marketplace = await readJson(join(repoRoot, '.claude-plugin', 'marketplace.json'));
  assert.equal(typeof marketplace.name, 'string');
  assert.ok(marketplace.owner && typeof marketplace.owner.name === 'string', 'owner.name is required');
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0);

  const entry = marketplace.plugins.find((p) => p.name === 'tracery');
  assert.ok(entry, 'marketplace.json must list a plugin named "tracery"');
  assert.equal(entry.source, './plugins/claude-code');
  assert.match(entry.name, KEBAB_CASE_RE, `marketplace plugin entry "name" must be kebab-case, got "${entry.name}"`);
  assertValidAuthor(entry.author, 'marketplace.json plugins[].author');

  // The relative source must actually resolve to a directory containing a
  // plugin manifest, from the marketplace root (the repo root).
  assert.ok(entry.source.startsWith('./'), 'relative plugin sources must start with "./"');
  const resolvedPluginRoot = resolve(repoRoot, entry.source);
  assert.equal(resolvedPluginRoot, pluginRoot);
  assert.ok(
    await exists(join(resolvedPluginRoot, '.claude-plugin', 'plugin.json')),
    `${entry.source} must contain .claude-plugin/plugin.json`,
  );
});

test('plugin.json parses, its manifest fields are well-formed, and its hooks/skills paths resolve to real files', async () => {
  const plugin = await readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  assert.equal(plugin.name, 'tracery');
  assert.match(plugin.name, KEBAB_CASE_RE, `plugin.json "name" must be kebab-case, got "${plugin.name}"`);
  // Regression: plugin.json's `author` previously shipped as a bare string
  // ("Atriarch Systems"), which only failed when Claude Code actually tried
  // to load the plugin -- not caught by any test until then.
  assertValidAuthor(plugin.author, 'plugin.json');
  assert.equal(typeof plugin.hooks, 'string', 'this plugin declares hooks as a path, not inline');

  const hooksPath = resolve(pluginRoot, plugin.hooks);
  assert.ok(await exists(hooksPath), `plugin.json "hooks" points at ${plugin.hooks}, which does not exist`);

  assert.equal(typeof plugin.skills, 'string');
  const skillsPath = resolve(pluginRoot, plugin.skills);
  assert.ok(await exists(skillsPath), `plugin.json "skills" points at ${plugin.skills}, which does not exist`);
});

test('hooks.json only references command files that exist', async () => {
  const plugin = await readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const hooksPath = resolve(pluginRoot, plugin.hooks);
  const hooksConfig = await readJson(hooksPath);

  assert.ok(hooksConfig.hooks && typeof hooksConfig.hooks === 'object');
  const events = Object.keys(hooksConfig.hooks);
  assert.ok(events.length > 0, 'hooks.json declares no hook events');

  const referencedFiles = new Set();
  for (const event of events) {
    for (const matcherEntry of hooksConfig.hooks[event]) {
      assert.ok(Array.isArray(matcherEntry.hooks), `${event} entry has no "hooks" array`);
      for (const hook of matcherEntry.hooks) {
        assert.equal(hook.type, 'command');
        assert.equal(typeof hook.command, 'string');
        // Commands are shaped like: node "${CLAUDE_PLUGIN_ROOT}/hooks/emit.mjs"
        // Pull out every ${CLAUDE_PLUGIN_ROOT}/<path> reference in the string.
        const matches = hook.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/g);
        let found = false;
        for (const m of matches) {
          referencedFiles.add(m[1]);
          found = true;
        }
        assert.ok(found, `command "${hook.command}" does not reference a \${CLAUDE_PLUGIN_ROOT}-relative file`);
      }
    }
  }

  assert.ok(referencedFiles.size > 0, 'no file paths were extracted from hooks.json commands');
  for (const relPath of referencedFiles) {
    const abs = join(pluginRoot, relPath);
    assert.ok(await exists(abs), `hooks.json references "${relPath}" (resolved: ${abs}), which does not exist`);
  }
});

test('every skill referenced under skills/ has a SKILL.md', async () => {
  const plugin = await readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const skillsPath = resolve(pluginRoot, plugin.skills);
  const entries = await readdir(skillsPath, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());
  assert.ok(skillDirs.length > 0, `no skill directories found under ${plugin.skills}`);
  for (const dir of skillDirs) {
    const skillMd = join(skillsPath, dir.name, 'SKILL.md');
    assert.ok(await exists(skillMd), `skills/${dir.name} has no SKILL.md`);
  }
});

// Text that must never appear verbatim in emitted events for a given REAL
// captured fixture (the plugin's privacy contract -- see docs/CLAUDE-CODE-
// PLUGIN.md "Privacy: what is sent, what never is"). Fixtures not listed
// here contribute no forbidden text of their own (e.g. SessionStart/
// SessionEnd carry nothing free-text shaped).
const FORBIDDEN_TEXT_BY_FIXTURE = {
  'user-prompt-submit': (p) => [p.prompt],
  'pre-tool-use-bash': (p) => [p.tool_input?.command],
  'post-tool-use-bash': (p) => [p.tool_response?.stdout],
  'pre-tool-use-agent': (p) => [p.tool_input?.prompt],
  'post-tool-use-agent': (p) => [p.tool_input?.prompt, p.tool_response?.content?.[0]?.text],
  'subagent-post-tool-use': (p) => [typeof p.tool_response === 'string' ? p.tool_response : undefined],
  stop: (p) => [p.last_assistant_message],
  'subagent-stop': (p) => [p.last_assistant_message],
};

function runEmit(rawPayload, env, dataDir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [emitPath], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.write(rawPayload);
    child.stdin.end();
  });
}

// Runs the real hook script (not just the pure mapper) against every fixture
// that was actually captured from a live Claude Code 2.1.258 session (i.e.
// lacks `_fixture_note`), in a plausible session order, then checks two
// things about what actually reaches the spool: every event validates
// against @atriarch/tracery-core's validateEvent, and none of the raw
// command/prompt/file-content/tool-output text from those real payloads
// leaked into it verbatim.
test('emit.mjs run against every REAL captured fixture emits only valid, leak-free events', async () => {
  const preferredOrder = [
    'session-start',
    'user-prompt-submit',
    'pre-tool-use-bash',
    'post-tool-use-bash',
    'pre-tool-use-agent',
    'subagent-start',
    'subagent-pre-tool-use',
    'subagent-post-tool-use',
    'subagent-stop',
    'post-tool-use-agent',
    'post-tool-use-failure',
    'stop',
    'session-end',
  ];

  const entries = await readdir(fixturesDir);
  const allNames = entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));

  const realNames = [];
  const forbidden = new Set();
  for (const name of allNames) {
    const raw = await readFile(join(fixturesDir, `${name}.json`), 'utf8');
    const payload = JSON.parse(raw);
    if (payload._fixture_note) continue; // documented shape only, not a real capture -- excluded
    realNames.push(name);
    const collect = FORBIDDEN_TEXT_BY_FIXTURE[name];
    if (collect) {
      for (const text of collect(payload)) {
        if (typeof text === 'string' && text.length > 0) forbidden.add(text);
      }
    }
  }
  assert.ok(realNames.length > 0, 'expected at least one REAL captured fixture (none had _fixture_note unset)');
  assert.ok(forbidden.size > 0, 'expected at least one forbidden-text sample to check for leaks');

  const ordered = [...preferredOrder.filter((n) => realNames.includes(n)), ...realNames.filter((n) => !preferredOrder.includes(n))];

  const dataDir = await mkdtemp(join(tmpdir(), 'tracery-packaging-real-'));
  // Hub deliberately unreachable: this test only needs what lands in the
  // spool, not a live hub round-trip (that is emit.test.mjs's job).
  const env = { CLAUDE_PLUGIN_OPTION_HUB_URL: 'http://127.0.0.1:1', CLAUDE_PLUGIN_OPTION_API_KEY: 'test-key' };
  try {
    for (const name of ordered) {
      const raw = await readFile(join(fixturesDir, `${name}.json`), 'utf8');
      const { code, stdout, stderr } = await runEmit(raw, env, dataDir);
      assert.equal(code, 0, `emit.mjs exited nonzero for fixture "${name}": ${stderr}`);
      assert.equal(stdout, '', `emit.mjs printed to stdout for fixture "${name}"`);
    }

    const { spoolPathFor } = await import('../hooks/emit.mjs');
    const spoolPath = spoolPathFor(dataDir, { hubUrl: 'http://127.0.0.1:1', apiKey: 'test-key', workspace: 'default' });
    const spoolRaw = await readFile(spoolPath, 'utf8');
    const lines = spoolRaw.split('\n').filter((l) => l.trim().length > 0);
    assert.ok(lines.length > 0, 'expected at least one spooled event from the real fixtures');
    const events = lines.map((l) => JSON.parse(l));

    for (const event of events) {
      const result = validateEvent(event);
      assert.equal(result.ok, true, result.ok ? '' : `event ${event.id} (${event.type} on ${event.node}) invalid: ${result.reason}`);
    }

    const serialized = JSON.stringify(events);
    for (const needle of forbidden) {
      assert.equal(serialized.includes(needle), false, `forbidden content leaked into emitted events: ${JSON.stringify(needle.slice(0, 80))}`);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
