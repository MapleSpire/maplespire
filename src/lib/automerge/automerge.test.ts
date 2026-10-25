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

import { describe, it, expect } from 'vitest'
import * as Automerge from '@automerge/automerge'
import { reconcile } from './reconcile'
import {
  rootModelToSlice,
  sliceToRootModel,
  diagramToDiagramDoc,
  diagramDocToDiagram,
  diagramDocComments,
  diagramDocFlows,
  metaToStubDiagram,
  stripDeletedFromComposition,
  splitModel,
  splitIntoShards,
  modelShardsToRootModel,
  mergeObjectShards,
  mergeConnectionShards,
  mergeDecisionRecordShards,
  type ModelSlice,
} from './projection'
import {
  type ModelDoc,
  type DiagramDoc,
  type DiagramMeta,
  type RootModel,
  type ModelMeta,
} from './types'
import type { C4Object, Connection, Group, Diagram, Comment, Flow, DecisionRecord } from '../../types'

// TS 6.0.3 tightened Automerge.from's type parameter to `Record<string, unknown>`.
// Our doc types are structurally fine but have no index signature, so this thin
// wrapper keeps the (type-only) call sites readable.
const fromDoc = <T extends object>(d: T) => Automerge.from(d as T & Record<string, unknown>)

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeObject(id: string, over: Partial<C4Object> = {}): C4Object {
  return {
    id,
    type: 'app',
    name: id,
    position: { x: 0, y: 0 },
    size: { width: 160, height: 100 },
    tagAssignments: {}, tagOrder: [], scope: 'internal',
    status: 'live',
    properties: {},
    ...over,
  }
}

// ── reconcile (pure) ────────────────────────────────────────────────────────

describe('reconcile (pure)', () => {
  it('adds, updates, and deletes object keys to match target', () => {
    const draft: Record<string, unknown> = { a: 1, b: 2, keep: 'x' }
    reconcile(draft, { a: 1, b: 99, c: 3, keep: 'x' })
    expect(draft).toEqual({ a: 1, b: 99, c: 3, keep: 'x' })
  })

  it('treats undefined in target as deletion', () => {
    const draft: Record<string, unknown> = { a: 1, b: 2 }
    reconcile(draft, { a: 1, b: undefined })
    expect(draft).toEqual({ a: 1 })
  })

  it('recurses into nested objects without replacing the parent reference', () => {
    const nested = { x: 1, y: 2 }
    const draft: Record<string, unknown> = { pos: nested }
    reconcile(draft, { pos: { x: 1, y: 5 } })
    expect(draft.pos).toBe(nested) // same reference — minimal, drilled-in edit
    expect(draft.pos).toEqual({ x: 1, y: 5 })
  })

  it('grows, shrinks, and edits arrays in place', () => {
    const grow: unknown[] = [1, 2]
    reconcile(grow, [1, 2, 3, 4])
    expect(grow).toEqual([1, 2, 3, 4])

    const shrink: unknown[] = [1, 2, 3, 4]
    reconcile(shrink, [1, 9])
    expect(shrink).toEqual([1, 9])
  })

  it('reconciles arrays of objects element-wise', () => {
    const draft: unknown[] = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
    reconcile(draft, [{ id: 'a', v: 1 }, { id: 'b', v: 22 }, { id: 'c', v: 3 }])
    expect(draft).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 22 }, { id: 'c', v: 3 }])
  })
})

// ── projection round-trips ────────────────────────────────────────────────────

