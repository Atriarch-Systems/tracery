import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { architectures, dockerContext, registryClient, releaseImages, releaseSourceImages, sourcesTag, checkVersionTags, assertArchitectureImage, assertMultiPlatformImage } from './release-docker-registry.mjs';

// Pushes each tested architecture image as <tag>-<arch> (unless an identical
// one exists) and combines their verified digests into <tag>.
async function publishTagSet({ repository, tag, local, expected, current, client, docker }) {
  const references = [];
  for (const arch of architectures) {
    let image = current.images[arch];
    if (!image) {
      docker(['tag', `${local}-${arch}`, `${repository}:${tag}-${arch}`]);
      docker(['push', `${repository}:${tag}-${arch}`]);
      image = await client.manifest(`${tag}-${arch}`);
    }
    assertArchitectureImage(image, arch, expected);
    references.push(`${repository}@${image.digest}`);
  }
  if (!current.combined) docker(['buildx', 'imagetools', 'create', '-t', `${repository}:${tag}`, ...references]);
  const combined = await client.manifest(tag);
  await assertMultiPlatformImage(client, combined, expected);
  return { references, combined };
}

export async function publishDocker({ repository, version, runId, expected, sources, client, docker }) {
  if (!/^\d+$/.test(runId ?? '')) throw Error('Missing workflow run ID');
  if (!sources) throw Error('Missing tested source images');
  const sourceTag = sourcesTag(version);
  // Preflight every immutable binary and source tag before pushing anything.
  const current = await checkVersionTags(client, version, expected);
  const currentSources = await checkVersionTags(client, sourceTag, sources);
  // Corresponding sources go up first, so a binary tag never exists without them.
  await publishTagSet({ repository, tag: sourceTag, local: `tracery-release-sources:${runId}`, expected: sources, current: currentSources, client, docker });
  const { references, combined } = await publishTagSet({ repository, tag: version, local: `tracery-release:${runId}`, expected, current, client, docker });
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
  await publishDocker({ repository, version, runId: process.env.GITHUB_RUN_ID, expected: releaseImages(), sources: releaseSourceImages(), client: await registryClient(repository),
    docker: args => execFileSync('docker', args, { stdio: 'inherit', timeout: 600_000 }) });
  console.log('Published and verified AMD64/ARM64 source and version tags and multi-platform aliases');
}
