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

import { createHash } from 'node:crypto'

/**
 * The VALUE half of the compaction witness.
 *
 * ## Why this exists next to `collectCrdtInventory`
 *
 * The inventory returns IDS ONLY. It witnesses "no entity vanished" and says
 * nothing about "no edit regressed" — a compaction that folded a STALE overlay
 * snapshot over a newer base value loses an edit while every id survives, and
 * the inventory reports that as clean. This walk emits a content hash per id, so
 * the two together answer both halves.
 *
 * ## Why it is written from the document types and not from `foldCollection`
 *
 * A witness that reuses the code under test agrees with it by construction. If
 * `foldCollection` mis-resolves overlay precedence, a witness built on
 * `foldCollection` mis-resolves it identically and reports a match. This
 * traversal is deliberately a second implementation of the same rule — root →
 * ModelMeta → shards, overlay LAST — and its disagreement with the projector is
 * the signal.
 *
 * ## Overlay-last-wins, stated because it is the whole subtlety
 *
 * `ModelMeta.objectShardUrls` keeps the overlay segments LAST, so a later shard
 * shadows an earlier one for the same id. Walking in array order and letting the
 * last write win reproduces what a reader sees. Tombstones are applied AFTER the
 * shards, so a tombstone for an id no shard carries is a visible no-op rather
 * than something that silently shapes the result.
 *
 * The caller supplies `resolve`; this module never opens storage itself, so the
 * run harness is free to open it with `network: []` in a separate process — the
 * independence that makes it a witness rather than a second opinion from the
 * same mouth.
 */

export type ResolveDoc = (url: string) => Promise<unknown>

export interface ContentWitness {
  /** id → hash of the value a reader would see, overlay-last-wins. */
  readonly objects: ReadonlyMap<string, string>
  readonly connections: ReadonlyMap<string, string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/**
 * A stable hash of a value, independent of key insertion order.
 *
 * Automerge documents are maps whose key order is not a property of the value,
 * so `JSON.stringify` of a folded map can differ byte-for-byte from the same
 * value before folding while nothing a reader sees has changed. That would make
 * the witness report a regression on every run — and a witness that cries wolf
 * gets deleted, which loses the real assertion.
 */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

async function readDoc(resolve: ResolveDoc, url: string, what: string): Promise<Record<string, unknown>> {
  const doc = await resolve(url)
  if (!isRecord(doc)) throw new Error(`compaction witness: ${what} (${url}) did not resolve to a document`)
  return doc
}

async function walkCollection(
  resolve: ResolveDoc,
  shardUrls: readonly string[],
  collection: 'objects' | 'connections',
  tombstones: readonly string[],
): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  // ARRAY ORDER, and last-write-wins: the overlay segments are kept last, so
  // this is what shadows a base value with its edited copy. Reversing this loop
  // would witness the pre-edit value and call a correct fold a regression.
  for (const url of shardUrls) {
    const shard = await readDoc(resolve, url, `${collection} shard`)
    const map = shard[collection]
    if (!isRecord(map)) continue
    for (const [id, value] of Object.entries(map)) seen.set(id, stableHash(value))
  }
  for (const id of tombstones) seen.delete(id)
  return seen
}

export async function collectContentWitness(
  rootDoc: unknown,
  resolve: ResolveDoc,
): Promise<ContentWitness> {
  if (!isRecord(rootDoc)) throw new Error('compaction witness: workspace root did not resolve to a document')
  const modelMetaUrl = typeof rootDoc.modelMetaUrl === 'string' ? rootDoc.modelMetaUrl : null
  if (!modelMetaUrl) {
    // A pre-sharding workspace has no overlay to fold, so compaction cannot be
    // pointed at it. Refusing beats returning an empty witness that would make
    // any comparison trivially pass.
    throw new Error('compaction witness: workspace root carries no modelMetaUrl — nothing to witness')
  }
  const meta = await readDoc(resolve, modelMetaUrl, 'ModelMeta')
  return {
    objects: await walkCollection(
      resolve, stringArray(meta.objectShardUrls), 'objects', stringArray(meta.deletedObjectIds),
    ),
    connections: await walkCollection(
      resolve, stringArray(meta.connectionShardUrls), 'connections', stringArray(meta.deletedConnectionIds),
    ),
  }
}

export interface WitnessVerdict {
  readonly pass: boolean
  /** Ids present before and absent after — an entity vanished. */
  readonly vanished: string[]
  /** Ids absent before and present after. A fold invents nothing, so this is a
   *  finding, not a curiosity. */
  readonly appeared: string[]
  /** Ids whose value changed and that the run did NOT report as `kept`. */
  readonly regressed: string[]
  /** Ids whose value changed and that the run DID report as `kept` — expected,
   *  and listed so the number can be compared against the run's own count. */
  readonly changedButKept: string[]
}

/**
 * Compare two witnesses taken before and after a compaction.
 *
 * PASS requires the id sets identical AND every hash identical for every id the
 * run did not report in `kept`. A `kept` entry is one edited concurrently during
 * the run, so its value is ALLOWED to differ — that is the only sanctioned
 * difference, and it must be sanctioned by the run's own report rather than
 * assumed from the data.
 */
export function compareContentWitness(
  before: ContentWitness,
  after: ContentWitness,
  keptIds: readonly string[] = [],
): WitnessVerdict {
  const kept = new Set(keptIds)
  const vanished: string[] = []
  const appeared: string[] = []
  const regressed: string[] = []
  const changedButKept: string[] = []

  for (const collection of ['objects', 'connections'] as const) {
    const b = before[collection]
    const a = after[collection]
    for (const [id, hash] of b) {
      if (!a.has(id)) { vanished.push(`${collection}:${id}`); continue }
      if (a.get(id) === hash) continue
      if (kept.has(id)) changedButKept.push(`${collection}:${id}`)
      else regressed.push(`${collection}:${id}`)
    }
    for (const id of a.keys()) if (!b.has(id)) appeared.push(`${collection}:${id}`)
  }

  return {
    pass: vanished.length === 0 && appeared.length === 0 && regressed.length === 0,
    vanished, appeared, regressed, changedButKept,
  }
}
