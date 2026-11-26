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
import { createEpochHop, EPOCH_HOP_QUIET_MAX_WAIT_MS, EPOCH_HOP_QUIET_MS, EPOCH_HOP_SLOW_ASK_MS, EPOCH_HOP_S7_PROOF_MAX_ATTEMPTS, EPOCH_HOP_STARVED_AFTER, EPOCH_HOP_STARVED_BACKOFF_MS, verdictOf, type EpochHopPorts, type HopAcknowledgement, type HopDocumentHeads } from './epochHop'

/**
 * G4-16f — the live epoch hop's STATE MACHINE, with
 * every effect a recorded port and the clock faked: the order of effects,
 * the 2 s latch bound (the flush included), no release-and-loop, the
 * backoff, the cancel on a second repoint, the retained old sets (which
 * outlive a cancel), the retired epoch (per document), a failed hop retried,
 * a failed acknowledgement treated as pending.
 */
type World = {
  log: string[]
  heads: { meta: string; base: string }
  /** token → the set's current heads (a bypassing writer may move them). */
  sets: Map<number, HopDocumentHeads[]>
  /** The server: which heads it has forwarded, and which documents it retired. */
  forwarded: Set<string>
  retiredDocs: Set<string>
  blockedAt: number | null
  blockedFor: number[]
  ports: EpochHopPorts<{ url: string }>
}

function world(): World {
  let next = 0
  const w = {
    log: [] as string[], heads: { meta: 'm1', base: 'b1' }, sets: new Map(),
    forwarded: new Set<string>(), retiredDocs: new Set<string>(), blockedAt: null as number | null, blockedFor: [] as number[],
  } as World
  const docs = (): HopDocumentHeads[] => [{ documentId: 'meta', heads: [w.heads.meta] }, { documentId: 'base', heads: [w.heads.base] }]
  w.ports = {
    load: async (url) => { w.log.push(`load ${url}`); await Promise.resolve(); return { url } },
    drop: (h) => { w.log.push(`drop ${h.url}`) },
    oldHeads: docs,
    acknowledge: async (documents) => {
      await Promise.resolve()
      return documents.map((d): HopAcknowledgement => (w.retiredDocs.has(d.documentId)
        ? { documentId: d.documentId, durable: false, forwarded: false, epochRetired: true }
        : { documentId: d.documentId, durable: true, forwarded: d.heads.every((h) => w.forwarded.has(h)) }))
    },
    blockInput: () => { w.log.push('block'); w.blockedAt = Date.now() },
    unblockInput: () => { w.log.push('unblock'); w.blockedFor.push(Date.now() - w.blockedAt!); w.blockedAt = null },
    flushAndPauseWrites: async () => { w.log.push('flush+pause') },
    resumeWrites: () => { w.log.push('resume') },
    swap: async (h) => { w.log.push(`swap ${h.url}`) },
    retainOld: (d) => {
      next += 1
      w.log.push(`retain#${next} ${d.map((x) => x.heads[0]).join(',')}`)
      w.sets.set(next, d)
      return next
    },
    retainedHeads: (token) => w.sets.get(token) ?? [],
    releaseOld: (token) => { w.log.push(`release#${token}`); w.sets.delete(token) },
    collectRetiredDiff: (retired) => { w.log.push(`collect-diff ${retired.join(',')}`); return { objects: ['o1'] } },
    showRetired: (diff) => { w.log.push(`banner ${JSON.stringify(diff)}`) },
  }
  return w
}

