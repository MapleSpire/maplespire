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
import {
  META_URL_FORMAT_FIELD,
  META_URL_FORMAT_SCALAR,
  META_URL_HEAD_FIELDS,
  META_URL_LIST_FIELDS,
  SCALAR_META_URL_FIELD,
  readMetaUrl,
  readMetaUrls,
} from './modelMetaUrls.js'

/**
 * ModelMeta and base-shard EPOCHS (G4-16f) — the BUILDERS.
 *
 * An epoch document is a FRESH Automerge document whose ONE change writes the
 * state of its predecessor at the cut heads `H_cut`: the same keys, the same
 * values, and the same STORED DATATYPES, with none of the history. Pure: no
 * Repo, no storage, no SQL. The roll (`modelEpochRoll.ts`) creates and
 * flushes what these return.
 *
 * WHY NOT `A.clone` — it keeps the history, which is the thing being dropped.
 * WHY NOT A JSON COPY — it loses `ImmutableString`, counters, dates, bytes and
 * the int/uint/f64 distinction.
 * WHY NOT `A.from(materialized)` — measured on 3.2.6: a NESTED literal
 * encodes numbers by value (positive integers `int`, everything else `f64`),
 * so a stored `int -5` would come back `f64`; and an `Int`/`Uint`/`Float64`
 * wrapper inside a nested literal, or inserted into a list, is written as a
 * MAP. Only a scalar put (a map key or a list index) honours the wrappers.
 *
 * So the copy reads every value WITH ITS DATATYPE from the backend
 * (`getWithType` at `H_cut`) and writes it in the one way each datatype
 * survives (see {@link writeTyped}). `-0` is the one value no scalar put can
 * store (`Float64(-0)` stores `0`, a plain `-0` put stores `int 0`, both
 * measured); a NESTED `-0` stores `f64 -0`,
 * so a map holding one is created as a literal of its `-0` keys, and a list
 * element is inserted plain (an insert encodes `-0` as `f64 -0`, measured).
 * `typedEqual` is the check: the builders' tests assert it key by key,
 * datatype by datatype.
 *
 * The builders write each root object as ONE nested literal of the values a
 * literal does store exactly, then scalar-put the rest at their paths in the
 * same change ({@link writeLiteralTyped}, 3.3x faster than a proxy write per
 * value, diagnosis S3); {@link writeTyped} remains the per-value writer of
 * root scalars and of the forwarder ({@link copyTypedValue}).
 *
 * A key holding CONFLICTING values (two concurrent puts) is copied as its
 * winner: an epoch is a state, and the state shows the winner.
 */

type Heads = A.Heads
type ObjId = string
type Backend = ReturnType<typeof A.getBackend>
type FullValue = NonNullable<ReturnType<Backend['getWithType']>>

export class EpochBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EpochBuildError'
  }
}

const isNegativeZero = (value: unknown) => typeof value === 'number' && Object.is(value, -0)

/** A scalar `FullValue` as the value to PUT at a map key or list index so that
 * it is stored with the same datatype. Never called for `-0` (handled by the
 * callers) nor for objects. */
function scalarPut(value: FullValue): unknown {
  const [type, raw] = value
  switch (type) {
    case 'str': return new A.ImmutableString(raw as string)
    case 'int': return raw as number
    case 'uint': return new A.Uint(Number(raw))
    // NaN: a plain put stores f64 NaN, `Float64(NaN)` stores 0 (measured).
    case 'f64': return Number.isNaN(raw) ? raw : new A.Float64(raw as number)
    case 'counter': return new A.Counter(raw as number)
    case 'timestamp': return new Date((raw as Date).getTime())
    case 'bytes': return (raw as Uint8Array).slice()
    case 'boolean': return raw
    case 'null': return null
    default: throw new EpochBuildError(`not a scalar datatype: ${type}`)
  }
}

/** Write the value `source` holds at `(obj, prop)` at `heads` into the change
 * proxy `parent[key]`. */
