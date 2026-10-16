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
 * The two ways `ci-local.mjs` destroyed someone else's run, both on 2026-10-15:
 *
 *  - `--help` was not a flag it knew, so it was ignored and a REAL run started,
 *    whose first step drops the CI database (`DROP DATABASE … WITH (FORCE)`).
 *  - Its containers are machine-wide (one Postgres, one Redis), so a second run
 *    started from any worktree dropped the database under a first one
 *    mid-suite. Measured twice in one evening, by two different sessions.
 *
 * So: every flag is checked, each run owns containers named after its ports,
 * and it holds a lock on each container it will touch.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const USAGE = `Usage:
  node scripts/ci-local.mjs              services up, full test job, skip check
  node scripts/ci-local.mjs --static     also lint/build (the other CI job)
  node scripts/ci-local.mjs --update-allowlist
  node scripts/ci-local.mjs --down       remove the containers and exit
  node scripts/ci-local.mjs --help       this text; starts nothing

The containers are shared by every worktree on this machine and each run
recreates the CI database and flushes Redis, so only one run at a time may use
a pair: a second one refuses to start. For a separate pair, set BOTH
CI_LOCAL_PG_PORT and CI_LOCAL_REDIS_PORT — the containers are named after
their ports.`

const KNOWN = new Set(['--static', '--update-allowlist', '--down', '--help', '-h'])

/** @returns {{ help: boolean, static: boolean, updateAllowlist: boolean, down: boolean } | { error: string }} */
export function parseCiLocalArgs(argv) {
  const unknown = argv.filter((arg) => !KNOWN.has(arg))
  if (unknown.length) return { error: `Unknown argument(s): ${unknown.join(' ')}` }
  const has = (flag) => argv.includes(flag)
  return {
    help: has('--help') || has('-h'),
    static: has('--static'),
    updateAllowlist: has('--update-allowlist'),
    down: has('--down'),
  }
}

export const DEFAULT_PG_PORT = '5462'
export const DEFAULT_REDIS_PORT = '6389'

/**
 * The containers a run on these ports uses. Named after the port, so another
 * port is another container — the default ports keep the historical names, so
 * the containers already on a machine are reused. (Before, the names were fixed
 * and another port meant the SAME containers: the advice to use one wiped a
 * running suite's database.)
 */
export function ciContainerNames(pgPort, redisPort) {
  return {
    postgres: pgPort === DEFAULT_PG_PORT ? 'maplespire-ci-postgres' : `maplespire-ci-postgres-${pgPort}`,
    redis: redisPort === DEFAULT_REDIS_PORT ? 'maplespire-ci-redis' : `maplespire-ci-redis-${redisPort}`,
  }
}

/** Where the lock for one container lives (one per machine and user). */
export function lockPath(containerName, dir = os.tmpdir()) {
  return path.join(dir, `${containerName}.ci-local.lock`)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, we just may not signal it.
    return error?.code === 'EPERM'
  }
}

function readHolder(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Take one lock, or say who holds it. The create is EXCLUSIVE (`wx`), so of two
 * runs starting together exactly one gets it. A lock left by a process that no
 * longer exists (a killed run) — or one nobody can read — is removed and the
 * create retried once; the loser of that retry is told who won.
 *
 * @returns {{ ok: true, release: () => void } | { ok: false, file: string, holder: { pid?: number, cwd?: string, startedAt?: string } }}
 */
export function acquireCiLocalLock(file, { pid = process.pid, cwd = process.cwd(), isAlive = alive } = {}) {
  const body = JSON.stringify({ pid, cwd, startedAt: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, body, { flag: 'wx' })
      return {
        ok: true,
        release: () => {
          if (readHolder(file)?.pid === pid) rmSync(file, { force: true })
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const holder = readHolder(file)
    const live = holder && Number.isInteger(holder.pid) && holder.pid !== pid && isAlive(holder.pid)
    if (live || attempt === 1) return { ok: false, file, holder: holder ?? {} }
    rmSync(file, { force: true })
  }
  return { ok: false, file, holder: readHolder(file) ?? {} }
}

/** Every lock, or none: a run that gets the first and not the second gives
 *  the first back. */
export function acquireCiLocalLocks(files, options) {
  const held = []
  for (const file of files) {
    const lock = acquireCiLocalLock(file, options)
    if (!lock.ok) {
      for (const taken of held) taken.release()
      return lock
    }
    held.push(lock)
  }
  return { ok: true, release: () => { for (const taken of held) taken.release() } }
}
