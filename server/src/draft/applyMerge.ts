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

import { randomBytes, randomUUID } from 'node:crypto'
import {
  isValidAutomergeUrl,
  type Repo,
  type DocHandle,
  type DocumentId,
} from '@automerge/automerge-repo'
import { pool } from '../db.js'
import { forkRoot, isSummaryOnlyRoot, SUMMARY_FORK_UNSUPPORTED_MESSAGE } from '../forkRoot.js'
import { createBootstrapDocument } from '../bootstrapMint.js'
import { openBootstrapScope, type BootstrapScope } from '../bootstrapScope.js'
import {
  notifyWorkspaceCreated,
  notifyWorkspaceDocumentsCreated,
  type WorkspaceKey,
} from '../rbac/docScope.js'
import { claimWorkspaceDocuments } from '../rbac/documentClaims.js'
import { purgeServerCreationPlacement } from '../rbac/serverCreationPlacement.js'
import { coverWorkspace, noteCoveredLocally } from '../rbac/claimCoverage.js'
import { materializeFullModel, type FullModel, type HeadsMap } from './materialize.js'
import { diffModels, resolveConflicts, type DraftConflict, type DraftChange, type ChangeCollection, type Resolutions } from './merge.js'
import {
  isSparseDraftManifest,
  type DraftBaseManifest,
  type RootManifest,
} from './manifest.js'
import { materializeSparseDraftModels } from './sparse.js'
import {
  deleteOverlayEntities,
  writeOverlayEntities,
  type OverlayMetaLike,
} from '../overlaySegments.js'
import type { AutomergeResidencyLeases } from '../automergeResidency.js'
import { findReadyDocument, syncedHandle } from '../automergeRepoCompat.js'

/**
 * Merge a draft into the live model.
 *
 * Re-derives the 3-way diff (base = parent@fork, ours = parent@now, theirs = draft@now)
 * — the SAME parent root the Changes UI diffed against, so the reviewed changeset is exactly
 * what we apply. If there are conflicts the merge is blocked (route → 409). Otherwise the
 * draft's non-conflicting changeset is applied onto the parent root IN PLACE (preserving any
 * current-only entities the draft never touched), a NEW named version snapshots the merged
 * state, and the draft is marked merged.
 *
 * Returns null when the draft / its base / its parent can't be resolved (route → 404).
 *
 * SAFETY: Automerge writes (CRDT-idempotent) happen first; the two DB ops (snapshot insert +
 * mark-merged) are wrapped in one transaction. A re-run converges — applied changes drop out
 * of the recomputed diff, diagram-create is dedupe-guarded, and an already-merged draft
 * short-circuits — so a crash between the Automerge writes and the DB commit is recoverable.
 */

const SHARD_SIZE = Number(process.env.AM_SHARD_SIZE ?? 200)

interface RootLike {
  modelUrl?: string
  modelMetaUrl?: string
  shardUrls?: string[]
  registrySummaryOnly?: boolean
}
interface MetaLike extends OverlayMetaLike {
  objectShardUrls?: string[]
  connectionShardUrls?: string[]
  editsObjectShardUrl?: string
  editsConnectionShardUrl?: string
  deletedObjectIds?: string[]
  deletedConnectionIds?: string[]
  decisionRecordShardUrls?: string[]
  deletedDecisionRecordIds?: string[]
  [k: string]: unknown
}
interface RegistryShardDoc { diagrams: Record<string, Record<string, unknown>> }
type ModelDocLike = Record<string, Record<string, unknown>>
interface DiagramDocLike {
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
  layouts?: Record<string, unknown>
  flows?: Record<string, unknown>
  [k: string]: unknown
}

const MODEL_KEY: Partial<Record<ChangeCollection, keyof FullModel>> = {
  object: 'objects', connection: 'connections', group: 'groups',
  domain: 'domains', tag: 'tagSnapshots', decisionRecord: 'decisionRecords',
}
const INLINE_COLLECTIONS: ChangeCollection[] = ['group', 'domain', 'tag', 'decisionRecord']
/** DiagramDoc keys that are NOT scalar settings (handled separately) — used to
 * wholesale-replace settings so a field the draft REMOVED is actually cleared. */
const DIAGRAM_NON_SETTINGS = new Set(['objectIds', 'connectionIds', 'groupIds', 'layouts', 'flows', 'comments', 'checkpoints'])