describe('projection round-trips', () => {
  it('root model ⇄ store slice preserves all entities', () => {
    const slice: ModelSlice = {
      objects: [makeObject('o1'), makeObject('o2', { name: 'Two' })],
      connections: [{ id: 'c1', fromId: 'o1', toId: 'o2', type: 'solid' }],
      groups: [],
      domains: [{ id: 'd1', name: 'Default' }],
      tagSnapshots: [{ tagId: 't1', value: 'tag', color: '#000000', groupId: 'g', groupName: 'Test', catalogRevision: 1 }],
      decisionRecords: [],
    }
    const back = rootModelToSlice(sliceToRootModel(slice))
    // order-independent compare by id
    expect(new Set(back.objects.map((o) => o.id))).toEqual(new Set(['o1', 'o2']))
    expect(back.connections).toEqual(slice.connections)
    expect(back.domains).toEqual(slice.domains)
    expect(back.tagSnapshots).toEqual(slice.tagSnapshots)
  })

  it('Diagram ⇄ DiagramDoc preserves settings, comments and flows', () => {
    const diagram: Diagram = {
      id: 'dg1',
      name: 'Context',
      type: 'context',
      objectIds: ['o1', 'o2'],
      connectionIds: ['c1'],
      groupIds: [],
      layouts: { o1: { position: { x: 10, y: 20 }, size: { width: 160, height: 100 } } },
      lowerRouting: { 'o1→o2': { fromAnchor: 3, lockedToAnchors: true } },
      readonly: false,
    }
    const comments: Comment[] = [
      { id: 'cm1', diagramId: 'dg1', type: 'question', text: 'hi', position: { x: 1, y: 1 }, author: 'me', createdAt: 'now', resolved: false, pinned: false, replies: [] },
    ]
    const flows: Flow[] = [{ id: 'fl1', name: 'Flow', diagramId: 'dg1', steps: [] }]

    const doc = diagramToDiagramDoc(diagram, comments, flows)
    expect(diagramDocToDiagram('dg1', doc)).toEqual(diagram)
    expect(diagramDocComments(doc)).toEqual(comments)
    expect(diagramDocFlows(doc)).toEqual(flows)
    expect(doc.checkpoints).toEqual([])
  })

  it('metaToStubDiagram preserves parentObjectId so drill-down stays discoverable', () => {
    // A level-2 diagram detailing object "sys1". When it is NOT the active diagram
    // it is projected from its registry meta (a stub). getRelatedDiagrams matches
    // it to the system via parentObjectId, so the stub must carry it.
    const meta: DiagramMeta = {
      id: 'dg2',
      name: 'Container view',
      type: 'container',
      docUrl: 'automerge:fake',
      parentObjectId: 'sys1',
      objectIds: ['o1'],
      connectionIds: [],
      groupIds: ['g1'],
    }
    expect(metaToStubDiagram(meta).parentObjectId).toBe('sys1')

    // A top-level diagram has no parent; the key must be absent (not undefined).
    const top = metaToStubDiagram({ ...meta, id: 'dg1', parentObjectId: undefined })
    expect('parentObjectId' in top).toBe(false)
  })
})

// ── registry tombstone cleanup (boot-from-server delete) ───────────────────────
// flushWrite preserves a NON-active diagram's shard meta composition verbatim (so a
// transient stub can't clobber it with empty arrays). Without a strip, a DELETE would
// never reach non-active diagrams' registry: their objectIds/connectionIds would keep a
// dangling id, so after a reload diagram.objectIds.length would exceed the objects that
// actually render. stripDeletedFromComposition is that surgical strip.

