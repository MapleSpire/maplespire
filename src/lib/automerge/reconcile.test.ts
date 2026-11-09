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

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, describe, it, expect, vi } from 'vitest'
import * as A from '@automerge/automerge'
import { NetworkAdapter, Repo, type DocHandle, type PeerId } from '@automerge/automerge-repo'
import {
  EXACT,
  applyCollectionReconcile,
  listOf,
  mapOf,
  planCollectionReconcile,
  reconcile,
  reconcileIsNoop,
  reconcileKey,
  structOf,
  type ReconcileSchema,
} from './reconcile'
import {
  COLLECTION_SCHEMAS,
  C4_OBJECT_SCHEMA,
  DIAGRAM_DOC_SCHEMA,
  ENTITY_SCHEMAS,
  type EntityCollection,
} from './knownKeys'
import { diagramToDiagramDoc } from './projection'
import type { DiagramDoc } from './types'
import type { C4Object, Comment, Diagram, Flow } from '../../types'

/**
 * V0-08 — reconcile preserves fields it does not know (N-1 compatibility).
 *
 * Before: `reconcileObject` deleted every key absent from the target, so a
 * client one schema version behind wiped every newer field of any entity it
 * edited. The first test below was written FIRST and ran RED against that
 * code (the draft came back as `{ name: 'new' }`).
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('reconcile — N-1 compatibility (V0-08)', () => {
  it('keeps the fields a v1 schema does not know when a v1 target lacks them', () => {
    const draft: Record<string, unknown> = { name: 'old', fragment: 'f-1', diagramId: 'd-1' }
    // What a v1 client knows about this collection's entities: `name` only.
    const v1 = { kind: 'struct', fields: { name: { kind: 'exact' } } } as const satisfies ReconcileSchema
    reconcile(draft, { name: 'new' }, v1)
    expect(draft).toEqual({ name: 'new', fragment: 'f-1', diagramId: 'd-1' })
  })

  it('still deletes a KNOWN field the target lacks, and any field the target holds as undefined', () => {
    const v1 = structOf<{ name: string; note?: string }>({ name: EXACT, note: EXACT })
    const draft: Record<string, unknown> = { name: 'a', note: 'n', fragment: 'f', extra: 'e' }
    reconcile(draft, { name: 'a', extra: undefined }, v1)
    expect(draft).toEqual({ name: 'a', fragment: 'f' })
  })

  it('EXACT keeps the pre-V0-08 semantics: every absent key is deleted', () => {
    const draft: Record<string, unknown> = { name: 'a', fragment: 'f' }
    reconcile(draft, { name: 'a' }, EXACT)
    expect(draft).toEqual({ name: 'a' })
  })

  it('a map deletes an absent KEY but keeps the unknown fields of the entities it keeps', () => {
    const coll: Record<string, any> = {
      a: { id: 'a', name: 'A', v2: 'keep' },
      b: { id: 'b', name: 'B' },
    }
    reconcile(coll, { a: { id: 'a', name: 'A2' } }, mapOf(structOf<{ id: string; name: string }>({ id: EXACT, name: EXACT })))
    expect(coll).toEqual({ a: { id: 'a', name: 'A2', v2: 'keep' } })
  })

  it('an undeclared field named like an Object.prototype member is still unknown', () => {
    const draft: Record<string, unknown> = { name: 'a', constructor: 'v2', toString: 'v2' }
    reconcile(draft, { name: 'b' }, structOf<{ name: string }>({ name: EXACT }))
    expect(draft).toEqual({ name: 'b', constructor: 'v2', toString: 'v2' })
  })

  it('a prototype-named key the target lacks IS deleted where it is known (EXACT, a map id)', () => {
    const draft: Record<string, unknown> = { name: 'a', constructor: 'old' }
    reconcile(draft, { name: 'a' }, EXACT)
    expect(draft).toEqual({ name: 'a' })
    expect(reconcileIsNoop({ constructor: 'old' }, {}, EXACT)).toBe(false)
    expect(planCollectionReconcile({ constructor: { id: 'constructor' } }, {}, mapOf(EXACT))).toEqual({ update: [], remove: ['constructor'] })
  })

  it('the planner honours a STRUCT schema too: an unknown field is no removal', () => {
    const doc = structOf<{ name: string; note?: string }>({ name: EXACT, note: EXACT })
    expect(planCollectionReconcile({ name: 'a', v2: 'k' }, { name: 'a' }, doc)).toBeNull()
    expect(planCollectionReconcile({ name: 'a', note: 'n', v2: 'k' }, { name: 'a' }, doc)).toEqual({ update: [], remove: ['note'] })
  })

  it('a field present in the target but undeclared is reconciled EXACT below it', () => {
    const draft: Record<string, any> = { name: 'a', v2: { p: 1, q: 2 } }
    reconcile(draft, { name: 'a', v2: { p: 1 } }, structOf<{ name: string }>({ name: EXACT }))
    expect(draft).toEqual({ name: 'a', v2: { p: 1 } })
  })
})

describe('reconcile — lists keep an element\'s unknown fields only for the same entity', () => {
  const step = structOf<{ id: string; title: string }>({ id: EXACT, title: EXACT })
  const schema = structOf<{ steps: { id: string; title: string }[] }>({ steps: listOf(step) })

  it('same id at the same index: the unknown field stays', () => {
    const draft: any = { steps: [{ id: 's1', title: 'T', v2: 'k' }] }
    reconcile(draft, { steps: [{ id: 's1', title: 'T2' }] }, schema)
    expect(draft.steps).toEqual([{ id: 's1', title: 'T2', v2: 'k' }])
  })

  it('a different entity written into the slot does NOT inherit the old element\'s unknown field', () => {
    const draft: any = { steps: [{ id: 's1', title: 'A', v2: 'belongs-to-s1' }, { id: 's2', title: 'B' }] }
    // s1 removed: the index walk writes s2 into slot 0.
    reconcile(draft, { steps: [{ id: 's2', title: 'B' }] }, schema)
    expect(draft.steps).toEqual([{ id: 's2', title: 'B' }])
  })

  it('id-less elements keep their unknown fields only when the list length is unchanged (an in-place edit)', () => {
    const conn: any = { waypoints: [{ x: 1, y: 2, curve: 0.5 }] }
    reconcile(conn, { waypoints: [{ x: 3, y: 2 }] }, ENTITY_SCHEMAS.connections)
    expect(conn.waypoints).toEqual([{ x: 3, y: 2, curve: 0.5 }])
  })

  it('an id-less element removed by an N-1 splice does NOT hand its unknown field to the next one', () => {
    // [w0{curve}, w1] → the N-1 client deletes w0 → target [w1]. The index walk
    // writes w1 into slot 0; keeping `curve` there would attach w0's field to w1.
    const conn: any = { waypoints: [{ x: 0, y: 0, curve: 0.5 }, { x: 9, y: 9 }] }
    reconcile(conn, { waypoints: [{ x: 9, y: 9 }] }, ENTITY_SCHEMAS.connections)
    expect(conn.waypoints).toEqual([{ x: 9, y: 9 }])
    const obj: any = { links: [{ url: 'a', iconV2: 'A' }, { url: 'b' }, { url: 'c' }] }
    reconcile(obj, { links: [{ url: 'b' }, { url: 'c' }] }, ENTITY_SCHEMAS.objects)
    expect(obj.links).toEqual([{ url: 'b' }, { url: 'c' }])
    // An insertion shifts the other way: the old element's field must not move onto the new one.
    const routed: any = { w: [{ x: 1, y: 1, curve: 1 }] }
    reconcile(routed, { w: [{ x: 5, y: 5 }, { x: 1, y: 1 }] }, structOf<{ w: { x: number; y: number }[] }>({ w: listOf(structOf<{ x: number; y: number }>({ x: EXACT, y: EXACT })) }))
    expect(routed.w).toEqual([{ x: 5, y: 5 }, { x: 1, y: 1 }])
  })

  it('the by-id `related` merge keeps a link\'s unknown field', () => {
    const rec: any = { related: [{ id: 'l1', type: 'url', label: 'a', v2: 'k' }, { id: 'l2', type: 'url', label: 'b' }] }
    reconcile(rec, { related: [{ id: 'l2', type: 'url', label: 'b2' }, { id: 'l1', type: 'url', label: 'a' }].reverse() }, ENTITY_SCHEMAS.decisionRecords)
    expect(rec.related).toEqual([{ id: 'l1', type: 'url', label: 'a', v2: 'k' }, { id: 'l2', type: 'url', label: 'b2' }])
  })
})

// ── every collection ─────────────────────────────────────────────────────────

/** A v2 entity per collection: a realistic N entity plus a top-level v2 field
 * and a v2 field inside a nested struct, and the path of that nested field. */
