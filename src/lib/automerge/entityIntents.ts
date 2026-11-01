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

import type { C4Object, Comment, Connection, DecisionRecord, Diagram, Domain, Flow, Group, Tag } from '../../types'
import type { KvStore } from '../modelQuery/kvStore'
import { adoptTabJournalNamespace } from './tabJournalAdoption'
import { stripUndefined } from './docSafe'
import { startClientTimelineMeasure } from '../observability/clientTimeline'

/**
 * Crash-recovery journal for ENTITY edits under boot-from-server — the mirror of
 * `PendingPlacementIntents`, one durability stage earlier.
 *
 * Between a keystroke and `writeEditsShards`, an object/connection edit lives only
 * in the in-memory `editsObjects`/`editsConnections` maps; and when the overlay
 * write head is missing or unresolved, that window is UNBOUNDED — the flush bails,
 * `ensureOverlayHandles`' catch swallows the failure, and a closed tab silently
 * loses the edit while the badge reads "Synced". This journal records the
 * INTENT (the last absolute state the user asked for, plus the baseline it was
 * edited from) in IndexedDB at capture time, and only forgets it once the edit is
 * provably durable in the local Automerge document (`repo.flush([documentId])`
 * resolved — the exact contract `acknowledgePlacementSnapshot` already uses).
 *
 * Replay decisions:
 * - "Accomplished" is detected by BATCH ID, not by value: `writeEditsShards`
 *   already pushes its batchId into `doc.writeBatchIds`; an intent stamped with a
 *   batchId the shard carries WAS written, so it is acknowledged without
 *   comparing values — the lastMutationID pattern (Replicache), which the
 *   half-journal `overlayBatchJournal` uses on the server leg for the same
 *   reason. Value equality is only the fallback for a crash that lost the stamp.
 * - Replay is a per-FIELD three-way merge (snapshot vs baseline onto the current
 *   value), not a whole-entity re-assert: a colleague's concurrent edit to a
 *   field the local user never touched survives the replay (the ps_crud PATCH
 *   semantics; a whole-snapshot reconcile would clobber it).
 * - The journal is per-TAB on disk (own key per tab + a small registry key):
 *   a sibling tab persisting its own — possibly empty — journal must never
 *   overwrite or delete the intents of the tab that still needs them.
 * - The journal never creates durable structure (no heads, no documents). With
 *   no write head it simply keeps holding the intent, bounded by latest-wins
 *   per entity, and the sync badge counts it so the UI cannot claim `ready`.
 */

/**
 * The four SMALL-COLLECTION families — inline maps on ModelMeta,
 * written whole by `writeSmallCollections`. One carrier, one flush point, and
 * the same witness in BOTH replay modes: the materialized ModelMeta document
 * itself (which is why, unlike objects/connections, their replay consults no
 * server endpoint and no batch ids — ModelMeta has no `writeBatchIds`, and
 * does not need one: the map IS the durable truth).
 *
 * `tagSnapshot` intents are keyed by `tag.tagId` (the canonical catalog id,
 * the same key `writeSmallCollections` uses for the ModelMeta map), not by
 * the local `id` field.
 */
export type SmallCollectionIntentKind = 'group' | 'domain' | 'tagSnapshot' | 'decisionRecord'

/**
 * The two DIAGRAM-COLLECTION families — id-keyed maps on each
 * per-diagram DiagramDoc (`comments`, `flows`), written whole for the ACTIVE
 * diagram by flushWrite step 3 (and once, at doc creation, by
 * `ensureDiagramDoc` for import-pushed flows). Unlike the small collections,
 * their carrier is PER DIAGRAM: an intent carries the `diagramId` of its
 * entity (upserts inside the snapshot, deletes on the intent itself), and the
 * replay/ack can only consult the carrier of the diagram that is currently
 * attached — intents for other diagrams stay journaled (badge-counted) until
 * their diagram is activated.
 */
export type DiagramCollectionIntentKind = 'comment' | 'flow'

/**
 * The diagram STUB family — the registry-facing identity of a diagram
 * (name, type, parent, view settings), whose creation/rename/delete previously
 * had no journal at all: a created diagram lived only in Zustand for the whole
 * debounce window. The snapshot is the FULL store `Diagram` value (for a
 * creation, composition and layouts included — they are what the user made),
 * but capture DIFFS only the stub fields, so composition/drag churn never
 * spams the journal.
 */
export type EntityIntentKind =
  | 'object'
  | 'connection'
  | SmallCollectionIntentKind
  | DiagramCollectionIntentKind
  | 'diagram'

export const SMALL_COLLECTION_INTENT_KINDS: readonly SmallCollectionIntentKind[] =
  ['group', 'domain', 'tagSnapshot', 'decisionRecord']

export const DIAGRAM_COLLECTION_INTENT_KINDS: readonly DiagramCollectionIntentKind[] =
  ['comment', 'flow']

/** CLOSED-world on purpose (the poison pill): with an open-world
 * `kind !== 'object' && kind !== 'connection'` test, an UNKNOWN kind — a
 * future kind hydrated by this build from a newer sibling's journal — would
 * classify as a small-collection kind, reach the small planner, throw on the
 * missing `current` map, and the catch would abort the ENTIRE replay pass: one
 * poison record permanently disabling small-collection replay. Unknown kinds
 * classify as NEITHER family and stay journaled untouched, waiting for a build
 * that knows them. */
export function isSmallCollectionKind(kind: EntityIntentKind): kind is SmallCollectionIntentKind {
  return (SMALL_COLLECTION_INTENT_KINDS as readonly string[]).includes(kind)
}

/** CLOSED world, same poison-pill rationale as `isSmallCollectionKind`. */
export function isDiagramCollectionKind(kind: EntityIntentKind): kind is DiagramCollectionIntentKind {
  return (DIAGRAM_COLLECTION_INTENT_KINDS as readonly string[]).includes(kind)
}

/** The ENTITY planner's admission — POSITIVE on purpose: under a
 * `!isSmallCollectionKind(kind)` dispatch, an unknown kind (a future family
 * hydrated from a newer sibling's journal) would fall through to the entity
 * planner, whose binary `kind === 'object' ? … : connection` would write it
 * into the CONNECTION overlay shard. Unknown kinds must be PARKED:
 * kept journaled and badge-counted, planned by nobody. */
export function isEntityPlannerKind(kind: EntityIntentKind): kind is 'object' | 'connection' {
  return kind === 'object' || kind === 'connection'
}

/** True for the kinds THIS build can plan and replay. `pending()` can hold
 * more (see the closed-world note above). */
export function isKnownIntentKind(kind: string): kind is EntityIntentKind {
  return kind === 'object' || kind === 'connection' || kind === 'diagram'
    || (SMALL_COLLECTION_INTENT_KINDS as readonly string[]).includes(kind)
    || (DIAGRAM_COLLECTION_INTENT_KINDS as readonly string[]).includes(kind)
}

/** One document that carried a SENT intent, at the heads its local flush left. */
export interface SentCarrier {
  documentId: string
  heads: string[]
}

/**
 * Why an intent is SENT rather than gone: its carrier document was flushed to
 * IndexedDB, but nothing has yet proved the SERVER holds that write.
 *
 * The local flush is what the crash journal waits for, and it is not enough to
 * forget the user's intention. A `current` tab writes into the documents of the
 * version it booted into; when the default moves to a fork while the tab is
 * offline, those documents belong to a version nobody opens any more, and the
 * reload into the new default has nothing left to replay. Measured 2026-10-31
 * (repoint-offline-create.spec.ts test 2, probe of the journals): the offline
 * diagram's creation intent was gone at the registry shard's local flush, and
 * after the reload the diagram was in neither version the user could see.
 *
 * `workspace` is the CONCRETE version the carrier belongs to
 * (`landscapeId/versionId`), null when the session could not name one. The
 * heads are the positive witness: a SENT intent is released only when the
 * server answers `durable` for exactly those heads in that workspace — never by
 * absence from the durable-heads ledger, which is one key shared by every tab
 * and which a sibling tab's ack round deletes.
 */
