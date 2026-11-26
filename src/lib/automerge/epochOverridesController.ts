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

import type { C4Object, Connection, Group } from '../../types'
import { getDiagramIndex, useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useEpochOverridesStore, type ReapplyRefusal } from '../../stores/epochOverridesStore'
import { undoHistory } from '../history/undoHistory'
import { openEntityInDiagram } from '../entityUsage'
import { workspaceKvStore } from '../modelQuery/kvStore'
import {
  defaultChecked, fetchOverrides, isReapplyMessage, overrideTarget, planReapply, reapplyMessage, resolveOverrides, rowStatuses,
  toggleChecked, type EntityGroup, type OverrideCollection, type OverrideRow, type ReplicaView,
} from './epochOverrides'

/**
 * The batch re-apply's EFFECTS (G4-16f): fetching the tab's own pending
 * override rows, the panel's selection, "Show in diagram", the ONE re-apply
 * edit and its resolution by batch id, the undo that returns the rows to
 * pending, and the crash journal. The bridge supplies the ports
 * (`EpochOverridePorts`, wired by `installEpochOverrides`) — installed only
 * on a workspace with epochs, refreshed at install and after a hop, never
 * on a timer.
 */
export interface EpochOverridePorts {
  /** This browser profile's actors — read again at each refresh (another
   * tab of the profile records its own). */
  actorIds(): string[] | Promise<string[]>
  /** A signed-in user — the route then lists the rows of every actor her
   * tabs and devices asked with, so a device
   * with no actor of its own asks too. */
  signedIn?(): boolean | Promise<boolean>
  /** False while an epoch hop runs (latch, paused or deferred writes): a
   * re-apply flushed then could land on the epoch being left. */
  writable(): boolean
  /** Flush what is pending now (untagged), so the next flush holds only the batch. */
  flushPending(): void
  /** Flush the pending write with every Automerge change carrying `message`;
   * answers the documents those changes went to (the batch's CARRIERS). */
  flushTagged(message: string): string[]
  /** Resolves true once every carrier is durable on the server (only them:
   * the rest of the ledger is not the batch's business). */
  whenDurable(carriers: readonly string[], timeoutMs: number): Promise<boolean>
  /** The changes, in the documents this tab projects, whose message matches. */
  changesWithMessage(match: (message: string) => boolean): Array<{ documentId: string; actor: string }>
  /** Whether none of these documents is still owed to the server. */
  carriersDurable(documentIds: readonly string[]): boolean
  /** The heads of these documents now (journaled after the tagged flush). */
  carrierHeads(documentIds: readonly string[]): Array<{ documentId: string; heads: string[] }>
  /** Whether the SERVER holds these heads (a roll copies the
   * batch's changes into the new epoch WITHOUT their message; the old
   * documents' heads still say whether the batch was written). From the
   * `acknowledgeDurableDocumentHeads` answers, one per document:
   *  - `true`: EVERY document answered `durable: true`;
   *  - `'retired'`: every document answered either
   *    `durable: true` or `epochRetired: true`, and at least one the latter —
   *    a retired document's heads are no longer checked by the server, but
   *    its epoch was forwarded before it was retired;
   *  - `false`: otherwise (a document neither durable nor retired, a missing
   *    answer, or an empty list). */
  serverHolds(heads: ReadonlyArray<{ documentId: string; heads: string[] }>): Promise<boolean | 'retired'>
  /** Boot-from-server: entities the store's window lacks, read
   * from the server read model. Absent: the store is the whole model. */
  fetchEntities?(collection: OverrideCollection, ids: string[]): Promise<Map<string, Record<string, unknown>>>
  /** Boot-from-server: put a fetched entity in the window so it can be edited. */
  seedForEdit?(collection: OverrideCollection, entity: Record<string, unknown>): void
}

/**
 * The crash journal: ONE SLOT PER BATCH, as one KV
 * record `batchId → JournaledBatch` — a redo no longer overwrites the journal
 * of another batch still waiting. Every change is ONE atomic `update` of that
 * record touching only its own batch's slot: an
 * undo dropping its batch can never erase the journal of a batch re-applied
 * right after, in this tab or another. One record rather than one key per
 * batch: listing keys is a `scanPrefix`, a scan of the whole database.
 */
