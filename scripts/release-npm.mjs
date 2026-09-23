// Publish only the exact tarballs that passed publish:check in this workflow run.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'artifacts/npm');
const packages = JSON.parse(readFileSync(path.join(directory, 'packages.json'), 'utf8'));
const expected = ['core', 'visualizer', 'client', 'react', 'hub'].map(name => `@atriarch/tracery-${name}`);
if (JSON.stringify(packages.map(pkg => pkg.name)) !== JSON.stringify(expected)) throw new Error('Unexpected package set/order');
for (const pkg of packages) {
  if (!/^[a-z0-9.-]+\.tgz$/.test(pkg.filename)) throw new Error('Invalid tarball filename');
  const tarball = path.join(directory, pkg.filename);
  const bytes = readFileSync(tarball);
  if (createHash('sha256').update(bytes).digest('hex') !== pkg.sha256 ||
      `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== pkg.integrity) {
    throw new Error(`Artifact digest mismatch: ${pkg.name}`);
  }
}
// Check every already-published version before publishing anything. A retry may
// skip an identical immutable package, but never silently skip different bytes.
const pending = [];
for (const pkg of packages) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
  if (response.status === 404) { pending.push(pkg); continue; }
  if (!response.ok) throw new Error(`Registry lookup failed: ${response.status} for ${pkg.name}`);
  const existing = await response.json();
  if (existing.dist?.integrity !== pkg.integrity) throw new Error(`Version already exists with different bytes: ${pkg.name}@${pkg.version}`);
  console.log(`Already published, matching integrity: ${pkg.name}@${pkg.version}`);
}
for (const pkg of pending) {
  const result = spawnSync('npm', ['publish', path.join(directory, pkg.filename), '--access', 'public', '--ignore-scripts', '--registry', 'https://registry.npmjs.org/'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Publish failed: ${pkg.name}@${pkg.version}`);
}
