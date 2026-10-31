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
 * The instrument that decides whether a Structurizr JSON import was FAITHFUL.
 *
 * It measures the things a customer notices — did my elements arrive, are my
 * arrows still there and pointing the same way, did every diagram keep the same
 * boxes on it, is the picture still laid out the way I drew it, do the labels
 * still read the same — and names the exact ids that were lost, because a
 * percentage tells a reviewer nothing they can act on.
 *
 * Two structural decisions worth knowing before reading:
 *
 * 1. It measures the RESULT, not the importer. Nothing here is allowed to call
 *    into the import pipeline; the only inputs are the parsed source workspace
 *    and the `ImportResult`. That is what lets QA point it at a saved import, at
 *    a fixture round trip, or at a future importer nobody has written yet.
 *
 *    The COST of that boundary, which no reader may forget: an `ImportResult`
 *    is not yet a workspace. It has not been through `importModel`, the
 *    Automerge bridge, or `syncLowerConnections`, and those are allowed to drop
 *    things — a connection stamped `kind: 'lower'` scores as perfectly imported
 *    here and could be deleted the first time the customer opens the diagram.
 *    A green report from this file means "the mapper did not lose
 *    it", never "the customer will see it". End-to-end claims belong in a
 *    store-level test; `lib/import/structurizrJsonSource.test.ts` carries one.
 *
 * 2. It reports along the axes where a DECISION lives (authored vs derived
 *    edges, per view kind, per element kind) instead of collapsing them into one
 *    score. `docs/structurizr-json-format.md` §13 lists a dozen places where
 *    "lossless" stops being well defined — dropping deployment views is a
 *    defensible decision (§13.1), dropping half your authored relationships
 *    never is. A single number cannot tell those apart, so this report does not
 *    produce one.
 */

import type { C4Object, Connection, Diagram, Group, Position } from '../../types'
import { elementRole } from '../structurizr/json/layoutPolicy'
import type { SzElement, SzElementKind, SzView, SzViewKind, SzWorkspace } from '../structurizr/json/types'
import type { ImportResult } from './types'

// ── Options ──────────────────────────────────────────────────────────────────

/** Element kinds by id — `elementRole` needs them to tell a boundary from a
 *  shape, and a report walks every view of the same workspace. */
function kindsOf(ws: SzWorkspace): ReadonlyMap<string, SzElementKind> {
  return new Map(ws.elements.map((e) => [e.id, e.kind]))
}


export interface FidelityOptions {
  /**
   * Object/group `properties` keys that may carry the source element's wire id,
   * tried in order. An importer that stamps one of these gets EXACT correlation;
   * without it the report falls back to names and says so (`weaklyMatched`),
   * because a name-matched report is a weaker claim and must not be read as an
   * equally strong one.
   */
  sourceIdProperties?: readonly string[]
  /**
   * Fraction of ordering comparisons that must survive before a view counts as
   * having kept the file's layout. Not 1.0: our shapes are sized from our own
   * style defaults rather than the customer's (§13.4), so a preserved layout can
   * still show a handful of near-tie flips without anyone noticing.
   */
  layoutAgreementThreshold?: number
}

/**
 * The wire id lands here by convention; `structurizr.dsl.identifier` is not in
 * this list because it is a property the SOURCE file already carries (big-bank
 * stamps it on every element), so it is handled as its own correlation tier
 * rather than as something the importer minted.
 */
const DEFAULT_SOURCE_ID_PROPERTIES = ['structurizr.id', 'structurizr.json.id'] as const

/** Also stamped by the DSL importer (`SOURCE_IDENTIFIER_PROPERTY` in mapper.ts). */
const DSL_MAPPER_IDENTIFIER_PROPERTY = 'structurizr.identifier'

const DSL_IDENTIFIER_PROPERTY = 'structurizr.dsl.identifier'

const DEFAULT_LAYOUT_AGREEMENT_THRESHOLD = 0.9

/** Result coordinates within this distance count as the same place. */
const POSITION_EPSILON = 1

/** Per view. A reviewer needs examples, not the full cross product. */
const MAX_INVERSION_EXAMPLES = 8

// ── Report shape ─────────────────────────────────────────────────────────────

export type MatchMethod = 'source-id' | 'dsl-identifier' | 'path' | 'name'

export interface SourceElementRef {
  id: string
  name: string
  kind: SzElementKind
}

export interface KindTally {
  expected: number
  matched: number
  missingIds: string[]
}

export interface ElementFidelity {
  expected: number
  matched: number
  missing: SourceElementRef[]
  byKind: Partial<Record<SzElementKind, KindTally>>
  /** How each match was made. `source-id` is the only exact channel. */
  matchedBy: Partial<Record<MatchMethod, number>>
  /** Matched by name or path — the import carried no usable provenance here. */
  weaklyMatchedIds: string[]
  /** Objects/groups the source does not explain: shapes we invented. */
  unexplainedTargets: Array<{ id: string; name: string; kind: 'object' | 'group' }>
}

export interface GroupFidelity {
  expected: number
  matched: number
  missing: string[]
  /**
   * True when the source declared `structurizr.groupSeparator`, so nested paths
   * were split into one expected boundary per level. Without it a `group` string
   * is opaque and is expected whole — never guess a separator (§13.6).
   */
  separatorDeclared: boolean
}

export type RelationshipLossReason =
  | 'no-connection'
  | 'endpoint-missing'
  | 'endpoint-is-group'
  | 'duplicate-endpoint-pair'
  | 'reversed'