/**
 * Claim-at-write context, plus the scope that fences the creation: every document the changeset CREATES on the parent — diagram copies,
 * fresh registry shards, overlay segments — is minted through `scope` when one
 * is supplied, so it is noted under the PARENT's lease and fenced on every save
 * until the claim that follows commits. `applyMerge` always supplies it; the
 * DB-free unit suites may pass a claim without one and take the plain mint.
 */
export interface MergeClaimContext {
  workspace: WorkspaceKey
  rootUrl: string
  scope?: BootstrapScope
}

interface ApplyChangesetOptions {
  onDocumentTouched?: (handle: DocHandle<unknown>) => void
  /** Claim-at-write context: every document this changeset CREATES
   * (diagram copies, fresh registry shards, overlay segments) is claimed for
   * `workspace` BEFORE any parent link is published. Optional only for the
   * DB-free unit suites; applyMerge always passes it. */
  claim?: MergeClaimContext
}

export interface MergeDurabilityOptions {
  residency?: AutomergeResidencyLeases
  workspace?: string
  /** Claim-at-write context for every document the merge creates on the
   * parent root. applyMerge supplies it; test callers may omit it. */
  claim?: MergeClaimContext
}

function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
async function find<T>(repo: Repo, url: string): Promise<DocHandle<T>> {
  return findReadyDocument<T>(repo, url)
}
async function readDoc<T>(repo: Repo, url: string): Promise<T | undefined> {
  return (await find<T>(repo, url)).doc()
}
function groupByDiagram(changes: DraftChange[]): Map<string, DraftChange[]> {
  const m = new Map<string, DraftChange[]>()
  for (const c of changes) {
    if (!c.diagramId) continue
    const arr = m.get(c.diagramId)
    if (arr) arr.push(c)
    else m.set(c.diagramId, [c])
  }
  return m
}

/** A document the merge creates on the PARENT root: through the caller's
 *  SCOPE when it has one (applyMerge always does — named for the parent's
 *  workspace, noted under the parent's lease, fenced on every save), named but
 *  unfenced for a claim context without a scope, a plain `repo.create` for the
 *  DB-free unit suites that omit the claim. The claim that follows each
 *  creation is what keeps the name honest — see `bootstrapMint.ts`. */
function createMergeDocument<T extends object>(
  repo: Repo,
  claim: MergeClaimContext | undefined,
  value: T,
): DocHandle<T> {
  if (claim?.scope) return claim.scope.create<T>(repo, value)
  return claim ? createBootstrapDocument<T>(repo, claim.workspace, value) : repo.create<T>(value)
}

async function findOrCreateRegistryShard(
  repo: Repo,
  rootHandle: DocHandle<RootLike>,
  claim?: MergeClaimContext,
): Promise<DocHandle<RegistryShardDoc>> {
  const shardUrls = rootHandle.doc()?.shardUrls ?? []
  for (const u of shardUrls) {
    if (!isValidAutomergeUrl(u)) continue
    const h = await find<RegistryShardDoc>(repo, u)
    if (Object.keys(h.doc()?.diagrams ?? {}).length < SHARD_SIZE) return h
  }
  const fresh = createMergeDocument<RegistryShardDoc>(repo, claim, { diagrams: {} })
  await fresh.whenReady()
  // A root must never publish a reference to a child that is not durable yet.
  await repo.flush([fresh.documentId])
  // ...and never a reference to a child that is not CLAIMED yet — a
  // throw here aborts the merge before the root link exists.
  if (claim) {
    await notifyWorkspaceDocumentsCreated({
      ...claim.workspace,
      rootUrl: claim.rootUrl,
      documentIds: [String(fresh.documentId)],
    })
  }
  rootHandle.change((r) => {
    const urls = (r.shardUrls ?? (r.shardUrls = [])) as string[]
    urls.push(fresh.url)
  })
  return fresh
}

async function findRegistryShardWithDiagram(
  repo: Repo,
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

/** Build a registry stub (denormalized) from the draft's diagram meta + a new docUrl. */
function stubFrom(dmeta: Record<string, unknown>, docUrl: string): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    id: dmeta.id,
    name: dmeta.name,
    type: dmeta.type,
    docUrl,
    objectIds: dmeta.objectIds ?? [],
    connectionIds: dmeta.connectionIds ?? [],
    groupIds: dmeta.groupIds ?? [],
  }
  if (dmeta.parentObjectId !== undefined) stub.parentObjectId = dmeta.parentObjectId
  return stub
}