const fixtures: Record<EntityCollection, { entity: Record<string, any>; nested: (e: any) => unknown; edit: string }> = {
  objects: {
    entity: {
      id: 'o1', type: 'app', name: 'O', position: { x: 1, y: 2, z: 9 }, size: { width: 1, height: 1 },
      tagAssignments: { t: { tagId: 't', weight: 3 } }, tagOrder: ['t'], scope: 'internal', status: 'live', properties: {},
      technologyUsages: { u: { id: 'u', technologyId: 'pg', catalogRevision: 1, snapshot: { schemaVersion: 1, name: 'PG', v2: 'k' } } },
      v2Field: 'k',
    },
    nested: (e) => [e.position.z, e.tagAssignments.t.weight, e.technologyUsages.u.snapshot.v2],
    edit: 'name',
  },
  connections: {
    entity: { id: 'c1', fromId: 'a', toId: 'b', type: 'solid', waypoints: [{ x: 0, y: 0, curve: 1 }], ownerAssignments: { p: { id: 'p', kind: 'team', source: 'platform', name: 'T', members: [{ id: 'm', name: 'M', v2: 'k' }] } }, v2Field: 'k' },
    nested: (e) => [e.waypoints[0].curve, e.ownerAssignments.p.members[0].v2],
    edit: 'label',
  },
  groups: {
    entity: { id: 'g1', name: 'G', color: '#fff', objectIds: [], tagAssignments: {}, tagOrder: [], iconAssignment: { source: 'generic', mode: 'explicit', displayName: 'x', v2: 'k' }, v2Field: 'k' },
    nested: (e) => [e.iconAssignment.v2],
    edit: 'name',
  },
  domains: { entity: { id: 'd1', name: 'D', v2Field: 'k' }, nested: () => [], edit: 'name' },
  tagSnapshots: {
    entity: { tagId: 't1', value: 'v', color: '#000', groupId: 'g', groupName: 'G', catalogRevision: 1, v2Field: 'k' },
    nested: () => [],
    edit: 'value',
  },
  decisionRecords: {
    entity: {
      id: 'r1', number: 1, title: 'T', summary: '', status: 'approved', author: 'a', createdAt: 'c', updatedAt: 'u', content: '',
      related: [{ id: 'l1', type: 'url', label: 'L', v2: 'k' }], history: [{ status: 'approved', date: 'd', by: 'k' }], v2Field: 'k',
    },
    nested: (e) => [e.related[0].v2, e.history[0].by],
    edit: 'title',
  },
  comments: {
    entity: {
      id: 'k1', diagramId: 'dg', type: 'idea', text: 't', position: { x: 0, y: 0, z: 1 }, author: 'a', createdAt: 'c',
      resolved: false, pinned: false, replies: [{ id: 'r', text: 'r', author: 'a', createdAt: 'c', reaction: 'k' }], v2Field: 'k',
    },
    nested: (e) => [e.position.z, e.replies[0].reaction],
    edit: 'text',
  },
  flows: {
    entity: { id: 'f1', name: 'F', diagramId: 'dg', fragment: 'k', steps: [{ id: 's', order: 0, type: 'process', title: 'S', objectId: 'o', v2: 'k' }] },
    nested: (e) => [e.steps[0].v2],
    edit: 'name',
  },
  diagrams: {
    entity: { id: 'dg', name: 'D', type: 'context', docUrl: 'automerge:x', objectIds: [], connectionIds: [], groupIds: [], thumbnail: 'k' },
    nested: () => [],
    edit: 'name',
  },
}