function writeTyped(
  be: Backend, heads: Heads, value: FullValue, parent: Record<string | number, unknown>, key: string | number,
): void {
  const [type, raw] = value
  if (type === 'map' || type === 'table') {
    const obj = raw as ObjId
    const keys = be.keys(obj, heads)
    // `-0` keys go into the creating literal (a nested -0 is stored f64 -0);
    // every other key is put afterwards, with its own datatype.
    const negativeZeroKeys: Record<string, number> = {}
    for (const k of keys) {
      const v = be.getWithType(obj, k, heads)
      if (v && v[0] === 'f64' && isNegativeZero(v[1])) negativeZeroKeys[k] = -0
    }
    parent[key] = negativeZeroKeys
    const target = parent[key] as Record<string, unknown>
    for (const k of keys) {
      if (k in negativeZeroKeys) continue
      const v = be.getWithType(obj, k, heads)
      if (v) writeTyped(be, heads, v, target, k)
    }
    return
  }
  if (type === 'list') {
    const obj = raw as ObjId
    parent[key] = []
    const target = parent[key] as unknown[]
    const length = be.length(obj, heads)
    for (let i = 0; i < length; i += 1) {
      const v = be.getWithType(obj, i, heads)
      if (!v) throw new EpochBuildError(`list element ${i} unreadable`)
      const [elementType, elementRaw] = v
      if (elementType === 'map' || elementType === 'table' || elementType === 'list' || elementType === 'text') {
        // A placeholder slot, then the object written into it by index.
        target.push(null)
        writeTyped(be, heads, v, target as unknown as Record<number, unknown>, i)
      } else if (elementType === 'f64' && isNegativeZero(elementRaw)) {
        target.push(-0) // an insert encodes -0 as f64 -0 (measured)
      } else {
        // Insert, then PUT at the index: an insert of a wrapper writes a map,
        // a put honours it (measured).
        target.push(null)
        target[i] = scalarPut(v)
      }
    }
    return
  }
  if (type === 'text') {
    parent[key] = be.text(raw as ObjId, heads)
    return
  }
  if (type === 'f64' && isNegativeZero(raw)) {
    // Only reachable for a ROOT key (maps handle their own -0 keys): the root
    // is created by `A.init`, so the literal trick does not apply. Refuse
    // rather than store a different value.
    throw new EpochBuildError(`a -0 at the document root (${String(key)}) cannot be copied`)
  }
  parent[key] = scalarPut(value)
}

/**
 * A scalar whose datatype a NESTED literal stores exactly as `getWithType`
 * reports it (measured on 3.2.6): a positive `int`, an `f64` that is not a positive
 * integer (`-0` and `NaN` included), and every non-number kind but `uint`.
 * Everything else — `int` ≤ 0, an integral positive `f64`, `uint` — would
 * change kind (or, as a wrapper, become a map) and is written by a scalar put
 * after the literal instead.
 */
function literalKeepsDatatype(value: FullValue): boolean {
  const [type, raw] = value
  if (type === 'int') return typeof raw === 'number' && raw > 0
  if (type === 'f64') return !(Number.isInteger(raw) && (raw as number) > 0)
  return type !== 'uint'
}

/** A scalar put deferred until the literal it belongs to is in the document:
 * the container's path below the root key, the key or index, the value. */
interface DeferredPut {
  path: Array<string | number>
  key: string | number
  value: FullValue
}

/**
 * The object at `(type, raw)` at `heads` as ONE plain literal, with the puts
 * the literal cannot spell collected in `deferred` (their slot holds `null`).
 * Text becomes a JS string (a nested string is stored as text), a `str` an
 * `ImmutableString`, a counter a `Counter`, dates and bytes as themselves.
 */