describe('the live epoch hop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('acknowledged: load, block, flush and pause, swap, retain the old documents, lift — then release them once forwarded', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'swap automerge:new', 'retain#1 m1,b1', 'unblock', 'resume', 'release#1'])
    expect(hop.state()).toEqual({ phase: 'idle' })
    expect(hop.retained()).toBe(0)
  })

  it('the latch is BOUNDED (2 s) and never loops: not acknowledged → lift, stay on the old epoch, back off 10 s, retry', async () => {
    const w = world()
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'unblock', 'resume'])
    expect(w.blockedFor[0]).toBeLessThanOrEqual(2_000)
    expect(hop.state()).toMatchObject({ phase: 'backoff', attempt: 0 })
    // Meanwhile the user keeps typing on the OLD epoch; the server forwards.
    w.heads = { meta: 'm2', base: 'b2' }
    w.forwarded.add('m2').add('b2')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1) // still backing off
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log.slice(5)).toEqual(['block', 'flush+pause', 'swap automerge:new', 'retain#1 m2,b2', 'unblock', 'resume', 'release#1'])
    expect(w.blockedFor.every((ms) => ms <= 2_000)).toBe(true)
  })

  it('in the S6b→S7 window (no epoch row yet: no `forwarded` on the old meta) a carried shard not durable does not swap; it does once S7 is passed', async () => {
    const w = world()
    let s7 = false
    w.ports.oldMetaDocumentId = () => 'meta'
    w.ports.carried = () => new Set(['base'])
    w.ports.acknowledge = async (documents) => {
      await Promise.resolve()
      return documents.map((d): HopAcknowledgement => (d.documentId === 'meta'
        ? (s7 ? { documentId: 'meta', durable: true, forwarded: true } : { documentId: 'meta', durable: true })
        : { documentId: d.documentId, durable: false }))
    }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(w.log.some((l) => l.startsWith('swap'))).toBe(false)
    expect(hop.state()).toMatchObject({ phase: 'backoff' })
    s7 = true
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log.filter((l) => l.startsWith('swap'))).toEqual(['swap automerge:new'])
  })

  it('latches that keep EXPIRING starve the hop — logged once, then at most one latch in 10 min, after a quiet moment', async () => {
    expect(EPOCH_HOP_STARVED_AFTER).toBe(3)
    expect([...EPOCH_HOP_STARVED_BACKOFF_MS]).toEqual([10 * 60_000, 20 * 60_000, 30 * 60_000])
    expect(EPOCH_HOP_QUIET_MS).toBe(3_000)
    expect(EPOCH_HOP_QUIET_MAX_WAIT_MS).toBe(5 * 60_000)
    const w = world()
    const events: Array<Record<string, unknown>> = []
    w.ports.log = (e) => { events.push(e) }
    // Never forwarded: every latch expires (not on the S7 proof), its asks
    // answered 600 ms after they were sent — this tab's own slowness.
    const ack = w.ports.acknowledge
    w.ports.acknowledge = async (documents, signal, options) => {
      if (options?.latch) await new Promise((resolve) => setTimeout(resolve, 600))
      return ack(documents, signal, options)
    }
    const latchedAt: number[] = []
    const block = w.ports.blockInput
    w.ports.blockInput = () => { latchedAt.push(Date.now()); block() }
    // Busy (a colleague's change every few hundred ms) until minute 30.
    const start = Date.now()
    w.ports.quietForMs = () => (Date.now() - start < 30 * 60_000 ? 100 : 60_000)
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // Ten minutes: the three latches of the ordinary backoff, no fourth.
    expect(latchedAt).toHaveLength(3)
    expect(events.filter((e) => e.event === 'epoch_hop.latch_starved')).toHaveLength(1)
    // The fourth comes after 10 min of backoff and the quiet wait's 5 min
    // ceiling (still busy): never sooner.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(latchedAt).toHaveLength(4)
    const third = latchedAt[2]! - start
    expect(latchedAt[3]! - start).toBeGreaterThanOrEqual(third + 2_000 + 10 * 60_000 + 5 * 60_000)
    expect(events.find((e) => e.event === 'epoch_hop.quiet_wait')).toMatchObject({ quiet: false })
    // Then 20 min of backoff; quiet by then (minute 30): latched at once after it.
    await vi.advanceTimersByTimeAsync(25 * 60_000)
    expect(latchedAt).toHaveLength(5)
    expect(latchedAt[4]! - latchedAt[3]!).toBeGreaterThanOrEqual(2_000 + 20 * 60_000)
    expect(latchedAt[4]! - latchedAt[3]!).toBeLessThan(2_000 + 20 * 60_000 + 1_000)
    expect(events.filter((e) => e.event === 'epoch_hop.latch_starved')).toHaveLength(1)
    expect(w.log.some((l) => l.startsWith('swap'))).toBe(false)
    hop.stop()
  })

  it('latches that expire while the SERVER is still forwarding (asks answered fast) do not starve the hop — the ordinary backoff goes on', async () => {
    expect(EPOCH_HOP_SLOW_ASK_MS).toBe(500)
    const w = world()
    const events: string[] = []
    w.ports.log = (e) => { events.push(String(e.event)) }
    const latchedAt: number[] = []
    const block = w.ports.blockInput
    w.ports.blockInput = () => { latchedAt.push(Date.now()); block() }
    w.ports.quietForMs = () => 60_000
    // Every ask answered at once, never forwarded (a large backlog on its way).
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(events).not.toContain('epoch_hop.latch_starved')
    // 0, 12, 44 s, then every 62 s: about ten in ten minutes.
    expect(latchedAt.length).toBeGreaterThanOrEqual(9)
    hop.stop()
  })

  it('the S7 proof is BOUNDED — latches in a row that end on it alone give up (logged, idle, nothing swapped), and the same url can be started again; another pending answer resets the count', async () => {
    const w = world()
    const events: string[] = []
    w.ports.log = (e) => { events.push(String(e.event)) }
    w.ports.oldMetaDocumentId = () => 'meta'
    let proofAt = Infinity
    let latches = 0
    w.ports.blockInput = () => { latches += 1 }
    w.ports.acknowledge = async (documents) => {
      await Promise.resolve()
      return documents.map((d): HopAcknowledgement => (d.documentId === 'meta'
        // Latch 2: S7 proven but the meta's forward still to come (another
        // reason to wait): the count restarts.
        ? (latches >= proofAt ? { documentId: 'meta', durable: true, forwarded: true }
          : latches === 2 ? { documentId: 'meta', durable: true, forwarded: false } : { documentId: 'meta', durable: true })
        : { documentId: d.documentId, durable: true }))
    }
    const hop = createEpochHop(w.ports, { backoffMs: [100], s7ProofMaxAttempts: 3 })
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(30_000)
    // Latch 1 unproven, 2 another reason (resets), 3–5 unproven: given up after 5.
    expect(events.filter((e) => e === 'epoch_hop.s7_unproven')).toHaveLength(1)
    expect(latches).toBe(5)
    expect(hop.state()).toEqual({ phase: 'idle' })
    expect(w.log.some((l) => l.startsWith('swap'))).toBe(false)
    proofAt = 0
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log.filter((l) => l.startsWith('swap'))).toEqual(['swap automerge:new'])
  })

  it('with no option, the S7 bound is TEN latches in a row', async () => {
    expect(EPOCH_HOP_S7_PROOF_MAX_ATTEMPTS).toBe(10)
    const w = world()
    const events: string[] = []
    w.ports.log = (e) => { events.push(String(e.event)) }
    w.ports.oldMetaDocumentId = () => 'meta'
    let latches = 0
    w.ports.blockInput = () => { latches += 1 }
    w.ports.acknowledge = async (documents) => {
      await Promise.resolve()
      return documents.map((d): HopAcknowledgement => (d.documentId === 'meta'
        ? { documentId: 'meta', durable: true } : { documentId: d.documentId, durable: true }))
    }
    const hop = createEpochHop(w.ports, { backoffMs: [100] })
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events.filter((e) => e === 'epoch_hop.s7_unproven')).toHaveLength(1)
    expect(latches).toBe(10)
  })

  it('a RETAINED set, asked after its swap, is not held to the proof — the port then names the NEW meta, which the set does not hold', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    let swapped = false
    w.ports.oldMetaDocumentId = () => (swapped ? 'new-meta' : 'meta')
    const swap = w.ports.swap
    w.ports.swap = async (h) => { await swap(h); swapped = true }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toContain('release#1')
    expect(hop.retained()).toBe(0)
  })

  it('the FLUSH counts inside the 2 s budget: a flush that hangs lifts the latch at 2 s and backs off', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    let release!: () => void
    w.ports.flushAndPauseWrites = () => { w.log.push('flush+pause'); return new Promise<void>((r) => { release = r }) }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(2_050)
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'unblock', 'resume'])
    expect(w.blockedFor[0]).toBeLessThanOrEqual(2_000)
    expect(hop.state()).toMatchObject({ phase: 'backoff' })
    // The late flush settles AFTER the lift: writes are resumed again, never
    // left paused behind a lifted latch.
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.log.slice(5)).toEqual(['resume'])
    hop.stop()
  })

  it('a FAILED acknowledgement is pending, not a failed hop: the latch lifts at its deadline and the backoff retries', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const ack = w.ports.acknowledge
    let failing = true
    w.ports.acknowledge = async (d, s) => { if (failing) throw new Error('HTTP 503'); return ack(d, s) }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(hop.state()).toMatchObject({ phase: 'backoff', attempt: 0 })
    failing = false
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toContain('swap automerge:new')
  })

  it('a user typing CONTINUOUSLY still converges in one latch: the paused heads are final, and those are what is acknowledged', async () => {
    const w = world()
    let typed = 0
    let paused = false
    w.ports.oldHeads = () => {
      if (!paused) { typed += 1; w.heads = { meta: `m${typed}`, base: `b${typed}` } }
      w.forwarded.add(w.heads.meta).add(w.heads.base)
      return [{ documentId: 'meta', heads: [w.heads.meta] }, { documentId: 'base', heads: [w.heads.base] }]
    }
    const flush = w.ports.flushAndPauseWrites
    w.ports.flushAndPauseWrites = async () => { await flush(); paused = true }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1)
    expect(w.log).toContain('swap automerge:new')
  })

  it('a SECOND repoint mid-latch cancels the hop: the latch is released, the unprojected handles dropped, the newest URL hopped to', async () => {
    const w = world()
    const hop = createEpochHop(w.ports)
    hop.start('automerge:e2')
    await vi.advanceTimersByTimeAsync(500) // inside the latch, not acknowledged
    expect(hop.state()).toMatchObject({ phase: 'latched', metaUrl: 'automerge:e2' })
    hop.start('automerge:e3')
    w.forwarded.add('m1').add('b1')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toEqual([
      'load automerge:e2', 'block', 'flush+pause',
      'unblock', 'resume', 'drop automerge:e2', // cancelled: lifted, dropped unprojected
      'load automerge:e3', 'block', 'flush+pause', 'swap automerge:e3', 'retain#1 m1,b1', 'unblock', 'resume', 'release#1',
    ])
    expect(w.log).not.toContain('swap automerge:e2')
  })

  it('a second repoint while a set is RETAINED keeps that set, retains the next one apart, and releases each only on ITS forward', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    // A deferred `writeHeldReference` moves the first set's meta right after the swap.
    const retain = w.ports.retainOld
    w.ports.retainOld = (d) => {
      const token = retain(d)
      if (token === 1) w.sets.set(1, [{ documentId: 'meta', heads: ['m-late'] }])
      return token
    }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:e2')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hop.retained()).toBe(1)
    // The second repoint: the hop to e3 swaps over the e2 documents.
    w.heads = { meta: 'n1', base: 'c1' }
    w.forwarded.add('n1').add('c1')
    hop.start('automerge:e3')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(w.log).toContain('swap automerge:e3')
    expect(w.log).toContain('release#2') // e2's own set: forwarded at once
    expect(w.log).not.toContain('release#1') // e1's set still waits for m-late
    expect(hop.retained()).toBe(1)
    w.forwarded.add('m-late')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toContain('release#1')
    expect(hop.retained()).toBe(0)
  })

  it('stop() during retaining releases the retained sets (nothing is left with no poll)', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const retain = w.ports.retainOld
    w.ports.retainOld = (d) => { const t = retain(d); w.sets.set(t, [{ documentId: 'meta', heads: ['never'] }]); return t }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(hop.retained()).toBe(1)
    hop.stop()
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log[w.log.length - 1]).toBe('release#1')
    expect(hop.retained()).toBe(0)
  })

  it('the same URL twice is one hop', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log.filter((l) => l.startsWith('load'))).toEqual(['load automerge:new'])
  })

  it('the retained old documents stay attached until their LAST heads — moved by a bypassing writer after the swap — are forwarded', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const retain = w.ports.retainOld
    w.ports.retainOld = (d) => { const t = retain(d); w.sets.set(t, [{ documentId: 'meta', heads: ['m-late'] }]); return t }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(w.log).toContain('swap automerge:new')
    expect(w.log).not.toContain('release#1')
    expect(hop.retained()).toBe(1)
    w.forwarded.add('m-late')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log[w.log.length - 1]).toBe('release#1')
  })

  it('a RETIRED held epoch: the differences are collected BEFORE the swap, then the banner — no re-apply', async () => {
    const w = world()
    w.retiredDocs.add('meta').add('base')
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    // Nothing live to retain: the (empty) set is still handed over, so the
    // port drops what it pinned for the swap, and released at once.
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'collect-diff meta,base', 'swap automerge:new', 'retain#1 ', 'unblock', 'resume', 'banner {"objects":["o1"]}', 'release#1'])
    expect(hop.state()).toEqual({ phase: 'retired', metaUrl: 'automerge:new' })
  })

  it('MIXED retirement: only the retired documents are exported; the others are retained until forwarded', async () => {
    const w = world()
    w.retiredDocs.add('base')
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(3_000)
    // The meta (live) is not forwarded yet — no
    // swap on the retired verdict alone: the latch times out.
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'unblock', 'resume'])
    w.forwarded.add('m1')
    await vi.advanceTimersByTimeAsync(12_000)
    // The meta (already forwarded) is retained, then released at its first poll.
    expect(w.log.slice(5)).toEqual(['block', 'flush+pause', 'collect-diff base', 'swap automerge:new', 'retain#1 m1', 'unblock', 'resume', 'banner {"objects":["o1"]}', 'release#1'])
    await vi.runAllTimersAsync()
    await hop.settled()
  })

  it('the swap is TOLD the verdict\'s retired documents — on the retired path only', async () => {
    const swaps: Array<readonly string[] | undefined> = []
    const retiredWorld = world()
    retiredWorld.retiredDocs.add('meta').add('base')
    retiredWorld.ports.swap = async (_h, retired) => { swaps.push(retired) }
    const retiredHop = createEpochHop(retiredWorld.ports)
    retiredHop.start('automerge:new')
    await vi.runAllTimersAsync()
    await retiredHop.settled()
    const forwardedWorld = world()
    forwardedWorld.forwarded.add('m1').add('b1')
    forwardedWorld.ports.swap = async (_h, retired) => { swaps.push(retired) }
    const forwardedHop = createEpochHop(forwardedWorld.ports)
    forwardedHop.start('automerge:new')
    await vi.runAllTimersAsync()
    await forwardedHop.settled()
    expect(swaps.map((r) => [...(r ?? [])].sort())).toEqual([['base', 'meta'], []])
  })

  it('a failing swap lifts the latch and drops the new handles; the SAME URL started again retries', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const events: Array<Record<string, unknown>> = []
    w.ports.log = (e) => events.push(e)
    let fail = true
    w.ports.swap = async (h) => { if (fail) { w.log.push('swap!'); throw new Error('projectAll threw') } w.log.push(`swap ${h.url}`) }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'swap!', 'unblock', 'resume', 'drop automerge:new'])
    expect(events).toContainEqual(expect.objectContaining({ event: 'epoch_hop.failed', error: 'projectAll threw' }))
    expect(hop.state()).toEqual({ phase: 'idle' })
    fail = false
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toContain('swap automerge:new')
  })
})

