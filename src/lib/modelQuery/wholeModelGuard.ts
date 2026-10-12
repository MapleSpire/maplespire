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

const warned = new Set<string>()

/** Whole-model reads are retained only for explicit export/migration fallbacks.
 * Migrated interactive views must use bounded ModelQuery pages instead. */
export function warnWholeModelRead(operation: string): void {
  if (!import.meta.env.DEV || typeof window === 'undefined' || warned.has(operation)) return
  warned.add(operation)
  console.warn(
    `[model-query] ${operation} materializes the whole model. ` +
      'Interactive views must use a paged query; keep this call only for explicit export or migration.'
  )
}
export function __resetWholeModelWarningsForTest(): void {
  warned.clear()
}
