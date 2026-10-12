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

import type { Group } from '../../types'

/**
 * Local-edit overlay for groups — the equivalent of the bridge's `editsObjects`
 * / `editsConnections` maps, which groups never had.
 *
 * Why it is needed. Every projection rewrites `state.groups` wholesale from the
 * ModelMeta (or server render) snapshot, and ModelMeta only advances when the
 * debounced `writeSmallCollections` flush runs. The 'normal' write debounce is
 * a pure trailing timer, so a continuous typing burst keeps postponing it: for
 * the whole burst the snapshot still holds the pre-edit name. Any projection
 * landing in that window — a live-sync refresh, an SSE invalidation, a model-doc
 * change — restored the old name, and because the right sidebar renders a
 * controlled input straight off the store, React reset the DOM value and the
 * characters vanished mid-word.
 *
 * Objects were never exposed to this, purely because `editsObjects` re-applies
 * the local value on every projection. That overlay is the entire difference
 * between renaming a shape (fine) and renaming a group (dropped letters).
 *
 * Lifetime is deliberately short: an entry is captured on the keystroke and
 * retired the moment that exact ref is durable in ModelMeta. Holding it any
 * longer would out-rank a genuine remote edit to the same group.
 */
export class GroupEditOverlay {
  private edits = new Map<string, Group>()
  private rendered = new Map<string, Group>()

  /** Baseline: what the last projection actually rendered, pre-overlay. */
  rebaseline(projected: readonly Group[]): void {
    this.rendered = new Map(projected.map((group) => [group.id, group]))
  }

  /**
   * Capture any group in the store that differs by reference from both the
   * projected baseline and what is already staged. Immer gives an edited group
   * a fresh reference, so identity is the signal — the same test the object arm
   * uses.
   */
  captureLocalEdits(groups: readonly Group[]): void {
    for (const group of groups) {
      if (this.rendered.get(group.id) !== group && this.edits.get(group.id) !== group) {
        this.edits.set(group.id, group)
      }
    }
  }

  /** Re-apply staged edits over a projected snapshot, keeping any staged group
   * the snapshot has not caught up to yet. */
  apply(projected: readonly Group[]): Group[] {
    if (this.edits.size === 0) return projected as Group[]
    const seen = new Set<string>()
    const merged = projected.map((group) => {
      seen.add(group.id)
      return this.edits.get(group.id) ?? group
    })
    for (const [id, group] of this.edits) if (!seen.has(id)) merged.push(group)
    return merged
  }

  /** Drop entries whose exact reference has been written to ModelMeta. */
  retireDurable(groups: readonly Group[]): void {
    for (const group of groups) {
      if (this.edits.get(group.id) === group) this.edits.delete(group.id)
    }
  }

  /** Workspace/version switch: a group staged against the previous workspace
   * must never reappear over the new one's groups. */
  clear(): void {
    this.edits.clear()
    this.rendered = new Map()
  }

  /** Staged count — for assertions and diagnostics only. */
  get size(): number {
    return this.edits.size
  }
}
