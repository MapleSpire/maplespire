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

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { isDraft, original } from 'immer'
import type { C4Object, Connection, Diagram, Flow, FlowStep, Group, Tag, SelectedItem, Domain, Comment, DecisionRecord, Position, Size, ConnectionShape } from '../types'
import { generateId } from '../lib/utils'
import { LEGACY_COMMENT_AUTHOR, type CommentAuthorship } from '../lib/comments/authorship'
import { assertTechnologyUsageIdentityPreserved } from '../lib/technologyUsage'
import { assignTag, unassignTag, orderedTagIds } from '../lib/tags/assignments'
import { buildDuplicateDiagram, buildDuplicateFlows } from '../lib/diagrams/duplicate'
import { useUIStore } from './uiStore'
import {
  pendingPlacementIntents,
  persistPlacementIntentsNow,
  schedulePersistPlacementIntents,
  type PendingGroupPlacement,
  type PendingObjectPlacement,
  type PlacementIntentBatch,
  type PlacementLayoutSpace,
} from '../lib/automerge/placementIntents'
import { currentWorkspaceRef, subscribeWorkspaceRef, workspaceRefKey } from '../lib/automerge/workspace'
import { workspaceKvStore } from '../lib/modelQuery/kvStore'

export interface ObjectPlacementUpdate {
  id: string
  position: Position
  size?: Size
}

export interface GroupPlacementUpdate {
  id: string
  position?: Position
  size?: Size
  autoSize?: boolean
}

export interface ConnectionBatchUpdate {
  id: string
  data: Partial<Connection>
}

function rememberTagSnapshot(registry: Tag[], snapshot?: Tag): void {
  if (!snapshot) return
  const existing = registry.find((entry) => entry.tagId === snapshot.tagId)
  if (existing) Object.assign(existing, snapshot)
  else registry.push(snapshot)
}

// ---------------------------------------------------------------------------
// DiagramIndex — O(1) lookup maps maintained by a subscriber outside Zustand.
// The bridge calls useModelStore.setState() wholesale (bypassing immer), so the
// index is rebuilt via subscribeWithSelector whenever the four source arrays
// change by reference identity.
// ---------------------------------------------------------------------------

export interface DiagramIndex {
  /** diagramId -> Set of objectIds in that diagram */
  objectToDiagramIds:    Map<string, Set<string>>
  /** diagramId -> Set of connectionIds in that diagram */
  connectionToDiagramIds: Map<string, Set<string>>
  /** diagramId -> Set of groupIds in that diagram */
  groupToDiagramIds:     Map<string, Set<string>>
  /** diagramId -> the diagram. Without it, resolving an id found in one of the
   *  reverse maps above costs a `diagrams.find` — an O(D) scan per posting,
   *  which is what made a 500-shape canvas O(N·D) on a 50k-diagram landscape. */
  diagramById:           Map<string, Diagram>
  /** objectId -> Set of diagrams that DETAIL that object (`parentObjectId`).
   *  The drill-down direction, and the only relation kind that had no reverse
   *  map: both the `detail` and `parent` buckets used to scan every diagram. */
  diagramIdsByParentObjectId: Map<string, Set<string>>
  objectById:            Map<string, C4Object>
  connectionById:        Map<string, Connection>
  groupById:             Map<string, Group>
  /** endpoint id (object OR group) -> connections leaving it. Avoids O(all) scans. */
  connectionsByFromId:   Map<string, Connection[]>
  /** endpoint id (object OR group) -> connections arriving at it. */
  connectionsByToId:     Map<string, Connection[]>
  /** parentId -> direct child objects. Backs descendant/closure walks. */
  childrenByParentId:    Map<string, C4Object[]>
  /** Complete team facet for the resident model, derived during the existing
   * object-index build so filter popovers never rescan every object. */
  teamIds:               string[]
}

// The index is split into per-source builders so the subscriber can rebuild only
// the maps whose source array actually changed (incremental index), instead of
// rebuilding all nine on every mutation.

type DiagramMaps = Pick<
  DiagramIndex,
  'objectToDiagramIds' | 'connectionToDiagramIds' | 'groupToDiagramIds'
  | 'diagramById' | 'diagramIdsByParentObjectId'
>
type ObjectMaps = Pick<DiagramIndex, 'objectById' | 'childrenByParentId' | 'teamIds'>
type ConnectionMaps = Pick<DiagramIndex, 'connectionById' | 'connectionsByFromId' | 'connectionsByToId'>
type GroupMaps = Pick<DiagramIndex, 'groupById'>

/** Diagram membership reverse maps (derived from each diagram's composition). */
function buildDiagramMaps(diagrams: Diagram[]): DiagramMaps {
  const objectToDiagramIds     = new Map<string, Set<string>>()
  const connectionToDiagramIds = new Map<string, Set<string>>()
  const groupToDiagramIds      = new Map<string, Set<string>>()
  const diagramById            = new Map<string, Diagram>()
  const diagramIdsByParentObjectId = new Map<string, Set<string>>()
  for (const d of diagrams) {
    diagramById.set(d.id, d)
    if (d.parentObjectId) {
      let s = diagramIdsByParentObjectId.get(d.parentObjectId)
      if (!s) { s = new Set(); diagramIdsByParentObjectId.set(d.parentObjectId, s) }
      s.add(d.id)
    }
    for (const oid of d.objectIds) {
      let s = objectToDiagramIds.get(oid)
      if (!s) { s = new Set(); objectToDiagramIds.set(oid, s) }
      s.add(d.id)
    }
    for (const cid of d.connectionIds) {
      let s = connectionToDiagramIds.get(cid)
      if (!s) { s = new Set(); connectionToDiagramIds.set(cid, s) }
      s.add(d.id)
    }
    for (const gid of d.groupIds) {
      let s = groupToDiagramIds.get(gid)
      if (!s) { s = new Set(); groupToDiagramIds.set(gid, s) }
      s.add(d.id)
    }
  }
  return {
    objectToDiagramIds, connectionToDiagramIds, groupToDiagramIds,
    diagramById, diagramIdsByParentObjectId,
  }
}

/** Object id-map + parent→children map (derived from the objects array). */
function buildObjectMaps(objects: C4Object[]): ObjectMaps {
  const objectById = new Map<string, C4Object>()
  const childrenByParentId = new Map<string, C4Object[]>()
  const teamIds = new Set<string>()
  for (const o of objects) {
    objectById.set(o.id, o)
    for (const teamId of [...(o.ownerTeamIds ?? []), ...(o.teamIds ?? [])]) {
      if (teamId) teamIds.add(teamId)
    }
    if (!o.parentId) continue
    let ch = childrenByParentId.get(o.parentId)
    if (!ch) { ch = []; childrenByParentId.set(o.parentId, ch) }
    ch.push(o)
  }
  return { objectById, childrenByParentId, teamIds: [...teamIds].sort() }
}

/** Connection id-map + endpoint reverse maps (derived from the connections array). */
function buildConnectionMaps(connections: Connection[]): ConnectionMaps {
  const connectionById = new Map<string, Connection>(connections.map((c) => [c.id, c]))
  const connectionsByFromId = new Map<string, Connection[]>()
  const connectionsByToId   = new Map<string, Connection[]>()
  for (const c of connections) {
    let f = connectionsByFromId.get(c.fromId)
    if (!f) { f = []; connectionsByFromId.set(c.fromId, f) }
    f.push(c)
    let t = connectionsByToId.get(c.toId)
    if (!t) { t = []; connectionsByToId.set(c.toId, t) }
    t.push(c)
  }
  return { connectionById, connectionsByFromId, connectionsByToId }
}

/** Group id-map (derived from the groups array). */
function buildGroupMaps(groups: Group[]): GroupMaps {
  return { groupById: new Map<string, Group>(groups.map((g) => [g.id, g])) }
}

function buildDiagramIndex(
  diagrams: Diagram[],
  objects: C4Object[],
  connections: Connection[],
  groups: Group[],
): DiagramIndex {
  return {
    ...buildDiagramMaps(diagrams),
    ...buildObjectMaps(objects),
    ...buildConnectionMaps(connections),
    ...buildGroupMaps(groups),
  }
}

/** Module-level singleton updated by the subscriber below. */
let _diagramIndex: DiagramIndex = buildDiagramIndex([], [], [], [])

/** Always returns the current (post-mutation) index. */
export function getDiagramIndex(): DiagramIndex {
  return _diagramIndex
}

// ---------------------------------------------------------------------------
// Debounced syncAllLowerConnections helper.
// Cancels any pending timer and re-schedules; the actual work runs once the
// burst of mutations settles (trailing edge, 100 ms).
//
// SCOPED by the connection delta when the caller knows it (connect, reconnect,
// delete — `endpointIds`): only the diagrams on which one of those endpoints
// has a visible representative are re-derived (`diagramsReachingEndpoints`).
// Measured 2026-10-11 (a Playwright connect-freeze probe, never committed; dev landscape of 739
// diagrams / 12 421 objects / 6 929 connections, real mouse on the 2D canvas
// and the 3D board): the unscoped pass re-derived EVERY diagram — each one an
// O(objects + connections + all memberships) rebuild plus its own store
// commit and index rebuild — as ONE 4 030-4 280 ms task 100 ms after every
// connect, with the save badge already showing. A call without endpoint ids
// (any caller that cannot name its delta) keeps the full pass, and a full
// request in the same burst wins over a scoped one.
//
// The diagrams a mutation reaches are resolved at SCHEDULE time against the
// index as it stands then — the mutators pass the reach of the OLD endpoints
// and of the touched connection ids, read before their own commit, and
// scheduleSyncAll adds the reach of every endpoint it is given — and again at
// fire time for the endpoint ids collected over the burst. Resolving only at
// fire time missed a diagram reached through an endpoint deleted later in the
// same burst (delete A→B, then delete A and B: neither id resolves any more,
// so the parent diagram's roll-up stayed stale). The two schedule-time
// resolutions overlap for the old endpoints: removing either one alone leaves
// every test green, removing both turns the burst test red (mutation battery,
// 2026-10-11). The connection-id holders are defence in depth: no input found
// reaches a diagram through them that the endpoints do not also reach.
//
// The pass itself runs in slices of LOWER_SYNC_SLICE_MS (`runLowerSlice`), so a
// hub object reaching hundreds of diagrams yields between slices instead of
// holding the main thread. A SCOPED pass is followed by a low-priority idle
// HEAL over every diagram (`scheduleLowerHeal`): the unscoped pass used to
// repair, incidentally, roll-ups left stale by paths that never re-derive
// (remote projection, deleteObject, deleteSelectedItems, importModel, group
// membership edits), and the scoped pass alone no longer does.
// ---------------------------------------------------------------------------
let _syncAllTimer: ReturnType<typeof setTimeout> | null = null
let _syncAllFull = false
let _syncScopeEndpointIds: Set<string> | null = null
let _syncScopeDiagramIds: Set<string> | null = null
let _syncWorkspaceKey: string | null = null

const LOWER_SYNC_DEBOUNCE_MS = 100
/** Work per slice before yielding; the first diagram of a slice that did not
 * have to rebuild its context always runs, so a pass makes progress whatever
 * the clock says. The commit (and the store subscribers it wakes) comes on top. */
const LOWER_SYNC_SLICE_MS = 8
/** rIC `timeout`: a board that never goes idle (a 3D scene animating every
 * frame) still gets its heal, as an ordinary task. */
const LOWER_HEAL_IDLE_TIMEOUT_MS = 2_000

type LowerPassKind = 'scoped' | 'full' | 'heal'

interface LowerPass {
  kind: LowerPassKind
  /** Diagram ids in processing order; null = every diagram, read at the first slice. */
  queue: string[] | null
  pos: number
  ctx: LowerSyncContext | null
  workspaceKey: string
  /** Cancels the slice this pass has scheduled, if any. */
  cancelScheduled: (() => void) | null
}

let _priorityPass: LowerPass | null = null
let _healPass: LowerPass | null = null
let lowerHealEnabled = true
let lowerSyncNow: () => number = () => performance.now()
let lowerSyncTrace: ((diagramId: string, kind: LowerPassKind) => void) | null = null

const currentWorkspaceKey = (): string => workspaceRefKey(currentWorkspaceRef())

let lowerScopeFailureLogged = false

/**
 * Run a SCOPE computation (which diagrams a connection mutation reaches).
 * These run synchronously inside the user's own action, before or after its
 * commit, and read model data that may come from a foreign or corrupt shard
 * (a group whose `objectIds` is not an array…). On ANY throw: null, which every
 * caller turns into a full pass — the user's edit must land whatever the scope
 * computation thinks of the model. Logged once per session.
 */
function tryLowerScope<T>(compute: () => T): T | null {
  try {
    return compute()
  } catch (error) {
    if (!lowerScopeFailureLogged) {
      lowerScopeFailureLogged = true
      console.warn('[lower-sync] scope computation failed; falling back to a full roll-up pass', error)
    }
    return null
  }
}

function scheduleSyncAll(
  get: () => ModelState,
  endpointIds?: readonly string[],
  reachedDiagramIds?: Iterable<string>,
): void {
  // A newer mutation supersedes the heal; the pass it schedules re-arms one.
  cancelLowerHeal()
  const workspaceKey = currentWorkspaceKey()
  if (_syncWorkspaceKey !== null && _syncWorkspaceKey !== workspaceKey) resetLowerSync()
  _syncWorkspaceKey = workspaceKey
  // Eager reach of the endpoints too: an endpoint deleted later in this burst
  // no longer resolves at fire time. A reach that cannot be computed falls
  // back to the full pass.
  const eager = endpointIds === undefined || _syncAllFull
    ? null
    : tryLowerScope(() => diagramsReachingEndpoints(get(), endpointIds))
  if (endpointIds === undefined || eager === null) {
    _syncAllFull = true
    _syncScopeEndpointIds = null
    _syncScopeDiagramIds = null
  } else {
    _syncScopeEndpointIds ??= new Set()
    for (const id of endpointIds) _syncScopeEndpointIds.add(id)
    _syncScopeDiagramIds ??= new Set()
    for (const id of reachedDiagramIds ?? []) _syncScopeDiagramIds.add(id)
    for (const id of eager) _syncScopeDiagramIds.add(id)
  }
  if (_syncAllTimer !== null) {
    clearTimeout(_syncAllTimer)
  }
  _syncAllTimer = setTimeout(fireLowerSync, LOWER_SYNC_DEBOUNCE_MS)
}

function fireLowerSync(): void {
  _syncAllTimer = null
  const full = _syncAllFull
  const endpoints = _syncScopeEndpointIds
  const reached = _syncScopeDiagramIds
  const workspaceKey = _syncWorkspaceKey ?? currentWorkspaceKey()
  _syncAllFull = false
  _syncScopeEndpointIds = null
  _syncScopeDiagramIds = null
  _syncWorkspaceKey = null
  if (workspaceKey !== currentWorkspaceKey()) return
  // This pass re-arms the heal when it is done.
  cancelLowerHeal()
  const state = useModelStore.getState()
  const fireReach = full || endpoints === null
    ? []
    : tryLowerScope(() => diagramsReachingEndpoints(state, endpoints))
  const isFull = full || (endpoints === null && reached === null) || fireReach === null
  let targets: string[]
  if (isFull) {
    targets = state.diagrams.map((diagram) => diagram.id)
  } else {
    const wanted = new Set(reached ?? [])
    for (const id of fireReach ?? []) wanted.add(id)
    // What an in-flight pass had not reached yet is still owed.
    const inFlight = _priorityPass
    if (inFlight?.queue) for (let i = inFlight.pos; i < inFlight.queue.length; i++) wanted.add(inFlight.queue[i])
    targets = wanted.size === 0 ? [] : state.diagrams.filter((d) => wanted.has(d.id)).map((d) => d.id)
  }
  cancelPriorityPass()
  _priorityPass = {
    kind: isFull ? 'full' : 'scoped',
    queue: targets,
    pos: 0,
    ctx: null,
    workspaceKey,
    cancelScheduled: null,
  }
  runPriorityPass()
}

