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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = JSON.parse(readFileSync('package.json'));
  const hub = JSON.parse(readFileSync('apps/hub/package.json'));
  if (hub.version !== root.version) throw Error('Hub and root versions must match');
  const context = releaseContext({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    operation: process.env.RELEASE_OPERATION, version: process.env.RELEASE_INPUT_VERSION }, root.version);
  for (const [name, value] of Object.entries(context)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${context.publish ? 'Publish' : 'Validate only'} ${context.tag}`);
}
