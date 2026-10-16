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

import { randomBytes } from 'node:crypto'
import { isValidAutomergeUrl, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import { materializeFullModel, type FullModel } from '../../draft/materialize.js'
import {
  deleteOverlayEntities,
  writeOverlayEntities,
  type OverlayMetaLike,
  type OverlaySegmentClaim,
} from '../../overlaySegments.js'
import { createClaimedDocument, type WorkspaceKey } from '../../rbac/docScope.js'
import type { SealedRepo } from '../../rbac/sealedRepo.js'
import { findReadyDocument } from '../../automergeRepoCompat.js'

/**
 * Server-side reads + writes on a workspace root for the AI tools — the same
 * doc topology the draft merge writes (draft/applyMerge.ts):
 *
 *  - sharded model: ModelMeta holds inline collections (groups/domains/tags/
 *    decisionRecords) + object/connection shard urls; entity upserts land in
 *    the PERSISTENT edits-overlay shard (kept LAST in the shard list so the
 *    read model overlays it last-wins), deletes append id tombstones;
 *  - monolithic model: everything lives on the root's modelUrl doc;
 *  - diagrams: a registry stub (denormalized) in a root registry shard + one
 *    DiagramDoc per diagram (settings + composition + layouts/flows/comments).
 *
 * Every write goes through `clonePlain` — Automerge REJECTS `undefined`
 * property values (workspace-isolation fix), and a JSON round-trip strips them.
 */

const SHARD_SIZE = Number(process.env.AM_SHARD_SIZE ?? 200)

export type EntityColl = 'objects' | 'connections'
export type InlineColl = 'groups' | 'domains' | 'tagSnapshots' | 'decisionRecords'

interface RootLike {
  modelUrl?: string
  modelMetaUrl?: string
  shardUrls?: string[]
}
interface MetaLike extends OverlayMetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
  groups?: Record<string, unknown>
  domains?: Record<string, unknown>
  tagSnapshots?: Record<string, unknown>
  decisionRecords?: Record<string, unknown>
  [k: string]: unknown
}
type ModelDocLike = Record<string, Record<string, unknown>>
interface RegistryShardDoc {
  diagrams: Record<string, Record<string, unknown>>
}
export interface DiagramDocLike {
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
  layouts?: Record<string, unknown>
  flows?: Record<string, unknown>
  comments?: Record<string, unknown>
  checkpoints?: unknown[]
  [k: string]: unknown
}

/** Deep plain copy; strips Automerge proxies AND `undefined` values. */
export function clonePlain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** New entity id — same base36 alphabet as the client's `generateId()`, a
 * couple of chars longer (server-minted ids should never collide with a
 * 7-char client id space). */
export function newEntityId(): string {
  return randomBytes(8).toString('hex').slice(0, 10)
}

async function find<T>(repo: SealedRepo, url: string): Promise<DocHandle<T>> {
  if (!isValidAutomergeUrl(url)) throw new Error(`invalid automerge url: ${url}`)
  const h = await findReadyDocument<T>(repo, url)
  return h
}

async function rootHandle(repo: SealedRepo, rootUrl: string): Promise<DocHandle<RootLike>> {
  return find<RootLike>(repo, rootUrl)
}

// ---------------------------------------------------------------------------
// Model entity writes (objects / connections)
// ---------------------------------------------------------------------------

/** Upsert full entity values (id-keyed). Read-modify-write is the CALLER's
 * job (merge patches against the materialized model first) — this writes the
 * given values verbatim. */
export async function upsertModelEntities(
  repo: SealedRepo,
  rootUrl: string,
  coll: EntityColl,
  entities: Record<string, unknown>,
  workspace: WorkspaceKey,
): Promise<void> {
  const ids = Object.keys(entities)
  if (ids.length === 0) return
  const values = clonePlain(entities)
  const root = (await rootHandle(repo, rootUrl)).doc()
  if (!root) throw new Error('workspace root unavailable')
  const sharded = !!root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)

  if (!sharded) {
    if (!root.modelUrl || !isValidAutomergeUrl(root.modelUrl)) throw new Error('workspace has no model document')
    const model = await find<ModelDocLike>(repo, root.modelUrl)
    model.change((m) => {
      const c = m[coll] ?? (m[coll] = {})
      for (const id of ids) c[id] = values[id] as Record<string, unknown>
    })
    return
  }

  const meta = await find<MetaLike>(repo, root.modelMetaUrl!)
  // E4-F: a full overlay head makes this write CREATE a fresh segment, which
  // must carry its claim before ModelMeta points at it.
  const claim: OverlaySegmentClaim = { workspace, rootUrl }
  await writeOverlayEntities(
    repo,
    meta as unknown as DocHandle<OverlayMetaLike>,
    coll,
    values,
    undefined,
    undefined,
    claim,
  )
  // Un-tombstone re-created/edited ids or the read model's tombstone pass
  // (applied last) would delete the value we just wrote.
  const tombField = coll === 'objects' ? 'deletedObjectIds' : 'deletedConnectionIds'
  const idSet = new Set(ids)
  meta.change((m) => {
    const arr = m[tombField] as string[] | undefined
    if (!arr) return
    for (let i = arr.length - 1; i >= 0; i--) if (idSet.has(arr[i])) arr.splice(i, 1)
  })
}

