# Running the app locally (Windows & macOS, with or without Docker)

This guide covers every supported way to run the stack for development.

There are two parts to the database story:

- **Without Docker** — a real Postgres runs as a native child process via
  [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) (prebuilt
  binaries, no install). **Recommended** — especially on Windows, where Docker
  Desktop has been flaky.
- **With Docker** — Postgres (and optionally the backend) run in containers via
  `docker compose`.

The **frontend always runs natively** through Vite in either case.

---

## What runs where

| Service | Port | How it runs | Notes |
|---|---|---|---|
| Frontend (Vite dev server) | `5173` | `npm run dev` | Proxies `/api` → `http://localhost:3001` |
| Sync / gallery backend (Express) | `3001` | `tsx` (or Docker) | Theme gallery + entity sync |
| Postgres | `5432` | embedded **or** Docker | Pick one — both use 5432 |
| Production web (nginx, optional) | `8080` | Docker only | SPA + same-origin API, Automerge and immutable assets |

Default DB connection: `postgres://maplespire:maplespire@localhost:5432/maplespire`.

---

## Prerequisites

- **Node.js 20.19+ (or 22.12+)** and npm — required by Vite 8. Check with `node -v`.
- **Git**.
- **Docker Desktop** — only if you choose the Docker path.

### Install dependencies (once)

The repo has two `package.json` files — install both:

```bash
npm install            # root (frontend)
cd server && npm install && cd ..   # backend + embedded-postgres binaries
```

> The `cd server` install downloads the platform-specific Postgres binary
> (~100 MB) for your OS automatically. macOS pulls `darwin-arm64`/`darwin-x64`,
> Windows pulls `windows-x64` — nothing to configure.

---

## Option A — Without Docker (recommended)

A native Postgres + the backend + the frontend, all with one command.

### macOS

```bash
npm run dev:local
```

### Windows (PowerShell)

```powershell
npm run dev:local
```

`dev:local` runs three processes concurrently:

1. `db:embedded` — native Postgres on `:5432`
2. `dev:server` — the Express backend on `:3001`
3. `dev` — Vite on `:5173`

Then open **http://localhost:5173**.

> The backend waits/retries for Postgres on startup, so the start order doesn't
> matter.

### Running the pieces separately

Useful when you want each process in its own terminal:

```bash
# terminal 1 — database
npm run db:embedded

# terminal 2 — backend
npm run dev:server

# terminal 3 — frontend
npm run dev
```

