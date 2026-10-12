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

import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { cbor, type PeerId } from '@automerge/automerge-repo/slim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdaptiveWebSocketClientAdapter } from './adaptiveWebSocketClientAdapter'
import { repoPeerAwareness, type PeerAwareness } from './peerAwareness'
import { createWaiverAllocation } from './waiverBudget'
import {
  documentRepoState,
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './documentResolution'
import {
  ceilingScheduleMs,
  releaseUnavailableDocument,
  resolveReadyHandleWithRetry,
  WAIVER_BUDGET_MS,
} from './handleRetry'
import {
  __setClientTimelineEnabledForTest,
  readClientTimeline,
  resetClientTimeline,
} from '../observability/clientTimeline'
import { readWaiverTelemetry, resetWaiverTelemetry } from './waiverTelemetry'
import { readProgressTelemetry, resetProgressTelemetry } from './progressTelemetry'
import { syncedHandle } from './repoCompat'
import { MIN_PROGRESS_BYTES } from './progressBudget'

/**
 * A repo whose `find()` rejects with `error` and whose progress query reports
 * `state`, as automerge-repo does. `removeFromCache` is recorded so a test can
 * assert whether the terminal cache entry was evicted.
 */
function rejectingRepo(error: unknown, state = 'loading') {
  const find = vi.fn(async () => { throw error })
  const removeFromCache = vi.fn(async () => undefined)
  const handles: Record<string, unknown> = {}
  const repo = fakeRepo({
    find,
    findWithProgress: () => ({ peek: () => ({ state }) }),
    handles,
    removeFromCache,
  })
  return { repo, find, removeFromCache }
}

/** `#docSynchronizers` for a fake, DERIVED from its handle table and never a
 *  second knob. The real `Repo` keeps the two in lockstep — `#ensureQuery`
 *  attaches every source synchronously as it registers the query, and
 *  `removeFromCache` and `delete` drop both together — which is what lets
 *  production read residency in O(1) (`repoCompat.ts`) instead of rebuilding
 *  the whole handle Record per access. A fake that offers one table and not
 *  the other models a repo that cannot exist, and would stay green over code
 *  reading the table production actually consults. A getter, not a snapshot,
 *  because these tables are mutated in place. */
function syncLayerOver(handles: Record<string, unknown>) {
  return {
    get docSynchronizers() {
      return Object.fromEntries(
        Object.entries(handles).map(([id, handle]) => [id, { query: { handle } }]),
      )
    },
  }
}

/**
 * The ONE place this file builds a fake `Repo`, so the two tables can never be
 * set apart — which is the drift itself, not a tidiness preference.
 *
 * `documentRepoState` reads residency through `syncedHandle` (`repoCompat.ts`,
 * O(1)), not through `repo.handles`. A fixture that offers `handles`
 * and NO sync layer therefore makes that read THROW, the probe's own
 * `try { … } catch { return 'unknown' }` swallows it, `findWithProgress` is
 * never called, and every classification arm is skipped: the function answers
 * `'unknown'` for every input while the suite stays green. Deriving the sync
 * layer here makes forgetting it impossible rather than merely unlikely.
 *
 * `Object.assign` onto the literal, NOT a spread of it: a spread would read
 * every property once and freeze the fixtures' own getters (`get peers()`
 * below), turning a live view into a snapshot taken before the test starts.
 */
function fakeRepo(parts: Record<string, unknown> & { handles: Record<string, unknown> }): Repo {
  return Object.assign(parts, { synchronizer: syncLayerOver(parts.handles) }) as unknown as Repo
}

describe('fakeRepo — la couche de synchronisation est CÂBLÉE, pas décorative', () => {
  it('un dépôt qui déclare `ready` se lit `ready`, et la table reste vivante', () => {
    // Guards against a factory that forgets `synchronizer`: `syncedHandle`
    // would throw a TypeError, `documentRepoState` would swallow it and answer
    // `'unknown'` for everything — and EVERY classification assertion in this
    // file would pass without the repo ever being queried. This positive test
    // is what makes that visible.
    const documentId = 'wired-doc'
    const handles: Record<string, unknown> = { [documentId]: { documentId, state: 'ready' } }
    const repo = fakeRepo({
      findWithProgress: () => ({ peek: () => ({ state: 'ready' }) }),
      handles,
    })

    expect(documentRepoState(repo, `automerge:${documentId}`)).toBe('ready')
    // …et par la couture que la production lit vraiment, un GETTER et non un
    // instantané : `removeFromCache` mute `handles` sur place, et une copie
    // prise à la construction ferait mentir la résidence.
    expect(syncedHandle(repo, documentId)).toBe(handles[documentId])
    delete handles[documentId]
    expect(syncedHandle(repo, documentId)).toBeUndefined()
  })
})

describe('resolveReadyHandleWithRetry', () => {
  it('evicts an unavailable query from a real 2.6 Repo', async () => {
    const documentId = '2oqD6jdnyr3sv35Up38MapoQRMX7'
    const url = `automerge:${documentId}`
    const repo = new Repo({})
    try {
      await expect(repo.find(url as AutomergeUrl)).rejects.toThrow(/unavailable/)
      const unavailableQuery = repo.findWithProgress(url as AutomergeUrl)
      expect(unavailableQuery.peek().state).toBe('unavailable')

      await expect(releaseUnavailableDocument(repo, url)).resolves.toBe(true)
      expect(repo.findWithProgress(url as AutomergeUrl)).not.toBe(unavailableQuery)
    } finally {
      await repo.shutdown()
    }
  })

  it('uses the 2.6 Repo cache eviction instead of mutating the handles snapshot', async () => {
    const documentId = 'alpha-child'
    const removeFromCache = vi.fn(async () => undefined)
    const handles: Record<string, unknown> = { [documentId]: { documentId, state: 'ready' } }
    const repo = fakeRepo({
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      handles,
      removeFromCache,
    })

    await expect(releaseUnavailableDocument(repo, `automerge:${documentId}`)).resolves.toBe(true)
    expect(removeFromCache).toHaveBeenCalledWith(documentId)
  })

  it('evicts a terminal unavailable handle and resolves it again from durable storage', async () => {
    const documentId = 'child-doc'
    // NO `state` on the cached entry. `DocHandle.state` is
    // `deleted` or `ready` and nothing else in 2.6.0-alpha.2, so an
    // `'unavailable'` handle is a value production cannot reach; the signal
    // that actually drives this path is the QUERY state below.
    const cached = { documentId }
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    const handles: Record<string, unknown> = { [documentId]: cached }
    const removeFromCache = vi.fn(async () => { delete handles[documentId] })
    const find = vi.fn()
      .mockRejectedValueOnce(new Error('Document is unavailable'))
      .mockImplementationOnce(async () => {
        expect(handles[documentId]).toBeUndefined()
        return ready
      })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      handles,
      removeFromCache,
    })

    await expect(resolveReadyHandleWithRetry(
      repo,
      `automerge:${documentId}` as AutomergeUrl,
      { tries: 2, delayMs: 0 },
    )).resolves.toBe(ready as unknown as DocHandle<unknown>)
    expect(removeFromCache).toHaveBeenCalledWith(documentId)
    expect(find).toHaveBeenCalledTimes(2)
  })

  it('does not evict a ready query', async () => {
    const documentId = 'ready-doc'
    const handles = { [documentId]: { documentId, state: 'ready' } }
    const removeFromCache = vi.fn()
    const repo = fakeRepo({
      findWithProgress: () => ({ peek: () => ({ state: 'ready' }) }),
      handles,
      removeFromCache,
    })

    // ANTI-VACUITY, and the reason this test needed rewriting rather than
    // re-running. While the fixture carried `handles` and no sync layer, the
    // residency read THREW, `documentRepoState`'s own catch answered
    // `'unknown'` — never `'unavailable'` — and `releaseUnavailableDocument`
    // returned false without the repo ever being asked. Both assertions below
    // passed for that reason and not for the one in the title. This line pins
    // that the repo really was consulted and really said `ready`.
    expect(documentRepoState(repo, `automerge:${documentId}`)).toBe('ready')

    await expect(releaseUnavailableDocument(repo, `automerge:${documentId}`)).resolves.toBe(false)
    expect(removeFromCache).not.toHaveBeenCalled()
  })
})

/**
 * Only a genuinely unavailable document is retryable. Before this, every
 * rejection consumed the full 20-attempt budget plus a cache eviction that
 * could never help — a deleted document and a malformed URL stalled the caller
 * for ~10s before failing anyway.
 */
describe('resolveReadyHandleWithRetry error classification', () => {
  const url = 'automerge:doomed-doc' as AutomergeUrl

  it('fails fast on a deleted document', async () => {
    const cause = new Error('Document doomed-doc was deleted')
    const { repo, find, removeFromCache } = rejectingRepo(cause)
    const sleep = vi.fn(async () => undefined)

    const error = await resolveReadyHandleWithRetry(repo, url, { tries: 20, delayMs: 500, sleep })
      .then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentPermanentlyUnavailableError)
    expect((error as DocumentPermanentlyUnavailableError).retryable).toBe(false)
    expect((error as DocumentPermanentlyUnavailableError).documentId).toBe('doomed-doc')
    expect((error as DocumentPermanentlyUnavailableError).cause).toBe(cause)
    expect(find).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    // Evicting the cache entry of a deleted document can never make it resolve.
    expect(removeFromCache).not.toHaveBeenCalled()
  })

  it('fails fast on a malformed automerge url', async () => {
    const cause = new Error("Invalid AutomergeUrl: 'not-a-url'")
    const { repo, find, removeFromCache } = rejectingRepo(cause)
    const sleep = vi.fn(async () => undefined)

    const error = await resolveReadyHandleWithRetry(repo, url, { tries: 20, delayMs: 500, sleep })
      .then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentPermanentlyUnavailableError)
    expect((error as DocumentPermanentlyUnavailableError).cause).toBe(cause)
    expect(find).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(removeFromCache).not.toHaveBeenCalled()
  })

  it('propagates an unrelated fault untouched instead of absorbing it into the retry loop', async () => {
    const cause = Object.assign(new Error('IndexedDB quota exceeded'), { name: 'QuotaExceededError' })
    const { repo, find, removeFromCache } = rejectingRepo(cause)
    const sleep = vi.fn(async () => undefined)

    // The ORIGINAL error, unwrapped — a storage fault is a bug to surface, not
    // a sync delay to wait out.
    await expect(resolveReadyHandleWithRetry(repo, url, { tries: 20, delayMs: 500, sleep }))
      .rejects.toBe(cause)
    expect(find).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(removeFromCache).not.toHaveBeenCalled()
  })

  it('still retries a document that has not synced to this browser yet', async () => {
    // Offline-first: the document is not here *yet*. Each attempt must clear
    // automerge-repo's terminal cache entry so the next find re-checks durable
    // storage and the network.
    const documentId = 'not-synced-yet'
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    // The cached entry carries no `state`: see the note above.
    const handles: Record<string, unknown> = { [documentId]: { documentId } }
    const removeFromCache = vi.fn(async () => { delete handles[documentId] })
    const find = vi.fn()
      .mockRejectedValueOnce(new Error(`Document ${documentId} is unavailable`))
      .mockRejectedValueOnce(new Error(`Document ${documentId} is unavailable`))
      .mockImplementationOnce(async () => {
        expect(handles[documentId]).toBeUndefined()
        return ready
      })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      handles,
      removeFromCache,
    })
    const sleep = vi.fn(async () => undefined)

    await expect(resolveReadyHandleWithRetry(
      repo,
      `automerge:${documentId}` as AutomergeUrl,
      { tries: 5, delayMs: 0, sleep },
    )).resolves.toBe(ready as unknown as DocHandle<unknown>)
    expect(find).toHaveBeenCalledTimes(3)
    expect(removeFromCache).toHaveBeenCalledTimes(2)
  })

  it('exhausts the budget for a document that never arrives and stays retryable', async () => {
    const cause = new Error('Document doomed-doc is unavailable')
    const { repo, find, removeFromCache } = rejectingRepo(cause, 'unavailable')
    const sleep = vi.fn(async () => undefined)

    const error = await resolveReadyHandleWithRetry(repo, url, { tries: 3, delayMs: 500, sleep })
      .then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect((error as DocumentTemporarilyUnavailableError).retryable).toBe(true)
    expect((error as DocumentTemporarilyUnavailableError).attempts).toBe(3)
    expect((error as DocumentTemporarilyUnavailableError).cause).toBe(cause)
    // Callers that match on the repo's own wording keep working.
    expect(String(error)).toMatch(/is unavailable/)
    expect(find).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(removeFromCache).toHaveBeenCalledTimes(3)
  })
})