export interface MissingRelationship {
  id: string
  sourceId: string
  destinationId: string
  description?: string
  reason: RelationshipLossReason
}

export interface RelationshipTally {
  expected: number
  matched: number
  missing: MissingRelationship[]
}

export interface RelationshipFidelity {
  /** Edges the user wrote. Losing one is a bug, never a decision. */
  authored: RelationshipTally
  /** Implied edges and deployment replicas (`linkedRelationshipId`, T7). */
  derived: RelationshipTally
  /** Connections no source relationship explains: arrows we invented. */
  unexplainedConnectionIds: string[]
}

export interface MissingView {
  key: string
  kind: SzViewKind
  title?: string
}

export interface ViewFidelity {
  expected: number
  matched: number
  missing: MissingView[]
  droppedByKind: Partial<Record<SzViewKind, number>>
  /** Matched on title/name rather than on `sourceViewKey` (T16 says key is identity). */
  weaklyMatchedKeys: string[]
  unexplainedDiagrams: Array<{ id: string; name: string }>
}

export interface ViewMembershipDetail {
  key: string
  kind: SzViewKind
  diagramId?: string
  expected: number
  present: number
  /** Listed by the view, absent from the diagram. */
  missing: SourceElementRef[]
  /** On the diagram, not listed by the view. */
  extra: Array<{ id: string; name: string }>
  /**
   * Distinct relationships the view draws. Distinct, not step count: a dynamic
   * view repeats a relationship id once per step (T9) and a diagram can only
   * hold the connection once, so counting steps would make every dynamic view
   * look lossy.
   */
  expectedRelationships: number
  presentRelationships: number
  /** Source relationship ids the view draws but the diagram does not carry. */
  missingRelationshipIds: string[]
}

export interface ViewMembershipFidelity {
  expectedTotal: number
  presentTotal: number
  expectedRelationshipTotal: number
  presentRelationshipTotal: number
  viewsWithLoss: number
  details: ViewMembershipDetail[]
}

export type LayoutClassification =
  | 'preserved'
  | 'relaid-out'
  | 'source-unpositioned'
  | 'indeterminate'
  | 'not-imported'

export interface OrderingInversion {
  axis: 'x' | 'y'
  a: string
  b: string
  sourceDelta: number
  resultDelta: number
}

export interface ViewLayoutDetail {
  key: string
  kind: SzViewKind
  diagramId?: string
  classification: LayoutClassification
  /** Elements the file gave real (non-boundary) coordinates for. */
  comparableInSource: number
  /** Of those, how many the diagram places. */
  positionedInResult: number
  /** Source (0,0) entries in a view that also has real coordinates — boundaries (T10c). */
  derivedBoundaries: number
  /** On the diagram but with no entry in `diagram.layouts`. */
  missingLayoutIds: string[]
  orderingAgreementX: number | null
  orderingAgreementY: number | null
  inversionCount: number
  inversions: OrderingInversion[]
}

export interface LayoutFidelity {
  preserved: number
  relaidOut: number
  sourceUnpositioned: number
  indeterminate: number
  notImported: number
  details: ViewLayoutDetail[]
}

export interface LabelChange {
  id: string
  from: string
  to: string
}

export interface LabelLoss {
  id: string
  from: string
}

export interface LabelTally {
  compared: number
  changed: LabelChange[]
  vanished: LabelLoss[]
}

export interface LabelFidelity {
  elementNames: LabelTally
  relationshipDescriptions: LabelTally
}

export interface FidelityReport {
  workspaceName: string
  elements: ElementFidelity
  groups: GroupFidelity
  relationships: RelationshipFidelity
  views: ViewFidelity
  viewMembership: ViewMembershipFidelity
  layout: LayoutFidelity
  labels: LabelFidelity
}

// ── Correlation ──────────────────────────────────────────────────────────────

interface TargetEntity {
  id: string
  name: string
  kind: 'object' | 'group'
  properties: Record<string, string>
  parentId?: string
}

interface ElementCorrelation {
  /** Source element id → the object/group id that represents it. */
  targetBySourceId: Map<string, TargetEntity>
  method: Map<string, MatchMethod>
  claimed: Set<string>
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim()
}

function toTargets(objects: readonly C4Object[], groups: readonly Group[]): TargetEntity[] {
  const out: TargetEntity[] = objects.map((o) => ({
    id: o.id,
    name: o.name,
    kind: 'object' as const,
    properties: o.properties ?? {},
    parentId: o.parentId,
  }))
  for (const g of groups) {
    // A group's containment pointer is named differently and points at an
    // object, which is exactly what a path walk needs, so it is folded in here.
    // `Group.properties` is where a boundary carries its own provenance. Reading
    // it is what lets three deployment nodes all called "Apache Tomcat" be told
    // apart; with an empty map here they correlated by NAME or not at all, and
    // the report blamed the importer for 7 elements it had imported correctly.
    out.push({ id: g.id, name: g.name, kind: 'group', properties: g.properties ?? {}, parentId: g.parentObjectId })
  }
  return out
}

/** `A/B/C` from a parent chain, used to disambiguate two components both called
 *  "Controller". Cycle-guarded: a corrupt result must not hang the harness. */
function pathOf<T extends { id: string; name: string; parentId?: string }>(
  entity: T,
  byId: ReadonlyMap<string, T>,
): string {
  const parts = [entity.name]
  const seen = new Set<string>([entity.id])
  let cursor = entity.parentId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const parent = byId.get(cursor)
    if (!parent) break
    parts.unshift(parent.name)
    cursor = parent.parentId
  }
  return parts.join('/').toLowerCase()
}

