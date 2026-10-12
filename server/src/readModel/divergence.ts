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

// Does the read model still agree with the CRDT?
//
// `health.ts` carries a write-newer-than-projection heuristic with a 60 s
// grace, which detects LATENESS: it fires when a source document changed and
// the projector has not caught up. It cannot see the case that matters — a
// projector that is caught up, reports healthy, and is wrong (e.g. a frozen
// read model, or entities silently dropped from projection).
//
// THE HARD PART is telling lag apart from divergence, and it is not solvable in
// one pass: the read model is eventually consistent, so any single comparison
// finds differences that are merely in flight. This module therefore compares
// TWICE and only reports an entity that differed in BOTH passes, with the
// projection generation unchanged between them. A difference that survives a
// grace period while the projector believes it has nothing to do is divergence.

import { createHash } from 'node:crypto'

export interface ComparableEntity {
  id: string
  /** Every field the read model is supposed to carry, already normalised by the
   * caller. Field selection is the caller's business; this module only decides
   * whether two views of the same id agree. */
  fields: Record<string, unknown>
}

/** Every read-model kind the detector covers. Comparing only objects and
 * connections would let the loss of every ro_connection_flows row go
 * undetected. */
export type EntityKind = 'object' | 'connection' | 'group' | 'diagram' | 'flow'

export interface DivergenceItem {
  kind: 'missing-in-read-model' | 'missing-in-crdt' | 'content-mismatch'
  entity: EntityKind
  id: string
  /** Bounded evidence. Full documents are never carried: this can run on a
   * 100 000-object workspace and the report has to stay readable and small. */
  detail?: string
}

export interface DivergencePass {
  /** Per-kind cardinality on each side, so a report says WHICH kind drifted. */
  counts: Record<EntityKind, { crdt: number; readModel: number }>
  items: DivergenceItem[]
}

/** Stable content hash. Keys are sorted so field order cannot fake a mismatch,
 * and `undefined` is dropped so an absent field and an explicitly-undefined one
 * compare equal — the read model cannot represent the difference anyway. */
export function entityHash(fields: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key]
    if (value === undefined) continue
    normalized[key] = value === null ? null : value
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16)
}

/** One comparison of one entity kind. Pure, so the rule itself is unit-tested
 * rather than only exercised against a live database. */
export function comparePass(
  entity: EntityKind,
  crdt: readonly ComparableEntity[],
  readModel: readonly ComparableEntity[],
  { maxItems = 50 } = {},
): DivergenceItem[] {
  const items: DivergenceItem[] = []
  const crdtById = new Map(crdt.map((e) => [e.id, e]))
  const roById = new Map(readModel.map((e) => [e.id, e]))

  for (const [id, left] of crdtById) {
    if (items.length >= maxItems) break
    const right = roById.get(id)
    if (!right) {
      items.push({ kind: 'missing-in-read-model', entity, id })
      continue
    }
    const leftHash = entityHash(left.fields)
    const rightHash = entityHash(right.fields)
    if (leftHash !== rightHash) {
      // Name the differing FIELDS, not the values: values can carry customer
      // content and this report goes to logs and metrics.
      const keys = new Set([...Object.keys(left.fields), ...Object.keys(right.fields)])
      const differing = [...keys].filter((k) => entityHash({ [k]: left.fields[k] }) !== entityHash({ [k]: right.fields[k] }))
      items.push({ kind: 'content-mismatch', entity, id, detail: `fields: ${differing.sort().join(', ') || '<unknown>'}` })
    }
  }

  for (const id of roById.keys()) {
    if (items.length >= maxItems) break
    if (!crdtById.has(id)) items.push({ kind: 'missing-in-crdt', entity, id })
  }

  return items
}

/** Intersect two passes. ONLY an item present in both, keyed by
 * (kind, entity, id), is divergence; anything that healed between them was lag.
 *
 * The generation guard is the other half: if the projector advanced between the
 * passes it was working, so even a surviving difference is not yet proof — the
 * run reports `inconclusive` rather than raising a false alarm. A detector that
 * cries wolf during normal catch-up ends up turned off.
 */
export function confirmDivergence(
  first: DivergencePass,
  second: DivergencePass,
  { generationBefore, generationAfter }: { generationBefore: number | null; generationAfter: number | null },
): { outcome: 'clean' | 'diverged' | 'inconclusive'; confirmed: DivergenceItem[]; healed: number; reason?: string } {
  const key = (item: DivergenceItem) => `${item.kind}|${item.entity}|${item.id}`
  const firstKeys = new Set(first.items.map(key))
  const confirmed = second.items.filter((item) => firstKeys.has(key(item)))
  const healed = first.items.length - confirmed.length

  if (generationBefore === null || generationAfter === null) {
    return { outcome: 'inconclusive', confirmed, healed, reason: 'no projection generation recorded for this workspace' }
  }
  if (generationAfter !== generationBefore) {
    return {
      outcome: 'inconclusive',
      confirmed,
      healed,
      reason: `projector advanced ${generationBefore} -> ${generationAfter} between passes; differences cannot be attributed`,
    }
  }
  if (confirmed.length === 0) return { outcome: 'clean', confirmed, healed }
  return { outcome: 'diverged', confirmed, healed }
}

/** Compact, loggable summary. Counts by kind, ids capped — a divergence report
 * that dumps 100 000 ids is one nobody reads. */
export function summarizeDivergence(items: readonly DivergenceItem[], { maxIds = 10 } = {}): string {
  if (items.length === 0) return 'none'
  const byKind = new Map<string, string[]>()
  for (const item of items) {
    const bucket = byKind.get(`${item.entity}/${item.kind}`) ?? []
    bucket.push(item.id)
    byKind.set(`${item.entity}/${item.kind}`, bucket)
  }
  return [...byKind.entries()]
    .map(([kind, ids]) => `${kind}=${ids.length} [${ids.slice(0, maxIds).join(', ')}${ids.length > maxIds ? ', …' : ''}]`)
    .join('; ')
}
