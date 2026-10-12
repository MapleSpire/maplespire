FROM node:22-alpine AS web-build

WORKDIR /app
COPY package.json package-lock.json ./
COPY server/patch-automerge-peer-sync-state.mjs server/patch-automerge-change-observers.mjs server/patch-automerge-document-saves.mjs server/patch-automerge-cooperative-events.mjs server/patch-automerge-inflight-fanout.mjs server/patch-automerge-sync-state-lifetime.mjs ./server/
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.image.json ./
COPY public ./public
COPY scripts/normalize-icon-catalog-assets.mjs ./scripts/normalize-icon-catalog-assets.mjs
COPY docker/icons ./docker/icons
COPY src ./src

# Empty public endpoints intentionally compile the browser clients to same-
# origin HTTP and a runtime-derived same-origin WebSocket URL.
ARG VITE_SYNC_API_URL=""
ARG VITE_AUTOMERGE_URL=""
ARG VITE_BOOT_FROM_SERVER="false"
ARG VITE_MODEL_SHARDING="false"
ARG VITE_SERVER_READ_MODEL="false"
ARG VITE_CLIENT_PERF_DIAGNOSTICS="false"
ENV VITE_SYNC_API_URL=${VITE_SYNC_API_URL}
ENV VITE_AUTOMERGE_URL=${VITE_AUTOMERGE_URL}
ENV VITE_BOOT_FROM_SERVER=${VITE_BOOT_FROM_SERVER}
ENV VITE_MODEL_SHARDING=${VITE_MODEL_SHARDING}
ENV VITE_SERVER_READ_MODEL=${VITE_SERVER_READ_MODEL}
ENV VITE_CLIENT_PERF_DIAGNOSTICS=${VITE_CLIENT_PERF_DIAGNOSTICS}
# `build:image`, NOT `build`. It exists because this build context has no
# `server/` in it by design (.dockerignore, ~584 MB), while the conformance
# tests in `src/lib/automerge/` import the server's copy of a shared module on
# purpose. See tsconfig.image.json for the full account; the gate those imports
# form still runs, at the repository root, in CI.
#
# TWO differences from `build`, not one, and the second is easy to miss.
# `tsconfig.image.json` excludes test files — that is the one this exists for.
# But `build` is `tsc -b`, which builds BOTH projects tsconfig.json references,
# and `build:image` is `tsc -p tsconfig.image.json`, which extends the app
# project alone: `vite.config.ts` (tsconfig.node.json) is not typechecked here.
# It is typechecked at the repository root by `npm run build`, in
# .github/workflows/ci.yml and in scripts/ci-local.mjs --static.
#
# `src/webImageBuild.test.ts` fails if a NON-test file ever gains such an
# import, which is the case this exclusion could not save.
#
# THIS LINE IS A MERGE RESOLUTION (2026-09-04), and the branch it replaced is
# the reason to say so. Task B0a-0a fixed the same four-day-old breakage by
# DROPPING the typecheck from this stage — `RUN npm run prebuild && npx vite
# build` — which works and checks less. `build:image` keeps a typecheck over the
# files the image actually ships and keeps the two `prebuild` verifications
# through `prebuild:image`, so it strictly contains the abandoned form. The gate
# B0a-0a left behind in `scripts/maplespire-compose.test.mjs` was rewritten to
# this mechanism in the same commit rather than deleted.
RUN npm run build:image
RUN if grep -R -E "(http|ws)://localhost:3001" dist; then exit 1; fi

FROM nginx:alpine

# The official nginx entrypoint renders /etc/nginx/templates/*.template with
# envsubst. This keeps the same image usable in Compose (`backend`) and in a
# cloud sidecar (`127.0.0.1`) without baking an environment hostname into it.
# The four defaults below are independent literal values. A single-cell
# manifest overriding BACKEND_* must also set SYNC_WS_* to that API endpoint.
# A manifest running an owner-aware router sets SYNC_WS_* to that router
# instead (task B0a-4); changing BACKEND_* does not update SYNC_WS_*.
ENV BACKEND_HOST=backend \
    BACKEND_PORT=3001 \
    SYNC_WS_HOST=backend \
    SYNC_WS_PORT=3001
COPY docker/nginx/nginx.conf /etc/nginx/templates/default.conf.template
# Off unless MS_IDENTITY_ASSOCIATION_APP_ID is set; see the script.
COPY --chmod=755 docker/nginx/40-microsoft-identity-association.sh /docker-entrypoint.d/40-microsoft-identity-association.sh
COPY --from=web-build /app/dist /usr/share/nginx/html
COPY docker/icons /usr/share/nginx/html/icons
RUN mkdir -p /var/lib/maplespire/assets/technologies

EXPOSE 80