function indexBy<T>(items: readonly T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    if (!k) continue
    const bucket = map.get(k)
    if (bucket) bucket.push(item)
    else map.set(k, [item])
  }
  return map
}

function correlateElements(
  source: SzWorkspace,
  result: ImportResult,
  sourceIdProperties: readonly string[],
  groupNames: ReadonlySet<string>,
): ElementCorrelation {
  const targets = toTargets(result.objects, result.groups)
  const targetsById = new Map(targets.map((t) => [t.id, t]))
  const sourcesById = new Map(source.elements.map((e) => [e.id, e]))

  const byProperty = new Map<string, Map<string, TargetEntity[]>>()
  for (const key of sourceIdProperties) {
    byProperty.set(key, indexBy(targets, (t) => normalize(t.properties[key]) || undefined))
  }
  const byDslIdentifier = indexBy(
    targets,
    (t) => normalize(t.properties[DSL_IDENTIFIER_PROPERTY]) || undefined,
  )
  // A Group the file's `group` strings already account for is not a candidate
  // for a NAME-based element match: big-bank declares a group "Big Bank plc"
  // AND two deployment nodes called "Big Bank plc", so without this the
  // enterprise boundary gets paired with a deployment node and the harness
  // reports one more element arriving than actually did. A stamped source id
  // still matches a group — turning a deployment node into a boundary is a
  // legitimate import decision (§13.1b).
  const nameable = targets.filter((t) => !(t.kind === 'group' && groupNames.has(normalize(t.name))))
  const byPath = indexBy(nameable, (t) => pathOf(t, targetsById))
  const byName = indexBy(nameable, (t) => normalize(t.name).toLowerCase() || undefined)

  const targetBySourceId = new Map<string, TargetEntity>()
  const method = new Map<string, MatchMethod>()
  const claimed = new Set<string>()

  const claim = (el: SzElement, target: TargetEntity, how: MatchMethod) => {
    targetBySourceId.set(el.id, target)
    method.set(el.id, how)
    claimed.add(target.id)
  }
  /** Ambiguity is not a match: two unclaimed candidates means we do not know,
   *  and a harness that guesses here reports fidelity it cannot vouch for. */
  const only = (candidates: TargetEntity[] | undefined): TargetEntity | undefined => {
    const free = (candidates ?? []).filter((c) => !claimed.has(c.id))
    return free.length === 1 ? free[0] : undefined
  }

  for (const el of source.elements) {
    let matched = false
    for (const key of sourceIdProperties) {
      const hit = only(byProperty.get(key)?.get(el.id))
      if (hit) {
        claim(el, hit, 'source-id')
        matched = true
        break
      }
    }
    if (matched) continue

    const dslIdentifier = normalize(el.properties[DSL_IDENTIFIER_PROPERTY])
    const hitByDsl = dslIdentifier ? only(byDslIdentifier.get(dslIdentifier)) : undefined
    if (hitByDsl) {
      claim(el, hitByDsl, 'dsl-identifier')
      continue
    }

    const hitByPath = only(byPath.get(pathOf(el, sourcesById)))
    if (hitByPath) {
      claim(el, hitByPath, 'path')
      continue
    }

    const hitByName = only(byName.get(normalize(el.name).toLowerCase()))
    if (hitByName) claim(el, hitByName, 'name')
  }

  return { targetBySourceId, method, claimed }
}

// ── Elements ─────────────────────────────────────────────────────────────────

function measureElements(
  source: SzWorkspace,
  result: ImportResult,
  correlation: ElementCorrelation,
  expectedGroupNames: ReadonlySet<string>,
): ElementFidelity {
  const byKind: Partial<Record<SzElementKind, KindTally>> = {}
  const missing: SourceElementRef[] = []
  const matchedBy: Partial<Record<MatchMethod, number>> = {}
  const weaklyMatchedIds: string[] = []

  for (const el of source.elements) {
    byKind[el.kind] ??= { expected: 0, matched: 0, missingIds: [] }
    const tally = byKind[el.kind]!
    tally.expected += 1
    const target = correlation.targetBySourceId.get(el.id)
    if (!target) {
      tally.missingIds.push(el.id)
      missing.push({ id: el.id, name: el.name, kind: el.kind })
      continue
    }
    tally.matched += 1
    const how = correlation.method.get(el.id) ?? 'name'
    matchedBy[how] = (matchedBy[how] ?? 0) + 1
    if (how !== 'source-id') weaklyMatchedIds.push(el.id)
  }

  // A Group whose name is one the source's `group` strings asked for is
  // explained by that string, not by a missing element — otherwise every group
  // boundary the import correctly created reads as an invented shape.
  const unexplainedTargets = toTargets(result.objects, result.groups)
    .filter((t) => !correlation.claimed.has(t.id))
    .filter((t) => !(t.kind === 'group' && expectedGroupNames.has(normalize(t.name))))
    .map((t) => ({ id: t.id, name: t.name, kind: t.kind }))

  return {
    expected: source.elements.length,
    matched: source.elements.length - missing.length,
    missing,
    byKind,
    matchedBy,
    weaklyMatchedIds,
    unexplainedTargets,
  }
}

// ── Groups ───────────────────────────────────────────────────────────────────

