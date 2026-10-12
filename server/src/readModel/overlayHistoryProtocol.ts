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

import { getConflicts } from '@automerge/automerge'

export type OverlayCollection = 'object' | 'connection'
export type AutomergeEntityConflicts = Map<string, Record<string, unknown[]>>

/** The entities whose KEY is in conflict — two clients put a whole entity at the
 * same map key concurrently — in sample order. These, and only these, need a
 * server write: JSON shows one branch and hides the other's fields. A nested
 * same-field conflict on any other entity converges deterministically in
 * Automerge and must be left alone: re-putting it orphans peers' concurrent
 * writes, and healing it alongside a `$` entity can delete its contested
 * leaf. */
export function wholeEntityConflictIds(conflicts: AutomergeEntityConflicts): string[] {
  const ids: string[] = []
  for (const [entityId, entity] of conflicts) {
    if (Object.prototype.hasOwnProperty.call(entity, '$')) ids.push(entityId)
  }
  return ids
}

export function requiresWholeEntityConflictHealing(conflicts: AutomergeEntityConflicts): boolean {
  return wholeEntityConflictIds(conflicts).length > 0
}

export interface ThreeWayMergeResult<T> {
  value: T | undefined
  changed: boolean
  conflicts: string[]
}

export interface ConcurrentEntityMergeResult<T> extends ThreeWayMergeResult<T> {
  /** The paths where concurrent writers changed the same field differently. */
  conflicts: string[]
}

const missing = Symbol('overlay-missing')
type Missing = typeof missing

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const jsonCopy = (value: unknown): unknown => value === undefined
  ? undefined
  : JSON.parse(JSON.stringify(value))

/** Resolve nested Automerge conflicts without replacing the entity map itself.
 * Replacing `entities[id]` changes its CRDT object identity; clients that are
 * concurrently editing the previous map then keep writing to a losing branch.
 * A whole-entity `$` conflict still needs one causal replacement, but ordinary
 * field conflicts can and must be resolved at their exact paths. */
export function applyResolvedEntityConflicts<T>(
  entities: Record<string, T>,
  entityId: string,
  resolved: T | undefined,
  automergeConflicts: Record<string, unknown[]>,
): void {
  if (resolved === undefined) {
    delete entities[entityId]
    return
  }
  const paths = Object.keys(automergeConflicts)
  const existing = entities[entityId]
  if (existing === undefined || paths.includes('$')) {
    entities[entityId] = jsonCopy(resolved) as T
    return
  }

  for (const path of paths) {
    const parts = path.split('.')
    let target = existing as unknown as Record<string, unknown>
    let source = resolved as unknown as Record<string, unknown>
    for (const part of parts.slice(0, -1)) {
      const sourceChild = source?.[part]
      if (!isRecord(sourceChild)) break
      if (!isRecord(target[part])) target[part] = {}
      target = target[part] as Record<string, unknown>
      source = sourceChild
    }
    const leaf = parts.at(-1)!
    if (source && Object.prototype.hasOwnProperty.call(source, leaf)) {
      target[leaf] = jsonCopy(source[leaf])
    } else {
      delete target[leaf]
    }
  }
}

/** Preserve conflicts Automerge intentionally keeps but JSON serialization
 * hides behind one deterministic winner. Paths are entity-relative. */
