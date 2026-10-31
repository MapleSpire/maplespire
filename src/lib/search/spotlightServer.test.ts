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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_REF, setActiveWorkspaceRef } from '../automerge/workspace'
import {
  __resetResolvedWorkspacesForTest, adoptBindingAsBasis, holdWorkspaceOn, rememberResolvedWorkspace,
} from '../automerge/workspaceBinding'
import {
  SpotlightServerSearch, __setSpotlightFetchForTest, fetchSpotlightAnswer, parseSpotlightAnswer, spotlightWorkspace,
} from './spotlightServer'
import type { SpotlightServerOutcome } from './spotlightServer'
import type { SpotlightWireRequest } from './spotlight/wire'

// The root this session holds, as the bridge reports it (`sessionRootUrl`).
// The trust rule itself (`documentsWorkspaceFor`) is the real one.
const session = vi.hoisted(() => ({ rootUrl: null as string | null }))
vi.mock('../automerge/bridge', () => ({ sessionRootUrl: () => session.rootUrl }))

const WS = { landscapeId: 'L1', versionId: 'V1' }
const ALIAS = { landscapeId: 'L1', versionId: 'current' }
const BOOTED_ROOT = 'automerge:booted-root'
const REQUEST: SpotlightWireRequest = { q: 'pay', perKind: 5, vocab: { domains: [['d1', 'Finance']], tags: [] } }

function body(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    topHit: { kind: 'system', id: 's1' },
    sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: 16, doc: { kind: 'system', id: 's1', name: 'Pay', extra: { parentName: null } } }] }],
    coverage: { unavailableKinds: ['adr'], fieldGaps: { diagram: ['desc', 'domain'] } },
    landscapeId: WS.landscapeId,
    versionId: WS.versionId,
    projectionGeneration: 7,
    status: 'healthy',
    caughtUp: true,
    absenceProvable: true,
    ...over,
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

let calls: Array<{ url: string; init?: RequestInit }> = []
function answerWith(make: (init?: RequestInit) => Promise<Response> | Response) {
  calls = []
  __setSpotlightFetchForTest(async (url, init) => {
    calls.push({ url, init })
    return make(init)
  })
}

/** A fetch that only ends when its signal aborts, like a real hung request. */
const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
})

