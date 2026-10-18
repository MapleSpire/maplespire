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
  type AutomergeUrl,
  type DocHandle,
  type QueryState,
  type Repo,
} from '@automerge/automerge-repo'
import type { WorkspaceKey } from './readModel/projector.js'
import { syncedHandle } from './automergeRepoCompat.js'

const CHANGE_HASH = /^[0-9a-f]{64}$/
export const MAX_DURABLE_DOCUMENTS = 64
// A frontier can legitimately contain one concurrent head per editor. Keep the
// gate above the 200-user target while still bounding request work and memory.
export const MAX_DURABLE_HEADS_PER_DOCUMENT = 512
// Ceiling on the local storage read only; a document that is still loading
// when it expires answers `durable:false`, which is always safe. The load goes
// on in the background and the client re-asks (`DURABLE_ACK_RETRY_MS`, 750 ms,
// in `src/lib/automerge/bridge.ts`), so this bounds request latency, not
// whether the document can ever be acknowledged.
const LOCAL_STORAGE_WAIT_MS = 2_000

/**
 * The document's handle once THIS PROCESS has looked everywhere it can look
 * without a peer — its cache and its own storage — or undefined when it holds
 * no data for it.
 *
 * `findReadyDocument` waits for any source, the network included, so for a
 * document whose only holder is a connected browser that has not sent it yet
 * it waited out its whole 10 s ceiling (measured 2026-10-18: +1.0 s → +11.1 s
 * on the first acknowledgement of a freshly seeded workspace). A document with
 * no data cannot carry the requested heads, so that wait could never turn the
 * answer into `true`; it only delayed `false`.
 *
 * `DocumentQuery` is `ready` exactly when its handle has non-empty heads, so
 * waiting is needed only while the query is `loading` AND the storage source
 * is still `pending`. The sync source is deliberately not waited on. A Repo
 * without storage has no `storage` source, so there is nothing to wait for.
 *
 * Like `repo.find`, `findWithProgress` creates the query when absent — this
 * does not resurrect anything `find` did not already resurrect here.
 */
async function findLocalDocument(
  repo: Repo,
  url: AutomergeUrl,
): Promise<DocHandle<unknown> | undefined> {
  const progress = repo.findWithProgress<unknown>(url)
  const settled = (state: QueryState<unknown>) =>
    state.state !== 'loading' || state.sources.storage !== 'pending'
  let state = progress.peek()
  if (!settled(state)) {
    state = await new Promise<QueryState<unknown>>((resolve) => {
      const finish = (next: QueryState<unknown>) => {
        clearTimeout(timer)
        unsubscribe()
        resolve(next)
      }
      const timer = setTimeout(() => finish(progress.peek()), LOCAL_STORAGE_WAIT_MS)
      const unsubscribe = progress.subscribe((next) => { if (settled(next)) finish(next) })
    })
  }
  if (state.state !== 'ready') return undefined
  // `DocHandle.state` is `ready` or `deleted`; a deleted handle can still sit
  // in a ready query when `DocHandle.delete()` is called on its own.
  return state.handle.state === 'ready' ? state.handle : undefined
}

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
  const satisfied = new Map<string, DocHandle<unknown>>()

  await Promise.all(requested.map(async ({ documentId, heads }) => {
    if (!permitted.has(documentId)) return
    const url = `automerge:${documentId}`
    if (!isValidAutomergeUrl(url)) return
    try {
      const handle = await findLocalDocument(repo, url)
      const doc = handle?.doc()
      if (handle && doc && hasHeads(doc, heads as Heads)) satisfied.set(documentId, handle)
    } catch {
      // A document can be registered before its newest changes reach this Repo.
      // The client retries; never acknowledge an incomplete document.
    }
  }))

  const documentIds = [...satisfied.values()].map(({ documentId }) => documentId)
  if (documentIds.length > 0) await repo.flush(documentIds)

  // `Repo.flush` SKIPS, silently, any id whose query is no longer cached
  // (automerge-repo 2.6, `Repo.flush`). The heads check above and the
  // flush are separated by every other document's wait, and idle eviction or a
  // freshness drop can `removeFromCache` in between without saving. Measured
  // 2026-10-18 on the pre-fix code: an id evicted 20 ms
  // into the request answered `durable:true` while a cold Repo on the same
  // storage found no document at all. So acknowledge only a handle still cached
  // AFTER the flush: a re-created query carries a NEW handle, so identity proves
  // this one was never removed and the flush saw it. `syncedHandle` errs only
  // towards `false` (see its docblock), which the client retries.
  return requested.map(({ documentId }) => {
    const handle = satisfied.get(documentId)
    return {
      documentId,
      durable: handle !== undefined && syncedHandle(repo, documentId) === handle,
    }
  })
}
