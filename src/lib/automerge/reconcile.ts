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
 *
 * WHICH ABSENT KEYS ARE DELETED is decided by a {@link ReconcileSchema}, which
 * every entry point takes as a REQUIRED argument (no default, so a new call
 * site cannot compile without declaring what it reconciles). A key the target
 * holds as `undefined` is always deleted — the writer named it. A key the
 * target simply LACKS is deleted only when the schema says that key is KNOWN
 * at that level: every key of a `map` (its keys are data — entity ids, tag
 * ids), every key under `EXACT`, and only the declared fields of a `struct`.
 * An undeclared struct field is kept: it was written by a newer client whose
 * schema this build does not know, and a target built by this build cannot
 * carry it (V0-08 — an N-1 client used to wipe every field it did not know).
 * The registry of known fields per collection is `knownKeys.ts`.
 */

type Plain = Record<string, unknown>

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** An entity / sub-object whose KNOWN fields are `fields`; any other key is
 * kept when the target lacks it. Each field's schema governs its value.
 * `T` is the type it describes, carried by a phantom member that never exists
 * at runtime: invariant (`(t: T) => T`), so a `StructSchema<Size>` is not
 * accepted where a `StructSchema<Position>` is required. */
export interface StructSchema<T = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  readonly kind: 'struct'
  readonly fields: Readonly<Record<string, ReconcileSchema>>
  readonly __schemaFor?: (t: T) => T
}
/** A by-key map whose keys are data: a key the target lacks is deleted. */
export interface MapSchema<V extends ReconcileSchema = ReconcileSchema> {
  readonly kind: 'map'
  readonly value: V
}
/** An array; `element` applies to an element only when the draft element and
 * the target element at that index are the same entity (see `elementSchema`). */
export interface ListSchema<E extends ReconcileSchema = ReconcileSchema> {
  readonly kind: 'list'
  readonly element: E
}
/** Every key is known, at this level and below: a key the target lacks is
 * deleted. Primitives, arrays of primitives, a COMPLETE target (a
 * materialized past document, see history.ts), and the generic tests. */
export interface ExactSchema {
  readonly kind: 'exact'
}
export type ReconcileSchema = StructSchema | MapSchema | ListSchema | ExactSchema

export const EXACT: ExactSchema = Object.freeze({ kind: 'exact' })

type Primitive = string | number | boolean | bigint | symbol | null | undefined
type NonPrimitive<T> = Exclude<T, Primitive>
type KeysOfUnion<T> = T extends unknown ? keyof T : never
/** `T[K]` across every member of a union `T` that has `K`. */
type FieldValue<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never

/**
 * The schema a value of type `T` must be described with — so a field's
 * declared KIND is checked against its type, not only its name:
 *  - only primitives (optional or not)            → `EXACT`
 *  - an array of primitives                       → `EXACT` or `listOf(EXACT)`
 *  - an array of objects                          → `listOf(<schema of the element>)`
 *  - an index-signature / `Record<string, V>`     → `mapOf(<schema of V>)` (`EXACT` too when V is primitive)
 *  - any other object type                        → `structOf<that type>`
 * Primitive members of a union are ignored (`string | ObjectLink` is described
 * by `ObjectLink`'s struct; the string member reconciles as a primitive).
 */
export type SchemaFor<T> =
  [NonPrimitive<T>] extends [never] ? ExactSchema
    : [NonPrimitive<T>] extends [readonly (infer E)[]]
      ? ([NonPrimitive<E>] extends [never] ? ExactSchema | ListSchema<ExactSchema> : ListSchema<SchemaFor<E>>)
      : string extends keyof NonPrimitive<T>
        ? ([NonPrimitive<NonPrimitive<T>[string]>] extends [never]
            ? ExactSchema | MapSchema<ExactSchema>
            : MapSchema<SchemaFor<NonPrimitive<T>[string]>>)
        : StructSchema<NonPrimitive<T>>

