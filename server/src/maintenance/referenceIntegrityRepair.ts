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
import type { DocumentId, Repo } from '@automerge/automerge-repo'
import type { Queryable } from '../readModel/types.js'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { deleteDiagramDoc, findDiagram, stripIdsFromAllDiagrams, updateDiagramDoc } from '../ai/core/modelOps.js'
import {
  linkTypesForKind,
  removeDecisionRecordLinks,
  type AdrLinkRemoval,
  type DecisionRecordLike,
  type MetaLike as AdrMetaLike,
} from './decisionRecordLinkRemoval.js'
import {
  LifecycleApplyRefusedError,
  sessionHoldsLifecycleLock,
  withLifecycleApplyLock,
  type LockedSession,
} from './lifecycleApplyLock.js'
import { classifyMissingRegistryReference } from './registryReferenceRepair.js'
import { readModelRedirectBaseVersion, readModelUntrustworthyReason, scanDocumentReferences } from './referenceIntegrityDocuments.js'
import { scanReferenceIntegrity } from './referenceIntegrityScan.js'
import type { ReferenceFinding } from './referenceFindings.js'

/**
 * Repair the references `scanReferenceIntegrity` found dangling.
 *
 * DRY RUN IS THE DEFAULT. `apply` is opt-in, and the workspace is a REQUIRED
 * argument rather than a filter — a fleet-wide apply is not representable, so it
 * cannot be reached by forgetting a parameter. Repair writes Automerge documents
 * directly and therefore bypasses the RBAC write gate, which is why it is
 * platform-admin only and why every applied run is audited.
 *
 * Not everything the scan reports can be repaired mechanically, and the ones
 * that cannot are the interesting part — see `planReferenceRepair`.
 *
 * THE APPLY IS EXCLUDED AGAINST THE WORKSPACE'S OTHER LIFECYCLE DOORS: it
 * takes the same key as promote, demote and repair-summary-flag
 * (`lifecycleApplyLock.ts`), and re-reads under it the guards this function
 * evaluates on a snapshot. A refusal is a thrown `LifecycleApplyRefusedError`
 * and nothing was written.
 *
 * `repairDegenerateRoots`, the only known writer of `versions.root_url`, takes
 * the key too. That matters here because `versions.root_url` is one of the
 * witnesses `assertWorkspaceHeldStill` re-reads: against that writer the
 * re-read is an invariant for the whole apply rather than a snapshot. See the
 * header of `lifecycleApplyLock.ts` for the full list of doors.
 */

export type ReferenceRepairAction =
  /** Remove a dangling id from every diagram's composition and layouts. */
  | 'strip-composition'
  /** Delete `Diagram.parentObjectId`, which points at a deleted object. */
  | 'clear-parent-object'
  /** Delete `Group.parentObjectId` — the one with a visible symptom. */
  | 'clear-group-parent'
  /** Drop a deleted object from a group's member list. */
  | 'drop-group-member'
  /** Delete a layout key that names nothing, from the layer that holds it. */
  | 'drop-layout-key'
  /** Drop a registry entry whose document is provably absent from storage. */
  | 'drop-registry-entry'
  /** Splice a dangling link out of one decision record's `related`. */
  | 'strip-adr-link'
  /** Nothing to do: the read paths already handle it by design. */
  | 'none'
  /** A human has to decide. `reason` says why. */
  | 'manual'

export interface ReferenceRepairPlan {
  finding: ReferenceFinding
  action: ReferenceRepairAction
  safeToApply: boolean
  /** Present whenever `safeToApply` is false — never make a console guess. */
  reason?: string
  /** What the mutation actually DID. Set only for actions that report effects,
   *  so `applied` can be counted from outcomes rather than from intentions. */
  outcome?: string
}

/**
 * How much work one apply may do while holding the workspace's lifecycle lock.
 *
 * NOT A MEASURED LATENCY BUDGET, and NOT a bound on the work either.
 *
 * It is the SCAN's own `DEFAULT_LIMIT` (`referenceIntegrityScan.ts`), reused as
 * a bound on the number of PLANS one held-lock window may carry.
 *
 * IT DOES NOT BOUND THE DOCUMENTS THAT WINDOW OPENS. One
 * `strip-composition` plan reaches `stripIdsFromAllDiagrams`, which walks EVERY
 * registry shard and opens EVERY diagram whose stub mentions the id. A single
 * deleted object that had been placed on ten thousand diagrams is one plan and
 * ten thousand DiagramDocs. Plans and documents are not proportional, and
 * nothing here bounds the second.
 *
 * IT SLICES, IT DOES NOT REFUSE. A hard refusal would tell the operator to
 * re-run with a smaller `limit`; but `limit` reaches the SQL leg and the walk's
 * per-diagram cap, NOT the group findings, which come from one ModelMeta
 * document and are bounded by nothing a caller can pass. A workspace with
 * enough dangling group members would be refused permanently.
 *
 * Applying the first N and reporting `truncated` cannot fail that way: the
 * repair is incremental, every plan is independent, and successive runs
 * converge on the state one unbounded run would have reached. The bound still
 * does its job — the plan set one held-lock window carries is finite and
 * stated — without inventing a state the operator cannot leave.
 */
const MAX_ACTIONABLE_PER_APPLY = 500

/**
 * Above this, the hold is REPORTED. Nothing is interrupted.
 *
 * Borrowed rather than invented: 5 000 ms is the same boundary
 * `PROJECTION_MUTEX_WAIT_MS` already draws in `promoteSummaryWorkspace.ts`
 * between "a wait a lifecycle door may take" and "a refusal", and a repair that
 * holds the shared key longer than a promotion is willing to wait for it is
 * worth an operator's attention. No measurement of THIS door stands behind the
 * value; the log line exists to produce one.
 */
const LOCK_HOLD_SOFT_CEILING_MS = 5_000

/** What the apply's own guarantees were worth, for the window they covered. */
export interface ReferenceApplyIntegrity {
  /**
   * False when the writing session could not prove it still held the apply key
   * once the writes were done — a dead backend ends the exclusion silently.
   * False does NOT mean "retry"; it means run `fsck` on this workspace.
   */
  exclusionProven: boolean
  /**
   * Non-null when the read model became untrustworthy DURING the apply. The
   * plans were therefore derived from evidence that stopped being ground truth
   * while they were being written, which no check before the lock could see:
   * `degraded_since` is the projector's, and the projector takes no lifecycle
   * lock.
   */
  degradedDuringApply: string | null
  /** How long the workspace's apply lock was actually held, wall clock. */
  heldForMs: number
}

export interface ReferenceRepairResult {
  reportOnly: boolean
  landscapeId: string
  versionId: string
  plans: ReferenceRepairPlan[]
  /** Findings actually repaired. Zero on a dry run. */
  applied: number
  /** Findings deliberately left alone (manual or by-design). */
  skipped: number
  /** True when the underlying scan hit its cap, so this is not the whole story. */
  truncated: boolean
  /**
   * Present EXACTLY when the apply lock was taken and the writes ran — so a dry
   * run, and an apply with nothing actionable, both leave it absent. Absence is
   * therefore "no writes happened", never "the writes were fine".
   */
  applyIntegrity?: ReferenceApplyIntegrity
}

