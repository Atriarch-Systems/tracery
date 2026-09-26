// Verifies the OS source archive published next to each release image
// (scripts/container-sources.py). Runs on the host, not in the image: the
// runtime image has no shell or tar, and does not contain the archive.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reads the sha256sum-format line container-sources.py writes next to the archive.
export function recordedDigest(text) {
  const match = /^([0-9a-f]{64}) {2}sources\.tar\.gz\n?$/.exec(String(text));
  if (!match) throw Error('Invalid sources.tar.gz.sha256 record');
  return match[1];
}

// Minimal POSIX tar reader (ustar plus the pax and GNU long-name headers
// Python's tarfile writes). Returns path -> { type, data | target }.
export function readTar(buffer) {
  const entries = new Map();
  let offset = 0, pax = {}, longName;
  const text = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
  const octal = (header, start, length) => {
    const value = text(header, start, length).trim();
    if (!/^[0-7]*$/.test(value)) throw Error(`Unsupported tar number at ${offset}`);
    return value ? parseInt(value, 8) : 0;
  };
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== octal(header, 148, 8)) throw Error(`Corrupt tar header at ${offset}`);
    const type = text(header, 156, 1) || '0';
    const size = pax.size !== undefined ? Number(pax.size) : octal(header, 124, 12);
    const start = offset + 512;
    if (start + size > buffer.length) throw Error('Truncated tar archive');
    const data = buffer.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      if (type === 'x') pax = parsePax(data);
      continue;
    }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    const prefix = text(header, 345, 155);
    let name = pax.path ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    name = name.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!name || name.split('/').includes('..') || name.startsWith('/')) throw Error(`Unsafe tar path: ${name}`);
    if (entries.has(name)) throw Error(`Duplicate tar entry: ${name}`);
    if (type === '0') entries.set(name, { type: 'file', data });
    else if (type === '5') entries.set(name, { type: 'directory' });
    else if (type === '2' || type === '1') entries.set(name, { type: type === '2' ? 'symlink' : 'link', target: pax.linkpath ?? text(header, 157, 100) });
    else throw Error(`Unsupported tar entry type ${type}: ${name}`);
    pax = {}; longName = undefined;
  }
  return entries;
}

function parsePax(data) {
  const records = {};
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const length = Number(data.subarray(position, space).toString('ascii'));
    if (space < 0 || !Number.isInteger(length) || length <= 0) throw Error('Corrupt pax header');
    const record = data.subarray(space + 1, position + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    position += length;
  }
  return records;
}

// Checks one architecture's source archive against the runtime image it
// accompanies: the digest the image records, every SHA256SUMS entry (and no
// unlisted file), and the package inventory and APK database it was built from.
export function verifySourceArchive({ archive, digest, installed, inventory }) {
  if (sha256(archive) !== digest) throw Error('Source archive does not match the SHA-256 recorded in the image');
  const entries = readTar(gunzipSync(archive));
  for (const name of entries.keys()) if (name !== 'sources' && !name.startsWith('sources/')) throw Error(`Unexpected path outside sources/: ${name}`);
  const file = name => {
    const entry = entries.get(`sources/${name}`);
    if (entry?.type !== 'file') throw Error(`Source archive is missing ${name}`);
    return entry.data;
  };
  const listed = new Set();
  for (const line of file('SHA256SUMS').toString('utf8').split('\n').filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw Error(`Malformed SHA256SUMS line: ${line}`);
    if (sha256(file(match[2])) !== match[1]) throw Error(`Checksum mismatch: ${match[2]}`);
    listed.add(match[2]);
  }
  for (const [name, entry] of entries) {
    const relative = name.slice('sources/'.length);
    if (entry.type === 'file' && relative !== 'SHA256SUMS' && !listed.has(relative)) throw Error(`Unlisted file in source archive: ${relative}`);
  }
  if (!file('packages.json').equals(Buffer.from(inventory))) throw Error('Source archive inventory differs from the image inventory');
  if (!file('installed.apk.txt').equals(Buffer.from(installed))) throw Error('Source archive APK database differs from the image');
  for (const name of ['README.txt', 'recipes', 'distfiles']) if (!entries.has(`sources/${name}`)) throw Error(`Source archive is missing ${name}`);
  return { files: listed.size };
}