describe('stripDeletedFromComposition (registry delete cleanup)', () => {
  it('removes a deleted object id from objectIds, leaving connectionIds + groupIds intact', () => {
    const out = stripDeletedFromComposition(
      { objectIds: ['a', 'gone', 'b'], connectionIds: ['c1'], groupIds: ['g1'] },
      new Set(['gone']),
      new Set()
    )
    expect(out.objectIds).toEqual(['a', 'b'])
    expect(out.connectionIds).toEqual(['c1'])
    expect(out.groupIds).toEqual(['g1'])
  })

  it('removes a deleted connection id from connectionIds independently of objects', () => {
    const out = stripDeletedFromComposition(
      { objectIds: ['a'], connectionIds: ['c1', 'cgone', 'c2'], groupIds: [] },
      new Set(),
      new Set(['cgone'])
    )
    expect(out.objectIds).toEqual(['a'])
    expect(out.connectionIds).toEqual(['c1', 'c2'])
  })

  it('returns the SAME array references when nothing is removed (no-op reconcile)', () => {
    // The common case: a flush with no deletes, or a diagram that never held the deleted
    // id. Returning the same refs keeps flushWrite's reconcile a true no-op so an unrelated
    // edit on one diagram does not churn every other diagram's registry meta.
    const objectIds = ['a', 'b']
    const connectionIds = ['c1']
    const groupIds = ['g1']
    const out = stripDeletedFromComposition(
      { objectIds, connectionIds, groupIds },
      new Set(['not-present']),
      new Set(['also-not-present'])
    )
    expect(out.objectIds).toBe(objectIds)
    expect(out.connectionIds).toBe(connectionIds)
    expect(out.groupIds).toBe(groupIds)
  })

  it('removes a deleted group id from groupIds, which used to be copied through verbatim', () => {
    // If groupIds were returned as-is, a non-active diagram's registry meta
    // would keep pointing at a deleted group across a reload — on the canvas,
    // wrapper chrome and a live "create detail diagram" control anchored to
    // something that no longer exists.
    const out = stripDeletedFromComposition(
      { objectIds: ['a'], connectionIds: ['c1'], groupIds: ['g1', 'ggone', 'g2'] },
      new Set(),
      new Set(),
      new Set(['ggone'])
    )
    expect(out.groupIds).toEqual(['g1', 'g2'])
    expect(out.objectIds).toEqual(['a'])
    expect(out.connectionIds).toEqual(['c1'])
  })

  it('leaves groupIds alone when no group set is supplied at all', () => {
    // The parameter is optional so every existing caller keeps its behaviour;
    // a caller that has no group intents must not start stripping.
    const groupIds = ['g1', 'g2']
    const out = stripDeletedFromComposition(
      { objectIds: [], connectionIds: [], groupIds },
      new Set(['a']),
      new Set(),
    )
    expect(out.groupIds).toBe(groupIds)
  })

  it('does not mutate the input arrays when it strips', () => {
    const objectIds = ['a', 'gone', 'b']
    stripDeletedFromComposition({ objectIds, connectionIds: [], groupIds: [] }, new Set(['gone']), new Set())
    expect(objectIds).toEqual(['a', 'gone', 'b']) // original untouched
  })

  it('cleans the deleted member out of EVERY diagram registry that contained it (delete + reload)', () => {
    // Two diagrams share object "shared"; deleting it must drop it from BOTH registries —
    // the active one (store-authoritative) AND the non-active one (preserved meta), so a
    // reload that re-reads the registry never lists the dangling id again. Here we model the
    // non-active path: flushWrite runs stripDeletedFromComposition over each shard meta.
    const registry: Record<string, DiagramMeta> = {
      ctx: { id: 'ctx', name: 'Context', type: 'context', docUrl: 'automerge:a', objectIds: ['sys', 'actor', 'shared'], connectionIds: ['e1'], groupIds: [] },
      land: { id: 'land', name: 'Landscape', type: 'context', docUrl: 'automerge:b', objectIds: ['shared', 'other'], connectionIds: ['e2', 'edel'], groupIds: ['g'] },
      unrelated: { id: 'unrelated', name: 'Unrelated', type: 'container', docUrl: 'automerge:c', objectIds: ['x', 'y'], connectionIds: ['e3'], groupIds: [] },
    }
    const deletedObjects = new Set(['shared'])
    const deletedConnections = new Set(['edel'])

    // What flushWrite writes back into each non-active diagram's shard meta.
    const cleaned: Record<string, DiagramMeta> = {}
    for (const [id, meta] of Object.entries(registry)) {
      const comp = stripDeletedFromComposition(
        { objectIds: meta.objectIds, connectionIds: meta.connectionIds, groupIds: meta.groupIds },
        deletedObjects,
        deletedConnections
      )
      cleaned[id] = { ...meta, ...comp }
    }

    // The deleted id is gone from EVERY diagram's registry.
    for (const meta of Object.values(cleaned)) {
      expect(meta.objectIds).not.toContain('shared')
      expect(meta.connectionIds).not.toContain('edel')
    }
    // Surviving members are preserved exactly (no over-deletion).
    expect(cleaned.ctx.objectIds).toEqual(['sys', 'actor'])
    expect(cleaned.land.objectIds).toEqual(['other'])
    expect(cleaned.land.connectionIds).toEqual(['e2'])
    expect(cleaned.land.groupIds).toEqual(['g'])
    expect(cleaned.unrelated).toEqual(registry.unrelated) // untouched diagram is identical

    // The invariant the strict e2e assertion checks: a diagram's registry objectIds count
    // now equals the objects a render (which excludes the deleted id) would draw.
    const renderedAfterDelete = ['sys', 'actor'] // ctx render with "shared" excluded
    expect(cleaned.ctx.objectIds.length).toBe(renderedAfterDelete.length)
  })
})

