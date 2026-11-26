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

import { getChangesMetaSince, type Doc, type Heads } from '@automerge/automerge'
import { holdsHeads } from './automergeHeads.js'
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type QueryState,
  type Repo,
} from '@automerge/automerge-repo'
import type { WorkspaceKey } from './readModel/projector.js'
import { requestLateRetiringRevival } from './readModel/modelEpochRetire.js'
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
  /** Superseded epoch documents only: the forward cursor covers the heads. */
  forwarded?: boolean
  /** Superseded epoch documents only: retired, swept. */
  epochRetired?: true
  /** A live superseded source durable past its forward cursor: a forward
   * pass is owed (the route triggers one). Also a
   * `retiring`/`pinned` one written past its cursor: the pass revives it
   * first. */
  forwardPending?: true
  /** With `forwardPending`, a latch asked now could not get its pass at
   * once (`ForwardTrigger.latchReady`): a draining tab waits before it
   * blocks input. Set by the route, never here. */
  forwardBusy?: true
  /** Forwarded sources only: the current epoch's documents and the heads the
   * server holds for them — what a hopping tab waits to hold before it swaps. */
  targetHeads?: DurableHeadRequest[]
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
  const startedAt = Date.now()
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
      if (handle && doc && holdsHeads(doc as Doc<unknown>, heads)) satisfied.set(documentId, handle)
    } catch {
      // A document can be registered before its newest changes reach this Repo.
      // The client retries; never acknowledge an incomplete document.
    }
  }))

  const documentIds = [...satisfied.values()].map(({ documentId }) => documentId)
  const flushStartedAt = Date.now()
  if (documentIds.length > 0) await repo.flush(documentIds)
  const statesStartedAt = Date.now()

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
  const epochs = await epochDocumentStates(db, workspace, requestedIds)
  const revive: string[] = []
  const results = requested.map(({ documentId, heads }): DurableHeadResult => {
    const handle = satisfied.get(documentId)
    const durable = handle !== undefined && syncedHandle(repo, documentId) === handle
    const epoch = epochs.get(documentId)
    // Not an epoch source: the answer is unchanged, and an absent `forwarded`
    // means "nothing to forward" to the client.
    if (!epoch) return { documentId, durable }
    if (epoch.state === 'retired') return { documentId, durable: false, forwarded: false, epochRetired: true }
    const forwarded = durable && headsForwarded(handle!.doc() as Doc<unknown>, heads, epoch)
    // A LIVE source whose durable heads the cursor does not cover yet: the
    // route asks the forwarder for a pass (`modelEpochForwardTrigger.ts`).
    if (!forwarded && durable && epoch.state === 'live') return { documentId, durable, forwarded: false, forwardPending: true }
    // A `retiring`/`pinned` document
    // written past its cursor after the retirement walk's quiet check — the
    // walk's step 4 (back to `live`) done for it now, by the pass this answer
    // triggers (`reviveRequestedRetiring`), instead of at the next periodic
    // walk: until then nothing forwarded it, and a hopping tab waited for
    // ever in backoff. Only PAST the cursor: one whose
    // cursor covers the heads is `forwarded: true` above, never revived.
    if (!forwarded && durable && (epoch.state === 'retiring' || epoch.state === 'pinned')) {
      revive.push(documentId)
      return { documentId, durable, forwarded: false, forwardPending: true }
    }
    return { documentId, durable, forwarded }
  })
  // A mark the owner's pass consumes under its fence.
  // A failure to mark is no failure of the answer: the walk's step 4 still
  // revives it later.
  await requestLateRetiringRevival(db, workspace, revive).catch((error) => {
    console.warn('durable-heads: the revival of a late-written retiring document could not be requested', error)
  })
  // A tab may swap only once ITS copies of the
  // current epoch's documents carry what the forward wrote there. A
  // forwarded source answers WHAT THE FORWARDS WROTE: per target document of
  // the current epoch, the hash of its latest forward change (not the
  // current heads of the first 64 epoch documents: on a large
  // workspace a target past the 64th was never named and the tab swapped
  // without it; and a target's current heads move with every edit).
  // A RETIRED answer too — the tab swaps on that
  // path as well, and the batch's live sources' forwards are what it needs.
  const targetsStartedAt = Date.now()
  if (results.some((r) => r.forwarded === true || r.epochRetired === true)) {
    const targetHeads = await currentEpochForwardTargets(db, workspace)
    for (const r of results) if (r.forwarded === true || r.epochRetired === true) r.targetHeads = targetHeads
  }
  lastAcknowledgementTiming = { findMs: flushStartedAt - startedAt, flushMs: statesStartedAt - flushStartedAt,
    statesMs: targetsStartedAt - statesStartedAt, targetsMs: Date.now() - targetsStartedAt }
  return results
}

/** The stages of the last acknowledgement, for the route's trace
 * (MODEL_EPOCH_TRACE_FILE). Diagnostics only. */
export let lastAcknowledgementTiming: { findMs: number; flushMs: number; statesMs: number; targetsMs: number } | null = null

