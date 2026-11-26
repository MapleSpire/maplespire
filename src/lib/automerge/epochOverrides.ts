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

import { apiFetch } from '../api/http'
import { API_BASE } from '../api/base'
import { withWorkspaceParams } from '../modelQuery/workspaceParams'

/**
 * RE-APPLYING OVERRIDDEN OFFLINE EDITS (G4-16f) —
 * the browser half, pure where it can be.
 *
 * When the forwarder carries a late (offline) write into the current epoch
 * and the current epoch already changed the same leaf, the current epoch
 * wins and the server records an OVERRIDE ROW: the late value,
 * the value that beat it, the late changes' actors. This tab fetches the
 * PENDING rows whose actors are its own, and offers them for a BATCH
 * re-apply: all checked by default, each uncheckable.
 *
 * Re-apply, at the click:
 *  1. each checked row's CURRENT value is read from this tab's replica (the
 *     store, which projects the live documents). When it differs from the
 *     value that overrode it (`currentValueAtForward`), somebody edited the
 *     field since: the row is pulled out, unchecked, shown "changed since"
 *     (the check runs on the replica);
 *  2. the remaining rows are written as ONE store edit (one undo step), by
 *     this tab's own actor, on the current epoch, and flushed with every
 *     Automerge change carrying `{reapplyBatch: <uuid>}`;
 *  3. once that is durable, the rows are resolved BY BATCH ID, the unchecked
 *     ones dismissed with it. Undo reverts the batch's rows to `pending`.
 */

export type OverridePath = Array<string | number>

export interface OverrideRow {
  id: string
  entityKind: string
  entityId: string | null
  path: OverridePath
  reason: 'leaf' | 'sequence-replaced' | 'entity-deleted' | string
  lateValue: unknown
  currentValueAtForward: unknown
  currentHeadsAtForward: string[]
  targetDoc: string
  state: string
  createdAt: string
}

/** The store slice an override's document path addresses. */
export type OverrideCollection = 'objects' | 'connections' | 'groups'

const STORE_COLLECTIONS: Record<string, OverrideCollection> = { objects: 'objects', connections: 'connections', groups: 'groups' }

/** Rebuild a value the server rendered JSON-safe (`renderValue`) as the plain
 * value the store holds: the store keeps strings, numbers and plain
 * structures — an `ImmutableString` is a string to it, a date its ISO text. */
export function plainOf(rendered: unknown): unknown {
  if (Array.isArray(rendered)) return rendered.map(plainOf)
  if (rendered && typeof rendered === 'object') {
    const r = rendered as Record<string, unknown>
    const keys = Object.keys(r)
    if (keys.length === 1) {
      if ('$immutable' in r) return String(r.$immutable)
      if ('$counter' in r) return Number(r.$counter)
      if ('$date' in r) return String(r.$date)
      if ('$number' in r) return Number(r.$number)
      if ('$bytes' in r) return r.$bytes
    }
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plainOf(v)]))
  }
  return rendered
}

/** Order-insensitive for maps, exact for lists; `undefined` is `null`. */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v === undefined) return null
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]))
    return v
  }
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

export interface OverrideTarget {
  collection: OverrideCollection
  entityId: string
  /** Field path inside the entity; empty for a whole-entity (deleted) row. */
  field: OverridePath
}

/** Where a row lands in the store, or null when this build cannot re-apply
 * it here (the meta's domains, tags, decision records: edited on their own
 * pages). */
export function overrideTarget(row: OverrideRow): OverrideTarget | null {
  const [collection, entityId, ...field] = row.path
  const slice = STORE_COLLECTIONS[String(collection)]
  if (!slice || typeof entityId !== 'string') return null
  return { collection: slice, entityId, field }
}

export function readAt(root: unknown, path: OverridePath): unknown {
  return path.reduce<unknown>((node, step) => (node == null ? undefined : (node as Record<string | number, unknown>)[step]), root)
}

/** `entity` with `path` set to `value`, copied along the path (never in place). */
export function writeAt<T>(entity: T, path: OverridePath, value: unknown): T {
  if (path.length === 0) return value as T
  const [head, ...rest] = path
  const base = (entity ?? (typeof head === 'number' ? [] : {})) as Record<string | number, unknown>
  const copy = (Array.isArray(base) ? [...base] : { ...base }) as Record<string | number, unknown>
  copy[head!] = writeAt(base[head!], rest, value)
  return copy as T
}

export interface ReplicaView {
  entity(collection: OverrideCollection, id: string): Record<string, unknown> | undefined
}

export type RowStatus =
  | { kind: 'ready' }
  | { kind: 'changed-since'; now: unknown }
  | { kind: 'endpoint-deleted' }
  /** A re-created connection whose missing endpoint(s) are themselves
   * pending entity rows: bundled with ALL of them. */
  | { kind: 'needs'; rowIds: string[]; entityIds: string[] }
  | { kind: 'unsupported' }

