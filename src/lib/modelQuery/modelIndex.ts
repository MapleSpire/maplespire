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

import type { C4Object, Connection, Group, Diagram } from '../../types'
import { equivalentTechnologyIds } from '../technologies/canonicalIds'
import type { KvStore } from './kvStore'
import type { PeerEdge, SearchHit } from './types'
import {
  trigramsOf, objectSearchTexts, connectionSearchTexts, scoreConnection,
  rankSearch, SEARCH_LIMIT, SEARCH_MIN_CHARS,
} from './search'
import { TECHNOLOGY_POSTINGS_DIRTY_KEY, technologyPostingsFor } from './technologyPostings'
import { TAG_POSTINGS_DIRTY_KEY, tagPostingsFor } from './tagPostings'
import { equivalentTagIds } from '../tags/canonicalIds'

/**
 * The persisted model index. Stores the C4 graph as flat
 * key/value records so adjacency and entity lookups can be served WITHOUT the
 * whole graph resident in JS — the foundation of the paged ModelQuery:
 *
 *   o:{id}   → C4Object        g:{id}  → Group         c:{id} → Connection
 *   out:{id} → connectionId[]  (connections with fromId === id)
 *   in:{id}  → connectionId[]  (connections with toId === id)
 *   ch:{id}  → objectId[]      (objects whose parentId === id — for descendants)
 *   d:{id}   → Diagram         od:{id} → diagramId[]   (diagrams containing object id)
 *   dpo:{id} → diagramId[]     (diagrams whose parentObjectId === id — detail/parent)
 *   tg:{trigram} → entityId[]  (3-grams of searchable text — substring search)
 *
 * A focus fan-out is then O(degree): one `in/out` list read + a batched read of
 * just that focus's connection records. Backend-agnostic via KvStore (IndexedDB
 * in prod, in-memory in tests).
 */

const oKey = (id: string) => `o:${id}`
const gKey = (id: string) => `g:${id}`
const cKey = (id: string) => `c:${id}`
const outKey = (id: string) => `out:${id}`
const inKey = (id: string) => `in:${id}`
const chKey = (id: string) => `ch:${id}`
const dKey = (id: string) => `d:${id}`
const odKey = (id: string) => `od:${id}`
const dpoKey = (id: string) => `dpo:${id}`
const tgKey = (t: string) => `tg:${t}`
const TEAM_FACET_COUNTS_KEY = 'facet:team-counts'

type TeamFacetCounts = Record<string, number>

function objectTeamIds(object: C4Object): string[] {
  return [...new Set([...(object.ownerTeamIds ?? []), ...(object.teamIds ?? [])].filter(Boolean))]
}

function addObjectTeams(counts: Map<string, number>, object: C4Object): void {
  for (const teamId of objectTeamIds(object)) counts.set(teamId, (counts.get(teamId) ?? 0) + 1)
}

function countsRecord(counts: Map<string, number>): TeamFacetCounts {
  return Object.fromEntries([...counts].filter(([, count]) => count > 0))
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key)
  if (arr) arr.push(value)
  else map.set(key, [value])
}

export interface ModelIndexInput {
  objects: C4Object[]
  groups: Group[]
  connections: Connection[]
  /** Optional — indexes diagram membership (od:/dpo:) for relatedDiagrams. */
  diagrams?: Diagram[]
}