/** One expected boundary per nesting LEVEL when a separator is declared: the DSL
 *  concatenates the full path into `group` (T5) and the renderer draws a box for
 *  each level, so `Group 2/Group 3` is two boundaries, not one named with a slash. */
function expectedGroupNames(source: SzWorkspace): Set<string> {
  const names = new Set<string>()
  const separator = source.groupSeparator
  for (const el of source.elements) {
    const raw = normalize(el.group)
    if (!raw) continue
    if (separator) {
      for (const part of raw.split(separator)) {
        const name = part.trim()
        if (name) names.add(name)
      }
    } else {
      names.add(raw)
    }
  }
  return names
}

function measureGroups(source: SzWorkspace, result: ImportResult, expected: ReadonlySet<string>): GroupFidelity {
  const present = new Set(result.groups.map((g) => normalize(g.name)))
  const missing = [...expected].filter((name) => !present.has(name))
  return {
    expected: expected.size,
    matched: expected.size - missing.length,
    missing,
    separatorDeclared: Boolean(source.groupSeparator),
  }
}

// ── Relationships ────────────────────────────────────────────────────────────

/** Length-prefixed so no separator character has to be assumed absent from an
 *  id — ids are opaque strings (§4.2) and a customer's id may contain anything. */
function pairKey(from: string, to: string): string {
  return `${from.length}:${from}>${to}`
}

function connectionLabel(connection: Connection): string {
  // Either field is a defensible landing place for a Structurizr description —
  // `label` is what the canvas draws, `description` is the long form — so both
  // count as the label having arrived.
  return normalize(connection.label) || normalize(connection.description)
}

