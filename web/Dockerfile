# Build with the repo root as context (pnpm workspace):
#   docker build -f web/Dockerfile -t ats-web .
# Static build served by nginx - web/ has no runtime dependency on core or
# server (it only ever talks to the API over HTTP, via relative /api/v1/...
# paths - see src/lib/api.ts), so unlike server/Dockerfile and
# workers/Dockerfile there's nothing here to link against packages/core.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --filter web...

FROM deps AS build
COPY web web
RUN pnpm --filter web build

# nginx, not a Node static server: this is the actual entry point for the
# whole stack (docker-compose.prod.yml maps it to the host's :5173, matching
# what WEB_ORIGIN already defaults to), so it also reverse-proxies
# /api/v1/... to the api container - see nginx.conf - rather than needing a
# second origin and CORS in the browser.
FROM nginx:1.27-alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 80
# 127.0.0.1, not localhost: nginx's default config here only has `listen
# 80;` (IPv4), but /etc/hosts resolves "localhost" to ::1 first - wget then
# tries the IPv6 loopback, finds nothing listening there, and fails with
# "Connection refused" even though the server is completely healthy and
# already serving real traffic on IPv4 fine (caught exactly this: every
# actual request succeeded while this healthcheck kept failing).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:80/ >/dev/null || exit 1
