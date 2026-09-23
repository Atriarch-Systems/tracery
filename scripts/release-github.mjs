import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const { GITHUB_REPOSITORY: repository, GITHUB_REF_NAME: tag, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
if (!repository || !/^v0\.\d+\.\d+$/.test(tag ?? '') || !token) throw Error('Missing release context');
const base = `https://api.github.com/repos/${repository}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
let response = await fetch(`${base}/releases/tags/${tag}`, { headers });
if (response.status === 404) {
  response = await fetch(`${base}/releases`, { method: 'POST', headers, body: JSON.stringify({ tag_name: tag, target_commitish: sha, name: `Tracery ${tag}`, generate_release_notes: true }) });
}
if (!response.ok) throw Error(`Release lookup/create failed: ${response.status}`);
const release = await response.json();
const files = ['artifacts/SHA256SUMS'];
for (const directory of ['artifacts/npm', 'artifacts/container', 'artifacts/reports']) {
  for (const name of readdirSync(directory)) if (name !== 'image.tar.gz') files.push(path.join(directory, name));
}
for (const file of files) {
  const name = path.basename(file);
  const bytes = readFileSync(file);
  const existing = release.assets.find(asset => asset.name === name);
  // Keep an identical immutable asset on retries, refuse to overwrite evidence.
  if (existing) {
    const download = await fetch(existing.browser_download_url);
    if (!download.ok || !Buffer.from(await download.arrayBuffer()).equals(bytes)) throw Error(`Existing release asset differs: ${name}`);
    console.log(`Matching release asset: ${name}`);
    continue;
  }
  const upload = await fetch(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bytes });
  if (!upload.ok) throw Error(`Asset upload failed: ${name}: ${upload.status}`);
  console.log(`Uploaded ${name}`);
}
