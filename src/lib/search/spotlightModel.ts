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
 * Spotlight: from the model in memory to ranked, grouped rows.
 *
 * The search core (`./spotlight/`) knows nothing about the store; this file
 * turns the resident model into `SpotlightDoc`s, groups the core's ranked
 * sections the way the Spotlight design shows them (a top hit, then groups by
 * relevance), and produces the syntax tips and value suggestions.
 *
 * Coverage: the documents built here are the RESIDENT tier — what the store
 * holds. Under the server-boot contract that is the open window, not the whole
 * model; when the server tier is selected, its answer (`spotlightServer.ts`) is
 * merged in by the core's `mergeSpotlightTiers`, and `spotlightServerRequest`
 * builds what it is asked. The Worker-cache tier (the offline complete copy)
 * is not wired yet.
 */

import type { C4Object, Connection, DecisionRecord, Diagram, Domain, Flow, Group, Tag } from '../../types'
import type { DiagramIndex } from '../../stores/modelStore'
import { technologyNamesOf } from '../technologyUsage'
import { orderedTagIds } from '../tags/assignments'
import type { TagAssignable } from '../tags/assignments'
import { fold, foldWithMap, sourceRange } from './spotlight/fold'
import { isEmptySpotlightQuery, suggestEnumValues } from './spotlight/grammar'
import type { EnumKey, SpotlightKey, SpotlightKind, SpotlightQuery } from './spotlight/grammar'
import {
  compareSpotlightHits,
  matchQuality,
  prepareSpotlightDoc,
  rankSpotlight,
  spotlightHighlights,
  spotlightKinds,
} from './spotlight/evaluate'
import type { PreparedDoc, SpotlightDoc, SpotlightHit, SpotlightResult } from './spotlight/evaluate'
import { spotlightEntityKey } from './spotlight/merge'
import type { SpotlightMergedResult } from './spotlight/merge'
import {
  SPOTLIGHT_PER_KIND_MAX, SPOTLIGHT_QUERY_MAX, SPOTLIGHT_VOCAB_DOMAINS_MAX, SPOTLIGHT_VOCAB_TAGS_MAX, SPOTLIGHT_VOCAB_TEXT_MAX,
} from './spotlight/wire'
import type { SpotlightWireRequest } from './spotlight/wire'

// ── groups and scopes ─────────────────────────────────────────────────────────

export type SpotlightGroupId = 'objects' | 'diagrams' | 'flows' | 'decisions' | 'connections' | 'actions'
export type SpotlightScopeId = 'all' | 'diagrams' | 'objects' | 'decisions' | 'actions'

/** Which result group each kind lands in. */
export const KIND_GROUP: Readonly<Record<SpotlightKind, SpotlightGroupId>> = {
  system: 'objects', app: 'objects', store: 'objects', component: 'objects', actor: 'objects', group: 'objects',
  diagram: 'diagrams', flow: 'flows', adr: 'decisions', connection: 'connections', page: 'actions',
}

/** Group order when two groups are equally relevant. */
export const GROUP_ORDER: readonly SpotlightGroupId[] = ['objects', 'diagrams', 'flows', 'decisions', 'connections', 'actions']

/** The quick filters on the right of the bar, in ⌘1-⌘4 order. */
export const SCOPE_KINDS: Readonly<Record<Exclude<SpotlightScopeId, 'all'>, readonly SpotlightKind[]>> = {
  diagrams: ['diagram'],
  objects: ['system', 'app', 'store', 'component', 'actor', 'group'],
  decisions: ['adr'],
  actions: ['page'],
}
export const SCOPES: readonly Exclude<SpotlightScopeId, 'all'>[] = ['diagrams', 'objects', 'decisions', 'actions']

/** Rows per group in the All scope (the design's `maxPerGroup`). */
export const ROWS_PER_GROUP = 4
/** Rows per group inside a scope, which lists a group in full. */
export const ROWS_PER_SCOPED_GROUP = 50

// ── documents from the store ──────────────────────────────────────────────────

/** What the resident tier reads. A plain object so tests need no store. */
export interface SpotlightSnapshot {
  readonly objects: readonly C4Object[]
  readonly connections: readonly Connection[]
  readonly groups: readonly Group[]
  readonly diagrams: readonly Diagram[]
  readonly flows: readonly Flow[]
  readonly decisionRecords: readonly DecisionRecord[]
  readonly domains: readonly Domain[]
  readonly tags: readonly Tag[]
  readonly index: Pick<DiagramIndex, 'objectToDiagramIds' | 'connectionToDiagramIds' | 'groupToDiagramIds' | 'diagramById' | 'objectById' | 'groupById'>
}

