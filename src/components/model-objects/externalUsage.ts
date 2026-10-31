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

import type { ModelObjectRow } from '../../lib/modelQuery/types'

/** "External in N of M diagrams" is shown only where the per-diagram scope
 * departs from the default the row already prints: an internal default that
 * is external somewhere, or an external default that some diagram overrides
 * to internal. Agreement everywhere would repeat the default as noise. */
export function showsExternalUsage(
  row: Pick<ModelObjectRow, 'isGroup' | 'scope' | 'diagramCount' | 'externalDiagramCount'>,
): boolean {
  if (row.isGroup || row.externalDiagramCount === undefined || row.diagramCount <= 0) return false
  return row.scope === 'external'
    ? row.externalDiagramCount < row.diagramCount
    : row.externalDiagramCount > 0
}
