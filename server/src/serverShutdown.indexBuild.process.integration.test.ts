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
 * T-DIAGDEF — ONE SIGTERM to the REAL server while its
 * BACKGROUND build of the static write-head index is in progress.
 *
 * The build is a `CREATE INDEX CONCURRENTLY` on a primary-pool connection; it
 * waits for every older snapshot, here an open REPEATABLE READ transaction, for
 * up to 80 % of `deadlock_timeout` (set to 60 s on this database, so ~48 s).
 * Before the fix `pool.end()` waited for that checked-out connection: the
 * shutdown ran to the 30 s forced exit, code 1, and left an INVALID index.
 *
 * Two boots of the same fresh database: the first creates the schema (and,
 * the membership table being empty, the index, plainly); between them a row
 * makes the table non-empty and the index is dropped, so the second boot's
 * background build has a real `CREATE INDEX CONCURRENTLY` to run.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CONNECTION = process.env.TEST_DATABASE_URL
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const HEAD_INDEX = 'idx_read_model_static_membership_deltas_head_entity'

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

interface Booted { child: ChildProcess; exited: Promise<[number | null, string | null]>; output: () => string }

async function boot(databaseUrl: string): Promise<Booted> {
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      BIND_ADDRESS: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      AUTH: 'off',
      READ_MODEL: 'on',
      NODE_ENV: 'development',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let out = ''
  child.stdout!.on('data', (chunk) => { out += String(chunk) })
  child.stderr!.on('data', (chunk) => { out += String(chunk) })
  const exited = once(child, 'exit') as Promise<[number | null, string | null]>
  const readyBy = Date.now() + 120_000
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/ready`).then((r) => r.ok).catch(() => false)
    if (ok) break
    if (Date.now() > readyBy || child.exitCode !== null) throw new Error(`server never ready:\n${out.slice(-4000)}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { child, exited, output: () => out }
}

describe.skipIf(!CONNECTION)('T-DIAGDEF — SIGTERM during the background index build (real server process)', () => {
  const database = `diagdef_indexbuild_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let holder: pg.Client | null = null
  let running: ChildProcess | null = null

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: CONNECTION })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
    // The build's CREATE waits 80 % of it (`ensureStaticMembershipHeadIndex`).
    await admin.query(`ALTER DATABASE "${database}" SET deadlock_timeout = '60s'`)
  })
  afterAll(async () => {
    if (running && running.exitCode === null) running.kill('SIGKILL')
    await holder?.query('ROLLBACK').catch(() => undefined)
    await holder?.end().catch(() => undefined)
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin?.end()
  })

  it('cancels the build and exits complete, code 0, in a few seconds', async () => {
    const url = new URL(CONNECTION!)
    url.pathname = `/${database}`
    const databaseUrl = url.toString()

    // Boot 1: the schema.
    const first = await boot(databaseUrl)
    running = first.child
    first.child.kill('SIGTERM')
    expect((await first.exited)[0], first.output().slice(-4000)).toBe(0)

    // Between the boots: a non-empty membership table, no head index.
    const db = new pg.Client({ connectionString: databaseUrl })
    await db.connect()
    try {
      await db.query(
        `INSERT INTO read_model_static_membership_deltas (landscape_id, version_id, membership_kind, owner_id, entity_id, generation)
         VALUES ('ls-index-build', 'head', 'diagram_object', 'dg-1', 'obj-1', 1)`,
      )
      await db.query(`DROP INDEX IF EXISTS ${HEAD_INDEX}`)
    } finally {
      await db.end()
    }
    // An old snapshot the CONCURRENT build must wait for — and no lock: the
    // boot's schema DDL on the membership table must not wait for it.
    holder = new pg.Client({ connectionString: databaseUrl })
    await holder.connect()
    await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    await holder.query('SELECT 1')

    // Boot 2: its background build starts once ready, and waits.
    const second = await boot(databaseUrl)
    running = second.child
    const buildRunning = async () => (await admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = $1 AND state = 'active' AND query ILIKE 'CREATE INDEX CONCURRENTLY%' AND query LIKE '%' || $2 || '%'`,
      [database, HEAD_INDEX],
    )).rows
    const waitingBy = Date.now() + 30_000
    let builds = await buildRunning()
    while (!builds.length) {
      if (Date.now() > waitingBy) throw new Error(`the background build never started:\n${second.output().slice(-4000)}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
      builds = await buildRunning()
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await buildRunning()).toHaveLength(1)

    const signalledAt = performance.now()
    second.child.kill('SIGTERM')
    const [code] = await second.exited
    const exitMs = performance.now() - signalledAt
    const out = second.output()

    const traceLine = out.split('\n').find((line) => line.includes('"server.shutdown_trace"'))
    expect(traceLine, out.slice(-4000)).toBeDefined()
    const trace = JSON.parse(traceLine!) as { outcome: string; totalMs: number; steps: { step: string; startMs: number; endMs?: number; failed?: boolean }[] }
    const stopLine = out.split('\n').find((line) => line.includes('"server.background_builds_stopped"'))
    console.log(JSON.stringify({ event: 'tdiagdef.index_build_shutdown_measure', exitMs: Math.round(exitMs), code, stopLine, trace }))
    expect(trace.outcome).toBe('complete')
    expect(code).toBe(0)
    expect(exitMs).toBeLessThan(5_000)
    // The step is visible in the trace, and ended before the pools.
    const stop = trace.steps.find((step) => step.step === 'background builds stop')
    const pools = trace.steps.find((step) => step.step === 'pools')
    expect(stop?.endMs).toBeDefined()
    expect(stop!.failed).toBeUndefined()
    expect(stop!.endMs!).toBeLessThanOrEqual(pools!.startMs)
    expect(stopLine).toContain('"cancelled"')
    // CANCELLED, not orphaned: no build left running on the server side.
    expect(await buildRunning()).toEqual([])
  }, 240_000)
})
