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
 * The ordinary→summary PROMOTION primitive, and its de-promotion.
 *
 * The summary world also serves sparse drafts (`draft/sparse.ts`) and the
 * performance fixtures (`performanceSeed/`), via `StaticDeltaProjector` +
 * `read_model_static_workspaces` / `read_model_static_documents`. This module is
 * the ENTRY DOOR for an ordinary landscape that has grown massive, the door back
 * out, and the door that FINISHES a half-open one:
 *
 *   {@link promoteSummaryWorkspace}  ordinary → summary (mints a write head)
 *   {@link demoteSummaryWorkspace}   summary  → ordinary (deletes the static rows)
 *   {@link repairSummaryFlag}        hybrid   → summary (the ROOT half only)
 *
 * The third exists because the hybrid state is REACHABLE two ways — a crash
 * between the promotion's commit and its root flip, and a flag stripped by hand
 * from a static fixture — and neither of the first two can regularise it:
 * `promote` refuses (`already-summary`, it would mint a SECOND write head and
 * split the mutable registry) and `demote` refuses any source it did not
 * promote.
 *
 * WHAT IT BUYS on a very large landscape (figures from a ~10k-diagram workspace):
 *
 *  - `bridge.ts`'s `if (!registrySummaryOnly)` branch — which resolves every
 *    registry shard (tens of MB over the socket, ~78 s) — stops executing. Only
 *    `registryWriteUrl` is resolved.
 *  - `planRegistryWrites` returns `{reconcile: [], placeIds: []}` once
 *    `registrySummaryOnly` holds, removing the O(n²) registry reconcile pass
 *    (~85 s in the first `flushWrite`).
 *  - `docScope`'s walk skips registry + base shards under `summaryOnly`
 *    (previously ~33 s, almost all WASM materialisation of registry shards).
 *
 * OPERATOR-TRIGGERED ONLY. There is deliberately no automatic threshold: a
 * boot-contract switch fired by a diagram count would be a surprise to users.
 * `npm run promote-summary` reports by default; `--apply` is the second,
 * explicit decision.
 *
 * TWO RULES THIS MODULE IS BUILT AROUND
 *
 *  1. **Never a parent before its children.** The write head is durable AND
 *     claimed, and the allow-list + static row are COMMITTED, before the root
 *     names any of it. The reason is asymmetric damage: a summary root with no
 *     static row is fsck `data-loss` (no client can list or open a diagram —
 *     the walk skips the registry by design and the baseline is server-owned),
 *     while a static row under a not-yet-summary root is fsck `degraded`. A
 *     crash lands in the second, never the first.
 *
 *     ⚠ `degraded` is the RECOVERABLE damage, not the harmless one: the static
 *     row alone ARMS the baseline write fence, and under the ordinary contract
 *     every registry shard a classic client would write a diagram creation or a
 *     rename into carries kind `registry` — baseline. From the commit until the
 *     root flip (or until a repair) those writes are DROPPED at the wire and
 *     that tab's sync badge honestly stays on "Enregistrement…". Nothing
 *     already durable is lost, and reads are untouched; new registry writes
 *     from a classic tab are. Which is why the crash window is not left to be
 *     discovered — {@link repairSummaryFlag} finishes it in one command.
 *  2. **Witnesses only, never a cache the promotion itself feeds.** Every
 *     precondition is answered by something independent of what the promotion
 *     writes: the read-model content seals, the arrival-watermark coverage, the
 *     registry shards materialised straight from Automerge storage, the claim
 *     tables. Nothing here asks the read model to vouch for the read model:
 *     a durability decision may consult DURABILITY WITNESSES only.
 *
 * THE FENCE WAIT. `buildBaselineWriteFence` caches its verdicts for
 * {@link BASELINE_FENCE_TTL_MS}; a server that answered "no static world" a
 * moment before the COMMIT keeps answering it for a while. So between the
 * commit and the root flip this module WAITS OUT the fence's full arming bound
 * ({@link BASELINE_FENCE_ARMING_BOUND_MS}). Without the wait, a baseline write
 * arriving inside the window would be applied and acked, and it would be
 * invisible to the summary world that starts one instant later — silent
 * CRDT↔SQL divergence. The quiesce must also not be lifted before the wait
 * ends; the caller lifts it by draining/accepting sockets AFTER this returns.
 *
 * WHAT IS NOT TOUCHED. The existing baseline registry shards stay in
 * `root.shardUrls`, kind `registry`, frozen and referenced. Removing them would
 * make fsck's reachability report one `document-orphaned` finding per shard, break
 * the static GC's SQL manifest, and break `staticRegistryReferenceRepair` /
 * `degenerateRootRepair`. Nobody LOADS them any more — that is the point — but
 * a deleted shard is a repair that becomes impossible later.
 */

import {
  Repo,
  generateAutomergeUrl,
  isValidAutomergeUrl,
  type DocHandle,
  type DocumentId,
  type StorageAdapterInterface,
} from '@automerge/automerge-repo'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { cachedHandles, findReadyDocument } from '../automergeRepoCompat.js'
import type { AutomergeResidencyLeases } from '../automergeResidency.js'
import { copyRootShape, ROOT_SHAPE_FIELDS, type WorkspaceRootShape } from '../rootShape.js'
import { BASELINE_FENCE_ARMING_BOUND_MS, isBaselineDocumentKind } from '../rbac/docScope.js'
import { CLAIM_PROTOCOL_VERSION, claimWorkspaceDocuments } from '../rbac/documentClaims.js'
import { readWorkspaceCoverage } from '../rbac/claimCoverage.js'
import { markStaticReadModelWorkspace } from '../readModel/staticWorkspace.js'
import { verifyWorkspaceIntegrity } from '../readModel/projectionIntegrity.js'
import { claimLifecycleWriteFence, getWorkspaceProjectionFreshness } from '../readModel/health.js'
import { PROJECTION_MUTEX_WAIT_MS, isDeadlockVictim, isProjectionMutexTimeout } from '../readModel/projectionAuthority.js'
import {
  acquireLifecycleApplyLock,
  releaseLifecycleApplyLock,
} from './lifecycleApplyLock.js'
import type { WorkspaceKey } from '../readModel/projector.js'
import type { Queryable } from '../readModel/types.js'
import { collectReferencedUrls, fsckWorkspace, type WorkspaceFsckReport } from './workspaceFsck.js'

// ============================================================================
// Shapes
// ============================================================================

/** The `read_model_static_workspaces.source` this module writes. A NEW value:
 * an operator-promoted ordinary landscape is neither a performance fixture nor
 * a sparse draft, and the distinction is what makes de-promotion safe to refuse
 * for the other two. */
export const PROMOTED_STATIC_SOURCE = 'promoted'

export type StaticDocumentKind =
  | 'root'
  | 'model-meta'
  | 'model-legacy'
  | 'object-base'
  | 'connection-base'
  | 'decision-record-base'
  | 'object-overlay'
  | 'connection-overlay'
  | 'registry'
  | 'registry-shard'
  | 'diagram'

export interface AllowListEntry {
  documentId: string
  kind: StaticDocumentKind
  entityId?: string
}

export type PromotionBlockerCode =
  | 'no-such-workspace'
  | 'root-unresolved'
  /** The root NAMES a ModelMeta and it did not resolve. Distinct from
   * `monolith-workspace` (names none) and from `root-unresolved`: without the
   * ModelMeta there is no overlay/base inventory, so the allow-list cannot be
   * built — and an apply that discovers this must SAY so rather than return a
   * report with no blockers and nothing applied. */
  | 'meta-unresolved'
  | 'monolith-workspace'
  | 'already-summary'
  /** Another promotion of this exact workspace holds the apply lock. Not a
   * defect — the second caller simply did not get the door. */
  | 'promotion-in-flight'
  /** A witness the verdict was computed from MOVED between the ~33 s of
   * evidence-gathering and the transaction. The verdict is stale by
   * construction, so it is discarded rather than acted on. */
  | 'witness-moved'
  | 'fsck-not-clean'
  | 'read-model-not-sealed'
  | 'read-model-not-caught-up'
  | 'projector-instance-mismatch'
  | 'crdt-sql-divergence'
  | 'registry-unresolved'
  | 'claim-coverage-missing'
  | 'peers-connected'
  | 'quiesce-unproven'
  | 'allow-list-incomplete'
  | 'allow-list-unclassified'

export interface PromotionBlocker {
  code: PromotionBlockerCode
  detail: string
}

export interface PromotionWitnesses {
  /** fsck's own verdict — status plus the two write-head structural checks. */
  fsck: {
    status: WorkspaceFsckReport['status']
    findings: number
    modelWriteHead: 'ran' | 'skipped'
    writeHeadVersion: 'ran' | 'skipped'
  } | null
  /** Read-model content seals versus the actual `ro_*` aggregates. */
  integrity: { outcome: string; summary: string } | null
  /** The arrival-watermark witness. This is what actually defeats the
   * stale-state trap: a `read_model_projection_state` row left by a PREVIOUS process
   * carries a plausible generation, but it cannot cover storage arrivals minted
   * after it — `absenceProvable` compares the two and refuses. */
  freshness: { status: string; caughtUp: boolean; absenceProvable: boolean } | null
  projectorInstanceId: string | null
  coverage: { covered: boolean; protocol: number } | null
  /** MEASURED live sockets on this workspace, or `null` when this process
   * cannot see them (a standalone script has no WebSocket server). `null` is
   * not zero — see `quiesce` below. */
  connectedPeers: number | null
  /** How the quiesce was established: measured in-process, or asserted by the
   * operator with `--assume-quiesced`. Recorded so a promotion report never
   * reads as "proved" when it was "promised". */
  quiesce: 'measured' | 'operator-asserted' | 'unknown'
  /** The registry materialisation pass — one shard at a time, ephemeral repo
   * per shard, nothing retained but `id -> docUrl`. */
  registry: {
    shards: number
    shardsUnresolved: number
    diagramsInCrdt: number
    diagramsInReadModel: number
    materializeMs: number
  } | null
}

export interface PromotionPlan {
  /** Every document the promoted allow-list will carry, kinds included. */
  allowList: AllowListEntry[]
  /** Reachable documents this module could not give a kind to. Non-empty is an
   * ABORT: an unlisted document stops resolving durably once the static row
   * lands (`resolveDurable`'s `static_allowed` filter). */
  unclassified: string[]
  /** Admitted to the workspace but absent from the allow-list — the same fatal
   * shape, discovered from the other side. */
  admittedButUnlisted: string[]
  /** In the allow-list but not admitted (the fresh write head is excluded — it
   * is claimed inside the promotion's own transaction). */
  listedButUnadmitted: string[]
  diagramCount: number
  /** The frozen baseline registry shards. They STAY in `root.shardUrls`. */
  frozenRegistryShards: number
}

/**
 * The blockers an operator may explicitly override, and the ONLY ones.
 *
 * The quiesce protects against a loss that is real but BOUNDED and NAMED:
 *
 *  - a classic tab's in-flight ENTITY writes. Its DiagramDoc writes survive —
 *    those are ordinary CRDT documents, still writable under the fence.
 *  - a DIAGRAM CREATED in the window, the sharper half: a classic tab creates a diagram by writing
 *    into a baseline registry shard, the server ACKS it while the fence is not
 *    yet armed for that document, and the moment the static row lands the new
 *    diagram is in a document `resolveDurable`'s `static_allowed` filter does
 *    not list. It was accepted, it is in storage, and it is unreachable. The
 *    drain below is what shortens that window to nothing on the overridden
 *    path: under an override the peers are asked to reconnect BEFORE the
 *    commit, not after the root flip.
 *
 * Every other precondition protects against a loss that is unbounded or silent
 * — an unlisted document that stops resolving forever, a read model that never
 * matched the CRDT — and none of those has an override, deliberately.
 *
 * The override exists because the online case is a REAL operational scenario
 * (the residual window is closed by the baseline fence plus the client's epoch
 * guard), and because the epoch guard's own e2e —
 * `e2e/boot/workspace-contract-promotion.spec.ts` — has to promote a workspace
 * with a live classic tab on it, which is by definition not quiesced.
 *
 * PINNED AS A SET by the unit suite: adding a code here is a decision about
 * what an operator may wave through, so it must fail a test.
 */
export const OVERRIDABLE_BLOCKERS: ReadonlySet<PromotionBlockerCode> = new Set([
  'peers-connected',
  'quiesce-unproven',
])

export interface SummaryPromotionReport {
  workspace: WorkspaceKey
  rootUrl: string | null
  mode: 'report' | 'apply'
  /**
   * FALSE when this door could not prove, at release time, that its session
   * still held the workspace's apply lock.
   *
   * Absent on a run that never took the lock (a report, or a refusal before
   * the door) — so absence means "no critical section", never "it was fine".
   *
   * It is NOT a retry hint. It says some part of this run's writes happened
   * with nothing excluding the other three doors, because Postgres drops a
   * dead backend's advisory locks instantly and silently. The answer is fsck,
   * not another attempt.
   */
  exclusionProven?: boolean
  /** Empty ⇒ the promotion may proceed. Non-empty ⇒ it did not, and will not. */
  blockers: PromotionBlocker[]
  /** Blockers the operator explicitly overrode with `allowConnectedPeers`. They
   * are REPORTED, never dropped: a promotion that ran over a live tab must say
   * so in its own record, and in the audit entry. */
  overridden: PromotionBlocker[]
  witnesses: PromotionWitnesses
  plan: PromotionPlan | null
  applied: {
    writeHeadUrl: string
    allowListSize: number
    staticSource: string
    /** Milliseconds actually waited between the COMMIT and the root flip. Must
     * be ≥ {@link BASELINE_FENCE_ARMING_BOUND_MS} — the fence's FULL arming
     * bound, not one TTL; it is reported so an operator log can be checked
     * against the constant without reading this file. */
    fenceWaitMs: number
    diagramCount: number
  } | null
}

// ============================================================================
// The allow-list builder — PURE
// ============================================================================

const documentIdOf = (value: string): string => value.replace(/^automerge:/, '').split('?')[0]

const urlList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && isValidAutomergeUrl(entry))
    : []
)

const oneUrl = (value: unknown): string | null => (
  typeof value === 'string' && isValidAutomergeUrl(value) ? value : null
)

