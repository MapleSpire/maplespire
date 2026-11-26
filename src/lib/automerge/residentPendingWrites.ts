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
 * The local writes of the RESIDENT sharded path that no document holds yet.
 *
 * `projectAll` replaces the store's objects (connections) with the merge of
 * the shard documents whenever one of them changed. A creation, an edit or a
 * delete made in the store and not yet flushed was then erased by any shard
 * change landing inside the write debounce — measured: objects Marie created
 * right after an overflow shard vanished from her own store, written to no
 * document, the badge on "Synced" (an e2e run with auth on, about one trial
 * in two). The comments, flows and placements already overlay
 * their pending intents on the projection; the boot-from-server path
 * journals entity intents (`entityIntents.ts`). This is the same overlay for
 * the resident path — kept apart from that journal, which BFS alone drains.
 *
 * Per entity: the latest local value and the value before the first local
 * write since the entity was last held by a document (the baseline). On a
 * projection, a write is overlaid on the documents' copy by the fields it
 * TOUCHED only (a remote change to another field stands; the store never
 * hands the flush a stale copy of it); an entry leaves once the documents
 * hold every field it touched (a delete: once they no longer hold the
 * entity). A remote delete of an entity edited here wins over the edit — on
 * screen at once, in the debt once the entity stayed absent for
 * {@link ABSENT_DELETE_GRACE_MS}; a creation no document holds yet is kept.
 */
import { Counter, ImmutableString } from '@automerge/automerge'
import { storeForm } from './overlayClearRescue'

export type ResidentCollection = 'objects' | 'connections'

type Entity = { id: string } & Record<string, unknown>
type Entry =
  | { op: 'upsert'; value: Entity; baseline: Entity | undefined; absentSince?: number }
  | { op: 'delete'; baseline: Entity }

/**
 * How long an entity edited here may be absent from the documents' merge before its
 * absence counts as a remote delete. A compaction that clears an overlay
 * entry and folds it into a NEW base shard leaves the entity in no projected
 * document until the tab follows that shard (measured: about a second on the
 * e2e stack, sampled on a device that never comes back online); dropping the
 * owed edit at once lost
 * it. While absent, it is not shown (a real delete still wins on screen at
 * once) and stays owed; it is overlaid again when the entity comes back.
 */
export const ABSENT_DELETE_GRACE_MS = 15_000
let absentDeleteGraceMs = ABSENT_DELETE_GRACE_MS
/** TEST SEAM: a shorter grace for a bridge test on real timers. */
export function __setAbsentDeleteGraceMsForTest(ms: number | null): void {
  absentDeleteGraceMs = ms ?? ABSENT_DELETE_GRACE_MS
}

/** Plain data with `undefined` fields dropped (the documents never hold
 * them), document scalars (immutable strings, counters) as the store holds them. */
function plain(value: unknown): unknown {
  if (value instanceof ImmutableString || value instanceof Counter || value instanceof Date || value instanceof Uint8Array) return storeForm(value)
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sorted(plain(a))) === JSON.stringify(sorted(plain(b)))
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])])
  }
  return value
}

/** The fields an upsert touched: every field of a creation; the fields that
 * differ from the baseline for an edit (a field it removed included). */
function touched(entry: Extract<Entry, { op: 'upsert' }>): string[] {
  if (!entry.baseline) return Object.keys(entry.value)
  const keys = new Set([...Object.keys(entry.value), ...Object.keys(entry.baseline)])
  return [...keys].filter((k) => k !== 'id' && entry.value[k] !== entry.baseline![k])
}

export class ResidentPendingWrites {
  private readonly entries: Record<ResidentCollection, Map<string, Entry>> = { objects: new Map(), connections: new Map() }

  get size(): number {
    return this.entries.objects.size + this.entries.connections.size
  }

  has(collection: ResidentCollection, id: string): boolean {
    return this.entries[collection].has(id)
  }

  clear(): void {
    this.entries.objects.clear()
    this.entries.connections.clear()
  }

