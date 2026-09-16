# Atriarch Activity Hub (SPEC.md §6 "Packaging"). Build from the REPO ROOT:
#
#   docker build -f apps/hub/Dockerfile -t atriarch-activity-hub:dev .
#
# Multi-stage: builds the npm workspaces this image actually needs
# (@atriarch/activity-core + @atriarch/activity-hub), builds the hosted UI in
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
      npm run build -w @atriarch/activity-core -w @atriarch/activity-hub -w @atriarch/activity-hub-web; \
    else \
      echo "apps/hub/web not present yet; shipping without a hosted UI"; \
      npm run build -w @atriarch/activity-core -w @atriarch/activity-hub; \
      mkdir -p apps/hub/web/dist; \
    fi

# Drop devDependencies (typescript, @types/*, ws, ...) from node_modules now
# that everything is compiled; keeps the npm-workspaces symlink graph intact.
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S activity && adduser -S activity -G activity

ENV NODE_ENV=production \
    ACTIVITY_HOST=0.0.0.0 \
    ACTIVITY_PORT=8971 \
    ACTIVITY_STORE=memory \
    ACTIVITY_SQLITE_PATH=/data/activity.db

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/core/package.json ./packages/core/package.json
COPY --from=build /repo/packages/core/dist ./packages/core/dist
COPY --from=build /repo/apps/hub/package.json ./apps/hub/package.json
COPY --from=build /repo/apps/hub/dist ./apps/hub/dist
COPY --from=build /repo/apps/hub/bin ./apps/hub/bin
COPY --from=build /repo/apps/hub/web/dist ./apps/hub/web/dist

RUN mkdir -p /data && chown -R activity:activity /data /app
USER activity

VOLUME ["/data"]
EXPOSE 8971

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ACTIVITY_PORT||8971)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/hub
ENTRYPOINT ["node", "bin/hub.mjs"]