/**
 * Decide what can be done about one finding, from the kind alone.
 *
 * Pure, so the decision that matters most — what NOT to touch automatically —
 * is testable without a database or a repo.
 */
export function planReferenceRepair(finding: ReferenceFinding): ReferenceRepairPlan {
  switch (finding.kind) {
    case 'diagram.layouts':
      // NOT `strip-composition`, which was the first thing tried and silently
      // did nothing: `stripIdsFromAllDiagrams` only opens a DiagramDoc when the
      // registry stub's COMPOSITION mentions the id, and a layout-key finding is
      // by definition an id that is in `layouts` and not in the composition. It
      // reported applied=1 and changed nothing. This needs its own op, and one
      // that knows which layer the key is in — `updateDiagramDoc` only touches
      // `layouts`, never `layouts3d`.
      return { finding, action: 'drop-layout-key', safeToApply: true }

    case 'diagram.groupIds':
    case 'diagram.objectIds':
    case 'diagram.connectionIds':
      // The id resolves to nothing anywhere in the workspace, so removing it
      // from every diagram that lists it is exactly right — and is what the
      // delete SHOULD have done. stripIdsFromAllDiagrams also drops the layout
      // key, which is membership rather than existence and would otherwise
      // resurrect an old position if the id ever came back.
      return { finding, action: 'strip-composition', safeToApply: true }

    case 'diagram.parentObjectId':
      return { finding, action: 'clear-parent-object', safeToApply: true }

    case 'group.parentObjectId':
      // The visible one: the canvas paints wrapper chrome and a live "create
      // detail diagram" control anchored to an object that is gone.
      return { finding, action: 'clear-group-parent', safeToApply: true }

    case 'group.objectIds':
      return { finding, action: 'drop-group-member', safeToApply: true }

    case 'flowStep.refs':
      // A step without its endpoint is malformed; blanking the field does not
      // repair it and removing the step is a content decision.
      return { finding, action: 'manual', safeToApply: false, reason: 'a flow step without its endpoint needs a content decision, not a field edit' }

    case 'diagram.docUrl':
      // Undecidable from the kind alone: whether this entry may be dropped
      // depends on storage ownership and projection state, which need a query.
      // `enrichRegistryEntryPlans` upgrades it — this is the answer when nobody
      // asked, and the safe one.
      return { finding, action: 'manual', safeToApply: false, reason: 'pending: storage ownership not checked' }

    case 'object.parentId':
      // By design. The server refuses-or-cascades, the client cannot enumerate
      // off-window children, and BOTH read paths already re-root a dangling
      // parent on purpose. "Repairing" it would rewrite documents to achieve
      // what the readers already do.
      return { finding, action: 'none', safeToApply: false, reason: 'by-design: both read paths re-root a dangling parent' }

    case 'connection.endpoint':
      // There is no half-connection: clearing the field is not a repair, and the
      // only real one is deleting the connection. Destructive, so never on a
      // bulk apply — it needs a per-finding decision this function cannot make.
      return { finding, action: 'manual', safeToApply: false, reason: 'destructive: the only repair is deleting the connection' }

    case 'decisionRecord.related.diagram':
    case 'decisionRecord.related.adr':
      // Undecidable from the kind alone. An ADRLink is USER-AUTHORED content and
      // `ro_decision_records` has only two writers, neither of them the ordinary
      // projector — a stale baseline projection would report every link as
      // dangling. The read model is not evidence here; the documents are.
      return { finding, action: 'manual', safeToApply: false, reason: 'pending: link target not confirmed absent from the documents' }
  }
}

interface RootLike { modelUrl?: string; modelMetaUrl?: string }
interface MetaLike { groups?: Record<string, { parentObjectId?: string; objectIds?: string[] }> }

/**
 * Repair the group references that live in `ModelMeta`.
 *
 * Written here rather than through `upsertInlineEntities` on purpose: that helper
 * assigns the WHOLE group object, which would clobber a concurrent edit to any
 * other field of the same group. A repair must touch only what it is repairing —
 * the same minimal-op discipline the client's reconciler follows.
 */
async function repairGroupReferences(
  repo: Repo,
  rootUrl: string,
  clearParent: ReadonlySet<string>,
  dropMembers: ReadonlyMap<string, ReadonlySet<string>>,
  touched?: Set<DocumentId>,
  documentTimeoutMs = 5_000,
): Promise<void> {
  if (clearParent.size === 0 && dropMembers.size === 0) return
  const root = (await findReadyDocument<RootLike>(repo, rootUrl, documentTimeoutMs)).doc()
  const metaUrl = root?.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl) ? root.modelMetaUrl : root?.modelUrl
  if (!metaUrl || !isValidAutomergeUrl(metaUrl)) throw new Error(`workspace ${rootUrl} has no model document`)
  const handle = await findReadyDocument<MetaLike>(repo, metaUrl, documentTimeoutMs)
  touched?.add(handle.documentId)
  handle.change((meta) => {
    for (const groupId of clearParent) {
      const group = meta.groups?.[groupId]
      if (group && 'parentObjectId' in group) delete group.parentObjectId
    }
    for (const [groupId, drop] of dropMembers) {
      const group = meta.groups?.[groupId]
      const members = group?.objectIds
      if (!members) continue
      // Tail-first: each splice leaves the lower indices valid.
      for (let i = members.length - 1; i >= 0; i--) {
        if (drop.has(members[i])) members.splice(i, 1)
      }
    }
  })
}

/**
 * Apply the link removals to ModelMeta, seeding overlay entries from the
 * materialized record only where none exists yet.
 */
async function repairDecisionRecordLinks(
  repo: Repo,
  rootUrl: string,
  removals: readonly AdrLinkRemoval[],
  touched?: Set<DocumentId>,
  documentTimeoutMs = 5_000,
  maxRecordShards = 24,
): Promise<ReturnType<typeof removeDecisionRecordLinks>> {
  const root = (await findReadyDocument<AdrRootLike>(repo, rootUrl, documentTimeoutMs)).doc()
  const metaUrl = root?.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl) ? root.modelMetaUrl : root?.modelUrl
  if (!metaUrl || !isValidAutomergeUrl(metaUrl)) throw new Error(`workspace ${rootUrl} has no model document`)
  const handle = await findReadyDocument<AdrMetaLike & { decisionRecordShardUrls?: string[] }>(repo, metaUrl, documentTimeoutMs)
  touched?.add(handle.documentId)

  // Only for ids with no overlay entry — that is the sole case needing a seed,
  // and the value must be the MATERIALIZED record so nothing edited since the
  // baseline is rolled back.
  const meta = handle.doc()
  const needBaseline = [...new Set(removals.map((r) => r.adrId))]
    .filter((id) => !meta?.decisionRecords?.[id])
  const baselineById = new Map<string, DecisionRecordLike>()
  if (needBaseline.length > 0) {
    const wanted = new Set(needBaseline)
    // Same memory bound as the planning walk, and for the same reason: this leg
    // short-circuits when every wanted id is found, but a record that is MISSING
    // (or in the last shard) makes it open all of them — ~26 MB apiece, which is
    // the `RangeError: out of memory` the planning walk's cap exists to avoid.
    // Falling short here is harmless: an unseeded id reports `absent`.
    let walked = 0
    for (const shardUrl of meta?.decisionRecordShardUrls ?? []) {
      if (wanted.size === 0 || walked >= maxRecordShards) break
      if (!isValidAutomergeUrl(shardUrl)) continue
      const shard = await tryRead<{ decisionRecords?: Record<string, DecisionRecordLike> }>(
        repo, shardUrl, documentTimeoutMs)
      walked++
      if (shard === 'unreadable') continue
      for (const id of [...wanted]) {
        const found = shard?.decisionRecords?.[id]
        if (found) { baselineById.set(id, found); wanted.delete(id) }
      }
    }
  }

  let results: ReturnType<typeof removeDecisionRecordLinks> = []
  handle.change((draft) => {
    results = removeDecisionRecordLinks(draft, removals, baselineById)
  })
  return results
}

