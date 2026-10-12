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

import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { interpretAsDocumentId, type BinaryDocumentId, type DocumentId, type Repo } from '@automerge/automerge-repo'
import {
  rollbackForkedDocuments,
  resetForkRollbackCountersForTest,
  forkRollbackMetricSamples,
} from './forkRollback.js'
import { mintDocumentIdBytes } from './rbac/documentIdMint.js'
import { StaleSyncCellWriteError } from './automergeStorageErrors.js'

/**
 * These tests are about the property a `try { repo.delete(url) } catch {}`
 * rollback cannot have: that the caller learns the outcome (`repo.delete`'s
 * durable half is a promise the LIBRARY swallows).
 *
 * And about the one property the module must NOT claim: nothing here asserts
 * that a rolled-back document stays gone past the Automerge save armed at its
 * creation (see the module docblock). The arm that pins the contract's SHAPE
 * keeps such a claim from creeping in.
 *
 * The fake repo models the two facts that make the real one hazardous:
 * `removeFromCache` is the teardown that does NOT issue a second removal, and
 * `removeDoc` is where the durable work and the failure both live.
 */
function fakeRepo(options: {
  removeDoc?: (id: string, attempt: number) => Promise<void>
  /** Throw SYNCHRONOUSLY from removeDoc — the path `Promise.allSettled` cannot see. */
  removeDocThrowsSync?: boolean
  withoutStorage?: boolean
  removeFromCacheThrows?: boolean
} = {}): {
  repo: Repo
  removeFromCacheCalls: string[]
  removeDocCalls: string[]
  /** Order of every side effect, so teardown-before-remove holds. */
  order: string[]
  /** Peak concurrent removeDoc calls, for the chunking arm. */
  peakConcurrency: () => number
} {
  const removeFromCacheCalls: string[] = []
  const removeDocCalls: string[] = []
  const order: string[] = []
  const attempts = new Map<string, number>()
  let inFlight = 0
  let peak = 0

  const storageSubsystem = options.withoutStorage ? undefined : {
    removeDoc: (id: DocumentId): Promise<void> => {
      if (options.removeDocThrowsSync) throw new Error('synchronous throw before any promise exists')
      return (async () => {
        const key = String(id)
        const attempt = (attempts.get(key) ?? 0) + 1
        attempts.set(key, attempt)
        removeDocCalls.push(key)
        order.push(`remove:${key}`)
        inFlight += 1
        if (inFlight > peak) peak = inFlight
        try {
          if (options.removeDoc) await options.removeDoc(key, attempt)
          else await Promise.resolve()
        } finally {
          inFlight -= 1
        }
      })()
    },
  }

  const repo = {
    storageSubsystem,
    // Present so a regression that flushes before removing is visible.
    flush: async (): Promise<void> => { order.push('flush') },
    removeFromCache: async (id: string): Promise<void> => {
      if (options.removeFromCacheThrows) throw new Error('handle already gone')
      removeFromCacheCalls.push(String(id))
      order.push(`teardown:${String(id)}`)
    },
    // Present so a regression back to `delete` is visible rather than silent.
    delete: (): void => { order.push('delete') },
  } as unknown as Repo

  return { repo, removeFromCacheCalls, removeDocCalls, order, peakConcurrency: () => peak }
}

const IDS = ['aaa', 'bbb'] as unknown as DocumentId[]
const EIGHT = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as unknown as DocumentId[]
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function resetEnv(): void {
  delete process.env.FORK_ROLLBACK_ATTEMPTS
  delete process.env.FORK_ROLLBACK_BUDGET_MS
}

/**
 * A FENCE REFUSAL IS CLASSIFIED, NOT MISREPORTED.
 *
 * With the bootstrap fence live, a fork on a lease-less cell fails on
 * `StaleSyncCellWriteError` at its flush, and every `removeRange` the durable
 * pass would issue meets the same fence for the same reason. Running the pass
 * anyway would spend attempts × ranges × N fenced borrows on a starving pool
 * and then raise the cleanup-failed alert for a request the fence refused
 * correctly. These arms pin the classification.
 */