const JOURNAL_KEY = 'epoch-reapply-batches:v2'
/** The single-slot journal of earlier builds: read once, moved into its slot. */
const LEGACY_JOURNAL_KEY = 'epoch-reapply-batch:v1'
type Journal = Record<string, JournaledBatch>
const DURABLE_TIMEOUT_MS = 30_000
/** A journaled batch whose message is found but whose carriers stay owed is
 * kept this many reviews before it is given up (its rows are offered again). */
const JOURNAL_MAX_ATTEMPTS = 5

/** How long a review waits, again, for an in-session batch whose first wait
 * ran out. */
const RECOVERY_WAIT_MS = 5_000

interface JournaledBatch {
  batchId: string
  reapplied: string[]
  dismissed: string[]
  attempts?: number
  /** The documents the tagged flush wrote, with their heads right after it. */
  carriers?: Array<{ documentId: string; heads: string[] }>
}

let ports: EpochOverridePorts | null = null
let refreshing: Promise<void> | null = null
/** Identity of the refresh `refreshing` holds (only it clears the slot). */
let refreshingToken: object | null = null
/** Batches whose own path is still waiting to resolve them (a re-apply or a
 * redo): the recovery leaves them alone. */
const resolvingInFlight = new Set<string>()
let fetchController: AbortController | null = null
let untag: (() => void) | null = null
/** batch id → its rows, for the undo hook and a redo under a new id. Set
 * BEFORE any await. */
const batches = new Map<string, JournaledBatch>()
/** Batches undone before their resolve: never resolved. */
const undoneBeforeResolve = new Set<string>()
/** Batches whose redo was refused during a hop: the undo that cancels it is
 * this module's, not the user's. */
const cancellingRedo = new Set<string>()
/** Entities fetched from the server read model for the panel. */
let fetchedEntities: Record<OverrideCollection, Map<string, Record<string, unknown>>> = {
  objects: new Map(), connections: new Map(), groups: new Map(),
}

function replica(): ReplicaView {
  const s = useModelStore.getState()
  const lookups = {
    objects: new Map(s.objects.map((o) => [o.id, o as unknown as Record<string, unknown>])),
    connections: new Map(s.connections.map((c) => [c.id, c as unknown as Record<string, unknown>])),
    groups: new Map(s.groups.map((g) => [g.id, g as unknown as Record<string, unknown>])),
  }
  return { entity: (collection, id) => lookups[collection].get(id) ?? fetchedEntities[collection].get(id) }
}

/** Boot-from-server: read the targeted entities the window lacks. */
async function fetchMissingEntities(rows: readonly OverrideRow[]): Promise<void> {
  if (!ports?.fetchEntities) return
  const s = useModelStore.getState()
  const present = {
    objects: new Set(s.objects.map((o) => o.id)), connections: new Set(s.connections.map((c) => c.id)), groups: new Set(s.groups.map((g) => g.id)),
  }
  const missing: Record<OverrideCollection, Set<string>> = { objects: new Set(), connections: new Set(), groups: new Set() }
  for (const row of rows) {
    const t = overrideTarget(row)
    if (t && !present[t.collection].has(t.entityId)) missing[t.collection].add(t.entityId)
  }
  const next = { objects: new Map(), connections: new Map(), groups: new Map() } as typeof fetchedEntities
  for (const collection of ['objects', 'connections', 'groups'] as const) {
    if (missing[collection].size > 0) next[collection] = await ports.fetchEntities(collection, [...missing[collection]])
  }
  fetchedEntities = next
}

function applyRows(rows: OverrideRow[]): void {
  const store = useEpochOverridesStore.getState()
  const statuses = rowStatuses(rows, replica())
  const defaults = defaultChecked(rows, statuses)
  const live = new Set(rows.map((r) => r.id))
  // A user's choice survives a refresh; a NEW row takes the default (checked).
  const checked = new Set<string>()
  for (const row of rows) {
    if (store.touched.has(row.id)) { if (store.checked.has(row.id)) checked.add(row.id) } else if (defaults.has(row.id)) checked.add(row.id)
  }
  useEpochOverridesStore.setState({
    rows,
    statuses,
    checked,
    touched: new Set([...store.touched].filter((id) => live.has(id))),
    pulled: new Set([...store.pulled].filter((id) => live.has(id))),
    noticeCollapsed: rows.length === 0 ? false : store.noticeCollapsed,
    panelOpen: rows.length === 0 ? false : store.panelOpen,
    highlight: rows.length === 0 ? false : store.highlight,
  })
}

