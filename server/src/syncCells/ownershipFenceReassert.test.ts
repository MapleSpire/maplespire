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

import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { RedisRuntime } from '../runtime/redis.js'
import {
  SyncCellOwnershipCoordinator,
  type SyncCellOwnershipConfig,
} from './ownership.js'

/**
 * The fence reassertion survey (`reassertHeldFences`), DETECTION half, at the
 * predicate level.
 *
 * The integration bench `ownershipFenceWedge.integration.test.ts` proves the
 * counter reads 1 against a real restore on a real database. This file covers
 * what a bench with one fixture cannot reach: the branch where the reading
 * FAILS, the branch where the lease set changes under the reading, the sides of
 * the divergence, and the CALL SITE — the `performReconcile` cases at the
 * bottom, so that deleting it fails a non-DB-gated test too.
 *
 * The fake pool is keyed on the SHAPE of the parameters rather than on the text
 * of the query: a text guard would go red on a semantically identical SQL
 * rewrite, making the harness a false-red generator for the next person with a
 * legitimate reason to touch that statement.
 */

const WORKSPACE_A = { landscapeId: 'landscape-1', versionId: 'version-a' }
const WORKSPACE_B = { landscapeId: 'landscape-1', versionId: 'version-b' }

/** Mirrors `workspaceKey` in ownership.ts, separator included. The separator is
 * written as an ESCAPE and never as the byte: a literal NUL in a source file is
 * invisible to lint, tsc and vitest when keys and lookups are corrupted
 * consistently. */
const key = (workspace: { landscapeId: string; versionId: string }): string =>
  `${workspace.landscapeId}\u0000${workspace.versionId}`

interface DurableRow {
  landscape_id: string
  version_id: string
  fencing_token: string
  cell_id: string
  released: boolean
}

interface Recorded {
  text: string
  values: unknown[]
}

function config(overrides: Partial<SyncCellOwnershipConfig> = {}): SyncCellOwnershipConfig {
  return {
    enabled: true,
    cellId: 'cell-a',
    advertiseUrl: 'http://cell.internal:3001',
    leaseTtlMs: 15_000,
    renewIntervalMs: 5_000,
    partitionLeaseTtlMs: 1_500,
    partitionRenewIntervalMs: 400,
    partitionProbeIntervalMs: 100,
    partitionWorker: false,
    reconcileIntervalMs: 300_000,
    telemetryIntervalMs: 300_000,
    reconcilePassDeadlineMs: 300_000,
    concurrency: 4,
    admissionConcurrency: 4,
    partitionCount: 1,
    topologyGeneration: 'v1',
    ...overrides,
  } as SyncCellOwnershipConfig
}

/** The reassertion query is the one taking two ARRAYS. Recognising it by shape
 * rather than by its text is deliberate — see the header. */
const isReassertQuery = (values: unknown[] | undefined): boolean =>
  Array.isArray(values) && values.length === 2
  && Array.isArray(values[0]) && Array.isArray(values[1])

interface Harness {
  pool: Pool
  queries: Recorded[]
  reassertCalls: number
}

/**
 * The reassertion query, selected by shape — never `queries.at(-1)`.
 *
 * `at(-1)` would make assertions vacuous: `snapshot()` prunes expired leases
 * and `markReleased` issues an UPDATE, so the last query is often not the one
 * under test. Reading `values[1]` off that UPDATE gives a plain string, and
 * `expect(string).not.toContain(...)` is a substring test that passes on almost
 * anything.
 */
function reassertQuery(harness: Harness): Recorded {
  const found = harness.queries.filter((query) => isReassertQuery(query.values))
  expect(found, 'no reassertion query was issued at all').not.toHaveLength(0)
  return found.at(-1)!
}

/**
 * A pool that answers the reassertion query and records everything.
 *
 * `answers` is consumed one per reassertion call, the last repeating, so a test
 * can make the second reading fail after the first succeeded. Any non-reassert
 * query is recorded and answered emptily rather than rejected: `performReconcile`
 * legitimately issues several, and a harness that throws on them would be
 * testing the harness.
 */