function literalTyped(
  be: Backend, heads: Heads, value: FullValue, path: Array<string | number>, deferred: DeferredPut[],
): unknown {
  const [type, raw] = value
  if (type === 'map' || type === 'table') {
    const out: Record<string, unknown> = {}
    for (const k of be.keys(raw as ObjId, heads)) {
      const v = be.getWithType(raw as ObjId, k, heads)
      if (v) out[k] = literalSlot(be, heads, v, path, k, deferred)
    }
    return out
  }
  if (type === 'list') {
    const length = be.length(raw as ObjId, heads)
    const out: unknown[] = new Array(length)
    for (let i = 0; i < length; i += 1) {
      const v = be.getWithType(raw as ObjId, i, heads)
      if (!v) throw new EpochBuildError(`list element ${i} unreadable`)
      out[i] = literalSlot(be, heads, v, path, i, deferred)
    }
    return out
  }
  if (type === 'text') return be.text(raw as ObjId, heads)
  throw new EpochBuildError(`not an object datatype: ${type}`)
}

function literalSlot(
  be: Backend, heads: Heads, v: FullValue, path: Array<string | number>, key: string | number, deferred: DeferredPut[],
): unknown {
  const type = v[0]
  if (type === 'map' || type === 'table' || type === 'list' || type === 'text') {
    return literalTyped(be, heads, v, [...path, key], deferred)
  }
  if (literalKeepsDatatype(v)) {
    // `-0` stays a plain `-0`: a nested `-0` is stored `f64 -0` (measured).
    return type === 'f64' || type === 'int' || type === 'boolean' || type === 'null' ? v[1] : scalarPut(v)
  }
  deferred.push({ path, key, value: v })
  return null
}

/** The value at `path` in `doc` at `heads`, with its datatype, or null when
 * any step of the path is absent. List steps are indices AT `heads`. */
export function fullValueAt(doc: A.Doc<unknown>, heads: Heads | undefined, path: ReadonlyArray<string | number>): FullValue | null {
  const be = A.getBackend(doc)
  let obj: ObjId = '_root'
  let value: FullValue | null = null
  for (let i = 0; i < path.length; i += 1) {
    value = be.getWithType(obj, path[i]!, heads) ?? null
    if (!value) return null
    if (i < path.length - 1) {
      const [type, raw] = value
      if (type !== 'map' && type !== 'table' && type !== 'list') return null
      obj = raw as ObjId
    }
  }
  return value
}

/** The object id at `path` (a map, list or text) at `heads`, or null. */
export function objectIdAt(doc: A.Doc<unknown>, heads: Heads | undefined, path: ReadonlyArray<string | number>): string | null {
  const value = path.length === 0 ? (['map', '_root'] as FullValue) : fullValueAt(doc, heads, path)
  if (!value) return null
  const [type, raw] = value
  return type === 'map' || type === 'table' || type === 'list' || type === 'text' ? (raw as string) : null
}

/**
 * Write, into the change proxy `parent[key]`, the value `source` holds at
 * `sourcePath` at `heads`, WITH ITS DATATYPE — the same copy the builders use.
 * For the epoch forwarder (`modelEpochForward.ts`): a forwarded leaf or a
 * forwarded created entity keeps its kind exactly as a recreated epoch does.
 * `'absent'` when the source has nothing at that path.
 */
export function copyTypedValue(
  source: A.Doc<unknown>, heads: Heads, sourcePath: ReadonlyArray<string | number>,
  parent: Record<string | number, unknown>, key: string | number,
): 'written' | 'absent' | 'negative-zero-as-zero' {
  const value = fullValueAt(source, heads, sourcePath)
  if (!value) return 'absent'
  if (value[0] === 'f64' && isNegativeZero(value[1])) {
    // A -0 LEAF written into an EXISTING map: no scalar put stores it, and the
    // enclosing map is not ours to re-create (that would orphan a concurrent
    // writer's edits inside it). Stored as the closest put, int 0, and said
    // so to the caller, which logs it.
    parent[key] = 0
    return 'negative-zero-as-zero'
  }
  writeTyped(A.getBackend(source), heads, value, parent, key)
  return 'written'
}