export async function deleteModelEntities(
  repo: SealedRepo,
  rootUrl: string,
  coll: EntityColl,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return
  const root = (await rootHandle(repo, rootUrl)).doc()
  if (!root) throw new Error('workspace root unavailable')
  const sharded = !!root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)

  if (!sharded) {
    if (!root.modelUrl || !isValidAutomergeUrl(root.modelUrl)) return
    const model = await find<ModelDocLike>(repo, root.modelUrl)
    model.change((m) => {
      const c = m[coll]
      if (c) for (const id of ids) delete c[id]
    })
    return
  }

  const meta = await find<MetaLike>(repo, root.modelMetaUrl!)
  const tombField = coll === 'objects' ? 'deletedObjectIds' : 'deletedConnectionIds'
  meta.change((m) => {
    const arr = (m[tombField] ?? (m[tombField] = [])) as string[]
    const have = new Set(arr)
    for (const id of ids) if (!have.has(id)) { arr.push(id); have.add(id) }
  })
  await deleteOverlayEntities(
    repo,
    meta as unknown as DocHandle<OverlayMetaLike>,
    coll,
    ids,
  )
}

// ---------------------------------------------------------------------------
// Inline collections (groups / domains / tags / decisionRecords)
// ---------------------------------------------------------------------------

export async function upsertInlineEntities(
  repo: SealedRepo,
  rootUrl: string,
  coll: InlineColl,
  entities: Record<string, unknown>
): Promise<void> {
  const ids = Object.keys(entities)
  if (ids.length === 0) return
  const values = clonePlain(entities)
  const root = (await rootHandle(repo, rootUrl)).doc()
  if (!root) throw new Error('workspace root unavailable')
  const sharded = !!root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)
  const target = sharded ? root.modelMetaUrl! : root.modelUrl
  if (!target || !isValidAutomergeUrl(target)) throw new Error('workspace has no model document')
  const handle = await find<MetaLike>(repo, target)
  handle.change((m) => {
    const c = (m[coll] as Record<string, unknown>) ?? (m[coll] = {})
    for (const id of ids) (c as Record<string, unknown>)[id] = values[id]
  })
}

export async function deleteInlineEntities(
  repo: SealedRepo,
  rootUrl: string,
  coll: InlineColl,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return
  const root = (await rootHandle(repo, rootUrl)).doc()
  if (!root) throw new Error('workspace root unavailable')
  const sharded = !!root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)
  const target = sharded ? root.modelMetaUrl! : root.modelUrl
  if (!target || !isValidAutomergeUrl(target)) return
  const handle = await find<MetaLike>(repo, target)
  handle.change((m) => {
    const c = m[coll] as Record<string, unknown> | undefined
    if (c) for (const id of ids) delete c[id]
  })
}

// ---------------------------------------------------------------------------
// Diagrams (registry stub + DiagramDoc)
// ---------------------------------------------------------------------------

async function findRegistryShardWithDiagram(
  repo: SealedRepo,
  shardUrls: string[],
  id: string
): Promise<DocHandle<RegistryShardDoc> | null> {
  for (const u of shardUrls) {
    if (!isValidAutomergeUrl(u)) continue
    const h = await find<RegistryShardDoc>(repo, u)
    if (h.doc()?.diagrams?.[id]) return h
  }
  return null
}