/** An action or page the Spotlight can run, already translated. */
export interface SpotlightActionDoc {
  readonly id: string
  readonly title: string
  readonly keywords: readonly string[]
}

export const OBJECT_KINDS = new Set<SpotlightKind>(['system', 'app', 'store', 'component', 'actor'])

/** `ADR-7` and `ADR-007`: the link resolver writes the first, the detail view
 *  the second. None for a record without a usable number (the server's
 *  `adr_number` is NULL then, and both tiers must agree). */
export function adrLabels(record: Pick<DecisionRecord, 'number'>): string[] {
  const n = record.number
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return []
  return [`ADR-${n}`, `ADR-${String(n).padStart(3, '0')}`]
}

function namesOfDiagrams(ids: ReadonlySet<string> | undefined, snapshot: SpotlightSnapshot): string[] {
  if (!ids) return []
  const names: string[] = []
  for (const id of ids) {
    const d = snapshot.index.diagramById.get(id)
    if (d) names.push(d.name)
  }
  return names
}

function endpointName(id: string, snapshot: SpotlightSnapshot): string {
  return snapshot.index.objectById.get(id)?.name ?? snapshot.index.groupById.get(id)?.name ?? ''
}

/**
 * Every searchable document the store holds, prepared (folded) once per
 * entity. Entities are immutable snapshots, so a prepared document is cached by
 * entity identity until a context it reads (diagram names, domains, tags,
 * placements) changes.
 */
export function buildSpotlightDocs(snapshot: SpotlightSnapshot, actions: readonly SpotlightActionDoc[]): PreparedDoc[] {
  const cache = docCache(snapshot)
  const domainName = new Map(snapshot.domains.map((d) => [d.id, d.name]))
  const tagName = new Map(snapshot.tags.map((t) => [t.tagId, t.value]))
  // Assigned tags only, in their functional order: a stale `tagOrder` entry
  // (left by a concurrent unassign) is not a tag. The server reads the same way.
  const tagsOf = (entity: TagAssignable) =>
    orderedTagIds(entity).map((id) => tagName.get(id)).filter((v): v is string => !!v)
  const out: PreparedDoc[] = []
  const add = (entity: object, build: () => SpotlightDoc) => {
    let prepared = cache.get(entity)
    if (!prepared) {
      prepared = prepareSpotlightDoc(build())
      cache.set(entity, prepared)
    }
    out.push(prepared)
  }

  for (const o of snapshot.objects) {
    add(o, () => ({
      kind: o.type,
      id: o.id,
      name: o.name,
      description: [o.shortDescription, o.description].filter(Boolean).join('\n'),
      tech: technologyNamesOf(o),
      tags: tagsOf(o),
      status: o.status,
      scope: o.scope,
      domain: o.domainId ? domainName.get(o.domainId) : undefined,
      diagrams: namesOfDiagrams(snapshot.index.objectToDiagramIds.get(o.id), snapshot),
    }))
  }
  for (const g of snapshot.groups) {
    add(g, () => ({
      kind: 'group',
      id: g.id,
      name: g.name,
      tech: technologyNamesOf(g),
      diagrams: namesOfDiagrams(snapshot.index.groupToDiagramIds.get(g.id), snapshot),
    }))
  }
  for (const c of snapshot.connections) {
    add(c, () => ({
      kind: 'connection',
      id: c.id,
      name: c.label ?? '',
      description: c.description,
      tech: technologyNamesOf(c),
      tags: tagsOf(c),
      diagrams: namesOfDiagrams(snapshot.index.connectionToDiagramIds.get(c.id), snapshot),
      from: endpointName(c.fromId, snapshot),
      to: endpointName(c.toId, snapshot),
    }))
  }
  for (const d of snapshot.diagrams) {
    add(d, () => ({
      kind: 'diagram',
      id: d.id,
      name: d.name,
      description: d.description,
      domain: d.domainId ? domainName.get(d.domainId) : undefined,
    }))
  }
  for (const f of snapshot.flows) {
    add(f, () => ({
      kind: 'flow',
      id: f.id,
      name: f.name,
      domain: f.domainId ? domainName.get(f.domainId) : undefined,
      diagrams: [snapshot.index.diagramById.get(f.diagramId)?.name ?? ''].filter(Boolean),
    }))
  }
  for (const r of snapshot.decisionRecords) {
    add(r, () => ({
      kind: 'adr',
      id: r.id,
      name: r.title,
      alt: adrLabels(r),
      description: [r.summary, r.content].filter(Boolean).join('\n'),
      status: r.status,
    }))
  }
  // Actions are rebuilt per call (labels follow the language); they are few.
  for (const a of actions) out.push(prepareSpotlightDoc({ kind: 'page', id: a.id, name: a.title, alt: a.keywords }))
  return out
}