/**
 * Apply a non-conflicting changeset onto `currentRootUrl` IN PLACE, pulling every value from
 * `theirs`. Pure Automerge (no DB) so it is unit-testable with an in-memory repo. Idempotent:
 * upserts are put-wins, deletes/tombstones are dedupe-safe, diagram-create is guarded.
 */
export async function applyChangeset(
  repo: Repo,
  currentRootUrl: string,
  theirs: FullModel,
  ours: FullModel,
  changes: DraftChange[],
  options: ApplyChangesetOptions = {},
): Promise<DocumentId[]> {
  const touchedDocumentIds = new Set<DocumentId>()
  const retain = <T extends DocHandle<unknown>>(handle: T): T => {
    options.onDocumentTouched?.(handle)
    return handle
  }
  const track = <T extends DocHandle<unknown>>(handle: T): T => {
    retain(handle)
    touchedDocumentIds.add(handle.documentId)
    return handle
  }
  const rootHandle = retain(await find<RootLike>(repo, currentRootUrl))
  const root = rootHandle.doc()
  if (!root) throw new Error(`applyChangeset: current root unavailable (${currentRootUrl})`)
  const sharded = !!root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)

  // --- Model collections ---
  if (!sharded && root.modelUrl && isValidAutomergeUrl(root.modelUrl)) {
    const modelHandle = track(await find<ModelDocLike>(repo, root.modelUrl))
    modelHandle.change((m) => {
      for (const ch of changes) {
        const key = MODEL_KEY[ch.collection]
        if (!key) continue
        const coll = m[key] ?? (m[key] = {})
        if (ch.kind === 'deleted') delete coll[ch.id]
        else {
          const v = (theirs[key] as Record<string, unknown>)[ch.id]
          if (v !== undefined) coll[ch.id] = v as Record<string, unknown>
        }
      }
    })
  } else if (sharded) {
    const metaHandle = track(await find<MetaLike>(repo, root.modelMetaUrl!))
    // groups/domains/tags/decisionRecords are inline in ModelMeta.
    metaHandle.change((m) => {
      for (const ch of changes) {
        if (!INLINE_COLLECTIONS.includes(ch.collection)) continue
        const key = MODEL_KEY[ch.collection]!
        const coll = (m[key] as Record<string, unknown>) ?? (m[key] = {})
        if (ch.kind === 'deleted') {
          delete coll[ch.id]
          if (ch.collection === 'decisionRecord' && m.decisionRecordShardUrls?.length) {
            const deleted = m.deletedDecisionRecordIds ?? (m.deletedDecisionRecordIds = [])
            if (!deleted.includes(ch.id)) deleted.push(ch.id)
          }
        } else {
          const v = (theirs[key] as Record<string, unknown>)[ch.id]
          if (v !== undefined) coll[ch.id] = v
          if (ch.collection === 'decisionRecord' && m.deletedDecisionRecordIds) {
            const index = m.deletedDecisionRecordIds.indexOf(ch.id)
            if (index >= 0) m.deletedDecisionRecordIds.splice(index, 1)
          }
        }
      }
    })
    // objects/connections → edits-overlay upsert + delete tombstones.
    for (const collKey of ['objects', 'connections'] as const) {
      const chCollection: ChangeCollection = collKey === 'objects' ? 'object' : 'connection'
      const tombField = collKey === 'objects' ? 'deletedObjectIds' : 'deletedConnectionIds'
      const upserts = changes.filter((c) => c.collection === chCollection && c.kind !== 'deleted')
      const deletes = changes.filter((c) => c.collection === chCollection && c.kind === 'deleted')

      if (upserts.length) {
        const values: Record<string, unknown> = {}
        for (const change of upserts) {
          const value = (theirs[collKey] as Record<string, unknown>)[change.id]
          if (value !== undefined) values[change.id] = value
        }
        const overlayDocumentIds = await writeOverlayEntities(
          repo,
          metaHandle as unknown as DocHandle<OverlayMetaLike>,
          collKey,
          values,
          undefined,
          options.onDocumentTouched,
          options.claim,
        )
        for (const documentId of overlayDocumentIds) touchedDocumentIds.add(documentId)
        // Un-tombstone any re-created/re-edited id, else the read model's tombstone pass
        // (applied LAST) would silently delete the value we just wrote — the list
        // `foldCollection` reads in compaction.ts.
        const upsertIds = new Set(upserts.map((c) => c.id))
        metaHandle.change((m) => {
          const arr = m[tombField] as string[] | undefined
          if (!arr) return
          for (let i = arr.length - 1; i >= 0; i--) if (upsertIds.has(arr[i])) arr.splice(i, 1)
        })
      }
      if (deletes.length) {
        metaHandle.change((m) => {
          const arr = (m[tombField] ?? (m[tombField] = [])) as string[]
          const have = new Set(arr)
          for (const ch of deletes) if (!have.has(ch.id)) { arr.push(ch.id); have.add(ch.id) }
        })
        const overlayDocumentIds = await deleteOverlayEntities(
          repo,
          metaHandle as unknown as DocHandle<OverlayMetaLike>,
          collKey,
          deletes.map((change) => change.id),
          options.onDocumentTouched,
        )
        for (const documentId of overlayDocumentIds) touchedDocumentIds.add(documentId)
      }
    }
  }

  // --- Diagrams ---
  const shardUrls = root.shardUrls ?? []
  const diagramChanges = changes.filter((c) => c.collection === 'diagram')
  const createdIds = new Set(diagramChanges.filter((c) => c.kind === 'created').map((c) => c.id))
  const updatedIds = new Set(diagramChanges.filter((c) => c.kind === 'updated').map((c) => c.id))
  const layoutByDiag = groupByDiagram(changes.filter((c) => c.collection === 'layout'))
  const flowByDiag = groupByDiagram(changes.filter((c) => c.collection === 'flow'))

  // created — clone the draft's DiagramDoc (strip checkpoints) + add a registry stub.
  // Three phases on purpose — create + flush every copy, claim them as ONE
  // batch (a merge can copy N diagrams), and only then publish the registry
  // stubs. A claim throw
  // aborts the merge BEFORE any published link points at an unclaimed copy;
  // the flushed orphans are GC fodder, not holes.
  const createdCopies: Array<{
    id: string
    dmeta: Record<string, unknown>
    handle: DocHandle<Record<string, unknown>>
  }> = []
  for (const ch of diagramChanges.filter((c) => c.kind === 'created')) {
    if (await findRegistryShardWithDiagram(repo, shardUrls, ch.id)) continue // dedupe (idempotent)
    const dmeta = theirs.diagrams[ch.id]?.meta as Record<string, unknown> | undefined
    const docUrl = dmeta?.docUrl as string | undefined
    if (!dmeta || !docUrl || !isValidAutomergeUrl(docUrl)) continue
    const copy = plain(await readDoc<Record<string, unknown>>(repo, docUrl)) as Record<string, unknown>
    copy.checkpoints = [] // their heads reference the draft's history; the clone lacks it
    const docHandle = createMergeDocument<Record<string, unknown>>(repo, options.claim, copy)
    await docHandle.whenReady()
    track(docHandle)
    await repo.flush([docHandle.documentId])
    createdCopies.push({ id: ch.id, dmeta, handle: docHandle })
  }
  if (createdCopies.length > 0 && options.claim) {
    await notifyWorkspaceDocumentsCreated({
      ...options.claim.workspace,
      rootUrl: options.claim.rootUrl,
      documentIds: createdCopies.map((copy) => String(copy.handle.documentId)),
    })
  }
  for (const created of createdCopies) {
    const shard = track(await findOrCreateRegistryShard(repo, rootHandle, options.claim))
    track(rootHandle)
    shard.change((s) => {
      s.diagrams[created.id] = stubFrom(created.dmeta, created.handle.url)
    })
  }

  // deleted — remove the registry stub only (orphan doc is GC'd later).
  for (const ch of diagramChanges.filter((c) => c.kind === 'deleted')) {
    const shard = await findRegistryShardWithDiagram(repo, shardUrls, ch.id)
    if (shard) {
      track(shard)
      shard.change((s) => { delete s.diagrams[ch.id] })
    }
  }

  // updated settings/composition + per-id layout/flow deltas, per touched non-created diagram.
  const touched = new Set<string>(
    [...updatedIds, ...layoutByDiag.keys(), ...flowByDiag.keys()].filter((id) => !createdIds.has(id))
  )
  for (const id of touched) {
    const td = theirs.diagrams[id]?.detail
    if (!td) continue
    const curUrl = (ours.diagrams[id]?.meta as { docUrl?: string } | undefined)?.docUrl
    if (!curUrl || !isValidAutomergeUrl(curUrl)) {
      // The live model deleted this diagram, but the draft kept + edited it (a conflict the
      // user resolved to keep-mine) → resurrect by cloning the draft's diagram doc.
      if (await findRegistryShardWithDiagram(repo, shardUrls, id)) continue // already present
      const dmeta = theirs.diagrams[id]?.meta as Record<string, unknown> | undefined
      const draftDocUrl = dmeta?.docUrl as string | undefined
      if (!dmeta || !draftDocUrl || !isValidAutomergeUrl(draftDocUrl)) continue
      const copy = plain(await readDoc<Record<string, unknown>>(repo, draftDocUrl)) as Record<string, unknown>
      copy.checkpoints = []
      const docHandle = createMergeDocument<Record<string, unknown>>(repo, options.claim, copy)
      await docHandle.whenReady()
      track(docHandle)
      await repo.flush([docHandle.documentId])
      // Claimed before the stub publishes its link (singular — the
      // keep-mine resurrection is per-conflict, never a bulk path).
      if (options.claim) {
        await notifyWorkspaceDocumentsCreated({
          ...options.claim.workspace,
          rootUrl: options.claim.rootUrl,
          documentIds: [String(docHandle.documentId)],
        })
      }
      const shard = track(await findOrCreateRegistryShard(repo, rootHandle, options.claim))
      track(rootHandle)
      shard.change((s) => { s.diagrams[id] = stubFrom(dmeta, docHandle.url) })
      continue
    }
    const doc = track(await find<DiagramDocLike>(repo, curUrl))
    doc.change((d) => {
      if (updatedIds.has(id)) {
        // Wholesale-replace settings: clear any current scalar setting the draft removed,
        // then apply the draft's. (Additive assignment would leave a cleared field stale.)
        for (const k of Object.keys(d)) {
          if (!DIAGRAM_NON_SETTINGS.has(k) && !(k in td.settings)) delete d[k]
        }
        for (const [k, v] of Object.entries(td.settings)) d[k] = v
        d.objectIds = td.objectIds
        d.connectionIds = td.connectionIds
        d.groupIds = td.groupIds
      }
      const layouts = (d.layouts ?? (d.layouts = {})) as Record<string, unknown>
      for (const ch of layoutByDiag.get(id) ?? []) {
        if (ch.kind === 'deleted') delete layouts[ch.id]
        else { const v = td.layouts?.[ch.id]; if (v !== undefined) layouts[ch.id] = v }
      }
      const flows = (d.flows ?? (d.flows = {})) as Record<string, unknown>
      for (const ch of flowByDiag.get(id) ?? []) {
        if (ch.kind === 'deleted') delete flows[ch.id]
        else { const v = td.flows?.[ch.id]; if (v !== undefined) flows[ch.id] = v }
      }
    })
    // Keep the registry stub's denormalized name/type/composition in sync for an update.
    if (updatedIds.has(id) && root.registrySummaryOnly !== true) {
      const dmeta = theirs.diagrams[id]?.meta as Record<string, unknown> | undefined
      const shard = await findRegistryShardWithDiagram(repo, shardUrls, id)
      if (dmeta && shard) {
        track(shard)
        shard.change((s) => {
          const stub = s.diagrams[id]
          if (!stub) return
          stub.name = dmeta.name
          stub.type = dmeta.type
          stub.objectIds = dmeta.objectIds ?? []
          stub.connectionIds = dmeta.connectionIds ?? []
          stub.groupIds = dmeta.groupIds ?? []
          // Mirror exactly: clear parentObjectId when the draft un-nested the diagram,
          // else the denormalized stub (read by the projector) drifts from the doc.
          if (dmeta.parentObjectId !== undefined) stub.parentObjectId = dmeta.parentObjectId
          else if ('parentObjectId' in stub) delete stub.parentObjectId
        })
      }
    }
  }
  return [...touchedDocumentIds]
}

