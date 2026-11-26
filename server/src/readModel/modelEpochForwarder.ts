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

import { randomUUID } from 'node:crypto'
import * as A from '@automerge/automerge'
import { isValidAutomergeUrl, type AutomergeUrl, type DocumentId, type Repo } from '@automerge/automerge-repo'
import {
  applyTargetPlan,
  changedEntityPaths,
  findForwardChange,
  forwardMessage,
  lateChanges,
  planForwardTarget,
  rebuildElemMap,
  type ForwardOverride,
  type ForwardSource,
  type Path,
  type PlannedInsert,
} from '../modelEpochForward.js'
import { insertOverrides, type OverrideInsert } from './modelEpochOverrides.js'
import {
  applyCompensation,
  compensationChanges,
  compensationFixMessage,
  compensationMessage,
  forwardDuplicates,
  planCompensation,
  planCounterFix,
  type KeptDuplicate,
} from '../modelEpochForwardDedupe.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { holdsHeads } from '../automergeHeads.js'
import { putToElementCacheSize, putToElementStats, viewAt } from '../modelEpochForward.js'
import { EPOCH_META_BUILDER_KEYS } from '../modelEpochs.js'
import { appendMetaUrl, elementUrl, metaUrlsAreScalar, readMetaUrl, readMetaUrls } from '../modelMetaUrls.js'
import { epochDocumentIdOf, type FencedTransaction } from './modelEpochStore.js'
import { modelEpochLock, type RollLock } from './modelEpochRoll.js'
import type { WorkspaceKey } from './projector.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'

/**
 * THE EPOCH FORWARDER (G4-16f): carries every
 * late write on a superseded epoch document into the current epoch, under
 * the `model-epoch:` key, through a JOURNAL committed before any write.
 *
 * For each late-write source (`listLateWriteSources`'s predicate):
 *  1. no late change once the server's own are removed: the cursor advances
 *     to the source's heads;
 *  2. otherwise the TARGETS are resolved — for a base shard, per entity: the
 *     current WRITE HEAD when an overlay segment of the current epoch holds
 *     that entity ("served elsewhere"; sequences then atomic), else the current base
 *     shard that holds it, else the one of the same slot; for a ModelMeta,
 *     the current ModelMeta, plus URL ADOPTION of the base shards a browser
 *     appended. The journal row records, per target, its document id,
 *     its entity paths, whether it is ALIGNED (built from this very source at
 *     its cut, so sequences replay by identity) and its planned inserts;
 *  3. each target gets ONE change whose message names (journal, target). A
 *     replay checks each RECORDED document for its message — never a
 *     re-resolved one: after a head rotation the recorded head is the retired
 *     one, and the ordinary forwarder carries what lands there — rebuilds the
 *     element ids of the targets already written, writes the others;
 *  4. one fenced transaction: CAS the cursor from `from` to the PLANNED `to`,
 *     merge `elem_map`, stamp `last_late_write_at`, record adopted shards,
 *     delete the journal.
 *
 * THE LEASE: a journal names its owner and a heartbeat. Another
 * forwarder replays an open journal only once the lease (30 s) has expired;
 * the owner stops between targets past its ceiling (10 s). The key check
 * before each `change` reads the lock client's cached "session alive" flag,
 * so content can still be written by a forwarder whose session has just died
 * — the lease bounds that window, it does not close it (a stated residual).
 *
 * While a journal is open, the fold writer, compaction and the roll refuse
 * (`modelEpochForwardPending`).
 */

export const FORWARD_LEASE_MS = 30_000
export const FORWARD_CEILING_MS = 10_000

const META_COLLECTIONS: ReadonlySet<string> = new Set(['groups', 'domains', 'tags', 'tagSnapshots', 'decisionRecords'])
const SHARD_COLLECTIONS: ReadonlySet<string> = new Set(['objects', 'connections'])
const NO_KEYS: ReadonlySet<string> = new Set()

export interface ForwarderDeps {
  readonly repo: Repo
  readonly key: WorkspaceKey
  readonly db: Queryable
  readonly connect: () => Promise<ReleasableQueryable>
  /** Write-fenced transactions for the journal and the cursor. */
  readonly fenced: FencedTransaction
  readonly instanceId: string
  readonly mayWrite: () => boolean
  readonly lock?: RollLock
  readonly leaseMs?: number
  readonly ceilingMs?: number
  readonly now?: () => number
  /** Deadline of each document resolution (default FORWARD_FIND_TIMEOUT_MS). */
  readonly findTimeoutMs?: number
  readonly quarantineAfterAttempts?: number
  readonly quarantineMinAgeMs?: number
  readonly dedupeWindowMs?: number
  /** Asked at every SAFE POINT — between two sources, between two dedupe
   * rows, before the mirror — and the pass stops there when it answers:
   * the sweep's time budget is spent, or a
   * compaction pass waits for the pool-heavy slot. What is left resumes on
   * the next pass (sources by their cursors, dedupe rows by
   * `dedupe_checked_at`). Absent: never yields (compaction's own forward). */
  readonly shouldYield?: () => ForwardYield | null
  /** Wraps the text mirror, a
   * phase with no safe point (`ModelEpochSweepDeps.unyielding`). */
  readonly unyielding?: <T>(phase: () => Promise<T>, name?: UnyieldingPhase) => Promise<T>
  /** The pass's MAINTENANCE — the dedupe sweep over the window's forward
   * writes and the current meta's text mirror (default true). False for an
   * event-driven pass that is not S9: neither carries a late write a
   * hopping tab waits for, and the dedupe walk grows with every forward of
   * the 14-day window (a continuous typist adds one per pass); the periodic
   * sweep, S9 and compaction's own forward keep doing both. */
  readonly maintenance?: boolean
  /** Ceiling of each `repo.flush` (default FORWARD_FLUSH_TIMEOUT_MS). */
  readonly flushTimeoutMs?: number
  readonly log?: (event: Record<string, unknown>) => void
  /** Tests only: a throw here is a crash right after that target's write. */
  readonly afterTargetWrite?: (targetDocumentId: string) => void | Promise<void>
  /** Tests only: a throw here is a crash with the journal committed and that
   * target not written yet. */
  readonly beforeTargetWrite?: (targetDocumentId: string) => void | Promise<void>
}

