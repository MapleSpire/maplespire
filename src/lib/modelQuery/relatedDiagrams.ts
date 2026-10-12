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
import type { RelatedDiagramsOptions, RelatedDiagramsResult } from './types'

const categories = ['detail', 'reference', 'parent'] as const

export function emptyRelatedDiagrams(limit = 50): RelatedDiagramsResult {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)))
  return {
    detail: [], reference: [], parent: [],
    totals: { detail: 0, reference: 0, parent: 0 },
    limit: boundedLimit,
    truncated: false,
  }
}

/** Apply the same bounded contract to resident/offline data that PostgreSQL
 * applies online. The registry can remain complete for offline navigation, but
 * the menu receives at most 3 * limit rows. */
export function boundRelatedDiagrams(
  input: { detail: Diagram[]; reference: Diagram[]; parent: Diagram[] },
  options: RelatedDiagramsOptions = {},
): RelatedDiagramsResult {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
  const query = options.query?.trim().toLocaleLowerCase() ?? ''
  const result = emptyRelatedDiagrams(limit)
  for (const category of categories) {
    const matching = input[category]
      .filter((diagram) => !query || diagram.name.toLocaleLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    result.totals[category] = matching.length
    result[category] = matching.slice(0, limit)
  }
  result.truncated = categories.some((category) => result.totals[category] > result[category].length)
  return result
}
