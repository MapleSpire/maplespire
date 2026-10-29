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
 * `workspace.model` — the inverse of `lib/structurizr/json/mapWorkspace.ts`.
 *
 * Three shape changes happen here, and each is a place data can silently
 * disappear:
 *
 *  1. **Flat to tree.** MapleSpire objects carry `parentId`; the wire has no
 *     parent pointer at all, only JSON nesting (T4). `ExportContext` already
 *     resolved which element is emitted under which — this file nests by that
 *     answer and never re-derives it, or a container view ends up scoped to an
 *     element the model emitted one level down.
 *  2. **One graph into two.** The deployment tree is a second graph over the
 *     same containers. The importer flattened it into Groups (the nodes) plus
 *     objects (instances and childless nodes), and rebuilding it means
 *     recovering a containment the Group records only as membership.
 *  3. **Fields into strings.** `tags` is comma-separated (T1), `instances` is a
 *     string that may be a range (T15), and a nested `group` is one flat path
 *     whose separator has to be declared or every reader flattens it (T5).
 *
 * The one thing this file will not do is drop an element. An object whose
 * parent chain does not resolve, an instance whose target is gone, a deployment
 * element with no node above it — each lands somewhere legal, with a warning
 * naming what was degraded. A workspace that loses a shape on the way out is
 * the failure the whole export exists to prevent.
 */

import type { C4Object, Connection, DecisionRecord, Group, TechnologyUsage } from '../../../types'
import { objectLinkUrl } from '../../objectLinks'
import { SOURCE_IDENTIFIER_PROPERTY } from '../../structurizr/mapper'
import {
  CONNECTION_DESCRIPTION_PROPERTY,
  encodeOwners,
  SHORT_DESCRIPTION_PROPERTY,
  isDerivedMapleSpireKey,
  ownerNamesOf,
  technologyDetailProperties,
  technologyStringOf,
} from '../../structurizr/maplespireFacts'
import {
  BOUNDARY_FOR_PROPERTY,
  DEPLOYMENT_GROUPS_PROPERTY,
  DSL_IDENTIFIER_PROPERTY,
  ENVIRONMENT_PROPERTY,
  GROUP_PATH_PROPERTY,
  GROUP_SEPARATOR_PROPERTY,
  INSTANCES_PROPERTY,
  INTERACTION_STYLE_PROPERTY,
  LINKED_RELATIONSHIP_PROPERTY,
  NODE_TECHNOLOGY_PROPERTY,
  PERSPECTIVE_DESCRIPTION_SUFFIX,
  PERSPECTIVE_PREFIX,
  PROPERTY_ORIGINAL_SUFFIX,
  SOURCE_ID_PROPERTY,
  SOURCE_INSTANCE_OF_PROPERTY,
  STYLE_PREFIX,
  URL_PROPERTY,
} from '../../structurizr/json/provenance'
import { wireTagsWith } from './styles'
import {
  CONNECTION_KIND_PROPERTY,
  DOMAIN_ID_PROPERTY,
  DOMAIN_PROPERTY,
  EXTRA_LINKS_PROPERTY,
  MAPLESPIRE_DERIVED_PROPERTY_KEYS,
  OWNERS_PROPERTY,
  OWNER_TEAMS_PROPERTY,
  STATUS_PROPERTY,
  SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION,
  SYNTHETIC_UNGROUPED_SYSTEM_ENTITY_ID,
  SYNTHETIC_UNGROUPED_SYSTEM_NAME,
  TEAMS_PROPERTY,
  WIRE_DEFAULT_TAGS,
  depthsIn,
  nestGroupsByMembership,
  type ExportContext,
  type WireComponent,
  type WireContainer,
  type WireContainerInstance,
  type WireDecision,
  type WireDecisionLink,
  type WireDeploymentNode,
  type WireDocumentation,
  type WireElementKind,
  type WireInfrastructureNode,
  type WireInteractionStyle,
  type WireModel,
  type WirePerson,
  type WirePerspective,
  type WireProperties,
  type WireRelationship,
  type WireSoftwareSystem,
  type WireSoftwareSystemInstance,
} from './types'

// ── The importer's stamps ────────────────────────────────────────────────────
// Every key below is imported from `structurizr/json/provenance.ts`, which the
// IMPORTER also reads them from. Do not re-declare them here: a key spelled
// differently on the two sides is a divergence no type checker or test can
// see, and a customer's environment or group path silently absent from the
// exported file.

/**
 * Keys the IMPORT minted, which this file turns back into wire fields. Each one
 * is a field somewhere else in the output, so re-emitting it as a property would
 * state the same fact twice — and the copy goes stale the moment an id is
 * re-minted or a node is renamed.
 *
 * `MAPLESPIRE_DERIVED_PROPERTY_KEYS` is the same rule for the keys this EXPORT
 * mints (`maplespire.status` and friends): they are re-derived from the live
 * field on every export, so a copy read back off a previous one is stale by
 * construction.
 */
const INVERTED_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  SOURCE_ID_PROPERTY,
  SOURCE_IDENTIFIER_PROPERTY,
  SOURCE_INSTANCE_OF_PROPERTY,
  ENVIRONMENT_PROPERTY,
  INSTANCES_PROPERTY,
  DEPLOYMENT_GROUPS_PROPERTY,
  NODE_TECHNOLOGY_PROPERTY,
  URL_PROPERTY,
  GROUP_PATH_PROPERTY,
  GROUP_SEPARATOR_PROPERTY,
  BOUNDARY_FOR_PROPERTY,
  INTERACTION_STYLE_PROPERTY,
  LINKED_RELATIONSHIP_PROPERTY,
  ...MAPLESPIRE_DERIVED_PROPERTY_KEYS,
])

/** What the importer joined a deployment node's facts with for `Group.description`. */
const NODE_FACT_SEPARATOR = ' · '

