/**
 * Public entry point for `@atriarch-systems/tracery-hub` as a *library*, not just a
 * binary (`bin/hub.mjs`). This is what an extensions module -- most notably
 * Tracery Cloud's `@atriarch/tracery-cloud-ee` in the private
 * `tracery-cloud` repo -- imports to build a `HubExtensions` object and to
 * get the types it plugs into `createServer`. It never imports anything
 * from `ee`; the dependency direction is the reverse (an extensions package
 * depends on this one), matching `server.ts`'s doc comment about the
 * extension seam.
 *
 * Kept deliberately small: the server itself (`createServer`), the
 * extension-seam types (`HubContext`/`HubExtensions`), the `Config` shape,
 * and the one small shared error-body helper (`errorBody`) that both the
 * hub's own routes and an extensions module's routes use for the same
 * `{ error: { code, message } } ` shape. Anything narrower belongs on one of
 * the package's other subpath exports (`./auth`, `./store`, `./config`,
 * `./test-helpers`) instead of being re-exported from here too.
 */
export { createServer, redactedRequestUrl, safeRequestId, clientErrorCode } from './server.js';
export type { CreatedServer } from './server.js';
export type { HubContext, HubExtensions } from './server-context.js';
export type { Config, ApiKeyConfig, Role, StoreKind, AuthMode } from './config.js';
export { loadConfig, hubVersion, isLoopbackHost } from './config.js';
export { errorBody } from './routes/errors.js';
export type { ErrorBody } from './routes/errors.js';