describe('rollbackForkedDocuments — a fence refusal is its own outcome (B2-5d)', () => {
  const undeletedTotal = () => forkRollbackMetricSamples()[0]!.values[0]!.value
  beforeEach(() => {
    resetForkRollbackCountersForTest()
    resetEnv()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetEnv()
  })

  it('KILLS the always-run durable pass: a fork the fence refused is torn down and removal is NOT attempted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo, removeDocCalls, removeFromCacheCalls } = fakeRepo()
    const outcome = await rollbackForkedDocuments(repo, IDS, {
      cause: new StaleSyncCellWriteError('snapshot', 'ownership-unavailable'),
    })
    expect(outcome).toEqual({ attempted: 2, removed: 0, undeleted: [], fenceRefused: ['aaa', 'bbb'], budgetExhausted: false })
    expect(removeFromCacheCalls, 'the in-memory teardown still runs').toHaveLength(2)
    expect(removeDocCalls, 'no fenced borrow was spent on a removal the fence would refuse').toHaveLength(0)
    // NOT an alert: the counter is for "a fork failed AND its cleanup failed",
    // and nothing here was this cell's to clean.
    expect(undeletedTotal()).toBe(0)
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/refused by the storage fence \(ownership-unavailable\)/)
  })

  it('a cause that is NOT the fence keeps the durable pass — the control for the arm above', async () => {
    const { repo, removeDocCalls } = fakeRepo()
    const outcome = await rollbackForkedDocuments(repo, IDS, { cause: new Error('timeout exceeded when trying to connect') })
    expect(outcome.fenceRefused).toEqual([])
    expect(outcome.removed).toBe(2)
    expect(removeDocCalls).toHaveLength(2)
  })

  it('KILLS the retry-on-fence-refusal: a removal the fence refuses is classified once and never re-attempted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const attemptsFor = new Map<string, number>()
    const { repo, removeDocCalls } = fakeRepo({
      removeDoc: async (id, attempt) => {
        attemptsFor.set(id, attempt)
        if (id === 'aaa') throw new StaleSyncCellWriteError('snapshot', 'fence-mismatch')
      },
    })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome).toEqual({ attempted: 2, removed: 1, undeleted: [], fenceRefused: ['aaa'], budgetExhausted: false })
    expect(attemptsFor.get('aaa'), 'the same lease state refuses the same way on every attempt — one is enough').toBe(1)
    expect(removeDocCalls.filter((id) => id === 'aaa')).toHaveLength(1)
    expect(undeletedTotal(), 'a fence refusal is not a cleanup failure').toBe(0)
    expect(error).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0]![0])).toMatch(/removal REFUSED by the storage fence/)
  })

  it('…while a non-fence rejection of the same document is still retried and still counted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const attemptsFor = new Map<string, number>()
    const { repo } = fakeRepo({
      removeDoc: async (id, attempt) => {
        attemptsFor.set(id, attempt)
        if (id === 'aaa') throw new Error('timeout exceeded when trying to connect')
      },
    })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome.undeleted).toEqual(['aaa'])
    expect(outcome.fenceRefused).toEqual([])
    expect(attemptsFor.get('aaa')).toBeGreaterThan(1)
    expect(undeletedTotal()).toBe(1)
  })
})

