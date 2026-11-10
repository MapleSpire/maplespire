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
 * Run the N-1 <-> N compatibility harness (V0-09) end to end, on a stack of
 * its own, and take it down again.
 *
 *  1. `.n-minus-1/` <- `scripts/build-n-minus-1.mjs --ref <ref>` (kept when it
 *     already names that commit);
 *  2. a FRESH Postgres container `maplespire-compat-pg-<port>` (removed after);
 *  3. this checkout's sync server (`tsx src/index.ts`, AUTH off, demo seed);
 *  4. this checkout's client as a Vite DEV server — the N client;
 *  5. `playwright test -c playwright.compat.config.ts`, whose spec serves the
 *     N-1 bundle and proxies the N dev server through same-origin front doors
 *     (`e2e/support/compatDoor.ts`).
 *
 * Ports (all overridable, none shared with a dev stack): Postgres 55439,
 * server 3240, N-1 origin 5240, N origin 5241, Vite (internal) 5249.
 *
 * Usage:
 *   node scripts/compat-n-1.mjs [--ref <rev>] [--force-build] [--stack-only]
 *   node scripts/compat-n-1.mjs --help
 *
 * `--ref` is passed to the build (`v0-08` by default, `pre-v0-08` is the RED
 * control). `--stack-only` starts the stack and waits for Ctrl+C instead of
 * running the spec. The exit code is Playwright's.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OUT, STAMP, buildNMinus1, parseBuildArgs } from './build-n-minus-1.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORTS = {
  pg: process.env.COMPAT_PG_PORT ?? '55439',
  server: process.env.COMPAT_SERVER_PORT ?? '3240',
  n1: process.env.COMPAT_N1_PORT ?? '5240',
  n: process.env.COMPAT_N_PORT ?? '5241',
  vite: process.env.COMPAT_VITE_PORT ?? '5249',
}
const PG_CONTAINER = `maplespire-compat-pg-${PORTS.pg}`
const DATABASE_URL = `postgres://maplespire:maplespire@localhost:${PORTS.pg}/maplespire`

export const USAGE = `Usage:
  node scripts/compat-n-1.mjs [--ref <rev>] [--force-build] [--stack-only]

  --ref <rev>      N-1 build: v0-08 (default), pre-v0-08 (RED control), or any rev
  --force-build    rebuild .n-minus-1/ even if it already names that commit
  --stack-only     start the stack and wait for Ctrl+C; run no spec`

export function parseCompatArgs(argv) {
  const parsed = { ref: 'v0-08', forceBuild: false, stackOnly: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--force-build') parsed.forceBuild = true
    else if (arg === '--stack-only') parsed.stackOnly = true
    else if (arg === '--ref') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) return { error: '--ref needs a value' }
      parsed.ref = value
      i += 1
    } else return { error: `Unknown argument: ${arg}` }
  }
  return parsed
}

const children = new Set()

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' })
}

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
  const args = parseCompatArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(`${args.error}\n\n${USAGE}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }
  const started = Date.now()
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const logDir = path.join(ROOT, 'reports', 'compat', runId)
  mkdirSync(logDir, { recursive: true })

  const build = parseBuildArgs(['--ref', args.ref, ...(args.forceBuild ? ['--force'] : [])])
  if ('error' in build) throw new Error(build.error)
  const buildStarted = Date.now()
  buildNMinus1(build)
  const buildMs = Date.now() - buildStarted
  const stamp = JSON.parse(readFileSync(path.join(DEFAULT_OUT, STAMP), 'utf8'))

  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      teardown()
      process.exit(code)
    })
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

    const stackStarted = Date.now()
    const server = startChild('server', process.execPath, [path.join(ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], {
      cwd: path.join(ROOT, 'server'),
      logDir,
      env: {
        PORT: PORTS.server,
        DATABASE_URL,
        NODE_ENV: 'development',
        APP_URL: `http://localhost:${PORTS.n}`,
        AUTH: 'off',
        AUTH_COOKIE_NAME: `maplespire_session_${PORTS.server}`,
      },
    })
    const vite = startChild('vite', process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', PORTS.vite, '--strictPort'], {
      cwd: ROOT,
      logDir,
      // Same-origin: the front door routes /api and /automerge to the server.
      env: { VITE_SYNC_API_URL: '', VITE_AUTOMERGE_URL: '', VITE_DEV_PORT: PORTS.vite },
    })
    await waitFor('server', httpOk(`http://localhost:${PORTS.server}/api/health`), 180_000, server)
    await waitFor('vite', httpOk(`http://localhost:${PORTS.vite}/`), 120_000, vite)
    const stackMs = Date.now() - stackStarted
    console.log(`[compat] stack up in ${Math.round(stackMs / 1000)} s; N-1 = ${stamp.sha.slice(0, 10)} (${stamp.subject}); logs in ${path.relative(ROOT, logDir)}/`)

    const env = {
      COMPAT_BACKEND: `http://localhost:${PORTS.server}`,
      COMPAT_N_DEV: `http://localhost:${PORTS.vite}`,
      COMPAT_N1_DIR: DEFAULT_OUT,
      COMPAT_N1_PORT: PORTS.n1,
      COMPAT_N_PORT: PORTS.n,
    }
    if (args.stackOnly) {
      console.log('[compat] --stack-only: env for the spec:')
      for (const [key, value] of Object.entries(env)) console.log(`  ${key}=${value}`)
      console.log('[compat] Ctrl+C to tear down.')
      await new Promise(() => {})
    }

    const specStarted = Date.now()
    const playwright = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test', '-c', 'playwright.compat.config.ts'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
    const specMs = Date.now() - specStarted
    const status = playwright.status ?? 1
    console.log(`\n[compat] N-1 ${stamp.sha.slice(0, 10)} (${stamp.ref}) <-> N ${spawnSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()}: ${status === 0 ? 'GREEN' : 'RED'}`)
    console.log(`[compat] cost: build ${Math.round(buildMs / 1000)} s, stack ${Math.round(stackMs / 1000)} s, spec ${Math.round(specMs / 1000)} s, total ${Math.round((Date.now() - started) / 1000)} s`)
    return status
  } finally {
    teardown()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((status) => process.exit(status), (error) => {
    console.error(`[compat] ${error instanceof Error ? error.message : String(error)}`)
    teardown()
    process.exit(1)
  })
}
