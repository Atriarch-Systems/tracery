#!/usr/bin/env node
// Starts the hub from environment variables (SPEC.md §6). Plain ESM, not
// compiled -- imports the built `dist/` output, same convention as the
// other packages' bin scripts.
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';

const config = loadConfig(process.env);

let created;
try {
  created = await createServer(config);
} catch (err) {
  console.error(`activity-hub: failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  throw err;
}

const address = await created.app.listen({ port: config.port, host: config.host });

created.app.log.info(`Atriarch Activity Hub listening on ${address}`);
created.app.log.info(`store: ${config.store}${config.store === 'sqlite' ? ` (${config.sqlitePath})` : ''}`);
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
    process.exit(0);
  } catch (err) {
    created.app.log.error(err);
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