/**
 * The forever-pending case: with a network adapter
 * attached, `repo.find()` NEVER SETTLES for a document no source answers — it
 * rejects nothing, so the classification loop above never even runs. A server
 * warming up after a set-default repoint can leave every boot document request
 * silently unanswered, and one un-ceilinged await would freeze the whole boot
 * with an empty store. These tests pin the wall-clock ceiling that turns that silence
 * into bounded attempts.
 */
describe('resolveReadyHandleWithRetry wall-clock ceiling (silent server)', () => {
  const documentId = 'silent-doc'
  const silentUrl = `automerge:${documentId}` as AutomergeUrl

  /** A repo whose find() sequence mixes never-settling promises and ready
   * handles — the automerge-repo shape when a peer stays silent, verified
   * against the real 2.6 Repo (NodeWSServerAdapter, 0 peers → still pending
   * at 10 000 ms). */
  /** NO probe-state parameter, deliberately: `silentRepo([...], 'ready')`
   * would fabricate a combination the real repo cannot produce — a query
   * reporting `ready` derives that from the handle HAVING DATA, at which point
   * `find()` has already resolved and cannot hang. The state is `loading` for
   * every caller, which is what a real never-settling find() reports. */
  function silentRepo(sequence: ReadonlyArray<'hang' | 'ready'>) {
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    let call = 0
    const find = vi.fn(() => {
      const step = sequence[Math.min(call, sequence.length - 1)]
      call += 1
      if (step === 'hang') return new Promise<never>(() => undefined)
      return Promise.resolve(ready)
    })
    const removeFromCache = vi.fn(async () => undefined)
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache,
    })
    return { repo, find, removeFromCache, ready }
  }

  it('T6: a request the server leaves unanswered is bounded, re-requested — and NOTHING is evicted', async () => {
    // Transient unavailability at boot: attempts 1-2 never settle (projector
    // warming up), the ceilings fire, attempt 3 finds the now-warm server.
    // Without a ceiling the first await never returns and this test dies on
    // its own timeout.
    //
    // Second half: the pending query is KEPT. A fired ceiling on a large
    // workspace usually means the document is QUEUED BEHIND another on a
    // server that serves one document at a time (e.g. a ~2.4 MB registry
    // shard), and re-awaiting recovers. Evicting would discard the request and
    // send it to the back of that queue.
    const { repo, find, removeFromCache, ready } = silentRepo(['hang', 'hang', 'ready'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const handle = await resolveReadyHandleWithRetry(repo, silentUrl, {
        tries: 3, delayMs: 0, findTimeoutMs: 20,
      })

      expect(handle).toBe(ready as unknown as DocHandle<unknown>)
      expect(find).toHaveBeenCalledTimes(3)
      // Fails if eviction is re-introduced at the second window.
      expect(removeFromCache).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  }, 5_000)

  it('a fired ceiling leaves its bounded operator trace', async () => {
    // The early warning: without this trace a server leaving find()
    // unanswered is console-silent, and a ceiling cannot be told apart from a
    // rejection.
    const { repo, find, removeFromCache, ready } = silentRepo(['hang', 'ready'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const handle = await resolveReadyHandleWithRetry(repo, silentUrl, {
        tries: 3, delayMs: 0, findTimeoutMs: 20,
      })

      expect(handle).toBe(ready as unknown as DocHandle<unknown>)
      expect(find).toHaveBeenCalledTimes(2)
      expect(removeFromCache).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('find ceiling 20ms fired for silent-doc (attempt 1/3)'),
      )
    } finally {
      warn.mockRestore()
    }
  }, 5_000)

  it('escalates the per-attempt ceiling 3s → 6s → 12s → 24s and caps at 30s', async () => {
    // The escalation table itself. Each window must double from the
    // base and clamp at FIND_TIMEOUT_CAP_MS, so a document that genuinely
    // needs longer than one window eventually gets an uninterrupted window
    // big enough to finish. Fake timers pin the exact boundaries: one ms
    // before each deadline the attempt is still waiting, one ms after it the
    // next find() has been issued.
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { repo, find } = silentRepo(['hang'])
      // The inter-attempt sleep is injected as a microtask: it is not part of
      // the escalation table under test, and the default setTimeout-based
      // sleep would need its own fake-timer bookkeeping between windows.
      const outcome = resolveReadyHandleWithRetry(repo, silentUrl, {
        tries: 6, delayMs: 0, findTimeoutMs: 3_000, sleep: async () => undefined,
      }).then(() => null, (thrown: unknown) => thrown)

      const windows = [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]
      for (let i = 0; i < windows.length; i += 1) {
        expect(find).toHaveBeenCalledTimes(i + 1)
        await vi.advanceTimersByTimeAsync(windows[i] - 1)
        expect(find).toHaveBeenCalledTimes(i + 1) // ceiling not reached yet
        await vi.advanceTimersByTimeAsync(1) // the deadline itself
      }

      const error = await outcome
      expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
      expect((error as DocumentTemporarilyUnavailableError).attempts).toBe(6)
      expect(find).toHaveBeenCalledTimes(6)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  }, 10_000)

  it('a persistently silent server exhausts the BOUNDED budget and stays retryable', async () => {
    // Without the per-attempt deadline (or the tries bound) this either hangs
    // into the test timeout or the call-count assertion fails.
    const { repo, find } = silentRepo(['hang'])
    const startedAt = Date.now()

    const error = await resolveReadyHandleWithRetry(repo, silentUrl, {
      tries: 2, delayMs: 0, findTimeoutMs: 15,
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect((error as DocumentTemporarilyUnavailableError).retryable).toBe(true)
    expect((error as DocumentTemporarilyUnavailableError).attempts).toBe(2)
    // Ceilings fire per attempt but the surfaced error carries the ROOT
    // cause only (here: none — find never rejected), never a chain of
    // intermediate DocumentTemporarilyUnavailableError wrappers.
    expect((error as DocumentTemporarilyUnavailableError).cause).toBeUndefined()
    expect(find).toHaveBeenCalledTimes(2)
    // Bounded in wall-clock terms too (15ms + 30ms escalated + slack).
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  }, 5_000)
})

/**
 * The ceiling schedule, computable instead of remembered.
 *
 * `budgetMs` clamps the last escalating window, so it has to be at least as
 * long as the schedule it contains. Written as two independent literals that
 * relation drifts in silence; `ceilingScheduleMs` is what lets a call site
 * DERIVE one from the other, and `bootDocumentResolution.test.ts` asserts the
 * derivation. These tests are the arithmetic underneath both.
 */
describe('ceilingScheduleMs', () => {
  it('is the boot schedule the 22 000 ms floor was read off', () => {
    // 3 000 + 6 000 + 12 000 of windows, plus 2 × 500 of inter-attempt delay.
    expect(ceilingScheduleMs(3, 3_000, 500)).toBe(22_000)
  })

  it('doubles each window and clamps at the escalation cap', () => {
    // 8 000 + 16 000 + 30 000 (24 000 would exceed the 30 000 cap), no delays.
    expect(ceilingScheduleMs(3, 8_000, 0)).toBe(54_000)
    expect(ceilingScheduleMs(1, 8_000, 500)).toBe(8_000)
    // The cap is a parameter so a caller can pin the arithmetic without
    // depending on the module constant staying where it is.
    expect(ceilingScheduleMs(4, 8_000, 0, 20_000)).toBe(8_000 + 16_000 + 20_000 + 20_000)
  })

  it('names what an UNBUDGETED caller is really asking for: 9 min 33 s (review M6)', () => {
    // A known residual, with its number, in executable form. `getModelHandle`
    // (repo.ts), `findDiagramHandle` (repo.ts) and the two model-shard sites
    // in bridge.ts resolve with NO `budgetMs` and NO `peers`, so they take the
    // defaults — `tries: 20`, `findTimeoutMs: 8_000`, `delayMs: 500`. On the
    // classic boot of a saturated server a silent `find()` on ONE model shard
    // can therefore hold the pipeline this long, during which `status` is not
    // `'error'` and the user reads "Loading…".
    //
    // Deliberately NOT narrowed without data: these sites give a 30 s
    // uninterrupted window (the boot-critical schedule gives at most 12 s), and
    // an unmeasured budget cut can kill large-shard loads. When a measurement
    // exists, this assertion is the one that has to move.
    expect(ceilingScheduleMs(20, 8_000, 500)).toBe(573_500)
    expect(573_500 / 60_000).toBeCloseTo(9.56, 1)
  })
})

/**
 * A WALL-CLOCK budget, in place of a count of attempts.
 *
 * These combine `budgetMs` with a bound that actually fires, so the clamp
 * `Math.min(escalatedMs, remainingMs())` in `handleRetry.ts` is pinned. That
 * clamp matters: a budget shorter than the schedule (e.g. `budgetMs: 20_000`)
 * cuts the last 12 s window and makes large registry shards fail to load.
 *
 * The ceiling path and the rejection path share `tries` while their real
 * costs differ by an order of magnitude: a document whose `find()` goes
 * SILENT gets 3 000 + 500 + 6 000 + 500 + 12 000 = 22 000 ms, while a document
 * whose `find()` REJECTS gets 3 × (a sub-millisecond rejection) + 2 × 500 ms ≈
 * 1.0 to 1.5 s — fifteen times less, for the same `tries: 3`.
 *
 * The clock is INJECTED where the schedule is what is under test, and
 * sleeping ADVANCES it. A `sleep` mocked to a no-op against the real clock
 * makes the wall invisible: every wall assertion then passes trivially
 * because no time goes by.
 */
describe('resolveReadyHandleWithRetry wall-clock budget', () => {
  const url = 'automerge:budget-doc' as AutomergeUrl

  /** A repo whose `find()` never settles — the automerge-repo shape when a
   * network adapter is attached and no peer answers. */
  function neverSettlingRepo() {
    const find = vi.fn(() => new Promise<never>(() => undefined))
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    return { repo, find }
  }

  /** A clock the test owns. `sleep` is the only thing that moves it, so the
   * schedule under test is what advances the wall — nothing else can. */
  function injectedClock() {
    let wall = 1_000
    return {
      now: () => wall,
      sleep: async (ms: number) => { wall += ms },
      elapsedSince: (start: number) => wall - start,
      wall: () => wall,
    }
  }

  it('T1: three fast rejections do NOT end the resolution — the BUDGET does', async () => {
    // The root of the workspace can reject `unavailable` in under a
    // millisecond while its socket is still shaking hands; with `tries` as the
    // bound, three attempts are spent before the peer that would answer has
    // connected (`find` called 3 times, the wall advancing ~1 s).
    const { repo, find } = rejectingRepo(new Error('Document budget-doc is unavailable'), 'unavailable')
    const clock = injectedClock()
    const startedAt = clock.wall()

    const error = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 20_000, delayMs: 500, tries: 500, now: clock.now, sleep: clock.sleep,
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    // 20 000 / 500 — the budget bought forty attempts where the counter bought
    // three. The exact figure matters less than the order of magnitude, so the
    // assertion is a floor well above any try-counted schedule.
    expect(find.mock.calls.length).toBeGreaterThan(30)
    expect(clock.elapsedSince(startedAt)).toBeGreaterThanOrEqual(20_000)
    // …and not a millisecond more than one inter-attempt delay past it.
    expect(clock.elapsedSince(startedAt)).toBeLessThan(20_000 + 500)
  })

  it('T2: the LAST window is clamped to the budget — it never overshoots by a whole ceiling', async () => {
    // `findTimeoutMs` is deliberately larger than the whole budget, so the
    // very FIRST window is the one the clamp has to cut: with
    // `Math.min(escalatedMs, remainingMs())` the call ends at ~300 ms, while an
    // un-clamped `escalatedMs` would end at ~1 000 ms — a whole window past the
    // promised budget. (A smaller `findTimeoutMs`, e.g. 60 against 300, would
    // NOT discriminate: the un-clamped 60 + 120 + 240 still finishes at ~440 ms.)
    //
    // Real timers and small numbers on purpose: the wall being asserted is the
    // real one. `tries` is far out of reach, so the ONLY thing that can end
    // this call is the budget — remove the `remainingMs() <= 0` break and
    // `find` is called 500 times instead of once.
    const { repo, find } = neverSettlingRepo()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const startedAt = Date.now()
    try {
      const error = await resolveReadyHandleWithRetry(repo, url, {
        budgetMs: 300, findTimeoutMs: 1_000, delayMs: 10, tries: 500,
      }).then(() => null, (thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
      expect((error as DocumentTemporarilyUnavailableError).retryable).toBe(true)
      const elapsed = Date.now() - startedAt
      expect(elapsed).toBeGreaterThanOrEqual(300)
      expect(elapsed).toBeLessThan(700)
      expect(find).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  }, 10_000)

  it('a caller with no budget keeps the attempt counter it always had', async () => {
    // Backwards compatibility is load-bearing here: the shard, diagram and
    // model call sites pass no budget and must keep failing exactly as before.
    const { repo, find } = rejectingRepo(new Error('Document budget-doc is unavailable'), 'unavailable')

    const error = await resolveReadyHandleWithRetry(repo, url, {
      tries: 4, delayMs: 0, sleep: async () => undefined,
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect((error as DocumentTemporarilyUnavailableError).attempts).toBe(4)
    expect(find).toHaveBeenCalledTimes(4)
  })

  it('a document that arrives DURING the budget resolves, and the budget stops there', async () => {
    // The success path, so the budget cannot be satisfied by "always run the
    // full 20 seconds".
    const documentId = 'budget-doc'
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    const find = vi.fn()
      .mockRejectedValueOnce(new Error(`Document ${documentId} is unavailable`))
      .mockRejectedValueOnce(new Error(`Document ${documentId} is unavailable`))
      .mockImplementation(async () => ready)
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    const clock = injectedClock()
    const startedAt = clock.wall()

    await expect(resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 20_000, delayMs: 500, tries: 500, now: clock.now, sleep: clock.sleep,
    })).resolves.toBe(ready as unknown as DocHandle<unknown>)

    expect(find).toHaveBeenCalledTimes(3)
    expect(clock.elapsedSince(startedAt)).toBe(1_000)
  })
})

/**
 * A rejection that arrives with NO PEER is not a verdict.
 *
 * On a large landscape with concurrent clients, real `unavailable` rejections
 * of the workspace root happen with `repo.peers.length === 0`, one adapter
 * attached, `isReady()` false, `navigator.onLine` true, and a rejection
 * latency under a millisecond — the peer handshake landing up to ~700 ms
 * AFTER the rejection. Each such rejection burns an attempt, and at three the
 * boot dies within seconds without any ceiling firing.
 *
 * So the criterion is NOT "have I tried three times". It is "is a peer still
 * on its way".
 */
describe('resolveReadyHandleWithRetry peer awareness', () => {
  const documentId = 'peerless-doc'
  const url = `automerge:${documentId}` as AutomergeUrl
  /** The budget these tests hand the resolver, kept in one place so the
   * "the cap is not a fraction of the budget" assertion names a real one. */
  const BOOT_BUDGET_UNDER_TEST = 25_000

  beforeEach(() => {
    __setClientTimelineEnabledForTest(true)
    resetClientTimeline()
  })
  afterEach(() => {
    __setClientTimelineEnabledForTest(null)
    resetClientTimeline()
  })

  const retryMarksFor = (document: string) => readClientTimeline().entries
    .filter((entry) => entry.name === 'boot.document.retry' && entry.details.document === document)

  /** A clock the test owns; `sleep` is the only thing that moves it. */
  function injectedClock() {
    let wall = 0
    return { now: () => wall, sleep: async (ms: number) => { wall += ms }, wall: () => wall }
  }

  /** A repo that rejects `unavailable` until `arrivesAt`, then answers. */
  function repoThatArrivesAt(clock: { now: () => number }, arrivesAt: number) {
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    const find = vi.fn(async () => {
      if (clock.now() < arrivesAt) throw new Error(`Document ${documentId} is unavailable`)
      return ready
    })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    return { repo, find, ready }
  }

  it('T3: a rejection with no peer connected is NOT a consumed attempt', async () => {
    // The peer lands at 1 800 ms — beyond a tries-counted allowance (three
    // sub-millisecond rejections plus two 500 ms delays ≈ 1.0–1.5 s) and well
    // beyond a typical worst handshake (~700 ms). The three attempts are still
    // there when it lands, because none of the rejections before it said
    // anything about the document.
    //
    // It must stay under WAIVER_BUDGET_MS: a peer that takes longer than that
    // to answer is indistinguishable, from inside the browser, from a server
    // that is not there at all.
    const arrivesAt = 1_800
    expect(arrivesAt).toBeLessThan(WAIVER_BUDGET_MS)
    const clock = injectedClock()
    const { repo, find, ready } = repoThatArrivesAt(clock, arrivesAt)
    let peers = 0

    const handle = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 20_000, tries: 3, delayMs: 500, now: clock.now,
      sleep: async (ms: number) => {
        await clock.sleep(ms)
        if (clock.now() >= arrivesAt) peers = 1
      },
      peers: {
        connectedPeerCount: () => peers,
        // The socket is open and still shaking hands: a peer IS on its way.
        peerExpected: () => peers === 0,
      },
    })

    // THE discriminator: a tries-counted implementation throws here, at ~1 s,
    // having spent all three attempts on rejections that said nothing.
    expect(handle).toBe(ready as unknown as DocHandle<unknown>)
    expect(clock.wall()).toBeGreaterThanOrEqual(arrivesAt)
    expect(clock.wall()).toBeLessThan(20_000)
    expect(find.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('T3c: a waived round costs NOTHING, even when there are more rounds than `tries`', async () => {
    // The property T3 alone does not pin: an implementation that keeps the
    // WAIT but drops `attempt -= 1` passes T3 (one waived round out of a
    // `tries: 3` allowance still leaves two), yet still charges peerless
    // rejections — and three attempts is all a boot has.
    //
    // So the round count here EXCEEDS `tries`. The peer is absent at each
    // rejection (which arms the waiver) and present one poll later (which
    // ends the wait for free), and the document only lands on the fifth ask.
    // With the decrement: five `find()`s, 200 ms, resolved. Without it: three
    // `find()`s and a `DocumentTemporarilyUnavailableError`.
    const clock = injectedClock()
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    let connected = false
    let asked = 0
    const find = vi.fn(async () => {
      asked += 1
      if (asked >= 5) return ready
      // A rejection always arrives with nobody home — the real-world shape.
      connected = false
      throw new Error(`Document ${documentId} is unavailable`)
    })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })

    const handle = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: BOOT_BUDGET_UNDER_TEST, tries: 3, delayMs: 500, now: clock.now,
      // …and the handshake lands during the very next poll.
      sleep: async (ms: number) => { await clock.sleep(ms); connected = true },
      peers: {
        connectedPeerCount: () => (connected ? 1 : 0),
        peerExpected: () => true,
      },
    })

    expect(handle).toBe(ready as unknown as DocHandle<unknown>)
    expect(find).toHaveBeenCalledTimes(5)
    // Four waived rounds of one poll each, and not a single inter-attempt
    // delay: a waived round does not pause, because the thing it was waiting
    // for has just happened.
    expect(clock.wall()).toBe(4 * 50)
    // Every one of them marked as waived, so an incident can see that the
    // attempts were never spent rather than having to infer it.
    expect(retryMarksFor('peerless-doc').map((entry) => entry.details.waived))
      .toEqual([true, true, true, true])
  })

  it('T3b: with a peer CONNECTED, a rejection is a verdict and still costs an attempt', async () => {
    // The complement, and the one that keeps the waiver honest. A connected
    // peer that answers "I do not have this document" says the same thing the
    // fortieth time; burning the budget on it only delays the bridge's
    // cached-root fallback, which is the recovery that works there.
    const clock = injectedClock()
    const { repo, find } = repoThatArrivesAt(clock, Number.POSITIVE_INFINITY)

    const error = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 20_000, tries: 3, delayMs: 500, now: clock.now, sleep: clock.sleep,
      peers: { connectedPeerCount: () => 1, peerExpected: () => true },
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect((error as DocumentTemporarilyUnavailableError).attempts).toBe(3)
    expect(find).toHaveBeenCalledTimes(3)
    expect(clock.wall()).toBe(1_000)
  })

  it('T4: OFFLINE — no peer expected, so the failure stays fast', async () => {
    // THE PRICE OF the long budget, and the test that stops it being paid in
    // silence.
    //
    // The short rejection budget is what protects the offline boot: with no
    // server, `fetchRootUrl` falls back to the cached root url and the `find()`
    // that follows rejects at once — which is why offline start-up is instant,
    // the product's flagship property. Carrying the 20 s budget over to that path
    // would add up to twenty seconds of hourglass to EVERY offline boot.
    //
    // Peer awareness is what pays that debt: offline there is no peer EXPECTED
    // — the transport has no handshake in flight — so nothing is waived and the
    // schedule is exactly what it always was. Extend the waiver to "wait for a
    // peer even when none is coming" and this test reports 20 s.
    const clock = injectedClock()
    const { repo, find } = repoThatArrivesAt(clock, Number.POSITIVE_INFINITY)

    const error = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 20_000, tries: 3, delayMs: 500, now: clock.now, sleep: clock.sleep,
      peers: { connectedPeerCount: () => 0, peerExpected: () => false },
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(find).toHaveBeenCalledTimes(3)
    expect(clock.wall()).toBeLessThanOrEqual(2_000)
    // And each rejection was CHARGED, not merely short. The wall assertion
    // above survives a waiver that enters the wait and leaves it one tick
    // later — the second guard, inside the waiter, keeps it fast. This pins
    // the FIRST guard on its own: offline, nothing is ever waived.
    expect(retryMarksFor('peerless-doc').map((entry) => entry.details.waived)).toEqual([false, false, false])
  })

  it('T4b: a handshake that never lands is capped by the WAIVER allowance, not by the budget', async () => {
    // THE price of the long budget, and the case `navigator.onLine` cannot
    // see. Wifi associated, no route to the server — a firewall in
    // DROP, a dropped VPN, a captive portal. The browser says it is ONLINE,
    // the socket sits in CONNECTING, and `handshakePending()` is true for the
    // whole of that first attempt, which is not a bounded quantity: a
    // discarded SYN leaves a socket connecting for tens of seconds.
    //
    // T4 next door asserts the offline price under `peerExpected: () => false`
    // — it POSTULATES the predicate instead of exercising it, so it says
    // nothing about this case. Here the predicate answers TRUE forever and no
    // peer ever arrives, which is exactly what an unreachable server looks
    // like from inside the browser. An uncapped waiver would report the whole
    // budget (25 000 ms) and ONE find call: a single waived rejection
    // consuming the entire wall.
    const clock = injectedClock()
    const { repo, find } = repoThatArrivesAt(clock, Number.POSITIVE_INFINITY)

    const error = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 25_000, tries: 3, delayMs: 500, now: clock.now, sleep: clock.sleep,
      peers: { connectedPeerCount: () => 0, peerExpected: () => true },
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    // The waiver buys ONE bounded wait for the whole call, then the ordinary
    // schedule resumes: allowance + the inter-attempt delays it never covers.
    expect(clock.wall()).toBeLessThanOrEqual(WAIVER_BUDGET_MS + 2 * 500)
    // And the attempts are all still spent — the waiver postpones charging a
    // rejection, it does not stop the resolution from ending.
    expect(find).toHaveBeenCalledTimes(3)
    // The mark is honest about it: armed once, then spent. A `waived: true`
    // on rounds 2 and 3 would say the allowance was still paying when it was
    // not, and an incident reads these marks to tell the two regimes apart.
    expect(retryMarksFor('peerless-doc').map((entry) => entry.details.waived))
      .toEqual([true, false, false])
  })

  it('the waiver allowance does not follow `budgetMs` around', async () => {
    // The relation this file owns: the cap is a number of its own, sized on a
    // measured handshake latency (worst observed ~700 ms), and NOT a fraction
    // or a multiple of the resolution budget. The number itself, its bounded
    // override and its clamp belong to `waiverBudget.test.ts`.
    expect(WAIVER_BUDGET_MS).toBeGreaterThan(2 * 683)
    expect(WAIVER_BUDGET_MS).toBeLessThan(BOOT_BUDGET_UNDER_TEST)
  })

  it('peers WITHOUT a budget waives nothing: the guard needs both halves', async () => {
    // `canWaive = peers !== undefined && budgetMs !== null`. Turning `&&` into
    // `||` would allow a waiver on an UNBUDGETED caller, where `remainingMs()`
    // is `Infinity` — a wait nobody asked for on the model/diagram call sites,
    // which pass no budget on purpose.
    //
    // Production cannot reach it today — the one site that passes `peers` also
    // passes `budgetMs` — which is exactly why the guard needs its own test
    // rather than an assumption about call sites that may change.
    const clock = injectedClock()
    const { repo, find } = repoThatArrivesAt(clock, Number.POSITIVE_INFINITY)

    const error = await resolveReadyHandleWithRetry(repo, url, {
      tries: 3, delayMs: 500, now: clock.now, sleep: clock.sleep,
      peers: { connectedPeerCount: () => 0, peerExpected: () => true },
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(find).toHaveBeenCalledTimes(3)
    // The ORDINARY schedule, to the millisecond: two inter-attempt delays and
    // not one poll tick of waiting (`||` would report 2 500).
    expect(clock.wall()).toBe(1_000)
    expect(retryMarksFor('peerless-doc').map((entry) => entry.details.waived))
      .toEqual([false, false, false])
  })

  it('a handshake that FAILS mid-wait stops the waiting: it does not hold the budget', async () => {
    // The transport gives up — the socket closed, a connection attempt failed,
    // the browser went offline. "A peer is on its way" stops being true, and
    // the waiver must stop with it, or "the server is down" would cost the
    // whole wall clock instead of the fast, honest failure it costs today.
    const clock = injectedClock()
    const { repo, find } = repoThatArrivesAt(clock, Number.POSITIVE_INFINITY)
    let expected = true

    const error = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 20_000, tries: 3, delayMs: 500, now: clock.now,
      sleep: async (ms: number) => {
        await clock.sleep(ms)
        if (clock.now() >= 1_000) expected = false
      },
      peers: { connectedPeerCount: () => 0, peerExpected: () => expected },
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(find.mock.calls.length).toBeLessThan(10)
    expect(clock.wall()).toBeLessThan(5_000)
  })

  it('the waiver is BOUNDED by the budget even when a peer keeps flapping', async () => {
    // A peer that connects and drops, forever, is the shape that could turn a
    // waiver into an unbounded wait. The wall is what forbids it — never a
    // count of flaps, which an adversarial transport chooses.
    const clock = injectedClock()
    const { repo } = repoThatArrivesAt(clock, Number.POSITIVE_INFINITY)
    let flap = 0

    const error = await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 3_000, tries: 3, delayMs: 100, now: clock.now, sleep: clock.sleep,
      peers: {
        connectedPeerCount: () => ((flap += 1) % 2 === 0 ? 1 : 0),
        peerExpected: () => true,
      },
    }).then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(clock.wall()).toBeLessThanOrEqual(3_000 + 100)
  })
})

/**
 * The instrument, and ONLY the instrument.
 *
 * Without these marks a fired CEILING cannot be told apart from a REJECTION
 * except by scraping `console.warn`, and a rejection leaves no trace at all.
 * The two paths share `tries` but not their wall budgets (~22s vs ~1.4s), so
 * "which one ran" is the first question any incident asks.
 * These marks answer it from the ordinary diagnostics timeline, with no probe
 * attached and no decision changed.
 */
describe('resolveReadyHandleWithRetry retry marks', () => {
  const url = 'automerge:marked-doc' as AutomergeUrl

  beforeEach(() => {
    __setClientTimelineEnabledForTest(true)
    resetClientTimeline()
  })
  afterEach(() => {
    __setClientTimelineEnabledForTest(null)
    resetClientTimeline()
  })

  const retryMarks = () => readClientTimeline().entries.filter((entry) => entry.name === 'boot.document.retry')

  it('names a REJECTED attempt as a rejection, with the document and the attempt number', async () => {
    const { repo } = rejectingRepo(new Error('Document marked-doc is unavailable'), 'unavailable')

    await expect(resolveReadyHandleWithRetry(repo, url, { tries: 2, delayMs: 0, sleep: async () => undefined }))
      .rejects.toBeInstanceOf(DocumentTemporarilyUnavailableError)

    // `waived` says whether the attempt was CHARGED: a rejection that
    // arrived with no peer connected and a handshake still in flight is a
    // real failed request that costs nothing, and an incident has to be able
    // to tell the two apart.
    expect(retryMarks().map((entry) => entry.details)).toEqual([
      { document: 'marked-doc', attempt: 1, cause: 'reject', waived: false },
      { document: 'marked-doc', attempt: 2, cause: 'reject', waived: false },
    ])
  })

  it('names an EXPIRED WINDOW as a ceiling, never as a rejection', async () => {
    const { repo } = silentishRepo()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(resolveReadyHandleWithRetry(repo, url, {
        tries: 2, delayMs: 0, findTimeoutMs: 15, sleep: async () => undefined,
      })).rejects.toBeInstanceOf(DocumentTemporarilyUnavailableError)
    } finally {
      warn.mockRestore()
    }

    expect(retryMarks().map((entry) => entry.details.cause)).toEqual(['ceiling', 'ceiling'])
  })

  it('is BOUNDED: a long retry run never floods the 500-entry timeline', async () => {
    // The timeline is a bounded ring: an unbounded per-attempt mark would push
    // the boot phases (`workspace.root`, `workspace.registry`) out of the very
    // snapshot an incident is read from — the instrument erasing the subject.
    const { repo } = rejectingRepo(new Error('Document marked-doc is unavailable'), 'unavailable')

    await expect(resolveReadyHandleWithRetry(repo, url, { tries: 40, delayMs: 0, sleep: async () => undefined }))
      .rejects.toBeInstanceOf(DocumentTemporarilyUnavailableError)

    expect(retryMarks().length).toBeLessThanOrEqual(8)
    expect(retryMarks().length).toBeGreaterThan(0)
  })

  it('R1c: the mark carries the TRANSPORT and the close code that ended it', async () => {
    // "reject, reject" alone hides the mechanism when it is a socket that fell
    // with code 1006 and came back moments later. Nothing decides on these two
    // fields — they make an incident legible from `readClientTimeline()` alone.
    const { repo } = rejectingRepo(new Error('Document marked-doc is unavailable'), 'unavailable')

    await expect(resolveReadyHandleWithRetry(repo, url, {
      tries: 2,
      delayMs: 0,
      sleep: async () => undefined,
      peers: {
        connectedPeerCount: () => 0,
        peerExpected: () => false,
        transportState: () => ({ phase: 'reconnecting', closeCode: 1006 }),
      },
    })).rejects.toBeInstanceOf(DocumentTemporarilyUnavailableError)

    expect(retryMarks().map((entry) => entry.details)).toEqual([
      { document: 'marked-doc', attempt: 1, cause: 'reject', waived: false, transport: 'reconnecting', closeCode: 1006 },
      { document: 'marked-doc', attempt: 2, cause: 'reject', waived: false, transport: 'reconnecting', closeCode: 1006 },
    ])
  })

  it('R1c: a transport that cannot say leaves the fields OUT, never guesses one', async () => {
    // The complement, and the one that keeps the instrument honest. An
    // oracle with no transport to describe returns null; a mark that filled in
    // `'idle'` there would put a state no socket was in into an incident.
    const { repo } = rejectingRepo(new Error('Document marked-doc is unavailable'), 'unavailable')

    await expect(resolveReadyHandleWithRetry(repo, url, {
      tries: 1,
      delayMs: 0,
      sleep: async () => undefined,
      peers: { connectedPeerCount: () => 0, peerExpected: () => false, transportState: () => null },
    })).rejects.toBeInstanceOf(DocumentTemporarilyUnavailableError)

    expect(retryMarks().map((entry) => entry.details))
      .toEqual([{ document: 'marked-doc', attempt: 1, cause: 'reject', waived: false }])
  })

  /** A repo whose find() never settles, so only the ceiling can end an attempt. */
  function silentishRepo() {
    const find = vi.fn(() => new Promise<never>(() => undefined))
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    return { repo, find }
  }
})

/**
 * "How will we know 2 000 ms stopped being enough?"
 *
 * The alarm has to PRECEDE the failure. A count of dead boots answers too
 * late: by the time it moves, users have already seen the defect. The reading
 * that moves first is the MARGIN — a waiver that ran into its cap while the
 * boot still succeeded — and these tests exist because a signal nobody has
 * ever watched increment cannot be trusted.
 *
 * So each counter is driven through the REAL `resolveReadyHandleWithRetry`,
 * never by calling the recorder directly: what is being pinned is that the
 * production path reaches it, in the state it claims to describe.
 */
describe('the waiver early-warning counters', () => {
  const documentId = 'peerless-doc'
  const url = `automerge:${documentId}` as AutomergeUrl

  beforeEach(() => { resetWaiverTelemetry() })
  afterEach(() => { resetWaiverTelemetry() })

  function injectedClock() {
    let wall = 0
    return { now: () => wall, sleep: async (ms: number) => { wall += ms }, wall: () => wall }
  }

  function alwaysRejectingRepo() {
    const find = vi.fn(async () => { throw new Error(`Document ${documentId} is unavailable`) })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    return { repo, find }
  }

  it('counts a CLIPPED waiver — the reading that moves before any boot fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clock = injectedClock()
    const { repo } = alwaysRejectingRepo()
    try {
      await resolveReadyHandleWithRetry(repo, url, {
        budgetMs: 25_000, tries: 3, delayMs: 500, now: clock.now, sleep: clock.sleep,
        peers: { connectedPeerCount: () => 0, peerExpected: () => true },
      }).catch(() => undefined)
    } finally {
      warn.mockRestore()
    }

    const telemetry = readWaiverTelemetry()
    expect(telemetry.granted).toBe(1)
    expect(telemetry.clipped).toBe(1)
    expect(telemetry.clippedRatio).toBe(1)
    // A clipped wait bounds the true latency from below and says nothing more,
    // so it must NOT enter the distribution: folding it in would drag the
    // percentiles toward the cap and hide the drift the cap is watched for.
    expect(telemetry.handshakeMs.count).toBe(0)
  })

  it('names the clip in the console, in the sentence an operator has to find', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clock = injectedClock()
    const { repo } = alwaysRejectingRepo()
    try {
      await resolveReadyHandleWithRetry(repo, url, {
        budgetMs: 25_000, tries: 1, delayMs: 0, now: clock.now, sleep: clock.sleep,
        peers: { connectedPeerCount: () => 0, peerExpected: () => true },
      }).catch(() => undefined)

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('the peer waiver hit its cap'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('before boots start failing'))
    } finally {
      warn.mockRestore()
    }
  })

  it('counts a healthy waiver and SAMPLES the handshake latency it majorizes', async () => {
    // The quantity WAIVER_BUDGET_MS is supposed to be an upper bound on, and
    // the only outcome that is evidence about it.
    const clock = injectedClock()
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    let peers = 0
    const find = vi.fn(async () => {
      if (peers === 0) throw new Error(`Document ${documentId} is unavailable`)
      return ready
    })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })

    await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 25_000, tries: 3, delayMs: 500, now: clock.now,
      sleep: async (ms: number) => { await clock.sleep(ms); if (clock.now() >= 600) peers = 1 },
      peers: { connectedPeerCount: () => peers, peerExpected: () => peers === 0 },
    })

    const telemetry = readWaiverTelemetry()
    expect(telemetry.granted).toBe(1)
    expect(telemetry.peerArrived).toBe(1)
    expect(telemetry.clipped).toBe(0)
    // ZERO is the healthy value, and the one reading that does not move with
    // the environment: absolute latencies rise on a slower deployment, a
    // well-sized cap keeps this at 0 anyway.
    expect(telemetry.clippedRatio).toBe(0)
    expect(telemetry.handshakeMs.count).toBe(1)
    expect(telemetry.handshakeMs.max).toBe(600)
    expect(telemetry.handshakeMs.p50).toBe(600)
  })

  it('does NOT cry wolf when the server simply went away', async () => {
    // `abandoned` (the transport stopped expecting anyone) and
    // `budget-exhausted` (the whole resolution ended the wait) are not
    // evidence about the cap. Collapsing either into `clipped` would fire the
    // early warning every time a server goes down — precisely the day nobody
    // can afford a false alarm.
    const clock = injectedClock()
    const { repo } = alwaysRejectingRepo()
    let expected = true

    await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 25_000, tries: 2, delayMs: 100, now: clock.now,
      sleep: async (ms: number) => { await clock.sleep(ms); if (clock.now() >= 300) expected = false },
      peers: { connectedPeerCount: () => 0, peerExpected: () => expected },
    }).catch(() => undefined)

    const telemetry = readWaiverTelemetry()
    expect(telemetry.granted).toBe(1)
    expect(telemetry.abandoned).toBe(1)
    expect(telemetry.clipped).toBe(0)
    expect(telemetry.clippedRatio).toBe(0)
  })

  it('tells the BUDGET running out apart from the CAP running out', async () => {
    // Same shape as the clipped test, but the resolution budget is shorter
    // than the cap, so the wall that ends the wait is not the one being
    // watched. Fails if every exhausted wait is reported as a clip.
    const clock = injectedClock()
    const { repo } = alwaysRejectingRepo()

    await resolveReadyHandleWithRetry(repo, url, {
      budgetMs: 500, tries: 3, delayMs: 100, now: clock.now, sleep: clock.sleep,
      peers: { connectedPeerCount: () => 0, peerExpected: () => true },
    }).catch(() => undefined)

    const telemetry = readWaiverTelemetry()
    expect(telemetry.granted).toBe(1)
    expect(telemetry.budgetExhausted).toBe(1)
    expect(telemetry.clipped).toBe(0)
  })

  it('reports no ratio at all before anything has been waived', () => {
    // `null`, never 0: "nothing has happened" and "nothing was clipped" are
    // different facts, and a 0 would read as a clean bill of health on a run
    // where the mechanism never armed. Same rule as `npm run fsck` refusing
    // to call an incomplete pass clean.
    expect(readWaiverTelemetry().clippedRatio).toBeNull()
    expect(readWaiverTelemetry().handshakeMs.p95).toBeNull()
  })
})

