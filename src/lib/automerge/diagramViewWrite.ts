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

import type { Diagram } from '../../types'
import { clonePlain, reconcileKey } from './reconcile'
import { persistentSlicesChanged } from './persistentSlices'

/**
 * Diagram fields that are pure VIEW SETTINGS: they live only in the
 * DiagramDoc (never in the registry meta — see `buildMeta` — never in a model
 * shard, never in the composition), so persisting a change to them needs one
 * targeted change on the active DiagramDoc and nothing else.
 *
 * Why this exists (measured 2026-10-08 with `node scripts/view3d-quality/run.mjs
 * --profile` against the dev stack, RTX 4080 SUPER host, a dev account holding
 * one imported diagram per earlier harness run; the cost grows with that
 * count, since the full pass walks every diagram; LoAF attributed the task to the write scheduler's
 * setTimeout, the CDP profile split it): picking a 3D decor wrote
 * `Diagram.sceneDecor` through the FULL flushWrite — ensureDiagramDoc over every
 * diagram, a buildMeta + reconcile of every registry meta, and a whole-DiagramDoc
 * reconcile — a single 305 ms task (reconcileValue 165 ms, buildMeta 62 ms) for
 * a change of three short strings. The same full pass ran when the skin select
 * changed `skinId` (166 ms inside the enter-3D window). With this path the same
 * harness reports no write-flush long frame on either (gate "long task is not
 * the write flush").
 *
 * Deliberately a whitelist: a field missing here only costs the slow path, a
 * field wrongly listed here would skip the registry. Do NOT add `name`, `type`,
 * `parentObjectId` (registry meta), the composition arrays, or `layouts` /
 * `layouts3d` (placement journal + group autoSize own those).
 */
export const DIAGRAM_VIEW_FIELDS = [
  'sceneDecor',
  'skinId',
  'connectionHighlightStyle',
  'connectionAnimationsEnabled',
  'defaultConnectionShape',
  // NOT `objectScopes`: the per-diagram internal/external overrides are
  // denormalised into the registry meta (`buildMeta`) so model-wide pages can
  // count "external in N of M diagrams" without every DiagramDoc — a targeted
  // DiagramDoc-only write would leave that copy stale.
] as const satisfies readonly (keyof Diagram)[]

const VIEW_FIELD_SET: ReadonlySet<string> = new Set(DIAGRAM_VIEW_FIELDS)

/** The persistent store slices the classifier must see unchanged. */
export interface ViewEditSlices {
  objects: readonly unknown[]
  connections: readonly unknown[]
  diagrams: readonly Diagram[]
  flows: readonly unknown[]
  tags: readonly unknown[]
  groups: readonly unknown[]
  domains: readonly unknown[]
  comments: readonly unknown[]
  decisionRecords: readonly unknown[]
  currentDiagramId: string | null
}

/**
 * If the only durable difference between `previous` and `state` is a change
 * to VIEW fields of exactly one diagram, return that diagram's id; otherwise
 * null (the caller then takes the ordinary full write). Reference identity
 * only — immer keeps untouched entries and slices by reference, so this is
 * O(diagrams) pointer compares plus O(keys) for the one changed entry.
 */
export function classifyDiagramViewEdit(state: ViewEditSlices, previous: ViewEditSlices): string | null {
  if (state.currentDiagramId !== previous.currentDiagramId) return null
  // Every persistent slice OTHER than diagrams must be untouched — asked of
  // the bridge's own gate, not of a second copy of its slice list: a slice
  // added there and forgotten here would be classified view-only and its
  // edit never written (architect review 2026-10-08).
  if (persistentSlicesChanged({ ...state, diagrams: previous.diagrams }, previous)) return null
  if (state.diagrams === previous.diagrams) return null
  if (state.diagrams.length !== previous.diagrams.length) return null
  let changed: number | null = null
  for (let i = 0; i < state.diagrams.length; i++) {
    if (state.diagrams[i] === previous.diagrams[i]) continue
    if (changed !== null) return null
    changed = i
  }
  if (changed === null) return null
  const next = state.diagrams[changed] as unknown as Record<string, unknown>
  const prev = previous.diagrams[changed] as unknown as Record<string, unknown>
  if (next.id !== prev.id) return null
  let viewChanged = false
  for (const key of new Set([...Object.keys(next), ...Object.keys(prev)])) {
    if (next[key] === prev[key]) continue
    if (!VIEW_FIELD_SET.has(key)) return null
    viewChanged = true
  }
  return viewChanged ? (next.id as string) : null
}