/**
 * Each row's status against the replica, at Re-apply (or render) time.
 *  - a LEAF or SEQUENCE row is `changed-since` when the field's value now
 *    differs from the value that overrode it;
 *  - an ENTITY row (the current epoch deleted it) is `changed-since` when the
 *    entity exists again; a re-created CONNECTION needs both endpoints: one
 *    that is itself a pending entity row BUNDLES the two (`needs`), one that
 *    is simply gone disables it (`endpoint-deleted`).
 */
export function rowStatuses(rows: readonly OverrideRow[], replica: ReplicaView): Map<string, RowStatus> {
  const out = new Map<string, RowStatus>()
  // Pending whole-entity rows a connection can depend on: objects AND groups
  // (a connection may end on a group).
  const deletedEndpointRows = new Map<string, string>()
  for (const row of rows) {
    const t = overrideTarget(row)
    if (t && t.field.length === 0 && (t.collection === 'objects' || t.collection === 'groups')) deletedEndpointRows.set(t.entityId, row.id)
  }
  const endpointExists = (id: string) => !!replica.entity('objects', id) || !!replica.entity('groups', id)
  for (const row of rows) {
    const t = overrideTarget(row)
    if (!t) { out.set(row.id, { kind: 'unsupported' }); continue }
    const entity = replica.entity(t.collection, t.entityId)
    if (t.field.length === 0) {
      if (entity) { out.set(row.id, { kind: 'changed-since', now: entity }); continue }
      if (t.collection === 'connections') {
        const late = plainOf(row.lateValue) as { fromId?: string; toId?: string } | null
        const missing = [...new Set([late?.fromId, late?.toId].filter((id): id is string => !!id && !endpointExists(id)))]
        if (missing.length > 0 && missing.every((id) => deletedEndpointRows.has(id))) {
          // BOTH missing endpoints, when both are pending rows: unchecking
          // either must pull the connection out.
          out.set(row.id, { kind: 'needs', rowIds: missing.map((id) => deletedEndpointRows.get(id)!), entityIds: missing })
          continue
        }
        if (missing.length > 0) { out.set(row.id, { kind: 'endpoint-deleted' }); continue }
      }
      out.set(row.id, { kind: 'ready' })
      continue
    }
    if (!entity) { out.set(row.id, { kind: 'changed-since', now: null }); continue }
    const now = readAt(entity, t.field)
    out.set(row.id, sameValue(now, plainOf(row.currentValueAtForward)) ? { kind: 'ready' } : { kind: 'changed-since', now })
  }
  return out
}

/** Default selection: EVERY row checked — except the ones that cannot
 * be applied as they stand (changed since, endpoint deleted, unsupported). */
export function defaultChecked(rows: readonly OverrideRow[], statuses: ReadonlyMap<string, RowStatus>): Set<string> {
  return new Set(rows.filter((r) => {
    const s = statuses.get(r.id)?.kind ?? 'ready'
    return s === 'ready' || s === 'needs'
  }).map((r) => r.id))
}

/** Checking or unchecking a row also checks or unchecks the rows BUNDLED
 * with it (a re-created connection and the re-created object it needs). */
export function toggleChecked(checked: ReadonlySet<string>, rowId: string, on: boolean, statuses: ReadonlyMap<string, RowStatus>): Set<string> {
  const next = new Set(checked)
  const group = new Set([rowId])
  for (const [id, status] of statuses) {
    if (status.kind !== 'needs') continue
    // Checking a connection checks every endpoint it needs; unchecking an
    // endpoint unchecks every connection that needs it.
    if (id === rowId && on) for (const r of status.rowIds) group.add(r)
    if (status.rowIds.includes(rowId) && !on) group.add(id)
  }
  for (const id of group) { if (on) next.add(id); else next.delete(id) }
  return next
}

export interface EntityGroup {
  key: string
  collection: OverrideCollection | null
  entityId: string | null
  rows: OverrideRow[]
}