/**
 * THE PRICE GUARD.
 *
 * ── What it is guarding against ──────────────────────────────────────────────
 * The waiver arms on a RECONNECTION (`handshakePending()` is true while a
 * reconnect is armed). The allowance is `WAIVER_BUDGET_MS`, and
 * `resolveInBatches` makes ONE CALL PER DOCUMENT: on a reference landscape
 * that is 1 root + 16 registry shards + 1 ModelMeta = 18 boot-critical
 * documents.
 *
 * WITHOUT a shared allowance that costs 18 × 2 000 = 36 s of hourglass on a
 * boot whose server is unreachable while the browser still reports itself
 * ONLINE — a firewall in DROP, a fallen VPN, a captive portal, or plainly a
 * server that is down and whose socket keeps retrying. That would trade away
 * the flagship offline property in silence.
 *
 * ── Why the oracle is the REAL adapter ───────────────────────────────────────
 * A hand-written `peerExpected: () => true` would postulate the predicate
 * instead of exercising it. What matters is the ADAPTER's answer in one
 * specific state: socket fallen with 1006, reconnect armed. So the fixture
 * builds that state on the real class and reads the predicate through the
 * real `repoPeerAwareness` binding — this goes RED if the allowance stops
 * being shared.
 */
describe('T5 — the offline price of a shared boot', () => {
  /** 1 root + 16 registry shards + 1 ModelMeta, as on a 3 000-diagram
   * landscape. It is the count `resolveInBatches` really makes, not a round
   * number: a per-call allowance would be multiplied by it. */
  const BOOT_CRITICAL_DOCUMENTS = 18

  /**
   * A second copy of the adapter suite's socket stub, on purpose: importing it
   * from `adaptiveWebSocketClientAdapter.test.ts` would re-register that file's
   * `describe`s inside this one and run them twice.
   */
  class StubWebSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    static readonly instances: StubWebSocket[] = []

    readyState = StubWebSocket.CONNECTING
    binaryType = ''
    readonly url: string
    private readonly listeners = new Map<string, Set<(event: Event) => void>>()

    constructor(url: string) {
      this.url = url
      StubWebSocket.instances.push(this)
    }
    addEventListener(type: string, listener: (event: Event) => void): void {
      const set = this.listeners.get(type) ?? new Set()
      set.add(listener)
      this.listeners.set(type, set)
    }
    removeEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.get(type)?.delete(listener)
    }
    send(): void {}
    close(): void { this.readyState = StubWebSocket.CLOSED }
    closeWith(code: number): void {
      this.readyState = StubWebSocket.CLOSED
      for (const listener of this.listeners.get('close') ?? []) listener({ code } as CloseEvent)
    }
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    StubWebSocket.instances.length = 0
  })

  function injectedClock() {
    let wall = 0
    return { now: () => wall, sleep: async (ms: number) => { wall += ms }, wall: () => wall }
  }

  /** The transport of a browser whose server is unreachable: one connection
   * attempt has failed with an abnormal close and a retry is armed. */
  function serverDownAwareness(): { adapter: AdaptiveWebSocketClientAdapter; peers: PeerAwareness } {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', StubWebSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://down.test/automerge', {
      fastMinimumMs: 10_000, fastMaximumMs: 10_000, baseMs: 10_000, maximumMs: 10_000, random: () => 0,
    })
    adapter.connect('browser-peer' as PeerId)
    StubWebSocket.instances[0].closeWith(1006)
    const repo = { peers: [], networkSubsystem: { adapters: [adapter] } } as unknown as Repo
    return { adapter, peers: repoPeerAwareness(repo) }
  }

  function alwaysUnavailableRepo(documentId: string) {
    const find = vi.fn(async () => { throw new Error(`Document ${documentId} is unavailable`) })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    return { repo, find }
  }

  it('18 boot-critical documents on a RECONNECTING transport stay under 2,5 s', async () => {
    const { adapter, peers } = serverDownAwareness()

    // ANTI-VACUITY, checked on the FIXTURE rather than on the predicate under
    // test: the transport really is in the state this guard is about — the
    // socket fell with 1006 and a retry is armed. Without it the test could
    // pass on a transport that had simply gone idle, where the waiver never
    // arms anyway.
    expect(adapter.transportPhase()).toBe('reconnecting')
    expect(adapter.lastCloseCode()).toBe(1006)

    const clock = injectedClock()
    const finds: number[] = []
    // ONE allowance for the whole boot — the shape `BOOT_DOCUMENT_RESOLUTION`
    // ships. Give each call its own and this reports 36 000 ms.
    const waiver = createWaiverAllocation()
    for (let index = 0; index < BOOT_CRITICAL_DOCUMENTS; index += 1) {
      const documentId = `boot-doc-${index}`
      const { repo, find } = alwaysUnavailableRepo(documentId)
      await resolveReadyHandleWithRetry(repo, `automerge:${documentId}` as AutomergeUrl, {
        waiver,
        budgetMs: 24_000,
        tries: 3,
        // ZERO on purpose. The inter-attempt delay is a CONSTANT unrelated to
        // the waiver — 2 × 500 ms per document — and leaving it in would bury
        // the quantity actually at risk under 18 s of schedule. What is measured here is exactly
        // the waiver allowance.
        delayMs: 0,
        now: clock.now,
        sleep: clock.sleep,
        peers,
      }).catch(() => undefined)
      finds.push(find.mock.calls.length)
    }

    // Every document really was asked for, three times. A guard that passed
    // because the loop short-circuited would be measuring nothing.
    expect(finds).toEqual(Array.from({ length: BOOT_CRITICAL_DOCUMENTS }, () => 3))
    // THE number. 18 × WAIVER_BUDGET_MS = 36 000 ms is what a per-call
    // allowance costs once the waiver arms here; a shared one costs the
    // allowance ONCE, for the whole boot.
    expect(BOOT_CRITICAL_DOCUMENTS * WAIVER_BUDGET_MS).toBe(36_000)
    expect(clock.wall()).toBeLessThanOrEqual(2_500)
  })

  it('and a browser that KNOWS it is offline still pays nothing at all', async () => {
    // The other half of the offline guarantee:
    // `navigator.onLine === false` ends `peerExpected()` before any transport
    // is consulted, so a genuinely offline boot is instant whatever the socket
    // underneath is doing.
    const { adapter, peers } = serverDownAwareness()
    vi.stubGlobal('navigator', { onLine: false })
    expect(adapter.transportPhase()).toBe('reconnecting')
    expect(peers.peerExpected()).toBe(false)

    const clock = injectedClock()
    for (let index = 0; index < BOOT_CRITICAL_DOCUMENTS; index += 1) {
      const documentId = `offline-doc-${index}`
      const { repo } = alwaysUnavailableRepo(documentId)
      await resolveReadyHandleWithRetry(repo, `automerge:${documentId}` as AutomergeUrl, {
        budgetMs: 24_000, tries: 3, delayMs: 0, now: clock.now, sleep: clock.sleep, peers,
      }).catch(() => undefined)
    }
    expect(clock.wall()).toBe(0)
  })
})

