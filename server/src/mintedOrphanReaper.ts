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

import type { Pool } from 'pg'
import type { Repo } from '@automerge/automerge-repo'
import { assertMaintenanceFence, type MaintenanceFence } from './maintenance/coordinator.js'
import { cachedHandles } from './automergeRepoCompat.js'
import { isDocumentStorageKey } from './automergeStorage.js'
import { envNumber } from './envNumber.js'
import { hasMintKey, isMintedDocumentId, verifyDocumentIdAgainstAny, type WorkspaceRef } from './rbac/documentIdMint.js'
import type { MetricSample } from './runtime/metrics.js'

/**
 * THE MINTED-ORPHAN REAPER.
 *
 * Reclaims documents the bootstrap family created under a workspace-bound id
 * (`bootstrapMint.ts`) whose publisher never claimed them — a fork whose
 * `INSERT INTO versions` failed, a merge snapshot that died between its
 * Automerge writes and its transaction, and the documents an Automerge save
 * armed at creation writes BACK after a rollback removed them
 * (`forkRollback.ts` § the armed save, pinned in `forkRoot.test.ts`).
 *
 * ## Why this is not `gcOrphanedDocs`, and can afford to be an hour
 *
 * The GC is mark-and-sweep: it needs the COMPLETE reachable set, so one
 * unreadable root anywhere in the fleet makes it delete nothing, and it keeps
 * a 24 h floor because a browser-created document's registry link may still
 * be on its way (offline-first). Its reclaim latency is 24-48 h, computed.
 *
 * This job walks nothing. Its predicate is LOCAL TO EACH STORAGE ROW:
 *
 *   1. the id is SERVER-MINTED — `isMintedDocumentId`, format only. A 16-byte
 *      legacy id (every browser document) fails on length before anything
 *      else, so the offline-first case never enters. Bootstrap work is
 *      synchronous server work; an hour is far above any measured fork;
 *   2. no `automerge_document_workspace` row — the publisher's claim, written
 *      in the same step as the `versions` row, never landed;
 *   3. the document is no version's `root_url` (redundant with 6 for a minted
 *      root whose version exists — kept because it also keeps such a root out
 *      of the STRANDED count, which is an alarm and should not fire on the one
 *      document every live version has), and is named by no saved
 *      landscape-version snapshot manifest — the liveness root
 *      `gcOrphanedDocs` honours for documents a root stopped referencing;
 *   4. last written before the floor — `MAX(updated_at)` over its chunks. A
 *      slow fork that is still writing is not old. `created_at ≤ updated_at`
 *      on every row, so "last written before" implies "born before" and no
 *      separate birth floor is needed; `born` is read only to order candidates
 *      oldest-first;
 *   5. not held in memory by this process;
 *   6. and — the check the MAC was built for — its tag verifies against NO
 *      `(landscape, version)` pair that EXISTS. A document bound to a version
 *      that does exist but was never claimed is STRANDED, not orphaned: the
 *      version was inserted and its claim batch failed (landscapes.ts lets
 *      that throw propagate; provisioning.ts logs it), and the lazy walk claims
 *      it at the next attach. Reaping it would hollow out a live version. It
 *      is counted and named, never deleted.
 *
 * None of those needs completeness, so the job is not fail-closed on the
 * fleet, needs no ownership admission (`admitRepoMaintenance` exists for the
 * GC's in-memory set, which must be the whole fleet's; under multi-partition a
 * document in another cell's memory is either bound to a version that exists —
 * check 6 protects it — or a fork more than an hour old with no version row,
 * which is broken), and runs under the coordinator's job-name lease and fence
 * exactly like every other destructive job.
 *
 * ## What it refuses
 *
 * With NO MINT KEY every id verifies `unminted`, so check 6 would be vacuously
 * true for every candidate: the job would delete on a verdict it never
 * computed. It refuses to run instead (`hasMintKey`), and says so.
 *
 * ## Cost
 *
 * Check 6 is candidates × versions × keys tag-HMACs, through
 * `verifyDocumentIdAgainstAny`, which decodes the id and derives the keys
 * ONCE per candidate — `verifyDocumentId` redoes both per call, roughly
 * tripling the cost. Candidates are
 * normally zero — an orphan is a failed publisher — and are capped per run;
 * the version list is read once. The loop yields to the event loop at the
 * head of every candidate, including the ones it skips. At the cap with a
 * large fleet this is seconds of CPU in a pathological state, not a steady
 * cost; the cap and the floor are knobs.
 *
 * The candidate SELECT aggregates the whole `automerge_storage` table (the
 * same shape `gcOrphanedDocs` runs daily), hourly. On a large deployment that
 * is the dominant cost of this job, and `MINTED_ORPHAN_REAPER_INTERVAL_MS` is
 * the dial: six hours is still four to eight times faster than the GC.
 *
 * ## The floor is the load-bearing guard
 *
 * A bootstrap running on ANOTHER replica is invisible to check 5, and on the
 * same replica idle eviction can drop a long fork's early handles inside the
 * hour. What protects a fork in progress is check 4 alone: it is reaped only
 * if none of its chunks was written for a whole floor. So the floor must
 * exceed the longest bootstrap that can complete at all, and the knob's
 * minimum must too. Given the fork rate observed near the server's memory
 * ceiling (~10k documents), both the default and the minimum below cover every
 * fork that can finish.
 */