/**
 * Decide which unreadable-document findings may actually be dropped.
 *
 * The walk marks a document `unreadable` when it fails to resolve — and a
 * TIMEOUT is not proof of absence, it is the `unknown` this module must
 * distinguish from `dangling`. So the verdict is re-derived from
 * storage, which is evidence rather than an observation: a document still in
 * `automerge_storage` was never missing, and one still mapped to a workspace or
 * still projected into `ro_diagrams` is not ours to drop.
 *
 * The judgement is `classifyMissingRegistryReference`, reused from
 * `registryReferenceRepair.ts` — the decision, not its fleet-wide driver, which
 * has no caller and applies all-or-nothing across every version at once.
 */
async function enrichRegistryEntryPlans(db: Queryable, plans: ReferenceRepairPlan[]): Promise<void> {
  const pending = plans.filter((plan) => plan.finding.kind === 'diagram.docUrl')
  if (pending.length === 0) return
  const documentIds = [...new Set(pending.map((plan) => plan.finding.targetId.replace(/^automerge:/, '')))]
  const { rows } = await db.query<{ document_id: string; stored: boolean; mapped: boolean; projected: boolean }>(
    `WITH candidate(document_id) AS (SELECT unnest($1::text[]))
     SELECT candidate.document_id,
       EXISTS (SELECT 1 FROM automerge_storage storage
               WHERE split_part(storage.key, '/', 1) = candidate.document_id) AS stored,
       EXISTS (SELECT 1 FROM automerge_document_workspace mapping
               WHERE mapping.document_id = candidate.document_id) AS mapped,
       EXISTS (SELECT 1 FROM ro_diagrams diagram
               WHERE replace(COALESCE(diagram.data->>'docUrl', ''), 'automerge:', '') = candidate.document_id) AS projected
     FROM candidate`,
    [documentIds],
  )
  const stateById = new Map(rows.map((row) => [row.document_id, row]))
  for (const plan of pending) {
    const state = stateById.get(plan.finding.targetId.replace(/^automerge:/, ''))
    if (state?.stored) {
      plan.reason = 'not missing: the document is in storage, so the walk timed out rather than found it absent'
      continue
    }
    const verdict = classifyMissingRegistryReference({
      mapped: state?.mapped === true,
      projected: state?.projected === true,
    })
    if (!verdict.safeToRemove) {
      plan.reason = `still ${verdict.mapped ? 'mapped to a workspace' : 'projected into the read model'} — not ours to drop`
      continue
    }
    plan.action = 'drop-registry-entry'
    plan.safeToApply = true
    delete plan.reason
  }
}

interface AdrRootLike { modelUrl?: string; modelMetaUrl?: string; shardUrls?: string[] }
interface AdrShardLike { decisionRecords?: Record<string, unknown> }
interface AdrMetaShape { decisionRecordShardUrls?: string[]; staticBaseline?: boolean }

/**
 * How much of a collection the walk actually saw.
 *
 * Two legs, tracked SEPARATELY: a plan may only be promoted on the strength of
 * the leg that would prove ITS target absent. Sharing one flag is how a
 * truncated diagram walk got read as "the diagram is not there" — the leg that
 * stopped early was not the leg being consulted.
 */
interface WalkCoverage { complete: boolean; reason: string }

/** Read one document, treating any failure as a hole in the walk rather than as
 *  an answer. `findReadyDocument` rejects on an unreadable document, and a
 *  rejection here must never reach the caller as absence — nor as a 500. */
async function tryRead<T>(repo: Repo, url: string, timeoutMs: number): Promise<T | undefined | 'unreadable'> {
  try {
    return (await findReadyDocument<T>(repo, url, timeoutMs)).doc()
  } catch {
    return 'unreadable'
  }
}

/**
 * Confirm from the DOCUMENTS that an ADR link's target is really gone.
 *
 * Never from `ro_decision_records`: it is written only by the one-shot baseline
 * build and the static delta projector, so a stale or half-built projection
 * would have this tool delete authored content at scale. Same refusal shape as
 * `enrichRegistryEntryPlans` — an observation is not evidence.
 *
 * A deadline or cap reached WITHOUT proof leaves the plan `manual`. Absence of
 * proof is `unknown`, never `dangling`.
 *
 * **The shard cap is a MEMORY bound, not a latency one, and it is the binding
 * constraint.** At the 100k seed shape (200 ADR shards x 500 records), one
 * Repo holding all of them peaks around 5.6 GB RSS — ~26 MB per shard, linear
 * — and in a process that has already done Automerge work the same walk can die
 * on an unrecoverable `RangeError: out of memory` from automerge_wasm. A
 * long-lived sync server is exactly that process. Time is the lesser problem
 * (~0.4 s per shard), and the walk cannot short-circuit: the repair
 * only fires when the target is ABSENT, which is the case that must open every
 * shard.
 *
 * **A leg that could not finish must not answer for the leg that did.** Both
 * `liveDiagrams` and `liveRecords` carry their own `WalkCoverage`, and a plan is
 * promoted only on the strength of the one that would prove ITS target absent.
 * A shared flag would let one malformed `shardUrls` entry (or a deadline) in the
 * diagram leg go unrecorded, and links pointing at diagrams that exist would be
 * stripped.
 *
 * **`decisionRecordShardUrls: []` is not proof either.** `toPerformanceControlMeta`
 * publishes exactly that alongside `staticBaseline: true` for the static
 * relational baseline, whose ADRs live in PostgreSQL — so walking zero shards
 * means the documents CANNOT hold the answer, not that the record is gone. In
 * that configuration `meta.decisionRecords` is an edit overlay, and treating it
 * as the collection would strip every link to a baseline-resident ADR. The
 * record leg is complete only when the meta is inline (its `decisionRecords` IS
 * the collection) or when every shard was walked.
 */