/**
 * The allowance is spent by a BOOT, not by a call.
 *
 * `resolveInBatches` makes one `resolveReadyHandleWithRetry` call per document,
 * so "per call" and "per boot" differ by a factor of 18 on the reference
 * landscape. T5 next door prices the whole boot; this pins the mechanism that
 * makes the price possible, on two calls, with a remainder that is neither
 * zero nor the full cap — an allowance reset per call would report the cap
 * twice and cannot fake a partial one.
 */
describe('T4 — one waiver allowance, shared across resolutions', () => {
  function injectedClock() {
    let wall = 0
    return { now: () => wall, sleep: async (ms: number) => { wall += ms }, wall: () => wall }
  }

  /** Rejects `unavailable` until `arrivesAt` on the shared clock, then answers. */
  function repoArrivingAt(clock: { now: () => number }, documentId: string, arrivesAt: number) {
    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    const find = vi.fn(async () => {
      if (clock.now() < arrivesAt) throw new Error(`Document ${documentId} is unavailable`)
      return ready
    })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    return { repo, find, ready }
  }

  it('the second resolution gets only what the first left — 800 ms of 2 000', async () => {
    const clock = injectedClock()
    const waiver = createWaiverAllocation(2_000)

    // First document: the handshake lands at 1 200 ms, so the boot really
    // waited for it and really spent 1 200 ms of the allowance.
    const first = repoArrivingAt(clock, 'first-doc', 1_200)
    await expect(resolveReadyHandleWithRetry(first.repo, 'automerge:first-doc' as AutomergeUrl, {
      budgetMs: 24_000, tries: 3, delayMs: 0, now: clock.now, sleep: clock.sleep, waiver,
      peers: {
        connectedPeerCount: () => (clock.now() >= 1_200 ? 1 : 0),
        peerExpected: () => true,
      },
    })).resolves.toBe(first.ready as unknown as DocHandle<unknown>)
    expect(clock.wall()).toBe(1_200)
    expect(waiver.remainingMs()).toBe(800)

    // Second document, same boot, same allowance: a peer that never comes may
    // now be waited for only 800 ms, not another 2 000.
    const second = repoArrivingAt(clock, 'second-doc', Number.POSITIVE_INFINITY)
    await resolveReadyHandleWithRetry(second.repo, 'automerge:second-doc' as AutomergeUrl, {
      budgetMs: 24_000, tries: 3, delayMs: 0, now: clock.now, sleep: clock.sleep, waiver,
      peers: { connectedPeerCount: () => 0, peerExpected: () => true },
    }).catch(() => undefined)

    // 1 200 + 800. A per-call allowance reports 3 200.
    expect(clock.wall()).toBe(2_000)
    expect(waiver.remainingMs()).toBe(0)
  })

  it('a caller that hands in NO allowance still gets a fresh one per call', async () => {
    // The compatibility half, and it is load-bearing: the model shards, the
    // active diagram and the overlay heads pass neither `peers` nor `waiver`,
    // and the shared allowance must not change what they cost. Two calls, no allowance
    // handed in, each gets the full cap.
    const clock = injectedClock()
    const walls: number[] = []
    for (const documentId of ['lone-a', 'lone-b']) {
      const before = clock.wall()
      const { repo } = repoArrivingAt(clock, documentId, Number.POSITIVE_INFINITY)
      await resolveReadyHandleWithRetry(repo, `automerge:${documentId}` as AutomergeUrl, {
        budgetMs: 24_000, tries: 1, delayMs: 0, now: clock.now, sleep: clock.sleep,
        peers: { connectedPeerCount: () => 0, peerExpected: () => true },
      }).catch(() => undefined)
      walls.push(clock.wall() - before)
    }
    expect(walls).toEqual([WAIVER_BUDGET_MS, WAIVER_BUDGET_MS])
  })
})

