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
import { holdsHeads } from './automergeHeads.js'
import { copyTypedValue, fullValueAt, objectIdAt } from './modelEpochs.js'

/**
 * EPOCH LATE-WRITE FORWARDING — the pure PLANNER and APPLIER (G4-16f).
 * No Repo, no SQL here — the forwarder service (`modelEpochForwarder.ts`)
 * drives these against live handles and the journal.
 *
 * A LATE WRITE is a change on a superseded epoch document (the SOURCE) that
 * lies outside the causal past of its cursor (initially the cut heads). The
 * forward re-applies the net effect of `diff(source, from, to)` on the
 * CURRENT epoch's documents (the TARGETS), BY IDENTITY:
 *
 *  - maps key by key, down to the leaf;
 *  - counters as INCREMENTS (they commute: never a clash);
 *  - list elements by ELEMENT ID and text by CHARACTER CURSOR: a deleted
 *    element is deleted where it now is, an inserted one goes right after
 *    its left neighbour. Only for an ALIGNED target — one BUILT from the
 *    source at the cut (`modelEpochs.ts`), whose sequences match the cut's
 *    element by element — and only while the target still holds the same
 *    sequence object it was born with;
 *  - everything else is a LEAF: written when the target still holds the late
 *    writer's base, kept when the target changed it — "the current epoch
 *    wins" (the owner's rule) — and the clash recorded as an OVERRIDE for the
 *    re-apply flow;
 *  - an entity deleted on either side stays deleted (Automerge's own rule: a
 *    deleted map key beats a concurrent nested edit); the late writer's edit
 *    to an entity the current epoch deleted is an override.
 *
 * ELEMENT IDENTITY IN AUTOMERGE 3.2.6, measured (and pinned by this
 * module's own tests):
 * cursors exist for TEXT only ("cursors only valid on text"), and
 * `getAll(list, i)` returns the WINNING op id — the element id only for an
 * element never overwritten. The element id of an overwritten element is the
 * `elemId` of the decoded put op whose id is `${startOp + k}@${actor}`
 * ({@link putToElementMap}); that layout is pinned by
 * `modelEpochForward.test.ts` ("decoded op-id layout"), so an Automerge
 * upgrade that changes it fails there first.
 *
 * IDEMPOTENCE: every target gets ITS OWN change, whose
 * message is {@link forwardMessage}`(journal, target)`. A replay checks each
 * target for its message ({@link findForwardChange}); a written target is
 * skipped and its new element ids are rebuilt from the decoded change
 * ({@link rebuildElemMap}) — never from values (a field set back to its base
 * value would otherwise be forwarded twice).
 */

export type Heads = A.Heads
export type Path = ReadonlyArray<string | number>

export interface ForwardTarget {
  documentId: string
  /** The target's CURRENT state (the plan is computed against it). */
  doc: A.Doc<unknown>
  /** `birthHeads` when the target was BUILT from the source at the cut (a
   * recreated base shard, the epoch meta): sequences are replayed by identity.
   * `null` for any other target (an overlay write head): sequences are leaves. */
  birthHeads: Heads | null
  /** Which changed entity paths this target receives (routing). */
  receives: (entityPath: Path) => boolean
  /** O1, "SERVED ELSEWHERE": for a write-head target, the
   * document whose value the current epoch SERVES for an entity the head does
   * not hold (an older overlay segment). The entity is then copied from it into
   * the head, kinds included, and the late write merged over THAT value — as
   * `ordinaryHeadForwarding.ts` does with `servedElsewhere`. Absent: the
   * entity is simply missing from the target. */
  servedElsewhere?: (entityPath: Path) => A.Doc<unknown> | undefined
}

export interface ForwardSource {
  doc: A.Doc<unknown>
  from: Heads
  to: Heads
  cut: Heads
  /** Old element id → current element id, for elements an EARLIER forward
   * created in a target (`read_model_model_epoch_docs.elem_map`). */
  elemMap: ReadonlyMap<string, string>
  /** Root keys whose CHILDREN are entities (`objects`, `connections`, the
   * meta's entity maps). A changed path under one is routed as
   * `[collection, id]`; any other root key as `[key]`. */
  collections: ReadonlySet<string>
  /** Root keys never forwarded (the epoch meta's builder keys). */
  excludedRootKeys: ReadonlySet<string>
}

export type LeafOp =
  | { kind: 'put'; target: Path; source: Path }
  | { kind: 'delete'; target: Path }
  | { kind: 'increment'; target: Path; by: number }
  /** O1: copy the value another current document serves for this entity. */
  | { kind: 'copy-served'; target: Path; from: A.Doc<unknown> }