/** Build (or fully rebuild) the index from a model snapshot. */
export async function buildModelIndex(store: KvStore, model: ModelIndexInput): Promise<void> {
  const entries: [string, unknown][] = []
  const ch = new Map<string, string[]>()
  const teamCounts = new Map<string, number>()
  for (const o of model.objects) {
    entries.push([oKey(o.id), o])
    addObjectTeams(teamCounts, o)
    if (o.parentId) push(ch, o.parentId, o.id)
  }
  for (const g of model.groups) entries.push([gKey(g.id), g])

  const out = new Map<string, string[]>()
  const inc = new Map<string, string[]>()
  for (const c of model.connections) {
    entries.push([cKey(c.id), c])
    push(out, c.fromId, c.id)
    push(inc, c.toId, c.id)
  }
  for (const [id, ids] of out) entries.push([outKey(id), ids])
  for (const [id, ids] of inc) entries.push([inKey(id), ids])
  for (const [id, ids] of ch) entries.push([chKey(id), ids])

  // Diagram records + membership: od (object → containing diagrams), dpo
  // (parentObjectId → diagrams) — for relatedDiagrams.
  const od = new Map<string, string[]>()
  const dpo = new Map<string, string[]>()
  for (const d of model.diagrams ?? []) {
    entries.push([dKey(d.id), d])
    for (const oid of d.objectIds) push(od, oid, d.id)
    if (d.parentObjectId) push(dpo, d.parentObjectId, d.id)
  }
  for (const [id, ids] of od) entries.push([odKey(id), ids])
  for (const [id, ids] of dpo) entries.push([dpoKey(id), ids])

  // Trigram postings for substring search (objects + connections share the space).
  const tg = new Map<string, string[]>()
  for (const o of model.objects) for (const t of trigramsOf(objectSearchTexts(o))) push(tg, t, o.id)
  for (const c of model.connections) for (const t of trigramsOf(connectionSearchTexts(c))) push(tg, t, c.id)
  for (const [t, ids] of tg) entries.push([tgKey(t), ids])
  entries.push([TEAM_FACET_COUNTS_KEY, countsRecord(teamCounts)])

  await store.setMany(entries)
  await Promise.all([
    technologyPostingsFor(store).rebuild([...model.objects, ...model.groups]),
    tagPostingsFor(store).rebuild([...model.objects, ...model.groups]),
  ])
  await store.delMany([TECHNOLOGY_POSTINGS_DIRTY_KEY, TAG_POSTINGS_DIRTY_KEY])
}

const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Time-sliced {@link buildModelIndex}: produces the IDENTICAL index, but yields to
 * the event loop between chunks of the (otherwise one long synchronous task) map +
 * trigram build and writes the entries in batches — so a MAIN-THREAD cold build (the
 * fallback when a web worker is blocked) never freezes the UI, even at 100k objects.
 * `onProgress(done, total)` reports the write phase (0..1-ish) for a progress UI.
 */
export async function buildModelIndexChunked(
  store: KvStore,
  model: ModelIndexInput,
  onProgress?: (done: number, total: number) => void,
  yieldEvery = 2000
): Promise<void> {
  const entries: [string, unknown][] = []
  const ch = new Map<string, string[]>()
  const tg = new Map<string, string[]>()
  const teamCounts = new Map<string, number>()
  const objects = model.objects
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]
    entries.push([oKey(o.id), o])
    addObjectTeams(teamCounts, o)
    if (o.parentId) push(ch, o.parentId, o.id)
    for (const t of trigramsOf(objectSearchTexts(o))) push(tg, t, o.id)
    if (i % yieldEvery === yieldEvery - 1) await yieldToMain()
  }
  for (const g of model.groups) entries.push([gKey(g.id), g])

  const out = new Map<string, string[]>()
  const inc = new Map<string, string[]>()
  const connections = model.connections
  for (let i = 0; i < connections.length; i++) {
    const c = connections[i]
    entries.push([cKey(c.id), c])
    push(out, c.fromId, c.id)
    push(inc, c.toId, c.id)
    for (const t of trigramsOf(connectionSearchTexts(c))) push(tg, t, c.id)
    if (i % yieldEvery === yieldEvery - 1) await yieldToMain()
  }

  const od = new Map<string, string[]>()
  const dpo = new Map<string, string[]>()
  for (const d of model.diagrams ?? []) {
    entries.push([dKey(d.id), d])
    for (const oid of d.objectIds) push(od, oid, d.id)
    if (d.parentObjectId) push(dpo, d.parentObjectId, d.id)
  }
  for (const [id, ids] of out) entries.push([outKey(id), ids])
  for (const [id, ids] of inc) entries.push([inKey(id), ids])
  for (const [id, ids] of ch) entries.push([chKey(id), ids])
  for (const [id, ids] of od) entries.push([odKey(id), ids])
  for (const [id, ids] of dpo) entries.push([dpoKey(id), ids])
  for (const [t, ids] of tg) entries.push([tgKey(t), ids])
  entries.push([TEAM_FACET_COUNTS_KEY, countsRecord(teamCounts)])

  // Write in batches with a yield between each so the big persist doesn't block.
  const BATCH = 5000
  for (let i = 0; i < entries.length; i += BATCH) {
    await store.setMany(entries.slice(i, i + BATCH))
    onProgress?.(Math.min(i + BATCH, entries.length), entries.length)
    if (i + BATCH < entries.length) await yieldToMain()
  }
  await Promise.all([
    technologyPostingsFor(store).rebuild([...model.objects, ...model.groups]),
    tagPostingsFor(store).rebuild([...model.objects, ...model.groups]),
  ])
  await store.delMany([TECHNOLOGY_POSTINGS_DIRTY_KEY, TAG_POSTINGS_DIRTY_KEY])
}