export interface SentMark {
  workspace: string | null
  carriers: SentCarrier[]
}

interface EntityIntentBase {
  workspaceKey: string
  /** Monotone per-journal revision; acknowledgements are `<= revision captured
   * BEFORE the durable write`, so an edit landing mid-flush survives the ack. */
  revision: number
  recordedAt: number
  id: string
  /** Present only on a SENT intent (see {@link SentMark}). */
  sent?: SentMark
  /** Put back by a repoint (`requeueSent`): the planners replay it
   * CONFLICT-AVERSE (`planCarriedUpsert`). Nothing proves it did not reach the
   * old version before the fork copied it, so where the new version differs
   * from what the user saw, the new version's value is someone else's later
   * work and wins. */
  carried?: true
  /** A baselined edit recorded while the entity's CREATION was SENT and
   * unconfirmed: the edit is a field patch for every ordinary replay, but a
   * carried replay must create the entity when the new version lacks it. */
  createIfAbsent?: true
}

export interface ObjectUpsertIntent extends EntityIntentBase {
  kind: 'object'
  op: 'upsert'
  snapshot: C4Object
  /** The last state believed durable when the edit was made (server render /
   * pre-edit hydration). Absent for a freshly created entity. Replay asserts
   * only the fields where snapshot differs from this. */
  baseline?: C4Object
  /** Set when writeEditsShards expressed this intent in a durable write; the
   * batchId also lands in the shard's `writeBatchIds`, which is what replay
   * checks to declare the intent accomplished. */
  writtenInBatchId?: string
}

export interface ConnectionUpsertIntent extends EntityIntentBase {
  kind: 'connection'
  op: 'upsert'
  snapshot: Connection
  baseline?: Connection
  writtenInBatchId?: string
}

export interface GroupUpsertIntent extends EntityIntentBase {
  kind: 'group'
  op: 'upsert'
  snapshot: Group
  baseline?: Group
  writtenInBatchId?: string
}

export interface DomainUpsertIntent extends EntityIntentBase {
  kind: 'domain'
  op: 'upsert'
  snapshot: Domain
  baseline?: Domain
  writtenInBatchId?: string
}

export interface TagSnapshotUpsertIntent extends EntityIntentBase {
  kind: 'tagSnapshot'
  op: 'upsert'
  snapshot: Tag
  baseline?: Tag
  writtenInBatchId?: string
}

export interface DecisionRecordUpsertIntent extends EntityIntentBase {
  kind: 'decisionRecord'
  op: 'upsert'
  snapshot: DecisionRecord
  baseline?: DecisionRecord
  writtenInBatchId?: string
}

export interface CommentUpsertIntent extends EntityIntentBase {
  kind: 'comment'
  op: 'upsert'
  /** Carries `diagramId` — the carrier document's identity. */
  snapshot: Comment
  baseline?: Comment
  writtenInBatchId?: string
}

export interface FlowUpsertIntent extends EntityIntentBase {
  kind: 'flow'
  op: 'upsert'
  snapshot: Flow
  baseline?: Flow
  writtenInBatchId?: string
}

export interface DiagramUpsertIntent extends EntityIntentBase {
  kind: 'diagram'
  op: 'upsert'
  /** The full store value (composition/layouts included — for a CREATION they
   * are what the user made and the doc is seeded from them). Edits still
   * replay per-field via the merge, so an old composition in the snapshot
   * never clobbers: it deep-equals the baseline's and is skipped. */
  snapshot: Diagram
  baseline?: Diagram
  writtenInBatchId?: string
}

export interface EntityDeleteIntent extends EntityIntentBase {
  kind: EntityIntentKind
  op: 'delete'
  /** For diagram-collection kinds only: which DiagramDoc carried the entity —
   * the id alone cannot name the carrier to delete from. */
  diagramId?: string
  writtenInBatchId?: string
}

export type SerializedEntityIntent =
  | ObjectUpsertIntent
  | ConnectionUpsertIntent
  | GroupUpsertIntent
  | DomainUpsertIntent
  | TagSnapshotUpsertIntent
  | DecisionRecordUpsertIntent
  | CommentUpsertIntent
  | FlowUpsertIntent
  | DiagramUpsertIntent
  | EntityDeleteIntent

/** v4: the journal carries the diagram-scoped kinds ('comment' | 'flow' |
 * 'diagram'), and a v3-era build hydrating them would mis-dispatch — its
 * entity-replay filter is the negative `!isSmallCollectionKind(kind)`, so a
 * hydrated 'flow' upsert would be planned as a CONNECTION and written into the
 * connection overlay shard (the same reason v3 exists: v2's binary planner vs
 * 'group'). Old builds read only their own namespace, so v4 journals are
 * invisible to them; new builds ADOPT leftover v3 and v2 journals at hydration
 * exactly like a crashed sibling tab's. This build also PARKS unknown kinds
 * (isEntityPlannerKind / the closed-world family guards), so the next family
 * may not need a v5. */
const STORAGE_PREFIX = 'pending-entity-intents:v4'
const LEGACY_STORAGE_PREFIXES = ['pending-entity-intents:v3', 'pending-entity-intents:v2'] as const
const REGISTRY_KEY = `${STORAGE_PREFIX}:tabs`
const tabStorageKey = (tabId: string) => `${STORAGE_PREFIX}:tab:${tabId}`
/** Above this many pending intents, each persist is a multi-hundred-kB write —
 * survivable, but a signal the producer (bulk import?) should not run through
 * the journal. Logged, never truncated: a silently capped journal would be a
 * recovery mechanism that lies about what it can recover. */
export const ENTITY_INTENT_SOFT_CAP = 1_000

/** One id per page load. A reload gets a NEW id, so the previous load's key is
 * adopted through the registry like any crashed tab's. */
export const entityIntentTabId: string =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

function intentKey(kind: EntityIntentKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * Plain-JSON deep equality, key-order insensitive. Both sides are expected to be
 * `stripUndefined`-normalized (the journal normalizes at serialization, the
 * Automerge write path normalizes at `changeAndTrack` time), so `undefined`
 * fields never produce a spurious inequality that would re-write an already
 * durable value on every boot.
 */
export function deepEqualPlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqualPlain(item, b[index]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every((key) => key in right && deepEqualPlain(left[key], right[key]))
  }
  return false
}

/** Cross-tab ordering: revisions from different tabs are incomparable counters,
 * so recency is decided by wall clock first, revision as the same-tab tiebreak. */
function newerThan(a: SerializedEntityIntent, b: SerializedEntityIntent): boolean {
  if (a.recordedAt !== b.recordedAt) return a.recordedAt > b.recordedAt
  return a.revision > b.revision
}

export function cloneSentMark(mark: SentMark): SentMark {
  return {
    workspace: mark.workspace,
    carriers: mark.carriers.map((carrier) => ({ documentId: carrier.documentId, heads: [...carrier.heads] })),
  }
}

function cloneIntent(source: SerializedEntityIntent): SerializedEntityIntent {
  const sent = source.sent ? { sent: cloneSentMark(source.sent) } : {}
  if (source.op === 'delete') return { ...source, ...sent }
  return {
    ...source,
    snapshot: stripUndefined(source.snapshot),
    ...(source.baseline !== undefined ? { baseline: stripUndefined(source.baseline) } : {}),
    ...sent,
  } as SerializedEntityIntent
}

