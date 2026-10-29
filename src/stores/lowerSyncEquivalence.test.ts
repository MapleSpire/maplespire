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
 * Seeded-random equivalence detectors for the lower roll-up (review
 * 2026-10-11). Three properties, each over a few hundred deterministic cases:
 *
 *  1. ORACLE — the hoisted-context derivation (one context per pass, kept
 *     current across its own derivations, one commit per slice) yields
 *     exactly what the ORIGINAL per-diagram algorithm, copied verbatim below,
 *     yields in sequence: same membership order, same surviving lower ids,
 *     same connections order. Any state, stale or not.
 *  2. SCOPE — after connect / reconnect / delete bursts, the scoped pass ALONE
 *     (heal off) leaves every diagram a fixed point of a full re-derivation.
 *  3. HEAL — adding the paths that never re-derive (deleteObject, a reparent,
 *     a remote group edit), scoped pass + heal leave the same fixed point.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __lowerSyncForTest, useModelStore } from './modelStore'
import type { C4Object, Connection, Diagram, Group } from '../types'

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32).
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]
  const subset = <T,>(xs: readonly T[], p: number): T[] => xs.filter(() => next() < p)
  return { next, int, pick, subset }
}
type Rng = ReturnType<typeof rng>

function obj(id: string, parentId?: string): C4Object {
  return {
    id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
    tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
    ...(parentId ? { parentId } : {}),
  }
}

interface Model {
  objects: C4Object[]
  groups: Group[]
  diagrams: Diagram[]
  connections: Connection[]
}

/** Systems ⊃ containers ⊃ components, a few groups, diagrams showing random
 * slices of every level, direct connections between random objects. */
function randomModel(r: Rng, opts: { staleLowers: boolean }): Model {
  const systems = Array.from({ length: 3 + r.int(2) }, (_, i) => obj(`S${i}`))
  const containers = Array.from({ length: 5 + r.int(4) }, (_, i) => obj(`C${i}`, r.pick(systems).id))
  const components = Array.from({ length: 5 + r.int(5) }, (_, i) => obj(`K${i}`, r.pick(containers).id))
  const loose = [obj('L0'), obj('L1')]
  const objects = [...systems, ...containers, ...components, ...loose]
  const ids = objects.map((o) => o.id)
  const groups: Group[] = Array.from({ length: 1 + r.int(3) }, (_, i) => ({
    id: `G${i}`, name: `G${i}`, objectIds: r.subset([...containers, ...components].map((o) => o.id), 0.2),
  }) as unknown as Group)
  const connections: Connection[] = []
  for (let i = 0; i < 6 + r.int(10); i++) {
    const from = r.pick(ids)
    let to = r.pick(ids)
    if (to === from) to = r.pick(ids)
    connections.push({ id: `c${i}`, fromId: from, toId: to, type: 'solid' })
  }
  const diagrams: Diagram[] = Array.from({ length: 4 + r.int(5) }, (_, i) => ({
    id: `d${i}`, name: `d${i}`, type: 'container',
    objectIds: r.subset(ids, 0.25),
    connectionIds: [],
    groupIds: r.subset(groups.map((g) => g.id), 0.4),
  }))
  for (const c of connections) {
    for (const d of diagrams) {
      if (d.objectIds.includes(c.fromId) && d.objectIds.includes(c.toId) && r.next() < 0.8) d.connectionIds.push(c.id)
    }
  }
  if (opts.staleLowers) {
    // Lowers that may or may not be needed, duplicated pairs, shared between
    // diagrams, dangling ids.
    const endpoints = [...ids, ...groups.map((g) => g.id)]
    for (let i = 0; i < 2 + r.int(8); i++) {
      const lower: Connection = { id: `low${i}`, fromId: r.pick(endpoints), toId: r.pick(endpoints), type: 'dashed', kind: 'lower', label: '' }
      connections.push(lower)
      if (r.next() < 0.3 && i > 0) {
        const twin = connections[connections.length - 2]
        if (twin.kind === 'lower') { lower.fromId = twin.fromId; lower.toId = twin.toId }
      }
      for (const d of diagrams) if (r.next() < 0.3) d.connectionIds.push(lower.id)
    }
    for (const d of diagrams) {
      if (r.next() < 0.15) d.connectionIds.push('ghost')
      // shuffle a little: membership order is part of what is compared
      if (d.connectionIds.length > 1 && r.next() < 0.5) d.connectionIds.reverse()
    }
  }
  return { objects, groups, diagrams, connections }
}

