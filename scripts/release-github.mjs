import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function githubClient(repository, token, fetcher = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(120_000) })) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) throw Error('Missing GitHub release context');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return async (route, { method = 'GET', body, bytes, binary = false, missing = false } = {}) => {
    const response = await fetcher(route.startsWith('https://') ? route : base + route, {
      method, headers: { ...headers, ...(binary ? { Accept: 'application/octet-stream' } : {}), ...(bytes ? { 'Content-Type': 'application/octet-stream' } : {}) },
      body: bytes ?? (body ? JSON.stringify(body) : undefined),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub ${method} ${route.split('?')[0]} failed: ${response.status}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}
export async function ensureReleaseTag(api, tag, sha) {
  if (!/^v0\.\d+\.\d+$/.test(tag ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw Error('Invalid release tag or commit');
  let ref = await api(`/git/ref/tags/${tag}`, { missing: true });
  if (!ref) {
    const annotated = await api('/git/tags', { method: 'POST', body: { tag, message: `Tracery ${tag}`, object: sha, type: 'commit' } });
    ref = await api('/git/refs', { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: annotated.sha } });
  }
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) object = (await api(`/git/tags/${object.sha}`)).object;
  if (object?.type !== 'commit' || object.sha !== sha) throw Error('Release tag already points to another commit; never retag a release');
}
export async function ensureDraftRelease(api, tag, sha) {
  await ensureReleaseTag(api, tag, sha);
  return await api(`/releases/tags/${tag}`, { missing: true }) ?? await api('/releases', {
    method: 'POST', body: { tag_name: tag, target_commitish: sha, name: `Tracery ${tag}`, generate_release_notes: true, draft: true },
  });
}
export function releaseFiles(directory = 'artifacts') {
  const files = [{ file: path.join(directory, 'SHA256SUMS'), name: 'SHA256SUMS' }];
  for (const subdir of ['npm', 'reports', 'container/amd64', 'container/arm64']) {
    for (const name of readdirSync(path.join(directory, subdir))) {
      if (name === 'image.tar.gz') continue;
      files.push({ file: path.join(directory, subdir, name), name: subdir.startsWith('container/') ? `${subdir.replace('/', '-')}-${name}` : name });
    }
  }
  if (new Set(files.map(file => file.name)).size !== files.length) throw Error('Duplicate GitHub release asset names');
  return files;
}
export async function publishReleaseEvidence(api, release, files) {
  for (const { file, name } of files) {
    const bytes = readFileSync(file);
    const existing = release.assets.find(asset => asset.name === name);
    if (existing) {
      const downloaded = await api(`/releases/assets/${existing.id}`, { binary: true });
      if (!downloaded.equals(bytes)) throw Error(`Existing release asset differs: ${name}`);
      continue;
    }
    await api(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(name)}`, { method: 'POST', bytes });
    console.log(`Uploaded ${name}`);
  }
  if (release.draft) await api(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repository, RELEASE_TAG: tag, GITHUB_SHA: sha, GH_TOKEN: token } = process.env;
  const api = githubClient(repository, token);
  const release = await ensureDraftRelease(api, tag, sha);
  if (!process.argv.includes('--prepare')) await publishReleaseEvidence(api, release, releaseFiles());
  console.log(`${process.argv.includes('--prepare') ? 'Prepared' : 'Published'} GitHub release ${tag}`);
}
