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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import {
  MaintenanceCoordinator,
  StaleMaintenanceFenceError,
  assertMaintenanceFence,
  workspaceKeyedMaintenanceEnabled,
  type MaintenanceFence,
} from './coordinator.js'
import { ensureMaintenanceSchema } from './schema.js'
import {
  acquireMaintenanceWorkspaceLock,
  maintenanceWorkspaceLockHolders,
  maintenanceWorkspaceLockKeyText,
  releaseMaintenanceWorkspaceLock,
} from './maintenanceWorkspaceLock.js'

/**
 * The per-workspace maintenance lock.
 *
 * 1. "Acquire it again through the pool and see if you get it" DOES NOT DETECT A
 *    LEAK. Advisory locks are counted per session and `pg-pool` hands back the
 *    most recently released client, so the probe is answered by the pooling layer.
 *    Every give-back assertion here goes through `maintenanceWorkspaceLockHolders`
 *    on a connection that is provably not the holder, and each is paired with a
 *    control taken WHILE the key is held — an unpaired zero means nothing.
 * 2. THE KEY IS CLUSTER-WIDE AND THIS SUITE'S SCHEMA ISOLATION DOES NOT REACH IT.
 *    Another process running this same file against the same cluster would hold
 *    the same keys, so the workspace ids below are unique per run.
 *
 * The key has THREE components and every one of them must vary somewhere, or a
 * bug that drops or hardcodes one is invisible.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

// Unique per run: the advisory key space is cluster-wide, not schema-scoped.
const RUN = `${process.pid}-${Math.floor(Math.random() * 1e9)}`
const WS_A = { landscapeId: `land-a-${RUN}`, versionId: 'ver-1' }
const WS_B = { landscapeId: `land-b-${RUN}`, versionId: 'ver-1' }
// Differs from WS_A ONLY in versionId, so a key that dropped or hardcoded the
// version would be caught.
const WS_A_V2 = { landscapeId: WS_A.landscapeId, versionId: 'ver-2' }

describe.skipIf(!TEST_DATABASE_URL)('per-workspace maintenance lock (T-25)', () => {
  let db: IsolatedSchemaDb
  let pool: Pool
  /** A connection that is never the one running a job, so a holder count taken on
   *  it cannot be answered by this session's own re-entrancy. */
  let observer: PoolClient
  const namespace = 1_800_000_000 + Math.floor(Math.random() * 100_000_000)
  // Explicitly ON. The production default is OFF (see `workspaceKeyedMaintenanceEnabled`),
  // and a suite that inherited the default would test the job-name path while
  // claiming to test this one.
  const coordinator = (runner: string) => new MaintenanceCoordinator(pool, runner, namespace, true)

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'maintenance_workspace_lock')
    pool = db.pool
    await ensureMaintenanceSchema(pool)
    observer = await pool.connect()
  }, 120_000)

  afterAll(async () => {
    observer?.release()
    await db?.teardown()
  })

  it('the key text is the documented wire format, and every component reaches it', () => {
    // The key text IS the exclusion's wire format: two builds that spell it
    // differently stop excluding each other, silently.
    expect(maintenanceWorkspaceLockKeyText('default_compaction', { landscapeId: 'L', versionId: 'V' }))
      .toBe('maintenance-workspace:default_compaction:L:V')
    // Each component varied ALONE, so dropping any one of the three is visible.
    expect(maintenanceWorkspaceLockKeyText('automerge_gc', { landscapeId: 'L', versionId: 'V' }))
      .toBe('maintenance-workspace:automerge_gc:L:V')
    expect(maintenanceWorkspaceLockKeyText('default_compaction', { landscapeId: 'OTHER', versionId: 'V' }))
      .toBe('maintenance-workspace:default_compaction:OTHER:V')
    expect(maintenanceWorkspaceLockKeyText('default_compaction', { landscapeId: 'L', versionId: 'OTHER' }))
      .toBe('maintenance-workspace:default_compaction:L:OTHER')
  })

  it('is OFF by default — the shipped default must be the pre-existing behaviour', () => {
    // The rollout hazard this flag exists for: a workspace-keyed replica and a
    // job-name-keyed replica take keys in DIFFERENT advisory key spaces and do not
    // exclude each other at all. If this ever defaults to on, deploying the change
    // becomes the thing that breaks the exclusion.
    expect(workspaceKeyedMaintenanceEnabled({})).toBe(false)
    expect(workspaceKeyedMaintenanceEnabled({ MAINTENANCE_WORKSPACE_KEYED: 'off' })).toBe(false)
    expect(workspaceKeyedMaintenanceEnabled({ MAINTENANCE_WORKSPACE_KEYED: 'true' })).toBe(false)
    expect(workspaceKeyedMaintenanceEnabled({ MAINTENANCE_WORKSPACE_KEYED: 'on' })).toBe(true)
  })

  it('refuses the SAME workspace, admits a DIFFERENT one, and admits one differing only by version', async () => {
    const holder = await pool.connect()
    const rival = await pool.connect()
    try {
      const keyA = maintenanceWorkspaceLockKeyText('default_compaction', WS_A)
      const keyB = maintenanceWorkspaceLockKeyText('default_compaction', WS_B)
      const keyAv2 = maintenanceWorkspaceLockKeyText('default_compaction', WS_A_V2)
      const keyOtherJob = maintenanceWorkspaceLockKeyText('technology_asset_gc', WS_A)

      expect(await acquireMaintenanceWorkspaceLock(holder, keyA)).toBe(true)

      // CONTROL — without it, "a different workspace proceeds" cannot be told
      // apart from "this lock never refuses anyone".
      expect(await acquireMaintenanceWorkspaceLock(rival, keyA),
        'a rival session took a key already held — the lock excludes nothing').toBe(false)

      expect(await acquireMaintenanceWorkspaceLock(rival, keyB),
        'a different landscape was refused — this is still a global lock').toBe(true)
      // Differs ONLY in versionId: a key that dropped the version would refuse here.
      expect(await acquireMaintenanceWorkspaceLock(rival, keyAv2),
        'a different VERSION of the same landscape was refused — the version is not in the key').toBe(true)
      // Differs ONLY in job: a key that hardcoded the job segment would refuse here.
      expect(await acquireMaintenanceWorkspaceLock(rival, keyOtherJob),
        'a different JOB on the same workspace was refused — the job is not in the key').toBe(true)

      for (const key of [keyB, keyAv2, keyOtherJob]) {
        expect(await releaseMaintenanceWorkspaceLock(rival, key)).toEqual({ confirmed: true, error: null })
      }
      expect(await releaseMaintenanceWorkspaceLock(holder, keyA)).toEqual({ confirmed: true, error: null })
    } finally {
      holder.release()
      rival.release()
    }
  })

  it('release ANSWERS rather than assumes, and the failure of the statement is distinct from a "no"', async () => {
    const client = await pool.connect()
    try {
      // `pg_advisory_unlock` RETURNS false here; it does not raise. A swallowed
      // result would make an evaporated lock and a clean release
      // indistinguishable.
      const never = await releaseMaintenanceWorkspaceLock(
        client, maintenanceWorkspaceLockKeyText('default_compaction', { landscapeId: 'never', versionId: RUN }),
      )
      expect(never).toEqual({ confirmed: false, error: null })

      // ...and the `catch` branch is reachable and reports the error rather than
      // a bare false. A client whose session is gone cannot answer at all, and
      // "Postgres said no" must not be confused with "Postgres did not answer".
      const dead = await pool.connect()
      const pid = (await dead.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
      // With a timeout, pg_terminate_backend returns once the backend has EXITED,
      // not once the signal is sent — otherwise the release below can still be
      // answered by the dying session and report no error.
      const terminated = await client.query<{ ok: boolean }>('SELECT pg_terminate_backend($1, 10000) AS ok', [pid])
      expect(terminated.rows[0].ok, 'the session did not exit within 10 s').toBe(true)
      const broken = await releaseMaintenanceWorkspaceLock(
        dead, maintenanceWorkspaceLockKeyText('default_compaction', WS_A),
      )
      expect(broken.confirmed).toBe(false)
      expect(broken.error, 'a statement that could not be answered reported no error').not.toBeNull()
      dead.release(new Error('terminated by test'))
    } finally { client.release() }
  })

  it('the coordinator serialises one workspace and lets another through', async () => {
    const a = coordinator('replica-a')
    const b = coordinator('replica-b')
    const release = deferred<void>()
    const entered = deferred<void>()
    let invocations = 0

    const owner = a.run('default_compaction', async () => {
      invocations += 1
      entered.resolve()
      await release.promise
      return { objectsFolded: 1 }
    }, { workspace: WS_A })

    try {
      await entered.promise

      await expect(b.run('default_compaction', async () => {
        invocations += 1
        return { objectsFolded: 99 }
      }, { workspace: WS_A })).resolves.toEqual({ status: 'skipped_locked', job: 'default_compaction' })

      // A refusal must be RECORDED, not merely returned: `skip_count` is what an
      // operator reads to see contention. Keyed by the FULL key: a skip counted
      // against the job-name row would make "this workspace is busy"
      // indistinguishable from "the job is globally held".
      const skips = await observer.query<{ skip_count: string }>(
        `SELECT skip_count FROM maintenance_job_status
          WHERE job_name = $1 AND landscape_id = $2 AND version_id = $3`,
        ['default_compaction', WS_A.landscapeId, WS_A.versionId])
      expect(Number(skips.rows[0]?.skip_count ?? 0),
        'the refusal was not recorded against THIS workspace — contention is invisible').toBeGreaterThan(0)

      // DIFFERENT workspace, same job, WHILE workspace A is still held. Probed
      // before the release: after it there is nothing held to be excluded by.
      await expect(b.run('default_compaction', async () => {
        invocations += 1
        return { objectsFolded: 2 }
      }, { workspace: WS_B })).resolves.toMatchObject({ status: 'completed' })

      expect(invocations, 'expected A, the refused rival NOT to run, and B').toBe(2)
    } finally {
      // Without this, any failure above leaves the task awaiting for ever, the
      // client checked out and `pool.end()` hanging — a red run then reports a
      // hang instead of the assertion that failed.
      release.resolve()
      await owner.catch(() => undefined)
    }
  })

  it('gives the key back — counted on an independent session, against a control', async () => {
    const a = coordinator('replica-a')
    const release = deferred<void>()
    const entered = deferred<void>()
    const keyA = maintenanceWorkspaceLockKeyText('default_compaction', WS_A)

    const owner = a.run('default_compaction', async () => {
      entered.resolve()
      await release.promise
      return { objectsFolded: 1 }
    }, { workspace: WS_A })

    try {
      await entered.promise
      // THE CONTROL, and it is what makes the zero below mean anything: the
      // counter must be shown able to FIND a holder.
      expect(await maintenanceWorkspaceLockHolders(observer, keyA),
        'the holder counter cannot see a key that is definitely held').toBe(1)
    } finally {
      release.resolve()
      await owner.catch(() => undefined)
    }

    expect(await maintenanceWorkspaceLockHolders(observer, keyA),
      'the workspace key is still held after the run finished — it leaked onto a pooled connection').toBe(0)
  })

  it('gives the key back when the task THROWS', async () => {
    const a = coordinator('replica-a')
    const keyB = maintenanceWorkspaceLockKeyText('default_compaction', WS_B)

    // Control first: nothing holds it before the failing run.
    expect(await maintenanceWorkspaceLockHolders(observer, keyB)).toBe(0)

    await expect(a.run('default_compaction', async () => {
      expect(await maintenanceWorkspaceLockHolders(observer, keyB),
        'the failing run never took the key, so giving it back proves nothing').toBe(1)
      throw new Error('compaction blew up')
    }, { workspace: WS_B })).rejects.toThrow('compaction blew up')

    expect(await maintenanceWorkspaceLockHolders(observer, keyB),
      'a thrown task leaked the workspace key onto a pooled connection').toBe(0)
  })

  /**
   * The fate of the CONNECTION, which is the only way to see the poison path.
   *
   * Returning a poisoned client to the pool instead of destroying it, or a
   * release guard that tracks the key text rather than "did we take it", change
   * what happens to the connection and nothing else, so the observable has to
   * be the backend itself.
   */
  const capturingPool = () => {
    let pid = 0
    let client: PoolClient | null = null
    const wrapper = {
      connect: async () => {
        const c = await pool.connect()
        pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        client = c
        return c
      },
      query: (...args: unknown[]) => (pool.query as (...a: unknown[]) => unknown)(...args),
    } as unknown as Pool
    return { wrapper, pid: () => pid, client: () => client }
  }

  const backendAlive = async (pid: number): Promise<boolean> => {
    // A destroyed client sends Terminate and the backend exits, but not
    // synchronously with `release()`. Poll briefly rather than bet on the timing.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { rows } = await observer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])
      if (rows[0].n === 0) return false
      await new Promise((r) => setTimeout(r, 50))
    }
    return true
  }

  it('destroys the connection when the key could not be confirmed released', async () => {
    // The lock EVAPORATES mid-run while the connection stays perfectly healthy —
    // the exact case `pg_advisory_unlock` answers `false` for, and the only one
    // where "Postgres said no" is distinguishable from "the socket died".
    const { wrapper, pid, client } = capturingPool()
    const a = new MaintenanceCoordinator(wrapper, 'replica-poison', namespace, true)
    const ws = { landscapeId: `land-poison-${RUN}`, versionId: 'ver-1' }
    const keyText = maintenanceWorkspaceLockKeyText('default_compaction', ws)

    await expect(a.run('default_compaction', async () => {
      // Drop the key underneath the coordinator, on its own session.
      await client()!.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [keyText])
      return 1
    }, { workspace: ws })).resolves.toMatchObject({ status: 'completed' })

    expect(await backendAlive(pid()),
      'the connection was handed back to the pool while its lock state was unknown').toBe(false)
  })

  it('does NOT destroy the connection on an ordinary refusal', async () => {
    // The other direction, and the one that makes the test above mean something:
    // a refusal is the common case, and destroying a healthy connection every
    // time a workspace is busy would churn the pool under contention.
    const ws = { landscapeId: `land-refused-${RUN}`, versionId: 'ver-1' }
    const keyText = maintenanceWorkspaceLockKeyText('default_compaction', ws)
    const rival = await pool.connect()
    try {
      expect(await acquireMaintenanceWorkspaceLock(rival, keyText)).toBe(true)

      const { wrapper, pid } = capturingPool()
      const a = new MaintenanceCoordinator(wrapper, 'replica-refused', namespace, true)
      await expect(a.run('default_compaction', async () => 1, { workspace: ws }))
        .resolves.toEqual({ status: 'skipped_locked', job: 'default_compaction' })

      expect(await backendAlive(pid()),
        'a refused run destroyed its connection — the pool churns under contention').toBe(true)
    } finally {
      await releaseMaintenanceWorkspaceLock(rival, keyText)
      rival.release()
    }
  })

  it('refuses a job that is not workspace-keyable', async () => {
    const a = coordinator('replica-a')
    // `automerge_gc` walks the whole Repo; two workspace-keyed runs would each
    // sweep with an incomplete reachable set, and mark-and-sweep with an
    // incomplete reachable set deletes live documents.
    await expect(a.run('automerge_gc', async () => 1, { workspace: WS_A }))
      .rejects.toThrow(/not workspace-keyable/)
    await expect(a.runFenced('automerge_gc', async () => 1, { workspace: WS_A }))
      .rejects.toThrow(/not workspace-keyable/)
  })

  it('reports a live workspace-keyed run as HELD, not orphaned (T-25b)', async () => {
    // `orphaned` is a paging alert, and the contract is that a `running` row
    // with no lock is exposed as `orphaned`, never as an active run. The
    // snapshot's `pg_locks` predicate must cover the 1-argument hashed key
    // space too, or a workspace-keyed run renders as a dead runner for its
    // entire duration.
    const a = coordinator('replica-snap')
    const ws = { landscapeId: `land-snap-${RUN}`, versionId: 'ver-1' }
    const release = deferred<void>()
    const entered = deferred<void>()

    const owner = a.run('default_compaction', async () => {
      entered.resolve()
      await release.promise
      return 1
    }, { workspace: ws })

    try {
      await entered.promise
      const snap = await a.clusterSnapshot()
      const row = snap.jobs.find((j) => j.landscapeId === ws.landscapeId)
      expect(row, 'the workspace-keyed run is absent from the snapshot entirely').toBeDefined()
      expect(row!.status, 'a healthy per-workspace run is reported as a dead runner').toBe('running')
      expect(row!.lockHeld, 'the snapshot looked in the wrong advisory key space').toBe(true)
      expect(row!.versionId).toBe(ws.versionId)
    } finally {
      release.resolve()
      await owner.catch(() => undefined)
    }

    // THE CONTROL, and without it "never says orphaned" would pass just as well:
    // a `running` row whose key nobody holds MUST still be reported as orphaned.
    await observer.query(
      `INSERT INTO maintenance_job_status (job_name, landscape_id, version_id, runner_id, status, started_at)
       VALUES ($1, $2, $3, 'ghost', 'running', now())
       ON CONFLICT (job_name, landscape_id, version_id) DO UPDATE SET status = 'running'`,
      ['default_compaction', `land-ghost-${RUN}`, 'ver-1'])
    const after = await a.clusterSnapshot()
    const ghost = after.jobs.find((j) => j.landscapeId === `land-ghost-${RUN}`)
    expect(ghost?.status, 'a running row with nobody holding its key is not reported orphaned').toBe('orphaned')
    expect(ghost?.lockHeld).toBe(false)
  })

  it('records a FAILURE on one workspace while another runs concurrently (T-25b)', async () => {
    // If two workspaces running one job shared a status row (a key of
    // `job_name` alone), the second run's upsert would overwrite `runner_id`
    // and the first run's terminal UPDATE — `WHERE job_name = $1 AND
    // runner_id = $2` — would match ZERO rows. `failure_count` and
    // `last_error_code`, both alert signals, would then silently miss the
    // failure.
    const a = coordinator('replica-fail-a')
    const b = coordinator('replica-fail-b')
    const wsA = { landscapeId: `land-fail-a-${RUN}`, versionId: 'ver-1' }
    const wsB = { landscapeId: `land-fail-b-${RUN}`, versionId: 'ver-1' }
    const entered = deferred<void>()
    const bDone = deferred<void>()

    const failing = a.run('default_compaction', async () => {
      entered.resolve()
      // Interleaved on purpose: B must upsert BETWEEN A's insert and A's
      // terminal update, which is the ordering that would lose the failure.
      await bDone.promise
      throw new Error('compaction blew up on workspace A')
    }, { workspace: wsA })

    try {
      await entered.promise
      await expect(b.run('default_compaction', async () => 1, { workspace: wsB }))
        .resolves.toMatchObject({ status: 'completed' })
    } finally {
      bDone.resolve()
    }
    await expect(failing).rejects.toThrow('compaction blew up on workspace A')

    const row = async (ws: { landscapeId: string; versionId: string }) => (await observer.query<{
      status: string; failure_count: string; last_error_code: string | null
    }>(
      `SELECT status, failure_count, last_error_code FROM maintenance_job_status
        WHERE job_name = $1 AND landscape_id = $2 AND version_id = $3`,
      ['default_compaction', ws.landscapeId, ws.versionId],
    )).rows[0]

    const a1 = await row(wsA)
    expect(a1?.status, 'the failed run is not recorded as failed').toBe('failed')
    expect(Number(a1?.failure_count),
      'a failure on one workspace incremented nothing — the alert cannot fire').toBe(1)
    expect(a1?.last_error_code,
      'a failure on one workspace wrote no error code').not.toBeNull()

    // The control: the OTHER workspace is unaffected and reports its own outcome,
    // so the assertion above is not satisfied by "everything is marked failed".
    const b1 = await row(wsB)
    expect(b1?.status).toBe('completed')
    expect(Number(b1?.failure_count)).toBe(0)
  })

  it('a failure on one workspace does not mark another run by the SAME replica (T-25b)', async () => {
    // Separating the ROWS is not sufficient on its own. The terminal UPDATE also
    // matches on `runner_id`, and ONE replica compacting two workspaces
    // concurrently uses the SAME runner id for both — so without the workspace in
    // the WHERE, a failure on one marks every row that replica owns. The previous
    // test cannot see this: it uses two different replicas, and with per-workspace
    // rows the runner id alone already picks the right one there.
    const one = coordinator('replica-shared')
    const wsA = { landscapeId: `land-same-a-${RUN}`, versionId: 'ver-1' }
    const wsB = { landscapeId: `land-same-b-${RUN}`, versionId: 'ver-1' }
    const entered = deferred<void>()
    const bDone = deferred<void>()

    const failing = one.run('default_compaction', async () => {
      entered.resolve()
      await bDone.promise
      throw new Error('failed on A')
    }, { workspace: wsA })

    try {
      await entered.promise
      await expect(one.run('default_compaction', async () => 1, { workspace: wsB }))
        .resolves.toMatchObject({ status: 'completed' })
    } finally {
      bDone.resolve()
    }
    await expect(failing).rejects.toThrow('failed on A')

    const { rows } = await observer.query<{ landscape_id: string; status: string; failure_count: string }>(
      `SELECT landscape_id, status, failure_count FROM maintenance_job_status
        WHERE job_name = $1 AND landscape_id = ANY($2::text[]) ORDER BY landscape_id`,
      ['default_compaction', [wsA.landscapeId, wsB.landscapeId]])
    expect(rows).toHaveLength(2)
    expect(rows[0].status, 'workspace A should be failed').toBe('failed')
    expect(rows[1].status, "a failure on A marked B's row too — one replica's failure smeared across its workspaces").toBe('completed')
    expect(Number(rows[1].failure_count), "B's failure_count was incremented by A's failure").toBe(0)
  })

  it('two workspaces get INDEPENDENT fencing tokens (T-25b)', async () => {
    // With a fence keyed by `job_name` alone, a second workspace's acquisition
    // would bump the shared token and the first run's next
    // `assertMaintenanceFence` would throw on a workspace it had nothing to do
    // with. A fence that fails closed on valid work stops being a fence.
    const a = coordinator('replica-a')
    const b = coordinator('replica-b')
    const wsA = { landscapeId: `land-fence-a-${RUN}`, versionId: 'ver-1' }
    const wsB = { landscapeId: `land-fence-b-${RUN}`, versionId: 'ver-1' }

    let fenceA: MaintenanceFence | null = null
    await a.runFenced('default_compaction', async (fence) => { fenceA = fence; return 1 }, { workspace: wsA })
    let fenceB: MaintenanceFence | null = null
    await b.runFenced('default_compaction', async (fence) => { fenceB = fence; return 1 }, { workspace: wsB })

    expect(fenceA).not.toBeNull()
    expect(fenceB).not.toBeNull()
    // Independent ROWS, so each starts at 1 rather than one counter advancing.
    expect(fenceA!.token).toBe('1')
    expect(fenceB!.token).toBe('1')
    expect(fenceA!.landscapeId).toBe(wsA.landscapeId)

    // A's fence is still current AFTER B acquired one for a different workspace.
    await expect(assertMaintenanceFence(observer, fenceA!)).resolves.toBeUndefined()

    // ...and the fence still fails closed where it should: a stale token for the
    // SAME workspace is rejected. Without this, "never throws" would pass too.
    await expect(assertMaintenanceFence(observer, { ...fenceA!, token: '99' }))
      .rejects.toThrow(StaleMaintenanceFenceError)
  })

  it('with the flag OFF a supplied workspace is ignored and the job-name lock is taken', async () => {
    // The rollout property, executed: an old-build replica takes the job-name key,
    // so a new-build replica must take the SAME key until the flag is flipped.
    const off = new MaintenanceCoordinator(pool, 'replica-off', namespace, false)
    const other = new MaintenanceCoordinator(pool, 'replica-other', namespace, false)
    const release = deferred<void>()
    const entered = deferred<void>()
    // Workspaces used by NO other test in this file: the row-count assertion
    // below is "zero per-workspace rows for this landscape", and a landscape an
    // earlier flag-on test already wrote would make it pass or fail for reasons
    // that have nothing to do with the flag.
    const wsOffA = { landscapeId: `land-off-a-${RUN}`, versionId: 'ver-1' }
    const wsOffB = { landscapeId: `land-off-b-${RUN}`, versionId: 'ver-1' }
    const keyA = maintenanceWorkspaceLockKeyText('default_compaction', wsOffA)

    const owner = off.run('default_compaction', async () => {
      entered.resolve()
      await release.promise
      return 1
    }, { workspace: wsOffA })

    try {
      await entered.promise
      // No workspace key was taken at all...
      expect(await maintenanceWorkspaceLockHolders(observer, keyA),
        'the flag is off yet the workspace key was taken').toBe(0)
      // ...and a DIFFERENT workspace is refused, because the exclusion is still
      // the cluster-wide job name. This is the assertion that inverts when the
      // flag is flipped, and it is the whole difference between the two modes.
      await expect(other.run('default_compaction', async () => 2, { workspace: wsOffB }))
        .resolves.toEqual({ status: 'skipped_locked', job: 'default_compaction' })

      // ...and the BOOK-KEEPING follows the exclusion actually in force, not the
      // workspace that happened to be supplied. Two replicas contending for one
      // job-name lock must write the one job-name row; if they booked into
      // per-workspace rows while sharing a lock, the row would say `running` for a
      // workspace whose key nobody holds — reported as `orphaned`, a paging alert.
      const { rows } = await observer.query<{ n: string }>(
        `SELECT count(*) AS n FROM maintenance_job_status
          WHERE job_name = $1 AND landscape_id = ANY($2::text[])`,
        ['default_compaction', [wsOffA.landscapeId, wsOffB.landscapeId]])
      expect(Number(rows[0].n),
        'the flag is off yet the run booked into a per-workspace row').toBe(0)
    } finally {
      release.resolve()
      await owner.catch(() => undefined)
    }
  })
})
