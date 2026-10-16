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

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  acquireCiLocalLock,
  acquireCiLocalLocks,
  ciContainerNames,
  lockPath,
  parseCiLocalArgs,
} from './ci-local-guard.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'ci-lock-'))

test('every known flag parses, and --help starts nothing', () => {
  assert.deepEqual(parseCiLocalArgs([]), { help: false, static: false, updateAllowlist: false, down: false })
  assert.deepEqual(parseCiLocalArgs(['--static', '--update-allowlist']), {
    help: false, static: true, updateAllowlist: true, down: false,
  })
  assert.equal(parseCiLocalArgs(['--help']).help, true)
  assert.equal(parseCiLocalArgs(['-h']).help, true)
})

test('an unknown flag is an error, not a run', () => {
  assert.match(parseCiLocalArgs(['--hlep']).error, /--hlep/)
  assert.match(parseCiLocalArgs(['--static', 'static']).error, /static/)
})

// The wire: the script itself must honour the parse BEFORE touching Docker.
// Run with Docker unreachable (an empty PATH: node is spawned by absolute
// path), so a regression here cannot start a real run against shared
// containers — it would fail on 'docker' instead.
test('the script prints usage for --help and refuses an unknown flag, starting nothing', () => {
  const env = { ...process.env, PATH: '', Path: '' }
  const help = spawnSync(process.execPath, ['scripts/ci-local.mjs', '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 20_000, env })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  assert.doesNotMatch(help.stdout + help.stderr, /Postgres :|Docker is not reachable/)

  const unknown = spawnSync(process.execPath, ['scripts/ci-local.mjs', '--nope'], { cwd: ROOT, encoding: 'utf8', timeout: 20_000, env })
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Unknown argument/)
  assert.doesNotMatch(unknown.stdout + unknown.stderr, /Postgres :|Docker is not reachable/)
})

// Review lenses (architect + reviewer): the names were fixed, so "use another
// port" meant the SAME containers — and a second run dropped the first's DB.
test('the containers are named after their ports; the defaults keep the old names', () => {
  assert.deepEqual(ciContainerNames('5462', '6389'), { postgres: 'maplespire-ci-postgres', redis: 'maplespire-ci-redis' })
  assert.deepEqual(ciContainerNames('5463', '6390'), {
    postgres: 'maplespire-ci-postgres-5463',
    redis: 'maplespire-ci-redis-6390',
  })
  assert.notEqual(lockPath(ciContainerNames('5463', '6389').postgres, 'd'), lockPath(ciContainerNames('5462', '6389').postgres, 'd'))
})

test('a second run cannot take the lock while the first is alive', () => {
  const dir = tempDir()
  try {
    const file = lockPath('maplespire-ci-postgres', dir)
    const first = acquireCiLocalLock(file, { pid: 111, cwd: 'worktree-a', isAlive: () => true })
    assert.equal(first.ok, true)
    const second = acquireCiLocalLock(file, { pid: 222, cwd: 'worktree-b', isAlive: () => true })
    assert.equal(second.ok, false)
    assert.equal(second.holder.pid, 111)
    assert.equal(second.holder.cwd, 'worktree-a')
    assert.equal(second.file, file)

    first.release()
    assert.equal(existsSync(file), false)
    assert.equal(acquireCiLocalLock(file, { pid: 222, isAlive: () => true }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Reviewer lens: check-then-write let two runs started together both "win".
// The create is exclusive now: whoever finds the file there does not get it.
test('the create is exclusive: a file already there is never overwritten by a live contender', () => {
  const dir = tempDir()
  try {
    const file = lockPath('maplespire-ci-postgres', dir)
    writeFileSync(file, JSON.stringify({ pid: 111, cwd: 'raced-in-first' }))
    const late = acquireCiLocalLock(file, { pid: 222, isAlive: () => true })
    assert.equal(late.ok, false)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 111, 'the winner was overwritten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock left by a dead run is taken over, and its release cannot remove the new holder', () => {
  const dir = tempDir()
  try {
    const file = lockPath('maplespire-ci-postgres', dir)
    const stale = acquireCiLocalLock(file, { pid: 111, isAlive: () => true })
    const next = acquireCiLocalLock(file, { pid: 222, isAlive: (pid) => pid !== 111 })
    assert.equal(next.ok, true)
    stale.release()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 222)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable lock file does not block forever', () => {
  const dir = tempDir()
  try {
    const file = lockPath('maplespire-ci-postgres', dir)
    writeFileSync(file, 'not json')
    assert.equal(acquireCiLocalLock(file, { pid: 1, isAlive: () => true }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A run with its own Postgres port but the DEFAULT Redis still shares Redis
// (flushed on every run): it must hold that lock too, all or nothing.
test('both locks or none: a run that gets Postgres but not Redis gives Postgres back', () => {
  const dir = tempDir()
  try {
    const pg = lockPath('maplespire-ci-postgres-5463', dir)
    const redis = lockPath('maplespire-ci-redis', dir)
    const other = acquireCiLocalLock(redis, { pid: 111, isAlive: () => true })
    assert.equal(other.ok, true)
    const run = acquireCiLocalLocks([pg, redis], { pid: 222, isAlive: () => true })
    assert.equal(run.ok, false)
    assert.equal(existsSync(pg), false, 'the Postgres lock was kept by a run that could not start')

    other.release()
    const again = acquireCiLocalLocks([pg, redis], { pid: 222, isAlive: () => true })
    assert.equal(again.ok, true)
    again.release()
    assert.equal(existsSync(pg) || existsSync(redis), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// QA lens, review 3: every lock test above injects `isAlive`, so the real
// liveness check — and the script's use of the lock — ran in no test.
test('the default liveness check: a live holder blocks, EPERM counts as alive', (t) => {
  const dir = tempDir()
  try {
    const file = lockPath('maplespire-ci-postgres', dir)
    writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: 'live-run' }))
    assert.equal(acquireCiLocalLock(file, { pid: process.pid + 1 }).ok, false, 'a live holder (this very process) was taken over')

    // Another user's process: it exists, we just may not signal it.
    t.mock.method(process, 'kill', () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    writeFileSync(file, JSON.stringify({ pid: 424242, cwd: 'other-user' }))
    assert.equal(acquireCiLocalLock(file, { pid: process.pid }).ok, false, 'EPERM was read as a dead holder')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock that names this very pid (a reused pid) does not lock this run out', () => {
  const dir = tempDir()
  try {
    const file = lockPath('maplespire-ci-postgres', dir)
    writeFileSync(file, JSON.stringify({ pid: 4242, cwd: 'before-reboot' }))
    assert.equal(acquireCiLocalLock(file, { pid: 4242, isAlive: () => true }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The wire: the script itself must refuse while the lock is held, BEFORE any
// container step. Run for real, but with nothing it could reach: no docker or
// npm on PATH, a private temp dir for the lock, ports nobody uses — so even a
// regression here cannot touch the shared containers.
test('the script refuses to start while another run holds the lock, starting nothing', () => {
  const dir = tempDir()
  try {
    const pgPort = '59977'
    const redisPort = '59978'
    const names = ciContainerNames(pgPort, redisPort)
    writeFileSync(lockPath(names.postgres, dir), JSON.stringify({ pid: process.pid, cwd: 'first-run', startedAt: 'earlier' }))
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(path|temp|tmp|tmpdir)$/i.test(key)))
    Object.assign(env, {
      PATH: path.dirname(process.execPath),
      TEMP: dir, TMP: dir, TMPDIR: dir,
      CI_LOCAL_PG_PORT: pgPort, CI_LOCAL_REDIS_PORT: redisPort,
    })
    const run = spawnSync(process.execPath, ['scripts/ci-local.mjs'], { cwd: ROOT, encoding: 'utf8', env, timeout: 20_000 })
    assert.equal(run.status, 3, run.stdout + run.stderr)
    assert.match(run.stderr, /Another ci-local run holds .*pid \d+, first-run/)
    assert.match(run.stderr, /delete .*ci-local\.lock/, 'the refusal does not say which file to clear')
    assert.doesNotMatch(run.stdout + run.stderr, /Postgres :/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
