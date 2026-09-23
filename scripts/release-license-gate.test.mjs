import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReleaseScan } from './release-license-gate.mjs';
const scan = (licenses, extra = {}) => ({ Results: [{ Target: 'Node.js', Licenses: licenses.map(Name => ({ Name, PkgName: 'dependency' })), ...extra }] });
test('accepts reviewed permissive licenses, including scanner-unknown Blue Oak', () => {
  assert.equal(checkReleaseScan(scan(['MIT', 'BlueOak-1.0.0'])), 2);
});
test('blocks copyleft, missing and unfamiliar application licenses', () => {
  for (const license of ['GPL-3.0-only', 'AGPL-3.0-only', 'SSPL-1.0', 'LGPL-2.1-only', 'UNKNOWN', undefined]) {
    assert.throws(() => checkReleaseScan(scan([license])), /Unreviewed license/);
  }
});
test('does not turn a Node notice exception into a blanket application exception', () => {
  assert.throws(() => checkReleaseScan(scan(['GPL-3.0-with-autoconf-exception'])), /Unreviewed license/);
});
test('empty scans, high vulnerabilities and secrets block publication', () => {
  assert.throws(() => checkReleaseScan({}), /Empty scan/);
  assert.throws(() => checkReleaseScan(scan([])), /No license findings/);
  assert.throws(() => checkReleaseScan(scan(['MIT'], { Vulnerabilities: [{ Severity: 'HIGH', VulnerabilityID: 'test', PkgName: 'test' }] })), /HIGH/);
  assert.throws(() => checkReleaseScan(scan(['MIT'], { Secrets: [{}] })), /Secret findings/);
});

test('image exceptions require exact sources and Node notices, and never cover application GPL', async () => {
  const { createHash } = await import('node:crypto');
  const nodeLicense = Buffer.from('reviewed upstream notice');
  const inventory = [{ name: 'busybox', version: '1.0-r0', license: 'GPL-2.0-only', origin: 'busybox', aportsCommit: 'a'.repeat(40) }];
  const policy = { alpinePackages: inventory, nodeLicenseSha256: createHash('sha256').update(nodeLicense).digest('hex') };
  const image = { Results: [
    { Class: 'os-pkgs', Type: 'alpine', Packages: [{ Name: 'busybox', Version: '1.0-r0' }] },
    { Class: 'lang-pkgs', Type: 'node-pkg' },
    { Target: 'OS Packages', Licenses: [{ PkgName: 'busybox', Name: 'GPL-2.0-only' }] },
    { Target: 'Loose File License(s)', Licenses: [{ Name: 'GPL-3.0-with-autoconf-exception', FilePath: 'usr/share/licenses/node/LICENSE' }] },
  ] };
  const options = { policy, inventory, nodeLicense };
  for (const [architecture, apkArch] of [['amd64', 'x86_64'], ['arm64', 'aarch64']]) {
    assert.equal(checkReleaseScan(image, { ...options, architecture, inventory: inventory.map(p => ({ ...p, architecture: apkArch })) }), 2);
    assert.throws(() => checkReleaseScan(image, { ...options, architecture, inventory: inventory.map(p => ({ ...p, architecture: 'wrong' })) }), /architecture does not match/);
  }
  assert.equal(checkReleaseScan(image, options), 2);
  assert.throws(() => checkReleaseScan(image, { ...options, nodeLicense: Buffer.from('changed') }), /Node license text differs/);
  assert.throws(() => checkReleaseScan(image, { ...options, inventory: [{ ...inventory[0], aportsCommit: 'b'.repeat(40) }] }), /Alpine inventory differs/);
  const incomplete = structuredClone(image);
  incomplete.Results[0].Packages = [];
  assert.throws(() => checkReleaseScan(incomplete, options), /do not match/);
  const application = structuredClone(image);
  application.Results[3].Licenses[0].FilePath = 'app/node_modules/example/LICENSE';
  assert.throws(() => checkReleaseScan(application, options), /Unreviewed license/);
});