beforeEach(() => {
  setActiveWorkspaceRef(WS)
  __resetResolvedWorkspacesForTest()
  holdWorkspaceOn(null)
  session.rootUrl = BOOTED_ROOT
})
afterEach(() => {
  __setSpotlightFetchForTest(null)
  setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
  __resetResolvedWorkspacesForTest()
  holdWorkspaceOn(null)
  session.rootUrl = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('fetchSpotlightAnswer', () => {
  it('POSTs the request for the active workspace and returns the validated answer', async () => {
    answerWith(() => json(body()))
    const outcome = await fetchSpotlightAnswer(REQUEST)
    expect(outcome.kind).toBe('answer')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toMatch(/\/api\/model\/spotlight\?landscapeId=L1&versionId=V1$/)
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(REQUEST)
    if (outcome.kind === 'answer') {
      expect(outcome.answer.sections[0].hits[0].doc).toMatchObject({ id: 's1', extra: { parentName: null } })
      expect(outcome.answer.coverage.unavailableKinds).toEqual(['adr'])
      expect(outcome.answer.projectionGeneration).toBe(7)
    }
  })

  it('under a hold, asks about the version the documents belong to, which the hold also names', async () => {
    setActiveWorkspaceRef(ALIAS)
    rememberResolvedWorkspace(ALIAS, WS, { from: 'root-fetch', rootUrl: BOOTED_ROOT })
    holdWorkspaceOn(WS)
    answerWith(() => json(body()))
    expect((await fetchSpotlightAnswer(REQUEST)).kind).toBe('answer')
    expect(calls[0].url).toMatch(/landscapeId=L1&versionId=V1$/)
  })

  it('does not ask on a hold alone: a hold does not name the documents\' workspace', async () => {
    setActiveWorkspaceRef(ALIAS)
    holdWorkspaceOn(WS)
    answerWith(() => json(body()))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-unknown' })
    expect(calls).toHaveLength(0)
  })

  it('reads 401 and 403 as a refusal, not an outage', async () => {
    for (const status of [401, 403]) {
      answerWith(() => json({ error: 'forbidden' }, status))
      expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'refused', status })
    }
  })

  it('reads every other failure as "unavailable": older server, not ready, server error, bad request', async () => {
    for (const status of [400, 404, 500, 502, 503]) {
      answerWith(() => json({ error: 'x', retryable: true }, status))
      expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: `http-${status}` })
    }
    answerWith(() => { throw new TypeError('Failed to fetch') })
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'network' })
    answerWith(() => new Response('<html>', { status: 200 }))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'malformed' })
  })

  it('does not ask at all when the browser is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    answerWith(() => json(body()))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'offline' })
    expect(calls).toHaveLength(0)
  })

  it('gives up after the timeout, and also when a transport answers past it', async () => {
    vi.useFakeTimers()
    answerWith(hang)
    const hung = fetchSpotlightAnswer(REQUEST, { timeoutMs: 1500 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(await hung).toEqual({ kind: 'unavailable', reason: 'timeout' })

    // A fetch that ignores the abort and resolves late is still a timeout.
    answerWith(() => new Promise<Response>((resolve) => setTimeout(() => resolve(json(body())), 2000)))
    const late = fetchSpotlightAnswer(REQUEST, { timeoutMs: 1500 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await late).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('times out after 1.5 s by default (a literal, not the constant under test)', async () => {
    vi.useFakeTimers()
    answerWith(hang)
    let settled = false
    const pending = fetchSpotlightAnswer(REQUEST).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1499)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('rejects with an AbortError only when the caller aborts', async () => {
    answerWith(hang)
    const controller = new AbortController()
    const pending = fetchSpotlightAnswer(REQUEST, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('drops an answer the server gave for another workspace (a draft served from its base)', async () => {
    answerWith(() => json(body({ versionId: 'BASE' })))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'other-workspace' })
    answerWith(() => json(body({ landscapeId: 'L2' })))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'other-workspace' })
  })

  it('asks a `current` tab about the concrete version its root fetch returned, never the alias', async () => {
    setActiveWorkspaceRef(ALIAS)
    rememberResolvedWorkspace(ALIAS, WS, { from: 'root-fetch', rootUrl: BOOTED_ROOT })
    answerWith(() => json(body()))
    expect((await fetchSpotlightAnswer(REQUEST)).kind).toBe('answer')
    expect(calls[0].url).toMatch(/landscapeId=L1&versionId=V1$/)
    expect(calls[0].url).not.toMatch(/current/)
    // The exact echo only: an answer about another version is dropped.
    answerWith(() => json(body({ versionId: 'V2' })))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'other-workspace' })
  })

  it('does not ask a `current` tab that never learned what its documents are (an offline boot)', async () => {
    setActiveWorkspaceRef(ALIAS)
    answerWith(() => json(body()))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-unknown' })
    expect(calls).toHaveLength(0)
  })

  // The case `documentsWorkspaceFor` exists for. The tab booted from the CACHED
  // root (V1's documents) while an admin repointed the default to V2; the first
  // socket binds to V2 and the bridge self-arms that as its basis. The server
  // answers `current` with V2. The rule this module used to keep for itself
  // accepted an echo equal to that basis, so V2's entities were shown in a V1
  // tab.
  it('does not trust a basis self-armed from a socket bound to the repointed version', async () => {
    setActiveWorkspaceRef(ALIAS)
    session.rootUrl = 'automerge:cached-v1-root'
    adoptBindingAsBasis(ALIAS, { landscapeId: 'L1', versionId: 'V2' })
    answerWith(() => json(body({ versionId: 'V2' })))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-unknown' })
    expect(calls).toHaveLength(0)
    expect(spotlightWorkspace()).toBeNull()
  })

  it('does not trust a root-fetched basis recorded beside another root than the one this session holds', async () => {
    setActiveWorkspaceRef(ALIAS)
    rememberResolvedWorkspace(ALIAS, { landscapeId: 'L1', versionId: 'V2' }, { from: 'root-fetch', rootUrl: 'automerge:v2-root' })
    session.rootUrl = 'automerge:cached-v1-root'
    answerWith(() => json(body({ versionId: 'V2' })))
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-unknown' })
    expect(calls).toHaveLength(0)
    session.rootUrl = null // no session at all
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-unknown' })
    expect(calls).toHaveLength(0)
  })

  it('asks a concrete tab about its own version, whatever a basis or a hold says', async () => {
    rememberResolvedWorkspace(ALIAS, { landscapeId: 'L1', versionId: 'V2' }, { from: 'root-fetch', rootUrl: BOOTED_ROOT })
    holdWorkspaceOn({ landscapeId: 'L1', versionId: 'V4' })
    session.rootUrl = null
    answerWith(() => json(body()))
    expect((await fetchSpotlightAnswer(REQUEST)).kind).toBe('answer')
    expect(calls[0].url).toMatch(/landscapeId=L1&versionId=V1$/)
  })

  it('drops an answer that arrives after the tab switched workspace', async () => {
    answerWith(async () => {
      setActiveWorkspaceRef({ landscapeId: 'L9', versionId: 'V9' })
      return json(body())
    })
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-changed' })
  })

  it('drops an answer that arrives after the session booted another root', async () => {
    setActiveWorkspaceRef(ALIAS)
    rememberResolvedWorkspace(ALIAS, WS, { from: 'root-fetch', rootUrl: BOOTED_ROOT })
    answerWith(async () => {
      // A reload followed the repoint: a new root, a new basis beside it.
      rememberResolvedWorkspace(ALIAS, { landscapeId: 'L1', versionId: 'V2' }, { from: 'root-fetch', rootUrl: 'automerge:v2-root' })
      session.rootUrl = 'automerge:v2-root'
      return json(body())
    })
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-changed' })
    // ...and while the new root is being fetched, the basis is gone: still dropped.
    rememberResolvedWorkspace(ALIAS, WS, { from: 'root-fetch', rootUrl: BOOTED_ROOT })
    session.rootUrl = BOOTED_ROOT
    answerWith(async () => {
      __resetResolvedWorkspacesForTest()
      return json(body())
    })
    expect(await fetchSpotlightAnswer(REQUEST)).toEqual({ kind: 'unavailable', reason: 'workspace-changed' })
  })
})

describe('parseSpotlightAnswer', () => {
  it('uses an answer whole or not at all', () => {
    expect(parseSpotlightAnswer(body())).not.toBeNull()
    const bad: Array<Record<string, unknown>> = [
      { v: 2 },
      { coverage: undefined },
      { coverage: { unavailableKinds: 'adr', fieldGaps: {} } },
      { coverage: { unavailableKinds: [], fieldGaps: { diagram: 'desc' } } },
      { sections: {} },
      { landscapeId: 3 },
      { sections: [{ kind: 'page', total: 1, totalCapped: false, hits: [] }] },
      { sections: [{ kind: 'system', total: -1, totalCapped: false, hits: [] }] },
      { sections: [{ kind: 'system', total: 1, hits: [] }] },
      { sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: Number.NaN, doc: { kind: 'system', id: 'a', name: 'A' } }] }] },
      // A hit filed under another kind's section.
      { sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: 1, doc: { kind: 'app', id: 'a', name: 'A' } }] }] },
      { sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: 1, doc: { kind: 'system', id: 'a', name: 'A', tech: 'pg' } }] }] },
      { sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: 1, doc: { kind: 'system', id: 'a', name: 'A', scope: 'galaxy' } }] }] },
    ]
    for (const over of bad) expect(parseSpotlightAnswer(body(over)), JSON.stringify(over)).toBeNull()
    expect(parseSpotlightAnswer(null)).toBeNull()
    expect(parseSpotlightAnswer([])).toBeNull()
  })

  it('keeps only plain values in a document extra', () => {
    const parsed = parseSpotlightAnswer(body({
      sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: 1, doc: { kind: 'system', id: 'a', name: 'A', extra: { ok: 'x', n: 2, none: null, obj: {}, inf: Infinity } } }] }],
    }))
    expect(parsed?.sections[0].hits[0].doc.extra).toEqual({ ok: 'x', n: 2, none: null })
  })
})

