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
 * `defaultExpansionTargetSource` — the REAL loader. The hook's own tests inject
 * a hand-driven source, so without this file every line of the real one (the
 * scope filter, the catches, the placement-only read, handing the document
 * subscription and the close on) could be deleted with the suite green.
 * (Written by the QA lens against the first version; ported to `open`.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  lookupMany: vi.fn(),
  connectionsMany: vi.fn(),
  read: vi.fn(),
  subscribe: vi.fn(),
  close: vi.fn(),
  openDiagramPlacement: vi.fn(),
  diagramById: new Map<string, unknown>(),
}))
vi.mock('../../lib/modelQuery', () => ({
  getModelQuery: () => ({ lookupMany: deps.lookupMany, connectionsMany: deps.connectionsMany }),
}))
vi.mock('../../stores/modelStore', () => ({ getDiagramIndex: () => ({ diagramById: deps.diagramById }) }))
vi.mock('../../lib/diagrams/duplicateSource', () => ({
  openDiagramPlacement: (...args: unknown[]) => deps.openDiagramPlacement(...args),
}))
const feed = vi.hoisted(() => ({
  serverTier: true,
  listener: null as null | ((event: { workspace: unknown; generation: number; kind: string }) => void),
  unsubscribed: 0,
  changedIdsSince: vi.fn(),
  currentServerGeneration: vi.fn(),
  workspace: { landscapeId: 'L', versionId: 'v' },
}))
vi.mock('../../lib/modelQuery/tierFlag', () => ({ isServerReadModelEnabled: () => feed.serverTier }))
vi.mock('../../lib/modelQuery/workspaceInvalidation', () => ({
  subscribeCurrentWorkspaceInvalidations: (fn: typeof feed.listener) => {
    feed.listener = fn
    return () => { feed.listener = null; feed.unsubscribed += 1 }
  },
}))
vi.mock('../../lib/modelQuery/modelReadCacheChangeFeed', () => ({
  changedIdsSince: (...args: unknown[]) => feed.changedIdsSince(...args),
  currentServerGeneration: (...args: unknown[]) => feed.currentServerGeneration(...args),
}))
vi.mock('../../lib/automerge/workspace', () => ({
  currentWorkspaceRef: () => feed.workspace,
  workspaceRefKey: (ref: { landscapeId: string; versionId: string }) => `${ref.landscapeId}/${ref.versionId}`,
}))

const { defaultExpansionTargetSource: source } = await import('./useInlineExpansionContents')

const PLACED = { o1: { position: { x: 10, y: 20 }, size: { width: 100, height: 60 } } }
const COMPOSITION = { objectIds: ['o1', 'g1', 'gone'], connectionIds: ['c1', 'c-gone'] }

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  deps.openDiagramPlacement.mockReturnValue({ read: deps.read, subscribe: deps.subscribe, close: deps.close })
  deps.read.mockResolvedValue(PLACED)
  deps.lookupMany.mockResolvedValue(new Map<string, unknown>([
    ['o1', { id: 'o1', scope: 'internal' }],
    ['g1', { id: 'g1', name: 'a group, no scope' }],
    ['gone', undefined],
  ]))
  deps.connectionsMany.mockImplementation(async (ids: string[]) =>
    new Map(ids.filter((id) => id === 'c1').map((id) => [id, { id }])))
})
afterEach(() => {
  warn.mockRestore()
  vi.clearAllMocks()
  deps.diagramById.clear()
})

