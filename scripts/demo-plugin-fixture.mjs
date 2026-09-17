#!/usr/bin/env node
// Small helper shared by scripts/demo-plugin.sh and scripts/demo-plugin.ps1:
// reads one of plugins/claude-code/tests/fixtures/*.json, rewrites its
// session_id, and prints the result to stdout so it can be piped straight
// into plugins/claude-code/hooks/emit.mjs. Keeps the fixture-rewriting logic
// in one place instead of duplicating JSON munging in both shells.
import { readFileSync } from 'node:fs';

const [, , fixturePath, sessionId] = process.argv;
if (!fixturePath || !sessionId) {
  console.error('usage: node demo-plugin-fixture.mjs <fixture.json> <session_id>');
  process.exit(1);
}

const payload = JSON.parse(readFileSync(fixturePath, 'utf8'));
payload.session_id = sessionId;
process.stdout.write(JSON.stringify(payload));