describe('SpotlightServerSearch', () => {
  /** An answer told apart by a marker (carried in versionId: the controller does
   *  not check workspaces, `fetchSpotlightAnswer` does). */
  const answer = (marker: string): SpotlightServerOutcome => {
    const parsed = parseSpotlightAnswer(body({ versionId: marker }))!
    return { kind: 'answer', answer: parsed }
  }

  it('waits for the debounce, then asks once for the last of several quick keystrokes', async () => {
    vi.useFakeTimers()
    const fetchAnswer = vi.fn(async (r: SpotlightWireRequest) => answer(r.q))
    const search = new SpotlightServerSearch({ debounceMs: 120, fetchAnswer })
    search.update('p', { ...REQUEST, q: 'p' })
    await vi.advanceTimersByTimeAsync(60)
    search.update('pa', { ...REQUEST, q: 'pa' })
    await vi.advanceTimersByTimeAsync(60)
    search.update('pay', { ...REQUEST, q: 'pay' })
    expect(search.getState()).toMatchObject({ key: 'pay', phase: 'pending' })
    await vi.advanceTimersByTimeAsync(119)
    expect(fetchAnswer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchAnswer).toHaveBeenCalledTimes(1)
    expect(fetchAnswer.mock.calls[0][0].q).toBe('pay')
    expect(search.getState()).toMatchObject({ key: 'pay', phase: 'done', outcome: { kind: 'answer' } })
  })

  it('debounces 120 ms and times requests out at 1.5 s by default', async () => {
    vi.useFakeTimers()
    const fetchAnswer = vi.fn(async (_r: SpotlightWireRequest, _o?: { timeoutMs?: number }) => answer('x'))
    const search = new SpotlightServerSearch({ fetchAnswer })
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(119)
    expect(fetchAnswer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchAnswer).toHaveBeenCalledTimes(1)
    expect(fetchAnswer.mock.calls[0][1]?.timeoutMs).toBe(1500)
  })

  it('aborts the request in flight when the query changes', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetchAnswer = vi.fn((_r: SpotlightWireRequest, o?: { signal?: AbortSignal }) => {
      signals.push(o!.signal!)
      return new Promise<SpotlightServerOutcome>(() => {})
    })
    const search = new SpotlightServerSearch({ debounceMs: 10, fetchAnswer })
    search.update('a', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    search.update('b', REQUEST)
    expect(signals[0].aborted).toBe(true)
  })

  it('never lets a late answer overwrite a newer one, even when its fetch ignored the abort', async () => {
    vi.useFakeTimers()
    const resolvers: Array<(o: SpotlightServerOutcome) => void> = []
    const fetchAnswer = vi.fn(() => new Promise<SpotlightServerOutcome>((resolve) => { resolvers.push(resolve) }))
    const search = new SpotlightServerSearch({ debounceMs: 10, fetchAnswer })
    search.update('old', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    search.update('new', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    resolvers[1](answer('new'))
    await vi.advanceTimersByTimeAsync(0)
    resolvers[0](answer('old'))
    await vi.advanceTimersByTimeAsync(0)
    const state = search.getState()
    expect(state.key).toBe('new')
    expect(state.outcome?.kind === 'answer' && state.outcome.answer.versionId).toBe('new')
  })

  it('does not ask again for the same key, goes idle on null, and asks again after cancel', async () => {
    vi.useFakeTimers()
    const fetchAnswer = vi.fn(async () => answer('x'))
    const search = new SpotlightServerSearch({ debounceMs: 10, fetchAnswer })
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchAnswer).toHaveBeenCalledTimes(1)
    search.update(null, null)
    expect(search.getState()).toEqual({ key: null, phase: 'idle', outcome: null })
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchAnswer).toHaveBeenCalledTimes(2)
    search.cancel()
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchAnswer).toHaveBeenCalledTimes(3)
  })

  it('turns an unexpected throw into "unavailable", and notifies subscribers', async () => {
    vi.useFakeTimers()
    const search = new SpotlightServerSearch({ debounceMs: 10, fetchAnswer: async () => { throw new Error('boom') } })
    const seen: string[] = []
    search.subscribe(() => seen.push(search.getState().phase))
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    expect(search.getState().outcome).toEqual({ kind: 'unavailable', reason: 'error' })
    expect(seen).toEqual(['pending', 'done'])
  })
})

