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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMemoryKvStore, workspaceKvStore, __setWorkspaceKvBaseForTest, type KvStore } from '../modelQuery/kvStore'
import { RESERVE_BLOCK_SIZE, RESERVE_LOW_WATER } from './mintedIdReserve'
import {
  startMintedIdSupply,
  stopMintedIdSupply,
  takeMintedDocumentIdBytes,
  notifyMintedIdSupplyOnline,
  notifyMintedIdSupplyHostReachable,
  mintedIdSupplyStats,
  POOL_TARGET,
  ensureMintedIdCapacity,
  MINT_JOIN_DEADLINE_MS,
  MINT_FETCH_TIMEOUT_MS,
} from './mintedIdSupply'
import { apiFetch } from '../api/http'

vi.mock('../api/http', () => ({ apiFetch: vi.fn() }))
const apiFetchMock = vi.mocked(apiFetch)

/** Base64 of `[1, marker, 0…]`, 24 bytes — the shape the mint endpoint returns. */
function fakeMintedId(marker: number): string {
  const bytes = new Uint8Array(24)
  bytes[0] = 1
  bytes[1] = marker & 0xff
  bytes[2] = (marker >> 8) & 0xff
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const markerOf = (id: Uint8Array): number => id[1]! + (id[2]! << 8)

/** One key, matching mintedIdReserve's RESERVE_KEY (already pinned by its own tests). */
const RESERVE_KEY = 'mintedIds/reserve@2'

const REF = { landscapeId: 'default', versionId: 'current' }

function mintResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** A 200 responder that answers exactly `count` fresh ids under one canonical key. */
function respondCanonical(landscapeId: string, versionId: string, firstMarker = 100) {
  let next = firstMarker
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const req = JSON.parse(String(init?.body)) as { count: number }
    const ids = Array.from({ length: req.count }, () => fakeMintedId(next++))
    return mintResponse(200, { landscapeId, versionId, ids })
  }
}

function requestBody(call: number): { landscapeId: string; versionId: string; count: number } {
  return JSON.parse(String(apiFetchMock.mock.calls[call]![1]?.body)) as {
    landscapeId: string
    versionId: string
    count: number
  }
}

