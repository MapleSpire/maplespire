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

import { describe, expect, it } from 'vitest'
import {
  COMPACTION_JOB,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_MAX_WORKSPACE_OBJECTS,
  DEFAULT_WINDOW_CAP,
  compactionQueueEnabled,
  createCompactionQueue,
  type CompactionPassOutcome,
  type CompactionQueueDeps,
  type CompactionQueueSeam,
  type CompactionQueueWorkspace,
} from './compactionQueue.js'
import type { DueWorkClaim } from './dueWork.js'

/**
 * The four bounds, each stated as the regression ("MUTANT") a test must catch.
 *
 * WHY THE CONCURRENCY TEST DOES NOT ASK THE QUEUE HOW CONCURRENT IT WAS. The
 * queue could report a `maxObservedConcurrency` and this file could assert on
 * it, and that number would be the instrument reporting on its own subject —
 * the classic trap of a witness that cannot see the thing it witnesses. The count
 * here is taken by the INJECTED `compact`, which is the only party that knows
 * when a pass is actually running, and the queue is never asked.
 *
 * WHY `setTimeout(0)` AND NOT FAKE TIMERS. The property is "did the second unit
 * start before the first finished", which needs the two to have a real chance to
 * overlap. A fake clock the test advances by hand decides the interleaving
 * itself, so the mutant that removes the gate would still pass.
 */
