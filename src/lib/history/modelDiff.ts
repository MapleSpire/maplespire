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

import type { C4Object, Connection, Diagram, Group, Position, Size } from '../../types'

/**
 * The difference between two model-store states, keyed by ENTITY ID — never by
 * array index. Undo/redo is built on it: a user action is recorded as the diff
 * between the store before and after it, and undone by applying that diff
 * backwards as an ordinary new local edit (see `applyDiff.ts`).
 *
 * Why ids and not immer's inverse patches: immer addresses arrays by index
 * (`objects/1234`), and a peer inserting or removing one element shifts every
 * later index — an index-addressed undo then rewrites the wrong entity.
 *
 * What is NOT here, on purpose:
 * - derived `kind: 'lower'` connections (the roll-up regenerates them);
 * - diagrams that exist on only one side (diagram create/delete is not undoable);
 * - flows, comments, ADRs, domains, the tag registry (not canvas edits).
 */

export type EntityKind = 'object' | 'connection' | 'group'
export type MembershipField = 'objectIds' | 'connectionIds' | 'groupIds'
export type LayoutSpace = '2d' | '3d'
export interface Placement { position: Position; size: Size }

type AnyEntity = C4Object | Connection | Group

export interface EntityChange {
  type: 'entity'
  kind: EntityKind
  id: string
  /** Whole immutable snapshots (immer freezes them). `undefined` = absent. */
  before?: AnyEntity
  after?: AnyEntity
  /** Restricts an UPDATE to these fields. Set on a partially applied change so
   * a redo only replays what the undo actually wrote. Absent = every changed field. */
  fields?: string[]
}

/** One id entering or leaving a diagram's `objectIds`/`connectionIds`/`groupIds`. */
export interface MembershipChange {
  type: 'membership'
  diagramId: string
  field: MembershipField
  id: string
  /** Present in the AFTER state (so absent in the before state). */
  present: boolean
}

/** One id entering or leaving a group's `objectIds`. */
export interface GroupMemberChange {
  type: 'groupMember'
  groupId: string
  id: string
  present: boolean
}

/** One placement in one layer of one diagram. */
export interface LayoutChange {
  type: 'layout'
  diagramId: string
  space: LayoutSpace
  id: string
  /** The raw layer entry on each side (`undefined` = no key). */
  before?: Placement
  after?: Placement
  /** What each side SHOWED in that space: the 3D layer falls back to 2D. Used to
   * restore a value rather than deleting a key, and to guard against a peer. */
  beforeResolved?: Placement
  afterResolved?: Placement
}

/** Any other diagram field (default connection shape, skin, ...). */
export interface DiagramFieldChange {
  type: 'diagramField'
  diagramId: string
  field: string
  before: unknown
  after: unknown
}

export type Change = EntityChange | MembershipChange | GroupMemberChange | LayoutChange | DiagramFieldChange

/** Insertion-ordered; the key identifies WHAT changed, so two diffs compose by key. */
export type ModelDiff = Map<string, Change>

export interface DiffableState {
  objects: readonly C4Object[]
  connections: readonly Connection[]
  groups: readonly Group[]
  diagrams: readonly Diagram[]
}

/** 3D routing twin → its 2D field. The fork-on-first-3D-edit stamps the 2D
 * values onto these twins; that copy SHOWS nothing new, so it is not a change. */
export const CONNECTION_3D_TWINS: Readonly<Record<string, string>> = {
  waypoints3d: 'waypoints',
  fromAnchor3d: 'fromAnchor',
  toAnchor3d: 'toAnchor',
  lockedToAnchors3d: 'lockedToAnchors',
  labelPosition3d: 'labelPosition',
  labelOffset3d: 'labelOffset',
  shape3d: 'shape',
}

const DIAGRAM_STRUCTURAL_FIELDS = new Set(['id', 'objectIds', 'connectionIds', 'groupIds', 'layouts', 'layouts3d'])
/** View-only or membership fields of a group that are not compared field-wise. */
const GROUP_SKIPPED_FIELDS = new Set(['objectIds', 'innerWrapperIds'])

export function entityKey(kind: EntityKind, id: string): string {
  return `${kind[0]}:${id}`
}
export function membershipKey(diagramId: string, field: MembershipField, id: string): string {
  return `m:${diagramId}:${field}:${id}`
}
export function groupMemberKey(groupId: string, id: string): string {
  return `gm:${groupId}:${id}`
}
export function layoutKey(diagramId: string, space: LayoutSpace, id: string): string {
  return `l:${diagramId}:${space}:${id}`
}
export function diagramFieldKey(diagramId: string, field: string): string {
  return `d:${diagramId}:${field}`
}

/** Structural equality for plain JSON-like values (what the store holds). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

/** The value a connection field SHOWS: a 3D twin falls back to its 2D field. */
export function resolvedConnectionField(c: object, field: string): unknown {
  const value = (c as Record<string, unknown>)[field]
  const base = CONNECTION_3D_TWINS[field]
  return base !== undefined && value === undefined ? (c as Record<string, unknown>)[base] : value
}