// ── enumeration (whole-family scans — back the global tables when the resident
//    store is windowed; O(all keys), so only the table views call these) ────────
// The `o:`/`c:`/`g:`/`d:` prefixes are unambiguous: a record key always has `:` at
// index 1, so `o:` never matches `out:`/`od:`, nor `c:` match `ch:`, etc.

export async function indexAllObjects(store: KvStore): Promise<C4Object[]> {
  return (await store.scanPrefix<C4Object>('o:')).map(([, v]) => v)
}
export async function indexAllConnections(store: KvStore): Promise<Connection[]> {
  return (await store.scanPrefix<Connection>('c:')).map(([, v]) => v)
}
export async function indexAllGroups(store: KvStore): Promise<Group[]> {
  return (await store.scanPrefix<Group>('g:')).map(([, v]) => v)
}
export async function indexAllDiagrams(store: KvStore): Promise<Diagram[]> {
  return (await store.scanPrefix<Diagram>('d:')).map(([, v]) => v)
}

// ── queries (the paged ModelQuery reads these) ───────────────────────────────

export async function indexOutgoing(store: KvStore, focusId: string): Promise<PeerEdge[]> {
  const ids = (await store.get<string[]>(outKey(focusId))) ?? []
  if (ids.length === 0) return []
  const conns = await store.getMany<Connection>(ids.map(cKey))
  const out: PeerEdge[] = []
  for (const c of conns) if (c && c.toId !== focusId) out.push({ connection: c, peerId: c.toId })
  return out
}

export async function indexIncoming(store: KvStore, focusId: string): Promise<PeerEdge[]> {
  const ids = (await store.get<string[]>(inKey(focusId))) ?? []
  if (ids.length === 0) return []
  const conns = await store.getMany<Connection>(ids.map(cKey))
  const out: PeerEdge[] = []
  for (const c of conns) if (c && c.fromId !== focusId) out.push({ connection: c, peerId: c.fromId })
  return out
}

export function indexObject(store: KvStore, id: string): Promise<C4Object | undefined> {
  return store.get<C4Object>(oKey(id))
}

export async function indexObjectsByIds(store: KvStore, ids: string[]): Promise<C4Object[]> {
  if (!ids.length) return []
  return (await store.getMany<C4Object>(ids.map(oKey))).filter((object): object is C4Object => !!object)
}

/** Direct children for a bounded parent set; one batched adjacency read followed
 * by one batched entity read. */
export async function indexChildrenOfMany(store: KvStore, parentIds: string[]): Promise<C4Object[]> {
  if (!parentIds.length) return []
  const childLists = await store.getMany<string[]>(parentIds.map(chKey))
  const childIds = [...new Set(childLists.flatMap((ids) => ids ?? []))]
  return indexObjectsByIds(store, childIds)
}

/** Connections touching a bounded object set, without enumerating c:* records. */
export async function indexConnectionsTouching(store: KvStore, objectIds: string[]): Promise<Connection[]> {
  if (!objectIds.length) return []
  const [outLists, inLists] = await Promise.all([
    store.getMany<string[]>(objectIds.map(outKey)),
    store.getMany<string[]>(objectIds.map(inKey)),
  ])
  const connectionIds = [...new Set([...outLists, ...inLists].flatMap((ids) => ids ?? []))]
  return (await store.getMany<Connection>(connectionIds.map(cKey))).filter((connection): connection is Connection => !!connection)
}

export function indexTechnologyEntityIds(store: KvStore, technologyIds: string[]): Promise<string[]> {
  return technologyPostingsFor(store).entityIdsForTechnologies(equivalentTechnologyIds(technologyIds))
}

export function indexTagEntityIds(store: KvStore, tagIds: string[]): Promise<string[]> {
  return tagPostingsFor(store).entityIdsForTags(equivalentTagIds(tagIds))
}

export function indexModelEntityCount(store: KvStore): Promise<number> {
  return technologyPostingsFor(store).entityCount()
}

/** Whole-model team facet in one indexed key read. The counts allow incremental
 * updates to remove a team only after its last object stops referencing it. */
export async function indexModelObjectFacets(store: KvStore): Promise<{ teamIds: string[] }> {
  const counts = (await store.get<TeamFacetCounts>(TEAM_FACET_COUNTS_KEY)) ?? {}
  return { teamIds: Object.keys(counts).filter((id) => counts[id] > 0).sort() }
}

export function indexGroup(store: KvStore, id: string): Promise<Group | undefined> {
  return store.get<Group>(gKey(id))
}