describe('defaultExpansionTargetSource', () => {
  it('reads the composition from the diagram index', () => {
    const stub = { objectIds: ['o1'], connectionIds: [] }
    deps.diagramById.set('B', stub)
    expect(source.composition('B')).toBe(stub)
    expect(source.composition('nope')).toBeUndefined()
  })

  it('keeps C4 objects and found connections, with the placement', async () => {
    const target = source.open('B')
    expect(deps.openDiagramPlacement).toHaveBeenCalledWith('B')
    const read = await target.load(COMPOSITION, { contents: true })
    expect(read.objects!.map((o) => o.id)).toEqual(['o1'])
    expect(read.connections!.map((c) => c.id)).toEqual(['c1'])
    expect(read.layouts).toEqual(PLACED)
    // ONE batched call for every connection, not one request per id.
    expect(deps.connectionsMany).toHaveBeenCalledOnce()
    expect(deps.connectionsMany).toHaveBeenCalledWith(['c1', 'c-gone'])
  })

  it('hands the document subscription and the close through', () => {
    const target = source.open('B')
    const unsubscribe = vi.fn()
    deps.subscribe.mockReturnValue(unsubscribe)
    const onChange = vi.fn()
    // Without it the hook never hears the target's document change.
    expect(target.subscribe(onChange)).toBe(unsubscribe)
    expect(deps.subscribe).toHaveBeenCalledWith(onChange)
    // Without it the lease on the target document is never given back.
    target.close()
    expect(deps.close).toHaveBeenCalledOnce()
  })

  it('a placement-only read asks the model nothing', async () => {
    const read = await source.open('B').load(COMPOSITION, { contents: false })
    expect(read).toEqual({ layouts: PLACED })
    expect(deps.lookupMany).not.toHaveBeenCalled()
    expect(deps.connectionsMany).not.toHaveBeenCalled()
  })

  it('a failed shapes lookup is UNKNOWN (absent), not empty, and the placement still comes', async () => {
    deps.lookupMany.mockRejectedValue(new Error('server down'))
    const read = await source.open('B').load(COMPOSITION, { contents: true })
    expect(read.objects).toBeUndefined()
    expect(read.connections).toBeUndefined()
    expect(read.layouts).toEqual(PLACED)
  })

  it('an unreadable placement is "unknown" (null), and the shapes still come', async () => {
    deps.read.mockRejectedValue(new Error('document unavailable'))
    const read = await source.open('B').load(COMPOSITION, { contents: true })
    expect(read.layouts).toBeNull()
    expect(read.objects!.map((o) => o.id)).toEqual(['o1'])
  })

  describe('watchServerChanges', () => {
    const A = { landscapeId: 'L', versionId: 'v' }
    const B = { landscapeId: 'L', versionId: 'draft' }
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    beforeEach(() => {
      feed.serverTier = true
      feed.listener = null
      feed.unsubscribed = 0
      feed.workspace = A
      feed.changedIdsSince.mockReset()
      feed.currentServerGeneration.mockReset()
    })

    it('has nothing to follow without the server tier', () => {
      feed.serverTier = false
      expect(source.watchServerChanges!(() => {})).toBeNull()
      expect(feed.listener).toBeNull()
    })

    // Reviewer lens: the shared stream is usually open already, so no 'ready'
    // comes — unseeded, the first edit after expanding went to the slow lane.
    it('is seeded at once: the first event is answered with ids', async () => {
      feed.currentServerGeneration.mockResolvedValue(10)
      feed.changedIdsSince.mockResolvedValue({ objectIds: ['o1'], connectionIds: [] })
      const seen: unknown[] = []
      const stop = source.watchServerChanges!((change) => seen.push(change))!
      await flush()
      feed.listener!({ workspace: A, generation: 12, kind: 'invalidate' })
      await flush()
      expect(feed.changedIdsSince).toHaveBeenCalledWith(A, 10, 12, expect.anything())
      expect(seen).toEqual([{ objectIds: ['o1'], connectionIds: [] }])

      // A replayed generation asks nothing; the next starts from the last seen.
      feed.listener!({ workspace: A, generation: 12, kind: 'invalidate' })
      feed.listener!({ workspace: A, generation: 13, kind: 'invalidate' })
      await flush()
      expect(feed.changedIdsSince).toHaveBeenCalledTimes(2)
      expect(feed.changedIdsSince).toHaveBeenLastCalledWith(A, 12, 13, expect.anything())

      stop()
      expect(feed.unsubscribed).toBe(1)
    })

    it('without a seed, the first event is "unknown", the next has ids', async () => {
      feed.currentServerGeneration.mockRejectedValue(new Error('HTTP 503'))
      feed.changedIdsSince.mockResolvedValue({ objectIds: [], connectionIds: [] })
      const seen: unknown[] = []
      source.watchServerChanges!((change) => seen.push(change))
      await flush()
      feed.listener!({ workspace: A, generation: 10, kind: 'invalidate' })
      expect(seen).toEqual([null])
      feed.listener!({ workspace: A, generation: 11, kind: 'invalidate' })
      await flush()
      expect(feed.changedIdsSince).toHaveBeenCalledWith(A, 10, 11, expect.anything())
    })

    // Architect + reviewer lenses: generations count per workspace. A switch
    // that kept the diagram on screen used to drop every event at or below
    // the OLD workspace's generation — silently.
    it('an event from another workspace re-baselines and says "unknown", never nothing', async () => {
      feed.currentServerGeneration.mockResolvedValue(500)
      const seen: unknown[] = []
      source.watchServerChanges!((change) => seen.push(change))
      await flush()
      feed.listener!({ workspace: B, generation: 12, kind: 'invalidate' })
      expect(seen).toEqual([null])
      expect(feed.changedIdsSince).not.toHaveBeenCalled()

      feed.changedIdsSince.mockResolvedValue({ objectIds: ['x'], connectionIds: [] })
      feed.listener!({ workspace: B, generation: 13, kind: 'invalidate' })
      await flush()
      expect(feed.changedIdsSince).toHaveBeenCalledWith(B, 12, 13, expect.anything())
    })

    it('a stream that comes back BELOW the baseline says "unknown"', async () => {
      feed.currentServerGeneration.mockResolvedValue(20)
      const seen: unknown[] = []
      source.watchServerChanges!((change) => seen.push(change))
      await flush()
      feed.listener!({ workspace: A, generation: 5, kind: 'ready' })
      expect(seen).toEqual([null])
    })

    it('a failed question is "unknown", not silence', async () => {
      feed.currentServerGeneration.mockResolvedValue(1)
      feed.changedIdsSince.mockRejectedValue(new Error('HTTP 503'))
      const seen: unknown[] = []
      source.watchServerChanges!((change) => seen.push(change))
      await flush()
      feed.listener!({ workspace: A, generation: 2, kind: 'invalidate' })
      await flush()
      expect(seen).toEqual([null])
    })

    // QA lens, review 3: nothing checked that stop() cancels, nor that the
    // cancellation is not then reported as "unknown".
    it('stop() cancels the question in flight, and its failure is not reported', async () => {
      feed.currentServerGeneration.mockResolvedValue(1)
      const seen: unknown[] = []
      let asked: AbortSignal | undefined
      let fail: (error: unknown) => void = () => {}
      feed.changedIdsSince.mockImplementation((_workspace: unknown, _since: number, _upTo: number, signal: AbortSignal) => {
        asked = signal
        return new Promise((_resolve, reject) => { fail = reject })
      })
      const stop = source.watchServerChanges!((change) => seen.push(change))!
      await flush()
      feed.listener!({ workspace: A, generation: 2, kind: 'invalidate' })
      expect(asked?.aborted).toBe(false)
      stop()
      expect(asked?.aborted, 'the question outlived the watch').toBe(true)
      fail(new DOMException('aborted', 'AbortError'))
      await flush()
      expect(seen, 'an aborted question was reported as "unknown"').toEqual([])
    })

    it('an answer landing after unsubscribe is dropped', async () => {
      feed.currentServerGeneration.mockResolvedValue(1)
      let answer!: (change: unknown) => void
      feed.changedIdsSince.mockReturnValue(new Promise((resolve) => { answer = resolve }))
      const seen: unknown[] = []
      const stop = source.watchServerChanges!((change) => seen.push(change))!
      await flush()
      feed.listener!({ workspace: A, generation: 2, kind: 'invalidate' })
      stop()
      answer({ objectIds: ['o1'], connectionIds: [] })
      await flush()
      expect(seen).toEqual([])
    })
  })
})
