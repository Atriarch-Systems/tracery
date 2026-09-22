import fs from 'node:fs';
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const allowed = new Set(['MIT','ISC','Apache-2.0','BSD-2-Clause','BSD-3-Clause','0BSD','Unlicense','MS-PL','Zlib','BlueOak-1.0.0']);
const failures = []; let checked = 0;
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location.includes('node_modules/') || pkg.link) continue;
  checked++;
  // caniuse-lite is development-only browser compatibility data; retain attribution if redistributing it.
  const reviewedData = location.endsWith('node_modules/caniuse-lite') && pkg.license === 'CC-BY-4.0' && pkg.dev === true;
  if (!allowed.has(pkg.license) && !reviewedData) failures.push(location + ': ' + (pkg.license ?? 'UNKNOWN'));
}
if (!checked) throw new Error('No dependency inventory found');
if (failures.length) throw new Error('Unapproved dependency licenses; review before release:\n' + failures.join('\n'));
console.log('PASS: ' + checked + ' locked third-party entries satisfy the reviewed license policy');
