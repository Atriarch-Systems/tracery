import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('core declarations compile with no renderer, React, DOM, or ambient types installed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tracery-core-types-'));
  try {
    const pkg = path.join(dir, 'node_modules/@atriarch/tracery-core');
    mkdirSync(pkg, { recursive: true });
    cpSync(new URL('../dist/', import.meta.url), path.join(pkg, 'dist'), { recursive: true });
    cpSync(new URL('../package.json', import.meta.url), path.join(pkg, 'package.json'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(dir, 'consumer.ts'), "import { Journal, project, type ActivityNode } from '@atriarch/tracery-core';\nconst node: ActivityNode = { id: 'a', label: 'A' };\nnew Journal().append([]); project(new Map(), { mode: 'flow', flow: 'f' });\n");
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      module: 'NodeNext', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: false, lib: ['ES2022'], types: [],
    }, files: ['consumer.ts'] }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)), '-p', dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
