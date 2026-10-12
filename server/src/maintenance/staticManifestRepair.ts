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

import type { Queryable } from '../readModel/types.js'

export interface StaticManifestWorkspaceAudit {
  landscapeId: string
  versionId: string
  source: string
  mappedDocuments: number
  storedMappedDocuments: number
  staticDocuments: number
  missingStaticDocuments: number
  backfillableDocuments: number
  unavailableMappedDocuments: number
  staticDocumentsWithoutMapping: number
  diagrams: number
  mappedDiagrams: number
  storedDiagrams: number
  modelMetaDocuments: number
  storedModelMetaDocuments: number
  rootMapped: boolean
  rootStored: boolean
  issues: string[]
  warnings: string[]
}

export interface StaticManifestRepairResult {
  reportOnly: boolean
  safeToApply: boolean
  workspaces: StaticManifestWorkspaceAudit[]
  proposedBackfill: number
  backfilled: number
}

type AuditRow = {
  landscape_id: string
  version_id: string
  source: string
  mapped_documents: string | number
  stored_mapped_documents: string | number
  static_documents: string | number
  missing_static_documents: string | number
  backfillable_documents: string | number
  unavailable_mapped_documents: string | number
  static_documents_without_mapping: string | number
  diagrams: string | number
  mapped_diagrams: string | number
  stored_diagrams: string | number
  model_meta_documents: string | number
  stored_model_meta_documents: string | number
  root_mapped: boolean
  root_stored: boolean
}

const numberOf = (value: string | number): number => Number(value)

export function assessStaticManifestWorkspace(row: AuditRow): StaticManifestWorkspaceAudit {
  const audit: StaticManifestWorkspaceAudit = {
    landscapeId: row.landscape_id,
    versionId: row.version_id,
    source: row.source,
    mappedDocuments: numberOf(row.mapped_documents),
    storedMappedDocuments: numberOf(row.stored_mapped_documents),
    staticDocuments: numberOf(row.static_documents),
    missingStaticDocuments: numberOf(row.missing_static_documents),
    backfillableDocuments: numberOf(row.backfillable_documents),
    unavailableMappedDocuments: numberOf(row.unavailable_mapped_documents),
    staticDocumentsWithoutMapping: numberOf(row.static_documents_without_mapping),
    diagrams: numberOf(row.diagrams),
    mappedDiagrams: numberOf(row.mapped_diagrams),
    storedDiagrams: numberOf(row.stored_diagrams),
    modelMetaDocuments: numberOf(row.model_meta_documents),
    storedModelMetaDocuments: numberOf(row.stored_model_meta_documents),
    rootMapped: row.root_mapped === true,
    rootStored: row.root_stored === true,
    issues: [],
    warnings: [],
  }
  if (audit.mappedDocuments === 0) audit.issues.push('empty-workspace-mapping')
  if (audit.unavailableMappedDocuments > 0) {
    audit.warnings.push(`declared-static-base-unavailable:${audit.unavailableMappedDocuments}`)
  }
  if (audit.staticDocumentsWithoutMapping > 0) audit.issues.push('static-document-without-workspace-mapping')
  if (!audit.rootMapped) audit.issues.push('root-not-mapped')
  if (!audit.rootStored) audit.issues.push('root-missing-storage')
  if (audit.modelMetaDocuments !== 1) audit.issues.push('model-meta-cardinality')
  if (audit.storedModelMetaDocuments !== 1) audit.issues.push('model-meta-missing-storage')
  if (audit.diagrams === 0) audit.issues.push('empty-diagram-baseline')
  if (audit.mappedDiagrams !== audit.diagrams) audit.issues.push('diagram-document-not-mapped')
  if (audit.storedDiagrams !== audit.diagrams) audit.issues.push('diagram-document-missing-storage')
  return audit
}