function runPriorityPass(): void {
  const pass = _priorityPass
  if (!pass) return
  pass.cancelScheduled = null
  const outcome = runLowerSlice(pass, LOWER_SYNC_SLICE_MS)
  if (_priorityPass !== pass) return
  if (outcome === 'more') {
    const timer = setTimeout(runPriorityPass, 0)
    pass.cancelScheduled = () => clearTimeout(timer)
    return
  }
  _priorityPass = null
  // A request already debounced will schedule its own pass, and that pass
  // the heal: arming one now would only be cancelled by it.
  if (outcome === 'done' && pass.kind === 'scoped' && _syncAllTimer === null) scheduleLowerHeal(pass.workspaceKey)
}

function cancelPriorityPass(): void {
  if (!_priorityPass) return
  _priorityPass.cancelScheduled?.()
  _priorityPass = null
}

function scheduleLowerHeal(workspaceKey: string): void {
  cancelLowerHeal()
  if (!lowerHealEnabled) return
  const pass: LowerPass = { kind: 'heal', queue: null, pos: 0, ctx: null, workspaceKey, cancelScheduled: null }
  _healPass = pass
  armLowerHealSlice(pass)
}

function armLowerHealSlice(pass: LowerPass): void {
  pass.cancelScheduled = whenLowerSyncIdle((budgetMs) => {
    if (_healPass !== pass) return
    pass.cancelScheduled = null
    const outcome = runLowerSlice(pass, budgetMs)
    // The slice's own commit may have woken code that superseded this heal.
    if (_healPass !== pass) return
    if (outcome === 'more') armLowerHealSlice(pass)
    else _healPass = null
  })
}

function cancelLowerHeal(): void {
  if (!_healPass) return
  _healPass.cancelScheduled?.()
  _healPass = null
}

interface IdleDeadlineLike {
  didTimeout: boolean
  timeRemaining: () => number
}

/** requestIdleCallback with a setTimeout fallback (Safari, Node). The budget is
 * the idle period left, capped at LOWER_SYNC_SLICE_MS. */
function whenLowerSyncIdle(run: (budgetMs: number) => void): () => void {
  const host = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof host.requestIdleCallback === 'function') {
    const id = host.requestIdleCallback((deadline) => {
      const remaining = deadline.didTimeout ? LOWER_SYNC_SLICE_MS : deadline.timeRemaining()
      run(Math.max(1, Math.min(LOWER_SYNC_SLICE_MS, remaining)))
    }, { timeout: LOWER_HEAL_IDLE_TIMEOUT_MS })
    return () => host.cancelIdleCallback?.(id)
  }
  const timer = setTimeout(() => run(LOWER_SYNC_SLICE_MS), 0)
  return () => clearTimeout(timer)
}

/** Drop everything pending: the debounced request, an in-flight pass, the heal. */
function resetLowerSync(): void {
  if (_syncAllTimer !== null) clearTimeout(_syncAllTimer)
  _syncAllTimer = null
  _syncAllFull = false
  _syncScopeEndpointIds = null
  _syncScopeDiagramIds = null
  _syncWorkspaceKey = null
  cancelPriorityPass()
  cancelLowerHeal()
}

// A workspace switch replaces the whole model: nothing collected for, or
// derived against, the previous one may run against the next. (A ref primed
// without notification is still caught: every slice re-checks the key.)
subscribeWorkspaceRef(() => resetLowerSync())

/**
 * One slice of a pass: (re)build the context if the store moved under it,
 * derive diagrams until the budget is spent, commit once.
 *
 * A context gone stale (the store moved between two slices) is rebuilt and
 * the pass KEEPS its position, heal included: restarting the heal from the
 * first diagram on every foreign change starved it for as long as the changes
 * kept coming (a remote peer dragging replaces `objects` many times a
 * second). The price: a diagram derived before the change, and a diagram
 * added during the heal, may lag until the next heal.
 *
 * A slice that throws drops its pass — no model-sized context retained, no
 * pass left registered as running — and the error propagates to the task
 * that ran it.
 */
function runLowerSlice(pass: LowerPass, budgetMs: number): 'more' | 'done' | 'cancelled' {
  if (pass.workspaceKey !== currentWorkspaceKey()) return 'cancelled'
  // Nothing (left) to derive: no context to build.
  if (pass.queue !== null && pass.pos >= pass.queue.length) return 'done'
  let completed = false
  try {
    const started = lowerSyncNow()
    const state = useModelStore.getState()
    let rebuilt = false
    if (pass.ctx === null || !lowerSyncContextCurrent(pass.ctx, state)) {
      pass.ctx = buildLowerSyncContext(state)
      rebuilt = true
    }
    if (pass.queue === null) {
      pass.queue = state.diagrams.map((diagram) => diagram.id)
      pass.pos = 0
    }
    let derived = 0
    while (pass.pos < pass.queue.length) {
      // A slice that spent its budget on the (re)build yields before deriving;
      // the next one finds the context current and derives at least one.
      if ((derived > 0 || rebuilt) && lowerSyncNow() - started >= budgetMs) break
      const diagramId = pass.queue[pass.pos++]
      lowerSyncTrace?.(diagramId, pass.kind)
      deriveLowerConnections(pass.ctx, diagramId)
      derived++
    }
    const committed = commitLowerSync(pass.ctx)
    if (import.meta.env.DEV) {
      // Dev-only measurement hook for the Playwright connect-freeze probe
      // (never committed): a page that defines the array gets one entry per slice.
      const probe = (globalThis as { __lowerSyncProbe?: unknown[] }).__lowerSyncProbe
      if (Array.isArray(probe)) {
        probe.push({ kind: pass.kind, at: started, ms: lowerSyncNow() - started, derived, committed, rebuilt, left: pass.queue.length - pass.pos })
      }
    }
    completed = true
    return pass.pos < pass.queue.length ? 'more' : 'done'
  } finally {
    if (!completed) {
      pass.ctx = null
      pass.queue = []
      pass.pos = 0
      pass.cancelScheduled?.()
      pass.cancelScheduled = null
      if (_priorityPass === pass) _priorityPass = null
      if (_healPass === pass) _healPass = null
    }
  }
}

// ---------------------------------------------------------------------------
// Lower roll-up derivation. `syncLowerConnections(diagramId)` re-derives ONE
// diagram's roll-up; everything it reads except that diagram's own membership
// is the same for every diagram of a pass — the object, group and connection
// id-maps, the lowers by endpoint pair, which connection ids the diagrams
// reference — so a pass builds them ONCE and keeps them current across its own
// derivations instead of rebuilding them per diagram (the per-diagram rebuild
// is what made a pass O(diagrams × model)). Derivations are applied to the
// context immediately and committed to the store once per slice.
//
// Measured 2026-10-11 (Playwright connect-freeze and 3D heal-commit probes, never committed;
// dev landscape of 745 diagrams / 12 482 objects / ~7 020 connections, real
// mouse, 3 runs each in 2D and 3D): a connect's scoped pass is one 2.8-4.9 ms
// slice; the heal that follows covers every diagram in 84-123 slices of at
// most 8.7-9.9 ms (5.6-15.1 ms for a slice that commits), 651-732 ms of CPU
// in all when nothing is stale, spread over 1.4-4.4 s. With the original
// upward ancestor walk per direct connection instead of the downward
// `visible` map, the same heal took 1.47-2.37 s of CPU in 169-243 slices of
// up to 13.7 ms.
// ---------------------------------------------------------------------------

interface LowerSyncContext {
  /** The store arrays this context reflects (after its own commits). */
  diagrams: Diagram[]
  objects: C4Object[]
  groups: Group[]
  connections: Connection[]
  /** parentId -> child object ids, in store order. */
  childrenByParentId: Map<string, string[]>
  groupMap: Map<string, Group>
  connectionMap: Map<string, Connection>
  /** Every non-lower connection, in store order. A lower pass never changes it. */
  directConnections: Connection[]
  /** Lowers by endpoint pair, in store order — the LAST one is the one reused. */
  lowersByPair: Map<string, Connection[]>
  /** connection id -> how many diagrams reference it (once per diagram). */
  refCount: Map<string, number>
  diagramIndexById: Map<string, number>
  /** Derived, not yet committed. */
  pendingConnectionIds: Map<string, string[]>
  pruned: Set<string>
  added: Connection[]
}

type LowerSyncSource = Pick<ModelState, 'diagrams' | 'objects' | 'groups' | 'connections'>

const lowerPairKey = (fromId: string, toId: string): string => `${fromId}→${toId}`

function lowerSyncContextCurrent(ctx: LowerSyncContext, state: LowerSyncSource): boolean {
  return ctx.diagrams === state.diagrams
    && ctx.objects === state.objects
    && ctx.groups === state.groups
    && ctx.connections === state.connections
}

function buildLowerSyncContext(source: LowerSyncSource): LowerSyncContext {
  const { diagrams, objects, groups, connections } = source
  const childrenByParentId = new Map<string, string[]>()
  for (const obj of objects) {
    if (!obj.parentId) continue
    const siblings = childrenByParentId.get(obj.parentId)
    if (siblings) siblings.push(obj.id)
    else childrenByParentId.set(obj.parentId, [obj.id])
  }
  const groupMap = new Map<string, Group>()
  for (const grp of groups) groupMap.set(grp.id, grp)
  const connectionMap = new Map<string, Connection>()
  const directConnections: Connection[] = []
  const lowersByPair = new Map<string, Connection[]>()
  for (const conn of connections) {
    connectionMap.set(conn.id, conn)
    if (conn.kind === 'lower') {
      const key = lowerPairKey(conn.fromId, conn.toId)
      const list = lowersByPair.get(key)
      if (list) list.push(conn)
      else lowersByPair.set(key, [conn])
    } else {
      directConnections.push(conn)
    }
  }
  const refCount = new Map<string, number>()
  const countedIn = new Map<string, number>()
  const diagramIndexById = new Map<string, number>()
  for (let i = 0; i < diagrams.length; i++) {
    const diagram = diagrams[i]
    if (!diagramIndexById.has(diagram.id)) diagramIndexById.set(diagram.id, i)
    for (const cid of diagram.connectionIds) {
      if (countedIn.get(cid) === i) continue
      countedIn.set(cid, i)
      refCount.set(cid, (refCount.get(cid) ?? 0) + 1)
    }
  }
  return {
    diagrams, objects, groups, connections,
    childrenByParentId, groupMap, connectionMap, directConnections, lowersByPair, refCount, diagramIndexById,
    pendingConnectionIds: new Map(), pruned: new Set(), added: [],
  }
}

function adjustRefCount(ctx: LowerSyncContext, ids: readonly string[], delta: 1 | -1): void {
  for (const cid of new Set(ids)) {
    const next = (ctx.refCount.get(cid) ?? 0) + delta
    if (next > 0) ctx.refCount.set(cid, next)
    else ctx.refCount.delete(cid)
  }
}

/**
 * Re-derive one diagram's lower connections against `ctx` and apply the
 * result to it. False when nothing changes (same membership in the same
 * order, nothing added or pruned) — the diagram is then not committed at all.
 */
function deriveLowerConnections(ctx: LowerSyncContext, diagramId: string): boolean {
  const index = ctx.diagramIndexById.get(diagramId)
  if (index === undefined) return false
  const diagram = ctx.diagrams[index]
  const currentIds = ctx.pendingConnectionIds.get(diagramId) ?? diagram.connectionIds
  const diagramObjectSet = new Set(diagram.objectIds)

  // Membership map: objectId -> containing groupId (only for groups on this diagram)
  const objectToGroup = new Map<string, string>()
  for (const groupId of diagram.groupIds) {
    const group = ctx.groupMap.get(groupId)
    if (group) {
      for (const oid of group.objectIds) objectToGroup.set(oid, groupId)
    }
  }

  // Nearest visible ancestor-or-self on this diagram, for every object that
  // has one: walk DOWN from each object on the diagram, stopping at a child
  // that is itself on the diagram (it is its own nearest). Equivalent to
  // walking up from each endpoint (the original `findVisibleEndpoint`), which
  // ran once per direct connection per diagram. `visible.has` doubles as the
  // visited set, so a parent cycle cannot loop here.
  const visible = new Map<string, string>()
  for (const id of diagramObjectSet) visible.set(id, id)
  for (const root of diagramObjectSet) {
    const children = ctx.childrenByParentId.get(root)
    if (!children) continue
    const stack = children.slice()
    while (stack.length > 0) {
      const id = stack.pop()!
      if (visible.has(id)) continue
      visible.set(id, root)
      const grandchildren = ctx.childrenByParentId.get(id)
      if (grandchildren) for (const child of grandchildren) stack.push(child)
    }
  }
  const findVisibleEndpoint = (objectId: string): string | null =>
    visible.get(objectId) ?? objectToGroup.get(objectId) ?? null

  // Lower connections currently attached to this diagram, and the diagram's
  // NON-lower connections (the needed lower ones are re-attached below,
  // reusing the same objects, hence the same ids).
  const existingLowerIds: string[] = []
  const newConnectionIds: string[] = []
  for (const cid of currentIds) {
    if (ctx.connectionMap.get(cid)?.kind === 'lower') existingLowerIds.push(cid)
    else newConnectionIds.push(cid)
  }

  // --- Re-derive the lower connections this diagram needs. An existing lower
  // with the same endpoint pair is reused, so a still-needed one keeps its id
  // across re-syncs (deleting + recreating it invalidated a live selection —
  // the right sidebar flickered open/closed). ---
  const newConnectionIdSet = new Set(newConnectionIds)
  const seenPairs = new Set<string>()
  const usedLowerIds = new Set<string>()
  const additions: Connection[] = []

  for (const directConn of ctx.directConnections) {
    const visibleFrom = findVisibleEndpoint(directConn.fromId)
    const visibleTo = findVisibleEndpoint(directConn.toId)

    // Skip if either endpoint has no visible representative
    if (!visibleFrom || !visibleTo) continue

    // Skip if both endpoints are directly visible (direct connection already shown)
    if (visibleFrom === directConn.fromId && visibleTo === directConn.toId) continue

    // Skip if rolled-up endpoints are the same (self-loop)
    if (visibleFrom === visibleTo) continue

    const pairKey = lowerPairKey(visibleFrom, visibleTo)
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)

    const sameLowers = ctx.lowersByPair.get(pairKey)
    const existingLower = sameLowers?.[sameLowers.length - 1]
    if (existingLower) {
      if (!newConnectionIdSet.has(existingLower.id)) {
        newConnectionIds.push(existingLower.id)
        newConnectionIdSet.add(existingLower.id)
      }
      usedLowerIds.add(existingLower.id)
    } else {
      const newConn: Connection = {
        id: generateId(),
        fromId: visibleFrom,
        toId: visibleTo,
        kind: 'lower',
        type: 'dashed',
        label: '',
      }
      additions.push(newConn)
      newConnectionIds.push(newConn.id)
      newConnectionIdSet.add(newConn.id)
      usedLowerIds.add(newConn.id)
    }
  }

  // --- Prune lower connections this diagram no longer needs and that no
  // other diagram references (this one accounts for exactly one reference).
  // Reused ones are kept, so ids stay stable. ---
  const toPrune = new Set(
    existingLowerIds.filter((cid) => !usedLowerIds.has(cid) && (ctx.refCount.get(cid) ?? 0) <= 1)
  )

  // Nothing to commit: same membership in the same order, nothing added or
  // pruned. Committing anyway hands every subscriber a new `diagrams` array
  // (index rebuild, React selectors, the bridge's durable-write classifier)
  // for an identical value — once per diagram re-derived.
  if (
    additions.length === 0
    && toPrune.size === 0
    && newConnectionIds.length === currentIds.length
    && newConnectionIds.every((cid, i) => cid === currentIds[i])
  ) return false

  adjustRefCount(ctx, currentIds, -1)
  adjustRefCount(ctx, newConnectionIds, 1)
  for (const cid of toPrune) {
    const pruned = ctx.connectionMap.get(cid)
    ctx.connectionMap.delete(cid)
    ctx.pruned.add(cid)
    if (!pruned) continue
    const key = lowerPairKey(pruned.fromId, pruned.toId)
    const kept = (ctx.lowersByPair.get(key) ?? []).filter((conn) => conn.id !== cid)
    if (kept.length > 0) ctx.lowersByPair.set(key, kept)
    else ctx.lowersByPair.delete(key)
  }
  for (const addition of additions) {
    ctx.connectionMap.set(addition.id, addition)
    const key = lowerPairKey(addition.fromId, addition.toId)
    const list = ctx.lowersByPair.get(key)
    if (list) list.push(addition)
    else ctx.lowersByPair.set(key, [addition])
    ctx.added.push(addition)
  }
  ctx.pendingConnectionIds.set(diagramId, newConnectionIds)
  return true
}

