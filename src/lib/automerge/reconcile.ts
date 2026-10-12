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
 * Minimal-op reconcile: mutate a draft (an Automerge change draft, or any plain
 * object/array) in place so it deep-equals `target`, touching ONLY the parts that
 * actually differ.
 *
 * Why minimal ops matter: every write inside `handle.change` becomes an Automerge
 * operation that merges per-field. If we naively replaced whole objects, two
 * clients editing different fields of the same entity would conflict at the object
 * level instead of merging at the field level. By drilling down and writing only
 * changed leaves, concurrent edits to different fields both survive — the whole
 * point of moving to a CRDT.
 *
 * The reconciler is intentionally Automerge-agnostic: an Automerge change draft
 * behaves like a normal mutable object/array, so the same code works on plain JS
 * (which is what the unit tests exercise) and on a real draft.
 *
 * Assumptions about the data (true for our model): JSON-only values — string,
 * number, boolean, null, plain objects, and arrays. No class instances, Dates,
 * Maps, or Sets (timestamps are ISO strings). `undefined` in `target` means "the
 * key is absent" and is reconciled as a deletion.
 */

type Plain = Record<string, unknown>

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Reconcile `draft` (a container we already hold) to match `target`. `draft` and
 * `target` must be the same kind (both arrays or both objects); callers always
 * start from a container, so this holds. */
export function reconcile(draft: unknown, target: unknown): void {
  if (Array.isArray(draft) && Array.isArray(target)) {
    reconcileArray(draft, target)
  } else if (isPlainObject(draft) && isPlainObject(target)) {
    reconcileObject(draft, target)
  }
  // Mismatched kinds at the top level shouldn't happen; nested mismatches are
  // handled by reconcileValue, which reassigns.
}

function reconcileObject(draft: Plain, target: Plain): void {
  // Update / add keys present (and defined) in target.
  for (const key of Object.keys(target)) {
    const next = target[key]
    if (next === undefined) {
      if (key in draft) delete draft[key]
      continue
    }
    reconcileValue(draft, key, next)
  }
  // Remove keys the target no longer has (snapshot keys first — we mutate draft).
  for (const key of Object.keys(draft)) {
    if (!(key in target) || target[key] === undefined) {
      delete draft[key]
    }
  }
}

/**
 * Array keys whose elements are merged BY `id` instead of by index.
 *
 * Index-walking a list of identified objects is a data-loss bug under
 * concurrent edits, because removing an element shifts every later one and each
 * peer then writes DIFFERENT entities to the same slots (with 5 links, 611 of
 * the 961 pairs of concurrent remove-sets resurrect a deleted link). The
 * smallest case is two users deleting a different chip — base [L1,L2,L3], one
 * removes L2, the other removes L1, and the merge yields [L2,L3]: the wrong link
 * is gone and a deleted one is back.
 *
 * Scoped by KEY NAME, which is a path suffix — deliberately not by shape.
 * `related` is the only key of that name in the reconciled model types
 * (`src/types/index.ts`), and other arrays whose elements happen to
 * carry an `id` (`Flow.steps`, `Comment.replies`, …) must keep their existing
 * semantics: keying by id does NOT make a reorder safe (Automerge has no move
 * op, so a move is delete+insert, and a concurrent delete of a moved element is
 * simply lost), and `Flow.steps` is the one array with a real reorder writer.
 * That is a product decision about delete-wins vs move-wins, not a mechanical
 * fix, so it stays out of here.
 */
const KEYED_BY_ID: ReadonlySet<string> = new Set(['related'])

