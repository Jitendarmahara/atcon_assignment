# Build with the repo root as context (pnpm workspace):
#   docker build -f server/Dockerfile -t ats-server .
# API only - CMD ["node", "server/dist/index.js"]. Every queue worker plus
# the outbox relay live in their own image now (workers/Dockerfile) - they
# moved to a separate top-level package (workers/) so the repo's structure
# matches the runtime reality: API and workers are genuinely different
# deployables (separate containers, separate scaling, separate crash
# domains), not one codebase with a subfolder. Both images share the same
# packages/core (Prisma client, domain logic, queue definitions) as a
# workspace dependency - see docs/ARCHITECTURE.md.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Install workspace deps first so this layer only invalidates when a
# manifest/lockfile changes, not on every source edit. --filter server...
# pulls in "core" too, since server depends on it via workspace:*.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter server...

FROM deps AS build
COPY packages/core packages/core
COPY server server
RUN pnpm --filter core exec prisma generate
RUN pnpm --filter core build
RUN pnpm --filter server build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
# Not needed by the API itself at runtime (only by `prisma generate`, already
# run during build) - included because docker-compose.prod.yml's one-shot
# `migrate` service also builds from this image and its
# `prisma migrate deploy` command needs the actual migration SQL files
# present on disk to apply them.
COPY --from=build /app/packages/core/prisma ./packages/core/prisma
# Also not needed by the API itself (it only ever imports compiled dist/),
# but prisma/seed.ts imports straight from ../src/ (not dist/, so it stays
# identical in dev and in a container) and runs via `tsx`, which needs the
# actual .ts files on disk - without this, `docker compose run migrate npx
# tsx prisma/seed.ts` fails with ERR_MODULE_NOT_FOUND the moment it tries to
# seed a fresh container's database (caught exactly that, live).
COPY --from=build /app/packages/core/src ./packages/core/src
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json

# Unprivileged (the base node image ships a non-root "node" user), and PID 1
# is node directly - no shell wrapper - so SIGTERM reaches the process's own
# handlers (see src/index.ts) instead of being swallowed.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