let cacheContext: readonly unknown[] = []
let cacheMap = new WeakMap<object, PreparedDoc>()

/** One cache per context: a renamed diagram, domain or tag, or a placement
 *  change, invalidates every prepared document that may have read it. */
function docCache(snapshot: SpotlightSnapshot): WeakMap<object, PreparedDoc> {
  const context = [snapshot.diagrams, snapshot.domains, snapshot.tags, snapshot.index.objectToDiagramIds, snapshot.index.objectById, snapshot.index.groupById]
  if (context.length !== cacheContext.length || context.some((v, i) => v !== cacheContext[i])) {
    cacheContext = context
    cacheMap = new WeakMap()
  }
  return cacheMap
}

// ── ranking and grouping ──────────────────────────────────────────────────────

export interface SpotlightGroupView {
  readonly id: SpotlightGroupId
  readonly hits: readonly SpotlightHit[]
  /** Every match in the group, including rows not shown. */
  readonly total: number
  /** `total` is a lower bound (the server stopped counting). */
  readonly totalCapped: boolean
}

export interface SpotlightView {
  readonly topHit: SpotlightHit | null
  readonly groups: readonly SpotlightGroupView[]
}

/** Hits asked of each section: one more than the rows a group shows, because
 *  the top hit leaves its group. The server tier is asked for the same number. */
export function perKindFor(scope: SpotlightScopeId): number {
  return scope === 'all' ? ROWS_PER_GROUP + 1 : ROWS_PER_SCOPED_GROUP + 1
}

/** Restrict a ranking to one scope, then rank. */
export function rankForScope(query: SpotlightQuery, docs: readonly PreparedDoc[], scope: SpotlightScopeId): SpotlightResult {
  const kinds = scope === 'all' ? null : new Set(SCOPE_KINDS[scope])
  const pool = kinds ? docs.filter((d) => kinds.has(d.doc.kind)) : docs
  return rankSpotlight(query, pool, perKindFor(scope))
}

/**
 * The query both tiers rank for what is typed, or null when the field shows no
 * results (empty in the All scope, `?`, or nothing but a pending key). An empty
 * field inside a scope lists that scope, in name order.
 */
export function spotlightSearchSource(typed: string, parsed: SpotlightQuery, scope: SpotlightScopeId): string | null {
  const trimmed = typed.trim()
  if (trimmed === '?') return null
  if (!trimmed) return scope === 'all' ? null : `kind:${SCOPE_KINDS[scope].join(',')}`
  return isEmptySpotlightQuery(parsed) ? null : typed
}

/** Every entity the resident documents hold, by `spotlightEntityKey`. */
export function residentDocsByKey(docs: readonly PreparedDoc[]): Map<string, PreparedDoc> {
  const byKey = new Map<string, PreparedDoc>()
  for (const d of docs) if (d.doc.kind !== 'page') byKey.set(spotlightEntityKey(d.doc.kind, d.doc.id), d)
  return byKey
}

/**
 * The server tier's request for `source` in `scope`, or null when the server
 * cannot add anything: no server-side kind can match (an Actions scope, a
 * `kind:page` query), the query is longer than the server reads, or the
 * vocabulary is larger than a request may carry (then `tag:` / `domain:` would
 * resolve differently on the two tiers). A name longer than the limit is cut,
 * which only changes matches past its 256th character.
 */