export interface SeqOp {
  /** List: the element index. Text: the UTF-16 index the element starts at. */
  pos: number
  del?: true
  /** Text: the element's length in UTF-16 code units (2 for a code point
   * outside the BMP). Lists: absent (1). */
  units?: number
  /** Insert: where the element is in the source at `to`, and its old id. */
  source?: Path
  oldId?: string
  /** Text insert: the element's CODE POINT — never a lone surrogate. */
  text?: string
}

export interface SeqPlan {
  target: Path
  kind: 'list' | 'text'
  /** The target sequence object, to find this plan's inserts in the decoded change. */
  obj: string
  ops: SeqOp[]
}

export interface PlannedInsert { obj: string; oldId: string }

export interface ForwardOverride {
  target: Path
  /** JSON-safe renderings for the override rows. */
  late: unknown
  current: unknown
  reason: 'leaf' | 'sequence-replaced' | 'entity-deleted'
}

export interface ForwardLog {
  leafWrites: number
  conflicts: number
  increments: number
  seqInserts: number
  seqDeletes: number
  unmapped: number
  seqObjectReplaced: number
  entityDeleteWins: number
  created: number
}

export interface TargetPlan {
  documentId: string
  leaf: LeafOp[]
  seq: SeqPlan[]
  /** In APPLICATION order: the order the inserts appear in the change. */
  plannedInserts: PlannedInsert[]
  overrides: ForwardOverride[]
  log: ForwardLog
}

const emptyLog = (): ForwardLog => ({
  leafWrites: 0, conflicts: 0, increments: 0, seqInserts: 0, seqDeletes: 0,
  unmapped: 0, seqObjectReplaced: 0, entityDeleteWins: 0, created: 0,
})

// ---------------------------------------------------------------- values ---

type Kind = 'list' | 'istr' | 'counter' | 'date' | 'bytes' | 'null' | 'absent' | 'map' | string

/** ARRAYS FIRST: a list proxy answers true to `isImmutableString`/`isCounter`
 * in 3.2.6 (measured). */
function kind(value: unknown): Kind {
  if (Array.isArray(value)) return 'list'
  if (A.isImmutableString(value)) return 'istr'
  if (A.isCounter(value)) return 'counter'
  if (value instanceof Date) return 'date'
  if (value instanceof Uint8Array) return 'bytes'
  if (value === null) return 'null'
  if (value === undefined) return 'absent'
  if (typeof value === 'object') return 'map'
  return typeof value
}

/** Value equality with KIND: text (`string`) differs from `ImmutableString`. */
export function sameValue(a: unknown, b: unknown): boolean {
  const ka = kind(a)
  if (ka !== kind(b)) return false
  if (ka === 'list') {
    const la = a as unknown[], lb = b as unknown[]
    return la.length === lb.length && la.every((x, i) => sameValue(x, lb[i]))
  }
  if (ka === 'istr') return String((a as A.ImmutableString).val) === String((b as A.ImmutableString).val)
  if (ka === 'counter') return (a as A.Counter).value === (b as A.Counter).value
  if (ka === 'date') return (a as Date).getTime() === (b as Date).getTime()
  if (ka === 'bytes') {
    const ba = a as Uint8Array, bb = b as Uint8Array
    return ba.length === bb.length && ba.every((x, i) => x === bb[i])
  }
  if (ka === 'map') {
    const ma = a as Record<string, unknown>, mb = b as Record<string, unknown>
    const ka2 = Object.keys(ma), kb2 = Object.keys(mb)
    return ka2.length === kb2.length && ka2.every((k) => Object.prototype.hasOwnProperty.call(mb, k) && sameValue(ma[k], mb[k]))
  }
  return Object.is(a, b)
}

/** A JSON-safe rendering of a value, for the override rows. */
export function renderValue(value: unknown): unknown {
  const k = kind(value)
  if (k === 'list') return (value as unknown[]).map(renderValue)
  if (k === 'istr') return { $immutable: String((value as A.ImmutableString).val) }
  if (k === 'counter') return { $counter: (value as A.Counter).value }
  if (k === 'date') return { $date: (value as Date).toISOString() }
  if (k === 'bytes') return { $bytes: [...(value as Uint8Array)] }
  if (k === 'absent') return null
  if (k === 'map') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, v]) => [key, renderValue(v)]))
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) }
  return value
}

const at = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>((node, step) => (node == null ? undefined : (node as Record<string | number, unknown>)[step]), root)