/** Rows grouped by entity, in the order they were overridden. */
export function groupByEntity(rows: readonly OverrideRow[]): EntityGroup[] {
  const groups = new Map<string, EntityGroup>()
  for (const row of rows) {
    const t = overrideTarget(row)
    const key = t ? `${t.collection}:${t.entityId}` : `${String(row.path[0])}:${row.entityId ?? row.id}`
    let group = groups.get(key)
    if (!group) {
      group = { key, collection: t?.collection ?? null, entityId: t?.entityId ?? row.entityId, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()]
}

export interface ReapplyPlan {
  batchId: string
  /** Rows written (checked and still `ready`/`needs`). */
  reapplied: string[]
  /** Unchecked rows, resolved `dismissed` with the batch. */
  dismissed: string[]
  /** Checked rows pulled out at the click: changed since, unchecked now. */
  pulled: string[]
  /** Per entity, the patch the ONE store edit applies. */
  updates: Array<{ collection: OverrideCollection; id: string; patch: Record<string, unknown> }>
  /** Whole entities re-created (the current epoch deleted them). */
  recreate: Array<{ collection: OverrideCollection; entity: Record<string, unknown> }>
}

/**
 * The batch, planned against the replica AT THE CLICK. Unchecked rows are
 * dismissed with the batch; checked rows whose field changed since are
 * PULLED out (not written, not dismissed: still pending, unchecked, shown).
 */
export function planReapply(
  rows: readonly OverrideRow[], checked: ReadonlySet<string>, replica: ReplicaView, batchId: string,
): ReapplyPlan {
  const statuses = rowStatuses(rows, replica)
  const plan: ReapplyPlan = { batchId, reapplied: [], dismissed: [], pulled: [], updates: [], recreate: [] }
  const patches = new Map<string, { collection: OverrideCollection; id: string; entity: Record<string, unknown>; fields: Set<string> }>()
  for (const row of rows) {
    if (!checked.has(row.id)) {
      // Never applicable as it stands: left pending rather than dismissed.
      const kind = statuses.get(row.id)?.kind
      if (kind === 'ready' || kind === 'needs') plan.dismissed.push(row.id)
      continue
    }
    const status = statuses.get(row.id)!
    if (status.kind === 'changed-since' || status.kind === 'endpoint-deleted' || status.kind === 'unsupported') {
      plan.pulled.push(row.id)
      continue
    }
    // A connection whose needed endpoint rows are not ALL in the batch would
    // be resolved "reapplied" without being written (`restoreDeletedEntities`
    // skips it): pulled out instead.
    if (status.kind === 'needs' && !status.rowIds.every((id) => checked.has(id))) { plan.pulled.push(row.id); continue }
    const t = overrideTarget(row)!
    const late = plainOf(row.lateValue)
    if (t.field.length === 0) {
      plan.recreate.push({ collection: t.collection, entity: late as Record<string, unknown> })
    } else {
      const key = `${t.collection}:${t.entityId}`
      let p = patches.get(key)
      if (!p) {
        p = { collection: t.collection, id: t.entityId, entity: replica.entity(t.collection, t.entityId) ?? {}, fields: new Set() }
        patches.set(key, p)
      }
      p.entity = writeAt(p.entity, t.field, late)
      p.fields.add(String(t.field[0]))
    }
    plan.reapplied.push(row.id)
  }
  for (const p of patches.values()) {
    plan.updates.push({ collection: p.collection, id: p.id, patch: Object.fromEntries([...p.fields].map((f) => [f, p.entity[f]])) })
  }
  // Objects and groups before the connections that need them.
  const rank = (c: OverrideCollection) => (c === 'connections' ? 1 : 0)
  plan.recreate.sort((a, b) => rank(a.collection) - rank(b.collection))
  return plan
}

/** The Automerge change message every change of a batch carries. */
export function reapplyMessage(batchId: string): string {
  return JSON.stringify({ reapplyBatch: batchId })
}

export function isReapplyMessage(message: string | null | undefined, batchId: string): boolean {
  if (!message) return false
  try { return (JSON.parse(message) as { reapplyBatch?: unknown }).reapplyBatch === batchId } catch { return false }
}

// ── the routes ──────────────────────────────────────────────────────────────

/** `signedIn`: the server adds the actors
 * the user's other tabs and devices asked with, so a device that never
 * wrote — no actor of its own — still asks. Without a session the route
 * lists only the actors asked: none, nothing to ask. */
export async function fetchOverrides(actors: readonly string[], signal?: AbortSignal, signedIn = false): Promise<OverrideRow[]> {
  if (actors.length === 0 && !signedIn) return []
  const query = withWorkspaceParams(new URLSearchParams({ actors: actors.join(',') }).toString())
  const response = await apiFetch(`${API_BASE}/api/model/epoch-overrides?${query}`, signal ? { signal } : {})
  if (!response.ok) throw new Error(`epoch-overrides → HTTP ${response.status}`)
  const body = await response.json() as { overrides?: OverrideRow[] }
  return Array.isArray(body.overrides) ? body.overrides : []
}

export type ResolveRequest = { batchId: string; reapplied: string[]; dismissed: string[] } | { revert: string }

export async function resolveOverrides(request: ResolveRequest): Promise<{ reapplied: number; dismissed: number; reverted: number }> {
  const response = await apiFetch(`${API_BASE}/api/model/epoch-overrides/resolve?${withWorkspaceParams('')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`epoch-overrides/resolve → HTTP ${response.status}`)
  return await response.json() as { reapplied: number; dismissed: number; reverted: number }
}
