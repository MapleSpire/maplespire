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
 * Spotlight search core: merging the resident and server tiers.
 *
 * THIS FILE EXISTS TWICE, byte for byte: `src/lib/search/spotlight/` (the ruling
 * copy) and `server/src/search/spotlight/` (the server's mirror). Edit the
 * `src/` copy, then run `node scripts/sync-spotlight-core.mjs`;
 * `spotlight.conformance.test.ts` fails on any byte difference. See `fold.ts`.
 *
 * The resident tier (what the store holds) answers at once; the server tier
 * answers later, for the WHOLE workspace as the read model last projected it.
 * `mergeSpotlightTiers` combines the two WITHOUT ranking a server document
 * again: its score is the server's, its place comes from the core's order
 * (`compareSpotlightHits`). Re-evaluating it would be wrong, not just slower:
 * the server trims long descriptions for the wire.
 *
 * Which kinds the server decides (`serverCoverage`):
 *  - none: pages (client-only), a kind in `coverage.unavailableKinds`, a kind
 *    whose missing field (`coverage.fieldGaps`) the query reads NEGATIVELY —
 *    the server would let through what the field would exclude — and a kind
 *    the store holds every entity of (`completeKinds`), unless the query reads
 *    context (below): the store then knows every entity but not every
 *    placement, so the server rules on the context of the entities the store
 *    holds, and its other hits for that kind are stale (deleted, say);
 *  - partial: the query reads a missing field positively. Every server hit is
 *    still a real match (it matched on the fields the server has), but some
 *    are missing and scores can be low: the count is a lower bound;
 *  - full: everything else.
 *
 * Per entity, in a kind the server decides:
 *  - not held by the store: the server's hit, unless this tab deleted the
 *    entity and the projection has not caught up (`deleted`);
 *  - held: the resident copy decides — it is among the resident hits or it
 *    does not match — because it is the copy this tab shows (canvas,
 *    inspector) and it carries this tab's edits before the projection does.
 *    (The other direction exists too: a remote edit can reach the projection
 *    before this tab's store; for that sync delay the result follows the older
 *    resident copy, as the rest of the tab does.)
 *
 * The exception is a query that reads OTHER entities: `in:`, `from:`, `to:`,
 * `has:diagram` read the diagrams placing an entity and its endpoints' names,
 * which the store knows only as far as it holds them — under the server-boot
 * contract, the open window. So for a held entity:
 *  - its own fields must still match (the query without its context groups),
 *    and then the server's verdict on the context counts: a server hit is
 *    shown, as the tab shows the entity (its kind, its name);
 *  - under a NEGATED context term, a resident hit the server did not return
 *    is dropped: the store cannot see the diagram or endpoint that excludes it.
 *    Cost, accepted: an entity created or edited into the match in this tab is
 *    missing from such a query for the projection's delay, and so is one the
 *    server ranked past its `perKind` cut (it would rank there in the merged
 *    list too, unless an unprojected edit raised its score). Not done for a
 *    partial kind, whose server answer is itself incomplete.
 *
 * Totals: a merged section counts at least what either tier counted (the
 * tiers overlap, so their sum would double count), and is a lower bound when
 * the server's candidate cap was hit or the kind is partial (`totalCapped`).
 */

import { fold } from './fold.js'
import { C4_OBJECT_KINDS, SPOTLIGHT_KIND_ORDER } from './grammar.js'
import type { SpotlightKind, SpotlightQuery, SpotlightTerm } from './grammar.js'
import { SHORT_TERM_CHARS, SPOTLIGHT_KIND_FIELDS, compareSpotlightHits, compareTopHits, evaluateSpotlight } from './evaluate.js'
import type { DocField, PreparedDoc, SpotlightDoc, SpotlightHit, SpotlightResult, SpotlightSection } from './evaluate.js'
import type { SpotlightCoverage, SpotlightWireDoc, SpotlightWireSection } from './wire.js'

/** Where a merged section's rows come from. */
export type SpotlightSectionSource = 'resident' | 'merged'

export interface SpotlightMergedSection<D extends SpotlightDoc = SpotlightDoc> extends SpotlightSection<D> {
  /** `total` is a lower bound: the server stopped counting, or misses a field. */
  readonly totalCapped: boolean
  readonly source: SpotlightSectionSource
}

export interface SpotlightMergedResult<D extends SpotlightDoc = SpotlightDoc> {
  readonly topHit: SpotlightHit<D> | null
  readonly sections: readonly SpotlightMergedSection<D>[]
}

/** What the merge reads from a server answer. */
export interface SpotlightServerTier {
  readonly sections: readonly SpotlightWireSection[]
  readonly coverage: SpotlightCoverage
}

/** What the merge reads from the store. */
export interface SpotlightResidentTier<R extends SpotlightDoc> {
  /** `rankSpotlight` over the store's documents: the same query, scope and
   *  `perKind` the server was asked for. */
  readonly result: SpotlightResult<R>
  /** The store's prepared document for a `spotlightEntityKey`, matching or not. */
  readonly doc: (entityKey: string) => PreparedDoc<R> | undefined
  /** True for an entity this tab deleted, which the projection may still list. */
  readonly deleted: (kind: SpotlightKind, id: string) => boolean
  /** Kinds whose every entity the store holds. */
  readonly completeKinds?: ReadonlySet<SpotlightKind>
}

export type SpotlightServerCoverage = 'full' | 'partial'

const OBJECT_KINDS: ReadonlySet<SpotlightKind> = new Set(C4_OBJECT_KINDS)

/** One key per entity across tiers. The five C4 object kinds share one id
 *  space (an object can change kind), so they share one key. */
export function spotlightEntityKey(kind: SpotlightKind, id: string): string {
  return `${OBJECT_KINDS.has(kind) ? 'object' : kind}:${id}`
}

/** The fields one term reads, as the evaluator reads them: an unscoped term
 *  reads names, and also technology, tags and descriptions once it is long
 *  enough. */
function termFields(term: SpotlightTerm): DocField[] {
  if (term.type === 'text') {
    if (term.field !== 'any') return [term.field]
    return term.values.some((v) => v.length >= SHORT_TERM_CHARS) ? ['name', 'tech', 'tag', 'desc'] : ['name']
  }
  switch (term.key) {
    case 'kind': return []
    case 'status': return ['status']
    case 'scope': return ['scope']
    case 'has': return term.values.map((v): DocField => (v === 'description' ? 'desc' : v === 'diagram' ? 'in' : v === 'tech' ? 'tech' : 'tag'))
  }
}

/** Every field a query reads (`read`), and those read by a negated term. */
export function spotlightFieldReads(query: SpotlightQuery): { read: Set<DocField>; negated: Set<DocField> } {
  const read = new Set<DocField>()
  const negated = new Set<DocField>()
  for (const group of query.groups) {
    for (const term of group) {
      for (const f of termFields(term)) {
        read.add(f)
        if (term.negated) negated.add(f)
      }
    }
  }
  return { read, negated }
}

/** Every field a query reads. */
export function spotlightFieldsRead(query: SpotlightQuery): Set<DocField> {
  return spotlightFieldReads(query).read
}

/** Fields whose value comes from OTHER entities than the one matched. */
const CONTEXT_FIELDS: readonly DocField[] = ['in', 'from', 'to']
const readsContext = (term: SpotlightTerm) => termFields(term).some((f) => CONTEXT_FIELDS.includes(f))

/** How far a server answer with `coverage` decides each kind for `query`;
 *  absent kinds are the store's alone. */
export function serverCoverage(
  query: SpotlightQuery,
  coverage: SpotlightCoverage,
  completeKinds: ReadonlySet<SpotlightKind> = new Set(),
): Map<SpotlightKind, SpotlightServerCoverage> {
  const { read, negated } = spotlightFieldReads(query)
  const contextual = CONTEXT_FIELDS.some((f) => read.has(f))
  const served = new Map<SpotlightKind, SpotlightServerCoverage>()
  for (const kind of SPOTLIGHT_KIND_ORDER) {
    if (kind === 'page' || coverage.unavailableKinds.includes(kind) || (completeKinds.has(kind) && !contextual)) continue
    const gaps = (coverage.fieldGaps[kind] ?? []).filter((f) => SPOTLIGHT_KIND_FIELDS[kind].includes(f))
    if (gaps.some((f) => negated.has(f))) continue
    served.set(kind, gaps.some((f) => read.has(f)) ? 'partial' : 'full')
  }
  return served
}

/**
 * Merge a server answer into the resident ranking of the same query and scope.
 * See the module header for the rules.
 */
export function mergeSpotlightTiers<R extends SpotlightDoc>(
  query: SpotlightQuery,
  resident: SpotlightResidentTier<R>,
  server: SpotlightServerTier,
  perKind: number,
): SpotlightMergedResult<R | SpotlightWireDoc> {
  type Hit = SpotlightHit<R | SpotlightWireDoc>
  const served = serverCoverage(query, server.coverage, resident.completeKinds)
  const { read, negated } = spotlightFieldReads(query)
  const contextual = CONTEXT_FIELDS.some((f) => read.has(f))
  const negatedContext = CONTEXT_FIELDS.some((f) => negated.has(f))
  // The query without the groups that read context: what a held entity's own
  // fields must still satisfy. A dropped group counts as satisfied.
  const own: SpotlightQuery = { ...query, groups: query.groups.filter((g) => !g.some(readsContext)) }
  const ownMatch = (d: PreparedDoc<R>) => own.groups.length === 0 || evaluateSpotlight(own, d) !== null
  const returned = new Set<string>()
  for (const s of server.sections) for (const h of s.hits) returned.add(spotlightEntityKey(h.doc.kind, h.doc.id))

  const byKind = new Map<SpotlightKind, Hit[]>()
  const listed = new Set<string>()
  const add = (key: string, hit: Hit) => {
    listed.add(key)
    let list = byKind.get(hit.doc.kind)
    if (!list) byKind.set(hit.doc.kind, (list = []))
    list.push(hit)
  }

  for (const s of resident.result.sections) {
    for (const h of s.hits) {
      const key = spotlightEntityKey(h.doc.kind, h.doc.id)
      if (negatedContext && served.get(s.kind) === 'full' && !returned.has(key)) continue
      add(key, h)
    }
  }
  for (const s of server.sections) {
    if (!served.has(s.kind)) continue
    for (const h of s.hits) {
      const key = spotlightEntityKey(h.doc.kind, h.doc.id)
      if (listed.has(key) || resident.deleted(h.doc.kind, h.doc.id)) continue
      const mine = resident.doc(key)
      if (!mine) {
        // The store holds every entity of a complete kind: one it lacks is stale.
        if (!resident.completeKinds?.has(s.kind)) add(key, { doc: h.doc, score: h.score, sortName: fold(h.doc.name) })
        continue
      }
      if (!contextual || !served.has(mine.doc.kind) || !ownMatch(mine)) continue
      add(key, { doc: mine.doc, score: h.score, sortName: mine.sortName })
    }
  }

  const residentByKind = new Map(resident.result.sections.map((s) => [s.kind, s]))
  const serverByKind = new Map(server.sections.map((s) => [s.kind, s]))
  const sections: SpotlightMergedSection<R | SpotlightWireDoc>[] = []
  let topHit: Hit | null = null
  for (const kind of SPOTLIGHT_KIND_ORDER) {
    const hits = byKind.get(kind)
    if (!hits || hits.length === 0) continue
    const mine = residentByKind.get(kind)
    const coverage = served.get(kind)
    let section: SpotlightMergedSection<R | SpotlightWireDoc>
    if (!coverage) {
      section = { kind, total: mine?.total ?? hits.length, hits, totalCapped: false, source: 'resident' }
    } else {
      const theirs = serverByKind.get(kind)
      // Under a negated context term the store's count includes what the server excluded.
      const residentTotal = negatedContext && coverage === 'full' ? 0 : mine?.total ?? 0
      hits.sort(compareSpotlightHits)
      section = {
        kind,
        total: Math.max(residentTotal, theirs?.total ?? 0, hits.length),
        hits: hits.slice(0, Math.max(0, perKind)),
        totalCapped: theirs?.totalCapped === true || coverage === 'partial',
        source: 'merged',
      }
    }
    sections.push(section)
    // Sections are sorted, so the best hit overall heads one of them.
    const first = section.hits[0]
    if (first && first.score > 0 && (!topHit || compareTopHits(first, topHit) < 0)) topHit = first
  }
  return { topHit, sections }
}
