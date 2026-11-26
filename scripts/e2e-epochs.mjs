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

/**
 * The G4-16f EPOCH end-to-end harness: a stack of its own with
 * `AM_MODEL_EPOCHS=on`, then `playwright test -c playwright.epochs.config.ts`,
 * then teardown. The shape is `scripts/compat-n-1.mjs`'s:
 *
 *  1. a FRESH Postgres container `ui-epochs-pg-<port>` (removed after);
 *  2. a SHARDED workspace (an epoch needs a ModelMeta; the boot demo is a
 *     monolith): one server boot for the schema, then `dev-boot.mjs
 *     --reseed`'s wipe + `seed-workspace.ts real` with the server DOWN;
 *  3. this checkout's sync server (`tsx src/index.ts`, AUTH off, the read
 *     model on, epochs ON with a 1-day period — so the FIRST roll is due on
 *     every pass, `firstRollSlot(key, 1) === 0` — and the compaction the roll
 *     rides on, forced per test through `POST /api/model/compact`);
 *  4. this checkout's client BUILT (NODE_ENV=development: the dev probes
 *     the specs read are kept) and served by `vite preview` — no HMR, no
 *     watcher, so no page reload a spec did not ask for (resident build: the
 *     Phase-4 boot flags off);
 *  5. the specs. A roll after the first is made due by back-dating the
 *     published epoch's `published_at` straight in SQL (`docker exec psql`,
 *     `e2e/support/epochStack.ts`): a TEST-ONLY helper on the test's own
 *     database, never a route.
 *
 * Ports (overridable, none shared with a dev stack): Postgres 55746, server
 * 3746, Vite 5746.
 *
 * Usage:
 *   node scripts/e2e-epochs.mjs [--stack-only] [-- <playwright args>]
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORTS = {
  pg: process.env.EPOCHS_PG_PORT ?? '55746',
  server: process.env.EPOCHS_SERVER_PORT ?? '3746',
  vite: process.env.EPOCHS_VITE_PORT ?? '5746',
}
const PG_CONTAINER = `ui-epochs-pg-${PORTS.pg}`
/** `--auth`: the dev-login identity made platform admin (the compaction route). */
const E2E_EPOCHS_ADMIN_EMAIL = 'marie@epochs.e2e.test'
const DATABASE_URL = `postgres://maplespire:maplespire@localhost:${PORTS.pg}/maplespire`

const children = new Set()
const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' })

function startChild(name, command, args, { cwd, env, logDir }) {
  const log = createWriteStream(path.join(logDir, `${name}.log`))
  // Its own process group, so teardown reaches tsx's and vite's children too.
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.on('exit', (code, signal) => log.write(`\n[${name}] exited code=${code} signal=${signal}\n`))
  children.add(child)
  return child
}

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

