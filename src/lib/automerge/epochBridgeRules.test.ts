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

import * as A from '@automerge/automerge'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ANSWER_EXPIRED, ANSWER_REFUSED, createRepointProbeScheduler, EPOCH_LINK_GONE, epochPredecessorChain, EXPIRED_ANSWERS_MAX, holdsTargets,
  hopUnaccounted, isExpiredSession, isPermanentRefusal,
  lifecycleFlushPlan, nextEpochCapability, predecessorIdOf, REPOINT_PROBE_DELAYS_MS, repointAction, retryUntilAnswered,
  UNMINTED_RETRY_MAX_ATTEMPTS, walkEpochLineage, withLineageLinks,
} from './epochBridgeRules'

describe('holdsTargets', () => {
  const base = A.from<{ v: number }>({ v: 1 })
  const older = A.clone(base) // a copy that never received the change below
  const doc = A.change(A.clone(base), (d) => { d.v = 2 })
  const late = A.getHeads(doc)

  it('a projected document must hold every target head', () => {
    expect(holdsTargets(new Map([['d', () => doc]]), [{ documentId: 'd', heads: late }])).toBe(true)
    expect(holdsTargets(new Map([['d', () => older]]), [{ documentId: 'd', heads: late }])).toBe(false)
  })
  it('a projected document not loaded yet does not hold it', () => {
    expect(holdsTargets(new Map([['d', () => undefined]]), [{ documentId: 'd', heads: late }])).toBe(false)
  })
  it('a document the tab does not project is not its business', () => {
    expect(holdsTargets(new Map(), [{ documentId: 'other', heads: late }])).toBe(true)
  })
})

describe('repointAction', () => {
  it('back to the booted meta: cancel', () => {
    expect(repointAction({ bootedMetaUrl: 'automerge:a', rootMetaUrl: 'automerge:a', capability: true })).toBe('cancel')
    expect(repointAction({ bootedMetaUrl: 'automerge:a', rootMetaUrl: 'automerge:a', capability: false })).toBe('cancel')
  })
  it('elsewhere: a hop only on a workspace with epochs; not known yet, the capability is ASKED, never assumed', () => {
    expect(repointAction({ bootedMetaUrl: 'automerge:a', rootMetaUrl: 'automerge:b', capability: true })).toBe('start')
    expect(repointAction({ bootedMetaUrl: 'automerge:a', rootMetaUrl: 'automerge:b', capability: false })).toBe('probe')
  })
  it('nothing booted or no meta named: nothing', () => {
    expect(repointAction({ bootedMetaUrl: null, rootMetaUrl: 'automerge:b', capability: true })).toBe('none')
    expect(repointAction({ bootedMetaUrl: 'automerge:a', rootMetaUrl: undefined, capability: true })).toBe('none')
  })
})

describe('the epoch capability', () => {
  it('sticky: a later false never downgrades a true', () => {
    expect(nextEpochCapability(false, true)).toBe(true)
    expect(nextEpochCapability(true, false)).toBe(true)
    expect(nextEpochCapability(false, false)).toBe(false)
  })
})

describe('lifecycleFlushPlan', () => {
  it('a write the latch deferred is re-armed and flushed with the pause lifted', () => {
    expect(lifecycleFlushPlan({ pausedByHop: true, deferredByHop: true, pending: false }))
      .toEqual({ flush: true, liftPause: true, requestDeferred: true })
  })
  it('paused with a pending write: lifted around the flush, nothing re-armed', () => {
    expect(lifecycleFlushPlan({ pausedByHop: true, deferredByHop: false, pending: true }))
      .toEqual({ flush: true, liftPause: true, requestDeferred: false })
  })
  it('not paused: a plain flush; nothing pending: nothing', () => {
    expect(lifecycleFlushPlan({ pausedByHop: false, deferredByHop: false, pending: true }))
      .toEqual({ flush: true, liftPause: false, requestDeferred: false })
    expect(lifecycleFlushPlan({ pausedByHop: false, deferredByHop: false, pending: false }).flush).toBe(false)
  })
})

