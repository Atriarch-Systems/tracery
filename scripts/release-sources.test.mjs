import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readTar, recordedDigest, sha256, verifySourceArchive } from './release-sources.mjs';

// Writes ustar entries, with a pax header for long names like Python's tarfile.
function header(name, { type = '0', size = 0, link = '' } = {}) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100); block.write('0000000\0', 108); block.write('0000000\0', 116);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}
const pad = data => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
function tar(entries) {
  const blocks = [];
  for (const [name, value] of entries) {
    if (name.length > 99) {
      const record = ` path=${name}\n`;
      let length = record.length + 2;
      while (`${length}${record}`.length !== length) length++;
      const body = Buffer.from(`${length}${record}`);
      blocks.push(header('PaxHeader', { type: 'x', size: body.length }), pad(body));
    }
    const short = name.slice(0, 99);
    if (value === null) blocks.push(header(short, { type: '5' }));
    else if (typeof value === 'object' && value.symlink) blocks.push(header(short, { type: '2', link: value.symlink }));
    else { const data = Buffer.from(value); blocks.push(header(short, { size: data.length }), pad(data)); }
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const installed = 'P:musl\nV:1.2.6-r2\n\n';
const inventory = '[{"name":"musl"}]\n';
function bundle(overrides = {}) {
  const files = {
    'README.txt': 'readme', 'installed.apk.txt': installed, 'packages.json': inventory,
    'recipes/musl/APKBUILD': 'pkgname=musl', [`distfiles/musl/${'long-'.repeat(25)}musl-1.2.6.tar.gz`]: 'upstream', ...overrides,
  };
  const sums = Object.entries(files).filter(([, v]) => v !== undefined).map(([name, data]) => `${sha256(Buffer.from(data))}  ${name}`).join('\n') + '\n';
  const entries = [['sources', null], ['sources/recipes', null], ['sources/distfiles', null]];
  for (const [name, data] of Object.entries(files)) if (data !== undefined) entries.push([`sources/${name}`, data]);
  entries.push(['sources/SHA256SUMS', sums]);
  return gzipSync(tar(entries));
}

test('reads ustar and pax long-name entries', () => {
  const entries = readTar(tar([['a', null], ['a/file.txt', 'hello'], [`a/${'x'.repeat(120)}`, 'long'], ['a/link', { symlink: 'file.txt' }]]));
  assert.equal(entries.get('a/file.txt').data.toString(), 'hello');
  assert.equal(entries.get(`a/${'x'.repeat(120)}`).data.toString(), 'long');
  assert.deepEqual(entries.get('a/link'), { type: 'symlink', target: 'file.txt' });
  assert.equal(entries.get('a').type, 'directory');
});
test('rejects corrupt headers and unsafe paths', () => {
  const archive = tar([['ok.txt', 'data']]);
  archive[0] = 'x'.charCodeAt(0);
  assert.throws(() => readTar(archive), /Corrupt tar header/);
  assert.throws(() => readTar(tar([['../escape', 'data']])), /Unsafe tar path/);
});
test('accepts a matching archive and records only a well-formed digest', () => {
  const archive = bundle();
  const digest = recordedDigest(`${sha256(archive)}  sources.tar.gz\n`);
  assert.equal(verifySourceArchive({ archive, digest, installed, inventory }).files, 5);
  assert.throws(() => recordedDigest('abc  sources.tar.gz\n'), /Invalid/);
});
test('rejects a different archive, tampered or unlisted files and mismatched inventories', () => {
  const archive = bundle();
  const digest = sha256(archive);
  assert.throws(() => verifySourceArchive({ archive, digest: sha256(Buffer.from('other')), installed, inventory }), /recorded in the image/);
  assert.throws(() => verifySourceArchive({ archive, digest, installed: 'P:busybox\n', inventory }), /APK database differs/);
  assert.throws(() => verifySourceArchive({ archive, digest, installed, inventory: '[]\n' }), /inventory differs/);
  const entries = [['sources', null], ['sources/README.txt', 'readme'], ['sources/extra.txt', 'unlisted'],
    ['sources/SHA256SUMS', `${sha256(Buffer.from('readme'))}  README.txt\n`]];
  const unlisted = gzipSync(tar(entries));
  assert.throws(() => verifySourceArchive({ archive: unlisted, digest: sha256(unlisted), installed, inventory }), /Unlisted file/);
  const tampered = gzipSync(tar([['sources', null], ['sources/README.txt', 'changed'], ['sources/SHA256SUMS', `${sha256(Buffer.from('readme'))}  README.txt\n`]]));
  assert.throws(() => verifySourceArchive({ archive: tampered, digest: sha256(tampered), installed, inventory }), /Checksum mismatch/);
});