describe('the live epoch hop: retired verdicts and the abort listener', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('point 5: the asks INSIDE the latch say so (`latch`), the drain ask does not', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const asked: Array<boolean | undefined> = []
    const acknowledge = w.ports.acknowledge
    w.ports.acknowledge = async (documents, signal, options) => { asked.push(options?.latch); return acknowledge(documents, signal) }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(asked[0]).toBeUndefined() // the drain
    expect(asked[1]).toBe(true) // the latch
  })

  it('a retired verdict waits for the batch\'s LIVE documents to be forwarded', () => {
    const docs = [{ documentId: 'meta', heads: ['m1'] }, { documentId: 'base', heads: ['b1'] }]
    const retiredBase = { documentId: 'base', durable: false, forwarded: false, epochRetired: true }
    expect(verdictOf(docs, [{ documentId: 'meta', durable: true, forwarded: false }, retiredBase])).toEqual({ kind: 'pending' })
    expect(verdictOf(docs, [{ documentId: 'meta', durable: true, forwarded: true }, retiredBase]))
      .toEqual({ kind: 'retired', retired: ['base'], targets: [] })
  })

  it('once loaded, the hop leaves NO abort listener of its own on its signal', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    let added = 0
    let removed = 0
    let hopSignal: AbortSignal | null = null
    const load = w.ports.load
    w.ports.load = async (url, signal) => {
      hopSignal = signal
      const add = signal.addEventListener.bind(signal)
      const remove = signal.removeEventListener.bind(signal)
      signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) => { if (type === 'abort') added += 1; add(type, fn, opts) }) as typeof signal.addEventListener
      signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject) => { if (type === 'abort') removed += 1; remove(type, fn) }) as typeof signal.removeEventListener
      return load(url, signal)
    }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(hopSignal).not.toBeNull()
    expect(w.log).toContain('swap automerge:new')
    expect(added).toBeGreaterThan(0)
    expect(added - removed).toBe(0)
  })
})

