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

// Launch the BOOT-FROM-SERVER dev stack used by the `e2e/boot` Playwright suite:
//   embedded Postgres  +  read-model server (READ_MODEL=on AM_SELECTIVE_SYNC=on, :3002)
//   +  vite with VITE_BOOT_FROM_SERVER/MODEL_SHARDING/SERVER_READ_MODEL (:5180).
// Cross-platform (env is passed via spawn, not an inline VAR=val prefix). Ctrl+C stops
// all three.
//
// Optional clean reseed (deterministic e2e/boot baseline):
//   node scripts/dev-boot.mjs --reseed [real|heavy|rich]   (default kind: real)
// Reseeding MUST happen with the server DOWN (boot-from-server re-windows a bulk setState
// before it can flush, so a live server never persists a seed). So the launcher starts the
// db, runs wipe-all + seed-workspace while the server is still down, THEN starts the server
// so its read-model projector cold-builds `ro_*` from the fresh root. Without --reseed the
// existing data is left untouched (a warm restart).
//
// ISOLATION: a second checkout running this stack on the defaults collides with the
// first — same Vite port, same server port, same embedded-Postgres data dir — and a
// `--reseed` then wipes the other stack's database from under it. Set
// BOOT_SERVER_PORT / BOOT_VITE_PORT here and PGPORT / PGDATA_DIR / DATABASE_URL for
// the embedded db and the server (both read them from the environment) to run a
// private stack; point Playwright at it with E2E_BOOT_URL / E2E_BOOT_API.
import { spawn } from 'node:child_process'

const RESEED = process.argv.includes('--reseed')
const SEED_KIND = process.argv.find((a) => /^(real|heavy|rich)$/.test(a)) ?? 'real'
const SERVER_PORT = process.env.BOOT_SERVER_PORT ?? '3002'
const VITE_PORT = process.env.BOOT_VITE_PORT ?? '5180'

const dbProc = { name: 'db', cmd: 'node', args: ['scripts/embedded-db.mjs'], cwd: 'server', env: {} }
const serverProc = {
  name: 'server', cmd: 'npx', args: ['tsx', 'src/index.ts'], cwd: 'server',
  env: {
    PORT: SERVER_PORT, READ_MODEL: 'on', AM_SELECTIVE_SYNC: 'on',
    // Cookies ignore the port: every stack on localhost would share one
    // session cookie, and a login on another worktree's stack logs this one
    // out ("Invalid or expired session"). One cookie per server port.
    AUTH_COOKIE_NAME: process.env.AUTH_COOKIE_NAME || `maplespire_session_${SERVER_PORT}`,
  },
}
const viteProc = {
  name: 'vite', cmd: 'npx', args: ['vite', '--port', VITE_PORT, '--strictPort'], cwd: '.',
  env: {
    VITE_SYNC_API_URL: `http://localhost:${SERVER_PORT}`,
    VITE_AUTOMERGE_URL: `ws://localhost:${SERVER_PORT}/automerge`,
    VITE_BOOT_FROM_SERVER: 'true',
    VITE_MODEL_SHARDING: 'true',
    VITE_SERVER_READ_MODEL: 'true',
  },
}

const children = []
function start(p) {
  const child = spawn(p.cmd, p.args, {
    cwd: p.cwd,
    env: { ...process.env, ...p.env },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tag = `[${p.name}] `
  child.stdout.on('data', (d) => process.stdout.write(tag + d))
  child.stderr.on('data', (d) => process.stderr.write(tag + d))
  child.on('exit', (code) => process.stderr.write(`${tag}exited (${code})\n`))
  children.push(child)
  return child
}

/** Run a one-shot command to completion, streaming its output under a tag. Resolves the exit code. */
function once(cmd, args, cwd, tag) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, env: process.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    c.stdout.on('data', (d) => process.stdout.write(tag + d))
    c.stderr.on('data', (d) => process.stderr.write(tag + d))
    c.on('exit', (code) => resolve(code ?? 1))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wipe + seed while the server is DOWN. wipe-all connects to the embedded db, so it doubles as
 * a db-readiness probe — retry it until the db accepts a connection, then seed once. */
async function reseed() {
  process.stdout.write(`[reseed] clean reseed requested (kind=${SEED_KIND}) — waiting for the db…\n`)
  for (let i = 0; i < 40; i++) {
    if ((await once('node', ['scripts/wipe-all.mjs'], 'server', '[reseed] ')) === 0) {
      await once('npx', ['tsx', 'scripts/seed-workspace.ts', SEED_KIND], 'server', '[reseed] ')
      process.stdout.write('[reseed] done — starting the server so the projector cold-builds ro_*\n')
      return
    }
    await sleep(1000)
  }
  process.stderr.write('[reseed] db never became ready after 40s — starting WITHOUT a reseed\n')
}

function shutdown() {
  for (const c of children) { try { c.kill() } catch { /* ignore */ } }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// db first (so a reseed has something to talk to); reseed while the server is down; then the rest.
start(dbProc)
if (RESEED) await reseed()
start(serverProc)
start(viteProc)
