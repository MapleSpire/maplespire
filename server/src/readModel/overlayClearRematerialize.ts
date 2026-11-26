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

import {
  Counter, ImmutableString, decodeChange, getAllChanges, getChangesSince, getObjectId, hasHeads, isCounter, view,
} from '@automerge/automerge'
import type { DecodedChange, Doc, Heads } from '@automerge/automerge'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * G4-16k (whether model epochs are enabled or not): the edits an overlay
 * compaction's CLEAR erased, found and written again by the SERVER.
 *
 * The compaction folds an overlay entry into a base shard, then deletes the
 * entry (`compaction.ts`, the conditional clear, change message
 * `maplespire:overlay-compaction-clear`). An edit made OFFLINE inside that
 * entry before the clear and received after it is an update inside a map the
 * clear deleted: Automerge keeps the delete, and the edit is named by nothing
 * — the base holds the folded older value. The browser that made the edit
 * rescues it when it sees the clear (`src/lib/automerge/overlayClearRescue.ts`);
 * a browser that never comes back, or closes before, cannot. The server holds
 * both changes once she syncs, so each pass looks for them here.
 *
 * Per overlay segment: the changes received since the last scan (all of them
 * the first time) that write inside an object the document no longer holds.
 * Such an object is an entry map (or a map inside one) that a change
 * DELETED; only a delete carrying the clear's message counts — a colleague's
 * explicit delete is a delete. For each such entry, `seen` is the entry as
 * the clear saw it (the document at its deps) and `mine` the entry with the
 * late changes on top (the document at the clear's deps plus them): the
 * fields where they differ are the edits the clear never saw.
 */
export const OVERLAY_CLEAR_MESSAGE = 'maplespire:overlay-compaction-clear'
/** The message of the change that writes a rematerialized field back. */
export const OVERLAY_REMATERIALIZE_MESSAGE = 'maplespire:overlay-clear-rematerialize'

export interface ClearedEntryEdit {
  collection: string
  id: string
  /** The entry with the late changes on top (a document value). */
  mine: unknown
  /** The entry as the clear saw it (a document value). */
  seen: unknown
  /** The entry with only the late changes an EARLIER scan read on top —
   * what an earlier pass may have written back already (absent: none). A
   * field still holding it is this server's own write, not a later one. */
  previous?: unknown
  /** The late changes read by THIS scan, by hash: the grace period runs from
   * when a pass first saw each of them (never from the
   * author's clock, which a device can set anywhere). */
  changes: string[]
}

/** Work counted by one scan (for the per-pass history cap). */
export interface ScanStats {
  /** Changes decoded. */
  decoded: number
}

/** How many changes are decoded, or ops walked, between two points where a
 * yielding caller gives the event loop back. */
const SCAN_STEP = 256

const MAKE = new Set(['makeMap', 'makeList', 'makeText', 'makeTable'])

/** Every object id the document holds now — text objects included: a string
 * field is a text object in Automerge 3, and an ordinary rename writes
 * inside it. */
export function liveObjects(doc: Doc<unknown>): Set<string> {
  const out = new Set<string>(['_root'])
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object' || value instanceof ImmutableString || value instanceof Date
      || value instanceof Uint8Array || isCounter(value)) return
    const id = getObjectId(value)
    if (id) out.add(id)
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === 'string') {
        const text = getObjectId(value, Array.isArray(value) ? Number(key) : key)
        if (text) out.add(text)
      } else walk(child)
    }
  }
  walk(doc)
  return out
}

type Entry = { collection: string; id: string; entry: string }

/**
 * The entries of `collections` whose late edits the clear erased, in the
 * changes after `since` (every change when `since` is null or unknown to the
 * document). Pure: reads `doc` only.
 *
 * Cost: the changes after `since` are decoded and the live object ids
 * walked; the whole history is decoded only when one of those changes
 * writes inside an object the document no longer holds. An ordinary edit of
 * a live entry does not; a write the pass's own clear then erased does (this
 * server's own rematerialization, or an edit landing in the pass window), so
 * the pass after one decodes the history again. Measured: 0.19 s for a
 * segment of 1 500 entries in 60 changes with 80 late edits (the test);
 * 1.45 s was measured for 365 daily clears of 50 entries.
 * That is CPU on the sync server's event loop, so the production caller runs
 * {@link clearedEntryEditsYielding}, which gives the loop back every
 * {@link SCAN_STEP} changes decoded and between the document views.
 */
