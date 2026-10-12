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

/**
 * Workspace fsck — the document-graph invariants, made runnable.
 *
 * WHY THIS EXISTS. Structural invariants such as "a ModelMeta must carry a
 * durable overlay write head", "a parent pointer must not be published before
 * its child is durable" and "a reachable document must be admitted to its
 * workspace" are only useful if something executes them. This module makes the
 * machine the detector, so a violation is found by a run, not by a reader.
 *
 * SCOPE, deliberately narrow. This checks the DOCUMENT GRAPH: which documents a
 * workspace's root reaches, whether they are present, whether they are admitted,
 * and whether the model can accept a durable write. It does NOT check entity
 * composition (a diagram listing an object id that no longer exists) — that is
 * `referenceIntegrityScan.ts`, which already ships with a console and a repair.
 * Two overlapping scanners would be the same disease this module treats.
 *
 * The analogy worth keeping is `git fsck --connectivity-only`, which asserts that
 * every object referenced by a reachable parent is present, and SQLite's split
 * between `PRAGMA integrity_check` (structure) and `PRAGMA foreign_key_check`
 * (references) — even SQLite treats those as two different passes.
 *
 * READ-ONLY. It repairs nothing. Repair paths already exist and are separately
 * gated (`degenerateRootRepair`, `overlaySegments.createSegment`); a checker that
 * also mutates cannot be run freely, and one that cannot be run freely is one
 * that does not get run.
 */

import { isValidAutomergeUrl, type Repo } from '@automerge/automerge-repo'
import type { WorkspaceKey } from '../readModel/projector.js'
import type { Queryable } from '../readModel/types.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { documentContentChunkFilter } from '../automergeStorage.js'
import { isStructurallyHealthyRoot } from './degenerateRootRepair.js'
import { CLAIM_PROTOCOL_VERSION } from '../rbac/documentClaims.js'
// The SAME predicate the baseline write fence applies, never a local copy of it:
// a second definition would drift from the fence and this check would then
// certify a workspace the fence is freezing.
import { isBaselineDocumentKind } from '../rbac/docScope.js'
import {
  OVERLAY_CHAIN_FOLD_MIN,
  OVERLAY_SEGMENT_ENTITY_CEILING,
} from '../readModel/overlayChainFold.js'
import { OVERLAY_SEGMENT_SIZE } from '../overlaySegments.js'
// Same reason as `isBaselineDocumentKind` above, one field over: this check
// exists to catch a meta the CLIENT would treat as legacy, so its threshold has
// to be the number the client compares against. Restating `1` here would make
// the detector and the producer two independent copies that can drift.
import { OVERLAY_WRITE_HEAD_VERSION } from '../modelMeta.js'
import { enumerateMaintainableWorkspaces } from './maintainableWorkspaces.js'

export type FsckSeverity =
  /** A user edit is accepted by the UI and never reaches durable storage. */
  | 'data-loss'
  /** Writes land but a client can never be told they did; the badge lies. */
  | 'sync-stall'
  /** Something is reachable-but-broken; the workspace still functions. */
  | 'degraded'

/** Every check this module knows how to run. Adding a row here is how an
 * invariant stops being folklore — see the module doc. */
export const FSCK_CHECKS = {
  'root-structure': 'The root document names a model and at least one registry shard.',
  'model-write-head': 'A sharded model carries a durable object AND connection overlay write head.',
  'write-head-version': 'The overlay write heads use the current bounded write-head protocol.',
  'document-present': 'Every document reachable from the root exists in storage.',
  'document-admitted': 'Every reachable document is mapped to this workspace.',
  'document-orphaned': 'Every document mapped to this workspace is reachable from its root.',
  'summary-static-coherence': 'A summary-only root and a read-model static workspace row imply each other.',
  'static-allow-list-orphaned': 'No read_model_static_documents rows survive without their workspace row.',
  'static-allow-list-empty': 'A static workspace has a non-empty allow-list, or nothing in it resolves.',
  'claim-coverage': 'A coverage-marked workspace has no reachable document missing its claim.',
  'diagram-tombstone-honoured': 'Every id in ModelMeta.deletedDiagramIds is absent from ro_diagrams.',
  'registry-head-projected': 'Every diagram in the registry write head has a ro_diagrams row.',
  'overlay-chain-bounded': 'The overlay segment chains are short enough that the D3 folder is running.',
  'overlay-head-bounded': 'The current overlay write heads are small enough that the rotation is running.',
  'overlay-segment-bounded': 'No LISTED overlay segment has grown past the size the fold bounds it to.',
  'overlay-segment-retained': 'Every overlay segment still inside its retention window exists in storage.',
  'write-head-writable': 'The registry write head is listed with a WRITABLE kind, never a baseline kind.',
} as const

/** PARK-level checks — they look ACROSS workspaces, so they can never appear
 * in a per-workspace report's checksRun/checksSkipped. Kept in a separate
 * registry on purpose: a check listed in {@link FSCK_CHECKS} but wired nowhere
 * would let a run report `clean` while silently not checking it — the exact
 * false-PASS shape this module exists to kill (per-workspace coverage is
 * asserted against FSCK_CHECKS in the tests). */
export const FSCK_PARK_CHECKS = {
  'shared-root': 'No two workspaces point at the same root document.',
} as const

export type FsckCheckCode = keyof typeof FSCK_CHECKS

/** One measurement of a current overlay write head. */
export interface OverlayWriteHeadSize {
  field: 'editsObjectShardUrl' | 'editsConnectionShardUrl'
  url: string
  /**
   * Entities in the head — `objects` or `connections`, whichever the collection
   * is. `null` when the document could not be resolved, NEVER 0: a zero here
   * reads as "the head is empty", which is the healthiest possible answer to a
   * question nobody was able to ask.
   */
  entities: number | null
  /** Unique `writeBatchIds`, the head's OTHER rotation trigger. Same null rule. */
  batches: number | null
  /**
   * How long since a durable byte last reached this head, from
   * `read_model_static_document_queue.enqueued_at` — the column the STORAGE
   * adapter stamps, never the projector. `null` when there is no row or no
   * queue table, which is unknown and not "for ever": a missing row would make
   * every over-full head look quiescent, i.e. would turn the conjunct that
   * defends against bulk imports into a rubber stamp.
   */
  quietForMs: number | null
  /**
   * `octet_length` of the head's chunks in `automerge_storage`, or `null` when
   * it could not be summed. A HEADLINE number and never a finding — bytes have
   * no ceiling this module can derive, and the rule stated three times above
   * says growth without a derivable bound gets a number, not a violation.
   *
   * It earns its place by covering what the check cannot: it is written by the
   * storage path, so it reports on a workspace with no projector at all, and it
   * needs no quiescence, so it reports on one edited around the clock.
   */
  bytes: number | null
}

export interface FsckFinding {
  check: FsckCheckCode
  severity: FsckSeverity
  detail: string
  /** The document the finding is about, when a single one is to blame. */
  documentUrl?: string
}

export interface WorkspaceFsckReport {
  workspace: WorkspaceKey
  rootUrl: string
  /**
   * `clean` is only reachable when EVERY check ran. A workspace whose root could
   * not be resolved is `incomplete`, never `clean`: "nothing
   * outstanding" is only true once everything has been looked at, and a pass that
   * reports from inside itself reports on how far it got.
   */
  status: 'clean' | 'violations' | 'incomplete'
  findings: FsckFinding[]
  checksRun: FsckCheckCode[]
  checksSkipped: { check: FsckCheckCode; reason: string }[]
  /** Documents reachable from the root, for the caller's own accounting. */
  reachableDocuments: number
  /**
   * How many ids `ModelMeta.deletedDiagramIds` carries.
   *
   * The list is unbounded and append-only, on the ONE document a summary
   * client must materialize to boot, so its growth is surveilled here until
   * the tombstone folder trims it. `diagram-tombstone-honoured`
   * only compares the list with `ro_diagrams`, so a workspace with 10 000
   * perfectly honoured tombstones is `clean` and says nothing about its size.
   * This is that number, reported by the one pass that already resolves the
   * document — no new read, no Automerge access beyond what fsck holds.
   */
  diagramTombstoneCount: number
  /**
   * How many entries the registry WRITE HEAD carries, or null when there is no
   * write head (a monolith workspace).
   *
   * The head is NOT bounded by SHARD_SIZE: `findOrCreateSummaryWriteShard`
   * (`bridge.ts`) reuses `root.registryWriteUrl` with NO size test, unlike its
   * twin `findOrCreateShardForNew`, and nothing else rotates it — so it holds
   * every diagram ever created on the workspace, and the reconciliation reads
   * it in full on the CREATION path.
   *
   * This is deliberately a NUMBER IN THE HEADLINE and not an `FSCK_CHECKS` row,
   * on the precedent set by `diagramTombstoneCount` right above: a workspace
   * that has legitimately accumulated diagrams is not broken, and turning growth
   * into a violation would make `npm run fsck` exit non-zero for it — diluting
   * the one property that makes `clean` worth reading. What it provides is
   * VISIBILITY.
   */
  registryWriteHeadDiagramCount: number | null
  /**
   * How many bytes of `automerge_storage` sit behind the BUDGETED half of a
   * boot: the root, the ModelMeta, and every registry shard — EXACTLY the set
   * the browser resolves under `BOOT_DOCUMENT_RESOLUTION` (`repo.ts`), and
   * therefore exactly the set whose transfer the 22 000 ms ceiling schedule
   * has to cover. Diagram documents are reachable but are not on this path.
   *
   * NOT "everything a client pulls before it paints". It misses in BOTH
   * directions:
   *
   *  - it UNDER-states a classic boot. `bootFromServer` off also materializes
   *    the MODEL shards, and those resolve unbudgeted. On a workspace with few
   *    objects the two sets nearly coincide; on an object-rich one they do not.
   *  - it OVER-states a summary workspace, by a lot: its root still lists
   *    registry shards (tens of MB on a large landscape) that a summary client
   *    never resolves. What is summed there is the weight of a LIST, not of a
   *    boot.
   *
   * So: the right number for sizing a per-document resolution budget, which is
   * what it is used for, and the wrong one for predicting time-to-paint or for
   * ranking workspaces by how hard they are to boot.
   *
   * Same precedent as the two counts above: a number in the headline, never an
   * `FSCK_CHECKS` row. A workspace that has legitimately grown is not broken,
   * and failing `npm run fsck` for size would dilute the one property that
   * makes `clean` worth reading.
   *
   * Boot documents are NOT all small: on a 3 000-diagram landscape this set was
   * ~6.7 MB across 16 registry shards, with a single shard of ~2.4 MB — served
   * one at a time by the single-threaded sync server, enough to blow a 3 s
   * per-document window. This number makes that visible without decoding
   * Automerge chunks by hand.
   */
  bootCriticalBytes: number
  /** The largest single document of that set — the one whose transfer time a
   * per-document resolution window has to cover on its own. */
  largestBootDocumentBytes: number
  /**
   * Bytes behind the CURRENT overlay write heads, and `null` when the sum could
   * not be taken.
   *
   * A number in the headline and never an `FSCK_CHECKS` row, on the precedent
   * of the three counts above: bytes have no ceiling this module can derive
   * from a producer, and growth without a derivable bound is not a violation.
   *
   * It is here because it covers the two cases `overlay-head-bounded` is
   * structurally unable to reach. That check skips on an ordinary workspace
   * (nothing rotates those heads, so a full one is not a fault) and skips when
   * the head will not resolve — and it stays silent on a workspace under
   * continuous writes, which never goes quiescent. This is written by the
   * storage adapter on every flush, so it reports through all three.
   */
  overlayWriteHeadBytes: number | null
  /**
   * The EFFECTIVE `OVERLAY_SEGMENT_SIZE` and `OVERLAY_HEAD_CEILING` this run
   * judged with.
   *
   * Both are read from `AM_OVERLAY_SEGMENT_SIZE` in the environment of the
   * process that runs the check, and `scripts/fsck-workspaces.ts` takes that
   * from `server/.env` while the server it is checking takes it from a compose
   * file. So "derived from the producer" holds inside one process and not
   * across the two, and a `clean` run otherwise says nothing about which
   * ceiling produced it. Reporting them is not a fix — it is the difference
   * between a reader who can notice and one who cannot.
   */
  overlaySegmentSize: number
  overlayHeadCeiling: number
}

type PlainDoc = Record<string, unknown> | undefined

const urlList = (value: unknown): string[] => (
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && isValidAutomergeUrl(entry)) : []
)

const url = (value: unknown): string | null => (
  typeof value === 'string' && isValidAutomergeUrl(value) ? value : null
)

export const documentIdOf = (value: string): string => value.replace(/^automerge:/, '').split('?')[0]

