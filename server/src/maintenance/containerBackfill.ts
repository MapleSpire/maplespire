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
 * Backfill and conflict-heal for write-path containers that documents minted
 * before "containers at birth" lack (`containers.producers.test.ts` pins the
 * producers since).
 *
 * THE HAZARD. A container created LAZILY by its first writer is created twice
 * when two peers write first concurrently, and Automerge keeps one of the two
 * values under the key: the other peer's entries become unreachable (measured
 * in `modelMeta.test.ts`). A server-side backfill is itself such a creator: if
 * a client offline across the backfill created the same container lazily, the
 * merge hides that client's entries (measured in `containerBackfill.test.ts`,
 * "a backfill concurrent with an offline lazy creator"). So a backfill is only
 * sound where the hidden entries can be HEALED afterwards.
 *
 * HEALING. Every value of a conflicted key stays in the document
 * (`Automerge.getConflicts`). Appending to the WINNING value the entries a
 * losing value holds and the winner lacks restores them without replacing the
 * winner, so concurrent appends into the winner survive and a second healer is
 * a no-op (measured in the same file). The conflict itself remains — a key can
 * only be un-conflicted by reassigning it, which would hide whatever a peer is
 * appending to the current winner at that moment.
 *
 * That is sound ONLY for a list nobody removes from: a re-added entry the
 * winner's side had deliberately removed would be resurrected. Hence:
 *
 *  - WRITTEN AND HEALED — the current overlay write heads' `writeBatchIds`.
 *    Every PRODUCT writer only appends to it (bridge.ts `writeEditsShards`);
 *    the one remover is the load-soak gate's clean-up of its own `qa-` ids
 *    (server/scripts/verify-sync-cell-load-soak.mjs), and a heal resurrecting
 *    one makes the projector acknowledge it again, nothing worse. An ordinary
 *    workspace rotates its heads only through compaction, whose fresh heads are
 *    born with the list, so every head minted by `createEmptyRoot` before
 *    birth-time creation and not compacted since still lacks it. A hidden id
 *    not acknowledged before it was hidden is a batch the projector never
 *    acknowledges.
 *  - REPORTED, NEVER WRITTEN — the ModelMeta tombstone lists (`deleted*Ids`):
 *    ids are spliced out on re-creation and by compaction, so a heal could
 *    re-delete a re-created entity, and a backfill could hide an offline
 *    client's delete with nothing safe to heal it. New metas get them at birth
 *    (`buildModelMeta`); old ones keep their lazy writer, whose hazard this
 *    pass does not make worse. This preview names the ids a conflicted list
 *    holds only in a losing copy, for a person to check against the model —
 *    fsck does not report them, because an id compaction or an undo removed
 *    from the winner on purpose looks exactly the same.
 *  - REPORTED — the containers a reader treats differently when absent
 *    (`groups`: the ordinary projector refuses an absent map and syncs `{}` as
 *    "every group deleted"; a head's entity map, the same; the shard url lists:
 *    GC refuses an absent list and would sweep with `[]`).
 *
 * DiagramDocs are not visited: their containers are neither grow-only nor
 * cheap to enumerate (one resolve per diagram), and the static projector merges
 * a DiagramDoc OVER its read-model row, so `{}` there would replace the row's
 * value.
 *
 * A field PRESENT but of the wrong kind is reported, never replaced.
 *
 * Apply writes straight to storage through its own `Repo`: every sync cell
 * that can own the workspace must be stopped (the CLI refuses without
 * `CONTAINER_BACKFILL_OFFLINE_CONFIRMED=on`, the `repair-degenerate-roots`
 * contract — operator-asserted, not measured), and it runs under the lifecycle
 * apply lock. Under the lock the documents are re-read from STORAGE through a
 * fresh `Repo` (a reused one answers from its cache), the root's summary shape
 * is compared with the preview's, the lock's possession is re-checked, and only
 * documents mapped to this workspace are written.
 */

