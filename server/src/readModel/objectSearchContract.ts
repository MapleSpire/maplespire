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

export const OBJECT_SEARCH_QUERY_ERROR = 'provide either no search text for bounded browsing or at least two search characters'

/** Empty text is the dependency focus picker's bounded browse mode. A single
 * character remains rejected because it creates an excessively broad textual
 * scan; two or more characters use the indexed search path. */
export function objectSearchQueryError(query: string): string | undefined {
  return query.length === 1 ? OBJECT_SEARCH_QUERY_ERROR : undefined
}