async function auditRows(db: Queryable): Promise<StaticManifestWorkspaceAudit[]> {
  const { rows } = await db.query<AuditRow>(
    `SELECT workspace.landscape_id, workspace.version_id, workspace.source,
       (SELECT count(*) FROM automerge_document_workspace mapping
        WHERE mapping.landscape_id = workspace.landscape_id
          AND mapping.version_id = workspace.version_id) AS mapped_documents,
       (SELECT count(*) FROM automerge_document_workspace mapping
        WHERE mapping.landscape_id = workspace.landscape_id
          AND mapping.version_id = workspace.version_id
          AND EXISTS (
            SELECT 1 FROM automerge_storage storage
            WHERE split_part(storage.key, '/', 1) = mapping.document_id
          )) AS stored_mapped_documents,
       (SELECT count(*) FROM read_model_static_documents document
        WHERE document.landscape_id = workspace.landscape_id
          AND document.version_id = workspace.version_id) AS static_documents,
       (SELECT count(*) FROM automerge_document_workspace mapping
        WHERE mapping.landscape_id = workspace.landscape_id
          AND mapping.version_id = workspace.version_id
          AND NOT EXISTS (
            SELECT 1 FROM read_model_static_documents document
            WHERE document.landscape_id = mapping.landscape_id
              AND document.version_id = mapping.version_id
              AND document.document_id = mapping.document_id
          )) AS missing_static_documents,
       (SELECT count(*) FROM automerge_document_workspace mapping
        WHERE mapping.landscape_id = workspace.landscape_id
          AND mapping.version_id = workspace.version_id
          AND EXISTS (
            SELECT 1 FROM automerge_storage storage
            WHERE split_part(storage.key, '/', 1) = mapping.document_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM read_model_static_documents document
            WHERE document.landscape_id = mapping.landscape_id
              AND document.version_id = mapping.version_id
              AND document.document_id = mapping.document_id
          )) AS backfillable_documents,
       (SELECT count(*) FROM automerge_document_workspace mapping
        WHERE mapping.landscape_id = workspace.landscape_id
          AND mapping.version_id = workspace.version_id
          AND NOT EXISTS (
            SELECT 1 FROM automerge_storage storage
            WHERE split_part(storage.key, '/', 1) = mapping.document_id
          )) AS unavailable_mapped_documents,
       (SELECT count(*) FROM read_model_static_documents document
        WHERE document.landscape_id = workspace.landscape_id
          AND document.version_id = workspace.version_id
          AND NOT EXISTS (
            SELECT 1 FROM automerge_document_workspace mapping
            WHERE mapping.document_id = document.document_id
              AND mapping.landscape_id = document.landscape_id
              AND mapping.version_id = document.version_id
          )) AS static_documents_without_mapping,
       (SELECT count(*) FROM ro_diagrams diagram
        WHERE diagram.landscape_id = workspace.landscape_id
          AND diagram.version_id = workspace.version_id) AS diagrams,
       (SELECT count(*) FROM ro_diagrams diagram
        WHERE diagram.landscape_id = workspace.landscape_id
          AND diagram.version_id = workspace.version_id
          AND EXISTS (
            SELECT 1 FROM automerge_document_workspace mapping
            WHERE mapping.landscape_id = diagram.landscape_id
              AND mapping.version_id = diagram.version_id
              AND mapping.document_id = replace(COALESCE(diagram.data->>'docUrl', ''), 'automerge:', '')
          )) AS mapped_diagrams,
       (SELECT count(*) FROM ro_diagrams diagram
        WHERE diagram.landscape_id = workspace.landscape_id
          AND diagram.version_id = workspace.version_id
          AND EXISTS (
            SELECT 1 FROM automerge_storage storage
            WHERE split_part(storage.key, '/', 1) = replace(COALESCE(diagram.data->>'docUrl', ''), 'automerge:', '')
          )) AS stored_diagrams,
       (SELECT count(*) FROM read_model_static_documents document
        WHERE document.landscape_id = workspace.landscape_id
          AND document.version_id = workspace.version_id
          AND document.kind = 'model-meta') AS model_meta_documents,
       (SELECT count(*) FROM read_model_static_documents document
        WHERE document.landscape_id = workspace.landscape_id
          AND document.version_id = workspace.version_id
          AND document.kind = 'model-meta'
          AND EXISTS (
            SELECT 1 FROM automerge_storage storage
            WHERE split_part(storage.key, '/', 1) = document.document_id
          )) AS stored_model_meta_documents,
       EXISTS (
         SELECT 1 FROM versions version
         JOIN automerge_document_workspace mapping
           ON mapping.landscape_id = version.landscape_id
          AND mapping.version_id = version.id
          AND mapping.document_id = replace(version.root_url, 'automerge:', '')
         WHERE version.landscape_id = workspace.landscape_id
           AND version.id = workspace.version_id
       ) AS root_mapped,
       EXISTS (
         SELECT 1 FROM versions version
         JOIN automerge_storage storage
           ON split_part(storage.key, '/', 1) = replace(version.root_url, 'automerge:', '')
         WHERE version.landscape_id = workspace.landscape_id
           AND version.id = workspace.version_id
       ) AS root_stored
     FROM read_model_static_workspaces workspace
     WHERE workspace.source = 'performance-seed-editable'
     ORDER BY workspace.landscape_id, workspace.version_id`,
  )
  return rows.map(assessStaticManifestWorkspace)
}

export async function repairPerformanceStaticManifests(
  db: Queryable,
  options: { apply?: boolean } = {},
): Promise<StaticManifestRepairResult> {
  const workspaces = await auditRows(db)
  const proposedBackfill = workspaces.reduce((sum, workspace) => sum + workspace.backfillableDocuments, 0)
  const safeToApply = workspaces.length > 0 && workspaces.every((workspace) => workspace.issues.length === 0)
  if (!options.apply || !safeToApply || proposedBackfill === 0) {
    return { reportOnly: !options.apply, safeToApply, workspaces, proposedBackfill, backfilled: 0 }
  }

  let backfilled = 0
  for (const workspace of workspaces) {
    const result = await db.query(
      `INSERT INTO read_model_static_documents (
         landscape_id, version_id, document_id, kind, entity_id
       )
       SELECT mapping.landscape_id, mapping.version_id, mapping.document_id,
              CASE WHEN diagram.id IS NOT NULL THEN 'diagram'
                   ELSE 'retained-static-base' END,
              diagram.id
       FROM automerge_document_workspace mapping
       LEFT JOIN ro_diagrams diagram
         ON diagram.landscape_id = mapping.landscape_id
        AND diagram.version_id = mapping.version_id
        AND replace(COALESCE(diagram.data->>'docUrl', ''), 'automerge:', '') = mapping.document_id
       WHERE mapping.landscape_id = $1 AND mapping.version_id = $2
         AND EXISTS (
           SELECT 1 FROM automerge_storage storage
           WHERE split_part(storage.key, '/', 1) = mapping.document_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM read_model_static_documents existing
           WHERE existing.landscape_id = mapping.landscape_id
             AND existing.version_id = mapping.version_id
             AND existing.document_id = mapping.document_id
         )
       ON CONFLICT DO NOTHING`,
      [workspace.landscapeId, workspace.versionId],
    )
    backfilled += result.rowCount ?? 0
  }
  return { reportOnly: false, safeToApply, workspaces, proposedBackfill, backfilled }
}