// ---------------------------------------------------------------------------
// ORACLE: the ORIGINAL syncLowerConnections (before the 2026-10-11 hoisting),
// copied verbatim apart from reading/writing a plain `Model`, minting ids
// through `mint`, and the direct-pair rule marked below.
// ---------------------------------------------------------------------------
function oracleSyncLowerConnections(state: Model, diagramId: string, mint: () => string): void {
  const { diagrams, objects, groups, connections } = state
  const diagram = diagrams.find((d) => d.id === diagramId)
  if (!diagram) return
  const objectMap = new Map<string, C4Object>()
  for (const o of objects) objectMap.set(o.id, o)
  const groupMap = new Map<string, Group>()
  for (const grp of groups) groupMap.set(grp.id, grp)
  const diagramObjectSet = new Set(diagram.objectIds)
  const objectToGroup = new Map<string, string>()
  for (const groupId of diagram.groupIds) {
    const group = groupMap.get(groupId)
    if (group) for (const oid of group.objectIds) objectToGroup.set(oid, groupId)
  }
  const connectionMap = new Map<string, Connection>()
  for (const conn of connections) connectionMap.set(conn.id, conn)
  const findVisibleEndpoint = (objectId: string): string | null => {
    if (diagramObjectSet.has(objectId)) return objectId
    let current = objectMap.get(objectId)?.parentId
    while (current) {
      if (diagramObjectSet.has(current)) return current
      current = objectMap.get(current)?.parentId
    }
    return objectToGroup.get(objectId) ?? null
  }
  const existingLowerIds = diagram.connectionIds.filter((cid) => connectionMap.get(cid)?.kind === 'lower')
  const lowerByPair = new Map<string, Connection>()
  for (const conn of connections) {
    if (conn.kind === 'lower') lowerByPair.set(`${conn.fromId}→${conn.toId}`, conn)
  }
  const newConnectionIds = diagram.connectionIds.filter((cid) => connectionMap.get(cid)?.kind !== 'lower')
  const newConnectionIdSet = new Set(newConnectionIds)
  // 2026-10-22, not in the original: no roll-up beside a pair the diagram
  // already draws with its own edge, in that direction.
  const directPairs = new Set<string>()
  for (const cid of newConnectionIds) {
    const own = connectionMap.get(cid)
    if (own) directPairs.add(`${own.fromId}→${own.toId}`)
  }
  const seenPairs = new Set<string>()
  const usedLowerIds = new Set<string>()
  const additions: Connection[] = []
  for (const directConn of connections) {
    if (directConn.kind === 'lower') continue
    const visibleFrom = findVisibleEndpoint(directConn.fromId)
    const visibleTo = findVisibleEndpoint(directConn.toId)
    if (!visibleFrom || !visibleTo) continue
    if (visibleFrom === directConn.fromId && visibleTo === directConn.toId) continue
    if (visibleFrom === visibleTo) continue
    const pairKey = `${visibleFrom}→${visibleTo}`
    if (directPairs.has(pairKey)) continue
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)
    const existingLower = lowerByPair.get(pairKey)
    if (existingLower) {
      if (!newConnectionIdSet.has(existingLower.id)) {
        newConnectionIds.push(existingLower.id)
        newConnectionIdSet.add(existingLower.id)
      }
      usedLowerIds.add(existingLower.id)
    } else {
      const newConn: Connection = { id: mint(), fromId: visibleFrom, toId: visibleTo, kind: 'lower', type: 'dashed', label: '' }
      additions.push(newConn)
      newConnectionIds.push(newConn.id)
      newConnectionIdSet.add(newConn.id)
      lowerByPair.set(pairKey, newConn)
      usedLowerIds.add(newConn.id)
    }
  }
  const otherDiagramConnectionIds = new Set<string>()
  for (const d of diagrams) {
    if (d.id === diagram.id) continue
    for (const cid of d.connectionIds) otherDiagramConnectionIds.add(cid)
  }
  const toPrune = new Set(existingLowerIds.filter((cid) => !usedLowerIds.has(cid) && !otherDiagramConnectionIds.has(cid)))
  if (
    additions.length === 0 && toPrune.size === 0
    && newConnectionIds.length === diagram.connectionIds.length
    && newConnectionIds.every((cid, i) => cid === diagram.connectionIds[i])
  ) return
  state.diagrams = diagrams.map((d) => (d === diagram ? { ...d, connectionIds: newConnectionIds } : d))
  if (additions.length > 0 || toPrune.size > 0) {
    const next = toPrune.size > 0 ? connections.filter((c) => !toPrune.has(c.id)) : connections.slice()
    for (const a of additions) next.push(a)
    state.connections = next
  }
}

