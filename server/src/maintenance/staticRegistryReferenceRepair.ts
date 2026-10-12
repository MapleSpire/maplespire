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

import type { AutomergeUrl, DocumentId, Repo } from '@automerge/automerge-repo'
import { createHash } from 'node:crypto'
import type { Queryable } from '../readModel/types.js'
import {
  classifyMissingRegistryReference,
  type MissingRegistryReference,
} from './registryReferenceRepair.js'
import { findReadyDocument } from '../automergeRepoCompat.js'

type RegistryDocument = { diagrams?: Record<string, { docUrl?: string }> }
type RepoFactory = () => Repo

export interface StaticRegistryRootRepairCandidate {
  landscapeId: string
  versionId: string
  rootUrl: AutomergeUrl
  source: string
  diagramCount: number
  requiredRegistryCount: number
  currentRegistryCount: number
  retainedUrls: AutomergeUrl[]
  removedUrls: AutomergeUrl[]
}

export function planStaticRegistryRootRepair(input: {
  landscapeId: string
  versionId: string
  rootUrl: AutomergeUrl
  source: string
  diagramCount: number
  shardUrls: AutomergeUrl[]
  storedUrls: ReadonlySet<AutomergeUrl>
  registryShardSize?: number
}): StaticRegistryRootRepairCandidate | null {
  if (!['performance-seed-editable', 'sparse-draft'].includes(input.source)) return null
  const shardSize = input.registryShardSize ?? 200
  if (!Number.isSafeInteger(shardSize) || shardSize < 1) return null
  const requiredRegistryCount = Math.ceil(input.diagramCount / shardSize)
  if (input.shardUrls.length <= requiredRegistryCount) return null
  const retainedUrls = input.shardUrls.slice(0, requiredRegistryCount)
  const removedUrls = input.shardUrls.slice(requiredRegistryCount)
  if (!retainedUrls.every((url) => input.storedUrls.has(url))) return null
  if (!removedUrls.every((url) => !input.storedUrls.has(url))) return null
  return {
    landscapeId: input.landscapeId,
    versionId: input.versionId,
    rootUrl: input.rootUrl,
    source: input.source,
    diagramCount: input.diagramCount,
    requiredRegistryCount,
    currentRegistryCount: input.shardUrls.length,
    retainedUrls,
    removedUrls,
  }
}

function rootRepairDigest(candidates: readonly StaticRegistryRootRepairCandidate[]): string {
  return createHash('sha256').update(JSON.stringify(
    [...candidates]
      .sort((left, right) => left.rootUrl.localeCompare(right.rootUrl))
      .map((candidate) => ({
        rootUrl: candidate.rootUrl,
        retainedUrls: candidate.retainedUrls,
        removedUrls: candidate.removedUrls,
      })),
  )).digest('hex')
}

async function withRepo<T>(factory: RepoFactory, task: (repo: Repo) => Promise<T>): Promise<T> {
  const repo = factory()
  try {
    return await task(repo)
  } finally {
    // No pre-shutdown handle cleanup is needed: `shutdown()`'s flush already
    // skips any document whose query is not ready (see `Repo.flush`), and
    // `repo.handles` returns a copy rebuilt per access, so deleting from it
    // would do nothing.
    await repo.shutdown()
  }
}

