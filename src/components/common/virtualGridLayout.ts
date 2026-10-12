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

export function virtualGridColumnCount(width: number, minColumnWidth: number, gap: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1
  return Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
}

export function virtualGridRowCount(itemCount: number, columns: number): number {
  return Math.ceil(Math.max(0, itemCount) / Math.max(1, columns))
}

export function virtualGridRowItems<T>(items: T[], columns: number, rowIndex: number): T[] {
  const safeColumns = Math.max(1, columns)
  const start = Math.max(0, rowIndex) * safeColumns
  return items.slice(start, start + safeColumns)
}
