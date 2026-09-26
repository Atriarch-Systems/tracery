import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordedDigest, verifySourceArchive } from './release-sources.mjs';

const [image, sourcesImage] = process.argv.slice(2);
if (!image || !sourcesImage) throw new Error('Usage: node scripts/release-image-check.mjs IMAGE SOURCES_IMAGE [artifact-directory] [amd64|arm64]');
const expectedArch = process.argv[5] ?? ({ x64: 'amd64', arm64: 'arm64' })[process.arch];
assert(['amd64', 'arm64'].includes(expectedArch), 'Expected a supported release architecture');
assert.equal(process.arch, expectedArch === 'amd64' ? 'x64' : 'arm64', 'Smoke tests must run natively');
const out = path.resolve(process.argv[4] ?? 'artifacts/container');
mkdirSync(out, { recursive: true });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 }).trim();
const suffix = `${process.pid}-${Date.now()}`;
const name = `tracery-release-${suffix}`;
const reject = `${name}-reject`;
const sourcesContainer = `${name}-sources`;
const volume = `${name}-data`;
const scratch = mkdtempSync(path.join(tmpdir(), 'tracery-image-check-'));
const version = JSON.parse(readFileSync(new URL('../apps/hub/package.json', import.meta.url))).version;
const runtimeUid = 10001;
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
// The image has no shell: in-container checks are Node programs.
const inImage = source => docker('exec', name, 'node', '-e', source);
try {
  assert.equal(docker('image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}'), `linux/${expectedArch}`);
  assert.equal(docker('image', 'inspect', sourcesImage, '--format', '{{.Os}}/{{.Architecture}}'), `linux/${expectedArch}`);
  assert.equal(docker('image', 'inspect', image, '--format', '{{.Config.User}}'), `${runtimeUid}:${runtimeUid}`, 'Image must declare a numeric non-root user');
  assert.equal(JSON.parse(docker('image', 'inspect', image, '--format', '{{json .Config.Healthcheck.Test}}'))[0], 'CMD', 'Health check must not need a shell');
  docker('volume', 'create', volume);
  // Run with the documented hardening: read-only root, no capabilities, no privilege gain.
  docker('run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-p', '127.0.0.1::8971', '-e', 'TRACERY_AUTH=none', '-e', 'TRACERY_STORE=sqlite', '-v', `${volume}:/data`, image);
  await ready();
  const info = await json('/v1/info');
  assert.equal(info.edition, 'community');
  assert.equal(info.version, version);
  const policy = JSON.parse(readFileSync(new URL('../licenses/container-policy.json', import.meta.url)));
  assert.equal(docker('exec', name, 'node', '-p', 'process.versions.node'), policy.nodeVersion);
  assert.equal(docker('exec', name, 'node', '-p', 'process.arch'), expectedArch === 'amd64' ? 'x64' : 'arm64');
  assert.equal(info.auth, 'none');
  const ui = await (await fetch(`${base}/ui/`)).text();
  assert(ui.includes('Tracery Graph') && ui.includes('tracery-licenses'), 'Hosted UI and embedded notices required');
  assert.equal(docker('exec', name, 'node', '-p', '`${process.getuid()}:${process.getgid()}`'), `${runtimeUid}:${runtimeUid}`, 'Runtime must be uid/gid 10001');
  inImage(`const fs=require('fs'); for(const p of ['/app/LICENSE','/app/NOTICE','/app/RUNTIME-NOTICES.txt','/app/THIRD-PARTY-NOTICES.txt','/usr/share/licenses/node/LICENSE','/usr/share/tracery/SOURCES.txt']) if(fs.statSync(p).size<100) throw Error(p); for(const p of ['/usr/local/lib/node_modules/npm','/usr/local/lib/node_modules/corepack','/opt/yarn-v1.22.22','/bin/sh','/bin/busybox','/sbin/apk','/usr/bin/wget','/usr/bin/nc','/bin/su','/usr/share/tracery/sources.tar.gz']) if(fs.existsSync(p)) throw Error('Unnecessary runtime content: '+p)`);
  // App code must be root-owned and not group/world-writable, so it stays
  // immutable even without a read-only mount. No setuid/setgid files, and
  // nothing outside /tmp and /data is world-writable.
  inImage(`const fs=require('fs'),path=require('path'),uid=${runtimeUid};
    const walk=(dir,visit)=>{for(const entry of fs.readdirSync(dir)){const p=path.join(dir,entry),s=fs.lstatSync(p);visit(p,s);if(s.isDirectory())walk(p,visit)}};
    const app=(p,s)=>{if(s.uid!==0||s.gid===uid||(!s.isSymbolicLink()&&(s.mode&0o022)))throw Error('Writable by the runtime user: '+p)};
    app('/app',fs.lstatSync('/app')); walk('/app',app);
    const check=(p,s)=>{if(s.mode&0o6000)throw Error('setuid/setgid: '+p);if(!s.isSymbolicLink()&&(s.mode&0o002))throw Error('World-writable: '+p)};
    for(const top of fs.readdirSync('/')){if(['proc','sys','dev','tmp','data'].includes(top))continue;const p='/'+top,s=fs.lstatSync(p);check(p,s);if(s.isDirectory())walk(p,check)}
    if(fs.statSync('/data').uid!==uid)throw Error('/data must belong to the runtime user')`);
  for (const [from, to] of [
    ['/usr/share/tracery/sources.tar.gz.sha256', 'sources.tar.gz.sha256'], ['/usr/share/tracery/alpine-packages.json', 'alpine-packages.json'],
    ['/usr/share/tracery/SOURCES.txt', 'SOURCES.txt'], ['/usr/share/licenses/node/LICENSE', 'NODE-LICENSE'], ['/app/RUNTIME-NOTICES.txt', 'RUNTIME-NOTICES.txt'],
  ]) docker('cp', `${name}:${from}`, path.join(out, to));
  docker('cp', `${name}:/lib/apk/db/installed`, path.join(scratch, 'installed'));
  // The companion source image cannot run; copy its files out of a created container.
  docker('create', '--name', sourcesContainer, sourcesImage, 'unused');
  for (const file of ['sources.tar.gz', 'sources.tar.gz.sha256', 'alpine-packages.json', 'SOURCES.txt']) {
    docker('cp', `${sourcesContainer}:/${file}`, path.join(file === 'sources.tar.gz' ? out : scratch, file));
    if (file !== 'sources.tar.gz') assert(readFileSync(path.join(scratch, file)).equals(readFileSync(path.join(out, file))), `Source image ${file} differs from the runtime image`);
  }
  const digest = recordedDigest(readFileSync(path.join(out, 'sources.tar.gz.sha256'), 'utf8'));
  const sourcesText = readFileSync(path.join(out, 'SOURCES.txt'), 'utf8');
  for (const expected of [digest, `:${version}-sources`, `/releases/tag/v${version}`, `container-${expectedArch}-sources.tar.gz`, 'Written offer']) {
    assert(sourcesText.includes(expected), `SOURCES.txt must name ${expected}`);
  }
  const { files } = verifySourceArchive({
    archive: readFileSync(path.join(out, 'sources.tar.gz')), digest,
    installed: readFileSync(path.join(scratch, 'installed')), inventory: readFileSync(path.join(out, 'alpine-packages.json')),
  });
  console.log(`Verified ${files} source archive files against the image's APK database`);
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
  console.log('PASS: hardened non-root image, immutable app, no OS tooling, UI/notices, published-source checksums, live tracing, SQLite persistence and secure auth default');
} finally {
  for (const container of [name, reject, sourcesContainer]) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
  rmSync(scratch, { recursive: true, force: true });
}
