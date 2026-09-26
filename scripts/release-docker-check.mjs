// Every versioned architecture tag and the combined tag are immutable, and so
// are the matching <version>-sources(-<arch>) tags of the OS source images.
import { ensureDockerRepository } from './release-docker-repository.mjs';
import { dockerContext, registryClient, releaseImages, releaseSourceImages, sourcesTag, checkVersionTags } from './release-docker-registry.mjs';
const { repository, version } = dockerContext();
await ensureDockerRepository({ image: repository, username: process.env.DOCKERHUB_USERNAME, token: process.env.DOCKERHUB_TOKEN }, (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }));
const client = await registryClient(repository);
await checkVersionTags(client, version, releaseImages());
await checkVersionTags(client, sourcesTag(version), releaseSourceImages());
console.log('Public repository and both architecture version and source tags passed preflight');
