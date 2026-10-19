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

/**
 * The idle HEAL that follows a scoped lower roll-up (review 2026-10-11).
 *
 * Before the scoped pass, every connect re-derived EVERY diagram — the 4 s
 * freeze — which also repaired, incidentally, roll-ups left stale by paths
 * that never re-derive (deleteObject, remote projection, group membership…).
 * The scoped pass alone no longer does; the heal restores that repair off the
 * critical path: idle-time slices with a time budget, one heal at a time,
 * superseded by a newer mutation, restarted when the store moves under it,
 * dropped on a workspace switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __lowerSyncForTest, useModelStore } from './modelStore'
import { currentWorkspaceRef, primeActiveWorkspaceRef, setActiveWorkspaceRef } from '../lib/automerge/workspace'
import type { C4Object, Connection, Diagram } from '../types'

function obj(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
  }
}
function conn(id: string, fromId: string, toId: string, over: Partial<Connection> = {}): Connection {
  return { id, fromId, toId, type: 'solid', ...over }
}
function diagram(id: string, over: Partial<Diagram> = {}): Diagram {
  return { id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over }
}

/*
 * dActive shows A1, A2 (children of S, S2); dSystems shows S, S2; dOther shows
 * X, Y. The direct A1→A2 rolls up to S→S2 on dSystems.
 */
function seed() {
  useModelStore.setState({
    objects: [
      obj('S', { type: 'system' }), obj('S2', { type: 'system' }),
      obj('A1', { parentId: 'S' }), obj('A2', { parentId: 'S2' }),
      obj('X', { type: 'system' }), obj('Y', { type: 'system' }),
      obj('X1', { parentId: 'X' }), obj('Y1', { parentId: 'Y' }),
    ],
    connections: [conn('a12', 'A1', 'A2')],
    groups: [],
    diagrams: [
      diagram('dActive', { objectIds: ['A1', 'A2'], connectionIds: ['a12'] }),
      diagram('dSystems', { objectIds: ['S', 'S2'] }),
      diagram('dOther', { objectIds: ['X', 'Y'] }),
    ],
    domains: [],
    currentDiagramId: 'dActive',
    selectedItems: [],
  })
  for (const d of useModelStore.getState().diagrams) useModelStore.getState().syncLowerConnections(d.id)
}

const lowersOn = (diagramId: string) => {
  const s = useModelStore.getState()
  const d = s.diagrams.find((x) => x.id === diagramId)!
  return s.connections
    .filter((c) => c.kind === 'lower' && d.connectionIds.includes(c.id))
    .map((c) => `${c.fromId}->${c.toId}`)
}

type ProbeEntry = { kind: string; derived: number; committed: number; rebuilt: boolean; left: number }
const probeHost = globalThis as { __lowerSyncProbe?: ProbeEntry[] }

beforeEach(() => {
  vi.useFakeTimers()
  __lowerSyncForTest.reset()
  __lowerSyncForTest.setHealEnabled(true)
  probeHost.__lowerSyncProbe = []
  seed()
})
afterEach(() => {
  __lowerSyncForTest.reset()
  __lowerSyncForTest.trace(null)
  __lowerSyncForTest.setClock(null)
  delete probeHost.__lowerSyncProbe
  vi.useRealTimers()
})

describe('the idle heal repairs what the scoped pass does not reach', () => {
  it('a roll-up left stale by deleteObject (which re-derives only the active diagram) is healed after the next scoped pass (RED with no heal)', () => {
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    // deleteObject drops A1→A2 and re-derives dActive only: dSystems keeps
    // its S→S2, which nothing justifies any more.
    useModelStore.getState().deleteObject('A1')
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    // An unrelated connect: its scoped pass reaches dOther only.
    useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    vi.advanceTimersByTime(100)
    expect(lowersOn('dOther')).toEqual(['X->Y'])
    expect(__lowerSyncForTest.pending().heal).toBe(true)
    // The heal runs in idle time (setTimeout fallback here: no rIC in Node).
    vi.advanceTimersByTime(50)
    expect(__lowerSyncForTest.pending().heal).toBe(false)
    expect(lowersOn('dSystems')).toEqual([])
    expect(useModelStore.getState().connections.filter((c) => c.kind === 'lower').map((c) => `${c.fromId}->${c.toId}`)).toEqual(['X->Y'])
  })

  it('a heal that finds nothing stale commits nothing (no subscriber wakes)', () => {
    useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    vi.advanceTimersByTime(100)
    const listener = vi.fn()
    const unsubscribe = useModelStore.subscribe(listener)
    __lowerSyncForTest.runHeal()
    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
    const heal = (probeHost.__lowerSyncProbe ?? []).filter((e) => e.kind === 'heal')
    expect(heal.length).toBeGreaterThan(0)
    expect(heal.every((e) => e.committed === 0)).toBe(true)
  })

  it('a full pass (a caller that names no endpoints) is not followed by a heal', () => {
    useModelStore.getState().syncAllLowerConnections()
    vi.advanceTimersByTime(100)
    expect(__lowerSyncForTest.pending()).toEqual({ debounce: false, priority: false, heal: false })
  })
})