export function indexConnection(store: KvStore, id: string): Promise<Connection | undefined> {
  return store.get<Connection>(cKey(id))
}

export function indexDiagram(store: KvStore, id: string): Promise<Diagram | undefined> {
  return store.get<Diagram>(dKey(id))
}

/** Batch-resolve ids to objects (or groups, when not an object) in two reads. */
export async function indexLookupMany(
  store: KvStore,
  ids: string[],
): Promise<Map<string, C4Object | Group>> {
  const [objs, grps] = await Promise.all([
    store.getMany<C4Object>(ids.map(oKey)),
    store.getMany<Group>(ids.map(gKey)),
  ])
  const m = new Map<string, C4Object | Group>()
  for (let i = 0; i < ids.length; i++) {
    const e = objs[i] ?? grps[i]
    if (e) m.set(ids[i], e)
  }
  return m
}

export async function indexConnectionCount(store: KvStore, id: string): Promise<number> {
  const [out, inc] = await Promise.all([
    store.get<string[]>(outKey(id)),
    store.get<string[]>(inKey(id)),
  ])
  let count = (out?.length ?? 0) + (inc?.length ?? 0)
  // self-loops appear in both lists → count once
  if (out) {
    const inSet = new Set(inc ?? [])
    for (const cid of out) if (inSet.has(cid)) count--
  }
  return count
}

/**
 * Transitive descendant object ids of `objectId` (BFS over the children index).
 * Matches the resident `getDescendantObjects` (excludes self; one `ch:` read per
 * level → O(size of the subtree), not O(all objects)).
 */
export async function indexDescendants(store: KvStore, objectId: string): Promise<string[]> {
  const result: string[] = []
  const seen = new Set<string>()
  const queue = [objectId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const children = (await store.get<string[]>(chKey(current))) ?? []
    for (const childId of children) {
      if (seen.has(childId)) continue
      seen.add(childId)
      result.push(childId)
      queue.push(childId)
    }
  }
  return result
}

/**
 * Diagrams related to an object, mirroring the resident `getRelatedDiagrams`:
 *   reference = diagrams containing the object (od:)
 *   detail    = diagrams whose parentObjectId === objectId (dpo:)
 *   parent    = diagrams whose parentObjectId === object.parentId (dpo:)
 * The active diagram is excluded, and reference takes precedence over detail/parent.
 */
export async function indexRelatedDiagrams(
  store: KvStore,
  objectId: string,
  currentDiagramId: string | null,
): Promise<{ detail: Diagram[]; reference: Diagram[]; parent: Diagram[] }> {
  const obj = await store.get<C4Object>(oKey(objectId))
  if (!obj) return { detail: [], reference: [], parent: [] }

  const seen = new Set<string>()
  const pick = (ids: string[] | undefined): string[] => {
    const out: string[] = []
    for (const did of ids ?? []) {
      if (did === currentDiagramId || seen.has(did)) continue
      seen.add(did)
      out.push(did)
    }
    return out
  }
  const fetch = async (ids: string[]): Promise<Diagram[]> =>
    (await store.getMany<Diagram>(ids.map(dKey))).filter((d): d is Diagram => !!d)

  const reference = await fetch(pick(await store.get<string[]>(odKey(objectId))))
  const detail = await fetch(pick(await store.get<string[]>(dpoKey(objectId))))
  const parent = obj.parentId ? await fetch(pick(await store.get<string[]>(dpoKey(obj.parentId)))) : []
  return { detail, reference, parent }
}

/**
 * Substring search served from the trigram index. Candidates = entities sharing
 * ALL of the query's trigrams (a superset of true substring matches — a string
 * containing the query has every one of the query's trigrams), then verified by
 * the SAME per-field substring scoring the resident path uses, then ranked. So
 * the result is identical to resident for queries >= SEARCH_MIN_CHARS.
 */