/**
 * Commit what `ctx` derived since its last commit, in ONE store update.
 * Plain arrays, swapped whole: immer never drafts the large element arrays.
 * The result is the one the per-diagram commits produced in sequence — each
 * pruned lower removed, each addition appended in derivation order. Returns
 * the number of diagrams committed.
 */
function commitLowerSync(ctx: LowerSyncContext): number {
  const changed = ctx.pendingConnectionIds.size
  if (changed === 0 && ctx.pruned.size === 0 && ctx.added.length === 0) return 0
  const diagrams = ctx.diagrams.slice()
  for (const [diagramId, connectionIds] of ctx.pendingConnectionIds) {
    const index = ctx.diagramIndexById.get(diagramId)
    if (index !== undefined) diagrams[index] = { ...diagrams[index], connectionIds }
  }
  let connections: Connection[] | null = null
  if (ctx.pruned.size > 0 || ctx.added.length > 0) {
    connections = ctx.pruned.size > 0 ? ctx.connections.filter((c) => !ctx.pruned.has(c.id)) : ctx.connections.slice()
    for (const addition of ctx.added) if (!ctx.pruned.has(addition.id)) connections.push(addition)
  }
  ctx.pendingConnectionIds.clear()
  ctx.pruned.clear()
  ctx.added = []
  // Recorded BEFORE the update: a subscriber that writes the store from inside
  // it must read as a foreign change to the next slice, not as this commit.
  ctx.diagrams = diagrams
  if (connections) ctx.connections = connections
  useModelStore.setState(connections ? { diagrams, connections } : { diagrams })
  return changed
}

function drainLowerHeal(): void {
  while (_healPass) {
    const pass = _healPass
    pass.cancelScheduled?.()
    pass.cancelScheduled = null
    if (runLowerSlice(pass, LOWER_SYNC_SLICE_MS) !== 'more' && _healPass === pass) _healPass = null
  }
}

/** Test seams: observe and drive the debounced pass and the idle heal. */
export const __lowerSyncForTest = {
  trace(fn: ((diagramId: string, kind: LowerPassKind) => void) | null): void {
    lowerSyncTrace = fn
  },
  setHealEnabled(enabled: boolean): void {
    lowerHealEnabled = enabled
    if (!enabled) cancelLowerHeal()
  },
  setClock(now: (() => number) | null): void {
    lowerSyncNow = now ?? (() => performance.now())
  },
  pending(): { debounce: boolean; priority: boolean; heal: boolean } {
    return { debounce: _syncAllTimer !== null, priority: _priorityPass !== null, heal: _healPass !== null }
  },
  /** Run the debounced request, the pass and the heal to completion, now. */
  drain(): void {
    if (_syncAllTimer !== null) {
      clearTimeout(_syncAllTimer)
      fireLowerSync()
    }
    while (_priorityPass) {
      _priorityPass.cancelScheduled?.()
      runPriorityPass()
    }
    drainLowerHeal()
  },
  /** Run ONLY the idle heal (if one is armed) to completion. */
  runHeal(): void {
    drainLowerHeal()
  },
  scheduleHeal(): void {
    scheduleLowerHeal(currentWorkspaceKey())
  },
  reset(): void {
    resetLowerSync()
  },
}

/**
 * The diagrams whose lower roll-up a change to connections touching
 * `endpointIds` can alter, in store order. A connection contributes to a
 * diagram's roll-up only when BOTH its endpoints resolve through
 * `syncLowerConnections`' `findVisibleEndpoint` — the endpoint itself or its
 * nearest ancestor is on the diagram, or a group on the diagram holds it. This
 * returns every diagram where ANY endpoint resolves, a superset: re-deriving an
 * unaffected diagram is a no-op (no commit, see syncLowerConnections), missing
 * an affected one would leave a stale roll-up. Pruning stays correct for the
 * diagrams skipped: their own needed set did not change, so a lower they
 * reference is still referenced.
 *
 * An endpoint may also be a GROUP id: a lower rolled up through
 * `findVisibleEndpoint` onto a group runs G1→G2, so deleting it must reach the
 * diagrams that show those groups.
 *
 * Reads the module DiagramIndex, which the subscriber at the bottom of this
 * file rebuilds synchronously on every store change.
 */
export function diagramsReachingEndpoints(
  state: Pick<ModelState, 'diagrams' | 'groups'>,
  endpointIds: Iterable<string>,
): string[] {
  const index = getDiagramIndex()
  const reached = new Set<string>()
  const endpoints = new Set(endpointIds)
  for (const endpointId of endpoints) {
    for (const diagramId of index.groupToDiagramIds.get(endpointId) ?? []) reached.add(diagramId)
    const seen = new Set<string>()
    let current: string | undefined = endpointId
    while (current && !seen.has(current)) {
      seen.add(current)
      for (const diagramId of index.objectToDiagramIds.get(current) ?? []) reached.add(diagramId)
      current = index.objectById.get(current)?.parentId
    }
  }
  for (const group of state.groups) {
    if (!group.objectIds.some((id) => endpoints.has(id))) continue
    for (const diagramId of index.groupToDiagramIds.get(group.id) ?? []) reached.add(diagramId)
  }
  if (reached.size === 0) return []
  return state.diagrams.filter((diagram) => reached.has(diagram.id)).map((diagram) => diagram.id)
}

/** The diagrams a connection mutation can affect, resolved NOW — call it
 * BEFORE the mutation's own commit: the endpoints' reach (see
 * diagramsReachingEndpoints) plus every diagram that holds one of the
 * connection ids (a deleted connection leaves every `connectionIds`). */
function reachBeforeMutation(endpointIds: readonly string[], connectionIds: readonly string[]): string[] {
  const reached = new Set(diagramsReachingEndpoints(useModelStore.getState(), endpointIds))
  const holders = getDiagramIndex().connectionToDiagramIds
  for (const cid of connectionIds) {
    for (const diagramId of holders.get(cid) ?? []) reached.add(diagramId)
  }
  return [...reached]
}

/** Scope of a batch of connection updates, read from the index BEFORE the
 * update is applied (call it before `set`): old AND new endpoints of every
 * endpoint-changing update, and the diagrams the OLD side reaches now. */
function connectionUpdateScope(updates: readonly ConnectionBatchUpdate[]): {
  endpointIds: string[]
  reachedDiagramIds: string[]
} {
  const byId = getDiagramIndex().connectionById
  const endpointIds: string[] = []
  const oldEndpointIds: string[] = []
  const connectionIds: string[] = []
  for (const { id, data } of updates) {
    if (data.fromId === undefined && data.toId === undefined) continue
    const before = byId.get(id)
    if (before) {
      endpointIds.push(before.fromId, before.toId)
      oldEndpointIds.push(before.fromId, before.toId)
      connectionIds.push(id)
    }
    if (data.fromId !== undefined) endpointIds.push(data.fromId)
    if (data.toId !== undefined) endpointIds.push(data.toId)
  }
  const reachedDiagramIds = connectionIds.length > 0 ? reachBeforeMutation(oldEndpointIds, connectionIds) : []
  return { endpointIds, reachedDiagramIds }
}

interface ModelState {
  objects: C4Object[]
  connections: Connection[]
  diagrams: Diagram[]
  flows: Flow[]
  tags: Tag[]
  groups: Group[]
  domains: Domain[]
  comments: Comment[]
  decisionRecords: DecisionRecord[]
  currentDiagramId: string | null
  selectedItems: SelectedItem[]
  /** True when the signed-in user has only a read ("View") grant on the booted
   * workspace AND the server enforces it (AUTH stage 'on'). Set by
   * AutomergeBridge from `GET /api/me/workspace-access`; the editor chrome and
   * canvas lock themselves on it. UX only — the server drops unauthorized
   * writes regardless (sync write gate + REST write gates). */
  workspaceReadOnly: boolean
  /** Monotone local placement intent revision. The Automerge bridge uses it to
   * distinguish placement-only notifications from ordinary durable edits. */
  placementRevision: number
  /** Transient, explicit model-delete intents waiting for the Automerge bridge.
   * A selective-sync projection is allowed to omit entities, so absence from
   * `objects`/`connections` must never be interpreted as a deletion. */
  pendingDeletedObjectIds: string[]
  pendingDeletedConnectionIds: string[]
  /** Groups deleted this session. Unlike objects and connections these are NOT
   *  persisted as document tombstones — a group lives whole inside ModelMeta, so
   *  the delete is durable the moment it flushes and there is no base shard for a
   *  tombstone to mark. The intent exists only so the same flush can strip the id
   *  from the registry meta of diagrams the store is not authoritative for. */
  pendingDeletedGroupIds: string[]
  /** Diagrams deleted this session. Under a SUMMARY-only registry the
   *  resident `diagrams` array is a bounded window over a server-owned
   *  registry, so `deleteDiagram` filtering it out cannot be observed as a
   *  deletion by anything downstream — off-window it changes nothing at all.
   *  This is the explicit intent the bridge turns into a
   *  `ModelMeta.deletedDiagramIds` tombstone. Same rule as objects: absence
   *  from the window is never a deletion, only this list is. */
  pendingDeletedDiagramIds: string[]
  /** Diagram ids currently tombstoned in `ModelMeta.deletedDiagramIds`, as the
   *  bridge last read them (local intents included). The diagram list is served
   *  by the SERVER under a summary registry, so a module-level memo would
   *  re-render nothing — this has to be reactive store state. Written only
   *  through `withRemote`. */
  deletedDiagramIds: string[]

  // Actions
  setWorkspaceReadOnly: (readOnly: boolean) => void
  addObject: (obj: Omit<C4Object, 'id' | 'tagAssignments' | 'tagOrder'> & Partial<Pick<C4Object, 'tagAssignments' | 'tagOrder'>>) => string
  updateObject: (id: string, data: Partial<C4Object>) => void
  /** Many entity updates, ONE store notification. See the implementation. */
  updateEntitiesBatch: (updates: {
    objects?: Array<{ id: string; data: Partial<C4Object> }>
    groups?: Array<{ id: string; data: Partial<Group> }>
  }) => void
  deleteObject: (id: string) => void
  moveObject: (id: string, position: { x: number; y: number }) => void
  moveObjectsBatch: (updates: Array<Pick<ObjectPlacementUpdate, 'id' | 'position'>>) => void
  resizeObjectsBatch: (updates: ObjectPlacementUpdate[]) => void
  updatePlacementsBatch: (updates: {
    objects?: ObjectPlacementUpdate[]
    groups?: GroupPlacementUpdate[]
    connections?: ConnectionBatchUpdate[]
  }) => void
  addConnection: (conn: Omit<Connection, 'id'>) => string
  updateConnection: (id: string, data: Partial<Connection>) => void
  updateConnectionsBatch: (updates: ConnectionBatchUpdate[]) => void
  toggleConnectionLock: (id: string) => void
  toggleConnectionHiddenSource: (id: string) => void
  toggleConnectionHiddenTarget: (id: string) => void
  toggleConnectionShowOnFocus: (id: string) => void
  hideGroupOutgoingConnections: (groupId: string) => void
  hideGroupIncomingConnections: (groupId: string) => void
  hideGroupAllConnections: (groupId: string) => void
  hideMemberConnections: (groupId: string, mode: 'source' | 'target' | 'both') => void
  showGroupConnections: (groupId: string) => void
  showMemberConnections: (groupId: string) => void
  deleteConnection: (id: string) => void
  selectObjects: (ids: string[]) => void
  selectConnection: (id: string | null) => void
  selectGroup: (id: string | null) => void
  toggleSelectItem: (item: SelectedItem) => void
  clearSelection: () => void
  addDiagram: (diagram: Omit<Diagram, 'id'>) => string
  /** Copy a VIEW. `source` must be a fully materialised diagram (layouts and
   *  all) — the store's own non-active diagrams are layout-less stubs, so
   *  callers resolve it through `loadDiagramDuplicateSource` rather than
   *  reading `state.diagrams`. The copy references the SAME model objects,
   *  connections and groups by id; nothing in the model is cloned. */
  duplicateDiagram: (source: Diagram, flows: readonly Flow[], name: string) => string
  updateDiagram: (id: string, data: Partial<Diagram>) => void
  /** Set or CLEAR a diagram's scene decoration (clear = delete the key —
   * Automerge rejects undefined values, so updateDiagram can't do it). */
  setDiagramSceneDecor: (diagramId: string, decor: Diagram['sceneDecor'] | null) => void
  deleteDiagram: (id: string) => void
  /** Bulk-insert a fully-formed set of imported entities (objects/connections/
   * groups/diagrams). Ids must be pre-assigned and unique. Merges with the
   * existing model and stamps the default domain where missing. */
  importModel: (data: {
    objects: C4Object[]
    connections: Connection[]
    groups: Group[]
    diagrams: Diagram[]
    /** Snapshots for tags the imported entities reference. Without these the
     *  assignments render as unresolved ids. */
    tags?: Tag[]
    /** Flows belonging to the imported diagrams (a Structurizr dynamic view is
     *  one). Pushed in the SAME transaction as the diagrams: the flush that
     *  creates a diagram's doc reads `state.flows` for it, so a flow that lands
     *  a beat later never reaches the document it belongs to. */
    flows?: Flow[]
  }) => void
  /** Apply a planned JSON-export import (see lib/import/maplespireJson.ts):
   * pushes only the plan's NEW entities — existing ids were already filtered
   * out, per the "existing objects win, never updated" import contract. Flows
   * ride along for the imported diagrams; the bridge persists them into each
   * new diagram's doc at creation. */
  applyJsonImport: (plan: {
    objects: C4Object[]
    connections: Connection[]
    groups: Group[]
    domains: Domain[]
    tags: Tag[]
    diagrams: Diagram[]
    flows: Flow[]
  }) => void
  /** Apply an auto-layout result to one existing diagram atomically: set its
   * `layouts` (or `layouts3d` when the 3D board is the target space) and patch
   * the affected connections' routing (waypoints/anchors/shape). Used by the
   * on-canvas "Auto-layout" button. `space` defaults to the active canvas view. */
  applyDiagramLayout: (
    diagramId: string,
    layouts: Record<string, { position: Position; size: Size }>,
    connectionPatches: Array<{
      id: string
      waypoints?: Position[]
      fromAnchor?: number
      toAnchor?: number
      lockedToAnchors?: boolean
      shape?: ConnectionShape
      labelPosition?: number
      labelOffset?: number
    }>,
    space?: '2d' | '3d',
  ) => void
  /** "Align 3D with 2D placements": delete the diagram's 3D layer (layouts3d +
   * its connections' *3d routing) so the 3D board mirrors 2D live again. */
  resetDiagram3dLayout: (diagramId?: string) => void
  setCurrentDiagram: (id: string) => void
  getCurrentDiagram: () => Diagram | undefined
  getSelectedObjects: () => C4Object[]
  getObjectsInCurrentDiagram: () => C4Object[]
  getConnectionsInCurrentDiagram: () => Connection[]
  addObjectToGroup: (objectId: string, groupId: string) => void
  removeObjectFromGroup: (objectId: string, groupId: string) => void
  // Governed Tag assignments. Catalog creation/editing goes through PostgreSQL APIs.
  rememberTagSnapshots: (snapshots: readonly Tag[]) => void
  addTagToObject: (objectId: string, tagId: string, snapshot?: Tag) => void
  removeTagFromObject: (objectId: string, tagId: string) => void
  addTagToConnection: (connectionId: string, tagId: string, snapshot?: Tag) => void
  removeTagFromConnection: (connectionId: string, tagId: string) => void
  addTagToGroup: (groupId: string, tagId: string, snapshot?: Tag) => void
  removeTagFromGroup: (groupId: string, tagId: string) => void
  reconcileTags: () => void
  addGroup: (group: Omit<Group, 'id' | 'tagAssignments' | 'tagOrder'> & Partial<Pick<Group, 'tagAssignments' | 'tagOrder'>>) => string
  updateGroup: (id: string, data: Partial<Group>) => void
  deleteGroup: (id: string) => void
  // Bulk selection actions
  deleteSelectedItems: () => void
  moveSelectedItems: (delta: { x: number; y: number }) => void
  addSelectedToGroup: (groupId: string) => void
  removeSelectedFromGroup: (groupId: string) => void
  setScopeForSelected: (scope: 'internal' | 'external') => void
  selectAllInDiagram: () => void

