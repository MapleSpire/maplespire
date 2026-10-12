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

export function moveRelative<T extends { id: string }>(
  items: readonly T[],
  sourceId: string,
  targetId: string,
  before: boolean,
): T[] {
  if (sourceId === targetId) return [...items]
  const source = items.find((item) => item.id === sourceId)
  if (!source) return [...items]
  const without = items.filter((item) => item.id !== sourceId)
  const targetIndex = without.findIndex((item) => item.id === targetId)
  if (targetIndex < 0) return [...items]
  const insertionIndex = targetIndex + (before ? 0 : 1)
  return [...without.slice(0, insertionIndex), source, ...without.slice(insertionIndex)]
}

export function resolvePerspectiveBarLayout(
  viewportWidth: number,
  leftSidebarOpen: boolean,
  rightSidebarOpen: boolean,
  canvasViewMode: '2d' | '3d',
) {
  const left = leftSidebarOpen ? 340 : 14
  const panelRight = rightSidebarOpen ? 338 : 12
  const controlReserve = 232
  const inlineRight = panelRight + controlReserve
  const inlineWidth = viewportWidth - left - inlineRight
  const stacked = inlineWidth < 340
  const stackedWidth = viewportWidth - left - panelRight
  const right = stacked ? panelRight : inlineRight
  const availableWidth = Math.max(0, viewportWidth - left - right)
  return {
    left,
    right,
    availableWidth,
    bottom: stacked ? (canvasViewMode === '3d' ? 116 : 70) : 14,
    stacked,
    forcedFab: stackedWidth < 300,
    compact: availableWidth < 480,
  }
}
