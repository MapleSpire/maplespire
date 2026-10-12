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
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocumentId,
  type Repo,
} from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { withLifecycleApplyLock } from './lifecycleApplyLock.js'
import type { WorkspaceKey } from '../readModel/projector.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { copyRootShape } from '../rootShape.js'

type PlainDocument = Record<string, unknown>

export interface RootRepairPlan {
  rootUrl: AutomergeUrl
  modelUrl: string | null
  modelMetaUrl: AutomergeUrl | null
  shardUrls: AutomergeUrl[]
  registryWriteUrl: AutomergeUrl | null
  issues: string[]
}

export interface DegenerateRootAudit extends RootRepairPlan {
  landscapeId: string
  versionId: string
  label: string
  mappedDocuments: number
  /** Present when the version has a `read_model_static_workspaces` row — the
   * SAME predicate the plan already uses (`static_source !== null`, the
   * `registrySummaryOnly` option below). The rotated root must keep the
   * summary contract fields (D2): guarding them with `sparseDraft` silently
   * demoted a rotated performance/promoted root to the ordinary contract —
   * unbounded walk, full client materialisation, and a root the fsck
   * `summary-static-coherence` check flags as a degraded hybrid. */
  staticWorkspace?: {
    diagramCount: number
  }
  sparseDraft?: {
    parentVersionId: string
    parentRootUrl: string
    diagramCount: number
  }
}

export interface DegenerateRootRepairResult {
  reportOnly: boolean
  safeToApply: boolean
  workspaces: DegenerateRootAudit[]
  repaired: number
  rotations: Array<{
    landscapeId: string
    versionId: string
    oldRootUrl: AutomergeUrl
    newRootUrl: AutomergeUrl
  }>
  /**
   * Workspaces whose rotation was REFUSED because a sibling lifecycle door held
   * the workspace's apply lock. Nothing was published for them, and re-running
   * once that door finishes rotates them.
   *
   * Separate from `workspaces[].issues`, which describe a plan that cannot be
   * built. A refusal here means the plan was fine and the moment was not.
   */
  refused: Array<{ landscapeId: string; versionId: string }>
}

interface PublishedDocument {
  documentId: string
  kind: string
}

interface RootRotation {
  newRootUrl: AutomergeUrl
  publishedDocuments: PublishedDocument[]
  retiredDocumentIds: string[]
}

function urls(values: unknown): AutomergeUrl[] {
  return Array.isArray(values)
    ? values.filter((value): value is AutomergeUrl => typeof value === 'string' && isValidAutomergeUrl(value))
    : []
}

function isModelMeta(value: PlainDocument): boolean {
  return Array.isArray(value.objectShardUrls) && Array.isArray(value.connectionShardUrls)
}

function isRegistry(value: PlainDocument): boolean {
  return value.diagrams !== null && typeof value.diagrams === 'object' && !Array.isArray(value.diagrams)
}

function isLegacyModel(value: PlainDocument): boolean {
  return ['objects', 'connections', 'groups', 'domains', 'tagSnapshots', 'decisionRecords']
    .every((key) => key in value)
}

function plain(value: PlainDocument | undefined): PlainDocument {
  return JSON.parse(JSON.stringify(value ?? {})) as PlainDocument
}

function documentId(url: string): string {
  return url.replace(/^automerge:/, '')
}

async function readyDocument(repo: Repo, url: AutomergeUrl): Promise<PlainDocument> {
  const handle = await findReadyDocument<PlainDocument>(repo, url)
  return plain(handle.doc() as PlainDocument | undefined)
}

/**
 * Publish a replacement root instead of mutating the damaged Automerge
 * document in place. An offline repair of the old URL is not durable: a stale
 * browser can later sync the old empty heads and win the conflicting root
 * assignments again. Once versions.root_url points at a fresh document, peers
 * that only know the retired URL cannot corrupt the canonical root.
 *
 * Sparse drafts rotate their small control plane too (legacy compatibility
 * model, ModelMeta and registries). Those documents are O(1), and isolating
 * them also prevents an old draft client from clearing a repaired registry or
 * ModelMeta after the root has moved.
 */