async function enrichDecisionRecordLinkPlans(
  repo: Repo,
  rootUrl: string,
  plans: ReferenceRepairPlan[],
  options: {
    deadlineMs?: number
    documentTimeoutMs?: number
    maxRecordShards?: number
    maxRegistryShards?: number
    now?: () => number
  } = {},
): Promise<WalkCoverage> {
  const pending = plans.filter((plan) => plan.finding.kind.startsWith('decisionRecord.related.'))
  if (pending.length === 0) return { complete: true, reason: '' }
  const deadlineMs = options.deadlineMs ?? 20_000
  const documentTimeoutMs = options.documentTimeoutMs ?? 5_000
  // 24 x ~26 MB of resident shard is the most this is willing to cost a shared,
  // long-lived repo. Past it the honest answer is `unknown`.
  const maxRecordShards = options.maxRecordShards ?? 24
  // Registry shards are small (diagram stubs, not records), but "small x
  // unbounded" is still unbounded on a shared repo, and this walk now has to
  // report incompleteness anyway.
  const maxRegistryShards = options.maxRegistryShards ?? 64
  const clock = options.now ?? (() => Date.now())
  const startedAt = clock()
  const outOfTime = () => clock() - startedAt >= deadlineMs

  const unresolved = (reason: string): WalkCoverage => {
    for (const plan of pending) plan.reason = `pending: ${reason}`
    return { complete: false, reason }
  }

  const root = await tryRead<AdrRootLike>(repo, rootUrl, documentTimeoutMs)
  if (root === 'unreadable') return unresolved('the workspace root could not be read')
  if (!root) return unresolved('the workspace root is empty')

  const diagrams: WalkCoverage = { complete: true, reason: '' }
  const liveDiagrams = new Set<string>()
  let registryWalked = 0
  for (const shardUrl of root.shardUrls ?? []) {
    if (!isValidAutomergeUrl(shardUrl)) {
      // `continue`, not `break`: one malformed entry must not hide every diagram
      // after it. It DOES make the walk incomplete — that is the point.
      diagrams.complete = false
      diagrams.reason = 'a registry shard URL is malformed, so the diagram list is incomplete'
      continue
    }
    if (registryWalked >= maxRegistryShards) {
      diagrams.complete = false
      diagrams.reason = `more than ${maxRegistryShards} registry shards — the diagram list was not read in full`
      break
    }
    if (outOfTime()) {
      diagrams.complete = false
      diagrams.reason = 'could not read every registry shard within the deadline'
      break
    }
    const shard = await tryRead<{ diagrams?: Record<string, unknown> }>(repo, shardUrl, documentTimeoutMs)
    if (shard === 'unreadable') {
      diagrams.complete = false
      diagrams.reason = 'a registry shard could not be read, so the diagram list is incomplete'
      continue
    }
    for (const id of Object.keys(shard?.diagrams ?? {})) liveDiagrams.add(id)
    registryWalked++
  }

  const metaUrl = root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl) ? root.modelMetaUrl : root.modelUrl
  const meta = metaUrl && isValidAutomergeUrl(metaUrl)
    ? await tryRead<AdrMetaLike & AdrMetaShape>(repo, metaUrl, documentTimeoutMs)
    : undefined
  if (meta === 'unreadable') return unresolved('the model document could not be read')
  if (!meta) return unresolved('the workspace has no model document')

  const liveRecords = new Set(Object.keys(meta.decisionRecords ?? {}))
  const tombstoned = new Set(meta.deletedDecisionRecordIds ?? [])
  const shardUrls = meta.decisionRecordShardUrls ?? []
  // Mirrors `usesDecisionRecordDelta` on the client: either marker means
  // `decisionRecords` is an EDIT OVERLAY and the collection lives elsewhere.
  const paged = meta.staticBaseline === true || shardUrls.length > 0
  const records: WalkCoverage = paged && shardUrls.length === 0
    ? {
        complete: false,
        reason: 'this workspace keeps its ADR baseline outside the documents (static relational baseline), '
          + 'so the documents cannot prove the target absent',
      }
    : { complete: true, reason: '' }
  let shardsWalked = 0
  for (const shardUrl of shardUrls) {
    if (!isValidAutomergeUrl(shardUrl)) {
      records.complete = false
      records.reason = 'an ADR shard URL is malformed, so the record list is incomplete'
      continue
    }
    if (shardsWalked >= maxRecordShards) {
      records.complete = false
      records.reason = `more than ${maxRecordShards} ADR shards — proving absence would cost more resident memory than this is allowed to`
      break
    }
    if (outOfTime()) {
      records.complete = false
      records.reason = 'could not read every ADR shard within the deadline'
      break
    }
    const shard = await tryRead<AdrShardLike>(repo, shardUrl, documentTimeoutMs)
    if (shard === 'unreadable') {
      records.complete = false
      records.reason = 'an ADR shard could not be read, so the record list is incomplete'
      continue
    }
    for (const id of Object.keys(shard?.decisionRecords ?? {})) liveRecords.add(id)
    shardsWalked++
  }

  // EVIDENCE FIRST, COVERAGE SECOND — the order matters and is not stylistic.
  // A positive sighting is proof on its own: having seen the target, how much of
  // the rest went unread is irrelevant. Only the ABSENCE claim needs the walk to
  // have finished. Testing coverage first would refuse findings the walk had
  // already answered, and — worse — makes the `continue`-past-a-bad-shard repair
  // above unobservable, since nothing would ever consult what it recovered.
  for (const plan of pending) {
    const isDiagram = plan.finding.kind === 'decisionRecord.related.diagram'
    const targetId = plan.finding.targetId
    // A tombstone is a positive statement that the record was DELETED, so it
    // proves absence without a complete walk, the same way a sighting proves
    // presence.
    const deleted = !isDiagram && tombstoned.has(targetId)
    const seen = isDiagram ? liveDiagrams.has(targetId) : liveRecords.has(targetId)
    if (seen && !deleted) {
      plan.reason = 'not missing: the target is in the documents, so the read model is stale'
      continue
    }
    const coverage = isDiagram ? diagrams : records
    if (!deleted && !coverage.complete) {
      plan.reason = `pending: ${coverage.reason}`
      continue
    }
    plan.action = 'strip-adr-link'
    plan.safeToApply = true
    delete plan.reason
  }
  if (diagrams.complete && records.complete) return { complete: true, reason: '' }
  return { complete: false, reason: diagrams.complete ? records.reason : diagrams.reason }
}

/**
 * Delete layout keys that name nothing, per diagram and per layer.
 *
 * Targeted at the diagram the finding names rather than swept across the
 * workspace: a layout key is scoped to its own diagram, so there is nothing to
 * gain from opening every other document.
 */
async function repairLayoutKeys(
  repo: Repo,
  rootUrl: string,
  byDiagram: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>,
  touched?: Set<DocumentId>,
): Promise<void> {
  if (byDiagram.size === 0) return
  for (const [diagramId, byLayer] of byDiagram) {
    const found = await findDiagram(repo, rootUrl, diagramId)
    if (!found) continue
    touched?.add(found.doc.documentId)
    found.doc.change((doc) => {
      for (const [layer, keys] of byLayer) {
        const layouts = (doc as Record<string, unknown>)[layer] as Record<string, unknown> | undefined
        if (!layouts) continue
        for (const key of keys) delete layouts[key]
      }
    })
  }
}