/** What an N-1 client's target looks like: the entity with every field it
 * does not know (anything named v2*, `fragment`, `thumbnail`, `z`, `curve`,
 * `weight`, `by`, `reaction`) stripped, at any depth. */
const V2_NAMES = new Set(['v2', 'v2Field', 'fragment', 'thumbnail', 'z', 'curve', 'weight', 'by', 'reaction'])
function asN1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asN1)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (!V2_NAMES.has(k)) out[k] = asN1(v)
    return out
  }
  return value
}

describe.each(Object.keys(fixtures) as EntityCollection[])('collection %s', (collection) => {
  const { entity, nested, edit } = fixtures[collection]
  const schema = ENTITY_SCHEMAS[collection]
  const key = (entity.id ?? entity.tagId) as string

  it('an N-1 edit keeps every v2 field, top-level and nested (plain draft)', () => {
    const draft = clone(entity)
    const target = { ...(asN1(entity) as Record<string, unknown>), [edit]: 'edited-by-n-1' }
    reconcile(draft, target, schema)
    expect(draft[edit]).toBe('edited-by-n-1')
    expect(draft).toEqual({ ...entity, [edit]: 'edited-by-n-1' })
    expect(nested(draft)).toEqual(nested(entity))
  })

  it('the same through a real Automerge change on the whole collection map', () => {
    const doc = A.from({ coll: { [key]: clone(entity) } } as Record<string, unknown>)
    const target = { [key]: { ...(asN1(entity) as Record<string, unknown>), [edit]: 'edited' } }
    const after = A.change(doc, (d: any) => reconcile(d.coll, target, COLLECTION_SCHEMAS[collection]))
    expect((after as any).coll[key]).toEqual({ ...entity, [edit]: 'edited' })
  })

  it('every DECLARED field is still deleted when the target lacks it, and an undeclared one never is', () => {
    const fields = schema.kind === 'struct' ? Object.keys(schema.fields) : []
    expect(fields.length).toBeGreaterThan(3)
    for (const field of fields) {
      const draft: Record<string, unknown> = { [field]: 'x', undeclaredV2: 'k' }
      reconcile(draft, {}, schema)
      expect(draft, field).toEqual({ undeclaredV2: 'k' })
    }
  })

  it('the pre-diff sees an extra KNOWN key in the current entity as a write', () => {
    const fields = schema.kind === 'struct' ? Object.keys(schema.fields) : []
    for (const field of fields) {
      expect(reconcileIsNoop({ [field]: 'x' }, {}, schema), field).toBe(false)
      expect(planCollectionReconcile({ e: { [field]: 'x' } }, { e: {} }, COLLECTION_SCHEMAS[collection]), field)
        .toEqual({ update: ['e'], remove: [] })
    }
  })

  it('the pre-diff agrees: a target differing only by unknown fields is a no-op', () => {
    const n1 = asN1(entity)
    expect(reconcileIsNoop(entity, n1, schema)).toBe(true)
    expect(reconcileIsNoop(entity, n1, EXACT)).toBe(false)
    expect(planCollectionReconcile({ [key]: entity }, { [key]: n1 }, COLLECTION_SCHEMAS[collection])).toBeNull()
  })
})