describe('the live epoch hop: busy drain, target heads, cancellation, backoff', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('no latch while the server answers `forwardBusy` — the tab keeps draining, then latches once and swaps', async () => {
    const w = world()
    const ack = w.ports.acknowledge
    let busyFor = 3
    const asks: Array<'drain' | 'latch'> = []
    w.ports.acknowledge = async (d, s, o) => {
      asks.push(o?.latch ? 'latch' : 'drain')
      if (!o?.latch && busyFor > 0) {
        busyFor -= 1
        return d.map((x) => ({ documentId: x.documentId, durable: true, forwarded: false, forwardPending: true, forwardBusy: true }))
      }
      // Ready: the server forwards whatever the tab holds (one pass, in time).
      for (const x of d) for (const h of x.heads) w.forwarded.add(h)
      return ack(d, s)
    }
    const hop = createEpochHop(w.ports, { busyDrainPollMs: 500 })
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(1_200)
    expect(w.log).toEqual(['load automerge:new']) // still draining: no overlay
    expect(hop.state()).toMatchObject({ phase: 'draining' })
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(asks.slice(0, 4)).toEqual(['drain', 'drain', 'drain', 'drain'])
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1)
    expect(w.log).toContain('swap automerge:new')
  })

  it('the busy drain is BOUNDED — a server busy for ever still gets the latch after `busyDrainMaxMs`', async () => {
    const w = world()
    w.ports.acknowledge = async (d) => d.map((x) => ({ documentId: x.documentId, durable: true, forwarded: false, forwardPending: true, forwardBusy: true }))
    const hop = createEpochHop(w.ports, { busyDrainMaxMs: 5_000, busyDrainPollMs: 500 })
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(4_800)
    expect(w.log.filter((l) => l === 'block')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1)
    hop.stop()
  })

  it('after a backoff the drain ASKS AGAIN — a server busy only now keeps the next latch off', async () => {
    const w = world()
    // Drain 1: pending, not busy → latch 1, never acknowledged → backoff 10 s.
    // After it the server is BUSY (S9 running): the next attempt must see it.
    let latches = 0
    const asks: Array<{ latch: boolean; at: number }> = []
    const start = Date.now()
    w.ports.acknowledge = async (d, _s, o) => {
      asks.push({ latch: o?.latch === true, at: Date.now() - start })
      if (o?.latch) latches += 1
      const busy = latches > 0 && !o?.latch
      return d.map((x) => ({ documentId: x.documentId, durable: true, forwarded: false, forwardPending: true, ...(busy ? { forwardBusy: true } : {}) }))
    }
    const hop = createEpochHop(w.ports, { busyDrainMaxMs: 5_000, busyDrainPollMs: 500 })
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1)
    expect(hop.state()).toMatchObject({ phase: 'backoff' })
    const drainsBefore = asks.filter((a) => !a.latch).length
    // Past the 10 s backoff: asked again — busy — so it drains, no second latch.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(asks.filter((a) => !a.latch).length).toBeGreaterThan(drainsBefore)
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1)
    // Bounded: it latches after `busyDrainMaxMs` all the same.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(w.log.filter((l) => l === 'block')).toHaveLength(2)
    hop.stop()
  })

  it('the backoff ESCALATES 10 s → 30 s → 60 s → 60 s between latches', async () => {
    const w = world()
    // The ordinary schedule, without starvation (which has its own test).
    const hop = createEpochHop(w.ports, { starvedAfter: Infinity })
    const blocksAt: number[] = []
    const start = Date.now()
    const block = w.ports.blockInput
    w.ports.blockInput = () => { blocksAt.push(Date.now() - start); block() }
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(2_000 + 10_000 + 2_000 + 30_000 + 2_000 + 60_000 + 2_000 + 60_000 + 100)
    // Latch starts: 0, then each after its 2 s latch + the backoff step.
    expect(blocksAt.slice(0, 5)).toEqual([0, 12_000, 44_000, 106_000, 168_000])
    hop.stop()
  })

  it('FORWARDED is not enough: the swap waits until the new handles hold the target heads, inside the same latch', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    let held = false
    const ack = w.ports.acknowledge
    w.ports.acknowledge = async (d, s) => (await ack(d, s)).map((a) => ({ ...a, targetHeads: [{ documentId: 'T', heads: ['fwd'] }] }))
    w.ports.holdsTargets = (_h, targets) => held && targets.some((t) => t.documentId === 'T' && t.heads.includes('fwd'))
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(600)
    expect(w.log).not.toContain('swap automerge:new')
    held = true // the forward change reaches the tab's copy of T
    await vi.advanceTimersByTimeAsync(600)
    expect(w.log).toContain('swap automerge:new')
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1)
    hop.stop()
  })

  it('the targets are FROZEN at the first forwarded answer: a later answer naming newer forwards is not chased', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    let answer = 0
    const ack = w.ports.acknowledge
    // Every answer names a NEWER forward to T; the tab holds only the first.
    w.ports.acknowledge = async (d, s) => {
      answer += 1
      return (await ack(d, s)).map((a) => ({ ...a, targetHeads: [{ documentId: 'T', heads: [`fwd-${answer}`] }] }))
    }
    let held = false
    w.ports.holdsTargets = (_h, targets) => held && targets.every((t) => t.heads.includes('fwd-2'))
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(300) // answers 1 (drain) and 2 (latch): frozen on fwd-2
    held = true
    await vi.advanceTimersByTimeAsync(800)
    expect(w.log).toContain('swap automerge:new')
    hop.stop()
  })

  it('the RETIRED path waits for the live sources\' targets too before it swaps', async () => {
    const w = world()
    w.retiredDocs.add('base')
    w.forwarded.add('m1')
    let held = false
    const ack = w.ports.acknowledge
    w.ports.acknowledge = async (d, s) => (await ack(d, s)).map((a) => (a.forwarded ? { ...a, targetHeads: [{ documentId: 'T', heads: ['fwd'] }] } : a))
    w.ports.holdsTargets = () => held
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(600)
    expect(w.log).not.toContain('swap automerge:new')
    held = true
    await vi.advanceTimersByTimeAsync(600)
    expect(w.log).toContain('swap automerge:new')
    expect(w.log.filter((l) => l === 'block')).toHaveLength(1)
    hop.stop()
  })

  it('target heads never held within the latch: the latch lifts and backs off, no swap', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    w.ports.holdsTargets = () => false
    const ack = w.ports.acknowledge
    w.ports.acknowledge = async (d, s) => (await ack(d, s)).map((a) => ({ ...a, targetHeads: [{ documentId: 'T', heads: ['x'] }] }))
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(2_100)
    expect(w.log).not.toContain('swap automerge:new')
    expect(hop.state()).toMatchObject({ phase: 'backoff' })
    hop.stop()
  })

  it('the root no longer names the epoch when the latch is acknowledged: no swap, latch lifted, handles dropped', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    let wanted = true
    w.ports.stillWanted = () => wanted
    const flush = w.ports.flushAndPauseWrites
    w.ports.flushAndPauseWrites = async () => { await flush(); wanted = false }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).not.toContain('swap automerge:new')
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'unblock', 'resume', 'drop automerge:new'])
  })

  it('cancel() stops the running hop (a repoint back to the held epoch) and the same URL can start again', async () => {
    const w = world()
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(500)
    hop.cancel()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.log).toEqual(['load automerge:new', 'block', 'flush+pause', 'unblock', 'resume', 'drop automerge:new'])
    w.forwarded.add('m1').add('b1')
    hop.start('automerge:new')
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toContain('swap automerge:new')
  })

  it('a load that ignores the signal cannot hold a cancelled hop; its late handles are dropped', async () => {
    const w = world()
    let arrive!: (h: { url: string }) => void
    w.ports.load = (url) => { w.log.push(`load ${url}`); return new Promise((r) => { arrive = r }) }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:slow')
    await vi.advanceTimersByTimeAsync(10)
    w.forwarded.add('m1').add('b1')
    const fast = w.ports.load
    hop.start('automerge:e3')
    w.ports.load = async (url) => { w.log.push(`load ${url}`); return { url } }
    void fast
    await vi.advanceTimersByTimeAsync(10)
    expect(w.log).toContain('load automerge:e3') // not stuck behind the slow load
    arrive({ url: 'automerge:slow' })
    await vi.runAllTimersAsync()
    await hop.settled()
    expect(w.log).toContain('drop automerge:slow')
    expect(w.log).toContain('swap automerge:e3')
    expect(w.log).not.toContain('swap automerge:slow')
  })

  it('a retained set is polled with a BACKOFF, not every 250 ms', async () => {
    const w = world()
    w.forwarded.add('m1').add('b1')
    const retain = w.ports.retainOld
    w.ports.retainOld = (d) => { const t = retain(d); w.sets.set(t, [{ documentId: 'meta', heads: ['never'] }]); return t }
    let asks = 0
    const ack = w.ports.acknowledge
    w.ports.acknowledge = async (d, s) => { if (d[0]?.heads[0] === 'never') asks += 1; return ack(d, s) }
    const hop = createEpochHop(w.ports)
    hop.start('automerge:new')
    await vi.advanceTimersByTimeAsync(60_000)
    // 250 ms fixed would be ~240 asks; doubling to a 20 s ceiling is a handful.
    expect(asks).toBeLessThanOrEqual(10)
    expect(asks).toBeGreaterThanOrEqual(5)
    hop.stop()
  })
})