/**
 * Storage keys automerge-repo owns that are NOT documents.
 *
 * The repo writes its own peer identity under the bare key `storage-adapter-id`.
 * It sits in `automerge_storage` beside real chunks, so `split_part(key, '/', 1)`
 * yields it as if it were a document id, and any admission path that maps a
 * storage key to a workspace can put it in `automerge_document_workspace` too.
 * It is then unreachable from the root BY CONSTRUCTION — it has no root, no
 * parent and no referent — so `document-orphaned` reports it on a workspace
 * that is in fact clean.
 *
 * `backupRestore.ts` special-cases the same key, hence a named predicate rather
 * than repeated inline string compares. An alarm that fires on the ordinary
 * bootstrap gets muted, and then it protects nothing.
 */
export const isRepoBookkeepingKey = (id: string): boolean => id === 'storage-adapter-id'

/**
 * Every document URL reachable from the root, excluding the root itself.
 *
 * Mirrors what a client actually follows on boot. `registries` must be the
 * resolved contents of `root.shardUrls`; a registry that could not be resolved
 * is passed as `undefined` and its diagrams are simply not reachable from here —
 * the caller reports that as a skipped check rather than as an empty result.
 */
export function collectReferencedUrls(
  root: PlainDoc,
  modelMeta: PlainDoc,
  registries: readonly PlainDoc[],
): string[] {
  const out = new Set<string>()
  const add = (value: unknown) => { const u = url(value); if (u) out.add(u) }

  add(root?.modelUrl)
  add(root?.modelMetaUrl)
  for (const shard of urlList(root?.shardUrls)) out.add(shard)
  add(root?.registryWriteUrl)

  for (const key of ['objectShardUrls', 'connectionShardUrls', 'decisionRecordShardUrls',
    'editsObjectShardUrls', 'editsConnectionShardUrls'] as const) {
    for (const shard of urlList(modelMeta?.[key])) out.add(shard)
  }
  add(modelMeta?.editsObjectShardUrl)
  add(modelMeta?.editsConnectionShardUrl)

  for (const registry of registries) {
    const diagrams = registry?.diagrams
    if (!diagrams || typeof diagrams !== 'object' || Array.isArray(diagrams)) continue
    for (const entry of Object.values(diagrams as Record<string, { docUrl?: unknown }>)) {
      add(entry?.docUrl)
    }
  }
  return [...out]
}

/**
 * KNOWN LIMIT: the "required, not defaulted" discipline on `staticSource`,
 * `claimCoverage` and the other required fields below holds by convention, not
 * by the compiler — TypeScript cannot forbid a future `?` (the optionality
 * would compile, and every caller that forgot the fact would silently pass the
 * corresponding check). Do not make them optional.
 */
export interface StructureCheckInput {
  rootUrl: string
  root: PlainDoc
  /** `undefined` when the root names no ModelMeta (a monolith workspace). */
  modelMeta: PlainDoc
  /** True when the root DOES name a ModelMeta but it could not be resolved. */
  modelMetaUnresolved?: boolean
  /** Registry shards that failed to resolve, so their diagrams are unknown. */
  unresolvedRegistries?: readonly string[]
  referenced: readonly string[]
  /** Document IDs (not URLs) found in `automerge_storage`. */
  presentIds: ReadonlySet<string>
  /** ALL document IDs mapped to this workspace in `automerge_document_workspace`
   * — the complete admission set, not just the reachable slice. `document-admitted`
   * only tests membership of reachable ids, and `document-orphaned` needs the
   * whole set to find admissions the graph no longer references. */
  admittedIds: ReadonlySet<string>
  /** `read_model_static_workspaces.source` for this workspace, or null when it
   * has no row. Required (not defaulted) on purpose: a caller that forgets it
   * would silently pass the coherence check for every workspace, which is the
   * false-PASS shape this module exists to kill. */
  staticSource: string | null
  /**
   * How many `read_model_static_documents` rows this workspace has, or
   * NULL when the question could not be asked at all (a database predating the
   * read model has no such table).
   *
   * Null is not zero, and collapsing them is the false-PASS shape this module
   * exists to kill: zero makes "no orphans" vacuously true and the check
   * reports `clean` for a database it never looked at.
   *
   * The pair (`staticSource === null`, this `> 0`) is one fact recorded in two
   * tables that can disagree (legacy orphaned allow-list rows predate the
   * foreign key). The projector joins the authority, so a surviving row is
   * inert rather than dangerous — which is exactly when it needs a detector,
   * because nothing else will ever notice it.
   */
  staticDocumentRows: number | null
  /** The document-claim coverage marker (`workspace_claim_coverage`, protocol
   * already compared by the reader), or null when the workspace has no row.
   * Required-not-defaulted for the same reason as `staticSource`: a forgotten
   * marker would silently skip `claim-coverage` for every workspace. */
  claimCoverage: { covered: boolean } | null
  /**
   * `ModelMeta.deletedDiagramIds`, deduplicated. Required (not defaulted)
   * for the same reason as `staticSource`: a caller that forgot it would
   * silently pass the check for every workspace.
   */
  diagramTombstones: readonly string[]
  /** The subset of {@link diagramTombstones} that STILL has a `ro_diagrams`
   * row, or NULL when that question could not be answered at all (a database
   * predating the read model has no such table). Answered by SQL — resolving
   * each diagram document would make the checker cost what it is checking
   * (module rule 4).
   *
   * Null is not the empty set: an empty set makes "every tombstoned id is
   * absent" vacuously TRUE and the check reports
   * `ran`, so a run that could not look reports `clean`. That is module rule 1
   * broken from the inside. */
  liveTombstonedDiagramIds: ReadonlySet<string> | null
  /**
   * `root.registryWriteUrl`, or null when the root names no write head.
   *
   * Required (not defaulted) for the same reason as `staticSource`: a caller
   * that forgot it would make every workspace look like a monolith and skip the
   * check silently, which is the false-PASS shape this module exists to kill.
   */
  registryWriteHeadUrl: string | null
  /**
   * Every `read_model_static_documents.kind` the BASELINE WRITE FENCE would see
   * for the write head — i.e. across ALL static workspaces, not just this one,
   * because the fence's lookup is global by `document_id`.
   *
   * Three distinct values, and collapsing any two of them is a false PASS:
   *   - a non-empty list — the fence sees these kinds;
   *   - `[]` — an ANSWER: nothing lists this document, so it is not fenced;
   *   - `null` — could not look (the table is missing), so the check SKIPS.
   *
   * Optional ONLY so the ~30 existing partial test inputs keep compiling; a
   * caller that omits it gets the skip, never a silent pass.
   */
  registryWriteHeadStaticKinds?: readonly string[] | null
  /** The diagram ids the write-head document carries, or null when that
   * document did not resolve (nothing can then be asserted about it). */
  registryWriteHeadDiagramIds: readonly string[] | null
  /** The subset of {@link registryWriteHeadDiagramIds} that HAS a `ro_diagrams`
   * row, or NULL when that question could not be answered (no `ro_diagrams`).
   * Answered by SQL, like the tombstone pair above — module rule 4.
   *
   * Here the null/empty confusion would invert the verdict rather than mute
   * it: the empty set would make the check emit ONE FINDING PER DIAGRAM of the
   * write head on a database that simply predates the read model. */
  projectedWriteHeadDiagramIds: ReadonlySet<string> | null
  /**
   * How long the write head's projection has been PENDING, in
   * milliseconds (`now() - enqueued_at` where `revision > projected_revision`),
   * or null when nothing is pending for it.
   *
   * Projection is asynchronous, so on a live stack an edit in flight makes the
   * head legitimately run ahead of `ro_diagrams`; without this, the check would
   * report `sync-stall` for a workspace that is merely busy. A BOUNDED lag is
   * tolerated and says so; an unbounded one is still a violation, and so is a
   * head that is never enqueued at all (no pending row to be lenient about).
   */
  registryWriteHeadProjectionLagMs: number | null
  /**
   * The overlay segments this workspace still owes an offline client,
   * i.e. `read_model_overlay_segments` rows that are current or still inside
   * their `retain_until` window. NULL when the question could not be answered
   * (a database predating the overlay-history schema), and the empty array when
   * there was nothing to look at.
   *
   * Required-not-defaulted, and null is not the empty set, for the reason the
   * tombstone pair above spells out: a caller that forgot it would make
   * `overlay-segment-retained` vacuously true and report `ran`, so a run that
   * could not look would report `clean`.
   *
   * It has TWO consumers, and the second one matters as much as the check:
   * `document-orphaned` exempts these ids. A fold removes a prefix from
   * ModelMeta while deliberately keeping its admission rows, so without the
   * exemption one fold pass turns a `clean` workspace into 32 `degraded`
   * findings and the alarm gets muted — which also means this list HIDES the
   * one orphan a crash inside the fold's publish window can leave behind. That
   * is the explicit price of the fold having no intent table.
   */
  retainedOverlaySegments: readonly { documentId: string; collection: string }[] | null
  /**
   * The size of each CURRENT overlay write head named by the ModelMeta, or
   * `undefined` when the caller did not measure them (which makes the run
   * incomplete, never clean).
   *
   * Measured from the DOCUMENT and from nothing else. The three cheaper sources
   * were all considered and all are fed by the very projector whose rotation
   * has stopped, so each is silenced by the fault it would report:
   *
   *  - `read_model_overlay_segments.last_projected_snapshot` is written by the
   *    projector and is `NOT NULL DEFAULT '{}'`, so an unprojected head reads
   *    EMPTY, i.e. clean. `foldOverlayChain` refuses to read it for exactly
   *    this reason and says so in its own comment;
   *  - `read_model_overlay_batch_acks` rows are written by the projector's
   *    acknowledgement, so a projector that is not running writes none;
   *  - `octet_length` in `automerge_storage` survives a dead projector, but it
   *    is a PROXY for the promised quantity and the promise is stated in
   *    entities and batches, not bytes.
   *
   * Two documents per workspace, not thousands — the cost objection that keeps
   * presence and admission in SQL does not reach this far.
   */
  overlayWriteHeads?: readonly OverlayWriteHeadSize[]
  /**
   * The size of every segment the ModelMeta LISTS, heads included, or
   * `undefined` when the caller did not measure them.
   *
   * Distinct from {@link overlayWriteHeads}, which reads the two CURRENT heads
   * and is the rotation's detector. This one is the FOLD's: its output is never
   * a current head, so nothing above can see it.
   */
  overlaySegmentSizes?: readonly OverlaySegmentSize[]
}

/**
 * How long an overlay chain may get before the length stops being growth
 * and starts being "the folder is not running".
 *
 * Four times the fold threshold, DERIVED rather than invented. A ceiling any
 * tighter would fire on the ordinary case — an alarm that screams at a
 * workspace which merely grew is an alarm that gets muted.
 *
 * Through the real planner, a healthy chain oscillates between roughly 34 and
 * 65 segments and a workspace converging from a long legacy chain walks down
 * ~31 net per pass (32 removed, one inserted), so this ceiling has ample
 * headroom.
 *
 * THE RELATION THAT MATTERS, since a segment is bounded at
 * `OVERLAY_SEGMENT_ENTITY_CEILING`: a sealed run holds `ceil(D / ceiling)`
 * segments for D distinct entities, so this constant and that one are two ends
 * of one capacity — `D <= ceiling * (OVERLAY_CHAIN_CEILING - minChain - 1)`,
 * which is 1 024 x 191 = 195 584 entities today. `overlay-segment-bounded`
 * reports the operand; `overlayChainFold.test.ts` asserts the relation holds
 * for the reference landscape, so moving either number without the other fails
 * a test rather than making this check permanently red. A permanently red check
 * is a muted check.
 */
export const OVERLAY_CHAIN_CEILING = 4 * OVERLAY_CHAIN_FOLD_MIN

/**
 * How big the CURRENT overlay write head may get before the rotation that is
 * supposed to retire it has provably stopped running.
 *
 * `OVERLAY_SEGMENT_SIZE` is imported from the producer, never restated: it is
 * the exact number `maybeRotateOverlayHead` schedules a rotation at.
 *
 * Four times, as the chain's ceiling is — and the reason it can be this tight
 * is the QUIESCENCE conjunct below, not slack. A generous multiple cannot buy
 * immunity to bulk imports: a ~12k-object import is written into one head
 * (`bridge.ts` declines to rotate and defers, `owner: 'server'`), which clears
 * 16x as easily as 4x. A multiple cannot separate a burst from a dead rotator,
 * at any value — only TIME can.
 *
 * @see OVERLAY_HEAD_ROTATION_GRACE_MS, which is what actually does it.
 *
 * KNOWN LIMIT, shared with `OVERLAY_CHAIN_CEILING`: the derivation holds within
 * ONE PROCESS.
 * This constant reads `AM_OVERLAY_SEGMENT_SIZE` from the environment of
 * whatever runs it, and `scripts/fsck-workspaces.ts` does `import
 * 'dotenv/config'` — so a CLI run picks the knob up from `server/.env` while
 * the deployed server takes it from a compose file or a task definition. Unset
 * on one side and 8 on the other, the ceiling is 64x looser than the promise it
 * checks. Not fixable by importing harder; the report therefore carries the
 * EFFECTIVE numbers it used (`overlaySegmentSize`, `overlayHeadCeiling`), so a
 * `clean` run says which ceiling produced it instead of leaving the reader to
 * assume the default.
 */
