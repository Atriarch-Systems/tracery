import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseContext({ event, ref, operation, version }, packageVersion) {
  if (!/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageVersion)) throw Error('Expected a stable 0.x package version');
  const tag = `v${packageVersion}`;
  if (event === 'push') {
    if (ref !== `refs/tags/${tag}`) throw Error('Tag must match the prepared package version');
    return { tag, version: packageVersion, publish: true };
  }
  if (event !== 'workflow_dispatch' || !['validate', 'publish'].includes(operation)) throw Error('Invalid release operation');
  if (ref !== 'refs/heads/main') throw Error('Run the manual release from main');
  if (operation === 'publish' && version !== packageVersion) throw Error('Enter the exact prepared package version to publish');
  if (version && version !== packageVersion) throw Error('Requested version differs from package.json');
  return { tag, version: packageVersion, publish: operation === 'publish' };
}

// The Helm chart's appVersion (the default image tag) and the plain manifest's
// image tag must name the version being released, so installs never point at
// an older or unpublished image.
export function deployManifestErrors(packageVersion, chartYaml, manifestYaml) {
  const errors = [];
  const appVersion = chartYaml.match(/^appVersion:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m)?.[1];
  if (appVersion !== packageVersion) {
    errors.push(`apps/hub/helm/Chart.yaml appVersion is ${appVersion ?? 'missing'}, expected ${packageVersion}`);
  }
  const tags = [...manifestYaml.matchAll(/^\s*image:\s*["']?[^\s"'#]*tracery-hub:([^\s"'#]+)/gm)].map((match) => match[1]);
  if (tags.length === 0) errors.push('apps/hub/k8s/deployment.yaml has no tracery-hub image tag');
  for (const tag of tags) {
    if (tag !== packageVersion) errors.push(`apps/hub/k8s/deployment.yaml image tag is ${tag}, expected ${packageVersion}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = JSON.parse(readFileSync('package.json'));
  const hub = JSON.parse(readFileSync('apps/hub/package.json'));
  if (hub.version !== root.version) throw Error('Hub and root versions must match');
  const deployErrors = deployManifestErrors(root.version, readFileSync('apps/hub/helm/Chart.yaml', 'utf8'),
    readFileSync('apps/hub/k8s/deployment.yaml', 'utf8'));
  if (deployErrors.length) throw Error(`Bump the deployment image tags with the version:\n${deployErrors.join('\n')}`);
  const context = releaseContext({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    operation: process.env.RELEASE_OPERATION, version: process.env.RELEASE_INPUT_VERSION }, root.version);
  for (const [name, value] of Object.entries(context)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${context.publish ? 'Publish' : 'Validate only'} ${context.tag}`);
}