export interface AllowListInput {
  rootUrl: string
  root: Record<string, unknown>
  /** `undefined` only for a monolith workspace, which cannot be promoted. */
  modelMeta: Record<string, unknown> | undefined
  /** The resolved registry shards, in `root.shardUrls` order; `undefined` for
   * one that did not resolve (the caller aborts on those separately). Only
   * `diagrams[id].docUrl` is read, so a SLIMMED `{diagrams: {id: {docUrl}}}` is
   * a legal argument — and is what the materialisation pass produces, so no
   * registry content is retained. */
  registries: readonly (Record<string, unknown> | undefined)[]
  /** The FRESH registry write head. Never a member of `root.shardUrls` yet. */
  writeHeadUrl: string
  /** `diagram id -> DiagramDoc url`, from `ro_diagrams`. The allow-list is
   * derived from the READ MODEL because the read model is what the summary
   * world serves; precondition 3 has already proved it equals the CRDT. */
  diagramDocUrls: ReadonlyMap<string, string>
}

/**
 * Carry already-admitted overlay segments across a re-promotion.
 *
 * `buildPromotionAllowList` derives overlay entries from ModelMeta's plural
 * lists, and the chain fold REMOVES a folded prefix from those lists. Since
 * `markStaticReadModelWorkspace` deletes the whole allow-list before
 * reinserting, a re-promotion after a fold would drop the folded segments'
 * rows — and on a static workspace `resolveDurable` answers from exactly that
 * table, so all three sync gates would DENY those documents with no mechanism
 * to lift it. An offline client reconnecting on a folded head would be
 * quarantined permanently.
 *
 * Pure, and separate from the SQL, because the caller lives inside a
 * transaction that only the DB-gated integration suite ever executes.
 */
export function mergePreservedOverlayEntries<T extends { documentId: string; kind: string }>(
  entries: readonly T[],
  admittedOverlays: readonly { document_id: string; kind: string }[],
): (T | { documentId: string; kind: string })[] {
  const known = new Set(entries.map((entry) => entry.documentId))
  const preserved: { documentId: string; kind: string }[] = []
  for (const row of admittedOverlays) {
    // Deduplicate against BOTH the built list and the rows already taken: the
    // query can legitimately return a document twice if the two tables
    // disagree, and a duplicate id would violate the allow-list's uniqueness.
    if (known.has(row.document_id)) continue
    known.add(row.document_id)
    preserved.push({ documentId: row.document_id, kind: row.kind })
  }
  return [...entries, ...preserved]
}

/**
 * Build the complete static allow-list for a promotion.
 *
 * The reachable set comes from `collectReferencedUrls` — fsck's own walk —
 * rather than from a second hand-written traversal: the allow-list and fsck's
 * reachability MUST agree, and one producer guarantees it. A document reachable
 * but unclassified is returned in `unclassified` and is an abort, never a silent
 * omission: after the static row lands, `resolveDurable`'s `static_allowed`
 * filter makes an unlisted document permanently unresolvable.
 *
 * ⚠ The write head lives inside the registry shard list, and kind `registry`
 * is baseline: labelling the write head `registry` would make the baseline
 * write fence drop every diagram creation and rename. Here the write head is
 * applied LAST and its kind is forced to `registry-shard`;
 * `assertWriteHeadIsWritable` below re-checks it against the ONE kind
 * predicate before anything is committed.
 */
export function buildPromotionAllowList(input: AllowListInput): {
  entries: AllowListEntry[]
  unclassified: string[]
} {
  const { root, modelMeta, registries, rootUrl, writeHeadUrl, diagramDocUrls } = input
  const referenced = collectReferencedUrls(root, modelMeta, registries)

  const byId = new Map<string, AllowListEntry>()
  const put = (url: string, kind: StaticDocumentKind, entityId?: string): void => {
    const id = documentIdOf(url)
    byId.set(id, entityId ? { documentId: id, kind, entityId } : { documentId: id, kind })
  }

  // Overlay heads first, so the base pass below can subtract them and the
  // overwrite order stays explicit rather than accidental.
  const objectOverlays = new Set<string>([
    ...urlList(modelMeta?.editsObjectShardUrls),
    ...(oneUrl(modelMeta?.editsObjectShardUrl) ? [oneUrl(modelMeta?.editsObjectShardUrl)!] : []),
  ])
  const connectionOverlays = new Set<string>([
    ...urlList(modelMeta?.editsConnectionShardUrls),
    ...(oneUrl(modelMeta?.editsConnectionShardUrl) ? [oneUrl(modelMeta?.editsConnectionShardUrl)!] : []),
  ])

  for (const url of urlList(modelMeta?.objectShardUrls)) {
    if (!objectOverlays.has(url)) put(url, 'object-base')
  }
  for (const url of urlList(modelMeta?.connectionShardUrls)) {
    if (!connectionOverlays.has(url)) put(url, 'connection-base')
  }
  for (const url of urlList(modelMeta?.decisionRecordShardUrls)) put(url, 'decision-record-base')
  // RETIRED overlay segments are still listed in `editsObjectShardUrls`; they
  // are overlays, not baseline, and labelling them `*-base` would fence the
  // very documents a rotation may still need to fold. All of them get the
  // writable overlay kind.
  for (const url of objectOverlays) put(url, 'object-overlay')
  for (const url of connectionOverlays) put(url, 'connection-overlay')

  // The frozen baseline registry. These KEEP their place in `root.shardUrls`
  // (see the module header) and are exactly what the fence must freeze.
  for (const url of urlList(root.shardUrls)) put(url, 'registry')

  const legacy = oneUrl(root.modelUrl)
  if (legacy) put(legacy, 'model-legacy')
  const metaUrl = oneUrl(root.modelMetaUrl)
  if (metaUrl) put(metaUrl, 'model-meta')

  for (const [diagramId, docUrl] of diagramDocUrls) {
    if (!isValidAutomergeUrl(docUrl)) continue
    put(docUrl, 'diagram', diagramId)
  }

  // The root itself is not in `referenced` (collectReferencedUrls excludes it).
  put(rootUrl, 'root')
  // LAST, and unconditional: the write head is the one document of a summary
  // workspace that a client MUST keep writing.
  put(writeHeadUrl, 'registry-shard')

  const unclassified = referenced
    .map(documentIdOf)
    .filter((id) => !byId.has(id))

  return { entries: [...byId.values()], unclassified: [...new Set(unclassified)] }
}

/**
 * Executable check IN the promotion path (not only in a test): the write head
 * must be writable under the ONE kind predicate, and no baseline-kinded entry
 * may carry its document id.
 */
export function assertWriteHeadIsWritable(entries: readonly AllowListEntry[], writeHeadUrl: string): void {
  const id = documentIdOf(writeHeadUrl)
  const mine = entries.filter((entry) => entry.documentId === id)
  if (mine.length !== 1) {
    throw new Error(`promotion allow-list carries ${mine.length} entries for the write head ${id}; expected exactly 1`)
  }
  if (mine[0].kind !== 'registry-shard' || isBaselineDocumentKind(mine[0].kind)) {
    throw new Error(
      `promotion allow-list labelled the registry write head '${mine[0].kind}': the baseline write fence would `
      + 'drop every diagram creation and rename on this workspace (the performance-fixture defect). '
      + "The write head is ALWAYS 'registry-shard'.",
    )
  }
}

// ============================================================================
// Preconditions — PURE
// ============================================================================

export interface PromotionFacts {
  rootUrl: string | null
  root: Record<string, unknown> | undefined
  fsck: WorkspaceFsckReport | null
  integrity: { outcome: string } | null
  freshness: { status: string; caughtUp: boolean; absenceProvable: boolean } | null
  projectorInstanceId: string | null
  /** When the caller can name the projector instance of the CURRENT run (the
   * server can; a standalone script cannot), a mismatch is an abort. */
  expectedProjectorInstanceId: string | null
  coverage: { covered: boolean; protocol: number } | null
  /** `null` = this process cannot see the sockets. Never treated as zero. */
  connectedPeers: number | null
  /** The operator's explicit `--assume-quiesced`. Only meaningful when
   * `connectedPeers` is `null`; it can never override a MEASURED non-zero. */
  quiesceAssertedByOperator: boolean
  staticSource: string | null
  /** `id -> docUrl` materialised from the registry shards. */
  crdtDiagrams: ReadonlyMap<string, string> | null
  /** `id -> docUrl` read from `ro_diagrams`. */
  readModelDiagrams: ReadonlyMap<string, string> | null
  unresolvedRegistryShards: readonly string[]
}

/** How many mismatching ids a blocker message names before it truncates. */
const BLOCKER_SAMPLE = 5

const sample = (values: readonly string[]): string => (
  values.length <= BLOCKER_SAMPLE
    ? values.join(', ')
    : `${values.slice(0, BLOCKER_SAMPLE).join(', ')} … (+${values.length - BLOCKER_SAMPLE} more)`
)

/**
 * The six promotion preconditions, as a pure function of already-gathered facts.
 *
 * Pure on purpose, like `checkWorkspaceStructure`: the deciding code is what
 * has to be testable without a database, a repo or a clock.
 */
export function evaluatePromotionPreconditions(facts: PromotionFacts): PromotionBlocker[] {
  const blockers: PromotionBlocker[] = []
  const block = (code: PromotionBlockerCode, detail: string) => blockers.push({ code, detail })

  if (!facts.rootUrl) {
    block('no-such-workspace', 'no versions row / root_url for this workspace')
    return blockers
  }
  if (!facts.root) {
    block('root-unresolved', `the root document ${facts.rootUrl} did not resolve`)
    return blockers
  }

  // ── already summary ───────────────────────────────────────────────────────
  // Both halves, because either one alone is the hybrid state fsck reports.
  if (facts.root.registrySummaryOnly === true || facts.staticSource !== null) {
    const hybrid = facts.root.registrySummaryOnly !== true && facts.staticSource !== null
    block(
      'already-summary',
      `this workspace is already in the summary world (registrySummaryOnly=${String(facts.root.registrySummaryOnly === true)}, `
      + `read_model_static_workspaces.source=${facts.staticSource ?? 'none'}). Promotion is not idempotent — `
      + 'it mints a NEW write head, and a second one would split the mutable registry. '
      + (hybrid
        // The HALF-OPEN state, and the way out of it BY NAME. Reached by a crash
        // between the commit and the root flip, or by a flag stripped from a
        // static fixture by hand. Promote and demote both refuse it, so the
        // message names the repair door explicitly.
        ? 'This one is HYBRID (static rows, ordinary root): the baseline write fence is already armed, '
          + 'so a classic tab\'s diagram creations and renames are being dropped right now. Finish it with '
          + '`npm run repair-summary-flag -- --apply` (POST /api/platform/workspace/repair-summary-flag), '
          + 'which restores the root half ONLY and mints nothing.'
        : 'To take it back out, use `npm run demote-summary -- --apply` '
          + '(POST /api/platform/workspace/demote-summary).'),
    )
  }

  // ── 1. sharded root with durable heads ────────────────────────────────────
  if (!oneUrl(facts.root.modelMetaUrl)) {
    block(
      'monolith-workspace',
      'the root names no ModelMeta: a monolith workspace has no overlay write heads and no base shards, '
      + 'so there is no baseline for the summary contract to freeze. Shard it server-side first.',
    )
  }

  // ── 4. fsck clean (and 1: the two structural checks must have RUN) ────────
  if (!facts.fsck) {
    block('fsck-not-clean', 'fsck did not run')
  } else if (facts.fsck.status !== 'clean') {
    const worst = facts.fsck.findings.map((finding) => `${finding.severity}/${finding.check}`)
    block(
      'fsck-not-clean',
      `fsck reports ${facts.fsck.status}${worst.length ? `: ${sample([...new Set(worst)])}` : ''}. `
      + 'A promotion arms `static_allowed`, so every pre-existing structural defect becomes permanent '
      + 'for cold clients. Repair first.',
    )
  } else {
    for (const check of ['model-write-head', 'write-head-version'] as const) {
      if (!facts.fsck.checksRun.includes(check)) {
        block('fsck-not-clean', `fsck skipped ${check}, so the durable write-head invariant was never established`)
      }
    }
  }

  // ── 2. read model complete and SEALED ─────────────────────────────────────
  if (!facts.integrity || facts.integrity.outcome !== 'verified') {
    block(
      'read-model-not-sealed',
      `the T1.3b content seals answer '${facts.integrity?.outcome ?? 'absent'}', not 'verified'. `
      + 'The summary world serves its global views from ro_*; promoting on unsealed rows publishes '
      + 'whatever drift is in them.',
    )
  }
  if (!facts.freshness) {
    block('read-model-not-caught-up', 'projection freshness could not be read')
  } else {
    if (facts.freshness.status !== 'healthy' || !facts.freshness.caughtUp) {
      block(
        'read-model-not-caught-up',
        `projection status '${facts.freshness.status}', caughtUp=${facts.freshness.caughtUp}: `
        + 'projected_generation has not met observed_generation for this workspace',
      )
    }
    if (!facts.freshness.absenceProvable) {
      // A stale `read_model_projection_state` row from a previous process looks
      // exactly like data — but it cannot cover an arrival minted after it,
      // and this predicate compares the two.
      block(
        'read-model-not-caught-up',
        'the arrival-watermark witness refuses: a durable write exists that the last completed projection '
        + 'provably does not include. A stale projection-state row would read healthy here — this is the '
        + 'check that tells them apart.',
      )
    }
  }
  if (
    facts.expectedProjectorInstanceId !== null
    && facts.projectorInstanceId !== facts.expectedProjectorInstanceId
  ) {
    block(
      'projector-instance-mismatch',
      `read_model_projection_state.projector_instance_id is ${facts.projectorInstanceId ?? 'NULL'}, not this run's `
      + `${facts.expectedProjectorInstanceId}: the row was written by another process and says nothing about now`,
    )
  }

  // ── 3. CRDT ↔ SQL equivalence, on IDS and docUrl ──────────────────────────
  if (facts.unresolvedRegistryShards.length > 0) {
    block(
      'registry-unresolved',
      `${facts.unresolvedRegistryShards.length} registry shard(s) did not resolve: ${sample(facts.unresolvedRegistryShards)}. `
      + 'Their diagrams cannot be compared, so the allow-list cannot be proven complete.',
    )
  }
  if (!facts.crdtDiagrams || !facts.readModelDiagrams) {
    block('crdt-sql-divergence', 'the registry↔read-model comparison did not run')
  } else {
    const missingFromReadModel: string[] = []
    const urlMismatch: string[] = []
    for (const [id, docUrl] of facts.crdtDiagrams) {
      const projected = facts.readModelDiagrams.get(id)
      if (projected === undefined) missingFromReadModel.push(id)
      else if (projected !== docUrl) urlMismatch.push(id)
    }
    const missingFromCrdt = [...facts.readModelDiagrams.keys()].filter((id) => !facts.crdtDiagrams!.has(id))
    if (missingFromReadModel.length) {
      block(
        'crdt-sql-divergence',
        `${missingFromReadModel.length} diagram(s) exist in the registry shards but not in ro_diagrams `
        + `(${sample(missingFromReadModel)}). Their DiagramDocs would be absent from the allow-list and `
        + 'resolveDurable would stop resolving them the moment the static row lands — the document would '
        + 'still be in storage and unreachable forever.',
      )
    }
    if (missingFromCrdt.length) {
      block(
        'crdt-sql-divergence',
        `${missingFromCrdt.length} diagram(s) exist in ro_diagrams but in no registry shard `
        + `(${sample(missingFromCrdt)}): the read model is ahead of, or diverged from, the CRDT`,
      )
    }
    if (urlMismatch.length) {
      block(
        'crdt-sql-divergence',
        `${urlMismatch.length} diagram(s) point at a different document in ro_diagrams than in the registry `
        + `(${sample(urlMismatch)}): the allow-list would admit one document and the client would open the other`,
      )
    }
  }

  // ── 5. document-claim coverage marker present ─────────────────────────────
  if (!facts.coverage || !facts.coverage.covered || facts.coverage.protocol < CLAIM_PROTOCOL_VERSION) {
    block(
      'claim-coverage-missing',
      `workspace_claim_coverage is ${facts.coverage ? `covered=${facts.coverage.covered} protocol=${facts.coverage.protocol}` : 'absent'} `
      + `(current protocol ${CLAIM_PROTOCOL_VERSION}). Without the marker the static row changes the walk memo's `
      + 'semantics at the worst possible moment. Let the workspace earn its marker first.',
    )
  }

  // ── 6. quiesce ────────────────────────────────────────────────────────────
  // Do not "relax" this without knowing the reason: a CLASSIC tab does not
  // journal its entity writes — the
  // client-side intent capture is gated on `bfsActive` — so any object or
  // connection edit in flight between the fence commit and that tab's reload
  // is lost with no journal to replay it from. Its DiagramDoc edits survive
  // (those are ordinary CRDT documents, still writable under the fence); its
  // ENTITY edits do not. That asymmetry, not tidiness, is the quiesce.
  const quiesceReason = 'v1 refuses an online promotion because a CLASSIC tab does not journal its entity writes '
    + '(the client intent capture is gated on `bfsActive`): any object/connection edit in flight between the '
    + "fence commit and that tab's reload is lost with no journal to replay it from. DiagramDoc edits would "
    + 'survive; entity edits would not.'
  if (facts.connectedPeers !== null && facts.connectedPeers > 0) {
    block(
      'peers-connected',
      `${facts.connectedPeers} peer(s) are connected to this workspace. ${quiesceReason} `
      + 'Close every session on this workspace and re-run.',
    )
  } else if (facts.connectedPeers === null && !facts.quiesceAssertedByOperator) {
    // `null` is NOT zero. A process with no WebSocket server (the standalone
    // script) has PROVED nothing; a fabricated zero would make the
    // precondition read as satisfied on exactly the runs where it was never
    // checked.
    block(
      'quiesce-unproven',
      'this process cannot see the workspace\'s live sockets, so the quiesce is unproven. '
      + `${quiesceReason} Either promote through the server route (which measures the census) or stop the `
      + 'sync server / confirm no session is open and re-run with --assume-quiesced.',
    )
  }

  return blockers
}

