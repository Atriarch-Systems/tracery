import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkVersionTags, registryClient, releaseImages, releaseSourceImages } from './release-docker-registry.mjs';
import { publishDocker } from './release-docker-publish.mjs';
const id = letter => `sha256:${letter.repeat(64)}`;
const expected = { amd64: id('a'), arm64: id('b') };
const sources = { amd64: id('f'), arm64: id('0') };
const images = {
  amd64: { digest: id('c'), document: { config: { digest: expected.amd64 } } },
  arm64: { digest: id('d'), document: { config: { digest: expected.arm64 } } },
};
const sourceImages = {
  amd64: { digest: id('1'), document: { config: { digest: sources.amd64 } } },
  arm64: { digest: id('2'), document: { config: { digest: sources.arm64 } } },
};
const index = (digest, set) => ({ digest, document: { manifests: Object.entries(set).map(([architecture, image]) => ({ digest: image.digest, platform: { os: 'linux', architecture } })) } });
const combined = index(id('e'), images);
const sourcesCombined = index(id('3'), sourceImages);
function registry(initial = {}) {
  const state = { ...Object.fromEntries([...Object.values(images), ...Object.values(sourceImages), combined, sourcesCombined].map(m => [m.digest, m])), ...initial };
  return { state, manifest: async ref => state[ref] ?? null };
}
// Simulates pushes and imagetools by recording what each tag would resolve to.
function fakeDocker(client, commands) {
  return args => {
    commands.push(args);
    const tag = args[0] === 'push' ? args[1].split(':')[1] : args[0] === 'buildx' ? args[args.indexOf('-t') + 1].split(':')[1] : null;
    if (!tag) return;
    const arch = tag.endsWith('-arm64') ? 'arm64' : 'amd64';
    if (tag.includes('-sources')) client.state[tag] = tag.endsWith('-sources') ? sourcesCombined : sourceImages[arch];
    else if (args[0] === 'push' || tag.startsWith('latest-')) client.state[tag] = images[arch];
    else client.state[tag] = combined;
  };
}
const options = (client, docker) => ({ repository: 'test/hub', version: '0.1.1', runId: '123', expected, sources, client, docker });
test('all immutable architecture and combined tags are checked before any push', async () => {
  const client = registry({ '0.1.1-amd64': images.amd64, '0.1.1-arm64': images.amd64 });
  const commands = [];
  await assert.rejects(publishDocker(options(client, args => commands.push(args))), /arm64 tag differs/);
  assert.deepEqual(commands, []);
});
test('an existing source tag for other sources blocks publication before any push', async () => {
  for (const initial of [{ '0.1.1-sources-arm64': sourceImages.amd64 }, { '0.1.1-sources-amd64': images.amd64 }, { '0.1.1-sources': combined }]) {
    const commands = [];
    await assert.rejects(publishDocker(options(registry(initial), args => commands.push(args))), /differs|architectures/);
    assert.deepEqual(commands, []);
  }
});
test('publication requires the tested source images', async () => {
  const commands = [];
  await assert.rejects(publishDocker({ ...options(registry(), args => commands.push(args)), sources: undefined }), /source images/);
  assert.deepEqual(commands, []);
});
test('combined tags reject missing, duplicate, wrong-OS and mismatched architectures', async () => {
  for (const mutate of [
    m => m.document.manifests.pop(),
    m => { m.document.manifests[1].platform.architecture = 'amd64'; },
    m => { m.document.manifests[1].platform.os = 'windows'; },
    m => { m.document.manifests[1].digest = images.amd64.digest; },
  ]) {
    const malformed = structuredClone(combined); mutate(malformed);
    await assert.rejects(checkVersionTags(registry({ '0.1.1': malformed }), '0.1.1', expected));
  }
});
test('sources are published before the binaries they accompany, from verified digests', async () => {
  const client = registry(), commands = [];
  await publishDocker(options(client, fakeDocker(client, commands)));
  const pushes = commands.filter(args => args[0] === 'push').map(args => args[1]);
  assert.deepEqual(pushes, ['test/hub:0.1.1-sources-amd64', 'test/hub:0.1.1-sources-arm64', 'test/hub:0.1.1-amd64', 'test/hub:0.1.1-arm64']);
  const sourcesCreate = commands.findIndex(args => args[0] === 'buildx' && args.includes('test/hub:0.1.1-sources'));
  assert(sourcesCreate >= 0 && sourcesCreate < commands.findIndex(args => args[0] === 'push' && args[1] === 'test/hub:0.1.1-amd64'));
  assert.deepEqual(commands[sourcesCreate].slice(-2), [`test/hub@${sourceImages.amd64.digest}`, `test/hub@${sourceImages.arm64.digest}`]);
  assert.deepEqual(commands.find(args => args[0] === 'tag' && args[2] === 'test/hub:0.1.1-sources-arm64'), ['tag', 'tracery-release-sources:123-arm64', 'test/hub:0.1.1-sources-arm64']);
  assert(!commands.some(args => args.some(arg => /latest-sources|sources.*latest/.test(arg))), 'latest aliases point only at runtime images');
});
test('publication combines verified digests, and retries reuse identical version tags', async () => {
  const client = registry(), commands = [];
  await publishDocker(options(client, fakeDocker(client, commands)));
  const create = commands.find(args => args.includes('test/hub:0.1.1') && args[0] === 'buildx');
  assert.deepEqual(create.slice(-2), [`test/hub@${images.amd64.digest}`, `test/hub@${images.arm64.digest}`]);
  assert.equal(commands.filter(args => args[0] === 'push').length, 4);
  commands.length = 0;
  await publishDocker(options(client, fakeDocker(client, commands)));
  assert(!commands.some(args => args[0] === 'push' || args.includes('test/hub:0.1.1') || args.includes('test/hub:0.1.1-sources')));
  assert(commands.some(args => args.includes(`test/hub@${combined.digest}`)));
});
test('a missing native image blocks combined and latest publication', async () => {
  const client = registry();
  const commands = [];
  await assert.rejects(publishDocker(options(client, args => commands.push(args))), /amd64 tag differs/);
  assert(!commands.some(args => args[0] === 'buildx'));
});
test('saved runtime and source image IDs are read per architecture', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tracery-release-ids-'));
  try {
    for (const arch of ['amd64', 'arm64']) {
      mkdirSync(path.join(directory, arch));
      writeFileSync(path.join(directory, arch, 'image-id.txt'), `${expected[arch]}\n`);
      writeFileSync(path.join(directory, arch, 'sources-image-id.txt'), `${sources[arch]}\n`);
    }
    assert.deepEqual(releaseImages(directory), expected);
    assert.deepEqual(releaseSourceImages(directory), sources);
    writeFileSync(path.join(directory, 'arm64', 'sources-image-id.txt'), 'not-a-digest\n');
    assert.throws(() => releaseSourceImages(directory), /Invalid saved arm64 sources-image-id\.txt/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('registry lookup distinguishes missing manifests from network/server failures', async () => {
  for (const status of [404, 500]) {
    const client = await registryClient('test/hub', async url => url.includes('auth.docker.io') ? new Response(JSON.stringify({ token: 'test-token' })) : new Response('', { status }));
    if (status === 404) assert.equal(await client.manifest('0.1.1'), null);
    else await assert.rejects(client.manifest('0.1.1'), /500/);
  }
});

test('expired anonymous pull tokens are renewed after long image uploads', async () => {
  let authCalls = 0, manifestCalls = 0;
  const client = await registryClient('test/hub', async (url, options) => {
    if (url.includes('auth.docker.io')) return new Response(JSON.stringify({ token: `token-${++authCalls}` }));
    if (++manifestCalls === 1) return new Response('', { status: 401 });
    assert.equal(options.headers.Authorization, 'Bearer token-2');
    return new Response(JSON.stringify(images.amd64.document));
  });
  assert.equal((await client.manifest('0.1.1-amd64')).document.config.digest, expected.amd64);
  assert.equal(authCalls, 2);
});