// ── Sharded model projection ──────────────────────────────────────────────────

describe('sharded model projection (Slice 3)', () => {
  function bigModel(nObjects: number, nConnections: number): RootModel {
    const objects: Record<string, C4Object> = {}
    for (let i = 0; i < nObjects; i++) objects['o' + i] = makeObject('o' + i, { name: 'Obj ' + i })
    const connections: Record<string, Connection> = {}
    const mod = Math.max(1, nObjects)
    for (let i = 0; i < nConnections; i++) {
      connections['c' + i] = { id: 'c' + i, fromId: 'o' + (i % mod), toId: 'o' + ((i + 1) % mod), type: 'solid' }
    }
    const group: Group = { id: 'g1', name: 'G', color: '#fff', objectIds: ['o0'], tagAssignments: {}, tagOrder: [] }
    return {
      objects,
      connections,
      groups: { g1: group },
      domains: { d1: { id: 'd1', name: 'Default' } },
      tagSnapshots: { t1: { tagId: 't1', value: 'tag', color: '#000000', groupId: 'g', groupName: 'Test', catalogRevision: 1 } },
      decisionRecords: {},
    }
  }

  const metaFrom = (split: ReturnType<typeof splitModel>): ModelMeta => ({
    ...split.meta,
    objectShardUrls: [],
    connectionShardUrls: [],
  })

  it('splitModel → modelShardsToRootModel round-trips a model exactly', () => {
    const model = bigModel(57, 23)
    const split = splitModel(model, 10)
    const back = modelShardsToRootModel(metaFrom(split), split.objectShards, split.connectionShards)
    expect(back).toEqual(model)
  })

  it('fills each shard to shardSize with no dupes or drops; count = ceil(n/size)', () => {
    const split = splitModel(bigModel(57, 0), 10)
    expect(split.objectShards.length).toBe(6) // ceil(57/10)
    for (let i = 0; i < 5; i++) expect(Object.keys(split.objectShards[i].objects).length).toBe(10)
    expect(Object.keys(split.objectShards[5].objects).length).toBe(7)
    const all = split.objectShards.flatMap((s) => Object.keys(s.objects))
    expect(all.length).toBe(57)
    expect(new Set(all).size).toBe(57)
  })

  it('keeps the small collections inline on the meta (objects/connections only are sharded)', () => {
    const split = splitModel(bigModel(5, 5), 2)
    expect(split.meta.groups.g1).toBeDefined()
    expect(split.meta.domains.d1).toBeDefined()
    expect(split.meta.tagSnapshots.t1).toBeDefined()
    expect('objects' in split.meta).toBe(false)
    expect('connections' in split.meta).toBe(false)
  })

  it('an empty model yields one empty object shard + one empty connection shard, and round-trips', () => {
    const empty: RootModel = { objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }
    const split = splitModel(empty, 512)
    expect(split.objectShards).toEqual([{ objects: {} }])
    expect(split.connectionShards).toEqual([{ connections: {} }])
    expect(modelShardsToRootModel(metaFrom(split), split.objectShards, split.connectionShards)).toEqual(empty)
  })

  it('mergeObjectShards / mergeConnectionShards union every shard', () => {
    expect(
      mergeObjectShards([{ objects: { a: makeObject('a') } }, { objects: { b: makeObject('b') } }])
    ).toEqual({ a: makeObject('a'), b: makeObject('b') })
    const c: Connection = { id: 'c', fromId: 'a', toId: 'b', type: 'solid' }
    expect(mergeConnectionShards([{ connections: {} }, { connections: { c } }])).toEqual({ c })
  })

  it('merges ADR shards with inline overlays and tombstones', () => {
    const baseline = { id: 'adr-1', title: 'Baseline' } as DecisionRecord
    const removed = { id: 'adr-2', title: 'Removed' } as DecisionRecord
    const edited = { id: 'adr-1', title: 'Edited' } as DecisionRecord
    expect(mergeDecisionRecordShards([
      { decisionRecords: { 'adr-1': baseline } },
      { decisionRecords: { 'adr-2': removed } },
    ])).toEqual({ 'adr-1': baseline, 'adr-2': removed })
    const model = modelShardsToRootModel({
      ...metaFrom(splitModel(bigModel(1, 0), 1)),
      decisionRecordShardUrls: ['one', 'two'],
      decisionRecords: { 'adr-1': edited },
      deletedDecisionRecordIds: ['adr-2'],
    }, [], [], [
      { decisionRecords: { 'adr-1': baseline } },
      { decisionRecords: { 'adr-2': removed } },
    ])
    expect(model.decisionRecords).toEqual({ 'adr-1': edited })
  })

  it('splitIntoShards rejects a non-positive / non-integer shardSize', () => {
    expect(() => splitIntoShards({ a: 1 }, 0)).toThrow()
    expect(() => splitIntoShards({ a: 1 }, -3)).toThrow()
    expect(() => splitIntoShards({ a: 1 }, 1.5)).toThrow()
  })

  it('round-trips at scale and stays independent of N (5000 objects / 4000 connections)', () => {
    const model = bigModel(5000, 4000)
    const split = splitModel(model, 512)
    expect(split.objectShards.length).toBe(Math.ceil(5000 / 512))
    expect(split.connectionShards.length).toBe(Math.ceil(4000 / 512))
    const back = modelShardsToRootModel(metaFrom(split), split.objectShards, split.connectionShards)
    expect(Object.keys(back.objects).length).toBe(5000)
    expect(Object.keys(back.connections).length).toBe(4000)
    expect(back).toEqual(model)
  })
})