// ============================================================================
// Registry materialisation
// ============================================================================

/**
 * Materialise every registry shard ONE AT A TIME and keep nothing but
 * `diagram id -> docUrl`.
 *
 * A fresh `Repo` per shard, shut down before the next one opens: memory is
 * bounded to ONE shard's WASM document, not to the workspace. This is the
 * `flushAndClose` discipline of `performanceSeed/workspace.ts`, applied to a
 * read.
 *
 * The return value is a SLIM `{diagrams: {id: {docUrl}}}` rather than the
 * shard document: retaining the resolved docs (or their handles) would keep
 * every shard's WASM memory alive for the whole pass.
 *
 * `network: []` on purpose: with an adapter attached and no peer connected,
 * `repo.find()` never settles for a missing document — which is exactly the
 * condition this pass has to be able to report.
 */
export async function materializeRegistryDiagrams(
  storage: StorageAdapterInterface,
  shardUrls: readonly string[],
  options: { resolveTimeoutMs?: number; onShard?: (done: number, total: number) => void } = {},
): Promise<{
  diagrams: Map<string, string>
  duplicateIds: string[]
  unresolved: string[]
  slimRegistries: Record<string, unknown>[]
  elapsedMs: number
}> {
  const timeoutMs = options.resolveTimeoutMs ?? 15_000
  const startedAt = Date.now()
  const diagrams = new Map<string, string>()
  const duplicateIds: string[] = []
  const unresolved: string[] = []
  const slimRegistries: Record<string, unknown>[] = []

  for (const [index, shardUrl] of shardUrls.entries()) {
    const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
    try {
      const handle = await findReadyDocument<Record<string, unknown>>(repo, shardUrl, timeoutMs)
      const doc = handle.doc()
      const entries = doc && typeof doc.diagrams === 'object' && doc.diagrams !== null && !Array.isArray(doc.diagrams)
        ? Object.entries(doc.diagrams as Record<string, { docUrl?: unknown }>)
        : []
      const slim: Record<string, { docUrl: string }> = {}
      for (const [id, meta] of entries) {
        const docUrl = typeof meta?.docUrl === 'string' ? meta.docUrl : ''
        if (diagrams.has(id) && diagrams.get(id) !== docUrl) duplicateIds.push(id)
        diagrams.set(id, docUrl)
        slim[id] = { docUrl }
      }
      slimRegistries.push({ diagrams: slim })
    } catch {
      unresolved.push(shardUrl)
    } finally {
      // Drop the repo (and with it the document's WASM memory) before the next
      // shard is opened. Not in a `catch` — a failure must release it too.
      await repo.shutdown().catch(() => undefined)
    }
    options.onShard?.(index + 1, shardUrls.length)
  }

  return { diagrams, duplicateIds, unresolved, slimRegistries, elapsedMs: Date.now() - startedAt }
}

// ============================================================================
// The promotion
// ============================================================================

/** The observable points of the ordered transaction. A caller (and the ordering
 * tests) can inspect DURABLE state at each of them; a hook that THROWS
 * simulates a crash exactly there. */
export type PromotionStep =
  | 'write-head-durable'
  | 'allow-list-built'
  | 'static-committed'
  | 'projector-released'
  | 'fence-waited'
  | 'root-flipped'

export interface PromotionHooks {
  /** Detach the ORDINARY projector. Wired to `ProjectorFleet.release` in
   * production; the fleet also refuses to re-attach a static workspace, so the
   * two together close the double-projection window. */
  releaseOrdinaryProjector?: (key: WorkspaceKey, reason: string) => void
  /** Feed the in-process doc index the newly claimed write head, AFTER the
   * commit (the index API takes a pool, so it cannot join the transaction —
   * the durable claim inside the transaction is what matters, this is the cache
   * catching up). */
  announceDocuments?: (args: { key: WorkspaceKey; rootUrl: string; documentIds: string[] }) => Promise<void> | void
  /** Ask any socket bound to this workspace to reconnect. Normally a no-op
   * belt — the quiesce precondition already proved there are none — but it
   * matters under the `allowConnectedPeers` override. */
  drainPeers?: (key: WorkspaceKey, reason: string) => void
  /** Test seam: observe (or interrupt) the ordered transaction. */
  onStep?: (step: PromotionStep) => Promise<void> | void
}

export interface PromoteSummaryOptions {
  db: Pool
  /**
   * The pool the lifecycle apply LOCK TOKEN is taken from. Defaults to `db`,
   * which is what tests want (an injected pool is usually an isolated schema).
   * Production passes `lifecycleApplyPool` so a long-held lock (tens of
   * seconds) does not pin a general-purpose connection; under concurrent
   * promotions that starved the primary pool.
   */
  lockDb?: Pool
  repo: Repo
  /** The live repo's shared residency registry. An isolated caller with no
   * eviction machinery must explicitly pass null. */
  residency: AutomergeResidencyLeases | null
  /** Storage for the ephemeral per-shard repos of the CRDT↔SQL comparison. */
  storage: StorageAdapterInterface
  workspace: WorkspaceKey
  /** DEFAULT FALSE — report only, like fsck and repairDegenerateRoots. */
  apply?: boolean
  /** MEASURE the live sockets on this workspace. Return `null` for "this
   * process cannot see them" — never a fabricated 0. Omitting the option is
   * the same as returning `null`. */
  connectedPeers?: () => number | null | Promise<number | null>
  /** The operator's `--assume-quiesced`. Unblocks an UNMEASURABLE census only;
   * it can never override a measured non-zero one. */
  assumeQuiesced?: boolean
  /** The operator's `--allow-connected-peers`. Moves the quiesce blockers into
   * `overridden` instead of refusing. See {@link OVERRIDABLE_BLOCKERS} — this
   * is the ONLY overridable precondition, and what it costs is a live classic
   * tab's in-flight ENTITY writes. */
  allowConnectedPeers?: boolean
  /** The projector instance id of the current run, when the caller knows it. */
  expectedProjectorInstanceId?: string | null
  hooks?: PromotionHooks
  /** Injected for the fence-wait test; production uses real time. */
  clock?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Per-document resolve ceiling. `repo.find()` never settles without it. */
  resolveTimeoutMs?: number
  onProgress?: (message: string) => void
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})

async function readRootUrl(db: Queryable, key: WorkspaceKey): Promise<string | null> {
  const { rows } = await db.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE landscape_id = $1 AND id = $2',
    [key.landscapeId, key.versionId],
  )
  return rows[0]?.root_url ?? null
}

async function readStaticSource(db: Queryable, key: WorkspaceKey): Promise<string | null> {
  const { rows } = await db.query<{ source: string }>(
    'SELECT source FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2',
    [key.landscapeId, key.versionId],
  )
  return rows[0]?.source ?? null
}

async function readModelDiagramUrls(db: Queryable, key: WorkspaceKey): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; doc_url: string | null }>(
    `SELECT id, data->>'docUrl' AS doc_url FROM ro_diagrams
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return new Map(rows.map((row) => [row.id, row.doc_url ?? '']))
}

async function readAdmittedIds(db: Queryable, key: WorkspaceKey): Promise<Set<string>> {
  const { rows } = await db.query<{ document_id: string }>(
    `SELECT document_id FROM automerge_document_workspace
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return new Set(rows.map((row) => row.document_id))
}

async function readProjectorInstanceId(db: Queryable, key: WorkspaceKey): Promise<string | null> {
  const { rows } = await db.query<{ projector_instance_id: string | null }>(
    `SELECT projector_instance_id FROM read_model_projection_state
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  return rows[0]?.projector_instance_id ?? null
}

/**
 * Apply a rebuilt root shape ONTO the live root document, in place.
 *
 * In place, not a rotation: the URL must not change. Every client cache, every
 * `versions.root_url`, every share link and the residency pin all key off it,
 * and a rotation would turn a bounded operation into a fleet-wide cache
 * invalidation. The VALUE still goes through `copyRootShape`, so the promotion
 * is not an eleventh root producer with its own literal — and a key outside
 * `ROOT_SHAPE_FIELDS` on a damaged root is dropped rather than carried over.
 */
function applyRootShape(handle: DocHandle<Record<string, unknown>>, next: WorkspaceRootShape): void {
  const fields = next as unknown as Record<string, unknown>
  handle.change((doc) => {
    for (const field of ROOT_SHAPE_FIELDS) {
      const value = fields[field]
      if (value === undefined) {
        if (field in doc) delete doc[field]
      } else {
        doc[field] = value
      }
    }
  })
}

/**
 * Re-read, under the lock and immediately before BEGIN, the witnesses that can
 * MOVE — and refuse the apply if any of them did.
 *
 * The lock alone does not close this: the neighbour that made the workspace
 * summary may have committed and released before this promotion ever asked for
 * the door, and a verdict computed against facts tens of seconds old would then
 * apply on top of it. Evidence has a lifetime, and acting on expired evidence
 * is the failure, not the delay.
 *
 * Only the volatile ones. fsck, the content seals and the registry↔read-model
 * comparison are not re-run: each costs the whole materialisation pass again,
 * and each is already protected by something that outlives the window (the
 * allow-list is committed in the same transaction as the static row; a
 * divergence appearing inside the window would have to come from a writer this
 * promotion just proved is not there).
 *
 * Returns the reason as a string, or `null` when nothing moved.
 */
async function volatileWitnessesMoved(args: {
  db: Pool
  workspace: WorkspaceKey
  rootHandle: DocHandle<Record<string, unknown>>
  before: {
    staticSource: string | null
    freshness: { status: string; caughtUp: boolean; absenceProvable: boolean } | null
    registrySummaryOnly: boolean
  }
  connectedPeers?: () => number | null | Promise<number | null>
}): Promise<string | null> {
  const { db, workspace, rootHandle, before } = args

  const staticSource = await readStaticSource(db, workspace)
  if (staticSource !== before.staticSource) {
    return `read_model_static_workspaces.source changed from ${before.staticSource ?? 'none'} to `
      + `${staticSource ?? 'none'} while this promotion was gathering its evidence: another promotion `
      + 'won the race. Nothing was written.'
  }

  const rootNow = rootHandle.doc()
  if ((rootNow?.registrySummaryOnly === true) !== before.registrySummaryOnly) {
    return 'the root document became summary-only while this promotion was gathering its evidence. '
      + 'Nothing was written.'
  }

  const freshness = await getWorkspaceProjectionFreshness(db, workspace)
  if (!freshness || freshness.status !== 'healthy' || !freshness.caughtUp || !freshness.absenceProvable) {
    // The message names the VERDICT and the two things that can produce it,
    // and asserts neither. "A durable write arrived" is often wrong:
    // `projectionStatusSql`'s `stale` branch is `newest_durable_write_at >
    // last_projected_at AND newest_durable_write_at < now() -
    // DEFAULT_STALE_GRACE_MS`, so a write to an admitted document the ordinary
    // projector never projects (a DiagramDoc, a registry shard, the root) can
    // cross the grace on its own during evidence gathering — the clock moved,
    // not the data.
    const was = before.freshness
    return `projection freshness is '${freshness?.status ?? 'unreadable'}', `
      + `caughtUp=${String(freshness?.caughtUp)}, absenceProvable=${String(freshness?.absenceProvable)} `
      + `(at the plan: '${was?.status ?? 'unreadable'}', caughtUp=${String(was?.caughtUp)}, `
      + `absenceProvable=${String(was?.absenceProvable)}). Either a durable write landed that the read `
      + 'model does not cover, or an older uncovered write crossed the staleness grace while this '
      + 'promotion was gathering evidence. Either way the allow-list it planned is not provably '
      + 'complete. Nothing was written.'
  }

  if (args.connectedPeers) {
    const peers = await args.connectedPeers()
    if (peers !== null && peers > 0) {
      return `${peers} peer(s) connected to this workspace while the promotion was gathering its evidence. `
        + 'Nothing was written.'
    }
  }
  return null
}

