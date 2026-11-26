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

import type { WorkspaceKey } from './projector.js'
import type { FencedTransaction } from './modelEpochStore.js'
import { pruneOverridesOfRetiredSources } from './modelEpochOverrides.js'
import { pruneDiscardExports } from './modelEpochQuarantine.js'
import type { Queryable } from './types.js'

/**
 * RETIREMENT of superseded epoch documents (G4-16f).
 *
 * A superseded document (`superseded_epoch` set, `state = 'live'`) RETIRES
 * once ALL of these hold:
 *  - AGE: it is older than N epochs — the epochs published since it was
 *    superseded, `superseded_epoch` included, abandoned and in-flight ones not
 *    counted, number MORE than `retain` (it was readable while its epoch was
 *    among the N previous ones);
 *  - QUIET: its durable heads equal its forward cursor (nothing left to
 *    forward), no forward journal is open on it, and its last late write is
 *    older than one period.
 * Age past 2N with the quiet test still failing DEFERS it with an alert
 * (`model_epoch.retire_deferred`): late writes keep arriving years on.
 *
 * The walk (one pass of {@link retireModelEpochDocs}, under the
 * `model-epoch:` key, flag-independent like the forwarder):
 *  1. `live` → `retiring`: GC stops marking it (`modelEpochGcRoots` marks
 *     only `live` and `pinned` documents, and filters out of the epoch rows'
 *     own URLs every document whose row is `retiring` or `retired`). It is no
 *     longer a late-write source, and no longer blocks a promotion.
 *  2. GC sweeps it (`gcOrphanedDocs`, still the only deleter). The next pass
 *     finds its storage empty: `retired`. The row stays (~40 bytes) so a
 *     client holding the document can be answered `epoch-retired`.
 *  3. Still in storage while ANOTHER root names it — an open forward journal
 *     (a target), a snapshot manifest (`landscape_versions`): `pinned`, with
 *     what pins it. Readable, not a source, not counted. The pin gone, the
 *     next pass moves it back to `retiring`.
 *  4. `retiring` or `pinned` and still in storage, with durable heads that
 *     moved past the forward cursor: a late write arrived after step 1's
 *     quiet check — back to `live`, a source again. GC
 *     keeps such a document meanwhile (`modelEpochGcRoots`).
 * An epoch row whose every document has retired becomes `retired`.
 */

export interface RetireConfig {
  retain: number
  periodDays: number
}

export interface RetireReport {
  retiring: string[]
  retired: string[]
  pinned: Array<{ documentId: string; by: string }>
  unpinned: string[]
  /** `retiring`/`pinned` back to `live`: a late write arrived after the quiet check. */
  revived: string[]
  deferred: Array<{ documentId: string; age: number; reason: string }>
  epochsRetired: number[]
  overridesPruned?: number
  discardsPruned?: number
  /** Documents left for the next pass: the budget ran out. */
  leftForNextPass?: number
}

export interface RetireDeps {
  db: Queryable
  fenced: FencedTransaction
  key: WorkspaceKey
  config: RetireConfig
  /** The document's durable heads from storage, null when storage holds none. */
  durableHeads: (documentId: string) => Promise<string[] | null>
  log?: (event: Record<string, unknown>) => void
  /** Tests only: the discard exports' retention (`pruneDiscardExports`). */
  discardRetention?: { minMs?: number; maxMs?: number }
  /** The walk's time budget for the documents it must READ (default
   * {@link RETIRE_WALK_BUDGET_MS}); the rest waits for the next pass, which
   * resumes after the last one read. */
  budgetMs?: number
  /** Tests only: the clock of the budget. */
  now?: () => number
}

/**
 * The walk READS every `retiring` and
 * `pinned` document (its durable heads: the whole stored document, decoded)
 * on every pass, and a `retiring` one stays so until the daily GC has
 * removed its storage. Measured on an e2e stack aged by retention, 180–236
 * of them made each periodic sweep — and the maintenance follow-up that runs
 * 30 s after a forwarding pass, so under continuous writes every 30 s — hold
 * the pool-heavy slot 33–35 s in its unyielding `retire` phase: a hopping
 * tab's latch (2 s) never got it, and no tab hopped in 150 s. The reads of
 * one pass are bounded by this budget; the next pass resumes after the last
 * document read (in memory, per workspace: a restart begins again), so every
 * document is still visited, a few passes later.
 */
export const RETIRE_WALK_BUDGET_MS = 2_000
/** Per workspace: WHERE in the walk's order (`superseded_epoch`, then
 * `document_id`, byte order) the last pass cut by its budget stopped — a
 * position, not a document: the
 * document last read may have retired since, and the walk still resumes
 * after it instead of from the start. */
