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

import type { FullModel, FullDiagram, DiagramDetail } from './materialize.js'

/**
 * 3-way content diff of a draft against its parent.
 *   base   = parent @ fork (a draft's base_manifest, materialized at those heads)
 *   ours   = parent @ now  (the live default version, which may have advanced)
 *   theirs = draft @ now
 *
 * `changes` = the DRAFT's created/updated/deleted vs base (what the Changes UI shows).
 * `conflicts` = ids BOTH the draft and the live model changed vs base, incompatibly —
 * these block the merge. Convergent edits (both deleted, both set to the same
 * value, or only one side changed) are NOT conflicts.
 *
 * "updated" = a durable-content field changed; transient/derived fields are ignored
 * (object/group position+size, connection waypoints/anchors, decisionRecord.updatedAt).
 * A move on a diagram lands in `diagram.layouts`, so it surfaces as a per-diagram LAYOUT
 * change, not a model-object change.
 */

export type ChangeKind = 'created' | 'updated' | 'deleted'
export type ModelCollection = 'object' | 'connection' | 'group' | 'domain' | 'tag' | 'decisionRecord'
export type ChangeCollection = ModelCollection | 'diagram' | 'layout' | 'flow'
export type ConflictKind = 'update/update' | 'update/delete' | 'delete/update' | 'unresolved'

export interface DraftChange {
  kind: ChangeKind
  collection: ChangeCollection
  id: string
  label: string
  /** Set for layout/flow changes (and echoed on diagram changes) for canvas focus + grouping. */
  diagramId?: string
}

/** A single differing field between the draft's value (mine) and the live model's (live). */
export interface ConflictDetail {
  field: string
  mine: string
  live: string
}

export interface DraftConflict {
  kind: ConflictKind
  collection: ChangeCollection
  id: string
  label: string
  diagramId?: string
  /** The fields that differ between mine (draft) and live, so the user can choose in place. */
  details?: ConflictDetail[]
}

export interface DiffResult {
  changes: DraftChange[]
  conflicts: DraftConflict[]
  counts: {
    /** Model-entity changes (objects/connections/groups/domains/tags/decisionRecords). */
    model: number
    /** Distinct diagrams touched (settings/composition/layout/flow). */
    diagrams: number
    conflicts: number
  }
}

type Dict = Record<string, unknown>
type Val = unknown

// --- equality ---------------------------------------------------------------

/** Stable stringify — recursively sorts object keys so key order doesn't matter;
 * array order is preserved (callers sort set-like arrays themselves). */
function canonical(v: Val): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const o = v as Dict
  // Drop undefined-valued keys so `{a: undefined}` ≡ `{}` (matches a JSON round-trip,
  // which the materialized models go through, and guards directly-built test models).
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}'
}

/** Deep equality ignoring key order, after stripping `ignore` top-level fields. */
function eqWithout(a: Val, b: Val, ignore: readonly string[]): boolean {
  return canonical(strip(a, ignore)) === canonical(strip(b, ignore))
}
function strip(v: Val, ignore: readonly string[]): Val {
  if (!ignore.length || v === null || typeof v !== 'object' || Array.isArray(v)) return v
  const o = { ...(v as Dict) }
  for (const k of ignore) delete o[k]
  return o
}

/** Fields excluded from each collection's content comparison (transient/derived/audit).
 * positions/sizes live in Diagram.layouts (a move is a diagram change, §layouts);
 * autoSize IS durable (a real group setting); *At stamps are audit churn. */
const IGNORE: Record<ModelCollection, readonly string[]> = {
  object: ['position', 'size'],
  // Routing currently lives on the model connection. Ignoring it made an
  // auto-layout merge data-dependent: a route-only edit vanished, while the
  // same route survived when another connection field also changed.
  connection: [],
  group: ['position', 'size'],
  domain: [],
  tag: [],
  decisionRecord: ['updatedAt', 'createdAt'],
}

// --- classification ---------------------------------------------------------

function classify(b: Val, x: Val, eq: (a: Val, c: Val) => boolean): ChangeKind | null {
  const hasB = b !== undefined
  const hasX = x !== undefined
  if (!hasB && hasX) return 'created'
  if (hasB && !hasX) return 'deleted'
  if (hasB && hasX && !eq(b, x)) return 'updated'
  return null
}

/** Conflict iff BOTH sides changed the same id vs base, incompatibly. `oEqT` is
 * meaningful only when both `ours` and `theirs` are present. */