/**
 * A real boot trace, replayed as a unit. The six lines that matter:
 *
 *   t=15 339  CLOSE:1006                            the pipe lets go
 *   t=15 340  attempt 2  REJECT  waived: false      1 ms later
 *   t=15 845  attempt 3  REJECT  waived: false      + delayMs
 *   t=15 846  "… is unavailable after 3 attempt(s)" the boot dies
 *   t=15 858  OPEN                                  519 ms after the fall
 *   t=15 875  peer                                  29 ms AFTER the boot gave up
 *
 * So the peer is put here at 1 035 ms: a schedule that charges every
 * rejection spends its three at 0, 500 and 1 000 and throws at 1 000 — 35 ms
 * too early, the same margin as the real trace. Nothing about this test is a
 * round number by accident.
 *
 * It exercises the whole composition rather than a predicate: the REAL
 * adapter in the fallen state, the REAL `repoPeerAwareness` binding, the
 * shared allowance, and the retry mark that has to describe all of it.
 */
describe('T6 — a rejection during a RECONNECTION is not a spent attempt', () => {
  class FallenSocket {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    static readonly instances: FallenSocket[] = []

    readyState = FallenSocket.CONNECTING
    binaryType = ''
    readonly url: string
    private readonly listeners = new Map<string, Set<(event: Event) => void>>()

    constructor(url: string) {
      this.url = url
      FallenSocket.instances.push(this)
    }
    addEventListener(type: string, listener: (event: Event) => void): void {
      const set = this.listeners.get(type) ?? new Set()
      set.add(listener)
      this.listeners.set(type, set)
    }
    removeEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.get(type)?.delete(listener)
    }
    send(): void {}
    close(): void { this.readyState = FallenSocket.CLOSED }
    open(): void {
      this.readyState = FallenSocket.OPEN
      for (const listener of this.listeners.get('open') ?? []) listener(new Event('open'))
    }
    peer(senderId = 'server-peer'): void {
      const bytes = Uint8Array.from(cbor.encode({ type: 'peer', senderId, peerMetadata: {} }))
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent)
    }
    closeWith(code: number): void {
      this.readyState = FallenSocket.CLOSED
      for (const listener of this.listeners.get('close') ?? []) listener({ code } as CloseEvent)
    }
  }

  /** The 519 ms of the trace, rounded up to the failing schedule: a
   * charge-every-rejection implementation throws at 1 000 ms, so a peer at
   * 1 035 arrives 35 ms too late (the real trace missed by 29 ms). */
  const PEER_RETURNS_AT_MS = 1_035

  beforeEach(() => {
    __setClientTimelineEnabledForTest(true)
    resetClientTimeline()
  })
  afterEach(() => {
    __setClientTimelineEnabledForTest(null)
    resetClientTimeline()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    FallenSocket.instances.length = 0
  })

  it('the peer that comes back after the old schedule died is USED', async () => {
    const documentId = '4Hk17rz6'
    let wall = 0
    const clock = { now: () => wall, sleep: async (ms: number) => { wall += ms } }

    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FallenSocket)
    const adapter = new AdaptiveWebSocketClientAdapter('ws://trace.test/automerge', {
      fastMinimumMs: 60_000, fastMaximumMs: 60_000, baseMs: 60_000, maximumMs: 60_000, random: () => 0,
    })
    adapter.connect('browser-peer' as PeerId)
    FallenSocket.instances[0].open()
    // A peer really HAS answered on this socket: the fall is mid-boot, not a
    // first handshake — the case a predicate latched on `ready` or
    // `reconnectAttempt` would wrongly exclude.
    FallenSocket.instances[0].peer()
    expect(adapter.isReady()).toBe(true)
    FallenSocket.instances[0].closeWith(1006)
    expect(adapter.transportPhase()).toBe('reconnecting')

    const ready = { documentId, state: 'ready', whenReady: vi.fn(async () => undefined) }
    const find = vi.fn(async () => {
      if (wall < PEER_RETURNS_AT_MS) throw new Error(`Document ${documentId} is unavailable`)
      return ready
    })
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
      // The peer is back on the wire at the same instant the document becomes
      // servable — one event, as it is on a real socket.
      get peers() { return wall >= PEER_RETURNS_AT_MS ? ['server-peer'] : [] },
      networkSubsystem: { adapters: [adapter] },
    })

    const handle = await resolveReadyHandleWithRetry(repo, `automerge:${documentId}` as AutomergeUrl, {
      budgetMs: 24_000,
      tries: 3,
      delayMs: 500,
      findTimeoutMs: 3_000,
      now: clock.now,
      sleep: clock.sleep,
      peers: repoPeerAwareness(repo),
      waiver: createWaiverAllocation(),
    })

    // THE discriminator. A charge-every-rejection implementation throws
    // `DocumentTemporarilyUnavailable` at 1 000 ms here, having spent all three attempts on rejections that
    // said nothing about the document.
    expect(handle).toBe(ready as unknown as DocHandle<unknown>)
    expect(wall).toBeGreaterThanOrEqual(PEER_RETURNS_AT_MS)
    // Inside the shared allowance, and nowhere near the resolution budget.
    expect(wall).toBeLessThanOrEqual(WAIVER_BUDGET_MS)
    // Two asks: the one that was waived, and the one that succeeded.
    expect(find).toHaveBeenCalledTimes(2)

    // …and the whole thing is legible from the timeline alone: the rejection,
    // that it was NOT charged, and the socket state that explains why — no
    // external wire probe needed.
    expect(readClientTimeline().entries
      .filter((entry) => entry.name === 'boot.document.retry')
      .map((entry) => entry.details))
      .toEqual([{ document: documentId, attempt: 1, cause: 'reject', waived: true, transport: 'reconnecting', closeCode: 1006 }])
  })
})