const retireWalkCursors = new Map<string, { epoch: number; id: string }>()
const afterCursor = (doc: { superseded_epoch: number; document_id: string }, cursor: { epoch: number; id: string }) =>
  doc.superseded_epoch > cursor.epoch || (doc.superseded_epoch === cursor.epoch && doc.document_id > cursor.id)

/** Tests only. */
export function __resetRetireWalkCursorsForTest(): void {
  retireWalkCursors.clear()
}

const sameHeads = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i])

/** What pins a document still in storage: an open journal or a snapshot manifest. */
async function pinOf(db: Queryable, key: WorkspaceKey, documentId: string): Promise<string | null> {
  const { rows: journal } = await db.query<{ id: string }>(
    `SELECT id FROM read_model_model_epoch_forwards
      WHERE landscape_id = $1 AND version_id = $2
        AND (source_document_id = $3 OR parts @> jsonb_build_array(jsonb_build_object('documentId', $3::text)))
      LIMIT 1`,
    [key.landscapeId, key.versionId, documentId])
  if (journal[0]) return `journal:${journal[0].id}`
  const { rows: present } = await db.query<{ present: boolean }>(
    `SELECT to_regclass(current_schema() || '.landscape_versions') IS NOT NULL AS present`)
  if (present[0]?.present) {
    const { rows: manifest } = await db.query<{ id: string }>(
      `SELECT id::text AS id FROM landscape_versions
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(manifest->'docs', '[]'::jsonb)) d
                       WHERE d->>'url' = 'automerge:' || $1::text)
        LIMIT 1`,
      [documentId])
    if (manifest[0]) return `manifest:${manifest[0].id}`
  }
  return null
}

