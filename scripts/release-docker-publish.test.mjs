import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVersionTags, registryClient } from './release-docker-registry.mjs';
import { publishDocker } from './release-docker-publish.mjs';
const id = letter => `sha256:${letter.repeat(64)}`;
const expected = { amd64: id('a'), arm64: id('b') };
const images = {
  amd64: { digest: id('c'), document: { config: { digest: expected.amd64 } } },
  arm64: { digest: id('d'), document: { config: { digest: expected.arm64 } } },
};
const combined = { digest: id('e'), document: { manifests: Object.entries(images).map(([architecture, image]) => ({ digest: image.digest, platform: { os: 'linux', architecture } })) } };
function registry(initial = {}) {
  const state = { [images.amd64.digest]: images.amd64, [images.arm64.digest]: images.arm64, [combined.digest]: combined, ...initial };
  return { state, manifest: async ref => state[ref] ?? null };
}
test('all immutable architecture and combined tags are checked before any push', async () => {
  const client = registry({ '0.1.1-amd64': images.amd64, '0.1.1-arm64': images.amd64 });
  const commands = [];
  await assert.rejects(publishDocker({ repository: 'test/hub', version: '0.1.1', runId: '123', expected, client, docker: args => commands.push(args) }), /arm64 tag differs/);
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
test('publication combines verified digests, and retries reuse identical version tags', async () => {
  const client = registry(), commands = [];
  const docker = args => {
    commands.push(args);
    if (args[0] === 'push') {
      const tag = args[1].split(':')[1];
      client.state[tag] = images[tag.endsWith('-amd64') ? 'amd64' : 'arm64'];
    } else if (args[0] === 'buildx') {
      const tag = args[args.indexOf('-t') + 1].split(':')[1];
      client.state[tag] = tag === 'latest-amd64' ? images.amd64 : tag === 'latest-arm64' ? images.arm64 : combined;
    }
  };
  const options = { repository: 'test/hub', version: '0.1.1', runId: '123', expected, client, docker };
  await publishDocker(options);
  const create = commands.find(args => args.includes('test/hub:0.1.1') && args[0] === 'buildx');
  assert.deepEqual(create.slice(-2), [`test/hub@${images.amd64.digest}`, `test/hub@${images.arm64.digest}`]);
  assert.equal(commands.filter(args => args[0] === 'push').length, 2);
  commands.length = 0;
  await publishDocker(options);
  assert(!commands.some(args => args[0] === 'push' || args.includes('test/hub:0.1.1')));
  assert(commands.some(args => args.includes(`test/hub@${combined.digest}`)));
});
test('a missing native image blocks combined and latest publication', async () => {
  const client = registry();
  const commands = [];
  await assert.rejects(publishDocker({ repository: 'test/hub', version: '0.1.1', runId: '123', expected, client, docker: args => commands.push(args) }), /amd64 tag differs/);
  assert(!commands.some(args => args[0] === 'buildx'));
});
test('registry lookup distinguishes missing manifests from network/server failures', async () => {
  for (const status of [404, 500]) {
    const client = await registryClient('test/hub', async url => url.includes('auth.docker.io') ? new Response(JSON.stringify({ token: 'test-token' })) : new Response('', { status }));
    if (status === 404) assert.equal(await client.manifest('0.1.1'), null);
    else await assert.rejects(client.manifest('0.1.1'), /500/);
  }
});
