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

import type { ShapeIconAssignment } from '../../types'

export interface ShapeIconArtwork {
  iconLightPath?: string
  iconDarkPath?: string
}

type CatalogLookup = (name: string) => ShapeIconArtwork | undefined

let lookup: CatalogLookup | null = null
let loading: Promise<void> | null = null
const waiters = new Set<() => void>()

/** Exact catalog name first (the same first-occurrence + alias rule as
 * getIconByName), then a case-insensitive match — the server AI tools and
 * the governed seed resolve names case-insensitively. */
function buildLookup(mod: typeof import('../techIcons')): CatalogLookup {
  const byLower = new Map<string, (typeof mod.ICONS)[number]>()
  for (const icon of mod.ICONS) {
    const key = icon.name.toLowerCase()
    if (!byLower.has(key)) byLower.set(key, icon)
  }
  return (name) => {
    const entry = mod.getIconByName(name) ?? byLower.get(name.trim().toLowerCase())
    if (!entry || (!entry.iconLight && !entry.iconDark)) return undefined
    return {
      ...(entry.iconLight ? { iconLightPath: entry.iconLight } : {}),
      ...(entry.iconDark ? { iconDarkPath: entry.iconDark } : {}),
    }
  }
}

/** Load the bundled icon catalog once. It is deliberately a dynamic import:
 * the catalog is ~40k lines and only shapes carrying a bare `icon` name with
 * no `iconAssignment` (data written before assignments existed, or by a
 * writer that forgot them) need it. */
export function loadIconCatalog(): Promise<void> {
  if (lookup) return Promise.resolve()
  loading ??= import('../techIcons').then(
    (mod) => {
      lookup = buildLookup(mod)
      const ready = [...waiters]
      waiters.clear()
      for (const notify of ready) notify()
    },
    (error: unknown) => {
      // A failed chunk load (offline before the chunk was cached) must not
      // latch: the next render retries, and the letter badge stays meanwhile.
      loading = null
      throw error
    },
  )
  return loading
}

/** Catalog artwork for a bare icon name, or undefined when the catalog is not
 * loaded yet or the name is truly not in it. */
export function catalogIconArtwork(name: string): ShapeIconArtwork | undefined {
  return lookup?.(name)
}

/**
 * The artwork a shape renders: its `iconAssignment` when it has one (the shape
 * the editor writes), else the catalog entry named by `icon`. An assignment
 * always wins, even without paths — a governed technology with no logo keeps
 * its letter badge rather than borrowing an unrelated catalog picture.
 *
 * While the catalog is still loading this returns undefined and calls
 * `onCatalogReady` once it is available, so a renderer can repaint.
 */
export function shapeIconArtwork(
  shape: { icon?: string; iconAssignment?: ShapeIconAssignment },
  onCatalogReady?: () => void,
): ShapeIconArtwork | undefined {
  if (shape.iconAssignment) return shape.iconAssignment
  const name = shape.icon?.trim()
  if (!name) return undefined
  if (lookup) return lookup(name)
  if (onCatalogReady) waiters.add(onCatalogReady)
  void loadIconCatalog().catch(() => {})
  return undefined
}

/** True while the catalog chunk is being fetched (exports wait on it). */
export function isIconCatalogLoading(): boolean {
  return lookup === null && loading !== null
}

/** Drop a pending `onCatalogReady` (a renderer being destroyed). */
export function cancelIconCatalogWait(onCatalogReady: () => void): void {
  waiters.delete(onCatalogReady)
}

/** Test seam: forget the loaded catalog. */
export function resetIconCatalogForTests(): void {
  lookup = null
  loading = null
  waiters.clear()
}