export function clearedEntryEdits(
  doc: Doc<unknown>,
  since: Heads | null,
  collections: readonly string[] = ['objects', 'connections'],
  stats?: ScanStats,
): ClearedEntryEdit[] {
  const steps = clearedEntryEditsSteps(doc, since, collections, stats)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/** {@link clearedEntryEdits}, awaiting `yieldNow` at each of its steps. The
 * document is an immutable Automerge value: a change landing meanwhile makes
 * a NEW document, so what is read is the revision passed in. */
export async function clearedEntryEditsYielding(
  doc: Doc<unknown>,
  since: Heads | null,
  collections: readonly string[],
  yieldNow: () => Promise<void>,
  stats?: ScanStats,
): Promise<ClearedEntryEdit[]> {
  const steps = clearedEntryEditsSteps(doc, since, collections, stats)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    await yieldNow()
  }
}

/** Decode `raws` (read by `read`, one call), a step right after that call and
 * then every {@link SCAN_STEP} changes or `SCAN_STEP * 8` ops decoded —
 * measured, a change of a daily clear of 50 entries decodes in about 0.3 ms,
 * so a count of changes alone left 80 ms slices. */
function* decodeAll(read: () => readonly Uint8Array[], stats?: ScanStats): Generator<void, DecodedChange[]> {
  const raws = read()
  yield
  const out: DecodedChange[] = []
  let changes = 0
  let ops = 0
  for (const raw of raws) {
    const change = decodeChange(raw)
    out.push(change)
    if (stats) stats.decoded += 1
    changes += 1
    ops += change.ops.length
    if (changes >= SCAN_STEP || ops >= SCAN_STEP * 8) { changes = 0; ops = 0; yield }
  }
  return out
}