export async function retireModelEpochDocs(deps: RetireDeps): Promise<RetireReport> {
  const { db, key, config } = deps
  const ws = [key.landscapeId, key.versionId]
  const report: RetireReport = { retiring: [], retired: [], pinned: [], unpinned: [], revived: [], deferred: [], epochsRetired: [] }
  const { rows: docs } = await db.query<{
    document_id: string; state: string; superseded_epoch: number; forward_cursor: string[] | null
    late_quiet: boolean; age: number; journal_open: boolean; pinned_by: string | null
  }>(
    `SELECT doc.document_id, doc.state, doc.superseded_epoch, doc.forward_cursor, doc.pinned_by,
            (doc.last_late_write_at IS NULL OR doc.last_late_write_at < now() - ($3::float8 * interval '1 day')) AS late_quiet,
            (SELECT count(*)::int FROM read_model_model_epochs epoch
              WHERE epoch.landscape_id = doc.landscape_id AND epoch.version_id = doc.version_id
                AND epoch.epoch_no >= doc.superseded_epoch
                AND epoch.state IN ('published', 'retained', 'retired')) AS age,
            EXISTS (SELECT 1 FROM read_model_model_epoch_forwards f
                     WHERE f.source_document_id = doc.document_id
                        -- a TARGET of an open (or quarantined) journal too:
                        -- a superseded document can be
                        -- one once a roll came after the journal.
                        OR f.parts @> jsonb_build_array(jsonb_build_object('documentId', doc.document_id))) AS journal_open
       FROM read_model_model_epoch_docs doc
      WHERE doc.landscape_id = $1 AND doc.version_id = $2
        AND doc.superseded_epoch IS NOT NULL AND doc.state IN ('live', 'retiring', 'pinned')
      ORDER BY doc.superseded_epoch, doc.document_id COLLATE "C"`,
    [...ws, config.periodDays])
  const setState = async (documentId: string, from: string, to: string, pinnedBy: string | null = null) =>
    deps.fenced(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE read_model_model_epoch_docs SET state = $3, pinned_by = $4, updated_at = now()
          WHERE document_id = $1 AND state = $2`,
        [documentId, from, to, pinnedBy])
      return (rowCount ?? 0) === 1
    })

  // The budget: resume after the document the last pass
  // cut by it read, wrapping around.
  const workspace = `${key.landscapeId}/${key.versionId}`
  const now = deps.now ?? Date.now
  const startedAt = now()
  const budgetMs = deps.budgetMs ?? RETIRE_WALK_BUDGET_MS
  const cursor = retireWalkCursors.get(workspace)
  const found = cursor ? docs.findIndex((d) => afterCursor(d, cursor)) : 0
  const resumeAt = found < 0 ? 0 : found
  const ordered = [...docs.slice(resumeAt), ...docs.slice(0, resumeAt)]
  retireWalkCursors.delete(workspace)
  let lastRead: { epoch: number; id: string } | null = null
  for (const [index, doc] of ordered.entries()) {
    // Only a document the walk must READ spends the budget.
    const reads = doc.state !== 'live' || (doc.age > config.retain && !doc.journal_open && doc.late_quiet)
    if (reads && lastRead !== null && now() - startedAt >= budgetMs) {
      retireWalkCursors.set(workspace, lastRead)
      report.leftForNextPass = ordered.length - index
      break
    }
    if (reads) lastRead = { epoch: doc.superseded_epoch, id: doc.document_id }
    if (doc.state === 'live') {
      if (doc.age <= config.retain) continue
      // The two cheap reasons first: the document is read only when they
      // pass (the same verdicts as before, without the decode).
      const reason = doc.journal_open ? 'journal-open'
        : !doc.late_quiet ? 'late-write-within-a-period'
        : await deps.durableHeads(doc.document_id).then((durable) =>
          (durable !== null && !sameHeads(durable, doc.forward_cursor ?? []) ? 'cursor-behind-durable-heads' : null))
      if (reason) {
        report.deferred.push({ documentId: doc.document_id, age: doc.age, reason })
        if (doc.age > 2 * config.retain) {
          deps.log?.({ event: 'model_epoch.retire_deferred', alert: true, gauge: 'model_epoch_retire_deferred',
            documentId: doc.document_id, age: doc.age, bound: 2 * config.retain, reason,
            landscapeId: key.landscapeId, versionId: key.versionId })
        }
        continue
      }
      if (await setState(doc.document_id, 'live', 'retiring')) report.retiring.push(doc.document_id)
      continue
    }
    // `retiring` or `pinned`: is it gone from storage, or held by another root?
    const durable = await deps.durableHeads(doc.document_id)
    if (durable === null) {
      if (await setState(doc.document_id, doc.state, 'retired')) report.retired.push(doc.document_id)
      continue
    }
    // A LATE WRITE SINCE THE QUIET CHECK: it landed — or
    // sat unflushed — between `live → retiring` and now. Back to `live`, so
    // the forwarder (which reads `live` sources only) carries it; GC keeps
    // such a document meanwhile (`modelEpochGcRoots`).
    if (!sameHeads(durable, doc.forward_cursor ?? [])) {
      if (await setState(doc.document_id, doc.state, 'live')) {
        report.revived.push(doc.document_id)
        deps.log?.({ event: 'model_epoch.retire_revived', documentId: doc.document_id, from: doc.state,
          landscapeId: key.landscapeId, versionId: key.versionId })
      }
      continue
    }
    const pin = await pinOf(db, key, doc.document_id)
    if (doc.state === 'retiring' && pin) {
      if (await setState(doc.document_id, 'retiring', 'pinned', pin)) report.pinned.push({ documentId: doc.document_id, by: pin })
    } else if (doc.state === 'pinned' && !pin) {
      if (await setState(doc.document_id, 'pinned', 'retiring')) report.unpinned.push(doc.document_id)
    }
  }

  // An epoch whose every CREATED document has retired is retired itself.
  const { rows: epochs } = await deps.fenced(async (tx) => tx.query<{ epoch_no: number }>(
    `UPDATE read_model_model_epochs epoch SET state = 'retired', retired_at = now(), updated_at = now()
      WHERE epoch.landscape_id = $1 AND epoch.version_id = $2 AND epoch.state = 'retained'
        AND EXISTS (SELECT 1 FROM read_model_model_epoch_docs d
                     WHERE d.landscape_id = epoch.landscape_id AND d.version_id = epoch.version_id
                       AND d.created_epoch = epoch.epoch_no)
        AND NOT EXISTS (SELECT 1 FROM read_model_model_epoch_docs d
                         WHERE d.landscape_id = epoch.landscape_id AND d.version_id = epoch.version_id
                           AND d.created_epoch = epoch.epoch_no AND d.state <> 'retired')
      RETURNING epoch.epoch_no`, ws))
  report.epochsRetired = epochs.map((e) => e.epoch_no)
  // A retired source ends the window in which its offline values can
  // be re-applied; its override rows go with it.
  if (report.retired.length) report.overridesPruned = await deps.fenced((tx) => pruneOverridesOfRetiredSources(tx, key))
  // The discard exports: with retirement, past their minimum retention, and
  // past their maximum in any case.
  const discardsPruned = await deps.fenced((tx) => pruneDiscardExports(tx, key, deps.discardRetention))
  if (discardsPruned) report.discardsPruned = discardsPruned
  if (report.retiring.length || report.retired.length || report.pinned.length || report.epochsRetired.length || report.leftForNextPass) {
    deps.log?.({ event: 'model_epoch.retire', landscapeId: key.landscapeId, versionId: key.versionId,
      retiring: report.retiring.length, retired: report.retired.length, pinned: report.pinned.length,
      epochsRetired: report.epochsRetired, ...(report.leftForNextPass ? { leftForNextPass: report.leftForNextPass } : {}) })
  }
  return report
}

/**
 * A `retiring` or `pinned` document a tab
 * WROTE after the walk's quiet check (durable heads past its forward cursor)
 * is the walk's step 4 — back to `live` — but the walk runs with the
 * periodic sweep (10 min) or its follow-up, and meanwhile the durable-heads
 * route could only answer it `forwarded: false` with no pass to wait for: a
 * tab hopping off that epoch waited for ever (backoff, no banner; measured:
 * 37 documents of the epoch Marie held moved to `retiring` by a sweep
 * between the rolls, her 1 225 objects created offline in none of her tab
 * after the reload, nor a fresh browser's). The route asks for the revival
 * here and answers `forwardPending`; the pass it triggers revives — under its
 * fence, compare-and-set from `retiring`/`pinned` only, so a document GC
 * swept (`retired`) is never revived — before it forwards.
 */
/*
 * The request is a
 * column of the row (`revive_requested_at`), not process memory — a restart
 * keeps it, and a route served by a cell that does not own the workspace
 * leaves it for the owner's next pass, which consumes it ONCE: the same
 * UPDATE that revives clears the mark, so the walk may move the document on
 * again afterwards.
 */

/** The route: these documents of `key` were written past their cursor. Only
 * a mark — the state changes under the owner's fence. */
export async function requestLateRetiringRevival(db: { query(sql: string, params: unknown[]): Promise<unknown> }, key: WorkspaceKey, documentIds: readonly string[]): Promise<void> {
  if (documentIds.length === 0) return
  await db.query(
    `UPDATE read_model_model_epoch_docs SET revive_requested_at = now()
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = ANY($3::text[]) AND state IN ('retiring', 'pinned')`,
    [key.landscapeId, key.versionId, [...documentIds]])
}

/** The pass (fenced): revive what was asked, back to `live`, the mark
 * consumed; a mark left on a document that is no longer `retiring`/`pinned`
 * (swept to `retired`, revived by the walk) is cleared too. */
export async function reviveRequestedRetiring(tx: Queryable, key: WorkspaceKey, log?: (event: Record<string, unknown>) => void): Promise<string[]> {
  const { rows } = await tx.query<{ document_id: string }>(
    `UPDATE read_model_model_epoch_docs SET state = 'live', pinned_by = NULL, revive_requested_at = NULL, updated_at = now()
      WHERE landscape_id = $1 AND version_id = $2 AND revive_requested_at IS NOT NULL AND state IN ('retiring', 'pinned')
      RETURNING document_id`,
    [key.landscapeId, key.versionId])
  // Only ORPHANED marks: READ
  // COMMITTED gives this statement its own snapshot, so a mark the route set
  // on a `retiring` document AFTER the revival above and before this line is
  // seen here — cleared without a filter, that request was lost.
  await tx.query(
    `UPDATE read_model_model_epoch_docs SET revive_requested_at = NULL
      WHERE landscape_id = $1 AND version_id = $2 AND revive_requested_at IS NOT NULL
        AND state NOT IN ('retiring', 'pinned')`,
    [key.landscapeId, key.versionId])
  for (const row of rows) {
    log?.({ event: 'model_epoch.retire_revived', documentId: row.document_id, by: 'late-write',
      landscapeId: key.landscapeId, versionId: key.versionId })
  }
  return rows.map((r) => r.document_id)
}

/** Is `documentId` a RETIRED epoch document (the `epoch-retired` answer)?
 * One indexed lookup; false when the table does not exist. */
export async function isRetiredEpochDocument(db: Queryable, documentId: string): Promise<boolean> {
  const { rows: present } = await db.query<{ present: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_model_epoch_docs') IS NOT NULL AS present`)
  if (!present[0]?.present) return false
  const { rows } = await db.query<{ retired: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM read_model_model_epoch_docs WHERE document_id = $1 AND state = 'retired') AS retired`,
    [documentId])
  return rows[0]?.retired === true
}