export function collectAutomergeEntityConflicts(
  entities: Record<string, unknown> | undefined,
): AutomergeEntityConflicts {
  const result: AutomergeEntityConflicts = new Map()
  const visit = (entityId: string, value: unknown, path: string): void => {
    if (!isRecord(value)) return
    for (const prop of Object.keys(value)) {
      const propPath = path ? `${path}.${prop}` : prop
      const conflicts = getConflicts(value as never, prop)
      if (conflicts && Object.keys(conflicts).length > 1) {
        const entity = result.get(entityId) ?? {}
        entity[propPath] = Object.values(conflicts).map(jsonCopy)
        result.set(entityId, entity)
      }
      visit(entityId, value[prop], propPath)
    }
  }
  for (const [entityId, value] of Object.entries(entities ?? {})) {
    // An overlay starts empty. Two clients can therefore assign a complete
    // entity to the same map key concurrently; JSON exposes only one winner.
    // Preserve every branch at `$` so the projector can merge their fields
    // against the immutable entity baseline instead of dropping one branch.
    const conflicts = getConflicts(entities as never, entityId)
    if (conflicts && Object.keys(conflicts).length > 1) {
      result.set(entityId, { $: Object.values(conflicts).map(jsonCopy) })
    }
    visit(entityId, value, '')
  }
  return result
}

/** At an explicit same-field conflict the already-published current value wins
 * until resolution. Non-conflicting siblings from the late edit stay merged.
 *
 * WHERE THE PUBLISHED VALUE HAS NO OPINION, THE MERGED LEAF STAYS. An explicit
 * Automerge conflict means the document holds two or more SET values for the
 * field; a published value that lacks it predates both writes — it is not a
 * deletion, and Automerge cannot even express "delete vs set" as a conflict
 * (the set wins outright, one value, no conflict). Deleting the leaf here would
 * let `applyResolvedEntityConflicts` transcribe that into the CRDT: both
 * writers' values erased from every peer, no trace. */
export function preserveCurrentConflictPaths<T>(
  merged: T | undefined,
  current: T | undefined,
  conflictPaths: readonly string[],
): T | undefined {
  if (!conflictPaths.length) return merged
  if (conflictPaths.includes('$')) return jsonCopy(current) as T | undefined
  const result = jsonCopy(merged) as Record<string, unknown> | undefined
  const currentRecord = current as Record<string, unknown> | undefined
  if (!result) return result as T | undefined
  for (const path of conflictPaths) {
    const parts = path.split('.')
    let target: Record<string, unknown> | undefined = result
    let source: Record<string, unknown> | undefined = currentRecord
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]
      target = isRecord(target?.[part]) ? target[part] as Record<string, unknown> : undefined
      source = isRecord(source?.[part]) ? source[part] as Record<string, unknown> : undefined
      if (!target) break
    }
    if (!target) continue
    const leaf = parts.at(-1)!
    if (source && leaf in source) target[leaf] = jsonCopy(source[leaf])
  }
  return result as T
}