async function findOrCreateRegistryShard(
  repo: SealedRepo,
  root: DocHandle<RootLike>,
  workspace: WorkspaceKey,
): Promise<DocHandle<RegistryShardDoc>> {
  const shardUrls = root.doc()?.shardUrls ?? []
  for (const u of shardUrls) {
    if (!isValidAutomergeUrl(u)) continue
    const h = await find<RegistryShardDoc>(repo, u)
    if (Object.keys(h.doc()?.diagrams ?? {}).length < SHARD_SIZE) return h
  }
  // A root must never publish a registry-shard URL before that shard can be
  // loaded by a cold peer (the save debounce is intentionally long in some
  // deployments, so `whenReady()` alone is not a durability boundary) — nor
  // (E4-F) before it is claimed: the wrapper does created -> flushed ->
  // claimed, and a claim throw aborts before `root.shardUrls` ever changes.
  const fresh = await createClaimedDocument<RegistryShardDoc>(
    repo, workspace, root.url, { diagrams: {} },
  )
  root.change((r) => {
    const urls = (r.shardUrls ?? (r.shardUrls = [])) as string[]
    urls.push(fresh.url)
  })
  await repo.flush([root.documentId])
  return fresh
}

/** Resolve a diagram id → its registry stub + DiagramDoc handle (or null). */
export async function findDiagram(
  repo: SealedRepo,
  rootUrl: string,
  id: string
): Promise<{ stub: Record<string, unknown>; doc: DocHandle<DiagramDocLike>; shard: DocHandle<RegistryShardDoc> } | null> {
  const root = (await rootHandle(repo, rootUrl)).doc()
  if (!root) return null
  const shard = await findRegistryShardWithDiagram(repo, root.shardUrls ?? [], id)
  if (!shard) return null
  const stub = shard.doc()?.diagrams?.[id]
  const docUrl = stub?.docUrl as string | undefined
  if (!stub || !docUrl || !isValidAutomergeUrl(docUrl)) return null
  const doc = await find<DiagramDocLike>(repo, docUrl)
  return { stub: clonePlain(stub), doc, shard }
}

export interface CreateDiagramInput {
  id?: string
  name: string
  type: 'context' | 'container' | 'component'
  description?: string
  parentObjectId?: string
  domainId?: string
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
  /** Initial per-entity {position,size} overrides, keyed by entity id. */
  layouts?: Record<string, unknown>
}

export async function createDiagramDoc(
  repo: SealedRepo,
  rootUrl: string,
  input: CreateDiagramInput,
  workspace: WorkspaceKey,
): Promise<string> {
  const id = input.id ?? newEntityId()
  const root = await rootHandle(repo, rootUrl)
  if (!root.doc()) throw new Error('workspace root unavailable')

  const body: DiagramDocLike = clonePlain({
    name: input.name,
    type: input.type,
    ...(input.description ? { description: input.description } : {}),
    ...(input.parentObjectId ? { parentObjectId: input.parentObjectId } : {}),
    ...(input.domainId ? { domainId: input.domainId } : {}),
    objectIds: input.objectIds ?? [],
    connectionIds: input.connectionIds ?? [],
    groupIds: input.groupIds ?? [],
    layouts: input.layouts ?? {},
    flows: {},
    comments: {},
    checkpoints: [],
  })
  // Publish child-before-parent: created -> flushed -> claimed, and only then
  // does the registry stub below advertise the URL. Without the flush the
  // registry can advertise the new DiagramDoc while its debounced save is
  // still pending (a newly connected browser then receives `doc-unavailable`);
  // without the claim-before-stub a restart between the two would leave a
  // published link the route gate has to constat. This site was the one
  // creator that already had the order right — createClaimedDocument is its
  // generalization, behaviour-identical.
  const docHandle = await createClaimedDocument<DiagramDocLike>(repo, workspace, rootUrl, body)

  const stub: Record<string, unknown> = clonePlain({
    id,
    name: input.name,
    type: input.type,
    docUrl: docHandle.url,
    ...(input.parentObjectId ? { parentObjectId: input.parentObjectId } : {}),
    objectIds: input.objectIds ?? [],
    connectionIds: input.connectionIds ?? [],
    groupIds: input.groupIds ?? [],
  })
  const shard = await findOrCreateRegistryShard(repo, root, workspace)
  shard.change((s) => {
    s.diagrams[id] = stub
  })
  await repo.flush([shard.documentId])
  return id
}

export interface UpdateDiagramInput {
  /** Scalar settings to set on the DiagramDoc (name, description, domainId…). */
  settings?: Record<string, unknown>
  addObjectIds?: string[]
  removeObjectIds?: string[]
  addConnectionIds?: string[]
  removeConnectionIds?: string[]
  addGroupIds?: string[]
  removeGroupIds?: string[]
  /** Per-entity {position,size} overrides on this diagram, keyed by entity id. */
  layoutUpserts?: Record<string, unknown>
  layoutDeletes?: string[]
}

