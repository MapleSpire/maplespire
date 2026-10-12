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
 */
export class LocalDiagramHold {
  private ids = new Set<string>()

  get size(): number {
    return this.ids.size
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  /** Note every diagram present in `current` but not in `previous`. Returns the
   *  newly held ids so the caller can do its own per-mode bookkeeping. */
  noteCreated(current: readonly Diagram[], previous: readonly Diagram[]): Diagram[] {
    const before = new Set(previous.map((diagram) => diagram.id))
    const created: Diagram[] = []
    for (const diagram of current) {
      if (before.has(diagram.id)) continue
      this.ids.add(diagram.id)
      created.push(diagram)
    }
    return created
  }

  /** Re-add held diagrams the projection dropped, taking the resident value. */
  apply(projected: Diagram[], resident: readonly Diagram[]): Diagram[] {
    if (this.ids.size === 0) return projected
    const present = new Set(projected.map((diagram) => diagram.id))
    const missing = resident.filter((diagram) => this.ids.has(diagram.id) && !present.has(diagram.id))
    return missing.length === 0 ? projected : [...projected, ...missing]
  }

  /**
   * Release ids that no longer need holding: `durableIds` are the registry's,
   * and anything absent from `resident` was deleted before it was ever written.
   * Without the second condition a deleted-while-pending diagram would be held
   * forever, and `apply` would keep looking for it on every projection.
   */
  retire(durableIds: Iterable<string>, resident: readonly Diagram[]): void {
    if (this.ids.size === 0) return
    const durable = new Set(durableIds)
    const residentIds = new Set(resident.map((diagram) => diagram.id))
    for (const id of [...this.ids]) {
      if (durable.has(id) || !residentIds.has(id)) this.ids.delete(id)
    }
  }

  clear(): void {
    this.ids.clear()
  }
}
