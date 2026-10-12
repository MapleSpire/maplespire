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

export interface PersistentModelSlices {
  objects: readonly unknown[]
  connections: readonly unknown[]
  diagrams: readonly unknown[]
  flows: readonly unknown[]
  tags: readonly unknown[]
  groups: readonly unknown[]
  domains: readonly unknown[]
  comments: readonly unknown[]
  decisionRecords: readonly unknown[]
  currentDiagramId: string | null
}

/**
 * Zustand publishes transient selection/UI changes through the same store as
 * durable model data. The Automerge bridge uses reference identity here to
 * ignore those events without deep-scanning the resident window.
 */
export function persistentSlicesChanged(
  state: PersistentModelSlices,
  previous: PersistentModelSlices,
): boolean {
  return state.objects !== previous.objects
    || state.connections !== previous.connections
    || state.diagrams !== previous.diagrams
    || state.flows !== previous.flows
    || state.tags !== previous.tags
    || state.groups !== previous.groups
    || state.domains !== previous.domains
    || state.comments !== previous.comments
    || state.decisionRecords !== previous.decisionRecords
}