export async function indexSearch(store: KvStore, query: string, limit = SEARCH_LIMIT): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase()
  if (q.length < SEARCH_MIN_CHARS) return []
  const tris = [...trigramsOf([q])]
  if (tris.length === 0) return []

  const postings = await store.getMany<string[]>(tris.map(tgKey))
  let candidates: Set<string> | null = null
  for (const posting of postings) {
    const set = new Set(posting ?? [])
    if (candidates === null) candidates = set
    else for (const id of candidates) if (!set.has(id)) candidates.delete(id)
    if (candidates.size === 0) return []
  }
  const ids = candidates ? [...candidates] : []
  if (ids.length === 0) return []

  const [objs, conns] = await Promise.all([
    store.getMany<C4Object>(ids.map(oKey)),
    store.getMany<Connection>(ids.map(cKey)),
  ])
  const objects = objs.filter((o): o is C4Object => !!o)
  const connections = conns.filter((c): c is Connection => !!c)

  // Resolve endpoint names for the connections that actually match (one batch).
  const endpoints = new Set<string>()
  for (const c of connections) if (scoreConnection(c, q) > 0) { endpoints.add(c.fromId); endpoints.add(c.toId) }
  const names = await indexLookupMany(store, [...endpoints])
  const nameOf = (id: string) => names.get(id)?.name ?? 'Unknown'

  return rankSearch(objects, connections, q, limit, nameOf)
}

// ── incremental update (fed by the bridge's projection diff) ─────────────────

export interface ModelIndexChanges {
  upsertObjects?: C4Object[]
  removeObjectIds?: string[]
  upsertGroups?: Group[]
  removeGroupIds?: string[]
  /** Connections added/changed — added to the adjacency lists. */
  addConnections?: Connection[]
  /** OLD connection objects to remove — their endpoints are read to detach them. */
  removeConnections?: Connection[]
  /** Object→parent links to attach in the children (ch:) index. */
  addObjectParents?: { parentId: string; id: string }[]
  /** Object→parent links to detach (OLD parentId) — for removes and parent moves. */
  removeObjectParents?: { parentId: string; id: string }[]
  upsertDiagrams?: Diagram[]
  removeDiagramIds?: string[]
  /** Object→diagram membership (od:) attach/detach. */
  addObjectDiagrams?: { objectId: string; diagramId: string }[]
  removeObjectDiagrams?: { objectId: string; diagramId: string }[]
  /** parentObjectId→diagram (dpo:) attach/detach. */
  addParentDiagrams?: { parentObjectId: string; diagramId: string }[]
  removeParentDiagrams?: { parentObjectId: string; diagramId: string }[]
}