/** Ids that existed before a pass stay as they are; a lower minted by the
 * pass is named by its endpoint pair (its id is random on both sides). */
function canonical(model: Model, preexisting: ReadonlySet<string>) {
  const byId = new Map(model.connections.map((c) => [c.id, c]))
  const name = (id: string) => {
    if (preexisting.has(id)) return id
    const c = byId.get(id)
    return c ? `new:${c.fromId}→${c.toId}` : `missing:${id}`
  }
  return {
    diagrams: model.diagrams.map((d) => `${d.id}: ${d.connectionIds.map(name).join(', ')}`),
    connections: model.connections.map((c) => name(c.id)),
  }
}

function storeModel(): Model {
  const s = useModelStore.getState()
  return { objects: s.objects, groups: s.groups, diagrams: s.diagrams, connections: s.connections }
}

function load(model: Model) {
  useModelStore.setState({
    objects: model.objects,
    groups: model.groups,
    diagrams: model.diagrams,
    connections: model.connections,
    domains: [],
    currentDiagramId: model.diagrams[0]?.id ?? null,
    selectedItems: [],
    pendingDeletedConnectionIds: [],
    pendingDeletedObjectIds: [],
  })
}

/** The diagram's lowers and the model's lowers, as sets (sorted ids). */
function lowerSets(s: Model, diagramId: string): string {
  const lowerIds = new Set(s.connections.filter((c) => c.kind === 'lower').map((c) => c.id))
  const d = s.diagrams.find((x) => x.id === diagramId)!
  return `${d.connectionIds.filter((id) => lowerIds.has(id)).sort().join(',')} | ${[...lowerIds].sort().join(',')}`
}

/**
 * Every diagram is a fixed point of a full re-derivation, as SETS: re-deriving
 * any one of them neither adds, nor removes, nor prunes a lower. Membership
 * ORDER is deliberately not compared: a re-derivation lists a diagram's
 * non-lower ids first, so a direct connection appended after an existing lower
 * on a diagram the scope does not reach reads as "re-ordered" — the old full
 * pass re-sorted it, the scoped pass leaves it (lowers are never persisted:
 * bridge flushWrite strips them before any write).
 */
function staleDiagrams(): string[] {
  const stale: string[] = []
  for (const d of useModelStore.getState().diagrams) {
    const before = useModelStore.getState()
    useModelStore.getState().syncLowerConnections(d.id)
    const after = useModelStore.getState()
    if (after.diagrams !== before.diagrams || after.connections !== before.connections) {
      // Undo whatever it committed so later diagrams are judged against the
      // same state.
      useModelStore.setState({ diagrams: before.diagrams, connections: before.connections })
    }
    if (lowerSets(before, d.id) !== lowerSets(after, d.id)) {
      stale.push(d.id)
      if (process.env.LOWER_DEBUG) {
        const desc = (s: typeof before) => {
          const dd = s.diagrams.find((x) => x.id === d.id)!
          const byId = new Map(s.connections.map((c) => [c.id, c]))
          return { objectIds: dd.objectIds, groupIds: dd.groupIds, conns: dd.connectionIds.map((id) => { const c = byId.get(id); return c ? `${id}:${c.kind ?? 'd'}:${c.fromId}->${c.toId}` : `${id}:?` }) }
        }
        console.error(JSON.stringify({ d: d.id, before: desc(before), after: desc(after), refs: before.diagrams.filter((x) => x.id !== d.id).map((x) => `${x.id}:${x.connectionIds.join(',')}`) }))
      }
    }
  }
  return stale
}

beforeEach(() => {
  vi.useFakeTimers()
  __lowerSyncForTest.reset()
  __lowerSyncForTest.setHealEnabled(true)
})
afterEach(() => {
  __lowerSyncForTest.reset()
  __lowerSyncForTest.setHealEnabled(true)
  vi.useRealTimers()
})

