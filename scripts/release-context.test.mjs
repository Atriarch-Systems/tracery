import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deployManifestErrors, releaseContext } from './release-context.mjs';
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
test('Helm appVersion and the k8s manifest image tag must equal the package version', () => {
  const chart = (appVersion) => `apiVersion: v2\nname: tracery-hub\nversion: 0.1.1\nappVersion: ${appVersion}\n`;
  const manifest = (tag) => `spec:\n  containers:\n    - name: hub\n      image: atriarchsystems/tracery-hub:${tag}\n`;
  assert.deepEqual(deployManifestErrors('0.1.2', chart('"0.1.2"'), manifest('0.1.2')), []);
  assert.deepEqual(deployManifestErrors('0.1.2', chart('0.1.2'), manifest('0.1.2')), []);
  assert.equal(deployManifestErrors('0.1.2', chart('"0.1.1"'), manifest('0.1.2')).length, 1);
  assert.equal(deployManifestErrors('0.1.2', chart('"0.1.2"'), manifest('0.1.1')).length, 1);
  assert.equal(deployManifestErrors('0.1.2', 'name: tracery-hub\n', 'kind: Deployment\n').length, 2);
});
test('the checked-in chart and manifest match the root package version', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const { version } = JSON.parse(read('package.json'));
  assert.deepEqual(deployManifestErrors(version, read('apps/hub/helm/Chart.yaml'), read('apps/hub/k8s/deployment.yaml')), []);
});