/** A persisted SENT mark is browser storage, so it is checked before it is trusted. */
export function isSentMark(value: unknown): value is SentMark {
  if (!value || typeof value !== 'object') return false
  const { workspace, carriers } = value as Partial<SentMark>
  return (workspace === null || typeof workspace === 'string')
    && Array.isArray(carriers)
    && carriers.every((carrier) => carrier
      && typeof carrier.documentId === 'string'
      && Array.isArray(carrier.heads)
      && carrier.heads.every((head) => typeof head === 'string'))
}

function isCreation(record: SerializedEntityIntent | undefined): boolean {
  return record?.op === 'upsert' && record.baseline === undefined
}

/**
 * Latest-wins per `kind:id`; a delete replaces a pending upsert and vice versa.
 *
 * Two stages. PENDING is what the crash journal always was: an intention not
 * yet in its carrier's local flush, replayed at boot. SENT is an intention whose
 * carrier was flushed locally but which no server has acknowledged yet (see
 * {@link SentMark}): it is not replayed, not counted, not a debt — it is kept
 * only so that a repoint can put it back ({@link requeueSent}).
 */
export class PendingEntityIntents {
  private revision = 0
  private readonly byWorkspace = new Map<string, Map<string, SerializedEntityIntent>>()
  private readonly sentByWorkspace = new Map<string, Map<string, SerializedEntityIntent>>()
  /** When each SENT intent was marked, on a per-page counter (`sentSequenceNow`);
   * one hydrated from disk was marked in an earlier page, i.e. before every
   * request this page makes, and reads 0. A release round may release only
   * what was marked before it asked: an intent marked during the round has
   * heads the round never asked about (reviewer lens, 2026-10-31). */
  private sentSequence = 0
  private readonly sentAt = new Map<string, number>()

  /** The high-water revision. Capture BEFORE the durable write; acknowledge
   * through it AFTER, so anything recorded mid-flight keeps its intent. */
  get revisionNow(): number {
    return this.revision
  }

  recordUpsert(
    workspaceKey: string,
    kind: 'object',
    id: string,
    snapshot: C4Object,
    baseline?: C4Object,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'connection',
    id: string,
    snapshot: Connection,
    baseline?: Connection,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'group',
    id: string,
    snapshot: Group,
    baseline?: Group,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'domain',
    id: string,
    snapshot: Domain,
    baseline?: Domain,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'tagSnapshot',
    id: string,
    snapshot: Tag,
    baseline?: Tag,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'decisionRecord',
    id: string,
    snapshot: DecisionRecord,
    baseline?: DecisionRecord,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'comment',
    id: string,
    snapshot: Comment,
    baseline?: Comment,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'flow',
    id: string,
    snapshot: Flow,
    baseline?: Flow,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: 'diagram',
    id: string,
    snapshot: Diagram,
    baseline?: Diagram,
  ): number
  /** Variable-kind overloads for the capture layers, which iterate kinds
   * generically (the literal overloads above cannot be called with a variable
   * kind, and a cast-through wrapper would defeat the safety it claims). */
  recordUpsert(
    workspaceKey: string,
    kind: SmallCollectionIntentKind,
    id: string,
    snapshot: Group | Domain | Tag | DecisionRecord,
    baseline?: Group | Domain | Tag | DecisionRecord,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: DiagramCollectionIntentKind,
    id: string,
    snapshot: Comment | Flow,
    baseline?: Comment | Flow,
  ): number
  recordUpsert(
    workspaceKey: string,
    kind: EntityIntentKind,
    id: string,
    snapshot: C4Object | Connection | Group | Domain | Tag | DecisionRecord | Comment | Flow | Diagram,
    baseline?: C4Object | Connection | Group | Domain | Tag | DecisionRecord | Comment | Flow | Diagram,
  ): number {
    const revision = ++this.revision
    const key = intentKey(kind, id)
    // A baselined edit over a SENT creation still owes that creation. The
    // record below supersedes it, and as a plain field patch a repoint would
    // replay a patch for an entity the new version never had — which the
    // planners read as "deleted since" and drop. The capture layers ask
    // `pendingCreation`, which covers SENT, but the object/connection capture
    // takes its baseline from the last flush, so the rule lives here, once.
    // Kept as a FLAG beside the baseline, not by dropping the baseline: an
    // ordinary crash replay still merges only the changed fields (reviewer
    // lens, 2026-10-31: dropping it turned crash replays into whole-value
    // writes over a colleague's concurrent edit).
    const sentRecord = this.sentByWorkspace.get(workspaceKey)?.get(key)
    const createIfAbsent = baseline !== undefined && (
      isCreation(sentRecord)
      || sentRecord?.createIfAbsent === true
      || this.byWorkspace.get(workspaceKey)?.get(key)?.createIfAbsent === true
    )
    // Snapshot and baseline are held BY REF — store entities are immutable
    // (immer), so recording costs no copy; cloning happens at serialization.
    const record = {
      workspaceKey,
      revision,
      recordedAt: Date.now(),
      kind,
      op: 'upsert',
      id,
      snapshot,
      ...(baseline !== undefined ? { baseline } : {}),
      ...(createIfAbsent ? { createIfAbsent: true } : {}),
    } as SerializedEntityIntent
    this.records(workspaceKey).set(key, record)
    this.forgetSent(workspaceKey, key)
    return revision
  }

  recordDelete(
    workspaceKey: string,
    kind: EntityIntentKind,
    id: string,
    meta?: { diagramId?: string },
  ): number {
    const revision = ++this.revision
    const record: EntityDeleteIntent = {
      workspaceKey,
      revision,
      recordedAt: Date.now(),
      kind,
      op: 'delete',
      id,
      ...(meta?.diagramId !== undefined ? { diagramId: meta.diagramId } : {}),
    }
    const key = intentKey(kind, id)
    this.records(workspaceKey).set(key, record)
    this.forgetSent(workspaceKey, key)
    return revision
  }

  /**
   * Stamp intents that a durable write just EXPRESSED with that write's batchId
   * (the same id `writeEditsShards` pushes into the shard's `writeBatchIds`).
   * Only intents at `revision <= throughRevision` are stamped — a newer intent
   * for the same entity was not part of this write. Persist promptly after: the
   * stamp is only useful if it survives a crash that outruns the acknowledgement.
   */
  markWritten(
    workspaceKey: string,
    kind: EntityIntentKind,
    ids: readonly string[],
    throughRevision: number,
    batchId: string,
  ): void {
    const records = this.byWorkspace.get(workspaceKey)
    if (!records) return
    for (const id of ids) {
      const key = intentKey(kind, id)
      const record = records.get(key)
      if (record && record.revision <= throughRevision) {
        records.set(key, { ...record, writtenInBatchId: batchId })
      }
    }
  }

  hasPending(workspaceKey: string): boolean {
    return (this.byWorkspace.get(workspaceKey)?.size ?? 0) > 0
  }

  /** Whether a live intent exists for this exact entity — the leading-edge
   * persist decision: a NEW key gets an immediate IndexedDB write, only
   * re-records of an already-journaled entity may coalesce. */
  has(workspaceKey: string, kind: EntityIntentKind, id: string): boolean {
    return this.byWorkspace.get(workspaceKey)?.has(intentKey(kind, id)) ?? false
  }

  /** The pending intent's op, or null. An OP FLIP (upsert replacing a pending
   * delete, or vice versa) must persist immediately even though the key is
   * not new: until the write lands, the DISK holds the opposite op, and a
   * hard kill inside the coalescing window would replay a delete of an
   * entity the user just restored. */
  pendingOp(workspaceKey: string, kind: EntityIntentKind, id: string): 'upsert' | 'delete' | null {
    const key = intentKey(kind, id)
    return this.byWorkspace.get(workspaceKey)?.get(key)?.op
      ?? this.sentByWorkspace.get(workspaceKey)?.get(key)?.op
      ?? null
  }

