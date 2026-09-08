# Build images only from the reviewed source + frozen pnpm lockfile.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @dingjiang/contracts build \
 && pnpm --filter @dingjiang/api build \
 && pnpm --filter @dingjiang/web build \
 && pnpm --filter @dingjiang/mcp build
# Keep compilers, test runners and package-manager tooling out of the runtime layers.
RUN CI=true pnpm install --prod --frozen-lockfile \
 && mkdir -p /var/lib/dingjiang/materials

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS base
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/packages/contracts ./packages/contracts
COPY --from=build --chown=1000:1000 /var/lib/dingjiang /var/lib/dingjiang
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node"]

FROM base AS api
COPY --from=build --chown=1000:1000 /app/apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["dist/main.js"]

FROM base AS web
COPY --from=build --chown=1000:1000 /app/apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]

FROM postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0 AS db
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade libpcre2-8-0 \
 && rm -rf /var/lib/apt/lists/* /usr/local/bin/gosu
USER postgres

FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS proxy
RUN apk upgrade --no-cache