function measureRelationships(
  source: SzWorkspace,
  result: ImportResult,
  correlation: ElementCorrelation,
): { fidelity: RelationshipFidelity; claimedByRelationshipId: Map<string, Connection> } {
  const remaining = new Map<string, Connection[]>()
  const everExisted = new Set<string>()
  for (const c of result.connections) {
    const key = pairKey(c.fromId, c.toId)
    everExisted.add(key)
    const bucket = remaining.get(key)
    if (bucket) bucket.push(c)
    else remaining.set(key, [c])
  }

  const authored: RelationshipTally = { expected: 0, matched: 0, missing: [] }
  const derived: RelationshipTally = { expected: 0, matched: 0, missing: [] }
  const claimedByRelationshipId = new Map<string, Connection>()
  const explained = new Set<string>()

  // Authored edges get first claim on a connection: when an importer flattens
  // deployment instances onto their containers (§13.1 option c) the replica and
  // the edge it derives from collapse onto the same pair, and the authored one
  // is the one whose loss would be a bug.
  const ordered = [...source.relationships].sort((a, b) =>
    Number(Boolean(a.linkedRelationshipId)) - Number(Boolean(b.linkedRelationshipId)),
  )

  for (const rel of ordered) {
    const tally = rel.linkedRelationshipId ? derived : authored
    tally.expected += 1
    const fail = (reason: RelationshipLossReason) =>
      tally.missing.push({
        id: rel.id,
        sourceId: rel.sourceId,
        destinationId: rel.destinationId,
        description: rel.description,
        reason,
      })

    const from = correlation.targetBySourceId.get(rel.sourceId)
    const to = correlation.targetBySourceId.get(rel.destinationId)
    if (!from || !to) {
      fail('endpoint-missing')
      continue
    }
    if (from.kind === 'group' || to.kind === 'group') {
      // A Connection joins objects, so an endpoint that became a boundary makes
      // the edge unrepresentable rather than merely absent.
      fail('endpoint-is-group')
      continue
    }

    const key = pairKey(from.id, to.id)
    const bucket = remaining.get(key)
    if (!bucket || bucket.length === 0) {
      const reverse = remaining.get(pairKey(to.id, from.id))
      if (reverse && reverse.length > 0) {
        const flipped = reverse.shift()
        if (flipped) explained.add(flipped.id)
        fail('reversed')
        continue
      }
      fail(everExisted.has(key) ? 'duplicate-endpoint-pair' : 'no-connection')
      continue
    }

    // Parallel edges between the same pair are distinct edges (§13.11), so the
    // description decides which connection this relationship is.
    const wanted = normalize(rel.description)
    const index = bucket.findIndex((c) => connectionLabel(c) === wanted)
    const [claimedConnection] = bucket.splice(index >= 0 ? index : 0, 1)
    if (!claimedConnection) {
      fail('no-connection')
      continue
    }
    explained.add(claimedConnection.id)
    claimedByRelationshipId.set(rel.id, claimedConnection)
    tally.matched += 1
  }

  return {
    fidelity: {
      authored,
      derived,
      unexplainedConnectionIds: result.connections.filter((c) => !explained.has(c.id)).map((c) => c.id),
    },
    claimedByRelationshipId,
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

interface ViewCorrelation {
  diagramByViewKey: Map<string, Diagram>
  weakKeys: string[]
  unexplained: Diagram[]
}

function correlateViews(source: SzWorkspace, result: ImportResult): ViewCorrelation {
  const diagramByViewKey = new Map<string, Diagram>()
  const weakKeys: string[] = []
  const used = new Set<string>()

  const byKey = indexBy(result.diagrams, (d) => d.sourceViewKey)
  const byName = indexBy(result.diagrams, (d) => normalize(d.name).toLowerCase() || undefined)

  for (const view of source.views) {
    const exact = byKey.get(view.key)?.find((d) => !used.has(d.id))
    if (exact) {
      diagramByViewKey.set(view.key, exact)
      used.add(exact.id)
      continue
    }
    // T16: `key` is identity and `name` is computed, so a name match is a guess.
    // It is still made — an importer that forgot `sourceViewKey` has a real
    // diagram we should credit — but it is reported as the guess it is.
    const label = normalize(view.title) || view.key
    const candidates = byName.get(label.toLowerCase())?.filter((d) => !used.has(d.id)) ?? []
    const [candidate] = candidates
    if (candidates.length === 1 && candidate) {
      diagramByViewKey.set(view.key, candidate)
      used.add(candidate.id)
      weakKeys.push(view.key)
    }
  }

  return {
    diagramByViewKey,
    weakKeys,
    unexplained: result.diagrams.filter((d) => !used.has(d.id)),
  }
}

function measureViews(source: SzWorkspace, correlation: ViewCorrelation): ViewFidelity {
  const missing: MissingView[] = []
  const droppedByKind: Partial<Record<SzViewKind, number>> = {}
  for (const view of source.views) {
    if (correlation.diagramByViewKey.has(view.key)) continue
    missing.push({ key: view.key, kind: view.kind, title: view.title })
    droppedByKind[view.kind] = (droppedByKind[view.kind] ?? 0) + 1
  }
  return {
    expected: source.views.length,
    matched: source.views.length - missing.length,
    missing,
    droppedByKind,
    weaklyMatchedKeys: correlation.weakKeys,
    unexplainedDiagrams: correlation.unexplained.map((d) => ({ id: d.id, name: d.name })),
  }
}

// ── View membership ──────────────────────────────────────────────────────────

function measureViewMembership(
  source: SzWorkspace,
  correlation: ElementCorrelation,
  views: ViewCorrelation,
  objectsById: ReadonlyMap<string, C4Object>,
  groupsById: ReadonlyMap<string, Group>,
  claimedByRelationshipId: ReadonlyMap<string, Connection>,
): ViewMembershipFidelity {
  const details: ViewMembershipDetail[] = []
  const sourcesById = new Map(source.elements.map((e) => [e.id, e]))
  let expectedTotal = 0
  let presentTotal = 0
  let expectedRelationshipTotal = 0
  let presentRelationshipTotal = 0
  let viewsWithLoss = 0

  for (const view of source.views) {
    const diagram = views.diagramByViewKey.get(view.key)
    const expected = view.elements.length
    const drawnEdges = [...new Set(view.relationships.map((r) => r.id))]
    expectedTotal += expected
    expectedRelationshipTotal += drawnEdges.length
    if (!diagram) {
      // Counted as expected-but-absent; the view section already names the view
      // itself, so its members are not repeated as individual losses here.
      details.push({
        key: view.key,
        kind: view.kind,
        expected,
        present: 0,
        missing: [],
        extra: [],
        expectedRelationships: drawnEdges.length,
        presentRelationships: 0,
        missingRelationshipIds: [],
      })
      if (expected > 0) viewsWithLoss += 1
      continue
    }

    const onDiagram = new Set<string>([...diagram.objectIds, ...diagram.groupIds])
    const accountedFor = new Set<string>()
    const missing: SourceElementRef[] = []
    for (const member of view.elements) {
      const target = correlation.targetBySourceId.get(member.id)
      if (target && onDiagram.has(target.id)) {
        accountedFor.add(target.id)
        presentTotal += 1
        continue
      }
      // A view may list an id the model does not declare (§4.4 dangling
      // reference); it is still a member the customer expected to see.
      const el = sourcesById.get(member.id)
      missing.push({ id: member.id, name: el?.name ?? '(not in model)', kind: el?.kind ?? 'customElement' })
    }

    const extra = [...onDiagram]
      .filter((id) => !accountedFor.has(id))
      .map((id) => ({ id, name: objectsById.get(id)?.name ?? groupsById.get(id)?.name ?? '(unknown)' }))

    const onDiagramEdges = new Set(diagram.connectionIds)
    const missingRelationshipIds = drawnEdges.filter((id) => {
      const connection = claimedByRelationshipId.get(id)
      return !connection || !onDiagramEdges.has(connection.id)
    })
    presentRelationshipTotal += drawnEdges.length - missingRelationshipIds.length

    if (missing.length > 0 || extra.length > 0 || missingRelationshipIds.length > 0) viewsWithLoss += 1
    details.push({
      key: view.key,
      kind: view.kind,
      diagramId: diagram.id,
      expected,
      present: expected - missing.length,
      missing,
      extra,
      expectedRelationships: drawnEdges.length,
      presentRelationships: drawnEdges.length - missingRelationshipIds.length,
      missingRelationshipIds,
    })
  }

  return {
    expectedTotal,
    presentTotal,
    expectedRelationshipTotal,
    presentRelationshipTotal,
    viewsWithLoss,
    details,
  }
}

// ── Layout ───────────────────────────────────────────────────────────────────

function positionOf(
  diagram: Diagram,
  targetId: string,
  objectsById: ReadonlyMap<string, C4Object>,
  groupsById: ReadonlyMap<string, Group>,
): Position | undefined {
  // The per-diagram layout is authoritative; the object's own position is the
  // fallback for importers that place shapes globally. A shape with neither is
  // reported through `missingLayoutIds` rather than silently skipped.
  return (
    diagram.layouts?.[targetId]?.position ?? objectsById.get(targetId)?.position ?? groupsById.get(targetId)?.position
  )
}

interface ComparablePlacement {
  sourceId: string
  source: Position
  result: Position
}

interface AgreementResult {
  /** null when the file expresses no ordering on this axis (every pair a tie). */
  ratio: number | null
  inverted: number
}

function agreement(
  pairs: readonly ComparablePlacement[],
  axis: 'x' | 'y',
  examples: OrderingInversion[],
): AgreementResult {
  let comparable = 0
  let agreeing = 0
  let inverted = 0
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const a = pairs[i]
      const b = pairs[j]
      if (!a || !b) continue
      const sourceDelta = a.source[axis] - b.source[axis]
      if (sourceDelta === 0) continue // the file expresses no opinion about this pair
      comparable += 1
      const resultDelta = a.result[axis] - b.result[axis]
      const kept = Math.abs(resultDelta) > POSITION_EPSILON && Math.sign(resultDelta) === Math.sign(sourceDelta)
      if (kept) {
        agreeing += 1
        continue
      }
      inverted += 1
      if (examples.length < MAX_INVERSION_EXAMPLES) {
        examples.push({ axis, a: a.sourceId, b: b.sourceId, sourceDelta, resultDelta })
      }
    }
  }
  return { ratio: comparable === 0 ? null : agreeing / comparable, inverted }
}

