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

import { ENTITY_FAMILY_LIST, entityKeyOf } from './entityFamilies'

/**
 * The LOCAL edits of a resident boot window, by entity.
 *
 * An earlier version kept the whole store state before the first local edit and, at the
 * subscription, handed `onStoreChange` the difference from it to now — which
 * folds every REMOTE projection that landed later into "local": under
 * boot-from-server the capture then journals a colleague's value as hers, a
 * whole-value clobber on replay. Here each entity remembers its value before
 * the FIRST local change of the window (undefined: created here), and
 * `base(now)` is the current state with only those entities put back: the
 * difference from it to now is the boot's own edits and nothing else, and a
 * slice no local change touched keeps its reference (so it reads as unchanged).
 */
type Slices = Record<string, readonly unknown[]>
/**
 * The entity before the window's first local change, and the FIELDS local
 * changes touched since (at entity grain alone, a
 * colleague's change to ANOTHER field of an entity she edited was put back
 * too, and so replayed as hers). `fields: null`: the whole entity (created
 * or deleted here).
 */
type First = { first: unknown; fields: Set<string> | null }

function changedFields(before: unknown, after: unknown): string[] {
  const a = (before ?? {}) as Record<string, unknown>
  const b = (after ?? {}) as Record<string, unknown>
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k])
}

export class BootLocalEdits {
  private readonly firsts = new Map<string, Map<string, First>>()

  get size(): number {
    let n = 0
    for (const map of this.firsts.values()) n += map.size
    return n
  }

  /** A local store change (never a remote one): remember what it changed. */
  note(previous: Slices, state: Slices): void {
    for (const family of ENTITY_FAMILY_LIST) {
      const slice = family.storeSlice
      const before = previous[slice]
      const after = state[slice]
      if (before === after || !Array.isArray(before) || !Array.isArray(after)) continue
      const firsts = this.firsts.get(slice) ?? new Map<string, First>()
      const prior = new Map(before.map((e) => [entityKeyOf(family, e), e]))
      const seen = new Set<string>()
      for (const entity of after) {
        const key = entityKeyOf(family, entity)
        seen.add(key)
        const was = prior.get(key)
        if (was === entity) continue
        const record = firsts.get(key)
        if (was === undefined) { if (!record) firsts.set(key, { first: undefined, fields: null }); continue }
        if (!record) firsts.set(key, { first: was, fields: new Set(changedFields(was, entity)) })
        else if (record.fields) for (const k of changedFields(was, entity)) record.fields.add(k)
      }
      for (const [key, entity] of prior) {
        if (seen.has(key)) continue
        const record = firsts.get(key)
        if (!record) firsts.set(key, { first: entity, fields: null })
        else record.fields = null
      }
      if (firsts.size > 0) this.firsts.set(slice, firsts)
    }
  }

  /** `now` with each locally changed entity back at its value before the
   * window's first local change (absent if created here); other slices are
   * `now`'s own references. */
  base<T extends object>(now: T): T {
    const out: Record<string, unknown> = { ...(now as Record<string, unknown>) }
    for (const family of ENTITY_FAMILY_LIST) {
      const slice = family.storeSlice
      const firsts = this.firsts.get(slice)
      const current = (now as unknown as Slices)[slice]
      if (!firsts || firsts.size === 0 || !Array.isArray(current)) continue
      const kept: unknown[] = []
      const present = new Set<string>()
      for (const entity of current) {
        const key = entityKeyOf(family, entity)
        present.add(key)
        const record = firsts.get(key)
        if (!record) { kept.push(entity); continue }
        if (record.first === undefined) continue
        if (!record.fields) { kept.push(record.first); continue }
        // Her fields back at their value before her first change; every other
        // field as the documents hold it now (a colleague's change stays).
        const merged: Record<string, unknown> = { ...(entity as Record<string, unknown>) }
        const first = record.first as Record<string, unknown>
        for (const k of record.fields) {
          if (k in first) merged[k] = first[k]
          else delete merged[k]
        }
        kept.push(merged)
      }
      // Deleted here: back in the base, so the difference is the delete.
      for (const [key, record] of firsts) if (!present.has(key) && record.first !== undefined) kept.push(record.first)
      out[slice] = kept
    }
    return out as T
  }
}