// ── intentional clears of known optional fields (the inventory) ──────────────

/** Literal cases, NOT derived from the registry: each is a real "user cleared
 * this optional field" write the app performs by writing the entity without
 * it. A registry that forgot one of these fields would leave it standing. */
const clears: [EntityCollection, Record<string, unknown>, string][] = [
  ['objects', { id: 'o', name: 'O', description: 'md' }, 'description'],
  ['objects', { id: 'o', name: 'O', shortDescription: 's' }, 'shortDescription'],
  ['objects', { id: 'o', name: 'O', parentId: 'p' }, 'parentId'],
  ['objects', { id: 'o', name: 'O', domainId: 'd' }, 'domainId'],
  ['objects', { id: 'o', name: 'O', iconAssignment: { source: 'generic', mode: 'explicit', displayName: 'x' } }, 'iconAssignment'],
  ['objects', { id: 'o', name: 'O', technologyUsages: {} }, 'technologyUsages'],
  ['objects', { id: 'o', name: 'O', ownerAssignments: {} }, 'ownerAssignments'],
  ['objects', { id: 'o', name: 'O', links: ['https://x'] }, 'links'],
  ['objects', { id: 'o', name: 'O', icon: 'i' }, 'icon'],
  ['connections', { id: 'c', label: 'L' }, 'label'],
  ['connections', { id: 'c', waypoints3d: [] }, 'waypoints3d'],
  ['connections', { id: 'c', shape3d: 'straight' }, 'shape3d'],
  ['connections', { id: 'c', hidden: 'both' }, 'hidden'],
  ['connections', { id: 'c', properties: { a: 'b' } }, 'properties'],
  ['connections', { id: 'c', status: 'down' }, 'status'],
  ['groups', { id: 'g', borderColor: '#000' }, 'borderColor'],
  ['groups', { id: 'g', fillOpacity: 0.5 }, 'fillOpacity'],
  ['groups', { id: 'g', innerWrapperIds: ['x'] }, 'innerWrapperIds'],
  ['groups', { id: 'g', position: { x: 0, y: 0 } }, 'position'],
  ['domains', { id: 'd', parentId: 'p' }, 'parentId'],
  ['domains', { id: 'd', color: '#f00' }, 'color'],
  ['decisionRecords', { id: 'r', ownerId: 'u' }, 'ownerId'],
  ['decisionRecords', { id: 'r', history: [] }, 'history'],
  ['comments', { id: 'k', authorId: 'u' }, 'authorId'],
  ['flows', { id: 'f', domainId: 'd' }, 'domainId'],
  ['diagrams', { id: 'dg', parentObjectId: 'p' }, 'parentObjectId'],
  ['diagrams', { id: 'dg', objectScopes: {} }, 'objectScopes'],
]

