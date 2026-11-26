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

import { resolvePerspectiveBarLayout } from '../tags/tagPerspectiveUtils'

/**
 * A NARROW EDITOR: from `lg` (1024 px) while the
 * canvas between the two columns is too narrow for the perspective bar to sit
 * beside the zoom cluster — the bar then STACKS above it, in the canvas's
 * bottom corner (`resolvePerspectiveBarLayout`, the bar's own rule: under
 * ~1250 px with both columns open). At 1024×768 the drawer docked against
 * the inspector left 15 % of the canvas, and the drawer, the notice, the
 * preview strip and the toast covered 65–86 % of the stacked bar. There
 * (`EpochOverridesPanel`):
 *  - the drawer takes the INSPECTOR's column below the tool row (Share stays
 *    visible above it; the inspector's Now/Yours markers show again in the
 *    preview, where the drawer folds into the strip);
 *  - the notice, the pill, the toast and the preview strip go to the TOP of
 *    the canvas, under the tool pill (below the retired banner when it is
 *    up), never over the bar or the zoom.
 * At 1280 and 1440 the bar is inline: nothing changes there. Under `lg` the
 * columns leave no canvas (the drawer falls back to the right edge, as before).
 */
export function narrowEditor(viewportWidth: number, leftOpen: boolean, rightOpen: boolean, mode: '2d' | '3d'): boolean {
  return rightOpen && viewportWidth >= 1024 && resolvePerspectiveBarLayout(viewportWidth, leftOpen, rightOpen, mode).stacked
}