describe('epochPredecessorChain', () => {
  const meta = (pred: string | null) => (pred ? { modelEpoch: 2, epochPredecessorRef: new A.ImmutableString(pred) } : { modelEpoch: 1 })
  it('the predecessors, walked through the metas held, to the first unknown one', async () => {
    const held = new Map<string, unknown>([['automerge:m2', meta('automerge:m1')], ['automerge:m1', meta(null)]])
    const chain = await epochPredecessorChain(meta('automerge:m2'), async (url) => held.get(url))
    expect([...chain]).toEqual(['m2', 'm1'])
  })
  it('the first link needs no load (one roll, then a reload: the common case)', async () => {
    const chain = await epochPredecessorChain(meta('automerge:m2'), async () => undefined)
    expect([...chain]).toEqual(['m2'])
  })
  it('a meta of another lineage (no predecessor ref) names nothing — a repair or another version never resurrects a pointer', async () => {
    expect([...await epochPredecessorChain({ objectShardUrls: [] }, async () => undefined)]).toEqual([])
    expect([...await epochPredecessorChain(undefined, async () => undefined)]).toEqual([])
  })
  it('bounded, and a cycle stops it', async () => {
    const cyclic = new Map<string, unknown>([['automerge:a', meta('automerge:b')], ['automerge:b', meta('automerge:a')]])
    expect([...await epochPredecessorChain(meta('automerge:a'), async (u) => cyclic.get(u))]).toEqual(['a', 'b'])
    const long = async (url: string) => meta(`automerge:x${Number(url.slice('automerge:x'.length)) + 1}`)
    expect((await epochPredecessorChain(meta('automerge:x0'), long, 4)).size).toBe(4)
  })
  it('a plain string ref is read too', async () => {
    expect([...await epochPredecessorChain({ epochPredecessorRef: 'automerge:p' }, async () => undefined)]).toEqual(['p'])
  })
  it('a ref that is not an automerge URL names nothing', async () => {
    expect(predecessorIdOf({ epochPredecessorRef: 'p' })).toBeNull()
    expect(predecessorIdOf({ epochPredecessorRef: { val: 'https://x/p' } })).toBeNull()
    expect([...await epochPredecessorChain({ epochPredecessorRef: 'p' }, async () => ({ epochPredecessorRef: 'automerge:q' }))]).toEqual([])
  })
})

describe('the persisted epoch lineage', () => {
  const meta = (pred: string | null) => (pred ? { modelEpoch: 3, epochPredecessorRef: new A.ImmutableString(`automerge:${pred}`) } : { modelEpoch: 0 })
  it('TWO rolls the tab never saw, then a reload: E3 → E2 is in the meta, E2 → E1 is LOADED once and learned; E1 → E0 was persisted at the E1 boot', async () => {
    const load = vi.fn(async (url: string) => (url === 'automerge:e2' ? meta('e1') : undefined))
    const { chain, learned } = await walkEpochLineage({ current: meta('e2'), currentId: 'e3', lineage: { e1: 'e0', e0: '' }, load })
    expect([...chain]).toEqual(['e2', 'e1', 'e0'])
    expect(learned).toEqual([['e3', 'e2'], ['e2', 'e1']])
    expect(load).toHaveBeenCalledTimes(1)
    // Persisted, the next walk loads nothing.
    const lineage = withLineageLinks({ e1: 'e0', e0: '' }, learned)
    const again = vi.fn(async () => undefined)
    expect([...(await walkEpochLineage({ current: meta('e2'), currentId: 'e3', lineage, load: again })).chain]).toEqual(['e2', 'e1', 'e0'])
    expect(again).not.toHaveBeenCalled()
  })
  it('a meta with no predecessor ends the walk, recorded as ""', async () => {
    const { chain, learned } = await walkEpochLineage({ current: meta('e0'), currentId: 'e1', load: async () => meta(null) })
    expect([...chain]).toEqual(['e0'])
    expect(learned).toEqual([['e1', 'e0'], ['e0', '']])
  })
  it('a repoint to another lineage (no ref) accepts nothing, and its link says so', async () => {
    const { chain, learned } = await walkEpochLineage({ current: { objectShardUrls: [] }, currentId: 'r', lineage: { e1: 'e0' }, load: async () => undefined })
    expect([...chain]).toEqual([])
    expect(learned).toEqual([['r', '']])
  })
  it('withLineageLinks: malformed entries dropped, the newest kept last, bounded', () => {
    expect(withLineageLinks({ a: 'b', bad: 3, c: '' }, [])).toEqual({ a: 'b', c: '' })
    expect(withLineageLinks([1, 2], [['x', 'y']])).toEqual({ x: 'y' })
    const many = Array.from({ length: 70 }, (_, i) => [`m${i}`, `m${i - 1}`] as [string, string])
    const bounded = withLineageLinks({}, many, 64)
    expect(Object.keys(bounded)).toHaveLength(64)
    expect(bounded.m69).toBe('m68')
    expect(bounded.m0).toBeUndefined()
    expect(withLineageLinks({}, [['s', 's']])).toEqual({}) // a self-link is never kept
  })
})