// ── Automerge merge semantics (the headline: field-level merge) ───────────────

function modelWith(objects: C4Object[]): ModelDoc {
  const doc: ModelDoc = { objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} }
  for (const o of objects) doc.objects[o.id] = o
  return doc
}

describe('Automerge field-level merge via reconcile', () => {
  it('concurrent edits to DIFFERENT fields of the same entity both survive', () => {
    const base = fromDoc(modelWith([makeObject('x', { name: 'X', description: 'orig' })]))

    // Two clients diverge from the same base.
    let a = Automerge.clone(base)
    let b = Automerge.clone(base)

    // A edits description; B (concurrently) moves the shape. Each uses reconcile,
    // mirroring how the bridge writes a changed entity into the doc.
    a = Automerge.change(a, (d) => {
      reconcile(d.objects.x, makeObject('x', { name: 'X', description: 'A-edited' }))
    })
    b = Automerge.change(b, (d) => {
      reconcile(d.objects.x, makeObject('x', { name: 'X', description: 'orig', position: { x: 500, y: 300 } }))
    })

    const merged = Automerge.merge(a, b)
    // Neither edit may clobber the other: both survive.
    expect(merged.objects.x.description).toBe('A-edited')
    expect(merged.objects.x.position).toEqual({ x: 500, y: 300 })
  })

  it('concurrent ADDs of different entities both land (id-keyed map merge)', () => {
    const base = fromDoc(modelWith([makeObject('x')]))
    let a = Automerge.clone(base)
    let b = Automerge.clone(base)

    a = Automerge.change(a, (d) => reconcile(d.objects, sliceMap([makeObject('x'), makeObject('y')])))
    b = Automerge.change(b, (d) => reconcile(d.objects, sliceMap([makeObject('x'), makeObject('z')])))

    const merged = Automerge.merge(a, b)
    expect(Object.keys(merged.objects).sort()).toEqual(['x', 'y', 'z'])
  })

  it('a deletion propagates through merge when the peer did not touch it', () => {
    const base = fromDoc(modelWith([makeObject('x'), makeObject('y')]))
    let a = Automerge.clone(base)
    const b = Automerge.clone(base)

    // A removes y by reconciling the map to one without it.
    a = Automerge.change(a, (d) => reconcile(d.objects, sliceMap([makeObject('x')])))

    const merged = Automerge.merge(a, b)
    expect(Object.keys(merged.objects)).toEqual(['x'])
  })

  it('reconciling to an identical value records no change (minimal ops)', () => {
    const doc = fromDoc(modelWith([makeObject('x', { description: 'same' })]))
    const next = Automerge.change(doc, (d) => {
      reconcile(d.objects.x, makeObject('x', { description: 'same' }))
    })
    // No-op change: content identical, heads unchanged.
    expect(Automerge.getHeads(next)).toEqual(Automerge.getHeads(doc))
  })
})