function conflictOf(draft: ChangeKind, our: ChangeKind | null, oEqT: boolean): ConflictKind | null {
  if (!our) return null
  if (draft === 'deleted' && our === 'deleted') return null // convergent
  if (draft === 'updated' && our === 'updated') return oEqT ? null : 'update/update'
  if (draft === 'created' && our === 'created') return oEqT ? null : 'update/update'
  if (draft === 'updated' && our === 'deleted') return 'update/delete'
  if (draft === 'deleted' && our === 'updated') return 'delete/update'
  return 'update/update'
}

// --- labels -----------------------------------------------------------------

function labelOf(coll: ChangeCollection, v: Val, id: string): string {
  const o = (v ?? {}) as Dict
  if (coll === 'connection') {
    // Endpoint string only when endpoints exist, so an endpoint-less record falls back to the id.
    return (o.label as string) || (o.fromId != null && o.toId != null ? `${o.fromId} → ${o.toId}` : id)
  }
  if (coll === 'decisionRecord') return (o.title as string) || id
  return (o.name as string) || id
}

/** A short, human display of a value for the conflict comparison. */
function shortVal(v: Val): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v !== 'object') return String(v)
  const s = JSON.stringify(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}

/** The fields that differ between mine (draft) and live, for a conflict's resolve UI. */
function detailsFor(mine: Val, live: Val, ignore: readonly string[]): ConflictDetail[] {
  if (mine === undefined) return [{ field: '(presence)', mine: 'deleted in draft', live: 'edited in live' }]
  if (live === undefined) return [{ field: '(presence)', mine: 'edited in draft', live: 'deleted in live' }]
  const m = strip(mine, ignore) as Dict
  const l = strip(live, ignore) as Dict
  const out: ConflictDetail[] = []
  for (const k of new Set([...Object.keys(m), ...Object.keys(l)])) {
    if (k === 'id') continue
    if (canonical(m[k]) !== canonical(l[k])) out.push({ field: k, mine: shortVal(m[k]), live: shortVal(l[k]) })
  }
  return out
}

// --- model-collection diff --------------------------------------------------

function diffCollection(
  coll: ModelCollection,
  base: Dict,
  ours: Dict,
  theirs: Dict,
  out: DiffResult
): void {
  const ignore = IGNORE[coll]
  const eq = (a: Val, b: Val) => eqWithout(a, b, ignore)
  const ids = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])
  for (const id of ids) {
    const b = base[id]
    const o = ours[id]
    const t = theirs[id]
    const draft = classify(b, t, eq)
    if (!draft) continue
    const our = classify(b, o, eq)
    const oEqT = o !== undefined && t !== undefined ? eq(o, t) : false
    const label = labelOf(coll, t ?? b ?? o, id)
    out.changes.push({ kind: draft, collection: coll, id, label })
    const ck = conflictOf(draft, our, oEqT)
    if (ck) out.conflicts.push({ kind: ck, collection: coll, id, label, details: detailsFor(t, o, ignore) })
  }
}

// --- diagram diff -----------------------------------------------------------

const SETTINGS_IGNORE: readonly string[] = []

/** Sort set-like composition arrays so a reorder isn't a false "updated". */
function compositionKey(d: DiagramDetail): string {
  const sort = (a: string[]) => [...a].sort()
  return canonical({ o: sort(d.objectIds), c: sort(d.connectionIds), g: sort(d.groupIds) })
}
function diagramBodyEq(a: DiagramDetail, b: DiagramDetail): boolean {
  return (
    eqWithout(a.settings, b.settings, SETTINGS_IGNORE) &&
    compositionKey(a) === compositionKey(b) &&
    canonical(a.layouts) === canonical(b.layouts) &&
    canonical(a.flows) === canonical(b.flows)
  )
}
function settingsOrCompositionEq(a: DiagramDetail, b: DiagramDetail): boolean {
  return eqWithout(a.settings, b.settings, SETTINGS_IGNORE) && compositionKey(a) === compositionKey(b)
}
function diagramName(d: FullDiagram | undefined): string {
  return ((d?.meta?.name as string) || (d?.detail?.settings?.name as string) || d?.id) ?? '?'
}

