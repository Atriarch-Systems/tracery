// Every versioned architecture tag and the combined tag are immutable.
import { ensureDockerRepository } from './release-docker-repository.mjs';
import { dockerContext, registryClient, releaseImages, checkVersionTags } from './release-docker-registry.mjs';
const { repository, version } = dockerContext();
await ensureDockerRepository({ image: repository, username: process.env.DOCKERHUB_USERNAME, token: process.env.DOCKERHUB_TOKEN }, (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }));
await checkVersionTags(await registryClient(repository), version, releaseImages());
console.log('Public repository and both architecture version tags passed preflight');