import { isValidAutomergeUrl, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { findReadyDocument } from '../automergeRepoCompat.js'
import type { SealedRepo } from '../rbac/sealedRepo.js'
import type { WorkspaceKey } from '../rbac/docScope.js'
import { sessionHoldsLifecycleLock, withLifecycleApplyLock } from './lifecycleApplyLock.js'
import { enumerateMaintainableWorkspaces } from './maintainableWorkspaces.js'
import { TOMBSTONE_LISTS, entryKey, hiddenListEntries } from './containerConflicts.js'

export { TOMBSTONE_LISTS, hiddenListEntries }

export type ContainerRole = 'model-meta' | 'object-head' | 'connection-head'
export type ContainerKind = 'list' | 'map'

interface ContainerRule {
  field: string
  kind: ContainerKind
  /** Why it is reported rather than written (report-only rules). */
  why?: string
}

/** Written when ABSENT, and healed when conflicted. Grow-only lists only. */
export const BACKFILLED_CONTAINERS: Readonly<Record<ContainerRole, readonly ContainerRule[]>> = {
  'model-meta': [],
  'object-head': [{ field: 'writeBatchIds', kind: 'list' }],
  'connection-head': [{ field: 'writeBatchIds', kind: 'list' }],
}

const LAZY_TOMBSTONES = 'left to its lazy writer: tombstones are spliced out, so neither a backfill nor a heal is safe '
  + '(new metas get it at birth)'
const PROJECTOR_REFUSES = 'the ordinary projector refuses an absent map but syncs `{}` as "every item deleted"'

/** Reported when ABSENT, never written. */
export const REPORTED_CONTAINERS: Readonly<Record<ContainerRole, readonly ContainerRule[]>> = {
  'model-meta': [
    { field: 'deletedObjectIds', kind: 'list', why: LAZY_TOMBSTONES },
    { field: 'deletedConnectionIds', kind: 'list', why: LAZY_TOMBSTONES },
    { field: 'deletedDecisionRecordIds', kind: 'list', why: LAZY_TOMBSTONES },
    { field: 'deletedDiagramIds', kind: 'list', why: LAZY_TOMBSTONES },
    { field: 'groups', kind: 'map', why: PROJECTOR_REFUSES },
    { field: 'objectShardUrls', kind: 'list', why: 'GC refuses an absent shard list; `[]` would let it sweep the children' },
    { field: 'connectionShardUrls', kind: 'list', why: 'GC refuses an absent shard list; `[]` would let it sweep the children' },
  ],
  'object-head': [{ field: 'objects', kind: 'map', why: PROJECTOR_REFUSES }],
  'connection-head': [{ field: 'connections', kind: 'map', why: PROJECTOR_REFUSES }],
}

export interface ContainerDocument {
  role: ContainerRole
  url: string
  /** `undefined` when the document did not resolve. An Automerge document otherwise. */
  doc: Record<string, unknown> | undefined
}

export interface ContainerWrite { url: string; role: ContainerRole; field: string; kind: ContainerKind }
export interface ContainerHeal { url: string; role: ContainerRole; field: string; entries: unknown[] }
export interface ContainerReport { url: string; role: ContainerRole; field: string; reason: string }

export interface ContainerPlan {
  writes: ContainerWrite[]
  heals: ContainerHeal[]
  /** Containers left alone on purpose, each with its reason. */
  reports: ContainerReport[]
  /** Documents that did not resolve, so their containers are UNKNOWN. */
  unresolved: { url: string; role: ContainerRole }[]
}

const isKind = (value: unknown, kind: ContainerKind) => (
  kind === 'list' ? Array.isArray(value) : Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

/** The decision, as a pure function of resolved documents. */
export function planContainerBackfill(documents: readonly ContainerDocument[]): ContainerPlan {
  const plan: ContainerPlan = { writes: [], heals: [], reports: [], unresolved: [] }
  for (const { role, url, doc } of documents) {
    if (!doc) {
      plan.unresolved.push({ url, role })
      continue
    }
    for (const rule of BACKFILLED_CONTAINERS[role]) {
      const value = doc[rule.field]
      if (value === undefined) {
        plan.writes.push({ url, role, field: rule.field, kind: rule.kind })
      } else if (!isKind(value, rule.kind)) {
        plan.reports.push({ url, role, field: rule.field, reason: `present but not a ${rule.kind}; a value is never replaced` })
      } else {
        const entries = hiddenListEntries(doc, rule.field)
        if (entries.length > 0) plan.heals.push({ url, role, field: rule.field, entries })
      }
    }
    for (const rule of REPORTED_CONTAINERS[role]) {
      const value = doc[rule.field]
      if (value === undefined) plan.reports.push({ url, role, field: rule.field, reason: `absent — not written: ${rule.why}` })
      else if (!isKind(value, rule.kind)) plan.reports.push({ url, role, field: rule.field, reason: `present but not a ${rule.kind}` })
    }
    if (role === 'model-meta') {
      for (const field of TOMBSTONE_LISTS) {
        const hidden = hiddenListEntries(doc, field)
        if (hidden.length > 0) {
          const shown = hidden.slice(0, 20).map((id) => JSON.stringify(id)).join(', ')
          plan.reports.push({
            url, role, field,
            reason: `conflicted: ${hidden.length} tombstone(s) in a losing list only — ${shown}`
              + `${hidden.length > 20 ? ', …' : ''}. Not healed: each may be one compaction or an undo removed from `
              + 'the winner on purpose; re-adding it would delete the entity again. Check each id against the model.',
          })
        }
      }
    }
  }
  return plan
}

const urlOf = (value: unknown): string | null => (
  typeof value === 'string' && isValidAutomergeUrl(value) ? value : null
)

/** The root fields the plan depends on; a change between preview and apply refuses. */
function rootShape(root: Record<string, unknown>): string {
  return JSON.stringify({
    modelMetaUrl: root.modelMetaUrl ?? null,
    registrySummaryOnly: root.registrySummaryOnly ?? null,
    registryWriteUrl: root.registryWriteUrl ?? null,
  })
}

export interface GatheredContainers {
  documents: ContainerDocument[]
  handleByUrl: Map<string, DocHandle<Record<string, unknown>>>
  /** True for a monolith root: no ModelMeta, nothing on this pass applies. */
  monolith: boolean
  rootShape: string
}

/** Resolve the ModelMeta and its two current write heads. */
export async function gatherContainerDocuments(
  repo: SealedRepo,
  rootUrl: string,
  resolveTimeoutMs = 8_000,
): Promise<GatheredContainers> {
  const handleByUrl = new Map<string, DocHandle<Record<string, unknown>>>()
  const resolve = async (url: string | null): Promise<Record<string, unknown> | undefined> => {
    if (!url) return undefined
    try {
      const handle = await findReadyDocument<Record<string, unknown>>(repo, url, resolveTimeoutMs)
      handleByUrl.set(url, handle)
      return handle.doc() ?? undefined
    } catch {
      return undefined
    }
  }
  const root = await resolve(urlOf(rootUrl))
  if (!root) throw new Error(`container backfill: the root ${rootUrl} did not resolve`)
  const metaUrl = urlOf(root.modelMetaUrl)
  if (!metaUrl) return { documents: [], handleByUrl, monolith: true, rootShape: rootShape(root) }
  const documents: ContainerDocument[] = []
  const meta = await resolve(metaUrl)
  documents.push({ role: 'model-meta', url: metaUrl, doc: meta })
  for (const [field, role] of [['editsObjectShardUrl', 'object-head'], ['editsConnectionShardUrl', 'connection-head']] as const) {
    const headUrl = urlOf(meta?.[field])
    if (headUrl) documents.push({ role, url: headUrl, doc: await resolve(headUrl) })
  }
  return { documents, handleByUrl, monolith: false, rootShape: rootShape(root) }
}

/**
 * Apply the plan's writes (each only if STILL absent at the change) and heals
 * (each entry only if STILL missing from the winner), then flush exactly the
 * documents changed.
 */
export async function writeContainerBackfill(
  repo: SealedRepo,
  plan: ContainerPlan,
  handleByUrl: ReadonlyMap<string, DocHandle<Record<string, unknown>>>,
): Promise<{ written: number; healed: number; documentIds: DocumentId[] }> {
  const urls = new Set([...plan.writes.map((write) => write.url), ...plan.heals.map((heal) => heal.url)])
  let written = 0
  let healed = 0
  const documentIds: DocumentId[] = []
  for (const url of urls) {
    const handle = handleByUrl.get(url)
    if (!handle) throw new Error(`container backfill: planned ${url} but holds no handle for it`)
    let changed = 0
    handle.change((doc) => {
      for (const write of plan.writes.filter((candidate) => candidate.url === url)) {
        if (doc[write.field] !== undefined) continue
        doc[write.field] = write.kind === 'list' ? [] : {}
        written += 1
        changed += 1
      }
      for (const heal of plan.heals.filter((candidate) => candidate.url === url)) {
        const list = doc[heal.field]
        if (!Array.isArray(list)) continue
        const have = new Set(list.map(entryKey))
        for (const entry of heal.entries) {
          if (have.has(entryKey(entry))) continue
          list.push(entry)
          have.add(entryKey(entry))
          healed += 1
          changed += 1
        }
      }
    })
    if (changed > 0) documentIds.push(handle.documentId)
  }
  if (documentIds.length > 0) await repo.flush(documentIds)
  return { written, healed, documentIds }
}

export type ContainerBackfillRefusal =
  | 'lock-unavailable'
  | 'lock-not-held'
  | 'workspace-unknown'
  | 'workspace-moved'
  | 'document-not-owned'

export interface ContainerBackfillReport {
  workspace: WorkspaceKey
  rootUrl: string | null
  monolith: boolean
  plan: ContainerPlan
  /** `null` in preview, and when apply was refused. */
  applied: { written: number; healed: number; documents: number; exclusionProven: boolean } | null
  refused: ContainerBackfillRefusal | null
  /** Quiescence is the operator's word (`CONTAINER_BACKFILL_OFFLINE_CONFIRMED`), never measured here. */
  quiesce: 'operator-asserted' | 'not-required'
}

type Queryable = Pick<Pool, 'query'>

async function rootUrlOf(db: Queryable, workspace: WorkspaceKey): Promise<string | null> {
  const row = (await enumerateMaintainableWorkspaces(db)).find((candidate) => (
    candidate.landscapeId === workspace.landscapeId && candidate.versionId === workspace.versionId
  ))
  return row?.rootUrl ?? null
}

async function ownedDocumentIds(db: Queryable, workspace: WorkspaceKey): Promise<Set<string>> {
  const { rows } = await db.query<{ document_id: string }>(
    `SELECT document_id FROM automerge_document_workspace WHERE landscape_id = $1 AND version_id = $2`,
    [workspace.landscapeId, workspace.versionId],
  )
  return new Set(rows.map((row) => row.document_id))
}

const documentIdOf = (url: string) => url.replace(/^automerge:/, '').split('?')[0]!

/**
 * Preview by default. With `apply`, everything is re-derived under the
 * lifecycle lock from a FRESH repo (`openRepo`), and refuses rather than
 * writes when anything the preview relied on moved.
 */
export async function backfillMissingContainers(args: {
  db: Pool
  /** The preview's repo. */
  repo: SealedRepo
  /** Opens a fresh repo over the same storage, for the re-read under the lock. Shut down by this call. */
  openRepo: () => SealedRepo & { shutdown(): Promise<void> }
  workspace: WorkspaceKey
  apply?: boolean
  resolveTimeoutMs?: number
}): Promise<ContainerBackfillReport> {
  const { db, repo, openRepo, workspace, apply = false, resolveTimeoutMs } = args
  const quiesce = apply ? 'operator-asserted' as const : 'not-required' as const
  const empty: ContainerPlan = { writes: [], heals: [], reports: [], unresolved: [] }
  const rootUrl = await rootUrlOf(db, workspace)
  if (!rootUrl) return { workspace, rootUrl: null, monolith: false, plan: empty, applied: null, refused: 'workspace-unknown', quiesce }
  const preview = await gatherContainerDocuments(repo, rootUrl, resolveTimeoutMs)
  const previewPlan = planContainerBackfill(preview.documents)
  const base = { workspace, rootUrl, monolith: preview.monolith, quiesce }
  if (!apply || preview.monolith || (previewPlan.writes.length === 0 && previewPlan.heals.length === 0)) {
    return { ...base, plan: previewPlan, applied: null, refused: null }
  }

  const outcome = await withLifecycleApplyLock(db, workspace, async (session) => {
    if (!(await sessionHoldsLifecycleLock(session, workspace))) return { refused: 'lock-not-held' as const }
    if (await rootUrlOf(session, workspace) !== rootUrl) return { refused: 'workspace-moved' as const }
    const owned = await ownedDocumentIds(session, workspace)
    const fresh = openRepo()
    try {
      const gathered = await gatherContainerDocuments(fresh, rootUrl, resolveTimeoutMs)
      if (gathered.rootShape !== preview.rootShape) return { refused: 'workspace-moved' as const }
      const plan = planContainerBackfill(gathered.documents)
      const foreign = [...plan.writes, ...plan.heals].find((change) => !owned.has(documentIdOf(change.url)))
      if (foreign) return { refused: 'document-not-owned' as const, plan }
      const result = await writeContainerBackfill(fresh, plan, gathered.handleByUrl)
      return { refused: null, plan, result }
    } finally {
      await fresh.shutdown()
    }
  })
  if (!outcome.granted) return { ...base, plan: previewPlan, applied: null, refused: 'lock-unavailable' }
  const value = outcome.value
  if (value.refused !== null) {
    return { ...base, plan: 'plan' in value && value.plan ? value.plan : previewPlan, applied: null, refused: value.refused }
  }
  return {
    ...base,
    plan: value.plan,
    applied: {
      written: value.result.written,
      healed: value.result.healed,
      documents: value.result.documentIds.length,
      exclusionProven: outcome.exclusionProven,
    },
    refused: null,
  }
}