describe('compaction queue (T-28f)', () => {
  const WS = (n: number): CompactionQueueWorkspace => ({ landscapeId: `land-${n}`, versionId: `ver-${n}` })
  const keyOf = (w: CompactionQueueWorkspace) => `${w.landscapeId}/${w.versionId}`

  interface Recorder {
    seam: CompactionQueueSeam
    enqueued: string[]
    claimLimits: number[]
    completed: string[]
    released: [string, string][]
    /** Every release, with the hold-back it asked for. `undefined` is
     *  "immediately", which is right for a policy refusal and wrong for a
     *  failure. */
    releaseDelays: (number | undefined)[]
    /** Every slot an enqueue was proposed for, so this suite (and not only the
     *  DB-gated file, which skips silently without a database) can check that
     *  the slot is quantized. */
    slots: string[]
  }

  /**
   * The queue table, in memory, behind the same seam the production adapter
   * implements. Deliberately NOT a fake that pattern-matches SQL text: that
   * tests the test's copy of the query. `dueWork.ts`'s real statements are
   * driven by `compactionQueue.integration.test.ts` against Postgres.
   */
  function memoryQueue(workspaces: CompactionQueueWorkspace[], attempts = 1): Recorder {
    const rows = new Map<string, DueWorkClaim>()
    const enqueued: string[] = []
    const claimLimits: number[] = []
    const completed: string[] = []
    const released: [string, string][] = []
    const releaseDelays: (number | undefined)[] = []
    const slots: string[] = []
    return {
      enqueued,
      claimLimits,
      completed,
      released,
      releaseDelays,
      slots,
      seam: {
        maintainable: async () => workspaces,
        // Rows only ever live in one slot here, so there is nothing older to
        // prune. The real thing is exercised in the integration file.
        prune: async () => 0,
        enqueue: async (workspace, slot) => {
          const id = keyOf(workspace)
          slots.push(slot.toISOString())
          if (rows.has(id)) return false
          rows.set(id, { job: COMPACTION_JOB, ...workspace, slot, attempts })
          enqueued.push(id)
          return true
        },
        claim: async (limit) => {
          claimLimits.push(limit)
          return [...rows.values()].slice(0, limit)
        },
        complete: async (claim) => {
          completed.push(keyOf(claim))
          rows.delete(keyOf(claim))
        },
        release: async (claim, error, retryAfterMs) => {
          released.push([keyOf(claim), error])
          releaseDelays.push(retryAfterMs)
        },
      },
    }
  }

  const compacted = (): CompactionPassOutcome =>
    ({ ran: true, objectsFolded: 2, connectionsFolded: 1, reattach: 'reattached' })

  /** Everything permissive, so each test turns exactly one thing hostile. */
  function deps(
    recorder: Recorder,
    overrides: Partial<CompactionQueueDeps> = {},
  ): CompactionQueueDeps {
    return {
      queue: recorder.seam,
      killSwitch: () => true,
      measure: async () => ({ objects: 10, connections: 5 }),
      preview: async () => ({ folded: 3, deleted: 0 }),
      compact: async () => compacted(),
      log: () => undefined,
      warn: () => undefined,
      ...overrides,
    }
  }

  // ── BOUND (i) ───────────────────────────────────────────────────────────────

  it('BOUND (i) — runs at most ONE compaction at a time on this cell', async () => {
    // MUTANT: in `tick()`, replace `gate.run(() => runUnit(claim))` with
    // `runUnit(claim)`. Both units then enter `compact` before either returns
    // and `maxInFlight` is 2.
    const recorder = memoryQueue([WS(1), WS(2)])
    let inFlight = 0
    let maxInFlight = 0
    const queue = createCompactionQueue(deps(recorder, {
      compact: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 0))
        inFlight -= 1
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(tick.compacted).toBe(2)
    expect(maxInFlight).toBe(1)
  })

  it('a pass that throws is released with its error, and the next unit still runs', async () => {
    // `runUnit` catches this one itself, so it is the RELEASE path that is
    // pinned here, not the gate — see the seam-throw test below for the gate.
    const recorder = memoryQueue([WS(1), WS(2)])
    let calls = 0
    const queue = createCompactionQueue(deps(recorder, {
      compact: async () => {
        calls += 1
        if (calls === 1) throw new Error('first unit exploded')
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(tick.failed).toBe(1)
    expect(tick.compacted).toBe(1)
    expect(recorder.released).toEqual([['land-1/ver-1', 'first unit exploded']])
  })

  it('BOUND (i) — a throw from the QUEUE SEAM fails one unit and the batch survives', async () => {
    // TWO MUTANTS, and the first is why this test exists at all. (1) In
    // `OneAtATime.run`, `this.tail = next.then(noop, noop)` -> `this.tail =
    // next`: the gate's tail is then rejected, every later unit resolves to that
    // same rejection WITHOUT BEING INVOKED, and workspace 2 is reported failed
    // having never been looked at. (2) Drop the `.catch` at the dispatch site:
    // `Promise.all` rejects, `tick()` throws, and the unit that had already
    // compacted is never reported — its row is gone and its counts with it.
    //
    // `measure` is the thrower on purpose: it is a round trip on the app pool
    // OUTSIDE `runUnit`'s own try, which is exactly the class of failure the
    // pass cannot catch for itself.
    const recorder = memoryQueue([WS(1), WS(2)])
    const compactedKeys: string[] = []
    const queue = createCompactionQueue(deps(recorder, {
      measure: async (workspace) => {
        if (workspace.landscapeId === 'land-1') throw new Error('statement timeout on ro_objects')
        return { objects: 1, connections: 0 }
      },
      compact: async (workspace) => {
        compactedKeys.push(keyOf(workspace))
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(tick.failed).toBe(1)
    expect(tick.units[0]).toMatchObject({ status: 'failed', error: 'statement timeout on ro_objects' })
    expect(compactedKeys).toEqual(['land-2/ver-2'])
    expect(tick.compacted).toBe(1)
    // THE ROW IS HANDED BACK. Asserting only the unit would miss a claim LEFT
    // IN PLACE — leased for fifteen minutes, invisible to every other cell, with
    // no `last_error`.
    // MUTANT: delete the `if (!settled)` block in `runUnit`'s `finally`.
    expect(recorder.released.map(([id]) => id)).toContain('land-1/ver-1')
    expect(recorder.completed).not.toContain('land-1/ver-1')
  })

  it('BOUND (i) — a unit that REJECTS is contained, and the next unit still runs', async () => {
    // `runUnit` is total (a throw from `measure`, `preview` or the queue seam
    // becomes a `failed` unit), so it never rejects on its own. The two things
    // that exist to survive a rejection — `OneAtATime`'s swallowing tail and the
    // dispatch-site `.catch` — need a way to be reached, or nothing tests them.
    //
    // `warn` is the injected way back in, and it is not a contrivance: it is
    // called from inside `runUnit`'s own `finally`, which is the one place a
    // throw still escapes. TWO MUTANTS die here: `this.tail = next.then(noop,
    // noop)` -> `this.tail = next` (unit 2 then resolves to unit 1's rejection
    // without ever being invoked), and deleting the dispatch `.catch`
    // (`Promise.all` rejects and the whole window's counts are lost).
    const recorder = memoryQueue([WS(1), WS(2)])
    const compactedKeys: string[] = []
    const queue = createCompactionQueue({
      ...deps(recorder),
      queue: {
        ...recorder.seam,
        release: async (claim, error, delay) => {
          if (claim.landscapeId === 'land-1') throw new Error('release failed too')
          return recorder.seam.release(claim, error, delay)
        },
      },
      warn: (message: string) => {
        if (message.includes('land-1')) throw new Error('the logger itself threw')
      },
      compact: async (workspace) => {
        if (workspace.landscapeId === 'land-1') throw new Error('unit one exploded')
        compactedKeys.push(keyOf(workspace))
        return compacted()
      },
    })

    const tick = await queue.tick()

    expect(tick.units[0]).toMatchObject({ status: 'failed' })
    expect(compactedKeys, 'unit 2 must have been INVOKED, not resolved to unit 1 rejection')
      .toEqual(['land-2/ver-2'])
    expect(tick.compacted).toBe(1)
  })

  it('the claim is handed back even when the FIRST hand-back fails', async () => {
    // MUTANT: `if (!settled)` -> `if (false)` in `runUnit`'s `finally`. The
    // `catch` releases, and the release marks the unit settled, so the guard is
    // only reachable when the release ITSELF fails — exactly its case: a
    // pool that has just timed out on the pass is a pool that can time out on
    // the book-keeping.
    const recorder = memoryQueue([WS(1)])
    let releaseAttempts = 0
    const queue = createCompactionQueue({
      ...deps(recorder),
      queue: {
        ...recorder.seam,
        release: async (claim, error, delay) => {
          releaseAttempts += 1
          if (releaseAttempts === 1) throw new Error('connection terminated during release')
          return recorder.seam.release(claim, error, delay)
        },
      },
      compact: async () => { throw new Error('the pass exploded') },
    })

    const tick = await queue.tick()

    expect(tick.failed).toBe(1)
    expect(releaseAttempts).toBe(2)
    // The row IS back. Without the guard it would sit leased for fifteen
    // minutes, invisible to every other cell, with no `last_error`.
    expect(recorder.released.map(([id]) => id)).toEqual(['land-1/ver-1'])
  })

  it('BOUND (i) — a second tick while one is running is REFUSED, not joined', async () => {
    // Joining would hand the second caller the first window's counts. The
    // refusal is what makes "how many did THIS window compact" answerable.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, {
      compact: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return compacted()
      },
    }))

    const first = queue.tick()
    const second = await queue.tick()

    expect(second.ran).toBe(false)
    expect(second.refused).toBe('tick_in_flight')
    expect(second.claimed).toBe(0)
    expect((await first).compacted).toBe(1)
  })

  // ── BOUND (ii) ──────────────────────────────────────────────────────────────

  it('BOUND (ii) — a window compacts at most `windowCap` workspaces', async () => {
    // MUTANT: pass `Number.MAX_SAFE_INTEGER` (or drop the argument's use) to
    // `deps.queue.claim`. All four are then claimed and compacted.
    const recorder = memoryQueue([WS(1), WS(2), WS(3), WS(4)])
    const queue = createCompactionQueue(deps(recorder, { windowCap: 3 }))

    const tick = await queue.tick()

    expect(recorder.enqueued).toHaveLength(4)
    expect(recorder.claimLimits).toEqual([3])
    expect(tick.claimed).toBe(3)
    expect(tick.compacted).toBe(3)
  })

  it('BOUND (ii) — the cap bounds the CLAIM, so the surplus holds no lease', async () => {
    // Claiming four and refusing one after the fact would leave a row leased to
    // a cell that is not working on it — invisible to the next window for the
    // whole lease. The bound has to be the limit passed to the claim.
    const recorder = memoryQueue([WS(1), WS(2), WS(3), WS(4)])
    const queue = createCompactionQueue(deps(recorder, { windowCap: 2 }))

    await queue.tick()

    expect(recorder.claimLimits).toEqual([2])
    expect(recorder.completed).toHaveLength(2)
  })

  // ── BOUND (iii) ─────────────────────────────────────────────────────────────

  it('BOUND (iii) — a workspace above the SIZE ceiling is refused, not compacted', async () => {
    // MUTANT: delete the `total > maxWorkspaceObjects` comparison. The oversized
    // workspace is then compacted, which is a pass entering the region where the
    // only observation on record is a run that did not terminate.
    const recorder = memoryQueue([WS(1)])
    let compactCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      maxWorkspaceObjects: 12_000,
      measure: async () => ({ objects: 11_999, connections: 2 }),
      compact: async () => {
        compactCalls += 1
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(compactCalls).toBe(0)
    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'oversize_workspace' })
    // COMPLETED, not released: a released row keeps its slot and `claimDueWork`
    // orders by slot, so a permanently oversized workspace would hold one of the
    // window's slots for ever.
    expect(recorder.completed).toEqual(['land-1/ver-1'])
    expect(recorder.released).toEqual([])
  })

  it('BOUND (iii) — the size gate runs BEFORE the preview, so an oversized workspace is never walked', async () => {
    // The preview resolves every base shard of a non-empty overlay. Asking it
    // first would pay the walk on exactly the workspaces the ceiling exists to
    // keep the pass out of.
    const recorder = memoryQueue([WS(1)])
    let previewCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      maxWorkspaceObjects: 100,
      measure: async () => ({ objects: 5_000, connections: 0 }),
      preview: async () => {
        previewCalls += 1
        return { folded: 1, deleted: 0 }
      },
    }))

    await queue.tick()

    expect(previewCalls).toBe(0)
  })

  it('BOUND (iii) — a FOLD above the ceiling is refused, from the preview alone', async () => {
    // MUTANT: delete the `preview.folded > maxFoldable` comparison.
    const recorder = memoryQueue([WS(1)])
    let compactCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      maxFoldable: 1_000,
      preview: async () => ({ folded: 1_001, deleted: 0 }),
      compact: async () => {
        compactCalls += 1
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(compactCalls).toBe(0)
    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'oversize_fold' })
  })

  it('BOUND (iii) — the ceiling is INCLUSIVE: exactly at it compacts, one above refuses', async () => {
    // MUTANT: `>` -> `>=`. The direction matters: 12 000 is
    // documented as "the largest scale at which this pass has been MEASURED to
    // complete", so the measured point must be allowed. A ceiling that refuses
    // the only scale anybody has evidence for is a different policy wearing the
    // same number.
    for (const [objects, connections, shouldCompact] of [
      [12_000, 0, true],
      [11_999, 1, true],
      [12_000, 1, false],
    ] as const) {
      const recorder = memoryQueue([WS(1)])
      let compactCalls = 0
      const queue = createCompactionQueue(deps(recorder, {
        maxWorkspaceObjects: 12_000,
        measure: async () => ({ objects, connections }),
        compact: async () => { compactCalls += 1; return compacted() },
      }))

      await queue.tick()

      expect(compactCalls, `${objects}+${connections}`).toBe(shouldCompact ? 1 : 0)
    }
  })

  it('BOUND (iii) — BOTH operands make the size, and the fold ceiling counts only the FOLD', async () => {
    // TWO MUTANTS. (1) `size.objects + size.connections` -> `size.objects * 2`:
    // needs a workspace whose two counts differ across the ceiling. (2)
    // `preview.folded` -> `preview.folded + preview.deleted` in the fold
    // ceiling. Tombstones are
    // applied, not folded; charging them to the fold ceiling would refuse a
    // delete-heavy pass that has almost nothing to write.
    const recorder = memoryQueue([WS(1), WS(2)])
    const compactedKeys: string[] = []
    const queue = createCompactionQueue(deps(recorder, {
      maxWorkspaceObjects: 100,
      maxFoldable: 1_000,
      // land-1: 99 + 2 = 101, ABOVE the ceiling — but `objects * 2` reads 198
      // and `objects + objects` would too, so the discriminating case needs the
      // sum to cross where a doubled `objects` does not.
      measure: async (workspace) =>
        (workspace.landscapeId === 'land-1' ? { objects: 40, connections: 61 } : { objects: 40, connections: 20 }),
      preview: async () => ({ folded: 1_000, deleted: 5_000 }),
      compact: async (workspace) => { compactedKeys.push(keyOf(workspace)); return compacted() },
    }))

    const tick = await queue.tick()

    // land-1: 40 + 61 = 101 > 100, refused. A doubled `objects` reads 80 and
    // would have let it through.
    expect(tick.units.find((unit) => unit.landscapeId === 'land-1'))
      .toMatchObject({ reason: 'oversize_workspace' })
    // land-2: 60 <= 100, and a fold of 1 000 with 5 000 tombstones is AT the
    // fold ceiling, not above it.
    expect(compactedKeys).toEqual(['land-2/ver-2'])
  })

  it('BOUND (iii) — a size that cannot be READ is refused, not assumed small', async () => {
    // "Cannot tell" is not permission. The ceiling's entire value is that the
    // region above it has never been observed to terminate, so an unanswerable
    // size must land on the same side as an oversized one.
    const recorder = memoryQueue([WS(1)])
    let compactCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      measure: async () => null,
      compact: async () => {
        compactCalls += 1
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(compactCalls).toBe(0)
    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'size_unknown' })
  })

  // ── BOUND (iv) ──────────────────────────────────────────────────────────────

  it('BOUND (iv) — the switch is read at CLAIM time: off means nothing is enqueued or claimed', async () => {
    const recorder = memoryQueue([WS(1), WS(2)])
    const queue = createCompactionQueue(deps(recorder, { killSwitch: () => false }))

    const tick = await queue.tick()

    expect(tick.ran).toBe(false)
    expect(tick.refused).toBe('kill_switch')
    expect(recorder.enqueued).toEqual([])
    expect(recorder.claimLimits).toEqual([])
  })

  it('BOUND (iv) — flipping the switch MID-WINDOW stops the units that have not started', async () => {
    // MUTANT: read the switch once (`const on = deps.killSwitch()` at
    // construction, or drop the per-unit call in `runUnit`). The second
    // workspace is then compacted after the operator turned compaction off,
    // which is the only moment the switch exists for.
    const recorder = memoryQueue([WS(1), WS(2)])
    let on = true
    let measureCalls = 0
    let previewCalls = 0
    const compactedKeys: string[] = []
    const queue = createCompactionQueue(deps(recorder, {
      killSwitch: () => on,
      measure: async () => { measureCalls += 1; return { objects: 10, connections: 5 } },
      preview: async () => { previewCalls += 1; return { folded: 3, deleted: 0 } },
      compact: async (workspace) => {
        compactedKeys.push(keyOf(workspace))
        on = false
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(compactedKeys).toEqual(['land-1/ver-1'])
    expect(tick.compacted).toBe(1)
    expect(tick.units[1]).toMatchObject({ status: 'skipped', reason: 'kill_switch' })
    expect(tick.skipped).toBe(1)
    // THE SWITCH IS READ FIRST, not somewhere in the middle. Moving the
    // mid-window reading down to just before `compact` would still refuse
    // correctly, but only after measuring and WALKING the second workspace —
    // and the walk is the expensive part. `measure` and `preview` must
    // have run exactly once each, for the first workspace only.
    expect(measureCalls).toBe(1)
    expect(previewCalls).toBe(1)
    // RELEASED, not completed: the work is still due, and while the switch is
    // off no window claims anything, so the row at the head starves nobody.
    expect(recorder.released).toEqual([
      ['land-2/ver-2', 'compaction queue switched off mid-window'],
    ])
  })

  it('BOUND (iv) — the environment switch is OFF unless it says exactly `on`', () => {
    expect(compactionQueueEnabled({})).toBe(false)
    expect(compactionQueueEnabled({ COMPACTION_QUEUE: '' })).toBe(false)
    expect(compactionQueueEnabled({ COMPACTION_QUEUE: 'true' })).toBe(false)
    expect(compactionQueueEnabled({ COMPACTION_QUEUE: '1' })).toBe(false)
    // THE NEAR MISSES: a `startsWith('on')` check would let
    // `COMPACTION_QUEUE=once` — or a half-typed `onn` — arm an unattended
    // destructive job.
    expect(compactionQueueEnabled({ COMPACTION_QUEUE: 'once' })).toBe(false)
    expect(compactionQueueEnabled({ COMPACTION_QUEUE: 'onn' })).toBe(false)
    expect(compactionQueueEnabled({ COMPACTION_QUEUE: 'off' })).toBe(false)
    expect(compactionQueueEnabled({ COMPACTION_QUEUE: ' ON ' })).toBe(true)
  })

  // ── The empty-fold gate, which is not one of the four ───────────────────────

  it("M7's second finding — a workspace with NOTHING to fold is never detached", async () => {
    // MUTANT: delete the `preview.folded + preview.deleted === 0` branch.
    // `runWorkspaceCompaction` then detaches the read plane and pays the whole
    // re-attach — ~30 s at 200 000 objects, measured — for zero work, because it
    // detaches before it can discover there is none.
    const recorder = memoryQueue([WS(1)])
    let compactCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      preview: async () => ({ folded: 0, deleted: 0 }),
      compact: async () => {
        compactCalls += 1
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(compactCalls).toBe(0)
    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'nothing_to_fold' })
    expect(recorder.completed).toEqual(['land-1/ver-1'])
  })

  it("M7's second finding — tombstones ALONE are work, and are not mistaken for an empty overlay", async () => {
    // `foldCollection` applies tombstones even with no overlay entries, so
    // `folded === 0 && deleted > 0` is a real pass. A gate written as
    // `folded === 0` would silently stop every delete-only compaction, and the
    // overlay would look quiet while the tombstone list grew without bound.
    const recorder = memoryQueue([WS(1)])
    let compactCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      preview: async () => ({ folded: 0, deleted: 4 }),
      compact: async () => {
        compactCalls += 1
        return compacted()
      },
    }))

    expect((await queue.tick()).compacted).toBe(1)
    expect(compactCalls).toBe(1)
  })

  it('a workspace that vanished between enqueue and claim is completed, not retried', async () => {
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, { preview: async () => null }))

    const tick = await queue.tick()

    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'vanished' })
    expect(recorder.completed).toEqual(['land-1/ver-1'])
    expect(recorder.released).toEqual([])
  })

  it('the LEASE covers a whole window, with the queue wait counted', async () => {
    // A window claims `DEFAULT_WINDOW_CAP` rows AT ONCE and runs them ONE AT A
    // TIME, so the last unit's lease has to cover its wait as well as its work.
    // The relation between the two constants is asserted, not assumed.
    //
    // The worst a unit can reach is the SIZE CEILING, and that is the point of
    // there being one: 12 000 objects, measured at 6.92-6.99 s of held call in
    // the shipped configuration when the pass has to cold-enter. Four times the
    // measured worst case is the margin asserted, not the measured value itself
    // — a bound that only just holds is one nobody may tune either constant
    // against.
    const WORST_CASE_PASS_MS = 7_000
    expect(DEFAULT_WINDOW_CAP * WORST_CASE_PASS_MS * 4).toBeLessThan(DEFAULT_CLAIM_LEASE_MS)
    // And the ceiling is the thing that makes `WORST_CASE_PASS_MS` a bound at
    // all: without it a unit's duration is unbounded and so is the window's.
    expect(DEFAULT_MAX_WORKSPACE_OBJECTS).toBe(12_000)
  })

  // ── Ownership, residency and size gates ─────────────────────────────────────

  it('OWNERSHIP is asked BEFORE the preview, which walks every base shard', async () => {
    // MUTANT 1: delete the `!owns(workspace)` branch — the unit then previews a
    // workspace this cell may not touch, pulling its whole model into this
    // Repo, on every tick, only to be refused at the coordinator's lock.
    // MUTANT 2: move the ownership gate below `deps.preview` — the refusal is
    // still correct but the cost is still paid.
    const recorder = memoryQueue([WS(1)])
    let previewCalls = 0
    let measureCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      owns: () => false,
      measure: async () => { measureCalls += 1; return { objects: 1, connections: 0 } },
      preview: async () => { previewCalls += 1; return { folded: 1, deleted: 0 } },
    }))

    const tick = await queue.tick()

    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'not_owned' })
    expect(previewCalls).toBe(0)
    expect(measureCalls).toBe(0)
    // RELEASED: ownership moves, so the work is still due.
    expect(recorder.released).toEqual([['land-1/ver-1', 'this cell does not own the workspace']])
  })

  it('a workspace this cell has NOT got resident is refused before the cold-entry path', async () => {
    // MUTANT: delete the `!isResident(workspace)` branch. The pass then
    // cold-BUILDS the workspace inside the coordinator's lock
    // — the difference between a 3.2 s hold and a 7.0 s one at 12 000 objects — and the `ro_*` count the
    // size ceiling reads would be taken on a read model that does not exist yet.
    const recorder = memoryQueue([WS(1)])
    let measureCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      isResident: () => false,
      measure: async () => { measureCalls += 1; return { objects: 1, connections: 0 } },
    }))

    const tick = await queue.tick()

    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'not_resident' })
    expect(measureCalls).toBe(0)
  })

  it('a size of ZERO is refused exactly like a size that could not be read', async () => {
    // MUTANT: `size === null || size.objects + size.connections === 0` ->
    // `size === null`. The count comes from `ro_*`, which the cold build writes;
    // a workspace reporting zero rows sails under ANY ceiling, which is how the
    // load-bearing bound gets silently disarmed on exactly the workspaces it
    // exists for.
    const recorder = memoryQueue([WS(1)])
    let compactCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      measure: async () => ({ objects: 0, connections: 0 }),
      compact: async () => { compactCalls += 1; return compacted() },
    }))

    const tick = await queue.tick()

    expect(compactCalls).toBe(0)
    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'size_unknown' })
  })

  it('a row claimed too many times is GIVEN UP for this window', async () => {
    // MUTANT: delete the `claim.attempts > maxAttempts` branch. Before it, NOTHING
    // in the tree read `attempts`: a workspace that fails deterministically was
    // re-claimed every window for ever, each attempt taking its read plane down,
    // and its immortal rows eventually filled every window so no healthy
    // workspace was ever claimed again.
    const recorder = memoryQueue([WS(1)], 4)
    let compactCalls = 0
    const queue = createCompactionQueue(deps(recorder, {
      maxAttempts: 3,
      compact: async () => { compactCalls += 1; return compacted() },
    }))

    const tick = await queue.tick()

    expect(compactCalls).toBe(0)
    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'too_many_attempts' })
    // COMPLETED: giving up for this window, not evicting the workspace — it is
    // proposed again at the next slot with a fresh count.
    expect(recorder.completed).toEqual(['land-1/ver-1'])
  })

  it('a FAILED unit is held back before it can be claimed again', async () => {
    // MUTANT: drop the `retryAfterMs` argument in the failure path. The row is
    // then instantly re-claimable, so a deterministic failure is retried every
    // tick — on a pass that takes the read plane down while it runs.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, {
      retryAfterMs: 1_800_000,
      compact: async () => { throw new Error('boom') },
    }))

    await queue.tick()

    expect(recorder.released).toEqual([['land-1/ver-1', 'boom']])
    expect(recorder.releaseDelays).toEqual([1_800_000])
  })

  it('a POLICY refusal is NOT held back — only failures are', async () => {
    // The other direction. A kill-switch refusal must be claimable the moment
    // the switch comes back on; holding it back for half an hour would make the
    // switch slow to un-flip.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, { killSwitch: () => true, owns: () => false }))

    await queue.tick()

    expect(recorder.releaseDelays).toEqual([undefined])
  })

  it('a fold that happened is reported with its real counts even if the BOOK-KEEPING fails', async () => {
    // MUTANT: build the returned unit after `complete()` instead of before. A
    // `complete` that throws then turns a destructive pass that RAN into a
    // report of zero — a number published about a different subject than the one
    // that ran.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue({
      ...deps(recorder),
      queue: {
        ...recorder.seam,
        complete: async () => { throw new Error('connection terminated') },
      },
      compact: async () => ({ ran: true, objectsFolded: 9, connectionsFolded: 4, reattach: 'reattached' }),
    })

    const tick = await queue.tick()

    expect(tick.units[0]).toMatchObject({ status: 'failed', error: 'connection terminated' })
    // The row was handed back by the `finally`, since `complete` never settled it.
    expect(recorder.released.map(([id]) => id)).toEqual(['land-1/ver-1'])
  })

  it('a fold that left the READ PLANE DOWN is counted, not buried in a success line', async () => {
    // MUTANT: delete `reattachFailed` from the tick, or compute it from
    // `status === 'failed'`. A window then prints `compacted 1, failed 0` while
    // the workspace it folded answers 503 — a green report over an outage.
    const recorder = memoryQueue([WS(1), WS(2)])
    const queue = createCompactionQueue(deps(recorder, {
      compact: async (workspace) => ({
        ran: true,
        objectsFolded: 1,
        connectionsFolded: 0,
        reattach: workspace.landscapeId === 'land-1' ? 'skipped_reattach_no_root' : 'reattached',
      }),
    }))

    const tick = await queue.tick()

    expect(tick.compacted).toBe(2)
    expect(tick.failed).toBe(0)
    expect(tick.reattachFailed).toBe(1)
  })

  // ── The two switches, and the two "did not happen" outcomes ─────────────────

  it('the ALLOW-LIST filters the proposal: a workspace it refuses gets no row at all', async () => {
    // MUTANT: drop the `if (!admit(workspace)) continue`. Every maintainable
    // workspace is then enqueued, and `COMPACTION_QUEUE=on` becomes a single
    // variable that turns an unattended destructive pass loose on a deployment
    // that never named a workspace — which is what `compactionAllowlist.ts`
    // exists to prevent on the manual route.
    const recorder = memoryQueue([WS(1), WS(2), WS(3)])
    const queue = createCompactionQueue(deps(recorder, {
      admit: (workspace) => workspace.landscapeId === 'land-2',
    }))

    const tick = await queue.tick()

    expect(recorder.enqueued).toEqual(['land-2/ver-2'])
    expect(tick.claimed).toBe(1)
    expect(tick.compacted).toBe(1)
  })

  it('an EMPTY allow-list compacts nothing, even with the queue switched on', async () => {
    // Both switches are required, and this is the one that is empty by default.
    const recorder = memoryQueue([WS(1), WS(2)])
    const queue = createCompactionQueue(deps(recorder, { admit: () => false }))

    const tick = await queue.tick()

    expect(tick.ran).toBe(true)
    expect(recorder.enqueued).toEqual([])
    expect(tick.claimed).toBe(0)
    expect(tick.compacted).toBe(0)
  })

  it('a pass that DECLINED to run is not reported as a compaction of zero', async () => {
    // MUTANT: delete the `!result.ran` branch, and a `skipped_locked` from the
    // coordinator — another replica holding the job — is reported as `compacted`
    // with zero counts, on a workspace this cell never touched. The row would
    // also be COMPLETED, so the workspace would silently lose its turn every
    // time a replica lost the race.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, {
      compact: async () => ({ ran: false, reason: 'skipped_locked' }),
    }))

    const tick = await queue.tick()

    expect(tick.compacted).toBe(0)
    expect(tick.units[0]).toMatchObject({ status: 'skipped', reason: 'not_run', detail: 'skipped_locked' })
    expect(recorder.completed).toEqual([])
    expect(recorder.released).toEqual([
      ['land-1/ver-1', 'the compaction pass declined to run: skipped_locked'],
    ])
  })

  it("the pass's OWN refusals are `not_run` too, and each keeps its reason", async () => {
    // THE ONE THE UNION EXISTS FOR. `runWorkspaceCompaction` returns NORMALLY
    // with zero counts and a `skippedReason` for four refusals, and the
    // coordinator stamps every one of them `completed`. A caller reading only
    // the status would book them as a compaction and delete the row — so a
    // workspace whose projector is one generation behind would lose its turn
    // every window, under a green report.
    for (const reason of [
      'summary_workspace',
      'projection_not_acknowledged',
      'foreign_projector_instance',
      'ownership_lost_mid_fold',
    ]) {
      const recorder = memoryQueue([WS(1)])
      const queue = createCompactionQueue(deps(recorder, { compact: async () => ({ ran: false, reason }) }))

      const tick = await queue.tick()

      expect(tick.compacted, reason).toBe(0)
      expect(tick.units[0], reason).toMatchObject({ status: 'skipped', reason: 'not_run', detail: reason })
      expect(recorder.completed, reason).toEqual([])
    }
  })

  // ── Reported numbers and boundaries ─────────────────────────────────────────
  //
  // The tests below pin the numbers the window REPORTS and the boundaries of
  // each bound, not only its control flow.

  it('reports the FOLD COUNTS it was given, not a pair of zeroes and not each other', async () => {
    // TWO MUTANTS: report `0, 0` for a compacted unit, and swap the two counts.
    // "Compacted with zero counts" is exactly the misreport the outcome shape
    // exists to prevent.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, {
      compact: async () => ({ ran: true, objectsFolded: 7, connectionsFolded: 3, reattach: 'reattached' }),
    }))

    const tick = await queue.tick()

    expect(tick.units[0]).toMatchObject({ status: 'compacted', objectsFolded: 7, connectionsFolded: 3 })
  })

  it('a REFUSED unit reports zeroes and a null read plane — the whole object, not a subset', async () => {
    // MUTANTS: make the refusal base report `99, 99`, or claim
    // `reattach: 'reattached'`. `toMatchObject` cannot see a field the
    // assertion does not name, so the whole object is compared. A
    // skipped unit claiming a re-attached read plane is a window asserting
    // something nobody looked at.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, {
      maxWorkspaceObjects: 100,
      measure: async () => ({ objects: 5_000, connections: 0 }),
    }))

    const tick = await queue.tick()

    expect(tick.units[0]).toEqual({
      landscapeId: 'land-1',
      versionId: 'ver-1',
      status: 'skipped',
      reason: 'oversize_workspace',
      objectsFolded: 0,
      connectionsFolded: 0,
      reattach: null,
    })
  })

  it('the window CONSERVES its claims: claimed === compacted + skipped + failed', async () => {
    // MUTANTS: hard-code `skipped` or `enqueued` to 0. Production logs both
    // (`index.ts`), and only the DB-gated file — which skips in silence without
    // Postgres — asserted them.
    const recorder = memoryQueue([WS(1), WS(2), WS(3)])
    const queue = createCompactionQueue(deps(recorder, {
      owns: (workspace) => workspace.landscapeId !== 'land-2',
      compact: async (workspace) => {
        if (workspace.landscapeId === 'land-3') throw new Error('boom')
        return compacted()
      },
    }))

    const tick = await queue.tick()

    expect(tick.enqueued).toBe(3)
    expect(tick.claimed).toBe(3)
    expect(tick.compacted).toBe(1)
    expect(tick.skipped).toBe(1)
    expect(tick.failed).toBe(1)
    expect(tick.claimed).toBe(tick.compacted + tick.skipped + tick.failed)
    // And a clean re-attach must count ZERO, not "whatever the counter says".
    expect(tick.reattachFailed).toBe(0)
  })

  it('the slot is QUANTIZED, so two cells in one window propose the same one', async () => {
    // MUTANT: `quantizeSlot(now(), intervalMs)` -> `now()`. Every proposal then
    // gets a distinct slot, the unique key collapses nothing, and the
    // leaderless dedup is silently off.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, {
      intervalMs: 24 * 60 * 60 * 1_000,
      now: () => new Date('2026-08-31T13:47:11.123Z'),
    }))

    await queue.tick()

    expect(recorder.slots).toEqual(['2026-08-31T00:00:00.000Z'])
  })

  it('a tick that THROWS does not wedge the queue for the life of the process', async () => {
    // MUTANT: move `tickInFlight = false` out of the `finally`. One statement
    // timeout on the claim then refuses every later window as `tick_in_flight`,
    // for ever — and production logs nothing, because it returns early when
    // `claimed === 0`.
    const recorder = memoryQueue([WS(1)])
    let boom = true
    const queue = createCompactionQueue(deps(recorder, {
      queue: {
        ...recorder.seam,
        claim: async (limit: number) => {
          if (boom) { boom = false; throw new Error('statement timeout on maintenance_due_work') }
          return recorder.seam.claim(limit)
        },
      },
    }))

    await expect(queue.tick()).rejects.toThrow('statement timeout')
    const second = await queue.tick()

    expect(second.refused).toBeUndefined()
    expect(second.ran).toBe(true)
    expect(second.compacted).toBe(1)
  })

  it('reports the re-attach outcome verbatim instead of assuming it re-attached', async () => {
    // `runWorkspaceCompaction` can return `skipped_reattach_no_root`: the fold
    // succeeded and the read plane is DOWN. A queue that reported only "folded
    // N" would show a green window over a workspace answering 503.
    const recorder = memoryQueue([WS(1)])
    const queue = createCompactionQueue(deps(recorder, {
      compact: async () => ({ ran: true, objectsFolded: 7, connectionsFolded: 0, reattach: 'skipped_reattach_no_root' }),
    }))

    const tick = await queue.tick()

    expect(tick.units[0]).toMatchObject({ status: 'compacted', reattach: 'skipped_reattach_no_root' })
  })
})