function measureLayout(
  source: SzWorkspace,
  correlation: ElementCorrelation,
  views: ViewCorrelation,
  objectsById: ReadonlyMap<string, C4Object>,
  groupsById: ReadonlyMap<string, Group>,
  threshold: number,
): LayoutFidelity {
  const details: ViewLayoutDetail[] = []
  const counts = { preserved: 0, relaidOut: 0, sourceUnpositioned: 0, indeterminate: 0, notImported: 0 }

  const kindById = kindsOf(source)
  for (const view of source.views) {
    const diagram = views.diagramByViewKey.get(view.key)
    if (!diagram) {
      counts.notImported += 1
      details.push({
        key: view.key,
        kind: view.kind,
        classification: 'not-imported',
        comparableInSource: 0,
        positionedInResult: 0,
        derivedBoundaries: 0,
        missingLayoutIds: [],
        orderingAgreementX: null,
        orderingAgreementY: null,
        inversionCount: 0,
        inversions: [],
      })
      continue
    }

    const positioned = view.elements.filter(
      (e): e is { id: string; x: number; y: number } => typeof e.x === 'number' && typeof e.y === 'number',
    )
    // T10(b): a whole view of zeros means no layout was ever computed, so
    // re-laying it out is correct and there is nothing to compare against.
    // T10(c): a BOUNDARY's stored coordinate is not a shape's — an importer is
    // expected to derive that box from its children — so comparing it invents
    // inversions for a layout the customer would call untouched. Which elements
    // those are is `elementRole`'s judgement, not "the ones sitting on (0,0)":
    // filtering by the zero alone reported `deployment-positioned.json` as
    // SCRAMBLED, because its producer parks every node on a (175,175)
    // placeholder while its four leaves are in exact source order.
    const realCoordinates = positioned.filter(
      (e) => (e.x !== 0 || e.y !== 0) && elementRole(view as SzView, e.id, kindById) === 'leaf',
    )
    const derivedBoundaries = positioned.length - realCoordinates.length

    const missingLayoutIds: string[] = []
    const placements: ComparablePlacement[] = []
    for (const member of realCoordinates) {
      const target = correlation.targetBySourceId.get(member.id)
      if (!target) continue
      if (diagram.layouts && !diagram.layouts[target.id]) missingLayoutIds.push(target.id)
      const at = positionOf(diagram, target.id, objectsById, groupsById)
      if (at) placements.push({ sourceId: member.id, source: { x: member.x, y: member.y }, result: at })
    }

    const inversions: OrderingInversion[] = []
    const empty: AgreementResult = { ratio: null, inverted: 0 }
    const xAxis = realCoordinates.length === 0 ? empty : agreement(placements, 'x', inversions)
    const yAxis = realCoordinates.length === 0 ? empty : agreement(placements, 'y', inversions)
    const x = xAxis.ratio
    const y = yAxis.ratio
    const inversionCount = xAxis.inverted + yAxis.inverted

    let classification: LayoutClassification
    if (realCoordinates.length === 0) classification = 'source-unpositioned'
    else if (x === null && y === null) classification = 'indeterminate'
    else classification = Math.min(x ?? 1, y ?? 1) >= threshold ? 'preserved' : 'relaid-out'

    if (classification === 'preserved') counts.preserved += 1
    else if (classification === 'relaid-out') counts.relaidOut += 1
    else if (classification === 'source-unpositioned') counts.sourceUnpositioned += 1
    else counts.indeterminate += 1

    details.push({
      key: view.key,
      kind: view.kind,
      diagramId: diagram.id,
      classification,
      comparableInSource: realCoordinates.length,
      positionedInResult: placements.length,
      derivedBoundaries,
      missingLayoutIds,
      orderingAgreementX: x,
      orderingAgreementY: y,
      inversionCount,
      inversions,
    })
  }

  return { ...counts, details }
}

// ── Labels ───────────────────────────────────────────────────────────────────

