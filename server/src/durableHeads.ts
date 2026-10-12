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

import { hasHeads, type Heads } from '@automerge/automerge'
import {
  isValidAutomergeUrl,
  type DocumentId,
  type Repo,
} from '@automerge/automerge-repo'
import type { WorkspaceKey } from './readModel/projector.js'
import { findReadyDocument } from './automergeRepoCompat.js'

const CHANGE_HASH = /^[0-9a-f]{64}$/
export const MAX_DURABLE_DOCUMENTS = 64
// A frontier can legitimately contain one concurrent head per editor. Keep the
// gate above the 200-user target while still bounding request work and memory.
export const MAX_DURABLE_HEADS_PER_DOCUMENT = 512

interface Queryable {
  query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }>
}

export interface DurableHeadRequest {
  documentId: string
  heads: string[]
}

export interface DurableHeadResult {
  documentId: string
  durable: boolean
}

export function parseDurableHeadRequests(value: unknown): DurableHeadRequest[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DURABLE_DOCUMENTS) return null
  const seen = new Set<string>()
  const parsed: DurableHeadRequest[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const { documentId, heads } = item as Partial<DurableHeadRequest>
    if (
      typeof documentId !== 'string'
      || seen.has(documentId)
      || !isValidAutomergeUrl(`automerge:${documentId}`)
      || !Array.isArray(heads)
      || heads.length === 0
      || heads.length > MAX_DURABLE_HEADS_PER_DOCUMENT
      || !heads.every((head) => typeof head === 'string' && CHANGE_HASH.test(head))
    ) return null
    seen.add(documentId)
    parsed.push({ documentId, heads: [...heads] })
  }
  return parsed
}

/**
 * Confirm that a set of client-observed Automerge heads has reached this
 * workspace's owning Repo and that Repo.flush() has durably committed those
 * exact documents through the PostgreSQL storage adapter.
 *
 * Document ids are never trusted from the client: the workspace manifest is
 * checked first. Unmapped or cross-workspace ids receive `durable:false` and
 * are never opened in the Repo.
 */
export async function acknowledgeDurableHeads(
  repo: Repo,
  db: Queryable,
  workspace: WorkspaceKey,
  requested: DurableHeadRequest[],
): Promise<DurableHeadResult[]> {
  const requestedIds = requested.map(({ documentId }) => documentId)
  const { rows } = await db.query<{ document_id: string }>(
    `SELECT document_id
     FROM automerge_document_workspace
     WHERE landscape_id = $1
       AND version_id = $2
       AND document_id = ANY($3::text[])`,
    [workspace.landscapeId, workspace.versionId, requestedIds],
  )
  const permitted = new Set(rows.map(({ document_id }) => document_id))
  const satisfied = new Map<string, DocumentId>()

  await Promise.all(requested.map(async ({ documentId, heads }) => {
    if (!permitted.has(documentId)) return
    const url = `automerge:${documentId}`
    if (!isValidAutomergeUrl(url)) return
    try {
      const handle = await findReadyDocument(repo, url)
      const doc = handle.doc()
      if (doc && hasHeads(doc, heads as Heads)) satisfied.set(documentId, handle.documentId)
    } catch {
      // A document can be registered before its newest changes reach this Repo.
      // The client retries; never acknowledge an incomplete document.
    }
  }))

  const documentIds = [...satisfied.values()]
  if (documentIds.length > 0) await repo.flush(documentIds)

  return requested.map(({ documentId }) => ({
    documentId,
    durable: satisfied.has(documentId),
  }))
}
