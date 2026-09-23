import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const architectures = ['amd64', 'arm64'];
const digestPattern = /^sha256:[0-9a-f]{64}$/;
export function releaseImages(directory = 'artifacts/container') {
  return Object.fromEntries(architectures.map(arch => {
    const digest = readFileSync(`${directory}/${arch}/image-id.txt`, 'utf8').trim();
    if (!digestPattern.test(digest)) throw Error(`Invalid saved ${arch} image ID`);
    return [arch, digest];
  }));
}
export function dockerContext(env = process.env) {
  const repository = env.DOCKERHUB_IMAGE, version = env.RELEASE_VERSION;
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/.test(repository ?? '') || !/^0\.\d+\.\d+$/.test(version ?? '')) throw Error('Invalid release image or version');
  return { repository, version };
}
export async function registryClient(repository, fetcher = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) })) {
  const headers = { Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' };
  const authorize = async () => {
    const auth = await fetcher(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`);
    if (!auth.ok) throw Error(`Registry authentication failed: ${auth.status}`);
    const { token } = await auth.json();
    if (!token) throw Error('Registry returned no pull token');
    headers.Authorization = `Bearer ${token}`;
  };
  await authorize();
  return { async manifest(reference) {
    const url = `https://registry-1.docker.io/v2/${repository}/manifests/${encodeURIComponent(reference)}`;
    let response = await fetcher(url, { headers });
    // Uploading two source-inclusive images can outlast Docker Hub's pull token.
    if (response.status === 401) {
      await authorize();
      response = await fetcher(url, { headers });
    }
    if (response.status === 404) return null;
    if (!response.ok) throw Error(`Registry manifest lookup failed: ${response.status}`);
    const body = await response.text();
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const declared = response.headers.get('docker-content-digest');
    if (declared && declared !== digest) throw Error('Registry manifest digest mismatch');
    return { digest, document: JSON.parse(body) };
  } };
}
export function assertArchitectureImage(manifest, arch, expected) {
  if (!manifest || manifest.document.manifests || manifest.document.config?.digest !== expected[arch]) throw Error(`Existing ${arch} tag differs from the tested image; use a new version`);
}
export async function assertMultiPlatformImage(client, manifest, expected) {
  const entries = manifest?.document.manifests;
  if (!Array.isArray(entries) || entries.length !== architectures.length) throw Error('Version must contain exactly the two reviewed architectures');
  const seen = new Set();
  for (const entry of entries) {
    const arch = entry.platform?.architecture;
    if (entry.platform?.os !== 'linux' || !architectures.includes(arch) || seen.has(arch) || !digestPattern.test(entry.digest)) throw Error('Unexpected or duplicate image platform');
    seen.add(arch);
    assertArchitectureImage(await client.manifest(entry.digest), arch, expected);
  }
}
export async function checkVersionTags(client, version, expected) {
  const images = {};
  // Preflight EVERY immutable tag before publishing any new one.
  for (const arch of architectures) {
    images[arch] = await client.manifest(`${version}-${arch}`);
    if (images[arch]) assertArchitectureImage(images[arch], arch, expected);
  }
  const combined = await client.manifest(version);
  if (combined) await assertMultiPlatformImage(client, combined, expected);
  return { images, combined };
}