/**
 * THE LITERAL BUILDER (G4-16f, roll step S3): the root key `key` of the copy,
 * written as ONE nested literal assignment, then the few puts a literal cannot
 * spell (`literalKeepsDatatype`) at their paths, inside the SAME change. The
 * per-value proxy writes of {@link writeTyped} were ~85 % of a roll's S3
 * (measured); a literal is one call into
 * the backend. Same state and datatypes as {@link writeTyped}, pinned against
 * it by `modelEpochs.test.ts` ("the literal builder equals the proxy-write
 * builder"). A root scalar is a scalar put, as before (the `-0` refusal kept).
 */
function writeLiteralTyped(
  be: Backend, heads: Heads, value: FullValue, root: Record<string | number, unknown>, key: string,
): void {
  const type = value[0]
  if (type !== 'map' && type !== 'table' && type !== 'list') {
    writeTyped(be, heads, value, root, key)
    return
  }
  const deferred: DeferredPut[] = []
  root[key] = literalTyped(be, heads, value, [], deferred)
  for (const put of deferred) {
    let target = root[key] as Record<string | number, unknown>
    for (const step of put.path) target = target[step] as Record<string | number, unknown>
    target[put.key] = scalarPut(put.value)
  }
}

/** The state of `source` at `heads`, in a fresh document with ONE change.
 * `omitRootKeys` are left out (the meta builder writes them itself). */
export function buildEpochDocument<T>(
  source: A.Doc<unknown>,
  heads: Heads,
  options: { actor?: string; omitRootKeys?: ReadonlySet<string>; extra?: (root: Record<string, unknown>) => void } = {},
): A.Doc<T> {
  const be = A.getBackend(source)
  // A NAMED refusal. Automerge 3.2.6 throws on its own for heads it does not
  // have (the mutant removing this line survives the test that expects a
  // throw), but with a message that names no epoch and no cut.
  if (!A.hasHeads(source, heads)) throw new EpochBuildError('the source does not contain the cut heads')
  const init = A.init<T>(options.actor ? { actor: options.actor } : undefined)
  const doc = A.change(init, (draft) => {
    const root = draft as unknown as Record<string, unknown>
    for (const key of be.keys('_root', heads)) {
      if (options.omitRootKeys?.has(key)) continue
      const v = be.getWithType('_root', key, heads)
      if (v) writeLiteralTyped(be, heads, v, root, key)
    }
    options.extra?.(root)
  })
  if (A.getAllChanges(doc).length !== 1) throw new EpochBuildError('an epoch document must hold exactly one change')
  return doc
}

/** A base shard of the new epoch: the old shard's state at `H_cut`. */
export function buildEpochShard<T>(source: A.Doc<unknown>, cutHeads: Heads, actor?: string): A.Doc<T> {
  return buildEpochDocument<T>(source, cutHeads, { actor })
}

/** Root keys of an epoch ModelMeta that the builder writes itself and the
 * forwarder must never carry: the six text-mirror fields, the
 * six scalar URL fields, the marker and the epoch hints. */
export const EPOCH_META_HINT_FIELDS = ['modelEpoch', 'epochPredecessorRef', 'epochSlots', 'epochSuccessorRef'] as const
export const EPOCH_META_BUILDER_KEYS: ReadonlySet<string> = new Set<string>([
  ...META_URL_LIST_FIELDS, ...META_URL_HEAD_FIELDS,
  ...[...META_URL_LIST_FIELDS, ...META_URL_HEAD_FIELDS].map((f) => SCALAR_META_URL_FIELD[f]),
  META_URL_FORMAT_FIELD,
  ...EPOCH_META_HINT_FIELDS,
])

export interface EpochMetaPlan {
  /** The new epoch's number (≥ 1). */
  epoch: number
  /** The predecessor ModelMeta's URL. */
  predecessorUrl: string
  /** For each OLD base-list URL that is a base shard (not an overlay segment):
   * its URL in the new epoch — a recreated shard (full epoch) or itself
   * (carried, meta-only epoch). A URL absent from this map is an overlay
   * segment and is kept as-is, in its place after the base shards. */
  baseShardUrl: (oldUrl: string) => string | undefined
  actor?: string
}