/**
 * Promote an ordinary workspace into the summary world.
 *
 * REPORT-ONLY unless `apply` is true. The report is the same shape either way,
 * so a dry run tells an operator exactly what an apply would do — including the
 * registry materialisation that precondition 3 costs (~33 s at 10k diagrams),
 * a deliberate one-off payment.
 */
export async function promoteSummaryWorkspace(options: PromoteSummaryOptions): Promise<SummaryPromotionReport> {
  const owner = `promotion:${randomUUID()}`
  const workspace = `${options.workspace.landscapeId}/${options.workspace.versionId}`
  // Arm cleanup before resolving the first document. Reporting, refusal and
  // every failure path own the same bounded lifetime as a successful apply.
  try {
    return await runSummaryPromotion(options, (handle) => {
      assertPromotionHandlesCached(options.repo, [handle])
      options.residency?.acquire(handle, owner, workspace)
    })
  } finally {
    options.residency?.releaseOwner(owner)
  }
}

function assertPromotionHandlesCached(repo: Repo, handles: readonly DocHandle<unknown>[]): void {
  const cached = cachedHandles(repo)
  for (const handle of handles) {
    if (cached[handle.documentId] !== handle || handle.state === 'deleted') {
      throw new Error(`promotion control document ${handle.documentId} was evicted or replaced`)
    }
  }
}