// ------------------------------------------------------------ identities ---

/** put-op id → element id, from the decoded changes (a put at a list element
 * names it by `elemId`; its own id is `${startOp + k}@${actor}`). Inserts are
 * their own element ids and are not in the map. */
export function putToElementMap(doc: A.Doc<unknown>, since?: Heads): ReadonlyMap<string, string> {
  if (since) return addPutsToElements(new Map(), A.getChangesSince(doc, since))
  return memoizedPutToElementMap(doc)
}

/**
 * The FULL map of a document, extended from the last one computed for an
 * ancestor of it instead of decoding the whole history again (a forward
 * pass planned its source and target twice each, four full
 * decodes of a document a continuous typist grows by thousands of changes —
 * ~2.5 s of a 3 s pass, profiled, which no 2 s latch can wait for).
 *
 * Sound because the map only GROWS and never disagrees: its keys are op ids
 * (`counter@actor`, unique across documents) and the value of a key is fixed
 * by the change that holds the op. An entry whose heads the document holds is
 * a subset of the document's map; the changes since those heads complete it.
 * A key the document itself lacks is never asked for (callers look up the
 * op ids of the document's own winners). Shared by every caller; bounded.
 *
 * A map handed out is never changed afterwards: an extension COPIES its
 * ancestor's map — a copy costs no decoding. The cache holds
 * the last {@link PUT_TO_ELEMENT_CACHE_MAX} documents, enough for a pass to
 * plan and re-plan every target it touches (with 8, a pass
 * over 8+ documents evicted its own plan before the re-plan).
 *
 * BOUNDED IN MEMORY: at most TWO entries per
 * document lineage — a descendant keeps the ancestor it was extended from
 * (the source read at its cursor is that older state) and drops every other
 * cached ancestor (a source edited on every pass used to leave up to 64
 * near-identical copies of its map) — and at most
 * {@link PUT_TO_ELEMENT_CACHE_MAX_ENTRIES} map entries in all, the least
 * recently used documents evicted first.
 */
export const PUT_TO_ELEMENT_CACHE_MAX = 64
export const PUT_TO_ELEMENT_CACHE_MAX_ENTRIES = 1_000_000
const putToElementCache: Array<{ heads: Heads; map: ReadonlyMap<string, string> }> = []
let putToElementCacheEntries = 0
let putToElementCacheMaxEntries = PUT_TO_ELEMENT_CACHE_MAX_ENTRIES

function memoizedPutToElementMap(doc: A.Doc<unknown>): ReadonlyMap<string, string> {
  const heads = A.getHeads(doc)
  for (let i = putToElementCache.length - 1; i >= 0; i -= 1) {
    const entry = putToElementCache[i]!
    if (!holdsHeads(doc, entry.heads)) continue
    if (sameHeads(entry.heads, heads)) {
      // The same document state: most recently used.
      putToElementCache.splice(i, 1)
      putToElementCache.push(entry)
      return entry.map
    }
    // A descendant, extended from a copy. The ancestor it was extended from
    // STAYS (a pass reads the source at its cursor too — a view of an older
    // state, which would otherwise be decoded whole on every pass, measured
    // at 2.1 s passes in the no-pause e2e); every OTHER cached ancestor of
    // this state is an intermediate one and goes: at most two entries per
    // document lineage.
    const map = addPutsToElements(new Map(entry.map), A.getChangesSince(doc, entry.heads))
    for (let j = putToElementCache.length - 1; j >= 0; j -= 1) {
      const other = putToElementCache[j]!
      if (other !== entry && holdsHeads(doc, other.heads)) {
        putToElementCacheEntries -= other.map.size
        putToElementCache.splice(j, 1)
      }
    }
    return remember(heads, map)
  }
  return remember(heads, addPutsToElements(new Map(), A.getAllChanges(doc)))
}

function remember(heads: Heads, map: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  putToElementCache.push({ heads, map })
  putToElementCacheEntries += map.size
  while (putToElementCache.length > 1
    && (putToElementCache.length > PUT_TO_ELEMENT_CACHE_MAX || putToElementCacheEntries > putToElementCacheMaxEntries)) {
    putToElementCacheEntries -= putToElementCache.shift()!.map.size
  }
  return map
}

/** Test seam: the cache's size (documents, map entries); and its entry bound. */
export function putToElementCacheSize(): { documents: number; entries: number } {
  return { documents: putToElementCache.length, entries: putToElementCacheEntries }
}
export function setPutToElementCacheMaxEntriesForTest(max: number | null): void {
  putToElementCacheMaxEntries = max ?? PUT_TO_ELEMENT_CACHE_MAX_ENTRIES
}