export interface EpochMetaLists {
  objectShardUrls: string[]
  connectionShardUrls: string[]
  editsObjectShardUrls: string[]
  editsConnectionShardUrls: string[]
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
  /** Slot order of the new base shards, objects then connections. */
  slots: string[]
}

/**
 * The URL fields of the new ModelMeta from the predecessor's RULING values at
 * the cut (`readMetaUrls`, text or scalar by its marker): every base shard
 * replaced IN PLACE by its new-epoch URL (`baseShardUrl`), every overlay
 * segment kept as-is, and the ORDER UNCHANGED.
 *
 * In place, not "base first, then overlays": the list order is precedence —
 * a later shard wins an entity over an earlier one for every reader (the cold
 * build, the browser) — and a base shard CAN follow an overlay segment: a
 * resident browser appends its overflow shard at the END
 * (`bridge.ts` `publishModelShardReference`), after the segments and the
 * head. Moving it in front of them would hand those entities to the overlay
 * and change what is served. (A "base before overlay" order would reorder
 * exactly this case, so the builder keeps the order instead —
 * the mutant that reorders is killed by `modelEpochs.test.ts`, "keeps an
 * interleaved order".) Pure, exported for its own tests.
 */
export function planEpochMetaLists(predecessorAtCut: unknown, plan: Pick<EpochMetaPlan, 'baseShardUrl'>): EpochMetaLists {
  const slots: string[] = []
  const split = (field: 'objectShardUrls' | 'connectionShardUrls') => {
    const out: string[] = []
    for (const url of readMetaUrls(predecessorAtCut, field) ?? []) {
      const mapped = plan.baseShardUrl(url)
      if (mapped === undefined) out.push(url)
      else { out.push(mapped); slots.push(mapped) }
    }
    return out
  }
  const objectShardUrls = split('objectShardUrls')
  const connectionShardUrls = split('connectionShardUrls')
  const lists: EpochMetaLists = {
    objectShardUrls,
    connectionShardUrls,
    editsObjectShardUrls: readMetaUrls(predecessorAtCut, 'editsObjectShardUrls') ?? [],
    editsConnectionShardUrls: readMetaUrls(predecessorAtCut, 'editsConnectionShardUrls') ?? [],
    slots,
  }
  const objectHead = readMetaUrl(predecessorAtCut, 'editsObjectShardUrl')
  const connectionHead = readMetaUrl(predecessorAtCut, 'editsConnectionShardUrl')
  if (objectHead !== undefined) lists.editsObjectShardUrl = objectHead
  if (connectionHead !== undefined) lists.editsConnectionShardUrl = connectionHead
  return lists
}

/**
 * The new epoch's ModelMeta, BORN SCALAR-NATIVE: in its one change, every
 * non-URL key of the predecessor at `H_cut`
 * (unknown keys included), the marker, ALL FOUR scalar lists (empty ones
 * included) and the two scalar heads, the FROZEN TEXT MIRROR — the four old
 * text lists always present (so an old client's `if (!m.f) m.f = []` can
 * never fire and race another) and the two text heads when the
 * predecessor has them — and the epoch hints.
 *
 * The text heads are written only when they exist: a head is a scalar
 * assignment, not a container, so there is no list object two old clients
 * could race to create, and no old client writes a head (the browser never
 * rotates, `bridge.ts`); an empty string would read as "invalid" exactly as
 * an absent field does.
 */