/** Write the view fields of `diagram` into its DiagramDoc draft with the same
 * per-key semantics the full `reconcile(doc, diagramToDiagramDoc(...))` pass
 * applies to them — and touch nothing else. */
export function applyDiagramViewFields(doc: object, diagram: Diagram): void {
  const draft = doc as Record<string, unknown>
  const source = diagram as unknown as Record<string, unknown>
  for (const key of DIAGRAM_VIEW_FIELDS) reconcileKey(draft, key, source[key])
}

/**
 * Per-diagram scope overrides are written as a DELTA, never as the store's
 * whole map. Three Automerge facts decide it:
 *
 * - a DELETED map takes a peer's concurrent override with it, so a write never
 *   removes the map;
 * - two peers that each CREATE the key concurrently keep one map and hide the
 *   other's entries, so only a write that actually SETS an override may create
 *   it on an older diagram (new diagrams get it at birth,
 *   `withObjectScopesAtBirth`, the only race-free creation);
 * - the store can LAG the document (remote changes are projected late, e.g.
 *   boot-from-server defers it while the user edits), so reconciling the
 *   store's whole map would delete a peer's override the document has already
 *   merged (re-review 2026-10-29, F2). Only the keys THIS client changed are
 *   written; every other key keeps the document's value.
 *
 * `ScopeEditTracker` records those keys from local store changes (the bridge
 * feeds it from `onStoreChange`, which skips remote projections), and
 * `objectScopesForReconcile` applies them onto the document's own map.
 */
export class ScopeEditTracker {
  private dirty = new Map<string, Set<string>>()

  /** Record every override key that differs between two local store states. */
  note(previous: readonly Diagram[], next: readonly Diagram[]): void {
    if (previous === next) return
    const before = new Map(previous.map((d) => [d.id, d.objectScopes]))
    for (const d of next) {
      const prevScopes = before.get(d.id)
      if (prevScopes === d.objectScopes) continue
      const a = prevScopes ?? {}
      const b = d.objectScopes ?? {}
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[id] === b[id]) continue
        let set = this.dirty.get(d.id)
        if (!set) this.dirty.set(d.id, (set = new Set()))
        set.add(id)
      }
    }
  }

  /** The keys changed locally on a diagram since its last write; forgets them. */
  take(diagramId: string): ReadonlySet<string> | undefined {
    const set = this.dirty.get(diagramId)
    this.dirty.delete(diagramId)
    return set
  }

  clear(): void {
    this.dirty.clear()
  }
}

/**
 * The `objectScopes` value for a full `reconcile(doc, target)` of the active
 * DiagramDoc: the document's own map (cloned — never hand an Automerge proxy
 * back in) with only `dirty` keys taken from the store. `undefined` = the key
 * stays absent (the document has no map and no dirty key SETS an override).
 */
export function objectScopesForReconcile(
  docMap: unknown,
  store: Diagram['objectScopes'],
  dirty: ReadonlySet<string> | undefined,
): Record<string, unknown> | undefined {
  const base = docMap && typeof docMap === 'object' ? clonePlain(docMap as Record<string, unknown>) : undefined
  if (!dirty || dirty.size === 0) return base
  const result: Record<string, unknown> = base ?? {}
  let setsOne = false
  for (const id of dirty) {
    const value = store?.[id]
    if (value === 'internal' || value === 'external') {
      result[id] = value
      setsOne = true
    } else {
      delete result[id]
    }
  }
  return base || setsOne ? result : undefined
}

/** Put `objectScopesForReconcile`'s value on a reconcile target (absent = delete
 * the key from the TARGET, which `reconcile` then leaves absent in the doc). */
export function setObjectScopesForReconcile(
  target: { objectScopes?: unknown },
  store: Diagram['objectScopes'],
  doc: { objectScopes?: unknown },
  dirty: ReadonlySet<string> | undefined,
): void {
  const value = objectScopesForReconcile(doc.objectScopes, store, dirty)
  if (value === undefined) delete target.objectScopes
  else target.objectScopes = value
}

/** A diagram about to become a NEW DiagramDoc: give it the scope map now, so
 * no two peers ever have to create it concurrently later. */
export function withObjectScopesAtBirth<T extends Diagram>(diagram: T): T {
  return diagram.objectScopes ? diagram : { ...diagram, objectScopes: {} }
}
