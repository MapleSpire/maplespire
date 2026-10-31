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
 * Spotlight search core: matching, scoring and ordering.
 *
 * THIS FILE EXISTS TWICE, byte for byte: `src/lib/search/spotlight/` (the ruling
 * copy) and `server/src/search/spotlight/` (the server's mirror). Edit the
 * `src/` copy, then run `node scripts/sync-spotlight-core.mjs`;
 * `spotlight.conformance.test.ts` fails on any byte difference. See `fold.ts`.
 *
 * Every rule here is chosen so SQL can reproduce it exactly: matches are
 * exact / prefix / word-start / substring on FOLDED text, a word starts after
 * an ASCII non-alphanumeric character, and ties order by code point (Postgres
 * `COLLATE "C"`). Each tier (server, Worker cache, resident store) feeds its
 * candidates through `evaluateSpotlight`, so a result never moves when a slower
 * tier's answer replaces a faster one's.
 */

import { compareCodePoints, fold, foldWithMap, sourceRange } from './fold.js'
import { SPOTLIGHT_KIND_ORDER } from './grammar.js'
import type { EnumTerm, SpotlightKind, SpotlightQuery, SpotlightTerm, TextTerm } from './grammar.js'

/** A term shorter than this (folded) only matches at the START of a word, and
 *  an unscoped one only in names. Trigram indexes cannot serve a shorter term,
 *  and a one-letter substring match would return most of the model. */
export const SHORT_TERM_CHARS = 3

export const MATCH_EXACT = 4
export const MATCH_PREFIX = 3
export const MATCH_WORD_START = 2
export const MATCH_SUBSTRING = 1

/** Score of a match = field weight x match quality. Names lead. */
export const FIELD_WEIGHTS = { name: 4, tech: 3, tag: 3, desc: 2 } as const

/** A field a document of some kind can carry. */
export type DocField = 'name' | 'desc' | 'tech' | 'tag' | 'status' | 'scope' | 'domain' | 'in' | 'from' | 'to'

const C4_FIELDS: readonly DocField[] = ['name', 'desc', 'tech', 'tag', 'status', 'scope', 'domain', 'in']

/** Which fields each kind carries. A field outside this list is IGNORED even
 *  when a tier fills it, so every tier agrees on what can match and
 *  `spotlightKinds` can skip whole sections exactly. */
export const SPOTLIGHT_KIND_FIELDS: Readonly<Record<SpotlightKind, readonly DocField[]>> = {
  system: C4_FIELDS,
  app: C4_FIELDS,
  store: C4_FIELDS,
  component: C4_FIELDS,
  actor: C4_FIELDS,
  group: ['name', 'tech', 'in'],
  diagram: ['name', 'desc', 'domain'],
  flow: ['name', 'domain', 'in'],
  adr: ['name', 'desc', 'status'],
  connection: ['name', 'desc', 'tech', 'tag', 'in', 'from', 'to'],
  page: ['name'],
}

/** What a tier hands the evaluator. Raw text: the core folds it. */
export interface SpotlightDoc {
  readonly kind: SpotlightKind
  readonly id: string
  /** Title: object name, connection label, diagram name, ADR title, page label. */
  readonly name: string
  /** Other names that match like the title (`ADR-12`, a page's synonyms). */
  readonly alt?: readonly string[]
  /** Short + long description, or an ADR's summary and content. */
  readonly description?: string
  readonly tech?: readonly string[]
  readonly tags?: readonly string[]
  /** Canonical status (`live`, `approved`, ...). */
  readonly status?: string
  readonly scope?: 'internal' | 'external'
  /** Domain name. */
  readonly domain?: string
  /** Names of the diagrams it appears in (a flow: its diagram). */
  readonly diagrams?: readonly string[]
  /** Connection endpoint names. */
  readonly from?: string
  readonly to?: string
}

/** A document folded once, ready to be evaluated against many queries. */
export interface PreparedDoc<D extends SpotlightDoc = SpotlightDoc> {
  readonly doc: D
  /** Folded title. Ties order by it. */
  readonly sortName: string
  readonly name: readonly string[]
  readonly desc: string
  readonly tech: readonly string[]
  readonly tag: readonly string[]
  readonly status: string | null
  readonly scope: string | null
  readonly domain: readonly string[]
  readonly in: readonly string[]
  readonly from: readonly string[]
  readonly to: readonly string[]
}

export function prepareSpotlightDoc<D extends SpotlightDoc>(doc: D): PreparedDoc<D> {
  const fields = SPOTLIGHT_KIND_FIELDS[doc.kind]
  const has = (f: DocField) => fields.includes(f)
  const list = (f: DocField, values: readonly (string | undefined)[] | undefined): string[] =>
    has(f) && values ? values.map((v) => (v ? fold(v) : '')).filter((v) => v.length > 0) : []
  const sortName = fold(doc.name)
  return {
    doc,
    sortName,
    name: [sortName, ...list('name', doc.alt)].filter((v) => v.length > 0),
    desc: has('desc') && doc.description ? fold(doc.description) : '',
    tech: list('tech', doc.tech),
    tag: list('tag', doc.tags),
    status: has('status') && doc.status ? doc.status : null,
    scope: has('scope') && doc.scope ? doc.scope : null,
    domain: list('domain', [doc.domain]),
    in: list('in', doc.diagrams),
    from: list('from', [doc.from]),
    to: list('to', [doc.to]),
  }
}

// ── matching ──────────────────────────────────────────────────────────────────

/** A word starts at index 0 or after an ASCII character that is not a letter
 *  or digit. (Folded text has no ASCII capitals.) A non-ASCII character is
 *  never a separator, so `k8s` and Cyrillic words stay whole. */
export function isWordBoundary(code: number): boolean {
  return code < 0x80 && !((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a))
}

/** How well folded `term` matches folded `field`: exact, prefix, word start,
 *  substring, or 0. A short term never matches as a mere substring. */
export function matchQuality(field: string, term: string): number {
  if (!term || !field) return 0
  if (field === term) return MATCH_EXACT
  if (field.startsWith(term)) return MATCH_PREFIX
  let at = field.indexOf(term, 1)
  if (at < 0) return 0
  while (at > 0) {
    if (isWordBoundary(field.charCodeAt(at - 1))) return MATCH_WORD_START
    at = field.indexOf(term, at + 1)
  }
  return term.length >= SHORT_TERM_CHARS ? MATCH_SUBSTRING : 0
}

function bestQuality(fields: readonly string[], term: string): number {
  let best = 0
  for (const f of fields) {
    const q = matchQuality(f, term)
    if (q > best) best = q
    if (best === MATCH_EXACT) break
  }
  return best
}

interface TermResult {
  readonly matched: boolean
  readonly score: number
}

const NO_MATCH: TermResult = { matched: false, score: 0 }

function textTermResult(term: TextTerm, d: PreparedDoc): TermResult {
  let matched = false
  let score = 0
  const consider = (quality: number, weight: number) => {
    if (quality <= 0) return
    matched = true
    if (quality * weight > score) score = quality * weight
  }
  for (const value of term.values) {
    const short = value.length < SHORT_TERM_CHARS
    switch (term.field) {
      case 'any':
        consider(bestQuality(d.name, value), FIELD_WEIGHTS.name)
        if (!short) {
          consider(bestQuality(d.tech, value), FIELD_WEIGHTS.tech)
          consider(bestQuality(d.tag, value), FIELD_WEIGHTS.tag)
          consider(matchQuality(d.desc, value), FIELD_WEIGHTS.desc)
        }
        break
      case 'name': consider(bestQuality(d.name, value), FIELD_WEIGHTS.name); break
      case 'desc': consider(matchQuality(d.desc, value), FIELD_WEIGHTS.desc); break
      case 'tech': consider(bestQuality(d.tech, value), FIELD_WEIGHTS.tech); break
      case 'tag': consider(bestQuality(d.tag, value), FIELD_WEIGHTS.tag); break
      // Pure filters: they must match, they add nothing to the score.
      case 'domain': consider(bestQuality(d.domain, value), 0); break
      case 'in': consider(bestQuality(d.in, value), 0); break
      case 'from': consider(bestQuality(d.from, value), 0); break
      case 'to': consider(bestQuality(d.to, value), 0); break
    }
  }
  return matched ? { matched, score } : NO_MATCH
}

function enumTermMatches(term: EnumTerm, d: PreparedDoc): boolean {
  switch (term.key) {
    case 'kind': return term.values.includes(d.doc.kind)
    case 'status': return d.status !== null && term.values.includes(d.status)
    case 'scope': return d.scope !== null && term.values.includes(d.scope)
    case 'has':
      return term.values.some((v) =>
        v === 'description' ? d.desc.length > 0
          : v === 'diagram' ? d.in.length > 0
            : v === 'tech' ? d.tech.length > 0
              : v === 'tag' ? d.tag.length > 0
                : false)
  }
}

function termResult(term: SpotlightTerm, d: PreparedDoc): TermResult {
  return term.type === 'text' ? textTermResult(term, d) : { matched: enumTermMatches(term, d), score: 0 }
}

/**
 * The score of `d` for `query`, or null when it does not match. Groups are
 * ANDed (scores add up); terms in a group are ORed (the best positive term
 * counts). A query of filters alone matches with score 0.
 */
export function evaluateSpotlight(query: SpotlightQuery, d: PreparedDoc): number | null {
  if (query.groups.length === 0) return null
  let total = 0
  for (const group of query.groups) {
    let groupMatched = false
    let groupScore = 0
    for (const term of group) {
      const r = termResult(term, d)
      if (term.negated ? r.matched : !r.matched) continue
      groupMatched = true
      if (!term.negated && r.score > groupScore) groupScore = r.score
    }
    if (!groupMatched) return null
    total += groupScore
  }
  return total
}

// ── which sections can match ──────────────────────────────────────────────────

function kindsWith(field: DocField): SpotlightKind[] {
  return SPOTLIGHT_KIND_ORDER.filter((k) => SPOTLIGHT_KIND_FIELDS[k].includes(field))
}

function kindsAllowedBy(term: SpotlightTerm): readonly SpotlightKind[] {
  if (term.type === 'text') {
    // A negated term is satisfied by any kind that lacks the field.
    return term.negated || term.field === 'any' ? SPOTLIGHT_KIND_ORDER : kindsWith(term.field)
  }
  switch (term.key) {
    case 'kind':
      return SPOTLIGHT_KIND_ORDER.filter((k) => term.values.includes(k) !== term.negated)
    case 'status':
    case 'scope':
      return term.negated ? SPOTLIGHT_KIND_ORDER : kindsWith(term.key)
    case 'has': {
      if (term.negated) return SPOTLIGHT_KIND_ORDER
      const fields = term.values.map((v): DocField => (v === 'description' ? 'desc' : v === 'diagram' ? 'in' : v === 'tech' ? 'tech' : 'tag'))
      return SPOTLIGHT_KIND_ORDER.filter((k) => fields.some((f) => SPOTLIGHT_KIND_FIELDS[k].includes(f)))
    }
  }
}

/** The kinds a query can possibly return, in section order. Exact, not a
 *  heuristic: the evaluator ignores fields a kind does not carry, so a tier may
 *  skip every other section without losing a result. */
export function spotlightKinds(query: SpotlightQuery): SpotlightKind[] {
  if (query.groups.length === 0) return []
  let kinds: SpotlightKind[] = [...SPOTLIGHT_KIND_ORDER]
  for (const group of query.groups) {
    const allowed = new Set<SpotlightKind>()
    for (const term of group) for (const k of kindsAllowedBy(term)) allowed.add(k)
    kinds = kinds.filter((k) => allowed.has(k))
  }
  return kinds
}

// ── ordering ──────────────────────────────────────────────────────────────────

export interface SpotlightHit<D extends SpotlightDoc = SpotlightDoc> {
  readonly doc: D
  readonly score: number
  readonly sortName: string
}

/** Within a section: score, then folded title, then id (code point order). */
export function compareSpotlightHits(a: SpotlightHit, b: SpotlightHit): number {
  if (a.score !== b.score) return b.score - a.score
  return compareCodePoints(a.sortName, b.sortName) || compareCodePoints(a.doc.id, b.doc.id)
}

const KIND_RANK: Readonly<Record<string, number>> = Object.fromEntries(SPOTLIGHT_KIND_ORDER.map((k, i) => [k, i]))

/** Across sections (the top hit): score, then section order, then as above. */
export function compareTopHits(a: SpotlightHit, b: SpotlightHit): number {
  if (a.score !== b.score) return b.score - a.score
  return KIND_RANK[a.doc.kind] - KIND_RANK[b.doc.kind] || compareSpotlightHits(a, b)
}

export interface SpotlightSection<D extends SpotlightDoc = SpotlightDoc> {
  readonly kind: SpotlightKind
  /** Every match in this section, not just the hits returned. */
  readonly total: number
  readonly hits: readonly SpotlightHit<D>[]
}

export interface SpotlightResult<D extends SpotlightDoc = SpotlightDoc> {
  /** The best match overall; null when nothing scored (a filters-only query). */
  readonly topHit: SpotlightHit<D> | null
  /** Non-empty sections in `SPOTLIGHT_KIND_ORDER`. */
  readonly sections: readonly SpotlightSection<D>[]
}

/** Evaluate every candidate and keep the best `perKind` of each section. */
export function rankSpotlight<D extends SpotlightDoc>(
  query: SpotlightQuery,
  docs: Iterable<PreparedDoc<D>>,
  perKind: number,
): SpotlightResult<D> {
  const kinds = new Set(spotlightKinds(query))
  const byKind = new Map<SpotlightKind, SpotlightHit<D>[]>()
  let topHit: SpotlightHit<D> | null = null
  for (const d of docs) {
    if (!kinds.has(d.doc.kind)) continue
    const score = evaluateSpotlight(query, d)
    if (score === null) continue
    const hit: SpotlightHit<D> = { doc: d.doc, score, sortName: d.sortName }
    let list = byKind.get(d.doc.kind)
    if (!list) byKind.set(d.doc.kind, (list = []))
    list.push(hit)
    if (score > 0 && (!topHit || compareTopHits(hit, topHit) < 0)) topHit = hit
  }
  const sections: SpotlightSection<D>[] = []
  for (const kind of SPOTLIGHT_KIND_ORDER) {
    const list = byKind.get(kind)
    if (!list) continue
    list.sort(compareSpotlightHits)
    sections.push({ kind, total: list.length, hits: list.slice(0, Math.max(0, perKind)) })
  }
  return { topHit, sections }
}

// ── highlighting ──────────────────────────────────────────────────────────────

export type HighlightField = 'name' | 'desc' | 'tech' | 'tag' | 'domain' | 'in' | 'from' | 'to'

function termAppliesTo(term: TextTerm, field: HighlightField, value: string): boolean {
  if (term.field === field) return true
  if (term.field !== 'any') return false
  return field === 'name' || ((field === 'tech' || field === 'tag' || field === 'desc') && value.length >= SHORT_TERM_CHARS)
}

/**
 * Source ranges `[start, end)` of `text` that the query's positive text terms
 * match, merged and sorted. Computed on the folded text and mapped back, so
 * `energie` highlights `Énergie` and every tier highlights identically.
 */
export function spotlightHighlights(query: SpotlightQuery, text: string, field: HighlightField): Array<[number, number]> {
  const values: string[] = []
  for (const group of query.groups) {
    for (const term of group) {
      if (term.type !== 'text' || term.negated) continue
      for (const v of term.values) if (termAppliesTo(term, field, v) && !values.includes(v)) values.push(v)
    }
  }
  if (values.length === 0 || !text) return []
  const folded = foldWithMap(text)
  const ranges: Array<[number, number]> = []
  for (const value of values) {
    const short = value.length < SHORT_TERM_CHARS
    let at = folded.text.indexOf(value)
    while (at >= 0) {
      if (!short || at === 0 || isWordBoundary(folded.text.charCodeAt(at - 1))) {
        ranges.push(sourceRange(folded, at, at + value.length))
      }
      at = folded.text.indexOf(value, at + 1)
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}