  /** True while the pending intent for this entity is an UPSERT with no
   * baseline — a CREATION not yet acknowledged. A later edit of the same
   * entity must RE-RECORD AS A CREATION (full snapshot, no baseline): since
   * the journal is latest-wins per key, recording it as a baselined edit
   * would REPLACE the creation intent with a field patch whose replay only
   * asserts the newly changed fields — the entity itself would never be
   * recreated.
   *
   * A SENT creation counts, for both kinds of caller. The capture layers keep
   * re-recording the full snapshot, so a new diagram's journaled value carries
   * the composition and layouts it gained after its first flush (measured
   * 2026-10-31: the creation was acked at the registry shard's flush, BEFORE the
   * drag, with `objectIds: []`). And the create-then-delete retirements
   * (`acknowledge` below) still see a creation the server may never have had. */
  pendingCreation(workspaceKey: string, kind: EntityIntentKind, id: string): boolean {
    const key = intentKey(kind, id)
    const record = this.byWorkspace.get(workspaceKey)?.get(key)
    if (record) return isCreation(record)
    return isCreation(this.sentByWorkspace.get(workspaceKey)?.get(key))
  }

  pendingCount(workspaceKey: string): number {
    return this.byWorkspace.get(workspaceKey)?.size ?? 0
  }

  pending(workspaceKey: string): SerializedEntityIntent[] {
    return [...(this.byWorkspace.get(workspaceKey)?.values() ?? [])]
      .sort((left, right) => left.revision - right.revision)
  }

  /**
   * Forget intents outright: matching kind, id in `ids`, and revision ≤
   * `throughRevision` (captured before the write). An intent re-recorded during
   * the flight has a higher revision and survives. Op-agnostic on purpose:
   * whichever op was current at capture time is the one the write expressed.
   *
   * SENT entries go too. Every caller here has a reason that outlives the
   * server's answer — the planner found the value already held, the diagram is
   * gone, a creation was deleted before anything held it — and a SENT entry left
   * behind would come back on a repoint: a create-then-delete would resurrect.
   * A carrier's local flush is NOT such a reason; that is {@link markSent}.
   */
  acknowledge(
    workspaceKey: string,
    kind: EntityIntentKind,
    ids: readonly string[],
    throughRevision: number,
  ): void {
    const records = this.byWorkspace.get(workspaceKey)
    const sent = this.sentByWorkspace.get(workspaceKey)
    for (const id of ids) {
      const key = intentKey(kind, id)
      const record = records?.get(key)
      if (record && record.revision <= throughRevision) records!.delete(key)
      const sentRecord = sent?.get(key)
      if (sentRecord && sentRecord.revision <= throughRevision) this.forgetSent(workspaceKey, key)
    }
    if (records?.size === 0) this.byWorkspace.delete(workspaceKey)
  }

  /**
   * The carrier's LOCAL flush expressed these intents: move them to SENT, with
   * the carriers' heads and the concrete workspace they belong to. Same
   * revision rule as `acknowledge`. Returns how many moved.
   */
  markSent(
    workspaceKey: string,
    kind: EntityIntentKind,
    ids: readonly string[],
    throughRevision: number,
    mark: SentMark,
  ): number {
    const records = this.byWorkspace.get(workspaceKey)
    if (!records) return 0
    let moved = 0
    for (const id of ids) {
      const key = intentKey(kind, id)
      const record = records.get(key)
      if (!record || record.revision > throughRevision) continue
      records.delete(key)
      // A carried intent that reached a carrier of the new version is an
      // ordinary SENT one again: its replay already was conflict-averse.
      const { carried: _carried, ...uncarried } = record
      this.sentRecords(workspaceKey).set(key, { ...uncarried, sent: cloneSentMark(mark) } as SerializedEntityIntent)
      this.sentAt.set(sentKey(workspaceKey, key), ++this.sentSequence)
      moved += 1
    }
    if (records.size === 0) this.byWorkspace.delete(workspaceKey)
    return moved
  }

  /** The SENT-mark counter, for a release round to capture BEFORE it asks. */
  get sentSequenceNow(): number {
    return this.sentSequence
  }

  /** The named workspaces SENT intents are tagged with (null excluded). */
  sentWorkspaces(workspaceKey: string): string[] {
    const workspaces = new Set<string>()
    for (const record of this.sentByWorkspace.get(workspaceKey)?.values() ?? []) {
      if (typeof record.sent?.workspace === 'string') workspaces.add(record.sent.workspace)
    }
    return [...workspaces]
  }

  /** How many SENT intents wait for the server. Diagnostics only: SENT is not a
   * durability debt — the badge's witness is the durable-heads ledger. */
  sentCount(workspaceKey: string): number {
    return this.sentByWorkspace.get(workspaceKey)?.size ?? 0
  }

  /**
   * One carrier per document for the SENT intents of `workspace`: the heads of
   * its MOST RECENT capture. A carrier's heads are read after its local flush,
   * and a document's local history only grows, so the latest capture descends
   * from every earlier one — a server that holds it holds them all. (Asking with
   * the union instead would grow with the journal, and the endpoint refuses the
   * whole request past 512 heads per document or on a repeated id.)
   */
  sentCarriers(
    workspaceKey: string,
    workspace: string | null,
    throughSequence: number = Number.POSITIVE_INFINITY,
  ): SentCarrier[] {
    const latest = new Map<string, { order: [number, number]; carrier: SentCarrier }>()
    for (const [key, record] of this.sentByWorkspace.get(workspaceKey) ?? []) {
      if (!releasableIn(record, workspace)) continue
      const sequence = this.sentAt.get(sentKey(workspaceKey, key)) ?? 0
      if (sequence > throughSequence) continue
      const order: [number, number] = [sequence, record.revision]
      for (const carrier of record.sent!.carriers) {
        const held = latest.get(carrier.documentId)
        if (!held || order[0] > held.order[0] || (order[0] === held.order[0] && order[1] > held.order[1])) {
          latest.set(carrier.documentId, { order, carrier })
        }
      }
    }
    return [...latest.values()].map(({ carrier }) => ({ documentId: carrier.documentId, heads: [...carrier.heads] }))
  }

  /**
   * Retire the SENT intents of `workspace` whose every carrier the server
   * acknowledged. `durable` answers for one carrier at its recorded heads; it
   * must be a POSITIVE server answer (see {@link SentMark}). A SENT intent with
   * no carrier is released at once — there is nothing to prove, which is the
   * behaviour every intent had before this stage existed.
   *
   * `throughSequence` is `sentSequenceNow` captured BEFORE the request whose
   * answers `durable` reads: an intent marked after it carries heads the
   * request never named. A SENT intent tagged `null` (a session that could not
   * name its workspace) is releasable in any workspace — asked there, a
   * document of another version answers `durable: false`, never a false yes.
   * Returns how many were released.
   */
  releaseSent(
    workspaceKey: string,
    workspace: string | null,
    durable: (carrier: SentCarrier) => boolean,
    throughSequence: number = Number.POSITIVE_INFINITY,
  ): number {
    const records = this.sentByWorkspace.get(workspaceKey)
    if (!records) return 0
    let released = 0
    for (const [key, record] of [...records]) {
      if (!releasableIn(record, workspace)) continue
      if ((this.sentAt.get(sentKey(workspaceKey, key)) ?? 0) > throughSequence) continue
      if (!record.sent!.carriers.every(durable)) continue
      this.forgetSent(workspaceKey, key)
      released += 1
    }
    return released
  }

