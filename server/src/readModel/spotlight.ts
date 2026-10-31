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
 * Spotlight search over the read model, for one workspace.
 *
 * Two stages, the read model's established shape (cf. `roSearch`: "SQL filters,
 * Node ranks"):
 *
 *  1. CANDIDATES. Per kind family, one SQL query keeps the rows that MAY match,
 *     using the stored, accent-folded `spot_*` columns of `spotlightSql.ts`. Every
 *     predicate is a SUPERSET of the real rule (an unscoped term is looked for
 *     in name + description + technology at once), or exact; a negated text
 *     term is not pushed down at all, since NOT of a superset would drop real
 *     matches. Capped at `candidateCap` rows a family.
 *  2. RANKING. The candidates become `SpotlightDoc`s and go through the SAME
 *     evaluator the browser runs (`../search/spotlight/evaluate.ts`, the byte
 *     mirror of the client's), so a server answer ranks exactly as the resident
 *     tier would on the same entities. Scores, ties and the top hit agree by
 *     construction, not by a second implementation.
 *
 * Domain and tag NAMES do not live in the read model; the request carries the
 * client's vocabulary (`vocab`), so both tiers resolve `domain:` and `tag:`
 * against the same names.
 *
 * Coverage, reported in every answer so the client can fill the gaps from what
 * it holds instead of reading "nothing found":
 *  - `unavailableKinds`: decision records live in the read model only for
 *    STATIC workspaces (their sole projector is `staticDeltaProjector.ts`);
 *  - `fieldGaps`: the read model holds the registry's DiagramMeta stub for a
 *    diagram (bridge.ts `buildMeta`: no description, no domain) and no domain
 *    for a flow, so a term on those fields cannot match here;
 *  - `totalCapped`: when a family hits the cap, its totals are lower bounds and
 *    its hits are the best of the capped set, ordered by a name-match proxy.
 */

import { C4_OBJECT_KINDS, SPOTLIGHT_KIND_ORDER, parseSpotlightQuery } from '../search/spotlight/grammar.js'
import type { EnumTerm, SpotlightKind, SpotlightQuery, SpotlightTerm, TextField } from '../search/spotlight/grammar.js'
import { fold } from '../search/spotlight/fold.js'
import { SHORT_TERM_CHARS, SPOTLIGHT_KIND_FIELDS, matchQuality, prepareSpotlightDoc, rankSpotlight, spotlightKinds } from '../search/spotlight/evaluate.js'
import type { DocField, PreparedDoc, SpotlightDoc } from '../search/spotlight/evaluate.js'
import {
  SPOTLIGHT_PER_KIND_MAX, SPOTLIGHT_QUERY_MAX, SPOTLIGHT_VOCAB_DOMAINS_MAX, SPOTLIGHT_VOCAB_TAGS_MAX, SPOTLIGHT_VOCAB_TEXT_MAX,
} from '../search/spotlight/wire.js'
import type { SpotlightCoverage, SpotlightWireDoc, SpotlightWireResult } from '../search/spotlight/wire.js'
import { SPOTLIGHT_FOLD_FN, SPOTLIGHT_TECH_FN } from './spotlightSql.js'
import type { Queryable } from './types.js'

export interface SpotlightWorkspace {
  landscapeId: string
  versionId: string
}

export interface SpotlightVocab {
  /** domain id -> name */
  readonly domains: ReadonlyMap<string, string>
  /** tag id -> value */
  readonly tags: ReadonlyMap<string, string>
}

export interface RoSpotlightOptions {
  /** Kinds the caller wants (a scope); default every server-side kind. */
  readonly kinds?: readonly SpotlightKind[]
  /** Hits returned per kind section. */
  readonly perKind: number
  readonly vocab: SpotlightVocab
  /** Candidate rows read per family before ranking. */
  readonly candidateCap?: number
  /** Stops between families once the caller has gone (the request closed). */
  readonly signal?: AbortSignal
}

/** Thrown when `signal` aborts between two families. */
export class SpotlightAborted extends Error {
  constructor() { super('spotlight search aborted') }
}

/** Fields the read model does not hold, per kind (see the header). */
export const SPOTLIGHT_FIELD_GAPS: Readonly<Partial<Record<SpotlightKind, readonly DocField[]>>> = {
  diagram: ['desc', 'domain'],
  flow: ['domain'],
}

// The wire contract (types and limits) is the shared core's `wire.ts`, which
// the client reads with.
export type { SpotlightCoverage, SpotlightWireDoc, SpotlightWireSection } from '../search/spotlight/wire.js'
export type RoSpotlightResult = SpotlightWireResult
export { SPOTLIGHT_PER_KIND_MAX, SPOTLIGHT_QUERY_MAX }

export const SPOTLIGHT_CANDIDATE_CAP = 1000
const WIRE_DESCRIPTION_MAX = 600
const WIRE_DIAGRAMS_MAX = 12

/** Kinds the server can answer: every kind but the client-only pages. */
const SERVER_KINDS = SPOTLIGHT_KIND_ORDER.filter((k) => k !== 'page')

type Family = 'object' | 'group' | 'connection' | 'diagram' | 'flow' | 'adr'

const FAMILY_KINDS: Readonly<Record<Family, readonly SpotlightKind[]>> = {
  object: C4_OBJECT_KINDS,
  group: ['group'],
  connection: ['connection'],
  diagram: ['diagram'],
  flow: ['flow'],
  adr: ['adr'],
}

// ── request validation ──────────────────────────────────────────────────────

export interface SpotlightRequest {
  readonly q: string
  readonly kinds?: SpotlightKind[]
  readonly perKind: number
  readonly vocab: SpotlightVocab
}

function pairs(value: unknown, max: number): Map<string, string> | null {
  if (value === undefined) return new Map()
  if (!Array.isArray(value) || value.length > max) return null
  const out = new Map<string, string>()
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const [id, name] = entry
    if (typeof id !== 'string' || typeof name !== 'string' || id.length > SPOTLIGHT_VOCAB_TEXT_MAX || name.length > SPOTLIGHT_VOCAB_TEXT_MAX) return null
    out.set(id, name)
  }
  return out
}