export async function publishRotatedRoot(
  repo: Repo,
  workspace: DegenerateRootAudit,
): Promise<RootRotation> {
  if (workspace.modelUrl === null || !workspace.modelMetaUrl) {
    throw new Error('validated root repair lost its plan')
  }

  let modelUrl = workspace.modelUrl
  let modelMetaUrl: AutomergeUrl = workspace.modelMetaUrl
  let shardUrls = [...workspace.shardUrls]
  let registryWriteUrl = workspace.registryWriteUrl
  const publishedDocuments: PublishedDocument[] = []
  const retiredDocumentIds = [documentId(workspace.rootUrl)]

  if (workspace.sparseDraft) {
    const legacyModel = isValidAutomergeUrl(workspace.modelUrl)
      ? await readyDocument(repo, workspace.modelUrl as AutomergeUrl)
      : {
          objects: {}, connections: {}, groups: {}, domains: {},
          tagSnapshots: {}, decisionRecords: {},
        }
    const nextModel = repo.create<PlainDocument>(legacyModel)
    const nextMeta = repo.create<PlainDocument>(await readyDocument(repo, workspace.modelMetaUrl))
    const nextRegistries = []
    for (const registryUrl of workspace.shardUrls) {
      const value = await readyDocument(repo, registryUrl)
      if (!isRegistry(value)) value.diagrams = {}
      nextRegistries.push(repo.create<PlainDocument>(value))
    }
    await Promise.all([nextModel, nextMeta, ...nextRegistries].map((handle) => handle.whenReady()))
    await repo.flush([nextModel.documentId, nextMeta.documentId, ...nextRegistries.map((handle) => handle.documentId)])
    modelUrl = nextModel.url
    modelMetaUrl = nextMeta.url
    shardUrls = nextRegistries.map((handle) => handle.url)
    const writeIndex = workspace.registryWriteUrl
      ? workspace.shardUrls.indexOf(workspace.registryWriteUrl)
      : -1
    registryWriteUrl = writeIndex >= 0 ? nextRegistries[writeIndex]?.url ?? null : null
    publishedDocuments.push(
      { documentId: nextModel.documentId, kind: 'model-legacy' },
      { documentId: nextMeta.documentId, kind: 'model-meta' },
      ...nextRegistries.map((handle) => ({ documentId: handle.documentId, kind: 'registry-shard' })),
    )
    retiredDocumentIds.push(
      documentId(workspace.modelMetaUrl),
      ...workspace.shardUrls.map(documentId),
      ...(isValidAutomergeUrl(workspace.modelUrl) ? [documentId(workspace.modelUrl)] : []),
    )
  }

  // The ONE root-shape mapper (rootShape.ts) — undefined fields are dropped.
  // Two guards, deliberately DIFFERENT: the summary fields follow the STATIC
  // row (`staticWorkspace`, i.e. `static_source !== null` — the same predicate
  // the plan uses for `registrySummaryOnly` above), while the sparse-draft
  // base pointers follow the sparse-draft audit only. A rotated performance or
  // promoted root is summary without being anyone's draft, and must keep the
  // flag here. A sparse-draft audit alone still implies summary —
  // `static_source = 'sparse-draft'` IS a static row — so a caller that built
  // the audit by hand without `staticWorkspace` keeps the old contract.
  const summary = workspace.staticWorkspace ?? workspace.sparseDraft
  const nextRoot = repo.create<PlainDocument>(copyRootShape(undefined, {
    modelUrl,
    modelMetaUrl,
    shardUrls,
    registryWriteUrl: registryWriteUrl ?? undefined,
    registrySummaryOnly: summary ? true : undefined,
    diagramCount: summary?.diagramCount,
    sparseDraftBaseVersionId: workspace.sparseDraft?.parentVersionId,
    sparseDraftBaseRootUrl: workspace.sparseDraft?.parentRootUrl,
  }) as unknown as PlainDocument)
  await nextRoot.whenReady()
  await repo.flush([nextRoot.documentId as DocumentId])
  publishedDocuments.push({ documentId: nextRoot.documentId, kind: 'root' })
  return {
    newRootUrl: nextRoot.url,
    publishedDocuments,
    retiredDocumentIds: [...new Set(retiredDocumentIds)],
  }
}