const sameHeads = (a: Heads, b: Heads) => a.length === b.length && a.every((h) => b.includes(h))

/** Test seam: forget every memoized map, and the decoded-change count. */
export function resetPutToElementCache(): void {
  putToElementCache.length = 0
  putToElementCacheEntries = 0
  putToElementStats.decoded = 0
}

/** How many changes the map decoded (test seam: the memo's whole point). */
export const putToElementStats = { decoded: 0 }

function addPutsToElements(map: Map<string, string>, changes: Uint8Array[]): Map<string, string> {
  for (const raw of changes) {
    putToElementStats.decoded += 1
    const change = A.decodeChange(raw)
    change.ops.forEach((op, index) => {
      const opWithElem = op as { insert?: boolean; elemId?: string }
      if (!opWithElem.insert && opWithElem.elemId && opWithElem.elemId !== '_head') {
        map.set(`${change.startOp + index}@${change.actor}`, opWithElem.elemId)
      }
    })
  }
  return map
}

/** The element ids of the list at `path` at `heads`, in order. */
export function listElementIds(doc: A.Doc<unknown>, path: Path, heads: Heads | undefined, putToElem: ReadonlyMap<string, string>): { obj: string | null; ids: string[] } {
  const obj = objectIdAt(doc, heads, path)
  if (!obj) return { obj: null, ids: [] }
  const be = A.getBackend(doc)
  const ids: string[] = []
  for (let i = 0, n = be.length(obj, heads); i < n; i += 1) {
    const all = be.getAll(obj, i, heads)
    const winner = all[0]
    const opId = winner ? String(winner[winner.length - 1]) : ''
    ids.push(putToElem.get(opId) ?? opId)
  }
  return { obj, ids }
}

/**
 * The ELEMENTS of the text at `path` at `heads`: one per Unicode CODE POINT,
 * with its op id (its cursor), its value and its UTF-16 start and length.
 *
 * Automerge 3.2.6 indexes text in UTF-16 code units but stores one element per
 * code point: both halves of a surrogate pair answer the SAME cursor
 * (measured). Walking code units would plan an
 * astral character as two elements and write lone surrogates ("a😀b" forwarded
 * as "a��b"). A ZWJ sequence or a combining mark is several code
 * points, hence several elements, each with its own identity — which is what
 * Automerge itself stores.
 */
export function textCharacterIds(doc: A.Doc<unknown>, path: Path, heads: Heads | undefined): {
  obj: string | null; ids: string[]; values: string[]; starts: number[]
} {
  const obj = objectIdAt(doc, heads, path)
  if (!obj) return { obj: null, ids: [], values: [], starts: [] }
  const be = A.getBackend(doc)
  const text = be.text(obj, heads)
  const ids: string[] = []
  const values: string[] = []
  const starts: number[] = []
  let start = 0
  for (const codePoint of text) {
    ids.push(be.getCursor(obj, start, heads))
    values.push(codePoint)
    starts.push(start)
    start += codePoint.length
  }
  return { obj, ids, values, starts }
}

// -------------------------------------------------------------- detection ---

/** Changes on `source` outside the causal past of `cursor`, minus the
 * server's own (by hash — S8's `epochSuccessorRef` write). When none is left,
 * `advanceTo` is the source's heads: the cursor moves past server-only
 * changes, or a source whose only post-cut change is S8 would wait for the
 * 2N bound for ever. */
export function lateChanges(source: A.Doc<unknown>, cursor: Heads, serverHashes: ReadonlySet<string>): {
  late: ReturnType<typeof A.getChangesMetaSince>
  advanceTo: Heads | null
} {
  if (!holdsHeads(source, cursor)) throw new Error('the source does not contain its forward cursor')
  const late = A.getChangesMetaSince(source, cursor).filter((meta) => !serverHashes.has(meta.hash))
  return { late, advanceTo: late.length === 0 ? A.getHeads(source) : null }
}

/** The entity paths `diff(source, from, to)` touches, routed by collection. */
export function changedEntityPaths(source: ForwardSource): Path[] {
  const seen = new Map<string, Path>()
  for (const patch of A.diff(source.doc, source.from, source.to)) {
    const [first, second] = patch.path
    if (typeof first !== 'string' || source.excludedRootKeys.has(first)) continue
    const path: Path = source.collections.has(first)
      ? (second === undefined ? [first] : [first, second])
      : [first]
    seen.set(JSON.stringify(path), path)
  }
  return [...seen.values()]
}

