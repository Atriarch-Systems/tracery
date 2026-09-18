# Vendored: `vite-plugin-singlefile`

`vite-plugin-singlefile@2.3.3` (MIT, upstream: https://github.com/richardtallent/vite-plugin-singlefile)
is vendored here, as an extracted package directory referenced via
`"vite-plugin-singlefile": "file:vendor/vite-plugin-singlefile"` in
`package.json`, instead of a plain registry semver range.

**Why:** the upstream npm package's `package.json` declares
`peerDependencies` (`rollup`, optional) and `devDependencies` (including
`vitest`). In this monorepo's workspace tree, that combination reproducibly
crashes `npm`'s dependency resolver (`@npmcli/arborist`) with
`TypeError: Cannot read properties of null (reading 'edgesOut')` while it
tries to resolve the *dev*Dependency graph of a dependency that should never
be installed at all -- reproduced identically with `npm install` and
`npm ci`, on both Windows and inside the `node:22-alpine` Docker image, so it
is an upstream `npm`/arborist bug (observed with `npm@10.9.2`), not an
environment quirk. Before it crashes outright, an earlier `npm` attempt on
the same tree instead failed silently: the package never landed in
`node_modules` at all (no error, no log line), which is the more dangerous
failure mode since a build then breaks with a confusing
`ERR_MODULE_NOT_FOUND` for `vite-plugin-singlefile` inside a Vite temp file,
with no obvious link back to this cause.

**What's different here:** `package.json` in `vendor/vite-plugin-singlefile/`
is the unpacked npm tarball with `devDependencies`, `peerDependencies`,
`peerDependenciesMeta`, and build `scripts` stripped out -- fields that only
matter for *developing* the plugin itself, never for using it as a Vite
plugin at build time. Runtime behavior (`dist/`, its own `dependencies:
{ micromatch }`) is untouched. With those fields gone, `npm install`
resolves and hoists it cleanly to the repo root `node_modules` like any other
dependency.

**Upgrading:** to bump the version, `npm pack vite-plugin-singlefile@<version>`,
extract the tarball over this directory, and re-apply the same trim to the
extracted `package.json` (delete `devDependencies`, `peerDependencies`,
`peerDependenciesMeta`, `scripts`) before running `npm install` again. Revisit
whether this is still necessary against a newer `npm` major version -- this
may be fixed upstream by the time you read this.