export interface ReferenceRepairOptions {
  /** Required, not a filter: a fleet-wide apply must be unrepresentable. */
  landscapeId: string
  versionId: string
  /** Defaults to FALSE. Nothing is written unless a caller says so. */
  apply?: boolean
  limit?: number
  /** Also walk the Automerge documents. Off by default: it opens one document
   *  per diagram, where the SQL leg is a handful of indexed queries. */
  documents?: boolean
  /**
   * TEST SEAM, never passed in production. The same shape and the same name as
   * `PromotionHooks.onStep` in `promoteSummaryWorkspace.ts`, deliberately.
   *
   * It exists because `assertWorkspaceHeldStill`'s branches are otherwise
   * unreachable from a test: the window they defend is opened by another
   * process and closed again before this one gets its next `await`, and a
   * re-read nothing ever trips proves nothing.
   *
   * TWO STEPS, NOT ONE. The fingerprint is sampled before the scan so it covers
   * the SCAN as well as the planning; `fingerprint-taken` fires in that earlier
   * window, so a transition landing during the scan is reachable from a test
   * (with only `planned`, sampling late would go unnoticed).
   *
   * Neither step can weaken the lock: both fire outside the critical section,
   * so whatever they do is subject to the same exclusion as any other
   * neighbour. Neither is reachable from HTTP — the route builds its options
   * field by field and never spreads the request body, and JSON cannot carry a
   * function in any case.
   */
  onStep?: (step: ReferenceRepairStep) => Promise<void>
}

export type ReferenceRepairStep =
  /** The lifecycle fingerprint is sampled; the scan has NOT started. */
  | 'fingerprint-taken'
  /** All evidence gathered and planned; the apply lock has NOT been asked for. */
  | 'planned'
  /**
   * INSIDE the critical section: every document write has landed and been
   * flushed, and the exit health check has NOT run yet.
   *
   * It exists because the state this seam stands in for cannot be produced from
   * outside: the exit check answers "did the read model go untrustworthy WHILE
   * the writes were happening", and the writer that produces that state — the
   * projector setting `degraded_since` — takes no lifecycle lock and so cannot
   * be driven through any door's own API. Firing here puts a test exactly where
   * the projector would have been.
   */
  | 'applied'

/**
 * The two facts a completed lifecycle operation MOVES, sampled twice: once when
 * the evidence starts being gathered, once under the apply lock.
 *
 * The lock alone does not close this. It excludes a lifecycle door that is
 * running RIGHT NOW; it says nothing about one that committed and released
 * while this repair was scanning — and a promotion waits out the fence between
 * its static commit and its root flip, so "while this was scanning" is the
 * common case rather than the rare one. Same argument, and same remedy, as
 * `volatileWitnessesMoved` in `promoteSummaryWorkspace.ts`.
 *
 * WHY THESE FOUR.
 *
 * `read_model_static_workspaces.source` is the promotion's commit witness (the
 * promotion writes it, the demotion deletes it). `versions.root_url` moves on a
 * fork or a restore, and every write below is addressed THROUGH the root — a
 * repair planned against one registry and applied to another is a repair of a
 * workspace nobody asked about.
 *
 * THOSE TWO ARE NOT ENOUGH: `repairSummaryFlag` writes NO SQL AT ALL — it
 * mints nothing, opens no Postgres transaction, and flips the root in place,
 * same url. So a flag repair
 * can run to completion inside this run's evidence window and move neither SQL
 * witness, while changing the four facts that decide which registry the
 * workspace reads and writes.
 *
 * Hence the ROOT SHAPE. `registrySummaryOnly` and `registryWriteUrl` are the
 * two the flag repair sets, and promote and demote move them too, so they
 * subsume the SQL pair for lifecycle purposes rather than merely adding to it.
 * They are read only when applying: a dry run has nothing to protect and should
 * not pay a document resolve.
 *
 * The SQL is ONE statement with two scalar subqueries, not two round trips.
 * Sampled separately they can interleave, and the interleaving produces a false
 * PASS by ABA — a demote-then-promote restores `source` to its old value while
 * minting a fresh empty write head, which is exactly the transition this exists
 * to catch.
 *
 * The static-source query is duplicated from `promoteSummaryWorkspace`'s own
 * rather than exported from it, to keep this module off that one's import
 * graph. The duplication is safe in the one direction that matters: a table or
 * column rename breaks BOTH with a SQL error, so the two cannot silently
 * disagree.
 */
interface LifecycleFingerprint {
  rootUrl: string | undefined
  staticSource: string | null
  /** Undefined on a dry run, where the root shape is never sampled. */
  registrySummaryOnly?: boolean
  registryWriteUrl?: string
}

interface RegistryRootShape { registrySummaryOnly?: boolean; registryWriteUrl?: string }

async function readLifecycleFingerprint(
  db: Queryable, repo: Repo, landscapeId: string, versionId: string, withRootShape: boolean,
): Promise<LifecycleFingerprint> {
  const { rows } = await db.query<{ root_url: string | null; source: string | null }>(
    `SELECT
       (SELECT root_url FROM versions
         WHERE landscape_id = $1 AND id = $2) AS root_url,
       (SELECT source FROM read_model_static_workspaces
         WHERE landscape_id = $1 AND version_id = $2) AS source`,
    [landscapeId, versionId],
  )
  const rootUrl = rows[0]?.root_url ?? undefined
  const fingerprint: LifecycleFingerprint = { rootUrl, staticSource: rows[0]?.source ?? null }
  if (!withRootShape || !rootUrl || !isValidAutomergeUrl(rootUrl)) return fingerprint
  const root = (await findReadyDocument<RegistryRootShape>(repo, rootUrl)).doc()
  return {
    ...fingerprint,
    registrySummaryOnly: root?.registrySummaryOnly === true,
    registryWriteUrl: root?.registryWriteUrl,
  }
}

/**
 * Re-run, UNDER THE LOCK, every check the entry point ran on a snapshot — and
 * refuse the apply if any of them moved.
 *
 * This is the whole point of the lock, and without it the lock would be worth
 * much less than it looks. `repairReferenceIntegrity`'s two refusal guards are
 * evaluated once, at the top; between them and the first `deleteDiagramDoc`
 * come a SQL scan, an optional per-diagram document walk and the planner. A
 * promotion that starts one millisecond after the guards pass is invisible to
 * every one of them, and the actions it invalidates are the destructive ones:
 * `strip-composition` over every diagram, `drop-registry-entry`, and the layout
 * keys.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH. The re-read does NOT make the guards
 * an invariant at the instant of the write: the verdict holds at the instant
 * the LOCK IS TAKEN, and stays true for the duration only against writers that
 * need the same key.
 *
 *  - Against the three lifecycle doors, it IS an invariant for the whole apply:
 *    they cannot start without the key we are holding.
 *  - Against a lifecycle transition that COMPLETED during the evidence
 *    gathering, it is a detection — which is the case the lock alone misses,
 *    since a promotion may have committed and released before we asked.
 *  - Against everything else, it is still a snapshot. `degraded_since` is
 *    written by the projector (`readModel/health.ts`, driven by
 *    `projectorService.ts`), which takes no lifecycle lock, so a workspace can
 *    degrade mid-apply and nothing here sees it — which is why the apply also
 *    re-reads it on the way OUT and reports `degradedDuringApply`.
 *
 *    `versions.root_url` is NOT in this bullet: its only writer,
 *    `degenerateRootRepair.ts`, takes this same key around its rotation, so
 *    against that writer the re-read is an invariant for the whole apply.
 *
 * The remaining residue is named rather than closed. Closing it means moving
 * this door onto the maintenance coordinator.
 */
