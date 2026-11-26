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
 * The ModelMeta's URL fields — base-shard lists, overlay segment lists and the
 * two current write heads — read and written through ONE module (G4-16f).
 *
 * WHY. In Automerge 3 a JS string assigned into a document is collaborative
 * TEXT: one operation per character, so every URL written costs ~39
 * operations (measured in `modelMetaUrls.test.ts`), and the ModelMeta's
 * rotations and folds write URLs for ever. An `ImmutableString` is ONE scalar
 * operation. The probe behind this design measured 651 301 operations as text against
 * 16 701 as scalars for the same 16 700 list edits.
 *
 * WHY TWO FIELDS. An `ImmutableString` reads back as an OBJECT, not a string:
 * `typeof` is `'object'`, `=== url`, `includes(url)` and `indexOf(url)` all
 * miss, and `isValidAutomergeUrl` returns false (`typeof str !== 'string'`).
 * A build from before this module filters its head lists through
 * `isValidAutomergeUrl` (`bridge.ts` `orderedObjectOverlayUrls`) and decides
 * its write mode from `isValidUrl(meta.editsObjectShardUrl)`
 * (`overlayWriteHead.ts` `planBfsWriteMode`): a scalar in the OLD field would
 * silently drop every segment and send that client to `bfs-degraded`. So the
 * scalars live in NEW fields ({@link SCALAR_META_URL_FIELD}) and the old text
 * fields are left exactly as old builds expect them.
 *
 * TWO PHASES, chosen per document by {@link META_URL_FORMAT_FIELD}:
 *
 *  - TEXT authority (the marker absent — every document today): the old text
 *    fields are what every reader reads AND the only fields written. Each
 *    write leaves the SAME resulting list as before this module; its ops are
 *    the same op for op for an append, a plain removal and the rotator's
 *    reorder, the same op set for a fold window, and fewer (nothing after the
 *    slot re-created) for a middle insertion — see `rewriteUrlListInPlace`.
 *    Old and new builds write the same field, so an OLD client's splice
 *    concurrent with a NEW server's write is an ordinary concurrent edit of
 *    one Automerge list and merges as it always has. No scalar shadow is kept in this phase: it
 *    would cost one more operation per write and a one-time copy of every
 *    list on each document's first write (measured: `overlaySegments.
 *    history.test.ts` went red on it), and buy nothing the cut-over does not
 *    re-derive anyway.
 *  - SCALAR authority (the marker present): readers read the scalar fields,
 *    writers write only them, and the old text fields are a FROZEN mirror.
 *    This is where the ModelMeta stops growing ~39 operations per URL.
 *
 * NO DOCUMENT IS EVER CUT OVER IN PLACE (G4-16f). A scalar-ruled
 * ModelMeta is BORN so: an epoch roll builds a fresh document whose first
 * change carries the marker, all four scalar lists and the frozen text mirror
 * (`modelEpochs.ts` `buildEpochMeta`). The in-place cut-over that this module
 * used to take on a server's first write under `AM_META_URL_SCALAR=on` is
 * gone, switch included, and with it its two hazards:
 *
 *  (a) a TEXT write crossing an in-place cut-over was lost to scalar readers.
 *      Now a text-ruled ModelMeta stays text-ruled for life; once an epoch
 *      supersedes it, every write after its cut heads is a late write that
 *      the epoch forwarder carries (`readModel/modelEpochForwarder.ts`);
 *  (b) two servers cutting over concurrently each created a list with `[]`.
 *      An epoch meta has every list from its first change, so `writeList`'s
 *      `= []` never runs on one, and its single creator is serialized by the
 *      `model-epoch:` key and the epoch rows.
 *
 * {@link adoptScalarMetaUrls} remains, for tests and as the documented shape
 * of a scalar-ruled document; no production writer calls it.
 *
 * The browser has a copy of the READ and WRITE half
 * (`src/lib/automerge/modelMetaUrls.ts`) — the server's `rootDir` forbids a
 * shared import. With no cut-over left the two copies are IDENTICAL, byte
 * for byte (`src/lib/automerge/modelMetaUrls.conformance.test.ts`).
 *
 * ⚠ COMPILED BY THE CLIENT'S TSCONFIG TOO, through that root conformance
 * test (the same mechanism `modelMeta.ts`'s header describes): keep it plain
 * — no enum, no namespace, no parameter property.
 */
import { ImmutableString } from '@automerge/automerge-repo'

export type MetaUrlListField =
  | 'objectShardUrls'
  | 'connectionShardUrls'
  | 'editsObjectShardUrls'
  | 'editsConnectionShardUrls'

export type MetaUrlHeadField = 'editsObjectShardUrl' | 'editsConnectionShardUrl'

export type MetaUrlField = MetaUrlListField | MetaUrlHeadField

/** Old (text) field → its scalar counterpart. */
export const SCALAR_META_URL_FIELD = {
  objectShardUrls: 'objectShardRefs',
  connectionShardUrls: 'connectionShardRefs',
  editsObjectShardUrls: 'editsObjectShardRefs',
  editsConnectionShardUrls: 'editsConnectionShardRefs',
  editsObjectShardUrl: 'editsObjectShardRef',
  editsConnectionShardUrl: 'editsConnectionShardRef',
} as const satisfies Record<MetaUrlField, string>

export const META_URL_LIST_FIELDS: readonly MetaUrlListField[] = [
  'objectShardUrls', 'connectionShardUrls', 'editsObjectShardUrls', 'editsConnectionShardUrls',
]
export const META_URL_HEAD_FIELDS: readonly MetaUrlHeadField[] = [
  'editsObjectShardUrl', 'editsConnectionShardUrl',
]

/** The marker field and the value that means "the scalar fields rule". */
export const META_URL_FORMAT_FIELD = 'metaUrlFormat'
export const META_URL_FORMAT_SCALAR = 2

type MetaRecord = Record<string, unknown>

/**
 * ONE element of a URL field as a string, whatever it is stored as: text
 * reads back as a `string`, a scalar as an `ImmutableString` (`.val`).
 *
 * DUCK-TYPED on a string `.val`, and deliberately NOT `isImmutableString`:
 * Automerge 3.2.6's list proxy answers `true` to that (measured in
 * `modelMetaUrls.test.ts`, which also pins that a list reads as invalid
 * here), and not `instanceof` or `constructor.name` either, because a
 * minified browser bundle renames classes. No array guard: a list's `.val`
 * is never a string, and a mutant removing such a guard survived the whole
 * suite — a guard no input can fail is not kept.
 *
 * `undefined` for an absent value. Anything else (a corrupt element) becomes
 * a string that no URL check accepts, so a reader that validates still
 * rejects it and one that does not still fails on it, as before.
 */
export function metaUrlValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const val = (value as { val?: unknown }).val
    if (typeof val === 'string') return val
  }
  return `invalid:${typeof value}`
}

/**
 * ONE list ELEMENT as a string: {@link metaUrlValue}, with an absent element
 * (`null`) read as `invalid:object` too, so a list read keeps its positions.
 * The ONE normalisation both {@link readMetaUrls} and the in-place edit use:
 * a target read through the former matches an unreadable element in place,
 * and the edit leaves it alone (`modelMetaUrls.test.ts`, "an unreadable
 * element is left in place").
 */
export function elementUrl(value: unknown): string {
  return metaUrlValue(value) ?? `invalid:${typeof value}`
}

/** True when the document's URL fields are ruled by their scalar copies. */
export function metaUrlsAreScalar(meta: unknown): boolean {
  return typeof meta === 'object' && meta !== null
    && (meta as MetaRecord)[META_URL_FORMAT_FIELD] === META_URL_FORMAT_SCALAR
}

function authorityKey(meta: unknown, field: MetaUrlField): string {
  return metaUrlsAreScalar(meta) ? SCALAR_META_URL_FIELD[field] : field
}

/**
 * THE read of a URL list: the ruling field's elements as strings, in order,
 * duplicates kept (callers that dedupe still do). `undefined` when the ruling
 * field is absent or not a list — the same shape a raw read had, so
 * `readMetaUrls(m, f) ?? []` replaces `m.f ?? []` one for one.
 */
export function readMetaUrls(meta: unknown, field: MetaUrlListField): string[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const raw = (meta as MetaRecord)[authorityKey(meta, field)]
  if (!Array.isArray(raw)) return undefined
  return raw.map(elementUrl)
}

/** THE read of a current write head, as a string. */
export function readMetaUrl(meta: unknown, field: MetaUrlHeadField): string | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  return metaUrlValue((meta as MetaRecord)[authorityKey(meta, field)])
}

function readCopy(meta: unknown, key: string): string[] | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const raw = (meta as MetaRecord)[key]
  if (!Array.isArray(raw)) return raw === undefined || raw === null ? undefined : [metaUrlValue(raw)!]
  return raw.map(elementUrl)
}

/**
 * Every URL a field names in EITHER copy — the ruling one first, then what
 * only the other names. For REFERENCE closures only (GC marking, the document
 * scope walk, repair censuses), where naming a document must keep it: after
 * the cut-over the frozen text field still names what an old client may ask
 * for (and a copy left by a crash between writes is harmless here). Never
 * for an ORDER (last-wins reads use {@link readMetaUrls}). `undefined` when
 * neither copy exists, so an absent-list check keeps its meaning.
 */
export function readMetaUrlsUnion(meta: unknown, field: MetaUrlField): string[] | undefined {
  const ruling = metaUrlsAreScalar(meta) ? SCALAR_META_URL_FIELD[field] : field
  const other = ruling === field ? SCALAR_META_URL_FIELD[field] : field
  const first = readCopy(meta, ruling)
  const second = readCopy(meta, other)
  if (!first && !second) return undefined
  const out = [...(first ?? [])]
  const seen = new Set(out)
  for (const url of second ?? []) if (!seen.has(url)) { seen.add(url); out.push(url) }
  return out
}

/** The six fields at once, under their OLD names, as plain strings — for a
 * reader that hands a whole ModelMeta to code written against the old shape. */
export interface MetaUrlView {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrls?: string[]
  editsConnectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
}

export function readMetaUrlView(meta: unknown): MetaUrlView {
  const view: MetaUrlView = {}
  for (const field of META_URL_LIST_FIELDS) {
    const urls = readMetaUrls(meta, field)
    if (urls) view[field] = urls
  }
  for (const field of META_URL_HEAD_FIELDS) {
    const url = readMetaUrl(meta, field)
    if (url !== undefined) view[field] = url
  }
  return view
}

/**
 * `meta` with its six URL fields replaced by their RULING values as plain
 * strings under the OLD names, and WITHOUT the scalar copies or the marker —
 * a shallow copy; for a MATERIALIZED document (`handle.doc()`), never a
 * change proxy.
 *
 * Stripped, not kept: the copy reads the same through every reader (old
 * names, or {@link readMetaUrls}, which then finds no marker), and a copy
 * used to seed a NEW document (a fork, a reseeded control meta) cannot carry
 * a marker that points at stale copies — a JSON copy of a scalar-ruled
 * document keeps the marker and the scalars as plain strings, and a caller
 * that rewrites the OLD fields (remapped, pruned) would leave the new
 * document reading the source's shards. A new document is born under text
 * authority and is cut over by its first server write when the switch is on.
 * Tested in `modelMetaUrls.test.ts` ("a view keeps no marker").
 */
export function withMetaUrlView<T extends object>(meta: T): T {
  const copy: MetaRecord = { ...(meta as MetaRecord) }
  for (const field of [...META_URL_LIST_FIELDS, ...META_URL_HEAD_FIELDS]) {
    delete copy[field]
    delete copy[SCALAR_META_URL_FIELD[field]]
  }
  delete copy[META_URL_FORMAT_FIELD]
  return Object.assign(copy, readMetaUrlView(meta)) as T
}

/** Above this many cells of the TRIMMED middle the matching falls back to the
 * greedy pass (rare: the callers' edits are appends, removals and one-slot
 * substitutions, which the trim reduces to a middle of a few elements). */
const LCS_CELL_CEILING = 4_000_000

/**
 * Which elements of `values` are KEPT when the list becomes `target`, as a
 * mask, and which target positions they fill. Pure.
 *
 * The common prefix and suffix are kept first (an append, a removal and a
 * fold's one-slot substitution are then O(n) with a middle of a few
 * elements); the middle is matched by a longest common subsequence. On a tie
 * the LIST element is dropped rather than the target one inserted — the
 * choice that makes the ops identical to the greedy pass where the greedy
 * pass re-creates nothing (`modelMetaUrls.test.ts`, "op for op"). Above the
 * cell ceiling the middle falls back to the greedy prefix match, which
 * still yields `target`, only with more ops.
 */
/** What the LAST in-place edit computed, for the tests only: the cells of its
 * LCS table (0 when the trim left nothing to match, -1 when the middle fell
 * back to the greedy pass). Observable, so the trim is pinned by a number and
 * not by a timing. */
export const metaUrlEditStats = { lastLcsCells: 0 }

function keptElements(values: readonly string[], target: readonly string[]): boolean[] {
  metaUrlEditStats.lastLcsCells = 0
  const n = values.length
  const m = target.length
  const kept = new Array<boolean>(n).fill(false)
  let prefix = 0
  while (prefix < n && prefix < m && values[prefix] === target[prefix]) { kept[prefix] = true; prefix += 1 }
  let suffix = 0
  while (suffix < n - prefix && suffix < m - prefix && values[n - 1 - suffix] === target[m - 1 - suffix]) {
    kept[n - 1 - suffix] = true
    suffix += 1
  }
  const mn = n - prefix - suffix
  const mm = m - prefix - suffix
  if (mn === 0 || mm === 0) return kept
  if ((mn + 1) * (mm + 1) > LCS_CELL_CEILING) {
    metaUrlEditStats.lastLcsCells = -1
    let next = 0
    for (let i = 0; i < mn; i += 1) {
      if (next < mm && values[prefix + i] === target[prefix + next]) { kept[prefix + i] = true; next += 1 }
    }
    return kept
  }
  const width = mm + 1
  metaUrlEditStats.lastLcsCells = (mn + 1) * width
  // lcs[i * width + j] = LCS length of the middles from i and from j.
  const lcs = new Uint32Array((mn + 1) * width)
  for (let i = mn - 1; i >= 0; i -= 1) {
    for (let j = mm - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = values[prefix + i] === target[prefix + j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < mn && j < mm) {
    if (values[prefix + i] === target[prefix + j]) { kept[prefix + i] = true; i += 1; j += 1 }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) i += 1
    else j += 1
  }
  return kept
}

/**
 * Turn a live list into `target`, comparing elements by {@link elementUrl}
 * (the SAME normalisation {@link readMetaUrls} applies, so a target read
 * through it matches an unreadable element in place and leaves it alone),
 * with `make` building each inserted element. Synchronous; inside the change.
 *
 * The kept elements ({@link keptElements}) are never touched; every other
 * element is deleted, from the END (so the indices still to visit do not
 * move), then the missing target elements are inserted in ascending target
 * order, each at its target index — after the deletions the list is the kept
 * subsequence, so each insertion lands where `target` has it. One exception,
 * for op order only: when the first insertion lands exactly on the first
 * deleted slot, that delete and insert are one `splice(slot, 1, x)`.
 *
 * Result: always `target`. Op for op the same as the greedy prefix pass of
 * `crdtListEdit.rewriteListInPlace` (deletes from the end, then pushes) for an
 * append, a plain removal and the rotator's reorder `[A, C, B]` → `[A, B, C,
 * N]`; the same op set as `spliceFoldedRunInPlace` for a fold window (deletes
 * from the end, then the product at the first source's slot). It DIFFERS from
 * the greedy pass for a middle insertion, on purpose: the greedy pass deleted
 * and re-created every element after it — and a re-created element survives a
 * concurrent writer's removal of the original, i.e. a folded segment comes
 * back. Tested in `modelMetaUrls.test.ts` ("a middle insertion re-creates
 * nothing", "op for op").
 */
function rewriteUrlListInPlace(list: unknown[], target: readonly string[], make: (url: string) => unknown): void {
  const values = list.map(elementUrl)
  const kept = keptElements(values, target)
  // Which target positions the kept elements fill: the kept subsequence is a
  // subsequence of `target` IN ORDER; the leftmost embedding is a valid one,
  // and any valid one yields `target` once the rest is inserted.
  const keptValues = values.filter((_, index) => kept[index])
  const filled = new Array<boolean>(target.length).fill(false)
  let k = 0
  for (let j = 0; j < target.length && k < keptValues.length; j += 1) {
    if (target[j] === keptValues[k]) { filled[j] = true; k += 1 }
  }
  const firstInsert = filled.indexOf(false)
  const firstDelete = kept.indexOf(false)
  // Everything before the first deletion is kept, so after the later
  // deletions that slot IS target position `firstDelete`: when the first
  // insertion lands there, delete and insert in ONE splice — the op order of
  // `spliceFoldedRunInPlace`'s `splice(first, 1, product)`.
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (kept[index]) continue
    if (index === firstDelete && firstInsert === firstDelete) {
      list.splice(index, 1, make(target[firstInsert]!))
      filled[firstInsert] = true
    } else {
      list.splice(index, 1)
    }
  }
  for (let j = 0; j < target.length; j += 1) if (!filled[j]) list.splice(j, 0, make(target[j]!))
}

const asText = (url: string): unknown => url
const asScalar = (url: string): unknown => new ImmutableString(url)

function writeList(meta: MetaRecord, key: string, target: readonly string[], make: (url: string) => unknown): void {
  // Assign, then RE-READ: `meta[k] ?? (meta[k] = [])` yields the plain `[]`,
  // not the document's list, and a push into it is lost.
  if (!Array.isArray(meta[key])) meta[key] = []
  rewriteUrlListInPlace(meta[key] as unknown[], target, make)
}

/**
 * THE write of a URL list, inside the ModelMeta's `change`: make the RULING
 * field equal `target`, in place (one operation per element added or
 * removed, ~39 under text authority, 1 under scalar authority). It follows
 * the marker the document carries and never sets it.
 */
export function writeMetaUrls(meta: object, field: MetaUrlListField, target: readonly string[]): void {
  const record = meta as MetaRecord
  if (metaUrlsAreScalar(record)) writeList(record, SCALAR_META_URL_FIELD[field], target, asScalar)
  else writeList(record, field, target, asText)
}

/** Append `url` to a URL list unless already present — the common write. */
export function appendMetaUrl(meta: object, field: MetaUrlListField, url: string): void {
  const current = readMetaUrls(meta, field) ?? []
  // Written even when present (a no-op edit): an absent list is created, as
  // the raw `if (!m[f]) m[f] = []` writes did.
  writeMetaUrls(meta, field, current.includes(url) ? current : [...current, url])
}

/**
 * THE write of a current head. ALWAYS assigns (as the raw writes did): an
 * assignment of the same value is still an operation that takes part in a
 * concurrent conflict, and skipping it would change which writer wins.
 * `undefined` deletes.
 */
export function writeMetaUrl(meta: object, field: MetaUrlHeadField, url: string | undefined): void {
  const record = meta as MetaRecord
  const key = metaUrlsAreScalar(record) ? SCALAR_META_URL_FIELD[field] : field
  const make = key === field ? asText : asScalar
  if (url === undefined) delete record[key]
  else record[key] = make(url)
}

/**
 * The SHAPE of a scalar-ruled document, applied in the caller's change: every
 * scalar field derived from its old text field, then the marker. Idempotent.
 * For TESTS only: no production writer calls it, because a document must
 * never be cut over in place (the module header, hazards (a) and (b)); a
 * scalar-ruled ModelMeta is born so (`modelEpochs.ts` `buildEpochMeta`).
 */
export function adoptScalarMetaUrls(meta: object): void {
  const record = meta as MetaRecord
  if (metaUrlsAreScalar(record)) return
  for (const field of META_URL_LIST_FIELDS) {
    const urls = readMetaUrls(record, field)
    if (urls) writeList(record, SCALAR_META_URL_FIELD[field], urls, asScalar)
    else delete record[SCALAR_META_URL_FIELD[field]]
  }
  for (const field of META_URL_HEAD_FIELDS) {
    const url = readMetaUrl(record, field)
    if (url === undefined) delete record[SCALAR_META_URL_FIELD[field]]
    else if (metaUrlValue(record[SCALAR_META_URL_FIELD[field]]) !== url) record[SCALAR_META_URL_FIELD[field]] = asScalar(url)
  }
  record[META_URL_FORMAT_FIELD] = META_URL_FORMAT_SCALAR
}