describe('ORACLE: the hoisted derivation equals the original per-diagram algorithm', () => {
  it('a full pass over 300 random states, stale lowers and all', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const model = randomModel(r, { staleLowers: true })
      const preexisting = new Set(model.connections.map((c) => c.id))
      // Oracle on a deep copy, in store order, one diagram at a time.
      const expected: Model = structuredClone(model)
      let minted = 0
      for (const d of model.diagrams) oracleSyncLowerConnections(expected, d.id, () => `oracle-${++minted}`)
      load(structuredClone(model))
      useModelStore.getState().syncAllLowerConnections()
      __lowerSyncForTest.drain()
      expect(canonical(storeModel(), preexisting), `seed ${seed}`).toEqual(canonical(expected, preexisting))
    }
  })

  it('a full pass sliced ONE diagram per slice (clock 1000 ms per read), so the context is carried across a commit after every diagram — 200 random states', () => {
    const probe = globalThis as { __lowerSyncProbe?: Array<{ kind: string; derived: number }> }
    let t = 0
    __lowerSyncForTest.setClock(() => (t += 1000))
    try {
      for (let seed = 501; seed <= 700; seed++) {
        const r = rng(seed)
        const model = randomModel(r, { staleLowers: true })
        const preexisting = new Set(model.connections.map((c) => c.id))
        const expected: Model = structuredClone(model)
        let minted = 0
        for (const d of model.diagrams) oracleSyncLowerConnections(expected, d.id, () => `oracle-${++minted}`)
        load(structuredClone(model))
        probe.__lowerSyncProbe = []
        useModelStore.getState().syncAllLowerConnections()
        __lowerSyncForTest.drain()
        const slices = probe.__lowerSyncProbe.filter((e) => e.kind === 'full')
        // One rebuild-only slice, then one diagram per slice.
        expect(slices.length, `seed ${seed}`).toBe(model.diagrams.length + 1)
        expect(slices.every((e) => e.derived <= 1)).toBe(true)
        expect(canonical(storeModel(), preexisting), `seed ${seed}`).toEqual(canonical(expected, preexisting))
      }
    } finally {
      __lowerSyncForTest.setClock(null)
      delete probe.__lowerSyncProbe
    }
  })

  it('the single-diagram action, diagram by diagram, over 300 random states', () => {
    for (let seed = 1001; seed <= 1300; seed++) {
      const r = rng(seed)
      const model = randomModel(r, { staleLowers: true })
      const preexisting = new Set(model.connections.map((c) => c.id))
      const order = model.diagrams.map((d) => d.id).reverse()
      const expected: Model = structuredClone(model)
      let minted = 0
      for (const id of order) oracleSyncLowerConnections(expected, id, () => `oracle-${++minted}`)
      load(structuredClone(model))
      for (const id of order) useModelStore.getState().syncLowerConnections(id)
      expect(canonical(storeModel(), preexisting), `seed ${seed}`).toEqual(canonical(expected, preexisting))
    }
  })
})

type Op = (r: Rng) => void

function randomDirect(r: Rng): Connection | undefined {
  const directs = useModelStore.getState().connections.filter((c) => c.kind !== 'lower')
  return directs.length ? r.pick(directs) : undefined
}
const anyObjectId = (r: Rng) => r.pick(useModelStore.getState().objects).id

const CONNECTION_OPS: Op[] = [
  // connect, on a random active diagram
  (r) => {
    const s = useModelStore.getState()
    useModelStore.setState({ currentDiagramId: r.pick(s.diagrams).id })
    useModelStore.getState().addConnection({ fromId: anyObjectId(r), toId: anyObjectId(r), type: 'solid' })
  },
  // reconnect one side
  (r) => {
    const c = randomDirect(r)
    if (c) useModelStore.getState().updateConnection(c.id, r.next() < 0.5 ? { fromId: anyObjectId(r) } : { toId: anyObjectId(r) })
  },
  // reconnect both sides, through the placement batch
  (r) => {
    const c = randomDirect(r)
    if (c) useModelStore.getState().updatePlacementsBatch({ connections: [{ id: c.id, data: { fromId: anyObjectId(r), toId: anyObjectId(r) } }] })
  },
  // delete a direct connection
  (r) => {
    const c = randomDirect(r)
    if (c) useModelStore.getState().deleteConnection(c.id)
  },
  // delete a LOWER (the user deletes a dashed roll-up)
  (r) => {
    const lowers = useModelStore.getState().connections.filter((c) => c.kind === 'lower')
    if (lowers.length) useModelStore.getState().deleteConnection(r.pick(lowers).id)
  },
]

