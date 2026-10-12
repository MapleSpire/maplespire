# Architecture & Configuration

How the maplespire-mvp stack fits together, how to run it, and every environment
variable / runtime flag that changes its behaviour.

---

## 1. System architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser (Vite + React + TS)                              dev: :5173       │
│                                                                            │
│  Canvas renderer (src/canvas) ── Zustand modelStore ── ModelQuery seam     │
│   auto-layout (src/lib/layout)        │                  (getModelQuery)   │
│                                       │                        │           │
│              Automerge bridge (src/lib/automerge/bridge.ts)    │           │
│                 client Repo (IndexedDB + WebSocket)            │           │
└───────────────────┬────────────────────────────────┬─────────┴───────────┘
                    │ ws  /automerge (CRDT sync)      │ HTTP /api/* (REST)
                    │ GET /api/automerge/root         │
┌───────────────────▼────────────────────────────────▼──────────────────────┐
│  Node server (Express + tsx)                             dev: :3001        │
│                                                                            │
│   ① Automerge SYNC peer   ② Theme gallery API   ③ Read-model query API     │
│      (automergeServer.ts)    (/api/themes/*)       (/api/model/*, opt-in)  │
│      ws /automerge                                  + read-model PROJECTOR  │
│      Postgres storage adapter                          (Automerge→Postgres)│
└───────────────────────────────────┬────────────────────────────────────────┘
                                     │ SQL
┌────────────────────────────────────▼───────────────────────────────────────┐
│  Postgres 16                              docker :5432  OR  embedded :5432   │
│   automerge_storage (CRDT chunks)  ·  automerge_meta (root url)              │
│   themes  ·  ro_objects/ro_connections/ro_groups/ro_diagrams (read model)   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data flow.** The browser is a full Automerge (CRDT) peer: it persists documents
locally in IndexedDB and syncs them over a WebSocket to the server, which is the
durable peer (it persists every document in Postgres). UI reads/writes go through the
Zustand `modelStore`; the `bridge` projects Automerge docs → store (read) and
reconciles store → docs (write). Cross-diagram reads go through the **ModelQuery
seam** (`getModelQuery()`), which can be served from the resident store, the
IndexedDB index, or the server read model depending on flags.

---

## 2. Components

| # | Component | Where | Dev port | Responsibility |
|---|---|---|---|---|
| — | **Web client** | `src/`, served by Vite | **5173** | React UI, canvas renderer, auto-layout, the Automerge client repo, the Zustand store + ModelQuery seam. Build-time config via `VITE_*`. |
| ① | **Automerge sync peer** | `server/src/automergeServer.ts` | 3001 (`ws /automerge`) | A durable Automerge peer. Relays CRDT sync between clients, persists docs to Postgres (`automergeStorage.ts`), owns the shared **root** doc (`GET /api/automerge/root`). Optional idle eviction + selective sync. |
| ② | **Theme gallery API** | `server/src/themes.ts` + `index.ts` | 3001 (`/api/themes/*`) | Community theme publish/list/install (Postgres `themes` table). Always on. |
| ③ | **Read-model query API** | `server/src/readModel/*` + `index.ts` | 3001 (`/api/model/*`) | **Opt-in (`READ_MODEL=on`).** Postgres projection of the C4 model (`ro_*` tables, GIN/pg_trgm search) so clients answer cross-diagram queries without materializing the whole model. Includes the **projector** (`projectorService.ts`) that subscribes to the Automerge shards and keeps the tables fresh. |
| — | **Postgres 16** | docker / embedded | **5432** | Storage for Automerge chunks, the root-url pointer, themes, and the read model. |

The Express server (`server/src/index.ts`, port `PORT`/3001) hosts ②③ as HTTP and
attaches ① to the same HTTP server's WebSocket upgrade on `/automerge`.

### Notable endpoints
- `GET /api/health` — liveness.
- `GET /api/automerge/root` — the shared root document URL (every client opens the
  same one → one shared workspace).
- `GET /api/automerge/stats` — how many docs the server holds in memory (per state);
  used to confirm idle eviction / selective sync keep it bounded.
- `GET /api/themes`, `/api/themes/:id`, `POST /api/themes`, `…/install`, `…/report`.
- `GET /api/model/*` (only when `READ_MODEL=on`): `object/:id`, `group/:id`, `lookup`,
  `dependencies`, `connection-count`, `descendants`, `related-diagrams`, `search`,
  `page-objects`, `page-connections`.

---

## 3. Running the stack

**Prerequisites:** Node ≥ 20 (22 used here), npm; and Postgres via **Docker**
(`docker compose`) *or* the bundled **embedded** Postgres (no Docker needed). Install
deps in both roots: `npm install` and `cd server && npm install`. (If auto-layout
silently falls back to the built-in engine, check that `elkjs` is installed.)

### One-command dev (recommended)

```bash
npm run dev:local   # embedded Postgres + server + client (no Docker)
# or
npm run dev:all     # docker Postgres + server + client
```

Both use `concurrently` to run three processes. Then open the client (Vite prints the
URL, normally http://localhost:5173).

### Run pieces individually

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (client) only. |
| `npm run dev:server` | `cd server && tsx watch src/index.ts` — the Node server only. |
| `npm run db:embedded` | Start the bundled embedded Postgres (`server/scripts/embedded-db.mjs`). |
| `npm run db:up` / `db:down` / `db:reset` | Docker Postgres up / down / wipe+up. |
| `npm run build` | `tsc -b && vite build` (client). `cd server && npm run build` for the server (`tsc` → `dist/`, then `npm start`). |
| `npm test` | Client vitest. `cd server && npm test` for server vitest. |
| `npm run lint` | `eslint .` |
| `npm run e2e` | Playwright tests. |

### Enabling the premium read model locally

```bash
# server: project the model into Postgres + serve /api/model/*
cd server && READ_MODEL=on npm run dev
# client: route cross-diagram reads to the server
#   in the browser console:  __serverReadModel.on()   (reloads)
```
Note `READ_MODEL=on` also disables idle eviction (the server must keep the model docs
resident to project them).

### Enabling selective sync (the boot fix, server side)

```bash
cd server && AM_SELECTIVE_SYNC=on npm run dev   # announce only core docs; serve the rest on demand
```
Default off → the server announces every doc (legacy behaviour).

---

## 4. Environment variables

### 4a. Client (build-time, `VITE_*` — set in the shell or a `.env` Vite reads)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_SYNC_API_URL` | `http://localhost:3001` | Base URL for server REST (root url, themes, read-model API). |
| `VITE_AUTOMERGE_URL` | `ws://localhost:3001/automerge` | Base WebSocket URL for the Automerge sync peer. The client appends the active `landscapeId` and `versionId`. |
| `VITE_SHARD_SIZE` | `200` | Max diagrams per **registry** shard. |
| `VITE_MODEL_SHARD_SIZE` | `512` | Max objects/connections per **model** shard (only when model sharding is on). Larger ⇒ fewer shards (faster boot/sync) but bigger per-edit reconcile. |
| `VITE_MODEL_SHARDING` | `false` | Shard the monolithic ModelDoc into ModelMeta + object/connection shards (Slice 3 write-cost fix). Also a runtime flag (below). |
| `VITE_MODEL_PAGING` | `false` | Route the ModelQuery seam through the IndexedDB index instead of the resident store. Also a runtime flag. |
| `VITE_SERVER_READ_MODEL` | `false` | Route the ModelQuery seam through the server read model (`/api/model/*`). Also a runtime flag. |

`import.meta.env.DEV` (set by Vite in dev) gates the DEV console hooks below.

### 4b. Server (runtime `process.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP/WebSocket port for the Express + Automerge server. |
| `DATABASE_URL` | `postgres://maplespire:maplespire@localhost:5432/maplespire` | Postgres connection string (server + read-model + tests). |
| `READ_MODEL` | *(off)* | `on` ⇒ mount `/api/model/*` + start the read-model projector + disable idle eviction. |
| `AM_SELECTIVE_SYNC` | *(off)* | `on` ⇒ the sync peer announces only the core boot docs (root/meta/registry) and serves the rest on demand. Off ⇒ announce everything. |
| `AM_RESET_SYNC_STATE_ON_DISCONNECT` | *(off)* | `on` ⇒ after the last connection for a remote storage id closes, serialize pending sync-state saves and remove their exact persisted keys. Required on hubs that enforce WebSocket backpressure so a refused final frame is never treated as delivered after reconnect. |
| `AM_PERSIST_SYNC_STATE` | `on` | `off` ⇒ keep sync progress only in memory and start reconnects from an empty protocol state. Recommended for server hubs whose void transport API cannot acknowledge delivery; it trades some reconnect computation for correctness under backpressure and ownership handoff. |
| `AM_RETIRED_SYNC_DOCUMENT_LIMIT` | `100000` | Qualification threshold (1,000–1,000,000) exposed by `/api/automerge/stats` and enforced by the multi-cell load/soak gate for correctness-preserving retired-document tombstones. Tombstones are measured rather than age-evicted because arbitrarily late offline peers remain supported. |
| `AM_WORKSPACE_ROUTING` | *(off)* | `on` ⇒ reject Automerge upgrades unless the URL names exactly one active workspace; the shipped Compose files enable it. |
| `SYNC_CELL_PARTITION_COUNT` | `1` | Stable cluster-wide workspace partition count (1–1024). Keep at `1` until the public sync router is deployed. |
| `SYNC_CELL_TOPOLOGY_GENERATION` | `v1` | Stable topology identity stored in critical Redis; a mismatch fails boot. |
| `SYNC_CELL_ADVERTISE_URL` | *(unset)* | Internal `http(s)://host:port` origin for exactly one sync cell. Required before another cell can route a WebSocket to it; `compose.maplespire.yml` sets one per cell (`api`, `api-b`). |
| `AM_SHARD_SIZE` | `200` | Server-side registry shard size used during the one-time `entities`→Automerge migration. |
| `AM_IDLE_MS` | `300000` (5 min) | Idle-eviction threshold: unload docs idle longer than this **and** with no connected peer. `0` disables. Auto-disabled when `READ_MODEL=on`. |
| `AM_SWEEP_MS` | `60000` (1 min) | How often the idle-eviction sweep runs. |
| `METRICS_TOKEN` | *(unset)* | Bearer token for `GET /metrics` (Prometheus). **Unset ⇒ the endpoint 404s**, deliberately: failing open would publish workspace counts and process memory to anything that reaches the port, and scrape endpoints get exposed through an ingress by accident more than any other route. |
| `READ_MODEL_STALE_GRACE_MS` | `60000` (1 min) | How long a durable Automerge write may sit unobserved before its workspace reports `stale`. Validated `>= 1`; blank is treated as unset. |

### 4b-bis. Backup drill

| Variable | Default | Purpose |
|---|---|---|
| `BACKUP_DIRECTORY` | *(unset)* | Bundle destination when `--output` is not given. The drill refuses an existing directory. |
| `BACKUP_DRILL_SIGNING_KEY` | *(unset)* | HMAC-SHA256 key over the report's canonical JSON. **Unset ⇒ the run is still recorded, labelled unsigned** — a drill that refused to record itself for want of a key would be worse than an unsigned record of a real restore. Keep it in the worktree-local `server/.env`, never in committed source. |
| `BACKUP_DRILL_SIGNING_KEY_ID` | `default` | Names the key in the stored report so it can be rotated without invalidating the archive. |
| `BACKUP_DRILL_REPORT` | *(unset)* | Path for the signed report when `--report` is not given. |
| `BACKUP_POSTGRES_CONTAINER` | *(unset)* | Run `pg_dump`/`pg_restore` inside this container instead of on the host. |
| `BACKUP_POSTGRES_DOCKER_HOST` / `_PORT` | *(unset)* | Set **together** when the container is only a source of binaries rather than the server itself — typically `host.docker.internal` and the host port. Needed on a host with no client, or one whose client is older than the server. |
| `TECHNOLOGY_ASSET_DIR` | `server/data/technology-assets` | The icon volume. The drill archives from it; a restored cold server is pointed at the materialized copy, never at this one. The scheduled container mounts it read-only. |
| `BACKUP_BUNDLE_ROOT` | `/var/lib/maplespire/backups` | **Scheduler only**, and deliberately not `BACKUP_DIRECTORY`: this is the directory that HOLDS every bundle and that the retention sweep deletes from, whereas the one-shot CLI's `BACKUP_DIRECTORY` is ONE bundle. The scheduler refuses to start if only the CLI variable is set. |
| `BACKUP_DRILL_INTERVAL_HOURS` | `24` | Cadence, measured from the START of each run so a slow drill does not drift the schedule later each day. Accepts 0.25–720; an unreadable value is an error, not a silent clamp. |
| `BACKUP_DRILL_DEADLINE_HOURS` | `min(6, interval − grace)` | **Scheduler only.** Wall-clock ceiling on ONE drill. When it expires the drill is aborted, given `BACKUP_DRILL_ABORT_GRACE_SECONDS` to unwind, and — if it still will not stop — the process ENDS, because a session advisory lock held by a drill that cannot be stopped is returned only by the backend dying. **A bad value is a boot failure, not a warning**, and the container's restart policy will loop on it: refused below 30 minutes (`BackupDrillRtoDegraded` already tickets at 15, so a shorter ceiling kills drills the monitoring thinks are merely slow), and refused when `deadline + grace` exceeds `BACKUP_DRILL_INTERVAL_HOURS` — the maximum hold is the SUM, and a hold longer than the cadence bounds nothing. |
| `BACKUP_DRILL_ABORT_GRACE_SECONDS` | `300` | **Scheduler only.** How long an aborted drill has to stop before the process ends. Must exceed the teardown ceiling (120 s per step): the grace is the window in which the drill drops the isolated restore database it created, work that still touches the cluster and that the exclusion must still cover. Must also be **shorter than the deployment's `stop_grace_period`**, or Docker sends `SIGKILL` first and the graceful teardown never completes — `scripts/maplespire-compose.test.mjs` asserts that relation. Zero is refused. |
| `BACKUP_DRILL_COLD_API` | `on` | `off` skips booting a server against the restore. |
| `BACKUP_DRILL_HISTORY_MAX_BYTES` | `64MB` | Byte budget for `backup_drill_runs`. Accepts `KB`/`MB`/`GB`. The most recent PASSING run and the most recent 10 runs are never pruned — deleting either would manufacture an alert. Sub-64KB values are treated as a typo and ignored. |
| `BACKUP_BUNDLE_MAX_BYTES` | `20GB` | Byte budget for bundle directories. The newest bundle is never deleted; only directories containing a `manifest.json` are ever candidates. |
| `BIND_ADDRESS` | *(all interfaces)* | Listen address. The drill's cold server sets `127.0.0.1` because it runs `AUTH=off` against a full restore of production data. |

### 4c. Embedded Postgres (`server/scripts/embedded-db.mjs`)

Only used by `npm run db:embedded` (the no-Docker path).

| Variable | Default | Purpose |
|---|---|---|
| `PGPORT` | `5432` | Port the embedded cluster listens on. |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE` | `maplespire` / `maplespire` / `maplespire` | Superuser + database created on first run. |
| `PGDATA_DIR` | OS data dir (`LOCALAPPDATA`/`XDG_DATA_HOME`) | Where the cluster's data lives (persists across runs). |
| `PGSHAREDBUF` | `32MB` | `shared_buffers` — kept small to avoid a Windows shared-memory wedge. |
| `PGMAXCONN` | `100` | `max_connections` — raised from the PG default to survive many concurrent test/dev connections. |

### 4d. Tests / CI / misc

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | server vitest (`vitest.global-setup.ts`, the `*.integration.test.ts`) | DB the server tests run against; suites **skip gracefully** when unreachable. |
| `CI`, `E2E_*` | `playwright.config.ts` | Playwright run config. |
| `GEN_PREVIEW` | `src/lib/layout/genPreview.test.ts` | Opt-in layout-preview generation in a test. |
| `TEST_DATABASE_URL` | the 21 DB-gated server suites | Postgres they run against; **unset ⇒ they skip silently**. CI sets it and `REQUIRE_DB_TESTS`, and `scripts/check-test-skips.mjs` fails a run that skipped anything undeclared. See `docs/ci.md`. |
| `TEST_REDIS_URL` | the Redis-gated suites | Same shape, for `runtime/redis.integration.test.ts` and `syncCells/ownership.redis.integration.test.ts`. Paired with `REQUIRE_REDIS_TESTS`. |
| `REQUIRE_DB_TESTS`, `REQUIRE_REDIS_TESTS` | `src/testing/serviceGates.test.ts` | Declare that this environment intends to run the gated suites, so an unreachable service fails in seconds by name instead of vanishing into a green run. |
| `BACKUP_RESTORE_TEST_DATABASE_URL` | `src/backup/backupRestore.integration.test.ts` | Opt-in `pg_dump`/`pg_restore` drill. Not wired into CI yet — see `test-skip-allowlist.json`. |

---

## 5. Runtime feature flags (no rebuild)

Each Phase-4 performance flag has a `VITE_*` build-time form **and** a `localStorage`
runtime toggle with a `window.__*` console helper that flips it and reloads. Default
**off** ⇒ behaviour is the classic resident model.

| Console helper | localStorage key | What it does |
|---|---|---|
| `__modelSharding.on()/off()/status()` | `maplespire:modelSharding` | Shard the ModelDoc (Slice 3). `status()` reports shard counts. |
| `__modelPaging.on()/off()/enabled()` | `maplespire:modelPaging` | Serve the ModelQuery seam from the IndexedDB index. |
| `__serverReadModel.on()/off()/enabled()` | `maplespire:serverReadModel` | Serve the ModelQuery seam from the server read model (needs `READ_MODEL=on` server). |

Seam selection order in `getModelQuery()`: **server read model** → **IndexedDB index
(paging)** → **resident store** (default).

### DEV-only data hooks (`import.meta.env.DEV`, in the browser console)

| Hook | Purpose |
|---|---|
| `__seedLoad(nObjects, mConnections)` | Seed a synthetic flat load for perf testing. |
| `__seedHubs(5000, 10000)` | Add two high-degree hub objects (stress the Dependencies fan-out). |
| `__seedRich(opts?)` | Seed a realistic enterprise workspace (200 diagrams / 20k objects / 30k connections, C4 hierarchy, hubs, ADRs, flows, tags, technologies). |
| `__clearLoad()` | Remove the seeded load/hub/rich data. |
| `__editObject(id?, patch?)` | Programmatically edit one object (used to measure write latency). |
| `__canvasEngine`, `__themeSandbox` | Canvas-engine / theme-sandbox dev introspection. |

> Seeded data is written through the store, so it round-trips to the docs and
> persists. Use `__clearLoad()` (or `server/scripts/reset-automerge.mjs`) to reset.

---

## 6. Ports at a glance

| Port | Service |
|---|---|
| **5173** | Vite client (dev). |
| **3001** | Express server: REST (`/api/*`) + Automerge WebSocket (`/automerge`). Override with `PORT`. |
| **5432** | Postgres (docker or embedded). Override with `PGPORT` (embedded) / `DATABASE_URL`. |

> A second server instance is sometimes run on a different `PORT` (e.g. 3002) with
> `READ_MODEL=on` to exercise the read model without disturbing the main sync peer.

---

## 7. Reset / recovery

- **Reset the Automerge workspace:** `node server/scripts/reset-automerge.mjs`
  (clears `automerge_storage` + `automerge_meta`; the server recreates an empty root
  on next boot).
- **Embedded Postgres wedged** (Windows shared-memory / `ECONNRESET`): stop it
  (`pg_ctl stop -D <PGDATA_DIR> -m fast`, the bundled binary is under
  `server/node_modules/@embedded-postgres/...`), then `npm run db:embedded`.
- **Stale dev server on a port:** a killed `tsx`/`node` can leave a child holding the
  port; find it (`Get-NetTCPConnection -LocalPort 3001`) and stop that PID before
  restarting.