// --------------------------------------------------------------- planning ---

interface PlanContext {
  source: ForwardSource
  target: ForwardTarget
  vFrom: unknown
  vTo: unknown
  sourceP2E: ReadonlyMap<string, string>
  targetP2E: ReadonlyMap<string, string>
  plan: TargetPlan
  seqByKey: Map<string, SeqPlan>
  /** O1: the entity path the target does not hold and the value served for
   * it elsewhere; `node` reads the current value under that path from it. */
  served?: { path: Path; value: unknown }
}

/** The current value at `pCur`: the target's, or — under an entity it does
 * not hold but another document serves (O1) — the served one. */
function currentAt(ctx: PlanContext, pCur: Path): unknown {
  const served = ctx.served
  if (served && served.path.every((step, i) => pCur[i] === step)) return at(served.value, pCur.slice(served.path.length))
  return at(ctx.target.doc, pCur)
}

/**
 * `A.view(doc, heads)`, materialized ONCE per (document snapshot, heads): a
 * forward planned each target twice
 * (inserts, then the write), each time materializing the source at `from`
 * and at `to`; on the hot base shard of an aged stack those views were 6 s
 * of a minute's passes, profiled. A document's own heads are the document
 * itself (no view). Automerge documents are immutable snapshots, so a
 * WeakMap on the snapshot is sound; a few heads per snapshot are kept.
 */
const viewsBySnapshot = new WeakMap<object, Map<string, unknown>>()
const VIEWS_PER_SNAPSHOT = 4
export function viewAt<T>(doc: A.Doc<T>, heads: readonly string[]): A.Doc<T> {
  const own = A.getHeads(doc)
  if (own.length === heads.length && own.every((h) => heads.includes(h))) return doc
  const key = [...heads].sort().join(',')
  let views = viewsBySnapshot.get(doc as object)
  const cached = views?.get(key)
  if (cached !== undefined) return cached as A.Doc<T>
  const view = A.view(doc, heads as A.Heads)
  if (!views) { views = new Map(); viewsBySnapshot.set(doc as object, views) }
  if (views.size >= VIEWS_PER_SNAPSHOT) views.delete(views.keys().next().value as string)
  views.set(key, view)
  return view
}

/** Plan ONE target's share of a forward. Pure: reads `source.doc` and
 * `target.doc`, writes nothing. */
export function planForwardTarget(
  source: ForwardSource, target: ForwardTarget, options: { entityPaths?: Path[]; sourcePutToElem?: ReadonlyMap<string, string> } = {},
): TargetPlan {
  const plan: TargetPlan = { documentId: target.documentId, leaf: [], seq: [], plannedInserts: [], overrides: [], log: emptyLog() }
  const ctx: PlanContext = {
    source, target,
    vFrom: viewAt(source.doc, source.from),
    vTo: viewAt(source.doc, source.to),
    sourceP2E: options.sourcePutToElem ?? putToElementMap(source.doc),
    targetP2E: putToElementMap(target.doc),
    plan,
    seqByKey: new Map(),
  }
  for (const entityPath of options.entityPaths ?? changedEntityPaths(source)) {
    if (!target.receives(entityPath)) continue
    const b = at(ctx.vFrom, entityPath)
    const h = at(ctx.vTo, entityPath)
    let c = at(target.doc, entityPath)
    ctx.served = undefined
    if (c === undefined && entityPath.length === 2 && (b !== undefined || h !== undefined)) {
      // O1: the head does not hold it, but an older segment serves it. Copy
      // that value in first, then merge the late write over it.
      const from = target.servedElsewhere?.(entityPath)
      const value = from ? at(from, entityPath) : undefined
      if (from && value !== undefined) {
        plan.leaf.push({ kind: 'copy-served', target: entityPath, from })
        ctx.served = { path: entityPath, value }
        c = value
      }
    }
    if (entityPath.length === 2) {
      // An ENTITY of a collection.
      if (h !== undefined && b === undefined) {
        if (c === undefined) { plan.leaf.push({ kind: 'put', target: entityPath, source: entityPath }); plan.log.created += 1 }
        else node(ctx, entityPath, entityPath, entityPath, undefined, h)
        continue
      }
      if (b !== undefined && h === undefined) {
        if (c !== undefined) { plan.leaf.push({ kind: 'delete', target: entityPath }); plan.log.entityDeleteWins += 1 }
        continue
      }
      if (c === undefined) {
        plan.log.entityDeleteWins += 1
        plan.overrides.push({ target: entityPath, late: renderValue(h), current: null, reason: 'entity-deleted' })
        continue
      }
    }
    node(ctx, entityPath, entityPath, entityPath, b, h)
  }
  // Fix the application order NOW, so the journal can record the planned
  // inserts before any write: descending position; at one position deletes
  // first, then the inserts LAST-planned first, so they read in plan order
  // (without the last rule, ":M" reads as "M:").
  // DEEPEST sequences first: a sequence inside a list element was planned at
  // that element's CURRENT index, which the outer list's own inserts and
  // deletes would shift.
  plan.seq.sort((x, y) => y.target.length - x.target.length)
  for (const seq of plan.seq) {
    const order = new Map(seq.ops.map((op, i) => [op, i]))
    seq.ops.sort((x, y) => (y.pos - x.pos) || ((y.del ? 1 : 0) - (x.del ? 1 : 0)) || (order.get(y)! - order.get(x)!))
    for (const op of seq.ops) if (!op.del) plan.plannedInserts.push({ obj: seq.obj, oldId: op.oldId! })
  }
  return plan
}