describe('the heal is sliced by a time budget', () => {
  /** A clock that advances `step` ms every time the engine reads it. */
  function steppingClock(step: number) {
    let t = 0
    __lowerSyncForTest.setClock(() => (t += step))
  }

  function manyDiagrams(n: number) {
    useModelStore.setState((s) => ({
      diagrams: [
        ...s.diagrams,
        ...Array.from({ length: n }, (_, i) => diagram(`dMany${i}`, { objectIds: ['S', 'S2'] })),
      ],
    }))
  }

  it('yields between diagrams once the 8 ms budget is spent (RED when a slice runs to the end)', () => {
    manyDiagrams(20)
    // Every derived diagram reads the clock once more: 5 ms per read means
    // two diagrams fit (reads at +5 and +10 ms relative to the slice start).
    steppingClock(5)
    __lowerSyncForTest.scheduleHeal()
    __lowerSyncForTest.runHeal()
    const heal = (probeHost.__lowerSyncProbe ?? []).filter((e) => e.kind === 'heal')
    const total = useModelStore.getState().diagrams.length
    expect(heal.reduce((n, e) => n + e.derived, 0)).toBe(total)
    expect(Math.max(...heal.map((e) => e.derived))).toBeLessThanOrEqual(2)
    expect(heal.length).toBeGreaterThanOrEqual(Math.ceil(total / 2))
    // Each slice is its own task: the second is armed, not run inline.
    expect(heal[0].left).toBeGreaterThan(0)
  })

  it('a slice that only rebuilt may yield, every other slice derives at least ONE diagram (progress)', () => {
    manyDiagrams(3)
    steppingClock(1_000)
    __lowerSyncForTest.scheduleHeal()
    __lowerSyncForTest.runHeal()
    const heal = (probeHost.__lowerSyncProbe ?? []).filter((e) => e.kind === 'heal')
    expect(heal[0]).toMatchObject({ rebuilt: true, derived: 0 })
    expect(heal.slice(1).every((e) => !e.rebuilt && e.derived === 1)).toBe(true)
    expect(heal.length).toBe(useModelStore.getState().diagrams.length + 1)
  })

  it('the scoped pass of a HUB object yields between slices too, and still lands every roll-up', () => {
    manyDiagrams(30)
    __lowerSyncForTest.setHealEnabled(false)
    steppingClock(5)
    useModelStore.getState().addConnection({ fromId: 'A2', toId: 'A1', type: 'solid' })
    vi.advanceTimersByTime(100)
    const first = (probeHost.__lowerSyncProbe ?? []).filter((e) => e.kind === 'scoped')
    expect(first.length).toBe(1)
    expect(__lowerSyncForTest.pending().priority).toBe(true)
    vi.advanceTimersByTime(1_000)
    const scoped = (probeHost.__lowerSyncProbe ?? []).filter((e) => e.kind === 'scoped')
    expect(scoped.length).toBeGreaterThan(10)
    expect(__lowerSyncForTest.pending().priority).toBe(false)
    for (let i = 0; i < 30; i++) expect(lowersOn(`dMany${i}`).sort()).toEqual(['S->S2', 'S2->S'])
  })
})