function same(left: unknown, right: unknown): boolean {
  if (left === missing || right === missing) return left === right
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeValue(
  base: unknown | Missing,
  historical: unknown | Missing,
  current: unknown | Missing,
  path: string,
): { value: unknown | Missing; conflicts: string[] } {
  if (same(historical, base)) return { value: current, conflicts: [] }
  if (same(current, base) || same(current, historical)) return { value: historical, conflicts: [] }
  if (isRecord(base) && isRecord(historical) && isRecord(current)) {
    const value: Record<string, unknown> = {}
    const conflicts: string[] = []
    const keys = new Set([...Object.keys(base), ...Object.keys(historical), ...Object.keys(current)])
    for (const key of keys) {
      const child = mergeValue(
        key in base ? base[key] : missing,
        key in historical ? historical[key] : missing,
        key in current ? current[key] : missing,
        path ? `${path}.${key}` : key,
      )
      conflicts.push(...child.conflicts)
      if (child.value !== missing) value[key] = child.value
    }
    return { value, conflicts }
  }
  // Preserve the already-published current field until a user resolves the
  // conflict. Non-conflicting siblings are still forwarded by the recursion.
  return { value: current, conflicts: [path || '$'] }
}

/** Merge a late historical entity over the current head. Arrays are atomic;
 * plain-object fields merge recursively. Undefined represents absence so this
 * also covers delete/recreate without inventing a tombstone silently. */
export function threeWayMergeOverlayEntity<T>(
  base: T | undefined,
  historical: T | undefined,
  current: T | undefined,
): ThreeWayMergeResult<T> {
  const merged = mergeValue(base ?? missing, historical ?? missing, current ?? missing, '')
  const value = merged.value === missing ? undefined : merged.value as T
  return {
    value,
    changed: !same(value ?? missing, current ?? missing),
    conflicts: [...new Set(merged.conflicts)],
  }
}

/** Resolve conflicts hidden inside one Automerge overlay entity. The currently
 * published value remains authoritative for true same-field conflicts, while
 * every independent field delta from the concurrent branches is retained.
 *
 * `$` contains whole-entity branches produced when two clients concurrently
 * create the same sparse-overlay key. Other entries are nested Automerge field
 * conflicts on an entity that already existed in the overlay.
 *
 * THE BASE OF A CREATION IS THE EMPTY RECORD. `base` is undefined for an
 * entity born in the overlay (its base row says "did not exist") and for one
 * the projector meets for the first time as a `$` conflict. Reading that
 * absence as a value would degenerate the three-way merge to "keep what is
 * published": both concurrent replacements discarded, or the first branch
 * alone kept. Two records created concurrently under one key merge against
 * `{}` — every field present on one side is taken, a field set differently on
 * both sides is a reported conflict on which the published value wins where it
 * has one, as `collectAutomergeEntityConflicts` promises. One consequence: a
 * field present in the PUBLISHED value and absent from
 * both branches is kept (there is no base to say it was deleted), so a
 * deletion a client made inside a concurrent re-creation is reverted — the
 * `existed=true` path, with a real base, still honours it. */
export function mergeConcurrentAutomergeEntity<T>(
  base: T | undefined,
  current: T | undefined,
  selected: T | undefined,
  automergeConflicts: Record<string, unknown[]>,
): ConcurrentEntityMergeResult<T> {
  const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  const branches = [...(automergeConflicts.$ ?? []), selected]
    .filter((value): value is T => value !== undefined)
  const uniqueBranches = [...new Map(branches.map((value) => [JSON.stringify(value), value])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  let value = jsonCopy(current ?? base) as T | undefined
  const conflictPaths: string[] = []
  for (const branch of uniqueBranches) {
    if (sameJson(branch, value)) continue
    // Nothing accumulated yet and no base: the first branch IS the value so
    // far; the merge starts with the second. (`threeWayMergeOverlayEntity`
    // with base and current both absent returns the branch — kept explicit.)
    const creationBase = base === undefined && isRecord(branch) && isRecord(value)
      ? ({} as T)
      : base
    const merged = threeWayMergeOverlayEntity(creationBase, branch, value)
    value = merged.value
    conflictPaths.push(...merged.conflicts)
  }

  const explicitPaths = Object.keys(automergeConflicts).filter((path) => path !== '$')
  value = preserveCurrentConflictPaths(value, current, explicitPaths)
  conflictPaths.push(...explicitPaths)
  return {
    value,
    changed: !sameJson(value, selected),
    conflicts: [...new Set(conflictPaths)],
  }
}

/** ModelMeta order is semantic: later segments win. Always put the singular
 * current pointer last, even when a stale client appended it earlier. */
export function canonicalOverlayDocumentIds(
  documentIds: readonly string[],
  currentDocumentId: string | undefined,
): string[] {
  const result = [...new Set(documentIds.filter(Boolean))]
  if (!currentDocumentId) return result
  const index = result.indexOf(currentDocumentId)
  if (index >= 0) result.splice(index, 1)
  result.push(currentDocumentId)
  return result
}

/** Appending a fresh current head must retain materialized segment/effective
 * state. Reordering, replacing or removing history requires a rebuild. */
export function isAppendOnlyOverlayOrder(
  previous: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  return Boolean(previous
    && next.length >= previous.length
    && previous.every((documentId, index) => next[index] === documentId))
}