describe('intentional clears of known optional fields still delete', () => {
  it.each(clears)('%s: clearing %j → %s gone', (collection, entity, field) => {
    const draft = { ...clone(entity), v2Field: 'k' }
    const target: Record<string, unknown> = { ...entity }
    delete target[field]
    reconcile(draft, target, ENTITY_SCHEMAS[collection])
    expect(field in draft).toBe(false)
    expect(draft.v2Field).toBe('k')
  })

  it.each([
    ['description'], ['parentObjectId'], ['sourceViewKey'], ['domainId'], ['skinId'], ['sceneDecor'],
    ['layouts3d'], ['connectionHighlightStyle'], ['defaultConnectionShape'], ['readonly'],
  ])('DiagramDoc: clearing %s deletes it', (field) => {
    const draft: Record<string, unknown> = { name: 'D', [field]: field === 'sceneDecor' ? { packId: 'p' } : 'x', annotationsV2: {} }
    reconcile(draft, { name: 'D' }, DIAGRAM_DOC_SCHEMA)
    expect(draft).toEqual({ name: 'D', annotationsV2: {} })
  })

  it('a nested known field (sceneDecor.packId) clears while a nested unknown one stays', () => {
    const draft: any = { name: 'D', sceneDecor: { packId: 'p', density: 'rich', lightingV2: 'k' } }
    reconcileKey(draft, 'sceneDecor', { density: 'rich' }, DIAGRAM_DOC_SCHEMA.fields.sceneDecor)
    expect(draft.sceneDecor).toEqual({ density: 'rich', lightingV2: 'k' })
  })

  it('a flow step changing variant drops the old variant\'s fields (every union member is known)', () => {
    const flow: any = { id: 'f', steps: [{ id: 's', order: 0, type: 'message', title: 'S', fromObjectId: 'a', toObjectId: 'b', connectionId: 'c', v2: 'k' }] }
    reconcile(flow, { id: 'f', steps: [{ id: 's', order: 0, type: 'process', title: 'S', objectId: 'o' }] }, ENTITY_SCHEMAS.flows)
    expect(flow.steps[0]).toEqual({ id: 's', order: 0, type: 'process', title: 'S', objectId: 'o', v2: 'k' })
  })
})

// ── planner + apply ≡ reconcile, under a struct schema, in real Automerge ────

describe('planCollectionReconcile + applyCollectionReconcile ≡ reconcile under a known-keys schema', () => {
  it('writes the same document as the full reconcile', () => {
    const base = {
      a: { id: 'a', type: 'app', name: 'A', v2: 'k', position: { x: 0, y: 0, z: 1 } },
      b: { id: 'b', type: 'app', name: 'B', description: 'd' },
      c: { id: 'c', type: 'app', name: 'C' },
    }
    const doc = A.from({ coll: clone(base) } as Record<string, unknown>)
    const target = {
      a: { id: 'a', type: 'app', name: 'A2', position: { x: 0, y: 0 } },
      b: { id: 'b', type: 'app', name: 'B' },
    }
    const schema = COLLECTION_SCHEMAS.objects
    const full = A.change(A.clone(doc), (d: any) => reconcile(d.coll, target, schema))
    const plan = planCollectionReconcile((doc as any).coll, target, schema)!
    expect(plan).toEqual({ update: ['a', 'b'], remove: ['c'] })
    const targeted = A.change(A.clone(doc), (d: any) => applyCollectionReconcile(d.coll, target, plan, schema))
    expect((targeted as any).coll).toEqual((full as any).coll)
    expect((full as any).coll).toEqual({
      a: { id: 'a', type: 'app', name: 'A2', v2: 'k', position: { x: 0, y: 0, z: 1 } },
      b: { id: 'b', type: 'app', name: 'B' },
    })
  })
})

