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

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as A from '@automerge/automerge'
import type { Repo } from '@automerge/automerge-repo'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { findForwardChange, forwardMessage, rebuildElemMap, type ForwardOverride, type Path, type PlannedInsert } from '../modelEpochForward.js'
import { readMetaUrl, readMetaUrls } from '../modelMetaUrls.js'
import { modelEpochLock, type RollLock } from './modelEpochRoll.js'
import { insertOverrides, type OverrideInsert } from './modelEpochOverrides.js'
import { epochDocumentIdOf, storageDocument, type FencedTransaction } from './modelEpochStore.js'
import type { WorkspaceKey } from './projector.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'

/**
 * THE OPERATOR'S DOOR on a quarantined forward journal (G4-16f). The forwarder
 * quarantines a journal that keeps failing (`modelEpochForwarder.ts`,
 * `noteJournalFailure`) and raises an alert; from then on the fold writer,
 * compaction and the roll no longer refuse on it, and its source is not
 * forwarded. So by the time an operator acts, a fold, a compaction's clear or a
 * whole roll may have SUPERSEDED the targets the journal recorded. Both ways
 * out run under the `model-epoch:` key, so no forwarder runs meanwhile, and
 * both read each recorded target AS STORAGE HOLDS IT (the forwarder flushes
 * after every write):
 *
 *  - RELEASE: the cause is fixed (a document restored, a bug deployed). Each
 *    recorded target is checked: WRITTEN (its forward change is there) or
 *    still a valid destination — a document of the current epoch, or a
 *    listed overlay segment of the current meta while the current overlay
 *    still holds every entity routed to it (a clear or a fold that took them
 *    away invalidates it). Then:
 *      - every unwritten target still valid: the journal is OPEN again, its
 *        attempts reset; the next pass replays it;
 *      - some unwritten target superseded and NOTHING written yet: RE-PLANNED
 *        — the journal is deleted with the cursor left at its `from`, so the
 *        next pass routes the same late writes afresh against the current
 *        meta;
 *      - superseded and something already written: REFUSED
 *        (`superseded_since_quarantine`, naming both sets) — a partial replay
 *        into a superseded target could drop what it carries; the operator
 *        discards (below) and re-applies from its export.
 *  - DISCARD: the late writes the journal carries are given up. First they
 *    are EXPORTED — the source's changes between the journal's `from` and
 *    `to`, raw and decoded, with the diff — to a file whose path the result
 *    names; a source storage does not hold up to `to` yet is refused
 *    (`source_not_durable`: retry once the server flushed it). Then, in ONE
 *    write-FENCED transaction: the source's cursor moves
 *    to `to` (a CAS from `from`: `cursor_moved` when it did not hold), the
 *    targets ALREADY written are recorded as a completed forward would —
 *    their canonical change in `forward_writes` (for the dedupe sweep), their
 *    new element ids merged into `elem_map`, their override rows — and the
 *    journal is deleted. What was written STAYS written (Automerge changes are
 *    not undone); the result says which targets those are.
 *
 * `npm run repair:epoch-forward-quarantine` is the CLI over these.
 */

export interface QuarantinedForward {
  id: string
  sourceDocumentId: string
  attempts: number
  lastError: string | null
  quarantinedAt: Date
  targets: string[]
}

interface Part {
  documentId: string
  paths?: Path[]
  aligned?: boolean
  plannedInserts?: PlannedInsert[]
  headsBefore?: string[]
  overrides?: ForwardOverride[]
}
type JournalRow = {
  id: string
  source_document_id: string
  from_heads: string[]
  to_heads: string[]
  parts: Part[] | null
}