export async function repairStaticRegistryReferences(
  db: Queryable,
  repoFactory: RepoFactory,
  options: {
    apply?: boolean
    applyRootRepairs?: boolean
    expectedRootRepairDigest?: string
    auditOffset?: number
    auditLimit?: number
  } = {},
): Promise<{
  reportOnly: boolean
  safeToApply: boolean
  registries: number
  references: number
  missingRegistries: Array<{
    landscapeId: string
    versionId: string
    registryUrl: AutomergeUrl
    index: number | null
    mapped: boolean
  }>
  uncoveredMissingRegistries: number
  rootRepairs: StaticRegistryRootRepairCandidate[]
  rootRepairCandidateDigest: string
  rootRepairsApplied: number
  safeToRepairRoots: boolean
  registrySummaries: Array<{
    registryUrl: AutomergeUrl
    landscapeId: string
    versionId: string
    index: number | null
    references: number
  }>
  missing: MissingRegistryReference[]
  removed: number
  audit: { offset: number; limit: number; available: number; audited: number; complete: boolean }
}> {
  const { rows: workspaces } = await db.query<{
    landscape_id: string
    version_id: string
    root_url: AutomergeUrl
    source: string
    diagram_count: string | number
  }>(
    `SELECT workspace.landscape_id, workspace.version_id, version.root_url,
            workspace.source,
            (SELECT count(*) FROM ro_diagrams diagram
             WHERE diagram.landscape_id = workspace.landscape_id
               AND diagram.version_id = workspace.version_id) AS diagram_count
     FROM read_model_static_workspaces workspace
     JOIN versions version
       ON version.landscape_id = workspace.landscape_id
      AND version.id = workspace.version_id
     ORDER BY workspace.landscape_id, workspace.version_id`,
  )
  const registryWorkspaces = new Map<AutomergeUrl, {
    landscapeId: string
    versionId: string
    index: number | null
  }>()
  const workspaceRoots: Array<{
    landscapeId: string
    versionId: string
    rootUrl: AutomergeUrl
    source: string
    diagramCount: number
    shardUrls: AutomergeUrl[]
  }> = []
  for (const workspace of workspaces) {
    await withRepo(repoFactory, async (repo) => {
      const root = await findReadyDocument(repo, workspace.root_url)
      const shardUrls = (root.doc() as { shardUrls?: unknown } | undefined)?.shardUrls
      if (!Array.isArray(shardUrls)) return
      const validShardUrls = shardUrls.filter((value): value is AutomergeUrl => (
        typeof value === 'string' && value.startsWith('automerge:')
      ))
      workspaceRoots.push({
        landscapeId: workspace.landscape_id,
        versionId: workspace.version_id,
        rootUrl: workspace.root_url,
        source: workspace.source,
        diagramCount: Number(workspace.diagram_count),
        shardUrls: validShardUrls,
      })
      for (const [index, value] of shardUrls.entries()) {
        if (typeof value === 'string' && value.startsWith('automerge:')) {
          registryWorkspaces.set(value as AutomergeUrl, {
            landscapeId: workspace.landscape_id,
            versionId: workspace.version_id,
            index,
          })
        }
      }
    })
  }
  const { rows: descriptors } = await db.query<{
    landscape_id: string
    version_id: string
    url: AutomergeUrl
  }>(
    `SELECT document.landscape_id, document.version_id,
            'automerge:' || document.document_id AS url
     FROM read_model_static_documents document
     WHERE document.kind IN ('registry', 'registry-shard')`,
  )
  for (const descriptor of descriptors) {
    if (registryWorkspaces.has(descriptor.url)) continue
    registryWorkspaces.set(descriptor.url, {
      landscapeId: descriptor.landscape_id,
      versionId: descriptor.version_id,
      index: null,
    })
  }

  const registryUrls = [...registryWorkspaces.keys()]
  const { rows: registryStates } = registryUrls.length > 0
    ? await db.query<{ document_id: string; stored: boolean; mapped: boolean }>(
        `WITH candidate(document_id) AS (SELECT unnest($1::text[]))
         SELECT candidate.document_id,
           EXISTS (SELECT 1 FROM automerge_storage storage
                   WHERE split_part(storage.key, '/', 1) = candidate.document_id) AS stored,
           EXISTS (SELECT 1 FROM automerge_document_workspace mapping
                   WHERE mapping.document_id = candidate.document_id) AS mapped
         FROM candidate`,
        [registryUrls.map((url) => url.slice('automerge:'.length))],
      )
    : { rows: [] }
  const registryStateById = new Map(registryStates.map((state) => [state.document_id, state]))
  const missingRegistries = registryUrls.flatMap((registryUrl) => {
    const state = registryStateById.get(registryUrl.slice('automerge:'.length))
    if (state?.stored) return []
    const workspace = registryWorkspaces.get(registryUrl)!
    return [{ ...workspace, registryUrl, mapped: state?.mapped === true }]
  })
  const storedUrls = new Set(registryUrls.filter((registryUrl) => (
    registryStateById.get(registryUrl.slice('automerge:'.length))?.stored === true
  )))
  const rootRepairs = workspaceRoots.flatMap((workspace) => {
    const candidate = planStaticRegistryRootRepair({ ...workspace, storedUrls })
    return candidate ? [candidate] : []
  })
  const coveredMissingRegistryUrls = new Set(rootRepairs.flatMap((candidate) => candidate.removedUrls))
  const uncoveredMissingRegistries = missingRegistries.filter(({ registryUrl }) => (
    !coveredMissingRegistryUrls.has(registryUrl)
  )).length
  const rootRepairCandidateDigest = rootRepairDigest(rootRepairs)
  const safeToRepairRoots = rootRepairs.length > 0 && uncoveredMissingRegistries === 0

  if (options.applyRootRepairs) {
    if (!safeToRepairRoots) {
      throw new Error('static registry root repair is not safe to apply')
    }
    if (options.expectedRootRepairDigest !== rootRepairCandidateDigest) {
      throw new Error(
        `static registry root repair digest mismatch: expected ${options.expectedRootRepairDigest ?? '(missing)'}, `
        + `actual ${rootRepairCandidateDigest}`,
      )
    }
    for (const candidate of rootRepairs) {
      await withRepo(repoFactory, async (repo) => {
        const handle = await findReadyDocument(repo, candidate.rootUrl)
        const currentUrls = (handle.doc() as { shardUrls?: unknown } | undefined)?.shardUrls
        if (!Array.isArray(currentUrls)
          || JSON.stringify(currentUrls) !== JSON.stringify([...candidate.retainedUrls, ...candidate.removedUrls])) {
          throw new Error(`static registry root changed after audit: ${candidate.rootUrl}`)
        }
        handle.change((value: unknown) => {
          const root = value as { shardUrls: string[]; diagramCount?: number }
          root.shardUrls = [...candidate.retainedUrls]
          if (candidate.source === 'performance-seed-editable') root.diagramCount = candidate.diagramCount
        })
        await repo.flush([handle.documentId as DocumentId])
      })
      const removedDocumentIds = candidate.removedUrls.map((url) => url.slice('automerge:'.length))
      await db.query(
        `DELETE FROM automerge_document_workspace mapping
         WHERE mapping.landscape_id = $1 AND mapping.version_id = $2
           AND mapping.document_id = ANY($3::text[])
           AND NOT EXISTS (
             SELECT 1 FROM automerge_storage storage
             WHERE split_part(storage.key, '/', 1) = mapping.document_id
           )`,
        [candidate.landscapeId, candidate.versionId, removedDocumentIds],
      )
    }
  }

  let references = 0
  const registrySummaries: Array<{
    registryUrl: AutomergeUrl
    landscapeId: string
    versionId: string
    index: number | null
    references: number
  }> = []
  const missing: MissingRegistryReference[] = []
  const availableRegistries = [...registryWorkspaces.entries()].filter(([registryUrl]) => (
    registryStateById.get(registryUrl.slice('automerge:'.length))?.stored === true
  ))
  const auditOffset = Math.max(0, Math.trunc(options.auditOffset ?? 0))
  const requestedLimit = Math.max(0, Math.trunc(options.auditLimit ?? availableRegistries.length))
  const registriesToAudit = availableRegistries.slice(auditOffset, auditOffset + requestedLimit)
  for (let offset = 0; offset < registriesToAudit.length; offset += 10) {
    const loaded = await withRepo(repoFactory, async (repo) => {
      const result: Array<{
        registryUrl: AutomergeUrl
        workspace: { landscapeId: string; versionId: string; index: number | null }
        entries: Array<{ diagramId: string; documentUrl: string; documentId: string }>
      }> = []
      for (const [registryUrl, workspace] of registriesToAudit.slice(offset, offset + 10)) {
        const handle = await findReadyDocument(repo, registryUrl)
        const entries = Object.entries(((handle.doc() ?? {}) as RegistryDocument).diagrams ?? {})
          .flatMap(([diagramId, diagram]) => diagram.docUrl?.startsWith('automerge:')
            ? [{ diagramId, documentUrl: diagram.docUrl, documentId: diagram.docUrl.slice('automerge:'.length) }]
            : [])
        result.push({ registryUrl, workspace, entries })
      }
      return result
    })
    for (const { registryUrl, workspace, entries } of loaded) {
      references += entries.length
      registrySummaries.push({ registryUrl, ...workspace, references: entries.length })
      if (entries.length === 0) continue
      const { rows: states } = await db.query<{
        document_id: string
        stored: boolean
        mapped: boolean
        projected: boolean
      }>(
        `WITH candidate(document_id) AS (SELECT unnest($1::text[]))
         SELECT candidate.document_id,
           EXISTS (SELECT 1 FROM automerge_storage storage
                   WHERE split_part(storage.key, '/', 1) = candidate.document_id) AS stored,
           EXISTS (SELECT 1 FROM automerge_document_workspace mapping
                   WHERE mapping.document_id = candidate.document_id) AS mapped,
           EXISTS (SELECT 1 FROM ro_diagrams diagram
                   WHERE replace(COALESCE(diagram.data->>'docUrl', ''), 'automerge:', '') = candidate.document_id) AS projected
         FROM candidate`,
        [entries.map(({ documentId }) => documentId)],
      )
      const stateById = new Map(states.map((state) => [state.document_id, state]))
      for (const entry of entries) {
        const state = stateById.get(entry.documentId)
        if (state?.stored) continue
        missing.push({
          ...workspace,
          registryUrl,
          diagramId: entry.diagramId,
          documentUrl: entry.documentUrl,
          ...classifyMissingRegistryReference({
            mapped: state?.mapped === true,
            projected: state?.projected === true,
          }),
        })
      }
    }
  }

  const audit = {
    offset: auditOffset,
    limit: requestedLimit,
    available: availableRegistries.length,
    audited: registriesToAudit.length,
    complete: auditOffset === 0 && registriesToAudit.length === availableRegistries.length,
  }

  const safeToApply = audit.complete
    && missingRegistries.length === 0
    && missing.every((entry) => entry.safeToRemove)
  if (!options.apply || !safeToApply || missing.length === 0) {
    return {
      reportOnly: !options.apply,
      safeToApply,
      registries: registryWorkspaces.size,
      references,
      missingRegistries,
      uncoveredMissingRegistries,
      rootRepairs,
      rootRepairCandidateDigest,
      rootRepairsApplied: options.applyRootRepairs ? rootRepairs.length : 0,
      safeToRepairRoots,
      registrySummaries,
      missing,
      removed: 0,
      audit,
    }
  }

  const removals = new Map<AutomergeUrl, string[]>()
  for (const entry of missing) {
    const diagramIds = removals.get(entry.registryUrl) ?? []
    diagramIds.push(entry.diagramId)
    removals.set(entry.registryUrl, diagramIds)
  }
  for (const [registryUrl, diagramIds] of removals) {
    await withRepo(repoFactory, async (repo) => {
      const handle = await findReadyDocument(repo, registryUrl)
      handle.change((value: unknown) => {
        const document = value as RegistryDocument
        for (const diagramId of diagramIds) delete document.diagrams?.[diagramId]
      })
      await repo.flush([handle.documentId as DocumentId])
    })
  }
  return {
    reportOnly: false,
    safeToApply,
    registries: registryWorkspaces.size,
    references,
    missingRegistries,
    uncoveredMissingRegistries,
    rootRepairs,
    rootRepairCandidateDigest,
    rootRepairsApplied: options.applyRootRepairs ? rootRepairs.length : 0,
    safeToRepairRoots,
    registrySummaries,
    missing,
    removed: missing.length,
    audit,
  }
}