/**
 * Between the line drawn on a connection and the Markdown behind it.
 *
 * Two blank-line-separated paragraphs, because the wire field is one string and
 * a reader renders it as Markdown — so the label stays the first line, which is
 * what a renderer that truncates will show, and the long half is still there for
 * anyone who opens it.
 */
const DESCRIPTION_SEPARATOR = '\n\n'

/** §5.2's default-tag table lives in `./types` — the model emitter writes it and
 *  the styles emitter has to simulate exactly what was written. */
const DEFAULT_TAGS = WIRE_DEFAULT_TAGS

const DEFAULT_ENVIRONMENT = 'Default'

// ── Small pure helpers ───────────────────────────────────────────────────────

function trimmed(value: string | undefined): string | undefined {
  const out = value?.trim()
  return out ? out : undefined
}

/** Order-preserving dedupe. Tag order is meaningful — the last matching style
 *  wins upstream — so this never sorts. */
function dedupe(values: Iterable<string>): string[] {
  const out: string[] = []
  for (const value of values) {
    const token = value.trim()
    if (token && !out.includes(token)) out.push(token)
  }
  return out
}

/** Joined on `","` and never `", "`: Structurizr splits on the bare comma, so a
 *  space would arrive as a leading space on every tag but the first. */
function tagString(defaults: readonly string[], author: readonly string[]): string {
  return dedupe([...defaults, ...author]).join(',')
}

interface TechnologyBearing {
  technologyUsages?: Record<string, TechnologyUsage>
  technologyUsageOrder?: string[]
}

/** Versions included (`"Angular 17, TypeScript"`) — the importer parses them
 *  back into `usedVersion`, and a Structurizr reader sees what an author would
 *  have written. Names alone dropped every version on export. */
function technologyOf(entity: TechnologyBearing): string | undefined {
  return trimmed(technologyStringOf(entity))
}

function urlOf(entity: Pick<C4Object, 'links'>): string | undefined {
  const first = entity.links?.[0]
  return first === undefined ? undefined : trimmed(objectLinkUrl(first))
}

/**
 * The `description` a reader draws on the box. MapleSpire splits the one field
 * the wire has in two — a compact line rendered on the shape, and unbounded
 * Markdown behind it — and the importer fills the Markdown one, so that is what
 * closes a round trip. A shape drawn here with only the compact line still has
 * something to say, hence the fallback.
 */
function descriptionOf(object: C4Object): string | undefined {
  return trimmed(object.description) ?? trimmed(object.shortDescription)
}

/**
 * §5.3, out of the two properties the importer split each perspective into.
 *
 * A perspective may legitimately be NAMED `Owner.description`, so the suffix
 * alone cannot decide: a `.description` key is read as a description only when
 * its stem is also present as a perspective in its own right.
 */