describe('rollbackForkedDocuments — the caller learns the outcome', () => {
  beforeEach(() => {
    resetForkRollbackCountersForTest()
    resetEnv()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetEnv()
  })

  it('removes every document and reports NOTHING undeleted on the happy path', async () => {
    const { repo, removeDocCalls } = fakeRepo()
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome).toEqual({ attempted: 2, removed: 2, undeleted: [], fenceRefused: [], budgetExhausted: false })
    expect(removeDocCalls.sort()).toEqual(['aaa', 'bbb'])
  })

  it('the outcome has NO field about the armed save — a boolean this module cannot compute is not reported', () => {
    // THE CONTRACT'S SHAPE, pinned: a field like `saveDisarmed` would be a
    // guess, and adding one goes red here before it can be believed.
    const { repo } = fakeRepo()
    // `fenceRefused` is a CLASSIFICATION of an observed refusal —
    // the storage fence's own error, either at the fork or at a removal — not
    // a boolean about the armed save, so it does not reopen this arm's
    // objection.
    return rollbackForkedDocuments(repo, IDS).then((outcome) => {
      expect(Object.keys(outcome).sort()).toEqual(['attempted', 'budgetExhausted', 'fenceRefused', 'removed', 'undeleted'])
    })
  })

  it('does NOT flush before removing — the disarming flush was measured unsound and is not reintroduced', async () => {
    const { repo, order } = fakeRepo()
    await rollbackForkedDocuments(repo, IDS)
    expect(order).not.toContain('flush')
  })

  it('AWAITS the removal — the promise does not resolve before the storage work ran', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const { repo, removeDocCalls } = fakeRepo({ removeDoc: () => held })

    let settled = false
    const pending = rollbackForkedDocuments(repo, IDS).then((o) => { settled = true; return o })
    await Promise.resolve()
    await Promise.resolve()
    expect(removeDocCalls.length, 'removal must have STARTED').toBeGreaterThan(0)
    expect(settled, 'the rollback must not report before its removals complete').toBe(false)

    release()
    const outcome = await pending
    expect(outcome.removed).toBe(2)
  })

  it('REPORTS what it could not remove instead of assuming success', async () => {
    const { repo } = fakeRepo({
      removeDoc: async (id) => { if (id === 'bbb') throw new Error('timeout exceeded when trying to connect') },
    })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome.removed).toBe(1)
    expect(outcome.undeleted).toEqual(['bbb'])
    expect(outcome.attempted).toBe(2)
  })

  it('RETRIES a transient failure — the pool timeout that motivates this module', async () => {
    const { repo } = fakeRepo({
      removeDoc: async (_id, attempt) => { if (attempt === 1) throw new Error('timeout exceeded when trying to connect') },
    })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome.undeleted).toEqual([])
    expect(outcome.removed).toBe(2)
  })

  it('does NOT retry a document that already succeeded', async () => {
    const { repo, removeDocCalls } = fakeRepo({
      removeDoc: async (id, attempt) => { if (id === 'bbb' && attempt === 1) throw new Error('flaky') },
    })
    await rollbackForkedDocuments(repo, IDS)
    expect(removeDocCalls.filter((id) => id === 'aaa')).toHaveLength(1)
    expect(removeDocCalls.filter((id) => id === 'bbb')).toHaveLength(2)
  })

  it('NEVER throws — a rejected removal never becomes the fork\'s reported error', async () => {
    const { repo } = fakeRepo({ removeDoc: async () => { throw new Error('every attempt fails') } })
    await expect(rollbackForkedDocuments(repo, IDS)).resolves.toBeDefined()
  })

  it('a SYNCHRONOUS throw from removeDoc is caught, COUNTED against every document, and LOGGED with its cause', async () => {
    // The path `Promise.allSettled` cannot see: `group.map(id => removeDoc(id))`
    // throws before the array of promises exists. Catching it must not mean
    // returning an outcome with nothing counted and nothing printed.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo } = fakeRepo({ removeDocThrowsSync: true })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome.undeleted.sort()).toEqual(['aaa', 'bbb'])
    expect(outcome.removed).toBe(0)
    expect(forkRollbackMetricSamples()[0]!.values[0]!.value).toBe(2)
    expect(error).toHaveBeenCalledTimes(1)
    const [message, cause] = error.mock.calls[0]!
    expect(String(message)).toMatch(/aborted by an unexpected error/)
    expect(String(message)).toMatch(/all 2 document\(s\)/)
    expect(cause).toBeInstanceOf(Error)
  })

  it('survives a teardown that throws, and still does the durable pass', async () => {
    const { repo, removeDocCalls } = fakeRepo({ removeFromCacheThrows: true })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome.removed).toBe(2)
    expect(removeDocCalls).toHaveLength(2)
  })

  it('reports nothing undeleted when there is no storage — an ephemeral repo wrote nothing', async () => {
    const { repo, removeFromCacheCalls } = fakeRepo({ withoutStorage: true })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome).toEqual({ attempted: 2, removed: 0, undeleted: [], fenceRefused: [], budgetExhausted: false })
    expect(removeFromCacheCalls, 'the in-memory teardown still runs').toHaveLength(2)
  })

  it('tears down with removeFromCache, NEVER with delete — delete issues a second, un-awaited removal', async () => {
    const { repo, order, removeFromCacheCalls } = fakeRepo()
    await rollbackForkedDocuments(repo, IDS)
    expect(order).not.toContain('delete')
    expect(removeFromCacheCalls.sort()).toEqual(['aaa', 'bbb'])
    // Teardown precedes the durable pass for each document.
    expect(order.indexOf('teardown:aaa')).toBeLessThan(order.indexOf('remove:aaa'))
  })

  it('names the surviving documents at error level, with the RATIO a human needs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo } = fakeRepo({
      removeDoc: async (id) => { if (id === 'bbb') throw new Error('nope') },
    })
    await rollbackForkedDocuments(repo, IDS)
    expect(error).toHaveBeenCalledTimes(1)
    const line = String(error.mock.calls[0]![0])
    expect(line).toMatch(/1 of 2 document\(s\) remain DURABLE/)
    expect(line).toContain('bbb')
    expect(line).not.toContain('aaa')
  })

  it('the log says WHICH NET each residue is on, by its name — minted to the reaper, legacy to the GC', async () => {
    // "The minted-orphan reaper reclaims them" is false for every legacy id an
    // AUTH=off process creates. The name is the only thing about a document
    // this process can still read after failing to remove it.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const minted = String(interpretAsDocumentId(mintDocumentIdBytes({ landscapeId: 'L', versionId: 'V' }, 'unit-secret') as BinaryDocumentId))
    const legacy = 'aaa'
    const { repo } = fakeRepo({ removeDoc: async () => { throw new Error('nope') } })
    await rollbackForkedDocuments(repo, [minted, legacy] as unknown as DocumentId[])
    const line = String(error.mock.calls[0]![0])
    expect(line).toMatch(/1 minted -> the minted-orphan reaper/)
    expect(line).toMatch(/1 legacy -> gcOrphanedDocs/)
    expect(line).not.toMatch(/reclaims them/)
  })

  it('the log RATIO names the residue against the whole fork, not against itself', async () => {
    // '2 of 2' has the same numerator and denominator, so it cannot tell
    // `${pending.length} of ${ids.length}` from `${pending.length} of
    // ${pending.length}`. Partial failure is the arm that tells them apart.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const three = ['x', 'y', 'z'] as unknown as DocumentId[]
    const { repo } = fakeRepo({ removeDoc: async (id) => { if (id === 'z') throw new Error('nope') } })
    await rollbackForkedDocuments(repo, three)
    expect(String(error.mock.calls[0]![0])).toMatch(/1 of 3 document\(s\)/)
  })

  it('says nothing when it has nothing to say', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo } = fakeRepo()
    await rollbackForkedDocuments(repo, IDS)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('the fan-out is bounded — it was its own cause of failure', () => {
  beforeEach(() => { resetForkRollbackCountersForTest(); resetEnv() })
  afterEach(() => { vi.restoreAllMocks(); resetEnv() })

  it('never runs more removals at once than the storage gate can admit', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `d${i}`) as unknown as DocumentId[]
    const { repo, peakConcurrency } = fakeRepo({ removeDoc: () => sleep(5) })
    const outcome = await rollbackForkedDocuments(repo, twelve)
    expect(outcome.removed).toBe(12)
    expect(peakConcurrency(), 'the gate bound is 4; wider was measured to refuse 296 of 300').toBeLessThanOrEqual(4)
    expect(peakConcurrency(), 'and it does use the width it has').toBe(4)
  })

  it('STOPS at the wall-clock budget instead of hanging an already-failing request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.FORK_ROLLBACK_BUDGET_MS = '100'
    // The first chunk of 4 alone overruns 100 ms; the second chunk must be SKIPPED, not run.
    const { repo, removeDocCalls } = fakeRepo({ removeDoc: () => sleep(120) })
    const outcome = await rollbackForkedDocuments(repo, EIGHT)
    expect(outcome.budgetExhausted).toBe(true)
    expect(outcome.undeleted).toHaveLength(4)
    expect(removeDocCalls, 'the skipped chunk was never issued').toHaveLength(4)
  })

  it('reports the budget exhausted when an IN-FLIGHT chunk overran it, even with nothing left undeleted', async () => {
    // Not only a SKIPPED chunk sets the flag. The primary pool has no
    // statement timeout, so one chunk can take arbitrarily long; the caller
    // waited past the promise and must be told.
    process.env.FORK_ROLLBACK_BUDGET_MS = '100'
    const { repo } = fakeRepo({ removeDoc: () => sleep(150) })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome.undeleted).toEqual([])
    expect(outcome.removed).toBe(2)
    expect(outcome.budgetExhausted).toBe(true)
  })

  it('does NOT report a budget overrun when it finished in time', async () => {
    const { repo } = fakeRepo({ removeDoc: () => sleep(1) })
    const outcome = await rollbackForkedDocuments(repo, EIGHT)
    expect(outcome.budgetExhausted).toBe(false)
    expect(outcome.removed).toBe(8)
  })

  it('does not retry past the budget either — the retry loop reads the same deadline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.FORK_ROLLBACK_BUDGET_MS = '100'
    process.env.FORK_ROLLBACK_ATTEMPTS = '16'
    const { repo, removeDocCalls } = fakeRepo({
      removeDoc: async () => { await sleep(120); throw new Error('timeout exceeded when trying to connect') },
    })
    const outcome = await rollbackForkedDocuments(repo, IDS)
    expect(outcome.undeleted.sort()).toEqual(['aaa', 'bbb'])
    expect(removeDocCalls, 'one attempt, then the budget stops the loop').toHaveLength(2)
  })
})

