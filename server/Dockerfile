# --- Build stage: install all deps (incl. dev) and compile TypeScript ---
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* patch-automerge-peer-sync-state.mjs patch-automerge-change-observers.mjs patch-automerge-document-saves.mjs patch-automerge-cooperative-events.mjs patch-automerge-inflight-fanout.mjs patch-automerge-sync-state-lifetime.mjs ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage: production deps only + compiled output ---
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache su-exec

COPY package.json package-lock.json* patch-automerge-peer-sync-state.mjs patch-automerge-change-observers.mjs patch-automerge-document-saves.mjs patch-automerge-cooperative-events.mjs patch-automerge-inflight-fanout.mjs patch-automerge-sync-state-lifetime.mjs ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/technology-assets-entrypoint

RUN mkdir -p /var/lib/maplespire/assets/technologies \
    && chown -R node:node /var/lib/maplespire/assets \
    && chmod 0755 /usr/local/bin/technology-assets-entrypoint

ENV TECHNOLOGY_ASSET_DIR=/var/lib/maplespire/assets/technologies

ENTRYPOINT ["technology-assets-entrypoint"]

EXPOSE 3001

CMD ["node", "dist/index.js"]

# --- Drill stage: the same artifact, plus a matching PostgreSQL client ---
#
# Built FROM runtime rather than as its own image so the drill exercises the
# code that is deployed, byte for byte. That matters twice over: the cold-API
# stage boots `dist/index.js` from THIS image against the restored database, so
# a drill that passed is evidence about the running build and not about a
# separately-built copy of it.
#
# PG_MAJOR must match the SERVER's major version — pg_dump refuses to talk to a
# server newer than itself, and the failure is at drill time, on the day you
# upgraded Postgres and nothing else broke. Bump it with the postgres image.
FROM runtime AS drill

ARG PG_MAJOR=16
RUN apk add --no-cache "postgresql${PG_MAJOR}-client"

# Bundles are large and written on every run; the scheduler prunes them to a
# byte budget, and this is the path that budget applies to.
ENV BACKUP_DIRECTORY=/var/lib/maplespire/backups
RUN mkdir -p "${BACKUP_DIRECTORY}" && chown -R node:node "${BACKUP_DIRECTORY}"

# Its own entrypoint: the api's repairs ownership of the asset volume, which the
# drill mounts read-only on purpose. See docker-entrypoint-drill.sh.
COPY docker-entrypoint-drill.sh /usr/local/bin/backup-drill-entrypoint
RUN chmod 0755 /usr/local/bin/backup-drill-entrypoint
ENTRYPOINT ["backup-drill-entrypoint"]

CMD ["node", "dist/backup/drillScheduler.js"]