export function spotlightServerRequest(
  source: string,
  query: SpotlightQuery,
  scope: SpotlightScopeId,
  vocab: Pick<SpotlightSnapshot, 'domains' | 'tags'>,
): SpotlightWireRequest | null {
  if (source.length > SPOTLIGHT_QUERY_MAX) return null
  const inScope = scope === 'all' ? null : new Set(SCOPE_KINDS[scope])
  const kinds = spotlightKinds(query).filter((k) => k !== 'page' && (!inScope || inScope.has(k)))
  if (kinds.length === 0) return null
  if (vocab.domains.length > SPOTLIGHT_VOCAB_DOMAINS_MAX || vocab.tags.length > SPOTLIGHT_VOCAB_TAGS_MAX) return null
  const pairs = (entries: ReadonlyArray<readonly [string, string]>): Array<[string, string]> => entries
    .filter(([id, name]) => id.length <= SPOTLIGHT_VOCAB_TEXT_MAX && typeof name === 'string')
    .map(([id, name]) => [id, name.slice(0, SPOTLIGHT_VOCAB_TEXT_MAX)])
  return {
    q: source,
    ...(inScope ? { kinds } : {}),
    perKind: Math.min(perKindFor(scope), SPOTLIGHT_PER_KIND_MAX),
    vocab: {
      domains: pairs(vocab.domains.map((d) => [d.id, d.name] as const)),
      tags: pairs(vocab.tags.map((t) => [t.tagId, t.value] as const)),
    },
  }
}

/** A short digest of the vocabulary a request carries (FNV-1a over ids and
 *  names), so a renamed tag or domain changes a request's key without the key
 *  holding the whole vocabulary. */
export function spotlightVocabFingerprint(vocab: Pick<SpotlightSnapshot, 'domains' | 'tags'>): string {
  let h = 0x811c9dc5
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
    h = Math.imul(h ^ 0x1f, 0x01000193)
  }
  for (const d of vocab.domains) { mix(d.id); mix(d.name) }
  mix('|')
  for (const t of vocab.tags) { mix(t.tagId); mix(t.value) }
  return `${vocab.domains.length}.${vocab.tags.length}.${(h >>> 0).toString(36)}`
}

/** A tier's ranking as `groupSpotlightResult` reads it: the resident one, or
 *  one merged with the server's (`mergeSpotlightTiers`). */
export type RankedSpotlight = SpotlightResult | SpotlightMergedResult<SpotlightDoc>

/**
 * The design's layout: the top hit on its own, then groups ordered by their
 * best remaining match (ties in `GROUP_ORDER`), each capped. The top hit is not
 * repeated inside its group.
 */
export function groupSpotlightResult(result: RankedSpotlight, scope: SpotlightScopeId): SpotlightView {
  const cap = scope === 'all' ? ROWS_PER_GROUP : ROWS_PER_SCOPED_GROUP
  const top = result.topHit
  const byGroup = new Map<SpotlightGroupId, { hits: SpotlightHit[]; total: number; capped: boolean }>()
  for (const section of result.sections) {
    const id = KIND_GROUP[section.kind]
    let entry = byGroup.get(id)
    if (!entry) byGroup.set(id, (entry = { hits: [], total: 0, capped: false }))
    let total = section.total
    for (const hit of section.hits) {
      if (top && hit.doc.kind === top.doc.kind && hit.doc.id === top.doc.id) { total -= 1; continue }
      entry.hits.push(hit)
    }
    entry.total += total
    if ('totalCapped' in section && section.totalCapped) entry.capped = true
  }
  const groups: SpotlightGroupView[] = []
  for (const [id, entry] of byGroup) {
    if (entry.hits.length === 0) continue
    entry.hits.sort(compareSpotlightHits)
    groups.push({ id, hits: entry.hits.slice(0, cap), total: entry.total, totalCapped: entry.capped })
  }
  groups.sort((a, b) => b.hits[0].score - a.hits[0].score || GROUP_ORDER.indexOf(a.id) - GROUP_ORDER.indexOf(b.id))
  return { topHit: top, groups }
}

/** The part of `completion` still to type after `typed`, or null when `typed`
 *  is not its prefix: the Spotlight's ghost text. Accent- and case-insensitive
 *  (`energ` completes `Énergie tarifs` with `ie tarifs`), as the search is. A
 *  trailing space folds away, so that case only matches the plain way. */
export function completionRest(completion: string, typed: string): string | null {
  if (completion.length > typed.length && completion.toLowerCase().startsWith(typed.toLowerCase())) {
    return completion.slice(typed.length)
  }
  if (!typed || /\s$/.test(typed)) return null
  const want = fold(typed)
  const folded = foldWithMap(completion)
  if (!want || want.length >= folded.text.length || !folded.text.startsWith(want)) return null
  return completion.slice(sourceRange(folded, 0, want.length)[1])
}