/**
 * Flush every document a merge touched, one scoped flush per document.
 *
 * Exported so `applyMerge.flushAccessCount.test.ts` can drive it against a
 * real `new Repo({ network: [] })` with no Postgres.
 *
 * Do NOT "simplify" this to a single `repo.flush(touchedDocumentIds)`.
 * `Repo.flush` SILENTLY SKIPS any id whose query is not ready
 * (`repo.flush([unknownId])` resolves without throwing). The `find` below is therefore the DURABILITY path, not a
 * convenience: it re-admits a document an independently managed Repo evicted
 * mid-merge, so the flush lands on a real ready query instead of the silent
 * skip. When `options.residency` is set every touched document is leased for
 * the duration and eviction cannot occur at all; the fallback is for non-HTTP
 * callers, which have no lease.
 */
export async function flushTouchedDocuments(
  repo: Repo,
  touchedDocumentIds: DocumentId[],
): Promise<void> {
  await Promise.all(touchedDocumentIds.map(async (documentId) => {
    // O(1). Never `repo.handles[documentId]` here: that getter rebuilds the
    // entire handle Record per access, making the loop O(n*m).
    let handle = syncedHandle(repo, documentId)
    // The non-ready branch is currently unreachable (`repo.delete` drops the
    // cache entry synchronously), but `DocHandle.delete()` alone leaves a
    // `deleted` handle cached, so the guard stays.
    if (!handle || handle.state !== 'ready') {
      handle = await find<unknown>(repo, documentId)
    }
    await repo.flush([handle.documentId])
  }))
}