describe('the input is not trusted', () => {
  beforeEach(() => { resetForkRollbackCountersForTest(); resetEnv() })
  afterEach(() => { vi.restoreAllMocks(); resetEnv() })

  it('DEDUPLICATES ids — a duplicate would double-count the operator metric', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo, removeDocCalls } = fakeRepo({ removeDoc: async () => { throw new Error('nope') } })
    const outcome = await rollbackForkedDocuments(repo, ['a', 'a'] as unknown as DocumentId[])
    expect(outcome.attempted).toBe(1)
    expect(outcome.undeleted).toEqual(['a'])
    expect(forkRollbackMetricSamples()[0]!.values[0]!.value).toBe(1)
    // 3 attempts × 1 distinct document.
    expect(removeDocCalls).toHaveLength(3)
  })

  it('handles an empty fork without calling storage or logging', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo, removeDocCalls, removeFromCacheCalls } = fakeRepo()
    const outcome = await rollbackForkedDocuments(repo, [])
    expect(outcome).toEqual({ attempted: 0, removed: 0, undeleted: [], fenceRefused: [], budgetExhausted: false })
    expect(removeDocCalls).toHaveLength(0)
    expect(removeFromCacheCalls).toHaveLength(0)
    expect(error).not.toHaveBeenCalled()
  })
})

