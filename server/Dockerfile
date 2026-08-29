# Build with the repo root as context (pnpm workspace):
#   docker build -f server/Dockerfile -t ats-server .
# Same image runs both processes - override CMD for the worker:
#   docker run ats-server node server/dist/worker.js
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Install workspace deps first so this layer only invalidates when a
# manifest/lockfile changes, not on every source edit.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter server...

FROM deps AS build
COPY server server
RUN pnpm --filter server exec prisma generate
RUN pnpm --filter server build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/prisma ./server/prisma
COPY --from=build /app/server/package.json ./server/package.json

# Unprivileged (the base node image ships a non-root "node" user), and PID 1
# is node directly - no shell wrapper - so SIGTERM reaches the process's own
# handlers (see src/index.ts / src/worker.ts) instead of being swallowed.
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