/** Per-id sub-diff of a diagram's layouts or flows (carrying diagramId). */
function diffSubMap(
  coll: 'layout' | 'flow',
  diagramId: string,
  base: Dict,
  ours: Dict | undefined,
  theirs: Dict,
  out: DiffResult
): void {
  const eq = (a: Val, b: Val) => canonical(a) === canonical(b)
  const ids = new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(ours ?? {})])
  for (const id of ids) {
    const b = base[id]
    const o = ours?.[id]
    const t = theirs[id]
    const draft = classify(b, t, eq)
    if (!draft) continue
    const our = ours ? classify(b, o, eq) : null
    const oEqT = o !== undefined && t !== undefined ? eq(o, t) : false
    const label = coll === 'flow' ? ((t ?? b) as Dict)?.name as string || id : id
    out.changes.push({ kind: draft, collection: coll, id, label, diagramId })
    const ck = conflictOf(draft, our, oEqT)
    if (ck) out.conflicts.push({ kind: ck, collection: coll, id, label, diagramId, details: detailsFor(t, o, []) })
  }
}

function diffDiagrams(base: FullModel, ours: FullModel, theirs: FullModel, out: DiffResult): void {
  const ids = new Set([
    ...Object.keys(base.diagrams),
    ...Object.keys(ours.diagrams),
    ...Object.keys(theirs.diagrams),
  ])
  for (const id of ids) {
    const bd = base.diagrams[id]
    const od = ours.diagrams[id]
    const td = theirs.diagrams[id]
    const label = diagramName(td ?? bd ?? od)

    // Existence (registry membership).
    if (!bd && td) {
      out.changes.push({ kind: 'created', collection: 'diagram', id, label, diagramId: id })
      if (od && bd === undefined && !sameCreatedDiagram(od, td)) {
        out.conflicts.push({ kind: 'update/update', collection: 'diagram', id, label, diagramId: id, details: [{ field: '(diagram)', mine: 'created in draft', live: 'created in live' }] })
      }
      continue
    }
    if (bd && !td) {
      out.changes.push({ kind: 'deleted', collection: 'diagram', id, label, diagramId: id })
      // Draft deleted a diagram the live model edited → delete/update.
      if (od && bodyDiffers(bd, od)) {
        out.conflicts.push({ kind: 'delete/update', collection: 'diagram', id, label, diagramId: id, details: [{ field: '(presence)', mine: 'deleted in draft', live: 'edited in live' }] })
      }
      continue
    }
    if (!bd || !td) continue // not in base and not in draft → nothing

    // Both base & draft present. (1) If we can't read the BASE or DRAFT body we can't
    // tell what the draft did → fail safe.
    if (!bd.detail || !td.detail) {
      out.conflicts.push({ kind: 'unresolved', collection: 'diagram', id, label, diagramId: id })
      continue
    }
    // (2) The draft made NO body change → nothing to merge here, so a transient failure
    // to read the LIVE body is irrelevant; don't block merge over an untouched diagram.
    if (diagramBodyEq(bd.detail, td.detail)) continue
    // (3) The draft DID change the body but we can't read the live body → can't prove
    // convergence, so fail safe.
    if (od && !od.detail) {
      out.conflicts.push({ kind: 'unresolved', collection: 'diagram', id, label, diagramId: id })
      continue
    }

    const ourDeleted = !od // reached only when the draft DID change the body (see step 2)

    // Diagram-level (settings + composition) change.
    if (!settingsOrCompositionEq(bd.detail, td.detail)) {
      out.changes.push({ kind: 'updated', collection: 'diagram', id, label, diagramId: id })
      if (ourDeleted) {
        out.conflicts.push({ kind: 'update/delete', collection: 'diagram', id, label, diagramId: id, details: [{ field: '(presence)', mine: 'edited in draft', live: 'deleted in live' }] })
      } else if (
        od!.detail &&
        !settingsOrCompositionEq(bd.detail, od!.detail) &&
        !settingsOrCompositionEq(od!.detail, td.detail)
      ) {
        out.conflicts.push({ kind: 'update/update', collection: 'diagram', id, label, diagramId: id, details: detailsFor(td.detail.settings, od!.detail.settings, []) })
      }
    } else if (ourDeleted) {
      // Draft changed only layouts/flows (settings/composition equal) while the live
      // model deleted the diagram — reached only when the draft did change the body.
      out.conflicts.push({ kind: 'update/delete', collection: 'diagram', id, label, diagramId: id, details: [{ field: '(presence)', mine: 'edited in draft', live: 'deleted in live' }] })
    }

    // Per-id layout + flow sub-diffs (skip conflict side when the diagram was deleted —
    // the diagram-level update/delete above already records that collision).
    const ourLayouts = ourDeleted ? undefined : od!.detail!.layouts
    const ourFlows = ourDeleted ? undefined : od!.detail!.flows
    diffSubMap('layout', id, bd.detail.layouts, ourLayouts, td.detail.layouts, out)
    diffSubMap('flow', id, bd.detail.flows, ourFlows, td.detail.flows, out)
  }
}

