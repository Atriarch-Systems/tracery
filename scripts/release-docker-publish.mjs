import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { architectures, dockerContext, registryClient, releaseImages, checkVersionTags, assertArchitectureImage, assertMultiPlatformImage } from './release-docker-registry.mjs';

export async function publishDocker({ repository, version, runId, expected, client, docker }) {
  if (!/^\d+$/.test(runId ?? '')) throw Error('Missing workflow run ID');
  const current = await checkVersionTags(client, version, expected);
  const references = [];
  for (const arch of architectures) {
    let image = current.images[arch];
    if (!image) {
      docker(['tag', `tracery-release:${runId}-${arch}`, `${repository}:${version}-${arch}`]);
      docker(['push', `${repository}:${version}-${arch}`]);
      image = await client.manifest(`${version}-${arch}`);
    }
    assertArchitectureImage(image, arch, expected);
    references.push(`${repository}@${image.digest}`);
  }
  if (!current.combined) docker(['buildx', 'imagetools', 'create', '-t', `${repository}:${version}`, ...references]);
  const combined = await client.manifest(version);
  await assertMultiPlatformImage(client, combined, expected);
  // Alias updates use verified immutable digests, never a moving source tag.
  for (const [index, arch] of architectures.entries()) {
    docker(['buildx', 'imagetools', 'create', '--prefer-index=false', '-t', `${repository}:latest-${arch}`, references[index]]);
    assertArchitectureImage(await client.manifest(`latest-${arch}`), arch, expected);
  }
  docker(['buildx', 'imagetools', 'create', '-t', `${repository}:latest`, `${repository}@${combined.digest}`]);
  await assertMultiPlatformImage(client, await client.manifest('latest'), expected);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { repository, version } = dockerContext();
  await publishDocker({ repository, version, runId: process.env.GITHUB_RUN_ID, expected: releaseImages(), client: await registryClient(repository),
    docker: args => execFileSync('docker', args, { stdio: 'inherit', timeout: 600_000 }) });
  console.log('Published and verified AMD64/ARM64 version tags and multi-platform aliases');
}