export const OVERLAY_HEAD_CEILING = 4 * OVERLAY_SEGMENT_SIZE

/**
 * How many BYTES a listed overlay segment may hold before its size is a
 * defect rather than a workload.
 *
 * WHY THIS CHECK HAS TO EXIST, and why neither neighbour could stand in for it.
 * `overlay-chain-bounded` reads the chain's LENGTH and `overlay-head-bounded`
 * reads only the two CURRENT heads, so a retired segment's size is measured by
 * nothing else — and the fold's merged output is never a current head. Worse
 * than a gap: the fold collapses N segments into one, so as the merged document
 * grows the chain gets SHORTER and `overlay-chain-bounded` reads greener the
 * worse the fault gets. Without this row, one ~12k-entity merged segment would
 * report `clean` on every other check.
 *
 * WHY BYTES AND NOT ENTITIES. The bound the fold enforces is in entities
 * (`OVERLAY_SEGMENT_ENTITY_CEILING`), but every entity-valued source is fed by
 * the projector whose fold has stopped — the same argument
 * `overlayWriteHeads` makes for its three rejected sources, and
 * `last_projected_snapshot` is `NOT NULL DEFAULT '{}'` so an unprojected
 * segment reads EMPTY, i.e. clean. `octet_length` in `automerge_storage`
 * survives a dead projector, so it is the only operand a failing system cannot
 * flatter. It is a PROXY, and that is stated rather than implied.
 *
 * THE CONVERSION: an `ObjectInput` costs roughly 108 B/entity (9 fields) to
 * 212 B/entity (12 fields, the shape real corpora carry) of
 * `automerge_storage`. 1 024 B/entity is ~5x the larger, so a legitimately
 * rich entity cannot trip this, and the separation is still wide: a correctly
 * bounded segment is ~100-220 kB against a 1 MB ceiling, while a runaway merged
 * segment on a ~12k-entity landscape is 1.2-2.6 MB and fires.
 *
 * A LITERAL, NOT `OVERLAY_SEGMENT_ENTITY_CEILING * 1_024`: that product would
 * make one knob both disable the mechanism AND raise the ceiling of its
 * detector (e.g. `AM_OVERLAY_SEGMENT_ENTITY_CEILING=65536` would seal nothing
 * and move this ceiling to 64 MB, silencing the check). The literal test in
 * `workspaceFsck.test.ts` pins this.
 *
 * So the detector's threshold is fixed and the producer's is tunable. They are
 * ALLOWED to disagree: a deployment that raises the entity ceiling above
 * ~4 900 entities (1 MB / 212 B) will see this fire, which is the correct
 * direction — a bigger segment is a bigger segment whatever the knob says.
 */
export const OVERLAY_SEGMENT_BYTE_CEILING = 1_048_576

/**
 * How long a head must be past the ceiling AND durably QUIET before the
 * rotation is called dead rather than late.
 *
 * This is the conjunct that makes the check possible at all. A head over its
 * bound is, on its own, two indistinguishable things: a bulk import still
 * landing, and a rotation that will never run. What separates them is that a
 * healthy rotation empties the head within its debounce
 * (`AM_OVERLAY_ROTATION_MAX_DELAY_MS`, 30 s by default) of the writes stopping.
 * So a head still full five minutes after the last durable byte reached it has
 * had its chance ten times over.
 *
 * Quiescence is read from `read_model_static_document_queue.enqueued_at`, which
 * `PostgresStorageAdapter` stamps in the SAME transaction as the chunk write
 * (`automergeStorage.ts`). That matters more than the number: it is written by
 * the STORAGE path, not by the projector, so it is the one fact in this check
 * that a dead projector cannot freeze. `registryWriteHeadProjectionLagMs`
 * already reads the same column, one indexed lookup on the primary key.
 *
 * SIXTY-FIVE MINUTES, set by the debounce's reachable MAXIMUM rather than its
 * default: `AM_OVERLAY_ROTATION_MAX_DELAY_MS` is clamped `maximum: 3_600_000`
 * (`staticDeltaProjector.ts`). A shorter grace would make this check report
 * `degraded` on a workspace whose rotation is merely PENDING under a raised
 * debounce.
 *
 * The rule for exactly this shape — a second mechanism sized against
 * the first — is to make it fire AFTER the one it waits on, and to assert the
 * relation in a test, because the argument lives as prose in another module.
 * The tests pin it against 3 600 000 as a LITERAL. The projector's constant is
 * not imported: doing so would only move the cross-process problem above onto a
 * second knob, and would make the assertion agree with any value that knob is
 * given.
 *
 * The cost is detection latency on a fault that is permanent by definition,
 * which is the cheapest thing there is to spend.
 *
 * THE BLIND SPOT, named rather than left to be found: a head under genuinely
 * continuous writes never goes quiet, so this check stays silent on a
 * workspace edited around the clock with a dead rotator. That case is covered
 * by `overlayWriteHeadBytes` in the headline, which is reported on every run
 * and needs no quiescence.
 */
export const OVERLAY_HEAD_ROTATION_GRACE_MS = 3_900_000

/** How long a write-head projection may be in flight before the gap stops
 * being latency and starts being a stall. Long enough to cover a projection of
 * a large workspace, short enough that a wedged projector is still reported by
 * the next run rather than tolerated for ever. */
export const REGISTRY_HEAD_PROJECTION_GRACE_MS = 60_000

/**
 * The whole verdict, as a pure function of already-gathered facts.
 *
 * Kept pure on purpose: the deciding code is what has to be testable without
 * a database or a repo.
 */