/** Recompute the statuses against the replica (it changes under the panel). */
export function recomputeStatuses(): void {
  const { rows } = useEpochOverridesStore.getState()
  if (rows.length > 0) useEpochOverridesStore.setState({ statuses: rowStatuses(rows, replica()) })
}

/** Write this batch's slot (a copy: what is stored is what it is now). */
function journalWrite(batch: JournaledBatch): Promise<void> {
  const copy: JournaledBatch = { ...batch }
  return workspaceKvStore().update<Journal>(JOURNAL_KEY, (old) => ({ ...(old ?? {}), [copy.batchId]: copy }))
}

/** Drop THIS batch's slot, atomically, and nothing else (an undone batch must
 * never be resolved by a later recovery). */
function journalDrop(batchId: string): Promise<void> {
  return workspaceKvStore().update<Journal>(JOURNAL_KEY, (old) => {
    const rest: Journal = { ...(old ?? {}) }
    delete rest[batchId]
    return rest
  }).catch(() => undefined)
}

/** Count a review of a batch still owed; given up after JOURNAL_MAX_ATTEMPTS.
 * Only a slot still there is counted (never re-created after a drop). */
function journalCountAttempt(journaled: JournaledBatch): Promise<void> {
  const attempts = (journaled.attempts ?? 0) + 1
  if (attempts >= JOURNAL_MAX_ATTEMPTS) return journalDrop(journaled.batchId)
  return workspaceKvStore().update<Journal>(JOURNAL_KEY, (old) => {
    const slot = old?.[journaled.batchId]
    return slot ? { ...old, [journaled.batchId]: { ...slot, attempts } } : (old ?? {})
  }).catch(() => undefined)
}

/** Every journaled batch (the legacy single slot moved into its own first). */
async function journaledBatches(): Promise<JournaledBatch[]> {
  const store = workspaceKvStore()
  const legacy = await store.get<JournaledBatch>(LEGACY_JOURNAL_KEY).catch(() => undefined)
  if (legacy && typeof legacy.batchId === 'string') {
    await store.update<Journal>(JOURNAL_KEY, (old) => (old?.[legacy.batchId] ? old : { ...(old ?? {}), [legacy.batchId]: legacy }))
      .then(() => store.del(LEGACY_JOURNAL_KEY))
      .catch(() => undefined)
  }
  const journal = await store.get<Journal>(JOURNAL_KEY).catch(() => undefined)
  return Object.values(journal ?? {}).filter((b): b is JournaledBatch => typeof b?.batchId === 'string')
}

async function resolveJournaled(journaled: JournaledBatch): Promise<void> {
  await resolveOverrides({ batchId: journaled.batchId, reapplied: journaled.reapplied, dismissed: journaled.dismissed })
  batches.set(journaled.batchId, journaled)
  useEpochOverridesStore.setState({ lastBatch: journaled })
  await journalDrop(journaled.batchId)
}

/**
 * A JOURNALED batch not resolved yet: after a crash, or in this session when
 * its wait for durability ran out. Recognised by its MESSAGE, never by value
 * (the ABA case), and resolved only once what carries it is
 * durable on the server. Never while a re-apply runs, never a
 * batch whose own path still waits, never an UNDONE one.
 *  - in this session: the wait is run again, briefly;
 *  - message found, carriers durable → resolved;
 *  - message found, carriers still owed → kept, attempt counted;
 *  - message NOT found: a roll may have copied the changes into the new epoch
 *    without their message — the journaled carrier heads say
 *    whether the batch was written: the server holds them → resolved; their
 *    epoch is RETIRED → resolved too, as written: a retired
 *    epoch was forwarded before it was retired, so offering the rows again
 *    would re-apply a batch already in the current epoch (a batch that never
 *    reached the server before the retirement is in the hop's retired export,
 *    where its differences are offered); it does not (or none were journaled:
 *    the crash came before the flush) → the slot is dropped and the rows are
 *    offered again.
 * Each journaled batch in turn (one slot per batch).
 */