// ── reconcile against REAL Automerge drafts (proxy edge cases) ────────────────

describe('reconcile on real Automerge drafts', () => {
  it('round-trips a full DiagramDoc (optional fields + maps) through Automerge', () => {
    const diagram: Diagram = {
      id: 'dg1',
      name: 'Context',
      type: 'context',
      objectIds: ['o1'],
      connectionIds: [],
      groupIds: [],
      layouts: { o1: { position: { x: 5, y: 6 }, size: { width: 160, height: 100 } } },
      lowerRouting: { 'o1→o2': { waypoints: [{ x: 1, y: 2 }], shape: 'straight', lockedToAnchors3d: false } },
      readonly: true,
      skinId: 'skin-x',
      defaultConnectionShape: 'straight',
      sceneDecor: { packId: 'maquette-people', density: 'rich', seed: 42 },
    }
    const doc = diagramToDiagramDoc(diagram, [], [])
    const am = fromDoc(doc)
    // Materialised Automerge doc reads back to the exact same Diagram.
    expect(diagramDocToDiagram('dg1', am)).toEqual(diagram)
  })

  it('reconciles a Connection waypoints array (grow / edit / shrink) on a list proxy', () => {
    const conn = (waypoints: { x: number; y: number }[]): Connection => ({
      id: 'c1', fromId: 'a', toId: 'b', type: 'solid', waypoints,
    })
    let doc = fromDoc<ModelDoc>({ objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {} })
    doc = Automerge.change(doc, (d) => reconcile(d.connections, { c1: conn([{ x: 1, y: 1 }, { x: 2, y: 2 }]) }))
    expect(doc.connections.c1.waypoints).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }])

    // edit one point + append another (array-of-objects through the proxy)
    doc = Automerge.change(doc, (d) => reconcile(d.connections.c1, conn([{ x: 1, y: 9 }, { x: 2, y: 2 }, { x: 3, y: 3 }])))
    expect(doc.connections.c1.waypoints).toEqual([{ x: 1, y: 9 }, { x: 2, y: 2 }, { x: 3, y: 3 }])

    // shrink
    doc = Automerge.change(doc, (d) => reconcile(d.connections.c1, conn([{ x: 1, y: 9 }])))
    expect(doc.connections.c1.waypoints).toEqual([{ x: 1, y: 9 }])
  })

  it('concurrent delete-vs-edit of the same entity converges (commutative merge)', () => {
    const base = fromDoc(modelWith([makeObject('x', { description: 'orig' })]))
    const a = Automerge.change(Automerge.clone(base), (d) => {
      delete d.objects.x
    })
    const b = Automerge.change(Automerge.clone(base), (d) => {
      reconcile(d.objects.x, makeObject('x', { description: 'b-edit' }))
    })
    // Automerge merges commutatively — both orders must converge to the same keys.
    const ab = Automerge.merge(Automerge.clone(a), b)
    const ba = Automerge.merge(Automerge.clone(b), a)
    expect(Object.keys(ab.objects)).toEqual(Object.keys(ba.objects))
  })
})

// helper: array of entities -> id-keyed map (as a plain target for reconcile)
function sliceMap(objects: C4Object[]): Record<string, C4Object> {
  const out: Record<string, C4Object> = {}
  for (const o of objects) out[o.id] = o
  return out
}

// keep a reference so the DiagramDoc type import is exercised
export type _Doc = DiagramDoc

// ── ADR related-links: merge by id, not by index ──────────────────────────────
/**
 * `reconcileArray` walks BY INDEX, so removing an element shifts every later one
 * and each peer writes DIFFERENT entities into the same slots. For an identified
 * list that is data loss, and not a rare race: over 5 links and every pair of
 * remove-sets, most index-walk merges resurrect a deleted link.
 *
 * "Remove a middle link on A, add one on B" merges cleanly even with the index
 * walk, so it would not catch the defect; the reachable failure is two users
 * removing a DIFFERENT link each.
 */