/** Apply a delta to the index. Keeps adjacency lists consistent across endpoint moves. */
export async function applyModelChanges(store: KvStore, changes: ModelIndexChanges): Promise<void> {
  // Trigram maintenance must read the OLD entity records before they are
  // overwritten below, to compute which trigrams to remove (rename/relabel/delete).
  const tgObjIds = [...(changes.upsertObjects?.map((o) => o.id) ?? []), ...(changes.removeObjectIds ?? [])]
  const tgConnIds = [...(changes.addConnections?.map((c) => c.id) ?? []), ...(changes.removeConnections?.map((c) => c.id) ?? [])]
  const changedGroupIds = [...(changes.upsertGroups?.map((g) => g.id) ?? []), ...(changes.removeGroupIds ?? [])]
  const [oldTgObjs, oldTgConns, oldGroups] = await Promise.all([
    store.getMany<C4Object>(tgObjIds.map(oKey)),
    store.getMany<Connection>(tgConnIds.map(cKey)),
    store.getMany<Group>(changedGroupIds.map(gKey)),
  ])
  const oldTri = new Map<string, Set<string>>()
  tgObjIds.forEach((id, i) => oldTri.set(id, oldTgObjs[i] ? trigramsOf(objectSearchTexts(oldTgObjs[i]!)) : new Set()))
  tgConnIds.forEach((id, i) => oldTri.set(id, oldTgConns[i] ? trigramsOf(connectionSearchTexts(oldTgConns[i]!)) : new Set()))
  const newTri = new Map<string, Set<string>>()
  for (const o of changes.upsertObjects ?? []) newTri.set(o.id, trigramsOf(objectSearchTexts(o)))
  for (const c of changes.addConnections ?? []) newTri.set(c.id, trigramsOf(connectionSearchTexts(c)))

  const oldObjectsById = new Map<string, C4Object>()
  tgObjIds.forEach((id, index) => {
    const object = oldTgObjs[index]
    if (object) oldObjectsById.set(id, object)
  })
  const upsertObjects = changes.upsertObjects ?? []
  const removedObjectIds = changes.removeObjectIds ?? []
  const upsertIds = new Set(upsertObjects.map((object) => object.id))
  const addedCount = upsertObjects.filter((object) => !oldObjectsById.has(object.id)).length
  const removedCount = removedObjectIds.filter((id) => oldObjectsById.has(id) && !upsertIds.has(id)).length
  const oldGroupsById = new Map<string, Group>()
  changedGroupIds.forEach((id, index) => {
    const group = oldGroups[index]
    if (group) oldGroupsById.set(id, group)
  })
  const upsertGroups = changes.upsertGroups ?? []
  const removedGroupIds = changes.removeGroupIds ?? []
  const upsertGroupIds = new Set(upsertGroups.map((group) => group.id))
  const addedGroupCount = upsertGroups.filter((group) => !oldGroupsById.has(group.id)).length
  const removedGroupCount = removedGroupIds
    .filter((id) => oldGroupsById.has(id) && !upsertGroupIds.has(id)).length
  const postingEntitiesChanged = upsertObjects.length || removedObjectIds.length
    || upsertGroups.length || removedGroupIds.length

  // The flat index and compound postings live in separate IndexedDB databases.
  // Persist a recovery marker before either write so a crash can never make stale
  // postings look valid on the next warm/offline boot.
  if (postingEntitiesChanged) {
    await store.setMany([
      [TECHNOLOGY_POSTINGS_DIRTY_KEY, true],
      [TAG_POSTINGS_DIRTY_KEY, true],
    ])
  }

  if (changes.upsertObjects?.length) {
    await store.setMany(changes.upsertObjects.map((o) => [oKey(o.id), o]))
  }
  if (changes.removeObjectIds?.length) {
    await store.delMany(changes.removeObjectIds.map(oKey))
  }
  if (changes.upsertGroups?.length) {
    await store.setMany(changes.upsertGroups.map((g) => [gKey(g.id), g]))
  }
  if (changes.removeGroupIds?.length) {
    await store.delMany(changes.removeGroupIds.map(gKey))
  }
  if (upsertObjects.length || removedObjectIds.length) {
    const counts = new Map(Object.entries(
      (await store.get<TeamFacetCounts>(TEAM_FACET_COUNTS_KEY)) ?? {}
    ))
    const adjust = (object: C4Object, delta: number) => {
      for (const teamId of objectTeamIds(object)) {
        const next = (counts.get(teamId) ?? 0) + delta
        if (next > 0) counts.set(teamId, next)
        else counts.delete(teamId)
      }
    }
    for (const oldObject of oldObjectsById.values()) adjust(oldObject, -1)
    const removedIds = new Set(removedObjectIds)
    for (const object of upsertObjects) if (!removedIds.has(object.id)) adjust(object, 1)
    await store.set(TEAM_FACET_COUNTS_KEY, countsRecord(counts))
  }
  if (postingEntitiesChanged) {
    const technologyPostings = technologyPostingsFor(store)
    const tagPostings = tagPostingsFor(store)
    const [technologyBuilt, tagsBuilt] = await Promise.all([
      technologyPostings.isBuilt(), tagPostings.isBuilt(),
    ])
    const changedEntities = [...upsertObjects, ...upsertGroups]
    const removedEntityIds = [...removedObjectIds, ...removedGroupIds]
    const entityCountDelta = addedCount - removedCount + addedGroupCount - removedGroupCount
    const work: Promise<void>[] = []
    if (technologyBuilt) {
      work.push(technologyPostings.applyEntityDelta(changedEntities, removedEntityIds, entityCountDelta))
    }
    if (tagsBuilt) {
      work.push(tagPostings.applyEntityDelta(changedEntities, removedEntityIds, entityCountDelta))
    }
    await Promise.all(work)
    if (!technologyBuilt || !tagsBuilt) {
      // An off-window edit may race the first background build. One exceptional
      // flat-record scan publishes any missing generation; filtering never scans.
      const [indexedObjects, indexedGroups] = await Promise.all([
        store.scanPrefix<C4Object>('o:'),
        store.scanPrefix<Group>('g:'),
      ])
      const entities = [
        ...indexedObjects.map(([, object]) => object),
        ...indexedGroups.map(([, group]) => group),
      ]
      await Promise.all([
        ...(!technologyBuilt ? [technologyPostings.rebuild(entities)] : []),
        ...(!tagsBuilt ? [tagPostings.rebuild(entities)] : []),
      ])
    }
    await store.delMany([TECHNOLOGY_POSTINGS_DIRTY_KEY, TAG_POSTINGS_DIRTY_KEY])
  }
  const outAdd = new Map<string, string[]>()
  const outRem = new Map<string, string[]>()
  const inAdd = new Map<string, string[]>()
  const inRem = new Map<string, string[]>()
  const cSet: [string, unknown][] = []
  const cDel: string[] = []
  for (const c of changes.addConnections ?? []) {
    cSet.push([cKey(c.id), c])
    push(outAdd, c.fromId, c.id)
    push(inAdd, c.toId, c.id)
  }
  for (const c of changes.removeConnections ?? []) {
    cDel.push(cKey(c.id))
    push(outRem, c.fromId, c.id)
    push(inRem, c.toId, c.id)
  }
  // Removes before adds: an endpoint MOVE puts the same connection id in both
  // sets (remove from old endpoint, add to new); applying the add first would let
  // the remove undo it.
  if (cDel.length) await store.delMany(cDel)
  if (cSet.length) await store.setMany(cSet)

  await patchAdjacency(store, outKey, outAdd, outRem)
  await patchAdjacency(store, inKey, inAdd, inRem)

  // Children (ch:) index — a parent move emits a remove (old parent) + add (new).
  const chAdd = new Map<string, string[]>()
  const chRem = new Map<string, string[]>()
  for (const { parentId, id } of changes.addObjectParents ?? []) push(chAdd, parentId, id)
  for (const { parentId, id } of changes.removeObjectParents ?? []) push(chRem, parentId, id)
  await patchAdjacency(store, chKey, chAdd, chRem)

  // Diagram records + membership (od: / dpo:).
  if (changes.upsertDiagrams?.length) {
    await store.setMany(changes.upsertDiagrams.map((d) => [dKey(d.id), d]))
  }
  if (changes.removeDiagramIds?.length) {
    await store.delMany(changes.removeDiagramIds.map(dKey))
  }
  const odAdd = new Map<string, string[]>()
  const odRem = new Map<string, string[]>()
  for (const { objectId, diagramId } of changes.addObjectDiagrams ?? []) push(odAdd, objectId, diagramId)
  for (const { objectId, diagramId } of changes.removeObjectDiagrams ?? []) push(odRem, objectId, diagramId)
  await patchAdjacency(store, odKey, odAdd, odRem)

  const dpoAdd = new Map<string, string[]>()
  const dpoRem = new Map<string, string[]>()
  for (const { parentObjectId, diagramId } of changes.addParentDiagrams ?? []) push(dpoAdd, parentObjectId, diagramId)
  for (const { parentObjectId, diagramId } of changes.removeParentDiagrams ?? []) push(dpoRem, parentObjectId, diagramId)
  await patchAdjacency(store, dpoKey, dpoAdd, dpoRem)

  // Trigram postings (tg:) — per touched entity, add new grams and remove gone ones.
  const tgAdd = new Map<string, string[]>()
  const tgRem = new Map<string, string[]>()
  for (const id of new Set([...oldTri.keys(), ...newTri.keys()])) {
    const oldS = oldTri.get(id) ?? new Set<string>()
    const newS = newTri.get(id) ?? new Set<string>()
    for (const t of oldS) if (!newS.has(t)) push(tgRem, t, id)
    for (const t of newS) if (!oldS.has(t)) push(tgAdd, t, id)
  }
  await patchAdjacency(store, tgKey, tgAdd, tgRem)
}

