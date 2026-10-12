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

import type { Queryable } from './backupRestore.js'

/**
 * Workspaces whose root document is known-unrecoverable, and the record of who
 * decided that.
 *
 * The cold-load gate is the part of the backup drill that has teeth: it opens
 * the restored documents and compares heads, so a dump that restores a
 * structurally intact but unopenable workspace fails. That is the intent — but
 * it also means ONE pre-existing broken draft blocks every future backup, and
 * the pressure at that point is to weaken the gate for everybody.
 *
 * A retirement is the narrow alternative. It names one workspace, carries a
 * reason and an operator, lives in the dump (so it is itself backed up,
 * restored and fingerprinted), and is reported in the manifest of every
 * subsequent backup. Repair first; retire when repair is genuinely impossible;
 * never lower the gate.
 */

export type RetiredWorkspace = {
  landscapeId: string
  versionId: string
  rootUrl: string
  reason: string
  retiredBy: string
  retiredAt: string
}

export async function listRetiredWorkspaces(db: Queryable): Promise<RetiredWorkspace[]> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.backup_retired_workspaces') IS NOT NULL AS present`,
  )
  if (rows[0]?.present !== true) return []
  const { rows: retired } = await db.query<{
    landscape_id: string
    version_id: string
    root_url: string
    reason: string
    retired_by: string
    retired_at: Date | string
  }>(
    `SELECT landscape_id, version_id, root_url, reason, retired_by, retired_at
     FROM backup_retired_workspaces
     ORDER BY landscape_id, version_id`,
  )
  return retired.map((row) => ({
    landscapeId: row.landscape_id,
    versionId: row.version_id,
    rootUrl: row.root_url,
    reason: row.reason,
    retiredBy: row.retired_by,
    retiredAt: new Date(row.retired_at).toISOString(),
  }))
}

export async function retireWorkspace(
  db: Queryable,
  input: { landscapeId: string; versionId: string; reason: string; retiredBy: string },
): Promise<RetiredWorkspace> {
  if (input.reason.trim().length === 0) throw new Error('A retirement reason is required')
  if (input.retiredBy.trim().length === 0) throw new Error('A retiring operator is required')
  // The root URL is read from `versions` rather than accepted from the caller:
  // a retirement that names a URL the workspace does not actually have would
  // exempt the workspace while pointing the reviewer at the wrong document.
  const { rows } = await db.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
    [input.landscapeId, input.versionId],
  )
  const rootUrl = rows[0]?.root_url
  if (!rootUrl) {
    throw new Error(`No such workspace: ${input.landscapeId}/${input.versionId}`)
  }
  const { rows: stored } = await db.query<{ retired_at: Date | string }>(
    `INSERT INTO backup_retired_workspaces
       (landscape_id, version_id, root_url, reason, retired_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (landscape_id, version_id) DO UPDATE
       SET root_url = EXCLUDED.root_url,
           reason = EXCLUDED.reason,
           retired_by = EXCLUDED.retired_by,
           retired_at = now()
     RETURNING retired_at`,
    [input.landscapeId, input.versionId, rootUrl, input.reason.trim(), input.retiredBy.trim()],
  )
  return {
    landscapeId: input.landscapeId,
    versionId: input.versionId,
    rootUrl,
    reason: input.reason.trim(),
    retiredBy: input.retiredBy.trim(),
    retiredAt: new Date(stored[0]!.retired_at).toISOString(),
  }
}

export type RetiredDocument = {
  documentId: string
  reason: string
  retiredBy: string
  retiredAt: string
}

export async function listRetiredDocuments(db: Queryable): Promise<RetiredDocument[]> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.backup_retired_documents') IS NOT NULL AS present`,
  )
  if (rows[0]?.present !== true) return []
  const { rows: retired } = await db.query<{
    document_id: string
    reason: string
    retired_by: string
    retired_at: Date | string
  }>(
    `SELECT document_id, reason, retired_by, retired_at
     FROM backup_retired_documents ORDER BY document_id`,
  )
  return retired.map((row) => ({
    documentId: row.document_id,
    reason: row.reason,
    retiredBy: row.retired_by,
    retiredAt: new Date(row.retired_at).toISOString(),
  }))
}

/**
 * Retire ONE document — a diagram whose chunks never completed, typically.
 *
 * Narrower than retiring its workspace on purpose: the workspace's root and
 * registry stay under the gate, so the next real breakage in that landscape
 * still fails the drill.
 */
export async function retireDocument(
  db: Queryable,
  input: { documentId: string; reason: string; retiredBy: string },
): Promise<RetiredDocument> {
  const documentId = input.documentId.replace(/^automerge:/, '').trim()
  // The candidate queries compare against the bare id stored in
  // `automerge_document_workspace`; accepting a URL here and storing it would
  // produce a retirement that silently matches nothing.
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(documentId)) {
    throw new Error('A document id must be the base58 id, with or without the automerge: prefix')
  }
  if (input.reason.trim().length === 0) throw new Error('A retirement reason is required')
  if (input.retiredBy.trim().length === 0) throw new Error('A retiring operator is required')
  const { rows } = await db.query<{ retired_at: Date | string }>(
    `INSERT INTO backup_retired_documents (document_id, reason, retired_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_id) DO UPDATE
       SET reason = EXCLUDED.reason,
           retired_by = EXCLUDED.retired_by,
           retired_at = now()
     RETURNING retired_at`,
    [documentId, input.reason.trim(), input.retiredBy.trim()],
  )
  return {
    documentId,
    reason: input.reason.trim(),
    retiredBy: input.retiredBy.trim(),
    retiredAt: new Date(rows[0]!.retired_at).toISOString(),
  }
}

export async function reinstateDocument(db: Queryable, documentId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM backup_retired_documents WHERE document_id = $1',
    [documentId.replace(/^automerge:/, '').trim()],
  )
  return (rowCount ?? 0) > 0
}

/** Undo a retirement — after a repair, so the gate covers the workspace again. */
export async function reinstateWorkspace(
  db: Queryable,
  input: { landscapeId: string; versionId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM backup_retired_workspaces WHERE landscape_id = $1 AND version_id = $2',
    [input.landscapeId, input.versionId],
  )
  return (rowCount ?? 0) > 0
}
