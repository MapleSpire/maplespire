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
 * The `?view=` deep-link (2d|3d) for the canvas.
 *
 * `/app/…/diagram/<id>?view=3d` (editor) and `/share/<token>?view=3d` (viewer)
 * open straight into the 3D board. The editor's param is captured ONCE at module
 * load — before RouteSync reshapes the path on boot, which would otherwise strip
 * the query — and consumed on the first diagram entry (later diagrams fall back
 * to the per-diagram localStorage memory). RouteSync then re-derives `?view=3d`
 * from the live view mode, so the address bar stays a copyable 3D link. The
 * viewer reads/writes the param live (it isn't under RouteSync).
 */

export type DeepLinkView = '2d' | '3d'

function parse(search: string): DeepLinkView | null {
  try {
    const v = new URLSearchParams(search).get('view')
    return v === '2d' || v === '3d' ? v : null
  } catch {
    return null
  }
}

// Snapshot the boot URL synchronously at import time (before any router effect).
let initial: DeepLinkView | null = typeof window !== 'undefined' ? parse(window.location.search) : null

/** The boot `?view` mode, returned ONCE then cleared (single-shot) — so it seeds
 * only the first diagram opened, not every subsequent one. */
export function takeInitialViewMode(): DeepLinkView | null {
  const v = initial
  initial = null
  return v
}

/** The current `?view` mode from the live URL (non-consuming) — for the viewer. */
export function readUrlViewMode(): DeepLinkView | null {
  return typeof window !== 'undefined' ? parse(window.location.search) : null
}

/** Reflect the view mode into the live URL's `?view` (3d sets it, 2d drops it)
 * without a router navigation — keeps the address bar a copyable link. */
export function writeUrlViewMode(mode: DeepLinkView): void {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    if (mode === '3d') url.searchParams.set('view', '3d')
    else url.searchParams.delete('view')
    window.history.replaceState(window.history.state, '', url)
  } catch {
    /* history unavailable */
  }
}
