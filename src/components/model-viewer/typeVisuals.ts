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

import { User, Monitor, Box, Database, Puzzle } from 'lucide-react'
import type { C4Object, C4Type, Domain } from '../../types'
import { orderedTechnologyUsages } from '../../lib/technologyUsage'

/** Per-C4-type icon + hue (same convention as the Model objects table). */
export const TYPE_ICONS: Record<C4Type, React.ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  component: Puzzle,
}

export const TYPE_COLORS: Record<C4Type, string> = {
  actor: 'var(--color-c4-actor)',
  system: 'var(--color-c4-system)',
  app: 'var(--color-c4-app)',
  store: 'var(--color-c4-store)',
  component: 'var(--color-c4-component)',
}

/** Tinted badge background for a type hue. */
export const typeTint = (type: C4Type): string =>
  `color-mix(in srgb, ${TYPE_COLORS[type]} 15%, transparent)`

/** A tile's accent-bar color: first technology's brand color, else the domain
 * color, else the neutral line (design kit `barColor`). */
export function tileBarColor(o: C4Object, domainById: Map<string, Domain>): string {
  const tech = orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder)[0]?.snapshot.name
  if (tech) return 'var(--color-accent)'
  const domain = o.domainId ? domainById.get(o.domainId) : undefined
  return domain?.color ?? 'var(--color-line-strong)'
}
