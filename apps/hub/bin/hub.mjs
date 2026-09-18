#!/usr/bin/env node
// Starts the hub from environment variables (SPEC.md §6). Plain ESM, not
// compiled -- imports the built `dist/` output, same convention as the
// other packages' bin scripts.
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';

const config = loadConfig(process.env);

// The enterprise layer (SPEC.md §7) is optional and built separately
// (`npm run build:ee`); load it when present, fail soft (community
// edition) when it isn't. Only a genuine load failure (not "the file
// doesn't exist") is logged as an error.
let extensions;
try {
  const ee = await import('../ee/dist/index.js');
  extensions = ee.createEnterpriseExtensions(config);
} catch (err) {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('tracery-hub: no enterprise layer found (ee not built); running the community edition.');
  } else {
    console.error(`tracery-hub: enterprise layer failed to load, running the community edition: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let created;
try {
  created = await createServer(config, extensions);
} catch (err) {
  console.error(`tracery-hub: failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  throw err;
}

const address = await created.app.listen({ port: config.port, host: config.host });

// Task ("local mode"): exactly one banner line naming the auth mode -- never
// a minted/printed key. `authMode: 'none'` (the `npx @atriarch/tracery-hub`
// default on a loopback host) reads "local mode, no auth"; `'keys'` says so
// plainly instead.
const authNote =
  config.authMode === 'none'
    ? '(local mode, no auth; set TRACERY_API_KEYS or bind a non-loopback host to require keys)'
    : '(auth: TRACERY_API_KEYS configured)';
created.app.log.info(`Tracery hub: ${address}  ${authNote}`);
if (config.authWarning) {
  created.app.log.warn(config.authWarning);
}
created.app.log.info(`store: ${config.store}${config.store === 'sqlite' ? ` (${config.sqlitePath})` : ''}`);
if (extensions) {
  created.app.log.info(`enterprise layer: ${extensions.license.valid ? `licensed (${extensions.license.features.join(', ') || 'no features'})` : 'community edition'}`);
}
if (!(extensions?.isLicensed?.() ?? false)) {
  created.app.log.info('Tracery is open source (Apache-2.0). Docs: https://github.com/atriarch-systems/tracery · Support: https://ko-fi.com/demonslyr');
}

const shutdown = async (signal) => {
  created.app.log.info(`tracery-hub: received ${signal}, shutting down`);
  try {
    await created.close();
    extensions?.close?.();
    process.exit(0);
  } catch (err) {
    created.app.log.error(err);
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
