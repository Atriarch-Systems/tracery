import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const vendor = fileURLToPath(new URL('../licenses/vendor/', import.meta.url));
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Include the notices of every third-party package loaded by this Rollup build. */
export function bundleLicenses() {
  return {
    name: 'tracery-bundle-licenses',
    enforce: 'post',
    generateBundle(_options, bundle) {
      // Vite emits virtual runtime helpers (module preload and bundled CommonJS
      // interop) whose module IDs have no node_modules path. Its LICENSE.md also
      // contains the notices for those bundled helper dependencies.
      const viteManifest = createRequire(import.meta.url).resolve('vite/package.json');
      const vite = JSON.parse(fs.readFileSync(viteManifest, 'utf8'));
      const packages = new Map([[vite.name + '@' + vite.version, { dir: path.dirname(viteManifest), pkg: vite }]]);
      for (const id of this.getModuleIds()) {
        if (!id.includes('node_modules') || id.startsWith('\0')) continue;
        let dir = path.dirname(id.split('?')[0]);
        while (dir !== path.dirname(dir)) {
          const manifest = path.join(dir, 'package.json');
          if (fs.existsSync(manifest)) {
            const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            if (pkg.name && pkg.version) {
              if (!pkg.name.startsWith('@atriarch-systems/')) packages.set(pkg.name + '@' + pkg.version, { dir, pkg });
              break;
            }
          }
          dir = path.dirname(dir);
        }
      }
      const sections = [], missing = [];
      for (const [name, { dir, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        const files = fs.readdirSync(dir).filter(file => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(file) && fs.statSync(path.join(dir, file)).isFile());
        const fallback = path.join(vendor, name.replaceAll('/', '__') + '.txt');
        if (files.length === 0 && !fs.existsSync(fallback)) { missing.push(name); continue; }
        const texts = files.map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
        if (files.length === 0) texts.push(fs.readFileSync(fallback, 'utf8'));
        sections.push(name + ' (' + pkg.license + ')\n' + texts.join('\n'));
      }
      if (missing.length) this.error('Missing upstream license text: ' + missing.join(', '));
      const notices = 'Tracery third-party notices\nGenerated from the resolved build modules and Vite runtime helpers. Original package licenses follow.\n\n' + sections.join('\n\n----------------------------------------\n\n');
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: notices });
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !asset.fileName.endsWith('.html')) continue;
        const html = typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
        const licenseBlock = '<details id="tracery-licenses" style="position:fixed;right:12px;bottom:8px;z-index:100;max-width:85vw;max-height:70vh;overflow:auto;background:#fff;color:#111;padding:4px;font:12px system-ui"><summary>Open-source licenses</summary><pre style="white-space:pre-wrap">' + escape(notices) + '</pre></details>';
        asset.source = html.replace('</body>', licenseBlock + '</body>');
      }
    },
  };
}