  // Model objects view getters
  getChildObjects: (parentId: string) => C4Object[]
  getObjectConnectionCount: (objectId: string) => number
  getObjectDiagramCount: (objectId: string) => number
  getGroupConnectionCount: (groupId: string) => number
  getGroupDiagramCount: (groupId: string) => number
  getDescendantObjects: (objectId: string) => string[]
  getGroupClosure: (groupId: string) => string[]
  syncLowerConnections: (diagramId: string) => void
  /** Debounced roll-up re-derivation. With `endpointIds` (the old and new
   * endpoints of the connections a mutation touched) only the diagrams those
   * endpoints reach are re-derived — plus `reachedDiagramIds`, the reach the
   * caller resolved BEFORE its own commit — then an idle heal re-derives the
   * rest; without, every diagram. */
  syncAllLowerConnections: (endpointIds?: readonly string[], reachedDiagramIds?: readonly string[]) => void

  // Related diagrams for expand/zoom navigation
  getRelatedDiagrams: (objectId: string, options?: { includeCurrent?: boolean }) => {
    detail: Diagram[]
    reference: Diagram[]
    parent: Diagram[]
  }

  // Add object directly to model (without attaching to current diagram)
  addObjectToModel: (obj: Omit<C4Object, 'id' | 'tagAssignments' | 'tagOrder'> & Partial<Pick<C4Object, 'tagAssignments' | 'tagOrder'>>) => string

  // Remove object from diagram without deleting from model
  removeObjectFromDiagram: (objectId: string, diagramId?: string) => void
  removeObjectsFromDiagram: (objectIds: string[], diagramId?: string) => void
  isObjectOnlyInDiagram: (objectId: string, diagramId?: string) => boolean

  // Remove connection from diagram without deleting from model
  removeConnectionFromDiagram: (connectionId: string, diagramId?: string) => void
  isConnectionOnlyInDiagram: (connectionId: string, diagramId?: string) => boolean

  // Remove group from diagram without deleting from model
  removeGroupFromDiagram: (groupId: string, diagramId?: string) => void
  removeGroupsFromDiagram: (groupIds: string[], diagramId?: string) => void
  isGroupOnlyInDiagram: (groupId: string, diagramId?: string) => boolean
  addGroupToDiagram: (groupId: string, diagramId?: string) => void
  addObjectToDiagram: (objectId: string, diagramId?: string) => void

  // Domain actions
  addDomain: (domain: Omit<Domain, 'id'>) => string
  updateDomain: (id: string, data: Partial<Domain>) => void
  deleteDomain: (id: string) => void
  getDefaultDomain: () => Domain | undefined
  getChildDomains: (parentId: string) => Domain[]

  // Flow actions
  addFlow: (flow: Omit<Flow, 'id'>) => string
  updateFlow: (id: string, data: Partial<Flow>) => void
  deleteFlow: (id: string) => void
  addFlowStep: (flowId: string, step: Omit<FlowStep, 'id' | 'order'>) => string
  updateFlowStep: (flowId: string, stepId: string, data: Partial<FlowStep>) => void
  deleteFlowStep: (flowId: string, stepId: string) => void
  reorderFlowSteps: (flowId: string, stepIds: string[]) => void
  duplicateFlowStep: (flowId: string, stepId: string) => void
  duplicateFlow: (flowId: string) => string

  // Comment actions
  addComment: (comment: Omit<Comment, 'id' | 'createdAt'>) => string
  updateComment: (id: string, data: Partial<Comment>) => void
  deleteComment: (id: string) => void
  /** `authorship` defaults to the identity-less legacy author; UI callers pass
   *  `commentAuthorshipFor(user)` so the reply names its writer. */
  addReply: (commentId: string, text: string, authorship?: CommentAuthorship) => void
  deleteReply: (commentId: string, replyId: string) => void
  toggleResolved: (commentId: string) => void
  togglePinned: (commentId: string) => void
  getCommentsForDiagram: (diagramId: string) => Comment[]

  // Decision record actions
  addDecisionRecord: (record: Omit<DecisionRecord, 'id' | 'number' | 'createdAt' | 'updatedAt'>) => string
  updateDecisionRecord: (id: string, data: Partial<DecisionRecord>) => void
  deleteDecisionRecord: (id: string) => void
  getNextADRNumber: () => number
}

// ---------------------------------------------------------------------------
// 2D/3D placement layers. The MODEL is shared between the flat canvas and the
// 3D board; the VISUAL layer is per-mode: `diagram.layouts` vs `diagram.layouts3d`
// for shape placement, and the Connection `*3d` twins for routing/label/shape.
// Read rule: 3D value ?? 2D value. Write rule: edits made while the 3D board is
// active target ONLY the 3D layer (and vice versa) — so perfecting one mode can
// never rearrange the other.
// ---------------------------------------------------------------------------

type LayoutSpace = '2d' | '3d'

/** The layer placement writes target. Read from the UI store (not a param) so
 * EVERY mutation path is covered — canvas drags, arrow keys, the properties
 * panel, alignment actions — without threading a flag through each caller. */
function activeLayoutSpace(): LayoutSpace {
  return useUIStore.getState().canvasViewMode
}

function recordPlacementIntent(
  diagramId: string,
  space: PlacementLayoutSpace,
  batch: PlacementIntentBatch,
): number {
  const workspaceKey = workspaceRefKey(currentWorkspaceRef())
  const { revision, newKeys } = pendingPlacementIntents.record(workspaceKey, diagramId, space, batch)
  if (typeof indexedDB !== 'undefined') {
    // Leading edge for a key not yet journaled (phase B): the first record of
    // a drag used to live only in tab memory for up to the debounce window,
    // and a hard kill fires no pagehide. Re-records still coalesce.
    if (newKeys) persistPlacementIntentsNow(workspaceKvStore(), workspaceKey)
    else schedulePersistPlacementIntents(workspaceKvStore(), workspaceKey)
  }
  return revision
}

/** True when a connection carries any 3D routing override. */
function has3dRouting(c: Connection): boolean {
  return (
    c.waypoints3d !== undefined ||
    c.fromAnchor3d !== undefined ||
    c.toAnchor3d !== undefined ||
    c.lockedToAnchors3d !== undefined ||
    c.labelPosition3d !== undefined ||
    c.labelOffset3d !== undefined ||
    c.shape3d !== undefined
  )
}

/**
 * `list.find((x) => x.id === id)` for many ids, without reading every
 * element through an immer draft: ids are indexed once on the plain base
 * array (the draft's `original`, or `list` itself when it is not a draft),
 * and the element is read from `list` at that index. An index the draft no
 * longer agrees with (an element inserted or removed earlier in the same
 * recipe) falls back to the scan. (Not `find`'s answer in one case only: a
 * duplicate id inserted ahead of the original in the same recipe.)
 */
function draftLookup<T extends { id: string }>(list: T[]): (id: string) => T | undefined {
  let index: Map<string, number> | null = null
  return (id) => {
    if (!index) {
      const base = ((isDraft(list) ? original(list as never) : list) as T[] | undefined) ?? list
      index = new Map()
      for (let i = 0; i < base.length; i++) if (!index.has(base[i].id)) index.set(base[i].id, i)
    }
    const i = index.get(id)
    if (i !== undefined) {
      const x = list[i]
      if (x && x.id === id) return x
    }
    return list.find((x) => x.id === id)
  }
}

/**
 * Fork-on-first-3D-edit: the first edit made on the 3D board snapshots the
 * diagram's CURRENTLY-RESOLVED placement (objects + groups + its connections'
 * routing) into the 3D layer, so later 2D edits can't tear the perfected 3D
 * scene. Before the fork the 3D view live-mirrors 2D (the design's continuous
 * morph); elements added after the fork resolve per-element until adjusted.
 * Connections shared with an already-forked diagram keep their existing 3D
 * routing (only routing-virgin connections get stamped).
 */
function ensureFork3d(
  state: { objects: C4Object[]; groups: Group[]; connections: Connection[] },
  diagram: Diagram,
): void {
  if (diagram.layouts3d) return
  // CONNECT FREEZE (2026-10-11): `state.objects.find` per member walked the
  // WHOLE landscape through the immer draft — every element read makes a
  // proxy — on the first 3D edit of a diagram: ensureFork3d was 23-27 ms of
  // a reconnect's pointerup on a 9-node diagram of the dev landscape
  // (12 482 objects, 7 038 connections; reconnect-drop profile,
  // tp5-connect3d). Each id is now located once through the plain base
  // array, then read from the draft at that index.
  const find = draftLookup(state.objects)
  const l3: Record<string, { position: Position; size: Size }> = {}
  for (const oid of diagram.objectIds) {
    const o = find(oid)
    const l = diagram.layouts?.[oid]
    const position = l?.position ?? o?.position
    const size = l?.size ?? o?.size
    if (position && size) l3[oid] = { position: { ...position }, size: { ...size } }
  }
  const findGroup = draftLookup(state.groups)
  for (const gid of diagram.groupIds) {
    const g = findGroup(gid)
    const l = diagram.layouts?.[gid]
    const position = l?.position ?? g?.position
    const size = l?.size ?? g?.size
    if (position && size) l3[gid] = { position: { ...position }, size: { ...size } }
  }
  diagram.layouts3d = l3
  const findConnection = draftLookup(state.connections)
  for (const cid of diagram.connectionIds) {
    const c = findConnection(cid)
    if (!c || has3dRouting(c)) continue
    if (c.waypoints) c.waypoints3d = c.waypoints.map((p) => ({ ...p }))
    if (c.fromAnchor !== undefined) c.fromAnchor3d = c.fromAnchor
    if (c.toAnchor !== undefined) c.toAnchor3d = c.toAnchor
    if (c.lockedToAnchors !== undefined) c.lockedToAnchors3d = c.lockedToAnchors
    if (c.labelPosition !== undefined) c.labelPosition3d = c.labelPosition
    if (c.labelOffset !== undefined) c.labelOffset3d = c.labelOffset
    if (c.shape !== undefined) c.shape3d = c.shape
  }
}

/**
 * Write a shape's placement into the ACTIVE layer of `diagram`. The 2D branch is
 * the classic `layouts` write (byte-identical to the old inline code); the 3D
 * branch forks first, then writes `layouts3d`. `fallback` supplies the missing
 * half of a partial patch exactly like each call site used to.
 */
function writePlacement(
  state: { objects: C4Object[]; groups: Group[]; connections: Connection[] },
  diagram: Diagram,
  id: string,
  patch: { position?: Position; size?: Size },
  fallback: { position?: Position; size?: Size },
): void {
  const use3d = activeLayoutSpace() === '3d'
  if (use3d) ensureFork3d(state, diagram)
  const map = use3d ? (diagram.layouts3d ??= {}) : (diagram.layouts ??= {})
  const existing = map[id]
  const position = patch.position ?? existing?.position ?? fallback.position
  const size = patch.size ?? existing?.size ?? fallback.size
  if (!position || !size) return
  map[id] = { position, size }
}

/**
 * The body of `updateObject`, callable inside someone else's `set()`.
 *
 * Extracted so a batched update can apply many entities in ONE transaction
 * without re-implementing these semantics — notably the parent-wrapper sync
 * below, which a hand-rolled bulk writer would silently omit. `updateObject`
 * and `updateEntitiesBatch` must never disagree about what an update means.
 */
function applyObjectUpdate(
  state: ModelState,
  id: string,
  data: Partial<C4Object>,
): void {
  const { position, size, parentId, ...rest } = data
  const obj = state.objects.find((o) => o.id === id)
  if (!obj) return
  Object.assign(obj, rest)
  if ('parentId' in data) {
    if (parentId === undefined) delete obj.parentId
    else obj.parentId = parentId
  }

  // Handle position/size in diagram layouts when a diagram is active
  // (space-aware: the 3D board writes the separate 3D layer)
  if (position || size) {
    const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
    if (diagram) {
      writePlacement(state, diagram, id, { position, size }, { position: obj.position, size: obj.size })
    } else {
      if (position) obj.position = position
      if (size) obj.size = size
    }
  }

  // Sync parent wrapper groups in child diagrams
  const groupsToSync = state.groups.filter((g) => g.parentObjectId === id)
  for (const group of groupsToSync) {
    if (data.name !== undefined) group.name = data.name
    if (data.shortDescription !== undefined) group.description = data.shortDescription
    if ('icon' in data) {
      if (data.icon === undefined) delete group.icon
      else group.icon = data.icon
    }
    if ('iconAssignment' in data) {
      if (data.iconAssignment === undefined) delete group.iconAssignment
      else group.iconAssignment = data.iconAssignment
    }
    if (data.type !== undefined) {
      group.type = data.type.charAt(0).toUpperCase() + data.type.slice(1)
    }
  }
}