describe('FORK_ROLLBACK_ATTEMPTS is a live knob, not a decorative one', () => {
  /**
   * Every arm sets the variable AFTER import and BEFORE the call, and the
   * module reads it at call time; a load-time read would make these arms
   * reach nothing.
   *
   * The values are chosen where a regression is DISTINGUISHABLE: '2.5' returns
   * three iterations with or without the integer guard, so it is not used.
   */
  beforeEach(() => { resetForkRollbackCountersForTest(); resetEnv() })
  afterEach(() => { vi.restoreAllMocks(); resetEnv() })

  async function attemptsObserved(value: string | undefined): Promise<number> {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    if (value === undefined) delete process.env.FORK_ROLLBACK_ATTEMPTS
    else process.env.FORK_ROLLBACK_ATTEMPTS = value
    const { repo, removeDocCalls } = fakeRepo({ removeDoc: async () => { throw new Error('always') } })
    await rollbackForkedDocuments(repo, ['only'] as unknown as DocumentId[])
    return removeDocCalls.length
  }

  it('control — the default is 3', async () => {
    expect(await attemptsObserved(undefined)).toBe(3)
  })

  it('honours a value DIFFERENT from the fallback', async () => {
    expect(await attemptsObserved('5')).toBe(5)
  })

  it('REJECTS a value under the floor — 0 would disable removal entirely', async () => {
    expect(await attemptsObserved('0')).toBe(3)
  })

  it('CLAMPS a value over the ceiling — the bound that stops a failed fork hanging', async () => {
    expect(await attemptsObserved('99999')).toBe(16)
  })

  it('falls back on a blank, which is what a commented-out compose line leaves', async () => {
    expect(await attemptsObserved('')).toBe(3)
  })

  it('falls back on a non-integer', async () => {
    // `envNumber` with `integer: true` rejects a non-integer outright and
    // returns the fallback, so '5.7' must read 3 (without the guard the loop
    // would run 6 times).
    expect(await attemptsObserved('5.7')).toBe(3)
  })
})