export function checkWorkspaceStructure(input: StructureCheckInput): {
  findings: FsckFinding[]
  checksRun: FsckCheckCode[]
  checksSkipped: { check: FsckCheckCode; reason: string }[]
} {
  const findings: FsckFinding[] = []
  const checksRun: FsckCheckCode[] = []
  const checksSkipped: { check: FsckCheckCode; reason: string }[] = []
  const ran = (check: FsckCheckCode) => checksRun.push(check)
  const skip = (check: FsckCheckCode, reason: string) => checksSkipped.push({ check, reason })
  const isPresent = (value: string) => input.presentIds.has(documentIdOf(value))
  const isAdmitted = (value: string) => input.admittedIds.has(documentIdOf(value))

  // ── root-structure ────────────────────────────────────────────────────────
  if (!input.root) {
    skip('root-structure', 'the root document did not resolve')
  } else {
    ran('root-structure')
    if (!isStructurallyHealthyRoot(input.root)) {
      findings.push({
        check: 'root-structure',
        severity: 'degraded',
        detail: 'the root names no model, or has no valid registry shard, or is summary-only without a write head',
        documentUrl: input.rootUrl,
      })
    }
  }

  // ── summary-static-coherence ──────────────────────────────────────────────
  // Every summary producer also inserts a `read_model_static_workspaces` row,
  // so the flag and the row must imply each other. Every root reconstruction
  // goes through the ONE root-shape mapper (rootShape.ts) so the flag is not
  // dropped; this check is the production-data detector for any future
  // producer or stripper that breaks the pairing.
  if (!input.root) {
    skip('summary-static-coherence', 'the root document did not resolve')
  } else {
    ran('summary-static-coherence')
    const summaryOnly = input.root.registrySummaryOnly === true
    if (summaryOnly && input.staticSource === null) {
      findings.push({
        check: 'summary-static-coherence',
        severity: 'data-loss',
        detail: 'summary-only root with no read_model_static_workspaces row: the walk skips the '
          + 'registry by design and baseline shards are server-owned, so without the read model '
          + 'no client can list or open the diagrams — content is intact in storage but '
          + 'unreachable for every cold client',
        documentUrl: input.rootUrl,
      })
    } else if (!summaryOnly && input.staticSource !== null) {
      findings.push({
        check: 'summary-static-coherence',
        severity: 'degraded',
        detail: `static workspace row (source: ${input.staticSource}) but the root is not summary-only: `
          + 'resolveDurable applies the static_allowed filter, so documents outside '
          + 'read_model_static_documents stop resolving durably after a restart, and the workspace '
          + 'pays the unbounded classic walk that summary mode exists to avoid '
          + '(seen live on benchmark fixtures whose flag was removed by hand)',
        documentUrl: input.rootUrl,
      })
    }
  }

  // ── static-allow-list-orphaned ────────────────────────────────────────────
  // Deliberately NOT gated on the root resolving: an orphaned allow-list
  // is a purely relational fact, and the workspaces most likely to carry one
  // are exactly those whose root is in a state that makes the other checks
  // skip. Gating it on the root would silence it where it matters most.
  //
  // `typeof !== 'number'`, NOT `=== null`. Test files are excluded from
  // `tsc`, so a caller that forgets the field hands over `undefined`, and
  // `undefined === null` is false — the check would then RUN and report no
  // orphans for a count nobody took.
  if (typeof input.staticDocumentRows !== 'number') {
    skip('static-allow-list-orphaned', 'the read_model_static_documents count was not taken')
  } else {
    ran('static-allow-list-orphaned')
    if (input.staticSource === null && input.staticDocumentRows > 0) {
      findings.push({
        check: 'static-allow-list-orphaned',
        severity: 'degraded',
        detail: `${input.staticDocumentRows} read_model_static_documents row(s) with no `
          + 'read_model_static_workspaces row. Two producers, and they need different remedies: '
          + 'a demotion followed by a static-projector write that re-created the allow-list '
          + '(the projector now joins the authority to READ, but projectMeta/projectRoot still '
          + 'write on a bare pool), or a performance re-seed that died between clearWorkspace — '
          + 'which deletes the workspace row and deliberately NOT the documents — and '
          + 'markStaticReadModelWorkspace. The rows are inert either way, which is precisely '
          + 'why nothing else would ever report them. Removing them is one idempotent DELETE '
          + 'scoped to this workspace; there is no automated repair yet',
      })
    }
  }

  // ── static-allow-list-empty ───────────────────────────────────────────────
  // THE SECOND HALF OF THE SUMMARY CONTRACT, and the half a HALF-PROMOTED
  // workspace falls through.
  //
  // The two checks above cover one direction each and leave this one open:
  // `summary-static-coherence` pairs the ROOT FLAG with the WORKSPACE ROW, and
  // `static-allow-list-orphaned` catches DOCUMENT rows with no workspace row.
  // Neither looks at a workspace row whose allow-list is EMPTY — and that state
  // is not inert, it is total:
  //
  //   docScope.ts (resolveDurable) — `if (row.static_source && !row.static_allowed) return null`
  //
  // `static_allowed` is an EXISTS against `read_model_static_documents` for that
  // one document. With the workspace row present and the allow-list empty, that
  // EXISTS is false for EVERY document in the workspace, so `resolveDurable`
  // returns null for all of them: nothing opens, nothing lists, and the previous
  // two checks both report clean.
  //
  // ZERO IS ALWAYS WRONG HERE, and that is a property of the producer rather
  // than an assumption: `markStaticReadModelWorkspace` writes the workspace row
  // and the entries in ONE call (promoteSummaryWorkspace.ts), and the entries it
  // is given always contain the root, the ModelMeta and the baseline shards. A
  // static workspace with zero allowed documents therefore cannot be the output
  // of a completed promotion — only of one that died between its writes, or of a
  // later DELETE that took the documents and left the row.
  //
  // `data-loss`, matching `summary-static-coherence`'s summary-only-with-no-row
  // finding, because the consequence is the same one: content intact in storage
  // and unreachable for every client.
  if (typeof input.staticDocumentRows !== 'number') {
    skip('static-allow-list-empty', 'the read_model_static_documents count was not taken')
  } else {
    ran('static-allow-list-empty')
    if (input.staticSource !== null && input.staticDocumentRows === 0) {
      findings.push({
        check: 'static-allow-list-empty',
        severity: 'data-loss',
        detail: `read_model_static_workspaces row (source: ${input.staticSource}) with an EMPTY `
          + 'read_model_static_documents allow-list. resolveDurable refuses every document of a '
          + 'static workspace that is not in the allow-list, so with the list empty NOTHING in this '
          + 'workspace resolves durably: no client can open or list anything, while the content is '
          + 'intact in storage. The producer writes the row and the entries in one call, so this is '
          + 'a promotion that died between its writes or a DELETE that took the documents and left '
          + 'the row. The remedy is the same either way — re-run the promotion, which rebuilds the '
          + 'allow-list; a demotion also clears the state, at the cost of the classic walk',
        documentUrl: input.rootUrl,
      })
    }
  }

  // The registry WRITE HEAD must be listed with a writable kind. Labelled with a
  // baseline kind (`registry`, `*-base`), the baseline write fence drops EVERY
  // write to it — so every diagram creation and every rename on the workspace is
  // silently discarded. `data-loss` is the literal definition above: the UI
  // accepts the edit and it never reaches durable storage.
  //
  // Fixtures provisioned by an older producer can carry `registry` on their
  // write head (`realignPerformanceFixture.ts` repairs them).
  //
  // `isBaselineDocumentKind` also guards PROMOTION (`promoteSummaryWorkspace.ts`,
  // `write-head-not-writable`); this re-checks existing stock.
  // Note the promotion gate is STRICTLY STRONGER (`kind !== 'registry-shard' ||
  // isBaselineDocumentKind(kind)`, plus absence): a head labelled `diagram` fails
  // promotion and is clean here, because the fence does not freeze it and this
  // check reports what the FENCE does, not what promotion demands.
  //
  // The input is the list of kinds the FENCE would see, and the query that
  // produces it is a transcription of the fence's own — see `fsckWorkspace`.
  // Sharing the predicate while paraphrasing the query would answer a
  // different question than the fence:
  //
  //   fence  (docScope.ts, isFencedDocument): WHERE document.document_id = $1
  //                                           JOIN read_model_static_workspaces
  //   NOT:                                    WHERE landscape_id AND version_id
  //                                             AND document_id
  //
  // `read_model_static_documents` is keyed `(landscape_id, version_id,
  // document_id)` and carries a NON-unique index on `document_id` ALONE, added
  // to serve that global lookup — so one document listed baseline under ANY
  // static workspace is frozen everywhere, and a workspace-scoped read returns
  // nothing while the fence is freezing. Shared roots (the `shared-root` park
  // check) make this reachable rather than theoretical.
  //
  // Two skips, both genuine "could not look", so neither can hand out a `clean`:
  // an unresolved root and an unreadable manifest. There is deliberately NO
  // does-not-apply branch on the static bit — the fence ARMS on
  // `SELECT EXISTS (SELECT 1 FROM read_model_static_workspaces)`, which is
  // GLOBAL TO THE DEPLOYMENT and takes no workspace: "this workspace is not
  // static, so the fence never arms" is simply false. An empty list is a real
  // answer — nothing lists this document, the fence lets it through — so the
  // check RUNS and finds nothing.
  if (!input.root) {
    skip('write-head-writable', 'the root document did not resolve')
  } else if (input.registryWriteHeadUrl == null) {
    skip('write-head-writable', 'monolith workspace: the root names no registry write head')
  } else if (input.registryWriteHeadStaticKinds == null) {
    skip('write-head-writable', 'the static-document manifest could not be read')
  } else {
    ran('write-head-writable')
    // `.filter`, not `.some`: the fence itself is `rows.some(isBaselineDocumentKind)`
    // over every row for this document id, and naming WHICH kinds were seen is
    // what makes the finding actionable when more than one workspace lists it.
    const baselineKinds = input.registryWriteHeadStaticKinds.filter(isBaselineDocumentKind)
    if (baselineKinds.length > 0) {
      // The repair tool only relabels `registry` -> `registry-shard`
      // (`realignPerformanceFixture.ts`, `write-head-unexpected-kind` for
      // anything else). Offering it for a `*-base` head would send the reader
      // to a command that refuses.
      const repairable = baselineKinds.every((kind) => kind === 'registry')
      findings.push({
        check: 'write-head-writable',
        severity: 'data-loss',
        detail: `the registry write head is listed as ${baselineKinds.map((k) => `'${k}'`).join(', ')}, `
          + 'a BASELINE kind: the baseline write fence drops every write to it, so diagram creation '
          + 'and rename are silently discarded — the author sees the diagram locally and no second '
          + 'reader ever does'
          + (repairable
            ? ' (repair: npm run realign-performance-fixture -- --landscape <id> --version <id> --apply)'
            : ' (no automatic repair: realign-performance-fixture only relabels `registry`)'),
        documentUrl: input.registryWriteHeadUrl,
      })
    }
  }

  // ── model-write-head / write-head-version ─────────────────────────────────
  // These are the invariant that cost real data: under boot-from-server the
  // overlay shards are the ONLY durable home for objects and connections
  // (`flushWrite`'s diagramOnly branch), so a sharded model without them accepts
  // every edit in the UI and persists none of it.
  const namesMeta = url(input.root?.modelMetaUrl) !== null
  if (!input.root) {
    skip('model-write-head', 'the root document did not resolve')
    skip('write-head-version', 'the root document did not resolve')
  } else if (!namesMeta) {
    // A monolith workspace writes through the model document; overlay heads do
    // not apply and their absence is not a defect.
    skip('model-write-head', 'monolith workspace: the root names no ModelMeta')
    skip('write-head-version', 'monolith workspace: the root names no ModelMeta')
  } else if (input.modelMetaUnresolved || !input.modelMeta) {
    skip('model-write-head', 'the ModelMeta did not resolve')
    skip('write-head-version', 'the ModelMeta did not resolve')
  } else {
    ran('model-write-head')
    const objectHead = url(input.modelMeta.editsObjectShardUrl)
    const connectionHead = url(input.modelMeta.editsConnectionShardUrl)
    const missing: string[] = []
    if (!objectHead) missing.push('editsObjectShardUrl')
    if (!connectionHead) missing.push('editsConnectionShardUrl')
    if (missing.length > 0) {
      findings.push({
        check: 'model-write-head',
        severity: 'data-loss',
        detail: `sharded model has no durable overlay write head (${missing.join(', ')}); `
          + 'under boot-from-server every object and connection edit is accepted by the UI and dropped',
        documentUrl: url(input.root.modelMetaUrl) ?? undefined,
      })
    }
    // A head that is named but absent from storage is worse than one that is
    // missing: the client resolves it, fails, and reports nothing.
    for (const [field, head] of [['editsObjectShardUrl', objectHead], ['editsConnectionShardUrl', connectionHead]] as const) {
      if (head && !isPresent(head)) {
        findings.push({
          check: 'model-write-head',
          severity: 'data-loss',
          detail: `${field} points at a document that is not in storage`,
          documentUrl: head,
        })
      }
    }

    ran('write-head-version')
    if (objectHead || connectionHead) {
      const version = input.modelMeta.editsOverlayWriteHeadVersion
      if (version !== OVERLAY_WRITE_HEAD_VERSION) {
        findings.push({
          check: 'write-head-version',
          severity: 'data-loss',
          detail: `editsOverlayWriteHeadVersion is ${JSON.stringify(version)}, not ${OVERLAY_WRITE_HEAD_VERSION}. `
            + 'The client\'s write path plans this as a legacy head needing rotation and bails, '
            + 'while its resolver plans the same meta as current and returns without rotating — '
            + 'so every flush bails forever, silently, while ONLINE.',
          documentUrl: url(input.root.modelMetaUrl) ?? undefined,
        })
      }
    }
  }

  // ── document-present / document-admitted ──────────────────────────────────
  // Reachability is only as complete as the registries we could read, so an
  // unresolved registry downgrades these to skipped rather than passing on a
  // partial set.
  const unresolvedRegistries = input.unresolvedRegistries ?? []
  const reachabilityComplete = Boolean(input.root)
    && unresolvedRegistries.length === 0
    && !(namesMeta && (input.modelMetaUnresolved || !input.modelMeta))
  const incompleteReason = !input.root
    ? 'the root document did not resolve'
    : unresolvedRegistries.length > 0
      ? `${unresolvedRegistries.length} registry shard(s) did not resolve, so the reachable set is partial`
      : 'the ModelMeta did not resolve, so the reachable set is partial'

  if (!reachabilityComplete) {
    skip('document-present', incompleteReason)
    skip('document-admitted', incompleteReason)
    skip('document-orphaned', incompleteReason)
  } else {
    ran('document-present')
    for (const reference of input.referenced) {
      if (!isPresent(reference)) {
        findings.push({
          check: 'document-present',
          severity: 'degraded',
          detail: 'reachable from the root but absent from storage',
          documentUrl: reference,
        })
      }
    }
    ran('document-admitted')
    for (const reference of input.referenced) {
      // Only meaningful for documents that exist; a missing document is already
      // reported once and reporting it twice buries the first finding.
      if (isPresent(reference) && !isAdmitted(reference)) {
        findings.push({
          check: 'document-admitted',
          severity: 'sync-stall',
          detail: 'present in storage but not mapped to this workspace; '
            + 'acknowledgeDurableHeads answers durable:false for it without ever opening it, '
            + 'so a client waiting on this document is told "Enregistrement…" forever',
          documentUrl: reference,
        })
      }
    }
    // The INVERSE direction — only decidable against the COMPLETE reachable
    // set, which is why it shares the reachability gate above: with one
    // registry unread, "unreachable" would merely mean "not read yet".
    // Checkpoints are Automerge heads INSIDE a DiagramDoc, not child documents,
    // so level-1 reachability is the whole graph. KNOWN LIMITS: this walk does
    // not read `landscape_versions` snapshot manifests
    // (deliberate GC roots — a snapshot member unreferenced by the LIVE root
    // is expected, and flagged here until the snapshot-aware walk lands), and
    // a document admitted at first verified view can be seen mid-publication
    // — a finding that vanishes on re-run was that race, not a defect.
    ran('document-orphaned')
    const reachable = new Set([documentIdOf(input.rootUrl), ...input.referenced.map(documentIdOf)])
    // A FOLDED overlay segment is unreachable from the root ON PURPOSE and
    // its admission row is kept ON PURPOSE (`forwardHistoricalOverlay` needs it,
    // and de-admitting would quarantine an offline client's reconnect). Without
    // this exemption one fold pass converts a clean workspace into up to
    // `budget` findings per collection, and this check gets muted.
    for (const segment of input.retainedOverlaySegments ?? []) reachable.add(segment.documentId)
    for (const id of input.admittedIds) {
      // Repo bookkeeping is not a document, so "unreachable from the root" says
      // nothing about it. Filtered here, in the deciding code, rather than in
      // the SQL: this is the seam a test can hold, and the same reasoning has
      // to survive whatever else later feeds `admittedIds`.
      if (isRepoBookkeepingKey(id)) continue
      if (!reachable.has(id)) {
        findings.push({
          check: 'document-orphaned',
          severity: 'degraded',
          // Presence splits the finding into its two actionable shapes: a row
          // whose document is gone from storage too is pure garbage (the GC
          // now removes both together; older sweeps left these behind), while
          // a document STILL in storage may be a snapshot member or a
          // mid-publication child and deserves a look before any de-admission.
          detail: input.presentIds.has(id)
            ? 'mapped to this workspace but unreachable from its root, and still IN storage — '
              + 'a deleted diagram\'s leftover, a retired overlay segment, a snapshot member, '
              + 'or a mid-publication child (re-run before acting); '
              + 'the sync gate and residency budgets keep paying for it'
            : 'dead admission row: unreachable from the root AND gone from storage — '
              + 'left behind by a pre-fix GC sweep or a failed provisioning; safe to de-admit',
          documentUrl: `automerge:${id}`,
        })
      }
    }
  }

  // ── overlay-chain-bounded ─────────────────────────────────────────────────
  // NOT a size alarm — a workspace that has legitimately accumulated
  // diagrams gets a NUMBER in the headline, never a violation (the precedent
  // three comments above). This is the opposite case: the overlay chain is a
  // quantity the system PROMISES to bound, so a chain past the ceiling means
  // the folder is not running, and that is a defect with a name.
  if (!input.root) {
    skip('overlay-chain-bounded', 'the root document did not resolve')
  } else if (!namesMeta) {
    skip('overlay-chain-bounded', 'monolith workspace: the root names no ModelMeta')
  } else if (input.modelMetaUnresolved || !input.modelMeta) {
    skip('overlay-chain-bounded', 'the ModelMeta did not resolve')
  } else {
    ran('overlay-chain-bounded')
    // Only the two `edits*ShardUrls` lists. `objectShardUrls` / `connection-
    // ShardUrls` carry the MODEL base shards as well as overlay routes (24 + 10
    // on the reference landscape), and model sharding is a different mechanism
    // with a different bound — measuring it here would make this alarm fire on
    // a workspace whose only sin is having a large model.
    for (const field of ['editsObjectShardUrls', 'editsConnectionShardUrls'] as const) {
      const chain = urlList(input.modelMeta[field]).length
      if (chain > OVERLAY_CHAIN_CEILING) {
        findings.push({
          check: 'overlay-chain-bounded',
          severity: 'degraded',
          detail: `${field} lists ${chain} segments, past the ${OVERLAY_CHAIN_CEILING} ceiling — `
            + 'the D3 chain folder is not running for this workspace (no projector attached, '
            + 'ownership never acquired, or every pass refusing); each segment is one Automerge '
            + 'document plus three Postgres rows, and every cold boot materializes the whole list',
          documentUrl: url(input.root.modelMetaUrl) ?? undefined,
        })
      }
    }
  }

  // ── overlay-head-bounded ──────────────────────────────────────────────────
  // `overlay-chain-bounded` above detects a FOLD that has stopped; this
  // detects a ROTATION that has.
  //
  // They are not variants of one alarm, and the chain check cannot stand in for
  // this one — it is blind to this fault by construction and gets GREENER as it
  // worsens. Rotation is the only thing that appends to `edits*ShardUrls`
  // (`rotateOverlayHead` → `publishAdmittedRotation`; the browser explicitly
  // declines, `bridge.ts`'s `overlay.rotation.deferred` carries `owner:
  // 'server'`). So a rotation refused for ever leaves a SHORT chain with one
  // unbounded head: the chain stops growing, the fold finds nothing to fold,
  // and every quantity `overlay-chain-bounded` reads moves the right way while
  // the workspace degrades.
  //
  // What it costs: the head is materialized in full by every editing client
  // (`ensureOverlayHandles`), by the projector on every pass, and by the fold
  // that can never retire it. No edit is lost and no client is stalled — hence
  // `degraded` — but the boot the whole read-model design exists to keep small
  // grows without any bound at all.
  if (!input.root) {
    skip('overlay-head-bounded', 'the root document did not resolve')
  } else if (!namesMeta) {
    skip('overlay-head-bounded', 'monolith workspace: the root names no ModelMeta')
  } else if (input.modelMetaUnresolved || !input.modelMeta) {
    skip('overlay-head-bounded', 'the ModelMeta did not resolve')
  } else if (input.staticSource === null) {
    // ORDINARY WORKSPACE — and this gate is the difference between a detector
    // and an alarm on the ordinary bootstrap.
    //
    // Every path that rotates a head begins `if (!(await
    // this.holdsStaticPlane(descriptor))) return`, and `holdsStaticPlane` is a
    // lookup in `read_model_static_workspaces` — the same row `staticSource`
    // reports. `rotateOverlayHead` and `publishAdmittedRotation` exist in
    // `staticDeltaProjector.ts` and nowhere else in the tree. So on the
    // ordinary plane NOTHING promises to bound this head, and a full one there
    // is not "the rotation stopped": there was never a rotation to stop.
    //
    // No rotator serves an ordinary workspace's head, so a VIOLATION here
    // would be an alarm on a state nothing promises to avoid, which is the
    // fastest way to get a checker ignored. `overlayWriteHeadBytes` still reports for these
    // workspaces: a number is the right shape for growth nobody bounded, and
    // it is what would settle the question.
    skip('overlay-head-bounded', 'ordinary workspace: overlay rotation is a static-plane mechanism')
  } else if (!input.overlayWriteHeads) {
    skip('overlay-head-bounded', 'the overlay write heads were not measured')
  } else if (input.overlayWriteHeads.length === 0) {
    // A sharded meta naming NO head. `model-write-head` reports that at
    // `data-loss`; there is nothing here to bound, so this must be a
    // does-not-apply skip and not a `ran` over an empty list. A check that ran
    // over nothing and found nothing is indistinguishable in `checksRun` from
    // one that looked. `write-head-version`
    // next door guards its own body the same way.
    skip('overlay-head-bounded', 'no overlay write head: the ModelMeta names neither')
  } else {
    // PER HEAD, and never a skip that abandons the whole check.
    //
    // Unlike `document-present`, which abandons on a partial reachability set
    // because that set produces WRONG findings, a decided head produces a
    // CORRECT finding whatever the other head is doing. Abandoning when one
    // head is unmeasurable would throw that verdict away — and the thing that
    // makes a head unmeasurable is plausibly this very fault (a head too large
    // to decode inside `resolveTimeoutMs`), so the detector would be disarmed
    // in proportion to the severity of what it detects.
    ran('overlay-head-bounded')
    for (const head of input.overlayWriteHeads) {
      const chainField = head.field === 'editsObjectShardUrl'
        ? 'editsObjectShardUrls' : 'editsConnectionShardUrls'
      const chain = urlList(input.modelMeta[chainField]).length
      const report = (detail: string) => findings.push({
        check: 'overlay-head-bounded', severity: 'degraded', detail, documentUrl: head.url,
      })

      // UNMEASURABLE. Reported rather than skipped, so it cannot silence the
      // other head — and because "this head's bound is unverified" is itself
      // actionable. `model-write-head` separates the causes: it fires when the
      // head is absent from storage, so a head that is present and will not
      // resolve is the size case.
      if (head.entities === null || head.batches === null) {
        report(`${head.field} did not resolve, so its size is UNVERIFIED — this workspace cannot `
          + 'be called bounded. A head present in storage that will not resolve inside the '
          + 'per-document ceiling is plausibly one this same fault has grown too large to decode '
          + `(${head.bytes === null ? 'its byte count could not be taken either' : `${Math.round(head.bytes / 1024)} kB in storage`}). `
          + '`model-write-head` reports the other cause, a head that is not in storage at all.')
        continue
      }

      const past: string[] = []
      if (head.entities > OVERLAY_HEAD_CEILING) past.push(`${head.entities} entities`)
      if (head.batches > OVERLAY_HEAD_CEILING) past.push(`${head.batches} pending write batches`)
      if (past.length === 0) continue

      const over = `${head.field} carries ${past.join(' and ')}, past the ${OVERLAY_HEAD_CEILING} `
        + `ceiling (${OVERLAY_SEGMENT_SIZE} is the size a rotation is scheduled at); `
        + `${chainField} lists ${chain} segment(s)`

      // THE CONJUNCT. Over the ceiling is half a fact — a bulk import puts
      // thousands of entities in the head legitimately, and the client keeps
      // writing rather than rotating. Still full long after the last durable
      // byte landed is the other half, and it is the half a healthy rotation
      // cannot produce: it empties the head within its debounce of the writes
      // stopping.
      //
      // `null` is UNKNOWN and never "quiet for ever" — rounding it up would
      // make the conjunct a rubber stamp on the one input a stale schema
      // silently supplies. It is reported at the same severity with the
      // uncertainty named, rather than skipped: the ceiling half is decided,
      // and a workspace promoted with an already-full head that nothing has
      // written since has NO queue row at all, which is precisely the state
      // this check exists to find.
      if (head.quietForMs === null) {
        report(`${over}. Whether this is a bulk import still landing or a rotation that has `
          + 'stopped could NOT be decided: the head has no `read_model_static_document_queue` '
          + 'row, so the time of its last durable write is unknown. A workspace promoted with an '
          + 'already-full head and not written since looks exactly like this, and so does a dead '
          + 'rotator. Re-run after writes have demonstrably stopped.')
        continue
      }
      if (head.quietForMs <= OVERLAY_HEAD_ROTATION_GRACE_MS) continue

      // The CHAIN LENGTH travels with the finding because it is what separates
      // the two readings an operator has to choose between: a chain of 1 next
      // to a head 50x its bound has never rotated, while a long chain next to
      // one says rotation worked until it stopped. Neither is legible from the
      // head alone.
      report(`${over}, and has taken no durable write for ${Math.round(head.quietForMs / 1000)}s `
        + `— long past the ${OVERLAY_HEAD_ROTATION_GRACE_MS / 1000}s a healthy rotation needs `
        + 'after the writes stop. The server-owned rotation is not running for this workspace — '
        + 'no projector attached, ownership never acquired, or every pass refusing a contended '
        + 'advisory key. The browser will not rotate on its own (it defers, `owner: server`), so '
        + 'the head grows without bound and every editing client materializes all of it.')
    }
  }

  // ── overlay-segment-bounded ───────────────────────────────────────────────
  // The THIRD member of the family the two checks above describe:
  // `overlay-chain-bounded` reads how MANY segments there are,
  // `overlay-head-bounded` reads how big the two CURRENT heads are, and
  // between them nothing reads how big a RETIRED segment is.
  //
  // That is not merely a gap. The fold collapses a window into one document, so
  // the bigger the merged segment grows the SHORTER the chain gets — the chain
  // check reads greener as this fault worsens, exactly as it does for a dead
  // rotation.
  //
  // Unlike the head check this one is NOT static-plane-only. A retired segment
  // over the bound on an ordinary workspace is the same fact with the same
  // cause — the import path, where the browser writes the whole landscape into
  // one head (`overlay.rotation.deferred`, `owner: 'server'`) and the next
  // rotation retires it WHOLE rather than splitting it. There is no plane on
  // which that is healthy, and unlike a dead rotation there IS something that
  // promises to bound it now.
  if (!input.root) {
    skip('overlay-segment-bounded', 'the root document did not resolve')
  } else if (!namesMeta) {
    skip('overlay-segment-bounded', 'monolith workspace: the root names no ModelMeta')
  } else if (input.modelMetaUnresolved || !input.modelMeta) {
    skip('overlay-segment-bounded', 'the ModelMeta did not resolve')
  } else if (!input.overlaySegmentSizes) {
    skip('overlay-segment-bounded', 'the overlay segments were not measured')
  } else if (input.overlaySegmentSizes.length === 0) {
    skip('overlay-segment-bounded', 'no overlay segments: the ModelMeta lists none')
  } else {
    // PER SEGMENT, never a skip that abandons the whole check: an
    // unmeasurable item must not throw away the measured verdict of the items
    // beside it (same rule as `overlay-head-bounded`).
    ran('overlay-segment-bounded')
    const unmeasured = input.overlaySegmentSizes.filter((segment) => segment.bytes === null)
    for (const segment of input.overlaySegmentSizes) {
      if (segment.bytes === null) continue
      if (segment.bytes <= OVERLAY_SEGMENT_BYTE_CEILING) continue
      findings.push({
        check: 'overlay-segment-bounded',
        severity: 'degraded',
        detail: `${segment.field} carries a segment of ${Math.round(segment.bytes / 1024)} kB, past `
          + `the ${Math.round(OVERLAY_SEGMENT_BYTE_CEILING / 1024)} kB ceiling that the D3 fold `
          + `bounds a segment to (${OVERLAY_SEGMENT_ENTITY_CEILING} entities). Two causes, and `
          + 'both cost the same: an over-full head retired WHOLE by a rotation that creates an '
          + 'empty successor rather than splitting it, or a fold that merged its window into one '
          + 'document. Every editing client, every projector pass and every fold materializes it '
          + 'in full — and wasm32 linear memory never shrinks, so the process keeps the high-water '
          + 'mark for its lifetime.',
        documentUrl: `automerge:${segment.documentId}`,
      })
    }
    // ONE FAULT, ONE VOICE. A listed segment with no content rows is ALREADY
    // reported by `document-present` — `collectReferencedUrls` puts both
    // `edits*ShardUrls` in `referenced`, so the absence is found there — and
    // `document-admitted` refuses exactly this duplication in as many words:
    // "a missing document is already reported once and reporting it twice
    // buries the first finding".
    //
    // So only segments that are PRESENT and still unmeasurable are reported
    // here. That set is normally empty, and when it is not it means the byte
    // sum disagreed with the presence check — worth a finding precisely because
    // the two read the same table through different predicates.
    const unexplained = unmeasured.filter(
      (segment) => input.presentIds === null || input.presentIds.has(segment.documentId),
    )
    if (unexplained.length) {
      findings.push({
        check: 'overlay-segment-bounded',
        severity: 'degraded',
        detail: `${unexplained.length} of ${input.overlaySegmentSizes.length} listed overlay `
          + 'segments are PRESENT in storage and still produced no content bytes, so their size is '
          + 'UNVERIFIED and this workspace cannot be called bounded. The two facts come from the '
          + 'same table through different predicates, so a disagreement between them is itself the '
          + 'finding; segments that are simply absent are reported once, by `document-present`.',
        documentUrl: url(input.root.modelMetaUrl) ?? undefined,
      })
    }
  }

  // ── overlay-segment-retained ──────────────────────────────────────────────
  // The reason the fold is not itself a data-loss defect. Folding
  // removes a prefix from ModelMeta, so the GC's ModelMeta walk stops marking
  // those documents; a dedicated reachability root in `gc.ts` replaces it. This
  // is the run-not-reader detector for that root failing: a segment the
  // retention contract still owes an offline client, whose bytes are gone.
  // `!` and not `=== null`: a caller that omitted the field entirely must land
  // in the SAFE direction — a skip, which makes the run `incomplete` — and
  // never crash the whole pass or, worse, report itself clean on a list it
  // never received.
  if (!input.retainedOverlaySegments) {
    skip('overlay-segment-retained', 'no overlay-history schema in this database')
  } else {
    ran('overlay-segment-retained')
    for (const segment of input.retainedOverlaySegments) {
      if (input.presentIds.has(segment.documentId)) continue
      // `document-present` already reports anything still reachable from the
      // root; two alarms on one document bury the first.
      if (input.referenced.some((reference) => documentIdOf(reference) === segment.documentId)) continue
      findings.push({
        check: 'overlay-segment-retained',
        severity: 'data-loss',
        detail: `retained ${segment.collection} overlay segment is GONE from storage — `
          + 'a client reconnecting with offline edits against it gets $base-unavailable, '
          + 'so its edits are recorded as conflicts and never merged',
        documentUrl: `automerge:${segment.documentId}`,
      })
    }
  }

  // ── claim-coverage ────────────────────────────────────────────────────────
  // NOT a new scanner: one more assertion over facts already gathered
  // (`referenced` ∪ the root against `admittedIds`), gated on the claim-coverage marker.
  // The marker PROMISES that every reachable document was claimed at write —
  // this is the run-not-reader detector for a marker that lies (a forgotten
  // creator site, a lost claim). fsck stays read-only: it SIGNALS; the
  // correction is the route-gate constat or the operator, never this pass.
  if (!input.claimCoverage || !input.claimCoverage.covered) {
    // An uncovered workspace has made no promise, so there is nothing to
    // check — a does-not-apply skip, NOT incompleteness (the legacy stock is
    // covered lazily at first attach and must still be able to report clean).
    skip('claim-coverage', 'uncovered workspace: no claim-coverage marker (legacy stock covers lazily at first attach)')
  } else if (!reachabilityComplete) {
    // Covered but the reachable set is partial: the promise cannot be
    // verified, and "checked what we could" must not read as checked.
    skip('claim-coverage', incompleteReason)
  } else {
    ran('claim-coverage')
    for (const id of new Set([documentIdOf(input.rootUrl), ...input.referenced.map(documentIdOf)])) {
      // Present-only, same rationale as document-admitted: a document missing
      // from storage is already reported once by document-present, and a
      // second finding would bury the first.
      if (input.presentIds.has(id) && !input.admittedIds.has(id)) {
        findings.push({
          check: 'claim-coverage',
          severity: 'sync-stall',
          detail: 'the claim-coverage marker promises every reachable document was claimed at '
            + 'write, but this one has no claim row — the marker lies, covered attaches skip the '
            + 'pre-warm walk, and the document stays unadmitted until a route-gate miss de-covers '
            + 'the workspace',
          documentUrl: `automerge:${id}`,
        })
      }
    }
  }

  // ── diagram-tombstone-honoured ────────────────────────────────────────────
  // The diagram-tombstone invariant, made runnable. A tombstone the projector never applied is
  // the "written but never read" defect in its resting state: the client says
  // the diagram is gone and hides its card, while every global view, the paged
  // list and every "linked diagrams" panel still carry it. Nothing is LOST, so
  // this is `degraded` — but it is exactly the class of drift a reader never
  // finds and a run finds in one command.
  //
  // An EMPTY tombstone list is not a skip: "every id in the list is absent" is
  // vacuously true and the check genuinely looked at everything there was. Only
  // the absence of a ModelMeta makes it inapplicable.
  if (!input.root) {
    skip('diagram-tombstone-honoured', 'the root document did not resolve')
  } else if (!namesMeta) {
    skip('diagram-tombstone-honoured', 'monolith workspace: the root names no ModelMeta')
  } else if (input.modelMetaUnresolved || !input.modelMeta) {
    skip('diagram-tombstone-honoured', 'the ModelMeta did not resolve')
  } else if (!input.liveTombstonedDiagramIds) {
    // "Every tombstoned id is absent" is vacuously true against a table that
    // does not exist, so an empty set here would make a run that could not
    // look report clean.
    skip('diagram-tombstone-honoured', 'the read model has no ro_diagrams table')
  } else {
    ran('diagram-tombstone-honoured')
    const live = input.liveTombstonedDiagramIds
    for (const id of new Set(input.diagramTombstones)) {
      if (!live.has(id)) continue
      findings.push({
        check: 'diagram-tombstone-honoured',
        severity: 'degraded',
        detail: `diagram ${id} is tombstoned in ModelMeta.deletedDiagramIds but still has a ro_diagrams row: `
          + 'the client hides its card and the server keeps serving it, so it stays on the paged list, in the '
          + 'global views and in the "linked diagrams" of every object it contained. The projector either never '
          + 'saw the tombstone (a semantic-fingerprint short circuit) or never applied it',
      })
    }
  }

  // ── registry-head-projected ───────────────────────────────────────────────
  // The other direction of the same seam: a summary
  // workspace writes a NEW diagram into the registry write head and nowhere
  // else. The write is durable and the nav menu can still reach it — but with
  // no `ro_diagrams` row, the Diagrams page, the search, "linked diagrams",
  // `diagram-render`, share links and every other client are blind to it.
  //
  // `sync-stall`, deliberately, NOT `data-loss`: the user's write did reach
  // durable storage. What broke is the read model's ability to ever tell
  // anyone about it — writes land and no one can be told.
  //
  // Tombstoned ids are excluded: the projection refuses to resurrect them (the
  // `diagram-tombstone-honoured` invariant above forbids exactly that), so
  // demanding a row for one would make this check fire on CORRECT behaviour,
  // and an alarm that fires on the ordinary case gets muted.
  //
  // An EMPTY write head is not a skip, for the same reason an empty tombstone
  // list is not: the check genuinely looked at everything there was.
  const tombstoned = new Set(input.diagramTombstones)
  if (!input.root) {
    skip('registry-head-projected', 'the root document did not resolve')
  } else if (!input.registryWriteHeadUrl) {
    skip('registry-head-projected', 'monolith workspace: the root names no registry write head')
  } else if (!input.registryWriteHeadDiagramIds) {
    skip('registry-head-projected', 'the registry write head did not resolve')
  } else if (!input.projectedWriteHeadDiagramIds) {
    // An empty set here would not merely mute the check, it would INVERT it:
    // one finding per diagram of the write head on a database that predates
    // the read model.
    skip('registry-head-projected', 'the read model has no ro_diagrams table')
  } else if (
    input.registryWriteHeadProjectionLagMs !== null
    && input.registryWriteHeadProjectionLagMs < REGISTRY_HEAD_PROJECTION_GRACE_MS
  ) {
    // The projection is asynchronous: a workspace someone is editing right now
    // has a head ahead of `ro_diagrams` for as long as the projector takes, and
    // reporting that as a stall would make `npm run fsck` non-deterministic on
    // a live stack.
    //
    // This is deliberately NOT an unconditional pass for "pending": a wedged
    // projector keeps the row pending for ever and must still be reported, and
    // a head that was never enqueued has NO pending row at all, so the defect
    // this check exists for cannot hide behind it.
    skip(
      'registry-head-projected',
      `projection in flight: the write head was enqueued ${
        Math.round(input.registryWriteHeadProjectionLagMs)} ms ago and is not yet applied`,
    )
  } else {
    ran('registry-head-projected')
    const projected = input.projectedWriteHeadDiagramIds
    for (const id of new Set(input.registryWriteHeadDiagramIds)) {
      if (tombstoned.has(id) || projected.has(id)) continue
      findings.push({
        check: 'registry-head-projected',
        severity: 'sync-stall',
        detail: `diagram ${id} is in the registry write head but has no ro_diagrams row: the write is durable `
          + 'and the nav menu can still open it, while the Diagrams page, the search, the "linked diagrams" '
          + 'panels, diagram-render and every share link are blind to it. Either the write head is never '
          + 'enqueued for projection, or the projector has no branch that reads it',
        documentUrl: input.registryWriteHeadUrl,
      })
    }
  }

  return { findings, checksRun, checksSkipped }
}

