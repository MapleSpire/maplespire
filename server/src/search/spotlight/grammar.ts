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
 * Spotlight search core: the query language.
 *
 * THIS FILE EXISTS TWICE, byte for byte: `src/lib/search/spotlight/` (the ruling
 * copy) and `server/src/search/spotlight/` (the server's mirror). Edit the
 * `src/` copy, then run `node scripts/sync-spotlight-core.mjs`;
 * `spotlight.conformance.test.ts` fails on any byte difference. See `fold.ts`
 * for why there are two copies and what both tsconfigs require.
 *
 * Grammar (v1):
 *
 *   query  := clause (WS clause)*
 *   clause := 'OR' | 'AND' | 'NOT' | ['-'] (key ':' value | '"' phrase '"' | word)
 *   value  := '"' phrase '"' | text (',' text)*
 *
 * Clauses are ANDed. `OR` joins the clauses on either side of it into one
 * group; `NOT` (or a leading `-`) negates the next clause; `AND` is accepted and
 * changes nothing. A comma-separated value is an OR within one filter
 * (`kind:system,app`). There are no parentheses.
 *
 * A key the grammar does not know is searched as plain text (so `http://host`
 * still works) and, when it looks like a mistyped key, produces a warning the
 * UI turns into a tip.
 */

import { fold } from './fold.js'

/** What a result is. The five C4 object types, then the other searchable kinds. */
export type SpotlightKind =
  | 'system'
  | 'app'
  | 'store'
  | 'component'
  | 'actor'
  | 'group'
  | 'diagram'
  | 'flow'
  | 'adr'
  | 'connection'
  | 'page'

/** Fixed section order. The top hit's tie-break and every tier's section list
 *  use it, so results do not reorder when a faster tier hands over to the server. */
export const SPOTLIGHT_KIND_ORDER: readonly SpotlightKind[] = [
  'system', 'app', 'store', 'component', 'actor', 'group', 'diagram', 'flow', 'adr', 'connection', 'page',
]

export const C4_OBJECT_KINDS: readonly SpotlightKind[] = ['system', 'app', 'store', 'component', 'actor']

/** Free-text fields a term can be scoped to. `any` is the unscoped default. */
export type TextField = 'any' | 'name' | 'desc' | 'tech' | 'tag' | 'domain' | 'in' | 'from' | 'to'
/** Filters over a closed vocabulary. */
export type EnumKey = 'kind' | 'status' | 'scope' | 'has'
export type SpotlightKey = Exclude<TextField, 'any'> | EnumKey

export interface TextTerm {
  readonly type: 'text'
  readonly field: TextField
  /** Folded; the term matches when ANY of them does. Never empty. */
  readonly values: readonly string[]
  readonly negated: boolean
  /** Written in double quotes. Matching is the same; the UI reads it. */
  readonly phrase: boolean
}

export interface EnumTerm {
  readonly type: 'enum'
  readonly key: EnumKey
  /** Canonical values; the term matches when ANY of them does. Never empty. */
  readonly values: readonly string[]
  readonly negated: boolean
}

export type SpotlightTerm = TextTerm | EnumTerm

export type SpotlightTokenType = 'text' | 'phrase' | 'key' | 'value' | 'operator' | 'negation' | 'invalid'

/** A span of the source string, for colouring the input. */
export interface SpotlightToken {
  readonly type: SpotlightTokenType
  readonly start: number
  readonly end: number
}

export type SpotlightWarning =
  | { readonly code: 'unknownKey'; readonly key: string; readonly suggestion?: SpotlightKey; readonly start: number; readonly end: number }
  | { readonly code: 'unknownValue'; readonly key: EnumKey; readonly value: string; readonly expected: readonly string[]; readonly start: number; readonly end: number }

export interface SpotlightQuery {
  readonly source: string
  /** AND of groups; each group is an OR of terms. Empty when nothing searchable was typed. */
  readonly groups: readonly (readonly SpotlightTerm[])[]
  readonly tokens: readonly SpotlightToken[]
  readonly warnings: readonly SpotlightWarning[]
  /** The key whose value the caret is completing (`tag:` with nothing after
   *  it yet, or `kind:sy` at the end of the input): the UI suggests values. */
  readonly pendingKey: SpotlightKey | null
}

// ── vocabulary ────────────────────────────────────────────────────────────────

/** Every spelling of a key, folded (accents dropped, lowercase), FR and EN. */
export const SPOTLIGHT_KEY_ALIASES: Readonly<Record<string, SpotlightKey>> = {
  kind: 'kind', is: 'kind', type: 'kind', genre: 'kind', est: 'kind',
  name: 'name', title: 'name', nom: 'name', titre: 'name',
  desc: 'desc', description: 'desc',
  tech: 'tech', technology: 'tech', techno: 'tech', technologie: 'tech',
  tag: 'tag', tags: 'tag', etiquette: 'tag',
  status: 'status', statut: 'status',
  scope: 'scope', portee: 'scope',
  domain: 'domain', domaine: 'domain',
  in: 'in', dans: 'in',
  has: 'has', avec: 'has',
  from: 'from', de: 'from',
  to: 'to', vers: 'to',
}

const ENUM_KEYS: ReadonlySet<SpotlightKey> = new Set<SpotlightKey>(['kind', 'status', 'scope', 'has'])

/** Canonical value -> its folded spellings. `object` is a shorthand that
 *  expands to the five C4 object kinds. */
export const SPOTLIGHT_ENUM_VALUES: Readonly<Record<EnumKey, Readonly<Record<string, readonly string[]>>>> = {
  kind: {
    system: ['system', 'systems', 'systeme', 'systemes'],
    app: ['app', 'apps', 'application', 'applications', 'container', 'containers', 'conteneur', 'conteneurs'],
    store: ['store', 'stores', 'database', 'databases', 'db', 'datastore', 'stockage', 'bdd'],
    component: ['component', 'components', 'composant', 'composants'],
    actor: ['actor', 'actors', 'person', 'people', 'user', 'users', 'acteur', 'acteurs', 'personne', 'personnes', 'utilisateur'],
    object: ['object', 'objects', 'objet', 'objets', 'shape', 'shapes', 'forme', 'formes'],
    group: ['group', 'groups', 'groupe', 'groupes', 'boundary'],
    diagram: ['diagram', 'diagrams', 'diagramme', 'diagrammes', 'view', 'views', 'vue', 'vues'],
    flow: ['flow', 'flows', 'flux', 'scenario', 'scenarios'],
    adr: ['adr', 'adrs', 'decision', 'decisions', 'record', 'records'],
    connection: ['connection', 'connections', 'link', 'links', 'relationship', 'relationships', 'lien', 'liens', 'relation', 'relations'],
    page: ['page', 'pages', 'action', 'actions', 'command', 'commands', 'commande', 'commandes'],
  },
  status: {
    live: ['live', 'active', 'actif', 'production'],
    draft: ['draft', 'planned', 'brouillon', 'prevu'],
    down: ['down', 'offline', 'panne', 'hors-service'],
    unstable: ['unstable', 'degraded', 'instable', 'degrade'],
    'in-progress': ['in-progress', 'inprogress', 'progress', 'wip', 'proposed', 'en-cours', 'propose'],
    approved: ['approved', 'accepted', 'approuve', 'accepte'],
    rejected: ['rejected', 'declined', 'rejete', 'refuse'],
  },
  scope: {
    internal: ['internal', 'interne'],
    external: ['external', 'externe'],
  },
  has: {
    description: ['description', 'desc'],
    diagram: ['diagram', 'diagrams', 'diagramme', 'diagrammes'],
    tech: ['tech', 'technology', 'technologies', 'techno', 'technologie'],
    tag: ['tag', 'tags', 'etiquette', 'etiquettes'],
  },
}

// ── parser ────────────────────────────────────────────────────────────────────

interface Clause {
  readonly term: SpotlightTerm | null
  /** An OR/AND/NOT keyword rather than a term. */
  readonly operator: 'OR' | 'AND' | 'NOT' | null
}

/** Parse a Spotlight query. Never throws: anything it cannot read becomes plain text. */
export function parseSpotlightQuery(source: string): SpotlightQuery {
  const tokens: SpotlightToken[] = []
  const warnings: SpotlightWarning[] = []
  const clauses: Clause[] = []
  let pendingKey: SpotlightKey | null = null
  let i = 0
  const n = source.length

  while (i < n) {
    if (isSpace(source, i)) { i++; continue }
    let negated = false
    if (source[i] === '-' && i + 1 < n && !isSpace(source, i + 1)) {
      negated = true
      tokens.push({ type: 'negation', start: i, end: i + 1 })
      i++
    }

    if (source[i] === '"') {
      const { text, end } = readQuoted(source, i)
      tokens.push({ type: 'phrase', start: i, end })
      i = end
      const value = fold(text)
      clauses.push({ term: value ? { type: 'text', field: 'any', values: [value], negated, phrase: true } : null, operator: null })
      continue
    }

    // A bare word ends at whitespace or at a quote that is not a key's value.
    let end = i
    while (end < n && !isSpace(source, end) && source[end] !== '"') end++
    const word = source.slice(i, end)

    if (!negated && (word === 'OR' || word === 'AND' || word === 'NOT')) {
      tokens.push({ type: 'operator', start: i, end })
      clauses.push({ term: null, operator: word })
      i = end
      continue
    }

    const colon = word.indexOf(':')
    const key = colon > 0 ? SPOTLIGHT_KEY_ALIASES[fold(word.slice(0, colon))] : undefined
    if (colon > 0 && key) {
      tokens.push({ type: 'key', start: i, end: i + colon + 1 })
      const valueStart = i + colon + 1
      let valueText: string
      let valueEnd = end
      let quoted = false
      let closed = false
      if (valueEnd === valueStart && source[valueEnd] === '"') {
        const q = readQuoted(source, valueEnd)
        valueText = q.text
        valueEnd = q.end
        quoted = true
        closed = q.closed
      } else {
        valueText = source.slice(valueStart, valueEnd)
      }
      if (valueEnd > valueStart) tokens.push({ type: 'value', start: valueStart, end: valueEnd })
      // The value is still being typed when it runs to the end of the input
      // (the caret's place while typing) and is not a closed quote.
      pendingKey = valueEnd >= n && !closed ? key : null
      i = valueEnd
      const parts = quoted ? [valueText] : valueText.split(',')
      if (ENUM_KEYS.has(key)) {
        const enumKey = key as EnumKey
        const values: string[] = []
        let partStart = quoted ? valueStart + 1 : valueStart
        for (const part of parts) {
          const raw = part.trim()
          const partEnd = partStart + part.length
          if (raw) {
            const resolved = resolveEnumValue(enumKey, raw)
            if (resolved.length > 0) {
              for (const v of resolved) if (!values.includes(v)) values.push(v)
            } else if (!(pendingKey && partEnd >= valueEnd)) {
              // An unresolved value still being typed at the caret is not a mistake yet.
              warnings.push({
                code: 'unknownValue', key: enumKey, value: raw,
                expected: Object.keys(SPOTLIGHT_ENUM_VALUES[enumKey]),
                start: partStart, end: partEnd,
              })
            }
          }
          partStart = partEnd + 1
        }
        clauses.push({ term: values.length ? { type: 'enum', key: enumKey, values, negated } : null, operator: null })
      } else {
        const values = parts.map((p) => fold(p)).filter((v) => v.length > 0)
        clauses.push({
          term: values.length ? { type: 'text', field: key as TextField, values: dedupe(values), negated, phrase: quoted } : null,
          operator: null,
        })
      }
      continue
    }

    // Plain text, possibly an unknown `key:value`. A lone `-` searches nothing.
    if (word === '-') {
      tokens.push({ type: 'invalid', start: i, end })
      i = end
      continue
    }
    if (colon > 1) {
      const rawKey = word.slice(0, colon)
      // `http://host` and `10:30` are text, not mistyped keys.
      const looksLikeKey = /^\p{L}+$/u.test(rawKey) && !word.slice(colon + 1).startsWith('/')
      if (looksLikeKey) {
        const suggestion = suggestKey(fold(rawKey))
        warnings.push({ code: 'unknownKey', key: rawKey, ...(suggestion ? { suggestion } : {}), start: i, end: i + colon })
      }
    }
    tokens.push({ type: 'text', start: i, end })
    i = end
    const value = fold(word)
    clauses.push({ term: value ? { type: 'text', field: 'any', values: [value], negated, phrase: false } : null, operator: null })
  }

  return { source, groups: groupClauses(clauses), tokens, warnings, pendingKey }
}

/** True when the query has nothing to match on. */
export function isEmptySpotlightQuery(query: SpotlightQuery): boolean {
  return query.groups.length === 0
}

/** Values of an enum key that start with `prefix` (folded), canonical names
 *  first, for the value suggestions shown while a filter is typed. */
export function suggestEnumValues(key: EnumKey, prefix: string): string[] {
  const p = fold(prefix)
  const out: string[] = []
  for (const [canonical, spellings] of Object.entries(SPOTLIGHT_ENUM_VALUES[key])) {
    if (spellings.some((s) => s.startsWith(p))) out.push(canonical)
  }
  return out
}

function groupClauses(clauses: readonly Clause[]): SpotlightTerm[][] {
  const groups: SpotlightTerm[][] = []
  let joinNext = false
  let negateNext = false
  for (const clause of clauses) {
    if (clause.operator === 'OR') { joinNext = groups.length > 0; continue }
    if (clause.operator === 'NOT') { negateNext = true; continue }
    if (clause.operator === 'AND' || !clause.term) {
      // A dropped term (an empty value) still ends a pending NOT/OR.
      if (!clause.operator) { negateNext = false; joinNext = false }
      continue
    }
    const term = negateNext ? { ...clause.term, negated: !clause.term.negated } : clause.term
    negateNext = false
    if (joinNext) groups[groups.length - 1].push(term)
    else groups.push([term])
    joinNext = false
  }
  return groups
}

/** Resolve a typed enum value: an exact spelling wins; otherwise a prefix that
 *  names exactly one canonical value (`kind:sys`). `object` expands to the five
 *  C4 kinds. Returns [] when nothing (or more than one thing) matches. */
function resolveEnumValue(key: EnumKey, raw: string): string[] {
  const v = fold(raw)
  const table = SPOTLIGHT_ENUM_VALUES[key]
  let found: string | null = null
  for (const [canonical, spellings] of Object.entries(table)) {
    if (spellings.includes(v)) { found = canonical; break }
  }
  if (!found && v.length >= 2) {
    const candidates = Object.entries(table).filter(([, spellings]) => spellings.some((s) => s.startsWith(v)))
    if (candidates.length === 1) found = candidates[0][0]
  }
  if (!found) return []
  if (key === 'kind' && found === 'object') return [...C4_OBJECT_KINDS]
  return [found]
}

/** The known key closest to a mistyped one (edit distance at most 2). */
function suggestKey(typed: string): SpotlightKey | undefined {
  if (typed.length < 2) return undefined
  let best: SpotlightKey | undefined
  let bestDistance = 3
  for (const [alias, key] of Object.entries(SPOTLIGHT_KEY_ALIASES)) {
    const d = editDistance(typed, alias, bestDistance)
    if (d < bestDistance) { bestDistance = d; best = key }
  }
  return best
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      row.push(d)
      if (d < rowMin) rowMin = d
    }
    if (rowMin >= cap) return cap
    prev = row
  }
  return prev[b.length]
}

function readQuoted(source: string, open: number): { text: string; end: number; closed: boolean } {
  const close = source.indexOf('"', open + 1)
  if (close < 0) return { text: source.slice(open + 1), end: source.length, closed: false }
  return { text: source.slice(open + 1, close), end: close + 1, closed: true }
}

function isSpace(source: string, i: number): boolean {
  const c = source.charCodeAt(i)
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xa0 || c === 0x3000
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
