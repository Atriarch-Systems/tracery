#!/usr/bin/env node
/**
 * Publish readiness check for the Python client (docs/PUBLISHING.md
 * "PyPI"). Sibling to scripts/publish-check.mjs, kept separate because it
 * drives `python`/`pip`/venv tooling instead of npm.
 *
 * Steps: ensure the `build` package is installed, `python -m build
 * clients/python` to produce a wheel + sdist, create a fresh venv in a
 * scratch dir, install the wheel into it (not `pip install -e`, so this
 * proves the actual built artifact, matching what PyPI would serve), then
 * `python -c "import atriarch.tracery as t; print(t.__name__)"` from
 * inside that venv only.
 *
 * Usage: `node scripts/publish-check-python.mjs`, or
 * `npm run publish:check:python`. Exits non-zero on any failure. Always
 * cleans up its scratch dir.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PYTHON_PKG_DIR = path.join(REPO_ROOT, 'clients', 'python');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
  return Boolean(ok);
}

function findPython() {
  for (const candidate of [process.env.PYTHON, 'python', 'python3']) {
    if (!candidate) continue;
    const res = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (res.status === 0) return candidate;
  }
  throw new Error('no working python/python3 interpreter found on PATH');
}

function run(cmd, args, opts = {}) {
  console.log(`[publish-check-python] $ ${cmd} ${args.join(' ')}`);
  // Every command this script runs (python, pip, venv's own python.exe) is a
  // real executable resolved by name/path, never a Windows .cmd/.bat shim --
  // shell:true would route args through cmd.exe, which mis-splits a `-c`
  // argument containing spaces/semicolons (e.g. "import x; print(x)").
  return spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
}

const PYTHON = findPython();
console.log(`[publish-check-python] using interpreter: ${PYTHON}`);

const scratchRoot = mkdtempSync(path.join(tmpdir(), 'tracery-publish-check-py-'));
const venvDir = path.join(scratchRoot, 'venv');
console.log(`[publish-check-python] scratch dir: ${scratchRoot}`);

let exitCode = 0;
try {
  // 1. ensure `build` is installed for this interpreter
  const buildCheck = run(PYTHON, ['-c', 'import build']);
  if (buildCheck.status !== 0) {
    console.log('[publish-check-python] "build" module missing, installing it...');
    const install = run(PYTHON, ['-m', 'pip', 'install', 'build']);
    check('python -m pip install build', install.status === 0, install.stderr?.trim());
  } else {
    check('"build" module already installed', true);
  }

  // 2. python -m build clients/python
  const distDir = path.join(PYTHON_PKG_DIR, 'dist');
  rmSync(distDir, { recursive: true, force: true }); // stale wheels from a previous run would make step 3 ambiguous
  const buildRes = run(PYTHON, ['-m', 'build', PYTHON_PKG_DIR]);
  console.log(buildRes.stdout);
  if (buildRes.stderr) console.error(buildRes.stderr);
  const wheelFiles = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith('.whl')) : [];
  check('python -m build clients/python', buildRes.status === 0 && wheelFiles.length === 1, `wheels found: ${wheelFiles.join(', ') || 'none'}`);
  if (wheelFiles.length !== 1) throw new Error('expected exactly one wheel in clients/python/dist');
  const wheelPath = path.join(distDir, wheelFiles[0]);
  console.log(`[publish-check-python] built wheel: ${wheelPath}`);

  // 3. fresh venv
  const venvRes = run(PYTHON, ['-m', 'venv', venvDir]);
  check('python -m venv (fresh scratch venv)', venvRes.status === 0, venvRes.stderr?.trim());

  const venvPython = process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

  // 4. install the wheel (not editable -- this is the artifact PyPI would serve)
  const installWheel = run(venvPython, ['-m', 'pip', 'install', wheelPath]);
  check('pip install <wheel> into the fresh venv', installWheel.status === 0, installWheel.stderr?.trim());

  // 5. import from the venv only
  const importRes = run(venvPython, ['-c', 'import atriarch.tracery as t; print(t.__name__)']);
  console.log(importRes.stdout);
  check(
    'python -c "import atriarch.tracery as t; print(t.__name__)"',
    importRes.status === 0 && importRes.stdout.includes('atriarch.tracery'),
    importRes.stderr?.trim(),
  );
} catch (err) {
  console.error(`[publish-check-python] ERROR: ${err.message}`);
  exitCode = 1;
}

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((r) => r.name).join('; ')}`);
  exitCode = 1;
} else if (exitCode === 0) {
  console.log('ALL CHECKS PASSED');
}

try {
  rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(`[publish-check-python] removed scratch dir ${scratchRoot}`);
} catch (err) {
  console.warn(`[publish-check-python] could not fully remove scratch dir ${scratchRoot}: ${err.message}`);
}

process.exit(exitCode);