function elementId(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined
  const id = value.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Whether the by-id merge can express this transition faithfully.
 *
 * Three conditions, and failing ANY of them falls back to the generic index
 * walk:
 *
 *  - every element on both sides carries a non-empty string `id`. `related`
 *    arrives unvalidated on the paged read-model path (`modelQuery/decisionRecords.ts`
 *    casts, and the server types it `unknown[]`), so an id-less link is
 *    representable. Bucketing those together under one key would be silent data
 *    loss — strictly worse than the bug being fixed.
 *  - ids are unique within each side. A duplicate makes "the element with this
 *    id" meaningless.
 *  - the surviving elements appear in the SAME relative order on both sides.
 *    A by-id merge can delete and append but cannot express a reorder without
 *    the index writes this exists to avoid, so it declines the job rather than
 *    silently dropping the new order. `related` currently has only append and
 *    remove-by-id writers, which never reorder.
 *
 * The first two OVERLAP, deliberately: an absent id behaves as a perfectly good
 * unique key when there is exactly one of them, and two of them collide under
 * the uniqueness check. Neither is dead code — each covers the case the other
 * reaches only by accident of `Set` semantics.
 */
function keyableById(draft: readonly unknown[], target: readonly unknown[]): boolean {
  const draftIds: string[] = []
  for (const item of draft) {
    const id = elementId(item)
    if (id === undefined) return false
    draftIds.push(id)
  }
  const targetIds: string[] = []
  for (const item of target) {
    const id = elementId(item)
    if (id === undefined) return false
    targetIds.push(id)
  }
  if (new Set(draftIds).size !== draftIds.length) return false
  if (new Set(targetIds).size !== targetIds.length) return false
  // Relative order of the intersection must agree, or this is a reorder.
  const targetSet = new Set(targetIds)
  const survivors = draftIds.filter((id) => targetSet.has(id))
  const draftSet = new Set(draftIds)
  const inTargetOrder = targetIds.filter((id) => draftSet.has(id))
  return survivors.length === inTargetOrder.length
    && survivors.every((id, i) => id === inTargetOrder[i])
}

/** Merge `draft` toward `target` matching elements by `id`: remove, then update
 *  in place, then append. No element is ever overwritten by a DIFFERENT one, so
 *  two peers removing different elements no longer collide. */
function reconcileArrayById(draft: unknown[], target: readonly unknown[]): void {
  const keep = new Set(target.map(elementId))
  // Tail-first so each splice leaves the lower indices valid.
  for (let i = draft.length - 1; i >= 0; i--) {
    if (!keep.has(elementId(draft[i]))) draft.splice(i, 1)
  }
  const indexById = new Map<string, number>()
  draft.forEach((item, i) => indexById.set(elementId(item)!, i))
  for (const next of target) {
    const at = indexById.get(elementId(next)!)
    if (at === undefined) continue
    reconcileObject(draft[at] as Plain, next as Plain)
  }
  for (const next of target) {
    if (indexById.has(elementId(next)!)) continue
    // Recompute the slot every time. `draft[i] = x` UPDATES for any i <= length
    // and only throws past it ("index 5 is out of bounds" at length 3),
    // and this pass has already spliced — a precomputed index can land back in
    // range and destroy a survivor instead of failing loudly.
    ;(draft as unknown as Plain)[draft.length as unknown as string] = clonePlain(next)
  }
}

function reconcileArray(draft: unknown[], target: readonly unknown[], key?: string): void {
  if (key !== undefined && KEYED_BY_ID.has(key) && keyableById(draft, target)) {
    reconcileArrayById(draft, target)
    return
  }
  const shared = Math.min(draft.length, target.length)
  for (let i = 0; i < shared; i++) {
    reconcileValue(draft as unknown as Plain, i as unknown as string, target[i])
  }
  if (target.length > draft.length) {
    for (let i = draft.length; i < target.length; i++) {
      // Append by index; on an Automerge list proxy this inserts.
      ;(draft as unknown as Plain)[i as unknown as string] = clonePlain(target[i])
    }
  } else if (draft.length > target.length) {
    draft.splice(target.length, draft.length - target.length)
  }
}

/** Reconcile a single child at `container[key]` toward `next`. Recurses for
 * same-kind containers, otherwise assigns (primitive, or a type change). */
function reconcileValue(container: Plain, key: string, next: unknown): void {
  const current = (container as Plain)[key]
  if (Array.isArray(next)) {
    // `key` is the array's own name, which is what scopes the by-id merge. When
    // this is called from reconcileArray it is a numeric index, so a nested
    // array can never inherit its parent's keying.
    if (Array.isArray(current)) reconcileArray(current, next, key)
    else container[key] = clonePlain(next)
    return
  }
  if (isPlainObject(next)) {
    if (isPlainObject(current)) reconcileObject(current, next)
    else container[key] = clonePlain(next)
    return
  }
  // Primitive (or null): write only when it actually changed.
  if (current !== next) container[key] = next
}

/** Structured clone of JSON-ish data so we never hand an Automerge draft a
 * reference it might alias. (Avoids `structuredClone` for broad runtime support.)
 * Also DROPS `undefined`-valued object keys, which Automerge rejects with a
 * RangeError — exported so doc-CREATION sites (Repo.create validates the initial
 * value the same way) can sanitize store data that may carry optional fields as
 * present-but-undefined (e.g. `domainId: domains[0]?.id` with no domains). */
export function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as unknown as T
  if (isPlainObject(value)) {
    const out: Plain = {}
    for (const k of Object.keys(value)) {
      const v = (value as Plain)[k]
      if (v !== undefined) out[k] = clonePlain(v)
    }
    return out as unknown as T
  }
  return value
}