describe('createRepointProbeScheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const ports = (wanted: { value: boolean }) => {
    const probes: number[] = []
    return {
      probes,
      ports: {
        wanted: () => wanted.value, probe: () => { probes.push(Date.now()) },
        setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
      },
    }
  }
  it('probes at 0, 2, 5, 15 and 65 s, then stops — and the same target never starts again', async () => {
    const wanted = { value: true }
    const { probes, ports: p } = ports(wanted)
    const s = createRepointProbeScheduler(p)
    const t0 = Date.now()
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(200_000)
    expect(probes.map((t) => t - t0)).toEqual([0, 2_000, 7_000, 22_000, 87_000])
    expect(REPOINT_PROBE_DELAYS_MS).toEqual([0, 2_000, 5_000, 15_000, 65_000])
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(200_000)
    expect(probes).toHaveLength(5)
    // A NEW target starts a fresh series at once.
    s.schedule('automerge:c')
    await vi.advanceTimersByTimeAsync(10)
    expect(probes).toHaveLength(6)
  })
  it('stops as soon as it is no longer wanted (the capability came)', async () => {
    const wanted = { value: true }
    const { probes, ports: p } = ports(wanted)
    const s = createRepointProbeScheduler(p)
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(10)
    wanted.value = false
    await vi.advanceTimersByTimeAsync(200_000)
    expect(probes).toHaveLength(1)
    expect(s.pending()).toBe(false)
  })
  it('stop() cancels the pending probe and resets the series', async () => {
    const { probes, ports: p } = ports({ value: true })
    const s = createRepointProbeScheduler(p)
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(10)
    s.stop()
    expect(s.pending()).toBe(false)
    await vi.advanceTimersByTimeAsync(200_000)
    expect(probes).toHaveLength(1)
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(10)
    expect(probes).toHaveLength(2) // from the first step again, at once
  })
  it('stop() forgets the target and the exhaustion — a restarted bridge probes the SAME target again', async () => {
    const { probes, ports: p } = ports({ value: true })
    const s = createRepointProbeScheduler(p)
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(200_000)
    expect(probes).toHaveLength(5) // exhausted
    s.stop()
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(10)
    expect(probes).toHaveLength(6)
  })
  it('a step that is no longer wanted resets the series — wanted again, the next probe is the FIRST step\'s (at once)', async () => {
    const wanted = { value: true }
    const { probes, ports: p } = ports(wanted)
    const s = createRepointProbeScheduler(p)
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(2_100) // probes at 0 and 2 s
    expect(probes).toHaveLength(2)
    wanted.value = false
    await vi.advanceTimersByTimeAsync(5_000) // the 5 s step finds it unwanted
    expect(s.pending()).toBe(false)
    wanted.value = true
    s.schedule('automerge:b')
    await vi.advanceTimersByTimeAsync(10)
    expect(probes).toHaveLength(3)
  })
})