// ── QA lens, round 2 (2026-10-25): survivors of an independent battery ─────────

describe('fetchSpotlightAnswer and a caller abort', () => {
  /** A hung transport that also refuses an already-aborted signal at once. */
  const hangAbortable = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    if (init?.signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })

  it('rejects with an AbortError when the caller aborts while a transport that ignores the abort answers', async () => {
    const controller = new AbortController()
    answerWith(() => { controller.abort(); return json(body()) })
    await expect(fetchSpotlightAnswer(REQUEST, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('hands an already-aborted caller signal to the transport already aborted', async () => {
    let abortedAtCall: boolean | null = null
    __setSpotlightFetchForTest(async (_url, init) => {
      abortedAtCall = init?.signal?.aborted === true
      return hangAbortable(init)
    })
    const controller = new AbortController()
    controller.abort()
    await expect(fetchSpotlightAnswer(REQUEST, { signal: controller.signal, timeoutMs: 50 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(abortedAtCall ?? true).toBe(true)
  })

  it('forwards a caller abort to the transport at once, not at the deadline', async () => {
    answerWith(hangAbortable)
    const controller = new AbortController()
    const pending = fetchSpotlightAnswer(REQUEST, { signal: controller.signal })
    controller.abort()
    expect(calls[0].init?.signal?.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('parseSpotlightAnswer: display fields', () => {
  it('refuses a document whose display fields are not strings', () => {
    const doc = (more: Record<string, unknown>) => ({ sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: 1, doc: { kind: 'system', id: 'a', name: 'A', ...more } }] }] })
    for (const more of [{ name: 3 }, { from: 3 }, { to: {} }, { diagrams: 'Checkout' }, { diagrams: [1] }, { description: {} }]) {
      expect(parseSpotlightAnswer(body(doc(more))), JSON.stringify(more)).toBeNull()
    }
  })
})

describe('SpotlightServerSearch.retry', () => {
  const answered = (): SpotlightServerOutcome => ({ kind: 'answer', answer: parseSpotlightAnswer(body())! })

  it('does not ask again after an answer, or after a refusal', async () => {
    vi.useFakeTimers()
    for (const outcome of [answered(), { kind: 'refused', status: 403 } as SpotlightServerOutcome]) {
      const fetchAnswer = vi.fn(async () => outcome)
      const search = new SpotlightServerSearch({ debounceMs: 10, fetchAnswer })
      search.update('k', REQUEST)
      await vi.advanceTimersByTimeAsync(10)
      search.retry()
      await vi.advanceTimersByTimeAsync(10)
      expect(fetchAnswer, outcome.kind).toHaveBeenCalledTimes(1)
    }
  })

  it('does not restart a request still waiting for its debounce', async () => {
    vi.useFakeTimers()
    const fetchAnswer = vi.fn(async (): Promise<SpotlightServerOutcome> => ({ kind: 'unavailable', reason: 'x' }))
    const search = new SpotlightServerSearch({ debounceMs: 100, fetchAnswer })
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(60)
    search.retry()
    await vi.advanceTimersByTimeAsync(40)
    expect(fetchAnswer).toHaveBeenCalledTimes(1)
  })

  it('asks again after "unavailable"', async () => {
    vi.useFakeTimers()
    const fetchAnswer = vi.fn(async (): Promise<SpotlightServerOutcome> => ({ kind: 'unavailable', reason: 'offline' }))
    const search = new SpotlightServerSearch({ debounceMs: 10, fetchAnswer })
    search.update('k', REQUEST)
    await vi.advanceTimersByTimeAsync(10)
    search.retry()
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchAnswer).toHaveBeenCalledTimes(2)
  })
})
