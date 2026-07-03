# syntax=docker/dockerfile:1
# Pushify backend — API server, background worker and migration runner in one image.
#   API:     node dist/index.js   (PROCESS_ROLE=api)
#   Worker:  node dist/worker.js  (PROCESS_ROLE=worker)
#   Migrate: node dist/migrate.js (one-shot)

FROM node:22-bookworm-slim AS base
WORKDIR /app

# Production dependencies. Build tools are only a fallback for native modules (argon2 ships
# prebuilds for linux glibc); they never reach the runtime image.
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
# git — the deploy worker clones user repos control-plane-side before shipping them to the
# target server over SSH. curl — container healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The migration runner reads SQL files at src/db/migrations relative to the app root.
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY package.json ./
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
