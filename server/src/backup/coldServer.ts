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

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * A server process, booted cold against the restored database.
 *
 * "Cold" is the whole point and constrains how this is written:
 *
 *  - **A separate process**, not an in-process import. The drill runner has
 *    already opened pools, warmed module state and (in the integration test) run
 *    a repo. Reusing any of that would let a restore pass on state the restore
 *    did not provide.
 *  - **Its own port**, taken from the OS rather than a constant, so a drill can
 *    run beside a dev stack without colliding with it on a hard-coded 3001.
 *  - **Its own asset volume**, supplied by the caller — the one the restore just
 *    materialized. A cold server pointed at the live volume would report the
 *    live volume's icons and prove nothing about the archive.
 *
 * Deliberately booted WITHOUT `AUTH=on`. The restored database's sessions belong
 * to a different deployment and no operator credential exists for a throwaway
 * process, so requiring auth here would test the drill runner's ability to mint
 * a token, not the restore. What the cold check answers is "can a server read
 * this data" — the access-control path has its own suites.
 */

export type ColdServerHandle = {
  baseUrl: string
  port: number
  /** Which entrypoint was booted — a drill that silently ran a stale `dist/`
   * would be evidence about the wrong build. */
  entrypoint: string
  stop: () => Promise<void>
  /** Tail of the child's stdio, for a failure report that says why. */
  output: () => string
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    // Port 0 asks the OS. Racy in principle — another process could take the
    // port between close and boot — but the alternative is a fixed port, which
    // collides with a dev stack deterministically rather than rarely.
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolvePort(port) : reject(new Error('could not reserve a port'))))
    })
  })
}

/**
 * Sources first, `dist/` second — the opposite of what a deploy does, and
 * deliberately.
 *
 * A source checkout carries a `dist/` from whenever someone last ran the build,
 * and booting that would verify a restore against code that is not the code
 * under test. Every environment that HAS `src` + tsx is a development or CI one
 * where the sources are the truth; a real deployment ships `dist/` without them
 * and takes the second branch.
 */
export function serverEntrypoint(serverRoot: string): { command: string; args: string[]; kind: string } {
  const source = join(serverRoot, 'src', 'index.ts')
  // No shell, no `npx`: on Windows both re-split arguments on the spaces this
  // repository's own path contains ("My projects"), which has already broken one
  // runner in this codebase. Invoke tsx's ESM entrypoint through node directly.
  const tsx = join(serverRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (existsSync(source) && existsSync(tsx)) {
    return { command: process.execPath, args: [tsx, source], kind: 'src/index.ts (tsx)' }
  }
  const built = join(serverRoot, 'dist', 'index.js')
  if (existsSync(built)) return { command: process.execPath, args: [built], kind: 'dist/index.js' }
  throw new Error('Neither src/index.ts with tsx nor dist/index.js is present; cannot boot a cold server')
}

export async function startColdServer(options: {
  databaseUrl: string
  serverRoot: string
  assetDirectory: string
  /** Extra environment, e.g. READ_MODEL. Applied over the sanitized base. */
  env?: NodeJS.ProcessEnv
  bootTimeoutMs?: number
}): Promise<ColdServerHandle> {
  const serverRoot = resolve(options.serverRoot)
  const port = await freePort()
  const { command, args, kind } = serverEntrypoint(serverRoot)
  let output = ''
  const record = (chunk: string) => { output = `${output}${chunk}`.slice(-32_768) }

  const child: ChildProcess = spawn(command, args, {
    cwd: serverRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Every variable that could point the cold process back at the live
      // deployment is overridden, not inherited. A cold server that silently
      // reconnected to production Redis or the live asset volume would report
      // production's health and call it the restore's.
      NODE_ENV: 'development',
      PORT: String(port),
      // Loopback ONLY, and this is not optional. This process runs AUTH=off
      // against a full restore of production data — every workspace, org and
      // model, plus an unauthenticated Automerge sync socket — for the length of
      // the drill. Binding every interface would publish all of it to whatever
      // can reach the host, and the documented host invocation of the drill has
      // no container network to contain it. `runColdApiChecks` already dials
      // 127.0.0.1, so nothing else has to change.
      BIND_ADDRESS: '127.0.0.1',
      DATABASE_URL: options.databaseUrl,
      TECHNOLOGY_ASSET_DIR: options.assetDirectory,
      AUTH: 'off',
      AUTH_DEV_LOGIN: 'off',
      ORG_SEED: 'off',
      // Empty, and REQUIRED explicitly off: the runtime treats an absent URL as
      // "no distributed runtime", which is right for a throwaway process, but
      // only if it is also told not to insist on one.
      REDIS_URL: '',
      REDIS_REQUIRED: 'off',
      REDIS_RENDER_CACHE_URL: '',
      SYNC_CELL_OWNERSHIP: 'off',
      READ_MODEL: 'on',
      METRICS_TOKEN: '',
      ...options.env,
    },
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', record)
  child.stderr?.on('data', record)

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.on('exit', (code, signal) => { exited = { code, signal } })

  const stop = async (): Promise<void> => {
    if (exited || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolveStop()
      }, 10_000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolveStop()
      })
    })
  }

  const deadline = Date.now() + (options.bootTimeoutMs ?? 120_000)
  const baseUrl = `http://127.0.0.1:${port}`
  while (Date.now() < deadline) {
    if (exited) {
      const detail = exited as { code: number | null; signal: NodeJS.Signals | null }
      throw new Error(
        `Cold server exited before it listened (code ${detail.code ?? 'null'}, signal ${detail.signal ?? 'null'}):\n${output.slice(-4_000)}`,
      )
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) })
      if (response.status === 200) return { baseUrl, port, entrypoint: kind, stop, output: () => output }
    } catch { /* not listening yet */ }
    await new Promise((wait) => setTimeout(wait, 500))
  }
  await stop()
  throw new Error(`Cold server never answered /api/health within the boot timeout:\n${output.slice(-4_000)}`)
}
