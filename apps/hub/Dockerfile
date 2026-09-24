# Tracery Hub (SPEC.md §6 "Packaging"). Build from the REPO ROOT:
#
#   docker build -f apps/hub/Dockerfile -t atriarchsystems/tracery-hub:dev .
#
# Multi-stage: builds the npm workspaces this image actually needs
# (@atriarch-systems/tracery-core + @atriarch-systems/tracery-hub), builds the hosted UI in
# apps/hub/web when that directory exists (workstream E), and ships a final
# pinned Alpine/Node runtime with production dependencies and matching OS sources.

FROM node:22.23.2-alpine3.24@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
WORKDIR /repo

# Full monorepo context: apps/hub/web may or may not exist yet, and copying
# the whole tree sidesteps having to conditionally COPY a maybe-missing
# directory (Docker COPY fails outright on a source that isn't there).
# .dockerignore excludes node_modules/dist/.git so this is always a clean
# source-only tree, never a developer's already-built working copy.
COPY . .

RUN npm ci

# Build all server and UI packages in dependency order. Core ships self-contained
# data declarations and never imports the renderer at runtime.
RUN npm run build -w @atriarch-systems/tracery-visualizer -w @atriarch-systems/tracery-core -w @atriarch-systems/tracery-client -w @atriarch-systems/tracery-react -w @atriarch-systems/tracery-hub

# Hosted UI (apps/hub/web, workstream E) is optional: when its package.json
# is present it is also an npm workspace (see the root package.json), so the
# `npm ci` above already installed its deps and it just needs building. When
# it is absent, leave an empty dist/ so the final stage's COPY always has
# something to copy; the hub then falls back to its "UI not built" placeholder
# page (apps/hub/src/routes/ui.ts) at runtime.
RUN if [ -f apps/hub/web/package.json ]; then \
      echo "building apps/hub/web"; \
      npm run build -w @atriarch-systems/tracery-hub-web; \
    else \
      echo "apps/hub/web not present yet; shipping without a hosted UI"; \
      mkdir -p apps/hub/web/dist; \
    fi

# Drop devDependencies (typescript, @types/*, ws, ...) from node_modules now
# that everything is compiled; keeps the npm-workspaces symlink graph intact.
RUN npm prune --omit=dev && node scripts/runtime-notices.mjs

# Copy the runtime, not npm, Corepack or Yarn and their unused dependencies.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS runtime-base
RUN apk add --no-cache libstdc++=15.2.0-r5 ca-certificates-bundle=20260909-r0
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# Some official ARM builds omit /usr/local/LICENSE; preserve the same reviewed
# upstream license on both architectures. The release gate verifies its SHA-256.
COPY licenses/vendor/node-v22.23.2-LICENSE /usr/share/licenses/node/LICENSE

# Collect sources using the runtime inventory, before adding build tools.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS sources
RUN apk add --no-cache python3 git abuild xz
COPY --from=runtime-base /lib/apk/db/installed /runtime-installed
COPY scripts/container-sources.py /container-sources.py
RUN python3 /container-sources.py

FROM runtime-base
WORKDIR /app
COPY --from=sources /out/ /usr/share/tracery/
RUN addgroup -S tracery && adduser -S tracery -G tracery

# TRACERY_HOST=0.0.0.0: config.ts's local-mode default (127.0.0.1) is a
# Node-process convenience (`npx @atriarch-systems/tracery-hub`), not a container one
# -- a container needs to accept connections from outside its network
# namespace, so this image binds all interfaces explicitly.
#
# Network-exposed containers require API keys or an explicit runtime auth opt-out.
ENV NODE_ENV=production \
    TRACERY_HOST=0.0.0.0 \
    TRACERY_PORT=8971 \
    TRACERY_STORE=memory \
    TRACERY_SQLITE_PATH=/data/tracery.db

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/LICENSE /repo/NOTICE /repo/RUNTIME-NOTICES.txt ./
COPY --from=build /repo/apps/hub/web/dist/THIRD-PARTY-NOTICES.txt ./THIRD-PARTY-NOTICES.txt
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/apps/hub/package.json ./apps/hub/package.json
COPY --from=build /repo/apps/hub/dist ./apps/hub/dist
COPY --from=build /repo/apps/hub/bin ./apps/hub/bin
COPY --from=build /repo/apps/hub/web/dist ./apps/hub/web/dist

RUN mkdir -p /data && chown -R tracery:tracery /data /app
USER tracery

VOLUME ["/data"]
EXPOSE 8971

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TRACERY_PORT||8971)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/hub
ENTRYPOINT ["node", "bin/hub.mjs"]