async function runSummaryPromotion(
  options: PromoteSummaryOptions,
  retain: (handle: DocHandle<unknown>) => void,
): Promise<SummaryPromotionReport> {
  const {
    db, lockDb, repo, storage, workspace, apply = false,
    assumeQuiesced = false, allowConnectedPeers = false,
    expectedProjectorInstanceId = null,
    hooks = {},
    clock = Date.now,
    sleep = realSleep,
    resolveTimeoutMs = 15_000,
    onProgress,
  } = options
  const say = (message: string) => onProgress?.(message)

  const report: SummaryPromotionReport = {
    workspace,
    rootUrl: null,
    mode: apply ? 'apply' : 'report',
    blockers: [],
    overridden: [],
    witnesses: {
      fsck: null, integrity: null, freshness: null,
      projectorInstanceId: null, coverage: null,
      connectedPeers: null, quiesce: 'unknown', registry: null,
    },
    plan: null,
    applied: null,
  }

  const rootUrl = await readRootUrl(db, workspace)
  report.rootUrl = rootUrl
  if (!rootUrl) {
    report.blockers = evaluatePromotionPreconditions({
      rootUrl: null, root: undefined, fsck: null, integrity: null, freshness: null,
      projectorInstanceId: null, expectedProjectorInstanceId, coverage: null,
      connectedPeers: null, quiesceAssertedByOperator: assumeQuiesced,
      staticSource: null, crdtDiagrams: null, readModelDiagrams: null,
      unresolvedRegistryShards: [],
    })
    return report
  }

  // ⚠ WITNESS ASYMMETRY, deliberate. The registry shards are materialised
  // from an EPHEMERAL repo over the storage adapter — a strictly durable
  // witness — while the root and the ModelMeta are resolved from the CALLER'S
  // repo, which on the sync server may answer from memory or from a peer.
  //
  // It is not symmetrical for a reason: these two handles are not only read,
  // they are MUTATED at step 6, and a mutation must go through the repo that
  // owns the document's sync identity. Resolving them twice — once for the
  // verdict, once for the write — would give the promotion two copies of the
  // same document and no rule for which one it decided against.
  //
  // What covers the gap instead: `modelMetaUrl` is in fsck's reachable set, and
  // fsck's `document-present` check answers presence from `automerge_storage`
  // BY SQL, so a ModelMeta that exists only in this process's memory fails
  // precondition 4 before it can reach the allow-list. The root itself is
  // excluded from that walk (fsck never checks its own entry point), so the
  // residual is exactly one document — the one named by `versions.root_url`,
  // which no client can have reached this workspace without, and which step 6
  // flushes explicitly.
  say(`resolving the control documents of ${workspace.landscapeId}/${workspace.versionId}`)
  const rootHandle = await findReadyDocument<Record<string, unknown>>(repo, rootUrl, resolveTimeoutMs)
    .catch(() => null)
  if (rootHandle) retain(rootHandle)
  const root = rootHandle?.doc()
  const metaUrl = oneUrl(root?.modelMetaUrl)
  const metaHandle = metaUrl
    ? await findReadyDocument<Record<string, unknown>>(repo, metaUrl, resolveTimeoutMs).catch(() => null)
    : null
  if (metaHandle) retain(metaHandle)
  const modelMeta = metaHandle?.doc()

  // ── the witnesses ─────────────────────────────────────────────────────────
  say('running fsck')
  const fsck = await fsckWorkspace(db, repo, workspace, rootUrl, { resolveTimeoutMs })
  const [integrity, freshness, coverage, projectorInstanceId, staticSource] = await Promise.all([
    verifyWorkspaceIntegrity(db, workspace),
    getWorkspaceProjectionFreshness(db, workspace),
    readWorkspaceCoverage(db, workspace),
    readProjectorInstanceId(db, workspace),
    readStaticSource(db, workspace),
  ])
  const connectedPeers = options.connectedPeers ? await options.connectedPeers() : null

  say(`materialising ${urlList(root?.shardUrls).length} registry shard(s), one at a time`)
  const registryUrls = urlList(root?.shardUrls)
  const materialized = await materializeRegistryDiagrams(storage, registryUrls, {
    resolveTimeoutMs,
    onShard: (done, total) => say(`  registry shard ${done}/${total}`),
  })
  const readModelDiagrams = await readModelDiagramUrls(db, workspace)

  report.witnesses = {
    fsck: {
      status: fsck.status,
      findings: fsck.findings.length,
      modelWriteHead: fsck.checksRun.includes('model-write-head') ? 'ran' : 'skipped',
      writeHeadVersion: fsck.checksRun.includes('write-head-version') ? 'ran' : 'skipped',
    },
    integrity: { outcome: integrity.outcome, summary: integrity.summary },
    freshness: {
      status: freshness.status,
      caughtUp: freshness.caughtUp,
      absenceProvable: freshness.absenceProvable,
    },
    projectorInstanceId,
    coverage: coverage ? { covered: coverage.covered, protocol: coverage.protocol } : null,
    connectedPeers,
    quiesce: connectedPeers !== null ? 'measured' : assumeQuiesced ? 'operator-asserted' : 'unknown',
    registry: {
      shards: registryUrls.length,
      shardsUnresolved: materialized.unresolved.length,
      diagramsInCrdt: materialized.diagrams.size,
      diagramsInReadModel: readModelDiagrams.size,
      materializeMs: materialized.elapsedMs,
    },
  }

  report.blockers = evaluatePromotionPreconditions({
    rootUrl,
    root,
    fsck,
    integrity,
    freshness,
    projectorInstanceId,
    expectedProjectorInstanceId,
    coverage: coverage ? { covered: coverage.covered, protocol: coverage.protocol } : null,
    connectedPeers,
    quiesceAssertedByOperator: assumeQuiesced,
    staticSource,
    crdtDiagrams: materialized.diagrams,
    readModelDiagrams,
    unresolvedRegistryShards: materialized.unresolved,
  })
  if (materialized.duplicateIds.length) {
    report.blockers.push({
      code: 'crdt-sql-divergence',
      detail: `${materialized.duplicateIds.length} diagram id(s) appear in more than one registry shard with `
        + `different documents (${sample(materialized.duplicateIds)})`,
    })
  }

  // ── the two CONTROL documents, as BLOCKERS rather than as a silent exit ────
  // The apply path needs live handles on the root and (for a sharded workspace)
  // on the ModelMeta. Without an explicit blocker, `apply` + zero blockers +
  // `applied: null` would be a 200 from the route and a zero exit code from
  // the script — both read as "done" by an operator.
  if (!rootHandle && !report.blockers.some((blocker) => blocker.code === 'root-unresolved')) {
    report.blockers.push({
      code: 'root-unresolved',
      detail: `the root document ${rootUrl} did not resolve within ${resolveTimeoutMs} ms, so no handle exists `
        + 'to flip. Nothing was written.',
    })
  }
  if (rootHandle && metaUrl && !metaHandle) {
    report.blockers.push({
      code: 'meta-unresolved',
      detail: `the root names ModelMeta ${metaUrl} and it did not resolve within ${resolveTimeoutMs} ms. `
        + 'Its overlay heads and base shards are the inventory the allow-list is built from, and its '
        + '`staticBaseline` flag is half of the summary contract — a promotion cannot be completed, or '
        + 'even planned, without it. Repair the missing document first (npm run fsck names it).',
    })
  }

  // ── the plan (built even for a dry run — that IS the report) ──────────────
  if (root && rootHandle) {
    // A PLACEHOLDER write-head url for the dry run. The real one is minted in
    // step 1 of the apply path; the plan only needs its slot so the allow-list
    // SIZE and the kind assertion are the numbers an apply will produce.
    // Generated rather than a hand-typed literal so it is a valid Automerge url
    // like the real one. Nothing is ever created for it.
    const plannedWriteHeadUrl = generateAutomergeUrl()
    const { entries, unclassified } = buildPromotionAllowList({
      rootUrl,
      root,
      modelMeta,
      registries: materialized.slimRegistries,
      writeHeadUrl: plannedWriteHeadUrl,
      diagramDocUrls: readModelDiagrams,
    })
    const admitted = await readAdmittedIds(db, workspace)
    const listed = new Set(entries.map((entry) => entry.documentId))
    const plannedWriteHeadId = documentIdOf(plannedWriteHeadUrl)
    report.plan = {
      allowList: entries,
      unclassified,
      admittedButUnlisted: [...admitted].filter((id) => !listed.has(id)),
      listedButUnadmitted: [...listed].filter((id) => id !== plannedWriteHeadId && !admitted.has(id)),
      diagramCount: readModelDiagrams.size,
      frozenRegistryShards: registryUrls.length,
    }
    if (unclassified.length) {
      report.blockers.push({
        code: 'allow-list-unclassified',
        detail: `${unclassified.length} document(s) are reachable from the root but fit no allow-list kind `
          + `(${sample(unclassified)}). An unlisted document stops resolving durably the moment the static row `
          + 'lands, so this is an abort, never an omission.',
      })
    }
    if (report.plan.admittedButUnlisted.length || report.plan.listedButUnadmitted.length) {
      report.blockers.push({
        code: 'allow-list-incomplete',
        detail: `|allow-list| ≠ |automerge_document_workspace|: ${report.plan.admittedButUnlisted.length} admitted `
          + `document(s) are not in the allow-list (${sample(report.plan.admittedButUnlisted)}) and `
          + `${report.plan.listedButUnadmitted.length} listed document(s) are not admitted `
          + `(${sample(report.plan.listedButUnadmitted)})`,
      })
    }
  }

  // The ONE override, applied HERE and not inside the pure verdict: the
  // verdict must keep saying what it sees, and the operator's decision must be
  // visible as a decision — in the report, in the log and in the audit entry —
  // rather than as a precondition that quietly did not fire.
  if (allowConnectedPeers) {
    report.overridden = report.blockers.filter((blocker) => OVERRIDABLE_BLOCKERS.has(blocker.code))
    report.blockers = report.blockers.filter((blocker) => !OVERRIDABLE_BLOCKERS.has(blocker.code))
    for (const blocker of report.overridden) {
      console.warn(`[promote-summary] OVERRIDDEN by the operator (${blocker.code}): ${blocker.detail}`)
    }
  }

  if (!apply || report.blockers.length > 0 || !rootHandle || !metaHandle) {
    if (apply && report.blockers.length > 0) {
      say(`REFUSED: ${report.blockers.length} blocker(s)`)
    }
    return report
  }

  // ══════════════════════════════════════════════════════════════════════════
  // THE ORDERED TRANSACTION. Never a parent before its children.
  // ══════════════════════════════════════════════════════════════════════════

  // 0 — THE APPLY LOCK. Everything above is evidence-gathering, and at 10k
  //     diagrams it costs ~33 s of registry materialisation. Two POSTs (or a
  //     POST and the script) landing inside that window BOTH observed
  //     `staticSource = null`, so both would mint a write head — and the second
  //     `markStaticReadModelWorkspace` DELETEs the allow-list of the first
  //     before writing its own, leaving one workspace whose root names write
  //     head A while the only admitted, allow-listed head is B. Nothing
  //     downstream can repair that: A's diagrams are in an unlisted document.
  //     `pg_try_advisory_lock`, never the blocking form — a promotion that
  //     cannot get the door must SAY so (`promotion-in-flight`) rather than
  //     queue behind a 33-second neighbour on an HTTP request.
  const lockHolder = await acquireLifecycleApplyLock(lockDb ?? db, workspace)
  if (!lockHolder) {
    report.blockers.push({
      code: 'promotion-in-flight',
      detail: 'another promotion of this workspace holds the apply lock (pg_advisory_lock). '
        + 'Nothing was written. Re-run once it finishes — if it succeeds, this one would have been '
        + 'refused as `already-summary` anyway.',
    })
    say('REFUSED: another promotion holds the apply lock')
    return report
  }
  try {
    // 0b — RE-READ the witnesses that can move, now that the lock makes the
    //      answer stable. The verdict above was computed against facts up to
    //      ~33 s old; acting on it without re-reading is the TOCTOU the lock
    //      alone does not close, because the first promotion may have COMMITTED
    //      and released before this one ever asked for the door.
    const moved = await volatileWitnessesMoved({
      db,
      workspace,
      rootHandle,
      before: {
        staticSource,
        freshness: report.witnesses.freshness,
        registrySummaryOnly: root!.registrySummaryOnly === true,
      },
      // A census that moved is only a reason to abort when the operator did not
      // already accept live peers.
      connectedPeers: allowConnectedPeers ? undefined : options.connectedPeers,
    })
    if (moved) {
      report.blockers.push({ code: 'witness-moved', detail: moved })
      say(`REFUSED: ${moved}`)
      return report
    }

    // 0c — UNDER AN OVERRIDE, DRAIN FIRST. On the ordinary path there are no
    //      peers, so this is the post-flip belt at the bottom of the function
    //      and nothing more. Under `allowConnectedPeers` there ARE peers, and
    //      the belt at the bottom fires too late (after the fence wait): a
    //      diagram created by a classic tab between the commit and the root flip
    //      is acked while the fence is still arming and then lands in a document
    //      `static_allowed` does not list — accepted, durable, unreachable.
    //      Asking those peers to reconnect BEFORE the commit keeps the
    //      override's cost bounded.
    if (report.overridden.length > 0) {
      say(`draining ${report.witnesses.connectedPeers ?? '?'} overridden peer(s) BEFORE the commit`)
      hooks.drainPeers?.(workspace, 'workspace promotion in progress (quiesce overridden)')
    }

    // 1 — a FRESH, EMPTY write head, durable before anything names it. Never a
    //     recycled baseline shard: a full shard breaks the O(1) of diagram
    //     creation (the same invariant holds in performanceSeed/workspace.ts).
    say('1/6 minting the registry write head')
    const writeHead = repo.create<{ diagrams: Record<string, unknown> }>({ diagrams: {} })
    retain(writeHead)
    await repo.flush([writeHead.documentId])
    assertPromotionHandlesCached(repo, [writeHead])
    await hooks.onStep?.('write-head-durable')

    // 2 — the COMPLETE allow-list, now with the real write head.
    say('2/6 building the allow-list')
    const built = buildPromotionAllowList({
      rootUrl,
      root: root!,
      modelMeta,
      registries: materialized.slimRegistries,
      writeHeadUrl: writeHead.url,
      diagramDocUrls: readModelDiagrams,
    })
    if (built.unclassified.length) {
      throw new Error(`promotion allow-list left ${built.unclassified.length} reachable document(s) unclassified`)
    }
    assertWriteHeadIsWritable(built.entries, writeHead.url)
    await hooks.onStep?.('allow-list-built')

    // 3 — ONE Postgres transaction: static row + the entire allow-list + the
    //     write head's claim. One transaction so the `static_allowed` filter is
    //     never armed over a partial list — there is no holed window to fall into.
    say('3/6 committing the static row, the allow-list and the write-head claim')
    const client: PoolClient = await db.connect()
    let rollbackFailure: Error | true | undefined
    try {
      await client.query('BEGIN')
      // LOCK ORDER: this transaction is the ONE exception to the global one.
      //
      // The global order is `read_model_static_workspaces` (S) →
      // `automerge_document_workspace` (W) → `read_model_static_documents` (D)
      // → `read_model_projection_state` (P), and both projectors and the
      // demotion take it that way. The promotion takes **W → S → W → D → P**:
      // `claimWorkspaceDocuments` is first, and S is only reached inside
      // `markStaticReadModelWorkspace` below.
      //
      // It is safe HERE and nowhere else, for two reasons that are properties
      // of this door rather than of the order:
      //
      //  - the only transaction that would contend on S while wanting W is a
      //    static publish, and a promotion cannot overlap one on its own
      //    workspace: `already-summary` refuses when `staticSource !== null`,
      //    so by construction no static projector owns this plane yet;
      //  - the W it takes first is the claim on a write head minted seconds
      //    ago (`repo.create` at step 1), an id no other transaction has ever
      //    seen.
      //
      // If either stops being true — a promotion admitted on an already-static
      // workspace, or a write head that is not fresh — this needs a DESIGN, not
      // a reorder, and the obvious reorder is specifically wrong. Moving
      // `markStaticReadModelWorkspace` above this call does not work twice
      // over: `assertWriteHeadIsWritable` guarantees the allow-list NAMES the
      // write head, so writing it first names the head durably before the
      // `foreign` check has proved it unclaimed; and that call takes W after D
      // internally, which `staticWorkspace.ts` establishes must never happen.
      const claim = await claimWorkspaceDocuments(client, workspace, [String(writeHead.documentId)])
      if (claim.missingVersion) throw new Error(`no versions row for ${workspace.landscapeId}/${workspace.versionId}`)
      if (claim.foreign.length) {
        throw new Error(`the fresh write head ${writeHead.documentId} is already claimed by another workspace`)
      }
      // Overlay segments the projector already admitted, UNIONED back in (see
      // `mergePreservedOverlayEntries` for why a re-promotion needs them).
      // BOUNDED by the retention window, with the SAME predicate as the GC
      // reachability root and the `overlay-segment-retained` fsck check: an
      // unbounded union would grow monotonically, and a segment the GC is
      // entitled to sweep has no business in an allow-list.
      const { rows: admittedOverlays } = await client.query<{ document_id: string; kind: string }>(
        `SELECT document.document_id, document.kind
           FROM read_model_static_documents document
           JOIN read_model_overlay_segments segment
             ON segment.landscape_id = document.landscape_id
            AND segment.version_id = document.version_id
            AND segment.document_id = document.document_id
          WHERE document.landscape_id = $1 AND document.version_id = $2
            AND document.kind IN ('object-overlay', 'connection-overlay')
            AND (segment.is_current OR segment.retain_until IS NULL
                 OR segment.retain_until > now())`,
        [workspace.landscapeId, workspace.versionId],
      )
      await markStaticReadModelWorkspace(
        client, workspace, PROMOTED_STATIC_SOURCE,
        mergePreservedOverlayEntries(built.entries, admittedOverlays), null,
      )
      // THE WRITE FENCE, LAST — and both halves of that are load-bearing.
      //
      // WHY AT ALL. Everything above hands the `ro_*` plane to the static
      // projector, and nothing above can stop an ordinary cold build that is
      // ALREADY RUNNING from committing over it afterwards. Its own
      // `assertReadModelPlane` ran at the start of its transaction, before this
      // row existed; the plane check cannot be moved to its end either, because
      // ordinary authority is the ABSENCE of a row and absence is not lockable.
      // Without the fence such a build can silently erase most of the freshly
      // published rows; with it, that build fails its own end-of-transaction
      // assert and rolls back whole.
      //
      // The projection mutex is not an alternative: an ordinary cold build
      // holds it for ~7-9 s at 12 000 objects even on a repeat build (far
      // longer on a first one), against a 5 000 ms wait ceiling, so a promotion
      // of a large landscape would be refused essentially always. The fence
      // costs one UPDATE and no waiting, because the state row is locked only
      // from the projection's own claim onward, which is its tail rather than
      // its body.
      //
      // WHY LAST. `read_model_projection_state` is the terminal lock for both
      // projectors, so a resource that is always terminal cannot be in a cycle.
      // Taken before `markStaticReadModelWorkspace` it closes one at once: this
      // transaction would hold the state row and want
      // `read_model_static_documents`, while a static publish holds
      // `read_model_static_documents` and wants the state row. 40P01 on a
      // single workspace, no fan-out needed.
      //
      // And in THIS transaction, never a follow-up one: the gap between two
      // commits is a resurrection window, because a projector attaching inside
      // it reads the sentinel as its own `expectedPrevious` and its CAS then
      // succeeds.
      await claimLifecycleWriteFence(client, workspace)
      await client.query('COMMIT')
    } catch (error) {
      // Release WITH the failure. This transaction holds FOUR row-lock sets by
      // the time it can throw — `automerge_document_workspace`,
      // `read_model_static_workspaces`, `read_model_static_documents` and now
      // `read_model_projection_state` — and a client returned to the pool still
      // inside its transaction hands every one of them to the next borrower,
      // including the state row that every projection's
      // `assertReadModelWriteFence` takes `FOR UPDATE`. A bare `release()`
      // does NOT end the session (pg-pool removes the client only for a truthy
      // argument), so a failed ROLLBACK would be a silent wedge, not a leak
      // that times out.
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        rollbackFailure = rollbackError instanceof Error ? rollbackError : true
      })
      throw error
    } finally {
      client.release(rollbackFailure)
    }
    const committedAt = clock()
    await hooks.onStep?.('static-committed')
    try {
      await hooks.announceDocuments?.({ key: workspace, rootUrl, documentIds: [String(writeHead.documentId)] })
    } catch (error) {
      // The DURABLE claim is committed; this only feeds a process-local index.
      // Loud, never swallowed silently.
      console.warn('[promote-summary] doc-index announce failed (the durable claim is committed):', error)
    }

    // 4 — detach the ORDINARY projector. `ProjectorFleet.start` also refuses to
    //     attach a static workspace, so a concurrent `ensure()` cannot resurrect
    //     it; without both, the ordinary and the static projector would write
    //     ro_* concurrently with racing generations. Its stop also releases
    //     residency: our own leases must retain the control handles through
    //     the fence wait and their durable publication below.
    say('4/6 detaching the ordinary projector')
    hooks.releaseOrdinaryProjector?.(workspace, 'promoted')
    await hooks.onStep?.('projector-released')

    // 5 — WAIT OUT THE FENCE'S FULL ARMING BOUND. A server whose fence caches
    //     were refreshed just before the COMMIT keeps answering from pre-commit
    //     state for {@link BASELINE_FENCE_ARMING_BOUND_MS}, so a baseline write
    //     in that window would be applied and acked — and invisible to the
    //     summary world that begins at the root flip. The bound is NOT one TTL:
    //     two caches sit in series and the per-document one stamps its expiry
    //     at the SETTLEMENT of a query that has its own deadline. The derivation
    //     lives on the constant in docScope.ts, next to the caches, so
    //     shortening a TTL cannot leave this wait behind. The quiesce may not be
    //     lifted before this returns either.
    say(`5/6 waiting out the baseline write fence arming bound (${BASELINE_FENCE_ARMING_BOUND_MS} ms)`)
    let waited = clock() - committedAt
    while (waited < BASELINE_FENCE_ARMING_BOUND_MS) {
      await sleep(BASELINE_FENCE_ARMING_BOUND_MS - waited)
      const next = clock() - committedAt
      // A clock that does not advance would spin; treat a non-advancing sleep as
      // satisfied rather than hang the operator's terminal forever.
      if (next <= waited) { waited = BASELINE_FENCE_ARMING_BOUND_MS; break }
      waited = next
    }
    await hooks.onStep?.('fence-waited')

    // 6 — publish ModelMeta, then the root IN PLACE through the root-shape
    //     mapper. Every child is durable and admitted before the root names it.
    //     Await the explicit Meta flush before starting the explicit root save.
    //     This does not drain Repo's automatic saves: after a failure, one may
    //     still finish persisting Meta in the already-partial static workspace.
    say('6/6 flipping the root to the summary contract')
    const nextRoot = copyRootShape(root as Partial<WorkspaceRootShape>, {
      registrySummaryOnly: true,
      registryWriteUrl: writeHead.url,
      diagramCount: readModelDiagrams.size,
      shardUrls: [...urlList(root!.shardUrls), writeHead.url],
    })
    // Forced ownership-loss eviction deliberately bypasses residency leases.
    // Refuse stale references; Repo.flush silently skips missing cache entries.
    assertPromotionHandlesCached(repo, [rootHandle, metaHandle])
    metaHandle.change((doc) => { doc.staticBaseline = true })
    await repo.flush([metaHandle.documentId])
    assertPromotionHandlesCached(repo, [rootHandle, metaHandle])
    applyRootShape(rootHandle, nextRoot)
    await repo.flush([rootHandle.documentId])
    assertPromotionHandlesCached(repo, [rootHandle, metaHandle])
    await hooks.onStep?.('root-flipped')

    // Post-flip belt. On the ordinary path there are no peers (precondition 6);
    // on the overridden path the peers were already asked to reconnect at step
    // 0c, and this second call catches anything that reconnected in between.
    hooks.drainPeers?.(workspace, 'workspace promoted to the summary contract')

    report.applied = {
      writeHeadUrl: writeHead.url,
      allowListSize: built.entries.length,
      staticSource: PROMOTED_STATIC_SOURCE,
      fenceWaitMs: waited,
      diagramCount: readModelDiagrams.size,
    }
    say('promoted')
    return report
  } finally {
    // Mutating the returned object from `finally` is intentional: `return
    // report` evaluates the REFERENCE before this block runs, so a field
    // written here reaches the caller from every return path.
    report.exclusionProven = await releaseLifecycleApplyLock(lockHolder, workspace)
  }
}

// ============================================================================
// The de-promotion — the escape hatch, not an operating mode
// ============================================================================

export type DemotionBlockerCode =
  | 'no-such-workspace'
  | 'root-unresolved'
  | 'not-summary'
  | 'not-promoted'
  | 'sparse-child-active'
  | 'peers-connected'
  | 'quiesce-unproven'
  | 'diagram-tombstones-outstanding'
  /** Another lifecycle door holds the workspace's apply lock. */
  | 'lifecycle-in-flight'
  /** A witness the verdict rests on moved between the verdict and the lock. */
  | 'witness-moved'
  /** A static read-model publish held the workspace row past the ceiling. The
   * ONLY blocker on this door that is reported AFTER a durable act: the root
   * has already been reverted, so its detail says so and a re-run finishes. */
  | 'publish-in-flight'

export interface DemotionBlocker {
  code: DemotionBlockerCode
  detail: string
}

/**
 * The de-promotion's overridable blockers — the SAME two as the promotion's,
 * and for the same reason: a live session's in-flight writes are a bounded,
 * named loss; `not-promoted` and `sparse-child-active` are not.
 *
 * Exported so the unit suite can pin it AS A SET: `sparse-child-active`
 * slipping in here would silently make "delete the baseline a live draft is
 * reading" an operator checkbox.
 */
export const DEMOTION_OVERRIDABLE_BLOCKERS: ReadonlySet<DemotionBlockerCode> = new Set([
  'peers-connected',
  'quiesce-unproven',
])