/**
 * The status verdict, pure and shared with the unit suite. A check skipped
 * because it does not APPLY (a monolith has no overlay head; an uncovered
 * workspace has made no coverage promise) is not incompleteness; a check
 * skipped because something failed to resolve is — `clean` requires every
 * applicable check to have RUN.
 */
export function fsckStatusOf(
  findings: readonly FsckFinding[],
  checksSkipped: readonly { check: FsckCheckCode; reason: string }[],
): WorkspaceFsckReport['status'] {
  return checksSkipped.some((entry) => (
    !entry.reason.startsWith('monolith workspace')
    && !entry.reason.startsWith('uncovered workspace')
    // `ordinary workspace` — added with `overlay-head-bounded`. Overlay
    // rotation is gated on `holdsStaticPlane`, so on a workspace with no
    // `read_model_static_workspaces` row the check does not APPLY; without
    // this prefix every ordinary workspace's run would report `incomplete`
    // and `npm run fsck` would exit non-zero for the common case, which is
    // the fastest way to make a checker ignored.
    && !entry.reason.startsWith('ordinary workspace')
    // `no overlay write head` — a SHARDED meta naming neither head. Its own
    // prefix rather than borrowing `monolith workspace`, which would have been
    // false about the workspace: this one IS sharded, which is exactly why
    // `model-write-head` reports it at `data-loss`. That matters beyond
    // wording — an `incomplete` here would OUTRANK those findings and report
    // the run as "could not be checked" when it found a real defect.
    && !entry.reason.startsWith('no overlay write head')
    // `no overlay segments` — a SEPARATE prefix from the one above for
    // the same reason that one is separate from `monolith workspace`: a meta
    // that names a write head but lists no segment chain is an ordinary early
    // state, not a missing head, and borrowing the head's prefix would make one
    // reason stand for two different facts. "There are no segments" is an
    // ANSWER; "nobody measured them" is not, and only the first is here — the
    // `the overlay segments were not measured` skip deliberately falls through
    // to `incomplete`.
    && !entry.reason.startsWith('no overlay segments')
  ))
    ? 'incomplete'
    : findings.length > 0 ? 'violations' : 'clean'
}

