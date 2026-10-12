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

import type { DocumentId, Repo } from '@automerge/automerge-repo'
import type { SeedModel } from './generator.js'
import { buildEmptyRootShape } from '../rootShape.js'
import { buildModelMeta } from '../modelMeta.js'

/**
 * Build the complete sharded Automerge graph for an organization demo seed.
 * The caller may publish the returned root in PostgreSQL only after this
 * function has durably flushed every document referenced by that root. It
 * batch-claims `createdDocumentIds` right after its INSERT INTO versions, then
 * sets the coverage marker.
 */
export async function createSeedWorkspaceRoot(
  repo: Repo,
  model: SeedModel,
): Promise<{ rootUrl: string; createdDocumentIds: string[] }> {
  const createdDocumentIds: DocumentId[] = []
  const track = <T extends { documentId: DocumentId }>(handle: T): T => {
    createdDocumentIds.push(handle.documentId)
    return handle
  }
  const objectsById: Record<string, unknown> = {}
  for (const object of model.objects) objectsById[object.id] = object
  const connectionsById: Record<string, unknown> = {}
  for (const connection of model.connections) connectionsById[connection.id] = connection

  const monolith = track(repo.create({
    objects: {},
    connections: {},
    groups: {},
    domains: {},
    tagSnapshots: {},
    decisionRecords: {},
  }))
  await monolith.whenReady()
  const objectShard = track(repo.create({ objects: objectsById }))
  await objectShard.whenReady()
  const objectOverlay = track(repo.create({ objects: {}, writeHeadVersion: 1 }))
  await objectOverlay.whenReady()
  const connectionShard = track(repo.create({ connections: connectionsById }))
  await connectionShard.whenReady()
  const connectionOverlay = track(repo.create({ connections: {}, writeHeadVersion: 1 }))
  await connectionOverlay.whenReady()
  // Always build ModelMeta through `buildModelMeta`, never a literal, so the
  // protocol version and head ordering stay defined in one place.
  const meta = track(repo.create(buildModelMeta({
    objectShardUrls: [objectShard.url],
    connectionShardUrls: [connectionShard.url],
    objectWriteHead: objectOverlay.url,
    connectionWriteHead: connectionOverlay.url,
    groups: model.groups,
    domains: model.domains,
    tagSnapshots: model.tagSnapshots,
    decisionRecords: {},
  })))
  await meta.whenReady()

  const diagramsMeta: Record<string, unknown> = {}
  for (const diagram of model.diagrams) {
    const doc = track(repo.create({
      name: diagram.name,
      type: diagram.type,
      ...(diagram.parentObjectId ? { parentObjectId: diagram.parentObjectId } : {}),
      objectIds: diagram.objectIds,
      connectionIds: diagram.connectionIds,
      groupIds: diagram.groupIds,
      layouts: diagram.layouts,
      comments: {},
      flows: {},
      checkpoints: [],
    }))
    await doc.whenReady()
    diagramsMeta[diagram.id] = {
      id: diagram.id,
      name: diagram.name,
      type: diagram.type,
      docUrl: doc.url,
      ...(diagram.parentObjectId ? { parentObjectId: diagram.parentObjectId } : {}),
      objectIds: diagram.objectIds,
      connectionIds: diagram.connectionIds,
      groupIds: diagram.groupIds,
    }
  }
  const registryShard = track(repo.create({ diagrams: diagramsMeta }))
  await registryShard.whenReady()

  // The empty-root shape comes from the ONE root-shape module (rootShape.ts);
  // the fill below is an in-place mutation of a doc this function just created
  // and only touches fields inside the closed ROOT_SHAPE_FIELDS list.
  const rootHandle = track(repo.create(buildEmptyRootShape()))
  await rootHandle.whenReady()
  rootHandle.change((root) => {
    const mutable = root as { modelUrl: string; shardUrls: string[]; modelMetaUrl?: string }
    mutable.modelUrl = monolith.url
    mutable.shardUrls = [registryShard.url]
    mutable.modelMetaUrl = meta.url
  })
  // Repo saves are debounced. Publishing this URL in `versions` before a
  // flush can leave a durable root pointing at missing model/diagram docs if
  // the process restarts, and mapping the workspace while saves are pending
  // can also make the storage fence reject those late provisioning writes.
  await repo.flush(createdDocumentIds)
  return { rootUrl: rootHandle.url, createdDocumentIds: createdDocumentIds.map((id) => String(id)) }
}