const NON_DERIVING_OPS: Op[] = [
  // deleteObject re-derives the ACTIVE diagram only
  (r) => {
    const s = useModelStore.getState()
    if (s.objects.length > 4) s.deleteObject(anyObjectId(r))
  },
  // a remote projection reparenting an object (no pass scheduled)
  (r) => {
    const s = useModelStore.getState()
    const target = r.pick(s.objects)
    const parent = r.pick(s.objects)
    // Never a cycle: the app does not create one, and the roll-up's ancestor
    // walk (unchanged from the original) does not guard against one.
    const byId = new Map(s.objects.map((o) => [o.id, o]))
    for (let at: string | undefined = parent.id; at; at = byId.get(at)?.parentId) {
      if (at === target.id) return
    }
    useModelStore.setState({ objects: s.objects.map((o) => (o.id === target.id ? { ...o, parentId: parent.id } : o)) })
  },
  // a remote group membership edit (no pass scheduled)
  (r) => {
    const s = useModelStore.getState()
    if (!s.groups.length) return
    const g = r.pick(s.groups)
    useModelStore.setState({ groups: s.groups.map((x) => (x.id === g.id ? { ...x, objectIds: [...x.objectIds, anyObjectId(r)] } : x)) })
  },
]

function runSequence(seed: number, ops: Op[], heal: boolean, tail: Op[] = []): string[] {
  const r = rng(seed)
  load(randomModel(r, { staleLowers: false }))
  // Start from a consistent state.
  useModelStore.getState().syncAllLowerConnections()
  __lowerSyncForTest.drain()
  __lowerSyncForTest.setHealEnabled(heal)
  for (let burst = 0; burst < 6; burst++) {
    const n = 1 + r.int(3)
    for (let i = 0; i < n; i++) r.pick(ops)(r)
    __lowerSyncForTest.drain()
  }
  for (const op of tail) op(r)
  // The heal follows a SCOPED pass (as the full pass did before it): a burst
  // of non-deriving ops alone schedules nothing, so end on a connect.
  CONNECTION_OPS[0](r)
  __lowerSyncForTest.drain()
  return staleDiagrams()
}

describe('SCOPE: connection mutations leave every diagram a fixed point with the scoped pass alone', () => {
  it('300 random sequences of connect / reconnect / delete bursts (heal OFF)', () => {
    for (let seed = 2001; seed <= 2300; seed++) {
      expect(runSequence(seed, CONNECTION_OPS, false), `seed ${seed}`).toEqual([])
    }
  })
})

describe('HEAL: with the paths that never re-derive, scoped pass + heal leave the same fixed point', () => {
  it('300 random sequences mixing connection mutations, deleteObject, reparent and group edits (heal ON)', () => {
    // The non-deriving ops weighted x3: they are what the heal exists for.
    const ops = [...CONNECTION_OPS, ...NON_DERIVING_OPS, ...NON_DERIVING_OPS, ...NON_DERIVING_OPS]
    // ...and a tail of them just before the final connect, which the scope of
    // that connect will usually not reach.
    const tail = [...NON_DERIVING_OPS, ...NON_DERIVING_OPS]
    let staleWithoutHeal = 0
    for (let seed = 3001; seed <= 3300; seed++) {
      expect(runSequence(seed, ops, true, tail), `seed ${seed}`).toEqual([])
      // ...and STRICTLY, membership order included: after the heal a
      // re-derivation commits nothing at all. (Paint order follows the active
      // diagram's `connectionIds`; the scoped pass leaves an unreached
      // diagram's order as it was, the heal brings it back.)
      for (const d of useModelStore.getState().diagrams) {
        const before = useModelStore.getState().diagrams
        useModelStore.getState().syncLowerConnections(d.id)
        expect(useModelStore.getState().diagrams, `seed ${seed} ${d.id}`).toBe(before)
      }
      // Control: the same sequence without the heal must leave SOMETHING stale
      // in a fair share of cases, or this arm proves nothing about the heal.
      if (runSequence(seed, ops, false, tail).length > 0) staleWithoutHeal++
    }
    console.info(`[lower heal control] ${staleWithoutHeal}/300 sequences stale without the heal`)
    expect(staleWithoutHeal).toBeGreaterThan(30)
  })
})
