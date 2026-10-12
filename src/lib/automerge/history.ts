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

import { getHistory, getHeads, view } from '@automerge/automerge'
import type { DocHandle } from '@automerge/automerge-repo'
import { reconcile } from './reconcile'
import { changeWithDurabilityTracking } from './durableSync'
import type { DiagramDoc, Checkpoint } from './types'

/**
 * Per-diagram time travel, built on Automerge's retained change history.
 *
 *  - listHistory(): the diagram's full change timeline (newest first), each entry
 *    carrying the `heads` to view/restore at that point.
 *  - previewAt(): materialise the diagram as it was at given heads (read-only).
 *  - restoreTo(): roll the diagram back by writing the past state as a NEW change,
 *    so the restore is itself undoable and the checkpoint list is preserved.
 *  - named checkpoints live in `DiagramDoc.checkpoints`.
 */

export interface HistoryEntry {
  hash: string
  time: number
  message?: string
  actor: string
  /** Heads at this point — pass to previewAt/restoreTo. */
  heads: string[]
}

export function listHistory(handle: DocHandle<DiagramDoc>): HistoryEntry[] {
  const doc = handle.doc()
  if (!doc) return []
  return getHistory(doc)
    .map((state) => ({
      hash: state.change.hash,
      // Automerge records change time as a Unix timestamp in SECONDS; convert to
      // milliseconds so the UI's relative-time math (vs Date.now()) is correct.
      time: state.change.time * 1000,
      message: state.change.message ?? undefined,
      actor: state.change.actor,
      heads: getHeads(state.snapshot),
    }))
    .reverse() // newest first
}

/** Heads read back from an Automerge doc (e.g. a stored checkpoint) may be a proxy
 * array; normalise to plain strings so `view` can decode the hex hashes. */
function normaliseHeads(heads: readonly string[]): string[] {
  return Array.from(heads, String)
}

/** True only if EVERY requested head is a real change hash in this doc's local
 * history. `view` with unknown heads does NOT throw — it returns a degenerate
 * empty doc — so callers must check this before previewing/restoring, or they'd
 * silently wipe a doc whose history this peer doesn't have (e.g. a checkpoint
 * carried over from a forked/duplicated diagram, or heads pruned by compaction). */
function headsKnown(doc: Parameters<typeof getHistory>[0], heads: string[]): boolean {
  if (heads.length === 0) return false
  const known = new Set<string>()
  for (const state of getHistory(doc)) known.add(state.change.hash)
  return heads.every((h) => known.has(h))
}

export function previewAt(handle: DocHandle<DiagramDoc>, heads: string[]): DiagramDoc | undefined {
  const doc = handle.doc()
  if (!doc) return undefined
  const want = normaliseHeads(heads)
  if (!headsKnown(doc, want)) {
    console.warn('previewAt: requested heads not in local history; cannot preview', heads)
    return undefined
  }
  try {
    return view(doc, want) as DiagramDoc
  } catch (err) {
    console.error('previewAt: could not view at heads', heads, err)
    return undefined
  }
}

export function restoreTo(handle: DocHandle<DiagramDoc>, heads: string[]): void {
  const doc = handle.doc()
  if (!doc) return
  const want = normaliseHeads(heads)
  // Guard: never restore to heads this peer doesn't have — `view` would return an
  // empty doc and reconcile would WIPE the diagram (e.g. a checkpoint copied from
  // a forked diagram references the source's history, absent here).
  if (!headsKnown(doc, want)) {
    console.warn('restoreTo: requested heads not in local history; skipping', heads)
    return
  }
  let past: DiagramDoc
  try {
    past = view(doc, want) as DiagramDoc
  } catch (err) {
    // Don't leave the doc half-changed — bail before the write if heads are bad.
    console.error('restoreTo: could not view at heads', heads, err)
    return
  }
  changeWithDurabilityTracking(handle, (d: DiagramDoc) => {
    // Restore every field to the past state, but KEEP the current checkpoint list
    // (restore points should not vanish when you roll back).
    const target: DiagramDoc = { ...past, checkpoints: d.checkpoints ?? [] }
    reconcile(d, target)
  })
}

/**
 * Generic, doc-type-agnostic restore: materialise `handle` at `heads` and write
 * that past state back as a NEW change (so it is itself undoable). Used by
 * LANDSCAPE-wide version restore, which rolls every workspace doc (model shards,
 * registry shards, diagram docs) back to a captured manifest of heads —
 * `restoreTo` above is the DiagramDoc-specific variant that also preserves the
 * checkpoint list. Returns false if the doc isn't ready or the heads can't be
 * viewed (e.g. this peer hasn't synced that far back), leaving the doc untouched.
 */
export function restoreDocToHeads<T extends object>(
  handle: DocHandle<T>,
  heads: string[]
): boolean {
  const doc = handle.doc()
  if (!doc) return false
  const want = normaliseHeads(heads)
  // GUARD (see headsKnown): skip rather than WIPE a doc whose history this peer
  // doesn't have — the landscape restore reports it as "unavailable".
  if (!headsKnown(doc, want)) {
    console.warn('restoreDocToHeads: requested heads not in local history; skipping', heads)
    return false
  }
  let past: T
  try {
    past = view(doc, want) as T
  } catch (err) {
    // Don't leave the doc half-changed — bail before the write if heads are bad.
    console.error('restoreDocToHeads: could not view at heads', heads, err)
    return false
  }
  changeWithDurabilityTracking(handle, (d: T) => {
    reconcile(d as object, past as object)
  })
  return true
}

export function listCheckpoints(handle: DocHandle<DiagramDoc>): Checkpoint[] {
  return handle.doc()?.checkpoints ?? []
}

export function addCheckpoint(handle: DocHandle<DiagramDoc>, label: string): void {
  const doc = handle.doc()
  if (!doc) return
  // Raw Automerge heads (hex), NOT handle.heads() which returns repo-tagged
  // UrlHeads — `view`/`getHeads` from the core only accept raw hashes.
  const heads = getHeads(doc)
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `cp-${heads.join('').slice(0, 8)}-${label.length}`
  changeWithDurabilityTracking(handle, (d) => {
    if (!d.checkpoints) d.checkpoints = []
    d.checkpoints.push({ id, label, heads, createdAt: new Date().toISOString() })
  })
}

export function removeCheckpoint(handle: DocHandle<DiagramDoc>, id: string): void {
  changeWithDurabilityTracking(handle, (d) => {
    const idx = (d.checkpoints ?? []).findIndex((c) => c.id === id)
    if (idx >= 0) d.checkpoints!.splice(idx, 1)
  })
}
