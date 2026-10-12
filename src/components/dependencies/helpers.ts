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

import type { ElementType } from 'react'
import { Box, Database, User, Monitor, Puzzle } from 'lucide-react'
import type { C4Object } from '../../types'
import { orderedTechnologyUsages } from '../../lib/technologyUsage'

/** Fallback icon per object type when an object has no custom icon. */
export const typeIcons: Record<string, ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  component: Puzzle,
}

/** CSS var carrying each C4 type's hue (per-appearance via index.css). */
export const typeColorVar: Record<string, string> = {
  actor: '--color-c4-actor',
  system: '--color-c4-system',
  app: '--color-c4-app',
  store: '--color-c4-store',
  component: '--color-c4-component',
}

/** Tinted tile background for a dependency card (kit: type hue at 16% over
 * surface-200). Groups (no type) fall back to a neutral warm tile. */
export function typeTint(type?: string): string {
  const v = type ? typeColorVar[type] : undefined
  return v ? `color-mix(in srgb, var(${v}) 16%, var(--color-surface-200))` : 'var(--color-surface-200)'
}

/** Builds the "App · Cloud Run · Node · REST · External" middot-joined meta line. */
export function techSummary(o: C4Object): string {
  const label = o.type.charAt(0).toUpperCase() + o.type.slice(1)
  const tech = orderedTechnologyUsages(o.technologyUsages, o.technologyUsageOrder).flatMap((usage) =>
    [usage.snapshot.name, usage.usedVersion, usage.role].filter(Boolean) as string[]
  )
  const parts = [label, ...tech]
  if (o.scope === 'external') parts.push('External')
  return parts.join(' · ')
}