export interface ForwardSourceReport {
  documentId: string
  /** `unchanged`: its heads are its cursor, no journal open — nothing read, nothing written. */
  outcome: 'advanced' | 'unchanged' | 'forwarded' | 'leased-elsewhere' | 'missing-cursor-heads' | 'ceiling' | 'nothing-routed' | 'failed' | 'quarantined'
  targets?: number
  error?: string
  /** `-0` leaves stored as 0 (Automerge cannot hold a map's -0). */
  negativeZeroAsZero?: number
}

export interface DedupeReport { target: string; duplicate: string; applied: number; unmatched: number; kept?: KeptDuplicate[] }

/** Why a pass stopped early at a safe point: its time budget, or a waiting
 * compaction pass. */
export type ForwardYield = 'budget' | 'preempted'

/** The phases with no safe point a pass marks (named, so a test can
 * require each). */
export type UnyieldingPhase = 'retire' | 'purge' | 'mirror'

export type ForwarderReport =
  | { outcome: 'model_epoch_lock_contended' }
  | { outcome: 'not_owned' }
  | { outcome: 'no_current_epoch' }
  | { outcome: 'ran'; sources: ForwardSourceReport[]; dedupe?: DedupeReport[]; mirrorAdopted?: string[]; yielded?: ForwardYield }

/** Ceiling of one `repo.flush` in the forwarder.
 * Past it the pass FAILS that step — a write already applied in memory is
 * found by its message on the next attempt (the journal stays open; a
 * compensation or a mirror adoption is idempotent by its own message or by
 * value) — instead of holding the `model-epoch:` key and the pool-heavy slot
 * for as long as storage hangs. Shorter than the journal lease
 * (FORWARD_LEASE_MS), so a stalled flush no longer outlives it. */
export const FORWARD_FLUSH_TIMEOUT_MS = 20_000

export class ForwardFlushTimeout extends Error {
  constructor(documentId: string, ms: number) {
    super(`model epoch forwarder: flushing ${documentId} took more than ${ms} ms`)
    this.name = 'ForwardFlushTimeout'
  }
}