async function assertWorkspaceHeldStill(
  // A BRANDED `LockedSession`, not a `Queryable` and not the pool. Only
  // `withLifecycleApplyLock` mints one, so this function cannot be handed the
  // pool and cannot be called from outside the critical section — which is what
  // makes "the re-read happened under the lock" a property of the types rather
  // than of a test. With an unbranded parameter, passing the pool and hoisting
  // the call out of the lock would both compile.
  lockedSession: LockedSession,
  repo: Repo,
  landscapeId: string,
  versionId: string,
  before: LifecycleFingerprint,
): Promise<void> {
  const refuse = (what: string): never => {
    throw new LifecycleApplyRefusedError(
      'workspace-moved',
      `workspace ${landscapeId}/${versionId} changed while the repair was gathering evidence: ${what}. `
      + 'Nothing was written. Re-run the report — the plans it produced describe a workspace that no '
      + 'longer exists in that shape.',
    )
  }
  // POSSESSION BEFORE EVIDENCE, and it is the first statement on purpose.
  //
  // The brand on `lockedSession` proves this call sits inside the wrapper; it
  // cannot prove the backend behind it holds anything: a cast could substitute
  // another connection (the reads return the same values), and a session
  // killed mid-apply ends the exclusion in silence. Asking Postgres closes both:
  // a substituted connection is a different `pg_backend_pid()` and answers
  // false, and so does a backend whose session has already died.
  //
  // Everything below this line reads state in order to DECIDE WHETHER TO WRITE.
  // Reading it on a connection that holds nothing produces a verdict about a
  // workspace nobody is excluding, which is worse than no verdict — so the
  // order is not stylistic.
  if (!await sessionHoldsLifecycleLock(lockedSession, { landscapeId, versionId })) {
    throw new LifecycleApplyRefusedError(
      'exclusion-unproven',
      `the session about to repair ${landscapeId}/${versionId} could not prove it holds the apply `
      + 'lock. NOTHING was written. Either its backend died since the lock was taken, or this '
      + 'check is running on a connection that is not the one holding the key.',
    )
  }
  const redirect = await readModelRedirectBaseVersion(lockedSession, { landscapeId, versionId })
  if (redirect) refuse(`it now reads its read model from version ${redirect} (sparse draft)`)
  const untrustworthy = await readModelUntrustworthyReason(lockedSession, { landscapeId, versionId })
  if (untrustworthy) refuse(`its read model is no longer trustworthy (${untrustworthy})`)
  const now = await readLifecycleFingerprint(lockedSession, repo, landscapeId, versionId, true)
  if (now.rootUrl !== before.rootUrl) {
    refuse(`versions.root_url moved from ${before.rootUrl ?? 'none'} to ${now.rootUrl ?? 'none'}`)
  }
  if (now.staticSource !== before.staticSource) {
    refuse(
      `read_model_static_workspaces.source moved from ${before.staticSource ?? 'none'} to `
      + `${now.staticSource ?? 'none'} — a promotion or a demotion completed under this run`,
    )
  }
  // The two the flag repair moves and the SQL pair does not. Named separately
  // in the message because "the root's summary contract changed" and "the
  // static row changed" send an operator to different places.
  if (now.registrySummaryOnly !== before.registrySummaryOnly) {
    refuse(
      `the root's registrySummaryOnly moved from ${String(before.registrySummaryOnly)} to `
      + `${String(now.registrySummaryOnly)} — a summary-flag repair, a promotion or a demotion `
      + 'completed under this run',
    )
  }
  if (now.registryWriteUrl !== before.registryWriteUrl) {
    refuse(
      `the root's registryWriteUrl moved from ${before.registryWriteUrl ?? 'none'} to `
      + `${now.registryWriteUrl ?? 'none'} — the workspace now writes its registry somewhere else `
      + 'than where these plans were read from',
    )
  }
}

