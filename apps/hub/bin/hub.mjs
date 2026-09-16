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
    console.log('activity-hub: no enterprise layer found (ee not built); running the community edition.');
  } else {
    console.error(`activity-hub: enterprise layer failed to load, running the community edition: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let created;
try {
  created = await createServer(config, extensions);
} catch (err) {
  console.error(`activity-hub: failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  throw err;
}

const address = await created.app.listen({ port: config.port, host: config.host });

created.app.log.info(`Atriarch Activity Hub listening on ${address}`);
created.app.log.info(`store: ${config.store}${config.store === 'sqlite' ? ` (${config.sqlitePath})` : ''}`);
if (extensions) {
  created.app.log.info(`enterprise layer: ${extensions.license.valid ? `licensed (${extensions.license.features.join(', ') || 'no features'})` : 'community edition'}`);
}
if (created.devKey) {
  created.app.log.warn(
    `No ACTIVITY_API_KEYS configured. Generated a dev key with all roles on workspace "default":\n` +
      `  ${created.devKey}\n` +
      `Set ACTIVITY_API_KEYS or ACTIVITY_API_KEYS_FILE for anything beyond local development.`,
  );
}

const shutdown = async (signal) => {
  created.app.log.info(`activity-hub: received ${signal}, shutting down`);
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