/**
 * Diff two model snapshots into a change-set for `applyModelChanges`. Uses
 * reference identity (objects/groups/connections keep their ref when unchanged —
 * the same structural sharing the store projection relies on), so a one-entity
 * edit produces a one-entity diff. Connection endpoint moves emit both a remove
 * (old endpoints) and an add (new), and a same-endpoint field change re-emits the
 * record only (adjacency is a Set, so re-adding is a no-op).
 */
export function diffModelChanges(prev: ModelIndexInput, next: ModelIndexInput): ModelIndexChanges {
  const prevObj = new Map(prev.objects.map((o) => [o.id, o]))
  const nextObjIds = new Set(next.objects.map((o) => o.id))
  const upsertObjects = next.objects.filter((o) => prevObj.get(o.id) !== o)
  const removeObjectIds = prev.objects.filter((o) => !nextObjIds.has(o.id)).map((o) => o.id)

  // Parent-link transitions for the children (ch:) index: new object with a
  // parent → add; removed object → remove (old parent); parentId changed → both.
  const addObjectParents: { parentId: string; id: string }[] = []
  const removeObjectParents: { parentId: string; id: string }[] = []
  for (const o of next.objects) {
    const old = prevObj.get(o.id)
    if (!old) {
      if (o.parentId) addObjectParents.push({ parentId: o.parentId, id: o.id })
    } else if (old.parentId !== o.parentId) {
      if (old.parentId) removeObjectParents.push({ parentId: old.parentId, id: o.id })
      if (o.parentId) addObjectParents.push({ parentId: o.parentId, id: o.id })
    }
  }
  for (const o of prev.objects) {
    if (!nextObjIds.has(o.id) && o.parentId) removeObjectParents.push({ parentId: o.parentId, id: o.id })
  }

  const prevGrp = new Map(prev.groups.map((g) => [g.id, g]))
  const nextGrpIds = new Set(next.groups.map((g) => g.id))
  const upsertGroups = next.groups.filter((g) => prevGrp.get(g.id) !== g)
  const removeGroupIds = prev.groups.filter((g) => !nextGrpIds.has(g.id)).map((g) => g.id)

  const prevConn = new Map(prev.connections.map((c) => [c.id, c]))
  const nextConnIds = new Set(next.connections.map((c) => c.id))
  const addConnections: Connection[] = []
  const removeConnections: Connection[] = []
  for (const c of next.connections) {
    const old = prevConn.get(c.id)
    if (!old) addConnections.push(c)
    else if (old.fromId !== c.fromId || old.toId !== c.toId) {
      removeConnections.push(old)
      addConnections.push(c)
    } else if (old !== c) addConnections.push(c) // same endpoints, other field changed
  }
  for (const c of prev.connections) if (!nextConnIds.has(c.id)) removeConnections.push(c)

  // Diagrams: record upserts/removes + membership transitions (od: object→diagram,
  // dpo: parentObjectId→diagram). A diagram's objectIds set diff drives od:.
  const prevDgs = prev.diagrams ?? []
  const nextDgs = next.diagrams ?? []
  const prevDg = new Map(prevDgs.map((d) => [d.id, d]))
  const nextDgIds = new Set(nextDgs.map((d) => d.id))
  const upsertDiagrams = nextDgs.filter((d) => prevDg.get(d.id) !== d)
  const removeDiagramIds = prevDgs.filter((d) => !nextDgIds.has(d.id)).map((d) => d.id)
  const addObjectDiagrams: { objectId: string; diagramId: string }[] = []
  const removeObjectDiagrams: { objectId: string; diagramId: string }[] = []
  const addParentDiagrams: { parentObjectId: string; diagramId: string }[] = []
  const removeParentDiagrams: { parentObjectId: string; diagramId: string }[] = []
  for (const d of nextDgs) {
    const old = prevDg.get(d.id)
    if (!old) {
      for (const oid of d.objectIds) addObjectDiagrams.push({ objectId: oid, diagramId: d.id })
      if (d.parentObjectId) addParentDiagrams.push({ parentObjectId: d.parentObjectId, diagramId: d.id })
    } else if (old !== d) {
      const oldSet = new Set(old.objectIds)
      const newSet = new Set(d.objectIds)
      for (const oid of d.objectIds) if (!oldSet.has(oid)) addObjectDiagrams.push({ objectId: oid, diagramId: d.id })
      for (const oid of old.objectIds) if (!newSet.has(oid)) removeObjectDiagrams.push({ objectId: oid, diagramId: d.id })
      if (old.parentObjectId !== d.parentObjectId) {
        if (old.parentObjectId) removeParentDiagrams.push({ parentObjectId: old.parentObjectId, diagramId: d.id })
        if (d.parentObjectId) addParentDiagrams.push({ parentObjectId: d.parentObjectId, diagramId: d.id })
      }
    }
  }
  for (const d of prevDgs) {
    if (nextDgIds.has(d.id)) continue
    for (const oid of d.objectIds) removeObjectDiagrams.push({ objectId: oid, diagramId: d.id })
    if (d.parentObjectId) removeParentDiagrams.push({ parentObjectId: d.parentObjectId, diagramId: d.id })
  }

  return {
    upsertObjects, removeObjectIds, upsertGroups, removeGroupIds,
    addConnections, removeConnections, addObjectParents, removeObjectParents,
    upsertDiagrams, removeDiagramIds,
    addObjectDiagrams, removeObjectDiagrams, addParentDiagrams, removeParentDiagrams,
  }
}

async function patchAdjacency(
  store: KvStore,
  keyOf: (id: string) => string,
  add: Map<string, string[]>,
  remove: Map<string, string[]>,
): Promise<void> {
  const endpoints = new Set([...add.keys(), ...remove.keys()])
  for (const ep of endpoints) {
    const current = new Set((await store.get<string[]>(keyOf(ep))) ?? [])
    for (const id of remove.get(ep) ?? []) current.delete(id)
    for (const id of add.get(ep) ?? []) current.add(id)
    if (current.size > 0) await store.set(keyOf(ep), [...current])
    else await store.del(keyOf(ep))
  }
}