/** The body of `updateGroup`'s `set()`. See `applyObjectUpdate`. */
function applyGroupUpdate(
  state: ModelState,
  id: string,
  data: Partial<Group>,
): void {
  const { position, size, ...rest } = data
  const group = state.groups.find((g) => g.id === id)
  if (!group) return
  assertTechnologyUsageIdentityPreserved(group.technologyUsages, rest.technologyUsages)
  Object.assign(group, rest)
  if (position || size) {
    const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
    if (diagram) {
      writePlacement(state, diagram, id, { position, size }, { position: group.position, size: group.size })
    } else {
      if (position) group.position = position
      if (size) group.size = size
    }
  }
}

/**
 * Journal a placement carried by a generic entity UPDATE (`updateObject`,
 * `updateEntitiesBatch`) — the properties-panel X/Y/W/H path. These writes
 * land in `diagram.layouts` exactly like a drag, but bypassed the placement
 * journal entirely (phase B capture hole): a hard kill inside the write
 * debounce lost the edit with no trace. Call BEFORE `set()` (the journal is
 * a module singleton; recording inside immer would run under the draft).
 */
function recordPlacementFromEntityUpdates(
  before: { diagrams: Diagram[]; currentDiagramId: string | null },
  updates: {
    objects?: Array<{ id: string; entity?: { position?: Position; size?: Size }; position?: Position; size?: Size }>
    groups?: Array<{ id: string; entity?: { position?: Position; size?: Size }; position?: Position; size?: Size }>
  },
): void {
  const diagram = before.diagrams.find((candidate) => candidate.id === before.currentDiagramId)
  if (!diagram) return
  const space = activeLayoutSpace()
  const objects: PendingObjectPlacement[] = []
  const groups: PendingGroupPlacement[] = []
  for (const update of updates.objects ?? []) {
    if (!update.position && !update.size) continue
    if (!update.entity) continue
    const resolved = readPlacement(diagram, update.id, update.entity)
    const position = update.position ?? resolved.position
    const size = update.size ?? resolved.size
    if (!position || !size) continue
    objects.push({ id: update.id, position, size })
  }
  for (const update of updates.groups ?? []) {
    if (!update.position && !update.size) continue
    if (!update.entity) continue
    const resolved = readPlacement(diagram, update.id, update.entity)
    groups.push({
      id: update.id,
      position: update.position ?? resolved.position,
      size: update.size ?? resolved.size,
    })
  }
  if (objects.length === 0 && groups.length === 0) return
  recordPlacementIntent(diagram.id, space, { objects, groups })
}

/** Resolved placement of `id` in the ACTIVE layer (for delta moves). */
function readPlacement(
  diagram: Diagram,
  id: string,
  base: { position?: Position; size?: Size },
): { position?: Position; size?: Size } {
  const l3 = activeLayoutSpace() === '3d' ? diagram.layouts3d?.[id] : undefined
  const l = l3 ?? diagram.layouts?.[id]
  return { position: l?.position ?? base.position, size: l?.size ?? base.size }
}

/** Redirect a connection patch's routing fields to their 3D twins (edits made on
 * the 3D board). Model-level fields (label text, type, status, endpoints…) pass
 * through untouched. Uses `in` checks so explicit clears keep working. */
function redirectConnPatchTo3d(data: Partial<Connection>): Partial<Connection> {
  const out: Partial<Connection> = {}
  for (const [key, value] of Object.entries(data)) {
    switch (key) {
      case 'waypoints':
        // [] (not undefined) so "no bends in 3D" doesn't fall back to the 2D bends.
        out.waypoints3d = (value as Position[] | undefined) ?? []
        break
      case 'fromAnchor':
        out.fromAnchor3d = value as number | undefined
        break
      case 'toAnchor':
        out.toAnchor3d = value as number | undefined
        break
      case 'lockedToAnchors':
        out.lockedToAnchors3d = value as boolean | undefined
        break
      case 'labelPosition':
        out.labelPosition3d = value as number | undefined
        break
      case 'labelOffset':
        out.labelOffset3d = value as number | undefined
        break
      case 'shape':
        out.shape3d = value as ConnectionShape | undefined
        break
      default:
        ;(out as Record<string, unknown>)[key] = value
    }
  }
  return out
}