  /** A LOCAL store change: record what it created, edited, deleted. */
  note(collection: ResidentCollection, previous: readonly Entity[], next: readonly Entity[], skip?: (entity: Entity) => boolean): void {
    if (previous === next) return
    const map = this.entries[collection]
    // The common edit (immer keeps the order and every other ref): a walk in
    // step, no index of the whole collection.
    if (previous.length === next.length) {
      const changed: number[] = []
      let aligned = true
      for (let i = 0; i < next.length; i += 1) {
        if (previous[i] === next[i]) continue
        if (previous[i]!.id !== next[i]!.id) { aligned = false; break }
        changed.push(i)
      }
      if (aligned) {
        for (const i of changed) {
          const entity = next[i]!
          if (skip?.(entity)) continue
          const open = map.get(entity.id)
          map.set(entity.id, { op: 'upsert', value: entity, baseline: open ? open.baseline : previous[i] })
        }
        return
      }
    }
    const before = new Map(previous.map((e) => [e.id, e]))
    const seen = new Set<string>()
    for (const entity of next) {
      seen.add(entity.id)
      if (skip?.(entity)) continue
      const prior = before.get(entity.id)
      if (prior === entity) continue
      const open = map.get(entity.id)
      // The baseline is the value before the FIRST write still owed.
      const baseline = open ? (open.op === 'upsert' ? open.baseline : open.baseline) : prior
      map.set(entity.id, { op: 'upsert', value: entity, baseline })
    }
    for (const [id, prior] of before) {
      if (seen.has(id) || skip?.(prior)) continue
      const open = map.get(id)
      // Created and deleted before any document held it: nothing owed.
      if (open?.op === 'upsert' && !open.baseline) { map.delete(id); continue }
      map.set(id, { op: 'delete', baseline: open?.op === 'upsert' ? open.baseline ?? prior : open?.baseline ?? prior })
    }
  }

  /**
   * The documents' merge with the owed writes overlaid (a new array only when
   * something is overlaid); releases every entry the documents now hold.
   */
  overlay<T extends { id: string }>(collection: ResidentCollection, merged: T[], now: number = Date.now()): T[] {
    const map = this.entries[collection]
    if (map.size === 0) return merged
    const index = new Map(merged.map((e, i) => [e.id, i]))
    const out = [...merged]
    const drop = new Set<number>()
    let changed = false
    for (const [id, entry] of map) {
      const at = index.get(id)
      const doc = at === undefined ? undefined : (merged[at] as unknown as Entity)
      if (entry.op === 'delete') {
        if (!doc) { map.delete(id); continue }
        drop.add(at!)
        changed = true
        continue
      }
      if (!doc) {
        // An edit of an entity the documents no longer hold: not shown (a
        // remote delete wins on screen), still owed for a grace period — the
        // absence may be a fold product not followed yet. Past it, the delete wins.
        if (entry.baseline) {
          entry.absentSince ??= now
          if (now - entry.absentSince >= absentDeleteGraceMs) map.delete(id)
          continue
        }
        out.push(entry.value as unknown as T)
        changed = true
        continue
      }
      entry.absentSince = undefined
      const fields = touched(entry)
      if (fields.every((k) => same(entry.value[k], doc[k]))) { map.delete(id); continue }
      const overlaid: Record<string, unknown> = { ...doc }
      for (const k of fields) {
        if (k in entry.value && entry.value[k] !== undefined) overlaid[k] = entry.value[k]
        else delete overlaid[k]
      }
      out[at!] = overlaid as unknown as T
      changed = true
    }
    if (!changed) return merged
    return drop.size > 0 ? out.filter((_, i) => !drop.has(i)) : out
  }

  /** After a write: release the entries the documents hold (`held` reads the
   * entity from the document it is routed to). */
  release(collection: ResidentCollection, held: (id: string) => Record<string, unknown> | undefined, now: number = Date.now()): void {
    const map = this.entries[collection]
    for (const [id, entry] of map) {
      const doc = held(id)
      if (entry.op === 'delete') { if (!doc) map.delete(id); continue }
      // Absent past its grace (seen absent by a projection): the remote delete wins.
      if (!doc && entry.absentSince !== undefined && now - entry.absentSince >= absentDeleteGraceMs) { map.delete(id); continue }
      if (doc && touched(entry).every((k) => same(entry.value[k], doc[k]))) map.delete(id)
    }
  }

  /**
   * When the first absent entry's
   * grace ends (epoch ms), or null. Only a projection or a write ever asks
   * `overlay`/`release`, so in a quiet workspace an entity deleted remotely
   * would stay owed — the badge on "Saving" — with no end: the bridge arms a
   * timer on this deadline and releases there.
   */
  nextAbsentDeadline(): number | null {
    let next: number | null = null
    for (const map of Object.values(this.entries)) {
      for (const entry of map.values()) {
        if (entry.op !== 'upsert' || entry.absentSince === undefined) continue
        const at = entry.absentSince + absentDeleteGraceMs
        if (next === null || at < next) next = at
      }
    }
    return next
  }
}