  /**
   * A repoint: the session now writes into `bootedWorkspace`, and every SENT
   * intent of ANOTHER named workspace was expressed only in documents nobody
   * opens any more. Put them back to PENDING, CARRIED, so the ordinary replays
   * plan them — conflict-averse — against the booted workspace's witnesses.
   * Each gets a fresh revision (an ack captured before the move must not
   * retire it) and loses its `writtenInBatchId`, which names a batch in the
   * OLD version's overlay shard. SENT intents with no workspace (`null`) are
   * left alone: nothing says they belong elsewhere. Returns the requeued
   * `kind:id` keys.
   */
  requeueSent(workspaceKey: string, bootedWorkspace: string): string[] {
    const records = this.sentByWorkspace.get(workspaceKey)
    if (!records) return []
    const requeued: string[] = []
    for (const [key, record] of [...records]) {
      const workspace = record.sent?.workspace ?? null
      if (workspace === null || workspace === bootedWorkspace) continue
      this.forgetSent(workspaceKey, key)
      const { sent: _sent, writtenInBatchId: _batch, ...rest } = record
      this.records(workspaceKey).set(key, { ...rest, carried: true, revision: ++this.revision } as SerializedEntityIntent)
      requeued.push(key)
    }
    return requeued
  }

  serialize(workspaceKey: string): SerializedEntityIntent[] {
    // stripUndefined both deep-copies (the live ref must not be shared with
    // IndexedDB's structured clone) and normalizes to exactly what the Automerge
    // write path persists — so a hydrated snapshot compares equal to the doc
    // value it produced. SENT intents ride in the same array, marked.
    const sent = [...(this.sentByWorkspace.get(workspaceKey)?.values() ?? [])]
      .sort((left, right) => left.revision - right.revision)
    return [...this.pending(workspaceKey), ...sent].map(cloneIntent)
  }

  hydrate(
    workspaceKey: string,
    serialized: readonly SerializedEntityIntent[] | undefined,
  ): void {
    if (!serialized?.length) return
    for (const source of serialized) {
      if (source.workspaceKey !== workspaceKey) continue
      const key = intentKey(source.kind, source.id)
      // A key lives in ONE stage. Never let a stale entry (own disk state, or an
      // adopted sibling tab's) clobber a NEWER one already held in either.
      const existing = this.byWorkspace.get(workspaceKey)?.get(key)
        ?? this.sentByWorkspace.get(workspaceKey)?.get(key)
      if (existing && !newerThan(source, existing)) continue
      // Checked BEFORE the clone, which would throw on it and abort the whole
      // adoption. A malformed mark cannot be released or requeued: keep the
      // intent PENDING, which is what it was before the stage existed.
      const { sent: mark, ...unmarked } = source
      const clone = cloneIntent(
        (isSentMark(mark) ? source : unmarked) as SerializedEntityIntent,
      )
      if (clone.sent) {
        this.byWorkspace.get(workspaceKey)?.delete(key)
        this.sentRecords(workspaceKey).set(key, clone)
      } else {
        this.forgetSent(workspaceKey, key)
        this.records(workspaceKey).set(key, clone)
      }
      this.revision = Math.max(this.revision, source.revision)
    }
  }

  private records(workspaceKey: string): Map<string, SerializedEntityIntent> {
    let records = this.byWorkspace.get(workspaceKey)
    if (!records) {
      records = new Map()
      this.byWorkspace.set(workspaceKey, records)
    }
    return records
  }

  private sentRecords(workspaceKey: string): Map<string, SerializedEntityIntent> {
    let records = this.sentByWorkspace.get(workspaceKey)
    if (!records) {
      records = new Map()
      this.sentByWorkspace.set(workspaceKey, records)
    }
    return records
  }

  private forgetSent(workspaceKey: string, key: string): void {
    this.sentAt.delete(sentKey(workspaceKey, key))
    const records = this.sentByWorkspace.get(workspaceKey)
    if (!records?.delete(key)) return
    if (records.size === 0) this.sentByWorkspace.delete(workspaceKey)
  }
}

function sentKey(workspaceKey: string, key: string): string {
  return `${workspaceKey}\u0000${key}`
}

/** A SENT intent the server of `workspace` may confirm: its own, or one whose
 * session could not name a workspace. */
function releasableIn(record: SerializedEntityIntent, workspace: string | null): boolean {
  const tag = record.sent?.workspace
  return record.sent !== undefined && (tag === workspace || tag === null)
}

export const pendingEntityIntents = new PendingEntityIntents()

// ── replay planning (pure — the bridge supplies state, this decides) ─────────

export interface EntityIntentReplayInput {
  intents: readonly SerializedEntityIntent[]
  /** CURRENT effective value per entity id (base + overlay, i.e. what the model
   * actually holds now) — not just the overlay: after the daily compaction the
   * overlay is empty and comparing against it alone would replay stale
   * snapshots over compacted, possibly newer values. */
  currentObjects: ReadonlyMap<string, C4Object>
  currentConnections: ReadonlyMap<string, Connection>
  /** All batch ids carried by the resolved overlay shards (`writeBatchIds`),
   * per collection. Membership proves an intent's write happened. */
  objectBatchIds: ReadonlySet<string>
  connectionBatchIds: ReadonlySet<string>
  /** ModelMeta's durable tombstones. */
  deletedObjectIds: ReadonlySet<string>
  deletedConnectionIds: ReadonlySet<string>
  /** False when the witness set cannot vouch for ABSENCE (server read model
   * unreachable or disabled): a STAMPED intent missing from the batch ids may
   * then be "accomplished, then consumed+compacted" rather than "lost", and
   * blindly re-asserting its whole snapshot would clobber whatever followed.
   * Such intents are DEFERRED — kept journaled (the badge already counts
   * them) until a witness is reachable. Defaults to true. */
  witnessesReliable?: boolean
}

export interface EntityIntentReplayPlan {
  replayObjects: C4Object[]
  replayConnections: Connection[]
  replayDeleteObjectIds: string[]
  replayDeleteConnectionIds: string[]
  /** Upserts whose id is durably tombstoned: the replay must also lift the
   * tombstone or the server read model keeps excluding the entity. */
  unTombObjectIds: string[]
  unTombConnectionIds: string[]
  /** Already durable — acknowledge WITHOUT re-writing. Re-asserting a value the
   * doc already holds would stamp a new last-writer timestamp over any colleague
   * edit that synced since the crash. */
  satisfied: Array<{ kind: EntityIntentKind; id: string; revision: number }>
  /** Stamped intents whose fate no reachable witness can settle: neither
   * replayed nor acknowledged this pass. Count only — they simply stay in the
   * journal for a later pass with a witness. */
  deferred: number
}

/**
 * Three-way merge: assert onto `current` ONLY the fields the local edit changed
 * (snapshot vs baseline), leaving a colleague's concurrent edits to untouched
 * fields intact. Field granularity is top-level, the same contract as a
 * PowerSync column patch. No baseline (created entity) degrades to the full
 * snapshot over `current`.
 */
export function mergeChangedFields<T extends Record<string, unknown>>(
  snapshot: T,
  baseline: Record<string, unknown> | undefined,
  current: T,
): T {
  if (!baseline) return { ...current, ...snapshot }
  const merged: Record<string, unknown> = { ...current }
  for (const key of new Set([...Object.keys(snapshot), ...Object.keys(baseline)])) {
    if (deepEqualPlain(snapshot[key], baseline[key])) continue
    if (key in snapshot) merged[key] = snapshot[key]
    else delete merged[key]
  }
  return merged as T
}

export type CarriedUpsertDecision<T> = { write: false } | { write: true; value: T; created: boolean }

/**
 * The replay of a CARRIED upsert (`requeueSent`): the default moved, and this
 * intent goes into the version `current` names now. CONFLICT-AVERSE, because
 * nothing proves it did not reach the OLD version before the fork copied it —
 * a SENT intent outlives its delivery until a release round proves it, and a
 * tab can close in between (reviewer lens, 2026-10-31). Wherever the new
 * version differs from what the user saw (`baseline`), it is someone else's
 * later work, and it wins:
 *
 *  - entity absent: a creation (no baseline, or `createIfAbsent`) is created —
 *    unless the new version TOMBSTONED it, which is a later delete; a field
 *    patch of an absent entity has nothing left to patch;
 *  - entity present: a creation is already there (the fork copied it); a patch
 *    writes only the fields the user changed AND the new version still holds
 *    at the user's baseline.
 *
 * The cost, accepted: an offline edit of a field someone else changed in the
 * new version since is not carried (it stays in the old version's copy).
 * An ordinary crash replay never comes here: it keeps `mergeChangedFields`.
 */