/**
 * Apply and durably persist only the documents touched by this merge.
 *
 * A busy server repo intentionally contains handles that are still loading. Calling
 * `repo.flush()` without an allow-list tries to read every cached handle and throws
 * `DocHandle is not ready`, after the merge mutations have already been applied. Keeping
 * the durability boundary scoped makes the operation independent of unrelated workspaces.
 */
export async function applyChangesetDurably(
  repo: Repo,
  currentRootUrl: string,
  theirs: FullModel,
  ours: FullModel,
  changes: DraftChange[],
  options: MergeDurabilityOptions = {},
): Promise<DocumentId[]> {
  const leaseOwner = options.residency ? `draft-merge:${randomUUID()}` : null
  const retain = leaseOwner
    ? (handle: DocHandle<unknown>) => options.residency!.acquire(
        handle,
        leaseOwner,
        options.workspace ?? 'draft-merge',
      )
    : undefined
  try {
    const touchedDocumentIds = await applyChangeset(
      repo,
      currentRootUrl,
      theirs,
      ours,
      changes,
      { onDocumentTouched: retain, claim: options.claim },
    )
    await flushTouchedDocuments(repo, touchedDocumentIds)
    return touchedDocumentIds
  } finally {
    if (leaseOwner) options.residency!.releaseOwner(leaseOwner)
  }
}

