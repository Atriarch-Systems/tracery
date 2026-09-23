import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseContext } from './release-context.mjs';
const manual = { event: 'workflow_dispatch', ref: 'refs/heads/main', operation: 'validate', version: '' };
test('manual validation never enables publication or requires a version input', () => {
  assert.deepEqual(releaseContext(manual, '0.1.1'), { tag: 'v0.1.1', version: '0.1.1', publish: false });
});
test('manual publication requires main and an exact prepared version', () => {
  assert.equal(releaseContext({ ...manual, operation: 'publish', version: '0.1.1' }, '0.1.1').publish, true);
  for (const input of [{ operation: 'publish' }, { operation: 'publish', version: '0.1.0' }, { ref: 'refs/heads/other' }, { operation: 'unknown' }]) {
    assert.throws(() => releaseContext({ ...manual, ...input }, '0.1.1'));
  }
});
test('external tag pushes still work, but cannot release another version or a prerelease', () => {
  assert.equal(releaseContext({ event: 'push', ref: 'refs/tags/v0.1.1' }, '0.1.1').publish, true);
  for (const ref of ['refs/heads/main', 'refs/tags/v0.1.0', 'refs/tags/v0.1.1-rc.1']) assert.throws(() => releaseContext({ event: 'push', ref }, '0.1.1'));
  assert.throws(() => releaseContext(manual, '0.01.1'));
});
