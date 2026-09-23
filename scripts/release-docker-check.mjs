// A published version tag is immutable. Retries may reuse the exact image config.
import { execFileSync } from 'node:child_process';
import { ensureDockerRepository } from './release-docker-repository.mjs';
const repository = process.env.DOCKERHUB_IMAGE;
const version = process.env.GITHUB_REF_NAME?.replace(/^v/, '');
if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/.test(repository ?? '') || !/^0\.\d+\.\d+$/.test(version ?? '')) throw Error('Invalid release image or version');
await ensureDockerRepository({ image: repository, username: process.env.DOCKERHUB_USERNAME, token: process.env.DOCKERHUB_TOKEN }, (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }));
const tokenResponse = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`);
if (!tokenResponse.ok) throw Error(`Registry authentication failed: ${tokenResponse.status}`);
const { token } = await tokenResponse.json();
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' };
let response = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${version}`, { headers });
if (response.status === 404) {
  console.log('Public repository exists; version tag is available');
} else {
  if (!response.ok) throw Error(`Registry lookup failed: ${response.status}`);
  let manifest = await response.json();
  if (manifest.manifests) {
    const amd64 = manifest.manifests.find(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
    if (!amd64) throw Error('Existing version has no matching architecture');
    response = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${amd64.digest}`, { headers });
    if (!response.ok) throw Error(`Manifest lookup failed: ${response.status}`);
    manifest = await response.json();
  }
  const saved = JSON.parse(execFileSync('tar', ['-xOzf', 'artifacts/container/image.tar.gz', 'manifest.json'], { encoding: 'utf8' }));
  if (saved.length !== 1) throw Error('Expected exactly one saved image');
  const config = saved[0].Config.replace(/^blobs\/sha256\//, '').replace(/\.json$/, '');
  if (manifest.config?.digest !== `sha256:${config}`) throw Error('Docker version already exists with different bytes; use a new version');
  console.log('Existing Docker version matches the tested image config');
}