function measureLabels(
  source: SzWorkspace,
  correlation: ElementCorrelation,
  claimedByRelationshipId: ReadonlyMap<string, Connection>,
): LabelFidelity {
  const elementNames: LabelTally = { compared: 0, changed: [], vanished: [] }
  for (const el of source.elements) {
    const target = correlation.targetBySourceId.get(el.id)
    if (!target) continue
    const from = normalize(el.name)
    if (!from) continue
    elementNames.compared += 1
    const to = normalize(target.name)
    if (!to) elementNames.vanished.push({ id: el.id, from })
    else if (to !== from) elementNames.changed.push({ id: el.id, from, to })
  }

  const relationshipDescriptions: LabelTally = { compared: 0, changed: [], vanished: [] }
  for (const rel of source.relationships) {
    const connection = claimedByRelationshipId.get(rel.id)
    if (!connection) continue
    const from = normalize(rel.description)
    // An edge the customer left undescribed cannot lose its description, and
    // counting it would inflate the denominator with guaranteed passes.
    if (!from) continue
    relationshipDescriptions.compared += 1
    const to = connectionLabel(connection)
    if (!to) relationshipDescriptions.vanished.push({ id: rel.id, from })
    else if (to !== from) relationshipDescriptions.changed.push({ id: rel.id, from, to })
  }

  return { elementNames, relationshipDescriptions }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function measureFidelity(
  source: SzWorkspace,
  result: ImportResult,
  options: FidelityOptions = {},
): FidelityReport {
  const sourceIdProperties = options.sourceIdProperties ?? [
    ...DEFAULT_SOURCE_ID_PROPERTIES,
    DSL_MAPPER_IDENTIFIER_PROPERTY,
  ]
  const threshold = options.layoutAgreementThreshold ?? DEFAULT_LAYOUT_AGREEMENT_THRESHOLD

  const objectsById = new Map(result.objects.map((o) => [o.id, o]))
  const groupsById = new Map(result.groups.map((g) => [g.id, g]))

  const groupNames = expectedGroupNames(source)
  const correlation = correlateElements(source, result, sourceIdProperties, groupNames)
  const viewCorrelation = correlateViews(source, result)
  const relationships = measureRelationships(source, result, correlation)

  return {
    workspaceName: source.name,
    elements: measureElements(source, result, correlation, groupNames),
    groups: measureGroups(source, result, groupNames),
    relationships: relationships.fidelity,
    views: measureViews(source, viewCorrelation),
    viewMembership: measureViewMembership(
      source,
      correlation,
      viewCorrelation,
      objectsById,
      groupsById,
      relationships.claimedByRelationshipId,
    ),
    layout: measureLayout(source, correlation, viewCorrelation, objectsById, groupsById, threshold),
    labels: measureLabels(source, correlation, relationships.claimedByRelationshipId),
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface FormatOptions {
  /** Items listed per section before the tail is summarised. */
  maxItems?: number
}

const DEFAULT_MAX_ITEMS = 15

function ratio(matched: number, expected: number): string {
  const pct = expected === 0 ? 100 : Math.round((matched / expected) * 1000) / 10
  return `${matched}/${expected} (${pct}%)`
}

function list(lines: readonly string[], maxItems: number, indent = '    '): string[] {
  const shown = lines.slice(0, maxItems).map((l) => `${indent}${l}`)
  if (lines.length > maxItems) shown.push(`${indent}… and ${lines.length - maxItems} more`)
  return shown
}

function tallyLine(label: string, tally: LabelTally): string {
  return `  ${label}: ${tally.changed.length} changed, ${tally.vanished.length} vanished (of ${tally.compared} compared)`
}

/**
 * Renders the report for a failing assertion. Optimised for the moment a
 * reviewer reads a CI log: the headline counts first, then the named losses,
 * because "which element" is the only question worth answering there.
 */
export function formatFidelityReport(report: FidelityReport, options: FormatOptions = {}): string {
  const max = options.maxItems ?? DEFAULT_MAX_ITEMS
  const out: string[] = [`Structurizr import fidelity — ${report.workspaceName}`]

  const { elements, groups, relationships, views, viewMembership, layout, labels } = report

  out.push(`  elements:      ${ratio(elements.matched, elements.expected)}`)
  const opaqueGroups = groups.expected > 0 && !groups.separatorDeclared
  out.push(
    `  groups:        ${ratio(groups.matched, groups.expected)}${opaqueGroups ? ' (no separator declared — group strings are opaque)' : ''}`,
  )
  out.push(
    `  relationships: authored ${ratio(relationships.authored.matched, relationships.authored.expected)} · derived ${ratio(relationships.derived.matched, relationships.derived.expected)}`,
  )
  out.push(`  views:         ${ratio(views.matched, views.expected)}`)
  out.push(
    `  membership:    ${ratio(viewMembership.presentTotal, viewMembership.expectedTotal)} placements · ${ratio(viewMembership.presentRelationshipTotal, viewMembership.expectedRelationshipTotal)} drawn edges · ${viewMembership.viewsWithLoss} view(s) affected`,
  )
  out.push(
    `  layout:        preserved ${layout.preserved} · re-laid-out ${layout.relaidOut} · source unpositioned ${layout.sourceUnpositioned} · indeterminate ${layout.indeterminate}`,
  )
  out.push(tallyLine('element names', labels.elementNames))
  out.push(tallyLine('edge labels  ', labels.relationshipDescriptions))

  if (elements.weaklyMatchedIds.length > 0) {
    out.push(
      `  NOTE: ${elements.weaklyMatchedIds.length} element(s) matched by name/path, not by a stamped source id — correlation here is a guess.`,
    )
  }

  if (elements.missing.length > 0) {
    out.push('', `MISSING ELEMENTS (${elements.missing.length})`)
    out.push(...list(elements.missing.map((e) => `${e.id} "${e.name}" (${e.kind})`), max))
  }
  if (elements.unexplainedTargets.length > 0) {
    out.push('', `INVENTED SHAPES — nothing in the source explains these (${elements.unexplainedTargets.length})`)
    out.push(...list(elements.unexplainedTargets.map((t) => `${t.kind} ${t.id} "${t.name}"`), max))
  }
  if (groups.missing.length > 0) {
    out.push('', `MISSING GROUPS (${groups.missing.length})`)
    out.push(...list(groups.missing.map((n) => `"${n}"`), max))
  }

  const describeEdge = (m: MissingRelationship) =>
    `${m.id} ${m.sourceId} → ${m.destinationId} "${m.description ?? ''}" [${m.reason}]`
  if (relationships.authored.missing.length > 0) {
    out.push('', `MISSING AUTHORED RELATIONSHIPS (${relationships.authored.missing.length}) — a loss here is a bug`)
    out.push(...list(relationships.authored.missing.map(describeEdge), max))
  }
  if (relationships.derived.missing.length > 0) {
    out.push(
      '',
      `MISSING DERIVED RELATIONSHIPS (${relationships.derived.missing.length}) — may be a decision (§13.2), confirm it is`,
    )
    out.push(...list(relationships.derived.missing.map(describeEdge), max))
  }
  if (relationships.unexplainedConnectionIds.length > 0) {
    out.push('', `INVENTED CONNECTIONS (${relationships.unexplainedConnectionIds.length})`)
    out.push(...list(relationships.unexplainedConnectionIds, max))
  }

  if (views.missing.length > 0) {
    const kinds = Object.entries(views.droppedByKind)
      .map(([kind, count]) => `${kind}×${count}`)
      .join(', ')
    out.push('', `MISSING VIEWS (${views.missing.length}) — kinds: ${kinds}`)
    out.push(...list(views.missing.map((v) => `${v.kind} "${v.key}"${v.title ? ` (${v.title})` : ''}`), max))
  }
  if (views.unexplainedDiagrams.length > 0) {
    out.push('', `INVENTED DIAGRAMS (${views.unexplainedDiagrams.length})`)
    out.push(...list(views.unexplainedDiagrams.map((d) => `${d.id} "${d.name}"`), max))
  }

  const damagedViews = viewMembership.details.filter(
    (d) => d.diagramId && (d.missing.length > 0 || d.extra.length > 0 || d.missingRelationshipIds.length > 0),
  )
  if (damagedViews.length > 0) {
    out.push('', `VIEW MEMBERSHIP (${damagedViews.length} view(s) do not contain what the file listed)`)
    for (const view of damagedViews) {
      out.push(
        `  view "${view.key}" (${view.kind}) — ${view.present}/${view.expected} elements, ${view.presentRelationships}/${view.expectedRelationships} edges`,
      )
      if (view.missing.length > 0) {
        out.push(...list(view.missing.map((e) => `absent: ${e.id} "${e.name}" (${e.kind})`), max, '      '))
      }
      if (view.missingRelationshipIds.length > 0) {
        out.push(...list(view.missingRelationshipIds.map((id) => `edge not drawn: ${id}`), max, '      '))
      }
      if (view.extra.length > 0) {
        out.push(...list(view.extra.map((e) => `unexpected: ${e.id} "${e.name}"`), max, '      '))
      }
    }
  }

  const scrambled = layout.details.filter((d) => d.classification === 'relaid-out')
  if (scrambled.length > 0) {
    out.push('', `LAYOUT NOT PRESERVED (${scrambled.length} view(s) that shipped real coordinates)`)
    for (const view of scrambled) {
      const fmt = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`)
      out.push(
        `  view "${view.key}" — ordering kept: x ${fmt(view.orderingAgreementX)}, y ${fmt(view.orderingAgreementY)} over ${view.comparableInSource} positioned element(s)`,
      )
      out.push(
        ...list(
          view.inversions.map(
            (i) => `${i.axis}: ${i.a} vs ${i.b} — source Δ${i.sourceDelta}, result Δ${Math.round(i.resultDelta)}`,
          ),
          max,
          '      ',
        ),
      )
    }
  }
  const unplaced = layout.details.filter((d) => d.missingLayoutIds.length > 0)
  if (unplaced.length > 0) {
    out.push('', `NO PER-DIAGRAM LAYOUT (${unplaced.length} view(s) with shapes missing from diagram.layouts)`)
    for (const view of unplaced) {
      out.push(`  view "${view.key}" — ${view.missingLayoutIds.length} shape(s)`)
      out.push(...list(view.missingLayoutIds, max, '      '))
    }
  }

  const labelLines = [
    ...labels.elementNames.changed.map((c) => `element ${c.id}: "${c.from}" → "${c.to}"`),
    ...labels.elementNames.vanished.map((v) => `element ${v.id}: "${v.from}" → (empty)`),
    ...labels.relationshipDescriptions.changed.map((c) => `edge ${c.id}: "${c.from}" → "${c.to}"`),
    ...labels.relationshipDescriptions.vanished.map((v) => `edge ${v.id}: "${v.from}" → (empty)`),
  ]
  if (labelLines.length > 0) {
    out.push('', `LABELS CHANGED (${labelLines.length})`)
    out.push(...list(labelLines, max))
  }

  return out.join('\n')
}