describe('ADRLink related[] merges by link id', () => {
  interface Link { id: string; type: string; label: string; targetId: string }
  interface RecordDoc { [k: string]: unknown; rec: { id: string; related: Link[] } }
  const L = (n: string): Link => ({ id: n, type: 'diagram', label: `label-${n}`, targetId: `t-${n}` })
  const recDoc = (links: Link[]) =>
    Automerge.from<RecordDoc>({ rec: { id: 'A1', related: links.map((l) => ({ ...l })) } })
  /** How the app saves: the whole array, through reconcile, inside one change. */
  const save = (doc: Automerge.Doc<RecordDoc>, related: Link[], actor: string) =>
    Automerge.change(Automerge.clone(doc, { actor }), (d) => reconcile(d.rec, { id: 'A1', related }))
  const idsOf = (d: Automerge.Doc<RecordDoc>) => d.rec.related.map((l) => l.id)

  it('two users removing a DIFFERENT link no longer resurrect one of them', () => {
    // An index-walk merge yields ['L2','L3']: L2 comes back.
    const base = recDoc([L('L1'), L('L2'), L('L3')])
    const a = save(base, [L('L1'), L('L3')], 'aaaaaa')
    const b = save(base, [L('L2'), L('L3')], 'bbbbbb')

    expect(idsOf(Automerge.merge(Automerge.clone(a), b))).toEqual(['L3'])
    // Commutative, or the fix would only hold for one of the two peers.
    expect(idsOf(Automerge.merge(Automerge.clone(b), a))).toEqual(['L3'])
  })

  it('holds when one peer coalesces two removals into a single save', () => {
    // The 150ms write debounce turns two quick clicks into one change.
    const base = recDoc([L('L1'), L('L2'), L('L3'), L('L4'), L('L5')])
    const a = save(base, [L('L2'), L('L3'), L('L4'), L('L5')], 'aaaaaa')
    const b = save(base, [L('L3'), L('L4'), L('L5')], 'bbbbbb')

    expect(idsOf(Automerge.merge(Automerge.clone(a), b))).toEqual(['L3', 'L4', 'L5'])
  })

  it('never leaves a link carrying another link fields', () => {
    // The invariant, asserted rather than a literal array: whatever survives, its
    // fields must be its OWN. A spliced merge is the failure this guards.
    const base = recDoc([L('L1'), L('L2'), L('L3'), L('L4')])
    const a = save(base, [L('L1'), L('L4')], 'aaaaaa')
    const b = save(base, [L('L2'), L('L3'), L('L4')], 'bbbbbb')

    for (const link of Automerge.merge(Automerge.clone(a), b).rec.related) {
      expect(link).toEqual(L(link.id))
    }
  })

  it('still merges concurrent ADDs from both peers', () => {
    const base = recDoc([L('L1')])
    const a = save(base, [L('L1'), L('L2')], 'aaaaaa')
    const b = save(base, [L('L1'), L('L3')], 'bbbbbb')

    expect(idsOf(Automerge.merge(Automerge.clone(a), b)).sort()).toEqual(['L1', 'L2', 'L3'])
  })

  it('removes and appends in one save without writing past the list end', () => {
    // On an Automerge list a stale append index throws rather than writing a
    // hole, so this is the loud version of the plain-array test above.
    const base = recDoc([L('L1'), L('L2')])
    const saved = save(base, [L('L2'), L('L3'), L('L4')], 'aaaaaa')
    expect(idsOf(saved)).toEqual(['L2', 'L3', 'L4'])
  })

  it('applies an edit to a surviving link while another is removed', () => {
    const base = recDoc([L('L1'), L('L2')])
    const a = save(base, [L('L1')], 'aaaaaa')
    const b = save(base, [{ ...L('L1'), label: 'renamed' }, L('L2')], 'bbbbbb')

    const merged = Automerge.merge(Automerge.clone(a), b)
    expect(idsOf(merged)).toEqual(['L1'])
    expect(merged.rec.related[0].label).toBe('renamed')
  })
})