async function waitFor(label, probe, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`${label}: the process exited (${child.exitCode}) before it was ready`)
    if (await probe().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} not ready after ${timeoutMs / 1000} s`)
}

const httpOk = (url) => async () => (await fetch(url)).ok

function teardown() {
  stopChildren()
  docker(['rm', '-f', '-v', PG_CONTAINER])
}

async function main() {
  const argv = process.argv.slice(2)
  const stackOnly = argv.includes('--stack-only')
  const dash = argv.indexOf('--')
  const playwrightArgs = dash >= 0 ? argv.slice(dash + 1) : []
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const logDir = path.join(ROOT, 'reports', 'e2e-epochs', runId)
  mkdirSync(logDir, { recursive: true })
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => { teardown(); process.exit(code) })
  }
  try {
    if (docker(['version', '--format', '{{.Server.Version}}']).status !== 0) throw new Error('Docker is not reachable')
    // Named after its port and created by this script only: a leftover is a
    // crashed run of this harness, never someone else's container.
    docker(['rm', '-f', '-v', PG_CONTAINER])
    const created = docker(['run', '-d', '--name', PG_CONTAINER,
      '-e', 'POSTGRES_USER=maplespire', '-e', 'POSTGRES_PASSWORD=maplespire', '-e', 'POSTGRES_DB=maplespire',
      '-p', `127.0.0.1:${PORTS.pg}:5432`,
      '--health-cmd', 'pg_isready -U maplespire -d maplespire',
      '--health-interval', '2s', '--health-timeout', '5s', '--health-retries', '30',
      'postgres:16-alpine'])
    if (created.status !== 0) throw new Error(`docker run failed: ${created.stderr}`)
    await waitFor('postgres', async () =>
      docker(['inspect', '--format', '{{.State.Health.Status}}', PG_CONTAINER]).stdout.trim() === 'healthy', 90_000)

    const tsx = path.join(ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs')
    // `--auth`: AUTH=on with the dev login, so ids are MINTED and a random-id
    // document is admitted only through a pointer — the production shape of
    // `epoch-reload-offline-overflow.spec.ts`. The secret is this
    // run's own, never printed.
    const auth = (dash >= 0 ? argv.slice(0, dash) : argv).includes('--auth')
      ? { AUTH: 'on', AUTH_DEV_LOGIN: 'on', AUTH_SECRET: randomBytes(32).toString('hex'), PLATFORM_ADMIN_BOOTSTRAP_EMAIL: E2E_EPOCHS_ADMIN_EMAIL }
      : { AUTH: 'off' }
    const serverEnv = {
      PORT: PORTS.server,
      DATABASE_URL,
      NODE_ENV: 'development',
      APP_URL: `http://localhost:${PORTS.vite}`,
      ...auth,
      AUTH_COOKIE_NAME: `maplespire_session_${PORTS.server}`,
      READ_MODEL: 'on',
      AM_SELECTIVE_SYNC: 'on',
      // `E2E_EPOCHS_FLAG=off`: the same stack with epochs OFF, to measure a
      // spec that does not depend on them
      // (`epoch-zy-other-client-overflow.spec.ts`).
      AM_MODEL_EPOCHS: process.env.E2E_EPOCHS_FLAG === 'off' ? 'off' : 'on',
      AM_MODEL_EPOCH_PERIOD_DAYS: '1',
      // The event-driven forward's timeline (trigger passes, route waits), one
      // file per run: a later run never overwrites it.
      MODEL_EPOCH_TRACE_FILE: path.join(logDir, 'epoch-trace.jsonl'),
      // A spec may ask ONE compaction to hold the pool-heavy slot
      // longer (`compact({ holdMs, afterMs })`). Inert without that request:
      // every other spec compacts exactly as before.
      MODEL_EPOCH_E2E_COMPACTION_HOLD: 'on',
    }
    const schema = startChild('server-schema', process.execPath, [tsx, 'src/index.ts'], { cwd: path.join(ROOT, 'server'), logDir, env: serverEnv })
    await waitFor('server (schema)', httpOk(`http://localhost:${PORTS.server}/api/health`), 180_000, schema)
    try { process.kill(-schema.pid, 'SIGTERM') } catch { /* gone */ }
    await waitFor('server (schema) stop', async () => schema.exitCode !== null || schema.signalCode !== null, 30_000)
    for (const args of [['scripts/wipe-all.mjs'], [tsx, 'scripts/seed-workspace.ts', 'real']]) {
      const run = spawnSync(process.execPath, args, { cwd: path.join(ROOT, 'server'), env: { ...process.env, DATABASE_URL }, encoding: 'utf8' })
      if (run.status !== 0) throw new Error(`${args.join(' ')} failed: ${run.stderr || run.stdout}`)
    }
    const server = startChild('server', process.execPath, [tsx, 'src/index.ts'], { cwd: path.join(ROOT, 'server'), logDir, env: serverEnv })
    // A BUILD, served by `vite preview`: the dev server reloaded the page on
    // its own — `full-reload` on every edit of the worktree it serves, and
    // after a WebSocket reconnect — and those reloads carried earlier "green"
    // runs. A preview has no HMR client
    // and watches nothing. Built with NODE_ENV=development so the DEV probes
    // the specs read (`window.__epochHop`, `__modelStore`, …) are kept, into
    // this run's own directory (another run's build is never served).
    const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
    const clientEnv = {
      VITE_SYNC_API_URL: `http://localhost:${PORTS.server}`,
      VITE_AUTOMERGE_URL: `ws://localhost:${PORTS.server}/automerge`,
      VITE_DEV_PORT: PORTS.vite,
      VITE_BOOT_FROM_SERVER: 'false',
      VITE_MODEL_SHARDING: 'true',
      VITE_SERVER_READ_MODEL: 'false',
    }
    const outDir = path.join(logDir, 'client-build')
    const build = spawnSync(process.execPath, [viteBin, 'build', '--mode', 'development', '--outDir', outDir, '--emptyOutDir'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...clientEnv, NODE_ENV: 'development' },
    })
    writeFileSync(path.join(logDir, 'vite-build.log'), `${build.stdout}\n${build.stderr}`)
    if (build.status !== 0) throw new Error(`vite build failed (see ${path.relative(ROOT, logDir)}/vite-build.log)`)
    const vite = startChild('vite', process.execPath, [viteBin, 'preview', '--outDir', outDir, '--port', PORTS.vite, '--strictPort'], {
      cwd: ROOT,
      logDir,
      env: { ...clientEnv, NODE_ENV: 'development' },
    })
    await waitFor('server', httpOk(`http://localhost:${PORTS.server}/api/health`), 180_000, server)
    await waitFor('vite', httpOk(`http://localhost:${PORTS.vite}/`), 120_000, vite)
    console.log(`[e2e-epochs] stack up; logs in ${path.relative(ROOT, logDir)}/`)

    const env = {
      E2E_EPOCHS_BASE_URL: `http://localhost:${PORTS.vite}`,
      E2E_EPOCHS_SERVER: `http://localhost:${PORTS.server}`,
      E2E_EPOCHS_PG_CONTAINER: PG_CONTAINER,
      // Where a spec writes its own diagnostics (the hop's timeline).
      E2E_EPOCHS_LOG_DIR: logDir,
      E2E_EPOCHS_AUTH: auth.AUTH,
      E2E_EPOCHS_ADMIN_EMAIL,
    }
    if (stackOnly) {
      for (const [key, value] of Object.entries(env)) console.log(`  ${key}=${value}`)
      console.log('[e2e-epochs] --stack-only: Ctrl+C to tear down.')
      await new Promise(() => {})
    }
    const playwright = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test', '-c', 'playwright.epochs.config.ts', ...playwrightArgs], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
    const status = playwright.status ?? 1
    // Playwright empties test-results/ at its next start: keep this run's
    // traces and error contexts with its logs.
    const results = path.join(ROOT, 'test-results')
    if (existsSync(results)) cpSync(results, path.join(logDir, 'test-results'), { recursive: true })
    console.log(`[e2e-epochs] ${status === 0 ? 'GREEN' : 'RED'}`)
    return status
  } finally {
    teardown()
  }
}

main().then((status) => process.exit(status), (error) => {
  console.error(`[e2e-epochs] ${error instanceof Error ? error.message : String(error)}`)
  teardown()
  process.exit(1)
})
