# Build with the repo root as context (pnpm workspace):
#   docker build -f workers/Dockerfile -t ats-workers .
# One image, five possible processes - override CMD to pick which one a
# given container runs (the outbox relay and each queue worker scale and
# restart independently of each other and of the API; see
# docker-compose.prod.yml, which runs all five from this one image with
# per-queue replica counts):
#   docker run ats-workers node workers/dist/relay.js                # outbox relay
#   docker run ats-workers node workers/dist/resumeParse.js          # queue: resume-parse
#   docker run ats-workers node workers/dist/dedupeScan.js           # queue: dedupe-scan
#   docker run ats-workers node workers/dist/notifications.js        # queue: notifications
#   docker run ats-workers node workers/dist/scheduledMaintenance.js # queue: scheduled-maintenance
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Install workspace deps first so this layer only invalidates when a
# manifest/lockfile changes, not on every source edit. --filter workers...
# pulls in "core" too, since workers depends on it via workspace:*.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/package.json
COPY workers/package.json workers/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter workers...

FROM deps AS build
COPY packages/core packages/core
COPY workers workers
RUN pnpm --filter core exec prisma generate
RUN pnpm --filter core build
RUN pnpm --filter workers build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/workers/node_modules ./workers/node_modules
COPY --from=build /app/workers/dist ./workers/dist
COPY --from=build /app/workers/package.json ./workers/package.json

# Unprivileged (the base node image ships a non-root "node" user), and PID 1
# is node directly - no shell wrapper - so SIGTERM reaches the process's own
# handlers (see workers/src/shared.ts) instead of being swallowed.
USER node
# No public port - a worker never accepts inbound connections, only makes
# outbound calls to Redis/Postgres. Port 4001 below is container-internal
# only (see shared.ts's startHealthServer()): it exists purely so this
# HEALTHCHECK has something to ask "is this process's event loop alive," the
# same role the API's GET /health plays. Pointing this at the API's port
# 4000 (which the API listens on but no worker ever does) was a real bug
# caught while building this file - every worker container sat permanently
# unhealthy, which in a real orchestrator means an endless kill-and-restart
# loop on a process that was working fine.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "workers/dist/relay.js"]
