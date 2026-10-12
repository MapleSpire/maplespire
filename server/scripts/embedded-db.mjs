// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

// Run a real Postgres as a native child process — no Docker required.
//
// Uses `embedded-postgres`, which ships prebuilt Postgres binaries and manages
// the cluster lifecycle. The cluster is persisted in a local app-data dir (NOT
// under the OneDrive-synced project tree) so installs survive restarts without
// a cloud-sync process locking the data files. This is a drop-in replacement
// for `docker compose up postgres` when Docker Desktop is unstable.
//
//   npm run db:embedded            # from server/ (or `npm run db:embedded` at root)
//
// Defaults match the server's DATABASE_URL fallback
// (postgres://maplespire:maplespire@localhost:5432/maplespire), so no env wiring is
// needed. Override with PGPORT / PGUSER / PGPASSWORD / PGDATABASE / PGDATA_DIR.
import 'dotenv/config' // load server/.env so PGPORT/PGDATA_DIR/etc can isolate this worktree
import EmbeddedPostgres from 'embedded-postgres'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

// Keep the cluster OUT of cloud-synced folders (OneDrive/Dropbox/etc.) — a live
// Postgres data dir being synced or locked mid-write causes file errors and can
// corrupt the cluster. Default to a local app-data path; override with PGDATA_DIR.
const defaultDataDir =
  process.platform === 'win32'
    ? resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData', 'Local'), 'maplespire-dag', 'pgdata')
    : resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local', 'share'), 'maplespire-dag', 'pgdata')
const dataDir = process.env.PGDATA_DIR ?? defaultDataDir
const port = Number(process.env.PGPORT ?? 5432)
const user = process.env.PGUSER ?? 'maplespire'
const password = process.env.PGPASSWORD ?? 'maplespire'
const database = process.env.PGDATABASE ?? 'maplespire'

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  port,
  user,
  password,
  authMethod: 'password',
  persistent: true,
  // Windows mitigation: Postgres re-maps shared memory into each forked backend
  // at a fixed address; ASLR / injected DLLs (antivirus, etc.) occasionally sit
  // there, giving "could not reserve shared memory region" (error 487) and the
  // odd ECONNRESET. A smaller shared-memory footprint makes that collision rare,
  // so keep shared_buffers SMALL. max_connections bumped 20→100: the dev-server
  // pool + parallel server test suites + read-model projector exhausted 20 and
  // wedged the cluster. Override either via PGSHAREDBUF / PGMAXCONN.
  postgresFlags: [
    '-c', `shared_buffers=${process.env.PGSHAREDBUF ?? '32MB'}`,
    '-c', `max_connections=${process.env.PGMAXCONN ?? '100'}`,
  ],
  // initdb inherits the OS locale, so on a French/Windows machine a fresh
  // cluster is created as WIN1252 and the server then dies on boot with
  // `character with byte sequence 0xc4 0x8c ... has no equivalent in encoding
  // "WIN1252"` — the managed technology catalog contains names like "Čatalog".
  // The application data is UTF-8 everywhere else, so pin the cluster to UTF8
  // with a locale-independent collation. Only affects NEW clusters; existing
  // data dirs keep whatever they were initialised with.
  initdbFlags: [
    '--encoding=UTF8',
    '--locale=C',
  ],
  onLog: (msg) => process.stdout.write(`[pg] ${msg}`),
  onError: (msg) => process.stderr.write(`[pg] ${msg}`),
})

// initdb only needs to run for a brand-new cluster (PG_VERSION marks an
// initialised data dir). Subsequent runs just start the existing cluster.
const freshCluster = !existsSync(resolve(dataDir, 'PG_VERSION'))
if (freshCluster) {
  mkdirSync(dirname(dataDir), { recursive: true })
  console.log(`[embedded-pg] initialising new cluster in ${dataDir} …`)
  await pg.initialise()
}

await pg.start()
console.log(`[embedded-pg] cluster started on port ${port}`)

// Ensure the application database exists. createDatabase() throws if it's
// already there, which is the expected case on a warm cluster.
try {
  await pg.createDatabase(database)
  console.log(`[embedded-pg] created database "${database}"`)
} catch {
  // already exists — fine
}

console.log(`[embedded-pg] ready → postgres://${user}:***@localhost:${port}/${database}`)
console.log('[embedded-pg] leave this running; press Ctrl+C to stop')

let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  console.log('\n[embedded-pg] stopping …')
  try {
    await pg.stop()
  } catch (e) {
    console.error('[embedded-pg] stop error:', e)
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