describe('walkEpochLineage `complete`', () => {
  const meta = (pred: string | null) => (pred ? { epochPredecessorRef: `automerge:${pred}` } : {})
  it('true when the walk reached the chain\'s end, false when a link could not be loaded', async () => {
    const docs: Record<string, unknown> = { e1: meta('e0'), e0: meta(null) }
    const load = async (url: string) => docs[url.slice('automerge:'.length)]
    expect((await walkEpochLineage({ current: meta('e1'), currentId: 'e2', load })).complete).toBe(true)
    const missing = async (url: string) => (url === 'automerge:e0' ? undefined : docs[url.slice('automerge:'.length)])
    const cut = await walkEpochLineage({ current: meta('e1'), currentId: 'e2', load: missing })
    expect(cut.complete).toBe(false)
    expect([...cut.chain]).toEqual(['e1', 'e0'])
  })
  it('a link GONE for good (the server GC deleted the meta) DECIDES — the walk is complete, nothing learned for it', async () => {
    const gone = async (url: string) => (url === 'automerge:e0' ? EPOCH_LINK_GONE : meta('e0'))
    const walked = await walkEpochLineage({ current: meta('e1'), currentId: 'e2', load: gone })
    expect(walked.complete).toBe(true)
    expect([...walked.chain]).toEqual(['e1', 'e0'])
    expect(walked.learned).toEqual([['e2', 'e1'], ['e1', 'e0']])
  })
})

describe('retryUntilAnswered', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  function harness(answers: Array<string | null | typeof ANSWER_REFUSED | typeof ANSWER_EXPIRED>, alive = { value: true }) {
    const armed: number[] = []
    const asked: number[] = []
    const answered: string[] = []
    const start = Date.now()
    retryUntilAnswered<string>({
      ask: async () => { asked.push(Date.now() - start); return answers.length > 0 ? answers.shift()! : null },
      alive: () => alive.value,
      answered: (value) => { answered.push(value) },
      setTimer: (fn, ms) => { armed.push(ms); setTimeout(fn, ms) },
    })
    return { armed, asked, answered, alive }
  }
  it('asks at 2, 5, 15, 30 then every 60 s, and stops at the first answer', async () => {
    const h = harness([null, null, null, null, null, 'held'])
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 15_000 + 30_000 + 60_000 + 60_000)
    expect(h.armed).toEqual([2_000, 5_000, 15_000, 30_000, 60_000, 60_000])
    expect(h.asked).toEqual([2_000, 7_000, 22_000, 52_000, 112_000, 172_000])
    expect(h.answered).toEqual(['held'])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.asked).toHaveLength(6)
  })
  it('capped: a no-answer that never ends stops after the last attempt', async () => {
    const h = harness([])
    await vi.advanceTimersByTimeAsync(24 * 3_600_000)
    expect(h.asked).toHaveLength(UNMINTED_RETRY_MAX_ATTEMPTS)
    expect(h.answered).toEqual([])
  })
  it('a REFUSAL (4xx) is not asked again', async () => {
    const h = harness([ANSWER_REFUSED, 'held'])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.asked).toHaveLength(1)
    expect(h.answered).toEqual([])
  })
  it('an EXPIRED session (401) is asked again, but two in a row stop the series; one between answers does not', async () => {
    const stopped = harness([ANSWER_EXPIRED, ANSWER_EXPIRED, 'held'])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(stopped.asked).toHaveLength(EXPIRED_ANSWERS_MAX)
    expect(stopped.answered).toEqual([])
    const refreshed = harness([ANSWER_EXPIRED, null, ANSWER_EXPIRED, 'held'])
    await vi.advanceTimersByTimeAsync(600_000)
    expect(refreshed.answered).toEqual(['held'])
    expect(isExpiredSession(new Error('durable-heads API → HTTP 401'))).toBe(true)
    expect(isExpiredSession(new Error('durable-heads API → HTTP 403'))).toBe(false)
  })
  it('the caller\'s first ask already expired counts — the series stops at the next expired answer', async () => {
    const answered: string[] = []
    const asked: number[] = []
    const answers: Array<string | null | typeof ANSWER_EXPIRED> = [ANSWER_EXPIRED, 'held']
    retryUntilAnswered<string>({
      ask: async () => { asked.push(1); return answers.shift() ?? null },
      alive: () => true,
      answered: (value) => { answered.push(value) },
      setTimer: (fn, ms) => { setTimeout(fn, ms) },
    }, undefined, undefined, 1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(asked).toHaveLength(1)
    expect(answered).toEqual([])
  })
  it('a session that ended while a question was in flight arms nothing, and hears nothing', async () => {
    const alive = { value: true }
    let release: (v: string | null) => void = () => undefined
    const armed: number[] = []
    const answered: string[] = []
    retryUntilAnswered<string>({
      ask: () => new Promise((resolve) => { release = resolve }),
      alive: () => alive.value,
      answered: (v) => { answered.push(v) },
      setTimer: (fn, ms) => { armed.push(ms); setTimeout(fn, ms) },
    })
    await vi.advanceTimersByTimeAsync(2_000)
    alive.value = false
    release(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(armed).toEqual([2_000])
    release('held')
    await vi.advanceTimersByTimeAsync(0)
    expect(answered).toEqual([])
  })
  it('an answer after the session ended is not delivered', async () => {
    const alive = { value: true }
    let release: (v: string | null) => void = () => undefined
    const answered: string[] = []
    retryUntilAnswered<string>({
      ask: () => new Promise((resolve) => { release = resolve }),
      alive: () => alive.value,
      answered: (v) => { answered.push(v) },
      setTimer: (fn, ms) => { setTimeout(fn, ms) },
    })
    await vi.advanceTimersByTimeAsync(2_000)
    alive.value = false
    release('unknown')
    await vi.advanceTimersByTimeAsync(0)
    expect(answered).toEqual([])
  })
  it('an ask that FAILS after the session ended arms nothing (no orphan timer)', async () => {
    const alive = { value: true }
    let fail: (error: Error) => void = () => undefined
    const armed: number[] = []
    retryUntilAnswered<string>({
      ask: () => new Promise((_, reject) => { fail = reject }),
      alive: () => alive.value,
      answered: () => undefined,
      setTimer: (fn, ms) => { armed.push(ms); setTimeout(fn, ms) },
    })
    await vi.advanceTimersByTimeAsync(2_000)
    alive.value = false
    fail(new Error('the route threw'))
    await vi.advanceTimersByTimeAsync(0)
    expect(armed).toEqual([2_000])
  })
  it('a timer that fires after the session ended asks nothing', async () => {
    const h = harness([null])
    h.alive.value = false
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.asked).toEqual([])
  })
})