/** Validate a POST body. Returns an error string for a 400. */
export function parseSpotlightRequest(body: unknown): SpotlightRequest | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.q !== 'string') return 'q must be a string'
  if (b.q.length > SPOTLIGHT_QUERY_MAX) return `q is longer than ${SPOTLIGHT_QUERY_MAX} characters`
  let kinds: SpotlightKind[] | undefined
  if (b.kinds !== undefined) {
    if (!Array.isArray(b.kinds) || b.kinds.some((k) => !(SPOTLIGHT_KIND_ORDER as readonly unknown[]).includes(k))) return 'kinds must list known kinds'
    kinds = b.kinds as SpotlightKind[]
  }
  const perKind = b.perKind === undefined ? 5 : Number(b.perKind)
  if (!Number.isInteger(perKind) || perKind < 1 || perKind > SPOTLIGHT_PER_KIND_MAX) return `perKind must be 1..${SPOTLIGHT_PER_KIND_MAX}`
  const vocab = (b.vocab ?? {}) as Record<string, unknown>
  if (typeof vocab !== 'object') return 'vocab must be an object'
  const domains = pairs(vocab.domains, SPOTLIGHT_VOCAB_DOMAINS_MAX)
  const tags = pairs(vocab.tags, SPOTLIGHT_VOCAB_TAGS_MAX)
  if (!domains || !tags) return 'vocab.domains and vocab.tags must be [id, name] pairs'
  return { q: b.q, kinds, perKind, vocab: { domains, tags } }
}

// ── SQL building ────────────────────────────────────────────────────────────

