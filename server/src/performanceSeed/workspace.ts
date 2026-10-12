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
  Repo,
  type DocumentId,
  type StorageAdapterInterface,
} from '@automerge/automerge-repo'
import { PerformanceSeedPlan } from './generator.js'
import { toPerformanceControlMeta } from './controlMeta.js'
import { copyRootShape } from '../rootShape.js'

export type PerformanceSeedPhase =
  | 'objects'
  | 'connections'
  | 'decision_records'
  | 'model_meta'
  | 'diagrams'
  | 'root'

export interface PerformanceSeedProgress {
  phase: PerformanceSeedPhase
  completed: number
  total: number
  message: string
}

export interface PerformanceWorkspaceOptions {
  modelShardSize?: number
  registryShardSize?: number
  documentsPerRepo?: number
  decisionRecordShardSize?: number
  onProgress?: (progress: PerformanceSeedProgress) => void
}

export interface PerformanceWorkspaceResult {
  rootUrl: string
  modelUrl: string
  modelMetaUrl: string
  objectOverlayUrl: string
  connectionOverlayUrl: string
  objectShardUrls: string[]
  connectionShardUrls: string[]
  decisionRecordShardUrls: string[]
  registryShardUrls: string[]
  registryWriteUrl: string
  /** Ordered by diagram index; used to materialize the static read model. */
  diagramDocumentUrls: string[]
  documentUrls: string[]
  documentCount: number
}