/**
 * The stall budget. The failure these tests are about is NOT a race and NOT a
 * transport fault: it is a boot abandoning a document while the server is
 * visibly delivering, because an allowance counted from the request ignores
 * that the server serves one document at a time. On a throttled link (e.g.
 * ~180 kB/s) the last batch of registry shards can blow every window while the
 * transport reports `connected` and hundreds of kB arrive inside the window.
 *
 * These use FAKE TIMERS rather than the injected clock the budget tests use,
 * and that is forced: the ceiling is a real `setTimeout`, so a schedule
 * expressed in seconds cannot be driven by a `sleep` seam alone. Under fake timers
 * `Date.now()` IS the wall, so the fixture reads its progress and its
 * serving-time off the same clock the code under test does.
 */
describe('resolveReadyHandleWithRetry progress-aware stall budget (#37ter)', () => {
  const url = 'automerge:queued-shard' as AutomergeUrl
  const FAKE_EPOCH = 1_000

  beforeEach(() => {
    resetProgressTelemetry()
    vi.useFakeTimers({ now: FAKE_EPOCH })
  })
  afterEach(() => {
    vi.useRealTimers()
    resetProgressTelemetry()
  })

  /**
   * The measured shape, as a fixture: a server that IS serving this client the
   * whole time and reaches this particular document only at `servedAtMs`.
   *
   * `bytesPerMs` is the witness the fix consults. 100 = 100 kB/s, two orders
   * of magnitude above `MIN_PROGRESS_BYTES` per 3 s window — a real transfer.
   * Set it to 0 for a server that has gone quiet, or to 0.5 for chatter.
   */
  function servingRepo(options: { servedAtMs: number; bytesPerMs: number; peers?: number }) {
    const ready = { documentId: 'queued-shard', state: 'ready', whenReady: vi.fn(async () => undefined) }
    // Never settles until its turn comes — the automerge-repo shape when a
    // network adapter is attached and the peer has not answered for THIS
    // document yet, which is exactly a document queued behind
    // another on a server that serves one at a time.
    const find = vi.fn(() => (
      Date.now() - FAKE_EPOCH >= options.servedAtMs
        ? Promise.resolve(ready)
        : new Promise<never>(() => undefined)
    ))
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    const peers: PeerAwareness = {
      connectedPeerCount: () => options.peers ?? 1,
      peerExpected: () => false,
      inboundBytes: () => Math.floor((Date.now() - FAKE_EPOCH) * options.bytesPerMs),
    }
    return { repo, find, peers, ready }
  }

  /** The boot-critical numbers, so a change to them fails these tests too. */
  const BOOT = { tries: 3, delayMs: 500, findTimeoutMs: 3_000, budgetMs: 24_000 } as const

  /** Run a resolution to completion under fake timers and report the wall it
   * REALLY took.
   *
   * `elapsedMs` is stamped inside the settle callback, never read after the
   * fact: `advanceTimersByTimeAsync` runs the clock all the way to `forMs`
   * whatever the promise did, so a reading taken afterwards says how far the
   * TEST advanced and not how long the subject took. That is the measurement
   * mistake this repository keeps paying for, one layer down. */
  async function settle<T>(
    promise: Promise<T>,
    forMs: number,
  ): Promise<{ value: T | null; error: unknown; elapsedMs: number }> {
    let settledAt: number | null = null
    const outcome = promise.then(
      (value) => { settledAt = Date.now(); return { value, error: null as unknown } },
      (error: unknown) => { settledAt = Date.now(); return { value: null, error } },
    )
    await vi.advanceTimersByTimeAsync(forMs)
    const settled = await outcome
    return { ...settled, elapsedMs: (settledAt ?? Date.now()) - FAKE_EPOCH }
  }

  it('P1: a document QUEUED behind others survives past the stall wall and resolves', async () => {
    // THE defect. `servedAtMs` is 60 000: two and a half times `budgetMs`, and
    // nearly three times the 22 000 ms three-attempt schedule. Every window in
    // between expires with the socket delivering 300 kB.
    //
    // Without the stall budget this throws `DocumentTemporarilyUnavailable` at
    // 22 000 ms having asked three times.
    const { repo, find, peers } = servingRepo({ servedAtMs: 60_000, bytesPerMs: 100 })
    const { value, error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 120_000, peers, now: () => Date.now(),
    }), 200_000)

    expect(error).toBeNull()
    expect(value).toBeDefined()
    expect(elapsedMs).toBeGreaterThanOrEqual(60_000)
    // The stall wall never ran out, so the call never came near the absolute
    // one either.
    expect(elapsedMs).toBeLessThan(120_000)
    // It kept ASKING — honestly counted — and none of those asks was charged.
    expect(find.mock.calls.length).toBeGreaterThan(3)
    const telemetry = readProgressTelemetry()
    expect(telemetry.extended).toBeGreaterThan(3)
    expect(telemetry.hardCapped).toBe(0)
    expect(telemetry.stallEnded).toBe(0)
    // The margin, reported on the SUCCESS path: this is the figure an operator
    // compares against `maxBudgetMs` before anything has failed.
    expect(telemetry.maxExtendedMs).toBeGreaterThan(24_000)
  })

  it('P2: a server that goes QUIET still fails inside `budgetMs` — the price guard', async () => {
    // The half that must NOT change. If progress could be assumed rather than
    // observed, this is the test that would go from ~24 s to two minutes, and
    // the product fast failure against a dead server would be gone with it.
    const { repo, peers } = servingRepo({ servedAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 0 })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 120_000, peers, now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    // 24 000, not 22 000. On a quiet server it is the STALL WALL that ends the
    // call, not `tries` at 22 000 — the two seconds are the whole price of the
    // stall budget on the dead-server path, and they are asserted rather than
    // hoped for. Everything the offline boot depends on is intact:
    // one schedule, no waiting, a failure the user can retry.
    expect(elapsedMs).toBeGreaterThanOrEqual(BOOT.budgetMs)
    expect(elapsedMs).toBeLessThan(BOOT.budgetMs + BOOT.delayMs)
    const telemetry = readProgressTelemetry()
    expect(telemetry.extended).toBe(0)
    expect(telemetry.stallEnded).toBe(1)
    expect(telemetry.hardCapped).toBe(0)
  })

  it('P2b: with `tries` out of the way, the STALL wall is what ends a quiet server', async () => {
    // The other half of P2, and the one that names the wall. `tries: 500`
    // removes the counter from the argument entirely, so the only thing that
    // can end this call is the wall since the last progress — and it must
    // still be `budgetMs`, not the absolute one, or the fix has quietly
    // traded a 24 s failure for a two-minute hourglass on a dead server.
    const { repo, peers } = servingRepo({ servedAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 0 })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, tries: 500, maxBudgetMs: 120_000, peers, now: () => Date.now(),
    }), 400_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(elapsedMs).toBeGreaterThanOrEqual(BOOT.budgetMs)
    expect(elapsedMs).toBeLessThan(BOOT.budgetMs + BOOT.delayMs)
    const telemetry = readProgressTelemetry()
    expect(telemetry.stallEnded).toBe(1)
    expect(telemetry.hardCapped).toBe(0)
    expect(telemetry.extended).toBe(0)
  })

  it('P3: CHATTER below the threshold cannot hold the wall open', async () => {
    // A heartbeat is ~100-650 bytes on this transport. Without
    // `MIN_PROGRESS_BYTES` any keep-alive would satisfy the witness and the
    // stall wall would never fire again — the fix would have removed the bound
    // instead of relocating it. 0,5 B/ms is 1 500 bytes per 3 s window.
    expect(MIN_PROGRESS_BYTES).toBeGreaterThan(1_500)
    const { repo, peers } = servingRepo({ servedAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 0.5 })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 120_000, peers, now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(elapsedMs).toBeLessThanOrEqual(BOOT.budgetMs)
    expect(readProgressTelemetry().extended).toBe(0)
  })

  it('P4: a peer that delivers FOREVER is bounded by the absolute wall, loudly', async () => {
    // The rule this helper exists to enforce — no unbounded wait on a boot
    // path — applied to the mechanism that relaxes the other wall. A server
    // that keeps a socket warm without ever reaching this document must still
    // end the boot, and must SAY that it was the absolute wall, because that
    // verdict is about the deployment and not about any client setting.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { repo, peers } = servingRepo({ servedAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 100 })
      const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
        ...BOOT, maxBudgetMs: 40_000, peers, now: () => Date.now(),
      }), 200_000)

      expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
      expect(elapsedMs).toBeGreaterThanOrEqual(40_000)
      // Never a whole extra window past it: the ceiling is clamped to what is
      // left of BOTH walls, so the overshoot is bounded by one delay.
      expect(elapsedMs).toBeLessThanOrEqual(40_000 + BOOT.delayMs)
      const telemetry = readProgressTelemetry()
      expect(telemetry.hardCapped).toBe(1)
      expect(telemetry.stallEnded).toBe(0)
      expect(warn.mock.calls.some((call) => String(call[0]).includes('ABSOLUTE wall'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('P5: a caller that asked for no absolute wall gets the OLD behaviour, byte for byte', async () => {
    // The net is not optional and the trapeze is not free: extending without
    // an absolute wall would be the unbounded boot wait, so a caller that
    // passes no `maxBudgetMs` keeps the three-attempt schedule it has always
    // had — even with a peer delivering. This is what every unbudgeted model
    // and diagram call site still relies on.
    const { repo, find, peers } = servingRepo({ servedAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 100 })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, peers, now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(find).toHaveBeenCalledTimes(3)
    expect(elapsedMs).toBe(22_000)
    expect(readProgressTelemetry().extended).toBe(0)
  })

  it('P6: bytes with NO peer connected extend nothing', async () => {
    // Pins the `connectedPeerCount() > 0` conjunct.
    // Bytes on the wire during a teardown, or on a transport this repo is no
    // longer routed through, are not evidence that this document is coming.
    const { repo, peers } = servingRepo({
      servedAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 100, peers: 0,
    })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 120_000, peers, now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(elapsedMs).toBeLessThanOrEqual(BOOT.budgetMs)
    expect(readProgressTelemetry().extended).toBe(0)
  })

  it('P7: a `peers` that cannot answer `inboundBytes` extends nothing', async () => {
    // The seam is OPTIONAL, and its absence must read as "no progress
    // observed" rather than as progress asserted — the same ruling
    // `transportState` gets. Every existing caller with a hand-written double
    // lands here.
    const { repo } = servingRepo({ servedAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 100 })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT,
      maxBudgetMs: 120_000,
      now: () => Date.now(),
      peers: { connectedPeerCount: () => 1, peerExpected: () => false },
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(elapsedMs).toBeLessThanOrEqual(BOOT.budgetMs)
    expect(readProgressTelemetry().extended).toBe(0)
  })

  it('P8: an extended window is legible in the timeline, with the bytes that bought it', async () => {
    // An incident must be readable from
    // `readClientTimeline()` alone. A `ceiling` mark WITHOUT `progressBytes`
    // is a window that expired on a quiet socket; one WITH it is a document
    // waiting its turn. Those are opposite findings and they must not look the
    // same afterwards.
    __setClientTimelineEnabledForTest(true)
    resetClientTimeline()
    const { repo, peers } = servingRepo({ servedAtMs: 10_000, bytesPerMs: 100 })
    const { error } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 120_000, peers, now: () => Date.now(),
    }), 200_000)

    expect(error).toBeNull()
    const marks = readClientTimeline().entries
      .filter((entry) => entry.name === 'boot.document.retry')
      .map((entry) => entry.details as { cause?: string; progressBytes?: number })
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.every((mark) => mark.cause === 'ceiling')).toBe(true)
    expect(marks.every((mark) => (mark.progressBytes ?? 0) >= MIN_PROGRESS_BYTES)).toBe(true)
  })

  it('P9: a transport that delivers on EVERY look cannot spin the loop', async () => {
    // The degenerate case both locks exist for, and the one a wall-clock
    // assertion cannot see: when the walls are spent the ceiling is clamped to
    // 0 ms, and a witness that reports fresh bytes even across a zero-length
    // window would satisfy `productive`, hand `attempt` back, and re-arm the
    // stall wall — for ever, at full CPU, with the clock standing still. The
    // fixture makes that literal: `inboundBytes` grows on every READ, not with
    // time, which is the strongest witness a transport could possibly be.
    //
    // Pins BOTH locks; the loop guard is visible only here, because every
    // other test advances a clock and this failure needs none. Without either
    // lock the suite hangs on this test rather than failing an assertion — a
    // timeout IS the failure signal here, because "it never stopped" is the
    // defect.
    let served = 0
    const peers: PeerAwareness = {
      connectedPeerCount: () => 1,
      peerExpected: () => false,
      inboundBytes: () => (served += 1_000_000),
    }
    const find = vi.fn(() => new Promise<never>(() => undefined))
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })

    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 40_000, peers, now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(elapsedMs).toBeGreaterThanOrEqual(40_000)
    expect(elapsedMs).toBeLessThanOrEqual(40_000 + BOOT.delayMs)
    // A bound on the WORK, not just on the wall. The schedule that reaches
    // 40 000 ms with 3 s windows asks about a dozen times; a spin asks
    // millions, and would be a busy loop on a boot path even if it terminated.
    expect(find.mock.calls.length).toBeLessThan(100)
    expect(readProgressTelemetry().hardCapped).toBe(1)
  })

  /**
   * A socket that has FALLEN: no peer, a reconnect armed, and `find()`
   * rejecting `unavailable` instantly — which is what automerge-repo does the
   * moment `peers.size` reaches 0 — until the peer returns at `backAtMs`.
   *
   * `bytesPerMs` is what the transport delivered BEFORE the fall. It is the
   * only thing separating "my socket bounced during a working boot" from "the
   * server is down", and both must keep their own outcome.
   */
  function bouncedRepo(options: { backAtMs: number; bytesPerMs: number }) {
    const ready = { documentId: 'queued-shard', state: 'ready', whenReady: vi.fn(async () => undefined) }
    const find = vi.fn(() => (
      Date.now() - FAKE_EPOCH >= options.backAtMs
        ? Promise.resolve(ready)
        : Promise.reject(new Error('Document queued-shard is unavailable'))
    ))
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    const peers: PeerAwareness = {
      connectedPeerCount: () => 0,
      peerExpected: () => true,
      inboundBytes: () => Math.floor((Date.now() - FAKE_EPOCH) * options.bytesPerMs),
    }
    return { repo, find, peers }
  }

  it('P10: a socket that BOUNCES on a working boot does not spend attempts, allowance or not', async () => {
    // THE second limb — a real trace with only the ceiling half in place:
    //   t=53 390  ceiling, progressBytes 525 252
    //   t=53 393  CLOSE 1006
    //   t=53 394  reject, waived: false   <- charged
    //   t=53 897  reject, waived: false   <- charged, and dead
    // Two charged attempts in 503 ms on a boot that had pulled 2,89 MB. The
    // waiver was right not to arm — its shared 2 000 ms allowance had been
    // spent by three earlier bounces — and the rule was wrong: an exhausted
    // time budget cannot turn a non-verdict into a verdict.
    //
    // The allowance here is created ALREADY SPENT, so the waiver cannot be
    // what saves this boot.
    const { repo, find, peers } = bouncedRepo({ backAtMs: 10_000, bytesPerMs: 100 })
    const { value, error } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT,
      maxBudgetMs: 120_000,
      peers,
      waiver: createWaiverAllocation(0),
      now: () => Date.now(),
    }), 200_000)

    expect(error).toBeNull()
    expect(value).toBeDefined()
    // Far more than `tries`: every one of those rounds was a real request that
    // really failed, and not one of them said anything about the document.
    expect(find.mock.calls.length).toBeGreaterThan(BOOT.tries)
    expect(readProgressTelemetry().extended).toBeGreaterThan(0)
  })

  it('P10b: a socket that stays down past the STALL wall does end the call', async () => {
    // The bound on the limb above, and the reason it does not move the stall
    // anchor: while the socket is down NOTHING arrives, so the wall since the
    // last delivery keeps running and ends the call at `budgetMs`. Forgiving
    // the rejection buys the boot a reconnect (~500 ms in practice), not an
    // unbounded outage.
    const { repo, peers } = bouncedRepo({ backAtMs: 90_000, bytesPerMs: 100 })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT,
      maxBudgetMs: 120_000,
      peers,
      waiver: createWaiverAllocation(0),
      now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(elapsedMs).toBeGreaterThanOrEqual(BOOT.budgetMs)
    expect(elapsedMs).toBeLessThan(BOOT.budgetMs + BOOT.delayMs)
    expect(readProgressTelemetry().stallEnded).toBe(1)
  })

  it('P11: a server that never delivered ANYTHING still fails fast — the offline price', async () => {
    // The price guard for the second limb, and the one that decides whether
    // this fix is shippable at all. `peerExpected()` is true for the whole of
    // an outage — a reconnect is always armed — so forgiving on that alone
    // would trade the product instant offline boot for a 24 s hourglass.
    // The witness is what stops it: nothing was ever delivered, so nothing is
    // forgiven and `tries` ends the call in one schedule of delays.
    const { repo, find, peers } = bouncedRepo({ backAtMs: Number.MAX_SAFE_INTEGER, bytesPerMs: 0 })
    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT,
      maxBudgetMs: 120_000,
      peers,
      waiver: createWaiverAllocation(0),
      now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(find).toHaveBeenCalledTimes(BOOT.tries)
    // Three sub-millisecond rejections and two inter-attempt delays: the
    // ordinary ~1.0-1.5 s, unchanged.
    expect(elapsedMs).toBeLessThanOrEqual(2 * BOOT.delayMs)
    expect(readProgressTelemetry().extended).toBe(0)
  })
  it('P12: a CONNECTED peer saying no is still a verdict, however busy the socket is', async () => {
    // Pins `noPeerButOneIsComing` in the rebound limb. A peer that is connected and answers "I do not have this document"
    // says the same thing the fortieth time — that is the whole reason `tries`
    // exists — and a busy socket must not turn that answer into a maybe. This
    // is the boundary between the two halves of the stall budget: progress excuses a
    // MISSING peer, never a peer that answered.
    const ready = { documentId: 'queued-shard', state: 'ready', whenReady: vi.fn(async () => undefined) }
    void ready
    const find = vi.fn(() => Promise.reject(new Error('Document queued-shard is unavailable')))
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'unavailable' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })
    const peers: PeerAwareness = {
      connectedPeerCount: () => 1,
      peerExpected: () => true,
      inboundBytes: () => Math.floor((Date.now() - FAKE_EPOCH) * 100),
    }

    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 120_000, peers, waiver: createWaiverAllocation(0), now: () => Date.now(),
    }), 200_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    expect(find).toHaveBeenCalledTimes(BOOT.tries)
    expect(elapsedMs).toBeLessThanOrEqual(2 * BOOT.delayMs)
    expect(readProgressTelemetry().extended).toBe(0)
  })
  it('P13: a transport that delivered BEFORE this call does not buy it a free wall', async () => {
    // The difference between a 24 s failure and a two-minute one. If
    // `lastProgressBytes` started at 0, the first comparison would be a delta
    // of everything the tab had EVER received — megabytes, on a boot — and the
    // very first ceiling would move the stall wall on bytes that arrived before
    // this document was even asked for: a boot whose server went silent would
    // sit on the 120 000 ms ABSOLUTE wall instead of failing at 24 000 ms.
    //
    // The fixture is that exact shape: 6 MB already on the counter, and not
    // one byte more from here on.
    const alreadyDelivered = 6 * 1024 * 1024
    const peers: PeerAwareness = {
      connectedPeerCount: () => 1,
      peerExpected: () => false,
      inboundBytes: () => alreadyDelivered,
    }
    const find = vi.fn(() => new Promise<never>(() => undefined))
    const repo = fakeRepo({
      find,
      findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
      handles: {},
      removeFromCache: vi.fn(async () => undefined),
    })

    const { error, elapsedMs } = await settle(resolveReadyHandleWithRetry(repo, url, {
      ...BOOT, maxBudgetMs: 120_000, peers, now: () => Date.now(),
    }), 400_000)

    expect(error).toBeInstanceOf(DocumentTemporarilyUnavailableError)
    // The STALL wall, not the absolute one (otherwise 120 000).
    expect(elapsedMs).toBeGreaterThanOrEqual(BOOT.budgetMs)
    expect(elapsedMs).toBeLessThan(BOOT.budgetMs + BOOT.delayMs)
    const telemetry = readProgressTelemetry()
    expect(telemetry.stallEnded).toBe(1)
    expect(telemetry.hardCapped).toBe(0)
  })
})