class Params {
  readonly values: unknown[]
  constructor(initial: unknown[]) { this.values = [...initial] }
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

/** Code point -> Postgres ARE escape, as regex source text. */
const are = (code: number) => '\\u' + code.toString(16).padStart(4, '0')
/** The core's `isWordBoundary` as an ARE class: ASCII that is not a lowercase
 *  letter or a digit (folded text holds no ASCII capitals, but the class says
 *  the same thing as the JS either way). */
const BOUNDARY_CLASS = `[${are(0x01)}-${are(0x2f)}${are(0x3a)}-${are(0x60)}${are(0x7b)}-${are(0x7f)}]`

function likeContains(params: Params, value: string): string {
  return params.add(`%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
}

function wordStartRegex(params: Params, value: string): string {
  return params.add(`(^|${BOUNDARY_CLASS})${value.replace(/[\\^$.|?*+()[\]{}]/g, (c) => `\\${c}`)}`)
}

/** The core's matching rule for one folded value against one folded SQL expr:
 *  a short value must start a word; a longer one may sit anywhere. */
function matchSql(params: Params, expr: string, value: string): string {
  return value.length < SHORT_TERM_CHARS ? `${expr} ~ ${wordStartRegex(params, value)}` : `${expr} LIKE ${likeContains(params, value)}`
}

const foldSql = (sql: string) => `${SPOTLIGHT_FOLD_FN}(${sql})`
const or = (parts: string[]) => (parts.length === 0 ? 'FALSE' : parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`)

interface FamilySql {
  readonly family: Family
  readonly from: string
  readonly a: string
  readonly id: string
  /** Indexed superset: name + description + technology names. */
  readonly text: string
  readonly name: string
  readonly desc: string | null
  readonly tech: string | null
  /** Extra name strings that match like the title (ADR numbers). */
  readonly alt: string | null
  readonly domainCol: string | null
  readonly statusCol: string | null
  readonly scopeCol: string | null
  /** Diagram membership: [table, member column] or a direct diagram id column. */
  readonly membership: { table: string; column: string } | { direct: string } | null
  readonly tags: ((ids: string) => string) | null
}

const FAMILY_SQL: Readonly<Record<Family, FamilySql>> = {
  object: {
    family: 'object', from: 'ro_objects o', a: 'o.', id: 'o.id',
    text: 'o.spot_text', name: 'o.spot_name',
    desc: foldSql(`COALESCE(o.data->>'shortDescription', '') || ' ' || o.description`),
    tech: foldSql(`${SPOTLIGHT_TECH_FN}(o.data)`), alt: null,
    domainCol: 'o.domain_id', statusCol: 'o.status', scopeCol: 'o.scope',
    membership: { table: 'ro_diagram_objects', column: 'object_id' },
    // The assignment map itself, as `orderedTagIds` reads it (ro_object_tags
    // drops entries whose value disagrees with their key).
    tags: (ids) => `jsonb_exists_any(COALESCE(o.data->'tagAssignments', '{}'::jsonb), ${ids}::text[])`,
  },
  group: {
    family: 'group', from: 'ro_groups g', a: 'g.', id: 'g.id',
    text: 'g.spot_text', name: 'g.spot_name',
    desc: null, tech: foldSql(`${SPOTLIGHT_TECH_FN}(g.data)`), alt: null,
    domainCol: null, statusCol: null, scopeCol: null,
    membership: { table: 'ro_diagram_groups', column: 'group_id' },
    tags: null,
  },
  connection: {
    family: 'connection', from: 'ro_connections c', a: 'c.', id: 'c.id',
    text: 'c.spot_text', name: 'c.spot_name',
    desc: foldSql(`COALESCE(c.data->>'description', '')`), tech: foldSql(`${SPOTLIGHT_TECH_FN}(c.data)`), alt: null,
    domainCol: null, statusCol: null, scopeCol: null,
    membership: { table: 'ro_diagram_connections', column: 'connection_id' },
    tags: (ids) => `jsonb_exists_any(COALESCE(c.data->'tagAssignments', '{}'::jsonb), ${ids}::text[])`,
  },
  // Description and domain: not in the read model (SPOTLIGHT_FIELD_GAPS).
  diagram: {
    family: 'diagram', from: 'ro_diagram_summaries s', a: 's.', id: 's.diagram_id',
    text: 's.spot_name', name: 's.spot_name',
    desc: null, tech: null, alt: null,
    domainCol: null, statusCol: null, scopeCol: null, membership: null, tags: null,
  },
  // Domain: not in the read model (SPOTLIGHT_FIELD_GAPS).
  flow: {
    family: 'flow', from: 'ro_flows f', a: 'f.', id: 'f.flow_id',
    text: 'f.spot_name', name: 'f.spot_name',
    desc: null, tech: null, alt: null,
    domainCol: null, statusCol: null, scopeCol: null, membership: { direct: 'f.diagram_id' }, tags: null,
  },
  adr: {
    family: 'adr', from: 'ro_decision_records r', a: 'r.', id: 'r.id',
    text: 'r.spot_text', name: 'r.spot_name',
    desc: foldSql(`COALESCE(r.data->>'summary', '') || ' ' || COALESCE(r.data->>'content', '')`), tech: null,
    // `ADR-7 ADR-007`, as adrLabels() writes them (padStart never truncates).
    alt: `CASE WHEN r.adr_number IS NULL THEN '' ELSE 'adr-' || r.adr_number || ' adr-'
      || CASE WHEN length(r.adr_number::text) >= 3 THEN r.adr_number::text ELSE lpad(r.adr_number::text, 3, '0') END END`,
    domainCol: null, statusCol: 'r.status', scopeCol: null, membership: null, tags: null,
  },
}

interface Ctx {
  readonly params: Params
  readonly vocab: SpotlightVocab
}

/** Ids from a vocabulary whose name matches the folded value by the core's rule. */
function vocabIds(names: ReadonlyMap<string, string>, value: string): string[] {
  const ids: string[] = []
  for (const [id, name] of names) if (matchQuality(fold(name), value) > 0) ids.push(id)
  return ids
}

function membershipMatch(f: FamilySql, ctx: Ctx, value: string): string {
  const nameMatch = matchSql(ctx.params, 'ds.spot_name', value)
  if (!f.membership) return 'FALSE'
  if ('direct' in f.membership) {
    return `EXISTS (SELECT 1 FROM ro_diagram_summaries ds WHERE ds.landscape_id = ${f.a}landscape_id
      AND ds.version_id = ${f.a}version_id AND ds.diagram_id = ${f.membership.direct} AND ${nameMatch})`
  }
  return `EXISTS (SELECT 1 FROM ${f.membership.table} dm JOIN ro_diagram_summaries ds
      ON ds.landscape_id = dm.landscape_id AND ds.version_id = dm.version_id AND ds.diagram_id = dm.diagram_id
    WHERE dm.landscape_id = ${f.a}landscape_id AND dm.version_id = ${f.a}version_id
      AND dm.${f.membership.column} = ${f.id} AND ${nameMatch})`
}

function endpointMatch(ctx: Ctx, column: string, value: string): string {
  const objectName = matchSql(ctx.params, 'eo.spot_name', value)
  const groupName = matchSql(ctx.params, 'eg.spot_name', value)
  return `(EXISTS (SELECT 1 FROM ro_objects eo WHERE eo.landscape_id = c.landscape_id AND eo.version_id = c.version_id
      AND eo.id = c.${column} AND ${objectName})
    OR (NOT EXISTS (SELECT 1 FROM ro_objects eo WHERE eo.landscape_id = c.landscape_id AND eo.version_id = c.version_id
      AND eo.id = c.${column})
      AND EXISTS (SELECT 1 FROM ro_groups eg WHERE eg.landscape_id = c.landscape_id AND eg.version_id = c.version_id
      AND eg.id = c.${column} AND ${groupName})))`
}

/** Candidate predicate for one positive text term value; null = unconstrained. */
function textValueSql(f: FamilySql, fields: readonly DocField[], ctx: Ctx, field: TextField, value: string): string | null {
  const short = value.length < SHORT_TERM_CHARS
  const has = (d: DocField) => fields.includes(d)
  // The name is inside the indexed text, so a long term also tests the text:
  // same rows, but the trigram index can serve it.
  const nameSql = () => (short ? matchSql(ctx.params, f.name, value)
    : `(${f.text} LIKE ${likeContains(ctx.params, value)} AND ${matchSql(ctx.params, f.name, value)})`)
  const nameOrAlt = () => or([nameSql(), ...(f.alt ? [matchSql(ctx.params, f.alt, value)] : [])])
  const tagMatch = () => {
    if (!f.tags || !has('tag')) return 'FALSE'
    const ids = vocabIds(ctx.vocab.tags, value)
    return ids.length ? f.tags(ctx.params.add(ids)) : 'FALSE'
  }
  switch (field) {
    case 'any':
      // An unscoped short term only matches names (the core's rule).
      if (short) return nameOrAlt()
      return or([
        `${f.text} LIKE ${likeContains(ctx.params, value)}`,
        ...(f.alt ? [matchSql(ctx.params, f.alt, value)] : []),
        ...(f.tags && has('tag') ? [tagMatch()] : []),
      ])
    case 'name': return nameOrAlt()
    case 'desc':
      if (!has('desc') || !f.desc) return 'FALSE'
      return short ? matchSql(ctx.params, f.desc, value) : `${f.text} LIKE ${likeContains(ctx.params, value)}`
    case 'tech':
      if (!has('tech') || !f.tech) return 'FALSE'
      return short ? matchSql(ctx.params, f.tech, value) : `${f.text} LIKE ${likeContains(ctx.params, value)}`
    case 'tag': return tagMatch()
    case 'domain': {
      if (!has('domain') || !f.domainCol) return 'FALSE'
      const ids = vocabIds(ctx.vocab.domains, value)
      return ids.length ? `${f.domainCol} = ANY(${ctx.params.add(ids)}::text[])` : 'FALSE'
    }
    case 'in': return has('in') ? membershipMatch(f, ctx, value) : 'FALSE'
    case 'from': return f.family === 'connection' ? endpointMatch(ctx, 'from_id', value) : 'FALSE'
    case 'to': return f.family === 'connection' ? endpointMatch(ctx, 'to_id', value) : 'FALSE'
  }
}

/** Candidate predicate for one enum term; null = unconstrained. */
function enumSql(f: FamilySql, fields: readonly DocField[], ctx: Ctx, term: EnumTerm): string | null {
  const exact = (sql: string) => (term.negated ? `NOT (${sql})` : sql)
  switch (term.key) {
    case 'kind': {
      const wanted = FAMILY_KINDS[f.family].filter((k) => term.values.includes(k))
      if (f.family !== 'object') return exact(wanted.length ? 'TRUE' : 'FALSE')
      return exact(wanted.length ? `o.type = ANY(${ctx.params.add(wanted)}::text[])` : 'FALSE')
    }
    case 'status':
      if (!fields.includes('status') || !f.statusCol) return term.negated ? null : 'FALSE'
      return exact(`COALESCE(${f.statusCol}, '') = ANY(${ctx.params.add([...term.values])}::text[])`)
    case 'scope':
      if (!fields.includes('scope') || !f.scopeCol) return term.negated ? null : 'FALSE'
      return exact(`COALESCE(${f.scopeCol}, '') = ANY(${ctx.params.add([...term.values])}::text[])`)
    case 'has':
      // Supersets (whitespace-only text still "has"); never negated here.
      return null
  }
}

function termSql(f: FamilySql, ctx: Ctx, term: SpotlightTerm): string | null {
  const fields = SPOTLIGHT_KIND_FIELDS[FAMILY_KINDS[f.family][0]]
  if (term.type === 'enum') return enumSql(f, fields, ctx, term)
  // NOT of a superset would drop real matches: stage 2 handles negation.
  if (term.negated) return null
  const parts: string[] = []
  for (const value of term.values) {
    const sql = textValueSql(f, fields, ctx, term.field, value)
    if (sql === null) return null
    parts.push(sql)
  }
  return or(parts)
}

/** AND of groups, each an OR of terms. Null parts relax their group. */
function querySql(f: FamilySql, ctx: Ctx, query: SpotlightQuery): string[] {
  const clauses: string[] = []
  for (const group of query.groups) {
    // A group that turns out unconstrained (`ledger OR -api`) drops its SQL, so
    // it must drop the parameters its earlier terms bound too: a bound but
    // unreferenced `$n` has no type, and Postgres refuses the whole statement.
    const mark = ctx.params.values.length
    const parts: string[] = []
    let open = false
    for (const term of group) {
      const sql = termSql(f, ctx, term)
      if (sql === null) { open = true; break }
      parts.push(sql)
    }
    if (open) ctx.params.values.length = mark
    else clauses.push(or(parts))
  }
  return clauses
}

/** Before the cap: the likeliest top hits first (the first positive name-
 *  searchable term's quality on the name), then name order. */
function proxyOrder(f: FamilySql, ctx: Ctx, query: SpotlightQuery): string {
  const order = [`${f.name} COLLATE "C"`, `${f.id} COLLATE "C"`]
  for (const group of query.groups) {
    const term = group.length === 1 ? group[0] : null
    if (!term || term.type !== 'text' || term.negated || (term.field !== 'any' && term.field !== 'name')) continue
    const value = term.values[0]
    const v = ctx.params.add(value)
    const prefix = ctx.params.add(`${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    return [`CASE WHEN ${f.name} = ${v} THEN 0 WHEN ${f.name} LIKE ${prefix} THEN 1
      WHEN ${matchSql(ctx.params, f.name, value)} THEN 2 ELSE 3 END`, ...order].join(', ')
  }
  return order.join(', ')
}

// ── stage 2: documents ──────────────────────────────────────────────────────

interface Row extends Record<string, unknown> {
  id: string
  data: Record<string, unknown> | null
}

function techNames(data: Record<string, unknown> | null): string[] {
  const usages = data?.technologyUsages
  if (!usages || typeof usages !== 'object') return []
  const map = usages as Record<string, { snapshot?: { name?: unknown } }>
  const order = Array.isArray(data?.technologyUsageOrder) ? (data!.technologyUsageOrder as unknown[]).filter((v): v is string => typeof v === 'string') : []
  const ids = [...order.filter((id) => id in map), ...Object.keys(map).filter((id) => !order.includes(id))]
  return ids.map((id) => map[id]?.snapshot?.name).filter((n): n is string => typeof n === 'string' && n.length > 0)
}

/** Assigned tags in functional order: the client's `orderedTagIds`
 *  (src/lib/tags/assignments.ts) — a `tagOrder` entry with no assignment is a
 *  stale CRDT leftover, not a tag; an assignment missing from the order comes
 *  after it, sorted. */
function tagNames(data: Record<string, unknown> | null, vocab: SpotlightVocab): string[] {
  const order = Array.isArray(data?.tagOrder) ? (data!.tagOrder as unknown[]).filter((v): v is string => typeof v === 'string') : []
  const assigned = data?.tagAssignments && typeof data.tagAssignments === 'object' ? Object.keys(data.tagAssignments as object) : []
  const assignedSet = new Set(assigned)
  const ids: string[] = []
  for (const id of order) if (assignedSet.has(id) && !ids.includes(id)) ids.push(id)
  for (const id of [...assigned].sort()) if (!ids.includes(id)) ids.push(id)
  return ids.map((id) => vocab.tags.get(id)).filter((n): n is string => !!n)
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

async function namesById(db: Queryable, key: SpotlightWorkspace, table: 'ro_objects' | 'ro_groups', ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM ${table} WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, ids],
  )
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** Diagram names per member, for the `in:` field and the preview. */
async function memberDiagramNames(
  db: Queryable, key: SpotlightWorkspace, table: string, column: string, ids: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (ids.length === 0) return out
  const { rows } = await db.query<{ member: string; name: string }>(
    `SELECT dm.${column} AS member, ds.name FROM ${table} dm JOIN ro_diagram_summaries ds
       ON ds.landscape_id = dm.landscape_id AND ds.version_id = dm.version_id AND ds.diagram_id = dm.diagram_id
     WHERE dm.landscape_id = $1 AND dm.version_id = $2 AND dm.${column} = ANY($3::text[])`,
    [key.landscapeId, key.versionId, ids],
  )
  for (const r of rows) {
    let list = out.get(r.member)
    if (!list) out.set(r.member, (list = []))
    list.push(r.name)
  }
  return out
}

async function familyDocs(db: Queryable, key: SpotlightWorkspace, family: Family, rows: Row[], vocab: SpotlightVocab): Promise<SpotlightWireDoc[]> {
  const ids = rows.map((r) => r.id)
  const domainName = (id: unknown) => (typeof id === 'string' ? vocab.domains.get(id) : undefined)
  switch (family) {
    case 'object': {
      const diagrams = await memberDiagramNames(db, key, 'ro_diagram_objects', 'object_id', ids)
      const parents = await namesById(db, key, 'ro_objects', [...new Set(rows.map((r) => str(r.parent_id)).filter(Boolean))])
      return rows.map((r) => ({
        kind: r.type as SpotlightKind, id: r.id, name: str(r.name),
        description: [str(r.data?.shortDescription), str(r.description)].filter(Boolean).join('\n'),
        tech: techNames(r.data), tags: tagNames(r.data, vocab),
        status: str(r.status) || undefined, scope: (str(r.scope) || undefined) as SpotlightDoc['scope'],
        domain: domainName(r.domain_id), diagrams: diagrams.get(r.id) ?? [],
        extra: {
          parentName: parents.get(str(r.parent_id)) ?? null, domainId: str(r.domain_id) || null,
          diagramCount: diagrams.get(r.id)?.length ?? 0,
        },
      }))
    }
    case 'group': {
      const diagrams = await memberDiagramNames(db, key, 'ro_diagram_groups', 'group_id', ids)
      return rows.map((r) => ({
        kind: 'group' as const, id: r.id, name: str(r.name), tech: techNames(r.data), diagrams: diagrams.get(r.id) ?? [],
        extra: { diagramCount: diagrams.get(r.id)?.length ?? 0 },
      }))
    }
    case 'connection': {
      const diagrams = await memberDiagramNames(db, key, 'ro_diagram_connections', 'connection_id', ids)
      const endpointIds = [...new Set(rows.flatMap((r) => [str(r.from_id), str(r.to_id)]))]
      const objects = await namesById(db, key, 'ro_objects', endpointIds)
      const groups = await namesById(db, key, 'ro_groups', endpointIds.filter((id) => !objects.has(id)))
      const endpoint = (id: string) => objects.get(id) ?? groups.get(id) ?? ''
      return rows.map((r) => ({
        kind: 'connection' as const, id: r.id, name: str(r.label), description: str(r.data?.description) || undefined,
        tech: techNames(r.data), tags: tagNames(r.data, vocab), diagrams: diagrams.get(r.id) ?? [],
        from: endpoint(str(r.from_id)), to: endpoint(str(r.to_id)),
        extra: { fromId: str(r.from_id), toId: str(r.to_id), diagramCount: diagrams.get(r.id)?.length ?? 0 },
      }))
    }
    case 'diagram': {
      const parents = await namesById(db, key, 'ro_objects', [...new Set(rows.map((r) => str(r.parent_object_id)).filter(Boolean))])
      // No description or domain: the read model does not hold them (SPOTLIGHT_FIELD_GAPS).
      return rows.map((r) => ({
        kind: 'diagram' as const, id: r.id, name: str(r.name),
        extra: {
          type: str(r.type), domainId: str(r.domain_id) || null, parentName: parents.get(str(r.parent_object_id)) ?? null,
          objectCount: Number(r.object_count ?? 0), connectionCount: Number(r.connection_count ?? 0),
        },
      }))
    }
    case 'flow':
      return rows.map((r) => ({
        kind: 'flow' as const, id: r.id, name: str(r.name),
        diagrams: [str(r.diagram_name)].filter(Boolean),
        extra: { diagramId: str(r.diagram_id) },
      }))
    case 'adr': {
      return rows.map((r) => {
        // The client's adrLabels(), on the record's OWN number: `adr_number` is
        // floored on one write path (2.5 → 2) and NULL on another, so it serves
        // stage 1 as a superset only. No label without a non-negative integer.
        const raw = r.data?.number
        const n = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
        return {
          kind: 'adr' as const, id: r.id, name: str(r.title),
          alt: n === null ? [] : [`ADR-${n}`, `ADR-${String(n).padStart(3, '0')}`],
          description: [str(r.data?.summary), str(r.data?.content)].filter(Boolean).join('\n'),
          status: str(r.status) || undefined,
          extra: { number: n, updatedAt: str(r.updated_at) || null, summary: str(r.data?.summary) || null },
        }
      })
    }
  }
}

const SELECT_COLUMNS: Readonly<Record<Family, string>> = {
  object: 'o.id, o.type, o.name, o.description, o.status, o.scope, o.domain_id, o.parent_id, o.data',
  group: 'g.id, g.name, g.data',
  connection: 'c.id, c.label, c.from_id, c.to_id, c.data',
  diagram: 's.diagram_id AS id, s.name, s.type, s.domain_id, s.parent_object_id, s.object_count, s.connection_count, s.data',
  flow: `f.flow_id AS id, f.name, f.diagram_id, NULL::jsonb AS data,
    (SELECT ds.name FROM ro_diagram_summaries ds WHERE ds.landscape_id = f.landscape_id AND ds.version_id = f.version_id
       AND ds.diagram_id = f.diagram_id) AS diagram_name`,
  adr: 'r.id, r.title, r.status, r.adr_number, r.updated_at, r.data',
}

/** Trim a document for the wire: the client renders it, it does not rank it. */
function wireDoc(doc: SpotlightWireDoc): SpotlightWireDoc {
  return {
    ...doc,
    ...(doc.description && doc.description.length > WIRE_DESCRIPTION_MAX ? { description: doc.description.slice(0, WIRE_DESCRIPTION_MAX) } : {}),
    ...(doc.diagrams && doc.diagrams.length > WIRE_DIAGRAMS_MAX ? { diagrams: doc.diagrams.slice(0, WIRE_DIAGRAMS_MAX) } : {}),
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Search one workspace. Every query is bound to `(landscape_id, version_id)`;
 * the caller has already passed the workspace access gate.
 */
export async function roSpotlight(
  db: Queryable,
  key: SpotlightWorkspace,
  source: string,
  opts: RoSpotlightOptions,
): Promise<RoSpotlightResult> {
  const query = parseSpotlightQuery(source.slice(0, SPOTLIGHT_QUERY_MAX))
  const wanted = new Set(opts.kinds ?? SERVER_KINDS)
  let kinds = spotlightKinds(query).filter((k) => k !== 'page' && wanted.has(k))
  const unavailableKinds: SpotlightKind[] = []
  if (kinds.includes('adr') && !(await isStaticWorkspace(db, key))) {
    kinds = kinds.filter((k) => k !== 'adr')
    unavailableKinds.push('adr')
  }
  const coverage: SpotlightCoverage = { unavailableKinds, fieldGaps: SPOTLIGHT_FIELD_GAPS }
  if (kinds.length === 0) return { v: 1, topHit: null, sections: [], coverage }
  const cap = Math.max(1, Math.min(opts.candidateCap ?? SPOTLIGHT_CANDIDATE_CAP, 5000))

  const prepared: PreparedDoc<SpotlightWireDoc>[] = []
  const cappedKinds = new Set<SpotlightKind>()
  for (const family of Object.keys(FAMILY_KINDS) as Family[]) {
    const familyKinds = FAMILY_KINDS[family].filter((k) => kinds.includes(k))
    if (familyKinds.length === 0) continue
    if (opts.signal?.aborted) throw new SpotlightAborted()
    const f = FAMILY_SQL[family]
    const ctx: Ctx = { params: new Params([key.landscapeId, key.versionId]), vocab: opts.vocab }
    const where = [`${f.a}landscape_id = $1`, `${f.a}version_id = $2`]
    if (family === 'object') where.push(`o.type = ANY(${ctx.params.add(familyKinds)}::text[])`)
    where.push(...querySql(f, ctx, query))
    const order = proxyOrder(f, ctx, query)
    const limit = ctx.params.add(cap + 1)
    const { rows } = await db.query<Row>(
      `SELECT ${SELECT_COLUMNS[family]} FROM ${f.from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`,
      ctx.params.values,
    )
    if (rows.length > cap) {
      rows.length = cap
      for (const k of familyKinds) cappedKinds.add(k)
    }
    for (const doc of await familyDocs(db, key, family, rows, opts.vocab)) prepared.push(prepareSpotlightDoc(doc))
  }

  const result = rankSpotlight(query, prepared, opts.perKind)
  return {
    v: 1,
    topHit: result.topHit ? { kind: result.topHit.doc.kind, id: result.topHit.doc.id } : null,
    sections: result.sections.map((s) => ({
      kind: s.kind,
      total: s.total,
      totalCapped: cappedKinds.has(s.kind),
      hits: s.hits.map((h) => ({ score: h.score, doc: wireDoc(h.doc) })),
    })),
    coverage,
  }
}

/** Decision records reach the read model only through the static projector. */
async function isStaticWorkspace(db: Queryable, key: SpotlightWorkspace): Promise<boolean> {
  const { rows } = await db.query<{ static: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2) AS static`,
    [key.landscapeId, key.versionId],
  )
  return rows[0]?.static === true
}