describe('FORK_ROLLBACK_BUDGET_MS is a live knob with bounds', () => {
  /**
   * Observable: with eight documents at 120 ms each, a 100 ms budget SKIPS the
   * second chunk and the default (5 000 ms) does not. Every arm reads that one
   * difference, so a value that falls back is told apart from one that is
   * honoured at the floor. The ceiling (120 000 ms) cannot be observed in a
   * unit test — that arm pins the PARSE of an oversized value, not the bound.
   */
  beforeEach(() => { resetForkRollbackCountersForTest(); resetEnv() })
  afterEach(() => { vi.restoreAllMocks(); resetEnv() })

  async function secondChunkSkipped(value: string | undefined): Promise<boolean> {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    if (value === undefined) delete process.env.FORK_ROLLBACK_BUDGET_MS
    else process.env.FORK_ROLLBACK_BUDGET_MS = value
    const { repo, removeDocCalls } = fakeRepo({ removeDoc: () => sleep(120) })
    await rollbackForkedDocuments(repo, EIGHT)
    return removeDocCalls.length === 4
  }

  it('control — the default budget lets both chunks run', async () => {
    expect(await secondChunkSkipped(undefined)).toBe(false)
  })

  it('honours a value at the floor', async () => {
    expect(await secondChunkSkipped('100')).toBe(true)
  })

  it('falls back on a value UNDER the floor — the deadline is checked before each chunk, and a tiny budget would skip every chunk after the first', async () => {
    expect(await secondChunkSkipped('50')).toBe(false)
  })

  it('falls back on zero', async () => {
    expect(await secondChunkSkipped('0')).toBe(false)
  })

  it('accepts an oversized value without falling back to the floor', async () => {
    expect(await secondChunkSkipped('999999999')).toBe(false)
  })

  it('falls back on a blank', async () => {
    expect(await secondChunkSkipped('')).toBe(false)
  })

  it('falls back on garbage', async () => {
    expect(await secondChunkSkipped('soon')).toBe(false)
  })
})