describe('minted id supply', () => {
  beforeEach(() => {
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    apiFetchMock.mockReset()
  })

  afterEach(() => {
    stopMintedIdSupply()
    vi.useRealTimers()
    __setWorkspaceKvBaseForTest(null)
  })

  // The module is INERT outside a session. repo.ts is evaluated at import, so
  // a replenish fired at module import would call the mocked fetch here.
  it('take before start returns null and triggers no fetch', async () => {
    expect(takeMintedDocumentIdBytes()).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  // Pins `count = clamp(POOL_TARGET − (available + remaining), 1, 64)`.
  // Mutant: `count: 64` hardcoded (over-minting widens the revoked-member
  // window — the pool is small as a SECURITY decision) → fails on the body.
  it('boot replenish tops the pool up to BLOCK+LOW_WATER and requests exactly the deficit', async () => {
    const seeded = Array.from({ length: 10 }, (_v, i) => fakeMintedId(i + 1))
    await workspaceKvStore().set(RESERVE_KEY, { ids: seeded, workspace: 'default/v-main' })
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))

    startMintedIdSupply(REF)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))

    // The request carries the ref AS ROUTED (`current` alias — the server
    // canonicalises) and asks for the deficit only: 24 − (10 hydrated + 0).
    expect(requestBody(0)).toEqual({
      landscapeId: 'default',
      versionId: 'current',
      count: POOL_TARGET - 10,
    })
    expect(POOL_TARGET).toBe(RESERVE_BLOCK_SIZE + RESERVE_LOW_WATER)

    // The deposit lands: 10 in memory + 14 persisted = POOL_TARGET.
    await vi.waitFor(async () => {
      const pool = await workspaceKvStore().get<{ ids: string[] }>(RESERVE_KEY)
      expect(pool?.ids.length ?? 0).toBe(POOL_TARGET - 10)
    })

    // A FULL pool tops up nothing: the online nudge must compute deficit ≤ 0.
    notifyMintedIdSupplyOnline()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  // Mutant: one fetch per take() → 2+ calls counted here.
  it('concurrent takes schedule ONE replenish (single-flight)', async () => {
    const seeded = Array.from({ length: POOL_TARGET }, (_v, i) => fakeMintedId(i + 1))
    await workspaceKvStore().set(RESERVE_KEY, { ids: seeded, workspace: 'default/v-main' })
    // A SLOW fetch, so every take-triggered replenish overlaps the first.
    let settle: ((response: Response) => void) | null = null
    apiFetchMock.mockImplementation(() => new Promise<Response>((resolve) => { settle = resolve }))

    startMintedIdSupply(REF)
    // Boot: available 16 + remaining 8 = POOL_TARGET → deficit 0 → NO boot fetch.
    await vi.waitFor(() => expect(mintedIdSupplyStats().available).toBeGreaterThan(0))
    expect(apiFetchMock).not.toHaveBeenCalled()

    expect(takeMintedDocumentIdBytes()).not.toBeNull()
    expect(takeMintedDocumentIdBytes()).not.toBeNull()
    expect(takeMintedDocumentIdBytes()).not.toBeNull()
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(apiFetchMock, 'three concurrent takes must join ONE in-flight replenish').toHaveBeenCalledTimes(1)
    settle!(mintResponse(200, { landscapeId: 'default', versionId: 'v-main', ids: [fakeMintedId(90)] }))
  })

  // Mutant: immediate retry in the .catch → dozens of calls inside the
  // simulated window instead of one per backoff step.
  it('offline failure backs off exponentially and never storms', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockRejectedValue(new TypeError('network down'))

    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    // 5 s → 10 s → 20 s, each boundary exact (never a retry inside the wait).
    await vi.advanceTimersByTimeAsync(4_999)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(4)

    // Climb to the cap…
    await vi.advanceTimersByTimeAsync(40_000) // 5
    await vi.advanceTimersByTimeAsync(80_000) // 6
    await vi.advanceTimersByTimeAsync(160_000) // 7
    await vi.advanceTimersByTimeAsync(300_000) // 8 (320 s capped to 300 s)
    const atCap = apiFetchMock.mock.calls.length
    expect(atCap).toBe(8)
    // …and stay there: exactly one attempt per further 5-minute window.
    await vi.advanceTimersByTimeAsync(300_000)
    expect(apiFetchMock.mock.calls.length).toBe(atCap + 1)
  })

  // The pure-reader rule: 403 = silence for the whole workspace session.
  // Mutant: 403 treated like 503 (backoff-retry) → a second call after the
  // timers advance.
  it('a 403 silences minting for the whole session', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(mintResponse(403, { error: 'forbidden' }))

    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    // Neither takes nor the online nudge may re-ask within the session.
    takeMintedDocumentIdBytes()
    notifyMintedIdSupplyOnline()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(apiFetchMock, 'a reader must cost AT MOST one mint request per session').toHaveBeenCalledTimes(1)

    // A new session re-arms: every access change restarts the bridge, and the
    // bridge restart is what calls startMintedIdSupply again.
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })

  // Drop + re-mint on an observed repoint.
  // Mutant: deposit without drainReserve → a v1 id is still takeable → an id
  // minted for the OLD canonical version reads displaced/foreign on the gate.
  it('a mint response for a different canonical version drops the block and rebinds the pool', async () => {
    const v1Ids = [fakeMintedId(1), fakeMintedId(2)]
    await workspaceKvStore().set(RESERVE_KEY, { ids: v1Ids, workspace: 'default/v1' })
    apiFetchMock.mockImplementation(respondCanonical('default', 'v2', 100))

    startMintedIdSupply(REF)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalled())

    // The persisted pool rebinds to the response's canonical key…
    await vi.waitFor(async () => {
      const pool = await workspaceKvStore().get<{ ids: string[]; workspace: string }>(RESERVE_KEY)
      expect(pool?.workspace).toBe('default/v2')
    })
    // …and take() never again yields a v1 id (markers 1-2).
    await vi.waitFor(() => expect(mintedIdSupplyStats().available).toBeGreaterThan(0))
    expect(mintedIdSupplyStats().poolWorkspace).toBe('default/v2')
    for (let bytes = takeMintedDocumentIdBytes(); bytes; bytes = takeMintedDocumentIdBytes()) {
      expect(markerOf(bytes), 'a v1 id survived the rebind').toBeGreaterThanOrEqual(100)
    }
  })

  // The stopBridge contract, seen from the supply's side: the outgoing
  // workspace's final lifecycle flush still names its documents (stopBridge
  // calls flushPendingWritesForLifecycle FIRST, stopMintedIdSupply after), so
  // ids stay takeable until stop — and stop kills both the block and every
  // deferred replenish. Mutant: drain before the flush's take → null → the
  // final flush's documents lose their names.
  it("stop drains only after the outgoing workspace's final flush take", async () => {
    const seeded = Array.from({ length: 4 }, (_v, i) => fakeMintedId(i + 1))
    await workspaceKvStore().set(RESERVE_KEY, { ids: seeded, workspace: 'default/v-main' })
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))

    startMintedIdSupply(REF)
    await vi.waitFor(() => expect(mintedIdSupplyStats().available).toBeGreaterThan(0))
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1)) // boot top-up (deficit 20)
    const callsBeforeStop = apiFetchMock.mock.calls.length

    // The bridge's teardown order: the lifecycle flush's synchronous tail
    // creates documents that must still be named with the OUTGOING
    // workspace's ids…
    const flushTake = takeMintedDocumentIdBytes()
    expect(flushTake, 'the final flush must still receive an id').not.toBeNull()

    // …and only then the supply stops, drains, and invalidates continuations.
    stopMintedIdSupply()
    expect(takeMintedDocumentIdBytes()).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(apiFetchMock.mock.calls.length, "the flush take's deferred replenish must be dead after stop")
      .toBe(callsBeforeStop)
  })

  // Never await a fetch without a ceiling: a half-open mint fetch would pin
  // `inFlight` forever and freeze the tab's replenishment across sessions.
  // This asserts every request CARRIES an abort signal; the 15 s value itself
  // is not asserted, because AbortSignal.timeout runs on Node-internal timers
  // that vitest's fake timers do not drive.
  it('every mint request carries a wall-clock abort signal', async () => {
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))
    startMintedIdSupply(REF)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalled())
    expect(
      apiFetchMock.mock.calls[0]![1]?.signal,
      'a mint fetch without an abort ceiling can freeze replenishment for the tab lifetime',
    ).toBeInstanceOf(AbortSignal)
  })

  // The boot take-vs-binding race. A take can arm a deferred
  // replenish while startMintedIdSupply's IIFE is still awaiting IndexedDB;
  // reading the deficit at that instant sees reserve === null and mints a
  // FULL pool on top of the one about to be hydrated (~2×POOL_TARGET —
  // over-minting widens the revoked-member window). Mutant: the
  // `await bindingReady` in replenishOnce removed → the deferred replenish
  // fetches POOL_TARGET ids while the binding is gated below.
  it('a take during the boot binding waits for it and never over-mints', async () => {
    const base = createMemoryKvStore()
    let releaseBinding!: () => void
    const gate = new Promise<void>((resolve) => { releaseBinding = resolve })
    let gated = false
    const slow: KvStore = {
      ...base,
      get: async <T,>(key: string): Promise<T | undefined> => {
        if (gated) await gate
        return base.get<T>(key)
      },
    }
    __setWorkspaceKvBaseForTest(slow)
    const seeded = Array.from({ length: POOL_TARGET }, (_v, i) => fakeMintedId(i + 1))
    await workspaceKvStore().set(RESERVE_KEY, { ids: seeded, workspace: 'default/v-main' })
    gated = true

    startMintedIdSupply(REF)
    // The take lands while the binding is still awaiting the (gated) pool read.
    expect(takeMintedDocumentIdBytes()).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(apiFetchMock, 'the deficit must not be read before the binding').not.toHaveBeenCalled()

    gated = false
    releaseBinding()
    await vi.waitFor(() => expect(mintedIdSupplyStats().available).toBe(RESERVE_BLOCK_SIZE))
    await new Promise((resolve) => setTimeout(resolve, 40))
    // Full pool: 16 hydrated + 8 persisted = POOL_TARGET → deficit 0, no mint.
    expect(apiFetchMock, 'a full pool has deficit 0 — no fetch at all').not.toHaveBeenCalled()
    expect(mintedIdSupplyStats().poolWorkspace).toBe('default/v-main')
  })

  // The cross-session epoch guards, stop shape. A slow mint
  // that resolves AFTER stop must deposit nothing and resurrect nothing: the
  // drained session is OVER. Mutant: the `if (epoch !== sessionEpoch) return`
  // guards removed from replenishOnce → the late 200 rebuilds a reserve over
  // the stopped session's captured store and deposits into it.
  it('a mint resolving after stop deposits nothing and resurrects no reserve', async () => {
    let settle!: (response: Response) => void
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { settle = resolve }))

    startMintedIdSupply(REF) // empty pool → the boot replenish asks for the full deficit
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    stopMintedIdSupply()

    settle(mintResponse(200, {
      landscapeId: 'default',
      versionId: 'v-main',
      ids: Array.from({ length: POOL_TARGET }, (_v, i) => fakeMintedId(i + 1)),
    }))
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(takeMintedDocumentIdBytes(), 'no resurrected reserve after stop').toBeNull()
    expect(mintedIdSupplyStats().available).toBe(0)
    expect(mintedIdSupplyStats().poolWorkspace).toBeNull()
    expect(
      await workspaceKvStore().get(RESERVE_KEY),
      'zero deposit under a stopped session',
    ).toBeUndefined()
  })

  // The cross-session epoch guards, switch shape. A stale
  // mint from a PREVIOUS session resolving after ANOTHER workspace's session
  // started must not touch the new session's reserve. Mutant: guards removed →
  // the old 200's canonical mismatches the new pool → drainReserve(new) +
  // rebind to the OLD canonical + deposit of its ids (the new session then
  // names documents with another workspace's ids).
  it("a stale mint from a previous session cannot touch the new session's reserve", async () => {
    let settleOld!: (response: Response) => void
    // Base responder for any later (post-assertion) stray replenish: a 503
    // backs off instead of depositing, so it cannot rebind anything.
    apiFetchMock.mockImplementation(async () => mintResponse(503, { error: 'busy' }))
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { settleOld = resolve }))

    startMintedIdSupply(REF) // session 1: empty pool → one in-flight mint
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    stopMintedIdSupply()

    // Session 2 boots on a persisted pool bound to ANOTHER canonical version.
    const newIds = Array.from({ length: 4 }, (_v, i) => fakeMintedId(500 + i))
    await workspaceKvStore().set(RESERVE_KEY, { ids: newIds, workspace: 'other/v-b' })
    startMintedIdSupply({ landscapeId: 'other', versionId: 'current' })
    await vi.waitFor(() => expect(mintedIdSupplyStats().poolWorkspace).toBe('other/v-b'))
    await vi.waitFor(() => expect(mintedIdSupplyStats().available).toBe(4))

    // The OLD session's fetch finally resolves, under its own canonical key.
    settleOld(mintResponse(200, {
      landscapeId: 'default',
      versionId: 'v-main',
      ids: Array.from({ length: 24 }, (_v, i) => fakeMintedId(i + 1)),
    }))
    await new Promise((resolve) => setTimeout(resolve, 30))

    // The new session's reserve is INTACT: same binding, nothing drained…
    expect(mintedIdSupplyStats().poolWorkspace).toBe('other/v-b')
    expect(mintedIdSupplyStats().available).toBe(4)
    // …zero deposit under the old canonical…
    const pool = await workspaceKvStore().get<{ ids: string[]; workspace: string }>(RESERVE_KEY)
    expect(pool?.workspace).toBe('other/v-b')
    expect(pool?.ids).toEqual([])
    // …and every takeable id is still the new session's.
    for (let bytes = takeMintedDocumentIdBytes(); bytes; bytes = takeMintedDocumentIdBytes()) {
      expect(markerOf(bytes), 'an old-session id leaked into the new reserve').toBeGreaterThanOrEqual(500)
    }
  })
})

