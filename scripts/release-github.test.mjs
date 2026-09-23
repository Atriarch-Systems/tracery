import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReleaseTag, ensureDraftRelease, publishReleaseEvidence } from './release-github.mjs';
const sha = 'a'.repeat(40), tagSha = 'b'.repeat(40), tag = 'v0.1.1';
test('manual release creates an annotated tag at the tested commit and starts as a draft', async () => {
  const calls = [];
  const api = async (route, options = {}) => {
    calls.push({ route, ...options });
    if (route.startsWith('/git/ref/')) return null;
    if (route === '/git/tags') return { sha: tagSha };
    if (route === '/git/refs') return { object: { type: 'tag', sha: tagSha } };
    if (route === `/git/tags/${tagSha}`) return { object: { type: 'commit', sha } };
    if (route.startsWith('/releases/tags/')) return null;
    if (route === '/releases') return { id: 1, ...options.body };
    throw Error(route);
  };
  const release = await ensureDraftRelease(api, tag, sha);
  assert.equal(release.draft, true);
  assert.equal(calls.find(call => call.route === '/git/tags').body.object, sha);
  assert.equal(calls.find(call => call.route === '/git/refs').body.sha, tagSha);
});
test('existing matching lightweight and annotated tags are reusable without writes', async () => {
  for (const type of ['tag', 'commit']) {
    await ensureReleaseTag(async (route, options) => {
      assert(!options?.method);
      return { object: route.startsWith('/git/ref/') && type === 'tag' ? { type, sha: tagSha } : { type: 'commit', sha } };
    }, tag, sha);
  }
});
test('an existing tag on another commit is never moved or released', async () => {
  const calls = [];
  await assert.rejects(ensureDraftRelease(async route => {
    calls.push(route);
    return { object: { type: 'commit', sha: 'c'.repeat(40) } };
  }, tag, sha), /another commit/);
  assert.deepEqual(calls, [`/git/ref/tags/${tag}`]);
});
test('GitHub release stays draft until every asset is uploaded or verified', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tracery-release-test-'));
  const file = path.join(directory, 'evidence.txt');
  writeFileSync(file, 'verified evidence');
  const release = { id: 1, draft: true, assets: [], upload_url: 'https://uploads.github.com/test{?name,label}' };
  try {
    const calls = [];
    await publishReleaseEvidence(async (route, options) => { calls.push({ route, ...options }); return {}; }, release, [{ file, name: 'evidence.txt' }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[1].body.draft, false);
    const retry = { ...release, assets: [{ id: 7, name: 'evidence.txt' }] };
    await assert.rejects(publishReleaseEvidence(async (_route, options) => {
      assert(options.binary, 'a mismatch must not publish the draft');
      return Buffer.from('different');
    }, retry, [{ file, name: 'evidence.txt' }]), /differs/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
