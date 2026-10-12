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

import { AiToolError } from '../toolContext.js'
import { ICON_CATALOG, type IconCatalogEntry } from './iconCatalog.gen.js'

/**
 * Icon-catalog lookups for the AI tools. `object.icon` / `group.icon` store an
 * icon's exact catalog NAME (the client renders by name lookup), so writes
 * must canonicalize + validate against the catalog or the badge silently
 * renders nothing.
 */

const byLowerName = new Map<string, IconCatalogEntry>()
for (const e of ICON_CATALOG) byLowerName.set(e.name.toLowerCase(), e)

export function findIcon(name: string): IconCatalogEntry | undefined {
  return byLowerName.get(name.trim().toLowerCase())
}

/** compatibleWith carries shape types or 'all'. */
export function iconCompatible(entry: IconCatalogEntry, shapeType: string): boolean {
  return entry.compatibleWith.includes('all') || entry.compatibleWith.includes(shapeType)
}

export interface IconSearchInput {
  q?: string
  pack?: string
  shapeType?: string
  limit: number
  offset?: number
}

/** Ranked substring search: exact > prefix > word-start > substring > keyword. */
export function searchIcons(input: IconSearchInput): { total: number; icons: IconCatalogEntry[] } {
  const q = input.q?.trim().toLowerCase()
  const pack = input.pack?.trim().toLowerCase()
  const scored: { score: number; entry: IconCatalogEntry }[] = []
  for (const entry of ICON_CATALOG) {
    if (pack && !(entry.packs ?? []).some((p) => p.toLowerCase() === pack)) continue
    if (input.shapeType && !iconCompatible(entry, input.shapeType)) continue
    if (!q) {
      scored.push({ score: 0, entry })
      continue
    }
    const name = entry.name.toLowerCase()
    let score = 0
    if (name === q) score = 100
    else if (name.startsWith(q)) score = 80
    else if (name.includes(` ${q}`) || name.includes(`-${q}`) || name.includes(`.${q}`)) score = 60
    else if (name.includes(q)) score = 40
    else if (
      [...(entry.framework ?? []), ...(entry.protocol ?? [])].some((k) => k.toLowerCase().includes(q))
    )
      score = 20
    if (score > 0) scored.push({ score, entry })
  }
  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  return { total: scored.length, icons: scored.slice(offset, offset + input.limit).map((s) => s.entry) }
}

export function listIconPacks(): { name: string; iconCount: number }[] {
  const counts = new Map<string, number>()
  for (const e of ICON_CATALOG) {
    for (const p of e.packs ?? []) counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, iconCount]) => ({ name, iconCount }))
    .sort((a, b) => b.iconCount - a.iconCount)
}

/** Why `name` can't be stored for `shapeType`, with close-match suggestions —
 * or null when it's valid. LLMs hallucinate plausible icon names constantly,
 * so every message steers back to search_icons. */
function iconProblem(name: string, shapeType: string): { message: string; status: number } | null {
  const entry = findIcon(name)
  if (!entry) {
    const near = searchIcons({ q: name, shapeType, limit: 5 }).icons.map((e) => e.name)
    return {
      message: `no icon named "${name}" in the catalog${near.length ? ` — closest matches: ${near.join(', ')}` : ''}. Use search_icons to find the exact name.`,
      status: 404,
    }
  }
  if (!iconCompatible(entry, shapeType)) {
    const alternatives = searchIcons({ q: name, shapeType, limit: 5 })
      .icons.filter((e) => e.name !== entry.name)
      .map((e) => e.name)
    return {
      message: `icon "${entry.name}" is not usable on a ${shapeType} (compatible with: ${entry.compatibleWith.join(', ')})${alternatives.length ? `. Compatible alternatives: ${alternatives.join(', ')}` : ''}`,
      status: 400,
    }
  }
  return null
}

/**
 * Validate `name` against the catalog for the given shape type and return the
 * CANONICAL catalog name to store (fixes case drift — the client lookup is
 * exact). Throws AiToolError with close-match suggestions on a miss.
 * Use on UPDATE paths, where setting the icon is the caller's explicit intent.
 */
export function requireIcon(name: string, shapeType: string): string {
  const problem = iconProblem(name, shapeType)
  if (problem) throw new AiToolError(problem.message, problem.status)
  return findIcon(name)!.name
}

/**
 * Lenient variant for CREATE paths: a hallucinated icon must not sink the
 * whole entity creation. Returns the canonical name, or drops the icon and
 * returns a warning the agent can act on (retry via update after search_icons).
 */
export function resolveIconOrWarn(
  name: string,
  shapeType: string
): { icon?: string; warning?: string } {
  const problem = iconProblem(name, shapeType)
  if (problem) return { warning: `icon ignored: ${problem.message}` }
  return { icon: findIcon(name)!.name }
}

export const ICON_COUNT = ICON_CATALOG.length