export function planCarriedUpsert<T extends Record<string, unknown>>(input: {
  snapshot: T
  baseline: Record<string, unknown> | undefined
  current: T | undefined
  tombstoned: boolean
  createIfAbsent: boolean
}): CarriedUpsertDecision<T> {
  const { snapshot, baseline, current, tombstoned, createIfAbsent } = input
  if (current === undefined) {
    if (tombstoned) return { write: false }
    if (baseline === undefined || createIfAbsent) return { write: true, value: snapshot, created: true }
    return { write: false }
  }
  if (baseline === undefined) return { write: false }
  const merged: Record<string, unknown> = { ...current }
  for (const key of new Set([...Object.keys(snapshot), ...Object.keys(baseline)])) {
    if (deepEqualPlain(snapshot[key], baseline[key])) continue
    if (!deepEqualPlain(current[key], baseline[key])) continue
    if (key in snapshot) merged[key] = snapshot[key]
    else delete merged[key]
  }
  if (deepEqualPlain(merged, current)) return { write: false }
  return { write: true, value: merged as T, created: false }
}

/**
 * Resident-mode partition: a delete intent whose id
 * is ABSENT from the locally materialized model must never reach the planner
 * with a fabricated "resident tombstone" — absence would then serve as its own
 * proof (`tombstoned && current === undefined` reduces to `current ===
 * undefined`), the witness deriving from the claim it proves. The local docs
 * can simply be BEHIND (the entity was created by a colleague and never synced
 * into this copy; under boot-from-server the model shards are never even
 * loaded, so a crashed BFS session's delete of an off-copy entity is the
 * ordinary case, not the edge). Acknowledging there loses the delete forever:
 * sync later catches the copy up and the entity resurrects with the journal
 * already purged. A delete is the ONE operation whose wrong resolution is not
 * self-correcting — an absent upsert is replayed (safe direction), an absent
 * delete would be acknowledged (losing direction) — so it is DEFERRED instead:
 * kept journaled, counted by the badge, retried when the entity is visible
 * locally or a boot-from-server session drains it against real meta
 * tombstones.
 */
export function splitResidentPlannableIntents(
  intents: readonly SerializedEntityIntent[],
  currentObjects: ReadonlyMap<string, C4Object>,
  currentConnections: ReadonlyMap<string, Connection>,
): { plannable: SerializedEntityIntent[]; deferredDeletes: SerializedEntityIntent[] } {
  const plannable: SerializedEntityIntent[] = []
  const deferredDeletes: SerializedEntityIntent[] = []
  for (const intent of intents) {
    if (intent.op === 'delete') {
      const present = intent.kind === 'object'
        ? currentObjects.has(intent.id)
        : currentConnections.has(intent.id)
      if (!present) {
        deferredDeletes.push(intent)
        continue
      }
    }
    plannable.push(intent)
  }
  return { plannable, deferredDeletes }
}

export function planEntityIntentReplay(input: EntityIntentReplayInput): EntityIntentReplayPlan {
  const witnessesReliable = input.witnessesReliable ?? true
  const plan: EntityIntentReplayPlan = {
    replayObjects: [],
    replayConnections: [],
    replayDeleteObjectIds: [],
    replayDeleteConnectionIds: [],
    unTombObjectIds: [],
    unTombConnectionIds: [],
    satisfied: [],
    deferred: 0,
  }
  for (const intent of input.intents) {
    const isObject = intent.kind === 'object'
    const current = isObject
      ? input.currentObjects.get(intent.id)
      : input.currentConnections.get(intent.id)
    const tombstoned = isObject
      ? input.deletedObjectIds.has(intent.id)
      : input.deletedConnectionIds.has(intent.id)
    const batchIds = isObject ? input.objectBatchIds : input.connectionBatchIds
    // Accomplished-by-batch: the shard carries the very batch that expressed
    // this intent. No value comparison — the write happened; whatever the value
    // is NOW is later history (possibly a colleague's), not ours to re-assert.
    if (intent.writtenInBatchId && batchIds.has(intent.writtenInBatchId)) {
      plan.satisfied.push({ kind: intent.kind, id: intent.id, revision: intent.revision })
      continue
    }
    if (intent.op === 'delete') {
      if (tombstoned && current === undefined) {
        plan.satisfied.push({ kind: intent.kind, id: intent.id, revision: intent.revision })
      } else if (isObject) {
        plan.replayDeleteObjectIds.push(intent.id)
      } else {
        plan.replayDeleteConnectionIds.push(intent.id)
      }
      continue
    }
    const snapshot = stripUndefined(intent.snapshot)
    if (current !== undefined && deepEqualPlain(snapshot, stripUndefined(current))) {
      plan.satisfied.push({ kind: intent.kind, id: intent.id, revision: intent.revision })
      continue
    }
    if (intent.carried) {
      const decision = planCarriedUpsert({
        snapshot: snapshot as unknown as Record<string, unknown>,
        baseline: intent.baseline ? stripUndefined(intent.baseline) as unknown as Record<string, unknown> : undefined,
        current: current !== undefined ? stripUndefined(current) as unknown as Record<string, unknown> : undefined,
        tombstoned,
        createIfAbsent: intent.createIfAbsent === true,
      })
      if (!decision.write) {
        plan.satisfied.push({ kind: intent.kind, id: intent.id, revision: intent.revision })
      } else if (isObject) {
        plan.replayObjects.push(decision.value as unknown as C4Object)
      } else {
        plan.replayConnections.push(decision.value as unknown as Connection)
      }
      continue
    }
    // Stamped + no witness can vouch for absence: the write may have happened
    // and been consumed+compacted. Blindly re-asserting the whole snapshot here
    // is the one branch that could clobber an entity beyond the per-field
    // residual — defer instead; the journal keeps it and the badge counts it.
    if (intent.writtenInBatchId && current === undefined && !witnessesReliable) {
      plan.deferred += 1
      continue
    }
    const baseline = intent.baseline ? stripUndefined(intent.baseline) : undefined
    const value = current !== undefined
      ? mergeChangedFields(
        snapshot as unknown as Record<string, unknown>,
        baseline as unknown as Record<string, unknown> | undefined,
        stripUndefined(current) as unknown as Record<string, unknown>,
      )
      : snapshot
    if (isObject) {
      plan.replayObjects.push(value as C4Object)
      if (tombstoned) plan.unTombObjectIds.push(intent.id)
    } else {
      plan.replayConnections.push(value as Connection)
      if (tombstoned) plan.unTombConnectionIds.push(intent.id)
    }
  }
  return plan
}

// ── small-collection replay planning ─────────────────────────────────────────

export interface SmallCollectionReplayInput {
  /** Only small-collection intents; the caller partitions (object/connection
   * intents go through `planEntityIntentReplay`, which speaks batch ids and
   * server witnesses this planner deliberately does not). */
  intents: readonly SerializedEntityIntent[]
  /** The durable ModelMeta maps, as resolved — the SAME witness in BFS and
   * resident mode, which is what makes this planner simpler than the entity
   * one: the carrier of these families IS their only durable home, so there is
   * no compaction ambiguity, no batch-id substrate and no reachability
   * question. `tagSnapshot` keys are canonical tagIds. */
  current: Readonly<Record<SmallCollectionIntentKind, ReadonlyMap<string, Record<string, unknown>>>>
  /** ModelMeta's ADR tombstones — the one small-collection family that HAS
   * durable delete artifacts (on delta/paged workspaces). */
  deletedDecisionRecordIds: ReadonlySet<string>
}

