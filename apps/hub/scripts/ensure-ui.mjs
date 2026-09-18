#!/usr/bin/env node
// Part of this package's `prepack` (SPEC.md §6 "Packaging"): `npm pack` /
// `npm publish` of @atriarch/tracery-hub must ship the hosted UI
// (web/dist) so `bin/hub.mjs`'s defaultUiDir() finds something once
// installed into a consumer's node_modules -- even from a clean checkout
// where apps/hub/web was never built. If web/dist is already there (the
// monorepo's own `npm run build` already ran it), this is a no-op.
//
// Every message this script prints, and everything the nested build below
// prints, goes to STDERR ONLY (never stdout) -- `npm pack --json`/`npm
// publish --json` (this is exactly what scripts/publish-check.mjs uses to
// find the produced tarball's filename) treats prepack as part of the same
// process tree and expects its own JSON result on stdout with nothing else
// mixed in; anything this script wrote to stdout would corrupt that JSON.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(hubRoot, '..', '..');
const uiEntry = path.join(hubRoot, 'web', 'dist', 'index.html');

if (existsSync(uiEntry)) {
  console.error('apps/hub prepack: web/dist already built, skipping UI build.');
  process.exit(0);
}

if (!existsSync(path.join(hubRoot, 'web', 'package.json'))) {
  console.error('apps/hub prepack: apps/hub/web is not present; shipping without a hosted UI.');
  process.exit(0);
}

console.error('apps/hub prepack: web/dist missing, building the hosted UI from the repo root...');
const res = spawnSync(
  'npm',
  [
    'run',
    'build',
    '-w',
    '@atriarch/tracery-core',
    '-w',
    '@atriarch/tracery-visualizer',
    '-w',
    '@atriarch/tracery-client',
    '-w',
    '@atriarch/tracery-react',
    '-w',
    '@atriarch/tracery-hub-web',
  ],
  // stdio: route both the nested build's stdout AND stderr to OUR stderr
  // (fd 2) -- see the file-level comment above for why stdout must stay
  // clean. stdin stays 'ignore' since this build is never interactive.
  { cwd: repoRoot, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' },
);
if (res.status !== 0) {
  console.error('apps/hub prepack: building the hosted UI failed.');
  process.exit(res.status ?? 1);
}

if (!existsSync(uiEntry)) {
  console.error(`apps/hub prepack: expected ${uiEntry} to exist after building apps/hub/web, but it does not.`);
  process.exit(1);
}
