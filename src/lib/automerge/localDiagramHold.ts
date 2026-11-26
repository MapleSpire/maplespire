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

/**
 * Holds a just-created diagram through the projections that run before it is
 * durable.
 *
 * The store's diagram list is not authoritative: `buildDiagramsArray` rebuilds
 * it from the REGISTRY metas on every projection, and a new diagram only gets a
 * meta on the debounced flush. Anything that re-projects in that window — a
 * remote change, a boot step still settling — would produce a list without it,
 * so the diagram would appear and vanish ~15ms later with no error, and the
 * create button would look broken.
 *
 * `captureSummaryLocalDiagram` guards the same window for summary-only
 * workspaces; this is the classic registry's equivalent.
 *
 * Ids are held, never snapshots — `apply` re-reads the resident list, so an edit
 * that lands in the same window is carried rather than reverted.
 *
 * THE DELETE HALF (T-DIAGDEF (2)), the same window the other way round: a
 * diagram the user just deleted still HAS its registry meta until the
 * debounced flush removes it, so a projection landing in between brings it
 * back into the store — and the flush then reconciles the registry FROM that
 * store and keeps the entry, durably. Reachable on every delete of the OPEN
 * diagram: the delete moves `currentDiagramId`, and the next diagram's first
 * paint (`projectActiveFromServer` → `buildDiagramsArray`) runs before the
 * write for the delete is even requested. Measured on an ordinary workspace
 * booted from the server: the row never left `ro_diagrams`, the card came
 * back after a reload and a server restart. A deletion is held from the
 * explicit intent (`noteDeleted`) until the registry no longer lists the id,
 * or until the same id is created again (an undo, a re-import).
 */
export class LocalDiagramHold {
  private ids = new Set<string>()
  private deleted = new Set<string>()

  /** Held CREATIONS (the session creation signal `has` answers for). */
  get size(): number {
    return this.ids.size
  }

  /** Held DELETIONS, not yet absent from the registry. */
  get heldDeletions(): number {
    return this.deleted.size
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  /** Note every diagram present in `current` but not in `previous`. Returns the
   *  newly held ids so the caller can do its own per-mode bookkeeping. A
   *  re-created id stops being held as deleted. */
  noteCreated(current: readonly Diagram[], previous: readonly Diagram[]): Diagram[] {
    const before = new Set(previous.map((diagram) => diagram.id))
    const created: Diagram[] = []
    for (const diagram of current) {
      if (before.has(diagram.id)) continue
      this.ids.add(diagram.id)
      this.deleted.delete(diagram.id)
      created.push(diagram)
    }
    return created
  }

  /** Hold an EXPLICIT delete intent (`pendingDeletedDiagramIds`) — never a
   *  diagram merely absent from a window. */
  noteDeleted(ids: Iterable<string>): void {
    for (const id of ids) {
      this.deleted.add(id)
      this.ids.delete(id)
    }
  }

  /** Drop held deletions the projection still carries, then re-add held
   *  creations it dropped, taking the resident value. */
  apply(projected: Diagram[], resident: readonly Diagram[]): Diagram[] {
    if (this.ids.size === 0 && this.deleted.size === 0) return projected
    const kept = this.deleted.size && projected.some((diagram) => this.deleted.has(diagram.id))
      ? projected.filter((diagram) => !this.deleted.has(diagram.id))
      : projected
    if (this.ids.size === 0) return kept
    const present = new Set(kept.map((diagram) => diagram.id))
    const missing = resident.filter((diagram) => this.ids.has(diagram.id) && !present.has(diagram.id))
    return missing.length === 0 ? kept : [...kept, ...missing]
  }

  /**
   * Release ids that no longer need holding: `durableIds` are the registry's,
   * and anything absent from `resident` was deleted before it was ever written.
   * Without the second condition a deleted-while-pending diagram would be held
   * forever, and `apply` would keep looking for it on every projection.
   *
   * A held DELETION is released once `durableIds` no longer lists it — but only
   * from a COMPLETE registry (`registryComplete`): a shard that has not
   * resolved yet is not an empty one, and reading it as "the delete landed"
   * would let its arrival resurrect the diagram.
   */
  retire(durableIds: Iterable<string>, resident: readonly Diagram[], registryComplete = true): void {
    if (this.ids.size === 0 && this.deleted.size === 0) return
    const durable = new Set(durableIds)
    const residentIds = new Set(resident.map((diagram) => diagram.id))
    for (const id of [...this.ids]) {
      if (durable.has(id) || !residentIds.has(id)) this.ids.delete(id)
    }
    if (!registryComplete) return
    for (const id of [...this.deleted]) {
      if (!durable.has(id)) this.deleted.delete(id)
    }
  }

  clear(): void {
    this.ids.clear()
    this.deleted.clear()
  }
}