export interface SmallCollectionReplayPlan {
  /** Values to write INTO the ModelMeta maps (per-field three-way merged). */
  replayUpserts: Record<SmallCollectionIntentKind, Record<string, unknown>[]>
  /** Keys to remove from the ModelMeta maps. Full-set families (groups,
   * domains, tagSnapshots) have NO delete tombstones by design — delete IS
   * absence — so an absent-target delete is planned anyway (a no-op removal,
   * then acknowledged). Why this is not "absence serving as its own proof"
   * (see the resident-mode partition above): a small-collection delete intent
   * can only be CAPTURED for an entity the store held, and the store's small
   * collections are projected from the LOCALLY RESIDENT ModelMeta — the very
   * document this replay reads. Absence at replay time therefore means our
   * own removal landed, or the entity never outlived RAM (created and
   * deleted between flushes) — not "a copy we cannot see may still hold it",
   * which is the objects' distributed-shards situation and the reason THEIR
   * absent-target deletes defer. Known residual risk: a laggard peer's CRDT put can resurrect the key, exactly as it
   * can against the live, non-crashed full-set write path today.
   * DecisionRecord deletes additionally re-assert the tombstone. */
  replayDeletes: Record<SmallCollectionIntentKind, string[]>
  /** ADR upserts whose id is durably tombstoned: the applier must lift the
   * tombstone or a delta-mode workspace keeps excluding the record. */
  unTombDecisionRecordIds: string[]
  /** Already durable — acknowledge WITHOUT re-writing (re-asserting an equal
   * value would stamp a new last-writer over a colleague's concurrent edit). */
  satisfied: Array<{ kind: EntityIntentKind; id: string; revision: number }>
}

export function planSmallCollectionIntentReplay(
  input: SmallCollectionReplayInput,
): SmallCollectionReplayPlan {
  const plan: SmallCollectionReplayPlan = {
    replayUpserts: { group: [], domain: [], tagSnapshot: [], decisionRecord: [] },
    replayDeletes: { group: [], domain: [], tagSnapshot: [], decisionRecord: [] },
    unTombDecisionRecordIds: [],
    satisfied: [],
  }
  for (const intent of input.intents) {
    if (!isSmallCollectionKind(intent.kind)) continue
    const kind = intent.kind
    const current = input.current[kind].get(intent.id)
    if (intent.op === 'delete') {
      if (kind === 'decisionRecord') {
        // ADRs have a positive artifact: tombstoned AND absent is proof.
        if (input.deletedDecisionRecordIds.has(intent.id) && current === undefined) {
          plan.satisfied.push({ kind, id: intent.id, revision: intent.revision })
          continue
        }
      }
      plan.replayDeletes[kind].push(intent.id)
      continue
    }
    const snapshot = stripUndefined(intent.snapshot) as unknown as Record<string, unknown>
    const baseline = intent.baseline
      ? stripUndefined(intent.baseline) as unknown as Record<string, unknown>
      : undefined
    if (intent.carried) {
      const decision = planCarriedUpsert({
        snapshot,
        baseline,
        current: current !== undefined ? stripUndefined(current) as Record<string, unknown> : undefined,
        tombstoned: kind === 'decisionRecord' && input.deletedDecisionRecordIds.has(intent.id),
        createIfAbsent: intent.createIfAbsent === true,
      })
      if (decision.write) plan.replayUpserts[kind].push(decision.value)
      else plan.satisfied.push({ kind, id: intent.id, revision: intent.revision })
      continue
    }
    let value: Record<string, unknown>
    if (current !== undefined) {
      // Satisfaction is the MERGE predicate, not raw equality: the intent is
      // expressed the moment the durable value already incorporates every
      // field the user changed — including a value a PREVIOUS replay merged
      // (raw equality against a merged value never holds, and calling that
      // unsatisfied re-plans the same write forever).
      const durable = stripUndefined(current) as Record<string, unknown>
      const merged = mergeChangedFields(snapshot, baseline, durable)
      if (deepEqualPlain(merged, durable)) {
        plan.satisfied.push({ kind, id: intent.id, revision: intent.revision })
        continue
      }
      value = merged
    } else {
      value = snapshot
    }
    plan.replayUpserts[kind].push(value)
    if (kind === 'decisionRecord' && input.deletedDecisionRecordIds.has(intent.id)) {
      plan.unTombDecisionRecordIds.push(intent.id)
    }
  }
  return plan
}

// ── diagram-collection replay planning ───────────────────────────────────────

export interface DiagramCollectionReplayInput {
  /** Only diagram-collection intents; the caller partitions. */
  intents: readonly SerializedEntityIntent[]
  /** The diagram whose DiagramDoc is attached and hydrated — the ONLY carrier
   * this pass can consult or write. */
  activeDiagramId: string
  /** The attached DiagramDoc's maps, as resolved — the carrier IS the witness,
   * same property as the small collections (their rationale transfers: a comment/flow intent can only be captured for an entity the
   * store held, and the store's slices are projected from this very doc, so
   * absence at replay time means our own removal landed or the entity never
   * outlived RAM — not "an unseen copy may still hold it"). */
  current: Readonly<Record<DiagramCollectionIntentKind, ReadonlyMap<string, Record<string, unknown>>>>
}

export interface DiagramCollectionReplayPlan {
  /** Values to write INTO the active DiagramDoc's maps (per-field merged). */
  replayUpserts: Record<DiagramCollectionIntentKind, Record<string, unknown>[]>
  /** Keys to remove from the active DiagramDoc's maps. Planned even for an
   * absent target (a no-op removal, then acknowledged) — see `current`. */
  replayDeletes: Record<DiagramCollectionIntentKind, string[]>
  /** Already durable — acknowledge WITHOUT re-writing. */
  satisfied: Array<{ kind: EntityIntentKind; id: string; revision: number }>
  /** Intents whose diagram is NOT the active one: untouched — they stay
   * journaled (badge-counted) until their diagram is activated. */
  remaining: number
}

export function planDiagramCollectionIntentReplay(
  input: DiagramCollectionReplayInput,
): DiagramCollectionReplayPlan {
  const plan: DiagramCollectionReplayPlan = {
    replayUpserts: { comment: [], flow: [] },
    replayDeletes: { comment: [], flow: [] },
    satisfied: [],
    remaining: 0,
  }
  for (const intent of input.intents) {
    if (!isDiagramCollectionKind(intent.kind)) continue
    const kind = intent.kind
    const diagramId = intent.op === 'delete'
      ? intent.diagramId
      : (intent.snapshot as { diagramId?: string }).diagramId
    if (diagramId !== input.activeDiagramId) {
      plan.remaining += 1
      continue
    }
    const current = input.current[kind].get(intent.id)
    if (intent.op === 'delete') {
      plan.replayDeletes[kind].push(intent.id)
      continue
    }
    const snapshot = stripUndefined(intent.snapshot) as unknown as Record<string, unknown>
    const baseline = intent.baseline
      ? stripUndefined(intent.baseline) as unknown as Record<string, unknown>
      : undefined
    if (intent.carried) {
      const decision = planCarriedUpsert({
        snapshot,
        baseline,
        current: current !== undefined ? stripUndefined(current) as Record<string, unknown> : undefined,
        tombstoned: false,
        createIfAbsent: intent.createIfAbsent === true,
      })
      if (decision.write) plan.replayUpserts[kind].push(decision.value)
      else plan.satisfied.push({ kind, id: intent.id, revision: intent.revision })
      continue
    }
    let value: Record<string, unknown>
    if (current !== undefined) {
      // The MERGE predicate, not raw equality — same livelock rationale as the
      // small-collection planner.
      const durable = stripUndefined(current) as Record<string, unknown>
      const merged = mergeChangedFields(snapshot, baseline, durable)
      if (deepEqualPlain(merged, durable)) {
        plan.satisfied.push({ kind, id: intent.id, revision: intent.revision })
        continue
      }
      value = merged
    } else {
      value = snapshot
    }
    plan.replayUpserts[kind].push(value)
  }
  return plan
}

