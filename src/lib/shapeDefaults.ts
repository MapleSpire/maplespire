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

/**
 * The box a new shape gets, whichever way it is created — the palette, a drop
 * on the canvas, the Model Objects page, or an import.
 *
 * Imports used their own per-type table (150-200 × 90-100), so an imported
 * diagram's shapes visibly did not match the ones a user then drew next to them
 * (user report, 2026-10-21). The server-side AI tools and org seed use the same
 * 160 × 100 in their own package (`server/src/ai/core/tools/*`,
 * `server/src/orgSeed/generator.ts`).
 */
export const DEFAULT_SHAPE_SIZE: Readonly<{ width: number; height: number }> = { width: 160, height: 100 }

export function defaultShapeSize(): { width: number; height: number } {
  return { ...DEFAULT_SHAPE_SIZE }
}