/** Where to highlight a row's title. */
export function titleHighlights(query: SpotlightQuery, title: string): Array<[number, number]> {
  return spotlightHighlights(query, title, 'name')
}

// ── tips and suggestions ──────────────────────────────────────────────────────

/** A syntax tip shown on an empty field. `insert` is what choosing it types. */
export interface SpotlightTip {
  readonly id: string
  readonly example: string
  readonly insert: string
}

export const SPOTLIGHT_TIPS: readonly SpotlightTip[] = [
  { id: 'kind', example: 'kind:system', insert: 'kind:' },
  { id: 'tag', example: 'tag:payments', insert: 'tag:' },
  { id: 'tech', example: 'tech:postgres', insert: 'tech:' },
  { id: 'in', example: 'in:"Checkout"', insert: 'in:"' },
  { id: 'status', example: 'status:live', insert: 'status:' },
  { id: 'phrase', example: '"order service"', insert: '"' },
  { id: 'exclude', example: '-legacy', insert: '-' },
  { id: 'or', example: 'billing OR invoicing', insert: '' },
  { id: 'has', example: 'has:description', insert: 'has:' },
  { id: 'from', example: 'from:"Web app"', insert: 'from:"' },
]

/** A completion for the value being typed after `key:`. */
export interface SpotlightSuggestion {
  readonly key: SpotlightKey
  readonly value: string
  /** The whole new query when it is chosen. */
  readonly insert: string
}

const ENUM_KEYS = new Set<SpotlightKey>(['kind', 'status', 'scope', 'has'])
const MAX_SUGGESTIONS = 6

/** The value typed so far after the pending key, and where it starts. A quoted
 *  value is one value; an unquoted comma list completes its last element. */
function pendingValue(query: SpotlightQuery): { start: number; partial: string } | null {
  if (!query.pendingKey) return null
  const key = [...query.tokens].reverse().find((t) => t.type === 'key')
  if (!key) return null
  const rest = query.source.slice(key.end)
  if (rest.startsWith('"')) return { start: key.end, partial: rest.slice(1) }
  const comma = rest.lastIndexOf(',')
  return comma >= 0 ? { start: key.end + comma + 1, partial: rest.slice(comma + 1) } : { start: key.end, partial: rest }
}

function quoteIfNeeded(value: string): string {
  return /[\s,"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value
}

/**
 * Values for the filter being typed (`tag:pay` suggests `payments`). Enum keys
 * offer their vocabulary; text keys offer names the store holds; `name:` and
 * `desc:` take free text and offer nothing.
 */
export function spotlightSuggestions(query: SpotlightQuery, snapshot: SpotlightSnapshot): SpotlightSuggestion[] {
  const pending = pendingValue(query)
  const key = query.pendingKey
  if (!pending || !key) return []
  const p = fold(pending.partial)
  let values: string[]
  if (ENUM_KEYS.has(key)) {
    values = suggestEnumValues(key as EnumKey, pending.partial)
  } else {
    const pool = candidateValues(key, snapshot)
    // The same matching rules as the search itself (a short value matches word starts only).
    values = p.length === 0 ? pool : pool.filter((v) => matchQuality(fold(v), p) > 0)
  }
  // A value typed in full needs no completion.
  values = values.filter((v) => fold(v) !== p)
  const head = query.source.slice(0, pending.start)
  return values.slice(0, MAX_SUGGESTIONS).map((value) => ({ key, value, insert: `${head}${quoteIfNeeded(value)} ` }))
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((v) => v.trim().length > 0))].sort((a, b) => a.localeCompare(b))
}

function candidateValues(key: SpotlightKey, snapshot: SpotlightSnapshot): string[] {
  switch (key) {
    case 'tag': return uniqueSorted(snapshot.tags.map((t) => t.value))
    case 'tech': {
      const names: string[] = []
      for (const o of snapshot.objects) names.push(...technologyNamesOf(o))
      for (const c of snapshot.connections) names.push(...technologyNamesOf(c))
      return uniqueSorted(names)
    }
    case 'domain': return uniqueSorted(snapshot.domains.map((d) => d.name))
    case 'in': return uniqueSorted(snapshot.diagrams.map((d) => d.name))
    case 'from':
    case 'to': return uniqueSorted([...snapshot.objects.map((o) => o.name), ...snapshot.groups.map((g) => g.name)])
    default: return []
  }
}