async function recoverJournaledBatches(): Promise<void> {
  if (!ports || useEpochOverridesStore.getState().busy) return
  for (const journaled of await journaledBatches()) {
    if (!ports || useEpochOverridesStore.getState().busy) return
    await recoverJournaledBatch(ports, journaled)
  }
}

async function recoverJournaledBatch(p: EpochOverridePorts, journaled: JournaledBatch): Promise<void> {
  if (resolvingInFlight.has(journaled.batchId)) return
  if (undoneBeforeResolve.has(journaled.batchId)) { await journalDrop(journaled.batchId); return }
  if (batches.has(journaled.batchId)) {
    const ids = (journaled.carriers ?? []).map((c) => c.documentId)
    if (ids.length === 0) return
    resolvingInFlight.add(journaled.batchId)
    try {
      if (!(await p.whenDurable(ids, RECOVERY_WAIT_MS)) || undoneBeforeResolve.has(journaled.batchId)) return
      await resolveJournaled(journaled)
    } finally {
      resolvingInFlight.delete(journaled.batchId)
    }
    return
  }
  const carriers = p.changesWithMessage((message) => isReapplyMessage(message, journaled.batchId))
  if (carriers.length === 0) {
    const held = journaled.carriers?.length ? await p.serverHolds(journaled.carriers).catch(() => false) : false
    if (held === true || held === 'retired') {
      await resolveJournaled(journaled)
      return
    }
    await journalDrop(journaled.batchId)
    return
  }
  if (!p.carriersDurable(carriers.map((c) => c.documentId))) {
    await journalCountAttempt(journaled)
    return
  }
  await resolveJournaled(journaled)
}

/**
 * Fetch this tab's pending rows. A refresh already in flight is NOT the
 * answer to a request made after a resolve: `force` waits
 * for it and runs again.
 */