/** Whole-diagram body comparison (meta + detail) for existence-conflict checks. */
function bodyDiffers(a: FullDiagram, b: FullDiagram): boolean {
  if (a.detail && b.detail) return !diagramBodyEq(a.detail, b.detail)
  return canonical(a.meta) !== canonical(b.meta)
}
function sameCreatedDiagram(a: FullDiagram, b: FullDiagram): boolean {
  return !bodyDiffers(a, b)
}

// --- entry point ------------------------------------------------------------

export function diffModels(base: FullModel, ours: FullModel, theirs: FullModel): DiffResult {
  const out: DiffResult = { changes: [], conflicts: [], counts: { model: 0, diagrams: 0, conflicts: 0 } }

  const collections: ModelCollection[] = ['object', 'connection', 'group', 'domain', 'tag', 'decisionRecord']
  const mapOf = (m: FullModel, c: ModelCollection): Dict => {
    switch (c) {
      case 'object': return m.objects
      case 'connection': return m.connections
      case 'group': return m.groups
      case 'domain': return m.domains
      case 'tag': return m.tagSnapshots
      case 'decisionRecord': return m.decisionRecords
    }
  }
  for (const c of collections) diffCollection(c, mapOf(base, c), mapOf(ours, c), mapOf(theirs, c), out)

  diffDiagrams(base, ours, theirs, out)

  // Counts.
  const modelColls = new Set<ChangeCollection>(collections)
  out.counts.model = out.changes.filter((c) => modelColls.has(c.collection)).length
  const touchedDiagrams = new Set<string>()
  for (const c of out.changes) {
    if (c.collection === 'diagram') touchedDiagrams.add(c.id)
    else if (c.diagramId) touchedDiagrams.add(c.diagramId)
  }
  out.counts.diagrams = touchedDiagrams.size
  out.counts.conflicts = out.conflicts.length
  return out
}

// --- conflict resolution -----------------------------------------------------

/** Per-conflict choice: keep the DRAFT's change, or keep the LIVE model's value. */
export type ConflictResolution = 'draft' | 'live'
export type Resolutions = Record<string, ConflictResolution>

/** Stable key identifying a change/conflict (a change and its conflict share it). */
export function conflictKey(c: { collection: ChangeCollection; id: string; diagramId?: string }): string {
  return `${c.collection}:${c.id}:${c.diagramId ?? ''}`
}

/**
 * Given a diff and the user's per-conflict resolutions, decide whether the merge can
 * proceed and which changes to apply. Blocks (returns the offending conflicts) when an
 * unresolvable conflict exists or any conflict is unresolved; otherwise drops every
 * change whose conflict was resolved to keep the LIVE value.
 */
export function resolveConflicts(
  diff: DiffResult,
  resolutions: Resolutions
): { blocked: DraftConflict[] | null; appliedChanges: DraftChange[] } {
  // A resolution only counts if it's exactly 'draft' or 'live' (garbage values don't unblock).
  const choice = (k: string): ConflictResolution | undefined => {
    const v = resolutions[k]
    return v === 'draft' || v === 'live' ? v : undefined
  }
  // 'unresolved' (a diagram body we couldn't read) can't be resolved via the UI — always blocks.
  const hard = diff.conflicts.filter((c) => c.kind === 'unresolved')
  if (hard.length) return { blocked: hard, appliedChanges: [] }
  const unresolved = diff.conflicts.filter((c) => choice(conflictKey(c)) === undefined)
  if (unresolved.length) return { blocked: unresolved, appliedChanges: [] }

  // 'live' = keep the live model's value → drop the draft's change for that id. A
  // DIAGRAM-level conflict resolved 'live' covers the whole diagram (its settings,
  // composition, layouts, and flows), whose sub-changes carry different keys.
  const liveKeys = new Set(diff.conflicts.filter((c) => choice(conflictKey(c)) === 'live').map(conflictKey))
  const liveDiagramIds = new Set(
    diff.conflicts.filter((c) => c.collection === 'diagram' && choice(conflictKey(c)) === 'live').map((c) => c.id)
  )
  const dropped = (ch: DraftChange): boolean =>
    liveKeys.has(conflictKey(ch)) ||
    (ch.collection === 'diagram' && liveDiagramIds.has(ch.id)) ||
    (ch.diagramId !== undefined && liveDiagramIds.has(ch.diagramId))
  return { blocked: null, appliedChanges: diff.changes.filter((ch) => !dropped(ch)) }
}
