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

import type { C4Object, Connection } from '../../types'
import type { SearchHit } from './types'
import { technologyNamesOf } from '../technologyUsage'

/** Minimum query length — a trigram needs 3 chars, so the paged backend can't
 * index shorter queries; both backends enforce this for consistent behavior. */
export const SEARCH_MIN_CHARS = 3
/** Default number of results returned. */
export const SEARCH_LIMIT = 12

/** An object's technology text — the deprecated singular `technology` plus every
 * `technologies[].name` (the modern field), space-joined. Used by both search
 * tokenization and scoring so a query matches either representation. */
export function objectTechnologyText(o: C4Object): string {
  return technologyNamesOf(o).join(' ')
}

/** The searchable text fields of an object (name / description / technology). */
export function objectSearchTexts(o: C4Object): string[] {
  const texts = [o.name, o.description].filter((s): s is string => !!s)
  const tech = objectTechnologyText(o)
  if (tech) texts.push(tech)
  return texts
}
/** The searchable text fields of a connection (label). */
export function connectionSearchTexts(c: Connection): string[] {
  return c.label ? [c.label] : []
}

/** 3-grams (lowercased) of each text, unioned — per-text so no cross-field grams. */
export function trigramsOf(texts: string[]): Set<string> {
  const set = new Set<string>()
  for (const text of texts) {
    const t = text.toLowerCase()
    for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3))
  }
  return set
}

// Relevance weights. Objects always outrank connections (so a name/desc hit shows
// before a label hit), matching today's objects-then-connections ordering.
/** Object score: name(4) > technology(3) > description(2); 0 = no substring match.
 * Technology spans the deprecated `technology` + the `technologies[]` array. */
export function scoreObject(o: C4Object, q: string): number {
  if (o.name.toLowerCase().includes(q)) return 4
  if (objectTechnologyText(o).toLowerCase().includes(q)) return 3
  if (o.description?.toLowerCase().includes(q)) return 2
  return 0
}
/** Connection score: label(1); 0 = no match. */
export function scoreConnection(c: Connection, q: string): number {
  return c.label?.toLowerCase().includes(q) ? 1 : 0
}

interface Scored {
  hit: SearchHit
  score: number
  sortKey: string
  id: string
}

/**
 * Rank matched objects + connections into a stable, deterministic SearchHit list.
 * Shared by the resident and paged backends so they produce identical output:
 * candidates are filtered by the SAME `scoreObject`/`scoreConnection`, then sorted
 * by score desc → display text asc → id asc. `nameOf` resolves a connection
 * endpoint id to a display name.
 */
export function rankSearch(
  objects: C4Object[],
  connections: Connection[],
  q: string,
  limit: number,
  nameOf: (id: string) => string,
): SearchHit[] {
  const scored: Scored[] = []
  for (const o of objects) {
    const score = scoreObject(o, q)
    if (score > 0) {
      scored.push({ hit: { type: 'object', object: o }, score, sortKey: o.name.toLowerCase(), id: o.id })
    }
  }
  for (const c of connections) {
    const score = scoreConnection(c, q)
    if (score > 0) {
      scored.push({
        hit: { type: 'connection', connection: c, fromName: nameOf(c.fromId), toName: nameOf(c.toId) },
        score,
        sortKey: (c.label ?? '').toLowerCase(),
        id: c.id,
      })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id))
  return scored.slice(0, limit).map((s) => s.hit)
}