function* clearedEntryEditsSteps(
  doc: Doc<unknown>,
  since: Heads | null,
  collections: readonly string[],
  stats?: ScanStats,
): Generator<void, ClearedEntryEdit[]> {
  const incremental = !!since && since.length > 0 && hasHeads(doc, since)
  const fresh = yield* decodeAll(() => (incremental ? getChangesSince(doc, since as Heads) : getAllChanges(doc)), stats)
  if (fresh.length === 0) return []
  yield
  const live = liveObjects(doc)
  yield
  const late = fresh.filter((change) => change.message !== OVERLAY_CLEAR_MESSAGE
    && change.ops.some((op) => !live.has(op.obj)))
  if (late.length === 0) return []
  const freshHashes = new Set(fresh.map((change) => change.hash))
  const history = incremental ? yield* decodeAll(() => getAllChanges(doc), stats) : fresh
  // Each made object's parent and key (an op's id is `${startOp + i}@${actor}`),
  // and every delete of a map key, indexed once.
  const made = new Map<string, { parent: string; key: string }>()
  const dels = new Map<string, Array<{ change: DecodedChange; pred: string[] }>>()
  let walked = 0
  for (const change of history) {
    change.ops.forEach((op, i) => {
      if (MAKE.has(op.action)) made.set(`${change.startOp + i}@${change.actor}`, { parent: op.obj, key: op.key })
      else if (op.action === 'del') {
        const at = `${op.obj}\u0000${op.key}`
        const list = dels.get(at) ?? []
        list.push({ change, pred: op.pred })
        dels.set(at, list)
      }
    })
    walked += change.ops.length
    if (walked >= SCAN_STEP * 16) { walked = 0; yield }
  }
  const collectionIds = new Map<string, string>()
  const collectionObjOf = new Map<string, string>()
  for (const collection of collections) {
    const id = getObjectId(doc, collection)
    if (id) { collectionIds.set(id, collection); collectionObjOf.set(collection, id) }
  }
  const entryCache = new Map<string, Entry | null>()
  // The entry (collection, id, entry object) an object lives in, if any.
  const entryOf = (obj: string): Entry | null => {
    const cached = entryCache.get(obj)
    if (cached !== undefined) return cached
    let current = obj
    let found: Entry | null = null
    for (let depth = 0; depth < 64; depth++) {
      const at = made.get(current)
      if (!at) break
      const collection = collectionIds.get(at.parent)
      if (collection) { found = { collection, id: at.key, entry: current }; break }
      current = at.parent
    }
    entryCache.set(obj, found)
    return found
  }
  // ONE pass over the history: per gone entry map, the changes that write
  // inside it (an entry an earlier pass cleared is written by its creation
  // too, so this is every cleared entry on a first scan).
  const touching = new Map<string, { at: Entry; changes: Set<string> }>()
  walked = 0
  for (const change of history) {
    if (change.message === OVERLAY_CLEAR_MESSAGE) continue
    for (const op of change.ops) {
      if (live.has(op.obj)) continue
      const at = entryOf(op.obj)
      if (!at || live.has(at.entry)) continue
      const entry = touching.get(at.entry) ?? { at, changes: new Set<string>() }
      entry.changes.add(change.hash)
      touching.set(at.entry, entry)
    }
    walked += change.ops.length
    if (walked >= SCAN_STEP * 16) { walked = 0; yield }
  }
  // The clear's ancestry, once per clear: a change in it is one the clear SAW
  // (its creation, an edit before it) — never late. Measured on a synthetic
  // segment of 1 500 entries in 60 changes, cleared, 80 late edits: 108 s
  // when every cleared entry was a group with its own views; the late ones
  // alone, views shared per head set, below.
  const depsOf = new Map(history.map((change) => [change.hash, change.deps]))
  const ancestry = new Map<string, Set<string>>()
  const ancestorsOf = (clear: DecodedChange): Set<string> => {
    let seen = ancestry.get(clear.hash)
    if (seen) return seen
    seen = new Set<string>()
    const stack = [...clear.deps]
    while (stack.length) {
      const hash = stack.pop()!
      if (seen.has(hash)) continue
      seen.add(hash)
      for (const dep of depsOf.get(hash) ?? []) stack.push(dep)
    }
    ancestry.set(clear.hash, seen)
    return seen
  }
  const views = new Map<string, Record<string, Record<string, unknown> | undefined>>()
  // Each view is one materialization of the document, the costliest single
  // call of the scan: a step after each new one.
  let viewed = 0
  const pick = (heads: string[], at: Entry) => {
    const key = [...heads].sort().join(',')
    let v = views.get(key)
    if (!v) { v = view(doc, heads) as Record<string, Record<string, unknown> | undefined>; views.set(key, v); viewed += 1 }
    return v[at.collection]?.[at.id]
  }
  const out: ClearedEntryEdit[] = []
  for (const { at, changes } of touching.values()) {
    if (viewed > 0) { viewed = 0; yield }
    if (![...changes].some((hash) => freshHashes.has(hash))) continue
    const deleting = (dels.get(`${collectionObjOf.get(at.collection)}\u0000${at.id}`) ?? [])
      .filter((d) => d.pred.includes(at.entry))
    // Only the compaction's clear: if any delete of this entry is not one
    // (a colleague's explicit delete, concurrent or not), it stays deleted.
    if (deleting.length === 0 || deleting.some((d) => d.change.message !== OVERLAY_CLEAR_MESSAGE)) continue
    const clear = deleting[0].change
    const saw = ancestorsOf(clear)
    // The changes the clear did not see: those read now, and those an
    // earlier scan read (split delivery).
    const unseen = [...changes].filter((hash) => !saw.has(hash))
    const now = unseen.filter((hash) => freshHashes.has(hash))
    const before = unseen.filter((hash) => !freshHashes.has(hash))
    if (now.length === 0) continue
    const seen = pick(clear.deps, at)
    const mine = pick([...new Set([...clear.deps, ...before, ...now])], at)
    const previous = before.length ? pick([...new Set([...clear.deps, ...before])], at) : undefined
    // Nothing the clear did not see, or nothing new since the earlier scan.
    if (seen === undefined || mine === undefined || same(mine, seen)) continue
    if (previous !== undefined && same(mine, previous)) continue
    out.push({ collection: at.collection, id: at.id, mine, seen, ...(previous !== undefined ? { previous } : {}), changes: now })
  }
  return out
}

/** The production grace period before the server writes back a late edit
 * (`CompactionOptions.rematerializeGraceMs`): a day, or
 * `OVERLAY_CLEAR_REMATERIALIZE_GRACE_MS` (milliseconds, 0 and up — the
 * real-stack scenario sets 0). */
export const DEFAULT_REMATERIALIZE_GRACE_MS = 24 * 60 * 60_000
export function rematerializeGraceMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OVERLAY_CLEAR_REMATERIALIZE_GRACE_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_REMATERIALIZE_GRACE_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`OVERLAY_CLEAR_REMATERIALIZE_GRACE_MS must be a number of milliseconds >= 0, got ${raw}`)
  }
  return value
}

/** A segment's recorded scan: where it stopped, and when a pass first saw
 * each late change still in its
 * grace period, by change hash, in epoch ms of the SERVER's clock. */
export interface ClearScanRow {
  heads: readonly string[]
  lateSeen?: Readonly<Record<string, number>>
  /** The late changes after `heads` a pass already dealt
   * with while the segment stayed parked (`compaction.ts`, `done`). */
  done?: readonly string[]
}