export async function listQuarantinedForwards(db: Queryable, key: WorkspaceKey): Promise<QuarantinedForward[]> {
  const { rows } = await db.query<{ id: string; source_document_id: string; attempts: number; last_error: string | null; quarantined_at: Date; parts: Array<{ documentId?: string }> | null }>(
    `SELECT id, source_document_id, attempts, last_error, quarantined_at, parts
       FROM read_model_model_epoch_forwards
      WHERE landscape_id = $1 AND version_id = $2 AND quarantined_at IS NOT NULL
      ORDER BY quarantined_at`,
    [key.landscapeId, key.versionId])
  return rows.map((r) => ({
    id: r.id, sourceDocumentId: r.source_document_id, attempts: r.attempts, lastError: r.last_error,
    quarantinedAt: r.quarantined_at,
    targets: targetsOf(r.parts),
  }))
}

const targetsOf = (parts: Array<{ documentId?: string }> | null) =>
  (Array.isArray(parts) ? parts : []).map((p) => String(p?.documentId ?? '')).filter(Boolean)

export type QuarantineActionResult =
  | { outcome: 'released'; journal: string; source: string; targets: string[]; written: string[]; replanned: boolean }
  | { outcome: 'discarded'; journal: string; source: string; targets: string[]; written: string[]; exportTable: 'read_model_model_epoch_discards'; exportPath?: string }
  | { outcome: 'superseded_since_quarantine'; journal: string; written: string[]; superseded: string[] }
  | { outcome: 'not_quarantined'; journal: string }
  | { outcome: 'model_epoch_lock_contended' }
  | { outcome: 'cursor_moved'; journal: string; exportPath?: string }
  | { outcome: 'source_not_durable'; journal: string }

export interface QuarantineDeps {
  db: Queryable
  connect: () => Promise<ReleasableQueryable>
  key: WorkspaceKey
  lock?: RollLock
  /** Write-FENCED transactions — required by release and discard (the CLI
   * asserts the write fence the workspace's projector holds, `fencedOn`). */
  fenced?: FencedTransaction
  /** The process's Repo, when the caller has one: each target is FLUSHED
   * first and read from its handle as well as from storage, so a write still
   * in memory counts as written. */
  repo?: Repo
  /** A document as storage holds it (default `storageDocument`). */
  loadDocument?: (documentId: string) => Promise<A.Doc<unknown> | null>
  /** Discard: ALSO write the export to a file here (mode 0600). The durable
   * copy is the `read_model_model_epoch_discards` row, always written. */
  exportDir?: string
  now?: () => Date
}

/**
 * A document as this caller can best see it: storage, merged with the live
 * handle (flushed first) when the caller holds a Repo. THE CLI HOLDS NONE — the
 * only caller in production — so the Repo branch is for an in-process caller
 * and the tests; the CLI judges from storage alone. It runs under the
 * `model-epoch:` key, so no forwarder is writing meanwhile, and a forwarder
 * flushes each target before it moves on — the window left is a flush that
 * FAILED (or hit `FORWARD_FLUSH_TIMEOUT_MS`) in a process still alive: its
 * write is in that process's memory only, and counts here as not written. The
 * CLI's help ({@link QUARANTINE_CLI_HELP}) tells the operator to close it
 * first: restart or stop the cells that ran the journal's attempts.
 */
function loaderOf(deps: QuarantineDeps): (documentId: string) => Promise<A.Doc<unknown> | null> {
  const stored = deps.loadDocument ?? ((id: string) => storageDocument(deps.db, id))
  const repo = deps.repo
  if (!repo) return stored
  return async (id) => {
    let live: A.Doc<unknown> | undefined
    try {
      const handle = await findReadyDocument<unknown>(repo, `automerge:${id}`, 5_000)
      await repo.flush([handle.documentId])
      live = handle.doc() as A.Doc<unknown>
    } catch {
      live = undefined
    }
    const fromStorage = await stored(id)
    if (live && fromStorage) return A.merge(A.clone(fromStorage), A.clone(live))
    return live ?? fromStorage
  }
}

async function underKey<T>(deps: QuarantineDeps, work: () => Promise<T>): Promise<T | { outcome: 'model_epoch_lock_contended' }> {
  const lock = deps.lock ?? modelEpochLock({ connect: deps.connect as never }, deps.key)
  const state = await lock.acquire().catch(() => 'unknown' as const)
  try {
    if (state !== 'acquired') return { outcome: 'model_epoch_lock_contended' }
    return await work()
  } finally {
    await lock.release(state)
  }
}

