# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime

LABEL org.opencontainers.image.source="https://github.com/Microck/akron-discord" \
  org.opencontainers.image.title="akron-discord"

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/akron-discord.sqlite

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system akron \
  && useradd --system --gid akron --home /app --shell /usr/sbin/nologin akron \
  && mkdir -p /app/data \
  && chown -R akron:akron /app \
  && chmod 0700 /app/data

COPY --from=build --chown=akron:akron /app/package.json /app/package-lock.json ./
COPY --from=build --chown=akron:akron /app/node_modules ./node_modules
COPY --from=build --chown=akron:akron /app/dist/src ./dist/src
COPY --chown=akron:akron assets ./assets

USER akron

VOLUME ["/app/data"]

CMD ["node", "dist/src/index.js"]