describe('the residue reaches an operator', () => {
  beforeEach(() => { resetForkRollbackCountersForTest(); resetEnv() })
  afterEach(() => { vi.restoreAllMocks(); resetEnv() })

  const counter = (): number => forkRollbackMetricSamples()[0]!.values[0]!.value

  it('counts every undeleted document, and the counter is exported to /metrics', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo } = fakeRepo({ removeDoc: async () => { throw new Error('nope') } })
    await rollbackForkedDocuments(repo, IDS)
    const samples = forkRollbackMetricSamples()
    expect(samples).toHaveLength(1)
    expect(samples[0]!.name).toBe('maplespire_fork_rollback_undeleted_documents_total')
    expect(samples[0]!.type).toBe('counter')
    expect(counter()).toBe(2)
  })

  it('exports ONE counter — the second one counted a guess and is gone', () => {
    // A metric built on `saveDisarmed` would be a number an alert trusts; the
    // module cannot compute it, so it does not export it.
    const names = forkRollbackMetricSamples().map((s) => s.name)
    expect(names).toEqual(['maplespire_fork_rollback_undeleted_documents_total'])
    expect(names.join(' ')).not.toMatch(/disarm/)
  })

  it('stays at ZERO when every rollback worked — a counter that always rises alerts on nothing', async () => {
    const { repo } = fakeRepo()
    await rollbackForkedDocuments(repo, IDS)
    expect(counter()).toBe(0)
  })

  it('ACCUMULATES across forks, because it is a counter and not a gauge', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { repo } = fakeRepo({ removeDoc: async () => { throw new Error('nope') } })
    await rollbackForkedDocuments(repo, IDS)
    await rollbackForkedDocuments(repo, ['ccc'] as unknown as DocumentId[])
    expect(counter()).toBe(3)
  })

  it('the help text does not promise what the module cannot see', () => {
    const help = forkRollbackMetricSamples()[0]!.help
    expect(help).toMatch(/says nothing about documents written back/)
  })

  it('keeps two interleaved rollbacks disjoint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let releaseA!: () => void
    const heldA = new Promise<void>((resolve) => { releaseA = resolve })
    const a = fakeRepo({ removeDoc: async () => { await heldA; throw new Error('a fails') } })
    const b = fakeRepo()
    const pendingA = rollbackForkedDocuments(a.repo, ['a1'] as unknown as DocumentId[])
    const outcomeB = await rollbackForkedDocuments(b.repo, ['b1', 'b2'] as unknown as DocumentId[])
    expect(outcomeB.undeleted).toEqual([])
    releaseA()
    const outcomeA = await pendingA
    expect(outcomeA.undeleted).toEqual(['a1'])
    expect(counter()).toBe(1)
  })
})

describe('the /metrics wiring', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  it('index.ts imports the samples and pushes them into the metrics response', () => {
    // Dropping the push would leave every unit arm green: the samples
    // function works and nobody calls it. Source-scan, because index.ts
    // cannot be imported by a unit test.
    expect(source).toMatch(/import \{ forkRollbackMetricSamples \} from '\.\/forkRollback\.js'/)
    expect(source).toMatch(/metrics\.push\(\.\.\.forkRollbackMetricSamples\(\)\)/)
  })

  it('the push is not behind a disabled branch', () => {
    const line = source.split('\n').find((l) => l.includes('forkRollbackMetricSamples()') && l.includes('metrics.push'))
    expect(line).toBeDefined()
    expect(line!.trim().startsWith('//')).toBe(false)
  })

  it('negative control — the scan is reading a real, non-trivial index.ts', () => {
    expect(source.length).toBeGreaterThan(100_000)
    expect(source).toMatch(/serverCreationPlacementMetricSamples\(\)/)
  })
})