Stop a process with **Ctrl+C**. Stopping `db:embedded` shuts the cluster down
cleanly. Data persists between runs (see [Data & reset](#data--reset)).

---

## Option B — With Docker

Run Postgres (and optionally the backend) in containers. The frontend still runs
via Vite.

### B1 — Postgres in Docker, backend + frontend native

This mirrors `dev:local` but uses the Docker Postgres instead of the embedded one:

```bash
npm run dev:all
```

`dev:all` runs `db:up` (Docker Postgres) + `dev:server` + `dev`. Open
**http://localhost:5173**.

Or run them separately:

```bash
npm run db:up          # start Docker Postgres (detached)
npm run dev:server     # backend
npm run dev            # frontend
npm run db:down        # stop Postgres when done
```

### B2 — Postgres + backend both in Docker

```bash
docker compose up -d postgres backend   # DB + Express backend in containers
npm run dev                              # frontend stays native
```

The backward-compatible `icons` service name now builds the production SPA and
serves it on `:8080`. It proxies `/api` and `/automerge` to `backend`, while
serving `/icons` and `/assets/technologies` from nginx on that same origin:
`docker compose up -d icons`.

Technology icon uploads are content-addressed and initially pending. Creating a
technology draft or revision claims the selected paths transactionally; pending
uploads older than `TECHNOLOGY_ASSET_PENDING_TTL_HOURS` (24 by default) are
collected in bounded daily batches. The shared volume ceiling is configurable
with `TECHNOLOGY_ASSET_GLOBAL_MAX_ASSETS` and
`TECHNOLOGY_ASSET_GLOBAL_QUOTA_BYTES`; `TECHNOLOGY_ASSET_GC_BATCH_SIZE` controls
the maximum metadata rows considered by one sweep.

The automated sweep intentionally starts from pending database metadata; it
does not enumerate the flat asset directory. A hard process/host crash in the
small interval after a new hash is written but before its database transaction
commits can therefore leave a file with no metadata. Treat filesystem usage as
the authoritative capacity alert and reconcile old unmatched hash filenames in
a maintenance window. Automating that exceptional sweep requires a persistent,
bounded directory cursor so a 50k-asset volume is never scanned on every run.

Tear everything down:

```bash
docker compose down       # stop containers
docker compose down -v     # also delete the Postgres volume (full reset)
```

---

## Don't run both databases at once

The embedded Postgres and the Docker Postgres **both bind port 5432** — only one
can run at a time.

If you switch from Docker to embedded (or hit "port already in use"):

```bash
npm run db:down            # free 5432 from Docker
```

On Windows you can confirm what holds the port:

```powershell
Get-NetTCPConnection -LocalPort 5432 -State Listen |
  ForEach-Object { (Get-Process -Id $_.OwningProcess).ProcessName }
```

A native cluster shows `postgres`; Docker shows `com.docker.backend` / `wslrelay`.

---

## Environment variables

All optional — sensible defaults are built in.

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | backend | `postgres://maplespire:maplespire@localhost:5432/maplespire` | Point the backend at any Postgres |
| `PORT` | backend | `3001` | Backend listen port |
| `VITE_SYNC_API_URL` | frontend | `http://localhost:3001` | Backend base URL the client calls |
| `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | embedded DB | `5432` / `maplespire` / `maplespire` / `maplespire` | Embedded cluster settings |
| `PGDATA_DIR` | embedded DB | per-OS path (below) | Where the embedded cluster lives |

Example — point the backend at an external/cloud Postgres (no local DB at all):

```bash
# macOS / Linux
DATABASE_URL='postgres://user:pass@host:5432/db' npm run dev:server
```

```powershell
# Windows PowerShell
$env:DATABASE_URL='postgres://user:pass@host:5432/db'; npm run dev:server
```

---

## Data & reset

### Embedded Postgres

The cluster is stored **outside** the project tree (so cloud-sync folders like
OneDrive don't lock or corrupt the data files):

| OS | Default data directory |
|---|---|
| Windows | `%LOCALAPPDATA%\maplespire-dag\pgdata` |
| macOS / Linux | `~/.local/share/maplespire-dag/pgdata` (or `$XDG_DATA_HOME/maplespire-dag/pgdata`) |

To wipe it and start fresh, stop the cluster and delete that folder — the next
`db:embedded` run re-initialises it.

```bash
# macOS
rm -rf ~/.local/share/maplespire-dag/pgdata
```

```powershell
# Windows
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\maplespire-dag\pgdata"
```

### Docker Postgres

```bash
npm run db:reset          # docker compose down -v && up -d postgres
```

---

## Verifying the gallery end-to-end

With the backend running (either path), Shop → **Community** → **Create theme**
(or **Publish sample**) → it appears in the Gallery → **Install**. You can also
hit the API directly:

```bash
curl http://localhost:3001/api/themes
```

---

## Troubleshooting

**`could not reserve shared memory region ... error code 487` (Windows, embedded
Postgres).**
Harmless and already mitigated — the launcher shrinks the shared-memory footprint
and Postgres retries the backend. If you still see occasional `ECONNRESET` under
heavy load, the backend pool retries transient errors automatically. No action
needed.

**Docker Desktop daemon keeps dropping / Postgres "healthy" but port 5432
refuses connections (Windows).**
This was the original reason the embedded path exists. Use **Option A**
(`npm run dev:local`) — it needs no Docker.

**`'tsx' is not recognized` / backend won't start.**
You missed the backend install: `cd server && npm install`.

**Port 5432 already in use.**
Another Postgres (Docker or a previous embedded run) is up. `npm run db:down`, or
kill the `postgres` process, then retry.

**Port 5173 or 3001 already in use.**
Vite will pick the next free port and print the URL. For the backend, set
`PORT=3002` (and `VITE_SYNC_API_URL=http://localhost:3002` for the frontend).

**Stop a stuck embedded cluster manually.**
Use the bundled `pg_ctl`:

```bash
# from server/
./node_modules/@embedded-postgres/<platform>/native/bin/pg_ctl -D "<PGDATA_DIR>" stop -m fast
```

(`<platform>` is e.g. `windows-x64`, `darwin-arm64`.)

---

## Command reference

| Command | What it does |
|---|---|
| `npm run dev` | Frontend only (Vite) |
| `npm run dev:server` | Backend only |
| `npm run db:embedded` | Native Postgres only (no Docker) |
| `npm run dev:local` | **Embedded DB + backend + frontend** (no Docker) |
| `npm run db:up` / `db:down` | Start / stop Docker Postgres |
| `npm run db:reset` | Recreate Docker Postgres (wipes data) |
| `npm run dev:all` | **Docker DB + backend + frontend** |
| `npm run build` | Type-check + production build (frontend) |