export type MergeOutcome =
  | { ok: true; versionId: string }
  | { ok: false; conflicts: DraftConflict[] }
  | { ok: false; blocked: string }

export async function applyMerge(
  repo: Repo,
  landscapeId: string,
  draftId: string,
  resolutions: Resolutions = {},
  durability: MergeDurabilityOptions = {},
): Promise<MergeOutcome | null> {
  const { rows } = await pool.query<{
    root_url: string
    parent_version_id: string | null
    base_manifest: DraftBaseManifest | null
    label: string
    status: string
  }>(
    `SELECT root_url, parent_version_id, base_manifest, label, status
     FROM versions WHERE id = $1 AND landscape_id = $2 AND kind = 'draft'`,
    [draftId, landscapeId]
  )
  if (rows.length === 0) return null
  const { root_url: draftRootUrl, parent_version_id: parentVersionId, base_manifest: baseManifest, label: draftLabel, status } = rows[0]
  if (status === 'merged') return { ok: true, versionId: '' } // idempotent — already merged
  if (status !== 'active') return null // discarded/archived drafts are not mergeable
  if (!baseManifest || !parentVersionId) return null

  // The merge applies the changeset onto the draft's PARENT root IN PLACE (the root the
  // Changes UI diffed against). If the landscape's default version was repointed away from
  // that parent since the draft forked, merging in place would land on a non-default version
  // — invisible to everyone on 'current'. Block rather than silently mis-merge.
  const { rows: lrows } = await pool.query<{ default_version_id: string | null }>(
    'SELECT default_version_id FROM landscapes WHERE id = $1',
    [landscapeId]
  )
  if (lrows.length === 0) return null
  if (lrows[0].default_version_id !== parentVersionId) {
    return { ok: false, blocked: 'The live model moved to a different version since this draft was created. Re-create the draft from the current model to merge.' }
  }

  const { rows: prow } = await pool.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2',
    [parentVersionId, landscapeId]
  )
  const parentRootUrl = prow[0]?.root_url
  if (!parentRootUrl) return null

  // A DEEP (non-sparse) merge snapshots the parent via forkRoot; on a
  // summary parent that fork mints a flag-without-static-row twin — the exact
  // data-loss state fsck's summary-static-coherence check reports. This shape
  // only arises when the parent was PROMOTED to summary after the deep draft
  // forked, and by then `materializeFullModel(parent)` would compute `ours`
  // from a partial registry anyway (a wrong diff, not just a bad snapshot).
  // Refuse BEFORE materialization, before applyChangesetDurably mutates the
  // parent, and before the snapshot — nothing is created or written. The
  // sparse path (isSparseDraftManifest, which never snapshots) is untouched.
  // `blocked` is applyMerge's typed refusal channel; the route maps it to 409.
  if (!isSparseDraftManifest(baseManifest) && await isSummaryOnlyRoot(repo, parentRootUrl)) {
    return { ok: false, blocked: SUMMARY_FORK_UNSUPPORTED_MESSAGE }
  }

  // Re-materialize + recompute the diff against the SAME parent the Changes UI used.
  let base: FullModel
  let ours: FullModel
  let theirs: FullModel
  if (isSparseDraftManifest(baseManifest)) {
    ({ base, ours, theirs } = await materializeSparseDraftModels(
      repo, pool, landscapeId, draftId, draftRootUrl, parentVersionId, baseManifest,
    ))
  } else {
    const atHeads: HeadsMap = {}
    for (const d of (baseManifest as RootManifest).docs) atHeads[d.url] = d.heads
    base = await materializeFullModel(repo, baseManifest.rootUrl, atHeads)
    ours = await materializeFullModel(repo, parentRootUrl)
    theirs = await materializeFullModel(repo, draftRootUrl)
  }
  const diff = diffModels(base, ours, theirs)
  // Gate on conflicts, honouring the user's per-conflict resolutions. `appliedChanges`
  // drops every change the user chose to keep-live; unresolved conflicts block (409).
  const { blocked, appliedChanges } = resolveConflicts(diff, resolutions)
  if (blocked) return { ok: false, conflicts: blocked }

  // THE AUTHORITY TO WRITE THE PARENT, ASKED HERE TOO. The HTTP handler asks
  // it first through `placeMergeWrite`, and the direct AI tool door is routed
  // to the parent's owner, but other callers (an agent loop, `/mcp`) reach
  // this function with nothing in front of it. A scope
  // refused here has minted nothing — the atomic "wrote: nothing" refusal —
  // and a scope granted here fences every document the merge creates on the
  // parent (diagram copies, registry shards, overlay segments) under the
  // parent's lease until their claims commit. The parent's EXISTING documents
  // are fenced by their durable rows, as before.
  const parentWorkspace: WorkspaceKey = { landscapeId, versionId: parentVersionId }
  const parentScope = openBootstrapScope(parentWorkspace, { kind: 'forker', workspace: parentWorkspace })

  // Apply onto the parent root in place (CRDT-idempotent), then snapshot the merged state.
  try {
    await applyChangesetDurably(repo, parentRootUrl, theirs, ours, appliedChanges, {
      ...durability,
      workspace: durability.workspace ?? `${landscapeId}/${parentVersionId}`,
      claim: durability.claim ?? {
        workspace: parentWorkspace,
        rootUrl: parentRootUrl,
        scope: parentScope,
      },
    })
    if (isSparseDraftManifest(baseManifest)) {
      // Deep-snapshotting the 30k-diagram immutable baseline would reintroduce the
      // O(N) failure this path removes. The parent remains the canonical baseline
      // plus durable overlays; the reviewed draft lifecycle is committed here.
      await pool.query(
        `UPDATE versions SET status = 'merged'
         WHERE id = $1 AND landscape_id = $2 AND kind = 'draft' AND status = 'active'`,
        [draftId, landscapeId],
      )
      return { ok: true, versionId: parentVersionId }
    }
  } catch (err) {
    // A failure BETWEEN a copy's or segment's mint and its autocommit claim
    // (inside `applyChangesetDurably`) is the one place the transaction's
    // catch below cannot reach; without this the parent scope's notes would
    // stay LIVE forever. Retired, they still answer
    // the fence for any late save and are evicted ahead of live entries.
    parentScope.retire()
    throw err
  }
  // Automerge writes — BEFORE the DB tx.
  // The snapshot's id BEFORE its fork: every forked document is named for
  // `(landscapeId, snapshotId)` (`bootstrapMint.ts`), so a snapshot whose
  // transaction below never commits is reaped by `mintedOrphanReaper.ts`
  // rather than surviving as a permanent orphan.
  const snapshotId = randomBytes(12).toString('base64url')
  // The snapshot is forked UNDER THE PARENT'S LEASE: its own workspace has no
  // row and therefore no lease, and the parent is what this merge is
  // authorised to write. `forkRoot` flushes BEFORE the transaction below
  // claims, and every one of those flushes meets the fence with the parent's key.
  const snapshotScope = openBootstrapScope(
    { landscapeId, versionId: snapshotId },
    { kind: 'forker', workspace: parentWorkspace },
  )
  const { rootUrl: snapshotRootUrl, createdDocumentIds: snapshotDocumentIds } = await forkRoot(
    repo, parentRootUrl, snapshotScope,
  )

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, parent_version_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [snapshotId, landscapeId, `Merge: ${draftLabel}`, snapshotRootUrl, parentVersionId]
    )
    // `AND status = 'active'` makes a concurrent/double merge a no-op: the 2nd request's
    // UPDATE matches 0 rows, so we ROLLBACK (undoing this request's snapshot insert in the
    // same tx) rather than minting a duplicate "Merge:" version. The losing fork is orphaned
    // (GC reclaims it).
    const upd = await client.query(
      `UPDATE versions SET status = 'merged' WHERE id = $1 AND landscape_id = $2 AND kind = 'draft' AND status = 'active'`,
      [draftId, landscapeId]
    )
    if ((upd.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK')
      // The losing fork is an orphan for the reaper; its notes become residue.
      snapshotScope.retire()
      return { ok: true, versionId: '' } // another request already merged this draft
    }
    // The snapshot version is claimed AND covered inside the same
    // transaction as its versions row — the three commit or vanish together
    // (a lost race above rolls all of it back; the fork stays an orphan for
    // GC). Freshly forked ids colliding is corruption: throw, roll back.
    const claims = await claimWorkspaceDocuments(
      client, { landscapeId, versionId: snapshotId }, snapshotDocumentIds,
    )
    if (claims.missingVersion || claims.foreign.length > 0) {
      throw new Error(claims.missingVersion
        ? 'snapshot claim ran without its versions row'
        : `snapshot documents already owned elsewhere (first: ${claims.foreign[0]!.documentId})`)
    }
    // The local write-through is DEFERRED past COMMIT: inside the tx the
    // marker is not durable, and a rollback would leave this process serving
    // "covered" from cache for a marker that never existed. Replayed below,
    // BEFORE notifyWorkspaceCreated, whose registration consults it.
    const covered = await coverWorkspace(
      client, { landscapeId, versionId: snapshotId }, '0', { deferLocalWriteThrough: true },
    )
    await client.query('COMMIT')
    if (covered) noteCoveredLocally({ landscapeId, versionId: snapshotId })
    // THE PLACEMENT NOTES ARE PURGED HERE, AFTER COMMIT, AND NOWHERE EARLIER.
    // The autocommit publishers purge inside
    // `notifyWorkspaceDocumentsCreated`; this one claims on the transaction
    // client, so the moment its rows are DURABLE is this line — the same reason
    // `noteCoveredLocally` is deferred past COMMIT just above. Purging inside
    // `claimWorkspaceDocuments` would leave a rolled-back snapshot with neither
    // a row nor a note, admitted unconditionally.
    purgeServerCreationPlacement([...claims.claimed, ...claims.alreadyOurs])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    // The snapshot's documents are durable and unclaimed: residue for the
    // reaper, and their notes stay readable so any late save is still fenced.
    snapshotScope.retire()
    // The parent scope's documents (a rotated overlay segment) are claimed by
    // their own autocommit as they are created, so their notes are normally
    // purged already; a failure between a segment's mint and its claim is the
    // one case this reaches, and it must not leave a LIVE note behind.
    parentScope.retire()
    throw err
  } finally {
    client.release()
  }

  // Without notifyWorkspaceCreated, sibling displaced scans would stay blind to
  // the snapshot version for the version-list TTL. Notify now that everything
  // is durable; the covered
  // marker (written in the transaction above) makes the registration skip the
  // priming walk.
  notifyWorkspaceCreated({ landscapeId, versionId: snapshotId, rootUrl: snapshotRootUrl })

  return { ok: true, versionId: snapshotId }
}