/** One scan to record (`lateSeen` absent: none waiting; `done` absent: none). */
export interface ClearScanSave {
  documentId: string
  heads: readonly string[]
  lateSeen?: Readonly<Record<string, number>>
  done?: readonly string[]
}

/**
 * Where each segment's last scan stopped, in `read_model_overlay_clear_scans`
 * (`schema.ts`): the compaction's `clearScans` (`compaction.ts`). A segment
 * with no row starts at its heads when a pass first sees it.
 *
 * `load` returns the rows least recently saved FIRST (the
 * pass reads them in that order and bounds how many it resolves, so a
 * workspace with hundreds of old segments rotates through them instead of
 * starving the newest). `purge` deletes the rows of segments that are gone.
 */
export function overlayClearScanStore(db: Queryable, key: WorkspaceKey) {
  return {
    load: async (collection: 'object' | 'connection'): Promise<ReadonlyMap<string, ClearScanRow>> => {
      const { rows } = await db.query<{ document_id: string; scanned_heads: string[]; late_seen: Record<string, number> | null; done_changes: string[] | null }>(
        `SELECT document_id, scanned_heads, late_seen, done_changes FROM read_model_overlay_clear_scans
         WHERE landscape_id = $1 AND version_id = $2 AND collection = $3
         ORDER BY updated_at ASC, document_id ASC`,
        [key.landscapeId, key.versionId, collection],
      )
      return new Map(rows.map((row) => [row.document_id, { heads: row.scanned_heads, lateSeen: row.late_seen ?? {}, done: row.done_changes ?? [] }]))
    },
    save: async (collection: 'object' | 'connection', scans: ReadonlyArray<ClearScanSave>, options: { onlyNew?: boolean } = {}): Promise<void> => {
      const kept = scans.filter((scan) => scan.heads.length > 0)
      if (kept.length === 0) return
      // A first sighting (`onlyNew`) never moves a row another pass saved.
      await db.query(
        `INSERT INTO read_model_overlay_clear_scans (landscape_id, version_id, collection, document_id, scanned_heads, late_seen, done_changes, updated_at)
         SELECT $1, $2, $3, scan.document_id, string_to_array(scan.heads, ','), scan.late_seen::jsonb,
                COALESCE(string_to_array(NULLIF(scan.done, ''), ','), '{}'), clock_timestamp()
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[]) AS scan(document_id, heads, late_seen, done)
         ON CONFLICT (landscape_id, version_id, collection, document_id)
         ${options.onlyNew ? 'DO NOTHING' : 'DO UPDATE SET scanned_heads = EXCLUDED.scanned_heads, late_seen = EXCLUDED.late_seen, done_changes = EXCLUDED.done_changes, updated_at = clock_timestamp()'}`,
        [key.landscapeId, key.versionId, collection, kept.map((scan) => scan.documentId), kept.map((scan) => scan.heads.join(',')),
          kept.map((scan) => JSON.stringify(scan.lateSeen ?? {})), kept.map((scan) => (scan.done ?? []).join(','))],
      )
    },
    purge: async (collection: 'object' | 'connection', documentIds: readonly string[]): Promise<void> => {
      if (documentIds.length === 0) return
      await db.query(
        `DELETE FROM read_model_overlay_clear_scans
         WHERE landscape_id = $1 AND version_id = $2 AND collection = $3 AND document_id = ANY($4::text[])`,
        [key.landscapeId, key.versionId, collection, [...documentIds]],
      )
    },
  }
}

/** A canonical form that tells two document values apart. */
function canonical(value: unknown): unknown {
  if (value instanceof ImmutableString) return value.val
  if (isCounter(value)) return { $counter: (value as { value: number }).value }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (value instanceof Uint8Array) return { $bytes: [...value] }
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
  }
  return value
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

/** Two values compared in canonical form (a document value against the JSON
 * an override row stores). */
export const sameDocumentValue = same

