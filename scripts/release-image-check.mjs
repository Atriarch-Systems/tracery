import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/release-image-check.mjs IMAGE [artifact-directory]');
const out = path.resolve(process.argv[3] ?? 'artifacts/container');
mkdirSync(out, { recursive: true });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 }).trim();
const suffix = `${process.pid}-${Date.now()}`;
const name = `tracery-release-${suffix}`;
const reject = `${name}-reject`;
const volume = `${name}-data`;
let base;
async function ready() {
  const binding = JSON.parse(docker('inspect', name))[0].NetworkSettings.Ports['8971/tcp'][0];
  base = `http://127.0.0.1:${binding.HostPort}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Container did not become ready: ${docker('logs', name)}`);
}
async function json(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10_000) });
  assert(response.ok, `${route}: ${response.status}`);
  return response.json();
}
try {
  docker('volume', 'create', volume);
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8971', '-e', 'TRACERY_AUTH=none', '-e', 'TRACERY_STORE=sqlite', '-v', `${volume}:/data`, image);
  await ready();
  const info = await json('/v1/info');
  assert.equal(info.edition, 'community');
  assert.equal(info.auth, 'none');
  const ui = await (await fetch(`${base}/ui/`)).text();
  assert(ui.includes('Tracery') && ui.includes('tracery-licenses'), 'Hosted UI and embedded notices required');
  const uid = docker('exec', name, 'node', '-p', 'process.getuid()');
  assert.notEqual(uid, '0', 'Runtime must be non-root');
  docker('exec', name, 'node', '-e', `const fs=require('fs'); for(const p of ['/app/LICENSE','/app/NOTICE','/app/RUNTIME-NOTICES.txt','/app/THIRD-PARTY-NOTICES.txt','/usr/share/licenses/node/LICENSE']) if(fs.statSync(p).size<100) throw Error(p); for(const p of ['/usr/local/lib/node_modules/npm','/usr/local/lib/node_modules/corepack','/opt/yarn-v1.22.22']) if(fs.existsSync(p)) throw Error('Unnecessary runtime tooling: '+p)`);
  // Source checks execute unprivileged in this disposable test container.
  docker('exec', name, 'sh', '-ec', 'mkdir /tmp/source-check; tar -xzf /usr/share/tracery/sources.tar.gz -C /tmp/source-check; cd /tmp/source-check/sources; sha256sum -c SHA256SUMS > /dev/null; cmp packages.json /usr/share/tracery/alpine-packages.json; cmp installed.apk.txt /lib/apk/db/installed');
  for (const file of ['sources.tar.gz', 'alpine-packages.json', 'SOURCES.txt']) docker('cp', `${name}:/usr/share/tracery/${file}`, path.join(out, file));
  docker('cp', `${name}:/usr/share/licenses/node/LICENSE`, path.join(out, 'NODE-LICENSE'));
  const fixture = spawnSync(process.execPath, ['scripts/publish-check-demo.template.mjs'], { env: { ...process.env, TRACERY_HUB_URL: base, TRACERY_API_KEY: '' }, stdio: 'inherit', timeout: 30_000 });
  assert.equal(fixture.status, 0, 'Live trace fixture must pass');
  const before = await json('/v1/flows');
  assert.equal(before.flows.length, 3);
  docker('restart', name);
  await ready();
  const after = await json('/v1/flows');
  assert.deepEqual(after.flows, before.flows, 'SQLite flows survive restart');
  const denied = spawnSync('docker', ['run', '--name', reject, image], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(denied.status, 1, 'Unauthenticated network configuration must fail closed');
  console.log('PASS: non-root image, UI/notices, source checksums, live tracing, SQLite persistence and secure auth default');
} finally {
  for (const container of [name, reject]) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
}