export async function repairReferenceIntegrity(
  // A `Pool` and not a `Queryable`: the apply path takes the
  // lifecycle apply lock, which needs a connection it can PIN for the whole
  // critical section — a session advisory lock taken on a borrowed-and-returned
  // client is handed to whatever query borrows that connection next. Narrowing
  // the parameter is what makes "apply without the lock" unrepresentable rather
  // than merely discouraged. The dry run does not need the lock and does not
  // take it.
  db: Pool,
  repo: Repo,
  options: ReferenceRepairOptions,
): Promise<ReferenceRepairResult> {
  const { landscapeId, versionId } = options
  // REFUSE a workspace whose read model is a redirect, before reading anything.
  //
  // A sparse draft registers `base_version_id = <parent>`, so its `ro_*` rows
  // live under the PARENT's version_id. Every check here resolves referrers from
  // the draft's documents against targets queried by the draft's own id — which
  // returns nothing — so the entire draft reads as dangling and an apply would
  // strip its compositions, group members, layout keys and ADR links.
  //
  // The SQL leg is not exempt: it produces the same false findings without ever
  // opening a document, so gating only the walk would not help. Refusing here
  // covers the dry run and the apply, which are the console's two entry points.
  const redirect = await readModelRedirectBaseVersion(db, { landscapeId, versionId })
  if (redirect) {
    throw new Error(
      `workspace ${landscapeId}/${versionId} reads its read model from version ${redirect} `
      + '(sparse draft) — its references cannot be resolved here, so this refuses rather than '
      + 'report every reference in the draft as dangling',
    )
  }
  // REFUSE a workspace whose read model cannot currently be trusted as ground
  // truth, for the same reason and with the same blast radius as the redirect
  // above. See `readModelUntrustworthyReason` for the two states that produce
  // it; the short version is that a projection which completed WITH HOLES, or a
  // workspace that was never projected, makes `ro_*` legitimately incomplete —
  // and every check here reads an absent target as a deleted one. Since
  // `diagram.objectIds`, `diagram.connectionIds` and `group.objectIds` are all
  // `safeToApply: true`, an apply would strip those ids from every diagram and
  // delete their saved layout positions.
  const untrustworthy = await readModelUntrustworthyReason(db, { landscapeId, versionId })
  if (untrustworthy) {
    throw new Error(
      `workspace ${landscapeId}/${versionId} cannot be checked right now: ${untrustworthy}. `
      + 'Its read model is incomplete for a known reason, so every reference in it would read '
      + 'as dangling — this refuses rather than propose deletions from a partial projection.',
    )
  }
  // Sample the lifecycle witnesses BEFORE the first byte of evidence is read,
  // so the fingerprint covers the whole evidence window and not just the part
  // after the scan. Compared again under the apply lock — see
  // `assertWorkspaceHeldStill`.
  const fingerprint = await readLifecycleFingerprint(
    db, repo, landscapeId, versionId, options.apply === true,
  )
  await options.onStep?.('fingerprint-taken')
  const report = await scanReferenceIntegrity(db, { landscapeId, versionId, limit: options.limit })
  // The root is needed to WALK as well as to write, so resolve it once. A dry run
  // over SQL alone still works without it — see the guard further down.
  const rootUrl = fingerprint.rootUrl
  let truncated = report.truncated
  const findings = [...report.findings]
  if (options.documents) {
    if (!rootUrl) throw new Error(`no root document for workspace ${landscapeId}/${versionId}`)
    // `limit` REACHES THE WALK, and it has to. `apply-too-large` tells the
    // operator to re-run with a smaller `limit`; before this line that advice
    // was false for walk findings, which are bounded by `maxDiagrams` and a
    // deadline and by nothing the caller passes. A workspace with enough
    // dangling layout keys could therefore be refused permanently with a
    // remedy that could not change the count — a 400 with no way out.
    //
    // The two quantities are NOT the same thing and the conflation is stated
    // rather than hidden: `limit` is findings-per-kind on the SQL leg and
    // diagrams-walked here. What matters for the remedy is only that lowering
    // it lowers both legs monotonically, which it does.
    const walk = await scanDocumentReferences(db, repo, rootUrl, {
      landscapeId,
      versionId,
      ...(options.limit === undefined ? {} : { maxDiagrams: options.limit }),
    })
    findings.push(...walk.findings)
    truncated = truncated || walk.truncated
  }
  const plans = findings.map(planReferenceRepair)
  await enrichRegistryEntryPlans(db, plans)
  // Needs the root, so it only runs where one resolves; a dry run on a workspace
  // with no root still works, it just cannot promote ADR-link plans.
  //
  // An incomplete walk is REPORTED, not swallowed: `truncated` is what tells the
  // console that "no findings promoted" may mean "could not look", and every
  // affected plan already carries its own `pending:` reason.
  if (rootUrl) {
    const coverage = await enrichDecisionRecordLinkPlans(repo, rootUrl, plans)
    truncated = truncated || !coverage.complete
  }
  const actionable = plans.filter((plan) => plan.safeToApply)

  const base = {
    landscapeId,
    versionId,
    plans,
    skipped: plans.length - actionable.length,
    truncated,
  }
  if (!options.apply || actionable.length === 0) {
    return { ...base, reportOnly: !options.apply, applied: 0 }
  }

  // Refuse rather than repair a workspace we cannot name. A missing root means
  // the scan's findings and the documents we would write are not provably the
  // same workspace, and a repair on the wrong one is unrecoverable.
  if (!rootUrl) throw new Error(`no root document for workspace ${landscapeId}/${versionId}`)

  // ── THE LIFECYCLE APPLY LOCK ──────────────────────────────────────────────
  //
  // The same key the promotion, the demotion and the flag repair take, on
  // purpose: those three and this one mutate the SAME workspace's documents,
  // and two locks that cannot see each other would let every door report mutual
  // exclusion while providing none. (Run from the maintenance coordinator, this
  // door would get per-workspace exclusion for free; it is wired as a request
  // handler, hence the explicit lock.)
  //
  // ONLY THE APPLY. The dry run stays available while a promotion is running,
  // because a report is exactly what an operator reads when a promotion looks
  // stuck — and it writes nothing, so it has nothing to exclude.
  //
  // AFTER the planning and the early return, so a run with nothing actionable
  // never asks for the door. Note the consequence for any test of this refusal:
  // an empty `actionable` returns `applied: 0` WITHOUT touching the lock, which
  // is indistinguishable from a successful no-op. A refusal test must therefore
  // assert the thrown `LifecycleApplyRefusedError` and carry a control proving
  // the fixture really had something to apply.
  // A BOUND ON HOW MUCH WORK ONE HELD-LOCK WINDOW MAY CONTAIN.
  //
  // `options.limit` bounds the SQL SCAN and the walk's per-diagram cap; it does
  // not bound the group findings, so this is what bounds the apply. The four
  // sibling doors do not HANG behind it —
  // `pg_try_advisory_lock` refuses immediately — but they are refused for the
  // whole duration, and a refusal after 40 s of neighbourly work is
  // indistinguishable from one after 200 ms.
  //
  // TAKEN BEFORE THE LOCK, which is the only place a bound can be honest: a
  // ceiling checked DURING the apply could only abandon a half-applied plan
  // set, and there is no rollback across Automerge documents. A neighbour
  // holding the key is what discriminates the two orderings in the test — a
  // bound taken inside would answer `lock-unavailable` instead.
  const withinBound = actionable.slice(0, MAX_ACTIONABLE_PER_APPLY)
  const deferred = actionable.length - withinBound.length
  await options.onStep?.('planned')
  const startedAt = Date.now()
  const outcome = await withLifecycleApplyLock(db, { landscapeId, versionId }, async (lockedSession) => {
    await assertWorkspaceHeldStill(lockedSession, repo, landscapeId, versionId, fingerprint)
    const applied = await applyRepairPlans(repo, rootUrl, withinBound)
    await options.onStep?.('applied')
    // THE EXIT HEALTH CHECK, on the carrying session. `assertWorkspaceHeldStill`
    // asks this same question on the way IN, where it is a refusal; here it is a
    // report, because the writes have already landed and there is nothing to
    // refuse. It closes the residue that said the re-read is a snapshot against
    // anything that does not take this key: `degraded_since` is written by the
    // projector, which takes no lifecycle lock, so a workspace can go degraded
    // in the middle of an apply and every check above it would still say yes.
    const degradedDuringApply = await readModelUntrustworthyReason(
      lockedSession, { landscapeId, versionId },
    )
    return { applied, degradedDuringApply }
  })
  if (!outcome.granted) {
    throw new LifecycleApplyRefusedError(
      'lock-unavailable',
      `another lifecycle operation on workspace ${landscapeId}/${versionId} (a promotion, a demotion `
      + 'or a summary-flag repair) holds the apply lock. NOTHING was written. Re-run once it finishes '
      + '— the findings this run planned were read before it started, so applying them now would '
      + 'delete ids from a registry that operation is in the middle of rewriting.',
    )
  }
  const { applied, degradedDuringApply } = outcome.value
  const heldForMs = Date.now() - startedAt
  const applyIntegrity: ReferenceApplyIntegrity = {
    exclusionProven: outcome.exclusionProven,
    degradedDuringApply,
    heldForMs,
  }
  // LOUD, and only when there is something to be loud about. Each of these
  // three says the apply ran but its guarantees did not hold for all of it —
  // the state the operator has to know about before they trust `applied`.
  if (!applyIntegrity.exclusionProven) {
    console.error(
      `[reference-integrity] ${landscapeId}/${versionId}: applied ${applied} finding(s) but the `
      + 'apply lock could NOT be witnessed at the end of the critical section. Run fsck.',
    )
  }
  if (degradedDuringApply) {
    console.error(
      `[reference-integrity] ${landscapeId}/${versionId}: the read model went untrustworthy DURING `
      + `the apply (${degradedDuringApply}). The ${applied} repair(s) were planned against evidence `
      + 'that had stopped being ground truth. Run fsck.',
    )
  }
  if (heldForMs > LOCK_HOLD_SOFT_CEILING_MS) {
    // A DETECTOR, NOT A CEILING, and the word matters: nothing here interrupts
    // anything. `MAX_ACTIONABLE_PER_APPLY` above is the actual bound; this line
    // only reports when that bound turned out to be too generous for a real
    // workspace, which is the measurement needed to lower it.
    console.warn(
      `[reference-integrity] ${landscapeId}/${versionId}: held the workspace apply lock for `
      + `${heldForMs} ms over ${withinBound.length} finding(s), above the ${LOCK_HOLD_SOFT_CEILING_MS} ms `
      + 'soft ceiling. Every sibling lifecycle door was refused for that whole window.',
    )
  }
  if (deferred > 0) {
    // NOT an error, and not silent either. `truncated` is the field the console
    // already reads as "this is not the whole story", which is exactly what a
    // bounded slice leaves behind.
    console.warn(
      `[reference-integrity] ${landscapeId}/${versionId}: applied ${applied} of ${actionable.length} `
      + `actionable finding(s); ${deferred} deferred to keep one held-lock window under `
      + `${MAX_ACTIONABLE_PER_APPLY}. Re-run to continue — the repair is incremental.`,
    )
  }
  return {
    ...base,
    reportOnly: false,
    applied,
    skipped: plans.length - applied,
    truncated: base.truncated || deferred > 0,
    applyIntegrity,
  }
}