/**
 * The scope guard. The by-id merge is keyed on the ARRAY'S NAME — a path suffix,
 * not the elements' shape — because four other arrays in the model carry `id`
 * elements and must keep index semantics. `Flow.steps` in particular has the only
 * real reorder writer, and keying by id would not make a reorder safe anyway:
 * Automerge has no move op, so a move is delete+insert and a concurrent delete of
 * a moved step is simply lost. That is a product decision, not a mechanical fix.
 */
describe('by-id array merge is scoped by key name, not by element shape', () => {
  const item = (id: string, label: string) => ({ id, label })

  it('keys related by id: removing the middle does not rewrite the tail in place', () => {
    const draft = [item('a', 'A'), item('b', 'B'), item('c', 'C')]
    const kept = draft[2]
    reconcile({ related: draft }, { related: [item('a', 'A'), item('c', 'C')] })
    expect(draft.map((x) => x.id)).toEqual(['a', 'c'])
    expect(draft[1]).toBe(kept) // the survivor was moved, not overwritten
  })

  it('leaves an identically-shaped array under a DIFFERENT key on the index walk', () => {
    // `steps` has id-bearing elements too. If this starts behaving like `related`,
    // the special case has leaked by shape.
    const draft = [item('a', 'A'), item('b', 'B'), item('c', 'C')]
    const wasSecond = draft[1]
    reconcile({ steps: draft }, { steps: [item('a', 'A'), item('c', 'C')] })
    expect(draft.map((x) => x.id)).toEqual(['a', 'c'])
    expect(draft[1]).toBe(wasSecond) // slot 1 was OVERWRITTEN in place — index semantics
  })

  it('falls back to the index walk when any link has no usable id', () => {
    // `related` arrives unvalidated from the paged read model, so an id-less link
    // is representable. Keying would bucket EVERY id-less link under one key and
    // silently drop all but one — strictly worse than the bug being fixed. Two of
    // them is what makes that observable: keyed, nothing here would be removed.
    const draft: Array<{ id?: string; label: string }> = [{ label: 'x' }, { label: 'y' }]
    reconcile({ related: draft }, { related: [{ label: 'y' }] })
    expect(draft).toEqual([{ label: 'y' }])
  })

  it('falls back to the index walk on duplicate ids', () => {
    // Same ids in the same order on both sides, so the reorder guard is happy —
    // only the uniqueness check stands between this and a lookup that resolves
    // both 'a' entries to the LAST one, leaving the first holding stale fields.
    const draft = [item('a', 'A'), item('b', 'B'), item('a', 'A2')]
    reconcile({ related: draft }, { related: [item('a', 'X'), item('b', 'B'), item('a', 'Y')] })
    expect(draft).toEqual([item('a', 'X'), item('b', 'B'), item('a', 'Y')])
  })

  it('appends several new links after a removal, recomputing the slot each time', () => {
    // The append slot must be read from the LIVE length inside the loop. This
    // pass splices and inserts, so a slot computed once from the target length
    // is already stale by the second append — on a plain array that writes a
    // hole, and on an Automerge list it throws ("index N is out of bounds").
    const draft = [item('a', 'A'), item('b', 'B')]
    reconcile({ related: draft }, { related: [item('b', 'B'), item('c', 'C'), item('d', 'D')] })
    expect(draft).toEqual([item('b', 'B'), item('c', 'C'), item('d', 'D')])
  })

  it('falls back to the index walk on a genuine reorder, which by-id cannot express', () => {
    const draft = [item('a', 'A'), item('b', 'B')]
    reconcile({ related: draft }, { related: [item('b', 'B'), item('a', 'A')] })
    expect(draft.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('does not key a nested array just because its parent was keyed', () => {
    // Inside reconcileArray the key is a numeric index, never a name.
    const draft = [{ id: 'a', related: [item('x', 'X'), item('y', 'Y')] }]
    reconcile({ related: draft }, { related: [{ id: 'a', related: [item('x', 'X'), item('y', 'Y2')] }] })
    expect(draft[0].related[1].label).toBe('Y2')
  })
})