const DELETE_BATCH = 100

/** Same shape as `gc.ts`' `configuredMinimumAgeMs`: a rejection floor, so a
 *  dangling `MINTED_ORPHAN_REAPER_MINIMUM_AGE_MS=` cannot make the cutoff NOW.
 *  Bounds as LITERALS: `envNumber.test.ts` parses every bounds row in the
 *  files it lists and checks fallback ∈ [minimum, maximum] and minimum > 0;
 *  an expression there reads as no number at all. One hour, one minute, seven
 *  days. */
function configuredMinimumAgeMs(): number {
  return envNumber('MINTED_ORPHAN_REAPER_MINIMUM_AGE_MS', {
    fallback: 3_600_000, minimum: 60_000, maximum: 604_800_000, integer: true,
  })
}

function configuredMaxCandidates(): number {
  return envNumber('MINTED_ORPHAN_REAPER_MAX_CANDIDATES', {
    fallback: 100, minimum: 1, maximum: 1_000, integer: true,
  })
}

export interface MintedOrphanReaperOptions {
  db: Pool
  fence?: MaintenanceFence
  /** Override the floor. Tests pass 0; production reads the knob. */
  minimumAgeMs?: number
  maxCandidates?: number
  now?: Date
  /** Compute the reap set, delete nothing. */
  reportOnly?: boolean
}

export interface MintedOrphanReaperResult {
  status: 'completed' | 'refused_no_mint_key'
  /** Rows examined this run: minted-length, unclaimed, no version root, old. */
  candidates: number
  /** Candidates whose id did not decode as a minted id after all. */
  notMintedFormat: number
  skippedInMemory: number
  /** Named by a saved landscape-version snapshot manifest — the GC's liveness root, honoured here too. */
  skippedSnapshot: number
  /** Bound to a version that EXISTS but unclaimed. Never reaped. */
  stranded: number
  reaped: number
  /** The run stopped with rows still unexamined — it found `maxCandidates`
   *  documents to reap, or hit its page bound; the next run continues. */
  truncated: boolean
  reapedDocumentIds: string[]
  strandedDocumentIds: string[]
  reportOnly: boolean
}

let reapedTotal = 0
let strandedTotal = 0
let lastRunCandidates = 0
/** The refusal is worth one line per process, not one per hour on every
 *  deployment without an AUTH_SECRET. */
let refusalLogged = false

function refused(reportOnly: boolean): MintedOrphanReaperResult {
  return {
    status: 'refused_no_mint_key', candidates: 0, notMintedFormat: 0, skippedInMemory: 0, skippedSnapshot: 0,
    stranded: 0, reaped: 0, truncated: false, reapedDocumentIds: [], strandedDocumentIds: [], reportOnly,
  }
}

