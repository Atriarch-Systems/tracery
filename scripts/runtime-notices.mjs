// Run after npm prune --omit=dev in the Docker build. Preserve actual license
// texts for every installed third-party runtime package, including nested deps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const notices = [];
function modules(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const location = path.join(directory, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) { modules(location); continue; }
    if (!entry.isDirectory()) continue; // workspace symlinks are first-party
    const manifest = path.join(location, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!pkg.name || !pkg.version) throw Error(`Unidentified installed package: ${location}`);
    let texts = fs.readdirSync(location).filter(name => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(name) && fs.statSync(path.join(location, name)).isFile()).map(name => fs.readFileSync(path.join(location, name), 'utf8'));
    if (!texts.length) {
      for (const name of fs.readdirSync(location).filter(name => /^readme([.]|$)/i.test(name))) {
        const text = fs.readFileSync(path.join(location, name), 'utf8');
        if (/Permission is hereby granted/i.test(text) && /THE SOFTWARE IS PROVIDED/i.test(text)) texts.push(text);
      }
    }
    if (!texts.length) {
      const fallback = path.join(root, 'licenses/vendor', `${pkg.name.replaceAll('/', '__')}@${pkg.version}.txt`);
      if (fs.existsSync(fallback)) texts = [fs.readFileSync(fallback, 'utf8')];
    }
    if (!texts.length) throw Error(`Missing runtime license text: ${pkg.name}@${pkg.version}`);
    notices.push(`${pkg.name}@${pkg.version} (${pkg.license})\n${texts.join('\n')}`);
    modules(path.join(location, 'node_modules'));
  }
}
modules(path.join(root, 'node_modules'));
if (!notices.length) throw Error('Empty runtime notice inventory');
fs.writeFileSync(path.join(root, 'RUNTIME-NOTICES.txt'), `Tracery Graph runtime dependency notices\n\n${notices.sort().join('\n\n----------------------------------------\n\n')}\n`);
console.log(`Preserved full license text for ${notices.length} runtime packages`);