/**
 * `diagram-tombstones-outstanding` is overridable, but NOT by
 * `allowConnectedPeers`. It has its own operator flag
 * (`allowDiagramResurrection`) because it is a different promise: the two
 * quiesce blockers cost a live session's in-flight writes, a bounded and named
 * loss, while this one RESURRECTS every diagram deleted since the promotion.
 * Folding it into the set above would make mass resurrection a side effect of
 * the checkbox for "there is a tab open".
 */
export const DEMOTION_RESURRECTION_BLOCKER: DemotionBlockerCode = 'diagram-tombstones-outstanding'

export interface SummaryDemotionReport {
  workspace: WorkspaceKey
  rootUrl: string | null
  mode: 'report' | 'apply'
  /**
   * FALSE when this door could not prove, at release time, that its session
   * still held the workspace's apply lock.
   *
   * Absent on a run that never took the lock (a report, or a refusal before
   * the door) — so absence means "no critical section", never "it was fine".
   *
   * It is NOT a retry hint. It says some part of this run's writes happened
   * with nothing excluding the other three doors, because Postgres drops a
   * dead backend's advisory locks instantly and silently. The answer is fsck,
   * not another attempt.
   */
  exclusionProven?: boolean
  blockers: DemotionBlocker[]
  /** Same contract as the promotion's: quiesce blockers the operator overrode,
   * reported rather than dropped. */
  overridden: DemotionBlocker[]
  witnesses: {
    staticSource: string | null
    allowListSize: number
    activeSparseChildren: string[]
    connectedPeers: number | null
    quiesce: 'measured' | 'operator-asserted' | 'unknown'
    /** Outstanding `ModelMeta.deletedDiagramIds` entries; null when the
     * check does not apply or the ModelMeta did not resolve. */
    diagramTombstones: number | null
  }
  applied: { staticRowsDeleted: number; writeHeadKeptInShardUrls: boolean } | null
}

export interface DemotionFacts {
  rootUrl: string | null
  root: Record<string, unknown> | undefined
  staticSource: string | null
  activeSparseChildren: readonly string[]
  /** `null` = unmeasurable from this process. Never treated as zero. */
  connectedPeers: number | null
  quiesceAssertedByOperator: boolean
  /**
   * How many ids `ModelMeta.deletedDiagramIds` carries.
   *
   * `undefined` means the check does not APPLY (a monolith root names no
   * ModelMeta). `null` means it applies but could not be READ, which is a
   * blocker in its own right: same rule as `connectedPeers`, unmeasurable is
   * never zero.
   */
  diagramTombstones?: number | null
}

/**
 * De-promotion preconditions, pure.
 *
 * The sparse-child rule is the one that costs data if it is missed: a sparse
 * draft serves its BASELINE from the parent's read model through
 * `read_model_static_workspaces.base_version_id`. Delete the parent's rows
 * underneath it and every untouched entity in that draft resolves to nothing —
 * the draft renders empty and its merge would compute a diff against a void.
 */
export function evaluateDemotionPreconditions(facts: DemotionFacts): DemotionBlocker[] {
  const blockers: DemotionBlocker[] = []
  const block = (code: DemotionBlockerCode, detail: string) => blockers.push({ code, detail })

  if (!facts.rootUrl) {
    block('no-such-workspace', 'no versions row / root_url for this workspace')
    return blockers
  }
  if (!facts.root) {
    block('root-unresolved', `the root document ${facts.rootUrl} did not resolve`)
    return blockers
  }
  if (facts.root.registrySummaryOnly !== true && facts.staticSource === null) {
    block('not-summary', 'this workspace is not in the summary world; there is nothing to demote')
  }
  if (facts.staticSource !== null && facts.staticSource !== PROMOTED_STATIC_SOURCE) {
    block(
      'not-promoted',
      `read_model_static_workspaces.source is '${facts.staticSource}', not '${PROMOTED_STATIC_SOURCE}'. `
      + 'A performance fixture and a sparse draft were BORN summary — their baseline exists nowhere else, '
      + 'so demoting them does not restore an ordinary workspace, it destroys the only one they have.',
    )
  }
  if (facts.activeSparseChildren.length > 0) {
    block(
      'sparse-child-active',
      `${facts.activeSparseChildren.length} active sparse draft(s) read this workspace's read model as their `
      + `baseline (${sample([...facts.activeSparseChildren])}). Deleting the static rows underneath them leaves `
      + 'every untouched entity resolving to nothing. Merge or discard them first.',
    )
  }
  // The demotion strips `registrySummaryOnly` from the root and deletes the
  // static rows, so the client rebuilds a CLASSIC registry from the frozen
  // baseline shards — which still carry an entry for every tombstoned diagram,
  // because nothing ever rewrites a sealed shard. Every diagram deleted since
  // the promotion would come back, and the ordinary projector's `syncDiagrams`
  // would recreate their `ro_diagrams` rows.
  //
  // Refusing is the right answer: the demotion is a rare operator door, and
  // failing it loudly beats deleted diagrams silently reappearing. It clears
  // by itself once the tombstone folder has emptied the list.
  if (facts.diagramTombstones === null) {
    block(
      'diagram-tombstones-outstanding',
      'the ModelMeta could not be read, so the number of outstanding diagram tombstones is unknown. '
      + 'Unmeasurable is not zero: demoting blind would silently resurrect every diagram deleted since '
      + 'the promotion, since the frozen baseline registry shards still carry their entries.',
    )
  } else if (facts.diagramTombstones !== undefined && facts.diagramTombstones > 0) {
    block(
      'diagram-tombstones-outstanding',
      `ModelMeta.deletedDiagramIds holds ${facts.diagramTombstones} outstanding diagram tombstone(s). `
      + 'The demotion rebuilds the registry from the FROZEN baseline shards, which still carry an entry for '
      + 'each of them, so every one of those diagrams would come back — and the ordinary projector would '
      + 'recreate its ro_diagrams row. Fold the tombstones first, or re-run with --allow-diagram-resurrection '
      + 'to accept it explicitly.',
    )
  }
  if (facts.connectedPeers !== null && facts.connectedPeers > 0) {
    block(
      'peers-connected',
      `${facts.connectedPeers} peer(s) are connected. A live summary session would keep writing to the write `
      + 'head while the contract changes underneath it; the boot contract is only re-read at reload.',
    )
  } else if (facts.connectedPeers === null && !facts.quiesceAssertedByOperator) {
    block(
      'quiesce-unproven',
      'this process cannot see the workspace\'s live sockets, so the quiesce is unproven. Demote through the '
      + 'server route (which measures the census), or confirm no session is open and re-run with '
      + '--assume-quiesced.',
    )
  }
  return blockers
}

export interface DemoteSummaryOptions {
  db: Pool
  /**
   * The pool the lifecycle apply LOCK TOKEN is taken from. Defaults to `db`,
   * which is what tests want (an injected pool is usually an isolated schema).
   * Production passes `lifecycleApplyPool` so a long-held lock (tens of
   * seconds) does not pin a general-purpose connection; under concurrent
   * promotions that starved the primary pool.
   */
  lockDb?: Pool
  repo: Repo
  workspace: WorkspaceKey
  apply?: boolean
  connectedPeers?: () => number | null | Promise<number | null>
  assumeQuiesced?: boolean
  allowConnectedPeers?: boolean
  /** Accept that every tombstoned diagram comes back. Deliberately its own
   * flag: this is not the same promise as overriding a quiesce. */
  allowDiagramResurrection?: boolean
  hooks?: {
    /** Re-attach the ordinary projector (`cold_build`, idempotent). */
    ensureOrdinaryProjector?: (key: WorkspaceKey) => Promise<unknown> | unknown
    drainPeers?: (key: WorkspaceKey, reason: string) => void
    onStep?: (step: 'root-reverted' | 'static-deleted' | 'meta-reverted') => Promise<void> | void
  }
  resolveTimeoutMs?: number
  onProgress?: (message: string) => void
}

async function readActiveSparseChildren(db: Queryable, key: WorkspaceKey): Promise<string[]> {
  // Two independent readings of "a child leans on this baseline", OR-ed: the
  // draft's own manifest, and the static row's `base_version_id`. Either alone
  // can be wrong — a draft whose manifest was rewritten, a static row posed by
  // a repair — and the union is the conservative side.
  const { rows } = await db.query<{ id: string }>(
    `SELECT v.id FROM versions v
      WHERE v.landscape_id = $1
        AND v.parent_version_id = $2
        AND v.kind = 'draft'
        AND v.status = 'active'
        AND (
          v.base_manifest->>'mode' = 'sparse-static'
          OR EXISTS (
            SELECT 1 FROM read_model_static_workspaces s
             WHERE s.landscape_id = $1 AND s.version_id = v.id AND s.base_version_id = $2
          )
        )
      ORDER BY v.id`,
    [key.landscapeId, key.versionId],
  )
  return rows.map((row) => row.id)
}

/**
 * Take a promoted workspace back out of the summary world.
 *
 * THE ORDER IS THE EXACT INVERSE of the promotion, for the same asymmetry: the
 * intermediate state must be the `degraded` one (static rows still present
 * under an ordinary root), never the `data-loss` one (a summary root with no
 * static row). So the root reverts FIRST.
 *
 * The write head STAYS in `root.shardUrls`. A classic client merges every shard
 * (`mergeShards`), so every diagram created since the promotion remains visible
 * — removing it would silently delete them from the registry.
 *
 * On a very large workspace this re-exposes the client-side registry costs the
 * promotion removed. It is the correction hatch, not a mode of operation.
 */
