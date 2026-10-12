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

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { startReadModelProjector } from './projectorService.js'
import {
  LIFECYCLE_WRITE_FENCE_PREFIX,
  assertReadModelWriteFence,
  claimLifecycleWriteFence,
  claimReadModelWriteFence,
} from './health.js'
import { ReadModelPlaneError, assertReadModelPlane } from './projectionAuthority.js'
import { roObject } from './queries.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * The read-model row-write fence, proven against a real Postgres and the real
 * projector. Without it, the row writes of a disowned pass are only overwritten
 * by the takeover's cold build if that build commits AFTER them, and nothing
 * orders the two.
 *
 * The discriminating shape in every test is ORDER: a takeover's claim commits
 * FIRST, then a stale pass runs to completion. Each test fails against a
 * projector without the fence.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  // Dedicated schema so this file's committed writes never touch public ro_* tables.
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 4, connectionTimeoutMillis: 4000, options: '-c search_path=rmfence_test,public' }), 'writeFence')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS rmfence_test')
      const { ensureReadModelSchema } = await import('./schema.js')
      await ensureReadModelSchema(c)
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[writeFence] no Postgres at ${URL} — skipping`)

/** Poll a condition (the projector's incremental writes are async, fire-and-forget). */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 6000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface StateRow {
  write_fence: string | null
  observed_generation: string
  projected_generation: string
  last_error_code: string | null
  consecutive_failures: number
}

async function stateRow(key: WorkspaceKey): Promise<StateRow | undefined> {
  const { rows } = await pool!.query<StateRow>(
    `SELECT write_fence, observed_generation::text, projected_generation::text,
            last_error_code, consecutive_failures
     FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return rows[0]
}

