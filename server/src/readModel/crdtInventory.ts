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

// An INDEPENDENT oracle for what the CRDT contains.
//
// A divergence detector that built its CRDT operand with
// `extractModelEntities` — the projector's own extractor — would compare the
// writer against itself: an empty shard or a stale tombstone would drop rows
// from BOTH operands and the detector would report `clean` with matching
// counts.
//
// So the rule for this file is simple and load-bearing: **it must not import
// anything from the projector.** It re-walks the document graph itself. Two
// implementations of the same traversal only agree when both are right; one
// implementation compared with itself always agrees.
//
// The second rule is that it FAILS where the projector's traversal shrugs.
// `extractModelEntities` does `Object.assign(map, shard?.objects ?? {})`, so a
// shard that resolves to something unexpected contributes nothing and raises
// nothing — invisible data loss. Here that throws. A detector that cannot read
// the truth must say so, not report a smaller truth.

export interface CrdtInventory {
  objects: string[]
  connections: string[]
  groups: string[]
  diagrams: string[]
  /** `${diagramId}:${flowId}` — flows live on diagram documents, not in the
   * model shards. */
  flows: string[]
}

export type ResolveDoc = (url: string) => Promise<unknown>

class InventoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new InventoryError(`${what} is not an array`)
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Read a document, refusing anything that is not a record.
 *
 * `resolve` rejecting propagates: an unreadable shard makes the whole inventory
 * fail. That is the point — a partial inventory compared against a complete
 * read model manufactures phantom divergence, and a partial inventory compared
 * against a partial read model hides real divergence.
 */
async function readDoc(resolve: ResolveDoc, url: string, what: string): Promise<Record<string, unknown>> {
  let doc: unknown
  try {
    doc = await resolve(url)
  } catch (error) {
    throw new InventoryError(`${what} ${url} could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(doc)) throw new InventoryError(`${what} ${url} did not resolve to a document`)
  return doc
}

function keysOfMap(container: Record<string, unknown>, field: string, what: string): string[] {
  const value = container[field]
  if (value === undefined) return []
  if (!isRecord(value)) throw new InventoryError(`${what}.${field} is not a map`)
  return Object.keys(value)
}

/** Walk root -> ModelMeta -> shards -> ids, and root -> registry -> diagrams ->
 * flows. Deliberately written from the document types rather than copied from
 * the projector. */
export async function collectCrdtInventory(rootDoc: unknown, resolve: ResolveDoc): Promise<CrdtInventory> {
  if (!isRecord(rootDoc)) throw new InventoryError('workspace root did not resolve to a document')

  const objects = new Set<string>()
  const connections = new Set<string>()
  const groups = new Set<string>()
  const diagrams: string[] = []
  const flows: string[] = []

  const modelMetaUrl = typeof rootDoc.modelMetaUrl === 'string' ? rootDoc.modelMetaUrl : null
  const modelUrl = typeof rootDoc.modelUrl === 'string' && rootDoc.modelUrl.length > 0 ? rootDoc.modelUrl : null

  if (modelMetaUrl) {
    const meta = await readDoc(resolve, modelMetaUrl, 'ModelMeta')
    for (const url of stringArray(meta.objectShardUrls, 'ModelMeta.objectShardUrls')) {
      const shard = await readDoc(resolve, url, 'object shard')
      for (const id of keysOfMap(shard, 'objects', 'object shard')) objects.add(id)
    }
    for (const url of stringArray(meta.connectionShardUrls, 'ModelMeta.connectionShardUrls')) {
      const shard = await readDoc(resolve, url, 'connection shard')
      for (const id of keysOfMap(shard, 'connections', 'connection shard')) connections.add(id)
    }
    for (const id of keysOfMap(meta, 'groups', 'ModelMeta')) groups.add(id)
    // Tombstones are applied LAST and only after the shards were read, so a
    // tombstone for an id no shard carries is visible as a no-op rather than
    // silently shaping the result.
    for (const id of stringArray(meta.deletedObjectIds, 'ModelMeta.deletedObjectIds')) objects.delete(id)
    for (const id of stringArray(meta.deletedConnectionIds, 'ModelMeta.deletedConnectionIds')) connections.delete(id)
  } else if (modelUrl) {
    // Pre-sharding workspaces keep one monolithic model document.
    const model = await readDoc(resolve, modelUrl, 'ModelDoc')
    const inner = isRecord(model.model) ? model.model : model
    for (const id of keysOfMap(inner, 'objects', 'ModelDoc')) objects.add(id)
    for (const id of keysOfMap(inner, 'connections', 'ModelDoc')) connections.add(id)
    for (const id of keysOfMap(inner, 'groups', 'ModelDoc')) groups.add(id)
  } else {
    throw new InventoryError('workspace root carries neither modelMetaUrl nor modelUrl')
  }

  // Diagrams and their flows. A `registrySummaryOnly` root materialises its
  // registry server-side and exposes no shard urls to walk; that is not an
  // error, but the caller must know the diagram side was not inventoried.
  const summaryOnly = rootDoc.registrySummaryOnly === true
  if (!summaryOnly) {
    for (const shardUrl of stringArray(rootDoc.shardUrls, 'root.shardUrls')) {
      const shard = await readDoc(resolve, shardUrl, 'registry shard')
      const registry = isRecord(shard.diagrams) ? shard.diagrams : {}
      for (const [diagramId, meta] of Object.entries(registry)) {
        diagrams.push(diagramId)
        const docUrl = isRecord(meta) && typeof meta.docUrl === 'string' ? meta.docUrl : null
        if (!docUrl) continue
        const diagramDoc = await readDoc(resolve, docUrl, `diagram ${diagramId}`)
        for (const flowId of keysOfMap(diagramDoc, 'flows', `diagram ${diagramId}`)) {
          flows.push(`${diagramId}:${flowId}`)
        }
      }
    }
  }

  return {
    objects: [...objects],
    connections: [...connections],
    groups: [...groups],
    diagrams,
    flows,
  }
}

export { InventoryError }
