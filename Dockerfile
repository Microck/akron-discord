# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

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

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/akron-discord.sqlite

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system akron \
  && useradd --system --gid akron --home /app --shell /usr/sbin/nologin akron \
  && mkdir -p /app/data \
  && chown -R akron:akron /app

COPY --from=build --chown=akron:akron /app/package.json /app/package-lock.json ./
COPY --from=build --chown=akron:akron /app/node_modules ./node_modules
COPY --from=build --chown=akron:akron /app/dist ./dist
COPY --chown=akron:akron assets ./assets

USER akron

VOLUME ["/app/data"]

CMD ["node", "dist/src/index.js"]