// ── bridge level: the active-diagram write (projection.diagramToDiagramDoc) ──

describe('bridge path — reconcile(doc, diagramToDiagramDoc(...), DIAGRAM_DOC_SCHEMA)', () => {
  it('an N-1 store rewriting the active diagram keeps the v2 doc fields, comment fields and flow fields', () => {
    const v2Doc = {
      name: 'D', type: 'context', description: 'old', objectIds: [], connectionIds: [], groupIds: [],
      layouts: { o1: { position: { x: 1, y: 1 }, size: { width: 1, height: 1 }, rotationV2: 90 } },
      lowerRouting: {},
      annotationsV2: { a1: { text: 'kept' } },
      comments: { k1: { id: 'k1', diagramId: 'dg', type: 'idea', text: 't', position: { x: 0, y: 0 }, author: 'a', createdAt: 'c', resolved: false, pinned: false, replies: [], reactionsV2: { up: 2 } } },
      flows: { f1: { id: 'f1', name: 'F', diagramId: 'dg', steps: [], fragment: 'kept' } },
      checkpoints: [],
    }
    const doc = A.from(clone(v2Doc) as Record<string, unknown>)
    // The N-1 store: built from its own types, so none of the v2 fields.
    const diagram: Diagram = {
      id: 'dg', name: 'D renamed', type: 'context', objectIds: [], connectionIds: [], groupIds: [],
      layouts: { o1: { position: { x: 5, y: 1 }, size: { width: 1, height: 1 } } },
    }
    const comments: Comment[] = [{ id: 'k1', diagramId: 'dg', type: 'idea', text: 't2', position: { x: 0, y: 0 }, author: 'a', createdAt: 'c', resolved: true, pinned: false, replies: [] }]
    const flows: Flow[] = [{ id: 'f1', name: 'F2', diagramId: 'dg', steps: [] }]
    const after = A.change(doc, (d: any) => reconcile(d, diagramToDiagramDoc(diagram, comments, flows, d.checkpoints), DIAGRAM_DOC_SCHEMA)) as unknown as DiagramDoc & Record<string, any>
    expect(after.name).toBe('D renamed')
    expect('description' in after).toBe(false) // a known field the store cleared
    expect(after.annotationsV2).toEqual({ a1: { text: 'kept' } })
    expect(after.layouts!.o1).toEqual({ position: { x: 5, y: 1 }, size: { width: 1, height: 1 }, rotationV2: 90 })
    expect(after.comments.k1).toMatchObject({ text: 't2', resolved: true, reactionsV2: { up: 2 } })
    expect(after.flows.f1).toMatchObject({ name: 'F2', fragment: 'kept' })
  })

  it('a deleted comment/flow (absent id) is still removed from the doc', () => {
    const doc = A.from({ name: 'D', comments: { k1: { id: 'k1', v2: 1 } }, flows: { f1: { id: 'f1', fragment: 'x' } } } as Record<string, unknown>)
    const after = A.change(doc, (d: any) => reconcile(d, { name: 'D', comments: {}, flows: {} }, DIAGRAM_DOC_SCHEMA)) as any
    expect(after.comments).toEqual({})
    expect(after.flows).toEqual({})
  })
})

// ── two real Repos: an N client and an N-1 client converge ───────────────────

type SentMessage = Parameters<NetworkAdapter['send']>[0]
type PeerMeta = Parameters<NetworkAdapter['connect']>[1]