export function isStructurallyHealthyRoot(value: PlainDocument | undefined): boolean {
  if (!value) return false
  const hasModel = (typeof value.modelUrl === 'string' && isValidAutomergeUrl(value.modelUrl))
    || (typeof value.modelMetaUrl === 'string' && isValidAutomergeUrl(value.modelMetaUrl))
  const registryWriteUrl = typeof value.registryWriteUrl === 'string'
    && isValidAutomergeUrl(value.registryWriteUrl)
    ? value.registryWriteUrl
    : null
  return hasModel
    && Array.isArray(value.shardUrls)
    && value.shardUrls.length > 0
    && value.shardUrls.every((url) => typeof url === 'string' && isValidAutomergeUrl(url))
    && (value.registrySummaryOnly !== true
      || (registryWriteUrl !== null && value.shardUrls.includes(registryWriteUrl)))
}

export function buildDegenerateRootRepairPlan(
  rootUrl: AutomergeUrl,
  documents: readonly { url: AutomergeUrl; value: PlainDocument; kind?: string | null }[],
  options: {
    allowMissingLegacyModel?: boolean
    registrySummaryOnly?: boolean
    preferredRegistryWriteUrl?: unknown
  } = {},
): RootRepairPlan {
  const mapped = new Set(documents.map(({ url }) => url))
  const modelCandidates = documents
    .filter(({ value, kind }) => ['model', 'model-legacy'].includes(kind ?? '') || isLegacyModel(value))
    .map(({ url }) => url)
  const metaCandidates = documents
    .filter(({ value, kind }) => kind === 'model-meta' || isModelMeta(value))
    .map(({ url }) => url)
  const registryCandidates = documents
    .filter(({ value, kind }) => ['registry', 'registry-shard'].includes(kind ?? '') || isRegistry(value))
    .map(({ url }) => url)
  const modelUrl = modelCandidates.length === 1
    ? modelCandidates[0]
    : options.allowMissingLegacyModel && modelCandidates.length === 0 ? '' : null
  const modelMetaUrl = metaCandidates.length === 1 ? metaCandidates[0] : null
  const shardUrls = registryCandidates
  const issues: string[] = []
  let registryWriteUrl: AutomergeUrl | null = null
  if (options.registrySummaryOnly) {
    if (
      typeof options.preferredRegistryWriteUrl === 'string'
      && isValidAutomergeUrl(options.preferredRegistryWriteUrl)
      && registryCandidates.includes(options.preferredRegistryWriteUrl as AutomergeUrl)
    ) {
      registryWriteUrl = options.preferredRegistryWriteUrl as AutomergeUrl
    } else if (registryCandidates.length === 1) {
      registryWriteUrl = registryCandidates[0]
    } else {
      const emptyRegistries = documents
        .filter(({ url, value }) => registryCandidates.includes(url) && Object.keys(
          value.diagrams && typeof value.diagrams === 'object' && !Array.isArray(value.diagrams)
            ? value.diagrams as Record<string, unknown>
            : {},
        ).length === 0)
        .map(({ url }) => url)
      if (emptyRegistries.length === 1) registryWriteUrl = emptyRegistries[0]
      else issues.push(`registry-write-head-cardinality:${emptyRegistries.length}`)
    }
  }
  if (!mapped.has(rootUrl)) issues.push('root-not-mapped')
  if (modelCandidates.length !== 1 && !(options.allowMissingLegacyModel && modelCandidates.length === 0)) {
    issues.push(`legacy-model-cardinality:${modelCandidates.length}`)
  }
  if (metaCandidates.length !== 1) issues.push(`model-meta-cardinality:${metaCandidates.length}`)
  if (registryCandidates.length === 0) issues.push('registry-shard-cardinality:0')

  const meta = modelMetaUrl ? documents.find(({ url }) => url === modelMetaUrl)?.value : undefined
  const referenced = new Set<AutomergeUrl>([
    ...urls(meta?.objectShardUrls),
    ...urls(meta?.connectionShardUrls),
    ...urls(meta?.decisionRecordShardUrls),
    ...urls(meta?.editsObjectShardUrls),
    ...urls(meta?.editsConnectionShardUrls),
  ])
  if (typeof meta?.editsObjectShardUrl === 'string' && isValidAutomergeUrl(meta.editsObjectShardUrl)) {
    referenced.add(meta.editsObjectShardUrl)
  }
  if (typeof meta?.editsConnectionShardUrl === 'string' && isValidAutomergeUrl(meta.editsConnectionShardUrl)) {
    referenced.add(meta.editsConnectionShardUrl)
  }
  for (const registryUrl of registryCandidates) {
    const registry = documents.find(({ url }) => url === registryUrl)?.value
    for (const entry of Object.values((registry?.diagrams ?? {}) as Record<string, { docUrl?: unknown }>)) {
      if (typeof entry?.docUrl === 'string' && isValidAutomergeUrl(entry.docUrl)) referenced.add(entry.docUrl)
    }
  }
  const missingReferences = [...referenced].filter((url) => !mapped.has(url))
  if (missingReferences.length > 0) issues.push(`referenced-document-not-mapped:${missingReferences.length}`)
  return { rootUrl, modelUrl, modelMetaUrl, shardUrls, registryWriteUrl, issues }
}