function byId<T extends { id: string }>(values: readonly T[]): Record<string, T> {
  return Object.fromEntries(values.map((value) => [value.id, value]))
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function createRepo(storage: StorageAdapterInterface): Repo {
  return new Repo({ storage, network: [], saveDebounceRate: 0 })
}

async function flushAndClose(repo: Repo, documentIds: DocumentId[]): Promise<void> {
  await repo.flush(documentIds)
  await repo.shutdown()
}

async function writeEntityShards(
  storage: StorageAdapterInterface,
  plan: PerformanceSeedPlan,
  kind: 'objects' | 'connections',
  shardSize: number,
  documentsPerRepo: number,
  onProgress?: PerformanceWorkspaceOptions['onProgress'],
): Promise<string[]> {
  const total = kind === 'objects' ? plan.scale.objects : plan.scale.connections
  const shardCount = Math.ceil(total / shardSize)
  const urls: string[] = []
  for (let batchStart = 0; batchStart < shardCount; batchStart += documentsPerRepo) {
    const repo = createRepo(storage)
    const documentIds: DocumentId[] = []
    const batchEnd = Math.min(shardCount, batchStart + documentsPerRepo)
    for (let shardIndex = batchStart; shardIndex < batchEnd; shardIndex++) {
      const start = shardIndex * shardSize
      const end = Math.min(total, start + shardSize)
      if (kind === 'objects') {
        const values = Array.from({ length: end - start }, (_, offset) => plan.objectAt(start + offset))
        const handle = repo.create({ objects: byId(values) })
        urls.push(handle.url)
        documentIds.push(handle.documentId)
      } else {
        const values = Array.from({ length: end - start }, (_, offset) => plan.connectionAt(start + offset))
        const handle = repo.create({ connections: byId(values) })
        urls.push(handle.url)
        documentIds.push(handle.documentId)
      }
    }
    await flushAndClose(repo, documentIds)
    const completed = Math.min(total, batchEnd * shardSize)
    onProgress?.({
      phase: kind,
      completed,
      total,
      message: `${kind}: ${completed.toLocaleString('en-CA')} / ${total.toLocaleString('en-CA')}`,
    })
  }
  return urls
}

async function writeDecisionRecordShards(
  storage: StorageAdapterInterface,
  plan: PerformanceSeedPlan,
  shardSize: number,
  documentsPerRepo: number,
  onProgress?: PerformanceWorkspaceOptions['onProgress'],
): Promise<string[]> {
  const total = plan.scale.decisionRecords
  const shardCount = Math.ceil(total / shardSize)
  const urls: string[] = []
  for (let batchStart = 0; batchStart < shardCount; batchStart += documentsPerRepo) {
    const repo = createRepo(storage)
    const documentIds: DocumentId[] = []
    const batchEnd = Math.min(shardCount, batchStart + documentsPerRepo)
    for (let shardIndex = batchStart; shardIndex < batchEnd; shardIndex++) {
      const start = shardIndex * shardSize
      const end = Math.min(total, start + shardSize)
      const values = Array.from({ length: end - start }, (_, offset) => plan.decisionRecordAt(start + offset))
      const handle = repo.create({ decisionRecords: byId(values) })
      urls.push(handle.url)
      documentIds.push(handle.documentId)
    }
    await flushAndClose(repo, documentIds)
    const completed = Math.min(total, batchEnd * shardSize)
    onProgress?.({
      phase: 'decision_records',
      completed,
      total,
      message: `decision records: ${completed.toLocaleString('en-CA')} / ${total.toLocaleString('en-CA')}`,
    })
  }
  return urls
}

async function writeModelDocuments(
  storage: StorageAdapterInterface,
  plan: PerformanceSeedPlan,
  objectShardUrls: string[],
  connectionShardUrls: string[],
  decisionRecordShardUrls: string[],
  decisionRecordShardSize: number,
  onProgress?: PerformanceWorkspaceOptions['onProgress'],
): Promise<{
  monolithUrl: string
  modelMetaUrl: string
  objectOverlayUrl: string
  connectionOverlayUrl: string
}> {
  const baseRepo = createRepo(storage)
  const monolith = baseRepo.create({
    objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  // Include explicit control fields so an empty first overlay always has an
  // Automerge change/head of its own. A zero-head snapshot cannot be discovered
  // by a cold peer over sync, which leaves classic clients requesting the same
  // historical segment forever after the server rotates the write head.
  const objectOverlay = baseRepo.create({ objects: {}, writeHeadVersion: 1, writeBatchIds: [] })
  const connectionOverlay = baseRepo.create({ connections: {}, writeHeadVersion: 1, writeBatchIds: [] })
  await flushAndClose(baseRepo, [
    monolith.documentId,
    objectOverlay.documentId,
    connectionOverlay.documentId,
  ])

  // Publish metadata only after every document it references is durable.
  const metaRepo = createRepo(storage)
  const modelMeta = metaRepo.create(toPerformanceControlMeta({
    objectShardUrls: [...objectShardUrls, objectOverlay.url],
    connectionShardUrls: [...connectionShardUrls, connectionOverlay.url],
    decisionRecordShardUrls,
    decisionRecordCount: plan.scale.decisionRecords,
    decisionRecordShardSize,
    editsObjectShardUrl: objectOverlay.url,
    editsObjectShardUrls: [objectOverlay.url],
    editsConnectionShardUrl: connectionOverlay.url,
    editsConnectionShardUrls: [connectionOverlay.url],
    deletedObjectIds: [],
    deletedConnectionIds: [],
    groups: {},
    domains: byId(plan.domains()),
    tagSnapshots: plan.tagSnapshots(),
    decisionRecords: {},
  }))
  await flushAndClose(metaRepo, [modelMeta.documentId])
  onProgress?.({
    phase: 'model_meta', completed: 1, total: 1,
    message: 'model metadata and editable overlays are durable',
  })
  return {
    monolithUrl: monolith.url,
    modelMetaUrl: modelMeta.url,
    objectOverlayUrl: objectOverlay.url,
    connectionOverlayUrl: connectionOverlay.url,
  }
}

async function writeDiagramDocuments(
  storage: StorageAdapterInterface,
  plan: PerformanceSeedPlan,
  registryShardSize: number,
  documentsPerRepo: number,
  onProgress?: PerformanceWorkspaceOptions['onProgress'],
): Promise<{ registryShardUrls: string[]; diagramDocumentUrls: string[]; registryWriteUrl: string }> {
  const registryShardUrls: string[] = []
  const diagramDocumentUrls: string[] = []
  for (let batchStart = 0; batchStart < plan.diagramCount; batchStart += registryShardSize) {
    const metas: Array<{
      id: string
      name: string
      type: string
      docUrl: string
      parentObjectId?: string
      objectIds: string[]
      connectionIds: string[]
      groupIds: string[]
    }> = []
    const batchEnd = Math.min(plan.diagramCount, batchStart + registryShardSize)
    // A registry shard can describe hundreds of diagrams, but flushing all of
    // those documents through one Repo opens one storage transaction per
    // document. Keep the registry grouping while persisting its diagram docs
    // in small repos so the writer never exhausts the PostgreSQL pool.
    for (let documentBatchStart = batchStart; documentBatchStart < batchEnd; documentBatchStart += documentsPerRepo) {
      const repo = createRepo(storage)
      const documentIds: DocumentId[] = []
      const documentBatchEnd = Math.min(batchEnd, documentBatchStart + documentsPerRepo)
      for (let index = documentBatchStart; index < documentBatchEnd; index++) {
        const diagram = plan.diagramAt(index)
        const {
          id, shapeCount: _shapeCount, comments, flows,
          ...diagramDocument
        } = diagram
        const handle = repo.create({
          ...diagramDocument,
          comments,
          flows,
          checkpoints: [],
        })
        documentIds.push(handle.documentId)
        diagramDocumentUrls.push(handle.url)
        metas.push({
          id,
          name: diagram.name,
          type: diagram.type,
          docUrl: handle.url,
          ...(diagram.parentObjectId ? { parentObjectId: diagram.parentObjectId } : {}),
          objectIds: diagram.objectIds,
          connectionIds: diagram.connectionIds,
          groupIds: diagram.groupIds,
        })
      }
      await flushAndClose(repo, documentIds)
      onProgress?.({
        phase: 'diagrams',
        completed: documentBatchEnd,
        total: plan.diagramCount,
        message: `diagrams: ${documentBatchEnd.toLocaleString('en-CA')} / ${plan.diagramCount.toLocaleString('en-CA')}`,
      })
    }

    const registryRepo = createRepo(storage)
    const registry = registryRepo.create({ diagrams: byId(metas) })
    registryShardUrls.push(registry.url)
    await flushAndClose(registryRepo, [registry.documentId])
  }
  // Keep one small mutable registry shard separate from the immutable 30k-entry
  // baseline. Summary-only clients load only this write head, so creating a
  // diagram stays O(1) without materializing every baseline registry shard.
  const writeRepo = createRepo(storage)
  const writeRegistry = writeRepo.create({ diagrams: {} })
  await flushAndClose(writeRepo, [writeRegistry.documentId])
  registryShardUrls.push(writeRegistry.url)
  return { registryShardUrls, diagramDocumentUrls, registryWriteUrl: writeRegistry.url }
}

export async function createPerformanceWorkspaceRoot(
  storage: StorageAdapterInterface,
  plan: PerformanceSeedPlan,
  options: PerformanceWorkspaceOptions = {},
): Promise<PerformanceWorkspaceResult> {
  const modelShardSize = positiveInteger('modelShardSize', options.modelShardSize ?? 512)
  const registryShardSize = positiveInteger('registryShardSize', options.registryShardSize ?? 200)
  const decisionRecordShardSize = positiveInteger('decisionRecordShardSize', options.decisionRecordShardSize ?? 500)
  // Automerge can issue both incremental and total saves for each document;
  // three documents leave headroom below the default 10-connection PG pool.
  const documentsPerRepo = positiveInteger('documentsPerRepo', options.documentsPerRepo ?? 3)
  const objectShardUrls = await writeEntityShards(
    storage, plan, 'objects', modelShardSize, documentsPerRepo, options.onProgress,
  )
  const connectionShardUrls = await writeEntityShards(
    storage, plan, 'connections', modelShardSize, documentsPerRepo, options.onProgress,
  )
  const decisionRecordShardUrls = await writeDecisionRecordShards(
    storage, plan, decisionRecordShardSize, documentsPerRepo, options.onProgress,
  )
  const model = await writeModelDocuments(
    storage, plan, objectShardUrls, connectionShardUrls, decisionRecordShardUrls,
    decisionRecordShardSize, options.onProgress,
  )
  const diagrams = await writeDiagramDocuments(
    storage, plan, registryShardSize, documentsPerRepo, options.onProgress,
  )

  const repo = createRepo(storage)
  // Through the ONE root-shape mapper (rootShape.ts) — no local root literal.
  const root = repo.create(copyRootShape(undefined, {
    modelUrl: model.monolithUrl,
    modelMetaUrl: model.modelMetaUrl,
    shardUrls: diagrams.registryShardUrls,
    registrySummaryOnly: true,
    diagramCount: plan.diagramCount,
    registryWriteUrl: diagrams.registryWriteUrl,
  }))
  await flushAndClose(repo, [root.documentId])
  options.onProgress?.({ phase: 'root', completed: 1, total: 1, message: 'workspace root is durable and ready to publish' })

  const objectUrls = [...objectShardUrls, model.objectOverlayUrl]
  const connectionUrls = [...connectionShardUrls, model.connectionOverlayUrl]
  const documentUrls = [...new Set([
    root.url,
    model.monolithUrl,
    model.modelMetaUrl,
    ...objectUrls,
    ...connectionUrls,
    ...decisionRecordShardUrls,
    ...diagrams.registryShardUrls,
    ...diagrams.diagramDocumentUrls,
  ])]
  return {
    rootUrl: root.url,
    modelUrl: model.monolithUrl,
    modelMetaUrl: model.modelMetaUrl,
    objectOverlayUrl: model.objectOverlayUrl,
    connectionOverlayUrl: model.connectionOverlayUrl,
    objectShardUrls: objectUrls,
    connectionShardUrls: connectionUrls,
    decisionRecordShardUrls,
    registryShardUrls: diagrams.registryShardUrls,
    registryWriteUrl: diagrams.registryWriteUrl,
    diagramDocumentUrls: diagrams.diagramDocumentUrls,
    documentUrls,
    documentCount: documentUrls.length,
  }
}