export const useModelStore = create<ModelState>()(
  immer((set, get) => ({
    objects: [],
    connections: [],
    diagrams: [],
    flows: [],
    tags: [],
    groups: [],
    domains: [],
    comments: [],
    decisionRecords: [],
    currentDiagramId: null,
    selectedItems: [],
    workspaceReadOnly: false,
    placementRevision: 0,
    pendingDeletedObjectIds: [],
    pendingDeletedConnectionIds: [],
    pendingDeletedGroupIds: [],
    pendingDeletedDiagramIds: [],
    deletedDiagramIds: [],

    setWorkspaceReadOnly: (readOnly) => {
      set((state) => {
        state.workspaceReadOnly = readOnly
      })
    },

    addObject: (obj) => {
      const id = generateId()
      const defaultDomain = get().getDefaultDomain()
      const domainId = obj.domainId || defaultDomain?.id
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
        let parentId: string | undefined = obj.parentId

        // Auto-assign parentId based on diagram hierarchy
        if (diagram && !parentId) {
          if (diagram.type === 'container' && diagram.parentObjectId && (obj.type === 'app' || obj.type === 'store')) {
            parentId = diagram.parentObjectId
          } else if (diagram.type === 'component' && diagram.parentObjectId && obj.type === 'component') {
            parentId = diagram.parentObjectId
          }
        }

        state.objects.push({ ...obj, id, parentId, domainId, tagAssignments: obj.tagAssignments ?? {}, tagOrder: obj.tagOrder ?? [] })
        if (diagram) {
          diagram.objectIds.push(id)
          if (!diagram.layouts) diagram.layouts = {}
          diagram.layouts[id] = { position: obj.position, size: obj.size }
          // Auto-add to parent wrapper group if this is a child diagram
          if (diagram.parentObjectId) {
            const parentWrapper = state.groups.find(
              (g) => g.parentObjectId === diagram.parentObjectId
            )
            if (parentWrapper && !parentWrapper.objectIds.includes(id)) {
              parentWrapper.objectIds.push(id)
            }
          }
        }
      })
      return id
    },

    updateObject: (id, data) => {
      if ('technologyUsages' in data) {
        const current = get().objects.find((object) => object.id === id)
        assertTechnologyUsageIdentityPreserved(current?.technologyUsages, data.technologyUsages)
      }
      if (data.position || data.size) {
        const before = get()
        recordPlacementFromEntityUpdates(before, {
          objects: [{
            id,
            entity: before.objects.find((object) => object.id === id),
            position: data.position,
            size: data.size,
          }],
        })
      }
      set((state) => { applyObjectUpdate(state, id, data) })
      if ('parentId' in data) {
        const diagramId = get().currentDiagramId
        if (diagramId) get().syncLowerConnections(diagramId)
      }
    },

    /**
     * Apply many object/group updates in ONE store transaction.
     *
     * Calling `updateObject` in a loop issues one `set()` per entity, and every
     * notification re-runs the Automerge bridge's `detectEdits()`, which walks
     * the whole model — O(updates × model) inside a single event. This is the
     * same contract `updatePlacementsBatch` holds for a multi-shape drag, which
     * `gestureBatch.test.ts` pins at exactly one notification.
     *
     * It routes through the SAME `applyObjectUpdate` / `applyGroupUpdate`
     * helpers the single-entity actions use, so semantics cannot drift — in
     * particular the parent-wrapper sync that mirrors name/description/icon
     * onto wrapper groups, which a hand-rolled bulk writer would silently drop.
     */
    updateEntitiesBatch: ({ objects = [], groups = [] }) => {
      if (objects.length === 0 && groups.length === 0) return
      for (const update of objects) {
        if (!('technologyUsages' in update.data)) continue
        const current = get().objects.find((object) => object.id === update.id)
        assertTechnologyUsageIdentityPreserved(current?.technologyUsages, update.data.technologyUsages)
      }
      {
        const before = get()
        const objectById = new Map(before.objects.map((object) => [object.id, object]))
        const groupById = new Map(before.groups.map((group) => [group.id, group]))
        recordPlacementFromEntityUpdates(before, {
          objects: objects.map((update) => ({
            id: update.id,
            entity: objectById.get(update.id),
            position: update.data.position,
            size: update.data.size,
          })),
          groups: groups.map((update) => ({
            id: update.id,
            entity: groupById.get(update.id),
            position: update.data.position,
            size: update.data.size,
          })),
        })
      }
      set((state) => {
        for (const update of objects) applyObjectUpdate(state, update.id, update.data)
        for (const update of groups) applyGroupUpdate(state, update.id, update.data)
      })
      if (objects.some((update) => 'parentId' in update.data)) {
        const diagramId = get().currentDiagramId
        if (diagramId) get().syncLowerConnections(diagramId)
      }
    },

    deleteObject: (id) => {
      set((state) => {
        const incidentConnectionIds = state.connections
          .filter((connection) => connection.kind !== 'lower' && (connection.fromId === id || connection.toId === id))
          .map((connection) => connection.id)
        if (!state.pendingDeletedObjectIds.includes(id)) state.pendingDeletedObjectIds.push(id)
        for (const connectionId of incidentConnectionIds) {
          if (!state.pendingDeletedConnectionIds.includes(connectionId)) {
            state.pendingDeletedConnectionIds.push(connectionId)
          }
        }
        state.objects = state.objects.filter((o) => o.id !== id)
        state.connections = state.connections.filter(
          (c) => c.fromId !== id && c.toId !== id
        )
        state.diagrams.forEach((d) => {
          d.objectIds = d.objectIds.filter((oid) => oid !== id)
          d.connectionIds = d.connectionIds.filter((cid) => {
            const conn = state.connections.find((c) => c.id === cid)
            return conn && conn.fromId !== id && conn.toId !== id
          })
          if (d.layouts) {
            delete d.layouts[id]
          }
          if (d.layouts3d) {
            delete d.layouts3d[id]
          }
        })
        state.groups.forEach((g) => {
          g.objectIds = g.objectIds.filter((oid) => oid !== id)
        })
        state.selectedItems = state.selectedItems.filter((s) => s.id !== id)
      })
      const diagramId = get().currentDiagramId
      if (diagramId) get().syncLowerConnections(diagramId)
    },

    updatePlacementsBatch: ({ objects = [], groups = [], connections = [] }) => {
      if (objects.length === 0 && groups.length === 0 && connections.length === 0) return
      // Read before the commit: the scoped roll-up needs the OLD endpoints too.
      // (null = could not be computed: the roll-up falls back to a full pass)
      const lowerScope = tryLowerScope(() => connectionUpdateScope(connections))
      const before = get()
      const diagram = before.diagrams.find((candidate) => candidate.id === before.currentDiagramId)
      const space = activeLayoutSpace()
      let placementRevision: number | undefined
      if (diagram) {
        const objectById = new Map(before.objects.map((object) => [object.id, object]))
        const groupById = new Map(before.groups.map((group) => [group.id, group]))
        const resolvedObjects = objects.flatMap((update) => {
          const object = objectById.get(update.id)
          if (!object) return []
          const resolved = readPlacement(diagram, update.id, { position: object.position, size: object.size })
          const size = update.size ?? resolved.size ?? object.size
          return [{ id: update.id, position: update.position, size }]
        })
        const resolvedGroups = groups.flatMap((update) => {
          const group = groupById.get(update.id)
          if (!group) return []
          const resolved = readPlacement(diagram, update.id, { position: group.position, size: group.size })
          return [{
            id: update.id,
            position: update.position ?? resolved.position,
            size: update.size ?? resolved.size,
            autoSize: update.autoSize,
          }]
        })
        const resolvedConnections = connections.map((update) => ({
          id: update.id,
          data: space === '3d' ? redirectConnPatchTo3d(update.data) : update.data,
        }))
        placementRevision = recordPlacementIntent(diagram.id, space, {
          objects: resolvedObjects,
          groups: resolvedGroups,
          connections: resolvedConnections,
        })
      }
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
        const objectById = new Map(state.objects.map((object) => [object.id, object]))
        const groupById = new Map(state.groups.map((group) => [group.id, group]))
        const connectionById = new Map(state.connections.map((connection) => [connection.id, connection]))

        for (const update of objects) {
          const object = objectById.get(update.id)
          if (!object) continue
          if (diagram) {
            writePlacement(
              state,
              diagram,
              update.id,
              { position: update.position, size: update.size },
              { position: object.position, size: object.size },
            )
          } else {
            object.position = update.position
            if (update.size) object.size = update.size
          }
        }

        for (const update of groups) {
          const group = groupById.get(update.id)
          if (!group) continue
          if (update.autoSize !== undefined) group.autoSize = update.autoSize
          if (diagram && (update.position || update.size)) {
            writePlacement(
              state,
              diagram,
              update.id,
              { position: update.position, size: update.size },
              { position: group.position, size: group.size },
            )
          } else {
            if (update.position) group.position = update.position
            if (update.size) group.size = update.size
          }
        }

        for (const update of connections) {
          const connection = connectionById.get(update.id)
          if (!connection) continue
          let patch = update.data
          if (activeLayoutSpace() === '3d') {
            if (diagram) ensureFork3d(state, diagram)
            patch = redirectConnPatchTo3d(update.data)
          }
          Object.assign(connection, patch)
        }
        if (placementRevision !== undefined) state.placementRevision = placementRevision
      })
      if (connections.some(({ data }) => data.fromId !== undefined || data.toId !== undefined)) {
        get().syncAllLowerConnections(lowerScope?.endpointIds, lowerScope?.reachedDiagramIds)
      }
    },

    moveObjectsBatch: (updates) => {
      get().updatePlacementsBatch({ objects: updates })
    },

    resizeObjectsBatch: (updates) => {
      get().updatePlacementsBatch({ objects: updates })
    },

    moveObject: (id, position) => {
      get().moveObjectsBatch([{ id, position }])
    },

    addConnection: (conn) => {
      const id = generateId()
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
        // Stamp the diagram's default shape onto the new connection so that later
        // changing the default does not retroactively reshape existing connections.
        const shape = conn.shape ?? diagram?.defaultConnectionShape ?? 'curved'
        state.connections.push({ ...conn, id, shape })
        if (diagram) {
          diagram.connectionIds.push(id)
        }
      })
      get().syncAllLowerConnections([conn.fromId, conn.toId])
      return id
    },

    updateConnectionsBatch: (updates) => {
      // Read before the commit: the scoped roll-up needs the OLD endpoints too.
      // (null = could not be computed: the roll-up falls back to a full pass)
      const lowerScope = tryLowerScope(() => connectionUpdateScope(updates))
      set((state) => {
        const byId = new Map(state.connections.map((connection, index) => [connection.id, index]))
        for (const { id, data } of updates) {
          const idx = byId.get(id)
          if (idx !== undefined) {
            // Routing/label/shape edits made on the 3D board land on the *3d twins
            // (model fields pass through) — after forking the diagram's 3D layer.
            let patch = data
            if (activeLayoutSpace() === '3d') {
              const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
              if (diagram) ensureFork3d(state, diagram)
              patch = redirectConnPatchTo3d(data)
            }
            state.connections[idx] = { ...state.connections[idx], ...patch }
          }
        }
      })
      // The lower-connection roll-up is derived ONLY from endpoints + object parentage +
      // diagram/group membership — never from visual fields (shape/type/label/status/
      // anchors/waypoints/hidden/…). So only re-roll-up when an endpoint actually changes
      // (a reconnect); a curved↔straight / solid↔dashed / label edit skips the whole
      // O(diagrams×connections) recompute it used to trigger on every keystroke.
      if (updates.some(({ data }) => data.fromId !== undefined || data.toId !== undefined)) {
        get().syncAllLowerConnections(lowerScope?.endpointIds, lowerScope?.reachedDiagramIds)
      }
    },

    updateConnection: (id, data) => {
      get().updateConnectionsBatch([{ id, data }])
    },

    toggleConnectionLock: (id) => {
      set((state) => {
        const idx = state.connections.findIndex((c) => c.id === id)
        if (idx !== -1) {
          const c = state.connections[idx]
          if (activeLayoutSpace() === '3d') {
            const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
            if (diagram) ensureFork3d(state, diagram)
            state.connections[idx] = {
              ...c,
              lockedToAnchors3d: !(c.lockedToAnchors3d ?? c.lockedToAnchors),
            }
          } else {
            state.connections[idx] = {
              ...c,
              lockedToAnchors: !c.lockedToAnchors,
            }
          }
        }
      })
    },

    toggleConnectionHiddenSource: (id) => {
      set((state) => {
        const idx = state.connections.findIndex((c) => c.id === id)
        if (idx === -1) return
        const curr = state.connections[idx].hidden
        let next: 'source' | 'target' | 'both' | undefined
        if (curr === undefined) next = 'source'
        else if (curr === 'source') next = undefined
        else if (curr === 'target') next = 'both'
        else if (curr === 'both') next = 'target'
        state.connections[idx] = { ...state.connections[idx], hidden: next }
      })
    },

    toggleConnectionHiddenTarget: (id) => {
      set((state) => {
        const idx = state.connections.findIndex((c) => c.id === id)
        if (idx === -1) return
        const curr = state.connections[idx].hidden
        let next: 'source' | 'target' | 'both' | undefined
        if (curr === undefined) next = 'target'
        else if (curr === 'target') next = undefined
        else if (curr === 'source') next = 'both'
        else if (curr === 'both') next = 'source'
        state.connections[idx] = { ...state.connections[idx], hidden: next }
      })
    },

    toggleConnectionShowOnFocus: (id) => {
      set((state) => {
        const idx = state.connections.findIndex((c) => c.id === id)
        if (idx === -1) return
        const curr = state.connections[idx].showOnFocus
        state.connections[idx] = { ...state.connections[idx], showOnFocus: curr === undefined ? false : !curr }
      })
    },

    hideGroupOutgoingConnections: (groupId) => {
      set((state) => {
        for (const conn of state.connections) {
          if (conn.fromId === groupId) {
            if (conn.hidden === 'target') conn.hidden = 'both'
            else if (!conn.hidden) conn.hidden = 'source'
          }
        }
      })
    },

    hideGroupIncomingConnections: (groupId) => {
      set((state) => {
        for (const conn of state.connections) {
          if (conn.toId === groupId) {
            if (conn.hidden === 'source') conn.hidden = 'both'
            else if (!conn.hidden) conn.hidden = 'target'
          }
        }
      })
    },

    hideGroupAllConnections: (groupId) => {
      set((state) => {
        for (const conn of state.connections) {
          if (conn.fromId === groupId || conn.toId === groupId) {
            conn.hidden = 'both'
          }
        }
      })
    },

    hideMemberConnections: (groupId, mode) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group) return
        const memberIds = new Set(group.objectIds)
        for (const conn of state.connections) {
          const fromMember = memberIds.has(conn.fromId)
          const toMember = memberIds.has(conn.toId)
          if (mode === 'source' && fromMember) {
            if (conn.hidden === 'target') conn.hidden = 'both'
            else if (!conn.hidden) conn.hidden = 'source'
          } else if (mode === 'target' && toMember) {
            if (conn.hidden === 'source') conn.hidden = 'both'
            else if (!conn.hidden) conn.hidden = 'target'
          } else if (mode === 'both' && (fromMember || toMember)) {
            conn.hidden = 'both'
          }
        }
      })
    },

    showGroupConnections: (groupId) => {
      set((state) => {
        for (const conn of state.connections) {
          if (conn.fromId === groupId || conn.toId === groupId) {
            delete conn.hidden
          }
        }
      })
    },

    showMemberConnections: (groupId) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group) return
        const memberIds = new Set(group.objectIds)
        for (const conn of state.connections) {
          if (memberIds.has(conn.fromId) || memberIds.has(conn.toId)) {
            delete conn.hidden
          }
        }
      })
    },

    deleteConnection: (id) => {
      const deleted = getDiagramIndex().connectionById.get(id)
      // Before the commit: the delete takes `id` out of every diagram, and the
      // endpoints may be deleted later in the same burst.
      // (null = could not be computed: the roll-up falls back to a full pass)
      const reached = deleted ? tryLowerScope(() => reachBeforeMutation([deleted.fromId, deleted.toId], [id])) : null
      set((state) => {
        const connection = state.connections.find((candidate) => candidate.id === id)
        if (connection?.kind !== 'lower' && !state.pendingDeletedConnectionIds.includes(id)) {
          state.pendingDeletedConnectionIds.push(id)
        }
        state.connections = state.connections.filter((c) => c.id !== id)
        state.diagrams.forEach((d) => {
          d.connectionIds = d.connectionIds.filter((cid) => cid !== id)
        })
        state.selectedItems = state.selectedItems.filter((s) => s.id !== id)
      })
      // An id the index does not know keeps the full pass (nothing to scope by).
      get().syncAllLowerConnections(deleted && reached ? [deleted.fromId, deleted.toId] : undefined, reached ?? undefined)
    },

    selectObjects: (ids) => {
      set((state) => {
        state.selectedItems = ids.map((id) => ({ id, type: 'object' as const }))
      })
    },

    selectConnection: (id) => {
      set((state) => {
        state.selectedItems = id ? [{ id, type: 'connection' as const }] : []
      })
    },

    selectGroup: (id) => {
      set((state) => {
        state.selectedItems = id ? [{ id, type: 'group' as const }] : []
      })
    },

    toggleSelectItem: (item) => {
      set((state) => {
        const idx = state.selectedItems.findIndex((s) => s.id === item.id && s.type === item.type)
        if (idx !== -1) {
          state.selectedItems.splice(idx, 1)
        } else {
          state.selectedItems.push(item)
        }
      })
    },

    clearSelection: () => {
      set((state) => {
        state.selectedItems = []
      })
    },

    addDiagram: (diagram) => {
      const id = generateId()
      set((state) => {
        state.diagrams.push({ ...diagram, id })
      })
      return id
    },

    duplicateDiagram: (source, flows, name) => {
      const id = generateId()
      const copy: Diagram = { ...buildDuplicateDiagram(source, name), id }
      const copiedFlows = buildDuplicateFlows(flows, id, generateId)
      set((state) => {
        // One transaction: the flush that creates the copy's DiagramDoc reads
        // `state.flows` for it (ensureDiagramDoc), so the flows must never be
        // visible a beat later than the diagram they belong to.
        state.diagrams.push(copy)
        if (copiedFlows.length) state.flows.push(...copiedFlows)
      })
      return id
    },

    updateDiagram: (id, data) => {
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === id)
        if (diagram) {
          Object.assign(diagram, data)
        }
      })
    },

    setDiagramSceneDecor: (diagramId, decor) => {
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === diagramId)
        if (!diagram) return
        if (decor) diagram.sceneDecor = decor
        else delete diagram.sceneDecor
      })
    },

    importModel: (data) => {
      set((state) => {
        const domainId = state.domains[0]?.id
        // Stamp the default domain onto copies — never mutate the caller's input
        // objects (they live in the modal's `result` state and may be reused).
        const stampDomain = <T extends { domainId?: string }>(item: T): T =>
          item.domainId || !domainId ? item : { ...item, domainId }
        // Tags first, and only the ones not already present: re-importing a
        // workspace mints the same deterministic ids, so a second import must
        // not duplicate the registry.
        if (data.tags?.length) {
          const known = new Set(state.tags.map((tag) => tag.tagId))
          state.tags.push(...data.tags.filter((tag) => !known.has(tag.tagId)))
        }
        state.objects.push(...data.objects.map(stampDomain))
        state.connections.push(...data.connections)
        state.groups.push(...data.groups.map(stampDomain))
        state.diagrams.push(...data.diagrams.map(stampDomain))
        if (data.flows?.length) state.flows.push(...data.flows.map(stampDomain))
      })
    },

    applyJsonImport: (plan) => {
      set((state) => {
        // Imported domains land first so a default-domain stamp (if ever added
        // here) would see them; entities carry their own domainId from the file.
        state.domains.push(...plan.domains)
        state.tags.push(...plan.tags)
        state.objects.push(...plan.objects)
        state.connections.push(...plan.connections)
        state.groups.push(...plan.groups)
        state.diagrams.push(...plan.diagrams)
        state.flows.push(...plan.flows)
      })
    },

    applyDiagramLayout: (diagramId, layouts, connectionPatches, space) => {
      const use3d = (space ?? activeLayoutSpace()) === '3d'
      const before = get()
      const target = before.diagrams.find((diagram) => diagram.id === diagramId)
      let placementRevision: number | undefined
      // Journal for ANY target diagram (phase B): a layout applied to a
      // non-current diagram used to mutate the store without a journal record
      // and, in classic mode, persist NOWHERE until that diagram was next
      // activated. The off-active drain / activation flush now express these.
      if (target) {
        const objectIds = new Set(target.objectIds)
        const groupIds = new Set(target.groupIds)
        const objects = Object.entries(layouts).flatMap(([id, layout]) =>
          objectIds.has(id) ? [{ id, position: layout.position, size: layout.size }] : [])
        const groups = Object.entries(layouts).flatMap(([id, layout]) =>
          groupIds.has(id) ? [{ id, position: layout.position, size: layout.size }] : [])
        const connections = connectionPatches.map(({ id, ...data }) => ({
          id,
          data: use3d ? redirectConnPatchTo3d(data) : data,
        }))
        placementRevision = recordPlacementIntent(diagramId, use3d ? '3d' : '2d', {
          objects,
          groups,
          connections,
        })
      }
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === diagramId)
        if (diagram) {
          // The server window can be temporarily incomplete during hydration.
          // Auto-layout owns only the entries it produced; absence from this
          // result is not an intentional deletion of an existing placement.
          if (use3d) diagram.layouts3d = { ...(diagram.layouts3d ?? {}), ...layouts }
          else diagram.layouts = { ...(diagram.layouts ?? {}), ...layouts }
        }
        const patchById = new Map(connectionPatches.map((p) => [p.id, p]))
        for (const c of state.connections) {
          const p = patchById.get(c.id)
          if (!p) continue
          if (use3d) {
            // 3D layout results land on the *3d twins; clears use explicit
            // sentinels ([] / false) so they don't fall back to the 2D values.
            c.waypoints3d = p.waypoints && p.waypoints.length ? p.waypoints : []
            if (p.lockedToAnchors && (p.fromAnchor !== undefined || p.toAnchor !== undefined)) {
              c.lockedToAnchors3d = true
              if (p.fromAnchor !== undefined) c.fromAnchor3d = p.fromAnchor
              else delete c.fromAnchor3d
              if (p.toAnchor !== undefined) c.toAnchor3d = p.toAnchor
              else delete c.toAnchor3d
            } else {
              c.lockedToAnchors3d = false
              delete c.fromAnchor3d
              delete c.toAnchor3d
            }
            if (p.shape) c.shape3d = p.shape
            if (p.labelPosition !== undefined) c.labelPosition3d = p.labelPosition
            if (p.labelOffset !== undefined) c.labelOffset3d = p.labelOffset
            continue
          }
          if (p.waypoints && p.waypoints.length) c.waypoints = p.waypoints
          else delete c.waypoints
          // The layout owns the anchor state it scored — an end the patch leaves
          // undefined is CLEARED (back to raycast), never kept: a stale anchor
          // surviving a re-layout gets re-locked onto the wrong port and the canvas
          // draws a worse line than the one the layout picked. Mirrors applyPatch
          // in src/lib/layout/index.ts — keep the two in lockstep.
          if (p.lockedToAnchors && (p.fromAnchor !== undefined || p.toAnchor !== undefined)) {
            c.lockedToAnchors = true
            if (p.fromAnchor !== undefined) c.fromAnchor = p.fromAnchor
            else delete c.fromAnchor
            if (p.toAnchor !== undefined) c.toAnchor = p.toAnchor
            else delete c.toAnchor
          } else {
            c.lockedToAnchors = false
            delete c.fromAnchor
            delete c.toAnchor
          }
          if (p.shape) c.shape = p.shape
          if (p.labelPosition !== undefined) c.labelPosition = p.labelPosition
          if (p.labelOffset !== undefined) c.labelOffset = p.labelOffset
        }
        if (placementRevision !== undefined) state.placementRevision = placementRevision
      })
    },

    resetDiagram3dLayout: (diagramId) => {
      const targetDiagramId = diagramId ?? get().currentDiagramId
      if (!targetDiagramId) return
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (!diagram) return
        delete diagram.layouts3d
        // Drop the 3D routing of this diagram's connections too — back to the
        // live mirror of the 2D arrangement (the "Align 3D with 2D" action).
        for (const cid of diagram.connectionIds) {
          const c = state.connections.find((x) => x.id === cid)
          if (!c) continue
          delete c.waypoints3d
          delete c.fromAnchor3d
          delete c.toAnchor3d
          delete c.lockedToAnchors3d
          delete c.labelPosition3d
          delete c.labelOffset3d
          delete c.shape3d
        }
      })
    },

    deleteDiagram: (id) => {
      set((state) => {
        // The intent is declared BEFORE the window is filtered, and it is
        // declared whether or not the id is in the window: under a summary
        // registry the diagram the user just clicked Delete on is usually NOT
        // resident, so filtering the window alone would be a silent no-op.
        if (!state.pendingDeletedDiagramIds.includes(id)) state.pendingDeletedDiagramIds.push(id)
        state.diagrams = state.diagrams.filter((d) => d.id !== id)
        if (state.currentDiagramId === id) {
          // `diagrams[0]` is the first of a WINDOW, not of the registry — under
          // a summary contract it can legitimately be undefined even though the
          // workspace holds 10 000 diagrams. Null is the honest answer; the
          // list view is what re-populates the window.
          state.currentDiagramId = state.diagrams[0]?.id ?? null
        }
      })
    },

    setCurrentDiagram: (id) => {
      set((state) => {
        state.currentDiagramId = id
        state.selectedItems = []
      })
    },

    getCurrentDiagram: () => {
      return get().diagrams.find((d) => d.id === get().currentDiagramId)
    },

    getSelectedObjects: () => {
      const ids = get().selectedItems.filter((s) => s.type === 'object').map((s) => s.id)
      return get().objects.filter((o) => ids.includes(o.id))
    },

    getObjectsInCurrentDiagram: () => {
      const diagram = get().getCurrentDiagram()
      if (!diagram) return []
      return get().objects.filter((o) => diagram.objectIds.includes(o.id))
    },

    getConnectionsInCurrentDiagram: () => {
      const diagram = get().getCurrentDiagram()
      if (!diagram) return []
      return get().connections.filter((c) => diagram.connectionIds.includes(c.id))
    },

    addGroup: (group) => {
      const id = generateId()
      const defaultDomain = get().getDefaultDomain()
      const domainId = group.domainId || defaultDomain?.id
      set((state) => {
        state.groups.push({
          ...group,
          id,
          autoSize: group.autoSize ?? true,
          domainId,
          tagAssignments: group.tagAssignments ?? {},
          tagOrder: group.tagOrder ?? [],
        })
      })
      return id
    },

    addObjectToGroup: (objectId, groupId) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (group && !group.objectIds.includes(objectId)) {
          group.objectIds.push(objectId)
        }
      })
    },

    removeObjectFromGroup: (objectId, groupId) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group) return
        const hadObjects = group.objectIds.length > 0
        group.objectIds = group.objectIds.filter((id) => id !== objectId)
        if (hadObjects && group.objectIds.length === 0) {
          const obj = state.objects.find((o) => o.id === objectId)
          if (obj) {
            const padding = 30
            const newPosition = {
              x: obj.position.x - padding,
              y: obj.position.y - padding,
            }
            const newSize = {
              width: obj.size.width + padding * 2,
              height: obj.size.height + padding * 2,
            }
            const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
            if (diagram) {
              writePlacement(state, diagram, groupId, { position: newPosition, size: newSize }, {})
            } else {
              group.position = newPosition
              group.size = newSize
            }
          }
        }
      })
    },

    rememberTagSnapshots: (snapshots) => {
      set((state) => {
        for (const snapshot of snapshots) rememberTagSnapshot(state.tags, snapshot)
      })
    },

    addTagToObject: (objectId, tagId, snapshot) => {
      set((state) => {
        const obj = state.objects.find((o) => o.id === objectId)
        if (!obj) return
        rememberTagSnapshot(state.tags, snapshot)
        assignTag(obj, tagId)
      })
    },

    removeTagFromObject: (objectId, tagId) => {
      set((state) => {
        const obj = state.objects.find((o) => o.id === objectId)
        if (obj) unassignTag(obj, tagId)
      })
    },

    addTagToConnection: (connectionId, tagId, snapshot) => {
      set((state) => {
        const connection = state.connections.find((candidate) => candidate.id === connectionId)
        if (!connection) return
        rememberTagSnapshot(state.tags, snapshot)
        assignTag(connection, tagId)
      })
    },

    removeTagFromConnection: (connectionId, tagId) => {
      set((state) => {
        const connection = state.connections.find((candidate) => candidate.id === connectionId)
        if (connection) unassignTag(connection, tagId)
      })
    },

    addTagToGroup: (groupId, tagId, snapshot) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group) return
        rememberTagSnapshot(state.tags, snapshot)
        assignTag(group, tagId)
      })
    },

    removeTagFromGroup: (groupId, tagId) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (group) unassignTag(group, tagId)
      })
    },

    // Normalize ordered CRDT assignment maps after concurrent edits. Catalog
    // metadata is deliberately not synthesized from workspace content.
    reconcileTags: () => {
      set((state) => {
        for (const entity of [...state.objects, ...state.connections, ...state.groups]) {
          // Selective CRDT sync may expose an entity before newly-added map/list
          // fields arrive. Initialize the stable-assignment containers at this
          // boundary; this is not a legacy-format conversion.
          if (entity.tagAssignments === undefined) entity.tagAssignments = {}
          const normalizedOrder = orderedTagIds(entity)
          const currentOrder = entity.tagOrder
          if (
            currentOrder === undefined
            || currentOrder.length !== normalizedOrder.length
            || currentOrder.some((tagId, index) => tagId !== normalizedOrder[index])
          ) {
            entity.tagOrder = normalizedOrder
          }
        }
      })
    },

    updateGroup: (id, data) => {
      const { position, size, ...rest } = data
      const placementOnly = Object.keys(rest).every((key) => key === 'autoSize')
      const before = get()
      const diagram = before.diagrams.find((candidate) => candidate.id === before.currentDiagramId)
      const currentGroup = before.groups.find((group) => group.id === id)
      let placementRevision: number | undefined
      if (diagram && currentGroup && (position || size)) {
        const resolved = readPlacement(diagram, id, { position: currentGroup.position, size: currentGroup.size })
        placementRevision = recordPlacementIntent(diagram.id, activeLayoutSpace(), {
          groups: [{
            id,
            position: position ?? resolved.position,
            size: size ?? resolved.size,
            autoSize: rest.autoSize,
          }],
        })
      }
      set((state) => {
        applyGroupUpdate(state, id, data)
        if (placementRevision !== undefined && placementOnly) state.placementRevision = placementRevision
      })
    },

    deleteGroup: (id) => {
      set((state) => {
        // A connection can END on a group, and this path used to leave those
        // behind: Model Connections then renders them as `Unknown → Unknown`
        // (heavyViews.ts resolves endpoint names from objects only). The bulk
        // path already swept them, so the two deletes disagreed on the same
        // model edit depending on how the user reached it.
        const incidentConnectionIds = new Set(
          state.connections
            .filter((connection) => connection.fromId === id || connection.toId === id)
            .map((connection) => connection.id)
        )
        for (const connection of state.connections) {
          // Lower connections are derived and regenerate from the model, so they
          // are removed but never tombstoned — same rule as deleteObject.
          if (connection.kind === 'lower' || !incidentConnectionIds.has(connection.id)) continue
          if (!state.pendingDeletedConnectionIds.includes(connection.id)) {
            state.pendingDeletedConnectionIds.push(connection.id)
          }
        }
        if (!state.pendingDeletedGroupIds.includes(id)) state.pendingDeletedGroupIds.push(id)
        state.groups = state.groups.filter((g) => g.id !== id)
        state.connections = state.connections.filter((c) => !incidentConnectionIds.has(c.id))
        state.selectedItems = state.selectedItems.filter((s) => s.id !== id)
        state.diagrams.forEach((d) => {
          d.groupIds = d.groupIds.filter((gid) => gid !== id)
          d.connectionIds = d.connectionIds.filter((cid) => !incidentConnectionIds.has(cid))
          if (d.layouts) {
            delete d.layouts[id]
            for (const cid of incidentConnectionIds) delete d.layouts[cid]
          }
          if (d.layouts3d) {
            delete d.layouts3d[id]
            for (const cid of incidentConnectionIds) delete d.layouts3d[cid]
          }
        })
      })
    },

    // Bulk selection actions
    deleteSelectedItems: () => {
      set((state) => {
        const objectIds = state.selectedItems.filter((s) => s.type === 'object').map((s) => s.id)
        const connectionIds = state.selectedItems.filter((s) => s.type === 'connection').map((s) => s.id)
        const groupIds = state.selectedItems.filter((s) => s.type === 'group').map((s) => s.id)
        const removed = (connection: Connection) =>
          connectionIds.includes(connection.id)
          || objectIds.includes(connection.fromId)
          || objectIds.includes(connection.toId)
          || groupIds.includes(connection.fromId)
          || groupIds.includes(connection.toId)
        const removedConnectionIds = state.connections.filter(removed).map((c) => c.id)
        const removedModelConnectionIds = state.connections
          .filter((connection) => connection.kind !== 'lower' && removed(connection))
          .map((connection) => connection.id)

        for (const objectId of objectIds) {
          if (!state.pendingDeletedObjectIds.includes(objectId)) state.pendingDeletedObjectIds.push(objectId)
        }
        for (const connectionId of removedModelConnectionIds) {
          if (!state.pendingDeletedConnectionIds.includes(connectionId)) {
            state.pendingDeletedConnectionIds.push(connectionId)
          }
        }

        for (const groupId of groupIds) {
          if (!state.pendingDeletedGroupIds.includes(groupId)) state.pendingDeletedGroupIds.push(groupId)
        }

        state.objects = state.objects.filter((o) => !objectIds.includes(o.id))
        state.connections = state.connections.filter(
          (c) => !connectionIds.includes(c.id) && !objectIds.includes(c.fromId) && !objectIds.includes(c.toId) && !groupIds.includes(c.fromId) && !groupIds.includes(c.toId)
        )
        state.groups = state.groups.filter((g) => !groupIds.includes(g.id))
        // A layout key is MEMBERSHIP, not existence, and this path never dropped
        // one — deleteObject and deleteGroup both do. A stale key resurrects the
        // old position the moment the same id comes back (undo, an import that
        // keeps existing ids, a draft merge), so the shape teleports.
        const droppedIds = [...objectIds, ...groupIds, ...removedConnectionIds]
        state.diagrams.forEach((d) => {
          d.objectIds = d.objectIds.filter((oid) => !objectIds.includes(oid))
          d.connectionIds = d.connectionIds.filter((cid) => {
            if (connectionIds.includes(cid)) return false
            const conn = state.connections.find((c) => c.id === cid)
            return conn && !objectIds.includes(conn.fromId) && !objectIds.includes(conn.toId) && !groupIds.includes(conn.fromId) && !groupIds.includes(conn.toId)
          })
          d.groupIds = d.groupIds.filter((gid) => !groupIds.includes(gid))
          for (const droppedId of droppedIds) {
            if (d.layouts) delete d.layouts[droppedId]
            if (d.layouts3d) delete d.layouts3d[droppedId]
          }
        })
        state.groups.forEach((g) => {
          g.objectIds = g.objectIds.filter((oid) => !objectIds.includes(oid))
        })
        state.selectedItems = []
      })
    },

    moveSelectedItems: (delta) => {
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
        for (const item of state.selectedItems) {
          if (item.type === 'object') {
            const obj = state.objects.find((o) => o.id === item.id)
            if (diagram) {
              // Delta applies to the ACTIVE layer's resolved position (a 3D nudge
              // starts from the 3D placement, not the 2D one).
              const current = readPlacement(diagram, item.id, { position: obj?.position, size: obj?.size })
              if (current.position) {
                writePlacement(
                  state,
                  diagram,
                  item.id,
                  { position: { x: current.position.x + delta.x, y: current.position.y + delta.y } },
                  { size: current.size ?? { width: 100, height: 80 } },
                )
              }
            } else if (obj) {
              obj.position = { x: obj.position.x + delta.x, y: obj.position.y + delta.y }
            }
          } else if (item.type === 'group') {
            const group = state.groups.find((g) => g.id === item.id)
            if (diagram) {
              const current = readPlacement(diagram, item.id, { position: group?.position, size: group?.size })
              if (current.position) {
                writePlacement(
                  state,
                  diagram,
                  item.id,
                  { position: { x: current.position.x + delta.x, y: current.position.y + delta.y } },
                  { size: current.size ?? { width: 100, height: 80 } },
                )
              }
            } else if (group && group.position) {
              group.position = { x: group.position.x + delta.x, y: group.position.y + delta.y }
            }
          }
        }
      })
    },

    addSelectedToGroup: (groupId) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group) return
        for (const item of state.selectedItems) {
          if (item.type === 'object' && !group.objectIds.includes(item.id)) {
            group.objectIds.push(item.id)
          }
        }
      })
    },

    removeSelectedFromGroup: (groupId) => {
      set((state) => {
        const group = state.groups.find((g) => g.id === groupId)
        if (!group) return
        for (const item of state.selectedItems) {
          if (item.type === 'object') {
            group.objectIds = group.objectIds.filter((id) => id !== item.id)
          }
        }
      })
    },

    setScopeForSelected: (scope) => {
      set((state) => {
        for (const item of state.selectedItems) {
          if (item.type === 'object') {
            const obj = state.objects.find((o) => o.id === item.id)
            if (obj) obj.scope = scope
          }
        }
      })
    },

    selectAllInDiagram: () => {
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
        if (!diagram) return
        const objectItems = diagram.objectIds
          .map((oid) => state.objects.find((o) => o.id === oid))
          .filter(Boolean)
          .map((o) => ({ id: o!.id, type: 'object' as const }))
        state.selectedItems = objectItems
      })
    },

    getChildObjects: (parentId) => {
      return get().objects.filter((o) => o.parentId === parentId)
    },

    getObjectConnectionCount: (objectId) => {
      // O(degree) via the endpoint reverse maps. Self-loops appear in both maps,
      // so subtract them to count each connection once.
      const idx = getDiagramIndex()
      const from = idx.connectionsByFromId.get(objectId)
      const to = idx.connectionsByToId.get(objectId)
      let count = (from?.length ?? 0) + (to?.length ?? 0)
      if (from) for (const c of from) if (c.toId === objectId) count--
      return count
    },

    getObjectDiagramCount: (objectId) => {
      return getDiagramIndex().objectToDiagramIds.get(objectId)?.size ?? 0
    },

    getGroupConnectionCount: (groupId) => {
      const idx = getDiagramIndex()
      const from = idx.connectionsByFromId.get(groupId)
      const to = idx.connectionsByToId.get(groupId)
      let count = (from?.length ?? 0) + (to?.length ?? 0)
      if (from) for (const c of from) if (c.toId === groupId) count--
      return count
    },

    getGroupDiagramCount: (groupId) => {
      const group = get().groups.find((g) => g.id === groupId)
      if (!group) return 0
      const memberIds = new Set(group.objectIds)
      return get().diagrams.filter((d) => d.objectIds.some((oid) => memberIds.has(oid))).length
    },

    getDescendantObjects: (objectId) => {
      // BFS over the parent->children reverse map: O(descendants) instead of
      // O(all-objects) per level.
      const idx = getDiagramIndex()
      const result: string[] = []
      const seen = new Set<string>()
      const queue = [objectId]
      while (queue.length > 0) {
        const current = queue.shift()!
        const children = idx.childrenByParentId.get(current)
        if (!children) continue
        for (const child of children) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          result.push(child.id)
          queue.push(child.id)
        }
      }
      return result
    },

    getGroupClosure: (groupId) => {
      const group = get().groups.find((g) => g.id === groupId)
      if (!group) return []
      const closure = new Set<string>()
      for (const objId of group.objectIds) {
        closure.add(objId)
        for (const desc of get().getDescendantObjects(objId)) {
          closure.add(desc)
        }
      }
      return Array.from(closure)
    },

    getRelatedDiagrams: (objectId, options) => {
      const state = get()
      const excluded = options?.includeCurrent ? null : state.currentDiagramId
      const idx = getDiagramIndex()
      const obj = idx.objectById.get(objectId)
      if (!obj) return { detail: [], reference: [], parent: [] }

      const detail: Diagram[] = []
      const reference: Diagram[] = []
      const parent: Diagram[] = []
      const seen = new Set<string>()

      // Every bucket is a reverse-map lookup plus an id resolution, both O(1).
      // This used to be O(D) twice over — a `diagrams.find` per posting, and an
      // unindexed full scan for detail+parent — which the canvas paid once per
      // visible shape. At 50k diagrams and 500 shapes that was ~10^8 iterations
      // per fire, on a trigger (a layout change) that cannot alter membership.
      const collect = (
        ids: ReadonlySet<string> | undefined,
        into: Diagram[],
      ) => {
        if (!ids) return
        for (const did of ids) {
          if (did === excluded || seen.has(did)) continue
          const diagram = idx.diagramById.get(did)
          if (!diagram) continue
          into.push(diagram)
          seen.add(did)
        }
      }

      // Order matters: reference wins over detail wins over parent for the same
      // diagram, which is the precedence the other three tier implementations
      // apply too (paged, IndexedDB postings, SQL).
      collect(idx.objectToDiagramIds.get(objectId), reference)
      collect(idx.diagramIdsByParentObjectId.get(objectId), detail)
      if (obj.parentId) collect(idx.diagramIdsByParentObjectId.get(obj.parentId), parent)

      return { detail, reference, parent }
    },

    addObjectToModel: (obj) => {
      const id = generateId()
      set((state) => {
        state.objects.push({ ...obj, id, tagAssignments: obj.tagAssignments ?? {}, tagOrder: obj.tagOrder ?? [] })
      })
      return id
    },

    addDomain: (domain) => {
      const id = generateId()
      set((state) => {
        state.domains.push({ ...domain, id })
      })
      return id
    },

    updateDomain: (id, data) => {
      set((state) => {
        const domain = state.domains.find((d) => d.id === id)
        if (domain) {
          Object.assign(domain, data)
        }
      })
    },

    deleteDomain: (id) => {
      set((state) => {
        state.domains = state.domains.filter((d) => d.id !== id)
        // Unassign objects/groups/diagrams/flows from this domain
        state.objects.forEach((o) => { if (o.domainId === id) delete o.domainId })
        state.groups.forEach((g) => { if (g.domainId === id) delete g.domainId })
        state.diagrams.forEach((d) => { if (d.domainId === id) delete d.domainId })
        state.flows.forEach((f) => { if (f.domainId === id) delete f.domainId })
      })
    },

    getDefaultDomain: () => {
      return get().domains[0]
    },

    getChildDomains: (parentId) => {
      return get().domains.filter((d) => d.parentId === parentId)
    },

    removeObjectFromDiagram: (objectId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (!diagram) return
        diagram.objectIds = diagram.objectIds.filter((id) => id !== objectId)
        diagram.connectionIds = diagram.connectionIds.filter((cid) => {
          const conn = state.connections.find((c) => c.id === cid)
          return conn && conn.fromId !== objectId && conn.toId !== objectId
        })
        state.selectedItems = state.selectedItems.filter((s) => !(s.type === 'object' && s.id === objectId))
      })
      get().syncLowerConnections(targetDiagramId)
    },

    removeObjectsFromDiagram: (objectIds, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return
      const idSet = new Set(objectIds)
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (!diagram) return
        diagram.objectIds = diagram.objectIds.filter((id) => !idSet.has(id))
        diagram.connectionIds = diagram.connectionIds.filter((cid) => {
          const conn = state.connections.find((c) => c.id === cid)
          return conn && !idSet.has(conn.fromId) && !idSet.has(conn.toId)
        })
        state.selectedItems = state.selectedItems.filter((s) => !(s.type === 'object' && idSet.has(s.id)))
      })
      get().syncLowerConnections(targetDiagramId)
    },

    isObjectOnlyInDiagram: (objectId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return false
      const s = getDiagramIndex().objectToDiagramIds.get(objectId)
      return s != null && s.size === 1 && s.has(targetDiagramId)
    },

    removeConnectionFromDiagram: (connectionId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (!diagram) return
        diagram.connectionIds = diagram.connectionIds.filter((id) => id !== connectionId)
      })
    },

    isConnectionOnlyInDiagram: (connectionId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return false
      const s = getDiagramIndex().connectionToDiagramIds.get(connectionId)
      return s != null && s.size === 1 && s.has(targetDiagramId)
    },

    removeGroupFromDiagram: (groupId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (!diagram) return
        diagram.groupIds = diagram.groupIds.filter((id) => id !== groupId)
        // A group is a real connection endpoint (`fromType: 'object' | 'group'`),
        // so a connection anchored to it has to leave with it. Left behind, the
        // canvas cannot draw it — `getConnectionGeometry` returns null on an
        // endpoint it cannot resolve — and cannot offer it either, so it becomes
        // invisible AND unreachable while still counting in every diagram total.
        // `deleteGroup` already sweeps for the same reason; this path did not.
        diagram.connectionIds = diagram.connectionIds.filter((cid) => {
          const conn = state.connections.find((c) => c.id === cid)
          return conn && conn.fromId !== groupId && conn.toId !== groupId
        })
        state.selectedItems = state.selectedItems.filter((s) => !(s.type === 'group' && s.id === groupId))
      })
      get().syncLowerConnections(targetDiagramId)
    },

    removeGroupsFromDiagram: (groupIds, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return
      const idSet = new Set(groupIds)
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (!diagram) return
        diagram.groupIds = diagram.groupIds.filter((id) => !idSet.has(id))
        // Same orphan sweep as the single-group path above.
        diagram.connectionIds = diagram.connectionIds.filter((cid) => {
          const conn = state.connections.find((c) => c.id === cid)
          return conn && !idSet.has(conn.fromId) && !idSet.has(conn.toId)
        })
        state.selectedItems = state.selectedItems.filter((s) => !(s.type === 'group' && idSet.has(s.id)))
      })
      get().syncLowerConnections(targetDiagramId)
    },

    isGroupOnlyInDiagram: (groupId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return false
      const s = getDiagramIndex().groupToDiagramIds.get(groupId)
      return s != null && s.size === 1 && s.has(targetDiagramId)
    },

    addGroupToDiagram: (groupId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (diagram && !diagram.groupIds.includes(groupId)) {
          diagram.groupIds.push(groupId)
          const group = state.groups.find((g) => g.id === groupId)
          if (group && !diagram.layouts?.[groupId]) {
            if (!diagram.layouts) diagram.layouts = {}
            if (group.position && group.size) {
              diagram.layouts[groupId] = { position: group.position, size: group.size }
            } else if (group.objectIds.every((oid) => !diagram.objectIds.includes(oid))) {
              // The group has NO members on this diagram and no stored geometry (e.g. an existing
              // "— Data" group added from elsewhere). Without a layout the canvas computes a null
              // bbox and the group is invisible. Give it a default, slightly-staggered box so it
              // renders as a draggable drop target the user can populate.
              const n = Object.keys(diagram.layouts).length
              diagram.layouts[groupId] = {
                position: { x: 200 + (n % 6) * 40, y: 200 + (n % 6) * 40 },
                size: { width: 240, height: 160 },
              }
            }
          }
        }
      })
      get().syncLowerConnections(targetDiagramId)
    },

    addObjectToDiagram: (objectId, diagramId) => {
      const targetDiagramId = diagramId || get().currentDiagramId
      if (!targetDiagramId) return
      set((state) => {
        const diagram = state.diagrams.find((d) => d.id === targetDiagramId)
        if (diagram && !diagram.objectIds.includes(objectId)) {
          diagram.objectIds.push(objectId)
          const obj = state.objects.find((o) => o.id === objectId)
          if (obj && !diagram.layouts?.[objectId]) {
            if (!diagram.layouts) diagram.layouts = {}
            diagram.layouts[objectId] = { position: obj.position, size: obj.size }
          }
        }
      })
      get().syncLowerConnections(targetDiagramId)
    },

    syncAllLowerConnections: (endpointIds, reachedDiagramIds) => {
      // Debounced: rapid connection mutations (add/update/delete) batch into one
      // pass ~100 ms after the last call, avoiding O(D×C×O) per keystroke.
      // Scoped to the diagrams the endpoints reach when the caller names them
      // (see scheduleSyncAll for the measurement).
      scheduleSyncAll(get, endpointIds, reachedDiagramIds)
    },

    addFlow: (flow) => {
      const id = generateId()
      set((state) => {
        state.flows.push({ ...flow, id })
      })
      return id
    },

    updateFlow: (id, data) => {
      set((state) => {
        const flow = state.flows.find((f) => f.id === id)
        if (flow) Object.assign(flow, data)
      })
    },

    deleteFlow: (id) => {
      set((state) => {
        state.flows = state.flows.filter((f) => f.id !== id)
        if (state.currentDiagramId) {
          const ui = useUIStore.getState()
          if (ui.currentFlowId === id) ui.setCurrentFlow(null)
        }
      })
    },

    addFlowStep: (flowId, step) => {
      const id = generateId()
      set((state) => {
        const flow = state.flows.find((f) => f.id === flowId)
        if (!flow) return
        const order = flow.steps.length > 0 ? Math.max(...flow.steps.map((s) => s.order)) + 1 : 1
        flow.steps.push({ ...step, id, order } as FlowStep)
      })
      return id
    },

    updateFlowStep: (flowId, stepId, data) => {
      set((state) => {
        const flow = state.flows.find((f) => f.id === flowId)
        if (!flow) return
        const step = flow.steps.find((s) => s.id === stepId)
        if (step) Object.assign(step, data)
      })
    },

    deleteFlowStep: (flowId, stepId) => {
      set((state) => {
        const flow = state.flows.find((f) => f.id === flowId)
        if (!flow) return
        flow.steps = flow.steps.filter((s) => s.id !== stepId)
      })
    },

    reorderFlowSteps: (flowId, stepIds) => {
      set((state) => {
        const flow = state.flows.find((f) => f.id === flowId)
        if (!flow) return
        const map = new Map(flow.steps.map((s) => [s.id, s]))
        flow.steps = stepIds.map((id, i) => {
          const s = map.get(id)!
          s.order = i + 1
          return s
        })
      })
    },

    duplicateFlowStep: (flowId, stepId) => {
      const id = generateId()
      set((state) => {
        const flow = state.flows.find((f) => f.id === flowId)
        if (!flow) return
        const step = flow.steps.find((s) => s.id === stepId)
        if (!step) return
        const order = Math.max(...flow.steps.map((s) => s.order)) + 1
        flow.steps.push({ ...step, id, order } as FlowStep)
      })
      return id
    },

    duplicateFlow: (flowId) => {
      const id = generateId()
      set((state) => {
        const flow = state.flows.find((f) => f.id === flowId)
        if (!flow) return
        state.flows.push({
          ...flow,
          id,
          name: `${flow.name} (copy)`,
          steps: flow.steps.map((s) => ({ ...s, id: generateId() })),
        })
      })
      return id
    },

    addComment: (comment) => {
      const id = generateId()
      const now = new Date().toISOString()
      set((state) => {
        state.comments.push({ ...comment, id, createdAt: now })
      })
      return id
    },

    updateComment: (id, data) => {
      set((state) => {
        const comment = state.comments.find((c) => c.id === id)
        if (comment) Object.assign(comment, data)
      })
    },

    deleteComment: (id) => {
      set((state) => {
        state.comments = state.comments.filter((c) => c.id !== id)
      })
    },

    addReply: (commentId, text, authorship = { author: LEGACY_COMMENT_AUTHOR }) => {
      const id = generateId()
      const now = new Date().toISOString()
      set((state) => {
        const comment = state.comments.find((c) => c.id === commentId)
        if (!comment) return
        comment.replies.push({
          id,
          text,
          author: authorship.author,
          ...(authorship.authorId ? { authorId: authorship.authorId } : {}),
          createdAt: now,
        })
      })
    },

    deleteReply: (commentId, replyId) => {
      set((state) => {
        const comment = state.comments.find((c) => c.id === commentId)
        if (!comment) return
        comment.replies = comment.replies.filter((r) => r.id !== replyId)
      })
    },

    toggleResolved: (commentId) => {
      set((state) => {
        const comment = state.comments.find((c) => c.id === commentId)
        if (comment) comment.resolved = !comment.resolved
      })
    },

    togglePinned: (commentId) => {
      set((state) => {
        const comment = state.comments.find((c) => c.id === commentId)
        if (comment) comment.pinned = !comment.pinned
      })
    },

    getCommentsForDiagram: (diagramId) => {
      return get().comments.filter((c) => c.diagramId === diagramId)
    },

    syncLowerConnections: (diagramId) => {
      // Derive from a PLAIN snapshot (get()), not inside the immer recipe. Doing
      // the lookup-map building + the all-connections scan inside set() drafted
      // ~25k proxies over the objects/connections arrays and froze diagram
      // switches for ~7.5s at 15k/10k. The algorithm is unchanged — only *where*
      // it runs: read plain here, then apply one minimal recipe that swaps whole
      // array refs (immer never drafts the big element arrays). The derivation
      // and the commit live in deriveLowerConnections / commitLowerSync, shared
      // with the debounced pass and the idle heal, which build the context
      // once for many diagrams.
      const ctx = buildLowerSyncContext(get())
      if (deriveLowerConnections(ctx, diagramId)) commitLowerSync(ctx)
    },

    // Decision record actions
    addDecisionRecord: (record) => {
      const id = generateId()
      const now = new Date().toISOString()
      const number = get().getNextADRNumber()
      set((state) => {
        state.decisionRecords.push({
          ...record,
          id,
          number,
          createdAt: now,
          updatedAt: now,
          content: record.content || '',
          history: [{ status: record.status, date: now }],
        })
      })
      return id
    },

    updateDecisionRecord: (id, data) => {
      set((state) => {
        const record = state.decisionRecords.find((r) => r.id === id)
        if (!record) return
        const now = new Date().toISOString()
        // Append a status-change event so the timeline reflects this record's own
        // history. Seed the prior status first for records created before `history`.
        if (data.status !== undefined && data.status !== record.status) {
          if (!record.history || record.history.length === 0) {
            record.history = [{ status: record.status, date: record.createdAt }]
          }
          record.history.push({ status: data.status, date: now })
        }
        Object.assign(record, data, { updatedAt: now })
      })
    },

    deleteDecisionRecord: (id) => {
      set((state) => {
        state.decisionRecords = state.decisionRecords.filter((r) => r.id !== id)
      })
    },

    getNextADRNumber: () => {
      const records = get().decisionRecords
      if (records.length === 0) return 1
      return Math.max(...records.map((r) => r.number)) + 1
    },
  }))
)