describe('isPermanentRefusal', () => {
  it('a 4xx refuses for good, but a timeout (408) or a rate limit (429) may pass later; a 5xx or the network may too', () => {
    expect(isPermanentRefusal(new Error('durable-heads API → HTTP 403'))).toBe(true)
    expect(isPermanentRefusal(new Error('durable-heads API → HTTP 404'))).toBe(true)
    expect(isPermanentRefusal(new Error('durable-heads API → HTTP 408'))).toBe(false)
    expect(isPermanentRefusal(new Error('durable-heads API → HTTP 429'))).toBe(false)
    // An expired session is refreshed in the
    // same session — asked again, not given up for the session.
    expect(isPermanentRefusal(new Error('durable-heads API → HTTP 401'))).toBe(false)
    expect(isPermanentRefusal(new Error('durable-heads API → HTTP 503'))).toBe(false)
    expect(isPermanentRefusal(new TypeError('Failed to fetch'))).toBe(false)
  })
})

describe('hopUnaccounted', () => {
  const set = (...ids: string[]) => new Set(ids)
  const base = { before: set('lost', 'exported', 'paulDeleted', 'herDelete', 'kept'), now: set('kept'), exported: set('exported'),
    afterSwap: set('kept', 'paulDeleted'), tombstones: set('herDelete'), bootFromServer: false }

  it('a loss is reported; an export line, a delete in the new epoch (projected by the swap, gone since) and an explicit delete of hers are not', () => {
    expect(hopUnaccounted(base)).toEqual(['lost'])
    expect(hopUnaccounted({ ...base, afterSwap: set('kept') })).toEqual(['lost', 'paulDeleted'])
    expect(hopUnaccounted({ ...base, tombstones: set() })).toEqual(['lost', 'herDelete'])
  })

  it('boot-from-server is never accounted (its store is the server render of a window)', () => {
    expect(hopUnaccounted({ ...base, bootFromServer: true })).toEqual([])
  })
})