describe('the heal yields to the user', () => {
  it('a new connection mutation supersedes a pending heal; its own pass re-arms one', () => {
    useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    vi.advanceTimersByTime(100)
    expect(__lowerSyncForTest.pending().heal).toBe(true)
    useModelStore.getState().addConnection({ fromId: 'Y1', toId: 'X1', type: 'solid' })
    expect(__lowerSyncForTest.pending()).toEqual({ debounce: true, priority: false, heal: false })
    vi.advanceTimersByTime(100)
    expect(__lowerSyncForTest.pending().heal).toBe(true)
  })

  it('a store change between two slices: the heal rebuilds its context and CONTINUES — later diagrams see the new state, an earlier one lags until the next heal (RED when the stale context is reused)', () => {
    useModelStore.setState((s) => ({
      diagrams: [...s.diagrams, ...Array.from({ length: 6 }, (_, i) => diagram(`dMany${i}`, { objectIds: ['S', 'S2'] }))],
    }))
    // 3 ms per clock read: the first slice (start read, rebuild, then reads at
    // +3, +6, +9) derives exactly two diagrams.
    let t = 0
    __lowerSyncForTest.setClock(() => (t += 3))
    const order: string[] = []
    __lowerSyncForTest.trace((id, kind) => { if (kind === 'heal') order.push(id) })
    __lowerSyncForTest.scheduleHeal()
    vi.advanceTimersByTime(0)
    expect(order).toEqual(['dActive', 'dSystems'])
    // Mid-heal, a path that never schedules a pass removes A1→A2: its S→S2
    // roll-up becomes pointless — on dSystems, which the heal ALREADY passed,
    // and on the dMany diagrams, which it has not reached yet (derived against
    // the OLD state they would gain an S→S2 nothing justifies).
    useModelStore.setState((s) => ({ connections: s.connections.filter((c) => c.id !== 'a12') }))
    vi.advanceTimersByTime(100)
    expect(__lowerSyncForTest.pending().heal).toBe(false)
    // Continued where it was, against a rebuilt context.
    expect(order).toEqual(['dActive', 'dSystems', 'dOther', ...Array.from({ length: 6 }, (_, i) => `dMany${i}`)])
    expect(probeHost.__lowerSyncProbe!.filter((e) => e.kind === 'heal' && e.rebuilt).length).toBe(2)
    for (let i = 0; i < 6; i++) expect(lowersOn(`dMany${i}`)).toEqual([])
    // The price of not restarting: dSystems lags until the next heal.
    expect(lowersOn('dSystems')).toEqual(['S->S2'])
    __lowerSyncForTest.scheduleHeal()
    vi.advanceTimersByTime(100)
    expect(lowersOn('dSystems')).toEqual([])
  })

  it('a heal under a STREAM of foreign store changes (a remote drag replacing `objects`) still completes (RED when a stale context restarts the heal)', () => {
    useModelStore.setState((s) => ({
      diagrams: [...s.diagrams, ...Array.from({ length: 30 }, (_, i) => diagram(`dMany${i}`, { objectIds: ['S', 'S2'] }))],
    }))
    let t = 0
    __lowerSyncForTest.setClock(() => (t += 3))
    __lowerSyncForTest.scheduleHeal()
    let slices = 0
    while (__lowerSyncForTest.pending().heal && slices < 500) {
      // A new `objects` identity before every slice: the context is never current.
      useModelStore.setState((s) => ({ objects: s.objects.map((o) => ({ ...o })) }))
      // 1 ms: a 0-delay timer armed during a fake tick is due at now + 1.
      vi.advanceTimersByTime(1)
      slices++
    }
    expect(__lowerSyncForTest.pending().heal).toBe(false)
    const heal = probeHost.__lowerSyncProbe!.filter((e) => e.kind === 'heal')
    // Every slice but the second (run in the same fake tick as the first,
    // before the next foreign change) found its context stale.
    expect(heal.filter((e) => e.rebuilt).length).toBeGreaterThanOrEqual(heal.length - 1)
    expect(heal.length).toBeGreaterThan(10)
    expect(heal.reduce((n, e) => n + e.derived, 0)).toBe(useModelStore.getState().diagrams.length)
    for (let i = 0; i < 30; i++) expect(lowersOn(`dMany${i}`)).toEqual(['S->S2'])
  })

  it('a workspace switch drops the pending request, the pass and the heal', () => {
    const before = currentWorkspaceRef()
    try {
      useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
      vi.advanceTimersByTime(100)
      expect(__lowerSyncForTest.pending().heal).toBe(true)
      useModelStore.getState().addConnection({ fromId: 'Y1', toId: 'X1', type: 'solid' })
      expect(__lowerSyncForTest.pending().debounce).toBe(true)
      const synced: string[] = []
      __lowerSyncForTest.trace((id) => synced.push(id))
      setActiveWorkspaceRef({ landscapeId: 'other-landscape', versionId: 'v1' })
      expect(__lowerSyncForTest.pending()).toEqual({ debounce: false, priority: false, heal: false })
      vi.advanceTimersByTime(1_000)
      expect(synced).toEqual([])
    } finally {
      setActiveWorkspaceRef(before)
    }
  })

  it('a slice that finds the workspace changed WITHOUT notification cancels itself (RED without the per-slice key check)', () => {
    const before = currentWorkspaceRef()
    try {
      __lowerSyncForTest.scheduleHeal()
      const synced: string[] = []
      __lowerSyncForTest.trace((id) => synced.push(id))
      // primeActiveWorkspaceRef swaps the ref without notifying listeners.
      primeActiveWorkspaceRef({ landscapeId: 'silent-landscape', versionId: 'v1' })
      expect(__lowerSyncForTest.pending().heal).toBe(true)
      vi.advanceTimersByTime(100)
      expect(synced).toEqual([])
      expect(__lowerSyncForTest.pending().heal).toBe(false)
    } finally {
      primeActiveWorkspaceRef(before)
    }
  })
})