export function buildEpochMeta<T>(predecessor: A.Doc<unknown>, cutHeads: Heads, plan: EpochMetaPlan): A.Doc<T> {
  if (!Number.isSafeInteger(plan.epoch) || plan.epoch < 1) throw new EpochBuildError(`bad epoch number ${plan.epoch}`)
  const atCut = A.view(predecessor, cutHeads)
  const lists = planEpochMetaLists(atCut, plan)
  return buildEpochDocument<T>(predecessor, cutHeads, {
    actor: plan.actor,
    omitRootKeys: EPOCH_META_BUILDER_KEYS,
    extra: (root) => {
      for (const field of META_URL_LIST_FIELDS) {
        root[SCALAR_META_URL_FIELD[field]] = lists[field].map((url) => new A.ImmutableString(url))
        root[field] = [...lists[field]] // text mirror, frozen at birth
      }
      for (const field of META_URL_HEAD_FIELDS) {
        const url = lists[field]
        if (url === undefined) continue
        root[SCALAR_META_URL_FIELD[field]] = new A.ImmutableString(url)
        root[field] = url
      }
      root[META_URL_FORMAT_FIELD] = META_URL_FORMAT_SCALAR
      root.modelEpoch = plan.epoch
      root.epochPredecessorRef = new A.ImmutableString(plan.predecessorUrl)
      root.epochSlots = lists.slots.map((url) => new A.ImmutableString(url))
    },
  })
}

/**
 * Deep equality of two documents' states WITH DATATYPES: the same keys, the
 * same list lengths, the same `getWithType` datatype and value at every leaf,
 * text by content. Object ids are not compared (they differ by construction).
 * `-0` and `0` differ; `NaN` equals `NaN`. Returns the first difference's
 * path, or null.
 */
export function typedDifference(
  a: A.Doc<unknown>, aHeads: Heads, b: A.Doc<unknown>, bHeads: Heads, options: { omitRootKeys?: ReadonlySet<string> } = {},
): string | null {
  const ba = A.getBackend(a)
  const bb = A.getBackend(b)
  const compare = (va: FullValue | null, vb: FullValue | null, path: string): string | null => {
    if (!va || !vb) return va === vb ? null : path
    if (va[0] !== vb[0]) return `${path} (${va[0]} vs ${vb[0]})`
    const type = va[0]
    if (type === 'map' || type === 'table') {
      const ka = ba.keys(va[1] as ObjId, aHeads).sort()
      const kb = bb.keys(vb[1] as ObjId, bHeads).sort()
      if (ka.join('\u0001') !== kb.join('\u0001')) return `${path} (keys)`
      for (const k of ka) {
        const d = compare(ba.getWithType(va[1] as ObjId, k, aHeads), bb.getWithType(vb[1] as ObjId, k, bHeads), `${path}.${k}`)
        if (d) return d
      }
      return null
    }
    if (type === 'list') {
      const la = ba.length(va[1] as ObjId, aHeads)
      if (la !== bb.length(vb[1] as ObjId, bHeads)) return `${path} (length)`
      for (let i = 0; i < la; i += 1) {
        const d = compare(ba.getWithType(va[1] as ObjId, i, aHeads), bb.getWithType(vb[1] as ObjId, i, bHeads), `${path}[${i}]`)
        if (d) return d
      }
      return null
    }
    if (type === 'text') return ba.text(va[1] as ObjId, aHeads) === bb.text(vb[1] as ObjId, bHeads) ? null : `${path} (text)`
    const [ra, rb] = [va[1], vb[1]]
    if (ra instanceof Date && rb instanceof Date) return ra.getTime() === rb.getTime() ? null : path
    if (ra instanceof Uint8Array && rb instanceof Uint8Array) {
      return ra.length === rb.length && ra.every((x, i) => x === rb[i]) ? null : path
    }
    if (typeof ra === 'bigint' || typeof rb === 'bigint') return String(ra) === String(rb) ? null : path
    return Object.is(ra, rb) ? null : `${path} (${String(ra)} vs ${String(rb)})`
  }
  const keysA = ba.keys('_root', aHeads).filter((k) => !options.omitRootKeys?.has(k)).sort()
  const keysB = bb.keys('_root', bHeads).filter((k) => !options.omitRootKeys?.has(k)).sort()
  if (keysA.join('\u0001') !== keysB.join('\u0001')) return '(root keys)'
  for (const k of keysA) {
    const d = compare(ba.getWithType('_root', k, aHeads), bb.getWithType('_root', k, bHeads), k)
    if (d) return d
  }
  return null
}