function node(ctx: PlanContext, pFrom: Path, pTo: Path, pCur: Path, b: unknown, h: unknown): void {
  if (sameValue(b, h)) return
  const c = currentAt(ctx, pCur)
  const kb = kind(b), kh = kind(h), kc = kind(c)
  if (kb === 'map' && kh === 'map' && kc === 'map') {
    const keys = new Set([...Object.keys(b as object), ...Object.keys(h as object)])
    for (const k of keys) {
      node(ctx, [...pFrom, k], [...pTo, k], [...pCur, k], (b as Record<string, unknown>)[k], (h as Record<string, unknown>)[k])
    }
    return
  }
  if (kb === 'counter' && kh === 'counter' && kc === 'counter') {
    ctx.plan.leaf.push({ kind: 'increment', target: pCur, by: (h as A.Counter).value - (b as A.Counter).value })
    ctx.plan.log.increments += 1
    return
  }
  const sequence = kb === 'list' ? 'list' : kb === 'string' ? 'text' : null
  if (sequence && kb === kh && kc === kb && ctx.target.birthHeads) {
    const fromObj = objectIdAt(ctx.source.doc, ctx.source.from, pFrom)
    const toObj = objectIdAt(ctx.source.doc, ctx.source.to, pTo)
    if (fromObj && fromObj === toObj) {
      const replayed = seqReplay(ctx, pFrom, pTo, pCur, sequence, b, h)
      if (replayed) return
      // The target replaced the sequence since birth: someone else changed
      // that same list after the cut — a clash at sequence granularity.
      ctx.plan.log.seqObjectReplaced += 1
      if (!sameValue(c, h)) {
        ctx.plan.log.conflicts += 1
        ctx.plan.overrides.push({ target: pCur, late: renderValue(h), current: renderValue(c), reason: 'sequence-replaced' })
      }
      return
    }
  }
  // A LEAF: the current epoch wins unless it still holds the late writer's base.
  if (sameValue(c, h)) return
  if (kb === 'absent' ? kc === 'absent' : sameValue(c, b)) {
    ctx.plan.leaf.push(kh === 'absent' ? { kind: 'delete', target: pCur } : { kind: 'put', target: pCur, source: pTo })
    ctx.plan.log.leafWrites += 1
    return
  }
  ctx.plan.log.conflicts += 1
  ctx.plan.overrides.push({ target: pCur, late: renderValue(h), current: renderValue(c), reason: 'leaf' })
}

function seqPlanFor(ctx: PlanContext, pCur: Path, kindName: 'list' | 'text', obj: string): SeqPlan {
  const key = JSON.stringify(pCur)
  let seq = ctx.seqByKey.get(key)
  if (!seq) {
    seq = { target: pCur, kind: kindName, obj, ops: [] }
    ctx.seqByKey.set(key, seq)
    ctx.plan.seq.push(seq)
  }
  return seq
}

/** Element-identity replay of one sequence. False when the target replaced
 * the sequence object since its birth (the caller applies the leaf rule). */
