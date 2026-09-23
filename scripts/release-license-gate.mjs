import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const permissive = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Unlicense', 'MS-PL', 'Zlib', 'BlueOak-1.0.0', 'CC0-1.0']);
// These are findings in Node's single, preserved upstream notice file. Autoconf
// output exceptions do not make the independent Node/Tracery application GPL.
const nodeNotices = new Set(['GPL-2.0-with-autoconf-exception', 'GPL-3.0-with-autoconf-exception', 'Artistic-2.0', 'ICU', 'LicenseRef-C-Ares', 'NAIST-2003', 'Unicode-3.0', 'Unicode-DFS-2016', 'BSD-2-Clause-FreeBSD']);
const canonical = packages => JSON.stringify(packages.map(p => ({ name: p.name, version: p.version, license: p.license, origin: p.origin, aportsCommit: p.aportsCommit })).sort((a, b) => a.name.localeCompare(b.name)));

export function checkReleaseScan(scan, { policy, inventory, nodeLicense, architecture } = {}) {
  const failures = [];
  const results = scan.Results ?? [];
  if (!results.length) throw new Error('Empty scan; refusing release');
  const image = Boolean(policy);
  if (image) {
    if (architecture) {
      const apkArch = { amd64: 'x86_64', arm64: 'aarch64' }[architecture];
      if (!apkArch || !inventory?.length || inventory.some(p => ![apkArch, 'noarch'].includes(p.architecture))) failures.push('Source inventory architecture does not match the tested image');
    }
    if (!inventory?.length || canonical(inventory) !== canonical(policy.alpinePackages)) failures.push('Alpine inventory differs from the reviewed source/license policy');
    if (!nodeLicense || createHash('sha256').update(nodeLicense).digest('hex') !== policy.nodeLicenseSha256) failures.push('Node license text differs from the reviewed version');
    const os = results.find(result => result.Class === 'os-pkgs' && result.Type === 'alpine');
    const actual = (os?.Packages ?? []).map(p => `${p.Name}@${p.Version}`).sort();
    const expected = (inventory ?? []).map(p => `${p.name}@${p.version}`).sort();
    if (!actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) failures.push('Image OS packages do not match the accompanying source inventory');
    if (!results.some(result => result.Class === 'lang-pkgs' && result.Type === 'node-pkg')) failures.push('Missing image application package scan');
  }
  let licenses = 0;
  for (const result of results) {
    for (const finding of result.Vulnerabilities ?? []) {
      if (['HIGH', 'CRITICAL'].includes(finding.Severity)) failures.push(`${finding.Severity}: ${finding.VulnerabilityID} in ${finding.PkgName}`);
    }
    if (result.Secrets?.length) failures.push(`Secret findings in ${result.Target}`);
    for (const finding of result.Licenses ?? []) {
      licenses++;
      if (permissive.has(finding.Name)) continue;
      if (image && result.Target === 'OS Packages') {
        const pkg = policy.alpinePackages.find(p => p.name === finding.PkgName);
        if (pkg && pkg.license.split(' AND ').includes(finding.Name)) continue;
      }
      if (image && finding.FilePath === 'usr/share/licenses/node/LICENSE' && nodeNotices.has(finding.Name)) continue;
      failures.push(`Unreviewed license ${finding.Name}: ${finding.PkgName || finding.FilePath}`);
    }
  }
  if (!licenses) failures.push('No license findings; refusing an empty license scan');
  if (failures.length) throw new Error(failures.join('\n'));
  return licenses;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scanPath, inventoryPath, nodeLicensePath, architecture] = process.argv.slice(2);
  const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
  const options = inventoryPath ? {
    policy: JSON.parse(readFileSync(new URL('../licenses/container-policy.json', import.meta.url), 'utf8')),
    inventory: JSON.parse(readFileSync(inventoryPath, 'utf8')),
    nodeLicense: readFileSync(nodeLicensePath),
    architecture,
  } : {};
  console.log(`PASS: ${checkReleaseScan(scan, options)} final-artifact license findings reviewed; no blocked findings in the supplied scan`);
}