/**
 * THE BURST, WHICH THE BACKGROUND TOP-UP CANNOT SERVE.
 *
 * `takeMintedDocumentIdBytes` is synchronous and never blocks, and
 * `scheduleReplenish` is asynchronous — so a caller creating N documents in one
 * synchronous loop spends whatever happens to be in the reserve and takes random
 * ids for the rest (e.g. an 18-document import against a ~16-id reserve takes
 * 2 random ids, and those documents are the ones lost).
 *
 * The fix cannot live inside the loop. These pin the primitive that runs in
 * FRONT of it.
 */
describe('ensureMintedIdCapacity — pre-provisioning a bulk burst', () => {
  beforeEach(() => {
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    apiFetchMock.mockReset()
  })
  afterEach(() => {
    stopMintedIdSupply()
    vi.useRealTimers()
    __setWorkspaceKvBaseForTest(null)
  })

  it('mints enough for a burst LARGER than the standing pool, and the burst then takes no fallback', async () => {
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))
    startMintedIdSupply(REF)

    const BURST = POOL_TARGET + 14 // 38 — comfortably past the standing target
    const available = await ensureMintedIdCapacity(BURST)
    expect(available, 'the reserve must hold the whole burst before it starts').toBeGreaterThanOrEqual(BURST)

    // DELTAS, not absolutes: `takenMinted`/`takenFallback` are module counters
    // that no lifecycle call resets, so every earlier test in this file has
    // already moved them; asserting absolutes would depend on test ORDER.
    const before = mintedIdSupplyStats()
    // Now spend it the way a bulk import does: synchronously, in one loop.
    for (let i = 0; i < BURST; i++) expect(takeMintedDocumentIdBytes()).not.toBeNull()
    const after = mintedIdSupplyStats()
    expect(
      after.takenFallback - before.takenFallback,
      'no document in the burst may fall back to a random id',
    ).toBe(0)
    expect(after.takenMinted - before.takenMinted).toBe(BURST)
  })

  it('WITHOUT it, the same burst falls back — the defect this exists to prevent', async () => {
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))
    startMintedIdSupply(REF)
    // Let only the ORDINARY background top-up run.
    await vi.waitFor(() => { expect(mintedIdSupplyStats().available).toBeGreaterThan(0) })

    const BURST = POOL_TARGET + 14
    const baseline = mintedIdSupplyStats().takenFallback
    for (let i = 0; i < BURST; i++) takeMintedDocumentIdBytes()
    expect(
      mintedIdSupplyStats().takenFallback - baseline,
      'this is the measured defect: a burst past the pool takes random ids',
    ).toBeGreaterThan(0)
  })

  it('spans several requests when the burst exceeds one mint block', async () => {
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))
    startMintedIdSupply(REF)
    const BURST = 150 // > MAX_IDS_PER_REQUEST (64)
    const available = await ensureMintedIdCapacity(BURST)
    expect(available).toBeGreaterThanOrEqual(BURST)
    expect(apiFetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('a refusing server does not block the import: it returns short rather than throwing or spinning', async () => {
    // 403 = a read-only grant. One request, then silence — and crucially the
    // caller gets an answer immediately instead of burning the 15 s ceiling.
    apiFetchMock.mockResolvedValue(mintResponse(403))
    startMintedIdSupply(REF)
    const started = Date.now()
    const available = await ensureMintedIdCapacity(40)
    expect(available).toBe(0)
    expect(Date.now() - started, 'must not spin to the deadline').toBeLessThan(2_000)
  })

  // What the join is FOR: the ceiling tests only prove the join gives UP in
  // time, never that it happens. Two overlapping pre-provisions must read the
  // deficit once between them, not twice.
  it('JOINS a top-up in flight rather than racing it into a double mint', async () => {
    let calls = 0
    // Initialised rather than nullable: assigning inside the promise executor
    // is invisible to control-flow analysis, so a `| null` here narrows to
    // `never` at the call below (TS2349) rather than to a callable.
    let release: () => void = () => {}
    const responder = respondCanonical('default', 'v-main')
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        // Held open just long enough for the second caller to arrive and have
        // something to join. It succeeds, so the join is worth waiting for.
        await new Promise<void>((resolve) => { release = resolve })
      }
      return responder(url, init)
    })

    startMintedIdSupply(REF)
    await vi.waitFor(() => { expect(calls).toBe(1) })

    const BURST = POOL_TARGET + 14
    const pending = ensureMintedIdCapacity(BURST)
    // Let the joiner reach the join before the first request answers.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const duringJoin = calls
    release()
    expect(await pending).toBeGreaterThanOrEqual(BURST)

    // The joiner must not have issued a request while the first was in flight.
    // Without the join it reads the same deficit and mints a second full pool.
    expect(duringJoin, 'the joiner must WAIT, not race').toBe(1)
  })

  it('the join is SHORTER than the fetch it may be joining', () => {
    // If this ever inverts, joining a hung top-up can spend the whole capacity
    // budget and starve the loop without a line of the mechanism changing.
    expect(MINT_JOIN_DEADLINE_MS).toBeLessThan(MINT_FETCH_TIMEOUT_MS)
  })

  it('does not inherit a slow background top-up’s ceiling — it asks for its own ids', async () => {
    vi.useFakeTimers()
    let calls = 0
    const responder = respondCanonical('default', 'v-main')
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls += 1
      // The first request is the one that hurts: it started just before the
      // user clicked, so joining it costs its WHOLE remaining ceiling.
      //
      // It settles at that ceiling rather than hanging forever, because that is
      // what production does — `AbortSignal.timeout(MINT_FETCH_TIMEOUT_MS)`
      // guarantees settlement, and `inFlight` is never cleared by
      // `stopMintedIdSupply`. A fixture that hangs would model a state the
      // module cannot reach, and would pin `inFlight` for every later test.
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), MINT_FETCH_TIMEOUT_MS)
        })
      }
      return responder(url, init)
    })

    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls, 'a background top-up must be in flight').toBe(1)

    const BURST = POOL_TARGET + 14
    const pending = ensureMintedIdCapacity(BURST)
    // A LITERAL, not `MINT_JOIN_DEADLINE_MS + 10`. Deriving the clock from the
    // constant under test would make the test agree with any value (even a
    // 14 999 ms ceiling, which is no ceiling at all against a 15 s fetch).
    await vi.advanceTimersByTimeAsync(2_100)
    expect(
      calls,
      'past the join ceiling it must ask on its own, not return short in silence',
    ).toBeGreaterThan(1)

    // Let the joined request reach its own ceiling so nothing is left pinned.
    await vi.advanceTimersByTimeAsync(MINT_FETCH_TIMEOUT_MS)
    expect(await pending).toBeGreaterThanOrEqual(BURST)
  })

  it('is inert outside a session and asks for nothing', async () => {
    expect(await ensureMintedIdCapacity(50)).toBe(0)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})

