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

import { plainOf } from '../../lib/automerge/epochOverrides'

/** An overridden value as the review panel and the markers show it
 * (G4-16f): text as is, anything else as compact JSON, empty as a dash. */
export function displayValue(value: unknown): string {
  const plain = plainOf(value)
  if (plain === null || plain === undefined || plain === '') return '—'
  if (typeof plain === 'string') return plain
  const text = JSON.stringify(plain)
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/** The full value, for a `title` (long values are cut in the row). */
export function fullValue(value: unknown): string {
  const plain = plainOf(value)
  if (plain === null || plain === undefined || plain === '') return '—'
  return typeof plain === 'string' ? plain : JSON.stringify(plain, null, 2)
}

const KNOWN_FIELDS = ['name', 'description', 'status', 'technology', 'label', 'type', 'scope', 'owners', 'tags', 'properties']

/** The label of an overridden field path ('name', 'properties.k', '*' for the
 * whole entity), shared by the panel and the inspector markers (visual 5). */
export function fieldLabel(
  field: string,
  collection: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (field === '*' || field === '') return t(`epochs.overrides.wholeEntity.${collection ?? 'objects'}`)
  const [head, ...rest] = field.split('.')
  if (!KNOWN_FIELDS.includes(head!)) return field
  const label = t(`epochs.overrides.field.${head}`)
  // A nested path keeps its tail, under the translated field:
  // "properties.k" reads "Properties › k".
  return rest.length === 0 ? label : `${label} › ${rest.join('.')}`
}

/** "5 min ago" in the app's language. */
export function relativeTime(iso: string, language: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.round((then - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour')
  return rtf.format(Math.round(seconds / 86_400), 'day')
}
