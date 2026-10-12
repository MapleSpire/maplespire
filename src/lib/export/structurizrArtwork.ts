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
 * How a MapleSpire shape's artwork crosses into Structurizr, for BOTH exports.
 *
 * Structurizr styles key on tags and nothing else, so an icon can only travel as
 * a synthetic tag with an `icon` style hung on it. That synthesis is a
 * convention, not a detail: the DSL export and the JSON export of the same
 * landscape must mint the SAME tag for the same artwork, or a customer holding
 * both files has two names for one icon — and the DSL importer, which drops
 * `ms-icon-*` on the way back in (`mapper.ts`), only recognises the one spelling.
 * It lived in `structurizr.ts` until the JSON exporter needed it too; a second
 * copy would have drifted the first time either side learned a new icon source.
 */

import type { C4Object } from '../../types'
import { ICON_TAG_PREFIX } from '../structurizr/mapper'
import { orderedTechnologyUsages } from '../technologyUsage'

export interface ShapeArtwork {
  /** The synthetic tag the `icon` style is keyed on. */
  tag: string
  label: string
  /** Stored path, still relative — `absoluteIconUrl` resolves it. */
  path: string
}

/** Which half of a dual-appearance icon pair to carry. */
export type ArtworkScheme = 'light' | 'dark'

/**
 * The artwork a shape renders, if any — an explicit icon assignment first, else
 * the icon the first governed technology supplies.
 *
 * `scheme` picks between the two stored appearances and falls back to the other
 * when only one exists: an export whose palette is dark carrying light artwork
 * is a legible file with the wrong pictures in it.
 */
export function artworkOf(o: C4Object, scheme: ArtworkScheme = 'light'): ShapeArtwork | null {
  const explicit = o.iconAssignment
  const fromTechnology = orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder)[0]?.snapshot
  const label = explicit?.displayName || fromTechnology?.name || o.icon
  const preferred = (source?: { iconLightPath?: string; iconDarkPath?: string }) =>
    scheme === 'dark'
      ? source?.iconDarkPath || source?.iconLightPath
      : source?.iconLightPath || source?.iconDarkPath
  const path = preferred(explicit) || preferred(fromTechnology)
  if (!label || !path) return null
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return null
  return { tag: `${ICON_TAG_PREFIX}${slug}`, label, path }
}

/** Resolve a stored icon path to something a Structurizr renderer can fetch.
 *  Paths are same-origin (`/icons/light/<hash>.png`), so they need an origin. */
export function absoluteIconUrl(path: string, origin: string | undefined): string {
  if (/^https?:\/\//i.test(path) || path.startsWith('data:')) return path
  if (!origin) return path
  return `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
}

/** True for a path only a same-origin reader can fetch — i.e. one that needs an
 *  `iconOrigin` before it means anything in someone else's renderer. */
export function isRelativeIconPath(path: string): boolean {
  return !/^https?:\/\//i.test(path) && !path.startsWith('data:')
}
