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
import type { Queryable } from '../readModel/types.js'
import { findReadyDocument } from '../automergeRepoCompat.js'

type RegistryDocument = { diagrams?: Record<string, { docUrl?: string }> }

export interface MissingRegistryReference {
  landscapeId: string
  versionId: string
  registryUrl: AutomergeUrl
  diagramId: string
  documentUrl: string
  mapped: boolean
  projected: boolean
  safeToRemove: boolean
}

export interface RegistryReferenceRepairResult {
  reportOnly: boolean
  safeToApply: boolean
  registries: number
  references: number
  missing: MissingRegistryReference[]
  removed: number
}

export function classifyMissingRegistryReference(input: {
  mapped: boolean
  projected: boolean
}): Pick<MissingRegistryReference, 'mapped' | 'projected' | 'safeToRemove'> {
  return { ...input, safeToRemove: !input.mapped && !input.projected }
}

export async function repairMissingRegistryReferences(
  db: Queryable,
  repo: Repo,
  options: { apply?: boolean } = {},
): Promise<RegistryReferenceRepairResult> {
  const { rows: versions } = await db.query<{
    landscape_id: string
    id: string
    root_url: AutomergeUrl
  }>(
    `SELECT version.landscape_id, version.id, version.root_url
     FROM versions version
     WHERE NOT EXISTS (
       SELECT 1 FROM read_model_static_workspaces workspace
       WHERE workspace.landscape_id = version.landscape_id
         AND workspace.version_id = version.id
     )
     ORDER BY version.landscape_id, version.id`,
  )
  const registries = new Map<AutomergeUrl, {
    landscapeId: string
    versionId: string
    handle: Awaited<ReturnType<Repo['find']>>
    document: RegistryDocument
  }>()
  let references = 0
  for (const version of versions) {
    const root = await findReadyDocument(repo, version.root_url)
    const shardUrls = Array.isArray((root.doc() as { shardUrls?: unknown } | undefined)?.shardUrls)
      ? ((root.doc() as { shardUrls: unknown[] }).shardUrls)
        .filter((url): url is AutomergeUrl => typeof url === 'string' && url.startsWith('automerge:'))
      : []
    for (const registryUrl of shardUrls) {
      const handle = await findReadyDocument(repo, registryUrl)
      const document = (handle.doc() ?? {}) as RegistryDocument
      references += Object.keys(document.diagrams ?? {}).length
      registries.set(registryUrl, {
        landscapeId: version.landscape_id,
        versionId: version.id,
        handle,
        document,
      })
    }
  }

  const candidates = [...registries.entries()].flatMap(([registryUrl, registry]) => (
    Object.entries(registry.document.diagrams ?? {}).flatMap(([diagramId, diagram]) => (
      diagram.docUrl?.startsWith('automerge:')
        ? [{
            landscapeId: registry.landscapeId,
            versionId: registry.versionId,
            registryUrl,
            diagramId,
            documentUrl: diagram.docUrl,
            documentId: diagram.docUrl.slice('automerge:'.length),
          }]
        : []
    ))
  ))
  const ids = [...new Set(candidates.map(({ documentId }) => documentId))]
  const { rows: states } = ids.length > 0
    ? await db.query<{
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
        [ids],
      )
    : { rows: [] }
  const stateById = new Map(states.map((state) => [state.document_id, state]))
  const missing: MissingRegistryReference[] = candidates.flatMap((candidate) => {
    const state = stateById.get(candidate.documentId)
    if (state?.stored) return []
    const classification = classifyMissingRegistryReference({
      mapped: state?.mapped === true,
      projected: state?.projected === true,
    })
    return [{ ...candidate, ...classification }]
  })
  const safeToApply = missing.every((entry) => entry.safeToRemove)
  if (!options.apply || !safeToApply || missing.length === 0) {
    return {
      reportOnly: !options.apply,
      safeToApply,
      registries: registries.size,
      references,
      missing,
      removed: 0,
    }
  }

  const removals = new Map<AutomergeUrl, string[]>()
  for (const entry of missing) {
    const idsForRegistry = removals.get(entry.registryUrl) ?? []
    idsForRegistry.push(entry.diagramId)
    removals.set(entry.registryUrl, idsForRegistry)
  }
  for (const [registryUrl, diagramIds] of removals) {
    const registry = registries.get(registryUrl)
    if (!registry) throw new Error('validated registry repair lost its handle')
    registry.handle.change((value: unknown) => {
      const document = value as RegistryDocument
      for (const diagramId of diagramIds) delete document.diagrams?.[diagramId]
    })
    await repo.flush([registry.handle.documentId as DocumentId])
  }
  return {
    reportOnly: false,
    safeToApply,
    registries: registries.size,
    references,
    missing,
    removed: missing.length,
  }
}