async function readQuarantined(deps: QuarantineDeps, journalId: string): Promise<JournalRow | null> {
  const { rows } = await deps.db.query<JournalRow>(
    `SELECT id, source_document_id, from_heads, to_heads, parts FROM read_model_model_epoch_forwards
      WHERE id = $1 AND landscape_id = $2 AND version_id = $3 AND quarantined_at IS NOT NULL`,
    [journalId, deps.key.landscapeId, deps.key.versionId])
  return rows[0] ?? null
}

interface Written { part: Part; doc: A.Doc<unknown>; message: string; hash: string; since: string[] }

/** Each recorded target, split into WRITTEN (its forward change found, as
 * storage holds it) and not. */
async function writtenTargets(deps: QuarantineDeps, journal: JournalRow): Promise<{ written: Written[]; unwritten: Part[] }> {
  const load = loaderOf(deps)
  const written: Written[] = []
  const unwritten: Part[] = []
  for (const part of journal.parts ?? []) {
    const doc = await load(part.documentId)
    const message = forwardMessage(journal.id, part.documentId)
    const since = doc && part.headsBefore && A.hasHeads(doc, part.headsBefore) ? part.headsBefore : []
    const change = doc ? findForwardChange(doc, message, since) : undefined
    if (doc && change) written.push({ part, doc, message, hash: change.hash, since })
    else unwritten.push(part)
  }
  return { written, unwritten }
}

/**
 * The recorded targets that are no longer a valid destination (see the
 * header): neither a document of the current epoch, nor a listed overlay
 * segment of the current meta whose current overlay still holds every
 * entity the journal routed to it.
 */
async function supersededTargets(deps: QuarantineDeps, parts: readonly Part[]): Promise<string[]> {
  if (parts.length === 0) return []
  const load = loaderOf(deps)
  const ws = [deps.key.landscapeId, deps.key.versionId]
  const { rows: current } = await deps.db.query<{ document_id: string }>(
    `SELECT document_id FROM read_model_model_epoch_docs
      WHERE landscape_id = $1 AND version_id = $2 AND superseded_epoch IS NULL AND state = 'live'`, ws)
  const currentDocs = new Set(current.map((r) => r.document_id))
  const { rows: published } = await deps.db.query<{ meta_url: string | null }>(
    `SELECT meta_url FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2 AND state = 'published'`, ws)
  const meta = published[0]?.meta_url ? await load(epochDocumentIdOf(published[0].meta_url)) : null
  const overlayIds = new Set<string>()
  const overlays: Array<A.Doc<unknown>> = []
  if (meta) {
    for (const field of ['editsObjectShardUrls', 'editsConnectionShardUrls'] as const) {
      for (const url of readMetaUrls(meta, field) ?? []) overlayIds.add(epochDocumentIdOf(url))
    }
    for (const field of ['editsObjectShardUrl', 'editsConnectionShardUrl'] as const) {
      const url = readMetaUrl(meta, field)
      if (url) overlayIds.add(epochDocumentIdOf(url))
    }
    for (const id of overlayIds) {
      const doc = await load(id)
      if (doc) overlays.push(doc)
    }
  }
  const holds = (doc: A.Doc<unknown>, p: Path) => {
    const map = (doc as Record<string, Record<string, unknown> | undefined>)[String(p[0])]
    return p.length === 2 && map !== undefined && Object.prototype.hasOwnProperty.call(map, String(p[1]))
  }
  return parts.filter((part) => {
    if (currentDocs.has(part.documentId)) return false
    if (!overlayIds.has(part.documentId)) return true
    return !(part.paths ?? []).every((p) => overlays.some((o) => holds(o, p)))
  }).map((part) => part.documentId)
}

