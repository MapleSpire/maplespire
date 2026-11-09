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

import { ENTITY_STORE_SLICES, type EntityStoreSlice } from './entityFamilies'

/** One store slice per registered entity family (`storeSlice` in
 * entityFamilies.ts), plus the local-only active diagram id. */
export type PersistentModelSlices = { readonly [S in EntityStoreSlice]: readonly unknown[] } & {
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
  for (const slice of ENTITY_STORE_SLICES) {
    if (state[slice] !== previous[slice]) return true
  }
  return false
}