/**
 * Every mutation, and nothing else — extracted so the critical section is one
 * expression at the call site and the lock cannot be bypassed by an early
 * return added later inside it.
 *
 * Returns the number of findings actually repaired, counted from EFFECTS.
 */
async function applyRepairPlans(
  repo: Repo,
  rootUrl: string,
  actionable: ReferenceRepairPlan[],
): Promise<number> {
  // Every document this apply CHANGES, so the flush below can name them.
  const touched = new Set<DocumentId>()
  const strip = [...new Set(
    actionable.filter((p) => p.action === 'strip-composition').map((p) => p.finding.targetId),
  )]
  if (strip.length > 0) await stripIdsFromAllDiagrams(repo, rootUrl, strip, touched)

  const clearParent = [...new Set(
    actionable.filter((p) => p.action === 'clear-parent-object').map((p) => p.finding.sourceId),
  )]
  for (const diagramId of clearParent) {
    // `settings.parentObjectId = null` deletes the key and syncs the registry
    // stub, so the diagram stops being a drill-down in BOTH places.
    await updateDiagramDoc(repo, rootUrl, diagramId, { settings: { parentObjectId: null } }, touched)
  }

  const clearGroupParent = new Set(
    actionable.filter((p) => p.action === 'clear-group-parent').map((p) => p.finding.sourceId),
  )
  const dropMembers = new Map<string, Set<string>>()
  for (const plan of actionable) {
    if (plan.action !== 'drop-group-member') continue
    const drop = dropMembers.get(plan.finding.sourceId) ?? new Set<string>()
    drop.add(plan.finding.targetId)
    dropMembers.set(plan.finding.sourceId, drop)
  }
  await repairGroupReferences(repo, rootUrl, clearGroupParent, dropMembers, touched)

  const layoutKeys = new Map<string, Map<string, Set<string>>>()
  for (const plan of actionable) {
    if (plan.action !== 'drop-layout-key') continue
    const byLayer = layoutKeys.get(plan.finding.sourceId) ?? new Map<string, Set<string>>()
    // `field` carries the layer the walk found it in: `layouts` or `layouts3d`.
    const layer = plan.finding.field === 'layouts3d' ? 'layouts3d' : 'layouts'
    const keys = byLayer.get(layer) ?? new Set<string>()
    keys.add(plan.finding.targetId)
    byLayer.set(layer, keys)
    layoutKeys.set(plan.finding.sourceId, byLayer)
  }
  await repairLayoutKeys(repo, rootUrl, layoutKeys, touched)

  const dropEntries = [...new Set(
    actionable.filter((p) => p.action === 'drop-registry-entry').map((p) => p.finding.sourceId),
  )]
  for (const diagramId of dropEntries) {
    // Removes the stub from whichever registry shard holds it. The DiagramDoc it
    // named is already absent from storage — that is the precondition.
    await deleteDiagramDoc(repo, rootUrl, diagramId, touched)
  }

  const linkPlans = actionable.filter((p) => p.action === 'strip-adr-link')
  let linkRemovals = 0
  if (linkPlans.length > 0) {
    // DEDUPE FIRST. The scan is a `CROSS JOIN LATERAL jsonb_array_elements` with
    // no DISTINCT, so one ADR carrying the same dead target twice yields two
    // findings — and `removeDecisionRecordLinks` strips BOTH on the first pass,
    // tail-first, by design. Sent as two removals, the second reports
    // `not-found` and one genuinely-repaired finding gets counted as `skipped`,
    // i.e. reported to the operator as "deliberately left alone".
    const byKey = new Map<string, { removal: AdrLinkRemoval; plans: ReferenceRepairPlan[] }>()
    for (const plan of linkPlans) {
      const types = linkTypesForKind(plan.finding.kind)
      const key = `${plan.finding.sourceId} | ${plan.finding.targetId} | ${types.join(',')}`
      const entry = byKey.get(key)
      if (entry) entry.plans.push(plan)
      else byKey.set(key, { removal: { adrId: plan.finding.sourceId, targetId: plan.finding.targetId, types }, plans: [plan] })
    }
    const grouped = [...byKey.values()]
    const outcomes = await repairDecisionRecordLinks(repo, rootUrl, grouped.map((entry) => entry.removal), touched)
    // Count EFFECTS, not intentions: reporting the plan count is exactly how a
    // repair in this module already claimed success while changing nothing.
    outcomes.forEach((result, index) => {
      // Positional pairing holds only because `removeDecisionRecordLinks` pushes
      // exactly one result per removal on EVERY branch. Check it rather than
      // trust it: a mismatch drops to uncounted, which under-reports `applied`
      // — the safe direction — instead of attributing a removal to the wrong ADR.
      const entry = grouped[index]
      if (!entry || entry.removal.adrId !== result.adrId || entry.removal.targetId !== result.targetId) return
      const outcome = result.outcome === 'removed' ? `removed:${result.removed}` : result.outcome
      for (const plan of entry.plans) {
        plan.outcome = outcome
        if (result.outcome === 'removed') linkRemovals++
      }
    })
  }

  // Durability before the caller is told it worked. The save debounce is long in
  // some deployments, so returning without this would report a repair that a
  // crash could still lose.
  //
  // SCOPED, because this call is inside the workspace's apply lock.
  // `repo.flush()` with no argument waits on EVERY document resident in the
  // process, including other workspaces' and documents this repair never
  // opened, while the sibling doors are refused for its whole duration.
  //
  // THE RISK RUNS ONE WAY, so the completeness of `touched` is not left to
  // inspection: a document that changed and is NOT named here is reported as
  // durable while living only in memory, which a crash then loses. Every helper
  // above adds what it changes, and `referenceIntegrityRepair.test.ts` diffs
  // document HEADS across an apply and fails when anything changed that this
  // set does not name.
  //
  // An empty set means nothing was changed — `flush([])` rather than `flush()`
  // is deliberate, since the no-argument form would then wait on the whole
  // process for a run that wrote nothing.
  await repo.flush([...touched])

  // Every other action is unconditional once planned; only the ADR-link strip
  // can plan safely and then find nothing to remove.
  return actionable.length - linkPlans.length + linkRemovals
}