/**
 * How long since a durable byte last reached this document, or `null` when the
 * question could not be answered.
 *
 * `enqueued_at` is stamped by `PostgresStorageAdapter` in the same transaction
 * as the chunk write, so it survives a projector that has stopped — which is
 * the whole reason `overlay-head-bounded` leans on it rather than on any of the
 * three cheaper, projector-fed columns. Deliberately NOT filtered on
 * `revision > projected_revision` (the filter `registryWriteHeadProjectionLagMs`
 * uses next door): that one asks "is a projection pending", this one asks "when
 * did writing stop", and a caught-up projector must not read as "never written".
 *
 * `null` on a missing row and on a missing table, never a large number: an
 * absent row means unknown, and rounding unknown up to "quiet for ever" is
 * exactly how the conjunct guarding against bulk imports would become a rubber
 * stamp.
 */
export async function overlayHeadQuietForMs(
  db: Queryable, key: WorkspaceKey, documentId: string,
): Promise<number | null> {
  try {
    const { rows } = await db.query<{ quiet_ms: string | number }>(
      `SELECT EXTRACT(EPOCH FROM (now() - enqueued_at)) * 1000 AS quiet_ms
         FROM read_model_static_document_queue
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [key.landscapeId, key.versionId, documentId],
    )
    return rows.length === 0 ? null : Math.max(0, Number(rows[0].quiet_ms))
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error
    return null
  }
}

/**
 * Bytes of one document's content chunks, or `null` when the sum could not be
 * taken — a HEADLINE number, so a failure to take it must read as unknown
 * rather than as a healthy zero.
 *
 * `split_part` in a predicate is NOT the full scan the metrics comment in
 * `index.ts` warns about; that one aggregates over the WHOLE table with no
 * predicate. Two expression indexes cover this shape
 * (`idx_automerge_storage_doc_arrival`, `idx_automerge_storage_doc_updated`,
 * both `btree (split_part(key, '/', 1), …)`), and the planner uses one:
 *
 *     Aggregate  (cost=12.67..12.68 rows=1)
 *       -> Bitmap Heap Scan on automerge_storage  (cost=4.18..12.65 rows=4)
 *            -> Bitmap Index Scan on idx_automerge_storage_doc_arrival
 *
 * The broad `catch` is deliberate and differs from `overlayHeadQuietForMs`
 * next door, which rethrows anything but `42P01`. That one feeds a VERDICT, so
 * a swallowed connection error would silently weaken a decision; this feeds a
 * number that is already allowed to be `null`, and a fleet run should not lose
 * every remaining workspace because one byte sum failed.
 */
async function documentStorageBytes(db: Queryable, documentId: string): Promise<number | null> {
  try {
    const { rows } = await db.query<{ bytes: string }>(
      // The CONTENT chunk filter, shared with presence above rather than
      // written out: without it this sums `sync-state/<peerId>` rows too, which
      // automerge-repo writes the first time any peer merely TRIES to sync a
      // document. A growth number that includes peer bookkeeping is measuring
      // the wrong thing — small per row, but this figure exists to say how
      // heavy the HEAD is.
      `SELECT SUM(octet_length(data))::bigint AS bytes
         FROM automerge_storage
        WHERE split_part(key, '/', 1) = $1
          AND ${documentContentChunkFilter()}`,
      [documentId],
    )
    const bytes = rows[0]?.bytes
    return bytes === undefined || bytes === null ? null : Number(bytes)
  } catch {
    return null
  }
}

/** One listed overlay segment and the bytes it holds. `bytes` is null when the
 * sum could not be taken; NULLS, NEVER ZEROS, because a zero here reads as
 * "this segment is small", which is the verdict the check exists to
 * withhold. */
export interface OverlaySegmentSize {
  field: 'editsObjectShardUrls' | 'editsConnectionShardUrls'
  documentId: string
  bytes: number | null
}

/**
 * Sum the CONTENT bytes of many documents in ONE statement.
 *
 * `GROUP BY`, not one query per segment: a chain runs to `OVERLAY_CHAIN_CEILING`
 * (256), and 256 round trips to answer one question would make the checker cost
 * what it is checking.
 *
 * A document with no content rows is ABSENT from the result rather than zero,
 * and the caller keeps that distinction: `document-present` is the check that
 * owns "this document has no bytes", and answering it here too would give one
 * fault two voices.
 */
export async function overlaySegmentStorageBytes(
  db: Queryable,
  documentIds: readonly string[],
): Promise<{ bytes: Map<string, number>; queryFailed: boolean }> {
  if (!documentIds.length) return { bytes: new Map(), queryFailed: false }
  try {
    const { rows } = await db.query<{ document_id: string; bytes: string }>(
      // `= ANY($1::text[])` rather than the `= $1` its single-document
      // neighbour uses — a different plan shape, so the index note over there
      // (taken with the equality form) does not automatically transfer.
      `SELECT split_part(key, '/', 1) AS document_id,
              SUM(octet_length(data))::bigint AS bytes
         FROM automerge_storage
        WHERE split_part(key, '/', 1) = ANY($1::text[])
          AND ${documentContentChunkFilter()}
        GROUP BY 1`,
      [[...documentIds]],
    )
    return {
      bytes: new Map(rows.map((row) => [row.document_id, Number(row.bytes)])),
      queryFailed: false,
    }
  } catch {
    // TWO FACTS, never one. Swallowing the error into an empty Map would make
    // "the statement failed" indistinguishable from "no rows", and a transient
    // database error would produce a `degraded` finding with an invented cause.
    //
    // `documentStorageBytes` may swallow because it feeds a NUMBER that is
    // allowed to be null, while `overlayHeadQuietForMs` rethrows because it
    // feeds a VERDICT. This one feeds a verdict, so a failure must reach the
    // caller and become `incomplete`, which is not `clean`.
    return { bytes: new Map(), queryFailed: true }
  }
}

/**
 * COMPLETE OR NOTHING — the weight of both overlay write heads, or `null`.
 *
 * Exported so it can be unit-tested: the headline numbers are assembled in
 * `fsckWorkspace`, which needs a live database and a live repo.
 *
 * A failed head is never counted as zero: a 4 MB object head beside a
 * connection head whose sum threw must not read as a complete 4 MB. PARTIAL is
 * not COMPLETE, and this is the number the design leans on to cover the
 * check's two named blind spots.
 *
 * `null` for an empty list too: no head is "does not apply", not "weighs
 * nothing".
 */
export function overlayWriteHeadBytesTotal(
  heads: readonly OverlayWriteHeadSize[] | undefined,
): number | null {
  if (heads === undefined || heads.length === 0) return null
  if (heads.some((head) => head.bytes === null)) return null
  return heads.reduce((total, head) => total + (head.bytes ?? 0), 0)
}

/**
 * Measure the CURRENT overlay write heads a ModelMeta names.
 *
 * Exported and dependency-injected so it can be unit-tested: reaching it
 * inline needs a live repo, a live database AND a STATIC workspace, and the
 * integration fixtures are ordinary ones. An unresolved head must read `null`,
 * never `0` — zero is the healthiest possible reading of a count nobody could
 * take, and the report is HMAC-signed.
 *
 * The call site is one line in `fsckWorkspace`, and deleting it is not silent:
 * `overlayWriteHeads` becomes `undefined`, the check skips as "not measured",
 * and the run is `incomplete`, which the integration tests fail on.
 */
export async function measureOverlayWriteHeads(
  modelMeta: Record<string, unknown>,
  resolve: (target: string) => Promise<PlainDoc>,
  quietForMs: (documentId: string) => Promise<number | null>,
  bytes: (documentId: string) => Promise<number | null>,
): Promise<OverlayWriteHeadSize[]> {
  const measured: OverlayWriteHeadSize[] = []
  for (const [field, collection] of [
    ['editsObjectShardUrl', 'objects'],
    ['editsConnectionShardUrl', 'connections'],
  ] as const) {
    const headUrl = url(modelMeta[field])
    // An absent or malformed head is `model-write-head`'s finding, at
    // `data-loss`. Reporting it a second time here would bury the first.
    if (!headUrl) continue
    const head = await resolve(headUrl)
    const entries = head?.[collection]
    measured.push({
      field,
      url: headUrl,
      // A resolved head with no entities is a REAL zero and reads as healthy,
      // which it is. `null` is reserved for the count that could not be taken.
      entities: head === undefined ? null
        : entries && typeof entries === 'object' ? Object.keys(entries).length : 0,
      batches: head === undefined ? null
        : new Set(Array.isArray(head.writeBatchIds)
          ? head.writeBatchIds.filter((id): id is string => typeof id === 'string')
          : []).size,
      quietForMs: await quietForMs(documentIdOf(headUrl)),
      bytes: await bytes(documentIdOf(headUrl)),
    })
  }
  return measured
}

/** Resolve a document without ever risking the never-settling `repo.find()`. */
async function tryResolve(repo: Repo, target: string, timeoutMs: number): Promise<PlainDoc> {
  if (!isValidAutomergeUrl(target)) return undefined
  try {
    const handle = await findReadyDocument<Record<string, unknown>>(repo, target, timeoutMs)
    return handle.doc()
  } catch {
    return undefined
  }
}

export interface WorkspaceFsckOptions {
  /** Per-document ceiling. `repo.find()` never settles with no peer connected. */
  resolveTimeoutMs?: number
}

/**
 * Run every document-graph check against one workspace.
 *
 * Presence and admission are answered by SQL rather than by resolving each
 * document: a workspace at scale reaches thousands of documents, and resolving
 * them would make the checker cost what it is checking. It also keeps the run
 * away from `repo.find()` for anything but the four control documents.
 */
export async function fsckWorkspace(
  db: Queryable,
  repo: Repo,
  key: WorkspaceKey,
  rootUrl: string,
  options: WorkspaceFsckOptions = {},
): Promise<WorkspaceFsckReport> {
  const timeoutMs = options.resolveTimeoutMs ?? 8_000
  const root = await tryResolve(repo, rootUrl, timeoutMs)

  const metaUrl = url(root?.modelMetaUrl)
  const modelMeta = metaUrl ? await tryResolve(repo, metaUrl, timeoutMs) : undefined
  const modelMetaUnresolved = Boolean(metaUrl) && modelMeta === undefined

  // The CURRENT overlay write heads, measured from the DOCUMENTS. Two
  // resolves, bounded by the same ceiling as everything else on this path, and
  // `undefined` for a monolith so the check skips with a does-not-apply reason
  // rather than an incomplete one. See `overlayWriteHeads` on the input type
  // for why the three cheaper sources are all silenced by the fault they would
  // report.
  const overlayWriteHeads = modelMeta === undefined ? undefined : await measureOverlayWriteHeads(
    modelMeta,
    (target) => tryResolve(repo, target, timeoutMs),
    (documentId) => overlayHeadQuietForMs(db, key, documentId),
    (documentId) => documentStorageBytes(db, documentId),
  )

  // Every LISTED segment, not just the two current heads, and answered by
  // ONE grouped statement rather than by resolving each document. Resolving
  // them is what the bound exists to prevent: a cold load of one oversized
  // merged segment can take several seconds on its own.
  const overlaySegmentSizes = modelMeta === undefined ? undefined : await (async () => {
    // THE CURRENT HEADS ARE EXCLUDED, and this is required rather than an
    // optimisation: including them would report a bulk import still landing
    // (or a head still inside its grace) as a violation.
    //
    // `overlay-head-bounded` owns the head, and it owns it WITH a 65-minute
    // quiescence conjunct precisely because "a head over its bound" and "a bulk
    // import still landing" are indistinguishable without one. This check has
    // no quiescence input by construction, so judging the head here re-decides
    // that question with the conjunct removed — `npm run fsck` would exit
    // non-zero for a landscape that is merely mid-import, for over an hour, and
    // an alarm that fires on the ordinary case is an alarm that gets muted.
    //
    // A retired segment needs no grace: nothing writes to it, so its size is
    // final the moment the rotation retires it.
    const heads = new Set([
      modelMeta.editsObjectShardUrl, modelMeta.editsConnectionShardUrl,
    ].filter((value): value is string => typeof value === 'string').map(documentIdOf))
    const listed = (['editsObjectShardUrls', 'editsConnectionShardUrls'] as const)
      .flatMap((field) => urlList(modelMeta[field]).map((value) => ({
        field, documentId: documentIdOf(value),
      })))
      .filter((entry) => !heads.has(entry.documentId))
    const measured = await overlaySegmentStorageBytes(db, listed.map((entry) => entry.documentId))
    // A FAILED QUERY IS NOT AN ANSWER. `undefined` here makes the check skip
    // with "the overlay segments were not measured", which `fsckStatusOf`
    // deliberately leaves out of its does-not-apply prefixes, so the run is
    // `incomplete` rather than reporting a fabricated violation.
    if (measured.queryFailed) return undefined
    return listed.map((entry) => ({
      ...entry,
      // `?? null`, never `?? 0`: a segment with no content rows has an UNKNOWN
      // size here, and a zero would read as "small", which is the verdict this
      // check exists to withhold.
      bytes: measured.bytes.get(entry.documentId) ?? null,
    }))
  })()

  const registryUrls = urlList(root?.shardUrls)
  const registries: PlainDoc[] = []
  const unresolvedRegistries: string[] = []
  // The write head is one of the shards in the ordinary case
  // (`publishNewRegistryShard` appends it to `shardUrls` AND names it in
  // `registryWriteUrl`), so it is captured from the walk this pass already
  // does. Only an older root that names a head outside `shardUrls` costs one
  // extra resolve, and that is bounded at one document.
  const registryWriteHeadUrl = url(root?.registryWriteUrl)
  let writeHeadDoc: PlainDoc
  let writeHeadResolved = false
  for (const registryUrl of registryUrls) {
    const doc = await tryResolve(repo, registryUrl, timeoutMs)
    if (doc === undefined) unresolvedRegistries.push(registryUrl)
    else registries.push(doc)
    if (registryWriteHeadUrl && registryUrl === registryWriteHeadUrl) {
      writeHeadDoc = doc
      writeHeadResolved = doc !== undefined
    }
  }
  if (registryWriteHeadUrl && !registryUrls.includes(registryWriteHeadUrl)) {
    writeHeadDoc = await tryResolve(repo, registryWriteHeadUrl, timeoutMs)
    writeHeadResolved = writeHeadDoc !== undefined
  }

  const referenced = collectReferencedUrls(root, modelMeta, registries)
  const ids = [...new Set([rootUrl, ...referenced].map(documentIdOf))]

  // The COMPLETE admission set, not just the reachable slice: `document-admitted`
  // only tests membership, and `document-orphaned` has to see the admissions the
  // graph no longer references. Bounded by the workspace's own row count (ids
  // only), never by the fleet.
  const admitted = new Set<string>()
  const { rows: mappedRows } = await db.query<{ document_id: string }>(
    `SELECT document_id FROM automerge_document_workspace
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  for (const row of mappedRows) admitted.add(row.document_id)

  const { rows: staticRows } = await db.query<{ source: string }>(
    `SELECT source FROM read_model_static_workspaces
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  const staticSource = staticRows[0]?.source ?? null

  // The allow-list's cardinality, by SQL. NULL when the count could not
  // be TAKEN, never 0: see the field's own note for why collapsing the two is a
  // false PASS rather than a lenient one.
  //
  // The catch is deliberately broad, and the reason is not the one a narrower
  // reading suggests. A database with no `read_model_static_documents` table
  // also has no `read_model_static_workspaces`, which is queried ten lines
  // above with no catch — so `fsckWorkspace` would have thrown before reaching
  // here, and "the table is absent" is a case this line cannot actually see.
  // What it catches is a dropped connection or a cancelled statement, and for
  // those NULL is the right answer: the run reports `incomplete` and exits
  // non-zero, rather than reporting no orphans on a question nobody asked.
  const staticDocumentRows = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM read_model_static_documents
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  ).then((result) => result.rows[0]?.n ?? 0).catch(() => null)

  // The write head's MANIFEST kinds, read with the fence's OWN query rather than
  // a workspace-scoped paraphrase of it — `document_id` alone, joined to
  // `read_model_static_workspaces`, exactly as `isFencedDocument` does
  // (`docScope.ts`). A checker that asks a narrower question than the component
  // it is checking manufactures a class of false negatives nobody can see —
  // sharing the predicate is not enough, the QUERY must match too.
  //
  // `[]` and `null` are different answers and are never collapsed: no rows means
  // the fence lets the document through, a missing table (`42P01`) means the
  // manifest could not be read at all and the check must skip.
  let registryWriteHeadStaticKinds: string[] | null = null
  if (registryWriteHeadUrl) {
    try {
      const { rows: kindRows } = await db.query<{ kind: string }>(
        `SELECT document.kind
           FROM read_model_static_documents document
           JOIN read_model_static_workspaces workspace
             ON workspace.landscape_id = document.landscape_id
            AND workspace.version_id = document.version_id
          WHERE document.document_id = $1`,
        [documentIdOf(registryWriteHeadUrl)],
      )
      registryWriteHeadStaticKinds = kindRows.map((row) => row.kind)
    } catch (error) {
      if ((error as { code?: string }).code !== '42P01') throw error
      registryWriteHeadStaticKinds = null
    }
  }

  // The claim-coverage marker. The protocol comparison happens HERE, so the
  // pure verdict only ever sees "covered under the CURRENT contract" — an old
  // protocol is an uncovered workspace, not a lying one. A database whose
  // schema predates the marker (42P01) simply has no covered workspaces.
  let claimCoverage: { covered: boolean } | null = null
  try {
    const { rows: coverageRows } = await db.query<{ covered: boolean; protocol: number }>(
      `SELECT covered, protocol FROM workspace_claim_coverage
        WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId],
    )
    const coverageRow = coverageRows[0]
    claimCoverage = coverageRow
      ? { covered: coverageRow.covered === true && Number(coverageRow.protocol) >= CLAIM_PROTOCOL_VERSION }
      : null
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error
  }

  // The overlay segments still inside their retention window. Bounded by
  // this workspace's own chain, answered by SQL with the SAME predicate as the
  // GC reachability root, so the two can never disagree about what is retained.
  let retainedOverlaySegments: { documentId: string; collection: string }[] | null
  try {
    const { rows: overlayRows } = await db.query<{ document_id: string; collection: string }>(
      `SELECT document_id, collection FROM read_model_overlay_segments
        WHERE landscape_id = $1 AND version_id = $2
          AND (is_current OR retain_until IS NULL OR retain_until > now())`,
      [key.landscapeId, key.versionId],
    )
    retainedOverlaySegments = overlayRows.map((row) => ({
      documentId: row.document_id, collection: row.collection,
    }))
  } catch (error) {
    // A database predating the overlay-history schema cannot answer. Null says
    // "could not look" and the check SKIPS; an empty array would make it
    // vacuously true and report `clean` for a run that never looked.
    if ((error as { code?: string }).code !== '42P01') throw error
    retainedOverlaySegments = null
  }

  // Presence covers reachable ∪ admitted — an orphaned admission's finding
  // says whether its document still exists in storage (a look-first candidate)
  // or is a dead row (safe to de-admit), and that split needs presence for the
  // admitted ids too.
  // CONTENT keys only. `sync-state/<peerId>` is per-peer bookkeeping, not the
  // document: automerge-repo writes one (2 bytes) the first time a peer tries
  // to sync a document, INCLUDING a document that has no content to send. So a
  // document whose snapshot was never durably written acquires a storage row
  // the moment a user opens it and gets "is unavailable" — and a presence check
  // that asks "is there any row with this prefix" then answers YES.
  //
  // That would be a detector that goes quiet as the defect spreads: each
  // broken document opened once would drop out of the findings, until the
  // workspace reports as healthy while none of its diagrams can be edited.
  const present = new Set<string>()
  // The retained overlay segments join the SAME presence query rather
  // than adding a second one: `overlay-segment-retained` needs to know whether
  // each still has bytes, and a folded segment is in neither `ids` nor
  // necessarily `admitted`.
  const presenceIds = [...new Set([...ids, ...admitted,
    ...(retainedOverlaySegments ?? []).map((segment) => segment.documentId)])]
  if (presenceIds.length > 0) {
    const { rows: storedRows } = await db.query<{ document_id: string }>(
      // The chunk filter comes from `automergeStorage.ts`, not spelled out
      // here: this predicate and `scripts/verify-retained-documents.ts` answer
      // the SAME question ("does this document have content"), and one shared
      // constant keeps the two checkers from disagreeing (e.g. on the default
      // for an unknown chunk kind).
      `SELECT DISTINCT split_part(key, '/', 1) AS document_id
         FROM automerge_storage
        WHERE split_part(key, '/', 1) = ANY($1::text[])
          AND ${documentContentChunkFilter()}`,
      [presenceIds],
    )
    for (const row of storedRows) present.add(row.document_id)
  }

  // The weight of the BOOT-CRITICAL set, answered by SQL for the same reason
  // presence is: a workspace at scale reaches thousands of documents, and
  // summing octet_length over all of them would make the checker cost what it
  // is checking. This set is the root + ModelMeta + registry shards — a few
  // dozen rows at most.
  const bootCriticalIds = [...new Set([
    documentIdOf(rootUrl),
    ...(url(root?.modelMetaUrl) ? [documentIdOf(url(root?.modelMetaUrl)!)] : []),
    ...urlList(root?.shardUrls).map(documentIdOf),
  ])]
  let bootCriticalBytes = 0
  let largestBootDocumentBytes = 0
  if (bootCriticalIds.length > 0) {
    const { rows: byteRows } = await db.query<{ bytes: string }>(
      `SELECT SUM(octet_length(data))::bigint AS bytes
         FROM automerge_storage
        WHERE split_part(key, '/', 1) = ANY($1::text[])
        GROUP BY split_part(key, '/', 1)`,
      [bootCriticalIds],
    )
    for (const row of byteRows) {
      const bytes = Number(row.bytes)
      bootCriticalBytes += bytes
      if (bytes > largestBootDocumentBytes) largestBootDocumentBytes = bytes
    }
  }

  // The tombstones, and which of them SQL still shows a row for. Bounded
  // by the workspace's own deleted-diagram count; no document is resolved for
  // it beyond the ModelMeta this pass already holds.
  const diagramTombstones = [...new Set(
    Array.isArray(modelMeta?.deletedDiagramIds)
      ? (modelMeta.deletedDiagramIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : [],
  )]
  let liveTombstonedDiagramIds: Set<string> | null = new Set<string>()
  if (diagramTombstones.length > 0) {
    try {
      const { rows: liveRows } = await db.query<{ id: string }>(
        `SELECT id FROM ro_diagrams
          WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, diagramTombstones],
      )
      for (const row of liveRows) liveTombstonedDiagramIds.add(row.id)
    } catch (error) {
      // A database predating the read model has no ro_diagrams; that is not a
      // violation, and it must not take the whole run down. It is not an empty
      // answer either — null says "could not look", and the check SKIPS rather
      // than reporting itself clean.
      if ((error as { code?: string }).code !== '42P01') throw error
      liveTombstonedDiagramIds = null
    }
  }

  // The write head's diagram ids, and which of them the read model can
  // actually serve. NOT bounded by SHARD_SIZE (see
  // `registryWriteHeadDiagramCount`), so this is answered by SQL in one query,
  // for the same reason as the tombstone pair: resolving each diagram would
  // make the checker cost what it is checking.
  const writeHeadDiagrams = writeHeadDoc?.diagrams
  const registryWriteHeadDiagramIds = writeHeadResolved
    ? (writeHeadDiagrams && typeof writeHeadDiagrams === 'object' && !Array.isArray(writeHeadDiagrams)
      ? Object.keys(writeHeadDiagrams as Record<string, unknown>)
      : [])
    : null
  let projectedWriteHeadDiagramIds: Set<string> | null = new Set<string>()
  if (registryWriteHeadDiagramIds && registryWriteHeadDiagramIds.length > 0) {
    try {
      const { rows: projectedRows } = await db.query<{ id: string }>(
        `SELECT id FROM ro_diagrams
          WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, registryWriteHeadDiagramIds],
      )
      for (const row of projectedRows) projectedWriteHeadDiagramIds.add(row.id)
    } catch (error) {
      // Same rationale as the tombstone query: a database predating the read
      // model has no ro_diagrams. An empty set here would turn the absence of
      // the table into one violation PER DIAGRAM.
      if ((error as { code?: string }).code !== '42P01') throw error
      projectedWriteHeadDiagramIds = null
    }
  }

  // Is the write head's projection merely IN FLIGHT? The queue row carries
  // both halves of that question, and reading it costs one indexed lookup. No
  // row at all means nothing is pending, which is also the shape of a head
  // that was never enqueued, and must stay reportable.
  let registryWriteHeadProjectionLagMs: number | null = null
  if (registryWriteHeadUrl) {
    try {
      const { rows: queueRows } = await db.query<{ lag_ms: string | number }>(
        `SELECT EXTRACT(EPOCH FROM (now() - enqueued_at)) * 1000 AS lag_ms
           FROM read_model_static_document_queue
          WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3
            AND revision > projected_revision`,
        [key.landscapeId, key.versionId, documentIdOf(registryWriteHeadUrl)],
      )
      if (queueRows.length > 0) registryWriteHeadProjectionLagMs = Math.max(0, Number(queueRows[0].lag_ms))
    } catch (error) {
      // No queue table means no projector; the check then answers on the rows
      // alone, with no in-flight tolerance.
      if ((error as { code?: string }).code !== '42P01') throw error
    }
  }

  const { findings, checksRun, checksSkipped } = checkWorkspaceStructure({
    rootUrl,
    root,
    modelMeta,
    modelMetaUnresolved,
    unresolvedRegistries,
    referenced,
    presentIds: present,
    admittedIds: admitted,
    staticSource,
    staticDocumentRows,
    claimCoverage,
    diagramTombstones,
    liveTombstonedDiagramIds,
    registryWriteHeadUrl,
    registryWriteHeadStaticKinds,
    registryWriteHeadDiagramIds,
    projectedWriteHeadDiagramIds,
    registryWriteHeadProjectionLagMs,
    retainedOverlaySegments,
    overlayWriteHeads,
    overlaySegmentSizes,
  })

  // Status is decided HERE, from the completed pass, never from inside it.
  const status = fsckStatusOf(findings, checksSkipped)

  return {
    workspace: key,
    rootUrl,
    status,
    findings,
    checksRun,
    checksSkipped,
    reachableDocuments: referenced.length,
    diagramTombstoneCount: diagramTombstones.length,
    registryWriteHeadDiagramCount: registryWriteHeadDiagramIds?.length ?? null,
    bootCriticalBytes,
    largestBootDocumentBytes,
    overlayWriteHeadBytes: overlayWriteHeadBytesTotal(overlayWriteHeads),
    overlaySegmentSize: OVERLAY_SEGMENT_SIZE,
    overlayHeadCeiling: OVERLAY_HEAD_CEILING,
  }
}