/** The value at `path` inside `value` (a document value or plain JSON). */
export function valueAtPath(value: unknown, path: ReadonlyArray<string | number>): unknown {
  let at: unknown = value
  for (const key of path) {
    if (!at || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[String(key)]
  }
  return at
}

/** A write its author unchecked in the batch re-apply — the path
 * inside the entity and the value she declined. */
export interface DeclinedWrite {
  path: ReadonlyArray<string | number>
  value: unknown
  /** The row is still `pending` — she has not decided. Every value at the path is
   * held back, not only `value`, and the segment's scan does not move past
   * the edit until she does. */
  pending?: true
}

/**
 * The declined writes of `ids` — the epoch override rows resolved
 * `dismissed` (`modelEpochOverrides.ts`), their path made relative to the
 * entity — and the rows still `pending` (`pending: true`). None when the
 * table does not exist (`AM_MODEL_EPOCHS` never on).
 */
export async function declinedOverrideWrites(
  db: Queryable, key: WorkspaceKey, collection: 'object' | 'connection', ids: readonly string[],
): Promise<Map<string, DeclinedWrite[]>> {
  const out = new Map<string, DeclinedWrite[]>()
  if (ids.length === 0) return out
  const { rows: present } = await db.query<{ present: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_model_epoch_overrides') IS NOT NULL AS present`)
  if (!present[0]?.present) return out
  const { rows } = await db.query<{ entity_id: string; path: Array<string | number>; late_value: unknown; state: string }>(
    `SELECT entity_id, path, late_value, state FROM read_model_model_epoch_overrides
      WHERE landscape_id = $1 AND version_id = $2 AND entity_kind = $3 AND state IN ('dismissed', 'pending')
        AND entity_id = ANY($4::text[])`,
    [key.landscapeId, key.versionId, collection, [...ids]])
  for (const row of rows) {
    const list = out.get(row.entity_id) ?? []
    list.push({ path: row.path.slice(2), value: row.late_value, ...(row.state === 'pending' ? { pending: true as const } : {}) })
    out.set(row.entity_id, list)
  }
  return out
}
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && !(v instanceof ImmutableString) && !(v instanceof Date) && !(v instanceof Uint8Array) && !isCounter(v)

/** A plain copy of a document value, assignable into a change. */
export function plainValue(value: unknown): unknown {
  if (value instanceof ImmutableString) return new ImmutableString(value.val)
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof Uint8Array) return new Uint8Array(value)
  // Kept a counter: `foldValueInPlace` leaves an equal one as it is.
  if (isCounter(value)) return new Counter((value as { value: number }).value)
  if (Array.isArray(value)) return value.map(plainValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plainValue(v)]))
  }
  return value
}

/**
 * The entity to write where it lives now (`current`, as the documents hold
 * it), or null when nothing is owed. A field is owed where `mine` differs
 * from `seen` AND `current` still holds what the clear saw: a later write —
 * hers through her browser's rescue, a colleague's — wins. A nested map is
 * compared key by key. The same rule as the browser's `rescuePatch`.
 */
export function rematerializedEntity(
  mine: Record<string, unknown>, seen: Record<string, unknown>, current: Record<string, unknown>,
  previous?: Record<string, unknown>,
  /** A field (or a key of a map field) never to write back — a write
   * she declined in the batch re-apply. */
  declined?: (field: readonly string[]) => boolean,
): Record<string, unknown> | null {
  const next = plainValue(current) as Record<string, unknown>
  let changed = false
  // A value nobody wrote after the clear (or after this server's own earlier
  // write of her fields, `previous`): hers may go over it.
  const untouched = (c: unknown, s: unknown, p: unknown, hasPrevious: boolean) => same(c, s) || (hasPrevious && same(c, p))
  const prev = previous ?? {}
  for (const k of new Set([...Object.keys(mine), ...Object.keys(seen), ...Object.keys(prev)])) {
    if (k === 'id') continue
    const m = mine[k]
    const s = seen[k]
    const c = current[k]
    const p = prev[k]
    if (same(m, s) && (!previous || same(m, p))) continue
    if (isMap(m) && isMap(s)) {
      const base = (isMap(c) ? plainValue(c) : {}) as Record<string, unknown>
      const pm = isMap(p) ? p : {}
      let nested = false
      for (const sk of new Set([...Object.keys(m), ...Object.keys(s), ...Object.keys(pm)])) {
        const cv = isMap(c) ? c[sk] : undefined
        if (same(m[sk], cv)) continue
        if (same(m[sk], s[sk]) && (!previous || same(m[sk], pm[sk]))) continue
        if (!untouched(cv, s[sk], pm[sk], !!previous)) continue
        if (declined?.([k, sk])) continue
        nested = true
        if (sk in m) base[sk] = plainValue(m[sk])
        else delete base[sk]
      }
      if (nested) { next[k] = base; changed = true }
      continue
    }
    if (same(m, c) || !untouched(c, s, p, !!previous)) continue
    if (declined?.([k])) continue
    changed = true
    if (k in mine) next[k] = plainValue(m)
    else delete next[k]
  }
  return changed ? next : null
}
