import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDockerRepository } from './release-docker-repository.mjs';
const config = { image: 'example/tracery-hub', username: 'maintainer', token: 'test-credential' };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
function fake(responses) {
  const calls = [];
  return { calls, request: async (url, options = {}) => { calls.push({ url, ...options }); const result = responses.shift(); assert(result, 'Unexpected request'); return result; } };
}
const authenticated = () => response(200, { access_token: 'test-session' });
const publicRepo = () => response(200, { is_private: false, permissions: { write: true } });
test('creates only the configured missing repository and explicitly makes it public', async () => {
  const mock = fake([authenticated(), response(404, {}), publicRepo(), publicRepo()]);
  await ensureDockerRepository(config, mock.request);
  const create = mock.calls[2];
  assert.equal(create.url, 'https://hub.docker.com/v2/namespaces/example/repositories');
  assert.equal(create.method, 'POST');
  const body = JSON.parse(create.body);
  assert.equal(body.name, 'tracery-hub');
  assert.equal(body.namespace, 'example');
  assert.equal(body.is_private, false);
  assert.equal(mock.calls[3].headers, undefined, 'Public visibility must be tested without credentials');
});
test('existing public repository is reused without changing metadata', async () => {
  const mock = fake([authenticated(), publicRepo(), publicRepo()]);
  await ensureDockerRepository(config, mock.request);
  assert.equal(mock.calls.filter(call => call.method === 'POST').length, 1, 'Only authentication uses POST');
});
test('private repository and failed lookups never trigger a visibility change or creation', async () => {
  for (const lookup of [response(200, { is_private: true }), response(500, {})]) {
    const mock = fake([authenticated(), lookup]);
    await assert.rejects(ensureDockerRepository(config, mock.request));
    assert.equal(mock.calls.length, 2);
  }
});
test('invalid configuration, failed authentication and missing write rights block publication', async () => {
  const invalid = fake([]);
  await assert.rejects(ensureDockerRepository({ ...config, image: '../wrong' }, invalid.request));
  assert.equal(invalid.calls.length, 0);
  await assert.rejects(ensureDockerRepository(config, fake([response(401, {})]).request), /authentication failed/);
  await assert.rejects(ensureDockerRepository(config, fake([authenticated(), response(200, { is_private: false, permissions: { write: false } })]).request), /write permission/);
});
