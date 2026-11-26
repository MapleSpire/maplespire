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

/**
 * An edit the overlay compaction's CLEAR never saw (with the epochs flag off
 * too).
 *
 * The compaction folds the edits overlay into the base shards, then deletes
 * an overlay entry only if it still deep-equals what it folded
 * (`server/src/readModel/compaction.ts`). That reasoning covers every edit
 * the server HOLDS when it clears, and "Automerge map put-wins" covers a PUT
 * of the entry landing during the clear. It does not cover an edit made
 * OFFLINE before the clear and received after it: the browser writes a field
 * INSIDE the entry (a nested update, not a put of the entry), and a
 * concurrent delete of the entry's key wins over an update inside it — the
 * entry is gone, the base holds the folded (older) value, and her edit is
 * named by nothing. Measured (an offline-reload script): 68 of 80 offline edits of
 * objects an earlier run had created (so living in the overlay) lost after
 * five compactions while offline; on the server the overlay's history showed
 * `makeMap` (creation, 18:03), her `description` (offline, 18:05), the
 * clear's `del` (18:07, deps without her change).
 *
 * The browser that holds the lost value sees it: a REMOTE change deleting an
 * overlay entry whose value, as this browser held it just before, differs
 * from the value the deleting change saw (the document at its deps). The
 * entry is then written back — a put of the whole entry, which the next
 * compaction folds like any other. A clear of an entry it saw whole (the
 * ordinary case) and this browser's own deletes restore nothing.
 */
/** The compaction clear's change message — the same string as
 * `OVERLAY_COMPACTION_CLEAR_MESSAGE` in `server/src/readModel/compaction.ts`. */
export const OVERLAY_COMPACTION_CLEAR_MESSAGE = 'maplespire:overlay-compaction-clear'

export interface OverlayEntryToRestore {
  collection: string
  id: string
  /** A plain copy, ready to assign into a change. */
  value: unknown
  /** What the deleting change saw (a plain copy): the fields where `value`
   * differs from it are the edits it never saw. */
  seen: unknown
}

export function clearedOverlayEditsToRestore(
  before: A.Doc<unknown> | undefined,
  after: A.Doc<unknown> | undefined,
  patches: readonly A.Patch[],
  collections: readonly string[] = ['objects', 'connections'],
): OverlayEntryToRestore[] {
  if (!before || !after) return []
  const deleted = patches.flatMap((patch) => (patch.action === 'del' && patch.path.length === 2
    && typeof patch.path[0] === 'string' && collections.includes(patch.path[0]) && typeof patch.path[1] === 'string'
    ? [[patch.path[0], patch.path[1]] as const] : []))
  if (deleted.length === 0) return []
  const local = A.getActorId(after as never)
  let changes: A.DecodedChange[] | null = null
  const out: OverlayEntryToRestore[] = []
  for (const [collection, id] of deleted) {
    const mine = (before as Record<string, Record<string, unknown> | undefined>)[collection]?.[id]
    if (mine === undefined) continue
    const collectionObject = A.getObjectId(before, collection)
    if (!collectionObject) continue
    changes ??= A.getChanges(before as never, after as never).map((raw) => A.decodeChange(raw))
    const deleting = changes.find((change) => change.actor !== local
      && change.ops.some((op) => op.action === 'del' && op.obj === collectionObject && op.key === id))
    // Only the compaction's CLEAR: a colleague's explicit delete — whose meta
    // tombstone may arrive after it — is a delete, never undone here.
    if (!deleting || deleting.message !== OVERLAY_COMPACTION_CLEAR_MESSAGE) continue
    const seen = (A.view(after as never, deleting.deps) as Record<string, Record<string, unknown> | undefined>)[collection]?.[id]
    // Nothing it saw (it deleted what it never held), or exactly what this
    // browser held: an ordinary clear, or a delete that saw every edit.
    if (seen === undefined || comparable(seen) === comparable(mine)) continue
    out.push({ collection, id, value: plainCopy(mine), seen: plainCopy(seen) })
  }
  return out
}

/** A canonical form that tells two entry values apart: keys sorted (a view
 * and a live document list a map's keys in different orders), immutable
 * strings, dates and counters tagged. */
function comparable(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function canonical(value: unknown): unknown {
  if (value instanceof A.ImmutableString) return { $immutable: value.val }
  if (value instanceof A.Counter) return { $counter: value.value }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (value instanceof Uint8Array) return { $bytes: [...value] }
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
  }
  return value
}