function durablePool(answers: Array<DurableRow[] | Error>, versions: Array<{ landscape_id: string; id: string }> = []): Harness {
  const harness: Harness = { pool: null as unknown as Pool, queries: [], reassertCalls: 0 }
  harness.pool = {
    async query(text: string, values?: unknown[]) {
      harness.queries.push({ text, values: values ?? [] })
      if (isReassertQuery(values)) {
        const answer = answers[Math.min(harness.reassertCalls, answers.length - 1)]!
        harness.reassertCalls += 1
        if (answer instanceof Error) throw answer
        return { rows: answer, rowCount: answer.length }
      }
      if (text.includes('FROM versions')) return { rows: versions, rowCount: versions.length }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as Pool
  return harness
}

const IDLE_REDIS = {
  configured: true,
  ready: true,
  prefix: 'test',
  async send() { throw new Error('the reassertion path must not reach Redis') },
} as unknown as RedisRuntime

interface Lease {
  workspace: typeof WORKSPACE_A
  token: string
  ownerValue: string
  validUntil: number
}

interface Internals {
  leases: Map<string, Lease>
  expected: Map<string, typeof WORKSPACE_A>
  partitionLease: { partition: number; ownerValue: string; token: string; validUntil: number } | null
  topologyConfirmed: boolean
  reassertHeldFences: () => Promise<void>
  performReconcile: () => Promise<void>
}

function coordinatorHolding(
  pool: Pool,
  held: Array<{ workspace: typeof WORKSPACE_A; token: string; validUntil?: number }>,
  clock?: () => number,
): { coordinator: SyncCellOwnershipCoordinator; internals: Internals } {
  const coordinator = new SyncCellOwnershipCoordinator(pool, IDLE_REDIS, config(), clock ?? Date.now)
  const internals = coordinator as unknown as Internals
  // This helper simulates a cell that has already STARTED — it seeds the leases
  // and the expected set that only a completed boot would hold. The pass
  // re-asks the topology contract whenever it is unconfirmed, so a fixture
  // that did not also confirm it would send `IDLE_REDIS` a command and fail for
  // a reason that has nothing to do with the reassertion under test. Confirming
  // it here keeps the fixture's story true rather than working around the check.
  internals.topologyConfirmed = true
  // An admitted workspace also has live partition authority: the pure
  // snapshot does not present orphaned physical entries as owned leases.
  internals.partitionLease = {
    partition: 0, ownerValue: 'cell-a|1|http://cell.internal:3001', token: '1',
    validUntil: (clock ?? Date.now)() + 60_000,
  }
  for (const lease of held) {
    internals.leases.set(key(lease.workspace), {
      workspace: lease.workspace,
      token: lease.token,
      // THREE parts, matching this fixture's `topologyGeneration: 'v1'`. Every
      // workspace owner value Redis holds ends in the generation,
      // so a two-part fixture models a state no acquire path can produce.
      ownerValue: `cell-a|${lease.token}|v1`,
      validUntil: lease.validUntil ?? Date.now() + 60_000,
    })
    internals.expected.set(key(lease.workspace), lease.workspace)
  }
  return { coordinator, internals }
}

const row = (
  workspace: typeof WORKSPACE_A,
  fencing_token: string,
  overrides: Partial<DurableRow> = {},
): DurableRow => ({
  landscape_id: workspace.landscapeId,
  version_id: workspace.versionId,
  fencing_token,
  cell_id: 'cell-a',
  released: false,
  ...overrides,
})

const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

/**
 * Run something with `console.warn` silenced and return the JSON lines it
 * emitted.
 *
 * The capture has to happen BEFORE `mockRestore()`, which clears
 * `mock.calls` as well as restoring the original — reading them afterwards
 * yields an empty array, and an assertion written that way passes on any
 * implementation that emits nothing at all.
 */
async function warningsFrom(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const warn = quiet()
  try {
    await run()
    return warn.mock.calls
      .map(([line]) => { try { return JSON.parse(String(line)) as Record<string, unknown> } catch { return null } })
      .filter((value): value is Record<string, unknown> => value !== null)
  } finally {
    warn.mockRestore()
  }
}

describe('reassertHeldFences — R1 detection', () => {
  it('counts nothing when every durable row agrees with the live token', async () => {
    const harness = durablePool([[row(WORKSPACE_A, '7'), row(WORKSPACE_B, '9')]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '7' },
      { workspace: WORKSPACE_B, token: '9' },
    ])
    const healthy = await warningsFrom(() => internals.reassertHeldFences())
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(0)
    // NEITHER summary line is emitted, and this is not a stylistic assertion.
    // Relaxing the foreign summary's gate from `> 0` to `>= 0` would print a
    // "two cells own this workspace" warning on every reconcile tick of every
    // healthy cell in the fleet — alert fatigue, in the log stream instead of
    // the pager — and only this assertion would notice.
    expect(healthy.map((line) => line.event)).toEqual([])
    // One query for two leases. `performReconcile` must scale to 10 000
    // versions, so an N+1 here is a defect and not a style question —
    // and it is invisible to a count assertion alone.
    expect(harness.reassertCalls).toBe(1)
    // The two arrays are POSITIONAL. Swapping them is caught by the integration
    // bench, but an over-broad join — dropping the version predicate, so a
    // landscape with 10 000 versions becomes an N x M scan every tick — is not
    // caught by a call count, which counts calls and not rows.
    const [landscapes, versions] = reassertQuery(harness).values as [string[], string[]]
    expect(landscapes).toEqual(['landscape-1', 'landscape-1'])
    expect(versions).toEqual(['version-a', 'version-b'])
    // Both halves of the key, asserted narrowly. A fake pool answers a fixed
    // row list whatever the SQL says, so dropping `AND o.version_id = ...`
    // changes nothing it can observe — while against a real table it turns the
    // lookup into an N x M scan over every version of the landscape, on every
    // reconcile tick, which is exactly the cost the "ONE query" paragraph
    // exists to bound. Two needles rather than the whole statement: pinning the
    // text wholesale makes this a false-red generator for the next legitimate
    // rewrite of that SQL.
    const sql = reassertQuery(harness).text
    expect(sql).toMatch(/w\.landscape_id/)
    expect(sql).toMatch(/w\.version_id/)
  })

  it('counts leases, not expectations, and not leases it is about to prune', async () => {
    // `expected` and `leases` differ in PERMANENCE, not transiently — a
    // workspace this cell should own but has not admitted yet is in one and not
    // the other, and it has no live token to compare anything against. An
    // expired lease is the mirror image: still in the map until the next prune,
    // already not owned.
    const EXPECTED_ONLY = { landscapeId: 'landscape-1', versionId: 'version-expected-only' }
    const EXPIRED = { landscapeId: 'landscape-1', versionId: 'version-expired' }
    const harness = durablePool([[row(WORKSPACE_A, '1'), row(EXPECTED_ONLY, '1'), row(EXPIRED, '1')]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '2' },
      { workspace: EXPIRED, token: '2', validUntil: Date.now() - 1_000 },
    ])
    internals.expected.set(key(EXPECTED_ONLY), EXPECTED_ONLY)

    const lines = await warningsFrom(() => internals.reassertHeldFences())
    // Two leases are in the map when the reading is taken, so both are read.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBeNull()
    // The pure reader refuses to present that survey as a count of live
    // authority: two physical entries were surveyed, but only one is live.
    // Cleanup belongs to reconciliation; this read leaves both entries intact.
    expect(coordinator.snapshot().ownedWorkspaceCount).toBe(1)
    expect(internals.leases.size).toBe(2)
    expect(lines.filter((line) => line.event === 'sync.cell.fence_divergence')
      .map((line) => line.versionId).sort()).toEqual(['version-a', 'version-expired'])
    // The workspace that is merely EXPECTED was never read: it has no lease and
    // therefore no live token, so there is nothing to compare.
    const [, versions] = reassertQuery(harness).values as [string[], string[]]
    expect(versions).not.toContain('version-expected-only')
  })

  it('counts exactly the workspaces the mutation gate would refuse, and says which', async () => {
    // `valid_fence` admits on `fencing_token = $token AND released_at IS NULL`;
    // a lower token, a released row and an absent row are all refusals, and a
    // different cell_id at the same token is NOT one.
    const HEALTHY = { landscapeId: 'landscape-1', versionId: 'version-healthy' }
    const LOWER = { landscapeId: 'landscape-1', versionId: 'version-lower' }
    const RELEASED = { landscapeId: 'landscape-1', versionId: 'version-released' }
    const ABSENT = { landscapeId: 'landscape-1', versionId: 'version-absent' }
    const OTHER_CELL = { landscapeId: 'landscape-1', versionId: 'version-other-cell' }
    const HIGHER = { landscapeId: 'landscape-1', versionId: 'version-higher' }
    const harness = durablePool([[
      row(HEALTHY, '4'),
      row(LOWER, '3'),
      row(RELEASED, '4', { released: true }),
      row(OTHER_CELL, '4', { cell_id: 'cell-b' }),
      row(HIGHER, '5'),
      // A row for a workspace this cell does NOT hold. The join is supposed to
      // be driven by the held set; counting it would mean the number describes
      // the table rather than this cell.
      row({ landscapeId: 'landscape-1', versionId: 'version-not-held' }, '1'),
    ]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: HEALTHY, token: '4' },
      { workspace: LOWER, token: '4' },
      { workspace: RELEASED, token: '4' },
      { workspace: ABSENT, token: '4' },
      { workspace: OTHER_CELL, token: '4' },
      { workspace: HIGHER, token: '4' },
    ])
    const lines = await warningsFrom(() => internals.reassertHeldFences())
    const snapshot = coordinator.snapshot()
    expect(snapshot.fenceDivergencesSeen).toBe(4)
    expect(snapshot.fenceDivergenceByCause).toEqual({
      belowLive: 1, aboveLive: 1, released: 1, absent: 1, foreignCellAtSameToken: 1,
    })

    // The REPAIR half, through this fake. TWO of the four causes are
    // repairable — `absent` and `belowLive` — so two attempts are made, and
    // this pool answers every write with `rowCount: 0`, which is exactly what
    // `persistLease` treats as "the durable token is newer than the acquired
    // one" and throws on. So: nothing repaired, two FAILURES, two errors.
    //
    // The failure count is asserted separately from `errorCount` so that
    // crediting a failed repair as a success is caught — "a repair that keeps
    // failing" is the interesting number, and folding it into an aggregate
    // hides it.
    expect(snapshot.fenceRepairCount).toBe(0)
    expect(snapshot.fenceRepairFailureCount).toBe(2)
    expect(snapshot.errorCount).toBe(2)

    // The count says HOW MANY. Only the log line says WHICH, and this is the
    // assertion that catches deleting the whole warn block.
    const emitted = lines.filter((line) => line.event === 'sync.cell.fence_divergence')
    expect(emitted.map((line) => line.versionId).sort()).toEqual(
      ['version-absent', 'version-higher', 'version-lower', 'version-released'],
    )
    const lower = emitted.find((line) => line.versionId === 'version-lower')
    expect(lower).toMatchObject({ liveToken: '4', durableToken: '3', durableReleased: false })
    const absent = emitted.find((line) => line.versionId === 'version-absent')
    expect(absent).toMatchObject({ liveToken: '4', durableToken: null, durableReleased: null })
  })

  it('caps the per-workspace lines and carries the total on a summary line', async () => {
    // The triggering event (a restore) lowers EVERY row at once.
    const workspaces = Array.from({ length: 9 }, (unused, index) => ({
      landscapeId: 'landscape-1', versionId: `version-${index}`,
    }))
    const harness = durablePool([workspaces.map((workspace) => row(workspace, '1'))])
    const { coordinator, internals } = coordinatorHolding(
      harness.pool,
      workspaces.map((workspace) => ({ workspace, token: '2' })),
    )
    const lines = await warningsFrom(() => internals.reassertHeldFences())
    expect(lines.filter((line) => line.event === 'sync.cell.fence_divergence')).toHaveLength(5)
    const summary = lines.filter((line) => line.event === 'sync.cell.fence_divergence_summary')
    expect(summary).toHaveLength(1)
    expect(summary[0]).toMatchObject({ diverged: 9, heldLeases: 9, suppressedDetailLines: 4 })
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(9)
  })

  it('WARNS about a foreign cell at our own token — the one cause that refuses nothing', async () => {
    // Every other cause here ends in a refused write with reason
    // `fence-mismatch`, which an operator eventually meets as a user complaint.
    // This one does not: `valid_fence` admits on
    // `fencing_token = $2 AND released_at IS NULL` and does NOT look at
    // `cell_id`, so the write goes THROUGH and two cells are writing the same
    // workspace at the same token. It is the most serious state this survey
    // can observe
    // and the only one with no symptom of its own.
    //
    // So the assertions here are deliberately NOT about a refusal — asserting
    // one would measure the wrong thing and would go green on an implementation
    // that had folded this into the divergence total.
    const FOREIGN = { landscapeId: 'landscape-1', versionId: 'version-foreign' }
    const harness = durablePool([[row(WORKSPACE_A, '4'), row(FOREIGN, '4', { cell_id: 'cell-b' })]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '4' },
      { workspace: FOREIGN, token: '4' },
    ])
    const lines = await warningsFrom(() => internals.reassertHeldFences())
    const snapshot = coordinator.snapshot()

    // NOT a divergence. Folding the cause into the total would make this 1 and would also make the summary line below appear.
    expect(snapshot.fenceDivergencesSeen).toBe(0)
    expect(snapshot.fenceDivergenceByCause).toEqual({
      belowLive: 0, aboveLive: 0, released: 0, absent: 0, foreignCellAtSameToken: 1,
    })
    // ...and NOT repaired. There is no local repair: this cell cannot tell
    // whether it or the other one is the stale believer, and `persistLease`
    // would overwrite the name and destroy the evidence.
    expect(snapshot.fenceRepairCount).toBe(0)
    expect(snapshot.fenceRepairFailureCount).toBe(0)
    expect(snapshot.errorCount).toBe(0)

    // The line, naming BOTH cells and the token. Without those three fields an
    // operator has a count and no way to act on it.
    const foreign = lines.filter((line) => line.event === 'sync.cell.fence_foreign_cell')
    expect(foreign).toHaveLength(1)
    expect(foreign[0]).toMatchObject({
      versionId: 'version-foreign',
      cellId: 'cell-a',
      durableCellId: 'cell-b',
      token: '4',
    })
    // Its OWN summary, on its OWN gate. `diverged` is zero here, so a summary
    // folded into the divergence block would never be emitted in the ordinary
    // shape of this incident — which is precisely this shape.
    expect(lines.filter((line) => line.event === 'sync.cell.fence_foreign_cell_summary')).toHaveLength(1)
    expect(lines.filter((line) => line.event === 'sync.cell.fence_divergence_summary')).toHaveLength(0)
    expect(lines.filter((line) => line.event === 'sync.cell.fence_divergence')).toHaveLength(0)
  })

  it('caps the foreign-cell lines on their OWN budget, not one shared with divergences', async () => {
    // A restore lowers every row at once. If the two line kinds shared a budget,
    // the divergences it produces would consume all five slots and the one line
    // saying two cells own the same workspace would never be printed — the
    // signal drowned by the noise, in the pass that saw both.
    //
    // THE COUNTS ARE CHOSEN SO THE TWO BUDGETS CANNOT COINCIDE. With both sides
    // capped at 5, `7 - foreignLogged` and `7 - logged` would be the same number
    // and swapping them would go unnoticed. Here the foreign side is capped
    // (12 -> 5) and the divergence side is NOT (2 -> 2), so the two differ.
    const diverging = Array.from({ length: 2 }, (unused, index) => ({
      landscapeId: 'landscape-1', versionId: `version-low-${index}`,
    }))
    const foreign = Array.from({ length: 12 }, (unused, index) => ({
      landscapeId: 'landscape-1', versionId: `version-foreign-${index}`,
    }))
    const harness = durablePool([[
      ...diverging.map((workspace) => row(workspace, '1')),
      ...foreign.map((workspace) => row(workspace, '2', { cell_id: 'cell-b' })),
    ]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      ...diverging.map((workspace) => ({ workspace, token: '2' })),
      ...foreign.map((workspace) => ({ workspace, token: '2' })),
    ])
    const lines = await warningsFrom(() => internals.reassertHeldFences())

    expect(lines.filter((line) => line.event === 'sync.cell.fence_divergence')).toHaveLength(2)
    expect(lines.filter((line) => line.event === 'sync.cell.fence_foreign_cell')).toHaveLength(5)
    const summary = lines.filter((line) => line.event === 'sync.cell.fence_foreign_cell_summary')
    expect(summary).toHaveLength(1)
    expect(summary[0]).toMatchObject({
      foreignCellAtSameToken: 12,
      examinedLeases: 14,
      // 12 - 5. Reading `logged` (2) instead of `foreignLogged` (5) gives 10,
      // which this fixture distinguishes.
      suppressedDetailLines: 7,
    })
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(2)
  })

  it('the two summary lines carry DIFFERENT denominators, and each carries its own', async () => {
    // `reassertHeldFences` states in a comment that `examined` — held minus the
    // leases that left the map during the survey's await — "is the denominator,
    // and neither `held.length` nor `this.leases.size` is". A test where
    // `examined === held.length` cannot tell the two fields apart.
    //
    // So: make them differ. One lease is removed from the map WHILE the survey's
    // await is in flight, so the pass holds three and examines two — and the
    // divergence summary must say 3 held / 2 examined, not 3 / 3 or 2 / 2.
    const DEPARTING = { landscapeId: 'landscape-1', versionId: 'version-departing' }
    const FOREIGN = { landscapeId: 'landscape-1', versionId: 'version-foreign' }
    const harness = durablePool([[
      row(WORKSPACE_A, '1'),
      row(DEPARTING, '1'),
      row(FOREIGN, '4', { cell_id: 'cell-b' }),
    ]])
    const { internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '4' },
      { workspace: DEPARTING, token: '4' },
      { workspace: FOREIGN, token: '4' },
    ])
    // Removed AFTER the query is issued and before the loop reads it — the same
    // window `releaseLease` and `loseLease` really use.
    const survey = internals.reassertHeldFences()
    internals.leases.delete(key(DEPARTING))
    const lines = await warningsFrom(async () => { await survey })

    const divergence = lines.find((line) => line.event === 'sync.cell.fence_divergence_summary')
    expect(divergence, 'no divergence summary was emitted — the arm proves nothing').toBeDefined()
    expect(divergence).toMatchObject({ heldLeases: 3, examinedLeases: 2, diverged: 1 })
    const foreignSummary = lines.find((line) => line.event === 'sync.cell.fence_foreign_cell_summary')
    expect(foreignSummary, 'no foreign summary was emitted').toBeDefined()
    // The foreign summary carries EXAMINED, never `held.length`: it is a
    // statement about the leases this pass actually looked at.
    expect(foreignSummary).toMatchObject({ examinedLeases: 2, foreignCellAtSameToken: 1 })
  })

  it('thins the foreign DETAIL lines in time, because that cause is never repaired', async () => {
    // The per-pass cap bounds one pass. This cause has no repair, so the
    // condition persists until an operator acts — five lines every
    // `reconcileIntervalMs` is ~104 000 lines a day per cell for a fact the
    // telemetry line already carries once a minute and that now has a
    // page-severity rule of its own.
    //
    // NOT an edge detector: the SUMMARY still fires on every pass, so the
    // condition stays continuously visible and only the detail is thinned. An
    // edge would make it invisible to anyone who joined after it started.
    const FOREIGN = { landscapeId: 'landscape-1', versionId: 'version-foreign' }
    const harness = durablePool([[row(FOREIGN, '4', { cell_id: 'cell-b' })]])
    let clock = 1_000_000
    const { internals } = coordinatorHolding(
      harness.pool,
      [{ workspace: FOREIGN, token: '4' }],
      () => clock,
    )

    const first = await warningsFrom(() => internals.reassertHeldFences())
    expect(first.filter((line) => line.event === 'sync.cell.fence_foreign_cell')).toHaveLength(1)

    // One reconcile interval later — far inside the 300 s telemetry interval
    // this suite configures.
    clock += 5_000
    const second = await warningsFrom(() => internals.reassertHeldFences())
    expect(second.filter((line) => line.event === 'sync.cell.fence_foreign_cell')).toHaveLength(0)
    // ...and the condition is STILL reported. This is the assertion that
    // separates thinning from suppressing.
    const summary = second.filter((line) => line.event === 'sync.cell.fence_foreign_cell_summary')
    expect(summary).toHaveLength(1)
    expect(summary[0]).toMatchObject({ foreignCellAtSameToken: 1, suppressedDetailLines: 1 })

    // Past the telemetry interval, the detail comes back — a burst budget, not
    // a one-shot latch that goes quiet for the life of the process.
    clock += 300_000
    const third = await warningsFrom(() => internals.reassertHeldFences())
    expect(third.filter((line) => line.event === 'sync.cell.fence_foreign_cell')).toHaveLength(1)
  })

  it('compares tokens as strings, so two BIGINTs one apart stay one apart', async () => {
    // `Number('9007199254740993') === Number('9007199254740992')` is TRUE: both
    // are the same double. node-pg returns BIGINT as a string and the predicate
    // keeps it that way; nothing but this test holds it there.
    const harness = durablePool([[row(WORKSPACE_A, '9007199254740992')]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '9007199254740993' },
    ])
    const warn = quiet()
    try {
      await internals.reassertHeldFences()
    } finally {
      warn.mockRestore()
    }
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(1)
    expect(coordinator.snapshot().fenceDivergenceByCause).toMatchObject({ belowLive: 1 })
  })

  it('reports null rather than zero when the reading itself fails', async () => {
    const harness = durablePool([new Error('connection terminated unexpectedly')])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '7' },
    ])
    const warn = quiet()
    try {
      // Fail-safe: a detector must not be able to stop the pass it observes.
      await expect(internals.reassertHeldFences()).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
    }
    const snapshot = coordinator.snapshot()
    // Not zero. Zero is the claim "every held fence agrees", and this pass has
    // no standing to make it.
    expect(snapshot.fenceDivergencesSeen).toBeNull()
    expect(snapshot.fenceDivergenceByCause).toBeNull()
    // And not silent: the failure is counted on the same telemetry line.
    expect(snapshot.errorCount).toBe(1)
  })

  it('does not leave a stale count behind after a failed reading', async () => {
    const harness = durablePool([
      [row(WORKSPACE_A, '3'), row(WORKSPACE_B, '3')],
      new Error('connection terminated unexpectedly'),
    ])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '7' },
      { workspace: WORKSPACE_B, token: '9' },
    ])
    const first = quiet()
    try {
      await internals.reassertHeldFences()
    } finally {
      first.mockRestore()
    }
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(2)
    const second = quiet()
    try {
      await internals.reassertHeldFences()
    } finally {
      second.mockRestore()
    }
    expect(coordinator.snapshot().fenceDivergencesSeen).toBeNull()
  })

  it('attempts no repair once the coordinator has begun stopping', async () => {
    // The guard at the top of the method covers a pass that STARTS during
    // shutdown. This is the other half: a pass already in flight when `stop()`
    // is called. Writing to the durable table while the coordinator is
    // releasing its leases is how a repair races the release and re-acquires a
    // workspace nobody holds — and no other test puts the two in the same
    // window.
    const rows = [row(WORKSPACE_A, '1')] // belowLive against token 7: repairable
    let queries = 0
    const internalsHolder: { internals?: Internals } = {}
    const pool = {
      async query(text: string, values?: unknown[]) {
        queries += 1
        if (isReassertQuery(values)) {
          // Shutdown lands between the survey and the loop, which is the only
          // window this can be tested in.
          ;(internalsHolder.internals as unknown as { stopping: boolean }).stopping = true
          return { rows, rowCount: rows.length }
        }
        if (text.includes('INSERT INTO sync_workspace_ownership')) {
          throw new Error('a repair was attempted during shutdown')
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Pool
    const { coordinator, internals } = coordinatorHolding(pool, [{ workspace: WORKSPACE_A, token: '7' }])
    internalsHolder.internals = internals

    const lines = await warningsFrom(() => internals.reassertHeldFences())

    // The pass ABANDONS. It does not repair, it does not warn, and it does not
    // publish — the `if (this.stopping) return` after the survey's await gets
    // there first. That was written for a different reason (a pass still in
    // flight when `stop()` returns must not write a count after the final
    // telemetry line) and it is what protects the repair too, which is why the
    // repair carries no `stopping` condition of its own (it would be dead code).
    expect(coordinator.snapshot().fenceDivergencesSeen).toBeNull()
    expect(lines.filter((line) => line.event === 'sync.cell.fence_divergence')).toEqual([])
    // Nothing written, and the INSERT that would have thrown was never issued —
    // `queries` counts only the survey.
    expect(coordinator.snapshot().fenceRepairCount).toBe(0)
    expect(coordinator.snapshot().fenceRepairFailureCount).toBe(0)
    expect(coordinator.snapshot().errorCount).toBe(0)
    expect(queries).toBe(1)
  })

  it('asks the database nothing when it holds no lease, and says so as zero', async () => {
    // Zero held leases is genuinely "no held fence disagrees" — the one case
    // where a zero without a reading is honest. It must also not send a query
    // with two empty arrays, which on a large table is a scan for no rows.
    const harness = durablePool([[]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [])
    await internals.reassertHeldFences()
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(0)
    expect(harness.reassertCalls).toBe(0)
  })
})

describe('reassertHeldFences — the reading cannot outlive the set it describes', () => {
  it('publishes null once the held set has changed since the reading', async () => {
    // `performReconcile` returns early when the partition is not live,
    // releasing every lease and never reaching the reassertion, so without this
    // guard a cell owning NOTHING would go on publishing a divergence count for
    // ever. The guard is a denominator, not a null written at each site that
    // empties the map — there are several such sites and an enumeration goes
    // stale.
    const harness = durablePool([[row(WORKSPACE_A, '1'), row(WORKSPACE_B, '9')]])
    const { coordinator, internals } = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '2' },
      { workspace: WORKSPACE_B, token: '9' },
    ])
    const warn = quiet()
    try {
      await internals.reassertHeldFences()
    } finally {
      warn.mockRestore()
    }
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(1)

    internals.leases.clear()
    expect(coordinator.snapshot().fenceDivergencesSeen).toBeNull()
    expect(coordinator.snapshot().fenceDivergenceByCause).toBeNull()
    expect(coordinator.snapshot().ownedWorkspaceCount).toBe(0)
  })

  it('does not count a lease that left the map while the query was in flight', async () => {
    // The three ways a lease leaves the map each write `released_at = NOW()` to
    // EXACTLY the row being compared, so without the post-await identity check
    // a clean shutdown produces one false divergence per lease — on the one
    // message an operator has to be able to trust.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pool = {
      async query(text: string, values?: unknown[]) {
        if (!isReassertQuery(values)) return { rows: [], rowCount: 0 }
        await gate
        return {
          rows: [row(WORKSPACE_A, '2', { released: true }), row(WORKSPACE_B, '9')],
          rowCount: 2,
        }
      },
    } as unknown as Pool
    const { coordinator, internals } = coordinatorHolding(pool, [
      { workspace: WORKSPACE_A, token: '2' },
      { workspace: WORKSPACE_B, token: '9' },
    ])
    const lines = await warningsFrom(async () => {
      const inFlight = internals.reassertHeldFences()
      // Exactly what `releaseLease` does, and the row it wrote is the one above.
      internals.leases.delete(key(WORKSPACE_A))
      release!()
      await inFlight
    })
    // One lease remains and it agrees, so the honest answer is zero — not the
    // one divergence the released row would otherwise have produced.
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(0)
    expect(lines.filter((line) => String(line.event).includes('fence_divergence'))).toEqual([])
  })
})

