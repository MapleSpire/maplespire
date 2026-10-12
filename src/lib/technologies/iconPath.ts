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

/** Resolve the immutable catalog asset for the application theme. Both fields
 * are optional so older revisions and one-variant logos degrade gracefully. */
export function resolveTechnologyIconPath(
  resolvedTheme: 'light' | 'dark',
  iconLightPath?: string | null,
  iconDarkPath?: string | null,
): string | undefined {
  return resolvedTheme === 'dark'
    ? iconDarkPath ?? iconLightPath ?? undefined
    : iconLightPath ?? iconDarkPath ?? undefined
}