/** One end of an in-process link (pattern from actorPerSession.test.ts). */
class LinkedAdapter extends NetworkAdapter {
  other: LinkedAdapter | null = null
  connected = false
  isReady(): boolean { return this.connected }
  whenReady(): Promise<void> { return Promise.resolve() }
  connect(peerId: PeerId, peerMetadata?: PeerMeta): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.connected = true
    const other = this.other
    if (other?.connected && other.peerId) {
      this.emit('peer-candidate', { peerId: other.peerId, peerMetadata: other.peerMetadata ?? {} })
      other.emit('peer-candidate', { peerId, peerMetadata: peerMetadata ?? {} })
    }
  }
  send(message: SentMessage): void {
    const other = this.other
    if (!other) return
    setTimeout(() => other.emit('message', message), 0)
  }
  disconnect(): void { this.connected = false }
}

const repos: Repo[] = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.shutdown().catch(() => undefined)))
})

function linkedRepos(): [Repo, Repo] {
  const a = new Repo({ network: [], sharePolicy: async () => true })
  const b = new Repo({ network: [], sharePolicy: async () => true })
  repos.push(a, b)
  const sa = new LinkedAdapter()
  const sb = new LinkedAdapter()
  sa.other = sb
  sb.other = sa
  a.networkSubsystem.addNetworkAdapter(sa)
  b.networkSubsystem.addNetworkAdapter(sb)
  return [a, b]
}

type Shard = { objects: Record<string, C4Object & Record<string, unknown>> }

describe('two repos — N and N-1 clients converge without losing v2 fields', () => {
  it('concurrent edits: N-1 renames (target without the v2 field), N edits the v2 field; both survive on both peers', async () => {
    const [nRepo, n1Repo] = linkedRepos()
    const object = {
      id: 'o1', type: 'app', name: 'O', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
      tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
      criticalityV2: 'high',
    } as C4Object & Record<string, unknown>
    const nHandle = nRepo.create<Shard>({ objects: { o1: clone(object) } })
    const n1Handle: DocHandle<Shard> = await n1Repo.find<Shard>(nHandle.url)
    await vi.waitFor(() => expect(n1Handle.doc()?.objects?.o1?.criticalityV2).toBe('high'))

    // The N-1 client's store object: its own type, no criticalityV2.
    const { criticalityV2: _unknown, ...n1Object } = object
    n1Handle.change((d) => reconcile(d.objects, { o1: { ...n1Object, name: 'Renamed by N-1' } }, COLLECTION_SCHEMAS.objects))
    nHandle.change((d) => { d.objects.o1.criticalityV2 = 'low' })

    const converged = (h: DocHandle<Shard>) => {
      const o = h.doc()?.objects.o1
      return o?.name === 'Renamed by N-1' && o?.criticalityV2 === 'low'
    }
    await vi.waitFor(() => {
      expect(converged(nHandle)).toBe(true)
      expect(converged(n1Handle)).toBe(true)
    })
    expect(A.getHeads(nHandle.doc() as A.Doc<unknown>)).toEqual(A.getHeads(n1Handle.doc() as A.Doc<unknown>))
  })

  it('control: the same N-1 write under EXACT (pre-V0-08 semantics) deletes the v2 field on both peers', async () => {
    const [nRepo, n1Repo] = linkedRepos()
    const object = { id: 'o1', type: 'app', name: 'O', criticalityV2: 'high' } as unknown as C4Object & Record<string, unknown>
    const nHandle = nRepo.create<Shard>({ objects: { o1: clone(object) } })
    const n1Handle: DocHandle<Shard> = await n1Repo.find<Shard>(nHandle.url)
    await vi.waitFor(() => expect(n1Handle.doc()?.objects?.o1?.criticalityV2).toBe('high'))
    n1Handle.change((d) => reconcile(d.objects, { o1: { id: 'o1', type: 'app', name: 'Renamed' } }, EXACT))
    await vi.waitFor(() => expect(nHandle.doc()?.objects.o1.name).toBe('Renamed'))
    expect('criticalityV2' in nHandle.doc()!.objects.o1).toBe(false)
  })

  it('C4_OBJECT_SCHEMA is what the bridge writes objects with', () => {
    // Pins the identity used above, so the convergence test exercises the
    // production schema rather than a test-local one.
    expect(COLLECTION_SCHEMAS.objects).toEqual(mapOf(C4_OBJECT_SCHEMA))
  })
})