/*
 * Second review round (2026-10-11).
 */
describe('robustness: a user edit always lands, a failing slice never wedges', () => {
  function trace() {
    const seen: Array<[string, string]> = []
    __lowerSyncForTest.trace((id, kind) => seen.push([id, kind]))
    return seen
  }
  // A group from a foreign or corrupt shard: no `objectIds` array. On no
  // diagram, so only the SCOPE computation (which scans every group) meets it.
  function malformedGroup() {
    useModelStore.setState((s) => ({ groups: [...s.groups, { id: 'BAD', name: 'BAD' } as unknown as typeof s.groups[number]] }))
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a malformed group: connect, reconnect, placement reconnect and delete all land, and each schedules a FULL pass (RED when a scope computation can throw)', () => {
    malformedGroup()
    const seen = trace()
    const id = useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    expect(useModelStore.getState().connections.some((c) => c.id === id)).toBe(true)
    useModelStore.getState().updateConnection(id, { toId: 'A2' })
    expect(useModelStore.getState().connections.find((c) => c.id === id)).toMatchObject({ toId: 'A2' })
    useModelStore.getState().updatePlacementsBatch({ connections: [{ id, data: { fromId: 'A1' } }] })
    expect(useModelStore.getState().connections.find((c) => c.id === id)).toMatchObject({ fromId: 'A1', toId: 'A2' })
    useModelStore.getState().deleteConnection('a12')
    expect(useModelStore.getState().connections.some((c) => c.id === 'a12')).toBe(false)
    vi.advanceTimersByTime(100)
    const passKinds = new Set(seen.filter(([, kind]) => kind !== 'heal').map(([, kind]) => kind))
    expect([...passKinds]).toEqual(['full'])
    expect(seen.filter(([, kind]) => kind === 'full').map(([d]) => d)).toEqual(useModelStore.getState().diagrams.map((d) => d.id))
  })

  it('deleteConnection alone, with a malformed group, lands and falls back to a full pass', () => {
    malformedGroup()
    const seen = trace()
    useModelStore.getState().deleteConnection('a12')
    expect(useModelStore.getState().connections.some((c) => c.id === 'a12')).toBe(false)
    vi.advanceTimersByTime(100)
    expect(seen.some(([, kind]) => kind === 'full')).toBe(true)
    expect(lowersOn('dSystems')).toEqual([])
  })

  it('a slice that throws drops its pass, and the next mutation still runs one (RED when a throwing slice leaves its pass registered)', () => {
    let explode = true
    __lowerSyncForTest.trace((id) => {
      if (explode && id === 'dSystems') throw new Error('boom')
    })
    // A2→A1 reaches dActive and dSystems: the scoped pass throws on the second.
    useModelStore.getState().addConnection({ fromId: 'A2', toId: 'A1', type: 'solid' })
    expect(() => vi.advanceTimersByTime(100)).toThrow('boom')
    expect(__lowerSyncForTest.pending()).toEqual({ debounce: false, priority: false, heal: false })
    explode = false
    const seen = trace()
    useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    vi.advanceTimersByTime(100)
    expect(seen.filter(([, kind]) => kind === 'scoped').length).toBeGreaterThan(0)
    expect(lowersOn('dOther')).toEqual(['X->Y'])
  })

  it('a HEAL slice that throws drops the heal (RED when it stays registered)', () => {
    __lowerSyncForTest.trace((_, kind) => {
      if (kind === 'heal') throw new Error('heal boom')
    })
    __lowerSyncForTest.scheduleHeal()
    expect(() => vi.advanceTimersByTime(1)).toThrow('heal boom')
    expect(__lowerSyncForTest.pending().heal).toBe(false)
  })

  it('a scoped request that reaches no diagram builds no context and goes straight to the heal (RED when an empty queue still builds one)', () => {
    useModelStore.getState().syncAllLowerConnections(['reaches-nothing'])
    vi.advanceTimersByTime(100)
    expect(probeHost.__lowerSyncProbe!.filter((e) => e.kind === 'scoped')).toEqual([])
    expect(__lowerSyncForTest.pending().heal).toBe(true)
  })

  it('a pass that finishes while a newer request is debounced does not arm a heal (RED when it does)', () => {
    useModelStore.setState((s) => ({
      diagrams: [...s.diagrams, ...Array.from({ length: 20 }, (_, i) => diagram(`dMany${i}`, { objectIds: ['S', 'S2'] }))],
    }))
    let t = 0
    __lowerSyncForTest.setClock(() => (t += 5))
    useModelStore.getState().addConnection({ fromId: 'A2', toId: 'A1', type: 'solid' })
    vi.advanceTimersByTime(100)
    expect(__lowerSyncForTest.pending().priority).toBe(true)
    // A newer request while the first pass is still slicing.
    useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    // Watch for heal WORK, not just the flag: a heal armed here would run to
    // completion inside the same advance and leave the flag clean.
    const healed: string[] = []
    __lowerSyncForTest.trace((id, kind) => { if (kind === 'heal') healed.push(id) })
    vi.advanceTimersByTime(50)
    expect(healed).toEqual([])
    expect(__lowerSyncForTest.pending()).toEqual({ debounce: true, priority: false, heal: false })
    // The newer request fires (t = 200) and ITS pass arms the heal.
    vi.advanceTimersByTime(50)
    expect(__lowerSyncForTest.pending()).toEqual({ debounce: false, priority: false, heal: true })
  })
})

