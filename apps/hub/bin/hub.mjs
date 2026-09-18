#!/usr/bin/env node
// Starts the hub from environment variables (SPEC.md §6). Plain ESM, not
// compiled -- imports the built `dist/` output, same convention as the
// other packages' bin scripts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';

const config = loadConfig(process.env);

/**
 * Resolves a `TRACERY_EXTENSIONS_MODULE` value into whatever `import()`
 * needs. A bare npm package name (`@scope/name`, `name`) or an already
 * fully-qualified URL (`file:`, `node:`, ...) is passed straight through --
 * that is exactly what `import()`'s own module resolution expects. Anything
 * else (a relative path like `./local-extensions/index.js`, or an absolute
 * filesystem path) is resolved against `process.cwd()` and converted to a
 * `file://` URL: `import()` accepts a bare relative/absolute path on POSIX,
 * but on Windows an absolute path (`C:\...`) is not a valid URL on its own
 * ("Only URLs with a scheme ... are supported"), so this conversion is
 * required for `TRACERY_EXTENSIONS_MODULE=C:\path\to\index.js` to work at
 * all on that platform.
 */
function resolveExtensionsSpecifier(spec) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !/^[a-z]:[\\/]/i.test(spec)) return spec; // already a URL (file:, node:, https:, ...) -- not a Windows drive letter
  if (!spec.startsWith('.') && !path.isAbsolute(spec)) return spec; // bare specifier: npm package name
  return pathToFileURL(path.resolve(spec)).href;
}

// Extensions (SPEC.md §7 "Extensions and Tracery Cloud", `apps/hub/README.md`
// "Extensions"): an optional module the operator names via
// TRACERY_EXTENSIONS_MODULE -- an npm package name (resolved the ordinary
// Node way) or an absolute/relative path to a built ESM module -- that
// exports an async-or-sync `createExtensions(config)` returning a
// `HubExtensions` object (`@atriarch/tracery-hub`'s `HubContext`/
// `HubExtensions` types, from this package's own "." export). Nothing in
// this package ships such a module; Tracery Cloud's `@atriarch/
// tracery-cloud-ee` (private `tracery-cloud` repo) is one example. Unset by
// default -- a checkout with no extensions configured just runs the
// community edition.
//
// This is a hard dependency once configured: a bad module name/path, an
// import error, or a `createExtensions` that throws all abort startup with a
// clear message instead of silently falling back to the community edition --
// an operator who set this env var meant for it to load.
let extensions;
const extensionsModule = process.env.TRACERY_EXTENSIONS_MODULE?.trim();
if (extensionsModule) {
  let mod;
  try {
    mod = await import(resolveExtensionsSpecifier(extensionsModule));
  } catch (err) {
    console.error(`tracery-hub: failed to load TRACERY_EXTENSIONS_MODULE "${extensionsModule}": ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (typeof mod.createExtensions !== 'function') {
    console.error(`tracery-hub: TRACERY_EXTENSIONS_MODULE "${extensionsModule}" has no exported "createExtensions" function`);
    process.exit(1);
  }
  try {
    extensions = await mod.createExtensions(config);
  } catch (err) {
    console.error(`tracery-hub: TRACERY_EXTENSIONS_MODULE "${extensionsModule}"'s createExtensions(config) threw: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`tracery-hub: loaded extensions module "${extensionsModule}"`);
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