async function watermarkOf(key: WorkspaceKey, documentId: string): Promise<string | null> {
  const { rows } = await pool!.query<{ projected_watermark: string }>(
    `SELECT projected_watermark::text FROM read_model_document_watermarks
     WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [key.landscapeId, key.versionId, documentId],
  )
  return rows[0]?.projected_watermark ?? null
}

function shardedWorkspace(repo: Repo) {
  const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } } })
  const cs0 = repo.create({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } })
  const meta = repo.create({ objectShardUrls: [os0.url], connectionShardUrls: [cs0.url], groups: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
  return { os0, cs0, meta, root, all: [os0, cs0, meta, root] }
}

suite('read-model row-write fence (NC-2)', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query('DROP SCHEMA IF EXISTS rmfence_test CASCADE')
    } finally {
      c.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    await pool!.query(
      'TRUNCATE ro_objects, ro_connections, ro_groups, read_model_projection_state, read_model_document_watermarks',
    )
  })

  it('a takeover makes a lingering projector roll back rows, watermark and telemetry together', async () => {
    // Two REAL projector instances on one workspace: A boots and owns the
    // rows; B takes over (its cold build claims the fence); then A — whose
    // listeners are still attached, exactly like a released instance whose
    // build and queues cannot be cancelled — sees a shard change and runs a
    // full delta pass. Without the fence, A's pass would commit stale rows
    // OVER B's cold build and stamp a watermark saying it hadn't. With the
    // fence, A's transaction rolls back whole.
    const WS: WorkspaceKey = { landscapeId: 'fence-ls1', versionId: 'v1' }
    const repo = new Repo({})
    const { os0, all } = shardedWorkspace(repo)
    await Promise.all(all.map((h) => h.whenReady()))
    const os0DocId = os0.documentId

    let fenceLostReports = 0
    const stopA = await startReadModelProjector(
      repo, all[3].url, pool!, WS, undefined, 0, undefined, undefined,
      () => { fenceLostReports += 1 },
    )
    try {
      // Sanity + the no-false-abort half: the single owner projects normally.
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['o5'] = { id: 'o5', name: 'Owned' }
      })
      const owned = await until(() => roObject(pool!, WS, 'o5'), (v) => !!v)
      expect(owned).toBeTruthy()
      const fenceA = (await stateRow(WS))?.write_fence
      expect(fenceA).toBeTruthy()

      // The takeover. B cold-builds from the same documents and claims the
      // fence inside the same transaction as its rows.
      const stopB = await startReadModelProjector(repo, all[3].url, pool!, WS)
      const fenceB = (await stateRow(WS))?.write_fence
      expect(fenceB).toBeTruthy()
      expect(fenceB).not.toBe(fenceA)
      // B leaves; the fence is a claim, not a lease — it survives the stop.
      stopB()
      expect((await stateRow(WS))?.write_fence).toBe(fenceB)

      const before = await stateRow(WS)
      const wmBefore = await watermarkOf(WS, os0DocId)
      expect(wmBefore).not.toBeNull()

      // A's stale pass. The pre-`begin` fence check kills the pass BEFORE it
      // touches the state row at all, so the wait signal is the fence-lost
      // report, not a generation bump.
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['o9'] = { id: 'o9', name: 'Stale' }
      })
      await until(async () => fenceLostReports, (n) => n > 0)
      expect(fenceLostReports).toBe(1)
      // Let the aborted pass unwind fully before reading its (absent) traces.
      await new Promise((r) => setTimeout(r, 400))

      expect(await roObject(pool!, WS, 'o9')).toBeFalsy()
      // The forgery the fence exists for: no watermark advance over rows that
      // were never rewritten.
      expect(await watermarkOf(WS, os0DocId)).toBe(wmBefore)
      // And NOTHING on the new owner's row. `observed_generation` is the
      // sharp half: `beginReadModelProjection` runs on the pool, outside the
      // transaction, so without the pre-check a straggler's begin bumps it —
      // walking the owner's status to `catching_up`, refusing
      // `absenceProvable` and blocking compaction until the owner's next
      // pass. A failure-telemetry write is the blunt half.
      const after = await stateRow(WS)
      expect(after?.observed_generation).toBe(before?.observed_generation)
      expect(after?.last_error_code).toBeNull()
      expect(after?.consecutive_failures).toBe(0)
      expect(after?.projected_generation).toBe(before?.projected_generation)
      expect(after?.write_fence).toBe(fenceB)
      // A second stale change must not re-fire the hook — it is a latch, and
      // the fleet recycle it triggers must not be scheduled per change.
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['o10'] = { id: 'o10', name: 'Stale again' }
      })
      await new Promise((r) => setTimeout(r, 300))
      expect(fenceLostReports).toBe(1)
      expect(await roObject(pool!, WS, 'o10')).toBeFalsy()
    } finally {
      stopA()
    }
  }, 30_000)

  it('a cold build that never owned the workspace rolls back everything, including its claim', async () => {
    // The other direction of the theft: a released instance's cold build
    // commits LAST and would otherwise claim the fence over the live owner's,
    // wedging the workspace — the loser cannot project, the winner can no
    // longer commit. The `stillOwned` guard on the claim turns that into a
    // full rollback: no rows, no watermarks, no fence, and the start rejects.
    const WS: WorkspaceKey = { landscapeId: 'fence-ls2', versionId: 'v1' }
    const repo = new Repo({})
    const { all } = shardedWorkspace(repo)
    await Promise.all(all.map((h) => h.whenReady()))

    await expect(
      startReadModelProjector(repo, all[3].url, pool!, WS, undefined, 0, undefined, () => false),
    ).rejects.toThrow(/write fence/)

    const { rows: objects } = await pool!.query(
      'SELECT id FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [WS.landscapeId, WS.versionId])
    expect(objects).toHaveLength(0)
    const { rows: watermarks } = await pool!.query(
      'SELECT document_id FROM read_model_document_watermarks WHERE landscape_id = $1 AND version_id = $2',
      [WS.landscapeId, WS.versionId])
    expect(watermarks).toHaveLength(0)
    expect((await stateRow(WS))?.write_fence).toBeNull()
  }, 30_000)

  it('a pass whose health span failed to begin is still fenced and still atomic', async () => {
    // The token-less fallback (health span failed to begin) must run in the
    // same transaction shape as the tracked path, so the fence assert rolls
    // it back the same way; run bare on the pool, a disowned pass whose begin
    // also failed could commit stale rows. Two phases:
    //
    //  (a) begin fails while this instance legitimately holds the fence — the
    //      fallback must still COMMIT (losing the health span must not lose
    //      the projection);
    //  (b) begin fails while the fence is foreign AND the pre-`begin` check
    //      was raced (simulated by lying to it) — the in-transaction assert
    //      is the last line, and it must roll the fallback back. This is the
    //      exact raced window the pre-check cannot close.
    const WS: WorkspaceKey = { landscapeId: 'fence-ls3', versionId: 'v1' }
    const repo = new Repo({})
    const { os0, all } = shardedWorkspace(repo)
    await Promise.all(all.map((h) => h.whenReady()))

    // A Queryable that can fail exactly one begin, and can tell the NEXT
    // pre-check one lie. connect() — which the projection transaction and the
    // in-transaction assert run on — passes straight through to the real
    // pool, so the assert always sees the truth.
    let failNextBegin = false
    let beginFailures = 0
    let lieToNextPreCheck: string | null = null
    let liesTold = 0
    const db = {
      query: (text: string, params?: unknown[]) => {
        if (failNextBegin && /RETURNING observed_generation/.test(text)) {
          failNextBegin = false
          beginFailures += 1
          return Promise.reject(new Error('injected: health span unavailable'))
        }
        if (lieToNextPreCheck !== null && /SELECT write_fence/.test(text) && !/FOR UPDATE/.test(text)) {
          const lie = lieToNextPreCheck
          lieToNextPreCheck = null
          liesTold += 1
          return Promise.resolve({ rows: [{ write_fence: lie }], rowCount: 1 })
        }
        return pool!.query(text, params as never[])
      },
      connect: () => pool!.connect(),
    } as unknown as Queryable

    const stop = await startReadModelProjector(repo, all[3].url, db, WS)
    try {
      // Let the boot's own trailing passes (diagram reconcile) drain before
      // arming, so the injected failure lands on the SHARD delta's begin and
      // the fallback attribution below stays tight.
      await new Promise((r) => setTimeout(r, 600))
      const fence = (await stateRow(WS))?.write_fence
      expect(fence).toBeTruthy()

      // (a) Legitimate owner, begin fails: the fallback commits.
      failNextBegin = true
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['oF1'] = { id: 'oF1', name: 'Fallback owned' }
      })
      await until(async () => beginFailures, (n) => n >= 1)
      const committed = await until(() => roObject(pool!, WS, 'oF1'), (v) => !!v)
      expect(committed).toBeTruthy()

      // (b) Foreign fence, raced pre-check (the lie), begin fails: the
      // fallback's own assert rolls everything back.
      await pool!.query(
        `UPDATE read_model_projection_state SET write_fence = 'intruder'
         WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )
      lieToNextPreCheck = fence!
      failNextBegin = true
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['oF2'] = { id: 'oF2', name: 'Fallback raced' }
      })
      await until(async () => beginFailures, (n) => n >= 2)
      await new Promise((r) => setTimeout(r, 400))

      // The lie was consumed (the raced pre-check really ran) and the row
      // still never landed: only the in-transaction assert can be the reason.
      expect(liesTold).toBe(1)
      expect(await roObject(pool!, WS, 'oF2')).toBeFalsy()
      expect((await stateRow(WS))?.write_fence).toBe('intruder')
    } finally {
      stop()
    }
  }, 30_000)

  it('the assert takes a REAL row lock: a concurrent claim waits for the asserting transaction', async () => {
    // The FOR UPDATE is invisible to single-connection tests (removing it
    // leaves them green). Two connections make it observable: while an
    // asserting transaction holds the row, a takeover's claim UPDATE must
    // block, and must land only after the commit.
    const WS: WorkspaceKey = { landscapeId: 'fence-ls4', versionId: 'v1' }
    await pool!.query(
      `INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence, updated_at)
       VALUES ($1, $2, 'holder', now())`,
      [WS.landscapeId, WS.versionId],
    )
    const asserting = await pool!.connect()
    try {
      await asserting.query('BEGIN')
      await assertReadModelWriteFence(asserting, WS, 'holder')

      let claimSettled = false
      const claim = (async () => {
        const claimant = await pool!.connect()
        try {
          await claimant.query(
            `UPDATE read_model_projection_state SET write_fence = 'taker'
             WHERE landscape_id = $1 AND version_id = $2`,
            [WS.landscapeId, WS.versionId],
          )
        } finally {
          claimant.release()
        }
      })().then(() => { claimSettled = true })

      await new Promise((r) => setTimeout(r, 350))
      // Without FOR UPDATE the plain SELECT holds nothing and the claim has
      // long landed by now.
      expect(claimSettled).toBe(false)

      await asserting.query('COMMIT')
      await claim
      expect(claimSettled).toBe(true)
      expect((await stateRow(WS))?.write_fence).toBe('taker')
    } finally {
      await asserting.query('ROLLBACK').catch(() => undefined)
      asserting.release()
    }
  }, 30_000)

  // ── the LIFECYCLE fence: the plane changing hands MID-projection ──────────
  //
  // A promotion committing between an ordinary cold build's authority check
  // and its blanket DELETE would let that build erase rows the new owner had
  // published, with COMMIT succeeding. `assertReadModelPlane` cannot stop it —
  // it runs at the START of the transaction, and ordinary authority is the
  // ABSENCE of a row, which is not lockable.

  async function seedState(key: WorkspaceKey, fence: string): Promise<void> {
    await pool!.query(
      `INSERT INTO read_model_projection_state (landscape_id, version_id, write_fence, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET write_fence = EXCLUDED.write_fence`,
      [key.landscapeId, key.versionId, fence],
    )
  }

  it('a lifecycle fence taken mid-projection makes the projection fail its own assert', async () => {
    const WS: WorkspaceKey = { landscapeId: 'fence-lifecycle', versionId: 'v1' }
    await seedState(WS, 'projector-A')

    // CONTROL FIRST, and it is not optional: without it, "the assert threw"
    // could be an assert that always throws, and the test would pass against a
    // fence that never worked.
    const control = await pool!.connect()
    try {
      await control.query('BEGIN')
      await expect(assertReadModelWriteFence(control, WS, 'projector-A')).resolves.toBeUndefined()
    } finally {
      await control.query('ROLLBACK').catch(() => undefined)
      control.release()
    }

    const projection = await pool!.connect()
    try {
      await projection.query('BEGIN')
      // …the cold build's rows would be written here…
      const taken = await claimLifecycleWriteFence(pool!, WS)
      expect(taken.startsWith(LIFECYCLE_WRITE_FENCE_PREFIX)).toBe(true)
      // …and this is the projection's LAST act before COMMIT.
      await expect(assertReadModelWriteFence(projection, WS, 'projector-A'))
        .rejects.toThrow(/write fence lost/)
      await projection.query('ROLLBACK')
    } finally {
      projection.release()
    }
    expect((await stateRow(WS))?.write_fence).toMatch(/^lifecycle:promote:/)
  })

  it('the fence value is UNIQUE per transition — a constant sentinel would be an ABA', async () => {
    // The interleaving a constant would admit, and it is not exotic: the
    // demotion does not clear the fence, so a projector attaching afterwards
    // observes the sentinel as its `expectedPrevious` and a RE-promotion
    // landing mid-build would write the same value again — letting that build's
    // CAS match and commit its blanket rebuild over the re-promoted plane.
    const WS: WorkspaceKey = { landscapeId: 'fence-lifecycle-aba', versionId: 'v1' }
    await seedState(WS, 'projector-A')

    const first = await claimLifecycleWriteFence(pool!, WS)
    // A projector attaches after the demotion and observes the sentinel.
    const observedByProjector = first
    const second = await claimLifecycleWriteFence(pool!, WS)
    expect(second).not.toBe(first)

    // Its CAS must now find nothing to move. Under a constant sentinel `first`
    // and `second` are equal and this claim SUCCEEDS — which is the defect.
    const build = await pool!.connect()
    try {
      await build.query('BEGIN')
      await expect(
        claimReadModelWriteFence(build, WS, null, 'projector-A', observedByProjector),
      ).rejects.toThrow(/write fence lost/)
      await build.query('ROLLBACK')
    } finally {
      build.release()
    }

    // CONTROL: against the value actually held, the same claim succeeds — so
    // the rejection above is about the VALUE and not about the claim being
    // broken for lifecycle fences in general. This is also the return path: a
    // projector re-takes the fence after a demotion without any special case.
    const back = await pool!.connect()
    try {
      await back.query('BEGIN')
      await expect(
        claimReadModelWriteFence(back, WS, null, 'projector-A', second),
      ).resolves.toBeUndefined()
      await back.query('COMMIT')
    } finally {
      back.release()
    }
    expect((await stateRow(WS))?.write_fence).toBe('projector-A')
  })

  it('taking the fence on a workspace with no health row FAILS — it does not invent one', async () => {
    // Both obvious implementations are wrong in opposite directions. A plain
    // unchecked UPDATE is a silent no-op here, so the promotion would believe
    // it had fenced a projection it had not — a gate that cannot fail. An
    // upsert avoids that but INVENTS a health row with a null org_id and no
    // `last_projected_at`, which the status ladder reads as `uninitialized` and
    // which then joins the fleet's counts and the divergence scheduler's work
    // list — manufacturing a health record just to note a fence. The row's
    // existence is a PRECONDITION (the promotion refuses
    // unless projection freshness is healthy, and that reads this very row), so
    // refusing loudly is the honest third option.
    const WS: WorkspaceKey = { landscapeId: 'fence-no-row', versionId: 'v1' }
    await pool!.query(
      `DELETE FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    await expect(claimLifecycleWriteFence(pool!, WS)).rejects.toThrow(/no\s+read_model_projection_state row/)
    // And it did not create one on the way out.
    const { rows } = await pool!.query(
      `SELECT 1 FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    expect(rows).toHaveLength(0)

    // CONTROL: with the row present the same call succeeds, so the rejection
    // above is about the missing row and not about the statement being broken.
    await seedState(WS, 'projector-A')
    await expect(claimLifecycleWriteFence(pool!, WS)).resolves.toMatch(/^lifecycle:promote:/)
  })

  it('a static publish HOLDS the workspace row, so a demotion waits for it', async () => {
    // The other direction, and it needs no fence: static authority is a row
    // that EXISTS, and an existing row can be locked. `assertReadModelPlane`
    // takes it in key share for the publish's whole transaction, which is what
    // turns its start-of-transaction verdict into a guarantee that holds to the
    // commit.
    const WS: WorkspaceKey = { landscapeId: 'fence-plane-lock', versionId: 'v1' }
    await pool!.query(
      `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
       VALUES ($1, $2, 'promoted')
       ON CONFLICT (landscape_id, version_id) DO NOTHING`,
      [WS.landscapeId, WS.versionId],
    )

    const publish = await pool!.connect()
    try {
      await publish.query('BEGIN')
      await assertReadModelPlane(publish, WS, 'static')

      let demotionSettled = false
      const demotion = (async () => {
        const client = await pool!.connect()
        try {
          // The demotion's real order: the workspace row FIRST.
          await client.query(
            'DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
            [WS.landscapeId, WS.versionId],
          )
        } finally {
          client.release()
        }
      })().then(() => { demotionSettled = true })

      await new Promise((r) => setTimeout(r, 350))
      // Without FOR KEY SHARE the plane check holds nothing and this has landed.
      expect(demotionSettled).toBe(false)

      await publish.query('COMMIT')
      await demotion
      expect(demotionSettled).toBe(true)
    } finally {
      await publish.query('ROLLBACK').catch(() => undefined)
      publish.release()
    }

    // And a publish BEGINNING after the demotion committed refuses at its
    // fourth statement, having written nothing.
    const late = await pool!.connect()
    try {
      await late.query('BEGIN')
      await expect(assertReadModelPlane(late, WS, 'static')).rejects.toThrow(ReadModelPlaneError)
      await late.query('ROLLBACK')
    } finally {
      late.release()
    }
  }, 30_000)

  it('the projection mutex is what closes the phantom-row window — measured both ways', async () => {
    // Under READ COMMITTED, a blanket
    // DELETE keeps its statement snapshot while blocked, so a pure INSERT a
    // concurrent transaction commits mid-build survives a full rebuild. The
    // fence cannot see it (the straggler's assert ran before the claim
    // committed). This replays both halves against the real database on a
    // scratch table — same statement shapes, no coupling to ro_* columns:
    // WITHOUT the mutex the phantom survives; WITH it, transactions
    // serialize and the rebuild sees (and removes) the straggler's row.
    await pool!.query(`CREATE TABLE IF NOT EXISTS rmfence_probe (id TEXT PRIMARY KEY)`)
    await pool!.query(`TRUNCATE rmfence_probe`)
    await pool!.query(`INSERT INTO rmfence_probe (id) VALUES ('o1'), ('o2')`)
    const LOCK_KEY = 'read-model-projection:fence-ls5:v1'
    const lockSql = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'

    // WITHOUT the mutex: the phantom survives the rebuild.
    const straggler = await pool!.connect()
    const takeover = await pool!.connect()
    try {
      await straggler.query('BEGIN')
      await straggler.query(`INSERT INTO rmfence_probe (id) VALUES ('phantom')`)
      await takeover.query('BEGIN')
      // The blanket DELETE: takes its snapshot NOW; the uncommitted INSERT is
      // invisible and locks nothing this DELETE needs, so it does not block.
      await takeover.query(`DELETE FROM rmfence_probe`)
      await straggler.query('COMMIT')
      await takeover.query(`INSERT INTO rmfence_probe (id) VALUES ('o1'), ('o2')`)
      await takeover.query('COMMIT')
      const { rows: phantomRows } = await pool!.query(`SELECT id FROM rmfence_probe ORDER BY id`)
      expect(phantomRows.map((r: { id: string }) => r.id)).toEqual(['o1', 'o2', 'phantom'])

      // WITH the mutex: the takeover waits for the whole straggler
      // transaction, its DELETE sees the phantom, and the rebuild is clean.
      await pool!.query(`TRUNCATE rmfence_probe`)
      await pool!.query(`INSERT INTO rmfence_probe (id) VALUES ('o1'), ('o2')`)
      await straggler.query('BEGIN')
      await straggler.query(lockSql, [LOCK_KEY])
      await straggler.query(`INSERT INTO rmfence_probe (id) VALUES ('phantom')`)
      await takeover.query('BEGIN')
      let takeoverEntered = false
      const takeoverRun = (async () => {
        await takeover.query(lockSql, [LOCK_KEY])
        takeoverEntered = true
        await takeover.query(`DELETE FROM rmfence_probe`)
        await takeover.query(`INSERT INTO rmfence_probe (id) VALUES ('o1'), ('o2')`)
        await takeover.query('COMMIT')
      })()
      await new Promise((r) => setTimeout(r, 300))
      expect(takeoverEntered).toBe(false)
      await straggler.query('COMMIT')
      await takeoverRun
      const { rows: cleanRows } = await pool!.query(`SELECT id FROM rmfence_probe ORDER BY id`)
      expect(cleanRows.map((r: { id: string }) => r.id)).toEqual(['o1', 'o2'])
    } finally {
      await straggler.query('ROLLBACK').catch(() => undefined)
      await takeover.query('ROLLBACK').catch(() => undefined)
      straggler.release()
      takeover.release()
      await pool!.query(`DROP TABLE IF EXISTS rmfence_probe`)
    }
  }, 30_000)
})