function seqReplay(ctx: PlanContext, pFrom: Path, pTo: Path, pCur: Path, k: 'list' | 'text', bValue: unknown, hValue: unknown): boolean {
  const { source, target } = ctx
  const birth = target.birthHeads!
  // One element per list entry, or per text CODE POINT (`textCharacterIds`);
  // `starts`/`values` only for text.
  const ids = (doc: A.Doc<unknown>, path: Path, heads: Heads | undefined, p2e: ReadonlyMap<string, string>):
    { obj: string | null; ids: string[]; values?: string[]; starts?: number[] } =>
    (k === 'list' ? listElementIds(doc, path, heads, p2e) : textCharacterIds(doc, path, heads))
  const F = ids(source.doc, pFrom, source.from, ctx.sourceP2E)
  const T = ids(source.doc, pTo, source.to, ctx.sourceP2E)
  // Alignment: the old sequence AT THE CUT, element k <-> the target's
  // sequence AT BIRTH, element k (the builder copies in order).
  const align = new Map<string, string>()
  let birthIds: string[] = []
  const cutPath = F.obj ? A.getBackend(source.doc).objInfo(F.obj, source.cut)?.path : undefined
  if (cutPath) {
    const atCut = ids(source.doc, cutPath, source.cut, ctx.sourceP2E)
    const atBirth = ids(target.doc, cutPath, birth, ctx.targetP2E)
    const currentObj = objectIdAt(target.doc, undefined, pCur)
    if (!atBirth.obj || atBirth.obj !== currentObj) return false
    birthIds = atBirth.ids
    atCut.ids.forEach((id, i) => { const mapped = atBirth.ids[i]; if (mapped) align.set(id, mapped) })
  } else {
    // The sequence did not exist at the cut (created late): the target can
    // only hold it if an earlier forward wrote it whole — not aligned.
    return false
  }
  const mapId = (oldId: string) => source.elemMap.get(oldId) ?? align.get(oldId)
  const C = ids(target.doc, pCur, undefined, ctx.targetP2E)
  // Element id -> its index in C, and (text) its UTF-16 start and length.
  const index = new Map(C.ids.map((id, i) => [id, i]))
  const startOf = (i: number) => (k === 'text' ? C.starts![i]! : i)
  const unitsOf = (i: number) => (k === 'text' ? C.values![i]!.length : 1)
  const seq = seqPlanFor(ctx, pCur, k, C.obj!)
  /**
   * Where an insert goes whose left neighbour the target DELETED. Text: the
   * deleted character's cursor still resolves — to the start of the next
   * character after it, which is exactly where Automerge's own "insert after
   * the deleted element" shows (`"ab"`, `a` replaced by `😀`, `Z` after `a`:
   * `"😀Zb"`). Lists have no cursor: right before the nearest element after
   * it, in the target's BIRTH order, that survives; else right after the
   * nearest one before it that does. Undefined when the element is not one
   * this target was born with (the caller then keeps walking left).
   */
  const deletedAnchor = (cid: string): number | undefined => {
    if (k === 'text') {
      try { return A.getBackend(target.doc).getCursorPosition(C.obj!, cid) } catch { return undefined }
    }
    const at = birthIds.indexOf(cid)
    if (at < 0) return undefined
    for (let r = at + 1; r < birthIds.length; r += 1) { const ci = index.get(birthIds[r]!); if (ci !== undefined) return ci }
    for (let l = at - 1; l >= 0; l -= 1) { const ci = index.get(birthIds[l]!); if (ci !== undefined) return ci + 1 }
    return undefined
  }
  const fromIndex = new Map(F.ids.map((id, i) => [id, i]))
  const toSet = new Set(T.ids)
  for (const id of F.ids) {
    if (toSet.has(id)) continue
    const cid = mapId(id)
    if (!cid) { ctx.plan.log.unmapped += 1; continue }
    const ci = index.get(cid)
    if (ci !== undefined) {
      seq.ops.push(k === 'text' ? { pos: startOf(ci), del: true, units: unitsOf(ci) } : { pos: ci, del: true })
      ctx.plan.log.seqDeletes += 1
    }
  }
  for (let i = 0; i < T.ids.length; i += 1) {
    const id = T.ids[i]!
    const fi = fromIndex.get(id)
    if (fi !== undefined) {
      if (k === 'list') {
        // A retained element: its inner changes (a leaf, a nested map, a counter).
        const cid = mapId(id)
        const ci = cid === undefined ? undefined : index.get(cid)
        if (ci !== undefined) node(ctx, [...pFrom, fi], [...pTo, i], [...pCur, ci], (bValue as unknown[])[fi], (hValue as unknown[])[i])
      }
      continue
    }
    if (source.elemMap.has(id)) continue // created in the target by an earlier forward
    let pos = 0
    for (let j = i - 1; j >= 0; j -= 1) {
      const cid = mapId(T.ids[j]!)
      const ci = cid === undefined ? undefined : index.get(cid)
      if (ci !== undefined) { pos = startOf(ci) + unitsOf(ci); break }
      // The left neighbour is known but DELETED in the target (a concurrent
      // delete): anchor where it still is, not at position 0.
      const at = cid === undefined ? undefined : deletedAnchor(cid)
      if (at !== undefined) { pos = at; break }
    }
    seq.ops.push(k === 'text'
      ? { pos, source: [...pTo, i], oldId: id, text: T.values![i]! }
      : { pos, source: [...pTo, i], oldId: id })
    ctx.plan.log.seqInserts += 1
  }
  return true
}