export async function demoteSummaryWorkspace(options: DemoteSummaryOptions): Promise<SummaryDemotionReport> {
  const {
    db, lockDb, repo, workspace, apply = false, assumeQuiesced = false,
    allowConnectedPeers = false, allowDiagramResurrection = false, hooks = {},
    resolveTimeoutMs = 15_000, onProgress,
  } = options
  const overridable = DEMOTION_OVERRIDABLE_BLOCKERS
  const say = (message: string) => onProgress?.(message)

  const rootUrl = await readRootUrl(db, workspace)
  const rootHandle = rootUrl
    ? await findReadyDocument<Record<string, unknown>>(repo, rootUrl, resolveTimeoutMs).catch(() => null)
    : null
  const root = rootHandle?.doc()
  const staticSource = await readStaticSource(db, workspace)
  const activeSparseChildren = await readActiveSparseChildren(db, workspace)
  const connectedPeers = options.connectedPeers ? await options.connectedPeers() : null
  const { rows: allowRows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM read_model_static_documents
      WHERE landscape_id = $1 AND version_id = $2`,
    [workspace.landscapeId, workspace.versionId],
  )

  // Read the tombstone list from the ModelMeta the root names. `undefined`
  // when the root names none (does not apply); `null` when it names one that
  // will not resolve (applies, unknown, and therefore a blocker).
  const tombstoneMetaUrl = typeof root?.modelMetaUrl === 'string' && root.modelMetaUrl ? root.modelMetaUrl : null
  let diagramTombstones: number | null | undefined
  if (tombstoneMetaUrl) {
    const metaHandle = await findReadyDocument<{ deletedDiagramIds?: string[] }>(
      repo, tombstoneMetaUrl, resolveTimeoutMs,
    ).catch(() => null)
    const deleted = metaHandle?.doc()?.deletedDiagramIds
    diagramTombstones = metaHandle ? new Set(deleted ?? []).size : null
  }

  const verdict = evaluateDemotionPreconditions({
    rootUrl, root, staticSource, activeSparseChildren, connectedPeers,
    quiesceAssertedByOperator: assumeQuiesced,
    diagramTombstones,
  })
  const overridden = (blocker: DemotionBlocker) => (
    (allowConnectedPeers && overridable.has(blocker.code))
    || (allowDiagramResurrection && blocker.code === DEMOTION_RESURRECTION_BLOCKER)
  )
  const report: SummaryDemotionReport = {
    workspace,
    rootUrl,
    mode: apply ? 'apply' : 'report',
    blockers: verdict.filter((blocker) => !overridden(blocker)),
    overridden: verdict.filter(overridden),
    witnesses: {
      staticSource,
      allowListSize: Number(allowRows[0]?.n ?? '0'),
      activeSparseChildren,
      connectedPeers,
      quiesce: connectedPeers !== null ? 'measured' : assumeQuiesced ? 'operator-asserted' : 'unknown',
      diagramTombstones: diagramTombstones ?? null,
    },
    applied: null,
  }
  if (!apply || report.blockers.length > 0 || !rootHandle || !root) return report

  // 0 — THE LIFECYCLE APPLY LOCK, and it belongs HERE: before the root revert,
  //     which is the first irreversible act on this path. Without it a
  //     workspace could be promoted and demoted at once — see
  //     `lifecycleApplyLock.ts` for the window in which
  //     `evaluateDemotionPreconditions` admits a demotion of a half-promoted
  //     workspace, and why the outcome would be the `data-loss` side of
  //     `summary-static-coherence`.
  const lockHolder = await acquireLifecycleApplyLock(lockDb ?? db, workspace)
  if (!lockHolder) {
    report.blockers.push({
      code: 'lifecycle-in-flight',
      detail: 'another lifecycle operation on this workspace (a promotion, a demotion or a flag repair) '
        + 'holds the apply lock. Nothing was written. Re-run once it finishes — if it was a promotion, '
        + 'this demotion would have been reading a half-promoted workspace.',
    })
    say('REFUSED: another lifecycle operation holds the apply lock')
    return report
  }
  try {
    // 0b — RE-READ the witnesses that can MOVE, now that the lock makes the
    //      answer stable. The verdict above may be up to two document resolves
    //      (`resolveTimeoutMs` each) old, and the lock does not reach backwards:
    //      a promotion that COMMITTED and released before this demotion asked
    //      for the door leaves exactly the state the verdict was allowed to
    //      admit.
    const currentRoot = rootHandle.doc()
    const currentStaticSource = await readStaticSource(db, workspace)
    const currentSummaryOnly = currentRoot?.registrySummaryOnly === true
    // The sparse children are re-read too: deleting the parent's rows under a
    // sparse draft leaves every untouched entity in that draft resolving to
    // nothing. The apply lock CANNOT cover it: `createDraft` (`landscapes.ts`)
    // publishes a sparse child taking no lifecycle lock, and even if it did,
    // `lifecycleLockKey` is keyed on the CHILD's (landscapeId, versionId), so
    // it could never exclude a door on the parent. Re-reading is the only
    // defence.
    const currentSparseChildren = await readActiveSparseChildren(db, workspace)
    const sparseChildrenMoved = currentSparseChildren.length !== activeSparseChildren.length
      || currentSparseChildren.some((child, index) => child !== activeSparseChildren[index])
    const movedWitness = currentStaticSource !== staticSource
      ? `read_model_static_workspaces.source changed from ${staticSource ?? 'none'} to `
        + `${currentStaticSource ?? 'none'} between the verdict and the apply lock`
      : currentSummaryOnly !== (root.registrySummaryOnly === true)
        ? `the root's registrySummaryOnly changed from ${root.registrySummaryOnly === true} to `
          + `${currentSummaryOnly} between the verdict and the apply lock`
        : sparseChildrenMoved
          ? `the active sparse children changed from [${activeSparseChildren.join(', ')}] to `
            + `[${currentSparseChildren.join(', ')}] between the verdict and the apply lock. `
            + 'Deleting this workspace\'s static rows underneath a sparse draft leaves every untouched '
            + 'entity in it resolving to nothing.'
          : null
    if (movedWitness || !currentRoot) {
      report.blockers.push({
        code: 'witness-moved',
        detail: movedWitness ?? 'the root document stopped resolving between the verdict and the apply lock',
      })
      say(`REFUSED: ${movedWitness ?? 'the root stopped resolving'}`)
      return report
    }

    // 0c — UNDER AN OVERRIDE, DRAIN FIRST — the mirror of the promotion's step 0c.
    //      A live SUMMARY session is writing into the registry write head and
    //      reading its baseline from `ro_*`; the demotion is about to delete those
    //      rows. Asking it to reconnect BEFORE the rows go is the difference
    //      between one reload and a session serving a baseline that no longer
    //      exists. The belt at the bottom fires after the deletion and is kept for
    //      anything that reconnected in between.
    if (report.overridden.length > 0) {
      say(`draining ${report.witnesses.connectedPeers ?? '?'} overridden peer(s) BEFORE the static rows go`)
      hooks.drainPeers?.(workspace, 'workspace demotion in progress (quiesce overridden)')
    }

    // 1 — the ROOT first (the inverse order). The write head keeps its place in
    //     `shardUrls`; only the summary contract fields go.
    say('1/3 reverting the root to the ordinary contract')
    const nextRoot = copyRootShape(currentRoot as Partial<WorkspaceRootShape>, {
      registrySummaryOnly: undefined,
      diagramCount: undefined,
    })
    applyRootShape(rootHandle, nextRoot)
    await repo.flush([rootHandle.documentId as DocumentId])
    await hooks.onStep?.('root-reverted')

    // 2 — the static rows, in one transaction. The fence disarms within one TTL
    //     of this commit (its per-document lookup JOINs the workspace row, so a
    //     mid-delete state already reads as unfenced) — no wait is owed here:
    //     disarming LATE only refuses baseline writes for a few seconds longer,
    //     which is the safe direction.
    say('2/3 deleting the static workspace rows')
    const client: PoolClient = await db.connect()
    let deleted: number
    // A ROLLBACK that itself fails leaves this client inside its transaction,
    // holding every row lock it took; returning it to the pool hands the next
    // borrower a connection that can never commit. Release it WITH the failure
    // so the pool destroys it instead. Same remedy as
    // `withReadModelProjectionTransaction`, same reason.
    let rollbackFailure: Error | true | undefined
    try {
      await client.query('BEGIN')
      // A CEILING, because this transaction can now WAIT. A static publish
      // holds `read_model_static_workspaces` in key share for its whole
      // duration (`assertReadModelPlane`), and that duration includes an
      // `overlay-rotation:` acquisition whose own ceiling is deliberately
      // disarmed (a publish can wait 20 s or more behind a holder).
      // Parking here would park the LIFECYCLE APPLY LOCK with it, shutting all
      // three doors for the workspace behind a wait nobody can see. Failing
      // says so instead, and the operator re-runs.
      await client.query(`SET LOCAL lock_timeout = '${PROJECTION_MUTEX_WAIT_MS}ms'`)
      // THE WORKSPACE ROW FIRST — a lock order, not a preference.
      //
      // `assertReadModelPlane` takes `FOR KEY SHARE` on this row at the START
      // of every static publish, so the publish's start-of-transaction verdict
      // holds to its commit. That share lock is also what this DELETE must
      // wait for. Taking the documents first would make the demotion hold
      // `read_model_static_documents` and want the workspace row, while a
      // publish holds the workspace row and wants the documents: ABBA, on one
      // workspace.
      //
      // The global order is `read_model_static_workspaces` →
      // `automerge_document_workspace` → `read_model_static_documents` →
      // `read_model_projection_state`.
      //
      // `read_model_static_documents_workspace_fk` makes an allow-list write
      // take key share on the workspace row through an AFTER-ROW RI trigger —
      // at END of statement, after the allow-list rows are locked — so a writer
      // that does not take that row up front goes D → S, against this
      // transaction's S → D, and this transaction would be the deadlock victim
      // AFTER step 1 has reverted and flushed the root.
      // `registerStaticReadModelDocumentsInTransaction` therefore takes the
      // workspace row first; `isDeadlockVictim` below is the backstop.
      //
      // ONE STATEMENT, via a CTE: the foreign key cascades, so a separate
      // DELETE of the documents after the workspace row would always report 0
      // rows — and that count is the only number the demotion reports about
      // the allow-list. Both CTE arms read ONE snapshot, so the count is taken
      // from before the cascade, and the workspace row lock is taken first,
      // with the cascade reaching the documents from it.
      const removal = await client.query<{ document_rows: number; workspace_rows: number }>(
        `WITH counted AS (
           SELECT count(*)::int AS rows
           FROM read_model_static_documents
           WHERE landscape_id = $1 AND version_id = $2
         ), removed AS (
           DELETE FROM read_model_static_workspaces
           WHERE landscape_id = $1 AND version_id = $2
           RETURNING 1
         )
         SELECT (SELECT rows FROM counted) AS document_rows,
                (SELECT count(*)::int FROM removed) AS workspace_rows`,
        [workspace.landscapeId, workspace.versionId],
      )
      // THE SWEEP IS NOT DEAD CODE under the cascade. `not-summary` (in
      // `evaluateDemotionPreconditions`) admits a demotion when the root is
      // `registrySummaryOnly` and the source is ALREADY null — the hybrid
      // half-state `summary-static-coherence` reports as `data-loss`. There is
      // no workspace row there, so the CTE deletes nothing and NOTHING
      // CASCADES; this statement is the only automatic reaper of such an
      // orphaned allow-list.
      //
      // AFTER the workspace delete, per the global lock order above. Nothing
      // observes the intermediate — both statements are in this transaction.
      const swept = await client.query(
        'DELETE FROM read_model_static_documents WHERE landscape_id = $1 AND version_id = $2',
        [workspace.landscapeId, workspace.versionId],
      )
      await client.query('COMMIT')
      // Two disjoint populations, both counted. `document_rows` counts what the
      // CASCADE removed — only when there WAS a workspace row to cascade from.
      // `swept.rowCount` counts what the cascade could not reach. On a healthy
      // demotion the second is 0; on the hybrid half-state the first is.
      const cascaded = removal.rows[0]?.workspace_rows ? removal.rows[0].document_rows : 0
      deleted = cascaded + (swept.rowCount ?? 0)
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        rollbackFailure = rollbackError instanceof Error ? rollbackError : true
      })
      // A BUSY MUTEX IS A VERDICT, NOT A CRASH — and this is the one path in
      // this function where something durable has ALREADY happened: the root
      // has been reverted AND flushed.
      //
      // Left as a throw, `55P03` (lock timeout) or `40P01` (deadlock victim)
      // would escape to the route's generic handler as a bare 500 with no
      // `SummaryDemotionReport` and no audit row (`appendAudit` is gated on
      // `report.applied`), hiding exactly what the operator needs to know.
      // Both mean "another static-plane writer won and nothing of ours was
      // written".
      //
      // Reported as a blocker instead, and the detail SAYS the root moved.
      // `applied` stays null because the demotion did not complete — a re-run
      // finishes it, and is admitted, because `not-summary` needs BOTH an
      // ordinary root and a null source and only the first is now true.
      //
      // The deadlock ordering is fixed at the writer
      // (`registerStaticReadModelDocumentsInTransaction` takes the workspace
      // row first), so this branch is a backstop. It is kept because the cost
      // of being wrong is a half-applied demotion nobody can see, and because a
      // deadlock fires FIRST when both are possible: `deadlock_timeout` is
      // 1 000 ms against this transaction's 5 000 ms ceiling.
      const mutexTimeout = isProjectionMutexTimeout(error)
      if (mutexTimeout || isDeadlockVictim(error)) {
        report.blockers.push({
          code: 'publish-in-flight',
          detail: (mutexTimeout
            ? 'a static read-model publish holds this workspace and did not release within '
              + `${PROJECTION_MUTEX_WAIT_MS} ms, so the static rows were NOT deleted.`
            : 'a concurrent static read-model write and this demotion deadlocked, and Postgres chose '
              + 'this transaction as the victim, so the static rows were NOT deleted.')
            + ' The root HAS already '
            + 'been reverted to the ordinary contract and flushed, so the workspace is now the hybrid '
            + 'state `summary-static-coherence` reports as `degraded`: documents outside the allow-list '
            + 'stop resolving durably after a restart. Re-run the demotion once the publish finishes — '
            + 'it will be admitted and will finish the job.',
        })
        say(mutexTimeout
          ? 'REFUSED mid-way: a static publish holds the workspace; the root is already reverted'
          : 'REFUSED mid-way: deadlocked against a static publish; the root is already reverted')
        return report
      }
      throw error
    } finally {
      client.release(rollbackFailure)
    }
    await hooks.onStep?.('static-deleted')

    // 3 — ModelMeta, then the ordinary projector comes back.
    say('3/3 clearing staticBaseline and re-attaching the ordinary projector')
    const metaUrl = oneUrl(currentRoot.modelMetaUrl)
    if (metaUrl) {
      const metaHandle = await findReadyDocument<Record<string, unknown>>(repo, metaUrl, resolveTimeoutMs).catch(() => null)
      if (metaHandle) {
        metaHandle.change((doc) => { doc.staticBaseline = false })
        await repo.flush([metaHandle.documentId as DocumentId])
      }
    }
    await hooks.onStep?.('meta-reverted')
    await hooks.ensureOrdinaryProjector?.(workspace)
    hooks.drainPeers?.(workspace, 'workspace demoted from the summary contract')

    report.applied = {
      staticRowsDeleted: deleted,
      writeHeadKeptInShardUrls: urlList(currentRoot.shardUrls).includes(String(currentRoot.registryWriteUrl ?? '')),
    }
    return report
  } finally {
    // Mutating the returned object from `finally` is intentional: `return
    // report` evaluates the REFERENCE before this block runs, so a field
    // written here reaches the caller from every return path.
    report.exclusionProven = await releaseLifecycleApplyLock(lockHolder, workspace)
  }
}

// ============================================================================
// The THIRD door — regularise a HYBRID workspace (the ROOT half only)
// ============================================================================

export type SummaryFlagRepairBlockerCode =
  | 'no-such-workspace'
  | 'root-unresolved'
  | 'meta-unresolved'
  | 'monolith-workspace'
  /** Another lifecycle door holds the workspace's apply lock. This door's whole
   * precondition — a static row with an un-flipped root — is ALSO the state a
   * promotion is in during the fence wait between its step 3 and its step 6, so without
   * the lock it is not repairing a crash, it is racing a healthy promotion. */
  | 'lifecycle-in-flight'
  /** A witness this door's plan rests on moved between the plan and the lock. */
  | 'witness-moved'
  /** No static row, or the root is already summary-only: there is no half-open
   * state to close. */
  | 'not-hybrid'
  /** Neither the root nor the committed allow-list names a registry write head,
   * so there is nothing to point the summary contract at. */
  | 'write-head-missing'
  /** More than one candidate write head in the allow-list. Picking one would be
   * a guess, and the wrong guess strands every diagram created into the other. */
  | 'write-head-ambiguous'
  /** The write head's allow-list entry does not carry kind `registry-shard`.
   * Flipping the root over it would freeze the one document a summary client
   * must keep writing. */
  | 'write-head-not-writable'
  /** The committed allow-list and `automerge_document_workspace` disagree. */
  | 'allow-list-incomplete'

export interface SummaryFlagRepairReport {
  workspace: WorkspaceKey
  rootUrl: string | null
  mode: 'report' | 'apply'
  /**
   * FALSE when this door could not prove, at release time, that its session
   * still held the workspace's apply lock.
   *
   * Absent on a run that never took the lock (a report, or a refusal before
   * the door) — so absence means "no critical section", never "it was fine".
   *
   * It is NOT a retry hint. It says some part of this run's writes happened
   * with nothing excluding the other three doors, because Postgres drops a
   * dead backend's advisory locks instantly and silently. The answer is fsck,
   * not another attempt.
   */
  exclusionProven?: boolean
  blockers: { code: SummaryFlagRepairBlockerCode; detail: string }[]
  witnesses: {
    staticSource: string | null
    registrySummaryOnly: boolean
    /** The write head the ROOT names, when it names one. */
    rootWriteHeadUrl: string | null
    allowListSize: number
    admittedDocuments: number
    /** The allow-list kind of the write head this repair would use. */
    writeHeadKind: string | null
    diagramCount: number
  }
  plan: { writeHeadUrl: string; adoptedFromAllowList: boolean; diagramCount: number } | null
  applied: { writeHeadUrl: string; adoptedFromAllowList: boolean; diagramCount: number } | null
}

export interface RepairSummaryFlagOptions {
  db: Pool
  /**
   * The pool the lifecycle apply LOCK TOKEN is taken from. Defaults to `db`,
   * which is what tests want (an injected pool is usually an isolated schema).
   * Production passes `lifecycleApplyPool` so a long-held lock (tens of
   * seconds) does not pin a general-purpose connection; under concurrent
   * promotions that starved the primary pool.
   */
  lockDb?: Pool
  repo: Repo
  workspace: WorkspaceKey
  /** DEFAULT FALSE — report only, like the other two doors. */
  apply?: boolean
  hooks?: {
    drainPeers?: (key: WorkspaceKey, reason: string) => void
    onStep?: (step: 'root-flipped' | 'meta-flagged') => Promise<void> | void
  }
  resolveTimeoutMs?: number
  onProgress?: (message: string) => void
}