/** The document id of an Automerge url (`automerge:<id>` or bare). */
function docIdOf(url: string): string {
  return url.replace(/^automerge:/, '').split('?')[0]!
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export async function reapMintedOrphans(
  repo: Repo,
  options: MintedOrphanReaperOptions,
): Promise<MintedOrphanReaperResult> {
  const reportOnly = options.reportOnly === true
  if (!hasMintKey()) {
    if (!refusalLogged) {
      refusalLogged = true
      console.warn('[minted-orphan-reaper] refused: no mint key (AUTH_SECRET) — every id would read unminted and the verdict would be vacuous; not repeated for this process')
    }
    return refused(reportOnly)
  }
  refusalLogged = false
  const db = options.db
  const minimumAgeMs = options.minimumAgeMs ?? configuredMinimumAgeMs()
  const maxCandidates = options.maxCandidates ?? configuredMaxCandidates()
  const cutoff = new Date((options.now ?? new Date()).getTime() - minimumAgeMs)

  // Check 6's universe: every version that exists, read once per run. A version
  // deleted between this read and the DELETE below makes its documents
  // stranded for one more hour, which is the safe direction.
  const { rows: versionRows } = await db.query<{ landscape_id: string; id: string }>(
    'SELECT landscape_id, id FROM versions',
  )
  const versions: WorkspaceRef[] = versionRows.map((row) => ({ landscapeId: row.landscape_id, versionId: row.id }))

  // Saved landscape-version SNAPSHOTS name live documents by url and restore
  // by rolling those exact documents back, so `gcOrphanedDocs` marks every
  // document a manifest names as reachable even when no root references it
  // (gc.ts, "Phase 0b"). The same set is excluded here, so the two sweepers
  // keep one notion of liveness (e.g. after a `deleteVersion`). NOT tolerant of a missing
  // table: a schema without it has lost a liveness root, and the safe answer
  // to that is a thrown run that deletes nothing, not a quieter sweep.
  const { rows: snapshotRows } = await db.query<{ manifest: { docs?: { url?: string }[] } | null }>(
    'SELECT manifest FROM landscape_versions',
  )
  const snapshotDocumentIds = new Set<string>()
  for (const row of snapshotRows) {
    for (const d of row.manifest?.docs ?? []) if (d.url) snapshotDocumentIds.add(docIdOf(d.url))
  }

  // Check 5. `cachedHandles`, the same source `gcOrphanedDocs` reads: absence
  // from it is a licence to delete durably, so it must be the cache and not a
  // synchronised-handle view.
  const inMemory = new Set(Object.values(cachedHandles(repo)).map((h) => docIdOf(h.url)))

  // Checks 1 (as a length prefilter — the real format test is in JS), 2, 3
  // and 4, in SQL. A minted id encodes to 37-38 characters and a legacy one
  // to 27-28 (`documentIdMint.ts`, measured over 200 samples each); 30 splits
  // them with margin on the safe side — a legacy id that slipped through
  // would be rejected by `isMintedDocumentId` below, and a minted one excluded
  // here would merely wait for a later run. The JS guard is what stops a
  // 24-byte id of an UNKNOWN scheme version, which passes the length filter
  // and is not ours to delete.
  //
  // PAGED BY KEYSET, and the cap counts REAPABLE documents, not rows.
  // Candidates this loop can never reap — stranded, in memory, unknown format
  // — are permanent and sort oldest-first, so capping SQL rows would let them
  // fill every slot on every run and starve younger orphans. A run walks pages of `max + 1`
  // rows past whatever it skips, until it has `max` documents to reap, runs
  // out of rows, or hits the page bound that keeps a pathological table from
  // turning one run into a full scan of every permanent skip.
  //
  // The cursor is the row's `born` AS TEXT: a `timestamptz` round-tripped
  // through a JS Date loses microseconds, and a cursor below the row it came
  // from re-fetches that row for ever.
  const MAX_PAGES = 10
  let notMintedFormat = 0
  let skippedInMemory = 0
  let skippedSnapshot = 0
  let examined = 0
  const strandedDocumentIds: string[] = []
  const toReap: string[] = []
  let cursor: { born: string; doc: string } | null = null
  let exhausted = false
  let pages = 0
  while (!exhausted && toReap.length < maxCandidates && pages < MAX_PAGES) {
    pages += 1
    // A page is exactly the room left under the cap, plus one row to tell
    // "no more" from "more": the cap is strict without a mid-page break.
    const pageSize = maxCandidates - toReap.length
    const params: unknown[] = [cutoff, pageSize + 1, cursor?.born ?? null, cursor?.doc ?? null]
    // Annotated, not inferred: the cursor feeds this query and is set from
    // its rows, which TypeScript reads as a self-referential initializer.
    const { rows }: { rows: Array<{ doc: string; born_text: string }> } = await db.query(
      `SELECT d.doc, d.born::text AS born_text
         FROM (
           SELECT split_part(key, '/', 1) AS doc,
                  MIN(created_at) AS born,
                  MAX(updated_at) AS last_write
             FROM automerge_storage
            WHERE length(split_part(key, '/', 1)) BETWEEN 30 AND 64
            GROUP BY split_part(key, '/', 1)
         ) d
        WHERE d.last_write < $1
          AND NOT EXISTS (SELECT 1 FROM automerge_document_workspace w WHERE w.document_id = d.doc)
          AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.root_url = 'automerge:' || d.doc)
          AND ($3::text IS NULL OR (d.born, d.doc) > ($3::timestamptz, $4::text))
        ORDER BY d.born, d.doc
        LIMIT $2`,
      params,
    )
    for (const row of rows.slice(0, pageSize)) {
      // At the HEAD of the loop, so a run of skipped candidates yields too.
      await yieldToEventLoop()
      examined += 1
      cursor = { born: row.born_text, doc: row.doc }
      const doc = row.doc
      if (!isDocumentStorageKey(doc) || !isMintedDocumentId(doc)) { notMintedFormat += 1; continue }
      if (inMemory.has(doc)) { skippedInMemory += 1; continue }
      if (snapshotDocumentIds.has(doc)) { skippedSnapshot += 1; continue }
      if (verifyDocumentIdAgainstAny(doc, versions)) { strandedDocumentIds.push(doc); continue }
      toReap.push(doc)
    }
    if (rows.length <= pageSize) exhausted = true
  }
  const truncated = !exhausted
  lastRunCandidates = examined

  let reaped = 0
  const reapedDocumentIds: string[] = []
  for (let offset = 0; !reportOnly && offset < toReap.length; offset += DELETE_BATCH) {
    const batch = toReap.slice(offset, offset + DELETE_BATCH)
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      if (options.fence) await assertMaintenanceFence(client, options.fence)
      // THE SAME THREE STATEMENTS AS `gcOrphanedDocs` (gc.ts), in the same
      // transaction, for the same reasons written there: the admission row
      // and the arrival watermark describe nothing once the storage is gone.
      // `mintedOrphanReaper.integration.test.ts` scans both files to keep
      // them the same.
      const { rows: deletedRows } = await client.query<{ doc: string }>(
        `DELETE FROM automerge_storage
         WHERE split_part(key, '/', 1) = ANY($1::text[])
         RETURNING split_part(key, '/', 1) AS doc`,
        [batch],
      )
      await client.query(
        `DELETE FROM automerge_document_workspace WHERE document_id = ANY($1::text[])`,
        [batch],
      )
      await client.query(
        `DELETE FROM read_model_document_watermarks WHERE document_id = ANY($1::text[])`,
        [batch],
      )
      await client.query('COMMIT')
      const distinct = [...new Set(deletedRows.map(({ doc }) => doc))]
      reaped += distinct.length
      reapedDocumentIds.push(...distinct)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  reapedTotal += reaped
  strandedTotal += strandedDocumentIds.length
  if (reaped > 0 || strandedDocumentIds.length > 0 || truncated) {
    console.log(
      `[minted-orphan-reaper] ${reportOnly ? 'would reap' : 'reaped'} ${reportOnly ? toReap.length : reaped} of ${examined} candidate(s)`
      + ` (floor ${minimumAgeMs} ms, in memory ${skippedInMemory}, in a snapshot ${skippedSnapshot}, not minted ${notMintedFormat}`
      + `${truncated ? ', TRUNCATED at ' + maxCandidates : ''})`
      + (strandedDocumentIds.length > 0
        ? `; ${strandedDocumentIds.length} STRANDED — bound to a live version but never claimed, left alone: ${strandedDocumentIds.join(', ')}`
        : '')
      + (reaped > 0 ? `: ${reapedDocumentIds.join(', ')}` : ''),
    )
  }

  return {
    status: 'completed',
    candidates: examined,
    notMintedFormat,
    skippedInMemory,
    skippedSnapshot,
    stranded: strandedDocumentIds.length,
    reaped,
    truncated,
    reapedDocumentIds,
    strandedDocumentIds,
    reportOnly,
  }
}

/** TEST SEAM. Counters are process-wide. */
export function resetMintedOrphanReaperCountersForTest(): void {
  reapedTotal = 0
  strandedTotal = 0
  lastRunCandidates = 0
}

export function mintedOrphanReaperMetricSamples(): MetricSample[] {
  return [
    {
      name: 'maplespire_minted_orphan_reaper_reaped_documents_total',
      help: 'Server-minted documents deleted by the minted-orphan reaper: unclaimed, bound to no existing version, older than the floor. Each one is a bootstrap publisher (fork, empty root, sparse draft, merge snapshot) that failed between its Automerge writes and its versions row, or a document an armed save wrote back after a rollback.',
      type: 'counter',
      values: [{ value: reapedTotal }],
    },
    {
      name: 'maplespire_minted_orphan_reaper_stranded_documents_total',
      help: 'Server-minted documents found unclaimed but bound to a version that EXISTS. Never deleted. Non-zero means a publisher inserted its versions row and its claim batch then failed; the lazy walk claims them at the next attach. Read as a claim-failure alarm.',
      type: 'counter',
      values: [{ value: strandedTotal }],
    },
    {
      name: 'maplespire_minted_orphan_reaper_last_run_candidates',
      help: 'Candidates the last reaper run examined (minted-length, unclaimed, no version root, older than the floor). Normally 0; a steady non-zero value means publishers are failing.',
      type: 'gauge',
      values: [{ value: lastRunCandidates }],
    },
  ]
}