describe('verdictOf', () => {
  const docs = [{ documentId: 'a', heads: ['h'] }, { documentId: 'b', heads: ['h'] }]
  it('an absent `forwarded` is "nothing to forward" (a carried, non-superseded document)', () => {
    expect(verdictOf(docs, [{ documentId: 'a', durable: true, forwarded: true }, { documentId: 'b', durable: true }])).toEqual({ kind: 'forwarded', targets: [] })
  })
  it('a forwarded verdict carries the UNION of the answers\' target heads', () => {
    expect(verdictOf(docs, [
      { documentId: 'a', durable: true, forwarded: true, targetHeads: [{ documentId: 'T', heads: ['t1'] }] },
      { documentId: 'b', durable: true, forwarded: true, targetHeads: [{ documentId: 'T', heads: ['t2'] }, { documentId: 'M', heads: ['m'] }] },
    ])).toEqual({ kind: 'forwarded', targets: [{ documentId: 'T', heads: ['t1', 't2'] }, { documentId: 'M', heads: ['m'] }] })
  })
  it('forwarded:false, or not durable, or missing, is pending', () => {
    expect(verdictOf(docs, [{ documentId: 'a', durable: true, forwarded: false }, { documentId: 'b', durable: true }])).toEqual({ kind: 'pending' })
    expect(verdictOf(docs, [{ documentId: 'a', durable: false }, { documentId: 'b', durable: true }])).toEqual({ kind: 'pending' })
    expect(verdictOf(docs, [{ documentId: 'a', durable: true }])).toEqual({ kind: 'pending' })
  })
  it('any retired document names exactly the retired ones', () => {
    expect(verdictOf(docs, [{ documentId: 'a', durable: true }, { documentId: 'b', durable: false, epochRetired: true }])).toEqual({ kind: 'retired', retired: ['b'], targets: [] })
  })

  it('a retired verdict carries what the LIVE sources\' forwards wrote', () => {
    expect(verdictOf(docs, [
      { documentId: 'a', durable: true, forwarded: true, targetHeads: [{ documentId: 'T', heads: ['x'] }] },
      { documentId: 'b', durable: false, epochRetired: true },
    ])).toEqual({ kind: 'retired', retired: ['b'], targets: [{ documentId: 'T', heads: ['x'] }] })
  })

  it('a CARRIED document answered as no epoch source settles even when not durable — never one the server names a source', () => {
    const carried = new Set(['b'])
    const retiredMeta = { documentId: 'a', durable: false, epochRetired: true as const }
    expect(verdictOf(docs, [retiredMeta, { documentId: 'b', durable: false }], carried)).toEqual({ kind: 'retired', retired: ['a'], targets: [] })
    expect(verdictOf(docs, [{ documentId: 'a', durable: true, forwarded: true }, { documentId: 'b', durable: false }], carried)).toEqual({ kind: 'forwarded', targets: [] })
    // Not carried: still pending.
    expect(verdictOf(docs, [retiredMeta, { documentId: 'b', durable: false }])).toEqual({ kind: 'pending' })
    // Carried but a source (forwarded bit, or a pending forward): not settled this way.
    expect(verdictOf(docs, [retiredMeta, { documentId: 'b', durable: true, forwarded: false }], carried)).toEqual({ kind: 'pending' })
    expect(verdictOf(docs, [retiredMeta, { documentId: 'b', durable: true, forwarded: false, forwardPending: true }], carried)).toEqual({ kind: 'pending' })
    // Carried and missing from the answer: pending.
    expect(verdictOf(docs, [retiredMeta], carried)).toEqual({ kind: 'pending' })
  })

  it('no verdict before the OLD meta\'s answer proves S7 — between S6b and S7 nothing has an epoch row', () => {
    const carried = new Set(['b'])
    // The window: the meta durable with no `forwarded`, the carried shard not
    // durable with none either. Without the proof this swapped.
    // Pending on the proof alone is said so (the S7 bound counts it).
    expect(verdictOf(docs, [{ documentId: 'a', durable: true }, { documentId: 'b', durable: false }], carried, 'a')).toEqual({ kind: 'pending', unproven: true })
    // ...and the window that already existed before the carried shards:
    // every document durable, no bit.
    expect(verdictOf(docs, [{ documentId: 'a', durable: true }, { documentId: 'b', durable: true }], new Set(), 'a')).toEqual({ kind: 'pending', unproven: true })
    // The meta missing from the answer: pending.
    expect(verdictOf(docs, [{ documentId: 'b', durable: true }], new Set(), 'a')).toEqual({ kind: 'pending', unproven: true })
    // A busy forward still reads busy.
    expect(verdictOf(docs, [{ documentId: 'a', durable: true }, { documentId: 'b', durable: true, forwarded: false, forwardPending: true, forwardBusy: true }], new Set(), 'a')).toEqual({ kind: 'pending', busy: true })
    // S7 passed: `forwarded` (even false) or `epochRetired` on the meta lets the usual rules decide.
    expect(verdictOf(docs, [{ documentId: 'a', durable: true, forwarded: true }, { documentId: 'b', durable: false }], carried, 'a')).toEqual({ kind: 'forwarded', targets: [] })
    expect(verdictOf(docs, [{ documentId: 'a', durable: true, forwarded: false }, { documentId: 'b', durable: true }], new Set(), 'a')).toEqual({ kind: 'pending' })
    expect(verdictOf(docs, [{ documentId: 'a', durable: false, epochRetired: true }, { documentId: 'b', durable: false }], carried, 'a')).toEqual({ kind: 'retired', retired: ['a'], targets: [] })
  })
})