export async function refreshOverrides(options: { force?: boolean } = {}): Promise<void> {
  if (!ports) return
  if (refreshing) {
    if (!options.force) return refreshing
    // Started before the caller's resolve: wait it out, then one that starts
    // after (or join one already started after).
    await refreshing.catch(() => undefined)
    if (refreshing) return refreshing
  }
  const controller = new AbortController()
  fetchController = controller
  const token = {}
  refreshingToken = token
  const mine: Promise<void> = (async () => {
    try {
      await recoverJournaledBatches()
      if (controller.signal.aborted || !ports) return
      const actors = await ports.actorIds()
      const signedIn = actors.length === 0 && (await ports.signedIn?.()) === true
      if (controller.signal.aborted || !ports) return
      const rows = await fetchOverrides(actors, controller.signal, signedIn)
      if (controller.signal.aborted || !ports) return
      await fetchMissingEntities(rows)
      if (controller.signal.aborted || !ports) return
      applyRows(rows)
      useEpochOverridesStore.setState({ error: null })
    } catch (error) {
      if (!controller.signal.aborted) useEpochOverridesStore.setState({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (fetchController === controller) fetchController = null
      // Only ITS OWN slot: a refresh of a workspace left, ending
      // late, must not clear the new workspace's refresh.
      if (refreshingToken === token) { refreshing = null; refreshingToken = null }
    }
  })()
  refreshing = mine
  await mine
}

export function setRowChecked(rowId: string, on: boolean): void {
  const s = useEpochOverridesStore.getState()
  const checked = toggleChecked(s.checked, rowId, on, s.statuses)
  const touched = new Set(s.touched)
  for (const id of new Set([...checked, ...s.checked])) if (checked.has(id) !== s.checked.has(id)) touched.add(id)
  touched.add(rowId)
  const pulled = new Set(s.pulled)
  if (on) pulled.delete(rowId)
  useEpochOverridesStore.setState({ checked, touched, pulled })
}

/** "All" checks only what can be applied as it stands: a row
 * changed since, an orphaned connection or an unsupported field stays
 * unchecked — the user checks it on purpose. */
export function setAllChecked(on: boolean): void {
  const s = useEpochOverridesStore.getState()
  const selectable = s.rows.filter((r) => {
    const kind = s.statuses.get(r.id)?.kind ?? 'ready'
    return kind === 'ready' || kind === 'needs'
  })
  useEpochOverridesStore.setState({
    checked: on ? new Set(selectable.map((r) => r.id)) : new Set(),
    touched: new Set(s.rows.map((r) => r.id)),
    pulled: on ? new Set() : s.pulled,
  })
}

export function openReview(): void {
  recomputeStatuses()
  useEpochOverridesStore.setState({ panelOpen: true, noticeCollapsed: true, compact: false })
}

export function closeReview(): void {
  useEpochOverridesStore.setState({ panelOpen: false, highlight: false, compact: false })
}

/** Back from the compact strip to the full review. */
export function expandReview(): void {
  recomputeStatuses()
  useEpochOverridesStore.setState({ compact: false })
}

/**
 * "Show in diagram": the LIVE model — the current epoch, which
 * already holds the other user's changes — on the diagram that contains the
 * entity, with it selected, and the highlight layer on. The panel folds into
 * a compact strip so the diagram stays visible; its
 * checkboxes stay as they are.
 */
export function showInDiagram(group: EntityGroup): boolean {
  useEpochOverridesStore.setState({ highlight: true, compact: true, refusal: null })
  if (!group.entityId || !group.collection) return false
  const index = getDiagramIndex()
  const kind = group.collection === 'objects' ? 'object' : group.collection === 'connections' ? 'connection' : 'group'
  const owners = kind === 'object' ? index.objectToDiagramIds : kind === 'connection' ? index.connectionToDiagramIds : index.groupToDiagramIds
  const diagrams = owners.get(group.entityId)
  const current = useModelStore.getState().currentDiagramId
  const diagramId = diagrams?.has(current ?? '') ? current : diagrams ? [...diagrams][0] : current
  if (!diagramId) { useUIStore.getState().setCurrentView('diagram'); return false }
  openEntityInDiagram(diagramId, kind, group.entityId)
  return true
}

/** Open the diagram the first targeted entity is on (the refusal's way out). */
export function openDiagramForReapply(): void {
  const s = useEpochOverridesStore.getState()
  const row = s.rows.find((r) => overrideTarget(r))
  const t = row ? overrideTarget(row) : null
  if (t) {
    showInDiagram({ key: `${t.collection}:${t.entityId}`, collection: t.collection, entityId: t.entityId, rows: [row!] })
  } else {
    useUIStore.getState().setCurrentView('diagram')
  }
  useEpochOverridesStore.setState({ refusal: null, compact: false })
}

function applyBatchEdit(plan: ReturnType<typeof planReapply>): void {
  const store = useModelStore.getState()
  // Boot-from-server: an entity outside the window is put in it first, so
  // the store edit has something to change.
  for (const update of plan.updates) {
    const fetched = fetchedEntities[update.collection].get(update.id)
    if (fetched && ports?.seedForEdit) ports.seedForEdit(update.collection, fetched)
  }
  // ONE task: every record joins one undo entry (`undoHistory`'s rule).
  const of = (c: OverrideCollection) => plan.recreate.filter((r) => r.collection === c).map((r) => r.entity)
  const objects = of('objects') as unknown as C4Object[]
  const connections = of('connections') as unknown as Connection[]
  const groups = of('groups') as unknown as Group[]
  if (objects.length + connections.length + groups.length > 0) {
    useModelStore.getState().restoreDeletedEntities({ objects, connections, groups })
  }
  for (const update of plan.updates) {
    if (update.collection === 'objects') store.updateObject(update.id, update.patch as Partial<C4Object>)
    else if (update.collection === 'connections') store.updateConnection(update.id, update.patch as Partial<Connection>)
    else store.updateGroup(update.id, update.patch as Partial<Group>)
  }
}

/** Rows another tab re-applied are refreshed out of this review this long
 * after. */
export const ELSEWHERE_REFRESH_MS = 5_000
let elsewhereRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleElsewhereRefresh(): void {
  if (elsewhereRefreshTimer) clearTimeout(elsewhereRefreshTimer)
  elsewhereRefreshTimer = setTimeout(() => {
    elsewhereRefreshTimer = null
    void refreshOverrides({ force: true })
  }, ELSEWHERE_REFRESH_MS)
}

function refuse(refusal: ReapplyRefusal): null {
  useEpochOverridesStore.setState({ refusal })
  return null
}

/**
 * RE-APPLY: plan at the click against the replica, pull out
 * what changed since, write the rest as ONE undoable edit by this tab's actor
 * on the current epoch — every change tagged `{reapplyBatch}` — then resolve
 * the rows by that batch id once the batch's own carriers are durable. The
 * batch is journaled first, so a crash before the resolve is recovered by its
 * message.
 *
 * Refused: outside the diagram view, where an edit is not
 * recorded and could not be undone as one step; and while an epoch hop runs.
 */
export async function reapplyChecked(): Promise<{ batchId: string; reapplied: string[]; pulled: string[] } | null> {
  if (!ports) return null
  const s = useEpochOverridesStore.getState()
  if (s.busy) return null
  if (!ports.writable()) return refuse('hop')
  const batchId = crypto.randomUUID()
  let plan = planReapply(s.rows, s.checked, replica(), batchId)
  if (plan.reapplied.length > 0 && !undoHistory.recordable) return refuse('needsDiagram')
  const pulled = new Set([...s.pulled, ...plan.pulled])
  const checked = new Set([...s.checked].filter((id) => !plan.pulled.includes(id)))
  useEpochOverridesStore.setState({ pulled, checked, touched: new Set([...s.touched, ...plan.pulled]), statuses: rowStatuses(s.rows, replica()), refusal: null })
  if (plan.reapplied.length === 0 && plan.dismissed.length === 0) return { batchId, reapplied: [], pulled: plan.pulled }
  useEpochOverridesStore.setState({ busy: true, error: null })
  const journaled: JournaledBatch = { batchId, reapplied: plan.reapplied, dismissed: plan.dismissed }
  batches.set(batchId, journaled)
  resolvingInFlight.add(batchId)
  try {
    await journalWrite(journaled)
    if (plan.reapplied.length > 0) {
      ports.flushPending()
      // Planned BEFORE the journal's await — another tab of the same user
      // may have re-applied these very rows meanwhile
      // (its values reach this store through the sync). Planned again NOW,
      // synchronously before the edit: a row already re-applied there is
      // changed since here (its value is no longer the one the server kept)
      // and leaves this batch — that tab writes and resolves it, this one
      // neither writes it twice nor raises an alert. Idempotent across tabs.
      const fresh = planReapply(s.rows, checked, replica(), batchId)
      const elsewhere = plan.reapplied.filter((id) => !fresh.reapplied.includes(id))
      if (elsewhere.length > 0) {
        const now = useEpochOverridesStore.getState()
        useEpochOverridesStore.setState({
          pulled: new Set([...now.pulled, ...elsewhere]),
          checked: new Set([...now.checked].filter((id) => !elsewhere.includes(id))),
          touched: new Set([...now.touched, ...elsewhere]),
          statuses: rowStatuses(s.rows, replica()),
        })
        plan = { ...fresh, dismissed: plan.dismissed, pulled: [...plan.pulled, ...elsewhere] }
        journaled.reapplied = plan.reapplied
        // The slot names only this batch's rows from now on — a recovery
        // after a crash before
        // the next write never resolves the other tab's rows in this batch's
        // name. Not awaited: nothing may await between the plan and the edit.
        void journalWrite(journaled).catch(() => undefined)
        // The other tab resolves them; their lines leave this review at a
        // refresh, which nothing else schedules (no timer, no hop).
        scheduleElsewhereRefresh()
      }
    }
    if (plan.reapplied.length === 0 && plan.dismissed.length === 0) {
      await journalDrop(batchId)
      return { batchId, reapplied: [], pulled: plan.pulled }
    }
    if (plan.reapplied.length > 0) {
      // `recordable` checked AGAIN, synchronously before the edit — the
      // view may have left the
      // diagram during the journal's await. `undoHistory.wrap` applies an
      // action even with no scope (it is only not recorded), so the edit
      // would be written and the refusal would say "nothing was changed".
      // Refused BEFORE anything is written.
      if (!undoHistory.recordable) {
        await journalDrop(batchId)
        return refuse('needsDiagram')
      }
      // Sealed first, and the top of the stack compared after:
      // the tag goes on THIS edit's entry or on nothing.
      undoHistory.seal()
      const before = undoHistory.top()
      applyBatchEdit(plan)
      const after = undoHistory.top()
      if (after === null || after === before) {
        // Nothing to undo was recorded: nothing is resolved, the journal
        // goes, and the user is told in words, not with the
        // internal reason.
        await journalDrop(batchId)
        return refuse('notRecorded')
      }
      undoHistory.tagLastEntry(`reapply:${batchId}`)
      const carriers = ports.flushTagged(reapplyMessage(batchId))
      // What carries it, with its heads: a recovery that no
      // longer finds the message asks the server for these heads.
      journaled.carriers = ports.carrierHeads(carriers)
      if (!undoneBeforeResolve.has(batchId)) await journalWrite(journaled).catch(() => undefined)
      // A flush that wrote NOTHING did not write the batch (an edit left in
      // the local journal, say): never "durable".
      const durable = carriers.length > 0 && await ports.whenDurable(carriers, DURABLE_TIMEOUT_MS)
      // Undone while it became durable: nothing to resolve; its
      // rows stay pending, as an undone batch's do.
      if (undoneBeforeResolve.has(batchId)) return { batchId, reapplied: [], pulled: plan.pulled }
      // NOT durable in time: the journal STAYS, nothing is
      // resolved — the next review recovers it.
      if (!durable) throw new Error('the re-applied edit is not durable yet; it is journaled and will be resolved later')
    }
    await resolveOverrides({ batchId, reapplied: plan.reapplied, dismissed: plan.dismissed })
    await journalDrop(batchId)
    useEpochOverridesStore.setState({ lastBatch: journaled })
    resolvingInFlight.delete(batchId)
    await refreshOverrides({ force: true })
    return { batchId, reapplied: plan.reapplied, pulled: plan.pulled }
  } catch (error) {
    useEpochOverridesStore.setState({ error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    resolvingInFlight.delete(batchId)
    useEpochOverridesStore.setState({ busy: false })
  }
}

/** Discard every row: one batch, nothing written. */
export async function dismissAll(): Promise<void> {
  const s = useEpochOverridesStore.getState()
  if (s.rows.length === 0 || s.busy) return
  const batchId = crypto.randomUUID()
  const dismissed = s.rows.map((r) => r.id)
  batches.set(batchId, { batchId, reapplied: [], dismissed })
  useEpochOverridesStore.setState({ busy: true })
  try {
    await resolveOverrides({ batchId, reapplied: [], dismissed })
    useEpochOverridesStore.setState({ lastDiscard: batchId })
    await refreshOverrides({ force: true })
  } catch (error) {
    useEpochOverridesStore.setState({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    useEpochOverridesStore.setState({ busy: false })
  }
}

/** Undo "Discard my edits": the rows return to pending. */
export async function undoDiscard(): Promise<void> {
  const batchId = useEpochOverridesStore.getState().lastDiscard
  if (!batchId) return
  useEpochOverridesStore.setState({ lastDiscard: null })
  try {
    await resolveOverrides({ revert: batchId })
    await refreshOverrides({ force: true })
  } catch (error) {
    useEpochOverridesStore.setState({ error: error instanceof Error ? error.message : String(error) })
  }
}

/** UNDO of a batch: its rows return to `pending`, the notice shows them
 * again — or, undone before its resolve, it is never resolved. REDO
 * re-applies them under a NEW batch id, journaled, and
 * resolves only once its carriers are durable. */
function onTaggedStep(tag: string, direction: 'undo' | 'redo'): string | void {
  if (!tag.startsWith('reapply:')) return
  const batchId = tag.slice('reapply:'.length)
  const batch = batches.get(batchId)
  if (direction === 'undo') {
    // The undo that cancels a redo refused during a hop: that batch was
    // already undone and reverted; nothing more to do.
    if (cancellingRedo.delete(batchId)) return
    undoneBeforeResolve.add(batchId)
    // Its journal goes too: a reload must not resolve, as
    // re-applied, a batch the user undid before its resolve.
    void journalDrop(batchId)
      .then(() => resolveOverrides({ revert: batchId }))
      .then(() => refreshOverrides({ force: true }))
      .catch((error) => useEpochOverridesStore.setState({ error: error instanceof Error ? error.message : String(error) }))
    return
  }
  if (!batch || !ports) return
  // A redo during a hop: its write could land on the epoch
  // being left, untagged. It is REFUSED for real:
  // the history has already redone the store edit, so it is undone again
  // right after this step — the entry goes back on the redo stack, the store
  // is as before the redo, and "try again in a moment" is what happened.
  if (!ports.writable()) {
    useEpochOverridesStore.setState({ refusal: 'hop' })
    const redone = undoHistory.top()
    cancellingRedo.add(batchId)
    queueMicrotask(() => {
      if (redone === null || undoHistory.top() !== redone || !undoHistory.undo()) cancellingRedo.delete(batchId)
    })
    return
  }
  const next = crypto.randomUUID()
  const redone: JournaledBatch = { batchId: next, reapplied: batch.reapplied, dismissed: batch.dismissed }
  batches.set(next, redone)
  resolvingInFlight.add(next)
  const p = ports
  // Journaled BEFORE the tagged flush: issued first, so the
  // KV writes land in that order.
  const journaling = journalWrite(redone).catch(() => undefined)
  const carriers = p.flushTagged(reapplyMessage(next))
  redone.carriers = p.carrierHeads(carriers)
  void journaling
    .then(() => (undoneBeforeResolve.has(next) ? undefined : journalWrite(redone).catch(() => undefined)))
    .then(() => carriers.length > 0 && p.whenDurable(carriers, DURABLE_TIMEOUT_MS))
    .then(async (durable) => {
      if (!durable || undoneBeforeResolve.has(next)) return
      await resolveOverrides({ batchId: next, reapplied: redone.reapplied, dismissed: redone.dismissed })
      await journalDrop(next)
      await refreshOverrides({ force: true })
    })
    .catch((error) => useEpochOverridesStore.setState({ error: error instanceof Error ? error.message : String(error) }))
    .finally(() => resolvingInFlight.delete(next))
  return `reapply:${next}`
}

/** Entity label for a group: the entity's current name, else its id. */
export function entityLabel(group: EntityGroup): string {
  if (!group.collection || !group.entityId) return group.key
  const entity = replica().entity(group.collection, group.entityId) as { name?: string; label?: string } | undefined
  if (entity?.name) return entity.name
  if (entity?.label) return entity.label
  const late = group.rows.find((r) => overrideTarget(r)?.field.length === 0)?.lateValue as { name?: string } | undefined
  return late?.name ?? group.entityId
}

/** A name for an entity id (the "needs" note): object, then group. */
export function entityName(id: string): string {
  const view = replica()
  const entity = (view.entity('objects', id) ?? view.entity('groups', id)) as { name?: string } | undefined
  if (entity?.name) return entity.name
  const row = useEpochOverridesStore.getState().rows.find((r) => r.entityId === id && overrideTarget(r)?.field.length === 0)
  return (row?.lateValue as { name?: string } | undefined)?.name ?? id
}

export function installEpochOverrides(next: EpochOverridePorts): () => void {
  ports = next
  untag?.()
  untag = undoHistory.onTaggedStep(onTaggedStep)
  void refreshOverrides()
  return () => {
    if (ports === next) ports = null
    if (elsewhereRefreshTimer) clearTimeout(elsewhereRefreshTimer)
    elsewhereRefreshTimer = null
    fetchController?.abort()
    fetchController = null
    // The refresh in flight is the workspace being left's: a reinstall must
    // start its own, not be handed this one.
    refreshing = null
    refreshingToken = null
    untag?.()
    untag = null
    batches.clear()
    undoneBeforeResolve.clear()
    cancellingRedo.clear()
    resolvingInFlight.clear()
    fetchedEntities = { objects: new Map(), connections: new Map(), groups: new Map() }
    // EVERYTHING of the workspace being left.
    useEpochOverridesStore.setState({
      rows: [], statuses: new Map(), checked: new Set(), touched: new Set(), pulled: new Set(), panelOpen: false, highlight: false,
      noticeCollapsed: false, compact: false, busy: false, error: null, refusal: null, lastBatch: null, lastDiscard: null,
    })
  }
}