/** Exactly one entry per key of `T` (every member of a union), each of the
 * kind `SchemaFor` requires: a key missing here, a key `T` does not have, or a
 * field described with the wrong kind (or a struct of another type) is a
 * compile error. That is the detector for "a type gained a field the registry
 * does not list". */
export type StructFields<T> = { readonly [K in Extract<KeysOfUnion<T>, string>]-?: SchemaFor<FieldValue<T, K>> }

/** `structOf`'s parameter: refuses a missing type argument (T would default
 * to `never` and accept `{}`) and an index-signature type (every key would be
 * "declared" — that is a map, `mapOf`). */
type StructFieldsArg<T> = [T] extends [never]
  ? 'structOf needs an explicit type argument'
  : string extends KeysOfUnion<T>
    ? 'an index-signature type is a map: describe it with mapOf'
    : StructFields<T>

export function structOf<T = never>(fields: NoInfer<StructFieldsArg<T>>): StructSchema<T> {
  return Object.freeze({
    kind: 'struct',
    fields: Object.freeze({ ...(fields as object) }) as Readonly<Record<string, ReconcileSchema>>,
  })
}
export function mapOf<V extends ReconcileSchema>(value: V): MapSchema<V> {
  return Object.freeze({ kind: 'map', value })
}
export function listOf<E extends ReconcileSchema>(element: E): ListSchema<E> {
  return Object.freeze({ kind: 'list', element })
}

/** Schema of the value held at `key` of a container described by `schema`.
 * An undeclared struct field (present in the target, so this build's writer
 * carried it through) is reconciled EXACT, as before V0-08. */
function childSchema(schema: ReconcileSchema, key: string): ReconcileSchema {
  if (schema.kind === 'map') return schema.value
  if (schema.kind === 'struct') return Object.hasOwn(schema.fields, key) ? schema.fields[key] : EXACT
  return EXACT
}

/** Whether a key present in the draft and ABSENT from the target is deleted.
 * `hasOwn`, not `in`/indexing: a field named `constructor` must not read as
 * declared through `Object.prototype`. */
function absentMeansDelete(schema: ReconcileSchema, key: string): boolean {
  return schema.kind !== 'struct' || Object.hasOwn(schema.fields, key)
}

/** Schema for array element `current` reconciled toward `next`, in arrays of
 * `draftLength` and `targetLength`. The element schema applies only when both
 * sides are provably the same entity; otherwise the index walk is writing a
 * DIFFERENT entity into this slot, keeping the old element's unknown fields
 * would attach them to the wrong entity, and the element is reconciled EXACT
 * (the unknown fields are lost, as before V0-08, rather than misattributed).
 *
 *  - both carry an `id`: the same id.
 *  - neither does: the index is NOT an identity — `Connection.waypoints`,
 *    `C4Object.links` and the routing lists are spliced by their editors, and
 *    a removal shifts every later element into the slot before it. Only an
 *    edit that keeps the length (a point dragged, a label edited) pairs each
 *    slot with itself, so only then do id-less elements keep their fields. A
 *    same-length edit that removes one element and inserts another at a
 *    different index is not distinguishable from that and can still
 *    misattribute; no current editor does it in one write. */
function elementSchema(
  schema: ReconcileSchema,
  current: unknown,
  next: unknown,
  draftLength: number,
  targetLength: number,
): ReconcileSchema {
  if (schema.kind !== 'list') return EXACT
  const id = elementId(current)
  if (id !== elementId(next)) return EXACT
  if (id === undefined && draftLength !== targetLength) return EXACT
  return schema.element
}

/** Reconcile `draft` (a container we already hold) to match `target`, under
 * `schema` (see the header for which absent keys are deleted). `draft` and
 * `target` must be the same kind (both arrays or both objects); callers always
 * start from a container, so this holds. */