/**
 * THE FIFTH DOOR ONTO THE WORKSPACE APPLY KEY.
 *
 * `db` is a `Pool` and not a `Queryable` for the same reason
 * `repairReferenceIntegrity`'s is: the apply path takes the lifecycle apply
 * lock, which needs a connection it can PIN. Narrowing the parameter is what
 * makes "rotate the root without the lock" unrepresentable rather than
 * discouraged. Every production caller already passed a pool.
 *
 * WHY A LOCK ON A READ PATH IS ACCEPTABLE: the hot path is
 * `isStructurallyHealthyRoot`, which returns before reaching this function on
 * every healthy workspace. What is behind the
 * check is a ROTATION: publishing a fresh root and compare-and-swapping
 * `versions.root_url`, the only writer of that column in the tree. That is
 * rare, durable, and precisely the witness the fourth door samples and re-reads
 * — so a rotation landing between that re-read and its writes reproduces
 * exactly the harm the re-read exists to prevent.
 *
 * THE LOCK IS PER WORKSPACE AND AROUND THE ROTATION ONLY. The audit above it
 * stays ungated: it writes nothing, and it is the report an operator reads
 * while a promotion is running.
 */
export async function repairDegenerateRoots(
  db: Pool,
  repo: Repo,
  options: { apply?: boolean; workspace?: WorkspaceKey } = {},
): Promise<DegenerateRootRepairResult> {
  const { rows: versions } = await db.query<{
    landscape_id: string
    id: string
    label: string
    root_url: AutomergeUrl
    parent_version_id: string | null
    base_manifest: { rootUrl?: unknown } | null
    static_source: string | null
    parent_diagram_count: string | number
    own_diagram_count: string | number
  }>(
    `SELECT version.landscape_id, version.id, version.label, version.root_url,
            version.parent_version_id, version.base_manifest,
            workspace.source AS static_source,
            (SELECT count(*) FROM ro_diagrams diagram
             WHERE diagram.landscape_id = version.landscape_id
               AND diagram.version_id = version.parent_version_id) AS parent_diagram_count,
            (SELECT count(*) FROM ro_diagrams diagram
             WHERE diagram.landscape_id = version.landscape_id
               AND diagram.version_id = version.id) AS own_diagram_count
     FROM versions version
     LEFT JOIN read_model_static_workspaces workspace
       ON workspace.landscape_id = version.landscape_id
      AND workspace.version_id = version.id
     WHERE ($1::text IS NULL OR version.landscape_id = $1)
       AND ($2::text IS NULL OR version.id = $2)
     ORDER BY version.landscape_id, version.id`,
    [options.workspace?.landscapeId ?? null, options.workspace?.versionId ?? null],
  )
  const workspaces: DegenerateRootAudit[] = []
  const auditedRoots = new Set<AutomergeUrl>()
  for (const version of versions) {
    let root: PlainDocument = {}
    let rootUnavailable = false
    try {
      const rootHandle = await findReadyDocument(repo, version.root_url)
      root = (rootHandle.doc() ?? {}) as PlainDocument
    } catch {
      // A referenced root can have a durable mapping while its only snapshot
      // is unreadable. This remains repairable when the mapped children form
      // one complete, unambiguous graph: the repair publishes a fresh root URL
      // and never mutates or trusts the bad history.
      rootUnavailable = true
    }
    if (isStructurallyHealthyRoot(root)) continue
    const { rows: mappings } = await db.query<{ document_id: string; kind: string | null }>(
      `WITH candidate AS (
         SELECT document_id, NULL::text AS kind
         FROM automerge_document_workspace
         WHERE landscape_id = $1 AND version_id = $2
         UNION ALL
         SELECT document_id, kind
         FROM read_model_static_documents
         WHERE landscape_id = $1 AND version_id = $2
       )
       SELECT document_id, max(kind) AS kind
       FROM candidate GROUP BY document_id ORDER BY document_id`,
      [version.landscape_id, version.id],
    )
    const documents: Array<{ url: AutomergeUrl; value: PlainDocument; kind: string | null }> = []
    const unavailable: string[] = []
    for (const { document_id: documentId, kind } of mappings) {
      const url = `automerge:${documentId}` as AutomergeUrl
      if (rootUnavailable && url === version.root_url) {
        // Preserve the proven SQL mapping in the reconstruction graph without
        // pretending the unreadable bytes were successfully materialized.
        documents.push({ url, value: {}, kind: kind ?? 'root' })
        continue
      }
      try {
        const handle = await findReadyDocument(repo, url)
        documents.push({ url, value: (handle.doc() ?? {}) as PlainDocument, kind })
      } catch {
        unavailable.push(documentId)
      }
    }
    const sparseDraft = version.static_source === 'sparse-draft'
      && version.parent_version_id
      && typeof version.base_manifest?.rootUrl === 'string'
      ? {
          parentVersionId: version.parent_version_id,
          parentRootUrl: version.base_manifest.rootUrl,
          diagramCount: Number(version.parent_diagram_count),
        }
      : undefined
    // D2: the summary contract follows the STATIC row, not the sparse-draft
    // audit — the same predicate as the plan's `registrySummaryOnly` below. A
    // sparse draft counts its PARENT's diagrams (its baseline lives in the
    // parent's read model); every other static workspace counts its own.
    const staticWorkspace = version.static_source !== null
      ? {
          diagramCount: Number(version.static_source === 'sparse-draft'
            ? version.parent_diagram_count
            : version.own_diagram_count),
        }
      : undefined
    const plan = buildDegenerateRootRepairPlan(version.root_url, documents, {
      allowMissingLegacyModel: sparseDraft !== undefined,
      registrySummaryOnly: version.static_source !== null,
      preferredRegistryWriteUrl: root.registryWriteUrl,
    })
    if (unavailable.length > 0) plan.issues.push(`mapped-document-unavailable:${unavailable.length}`)
    workspaces.push({
      ...plan,
      landscapeId: version.landscape_id,
      versionId: version.id,
      label: version.label,
      mappedDocuments: mappings.length,
      ...(staticWorkspace ? { staticWorkspace } : {}),
      ...(sparseDraft ? { sparseDraft } : {}),
    })
    auditedRoots.add(version.root_url)
  }
  const safeToApply = workspaces.length > 0 && workspaces.every((workspace) => workspace.issues.length === 0)
  if (!options.apply || !safeToApply) {
    return { reportOnly: !options.apply, safeToApply, workspaces, repaired: 0, rotations: [], refused: [] }
  }

  const rotations: DegenerateRootRepairResult['rotations'] = []
  const refused: DegenerateRootRepairResult['refused'] = []
  // Operator tool, not a transaction: a `read_model_static_workspaces` row
  // inserted between the audit above and this apply loop publishes a root
  // whose summary fields follow the AUDIT-time row set — a hybrid fsck's
  // summary-static-coherence check detects, fixed by re-running the repair.
  for (const workspace of workspaces) {
    if (!auditedRoots.has(workspace.rootUrl)) throw new Error('validated root repair lost its plan')
    // THE WORKSPACE'S APPLY KEY, the same one the promotion, the demotion, the
    // flag repair and the reference-integrity apply take. Everything from the
    // fresh root's publication to the `versions.root_url` CAS is inside it:
    // publishing outside and swapping inside would leave the swap racing the
    // very doors that read `root_url` as their witness.
    //
    // PER WORKSPACE, not around the whole loop — this function can be pointed
    // at a fleet, and one blocked workspace must not stop the others. That
    // holds for a REFUSAL, which `continue`s below. It does NOT hold for a
    // throw: `pool-exhausted` and a failed CAS both abandon the remaining
    // workspaces, which is stated here rather than implied by the sentence
    // above it.
    //
    // EVERY STATEMENT RUNS ON THE LOCKED SESSION, not on the pool, and that is
    // a durability fix rather than a tidiness one. This door PINS a connection
    // for the whole rotation, so
    // with `DB_POOL_MAX` degenerate workspaces rotating at once — distinct
    // keys, so all are granted — every holder pins one connection and then
    // needs a second for its own SQL, and none can release until it gets one.
    // Each then fails at `connectionTimeoutMillis`. Landing between the two
    // mapping INSERTs and the CAS leaves BOTH the old and the new model/meta
    // documents mapped, which makes `buildDegenerateRootRepairPlan` report
    // `model-meta-cardinality:2` on every later run — `safeToApply` false
    // FOREVER, and `/api/automerge/root` answering a permanently retryable 503
    // for a workspace that can never be repaired.
    //
    // Using the session the wrapper already minted removes that borrow, so the
    // only remaining one is inside `publishRotatedRoot`'s flushes — which run
    // BEFORE anything durable is written, so a timeout there leaves nothing to
    // clean up. It also makes the writes run on the backend
    // `sessionHoldsLifecycleLock` interrogates.
    //
    // KNOWN RESIDUAL: N holders still consume N of the pool's connections while
    // their flushes borrow from the same pool. The dedicated
    // `lifecycleApplyPool` (`db.ts`), which the three summary doors use, is the
    // target form, but this call site is deliberately NOT converted.
    // `withLifecycleApplyLock` hands the session to the callback
    // below, which runs `session.query(...)` on it — so the pool must carry the
    // caller's schema, which the injected `db` does and a module-scope pool does
    // not for an isolated-schema test. And this path is reached from an ORDINARY
    // user request through `ensureHealthyWorkspaceRoot`, so a `max: 4` bound
    // would turn a fifth concurrent root repair into a user-facing 503 rather
    // than into a slower admin operation — a product decision not yet taken.
    const outcome = await withLifecycleApplyLock(db, workspace, async (session) => {
      const rotation = await publishRotatedRoot(repo, workspace)

      // Map every replacement before publishing the new root pointer. A crash
      // can leave unreachable mapped documents for the fenced GC, but can never
      // expose a root whose children are missing from durable storage or RBAC
      // scope. What it CAN leave: `read_model_static_documents` rows and un-retired old children
      // whose duplication makes the next plan unsafe. See the block above.
      const ids = rotation.publishedDocuments.map(({ documentId }) => documentId)
      const kinds = rotation.publishedDocuments.map(({ kind }) => kind)
      await session.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         SELECT document_id, $1, $2 FROM unnest($3::text[]) AS input(document_id)
         ON CONFLICT (document_id) DO UPDATE SET
           landscape_id = EXCLUDED.landscape_id,
           version_id = EXCLUDED.version_id`,
        [workspace.landscapeId, workspace.versionId, ids],
      )
      // Kind semantics of the rotated registries: `publishRotatedRoot` labels
      // them 'registry-shard' — the WRITABLE kind, i.e. the post-rotation write
      // path — DELIBERATELY: the baseline write fence (isBaselineDocumentKind,
      // rbac/docScope.ts) freezes kind 'registry', and a rotation that
      // relabeled the freshly minted write head as baseline would fence the
      // very document the repaired workspace must keep writing.
      await session.query(
        `INSERT INTO read_model_static_documents (
           landscape_id, version_id, document_id, kind, entity_id
         )
         SELECT $1, $2, input.document_id, input.kind, NULL
         FROM unnest($3::text[], $4::text[]) AS input(document_id, kind)
         WHERE EXISTS (
           SELECT 1 FROM read_model_static_workspaces workspace
           WHERE workspace.landscape_id = $1 AND workspace.version_id = $2
         )
         ON CONFLICT (landscape_id, version_id, document_id) DO UPDATE SET
           kind = EXCLUDED.kind,
           entity_id = NULL`,
        [workspace.landscapeId, workspace.versionId, ids, kinds],
      )
      const switched = await session.query(
        `UPDATE versions SET root_url = $1
         WHERE landscape_id = $2 AND id = $3 AND root_url = $4`,
        [rotation.newRootUrl, workspace.landscapeId, workspace.versionId, workspace.rootUrl],
      )
      if (switched.rowCount !== 1) {
        throw new Error(`degenerate root CAS failed for ${workspace.landscapeId}/${workspace.versionId}`)
      }

      await session.query(
        `DELETE FROM read_model_static_documents
         WHERE landscape_id = $1 AND version_id = $2
           AND document_id = ANY($3::text[])`,
        [workspace.landscapeId, workspace.versionId, rotation.retiredDocumentIds],
      )
      await session.query(
        `DELETE FROM automerge_document_workspace
         WHERE landscape_id = $1 AND version_id = $2
           AND document_id = ANY($3::text[])`,
        [workspace.landscapeId, workspace.versionId, rotation.retiredDocumentIds],
      )
      return rotation.newRootUrl
    })
    if (!outcome.granted) {
      // REFUSED, not failed. Nothing was published for this workspace: the
      // callback never ran, so there is no half-rotated state to describe.
      refused.push({ landscapeId: workspace.landscapeId, versionId: workspace.versionId })
      continue
    }
    if (!outcome.exclusionProven) {
      // The rotation ran and the exclusion could not be proven over all of it.
      // Loud rather than swallowed: this one publishes a root and swaps the
      // column every other door samples, so an unexcluded window here is the
      // most expensive one in the set.
      console.error(
        `[degenerate-root-repair] rotated ${workspace.landscapeId}/${workspace.versionId} but could `
        + 'NOT prove the apply lock was held throughout. Run fsck on this workspace.',
      )
    }
    rotations.push({
      landscapeId: workspace.landscapeId,
      versionId: workspace.versionId,
      oldRootUrl: workspace.rootUrl,
      newRootUrl: outcome.value,
    })
  }
  return {
    reportOnly: false, safeToApply, workspaces, repaired: rotations.length, rotations, refused,
  }
}