/**
 * The repair's four SQL facts, read in ONE statement so they share one
 * snapshot. They used to be four `pool.query` calls under `Promise.all`, i.e.
 * four snapshots on four clients in no fixed order: a demotion committing
 * between them (its DELETE of the static row CASCADEs to the allow-list) left a
 * plan with the static row present and the allow-list empty. That plan refused
 * as `write-head-not-writable` + `allow-list-incomplete` (or `write-head-missing`
 * when the root names no head) — blaming a defect the workspace never had, and
 * never reaching the under-lock re-read that names what actually happened
 * (`witness-moved`). Measured 2026-10-22: the integration test "a flag repair
 * whose static row vanishes…" went red that way once in a loaded `ci-local
 * --static` run, and 0 times in 58 local runs of the old shape (30 idle, 28
 * under 14 CPU hogs); with the test's proxy holding the other reads until the
 * row has moved, the old shape was red 5/5 and this one green 25/25 under load.
 * Still a refusal either way: a torn plan could not pass where a whole one
 * would block, because each mover commits the static row and the allow-list
 * together.
 */
async function readRepairFacts(db: Queryable, key: WorkspaceKey): Promise<{
  staticSource: string | null
  allowList: { documentId: string; kind: string }[]
  admitted: Set<string>
  diagramCount: number
}> {
  const { rows } = await db.query<{
    static_source: string | null
    allow_list: { documentId: string; kind: string }[]
    admitted: string[]
    diagram_count: string
  }>(
    `SELECT
       (SELECT source FROM read_model_static_workspaces
         WHERE landscape_id = $1 AND version_id = $2) AS static_source,
       (SELECT coalesce(json_agg(json_build_object('documentId', document_id, 'kind', kind)), '[]'::json)
          FROM read_model_static_documents
         WHERE landscape_id = $1 AND version_id = $2) AS allow_list,
       (SELECT coalesce(json_agg(document_id), '[]'::json)
          FROM automerge_document_workspace
         WHERE landscape_id = $1 AND version_id = $2) AS admitted,
       (SELECT count(*)::text FROM ro_diagrams
         WHERE landscape_id = $1 AND version_id = $2) AS diagram_count`,
    [key.landscapeId, key.versionId],
  )
  const row = rows[0]
  return {
    staticSource: row?.static_source ?? null,
    allowList: row?.allow_list ?? [],
    admitted: new Set(row?.admitted ?? []),
    diagramCount: Number(row?.diagram_count ?? '0'),
  }
}

/**
 * Finish a HYBRID workspace — static rows committed, ordinary root — by writing
 * the ROOT half, and nothing else.
 *
 * WHY IT HAS TO EXIST. The hybrid state is reachable two ways:
 *
 *  1. a crash (or a kill, or a failover) between the promotion's COMMIT and its
 *     root flip. The promotion is written so this is the survivable direction,
 *     but neither other door recovers it: `promote` answers `already-summary`
 *     because the static row exists, `demote` answers `not-promoted` for any
 *     source it did not write and would in any case throw away a correct,
 *     complete allow-list.
 *  2. a `registrySummaryOnly` flag stripped by hand from a static fixture
 *     (which is how the summary-migration test fixtures are built).
 *
 * Both leave a workspace whose baseline write fence is ARMED (the static row is
 * what arms it) under a root that still tells clients to write into the frozen
 * baseline registry. Every diagram creation and rename from a classic tab is
 * dropped at the wire until one half or the other moves.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *  - it MINTS NOTHING. A second write head is the one irreversible mistake in
 *    this module's whole surface: the root would name A while the admitted,
 *    allow-listed head is B, and every diagram created into A is durable and
 *    unreachable. Where the root already names a head, that head is used; where
 *    it does not, the head the committed allow-list already carries is ADOPTED —
 *    it is durable and claimed, because the promotion's one transaction put it
 *    there.
 *  - it opens NO Postgres transaction. It writes two Automerge documents and
 *    reads SQL; there is no multi-row invariant to protect.
 *  - it does NOT wait out the fence. The wait exists to stop a baseline write
 *    being acked before the fence arms — and the fence is ALREADY armed here.
 *    This repair only ever removes a client's ability to write the baseline; it
 *    never grants one.
 *  - it does NOT require a quiesce. A live classic tab on a hybrid workspace is
 *    already having its registry writes dropped; the flag flip is what finally
 *    TELLS it (the client's epoch guard banners and offers the reload). Refusing
 *    to repair while someone is connected would preserve the damage in order to
 *    avoid announcing it.
 */
export async function repairSummaryFlag(options: RepairSummaryFlagOptions): Promise<SummaryFlagRepairReport> {
  const { db, lockDb, repo, workspace, apply = false, hooks = {}, resolveTimeoutMs = 15_000, onProgress } = options
  const say = (message: string) => onProgress?.(message)
  const blockers: SummaryFlagRepairReport['blockers'] = []
  const block = (code: SummaryFlagRepairBlockerCode, detail: string) => blockers.push({ code, detail })

  const rootUrl = await readRootUrl(db, workspace)
  const report: SummaryFlagRepairReport = {
    workspace,
    rootUrl,
    mode: apply ? 'apply' : 'report',
    blockers,
    witnesses: {
      staticSource: null, registrySummaryOnly: false, rootWriteHeadUrl: null,
      allowListSize: 0, admittedDocuments: 0, writeHeadKind: null, diagramCount: 0,
    },
    plan: null,
    applied: null,
  }
  if (!rootUrl) {
    block('no-such-workspace', 'no versions row / root_url for this workspace')
    return report
  }

  const rootHandle = await findReadyDocument<Record<string, unknown>>(repo, rootUrl, resolveTimeoutMs)
    .catch(() => null)
  const root = rootHandle?.doc()
  if (!rootHandle || !root) {
    block('root-unresolved', `the root document ${rootUrl} did not resolve within ${resolveTimeoutMs} ms`)
    return report
  }

  const { staticSource, allowList, admitted, diagramCount } = await readRepairFacts(db, workspace)
  const summaryOnly = root.registrySummaryOnly === true
  const rootWriteHeadUrl = oneUrl(root.registryWriteUrl)

  // The write head: the root's, or — for the crash case, where the root names
  // nothing — the unique `registry-shard` entry the committed allow-list already
  // carries. Never a fresh one.
  const registryShardEntries = allowList.filter((entry) => entry.kind === 'registry-shard')
  const writeHeadUrl = rootWriteHeadUrl
    ?? (registryShardEntries.length === 1 ? `automerge:${registryShardEntries[0].documentId}` : null)
  const writeHeadId = writeHeadUrl ? documentIdOf(writeHeadUrl) : null
  const writeHeadEntry = writeHeadId ? allowList.find((entry) => entry.documentId === writeHeadId) : undefined

  report.witnesses = {
    staticSource,
    registrySummaryOnly: summaryOnly,
    rootWriteHeadUrl,
    allowListSize: allowList.length,
    admittedDocuments: admitted.size,
    writeHeadKind: writeHeadEntry?.kind ?? null,
    diagramCount,
  }

  if (staticSource === null) {
    block(
      'not-hybrid',
      'this workspace has no read_model_static_workspaces row, so nothing has been committed for a root '
      + 'flip to complete. If you meant to move it into the summary world, that is `promote-summary` — '
      + 'this door only finishes a promotion whose durable half already landed.',
    )
  }
  if (summaryOnly) {
    block(
      'not-hybrid',
      'the root already carries registrySummaryOnly: there is no half-open state to close. '
      + '(To take the workspace back out, use `demote-summary`.)',
    )
  }
  if (!oneUrl(root.modelMetaUrl)) {
    block(
      'monolith-workspace',
      'the root names no ModelMeta. A monolith workspace has no `staticBaseline` to set and cannot be '
      + 'in the summary world at all — a static row on one is a defect this door cannot repair.',
    )
  }

  if (!writeHeadUrl) {
    block(
      'write-head-missing',
      `neither the root (registryWriteUrl) nor the committed allow-list (${registryShardEntries.length} `
      + "entries of kind 'registry-shard') names a registry write head. A summary root without one leaves "
      + 'every client unable to create a diagram, and minting one here would risk a SECOND head next to a '
      + 'first this repair cannot see. Investigate with `npm run fsck` before doing anything else.',
    )
  } else if (!rootWriteHeadUrl && registryShardEntries.length > 1) {
    block(
      'write-head-ambiguous',
      `the allow-list carries ${registryShardEntries.length} documents of kind 'registry-shard' and the root `
      + 'names none, so the head to adopt cannot be determined. Picking one would strand every diagram '
      + 'created into the others.',
    )
  }
  if (writeHeadId && !writeHeadEntry) {
    block(
      'write-head-not-writable',
      `the write head ${writeHeadId} is absent from the committed allow-list: after the flip, `
      + "`resolveDurable`'s static_allowed filter would stop resolving the one document a summary client "
      + 'must keep writing.',
    )
  } else if (writeHeadEntry && (writeHeadEntry.kind !== 'registry-shard' || isBaselineDocumentKind(writeHeadEntry.kind))) {
    block(
      'write-head-not-writable',
      `the write head ${writeHeadId} is listed as '${writeHeadEntry.kind}': the baseline write fence would drop `
      + 'every diagram creation and rename on this workspace (the performance-fixture defect). '
      + "It is ALWAYS 'registry-shard'.",
    )
  }

  // |allow-list| == |automerge_document_workspace|, BOTH directions. The set
  // comparison, not the counts: two disagreements of equal size cancel in a
  // count and leave a document that stops resolving the moment the root flips.
  const listed = new Set(allowList.map((entry) => entry.documentId))
  const admittedButUnlisted = [...admitted].filter((id) => !listed.has(id))
  const listedButUnadmitted = [...listed].filter((id) => !admitted.has(id))
  if (admittedButUnlisted.length || listedButUnadmitted.length) {
    block(
      'allow-list-incomplete',
      `|allow-list| ≠ |automerge_document_workspace|: ${admittedButUnlisted.length} admitted document(s) are `
      + `not in the allow-list (${sample(admittedButUnlisted)}) and ${listedButUnadmitted.length} listed `
      + `document(s) are not admitted (${sample(listedButUnadmitted)}). Flipping the root over a partial `
      + 'allow-list arms `static_allowed` over documents it does not list — they stop resolving durably and '
      + 'the content is stranded. This repair only completes a promotion whose durable half is COMPLETE.',
    )
  }

  const metaUrl = oneUrl(root.modelMetaUrl)
  const metaHandle = metaUrl
    ? await findReadyDocument<Record<string, unknown>>(repo, metaUrl, resolveTimeoutMs).catch(() => null)
    : null
  if (metaUrl && !metaHandle) {
    block(
      'meta-unresolved',
      `the root names ModelMeta ${metaUrl} and it did not resolve within ${resolveTimeoutMs} ms; `
      + '`staticBaseline` is half of the summary contract and cannot be set without it.',
    )
  }

  if (writeHeadUrl) {
    report.plan = {
      writeHeadUrl,
      adoptedFromAllowList: rootWriteHeadUrl === null,
      diagramCount,
    }
  }
  if (!apply || blockers.length > 0 || !report.plan || !metaHandle) {
    if (apply && blockers.length > 0) say(`REFUSED: ${blockers.length} blocker(s)`)
    return report
  }

  // THE LIFECYCLE APPLY LOCK, before the root flip — the first irreversible act
  // here. This door's precondition (a static row under an un-flipped root) is
  // exactly the state a healthy promotion occupies between its step 3 and its
  // step 6, so unlocked it cannot tell a crashed promotion from a running one.
  const lockHolder = await acquireLifecycleApplyLock(lockDb ?? db, workspace)
  if (!lockHolder) {
    block(
      'lifecycle-in-flight',
      'another lifecycle operation on this workspace (a promotion, a demotion or a flag repair) holds the '
      + 'apply lock. Nothing was written. A promotion in its post-commit window looks EXACTLY like the '
      + 'half-open state this door repairs — so if that is what holds the lock, there was nothing to repair.',
    )
    say('REFUSED: another lifecycle operation holds the apply lock')
    return report
  }
  try {
    // RE-READ the two witnesses that can move, as the other two doors do: the
    // plan above was computed against facts up to one document
    // resolve old, and a promotion that completed in that window leaves a root
    // this door must not flip a second time.
    const currentRoot = rootHandle.doc()
    const currentStaticSource = await readStaticSource(db, workspace)
    const movedWitness = currentStaticSource !== staticSource
      ? `read_model_static_workspaces.source changed from ${staticSource ?? 'none'} to `
        + `${currentStaticSource ?? 'none'} between the plan and the apply lock`
      : currentRoot?.registrySummaryOnly === true
        ? 'the root became summary-only between the plan and the apply lock; the promotion that owned this '
          + 'half-open state finished it, and there is nothing left to repair'
        : null
    if (movedWitness || !currentRoot) {
      block('witness-moved', movedWitness ?? 'the root document stopped resolving between the plan and the apply lock')
      say(`REFUSED: ${movedWitness ?? 'the root stopped resolving'}`)
      return report
    }

    // The ROOT half, through the ONE root-shape mapper — in place, same url.
    say('1/2 flipping the root to the summary contract')
    const head = report.plan.writeHeadUrl
    const shardUrls = urlList(currentRoot.shardUrls)
    const nextRoot = copyRootShape(currentRoot as Partial<WorkspaceRootShape>, {
      registrySummaryOnly: true,
      registryWriteUrl: head,
      diagramCount,
      shardUrls: shardUrls.includes(head) ? shardUrls : [...shardUrls, head],
    })
    applyRootShape(rootHandle, nextRoot)
    await repo.flush([rootHandle.documentId as DocumentId])
    await hooks.onStep?.('root-flipped')

    say('2/2 setting staticBaseline on the ModelMeta')
    metaHandle.change((doc) => { doc.staticBaseline = true })
    await repo.flush([metaHandle.documentId as DocumentId])
    await hooks.onStep?.('meta-flagged')

    hooks.drainPeers?.(workspace, 'workspace contract repaired to the summary contract')
    report.applied = report.plan
    say('repaired')
    return report
  } finally {
    // Mutating the returned object from `finally` is intentional: `return
    // report` evaluates the REFERENCE before this block runs, so a field
    // written here reaches the caller from every return path.
    report.exclusionProven = await releaseLifecycleApplyLock(lockHolder, workspace)
  }
}