/**
 * The evidence wake (`notifyMintedIdSupplyHostReachable`).
 *
 * `window 'online'` answers the wrong question: it fires when the BROWSER
 * regains a network, not when the SERVER comes back. "Server down, server
 * back, browser online throughout" produces no such event, so a failed mint
 * would stay asleep on its 5 s→300 s ladder long after it could be answered.
 *
 * The wake is guarded by `backoffTimer` rather than an edge on a connected
 * flag: with nothing waiting there is nothing to wake, so the function is safe
 * to call from a hot path with no caller-side state at all.
 */
describe('minted id supply — waking on evidence, and never faster than the ladder', () => {
  beforeEach(() => {
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    apiFetchMock.mockReset()
  })
  afterEach(() => {
    stopMintedIdSupply()
    vi.useRealTimers()
    __setWorkspaceKvBaseForTest(null)
  })

  it('wakes a mint the outage put to sleep, with no browser event at all', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(mintResponse(503))
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(1) // failed; the ladder is armed

    // The server is back. No timers are advanced: the whole point is that the
    // retry happens NOW, on evidence, rather than whenever the ladder comes
    // round — which for a client several rungs up is minutes away.
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))
    notifyMintedIdSupplyHostReachable()
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock, 'evidence must buy an immediate retry').toHaveBeenCalledTimes(2)
  })

  it('is INERT when nothing is waiting — that guard is what replaces the edge', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockImplementation(respondCanonical('default', 'v-main'))
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    const healthy = apiFetchMock.mock.calls.length
    expect(healthy).toBeGreaterThan(0)

    // A healthy supply has no armed backoff, so every one of these is a no-op.
    // Without this guard the function would need caller-side edge state.
    for (let i = 0; i < 30; i += 1) notifyMintedIdSupplyHostReachable()
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock.mock.calls.length).toBe(healthy)
  })

  it('CANNOT outpace the ladder, however often the evidence arrives', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(mintResponse(503))
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)

    // Five simulated minutes of evidence at 100 ms — 3 000 calls, which is the
    // shape of an inbound sync frame or a durable-ack round. Deleting the rate
    // limit turns this into ~3 000 mint requests against a server that is
    // refusing: the storm the backoff exists to prevent, arriving through the
    // wake instead of around it.
    for (let i = 0; i < 3_000; i += 1) {
      notifyMintedIdSupplyHostReachable()
      await vi.advanceTimersByTimeAsync(100)
    }
    const calls = apiFetchMock.mock.calls.length
    // The pure ladder over 300 s is 5+10+20+40+80+160 — six rungs. Evidence may
    // re-phase those, never add to them.
    expect(calls, 'evidence must not add requests, only re-phase them').toBeLessThanOrEqual(8)
    expect(calls, 'and it must not have silenced the ladder either').toBeGreaterThan(1)
  })

  it('does NOT reset the ladder — a wake takes a rung, it does not go back to the bottom', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(mintResponse(503))
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(1) // rung 1: the next wait is 5 s

    notifyMintedIdSupplyHostReachable()
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(2) // that failed too: next wait 10 s

    // If the wake reset `backoffMs` to 0 the next rung would be 5 s and this
    // would fire early. It must not.
    await vi.advanceTimersByTimeAsync(9_999)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not break the pure-reader rule: a 403 stays silent under any evidence', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(mintResponse(403, { error: 'forbidden' }))
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 20; i += 1) {
      notifyMintedIdSupplyHostReachable()
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(
      apiFetchMock,
      'a reader must still cost AT MOST one mint request per session',
    ).toHaveBeenCalledTimes(1)
  })

  it('a new session can be woken again after the previous one was stopped', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(mintResponse(503))
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    notifyMintedIdSupplyHostReachable()
    await vi.advanceTimersByTimeAsync(0)

    // Session state that survived a stop/start would make the new session's
    // first evidence look rate-limited by the OLD session's wake.
    stopMintedIdSupply()
    apiFetchMock.mockClear()
    startMintedIdSupply(REF)
    await vi.advanceTimersByTimeAsync(0)
    const afterBoot = apiFetchMock.mock.calls.length
    notifyMintedIdSupplyHostReachable()
    await vi.advanceTimersByTimeAsync(0)
    expect(apiFetchMock.mock.calls.length).toBe(afterBoot + 1)
  })

  it('is inert outside a session', async () => {
    notifyMintedIdSupplyHostReachable()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