describe('reassertHeldFences — the call site', () => {
  /** Drives the real `performReconcile`, not the private method, so the single
   * production call site has a witness that does NOT need a database, so
   * deleting the call fails a run a developer makes locally. */
  function reconcilable(answers: Array<DurableRow[] | Error>) {
    const versions = [
      { landscape_id: WORKSPACE_A.landscapeId, id: WORKSPACE_A.versionId },
      { landscape_id: WORKSPACE_B.landscapeId, id: WORKSPACE_B.versionId },
    ]
    const harness = durablePool(answers, versions)
    const built = coordinatorHolding(harness.pool, [
      { workspace: WORKSPACE_A, token: '2' },
      { workspace: WORKSPACE_B, token: '9' },
    ])
    // A real partition lease, so `partitionIsLive()` and `ownsPartition()` hold
    // without reaching Redis. `partitionCount: 1` puts both workspaces on 0.
    built.internals.partitionLease = {
      partition: 0, ownerValue: 'cell-a|1', token: '1', validUntil: Date.now() + 60_000,
    }
    return { harness, ...built }
  }

  it('runs inside performReconcile, after the discovery query', async () => {
    const { harness, coordinator, internals } = reconcilable([[row(WORKSPACE_A, '1'), row(WORKSPACE_B, '9')]])
    const warn = quiet()
    try {
      await internals.performReconcile()
    } finally {
      warn.mockRestore()
    }
    expect(coordinator.snapshot().fenceDivergencesSeen).toBe(1)
    expect(harness.reassertCalls).toBe(1)
    // ORDER, not just presence. Moving the call ahead of `acquireMissing` and
    // `pruneExpired` leaves a workspace admitted by THIS pass uninspected until
    // the next one, and counts leases this pass is about to prune.
    const discovery = harness.queries.findIndex((query) => query.text.includes('FROM versions'))
    const reassert = harness.queries.findIndex((query) => isReassertQuery(query.values))
    expect(discovery).toBeGreaterThanOrEqual(0)
    expect(reassert).toBeGreaterThan(discovery)
  })

  it('leaves the count unknown when the pass returns before reaching it', async () => {
    const { coordinator, internals } = reconcilable([[row(WORKSPACE_A, '1'), row(WORKSPACE_B, '9')]])
    const warn = quiet()
    try {
      await internals.performReconcile()
      expect(coordinator.snapshot().fenceDivergencesSeen).toBe(1)
      // Exactly what losing Redis does: the partition stops being live, the
      // pass releases everything and returns at the top, never reaching the
      // reassertion. The published number must not survive that.
      internals.partitionLease = null
      internals.leases.clear()
    } finally {
      warn.mockRestore()
    }
    const snapshot = coordinator.snapshot()
    expect(snapshot.ownedWorkspaceCount).toBe(0)
    expect(snapshot.expectedWorkspaceCount).toBe(2)
    expect(snapshot.fenceDivergencesSeen).toBeNull()
  })
})