function addUnique(arr: string[], ids: string[]): void {
  const have = new Set(arr)
  for (const id of ids) if (!have.has(id)) { arr.push(id); have.add(id) }
}
function removeAll(arr: string[], ids: string[]): void {
  const drop = new Set(ids)
  for (let i = arr.length - 1; i >= 0; i--) if (drop.has(arr[i])) arr.splice(i, 1)
}

export async function updateDiagramDoc(
  repo: SealedRepo,
  rootUrl: string,
  id: string,
  patch: UpdateDiagramInput,
  /**
   * Optional out-parameter: every document this call CHANGED is added to it.
   *
   * It exists so a caller holding a lock can `repo.flush(theseIds)` instead of
   * `repo.flush()`, which waits on every document resident in the process —
   * including other workspaces'. Optional and additive, so the AI write tools
   * that call this are untouched.
   *
   * Completeness is not left to inspection: `referenceIntegrityRepair.test.ts`
   * diffs document HEADS across an apply and fails if anything changed that was
   * not reported here.
   */
  touched?: Set<DocumentId>
): Promise<boolean> {
  const found = await findDiagram(repo, rootUrl, id)
  if (!found) return false
  touched?.add(found.doc.documentId)
  touched?.add(found.shard.documentId)
  const settings = patch.settings ? clonePlain(patch.settings) : undefined
  const layoutUpserts = patch.layoutUpserts ? clonePlain(patch.layoutUpserts) : undefined

  found.doc.change((d) => {
    if (settings) {
      for (const [k, v] of Object.entries(settings)) {
        if (v === null) delete d[k]
        else d[k] = v
      }
    }
    const objectIds = (d.objectIds ?? (d.objectIds = [])) as string[]
    if (patch.addObjectIds?.length) addUnique(objectIds, patch.addObjectIds)
    if (patch.removeObjectIds?.length) removeAll(objectIds, patch.removeObjectIds)
    const connectionIds = (d.connectionIds ?? (d.connectionIds = [])) as string[]
    if (patch.addConnectionIds?.length) addUnique(connectionIds, patch.addConnectionIds)
    if (patch.removeConnectionIds?.length) removeAll(connectionIds, patch.removeConnectionIds)
    const groupIds = (d.groupIds ?? (d.groupIds = [])) as string[]
    if (patch.addGroupIds?.length) addUnique(groupIds, patch.addGroupIds)
    if (patch.removeGroupIds?.length) removeAll(groupIds, patch.removeGroupIds)
    if (layoutUpserts || patch.layoutDeletes?.length) {
      const layouts = (d.layouts ?? (d.layouts = {})) as Record<string, unknown>
      for (const [k, v] of Object.entries(layoutUpserts ?? {})) layouts[k] = v
      for (const k of patch.layoutDeletes ?? []) delete layouts[k]
    }
  })

  // Keep the denormalized registry stub in sync (name/type/composition/parent).
  const doc = found.doc.doc()
  found.shard.change((s) => {
    const stub = s.diagrams[id]
    if (!stub || !doc) return
    stub.name = doc.name
    stub.type = doc.type
    stub.objectIds = clonePlain((doc.objectIds ?? []) as string[])
    stub.connectionIds = clonePlain((doc.connectionIds ?? []) as string[])
    stub.groupIds = clonePlain((doc.groupIds ?? []) as string[])
    if (doc.parentObjectId !== undefined) stub.parentObjectId = doc.parentObjectId
    else if ('parentObjectId' in stub) delete stub.parentObjectId
  })
  return true
}

export async function deleteDiagramDoc(
  repo: SealedRepo, rootUrl: string, id: string, touched?: Set<DocumentId>,
): Promise<boolean> {
  const root = (await rootHandle(repo, rootUrl)).doc()
  if (!root) return false
  const shard = await findRegistryShardWithDiagram(repo, root.shardUrls ?? [], id)
  if (!shard) return false
  touched?.add(shard.documentId)
  shard.change((s) => {
    delete s.diagrams[id]
  })
  return true
}

/** Remove ids from every diagram's composition + layouts (object/connection
 * delete cascade). Touches only diagrams that actually reference the ids. */