describe('requestIdleCallback: cancellation and the budget cap', () => {
  type Deadline = { didTimeout: boolean; timeRemaining: () => number }
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: (d: Deadline) => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  let callbacks: Map<number, (d: Deadline) => void>
  let cancelled: number[]
  let timeouts: Array<number | undefined>

  beforeEach(() => {
    callbacks = new Map()
    cancelled = []
    timeouts = []
    let next = 1
    host.requestIdleCallback = (cb, opts) => {
      const id = next++
      callbacks.set(id, cb)
      timeouts.push(opts?.timeout)
      return id
    }
    host.cancelIdleCallback = (id) => {
      cancelled.push(id)
      callbacks.delete(id)
    }
  })
  afterEach(() => {
    // (Node has neither: removing them restores the setTimeout fallback.)
    Reflect.deleteProperty(host, 'requestIdleCallback')
    Reflect.deleteProperty(host, 'cancelIdleCallback')
  })

  /** Run the one armed idle callback with this deadline. */
  function runIdle(deadline: Deadline) {
    const [[id, cb]] = [...callbacks]
    callbacks.delete(id)
    cb(deadline)
  }

  it('a newer mutation cancels the armed idle callback, and a stale one that fires anyway does nothing', () => {
    useModelStore.getState().addConnection({ fromId: 'X1', toId: 'Y1', type: 'solid' })
    vi.advanceTimersByTime(100)
    expect(callbacks.size).toBe(1)
    expect(timeouts).toEqual([2_000])
    const [[armedId, armed]] = [...callbacks]
    useModelStore.getState().addConnection({ fromId: 'Y1', toId: 'X1', type: 'solid' })
    expect(cancelled).toEqual([armedId])
    const seen: string[] = []
    __lowerSyncForTest.trace((id, kind) => { if (kind === 'heal') seen.push(id) })
    armed({ didTimeout: false, timeRemaining: () => 50 })
    expect(seen).toEqual([])
  })

  it('caps a slice at 8 ms whatever the idle period offers, honours a shorter one, and uses 8 ms on a timeout (RED without the cap)', () => {
    useModelStore.setState((s) => ({
      diagrams: [...s.diagrams, ...Array.from({ length: 60 }, (_, i) => diagram(`dMany${i}`, { objectIds: ['S', 'S2'] }))],
    }))
    // 1 ms per clock read: a slice derives about one diagram per ms of budget.
    let t = 0
    __lowerSyncForTest.setClock(() => (t += 1))
    __lowerSyncForTest.scheduleHeal()
    const derivedBy = (deadline: Deadline) => {
      const before = probeHost.__lowerSyncProbe!.length
      runIdle(deadline)
      return probeHost.__lowerSyncProbe!.slice(before).reduce((n, e) => n + e.derived, 0)
    }
    const generous = derivedBy({ didTimeout: false, timeRemaining: () => 50 })
    const short = derivedBy({ didTimeout: false, timeRemaining: () => 3 })
    const timedOut = derivedBy({ didTimeout: true, timeRemaining: () => 0 })
    expect(generous).toBeGreaterThan(3)
    expect(generous).toBeLessThanOrEqual(8)
    expect(short).toBeLessThanOrEqual(3)
    expect(timedOut).toBeGreaterThan(3)
    expect(timedOut).toBeLessThanOrEqual(8)
  })
})