/** Fields that differ between two snapshots of the same entity. */
export function changedFields(kind: EntityKind, before: object, after: object): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: string[] = []
  for (const key of keys) {
    if (key === 'id') continue
    if (kind === 'group' && GROUP_SKIPPED_FIELDS.has(key)) continue
    const a = (before as Record<string, unknown>)[key]
    const b = (after as Record<string, unknown>)[key]
    if (deepEqual(a, b)) continue
    if (kind === 'connection' && key in CONNECTION_3D_TWINS
      && deepEqual(resolvedConnectionField(before, key), resolvedConnectionField(after, key))) {
      continue
    }
    out.push(key)
  }
  return out
}

function isLower(c: Connection | undefined): boolean {
  return c?.kind === 'lower'
}

/**
 * Walk two id-keyed lists. Immer keeps untouched elements by reference and in
 * place, so the common case (a few changed elements in a 12 000-element list)
 * costs one pass of pointer compares, no Map.
 */
function diffList<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
  onChange: (id: string, b: T | undefined, a: T | undefined) => void,
): void {
  if (before === after) return
  if (before.length === after.length) {
    let aligned = true
    const touched: number[] = []
    for (let i = 0; i < before.length; i++) {
      if (before[i] === after[i]) continue
      if (before[i].id !== after[i].id) { aligned = false; break }
      touched.push(i)
    }
    if (aligned) {
      for (const i of touched) onChange(before[i].id, before[i], after[i])
      return
    }
  }
  const beforeById = new Map<string, T>()
  for (const b of before) beforeById.set(b.id, b)
  const seen = new Set<string>()
  for (const a of after) {
    seen.add(a.id)
    const b = beforeById.get(a.id)
    if (b !== a) onChange(a.id, b, a)
  }
  for (const b of before) if (!seen.has(b.id)) onChange(b.id, b, undefined)
}

function diffMembership(
  out: ModelDiff,
  diagramId: string,
  field: MembershipField,
  before: readonly string[],
  after: readonly string[],
  skip: (id: string) => boolean,
): void {
  if (before === after) return
  const b = new Set(before)
  const a = new Set(after)
  for (const id of a) if (!b.has(id) && !skip(id)) out.set(membershipKey(diagramId, field, id), { type: 'membership', diagramId, field, id, present: true })
  for (const id of b) if (!a.has(id) && !skip(id)) out.set(membershipKey(diagramId, field, id), { type: 'membership', diagramId, field, id, present: false })
}

function diffLayouts(out: ModelDiff, before: Diagram, after: Diagram): void {
  // 2D layer: raw = shown.
  if (before.layouts !== after.layouts) {
    const b = before.layouts ?? {}
    const a = after.layouts ?? {}
    for (const id of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (b[id] === a[id] || deepEqual(b[id], a[id])) continue
      out.set(layoutKey(after.id, '2d', id), {
        type: 'layout', diagramId: after.id, space: '2d', id,
        before: b[id], after: a[id], beforeResolved: b[id], afterResolved: a[id],
      })
    }
  }
  // 3D layer: compare what the 3D board SHOWS (3D ?? 2D) so the fork copying
  // the 2D layout into `layouts3d` on the first 3D edit is not a change.
  if (before.layouts3d !== after.layouts3d) {
    const b = before.layouts3d ?? {}
    const a = after.layouts3d ?? {}
    for (const id of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (b[id] === a[id]) continue
      const beforeResolved = b[id] ?? before.layouts?.[id]
      const afterResolved = a[id] ?? after.layouts?.[id]
      if (deepEqual(beforeResolved, afterResolved)) continue
      out.set(layoutKey(after.id, '3d', id), {
        type: 'layout', diagramId: after.id, space: '3d', id,
        before: b[id], after: a[id], beforeResolved, afterResolved,
      })
    }
  }
}