// --------------------------------------------------------------- applying ---

/** The message of a forward's change on one target. One per (journal, target). */
export function forwardMessage(journalId: string, targetDocumentId: string): string {
  return JSON.stringify({ epochForward: journalId, target: targetDocumentId })
}

/**
 * Apply a target plan INSIDE that target's change (a `DocHandle.change`
 * callback, or `A.change` in tests), reading every written value, with its
 * datatype, from the source at `to`. Returns how many `-0` leaves had to be
 * stored as 0 (see `copyTypedValue`).
 */
export function applyTargetPlan(draft: unknown, plan: TargetPlan, source: A.Doc<unknown>, to: Heads): { negativeZeroAsZero: number } {
  let negativeZeroAsZero = 0
  for (const op of plan.leaf) {
    const parent = at(draft, op.target.slice(0, -1)) as Record<string | number, unknown>
    const key = op.target[op.target.length - 1]!
    if (op.kind === 'put') {
      if (copyTypedValue(source, to, op.source, parent, key) === 'negative-zero-as-zero') negativeZeroAsZero += 1
    } else if (op.kind === 'delete') {
      delete parent[key]
    } else if (op.kind === 'copy-served') {
      if (copyTypedValue(op.from, A.getHeads(op.from), op.target, parent, key) === 'negative-zero-as-zero') negativeZeroAsZero += 1
    } else {
      (parent[key] as A.Counter).increment(op.by)
    }
  }
  for (const seq of plan.seq) {
    for (const op of seq.ops) {
      if (seq.kind === 'list') {
        const list = at(draft, seq.target) as unknown[]
        if (op.del) { A.deleteAt(list, op.pos); continue }
        const value = fullValueAt(source, to, op.source!)
        if (value && value[0] === 'f64' && Object.is(value[1], -0)) {
          A.insertAt(list, op.pos, -0) // an insert stores -0 as f64 -0 (measured)
        } else {
          A.insertAt(list, op.pos, null)
          copyTypedValue(source, to, op.source!, list as unknown as Record<number, unknown>, op.pos)
        }
      } else if (op.del) {
        // A whole code point: two code units for one outside the BMP.
        A.splice(draft as A.Doc<unknown>, seq.target as A.Prop[], op.pos, op.units ?? 1)
      } else {
        A.splice(draft as A.Doc<unknown>, seq.target as A.Prop[], op.pos, 0, op.text!)
      }
    }
  }
  return { negativeZeroAsZero }
}

/** The change on `doc` carrying `message`, or undefined. `since`: search only
 * after these heads (a target's birth); the whole history otherwise. */
export function findForwardChange(doc: A.Doc<unknown>, message: string, since?: Heads) {
  // DETERMINISTIC among duplicates (`modelEpochForwardDedupe.ts`): the
  // smallest hash is the CANONICAL change, whichever replica looks.
  return A.getChangesMetaSince(doc, since ?? [])
    .filter((meta) => meta.message === message)
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))[0]
}

/**
 * The element ids a forward's change CREATED, rebuilt from storage alone: the
 * change's insert ops on the planned sequence objects, in op order, zipped
 * with the journal's `plannedInserts` (recorded in application order). Null
 * when the change is absent or its inserts do not match the plan's count
 * (refuse rather than mis-anchor a later forward).
 */
export function rebuildElemMap(doc: A.Doc<unknown>, message: string, plannedInserts: readonly PlannedInsert[], since?: Heads): Map<string, string> | null {
  const meta = findForwardChange(doc, message, since)
  if (!meta) return null
  const change = A.inspectChange(doc, meta.hash)
  if (!change) return null
  const objects = new Set(plannedInserts.map((p) => p.obj))
  const out = new Map<string, string>()
  let n = 0
  change.ops.forEach((op, index) => {
    const insert = op as { insert?: boolean; obj?: string }
    if (insert.insert && insert.obj && objects.has(insert.obj) && n < plannedInserts.length) {
      out.set(plannedInserts[n]!.oldId, `${change.startOp + index}@${change.actor}`)
      n += 1
    }
  })
  return n === plannedInserts.length ? out : null
}