export function releaseQuarantinedForward(deps: QuarantineDeps, journalId: string): Promise<QuarantineActionResult> {
  return underKey(deps, async () => {
    // UNDER THE WRITE FENCE, as discard: a cell that
    // lost the workspace must not reopen or drop its journals.
    if (!deps.fenced) throw new Error('release runs FENCED: no write-fenced transaction was given')
    const journal = await readQuarantined(deps, journalId)
    if (!journal) return { outcome: 'not_quarantined', journal: journalId } as const
    const { written, unwritten } = await writtenTargets(deps, journal)
    const superseded = await supersededTargets(deps, unwritten)
    const targets = targetsOf(journal.parts)
    const writtenIds = written.map((w) => w.part.documentId)
    if (superseded.length === 0) {
      return deps.fenced!(async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE read_model_model_epoch_forwards
              SET quarantined_at = NULL, attempts = 0, heartbeat_at = now()
            WHERE id = $1 AND quarantined_at IS NOT NULL`, [journalId])
        if ((rowCount ?? 0) !== 1) return { outcome: 'not_quarantined', journal: journalId } as const
        return { outcome: 'released', journal: journalId, source: journal.source_document_id, targets, written: writtenIds, replanned: false } as const
      })
    }
    if (written.length > 0) {
      return { outcome: 'superseded_since_quarantine', journal: journalId, written: writtenIds, superseded } as const
    }
    // RE-PLANNED: nothing was written, so dropping the journal loses nothing;
    // the cursor is still its `from`, and the next pass routes afresh.
    return deps.fenced!(async (tx) => {
      const { rows } = await tx.query<{ forward_cursor: string[] | null }>(
        'SELECT forward_cursor FROM read_model_model_epoch_docs WHERE document_id = $1 FOR UPDATE', [journal.source_document_id])
      if (!sameHeadSet(rows[0]?.forward_cursor ?? [], journal.from_heads)) return { outcome: 'cursor_moved', journal: journalId } as const
      const { rowCount } = await tx.query(
        'DELETE FROM read_model_model_epoch_forwards WHERE id = $1 AND quarantined_at IS NOT NULL', [journalId])
      if ((rowCount ?? 0) !== 1) return { outcome: 'not_quarantined', journal: journalId } as const
      return { outcome: 'released', journal: journalId, source: journal.source_document_id, targets, written: [], replanned: true } as const
    })
  })
}

const sameHeadSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i])

/**
 * THE DISCARD EXPORT: everything an operator needs to
 * recover the given-up writes BY HAND — the source's changes after `from` and
 * up to `to` (raw, base64, and decoded), the diff, and the journal's own
 * routing: per target its entity paths, alignment, planned inserts, the heads
 * before its write, whether it was already written, and the override rows
 * recorded for it. `source` holds both heads (the caller refuses otherwise).
 *
 * WHERE IT GOES: a ROW of `read_model_model_epoch_discards`, written in the
 * SAME fenced transaction that moves the cursor and deletes the journal — so
 * "exported before given up" is atomic, and the export lives where the
 * journal lived, backed up with the database, whatever machine or ephemeral
 * container the CLI ran in (a file there would vanish with it; a mandatory
 * `--export-dir` only moves that problem onto the operator). `--export-dir`
 * still writes a file copy, mode 0600 (it holds user content).
 */
export interface DiscardExport {
  discardedAt: string
  landscapeId: string
  versionId: string
  journal: string
  source: string
  from: string[]
  to: string[]
  parts: Array<{
    documentId: string; paths: Path[]; aligned: boolean | null; plannedInserts: PlannedInsert[]; headsBefore: string[] | null
    alreadyWritten: boolean; overrides: ForwardOverride[]
  }>
  targets: string[]
  targetsAlreadyWritten: string[]
  changes: Array<{ hash: string; actor: string; seq: number; time: number; message: string | null; bytes: string }>
  diff: unknown
}

function buildDiscardExport(deps: QuarantineDeps, journal: JournalRow, source: A.Doc<unknown>, written: readonly string[]): DiscardExport {
  const beyondTo = new Set(A.getChangesSince(source, journal.to_heads).map((c) => A.decodeChange(c).hash))
  const changes = A.getChangesSince(source, journal.from_heads)
    .map((bytes) => ({ bytes, change: A.decodeChange(bytes) }))
    .filter(({ change }) => !beyondTo.has(change.hash!))
    .map(({ bytes, change }) => ({
      hash: change.hash!, actor: change.actor, seq: change.seq, time: change.time, message: change.message ?? null,
      bytes: Buffer.from(bytes).toString('base64'),
    }))
  const diff = JSON.parse(JSON.stringify(A.diff(source, journal.from_heads, journal.to_heads), (_k, v: unknown) =>
    (v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString('base64') } : v))) as unknown
  const at = (deps.now ?? (() => new Date()))()
  const writtenSet = new Set(written)
  return {
    discardedAt: at.toISOString(), landscapeId: deps.key.landscapeId, versionId: deps.key.versionId,
    journal: journal.id, source: journal.source_document_id, from: journal.from_heads, to: journal.to_heads,
    parts: (journal.parts ?? []).map((p) => ({
      documentId: p.documentId, paths: p.paths ?? [], aligned: p.aligned ?? null, plannedInserts: p.plannedInserts ?? [],
      headsBefore: p.headsBefore ?? null, alreadyWritten: writtenSet.has(p.documentId), overrides: p.overrides ?? [],
    })),
    targets: targetsOf(journal.parts), targetsAlreadyWritten: [...written],
    changes, diff,
  }
}

/** The file copy of an export: created, never overwritten, mode 0600. */
function writeExportFile(dir: string, payload: DiscardExport): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `epoch-forward-discard-${payload.journal}-${payload.discardedAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return file
}

/** A discard's export, as recorded (`npm run repair:epoch-forward-quarantine -- --show-export <journal>`). */
export async function readDiscardExport(db: Queryable, key: WorkspaceKey, journalId: string): Promise<DiscardExport | null> {
  const { rows } = await db.query<{ payload: DiscardExport }>(
    `SELECT payload FROM read_model_model_epoch_discards WHERE journal_id = $1 AND landscape_id = $2 AND version_id = $3`,
    [journalId, key.landscapeId, key.versionId])
  return rows[0]?.payload ?? null
}

/**
 * THE DISCARD EXPORTS' LIFETIME. An export is
 * the only copy of what a discard gave up, so it is kept at least
 * {@link DISCARD_EXPORT_MIN_RETENTION_MS} whatever happens; then it is pruned
 * WITH RETIREMENT — once its source document is retired, the window in which
 * those offline edits mean anything is over (as for the override rows) — and
 * after {@link DISCARD_EXPORT_MAX_RETENTION_MS} in any case (a source pinned
 * or deferred for ever). Run by every retirement pass, in its fenced
 * transaction. A DELETED version takes its exports with it
 * ({@link deleteEpochUserRowsOfWorkspace}, from `landscapes.ts`).
 */
export const DISCARD_EXPORT_MIN_RETENTION_MS = 30 * 86_400_000
export const DISCARD_EXPORT_MAX_RETENTION_MS = 180 * 86_400_000

export async function pruneDiscardExports(
  tx: Queryable, key: WorkspaceKey,
  retention: { minMs?: number; maxMs?: number } = {},
): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM read_model_model_epoch_discards x
      WHERE x.landscape_id = $1 AND x.version_id = $2
        AND x.discarded_at < now() - ($3::float8 * interval '1 millisecond')
        AND (x.discarded_at < now() - ($4::float8 * interval '1 millisecond')
             OR EXISTS (SELECT 1 FROM read_model_model_epoch_docs d
                         WHERE d.document_id = x.source_document_id AND d.state = 'retired'))`,
    [key.landscapeId, key.versionId, retention.minMs ?? DISCARD_EXPORT_MIN_RETENTION_MS, retention.maxMs ?? DISCARD_EXPORT_MAX_RETENTION_MS])
  return rowCount ?? 0
}

/**
 * The epoch rows that carry USER CONTENT and go with a DELETED version (or a
 * deleted landscape: `versionId` omitted), in the caller's transaction:
 * the discard exports (the given-up late writes), the override rows
 * (`late_value`), the forward-writes log (messages and
 * paths) and any forward journal (its parts carry the late values of the
 * overrides it planned). The epoch and document rows stay: protocol state
 * that GC already ignores for a version that no longer exists. A table that
 * does not exist is skipped. Returns the rows deleted per table.
 */
export const EPOCH_WORKSPACE_USER_TABLES = [
  'read_model_model_epoch_discards',
  'read_model_model_epoch_overrides',
  'read_model_model_epoch_forward_writes',
  'read_model_model_epoch_forwards',
  // The users' override actors.
  'read_model_model_epoch_override_actors',
  // G4-16k's scan cursors — no user
  // content, but nothing else ever removes them with their workspace.
  'read_model_overlay_clear_scans',
] as const

export async function deleteEpochUserRowsOfWorkspace(db: Queryable, landscapeId: string, versionId?: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of EPOCH_WORKSPACE_USER_TABLES) {
    const { rows: present } = await db.query<{ present: boolean }>(
      `SELECT to_regclass(current_schema() || '.${table}') IS NOT NULL AS present`)
    if (!present[0]?.present) continue
    const { rowCount } = versionId === undefined
      ? await db.query(`DELETE FROM ${table} WHERE landscape_id = $1`, [landscapeId])
      : await db.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [landscapeId, versionId])
    out[table] = rowCount ?? 0
  }
  return out
}

export function discardQuarantinedForward(deps: QuarantineDeps, journalId: string): Promise<QuarantineActionResult> {
  return underKey(deps, async () => {
    if (!deps.fenced) throw new Error('discard runs FENCED: no write-fenced transaction was given')
    const journal = await readQuarantined(deps, journalId)
    if (!journal) return { outcome: 'not_quarantined', journal: journalId } as const
    const { written } = await writtenTargets(deps, journal)
    const writtenIds = written.map((w) => w.part.documentId)
    // EXPORTED FIRST: nothing is given up before it is on disk — and what is
    // not durable yet (a source whose late changes storage does not hold up
    // to the journal's `to`) cannot be exported: refused, retry once flushed.
    const load = loaderOf(deps)
    const source = await load(journal.source_document_id)
    if (!source || !A.hasHeads(source, journal.from_heads) || !A.hasHeads(source, journal.to_heads)) {
      return { outcome: 'source_not_durable', journal: journalId } as const
    }
    const payload = buildDiscardExport(deps, journal, source, writtenIds)
    const exportPath = deps.exportDir ? writeExportFile(deps.exportDir, payload) : undefined
    const lateActors = await lateActorsOf(deps, journal, source)
    const elemMap: Record<string, string> = {}
    for (const w of written) {
      for (const [k, v] of rebuildElemMap(w.doc, w.message, w.part.plannedInserts ?? [], w.since) ?? []) elemMap[k] = v
    }
    const overrides: OverrideInsert[] = written.flatMap((w) => (w.part.overrides ?? []).map((override) => ({
      journalId: journal.id, sourceDoc: journal.source_document_id, targetDoc: w.part.documentId, override,
      currentHeadsAtForward: [w.hash], lateActors,
    })))
    return deps.fenced!(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE read_model_model_epoch_docs
            SET forward_cursor = $2::text[], elem_map = elem_map || $4::jsonb, updated_at = now()
          WHERE document_id = $1 AND forward_cursor IS NOT DISTINCT FROM $3::text[]`,
        [journal.source_document_id, journal.to_heads, journal.from_heads, JSON.stringify(elemMap)])
      if ((rowCount ?? 0) !== 1) {
        // Nothing else is written: the CAS failed, the transaction commits nothing.
        return { outcome: 'cursor_moved', journal: journalId, ...(exportPath ? { exportPath } : {}) } as const
      }
      // THE DURABLE EXPORT, in the same transaction as the give-up.
      await tx.query(
        `INSERT INTO read_model_model_epoch_discards (journal_id, landscape_id, version_id, source_document_id, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [journal.id, deps.key.landscapeId, deps.key.versionId, journal.source_document_id, JSON.stringify(payload)])
      // What was written is recorded as a completed forward would record it.
      await insertOverrides(tx, deps.key, overrides)
      for (const w of written) {
        await tx.query(
          `INSERT INTO read_model_model_epoch_forward_writes
             (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, paths)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb) ON CONFLICT DO NOTHING`,
          [journal.id, w.part.documentId, deps.key.landscapeId, deps.key.versionId, w.message, w.hash, w.since, JSON.stringify(w.part.paths ?? [])])
      }
      const { rowCount: deleted } = await tx.query(
        'DELETE FROM read_model_model_epoch_forwards WHERE id = $1 AND quarantined_at IS NOT NULL', [journalId])
      if ((deleted ?? 0) !== 1) throw new Error(`journal ${journalId} left quarantine during the discard`)
      return { outcome: 'discarded', journal: journalId, source: journal.source_document_id, targets: targetsOf(journal.parts), written: writtenIds,
        exportTable: 'read_model_model_epoch_discards', ...(exportPath ? { exportPath } : {}) } as const
    })
  })
}

/** The actors of the late changes (not the server's), for the override rows. */
async function lateActorsOf(deps: QuarantineDeps, journal: JournalRow, source: A.Doc<unknown>): Promise<string[]> {
  const { rows } = await deps.db.query<{ h: string }>(
    `SELECT DISTINCT unnest(server_change_hashes) AS h FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2`,
    [deps.key.landscapeId, deps.key.versionId])
  const server = new Set(rows.map((r) => r.h))
  return [...new Set(A.getChangesMetaSince(source, journal.from_heads).filter((m) => !server.has(m.hash)).map((m) => m.actor))]
}

/** `npm run repair:epoch-forward-quarantine -- --help`, and the usage error.
 * It states THE WINDOW (see `loaderOf`). */
export const QUARANTINE_CLI_HELP = `usage: npm run repair:epoch-forward-quarantine -- --landscape <id> --version <id>
         [--release <journal> | --discard <journal> [--export-dir <dir>] | --show-export <journal>]

  (no action)       list the workspace's quarantined forward journals
  --release <j>     reopen the journal (or re-route it when a target was superseded and nothing was written)
  --discard <j>     give up its late writes: exported to read_model_model_epoch_discards first
  --show-export <j> print a recorded discard export

BEFORE --release OR --discard: restart (or stop) every cell that ran the journal's attempts.
This CLI judges "already written" from STORAGE ALONE: a forward write a running server
applied in memory but never flushed (a failed or timed-out flush) counts as NOT written,
and if it reaches storage afterwards the late edit can land twice (re-planned release) or
be missing from the export's "already written" list (discard).`

export type QuarantineCommand =
  | { action: 'list' }
  | { action: 'release'; journal: string }
  | { action: 'discard'; journal: string; exportDir?: string }
  | { action: 'show-export'; journal: string }

/**
 * The CLI's arguments: `--release` or `--discard` WITHOUT
 * a journal id is an error, not list mode; both together is an error.
 */
export function parseQuarantineCommand(args: readonly string[]): QuarantineCommand {
  const valueOf = (name: string): string | undefined | null => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    return value && !value.startsWith('--') ? value : null
  }
  const release = valueOf('--release')
  const discard = valueOf('--discard')
  const show = valueOf('--show-export')
  if ([release, discard, show].filter((v) => v !== undefined).length > 1) throw new Error('--release, --discard and --show-export are exclusive: pick one')
  if (release === null) throw new Error('--release needs a journal id')
  if (discard === null) throw new Error('--discard needs a journal id')
  if (show === null) throw new Error('--show-export needs a journal id')
  const exportDir = valueOf('--export-dir')
  if (exportDir === null) throw new Error('--export-dir needs a directory')
  if (release) return { action: 'release', journal: release }
  if (discard) return { action: 'discard', journal: discard, ...(exportDir ? { exportDir } : {}) }
  if (show) return { action: 'show-export', journal: show }
  return { action: 'list' }
}