/** Every change between two store states, see the module comment for scope. */
export function diffModel(before: DiffableState, after: DiffableState): ModelDiff {
  const out: ModelDiff = new Map()

  diffList(before.objects, after.objects, (id, b, a) => {
    if (b && a && changedFields('object', b, a).length === 0) return
    out.set(entityKey('object', id), { type: 'entity', kind: 'object', id, before: b, after: a })
  })

  diffList(before.connections, after.connections, (id, b, a) => {
    if (isLower(b) || isLower(a)) return
    if (b && a && changedFields('connection', b, a).length === 0) return
    out.set(entityKey('connection', id), { type: 'entity', kind: 'connection', id, before: b, after: a })
  })

  diffList(before.groups, after.groups, (id, b, a) => {
    if (b && a) {
      if (b.objectIds !== a.objectIds) {
        const bm = new Set(b.objectIds)
        const am = new Set(a.objectIds)
        for (const m of am) if (!bm.has(m)) out.set(groupMemberKey(id, m), { type: 'groupMember', groupId: id, id: m, present: true })
        for (const m of bm) if (!am.has(m)) out.set(groupMemberKey(id, m), { type: 'groupMember', groupId: id, id: m, present: false })
      }
      if (changedFields('group', b, a).length === 0) return
    }
    out.set(entityKey('group', id), { type: 'entity', kind: 'group', id, before: b, after: a })
  })

  if (before.diagrams !== after.diagrams) {
    // Lower connections enter and leave `connectionIds` with the roll-up; they
    // are regenerated after an undo, never replayed.
    let lowerIds: Set<string> | null = null
    const isLowerId = (id: string): boolean => {
      if (!lowerIds) {
        lowerIds = new Set()
        for (const c of before.connections) if (c.kind === 'lower') lowerIds.add(c.id)
        for (const c of after.connections) if (c.kind === 'lower') lowerIds.add(c.id)
      }
      return lowerIds.has(id)
    }
    const never = (): boolean => false
    diffList(before.diagrams, after.diagrams, (diagramId, b, a) => {
      if (!b || !a) return
      diffMembership(out, diagramId, 'objectIds', b.objectIds, a.objectIds, never)
      diffMembership(out, diagramId, 'connectionIds', b.connectionIds, a.connectionIds, isLowerId)
      diffMembership(out, diagramId, 'groupIds', b.groupIds, a.groupIds, never)
      diffLayouts(out, b, a)
      for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (DIAGRAM_STRUCTURAL_FIELDS.has(field)) continue
        const bv = (b as unknown as Record<string, unknown>)[field]
        const av = (a as unknown as Record<string, unknown>)[field]
        if (deepEqual(bv, av)) continue
        out.set(diagramFieldKey(diagramId, field), { type: 'diagramField', diagramId, field, before: bv, after: av })
      }
    })
  }
  return out
}

/** True when a change brings its subject back to where it started. */
function isNoop(change: Change): boolean {
  switch (change.type) {
    case 'entity': {
      if (!change.before || !change.after) return change.before === change.after
      const { before, after } = change
      const fields = change.fields ?? changedFields(change.kind, before, after)
      return fields.every((field) => deepEqual(
        (before as unknown as Record<string, unknown>)[field],
        (after as unknown as Record<string, unknown>)[field],
      ))
    }
    case 'layout':
      return deepEqual(change.before, change.after) && deepEqual(change.beforeResolved, change.afterResolved)
    case 'diagramField':
      return deepEqual(change.before, change.after)
    default:
      return false
  }
}

/** `first` then `second`, as one diff. Changes that cancel out disappear. */
export function composeDiffs(first: ModelDiff, second: ModelDiff): ModelDiff {
  const out: ModelDiff = new Map(first)
  for (const [key, next] of second) {
    const prev = out.get(key)
    if (!prev) { out.set(key, next); continue }
    let merged: Change | null
    if ((prev.type === 'membership' && next.type === 'membership') || (prev.type === 'groupMember' && next.type === 'groupMember')) {
      // in then out (or out then in) = no change at all
      merged = prev.present === next.present ? next : null
    } else if (prev.type === 'entity' && next.type === 'entity') {
      merged = { type: 'entity', kind: next.kind, id: next.id, before: prev.before, after: next.after }
      // An update keeps the fields its OWN steps changed. Recomputing them from
      // the first before and the last after would also pick up a field a peer
      // changed between two keystrokes, and undo would revert the peer.
      if (prev.before && prev.after && next.before && next.after && merged.before && merged.after) {
        const own = new Set([
          ...(prev.fields ?? changedFields(prev.kind, prev.before, prev.after)),
          ...(next.fields ?? changedFields(next.kind, next.before, next.after)),
        ])
        merged.fields = [...own]
      }
    } else if (prev.type === 'layout' && next.type === 'layout') {
      merged = { ...next, before: prev.before, beforeResolved: prev.beforeResolved }
    } else if (prev.type === 'diagramField' && next.type === 'diagramField') {
      merged = { ...next, before: prev.before }
    } else {
      merged = next
    }
    if (!merged || isNoop(merged)) out.delete(key)
    else out.set(key, merged)
  }
  return out
}

/** A diff without the keys of another (a remote apply observed mid-action). */
export function subtractKeys(diff: ModelDiff, keys: Iterable<string>): ModelDiff {
  const out: ModelDiff = new Map(diff)
  for (const key of keys) out.delete(key)
  return out
}

/** True when every change of `next` is an update to something `open` already
 * changed — the shape of a typing burst or a live drag, which coalesce. */
export function isContinuation(open: ModelDiff, next: ModelDiff): boolean {
  if (next.size === 0) return true
  for (const [key, change] of next) {
    if (!open.has(key)) return false
    if (change.type === 'membership' || change.type === 'groupMember') return false
    if (change.type === 'entity' && (!change.before || !change.after)) return false
  }
  return true
}