export function reconcile(draft: unknown, target: unknown, schema: ReconcileSchema): void {
  if (Array.isArray(draft) && Array.isArray(target)) {
    reconcileArray(draft, target, schema)
  } else if (isPlainObject(draft) && isPlainObject(target)) {
    reconcileObject(draft, target, schema)
  }
  // Mismatched kinds at the top level shouldn't happen; nested mismatches are
  // handled by reconcileValue, which reassigns.
}

function reconcileObject(draft: Plain, target: Plain, schema: ReconcileSchema): void {
  // Update / add keys present (and defined) in target; an explicit `undefined`
  // deletes whatever the schema says, because the writer named the key.
  for (const key of Object.keys(target)) {
    const next = target[key]
    if (next === undefined) {
      if (key in draft) delete draft[key]
      continue
    }
    reconcileValue(draft, key, next, childSchema(schema, key))
  }
  // Remove keys the target lacks, but only KNOWN ones (snapshot keys first —
  // we mutate draft). An unknown key is a newer client's field: kept. `hasOwn`:
  // with `in`, a key named like an `Object.prototype` member (`constructor`)
  // always read as present and so could never be deleted.
  for (const key of Object.keys(draft)) {
    if (!Object.hasOwn(target, key) && absentMeansDelete(schema, key)) {
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
function reconcileArrayById(draft: unknown[], target: readonly unknown[], schema: ReconcileSchema): void {
  // Matched by id, so every update below is the same entity on both sides.
  const element = schema.kind === 'list' ? schema.element : EXACT
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
    reconcileObject(draft[at] as Plain, next as Plain, element)
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

function reconcileArray(draft: unknown[], target: readonly unknown[], schema: ReconcileSchema, key?: string): void {
  if (key !== undefined && KEYED_BY_ID.has(key) && keyableById(draft, target)) {
    reconcileArrayById(draft, target, schema)
    return
  }
  const shared = Math.min(draft.length, target.length)
  for (let i = 0; i < shared; i++) {
    reconcileValue(draft as unknown as Plain, i as unknown as string, target[i], elementSchema(schema, draft[i], target[i], draft.length, target.length))
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

/** Reconcile a single child at `container[key]` toward `next`, `schema` being
 * the schema of that VALUE. Recurses for same-kind containers, otherwise
 * assigns (primitive, or a type change). */
function reconcileValue(container: Plain, key: string, next: unknown, schema: ReconcileSchema): void {
  const current = (container as Plain)[key]
  if (Array.isArray(next)) {
    // `key` is the array's own name, which is what scopes the by-id merge. When
    // this is called from reconcileArray it is a numeric index, so a nested
    // array can never inherit its parent's keying.
    if (Array.isArray(current)) reconcileArray(current, next, schema, key)
    else container[key] = clonePlain(next)
    return
  }
  if (isPlainObject(next)) {
    if (isPlainObject(current)) reconcileObject(current, next, schema)
    else container[key] = clonePlain(next)
    return
  }
  // Primitive (or null): write only when it actually changed.
  if (current !== next) container[key] = next
}

/**
 * True when `reconcileValue(container, key, next, schema)` on a container
 * holding `current` at `key` would write NOTHING — i.e. `current` already
 * equals `next` under reconcile's own rules: an `undefined` member of an
 * object target means "absent", a key the target lacks is a difference only
 * when `schema` says reconcile would delete it (a struct's undeclared field is
 * kept, so it is no difference), arrays compare by index (an index-equal
 * `related` array is also a no-op for the by-id merge: nothing to remove,
 * update or append), primitives by `===`.
 *
 * For the write path's PRE-DIFF: read against the MATERIALIZED document
 * (`handle.doc()`, a plain frozen object), outside any change, so that only the
 * entries that differ go through a change draft. Measured 2026-10-11 with real
 * Automerge 3.2.6 (vitest scratch, 740 registry metas of 17 + 10 ids): reading
 * every meta out of the materialized doc 0.4 ms, reconciling the same metas
 * inside one change 266-279 ms — the draft is what costs.
 *
 * Conservative by construction: anything it cannot prove equal (a special
 * Automerge value, a kind mismatch) reads as "would write", which only costs
 * the ordinary reconcile.
 */
export function reconcileIsNoop(current: unknown, next: unknown, schema: ReconcileSchema): boolean {
  if (Array.isArray(next)) {
    if (!Array.isArray(current) || current.length !== next.length) return false
    for (let i = 0; i < next.length; i++) {
      if (!reconcileIsNoop(current[i], next[i], elementSchema(schema, current[i], next[i], current.length, next.length))) return false
    }
    return true
  }
  if (isPlainObject(next)) {
    if (!isPlainObject(current)) return false
    for (const key of Object.keys(next)) {
      const value = next[key]
      // `undefined` = absent: a current key it would delete is caught by the
      // loop over `current` below (a separate check here was a mutant no
      // test could kill — review 2026-10-11).
      if (value === undefined) continue
      if (!(key in current) || !reconcileIsNoop(current[key], value, childSchema(schema, key))) return false
    }
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(next, key)) {
        if (absentMeansDelete(schema, key)) return false
      } else if (next[key] === undefined) return false
    }
    return true
  }
  return current === next
}

/** Which keys `reconcile(collection, target, schema)` would touch, decided
 * against the MATERIALIZED collection (`reconcileIsNoop` per entry, outside any
 * change): `update` = target keys whose value differs, `remove` = keys the
 * target holds as `undefined`, or lacks where `schema` makes them deletable
 * (every key of a map). Null when the reconcile would write nothing at all. */
export interface CollectionReconcilePlan {
  update: string[]
  remove: string[]
}

export function planCollectionReconcile(
  materialized: Record<string, unknown>,
  target: Record<string, unknown>,
  schema: ReconcileSchema,
): CollectionReconcilePlan | null {
  const update: string[] = []
  const remove: string[] = []
  for (const key of Object.keys(target)) {
    const next = target[key]
    if (next === undefined) {
      if (key in materialized) remove.push(key)
      continue
    }
    if (!(key in materialized) || !reconcileIsNoop(materialized[key], next, childSchema(schema, key))) update.push(key)
  }
  for (const key of Object.keys(materialized)) {
    if (!Object.hasOwn(target, key) && absentMeansDelete(schema, key)) remove.push(key)
  }
  return update.length === 0 && remove.length === 0 ? null : { update, remove }
}

/** Apply a `planCollectionReconcile` plan to the change draft of the same
 * collection: exactly `reconcile(draft, target, schema)` minus the keys it
 * would have left untouched — per-key `reconcileKey` (recursing, minimal ops),
 * then the deletions, in reconcile's own order. `schema` must be the one the
 * plan was made with. */
export function applyCollectionReconcile(
  draft: Record<string, unknown>,
  target: Record<string, unknown>,
  plan: CollectionReconcilePlan,
  schema: ReconcileSchema,
): void {
  for (const key of plan.update) reconcileKey(draft, key, target[key], childSchema(schema, key))
  for (const key of plan.remove) {
    if (key in draft) delete draft[key]
  }
}

/** Reconcile ONE key of `container` toward `next`, with exactly the semantics
 * `reconcile` applies to that key when it walks the whole object: `undefined`
 * deletes the key, containers recurse under `schema` (the schema of the VALUE
 * at `key`), primitives write only on change. For targeted writers that own a
 * few fields of a large document and must not walk the rest of it (see
 * `diagramViewWrite.ts`). */
export function reconcileKey(container: Record<string, unknown>, key: string, next: unknown, schema: ReconcileSchema): void {
  if (next === undefined) {
    if (key in container) delete container[key]
    return
  }
  reconcileValue(container, key, next, schema)
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