/**
 * PARK-LEVEL check: two `versions` rows pointing at the SAME root document.
 *
 * This has happened in practice. Document admission is first-owner-wins PER
 * DOCUMENT, so the losing twin's docScope walk fails
 * "foreign" forever, its route backfill loops, and every COLD boot of it hangs
 * without a single error — warm clients hide it completely because they read
 * from IndexedDB. A per-workspace walk cannot see this (each twin's own graph
 * looks consistent); only the park view can.
 */
export interface SharedRootFinding {
  rootUrl: string
  workspaces: WorkspaceKey[]
}

/** Pure grouping so the verdict is unit-testable without a database. */
export function groupSharedRoots(
  rows: readonly { landscape_id: string; id: string; root_url: string }[],
): SharedRootFinding[] {
  const byRoot = new Map<string, WorkspaceKey[]>()
  for (const row of rows) {
    const list = byRoot.get(row.root_url) ?? []
    list.push({ landscapeId: row.landscape_id, versionId: row.id })
    byRoot.set(row.root_url, list)
  }
  return [...byRoot.entries()]
    .filter(([, workspaces]) => workspaces.length > 1)
    .map(([rootUrl, workspaces]) => ({ rootUrl, workspaces }))
}

export async function fsckSharedRoots(db: Queryable): Promise<SharedRootFinding[]> {
  const workspaces = await enumerateMaintainableWorkspaces(db)
  return groupSharedRoots(workspaces.map((workspace) => ({
    landscape_id: workspace.landscapeId,
    id: workspace.versionId,
    root_url: workspace.rootUrl,
  })))
}

/** Run the checker over every version in the registry. */
export async function fsckAllWorkspaces(
  db: Queryable,
  repo: Repo,
  options: WorkspaceFsckOptions = {},
): Promise<WorkspaceFsckReport[]> {
  const workspaces = await enumerateMaintainableWorkspaces(db)
  const reports: WorkspaceFsckReport[] = []
  for (const workspace of workspaces) {
    reports.push(await fsckWorkspace(
      db, repo, { landscapeId: workspace.landscapeId, versionId: workspace.versionId }, workspace.rootUrl, options,
    ))
  }
  return reports
}