// ---------------------------------------------------------------------------
// Wire up the DiagramIndex subscriber.
// Runs once per store change; short-circuits when none of the four source
// arrays have changed identity (i.e. only selectedItems / currentDiagramId
// changed).
// ---------------------------------------------------------------------------
;(function wireIndexSubscriber() {
  let prevDiagrams: Diagram[]    = []
  let prevObjects: C4Object[]    = []
  let prevConnections: Connection[] = []
  let prevGroups: Group[]         = []

  useModelStore.subscribe((state) => {
    const diagramsChanged    = state.diagrams    !== prevDiagrams
    const objectsChanged     = state.objects     !== prevObjects
    const connectionsChanged = state.connections !== prevConnections
    const groupsChanged      = state.groups      !== prevGroups
    if (!diagramsChanged && !objectsChanged && !connectionsChanged && !groupsChanged) return

    // Rebuild only the map-groups whose source array changed; reuse the rest by
    // reference. Assemble a fresh snapshot so getDiagramIndex() stays consistent.
    const idx = _diagramIndex
    _diagramIndex = {
      ...(diagramsChanged
        ? buildDiagramMaps(state.diagrams)
        : {
            objectToDiagramIds: idx.objectToDiagramIds,
            connectionToDiagramIds: idx.connectionToDiagramIds,
            groupToDiagramIds: idx.groupToDiagramIds,
            diagramById: idx.diagramById,
            diagramIdsByParentObjectId: idx.diagramIdsByParentObjectId,
          }),
      ...(objectsChanged
        ? buildObjectMaps(state.objects)
        : { objectById: idx.objectById, childrenByParentId: idx.childrenByParentId, teamIds: idx.teamIds }),
      ...(connectionsChanged
        ? buildConnectionMaps(state.connections)
        : { connectionById: idx.connectionById, connectionsByFromId: idx.connectionsByFromId, connectionsByToId: idx.connectionsByToId }),
      ...(groupsChanged ? buildGroupMaps(state.groups) : { groupById: idx.groupById }),
    }

    if (diagramsChanged)    prevDiagrams    = state.diagrams
    if (objectsChanged)     prevObjects     = state.objects
    if (connectionsChanged) prevConnections = state.connections
    if (groupsChanged)      prevGroups      = state.groups
  })
})()
