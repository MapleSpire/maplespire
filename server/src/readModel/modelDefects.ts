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

// A document the projector could not read is DATA, not silence.
//
// Silent data loss in the read model typically comes from TOLERANCE, not from a
// comparison bug: `Object.assign(map, shard?.objects ?? {})` lets a shard that
// resolves to a document without an `objects` field contribute nothing and
// raise nothing. The read model is then smaller than the model, the projector
// reports success, and no counter moves.
//
// That state is reachable in practice: documents with no data chunk exist. An
// empty Automerge document resolves perfectly happily — `repo.find` settles, the
// handle is `ready`, `doc()` returns `{}` — so nothing on the resolution path
// can see it. Only the shape of what came back can.
//
// So the rule here: reading an entity map either produces the map or produces a
// DEFECT. The projector still projects what it could read — refusing to project
// a workspace because one diagram is unopenable would be worse — but the
// shortfall becomes countable, loggable and scrapeable.
//
// WHY THE ABSENT FIELD IS A TRUE POSITIVE and not a false alarm on a legitimately
// empty shard: the client never creates one that way. `bridge.ts` creates shards
// as `createObjectShardHandle({ objects: {} })` and
// `createConnectionShardHandle({ connections: {} })`, and writes registry entries
// with `shard.diagrams[id] = meta`, which would throw on an absent `diagrams`.
// A shard with `objects: {}` is normal and NOT a defect. A shard with no
// `objects` key at all was never initialised by any healthy writer.

/** What went wrong. Deliberately about the SHAPE of what came back, because the
 * resolution path already classifies and reports failures to resolve — these are
 * the cases where resolution SUCCEEDED and the content is still unusable. */
export type ModelDefectKind =
  /** Resolved to undefined/null/array/scalar — not a document at all. */
  | 'document-unreadable'
  /** A record, but the entity field is entirely absent: never initialised. */
  | 'document-uninitialised'
  /** The entity field exists and is not a map. */
  | 'field-not-a-map'
  /** The workspace root names neither a sharded model nor a monolithic one. */
  | 'root-no-model-reference'

export type ModelDefectSource =
  | 'root'
  | 'model-meta'
  | 'model'
  | 'object-shard'
  | 'connection-shard'
  | 'registry-shard'

export interface ModelDefect {
  kind: ModelDefectKind
  source: ModelDefectSource
  /** The document url, or null for the root (whose url the extractor is not given). */
  url: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one entity map out of a resolved document, recording a defect instead of
 * shrugging. Returns an empty map on every defect path so the caller keeps its
 * partial-progress behaviour, while the shortfall is reported rather than
 * invisible.
 *
 * `undefined` and "absent" are the same case on purpose: Automerge rejects
 * `undefined` values, so a field that reads as undefined is a field that is not
 * there.
 */
export function readEntityMapOrDefect<T>(
  doc: unknown,
  field: string,
  source: ModelDefectSource,
  url: string | null,
): { map: Record<string, T>; defect: ModelDefect | null } {
  if (!isRecord(doc)) {
    return { map: {}, defect: { kind: 'document-unreadable', source, url } }
  }
  const value = doc[field]
  if (value === undefined) {
    return { map: {}, defect: { kind: 'document-uninitialised', source, url } }
  }
  if (!isRecord(value)) {
    return { map: {}, defect: { kind: 'field-not-a-map', source, url } }
  }
  return { map: value as Record<string, T>, defect: null }
}

/** Collecting form, for callers that read many documents into one list. */
export function readEntityMap<T>(
  doc: unknown,
  field: string,
  source: ModelDefectSource,
  url: string | null,
  defects: ModelDefect[],
): Record<string, T> {
  const { map, defect } = readEntityMapOrDefect<T>(doc, field, source, url)
  if (defect) defects.push(defect)
  return map
}

/**
 * Whether a defect means the document carries NO information about what it
 * should contain — as opposed to legitimately containing nothing.
 *
 * This distinction decides a data-loss question on the live shard-delta path.
 * That path computes `deletedIds = previous \ current` and deletes the
 * difference, so a shard that reads as empty deletes every row it used to own.
 * `{ objects: {} }` genuinely means "the user removed them all" and must still
 * delete. A document with no `objects` key at all was never initialised — no
 * writer in this product produces one — and is evidence of nothing, so acting on
 * it would destroy rows on the strength of a document that failed to load.
 */
export function isUninformative(defect: ModelDefect | null): boolean {
  return defect !== null && (defect.kind === 'document-unreadable' || defect.kind === 'document-uninitialised')
}

/** Compact, bounded, loggable. Urls are Automerge document urls — no customer
 * content — but the string still reaches logs and a database column, so both the
 * url list and the total length are capped. */
export function summarizeModelDefects(
  defects: readonly ModelDefect[],
  { maxUrls = 3, maxLength = 500 } = {},
): string {
  if (defects.length === 0) return 'none'
  const byKey = new Map<string, string[]>()
  for (const defect of defects) {
    const key = `${defect.source}/${defect.kind}`
    const bucket = byKey.get(key) ?? []
    bucket.push(defect.url ?? '<root>')
    byKey.set(key, bucket)
  }
  const summary = [...byKey.entries()]
    .map(([key, urls]) =>
      `${key}=${urls.length} [${urls.slice(0, maxUrls).join(', ')}${urls.length > maxUrls ? ', …' : ''}]`)
    .join('; ')
  return summary.length <= maxLength ? summary : `${summary.slice(0, maxLength - 1)}…`
}