function perspectivesOf(properties: Readonly<Record<string, string>> | undefined): WirePerspective[] {
  if (!properties) return []
  const named = new Set<string>()
  for (const key of Object.keys(properties)) {
    if (!key.startsWith(PERSPECTIVE_PREFIX)) continue
    const name = key.slice(PERSPECTIVE_PREFIX.length)
    if (!name.endsWith(PERSPECTIVE_DESCRIPTION_SUFFIX)) named.add(name)
  }
  const values = new Map<string, string>()
  const descriptions = new Map<string, string>()
  for (const [key, value] of Object.entries(properties)) {
    if (!key.startsWith(PERSPECTIVE_PREFIX)) continue
    const name = key.slice(PERSPECTIVE_PREFIX.length)
    const stem = name.slice(0, -PERSPECTIVE_DESCRIPTION_SUFFIX.length)
    if (name.endsWith(PERSPECTIVE_DESCRIPTION_SUFFIX) && named.has(stem)) descriptions.set(stem, value)
    else values.set(name, value)
  }
  const out: WirePerspective[] = []
  for (const name of new Set([...values.keys(), ...descriptions.keys()])) {
    const value = values.get(name)
    const description = descriptions.get(name)
    out.push({ name, ...(value ? { value } : {}), ...(description ? { description } : {}) })
  }
  // `Perspective` sorts by name upstream, so a name-sorted array is what a
  // Structurizr-written file looks like and what a diff against one expects.
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Everything on the entity that is genuinely the customer's, as `properties`.
 *
 * `<key>.original` is the exact inverse of the importer's `withProvenance`: it
 * parks a customer property there when its name collided with one of our
 * stamps, so the export puts their value back under the name they chose.
 */
function wireProperties(own: Readonly<Record<string, string>> | undefined): WireProperties | undefined {
  if (!own) return undefined
  const out: WireProperties = {}
  for (const [key, value] of Object.entries(own)) {
    if (key.startsWith(PERSPECTIVE_PREFIX) || key.startsWith(STYLE_PREFIX)) continue
    if (INVERTED_PROPERTY_KEYS.has(key) || isDerivedMapleSpireKey(key)) continue
    const stem = key.endsWith(PROPERTY_ORIGINAL_SUFFIX) ? key.slice(0, -PROPERTY_ORIGINAL_SUFFIX.length) : undefined
    if (stem !== undefined && INVERTED_PROPERTY_KEYS.has(stem)) out[stem] = value
    else out[key] = value
  }
  const identifier = trimmed(own[SOURCE_IDENTIFIER_PROPERTY])
  if (identifier !== undefined && out[DSL_IDENTIFIER_PROPERTY] === undefined) {
    out[DSL_IDENTIFIER_PROPERTY] = identifier
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * `Model.hydrate` rule 14 refuses the whole workspace over a duplicate name in
 * any of five scopes, and MapleSpire happily holds two systems called
 * "Payments". Suffixing edits the customer's data visibly; a file that will not
 * open at all is worse, and the warning says which name moved.
 */
function createNamer(warn: (message: string) => void) {
  // NUL joins the composite keys in this file because it is the one character a
  // name, a scope id or a description cannot contain — any printable separator
  // makes `("a b", "c")` and `("a", "b c")` the same key.
  const used = new Set<string>()
  return (scope: string, name: string, what: string): string => {
    const base = name.trim() || '(unnamed)'
    let candidate = base
    for (let i = 2; used.has(`${scope}\u0000${candidate.toLowerCase()}`); i += 1) candidate = `${base} (${i})`
    used.add(`${scope}\u0000${candidate.toLowerCase()}`)
    if (candidate !== base) {
      warn(
        `${what} "${base}" shares its name with another one in the same scope; Structurizr refuses to open a ` +
          `workspace with duplicate names, so it was exported as "${candidate}".`,
      )
    }
    return candidate
  }
}

/**
 * Everything first-class in MapleSpire that Structurizr's model has no field
 * for, as `properties`.
 *
 * These were simply dropped — a shape's lifecycle status, the team that owns it,
 * the domain it belongs to, and every link after the first. `properties` is the
 * channel the format offers for a fact it does not model: it round-trips intact
 * through every reader, it is visible in Structurizr's own UI, and it is read
 * back as ordinary properties by our own importer. A warning naming the loss
 * would not have given a regulated customer their ownership metadata back.
 */
export function maplespireObjectProperties(ctx: ExportContext, object: C4Object): WireProperties {
  const out: WireProperties = {}
  // `live` is the seed every imported and every new shape carries, so stating it
  // would put a property on every element in the file for no information.
  if (object.status && object.status !== 'live') out[STATUS_PROPERTY] = object.status
  const domain = object.domainId ? ctx.bundle.domains.find((entry) => entry.id === object.domainId) : undefined
  if (object.domainId) out[DOMAIN_ID_PROPERTY] = object.domainId
  if (domain) out[DOMAIN_PROPERTY] = domain.name
  const owners = ownerNamesOf(object)
  if (owners.length) out[OWNERS_PROPERTY] = encodeOwners(owners)
  // The wire description carries the Markdown one (`descriptionOf`); the
  // compact line drawn on the shape had nowhere to go when both exist.
  const short = trimmed(object.shortDescription)
  if (short && trimmed(object.description) && short !== trimmed(object.description)) {
    out[SHORT_DESCRIPTION_PROPERTY] = short
  }
  Object.assign(out, technologyDetailProperties(object))
  if (object.ownerTeamIds?.length) out[OWNER_TEAMS_PROPERTY] = object.ownerTeamIds.join(', ')
  if (object.teamIds?.length) out[TEAMS_PROPERTY] = object.teamIds.join(', ')
  // `url` carries the first one; the rest had nowhere to go and were discarded
  // without a word.
  const extra = (object.links ?? []).slice(1).map(objectLinkUrl).filter((url): url is string => Boolean(url?.trim()))
  if (extra.length) out[EXTRA_LINKS_PROPERTY] = extra.join(' ')
  return out
}

/** The same for a connection: its lifecycle status and its MapleSpire kind. */
export function maplespireConnectionProperties(connection: Connection): WireProperties {
  const out: WireProperties = {}
  const status = (connection as { status?: string }).status
  if (status && status !== 'live') out[STATUS_PROPERTY] = status
  const kind = (connection as { kind?: string }).kind
  if (kind) out[CONNECTION_KIND_PROPERTY] = kind
  const owners = ownerNamesOf(connection)
  if (owners.length) out[OWNERS_PROPERTY] = encodeOwners(owners)
  if (connection.ownerTeamIds?.length) out[OWNER_TEAMS_PROPERTY] = connection.ownerTeamIds.join(', ')
  Object.assign(out, technologyDetailProperties(connection))
  // The Markdown also goes into the wire `description` (after the label, for a
  // Structurizr reader), but there it cannot be told apart from the label: a
  // connection whose label is empty or equals its technology writes the
  // Markdown ALONE. This is what lets an importer split the two exactly
  // (reviewer lens, 2026-10-21: the first paragraph used to become the label).
  const markdown = connection.description?.trim()
  if (markdown && markdown !== connection.label?.trim()) out[CONNECTION_DESCRIPTION_PROPERTY] = markdown
  return out
}

function kindLabel(kind: WireElementKind): string {
  switch (kind) {
    case 'person':
      return 'Person'
    case 'softwareSystem':
      return 'Software system'
    case 'container':
      return 'Container'
    default:
      return 'Component'
  }
}

// ── The model emitter ────────────────────────────────────────────────────────

export function buildWireModel(ctx: ExportContext): WireModel {
  const { bundle, ids, warn } = ctx
  const nameIn = createNamer(warn)

  // ── which objects belong to the deployment graph, not the static one ───────
  // Read off `ExportContext` rather than re-derived: as a LOCAL of this
  // function it would be invisible to the views emitter, which could then scope
  // a component view to an element this file had put in the deployment tree
  // (`ComponentView.containerId` naming a `DeploymentNode` is an unchecked
  // `ClassCastException` in `ViewSet.hydrate`) or name a wrapper system this
  // file never emitted (rule 4 — the workspace does not open at all).
  const deploymentObjectIds = ctx.deploymentObjectIds
  const isInstance = (object: C4Object): boolean => {
    const kind = ctx.deploymentKindByObjectId.get(object.id)
    return kind === 'containerInstance' || kind === 'softwareSystemInstance'
  }

  // ── rebuild the deployment tree ────────────────────────────────────────────
  const deploymentGroups = bundle.groups.filter((group) => ctx.groupRoleById.get(group.id) === 'deploymentNode')
  const membersOf = new Map<string, Set<string>>(
    deploymentGroups.map((group) => [group.id, new Set(group.objectIds.filter((id) => deploymentObjectIds.has(id)))]),
  )
  const declaredEnvironment = new Map(
    deploymentGroups.map((group) => [group.id, trimmed(group.properties?.[ENVIRONMENT_PROPERTY])]),
  )

  /**
   * A node's parent is the tightest node whose members include all of its own —
   * `nestGroupsByMembership`, the same reading model groups get in
   * `buildExportContext`. Environments are separate trees, so a declared
   * mismatch disqualifies.
   */
  const parentGroupId = nestGroupsByMembership(
    deploymentGroups,
    (group) => membersOf.get(group.id)!,
    (child, parent) => {
      const mine = declaredEnvironment.get(child.id)
      const theirs = declaredEnvironment.get(parent.id)
      return mine === undefined || theirs === undefined || mine === theirs
    },
  )

  const depthOf = depthsIn(
    deploymentGroups.map((group) => group.id),
    parentGroupId,
  )
  const groupDepth = (groupId: string): number => depthOf.get(groupId) ?? 0

  const environmentOf = new Map<string, string>()
  for (const group of [...deploymentGroups].sort((a, b) => groupDepth(a.id) - groupDepth(b.id))) {
    const parent = parentGroupId.get(group.id)
    const inherited = parent === undefined ? undefined : environmentOf.get(parent)
    const fromMember = [...membersOf.get(group.id)!]
      .map((id) => trimmed(ctx.objectById.get(id)?.properties?.[ENVIRONMENT_PROPERTY]))
      .find((value) => value !== undefined)
    environmentOf.set(group.id, declaredEnvironment.get(group.id) ?? inherited ?? fromMember ?? DEFAULT_ENVIRONMENT)
  }

  // An object three nodes deep is a member of all three groups (the importer
  // makes a node's members its whole subtree, so the box wraps it); only the
  // deepest one actually contains it on the wire.
  const ownerGroupId = new Map<string, string>()
  for (const group of deploymentGroups) {
    for (const objectId of membersOf.get(group.id)!) {
      const current = ownerGroupId.get(objectId)
      if (current === undefined || groupDepth(group.id) > groupDepth(current)) ownerGroupId.set(objectId, group.id)
    }
  }

  // ── ids: every element before any relationship ─────────────────────────────
  // `ExportIds` gives a contested `structurizr.id` to whoever asks first, and
  // upstream one counter issues element and relationship ids alike (§4.5). An
  // element that lost its id to an edge would break every view row naming it.
  for (const object of bundle.objects) ids.wireId(object)
  for (const group of deploymentGroups) ids.wireId(group)

  const objectByCarriedId = new Map<string, C4Object>()
  for (const object of bundle.objects) {
    const carried = trimmed(object.properties?.[SOURCE_ID_PROPERTY])
    if (carried !== undefined && !objectByCarriedId.has(carried)) objectByCarriedId.set(carried, object)
  }

  // ── relationships, nested under their SOURCE (T6) ──────────────────────────
  const connectionByCarriedId = new Map<string, Connection>()
  for (const connection of bundle.connections) {
    const carried = trimmed(connection.properties?.[SOURCE_ID_PROPERTY])
    if (carried !== undefined && !connectionByCarriedId.has(carried)) connectionByCarriedId.set(carried, connection)
  }

  const relationshipsBySource = new Map<string, WireRelationship[]>()
  const takenDescriptions = new Set<string>()
  for (const connection of bundle.connections) {
    const from = ctx.objectById.get(connection.fromId)
    const to = ctx.objectById.get(connection.toId)
    if (from === undefined || to === undefined) {
      warn(
        `The connection "${connection.label || connection.id}" points at a shape that is not in this export, so it ` +
          `could not be written.`,
      )
      continue
    }
    const sourceId = ids.wireId(from)
    const destinationId = ids.wireId(to)
    const technology = technologyOf(connection)
    // `label` was filled from the wire's description OR, when that was empty,
    // from its technology. Re-emitting a label equal to the technology as a
    // description would invent one — and the next import rebuilds that same
    // label from `technology` either way, so nothing is lost by leaving it off.
    const label = trimmed(connection.label)
    const authored = trimmed(connection.description)
    // MapleSpire splits what the wire holds in one field: a short label drawn on
    // the line, and unbounded Markdown behind it. The wire has `description` and
    // nothing else, so BOTH have to go there or the long half never leaves the
    // app — this read `label` alone, so every word a customer wrote about a
    // connection was dropped silently, on every export, and no round trip could
    // see it because the importer only ever fills `label`.
    const drawn = label === technology ? undefined : label
    let description =
      authored === undefined || authored === drawn
        ? drawn
        : drawn === undefined
          ? authored
          : `${drawn}${DESCRIPTION_SEPARATOR}${authored}`

    // Rule 15 is a HARD read failure: `(destination, description)` must be
    // unique among one element's outgoing edges. Two identically-labelled edges
    // between one pair are legal here and fatal there, so the later one is
    // qualified rather than dropped — a relabelled edge is recoverable, a
    // missing edge is not.
    const keyFor = (value: string | undefined) => `${sourceId}\u0000${destinationId}\u0000${value ?? ''}`
    if (takenDescriptions.has(keyFor(description))) {
      let attempt = 2
      let candidate = `${label ?? ''} (${attempt})`.trim()
      while (takenDescriptions.has(keyFor(candidate))) {
        attempt += 1
        candidate = `${label ?? ''} (${attempt})`.trim()
      }
      warn(
        `Two connections run from "${from.name}" to "${to.name}" with the same label; Structurizr allows only one, ` +
          `so the second was exported as "${candidate}".`,
      )
      description = candidate
    }
    takenDescriptions.add(keyFor(description))

    const properties = connection.properties
    const rawStyle = trimmed(properties?.[INTERACTION_STYLE_PROPERTY])
    const interactionStyle: WireInteractionStyle | undefined =
      rawStyle === 'Synchronous' || rawStyle === 'Asynchronous' ? rawStyle : undefined

    // T7: present means DERIVED, and a dangling one is a hard read failure
    // (rule 16). So the link is emitted only when the edge it names is in this
    // file too — and under its NEW id, which re-minting may have changed.
    const linkedCarried = trimmed(properties?.[LINKED_RELATIONSHIP_PROPERTY])
    const linkedConnection = linkedCarried === undefined ? undefined : connectionByCarriedId.get(linkedCarried)
    const linkedRelationshipId = linkedConnection === undefined ? undefined : ids.wireId(linkedConnection)
    if (linkedCarried !== undefined && linkedRelationshipId === undefined) {
      warn(
        `"${connection.label || connection.id}" was derived from a relationship that is no longer in the model, so ` +
          `it was exported as an authored relationship instead.`,
      )
    }

    const author = ctx.tagValues(connection)
    // §5.4: a derived edge has no default tags at all, not even `Relationship`.
    const tags =
      linkedRelationshipId === undefined
        ? tagString(['Relationship', ...(interactionStyle ? [interactionStyle] : [])], author)
        : dedupe(author).join(',')
    const url = trimmed(properties?.[URL_PROPERTY])
    const wireProps = { ...wireProperties(properties), ...maplespireConnectionProperties(connection) }
    const perspectives = perspectivesOf(properties)

    const relationship: WireRelationship = {
      id: ids.wireId(connection),
      sourceId,
      destinationId,
      ...(description ? { description } : {}),
      ...(technology ? { technology } : {}),
      ...(tags ? { tags } : {}),
      ...(interactionStyle ? { interactionStyle } : {}),
      ...(linkedRelationshipId ? { linkedRelationshipId } : {}),
      ...(url ? { url } : {}),
      ...(Object.keys(wireProps).length ? { properties: wireProps } : {}),
      ...(perspectives.length ? { perspectives } : {}),
    }
    const bucket = relationshipsBySource.get(connection.fromId)
    if (bucket) bucket.push(relationship)
    else relationshipsBySource.set(connection.fromId, [relationship])
  }

  // ── static elements ────────────────────────────────────────────────────────
  const common = (object: C4Object, kind: WireElementKind, defaults: readonly string[], scope: string) => {
    const description = descriptionOf(object)
    const group = ctx.groupPathByObjectId.get(object.id)
    const url = urlOf(object)
    const properties = { ...wireProperties(object.properties), ...maplespireObjectProperties(ctx, object) }
    const perspectives = perspectivesOf(object.properties)
    const relationships = relationshipsBySource.get(object.id) ?? []
    return {
      id: ids.wireId(object),
      name: nameIn(scope, object.name, kindLabel(kind)),
      ...(description ? { description } : {}),
      // ONE reading of the wire tag list, shared with the styles emitter, which
      // has to simulate exactly what is written here: a `Cylinder` hung on
      // `Database` and an `icon` hung on `ms-icon-react` draw nothing unless the
      // element carries those exact tags, and two emitters guessing separately
      // is how icons go missing and how a customer's `Pipe` becomes a Cylinder.
      tags: wireTagsWith(ctx, object, defaults).join(','),
      ...(group ? { group } : {}),
      ...(url ? { url } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
      ...(perspectives.length ? { perspectives } : {}),
      ...(relationships.length ? { relationships } : {}),
    }
  }

  /** Children the STATIC tree owns. A shape someone nested under an instance is
   *  claimed by the deployment tree and must not be emitted twice. */
  const staticChildren = (objectId: string): C4Object[] =>
    ctx
      .childObjectIds(objectId)
      .filter((childId) => !deploymentObjectIds.has(childId))
      .map((childId) => ctx.objectById.get(childId))
      .filter((child): child is C4Object => child !== undefined)

  const emitComponent = (object: C4Object, scope: string): WireComponent => {
    const technology = technologyOf(object)
    return {
      ...common(object, 'component', DEFAULT_TAGS.component, scope),
      ...(technology ? { technology } : {}),
    }
  }

  const emitContainer = (object: C4Object, scope: string): WireContainer => {
    const technology = technologyOf(object)
    const components = staticChildren(object.id).map((child) => emitComponent(child, `component:${object.id}`))
    return {
      ...common(object, 'container', DEFAULT_TAGS.container, scope),
      ...(technology ? { technology } : {}),
      ...(components.length ? { components } : {}),
    }
  }

  const emitSystem = (object: C4Object): WireSoftwareSystem => {
    const containers = staticChildren(object.id).map((child) => emitContainer(child, `container:${object.id}`))
    return {
      ...common(object, 'softwareSystem', DEFAULT_TAGS.softwareSystem, 'softwareSystem'),
      ...(containers.length ? { containers } : {}),
    }
  }

  const roots = ctx.rootObjectIds
    .filter((objectId) => !deploymentObjectIds.has(objectId))
    .map((objectId) => ctx.objectById.get(objectId))
    .filter((object): object is C4Object => object !== undefined)

  const people: WirePerson[] = roots
    .filter((object) => ctx.kindByObjectId.get(object.id) === 'person')
    .map((object) => common(object, 'person', DEFAULT_TAGS.person, 'person'))

  const softwareSystems: WireSoftwareSystem[] = roots
    .filter((object) => ctx.kindByObjectId.get(object.id) === 'softwareSystem')
    .map(emitSystem)

  // Everything the static walk above will have reached, so that nothing falls
  // between the two graphs: a shape nested under an instance has neither a
  // system above it nor a place in the deployment tree, and dropping it is
  // exactly the silent loss this exporter exists to avoid.
  const reachable = new Set<string>()
  const markReachable = (objectId: string) => {
    if (reachable.has(objectId)) return
    reachable.add(objectId)
    for (const child of staticChildren(objectId)) markReachable(child.id)
  }
  for (const object of roots) markReachable(object.id)

  const stranded = bundle.objects.filter(
    (object) => !reachable.has(object.id) && !deploymentObjectIds.has(object.id),
  )
  const strandedIds = new Set(stranded.map((object) => object.id))
  const wrapped = [
    ...ctx.orphanObjectIds
      .filter((objectId) => !deploymentObjectIds.has(objectId))
      .map((objectId) => ctx.objectById.get(objectId))
      .filter((object): object is C4Object => object !== undefined),
    // Only the TOP of each stranded subtree; `emitContainer` recurses into the rest.
    ...stranded.filter((object) => {
      const parent = ctx.wireParentByObjectId.get(object.id)
      return parent === undefined || !strandedIds.has(parent)
    }),
  ]

  // A container is not legal at the top of the model, and dropping one loses a
  // shape the customer drew, so the leftovers get a wrapper system — the answer
  // the DSL exporter already gives, under a shared entity id so the views
  // emitter cannot mint a second wrapper of its own.
  if (wrapped.length > 0) {
    warn(
      `${wrapped.length} shape(s) sit outside any software system, which the format has no place for; they were ` +
        `exported inside a system called "Ungrouped".`,
    )
    softwareSystems.push({
      id: ids.wireId({ id: SYNTHETIC_UNGROUPED_SYSTEM_ENTITY_ID }),
      name: nameIn('softwareSystem', SYNTHETIC_UNGROUPED_SYSTEM_NAME, 'Software system'),
      description: SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION,
      tags: tagString(DEFAULT_TAGS.softwareSystem, []),
      containers: wrapped.map((object) => emitContainer(object, `container:${SYNTHETIC_UNGROUPED_SYSTEM_ENTITY_ID}`)),
    })
  }

  // ── deployment elements ────────────────────────────────────────────────────

  /** §5.5's inheritance, run backwards. `getAllDeploymentGroups()` is the union
   *  down the whole ancestor chain and the importer materialised that union, so
   *  echoing it would re-declare every ancestor's groups at every level — which
   *  is T27's actual damage, in a different place. */
  const ownDeploymentGroups = (raw: string | undefined, inherited: readonly string[]): string[] => {
    const inheritedSet = new Set(inherited)
    return dedupe((raw ?? '').split(',')).filter((group) => !inheritedSet.has(group))
  }

  const instanceCounters = new Map<string, number>()
  const nextInstanceId = (nodeKey: string, targetWireId: string): number => {
    const key = `${nodeKey}\u0000${targetWireId}`
    const next = (instanceCounters.get(key) ?? 0) + 1
    instanceCounters.set(key, next)
    return next
  }

  const emitInfrastructureNode = (object: C4Object, nodeKey: string, environment: string): WireInfrastructureNode => {
    const technology = technologyOf(object)
    return {
      ...common(object, 'container', DEFAULT_TAGS.infrastructureNode, `infrastructure:${nodeKey}`),
      environment,
      ...(technology ? { technology } : {}),
    }
  }

  /**
   * A deployment node the importer drew as a shape rather than a boundary — one
   * with nothing under it. `instances` is the discriminator: §5.5 gives it to
   * deployment nodes and withholds it from infrastructure nodes, which are
   * leaves that host nothing, and it is the only surviving trace of which kind
   * the element was.
   */
  const isLeafDeploymentNode = (object: C4Object): boolean =>
    ctx.deploymentKindByObjectId.get(object.id) === 'deploymentNode' &&
    trimmed(object.properties?.[INSTANCES_PROPERTY]) !== undefined

  const emitLeafNode = (
    object: C4Object,
    scope: string,
    environment: string,
    inherited: readonly string[],
  ): WireDeploymentNode => {
    const technology = technologyOf(object)
    const instances = trimmed(object.properties?.[INSTANCES_PROPERTY])
    const own = ownDeploymentGroups(object.properties?.[DEPLOYMENT_GROUPS_PROPERTY], inherited)
    return {
      ...common(object, 'container', DEFAULT_TAGS.deploymentNode, scope),
      environment,
      ...(technology ? { technology } : {}),
      ...(instances ? { instances } : {}),
      ...(own.length ? { deploymentGroups: own } : {}),
    }
  }

  const emitInstance = (
    object: C4Object,
    nodeKey: string,
    environment: string,
    inherited: readonly string[],
  ): WireContainerInstance | WireSoftwareSystemInstance | WireInfrastructureNode => {
    const carried = trimmed(object.properties?.[SOURCE_INSTANCE_OF_PROPERTY])!
    const target = objectByCarriedId.get(carried)
    if (target === undefined) {
      warn(
        `"${object.name}" is an instance of something that is no longer in the model; it was exported as an ` +
          `infrastructure node so the deployment view keeps its box.`,
      )
      return emitInfrastructureNode(object, nodeKey, environment)
    }
    const targetWireId = ids.wireId(target)
    const targetKind = ctx.kindByObjectId.get(target.id)
    // The wire has no component instance. Re-homing the arrow onto the
    // component's container would move the customer's edge, so it goes out as
    // one of the two kinds that exist and the warning names the compromise.
    if (targetKind === 'component') {
      warn(
        `"${object.name}" instantiates a component, which Structurizr cannot instantiate; it was exported as a ` +
          `container instance.`,
      )
    }
    const isSystemInstance = targetKind === 'softwareSystem'
    // The importer merged the instantiated element's tags into the instance
    // (`dedupe([...display.tags, ...el.tags])`) because that is what style
    // resolution does upstream; on the wire an instance carries none of them
    // (§5.5), so they come back off here.
    const inheritedTags = new Set(ctx.tagValues(target))
    const own = ctx.tagValues(object).filter((tag) => !inheritedTags.has(tag))
    const url = urlOf(object)
    const group = ctx.groupPathByObjectId.get(object.id)
    const properties = wireProperties(object.properties)
    const perspectives = perspectivesOf(object.properties)
    const relationships = relationshipsBySource.get(object.id) ?? []
    const deploymentGroupNames = ownDeploymentGroups(object.properties?.[DEPLOYMENT_GROUPS_PROPERTY], inherited)
    const shared = {
      id: ids.wireId(object),
      instanceId: nextInstanceId(nodeKey, targetWireId),
      environment,
      tags: tagString(
        isSystemInstance ? DEFAULT_TAGS.softwareSystemInstance : DEFAULT_TAGS.containerInstance,
        own,
      ),
      ...(deploymentGroupNames.length ? { deploymentGroups: deploymentGroupNames } : {}),
      ...(group ? { group } : {}),
      // An instance has no name, description or technology of its own upstream,
      // and the importer read the target's when the instance had none — so a
      // url identical to the target's was never on the instance to begin with.
      ...(url && url !== urlOf(target) ? { url } : {}),
      ...(properties ? { properties } : {}),
      ...(perspectives.length ? { perspectives } : {}),
      ...(relationships.length ? { relationships } : {}),
    }
    return isSystemInstance
      ? { ...shared, softwareSystemId: targetWireId }
      : { ...shared, containerId: targetWireId }
  }

  /**
   * The node's own description, out of the string the importer joined its facts
   * into. Only segments equal to a fact we can name are dropped, so a
   * description that itself contains the separator survives intact.
   */
  const nodeDescription = (group: Group, technology: string | undefined, instances: string | undefined) => {
    const raw = trimmed(group.description)
    if (raw === undefined) return undefined
    const derived = new Set<string>()
    if (technology) derived.add(technology)
    if (instances && instances !== '1') derived.add(`${instances} instances`)
    const declared = declaredEnvironment.get(group.id)
    if (declared) derived.add(`Environment: ${declared}`)
    return trimmed(raw.split(NODE_FACT_SEPARATOR).filter((part) => !derived.has(part)).join(NODE_FACT_SEPARATOR))
  }

  const childGroupsOf = new Map<string, Group[]>()
  for (const group of deploymentGroups) {
    const parent = parentGroupId.get(group.id)
    if (parent === undefined) continue
    const bucket = childGroupsOf.get(parent)
    if (bucket) bucket.push(group)
    else childGroupsOf.set(parent, [group])
  }

  const emitNode = (group: Group, inherited: readonly string[]): WireDeploymentNode => {
    const environment = environmentOf.get(group.id)!
    const parent = parentGroupId.get(group.id)
    const technology = trimmed(group.properties?.[NODE_TECHNOLOGY_PROPERTY]) ?? technologyOf(group)
    const instances = trimmed(group.properties?.[INSTANCES_PROPERTY])
    const own = ownDeploymentGroups(group.properties?.[DEPLOYMENT_GROUPS_PROPERTY], inherited)
    const effective = dedupe([...inherited, ...own])
    // Rule 14 scopes deployment-node names by environment at the top level and
    // by parent below it.
    const scope = parent === undefined ? `deploymentRoot:${environment}` : `deploymentChild:${parent}`

    const owned = [...(membersOf.get(group.id) ?? [])]
      .filter((objectId) => ownerGroupId.get(objectId) === group.id)
      .map((objectId) => ctx.objectById.get(objectId))
      .filter((object): object is C4Object => object !== undefined)

    const children: WireDeploymentNode[] = [
      ...(childGroupsOf.get(group.id) ?? []).map((child) => emitNode(child, effective)),
      ...owned
        .filter(isLeafDeploymentNode)
        .map((object) => emitLeafNode(object, `deploymentChild:${group.id}`, environment, effective)),
    ]
    const infrastructureNodes: WireInfrastructureNode[] = []
    const containerInstances: WireContainerInstance[] = []
    const softwareSystemInstances: WireSoftwareSystemInstance[] = []
    for (const object of owned) {
      if (isLeafDeploymentNode(object)) continue
      if (!isInstance(object)) {
        infrastructureNodes.push(emitInfrastructureNode(object, group.id, environment))
        continue
      }
      const emitted = emitInstance(object, group.id, environment, effective)
      if ('containerId' in emitted) containerInstances.push(emitted)
      else if ('softwareSystemId' in emitted) softwareSystemInstances.push(emitted)
      else infrastructureNodes.push(emitted)
    }

    const description = nodeDescription(group, technology, instances)
    const url = trimmed(group.properties?.[URL_PROPERTY])
    const properties = wireProperties(group.properties)
    return {
      id: ids.wireId(group),
      name: nameIn(scope, group.name, 'Deployment node'),
      ...(description ? { description } : {}),
      tags: tagString(DEFAULT_TAGS.deploymentNode, ctx.tagValues(group)),
      environment,
      ...(technology ? { technology } : {}),
      ...(instances ? { instances } : {}),
      ...(own.length ? { deploymentGroups: own } : {}),
      ...(url ? { url } : {}),
      ...(properties ? { properties } : {}),
      ...(children.length ? { children } : {}),
      ...(infrastructureNodes.length ? { infrastructureNodes } : {}),
      ...(containerInstances.length ? { containerInstances } : {}),
      ...(softwareSystemInstances.length ? { softwareSystemInstances } : {}),
    }
  }

  const deploymentNodes: WireDeploymentNode[] = deploymentGroups
    .filter((group) => parentGroupId.get(group.id) === undefined)
    .map((group) => emitNode(group, []))

  // Deployment elements whose node is gone. A node is the only thing legal at
  // the top of `model.deploymentNodes`, so a stray node or infrastructure node
  // goes out as one; an instance cannot, and gets a wrapper per environment.
  const wrappers = new Map<string, { node: WireDeploymentNode; containers: WireContainerInstance[]; systems: WireSoftwareSystemInstance[]; infrastructure: WireInfrastructureNode[] }>()
  for (const objectId of deploymentObjectIds) {
    if (ownerGroupId.get(objectId) !== undefined) continue
    const object = ctx.objectById.get(objectId)
    if (object === undefined) continue
    const environment = trimmed(object.properties?.[ENVIRONMENT_PROPERTY]) ?? DEFAULT_ENVIRONMENT
    if (!isInstance(object)) {
      warn(
        `"${object.name}" is a deployment element with no node above it; it was exported as a top-level deployment ` +
          `node.`,
      )
      deploymentNodes.push(emitLeafNode(object, `deploymentRoot:${environment}`, environment, []))
      continue
    }
    let wrapper = wrappers.get(environment)
    if (wrapper === undefined) {
      warn(
        `One or more instances in the "${environment}" environment have no deployment node above them; they were ` +
          `exported inside a node called "Deployment".`,
      )
      const containers: WireContainerInstance[] = []
      const systems: WireSoftwareSystemInstance[] = []
      const infrastructure: WireInfrastructureNode[] = []
      const node: WireDeploymentNode = {
        id: ids.wireId({ id: `structurizr-export:deployment:${environment}` }),
        name: nameIn(`deploymentRoot:${environment}`, 'Deployment', 'Deployment node'),
        tags: tagString(DEFAULT_TAGS.deploymentNode, []),
        environment,
        containerInstances: containers,
        softwareSystemInstances: systems,
        infrastructureNodes: infrastructure,
      }
      wrapper = { node, containers, systems, infrastructure }
      wrappers.set(environment, wrapper)
      deploymentNodes.push(node)
    }
    const emitted = emitInstance(object, `wrapper:${environment}`, environment, [])
    if ('containerId' in emitted) wrapper.containers.push(emitted)
    else if ('softwareSystemId' in emitted) wrapper.systems.push(emitted)
    else wrapper.infrastructure.push(emitted)
  }

  // T5's `structurizr.groupSeparator` is NOT written here. It is a statement
  // about the bytes — "one of the `group` strings in this file is a path" — and
  // `index.ts` reads it off the emitted model, which is the only place that
  // question can be answered. Answering it from the input index as well was one
  // fact with two readings, and the copy that could disagree was this one.
  // The domain catalog. Structurizr models no such concept, and `properties` is
  // the channel the format offers for a fact it does not model — round-tripped
  // intact by every reader and visible in Structurizr's own UI. Nothing here
  // read `bundle.domains` at all, so a domain-organised estate left with that
  // whole dimension erased and no diagnostic.
  const domainProperties: WireProperties = {}
  for (const domain of bundle.domains) {
    domainProperties[`${DOMAIN_PROPERTY}.${domain.id}`] = domain.name
  }
  const properties: WireProperties | undefined =
    Object.keys(domainProperties).length > 0 ? domainProperties : undefined

  return {
    ...(properties ? { properties } : {}),
    ...(people.length ? { people } : {}),
    ...(softwareSystems.length ? { softwareSystems } : {}),
    ...(deploymentNodes.length ? { deploymentNodes } : {}),
  }
}

// ── Documentation ────────────────────────────────────────────────────────────

/** `yyyy-MM-dd'T'HH:mm:ss'Z'` — the millisecond field `toISOString` adds is not
 *  in the format's pattern. */
function wireDate(value: string, fallback: string): string {
  const parsed = new Date(value)
  const iso = Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
  return iso.replace(/\.\d+Z$/, 'Z')
}

/** ADR status onto Structurizr's conventional vocabulary. The wire field is
 *  free-form (§5.6), so this is a courtesy to a reader that groups by the usual
 *  five — not a constraint, and not a validated enum. */
function wireStatus(status: DecisionRecord['status']): string {
  switch (status) {
    case 'approved':
      return 'Accepted'
    case 'rejected':
      return 'Rejected'
    default:
      return 'Proposed'
  }
}

/**
 * Decision records only. MapleSpire has no workspace-level prose to put in
 * `sections[]` — an object's documentation is already its element `description`,
 * and duplicating it into a section would produce two copies that drift.
 */
export function buildWireDocumentation(ctx: ExportContext): WireDocumentation | undefined {
  const records = ctx.bundle.decisionRecords
  if (records.length === 0) return undefined

  // Decision ids are arbitrary strings (§4.5) and the ADR number is the one a
  // reader shows, so that is the first choice. Falling back to the record's own
  // id keeps two records sharing a number distinguishable, and `links[]`
  // resolves through this map either way.
  const wireIdByRecord = new Map<string, string>()
  const used = new Set<string>()
  for (const record of records) {
    let candidate = String(record.number)
    if (used.has(candidate)) candidate = record.id
    for (let i = 2; used.has(candidate); i += 1) candidate = `${record.id}-${i}`
    used.add(candidate)
    wireIdByRecord.set(record.id, candidate)
  }

  /**
   * §5.6: CR and CRLF in decision content are normalised to LF.
   *
   * A Windows-authored record otherwise reads back CHANGED on every round trip
   * and shows up in the customer's git history as a diff that is not a change —
   * the same class of problem `canonicalise` exists to solve for key order.
   */
  const normalisedContent = (value: string): string => value.replace(/\r\n?/g, '\n')

  /**
   * The summary, folded into `content`.
   *
   * `WireDecision` has no field for it — the wire's decision is title, date,
   * status and one body — and it is the one line of a decision most people read.
   * Emitting it as the body's first paragraph is the only place it fits; the
   * alternative is to drop it.
   */
  const bodyOf = (record: DecisionRecord): string | undefined => {
    const summary = normalisedContent(record.summary ?? '').trim()
    const content = normalisedContent(record.content ?? '')
    if (!summary) return content.trim() ? content : undefined
    // Not repeated when the body already opens with it, which is the shape an
    // ADR template usually produces.
    if (content.trimStart().startsWith(summary)) return content
    return content.trim() ? `${summary}${DESCRIPTION_SEPARATOR}${content}` : summary
  }

  const decisions: WireDecision[] = records.map((record) => {
    const links: WireDecisionLink[] = (record.related ?? [])
      .filter((link) => link.type === 'adr' && link.targetId !== undefined && wireIdByRecord.has(link.targetId))
      .map((link) => ({
        id: wireIdByRecord.get(link.targetId!)!,
        ...(link.label.trim() ? { description: link.label.trim() } : {}),
      }))
    const content = bodyOf(record)
    return {
      id: wireIdByRecord.get(record.id)!,
      title: record.title,
      date: wireDate(record.createdAt, ctx.now),
      status: wireStatus(record.status),
      ...(content ? { content } : {}),
      format: 'Markdown',
      ...(links.length ? { links } : {}),
    }
  })

  return { decisions }
}