// ── persistence — per-tab key + registry, immediate by default ───────────────
//
// Per-tab keys because the alternative is a shared key each tab blindly
// rewrites/deletes: a clean sibling tab would erase the journal of the tab that
// still needs it (the placement journal has this defect today). Each tab only
// ever writes ITS key; the registry is the small discovery index. A registry
// read-modify-write can race between two tabs booting simultaneously — persist
// re-asserts the registration each time, so a lost registration self-heals on
// the next write.

const persistTimers = new Map<string, {
  timer: ReturnType<typeof setTimeout>
  pendingSince: number
}>()
const PERSIST_MAX_WAIT_MS = 500
let softCapWarned = false

export async function persistEntityIntents(store: KvStore, workspaceKey: string): Promise<void> {
  // Cost note: serialize deep-copies EVERY pending
  // snapshot+baseline, and this runs on every tick that records anything —
  // the journal-size-dependent term of the capture cost. DEV-gated no-op.
  const finishSerialize = startClientTimelineMeasure('entity-intents.persist.serialize')
  const serialized = pendingEntityIntents.serialize(workspaceKey)
  finishSerialize({ intents: serialized.length })
  if (serialized.length > ENTITY_INTENT_SOFT_CAP && !softCapWarned) {
    softCapWarned = true
    console.warn(
      `entity intent journal holds ${serialized.length} pending intents; `
      + 'a bulk producer should not run through the crash journal',
    )
  }
  // Registry mutations are ATOMIC single-key updates (one IndexedDB readwrite
  // transaction), never a recompose from an earlier read: a get-then-set here
  // once let a sibling tab's survivor write erase a fresh registration, which
  // stranded that tab's journal key forever after a crash — a silent loss
  // inside the anti-loss mechanism.
  if (serialized.length > 0) {
    await store.set(tabStorageKey(entityIntentTabId), serialized)
    await store.update<string[]>(REGISTRY_KEY, (tabs) =>
      tabs?.includes(entityIntentTabId) ? tabs : [...(tabs ?? []), entityIntentTabId])
  } else {
    await store.del(tabStorageKey(entityIntentTabId))
    await store.update<string[]>(REGISTRY_KEY, (tabs) =>
      (tabs ?? []).filter((tabId) => tabId !== entityIntentTabId))
  }
}

/**
 * Adopt every journaled tab's intents — our own previous page load included (a
 * reload gets a fresh tab id, so recovery IS adoption).
 *
 * A foreign key is emptied only by a CONDITIONAL atomic update: inside the
 * update transaction its current content is compared to exactly what was
 * adopted, and a LIVE sibling that re-recorded since our read keeps its newer
 * content untouched (deleting foreign keys outright, or subtracting the
 * registry from a pre-computed set, would reintroduce the stale-read race the
 * atomic registry exists to prevent, one level up).
 * The registry then loses only the ids whose keys were actually emptied, plus
 * ids whose keys were empty at read time (nothing to lose there — and a live
 * owner re-registers itself on its next persist anyway).
 */
export async function hydrateEntityIntents(store: KvStore, workspaceKey: string): Promise<void> {
  await adoptJournalNamespace(store, workspaceKey, REGISTRY_KEY, tabStorageKey, true)
  // The legacy namespaces (storage versions v3 and v2) written by older
  // builds. Same adoption protocol; our tab id never writes there, so every
  // key is foreign.
  for (const prefix of LEGACY_STORAGE_PREFIXES) {
    await adoptJournalNamespace(
      store, workspaceKey, `${prefix}:tabs`, (tabId) => `${prefix}:tab:${tabId}`, false,
    )
  }
}

async function adoptJournalNamespace(
  store: KvStore,
  workspaceKey: string,
  registryKey: string,
  keyOfTab: (tabId: string) => string,
  includeSelf: boolean,
): Promise<void> {
  // The protocol lives in tabJournalAdoption.ts, shared with the placement
  // journal.
  await adoptTabJournalNamespace<SerializedEntityIntent>({
    store,
    registryKey,
    keyOfTab,
    ownTabId: entityIntentTabId,
    includeSelf,
    hydrate: (entries) => pendingEntityIntents.hydrate(workspaceKey, entries),
    rehome: () => persistEntityIntents(store, workspaceKey),
    contentEquals: deepEqualPlain,
  })
}

/**
 * Persist NOW — the default for entity intents. Entity edits are discrete
 * commits, not a pointer stream: one immediate IndexedDB write per edit is
 * cheap, and it closes the capture→persist crash window the debounced variant
 * leaves open (a hard kill fires no pagehide).
 */
export function persistEntityIntentsNow(store: KvStore, workspaceKey: string): void {
  const pending = persistTimers.get(workspaceKey)
  if (pending) clearTimeout(pending.timer)
  persistTimers.delete(workspaceKey)
  void persistEntityIntents(store, workspaceKey).catch((error) => {
    console.warn('pending entity intent persistence failed', error)
  })
}

/** Coalescing variant for the one genuinely bursty producer (per-keystroke field
 * editing re-records the same entity): first write immediate, subsequent ones
 * within the window coalesce, 500 ms ceiling. */
export function schedulePersistEntityIntents(
  store: KvStore,
  workspaceKey: string,
  delayMs = 50,
): void {
  const pending = persistTimers.get(workspaceKey)
  if (!pending) {
    // Leading edge: nothing in flight for this workspace → do not wait at all.
    persistEntityIntentsNow(store, workspaceKey)
    // Arm a trailing write so re-records during the leading write's own
    // lifetime still land; it becomes a cheap no-op when nothing changed.
    const timer = setTimeout(() => {
      persistTimers.delete(workspaceKey)
      void persistEntityIntents(store, workspaceKey).catch((error) => {
        console.warn('pending entity intent persistence failed', error)
      })
    }, delayMs)
    persistTimers.set(workspaceKey, { timer, pendingSince: Date.now() })
    return
  }
  clearTimeout(pending.timer)
  const now = Date.now()
  const maxWaitRemaining = Math.max(0, PERSIST_MAX_WAIT_MS - (now - pending.pendingSince))
  const timer = setTimeout(() => {
    persistTimers.delete(workspaceKey)
    void persistEntityIntents(store, workspaceKey).catch((error) => {
      console.warn('pending entity intent persistence failed', error)
    })
  }, Math.min(delayMs, maxWaitRemaining))
  persistTimers.set(workspaceKey, { timer, pendingSince: pending.pendingSince })
}

export async function flushEntityIntentPersistence(
  store: KvStore,
  workspaceKey: string,
): Promise<void> {
  const pending = persistTimers.get(workspaceKey)
  if (pending) clearTimeout(pending.timer)
  persistTimers.delete(workspaceKey)
  await persistEntityIntents(store, workspaceKey)
}

/**
 * THE ordering that makes the journal a journal: the carrier document is
 * flushed FIRST, the intents are forgotten second, the forgetting is persisted
 * third. It lives here — in one unit-tested function — rather than inlined at
 * each bridge call site, where a "forget before flush" error is untestable. A
 * flush that never settles must keep the intents forever; a flush that rejects
 * must propagate without forgetting anything.
 */
export async function forgetIntentsOnceDurable(
  flushCarrier: () => Promise<unknown>,
  forget: () => void,
  persist: () => Promise<void>,
): Promise<void> {
  await flushCarrier()
  forget()
  await persist()
}