/** A document value as plain JSON-able data, as the store and the KV hold
 * it (immutable strings as strings, counters as numbers). */
export function storeForm(value: unknown): unknown {
  if (value instanceof A.ImmutableString) return value.val
  if (value instanceof A.Counter) return value.value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return [...value]
  if (Array.isArray(value)) return value.map(storeForm)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, storeForm(v)]))
  }
  return value
}

const same = (a: unknown, b: unknown) => comparable(storeForm(a)) === comparable(storeForm(b))
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * What to write back for a rescued entry, as a store patch — or null when
 * nothing is owed any more. Compared in DOCUMENT form (`currentDoc`, the entity as the documents now
 * hold it), never against the store, whose projection may show a default
 * where the document holds nothing. A field is owed where her value differs
 * from what the clear saw AND the documents still hold what it saw (a later
 * write — hers from another tab, a colleague's — wins). A nested map is
 * compared key by key: her key is applied beside a colleague's later key,
 * over the store's current map (`currentStore`).
 */
export function rescuePatch(
  mine: Record<string, unknown>, seen: Record<string, unknown>,
  currentDoc: Record<string, unknown> | undefined, currentStore: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(mine), ...Object.keys(seen)])) {
    if (k === 'id') continue
    const m = mine[k]
    const s = seen[k]
    const c = currentDoc?.[k]
    if (same(m, s)) continue
    if (isMap(m) && isMap(s)) {
      const base = { ...((isMap(currentStore?.[k]) ? currentStore![k] : storeForm(c ?? {})) as Record<string, unknown>) }
      let changed = false
      for (const sk of new Set([...Object.keys(m), ...Object.keys(s)])) {
        if (same(m[sk], s[sk])) continue
        if (!same(isMap(c) ? c[sk] : undefined, s[sk])) continue
        changed = true
        if (sk in m) base[sk] = storeForm(m[sk])
        else delete base[sk]
      }
      if (changed) patch[k] = base
      continue
    }
    if (!same(c, s)) continue
    patch[k] = k in mine ? storeForm(m) : undefined
  }
  return Object.keys(patch).length > 0 ? patch : null
}

/** A copy of a document value that can be assigned into a change. */
export function plainCopy(value: unknown): unknown {
  if (value instanceof A.ImmutableString) return new A.ImmutableString(value.val)
  if (value instanceof A.Counter) return new A.Counter(value.value)
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value)) return value.map(plainCopy)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plainCopy(v)]))
  }
  return value
}

/** A rescue as the workspace's KV store keeps it (`overlay-clear-rescues:v1`). */
export interface StoredOverlayRescue {
  collection: string
  id: string
  value: unknown
  seen: unknown
  /** When this browser found it: with the key, the identity of ONE finding. */
  since: number
}

const rescueKey = (r: { collection: string; id: string }) => `${r.collection}:${r.id}`

function isStoredRescue(value: unknown): value is StoredOverlayRescue {
  const r = value as Partial<StoredOverlayRescue> | undefined
  return !!r && typeof r.id === 'string' && (r.collection === 'objects' || r.collection === 'connections') && typeof r.since === 'number'
}

/**
 * The persisted rescues are shared by
 * every tab of the workspace and outlive the session that found them, so a
 * tab writes its own changes INTO what is stored, never a snapshot of its
 * memory over it. `upserts` replace the entry of their key; a removal drops
 * the stored entry only when it is the SAME finding (key and `since`) — one
 * another tab found since, or a newer finding of the same entity, stays.
 * Pure: the caller runs it inside the store's atomic `update`.
 */
export function mergeStoredRescues(
  stored: unknown,
  upserts: readonly StoredOverlayRescue[],
  removals: readonly StoredOverlayRescue[],
): StoredOverlayRescue[] {
  const out = new Map<string, StoredOverlayRescue>()
  for (const entry of Array.isArray(stored) ? stored : []) if (isStoredRescue(entry)) out.set(rescueKey(entry), entry)
  for (const removed of removals) {
    const at = out.get(rescueKey(removed))
    if (at && at.since === removed.since) out.delete(rescueKey(removed))
  }
  for (const entry of upserts) out.set(rescueKey(entry), entry)
  return [...out.values()]
}