export async function stripIdsFromAllDiagrams(
  repo: SealedRepo,
  rootUrl: string,
  ids: string[],
  touched?: Set<DocumentId>
): Promise<void> {
  if (ids.length === 0) return
  const drop = new Set(ids)
  const root = (await rootHandle(repo, rootUrl)).doc()
  if (!root) return
  for (const shardUrl of root.shardUrls ?? []) {
    if (!isValidAutomergeUrl(shardUrl)) continue
    const shard = await find<RegistryShardDoc>(repo, shardUrl)
    const diagrams = shard.doc()?.diagrams ?? {}
    for (const [diagId, stub] of Object.entries(diagrams)) {
      const touches =
        ((stub.objectIds as string[] | undefined) ?? []).some((i) => drop.has(i)) ||
        ((stub.connectionIds as string[] | undefined) ?? []).some((i) => drop.has(i)) ||
        ((stub.groupIds as string[] | undefined) ?? []).some((i) => drop.has(i))
      if (!touches) continue
      const docUrl = stub.docUrl as string | undefined
      if (docUrl && isValidAutomergeUrl(docUrl)) {
        const doc = await find<DiagramDocLike>(repo, docUrl)
        touched?.add(doc.documentId)
        doc.change((d) => {
          for (const field of ['objectIds', 'connectionIds', 'groupIds'] as const) {
            const arr = d[field] as string[] | undefined
            if (arr) removeAll(arr, ids)
          }
          const layouts = d.layouts as Record<string, unknown> | undefined
          if (layouts) for (const dropId of ids) delete layouts[dropId]
        })
      }
      touched?.add(shard.documentId)
      shard.change((s) => {
        const st = s.diagrams[diagId]
        if (!st) return
        for (const field of ['objectIds', 'connectionIds', 'groupIds'] as const) {
          const arr = st[field] as string[] | undefined
          if (arr) removeAll(arr, ids)
        }
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Comments (live on the DiagramDoc)
// ---------------------------------------------------------------------------

export interface CommentMutation {
  resolve?: boolean
  /** `authorId` is the writer's `AuthUser.id` — the identity the SPA compares
   *  against to render "You"; `author` is only a display label. */
  reply?: { text: string; author: string; authorId?: string | null }
}

export async function mutateComment(
  repo: SealedRepo,
  rootUrl: string,
  diagramId: string,
  commentId: string,
  mutation: CommentMutation
): Promise<boolean> {
  const found = await findDiagram(repo, rootUrl, diagramId)
  if (!found) return false
  let ok = false
  found.doc.change((d) => {
    const comments = d.comments as Record<string, Record<string, unknown>> | undefined
    const comment = comments?.[commentId]
    if (!comment) return
    ok = true
    if (mutation.resolve !== undefined) comment.resolved = mutation.resolve
    if (mutation.reply) {
      const replies = (comment.replies ?? (comment.replies = [])) as unknown[]
      replies.push(
        clonePlain({
          id: newEntityId(),
          text: mutation.reply.text,
          author: mutation.reply.author,
          ...(mutation.reply.authorId ? { authorId: mutation.reply.authorId } : {}),
          createdAt: new Date().toISOString(),
        })
      )
    }
  })
  return ok
}

// ---------------------------------------------------------------------------
// Session — one materialized snapshot per AI request, invalidated on writes
// ---------------------------------------------------------------------------

/**
 * Caches ONE `materializeFullModel` per request so an agent loop with many
 * read tools materializes once; any write invalidates it. Also caches
 * diagram-doc bodies (comments/flows) by diagram id.
 */
export class ModelSession {
  private model: Promise<FullModel> | null = null
  private diagramDocs = new Map<string, DiagramDocLike | null>()

  constructor(
    private readonly repo: SealedRepo,
    readonly rootUrl: string
  ) {}

  snapshot(): Promise<FullModel> {
    if (!this.model) this.model = materializeFullModel(this.repo, this.rootUrl)
    return this.model
  }

  /** Full DiagramDoc body (incl. comments) — cached per session. */
  async diagramDoc(id: string): Promise<DiagramDocLike | null> {
    if (this.diagramDocs.has(id)) return this.diagramDocs.get(id) ?? null
    const found = await findDiagram(this.repo, this.rootUrl, id)
    const doc = found ? (clonePlain(found.doc.doc()) as DiagramDocLike) : null
    this.diagramDocs.set(id, doc)
    return doc
  }

  invalidate(): void {
    this.model = null
    this.diagramDocs.clear()
  }
}
