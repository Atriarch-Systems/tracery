# Tracery Hub (SPEC.md §6 "Packaging"). Build from the REPO ROOT:
#
#   docker build -f apps/hub/Dockerfile -t atriarch/tracery-hub:dev .
#
# Multi-stage: builds the npm workspaces this image actually needs
# (@atriarch/tracery-core + @atriarch/tracery-hub), builds the hosted UI in
# apps/hub/web when that directory exists (workstream E), and ships a final
# node:22-alpine image with only production dependencies.

FROM node:22-alpine AS build
WORKDIR /repo

# Full monorepo context: apps/hub/web may or may not exist yet, and copying
# the whole tree sidesteps having to conditionally COPY a maybe-missing
# directory (Docker COPY fails outright on a source that isn't there).
COPY . .

RUN npm ci

# Hosted UI (apps/hub/web, workstream E) is optional at this point in the
# build: when its package.json is present it is also an npm workspace (see
# the root package.json), so the one `npm ci` above already installed its
# deps and it just needs to be included in the build below. When it is
# absent, build without it and leave an empty dist/ so the final stage's
# COPY always has something to copy; the hub then falls back to its "UI not
# built" placeholder page (apps/hub/src/routes/ui.ts) at runtime.
RUN if [ -f apps/hub/web/package.json ]; then \
      echo "building apps/hub/web"; \
      npm run build -w @atriarch/tracery-core -w @atriarch/tracery-hub -w @atriarch/tracery-hub-web; \
    else \
      echo "apps/hub/web not present yet; shipping without a hosted UI"; \
      npm run build -w @atriarch/tracery-core -w @atriarch/tracery-hub; \
      mkdir -p apps/hub/web/dist; \
    fi

# Drop devDependencies (typescript, @types/*, ws, ...) from node_modules now
# that everything is compiled; keeps the npm-workspaces symlink graph intact.
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S tracery && adduser -S tracery -G tracery

# TRACERY_HOST=0.0.0.0: config.ts's local-mode default (127.0.0.1) is a
# Node-process convenience (`npx @atriarch/tracery-hub`), not a container one
# -- a container needs to accept connections from outside its network
# namespace, so this image binds all interfaces explicitly.
#
# TRACERY_AUTH=none: a bare `docker run -p 8971:8971 image` with no other env
# would otherwise fail to boot (config.ts: non-loopback host + no
# TRACERY_API_KEYS = a startup error, on purpose -- see apps/hub/README.md
# "Auth mode"). This default assumes whatever you're doing with a bare
# `docker run` already trusts the network it's exposed on; a real deployment
# should instead set TRACERY_API_KEYS/_FILE (docker-compose.yaml, k8s/, and
# helm/ all do) and drop this back to unset.
ENV NODE_ENV=production \
    TRACERY_HOST=0.0.0.0 \
    TRACERY_PORT=8971 \
    TRACERY_STORE=memory \
    TRACERY_SQLITE_PATH=/data/tracery.db \
    TRACERY_AUTH=none

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
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
