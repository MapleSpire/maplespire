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

import type { SelectedItem } from '../../types'

/**
 * Does a right-click on `objectId` act on the whole selection, or on that one
 * shape?
 *
 * Right-click deliberately does NOT change the selection: `CanvasEngine`'s
 * `onMouseDown` returns early for `e.button === 2` and `onContextMenu` forwards
 * `this.selectedItems` untouched. That is the correct behaviour — it is what
 * lets a user right-click inside a multi-selection to act on all of it — but it
 * means the clicked shape and the selection can be completely disjoint.
 *
 * So the count alone is NOT the predicate. Gating the multi-selection menu on
 * "more than one object is selected" opens a menu offering to delete a
 * selection the user is not pointing at: select Y and Z, right-click an
 * unselected X, and the menu that appears over X deletes Y and Z while X
 * survives. `deleteSelectedItems` is a real model delete and this app has no
 * undo.
 *
 * MEMBERSHIP is the missing half, and the engine already spells it correctly for
 * the equivalent multi-drag decision:
 *
 *   selectedObjectIds.length > 1 && selectedObjectIds.includes(obj.id)
 *
 * This is that predicate, extracted so it can be tested — `CanvasView` has no
 * test file, and an inline JSX condition is unreachable from a unit test.
 */
export function usesMultiSelectMenu(
  objectId: string | null | undefined,
  selectedItems: readonly SelectedItem[],
): boolean {
  if (!objectId) return false
  const selectedObjectIds = selectedItems.filter((item) => item.type === 'object').map((item) => item.id)
  return selectedObjectIds.length > 1 && selectedObjectIds.includes(objectId)
}