async function flushWithin(deps: ForwarderDeps, documentId: DocumentId): Promise<void> {
  const ms = deps.flushTimeoutMs ?? FORWARD_FLUSH_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      deps.repo.flush([documentId]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ForwardFlushTimeout(String(documentId), ms)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface AdoptUrl { field: 'objectShardUrls' | 'connectionShardUrls'; url: string }
interface JournalPart {
  documentId: string; paths: Path[]; aligned: boolean; plannedInserts: PlannedInsert[]; adoptUrls: AdoptUrl[]
  /** The target's heads just before its write, recorded with the re-plan:
   * the forward change is searched for after them only (not the whole
   * history), and the dedupe sweep compares duplicates against them. Absent
   * on a journal a previous version wrote: the whole history is searched. */
  headsBefore?: string[]
  /** The leaves the current epoch won, from the plan that was written. */
  overrides?: ForwardOverride[]
}
interface JournalRow {
  id: string
  from: string[]
  to: string[]
  parts: JournalPart[]
  ownerInstance: string
  /** Age of the heartbeat on the database clock, at read time. */
  heartbeatAgeMs: number
}

interface SourceRow {
  documentId: string
  role: 'meta' | 'base' | 'adopted'
  slot: number | null
  supersededEpoch: number
  forwardCursor: string[] | null
  /** The cut heads the superseding epoch was built from (alignment). */
  cutHeads: string[] | null
  elemMap: Record<string, string>
  /** Its open journal is quarantined: not forwarded until an operator acts. */
  quarantined: boolean
  /** A journal (quarantined or not) is open on it, as the pass read it. */
  journalOpen: boolean
}

const urlOf = (documentId: string) => `automerge:${documentId}` as AutomergeUrl
/** Every document resolution of the forwarder runs under a DEADLINE: a
 * document that never arrives must fail the pass, not
 * hold the model-epoch key — and every refusal behind an open journal — for
 * ever. */
export const FORWARD_FIND_TIMEOUT_MS = 30_000
function findWithin<T>(deps: ForwarderDeps, url: string) {
  return findReadyDocument<T>(deps.repo, url, deps.findTimeoutMs ?? FORWARD_FIND_TIMEOUT_MS)
}
/** The heads of a document's FIRST change: an epoch document's birth. */
export const birthHeadsOf = (doc: A.Doc<unknown>, documentId?: string): A.Heads => {
  // A document's first change never changes: remembered per document id.
  // An epoch document's first change is its BUILD — the whole
  // shard — and decoding it on every plan cost ~0.5 s a pass, profiled.
  const known = documentId === undefined ? undefined : birthHeadsMemo.get(documentId)
  // Validated: a remembered birth the document does not hold
  // is not trusted — recomputed instead.
  if (known && holdsHeads(doc, known)) return known
  const first = A.getAllChanges(doc)[0]
  const heads = first ? [A.decodeChange(first).hash] : []
  if (documentId !== undefined && heads.length > 0) {
    birthHeadsMemo.set(documentId, heads)
    if (birthHeadsMemo.size > BIRTH_HEADS_MEMO_MAX) birthHeadsMemo.delete(birthHeadsMemo.keys().next().value!)
  }
  return heads
}
const BIRTH_HEADS_MEMO_MAX = 1_024
const birthHeadsMemo = new Map<string, A.Heads>()

async function loadSources(db: Queryable, key: WorkspaceKey): Promise<SourceRow[]> {
  const { rows } = await db.query<{
    document_id: string; role: SourceRow['role']; slot: number | null; superseded_epoch: number
    forward_cursor: string[] | null; elem_map: Record<string, string> | null; cut_heads: Record<string, string[]> | null
    quarantined: boolean; journal_open: boolean
  }>(
    `SELECT doc.document_id, doc.role, doc.slot, doc.superseded_epoch, doc.forward_cursor, doc.elem_map, epoch.cut_heads,
            (journal.quarantined_at IS NOT NULL) AS quarantined, (journal.id IS NOT NULL) AS journal_open
       FROM read_model_model_epoch_docs doc
       LEFT JOIN read_model_model_epochs epoch
         ON epoch.landscape_id = doc.landscape_id AND epoch.version_id = doc.version_id
        AND epoch.epoch_no = doc.superseded_epoch
       LEFT JOIN read_model_model_epoch_forwards journal ON journal.source_document_id = doc.document_id
      WHERE doc.landscape_id = $1 AND doc.version_id = $2
        AND doc.superseded_epoch IS NOT NULL AND doc.state = 'live'
      ORDER BY doc.superseded_epoch, doc.document_id`,
    [key.landscapeId, key.versionId])
  return rows.map((r) => ({
    documentId: r.document_id, role: r.role, slot: r.slot, supersededEpoch: r.superseded_epoch,
    forwardCursor: r.forward_cursor, elemMap: r.elem_map ?? {},
    cutHeads: r.cut_heads?.[urlOf(r.document_id)] ?? null,
    quarantined: r.quarantined === true,
    // Absent (a test's hand-made row): treated as open — the full path.
    journalOpen: r.journal_open !== false,
  }))
}

interface CurrentEpoch {
  epochNo: number
  metaUrl: string
  docs: Map<string, { role: string; slot: number | null; createdEpoch: number; builtFromCut: boolean }>
  serverHashes: Set<string>
}

async function loadCurrentEpoch(db: Queryable, key: WorkspaceKey): Promise<CurrentEpoch | null> {
  const ws = [key.landscapeId, key.versionId]
  const { rows } = await db.query<{ epoch_no: number; meta_url: string }>(
    `SELECT epoch_no, meta_url FROM read_model_model_epochs
      WHERE landscape_id = $1 AND version_id = $2 AND state = 'published'`, ws)
  if (!rows[0]) return null
  const { rows: docs } = await db.query<{ document_id: string; role: string; slot: number | null; created_epoch: number; built_from_cut: boolean }>(
    `SELECT document_id, role, slot, created_epoch, built_from_cut FROM read_model_model_epoch_docs
      WHERE landscape_id = $1 AND version_id = $2 AND superseded_epoch IS NULL`, ws)
  const { rows: hashes } = await db.query<{ h: string }>(
    `SELECT DISTINCT unnest(server_change_hashes) AS h FROM read_model_model_epochs
      WHERE landscape_id = $1 AND version_id = $2`, ws)
  return {
    epochNo: rows[0].epoch_no,
    metaUrl: rows[0].meta_url,
    docs: new Map(docs.map((d) => [d.document_id, { role: d.role, slot: d.slot, createdEpoch: d.created_epoch, builtFromCut: d.built_from_cut !== false }])),
    serverHashes: new Set(hashes.map((r) => r.h)),
  }
}

async function readJournal(db: Queryable, sourceDocumentId: string): Promise<JournalRow | null> {
  // The lease age is measured on the DATABASE clock, the clock that stamped
  // the heartbeat: two cells' wall clocks may
  // disagree by more than the lease.
  const { rows } = await db.query<{ id: string; from_heads: string[]; to_heads: string[]; parts: JournalPart[]; owner_instance: string; age_ms: number | string }>(
    `SELECT id, from_heads, to_heads, parts, owner_instance,
            (EXTRACT(EPOCH FROM (now() - heartbeat_at)) * 1000)::float8 AS age_ms
       FROM read_model_model_epoch_forwards WHERE source_document_id = $1`, [sourceDocumentId])
  const r = rows[0]
  return r ? { id: r.id, from: r.from_heads, to: r.to_heads, parts: r.parts, ownerInstance: r.owner_instance,
    heartbeatAgeMs: Number(r.age_ms) } : null
}

/** Run one forwarding pass over every late-write source of the workspace. */
export async function forwardModelEpochLateWrites(deps: ForwarderDeps): Promise<ForwarderReport> {
  if (!deps.mayWrite()) return { outcome: 'not_owned' }
  const lock = deps.lock ?? modelEpochLock({ connect: deps.connect as never }, deps.key)
  const state = await lock.acquire().catch(() => 'unknown' as const)
  try {
    if (state !== 'acquired') return { outcome: 'model_epoch_lock_contended' }
    const alive = () => lock.alive?.() ?? true
    const current = await loadCurrentEpoch(deps.db, deps.key)
    if (!current) return { outcome: 'no_current_epoch' }
    const report: ForwardSourceReport[] = []
    const yielded = (): ForwardYield | null => deps.shouldYield?.() ?? null
    const stopped = (reason: ForwardYield, dedupe: DedupeReport[] = []): ForwarderReport => {
      deps.log?.({ event: 'model_epoch.forward.yielded', reason, sourcesDone: report.length,
        landscapeId: deps.key.landscapeId, versionId: deps.key.versionId })
      return { outcome: 'ran', sources: report, ...(dedupe.length ? { dedupe } : {}), yielded: reason }
    }
    // Where a slow pass spends its time,
    // per source (logged past FORWARD_SLOW_PASS_MS only).
    const passStartedAt = Date.now()
    const decodedBefore = putToElementStats.decoded
    const timings: Array<{ documentId: string; ms: number; outcome: string }> = []
    const sources = await loadSources(deps.db, deps.key)
    const logSlow = () => {
      const totalMs = Date.now() - passStartedAt
      if (totalMs < FORWARD_SLOW_PASS_MS) return
      deps.log?.({ event: 'model_epoch.forward.slow', totalMs, sources: sources.length,
        slowest: [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5),
        putToElement: { ...putToElementCacheSize(), decoded: putToElementStats.decoded - decodedBefore },
        landscapeId: deps.key.landscapeId, versionId: deps.key.versionId })
    }
    for (const source of sources) {
      // A SAFE POINT: no journal of this pass is open between two sources.
      const reason = yielded()
      if (reason) { logSlow(); return stopped(reason) }
      if (source.quarantined) { report.push({ documentId: source.documentId, outcome: 'quarantined' }); continue }
      const sourceStartedAt = Date.now()
      try {
        const one = await forwardOne(deps, current, source, alive)
        timings.push({ documentId: source.documentId, ms: Date.now() - sourceStartedAt, outcome: one.outcome })
        // A journal whose source never shows its `from` heads again wedges
        // nothing once quarantined; an expected transient one is counted.
        if (one.outcome === 'missing-cursor-heads' && await noteJournalFailure(deps, source.documentId, 'missing-cursor-heads')) {
          one.outcome = 'quarantined'
        }
        report.push(one)
      } catch (error) {
        // The key or the write authority lost: the whole pass stops (nothing
        // is the source's fault). A test's simulated crash is a process
        // death, not a source failure.
        if (error instanceof SimulatedForwarderCrash || !alive() || !deps.mayWrite()) {
          throw error instanceof SimulatedForwarderCrash ? error.cause : error
        }
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        const quarantined = await noteJournalFailure(deps, source.documentId, message)
        deps.log?.({ event: 'model_epoch.forward.failed', source: source.documentId, error: message, quarantined })
        report.push({ documentId: source.documentId, outcome: quarantined ? 'quarantined' : 'failed', error: message })
      }
    }
    logSlow()
    // A requested event-driven pass stops here (`ForwarderDeps.maintenance`).
    if (deps.maintenance === false) return { outcome: 'ran', sources: report }
    const dedupe = await compensateDuplicateForwards(deps, alive, yielded)
    if (dedupe.yielded) return stopped(dedupe.yielded, dedupe.reports)
    const beforeMirror = yielded()
    if (beforeMirror) return stopped(beforeMirror, dedupe.reports)
    const mirror = deps.unyielding
      ? await deps.unyielding(() => forwardMetaMirror(deps, current, alive), 'mirror')
      : await forwardMetaMirror(deps, current, alive)
    return {
      outcome: 'ran', sources: report,
      ...(dedupe.reports.length ? { dedupe: dedupe.reports } : {}),
      ...(mirror && mirror.adopted.length ? { mirrorAdopted: mirror.adopted } : {}),
    }
  } finally {
    await lock.release(state)
  }
}

/** A throw from a test crash hook: the process "dies" there. */
class SimulatedForwarderCrash extends Error {
  constructor(readonly cause: unknown) { super('simulated forwarder crash') }
}
async function crashPoint(hook: ((id: string) => void | Promise<void>) | undefined, id: string): Promise<void> {
  if (!hook) return
  try { await hook(id) } catch (error) { throw new SimulatedForwarderCrash(error) }
}

/** A pass longer than this logs its slowest sources (`model_epoch.forward.slow`). */
export const FORWARD_SLOW_PASS_MS = 750

export const FORWARD_QUARANTINE_AFTER_ATTEMPTS = 5
/** …and only once the journal is this old: five passes of a sweep minutes
 * apart are not yet "for ever". */
export const FORWARD_QUARANTINE_MIN_AGE_MS = 60 * 60_000

/**
 * Count one failed attempt on the source's OPEN journal, and QUARANTINE it
 * past the threshold, with an ALERT. True when the
 * journal is (now) quarantined. A failure with no journal open wedges
 * nothing — the fold, compaction and the roll do not refuse — and is only
 * logged.
 */
async function noteJournalFailure(deps: ForwarderDeps, sourceDocumentId: string, error: string): Promise<boolean> {
  const after = deps.quarantineAfterAttempts ?? FORWARD_QUARANTINE_AFTER_ATTEMPTS
  const minAgeMs = deps.quarantineMinAgeMs ?? FORWARD_QUARANTINE_MIN_AGE_MS
  const row = await deps.fenced(async (tx) => {
    const { rows } = await tx.query<{ id: string; attempts: number; quarantined: boolean }>(
      `UPDATE read_model_model_epoch_forwards
          SET attempts = attempts + 1, last_error = $2,
              quarantined_at = CASE WHEN attempts + 1 >= $3 AND created_at <= now() - ($4::float8 * interval '1 millisecond')
                                    THEN now() END
        WHERE source_document_id = $1 AND quarantined_at IS NULL
        RETURNING id, attempts, quarantined_at IS NOT NULL AS quarantined`,
      [sourceDocumentId, error.slice(0, 2000), after, minAgeMs])
    return rows[0] ?? null
  })
  if (row?.quarantined) {
    deps.log?.({
      event: 'model_epoch.forward.quarantined', alert: true, journal: row.id, source: sourceDocumentId,
      attempts: row.attempts, error, landscapeId: deps.key.landscapeId, versionId: deps.key.versionId,
      remedy: `npm run repair:epoch-forward-quarantine -- --landscape <id> --version <id> (--release ${row.id} | --discard ${row.id})`,
    })
  }
  return row?.quarantined === true
}

/** How long a completed forward stays under the dedupe sweep. */
export const FORWARD_DEDUPE_WINDOW_MS = 14 * 86_400_000

/**
 * THE WRITES LOG IS PURGED: a row no reader needs any
 * more is deleted — outside the dedupe window (the sweep reads nothing older)
 * AND older than the PREDECESSOR epoch's publication (the
 * durable-heads targets read nothing older: `currentEpochForwardTargets`;
 * no predecessor — a legacy epoch — the current one's). Run by the periodic
 * sweep under its write fence. Returns how many rows went.
 */
export async function purgeForwardWrites(tx: Queryable, key: WorkspaceKey, windowMs = FORWARD_DEDUPE_WINDOW_MS): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM read_model_model_epoch_forward_writes w
      WHERE w.landscape_id = $1 AND w.version_id = $2
        AND w.written_at < now() - ($3::float8 * interval '1 millisecond')
        AND w.written_at < coalesce((SELECT coalesce(p.published_at, e.published_at) FROM read_model_model_epochs e
              LEFT JOIN read_model_model_epochs p
                ON p.landscape_id = e.landscape_id AND p.version_id = e.version_id AND p.epoch_no = e.predecessor_epoch
              WHERE e.landscape_id = $1 AND e.version_id = $2 AND e.state = 'published'), 'infinity'::timestamptz)`,
    [key.landscapeId, key.versionId, windowMs])
  return rowCount ?? 0
}

/**
 * THE DEDUPE SWEEP (`modelEpochForwardDedupe.ts`):
 * for every forward completed inside the window, a second change carrying
 * the same message on its target is compensated — once, under its own
 * message — and reported with an alert (it means a crash after sync and
 * before flush, or the lease window above, really happened).
 */
async function compensateDuplicateForwards(
  deps: ForwarderDeps, alive: () => boolean, yielded: () => ForwardYield | null,
): Promise<{ reports: DedupeReport[]; yielded?: ForwardYield }> {
  // LEAST RECENTLY CHECKED FIRST: a pass that
  // yields mid-sweep resumes where it stopped on the next one, instead of
  // re-reading the oldest rows of the 14-day window every time.
  const { rows } = await deps.db.query<{ journal_id: string; target_document_id: string; message: string; change_hash: string; heads_before: string[]; paths: Path[] }>(
    `SELECT journal_id, target_document_id, message, change_hash, heads_before, paths
       FROM read_model_model_epoch_forward_writes
      WHERE landscape_id = $1 AND version_id = $2
        AND written_at > now() - ($3::float8 * interval '1 millisecond')
      ORDER BY dedupe_checked_at NULLS FIRST, written_at`,
    [deps.key.landscapeId, deps.key.versionId, deps.dedupeWindowMs ?? FORWARD_DEDUPE_WINDOW_MS])
  const out: DedupeReport[] = []
  const checked: Array<{ journal: string; target: string }> = []
  // UNDER THE WRITE FENCE, as every other row this
  // pass writes: ONE fenced statement for the rows checked, when the loop
  // ends or yields. A row checked by a pass that throws before it is not
  // recorded — it is checked again first next time, which costs nothing.
  const record = async () => {
    if (checked.length === 0) return
    await deps.fenced(async (tx) => {
      await tx.query(
        `UPDATE read_model_model_epoch_forward_writes w SET dedupe_checked_at = now()
           FROM unnest($1::text[], $2::text[]) AS c(journal_id, target_document_id)
          WHERE w.journal_id = c.journal_id AND w.target_document_id = c.target_document_id`,
        [checked.map((c) => c.journal), checked.map((c) => c.target)])
    })
  }
  for (const row of rows) {
    // A SAFE POINT: each row's compensation is one change under its own message.
    const reason = yielded()
    if (reason) { await record(); return { reports: out, yielded: reason } }
    await checkDuplicatesOf(deps, alive, row, out)
    checked.push({ journal: row.journal_id, target: row.target_document_id })
  }
  await record()
  return { reports: out }
}

async function checkDuplicatesOf(
  deps: ForwarderDeps, alive: () => boolean,
  row: { target_document_id: string; message: string; change_hash: string; heads_before: string[]; paths: Path[] },
  out: DedupeReport[],
): Promise<void> {
  {
    // A target that no longer resolves (retired, swept) has nothing left to
    // compensate: the sweep goes on with the others.
    const handle = await findWithin<unknown>(deps, urlOf(row.target_document_id)).catch((error: unknown) => {
      deps.log?.({ event: 'model_epoch.forward.dedupe_target_unavailable', target: row.target_document_id,
        error: error instanceof Error ? error.message : String(error) })
      return null
    })
    if (!handle) return
    const doc = handle.doc() as A.Doc<unknown>
    if (!holdsHeads(doc, row.heads_before)) return
    for (const duplicate of forwardDuplicates(doc, row.message, row.heads_before, row.change_hash)) {
      const now = handle.doc() as A.Doc<unknown>
      const plan = planCompensation(now, duplicate, row.paths,
        { canonical: row.change_hash, headsBefore: row.heads_before, forwardMessage: row.message })
      // IDEMPOTENT BY ITS OWN MESSAGE: once a compensation
      // exists, only the counter difference a duplicated COMPENSATION left is
      // written — never a second compensation.
      const done = compensationChanges(now, row.message, duplicate, row.heads_before)
      const ops = done.length ? planCounterFix(now, plan.ops, done) : plan.ops
      if (done.length && ops.length === 0) continue
      if (!alive() || !deps.mayWrite()) {
        throw new Error('model epoch forwarder: the model-epoch key or the write authority was lost before a compensation')
      }
      const message = done.length ? compensationFixMessage(row.message, duplicate, done) : compensationMessage(row.message, duplicate)
      let result = { applied: 0, unmatched: 0 }
      if (ops.length) {
        handle.change((draft: unknown) => { result = applyCompensation(draft, now, ops, row.heads_before) }, { message })
      } else {
        // Nothing to undo (every duplicated element KEPT): the message alone
        // records that this duplicate was handled.
        handle.update((d) => A.emptyChange(d, { message }))
      }
      await flushWithin(deps, handle.documentId)
      const kept = done.length ? [] : plan.kept
      deps.log?.({ event: 'model_epoch.forward.duplicate_compensated', alert: true, target: row.target_document_id,
        duplicate, canonical: row.change_hash, ...result, ...(done.length ? { counterFixOf: done } : {}) })
      if (kept.length) {
        // Not deleted: a user kept one copy, or edited one. Visible twice
        // rather than silently gone; the operator decides.
        deps.log?.({ event: 'model_epoch.forward.duplicate_kept', alert: true, target: row.target_document_id,
          duplicate, canonical: row.change_hash, kept,
          landscapeId: deps.key.landscapeId, versionId: deps.key.versionId })
      }
      out.push({ target: row.target_document_id, duplicate, ...result, ...(kept.length ? { kept } : {}) })
    }
  }
}

async function forwardOne(
  deps: ForwarderDeps, current: CurrentEpoch, source: SourceRow, alive: () => boolean,
): Promise<ForwardSourceReport> {
  const now = deps.now ?? (() => Date.now())
  const lease = deps.leaseMs ?? FORWARD_LEASE_MS
  const ceiling = deps.ceilingMs ?? FORWARD_CEILING_MS
  const started = now()
  const sourceHandle = await findWithin<unknown>(deps, urlOf(source.documentId))
  const sourceDoc = sourceHandle.doc() as A.Doc<unknown>
  const cursor = source.forwardCursor ?? []
  // NOTHING SINCE THE CURSOR: the source's heads ARE its cursor and no
  // journal is open on it — no decode, no fenced write. Before, every such
  // source paid a history walk and a cursor UPDATE to the same value on every
  // pass (28-35 ms each, profiled on the e2e stack), so a pass grew with the
  // number of live superseded documents: 1.6 s at 24, 3.4 s at 68 — past a
  // latch's 2 s, which a continuous writer then never met (measured on an aged
  // stack). The
  // journal bit is the pass's own read (`loadSources`), under the
  // `model-epoch:` key every journal writer holds.
  if (!source.journalOpen && sameHeadSet(cursor, A.getHeads(sourceDoc))) {
    return { documentId: source.documentId, outcome: 'unchanged' }
  }
  const cut = source.cutHeads ?? cursor
  let journal = await readJournal(deps.db, source.documentId)
  if (journal && journal.ownerInstance !== deps.instanceId && journal.heartbeatAgeMs < lease) {
    return { documentId: source.documentId, outcome: 'leased-elsewhere' }
  }
  if (!holdsHeads(sourceDoc, journal ? journal.from : cursor)) {
    return { documentId: source.documentId, outcome: 'missing-cursor-heads' }
  }
  const elemMap = new Map(Object.entries(source.elemMap))
  const forwardSource = (from: A.Heads, to: A.Heads): ForwardSource => ({
    doc: sourceDoc, from, to, cut, elemMap,
    collections: source.role === 'meta' ? META_COLLECTIONS : SHARD_COLLECTIONS,
    excludedRootKeys: source.role === 'meta' ? EPOCH_META_BUILDER_KEYS : NO_KEYS,
  })

  if (!journal) {
    const { advanceTo } = lateChanges(sourceDoc, cursor, current.serverHashes)
    if (advanceTo) {
      await deps.fenced(async (tx) => {
        await tx.query(
          `UPDATE read_model_model_epoch_docs SET forward_cursor = $2::text[], updated_at = now()
            WHERE document_id = $1 AND forward_cursor IS NOT DISTINCT FROM $3::text[]`,
          [source.documentId, advanceTo, cursor])
      })
      return { documentId: source.documentId, outcome: 'advanced' }
    }
    const to = A.getHeads(sourceDoc)
    const routed = await route(deps, current, source, forwardSource(cursor, to))
    const servedPlan = await servedElsewhereFor(deps, current)
    const parts: JournalPart[] = routed.map((target) => ({
      documentId: target.documentId,
      paths: target.paths,
      aligned: target.aligned,
      adoptUrls: target.adoptUrls,
      plannedInserts: planForwardTarget(forwardSource(cursor, to), {
        documentId: target.documentId, doc: target.doc, birthHeads: target.aligned ? birthHeadsOf(target.doc, target.documentId) : null, receives: () => true,
        servedElsewhere: (path) => servedPlan(target.documentId, path),
      }, { entityPaths: target.paths }).plannedInserts,
    }))
    const row: JournalRow = { id: randomUUID(), from: cursor, to, parts, ownerInstance: deps.instanceId, heartbeatAgeMs: 0 }
    // COMMITTED BEFORE ANY WRITE.
    await deps.fenced(async (tx) => {
      await tx.query(
        `INSERT INTO read_model_model_epoch_forwards
           (id, landscape_id, version_id, source_document_id, from_heads, to_heads, parts, owner_instance, heartbeat_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7::jsonb, $8, now())`,
        [row.id, deps.key.landscapeId, deps.key.versionId, source.documentId, row.from, row.to, JSON.stringify(row.parts), deps.instanceId])
    })
    journal = row
  } else {
    const row = journal
    await deps.fenced(async (tx) => {
      await tx.query(`UPDATE read_model_model_epoch_forwards SET owner_instance = $2, heartbeat_at = now() WHERE id = $1`,
        [row.id, deps.instanceId])
    })
  }
  // One change per RECORDED target. A journal with no part (nothing routable:
  // every touched entity is gone from the current epoch's collections) still
  // moves the cursor below, so the same diff is not re-read.
  const open = journal
  const served = await servedElsewhereFor(deps, current)
  let negativeZeroAsZero = 0
  for (const part of open.parts) {
    if (now() - started > ceiling) return { documentId: source.documentId, outcome: 'ceiling', targets: open.parts.length }
    const handle = await findWithin<unknown>(deps, urlOf(part.documentId))
    const message = forwardMessage(open.id, part.documentId)
    const doc = handle.doc() as A.Doc<unknown>
    // Searched after the heads recorded before the write, not the whole
    // history: a replay reads what it wrote.
    const since = part.headsBefore && holdsHeads(doc, part.headsBefore) ? part.headsBefore : undefined
    if (findForwardChange(doc, message, since)) {
      for (const [k, v] of rebuildElemMap(doc, message, part.plannedInserts, since) ?? []) elemMap.set(k, v)
      continue
    }
    await crashPoint(deps.beforeTargetWrite, part.documentId)
    // Re-planned against the target's CURRENT state, recorded, then written.
    const plan = planForwardTarget(forwardSource(open.from, open.to), {
      documentId: part.documentId, doc, birthHeads: part.aligned ? birthHeadsOf(doc, part.documentId) : null, receives: () => true,
      servedElsewhere: (path) => served(part.documentId, path),
    }, { entityPaths: part.paths })
    part.plannedInserts = plan.plannedInserts
    // The clashes this write leaves to the current epoch, recorded with
    // the plan: they become override rows when the forward commits.
    part.overrides = plan.overrides
    // Only ever moved FORWARD: a journal replayed after a crash keeps the
    // heads of its first attempt when the target still lacks the change,
    // so a change that later syncs back from a peer is still found.
    part.headsBefore = part.headsBefore && holdsHeads(doc, part.headsBefore) ? part.headsBefore : [...A.getHeads(doc)]
    await deps.fenced(async (tx) => {
      await tx.query(`UPDATE read_model_model_epoch_forwards SET parts = $2::jsonb, heartbeat_at = now() WHERE id = $1`,
        [open.id, JSON.stringify(open.parts)])
    })
    // The key and the write authority, synchronously before the change.
    if (!alive() || !deps.mayWrite()) {
      throw new Error('model epoch forwarder: the model-epoch key or the write authority was lost before a write')
    }
    handle.change((draft: unknown) => {
      negativeZeroAsZero += applyTargetPlan(draft, plan, sourceDoc, open.to).negativeZeroAsZero
      for (const adopted of part.adoptUrls) appendMetaUrl(draft as object, adopted.field, adopted.url)
    }, { message })
    for (const [k, v] of rebuildElemMap(handle.doc() as A.Doc<unknown>, message, plan.plannedInserts, part.headsBefore) ?? []) elemMap.set(k, v)
    await flushWithin(deps, handle.documentId)
    await crashPoint(deps.afterTargetWrite, part.documentId)
  }
  if (negativeZeroAsZero > 0) {
    // Automerge stores a map's -0 as 0 (measured); the late writer's -0 is
    // forwarded as 0 and counted, never silently.
    deps.log?.({ event: 'model_epoch.forward.negative_zero_as_zero', source: source.documentId, count: negativeZeroAsZero })
  }
  // The CANONICAL change of each target, for the dedupe sweep.
  const writes: Array<{ target: string; message: string; hash: string; headsBefore: string[]; paths: Path[] }> = []
  for (const part of open.parts) {
    const message = forwardMessage(open.id, part.documentId)
    const doc = (await findWithin<unknown>(deps, urlOf(part.documentId))).doc() as A.Doc<unknown>
    const since = part.headsBefore && holdsHeads(doc, part.headsBefore) ? part.headsBefore : []
    const canonical = findForwardChange(doc, message, since)
    if (canonical) writes.push({ target: part.documentId, message, hash: canonical.hash, headsBefore: since, paths: part.paths })
  }
  // THE OVERRIDE ROWS: one per leaf the current epoch won, keyed to the
  // ACTORS of the late changes (only the tab that made them is offered them).
  const lateActors = [...new Set(A.getChangesMetaSince(sourceDoc, open.from)
    .filter((meta) => !current.serverHashes.has(meta.hash)).map((meta) => meta.actor))]
  const overrides: OverrideInsert[] = open.parts.flatMap((part) => {
    const w = writes.find((x) => x.target === part.documentId)
    return (part.overrides ?? []).map((override) => ({
      journalId: open.id, sourceDoc: source.documentId, targetDoc: part.documentId, override,
      currentHeadsAtForward: w ? [w.hash] : [], lateActors,
    }))
  })
  await flushWithin(deps, sourceHandle.documentId)
  await deps.fenced(async (tx) => {
    await insertOverrides(tx, deps.key, overrides)
    const { rowCount } = await tx.query(
      `UPDATE read_model_model_epoch_docs
          SET forward_cursor = $2::text[], elem_map = $4::jsonb, last_late_write_at = now(), updated_at = now()
        WHERE document_id = $1 AND forward_cursor IS NOT DISTINCT FROM $3::text[]`,
      [source.documentId, open.to, open.from, JSON.stringify(Object.fromEntries(elemMap))])
    if ((rowCount ?? 0) !== 1) throw new Error(`model epoch forwarder: the cursor of ${source.documentId} moved under the forward`)
    for (const adopted of open.parts.flatMap((p) => p.adoptUrls)) {
      await tx.query(
        `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role)
         VALUES ($1, $2, $3, $4, 'adopted') ON CONFLICT (document_id) DO NOTHING`,
        [epochDocumentIdOf(adopted.url), deps.key.landscapeId, deps.key.versionId, current.epochNo])
    }
    for (const w of writes) {
      await tx.query(
        `INSERT INTO read_model_model_epoch_forward_writes
           (journal_id, target_document_id, landscape_id, version_id, message, change_hash, heads_before, paths)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb) ON CONFLICT DO NOTHING`,
        [open.id, w.target, deps.key.landscapeId, deps.key.versionId, w.message, w.hash, w.headsBefore, JSON.stringify(w.paths)])
    }
    await tx.query(`DELETE FROM read_model_model_epoch_forwards WHERE id = $1`, [open.id])
  })
  deps.log?.({ event: 'model_epoch.forwarded', source: source.documentId, targets: open.parts.length })
  return {
    documentId: source.documentId, outcome: open.parts.length ? 'forwarded' : 'nothing-routed', targets: open.parts.length,
    ...(negativeZeroAsZero > 0 ? { negativeZeroAsZero } : {}),
  }
}

/**
 * "Served elsewhere": for a target, the NEWEST other overlay
 * segment of the current epoch that holds an entity the target lacks — the
 * value the current epoch serves for it. Overlay lists are read order: a later
 * segment wins, so the search runs from the end.
 */
async function servedElsewhereFor(deps: ForwarderDeps, current: CurrentEpoch): Promise<(targetDocumentId: string, path: Path) => A.Doc<unknown> | undefined> {
  const meta = (await findWithin<unknown>(deps, current.metaUrl)).doc() as A.Doc<unknown>
  const segments: Array<{ id: string; doc: A.Doc<unknown> }> = []
  for (const field of ['editsObjectShardUrls', 'editsConnectionShardUrls'] as const) {
    for (const u of readMetaUrls(meta, field) ?? []) {
      segments.push({ id: epochDocumentIdOf(u), doc: (await findWithin<unknown>(deps, u)).doc() as A.Doc<unknown> })
    }
  }
  return (targetDocumentId, path) => {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]!
      if (segment.id === targetDocumentId) continue
      const map = (segment.doc as Record<string, Record<string, unknown> | undefined>)[String(path[0])]
      if (path.length === 2 && map && Object.prototype.hasOwnProperty.call(map, String(path[1]))) return segment.doc
    }
    return undefined
  }
}

interface RoutedTarget { documentId: string; doc: A.Doc<unknown>; aligned: boolean; paths: Path[]; adoptUrls: AdoptUrl[] }

/** Where each changed entity of the source goes. */
async function route(deps: ForwarderDeps, current: CurrentEpoch, source: SourceRow, forward: ForwardSource): Promise<RoutedTarget[]> {
  const meta = (await findWithin<unknown>(deps, current.metaUrl)).doc() as A.Doc<unknown>
  const paths = changedEntityPaths(forward)
  // ALIGNED only for a target BUILT from this very source: created by the
  // epoch that superseded it, in the same slot. A later epoch's document was
  // built from an intermediate one, whose positions are not the source's.
  // And never a document the epoch only ADOPTED (`built_from_cut` false: the
  // foreign meta `--adopt-root` published; role `adopted`: a browser's
  // overflow shard, slot NULL like an adopted source's): it carries the
  // superseding epoch's number without having been built from anything.
  const aligned = (documentId: string) => {
    const info = current.docs.get(documentId)
    return info !== undefined && info.builtFromCut && info.role !== 'adopted' && info.createdEpoch === source.supersededEpoch
      && (source.role === 'meta' ? info.role === 'meta' : info.slot === source.slot)
  }
  if (source.role === 'meta') {
    const metaId = epochDocumentIdOf(current.metaUrl)
    const adoptUrls: AdoptUrl[] = []
    const atFrom = viewAt(forward.doc, forward.from)
    const atTo = viewAt(forward.doc, forward.to)
    for (const [field, overlayField, headField] of [
      ['objectShardUrls', 'editsObjectShardUrls', 'editsObjectShardUrl'],
      ['connectionShardUrls', 'editsConnectionShardUrls', 'editsConnectionShardUrl'],
    ] as const) {
      const before = new Set(readMetaUrls(atFrom, field) ?? [])
      const overlay = new Set(readMetaUrls(atTo, overlayField) ?? [])
      const head = readMetaUrl(atTo, headField)
      for (const u of readMetaUrls(atTo, field) ?? []) {
        if (!before.has(u) && !overlay.has(u) && u !== head) adoptUrls.push({ field, url: u })
      }
    }
    return [{ documentId: metaId, doc: meta, aligned: aligned(metaId), paths, adoptUrls }]
  }
  const load = async (u: string) => (await findWithin<unknown>(deps, u)).doc() as A.Doc<unknown>
  const bases: Array<{ id: string; doc: A.Doc<unknown> }> = []
  for (const [documentId, info] of current.docs) {
    if (info.role !== 'meta') bases.push({ id: documentId, doc: await load(urlOf(documentId)) })
  }
  const overlays: A.Doc<unknown>[] = []
  for (const field of ['editsObjectShardUrls', 'editsConnectionShardUrls'] as const) {
    for (const u of readMetaUrls(meta, field) ?? []) overlays.push(await load(u))
  }
  const holds = (doc: A.Doc<unknown>, path: Path) => {
    const map = (doc as Record<string, Record<string, unknown> | undefined>)[String(path[0])]
    return path.length === 2 && map !== undefined && Object.prototype.hasOwnProperty.call(map, String(path[1]))
  }
  const bySlot = [...current.docs].find(([, info]) => info.role !== 'meta' && info.slot !== null && info.slot === source.slot)?.[0]
  const targets = new Map<string, RoutedTarget>()
  const add = (documentId: string, doc: A.Doc<unknown>, isAligned: boolean, path: Path) => {
    let t = targets.get(documentId)
    if (!t) { t = { documentId, doc, aligned: isAligned, paths: [], adoptUrls: [] }; targets.set(documentId, t) }
    t.paths.push(path)
  }
  for (const path of paths) {
    const collection = String(path[0])
    const headUrl = readMetaUrl(meta, collection === 'objects' ? 'editsObjectShardUrl' : 'editsConnectionShardUrl')
    if (headUrl && overlays.some((o) => holds(o, path))) {
      add(epochDocumentIdOf(headUrl), await load(headUrl), false, path)
      continue
    }
    const holder = bases.find((b) => holds(b.doc, path))
      ?? bases.find((b) => b.id === bySlot && (b.doc as Record<string, unknown>)[collection] !== undefined)
      ?? bases.find((b) => (b.doc as Record<string, unknown>)[collection] !== undefined)
    if (holder) add(holder.id, holder.doc, aligned(holder.id), path)
  }
  return [...targets.values()]
}

/**
 * THE CURRENT META'S TEXT MIRROR: a build from before the scalar URL fields reads and writes the
 * six text fields an epoch meta is born with, frozen; servers never write
 * them, so every change there comes from such a client. The current meta is
 * therefore a source of its own: from its `mirror_cursor` (initially its
 * birth heads), the two BASE lists of the mirror are diffed, and every URL a
 * client appended — not already ruling, not an overlay segment or head — is
 * ADOPTED into the ruling scalar list (and recorded `adopted`). The overlay
 * lists and heads are the rotator's, and an old client never rotates a head:
 * they are not adopted. Idempotent by value (a URL already ruling is
 * skipped), so a crash between the change and the cursor's CAS costs nothing.
 */
async function forwardMetaMirror(deps: ForwarderDeps, current: CurrentEpoch, alive: () => boolean): Promise<{ adopted: string[] } | null> {
  const metaId = epochDocumentIdOf(current.metaUrl)
  const info = current.docs.get(metaId)
  if (!info || info.createdEpoch === 0) return null // a legacy meta is text-ruled: no mirror
  const { rows } = await deps.db.query<{ mirror_cursor: string[] | null }>(
    'SELECT mirror_cursor FROM read_model_model_epoch_docs WHERE document_id = $1', [metaId])
  const handle = await findWithin<unknown>(deps, current.metaUrl)
  const doc = handle.doc() as A.Doc<unknown>
  if (!metaUrlsAreScalar(doc)) return null
  const recorded = rows[0]?.mirror_cursor ?? null
  const cursor = recorded ?? birthHeadsOf(doc, metaId)
  if (!holdsHeads(doc, cursor)) return null
  const heads = [...A.getHeads(doc)]
  if (sameHeadSet(cursor, heads)) return { adopted: [] }
  const before = A.view(doc, cursor) as Record<string, unknown>
  const overlay = new Set([...(readMetaUrls(doc, 'editsObjectShardUrls') ?? []), ...(readMetaUrls(doc, 'editsConnectionShardUrls') ?? []),
    readMetaUrl(doc, 'editsObjectShardUrl'), readMetaUrl(doc, 'editsConnectionShardUrl')].filter(Boolean) as string[])
  const adopt: AdoptUrl[] = []
  for (const field of ['objectShardUrls', 'connectionShardUrls'] as const) {
    const was = new Set(mirrorList(before[field]))
    const ruling = new Set(readMetaUrls(doc, field) ?? [])
    for (const url of mirrorList((doc as Record<string, unknown>)[field])) {
      if (!was.has(url) && !ruling.has(url) && !overlay.has(url) && isValidAutomergeUrl(url)) adopt.push({ field, url })
    }
  }
  // THE NEW CURSOR is what this pass READ — the heads snapshot taken above —
  // plus its own adoption change, never the handle's heads after the flush:
  // an old client's append that lands while the flush is
  // awaited is in those heads but was never diffed, and would be skipped for
  // ever.
  let nextCursor = heads
  if (adopt.length > 0) {
    if (!alive() || !deps.mayWrite()) {
      throw new Error('model epoch forwarder: the model-epoch key or the write authority was lost before a mirror adoption')
    }
    const message = JSON.stringify({ epochMirrorForward: metaId, from: cursor })
    handle.change((draft: unknown) => {
      for (const a of adopt) appendMetaUrl(draft as object, a.field, a.url)
    }, { message })
    const adoption = A.getChangesMetaSince(handle.doc() as A.Doc<unknown>, heads).find((m) => m.message === message && m.actor === A.getActorId(handle.doc() as A.Doc<unknown>))
    if (adoption) nextCursor = [...heads.filter((h) => !adoption.deps.includes(h)), adoption.hash]
    await flushWithin(deps, handle.documentId)
  }
  await deps.fenced(async (tx) => {
    await tx.query(
      `UPDATE read_model_model_epoch_docs SET mirror_cursor = $2::text[], updated_at = now()
        WHERE document_id = $1 AND mirror_cursor IS NOT DISTINCT FROM $3::text[]`,
      [metaId, nextCursor, recorded])
    for (const a of adopt) {
      await tx.query(
        `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role)
         VALUES ($1, $2, $3, $4, 'adopted') ON CONFLICT (document_id) DO NOTHING`,
        [epochDocumentIdOf(a.url), deps.key.landscapeId, deps.key.versionId, current.epochNo])
    }
  })
  if (adopt.length) deps.log?.({ event: 'model_epoch.mirror_adopted', meta: metaId, urls: adopt.map((a) => a.url) })
  return { adopted: adopt.map((a) => a.url) }
}

const mirrorList = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => elementUrl(v)) : [])
const sameHeadSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i])
