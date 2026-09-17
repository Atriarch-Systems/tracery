// Validates the plugin packaging itself: the repo-root marketplace manifest
// and the plugin manifest parse as JSON, the marketplace entry's `source`
// resolves to this plugin directory, and every file `plugin.json` /
// `hooks.json` reference by path actually exists on disk. This is what
// catches "renamed hooks/emit.mjs but forgot hooks.json" or "marketplace.json
// points at a plugin dir that moved" before a user's `/plugin install` does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..'); // plugins/claude-code
const repoRoot = resolve(pluginRoot, '..', '..');

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

test('plugin.json parses and its hooks/skills paths resolve to real files', async () => {
  const plugin = await readJson(join(pluginRoot, '.claude-plugin', 'plugin.json'));
  assert.equal(plugin.name, 'tracery');
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
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(skillsPath, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());
  assert.ok(skillDirs.length > 0, `no skill directories found under ${plugin.skills}`);
  for (const dir of skillDirs) {
    const skillMd = join(skillsPath, dir.name, 'SKILL.md');
    assert.ok(await exists(skillMd), `skills/${dir.name} has no SKILL.md`);
  }
});