/** At most this many forward hashes per target in one answer
 * (the most recent ones). */
export const FORWARD_TARGET_HASHES_MAX = 32

/**
 * Per document of the CURRENT epoch that a forward wrote to, the hashes of
 * EVERY such change since that epoch was published: a
 * quarantine discard records a change long after it was made, so "the
 * latest by `written_at`" is not "the latest causally"; holding them all is
 * true whatever order they were recorded in. Capped per target at
 * {@link FORWARD_TARGET_HASHES_MAX}, the most recent kept.
 *
 * THE TARGETS: every target except those KNOWN not to be the
 * current epoch's — a superseded epoch document. The overlay write head and
 * its segments carry over from epoch to epoch and have no epoch row: a
 * join that required one dropped exactly the forwards an entity recently
 * edited (served from the overlay) receives.
 *
 * BOUNDED: only writes since the PREDECESSOR epoch's
 * publication (a document CARRIED from one
 * epoch to the next — the overlay head, its segments — receives forwards
 * during the predecessor's life too; bounded by the current epoch's
 * publication, a forward into the head written just before a roll the tab
 * had not hopped through yet was no longer named, and the tab swapped
 * without it). The hot route reads at most two epochs' rows on the
 * `(landscape_id, version_id, written_at)` index, not the workspace's whole
 * history; the periodic sweep purges what no reader needs any more
 * (`purgeForwardWrites`, the same bound). A legacy (first) epoch: its own
 * publication. No workspace with a published epoch: nothing.
 */
export async function currentEpochForwardTargets(db: Queryable, workspace: WorkspaceKey): Promise<DurableHeadRequest[]> {
  try {
    const { rows } = await db.query<{ target_document_id: string; hashes: string[] }>(
      `SELECT w.target_document_id,
              (array_agg(w.change_hash ORDER BY w.written_at DESC, w.change_hash))[1:$3] AS hashes
         FROM read_model_model_epochs e
         LEFT JOIN read_model_model_epochs p
           ON p.landscape_id = e.landscape_id AND p.version_id = e.version_id AND p.epoch_no = e.predecessor_epoch
         JOIN read_model_model_epoch_forward_writes w
           ON w.landscape_id = e.landscape_id AND w.version_id = e.version_id
          AND w.written_at >= coalesce(p.published_at, e.published_at)
         LEFT JOIN read_model_model_epoch_docs d ON d.document_id = w.target_document_id
        WHERE e.landscape_id = $1 AND e.version_id = $2 AND e.state = 'published'
          AND (d.document_id IS NULL OR d.superseded_epoch IS NULL)
        GROUP BY w.target_document_id
        ORDER BY w.target_document_id`,
      [workspace.landscapeId, workspace.versionId, FORWARD_TARGET_HASHES_MAX])
    return rows.map((r) => ({ documentId: r.target_document_id, heads: [...r.hashes].sort() }))
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error
    return []
  }
}

/**
 * G4-16f, the server half of the epoch hop's wait: the `forwarded`
 * bit. A tab hopping to a new epoch waits for `durable && forwarded` on the
 * heads of the OLD documents it holds. For a superseded epoch document still
 * forwarded (`live`), forwarded means its forward cursor covers those heads —
 * every requested head is in the cursor's causal past; a `pinned` or
 * `retiring` document is no longer a source, so nothing will ever forward
 * it: false. For a `retired` one the answer is `epochRetired`, and the
 * tab takes the export path. Any other document has nothing to forward: true.
 */
interface EpochDocState { state: string; superseded: boolean; cursor: string[] | null }

async function epochDocumentStates(db: Queryable, workspace: WorkspaceKey, ids: string[]): Promise<Map<string, EpochDocState>> {
  const out = new Map<string, EpochDocState>()
  try {
    const { rows } = await db.query<{ document_id: string; state: string; superseded_epoch: number | null; forward_cursor: string[] | null }>(
      `SELECT document_id, state, superseded_epoch, forward_cursor FROM read_model_model_epoch_docs
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[]) AND superseded_epoch IS NOT NULL`,
      [workspace.landscapeId, workspace.versionId, ids])
    for (const r of rows) if (typeof r.state === 'string') out.set(r.document_id, { state: r.state, superseded: r.superseded_epoch !== null, cursor: r.forward_cursor })
  } catch (error) {
    // No epoch table (a database whose read-model schema predates epochs):
    // nothing is an epoch document.
    if ((error as { code?: string }).code !== '42P01') throw error
  }
  return out
}

function headsForwarded(doc: Doc<unknown>, heads: string[], epoch: EpochDocState): boolean {
  // Any state but `retired` (the
  // caller answers it first) — a `retiring`/`pinned` document whose cursor
  // covers the heads asked about has nothing left to forward.
  if (!epoch.cursor || !holdsHeads(doc, epoch.cursor)) return false
  const beyond = new Set(getChangesMetaSince(doc, epoch.cursor as Heads).map((m) => m.hash))
  return heads.every((h) => !beyond.has(h))
}
