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
 * Tolerant reader: raw Structurizr workspace JSON -> the `SzWorkspace` IR.
 *
 * Two rules govern everything here, and they pull in opposite directions.
 *
 * REFUSE THE WHOLE DOCUMENT only when it is not an importable workspace at all
 * (§4.4's last row): unparseable, not an object, or client-side encrypted. An
 * encrypted workspace is the dangerous one — it parses as a *valid* workspace
 * with an empty model, so an importer that does not test for it reports
 * "imported 0 elements" as a success (§9.2 / T26).
 *
 * NEVER REFUSE A SUB-OBJECT. Five independent producers write this format and
 * they disagree about nulls, casing, and whether `tags` is even a string (§12).
 * A perspective with no name, a view with no key, a relationship with no
 * destination — each is a warning and a skipped row, never a lost workspace.
 * `warnings` is the import report; nothing here is allowed to be silent.
 *
 * Field names, wire types and defaults come from docs/structurizr-json-format.md
 * (verified against structurizr/structurizr @main, v6.2.2). Section references
 * below point into it.
 */

import {
  StructurizrJsonError,
  type SzElement,
  type SzElementKind,
  type SzElementStyle,
  type SzElementView,
  type SzRelationship,
  type SzRelationshipStyle,
  type SzRelationshipView,
  type SzView,
  type SzViewKind,
  type SzWorkspace,
  type RawWorkspaceJson,
} from './types'

// ── Narrowing at the boundary ────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Free text. `""` collapses to absent, because absent means `""` anyway (§4.2). */
function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length > 0 ? value : undefined
}

/** A trimmed name-ish field. `setGroup` trims and nulls whitespace-only (§5.2). */
function asTrimmedText(value: unknown): string | undefined {
  const text = asText(value)
  const trimmed = text?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

/**
 * Ids are OPAQUE strings and must never be parsed as numbers (§4.5) — but
 * structurizr-php stringifies the workspace id while others number it, and a
 * producer that numbers *element* ids would otherwise lose every element it
 * wrote. Accept a number, stringify, keep comparing as text.
 */
function asId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * `properties` is string -> string, always (§5.2). Numbers do reach it —
 * `structurizr.inspection.error` is a *stringified* number in Java's output but
 * a bare one elsewhere — so coerce scalars rather than dropping the entry.
 */
function readProperties(
  value: unknown,
  where: string,
  warnings: string[],
): Record<string, string> {
  const raw = asRecord(value)
  if (!raw) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') out[key] = entry
    else if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = String(entry)
    else if (typeof entry === 'boolean') out[key] = String(entry)
    else warnings.push(`${where}: dropped non-scalar property "${key}"`)
  }
  return out
}

// ── Tags ─────────────────────────────────────────────────────────────────────

/**
 * `tags` is a comma-separated STRING on model items and a real ARRAY on
 * filtered views (T1) — and structurizr-php writes `null`, structurizr-typescript
 * writes `""`, danbarua/.NET writes nothing at all (§12). One reader handles all
 * five shapes, because guessing wrong on the array form produces per-character
 * garbage and guessing wrong on the string form produces one giant tag.
 *
 * Split on `","` ONLY — never `", "`, or `"Software System"` and
 * `"Deployment Node"` split down the middle (T1). Then trim and drop empties:
 * the corpus really does contain `"Element,Deployment Node,"` and
 * `"Element,Container,Optional Database,,in_other_managed_services"` (T3), and
 * trimming CONVERGES with what the renderer draws — `Styles.findElementStyle`
 * trims the lookup key on both implementations, so `" Person"` already resolved
 * the Person style; what trimming additionally fixes is Structurizr's own
 * `hasTag(" Person") === false` bug (T3).
 */
function readTagTokens(value: unknown): string[] {
  const source: unknown[] =
    typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
  const out: string[] = []
  for (const token of source) {
    if (typeof token !== 'string') continue
    const trimmed = token.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/**
 * `getTagsAsSet()` puts the type defaults FIRST, then user tags — but
 * structurizr-typescript emits custom tags first, so strip by membership and
 * never by position (T2).
 */
function stripDefaultTags(all: readonly string[], defaults: readonly string[]): string[] {
  if (defaults.length === 0) return [...all]
  const drop = new Set(defaults)
  return all.filter((tag) => !drop.has(tag))
}

/**
 * §5.2's table. The two instance kinds are deliberately EMPTY:
 * `StaticStructureElementInstance.getDefaultTags()` returns an empty set and
 * `"Container Instance"` is a *stored* tag the constructor added, which is why
 * it is on the wire at all. Stripping it would delete a tag Structurizr
 * considers the user's — and §17.3 records that structurizr-python disagrees
 * about instance tags anyway, so inventing a strip rule here would be guessing.
 */
const ELEMENT_DEFAULT_TAGS: Record<SzElementKind, readonly string[]> = {
  person: ['Element', 'Person'],
  softwareSystem: ['Element', 'Software System'],
  container: ['Element', 'Container'],
  component: ['Element', 'Component'],
  customElement: ['Element'],
  deploymentNode: ['Element', 'Deployment Node'],
  infrastructureNode: ['Element', 'Infrastructure Node'],
  containerInstance: [],
  softwareSystemInstance: [],
}

/**
 * `Relationship.getDefaultTags()` (§5.4): a DERIVED edge has none at all, and an
 * authored one gains `Synchronous`/`Asynchronous` as a *default* whenever
 * `interactionStyle` is set. Strip only `"Relationship"` and `Asynchronous`
 * shows up in the user's tag list as if they had typed it (T2).
 */
function relationshipDefaultTags(
  interactionStyle: string | undefined,
  linkedRelationshipId: string | undefined,
): string[] {
  if (linkedRelationshipId !== undefined) return []
  const defaults = ['Relationship']
  if (interactionStyle === 'Synchronous' || interactionStyle === 'Asynchronous') {
    defaults.push(interactionStyle)
  }
  return defaults
}

// ── Perspectives ─────────────────────────────────────────────────────────────

function readPerspectives(
  value: unknown,
  where: string,
  warnings: string[],
): SzElement['perspectives'] {
  const out: SzElement['perspectives'] = []
  for (const entry of asArray(value)) {
    const raw = asRecord(entry)
    // `name` is the sole basis of a perspective's identity (§5.3). Without it
    // there is nothing to key on — but losing a 436 KB workspace over one
    // nameless perspective is the failure this whole file exists to prevent.
    const name = asTrimmedText(raw?.name)
    if (!raw || name === undefined) {
      warnings.push(`${where}: skipped a perspective with no name`)
      continue
    }
    out.push({
      name,
      // Optional since v6.1.0 and the changelog does not say so — do not require it.
      description: asText(raw.description),
      value: asText(raw.value),
      url: asText(raw.url),
    })
  }
  return out
}

// ── The element tree ─────────────────────────────────────────────────────────

/**
 * Every nested collection, walked generically for EVERY element kind rather
 * than per-kind: parentage exists only as JSON nesting (T4), there is no parent
 * pointer, and an importer that enumerates the legal paths orphans anything a
 * producer nests somewhere the Java writer would not.
 */
const CHILD_COLLECTIONS: ReadonlyArray<readonly [string, SzElementKind]> = [
  ['containers', 'container'],
  ['components', 'component'],
  ['children', 'deploymentNode'],
  ['infrastructureNodes', 'infrastructureNode'],
  ['containerInstances', 'containerInstance'],
  ['softwareSystemInstances', 'softwareSystemInstance'],
]

interface WalkState {
  elements: SzElement[]
  relationships: SzRelationship[]
  warnings: string[]
  seenElementIds: Set<string>
  seenRelationshipIds: Set<string>
  synthesised: number
}

function synthesiseId(state: WalkState, prefix: string): string {
  state.synthesised += 1
  return `${prefix}-synthesised-${state.synthesised}`
}

/**
 * v6.2.0 moved deployment groups onto the NODES and made them inherit
 * downwards; `getAllDeploymentGroups()` is `ancestors ∪ own` (§5.5). Read only
 * the instance-level key and every workspace using the node-level form silently
 * loses its relationship replication.
 *
 * Absent means `[]`. Never `["Default"]` — v6.2.0 deleted that default, and
 * synthesising it invents a group the customer's Structurizr does not have,
 * shows it in our UI, and writes it back out on export (T27).
 *
 * We materialise the effective set at every level of the tree so a consumer
 * never has to re-walk parents. The cost is that a node's own declared groups
 * are no longer distinguishable from its inherited ones — an exporter must
 * therefore re-derive node-level groups rather than echoing this field back,
 * or it re-commits T27's actual damage in a different place.
 */
function readDeploymentGroups(raw: Record<string, unknown>, inherited: readonly string[]): string[] {
  const own: string[] = []
  for (const entry of asArray(raw.deploymentGroups)) {
    const group = asTrimmedText(entry)
    if (group !== undefined) own.push(group)
  }
  // LEGACY singular, read-only alias — accepted on read, never emitted (§2).
  const legacy = asTrimmedText(raw.deploymentGroup)
  if (legacy !== undefined) own.push(legacy)

  const merged: string[] = []
  for (const group of [...inherited, ...own]) {
    if (!merged.includes(group)) merged.push(group)
  }
  return merged
}

function walkElement(
  input: unknown,
  kind: SzElementKind,
  parentId: string | undefined,
  inheritedGroups: readonly string[],
  state: WalkState,
): void {
  const raw = asRecord(input)
  if (!raw) {
    state.warnings.push(`model: skipped a ${kind} entry that is not an object`)
    return
  }

  // §4.4: a missing id is synthesised, never fatal. The element cannot be
  // referenced by a view (nothing on the wire points at it), but the rest of
  // the workspace survives — and the warning says which one to look at.
  let id = asId(raw.id)
  if (id === undefined) {
    id = synthesiseId(state, 'element')
    state.warnings.push(
      `model: ${kind} "${asTrimmedText(raw.name) ?? '(unnamed)'}" has no id; using ${id}`,
    )
  }
  if (state.seenElementIds.has(id)) {
    // Structurizr's TreeSet would silently drop one of these (§4.3). We keep
    // both — "the importer ate my diagram" is the worse failure — but a view
    // referencing the id now matches two elements, so it must be reported.
    state.warnings.push(`model: duplicate element id "${id}"; both kept`)
  }
  state.seenElementIds.add(id)

  const isInstance = kind === 'containerInstance' || kind === 'softwareSystemInstance'
  // Instances have NO `name` key: `getName()` is @JsonIgnore and `setName()` is
  // a no-op, so the label has to come from dereferencing containerId /
  // softwareSystemId later (§5.5). structurizr-python emits one anyway (§12),
  // hence the read attempt before the empty fallback.
  const name = asTrimmedText(raw.name)
  if (name === undefined && !isInstance) {
    state.warnings.push(`model: ${kind} "${id}" has no name`)
  }

  const styleTags = readTagTokens(raw.tags)
  const where = `model: ${kind} "${id}"`
  const deploymentGroups = readDeploymentGroups(raw, inheritedGroups)

  const element: SzElement = {
    id,
    kind,
    name: name ?? '',
    description: asText(raw.description),
    technology: asText(raw.technology),
    tags: stripDefaultTags(styleTags, ELEMENT_DEFAULT_TAGS[kind]),
    styleTags,
    // ONE flat string even when the groups are nested — splitting is the
    // caller's job and only when `groupSeparator` says so (T5, §13.6).
    group: asTrimmedText(raw.group),
    location: asTrimmedText(raw.location),
    url: asText(raw.url),
    properties: readProperties(raw.properties, where, state.warnings),
    perspectives: readPerspectives(raw.perspectives, where, state.warnings),
    parentId,
    environment: asTrimmedText(raw.environment),
    // A STRING, and legally a range: "0..5", "1..N", "1..*" (T15). 16 of 151
    // corpus occurrences are JSON numbers, so coerce rather than reject —
    // parsing it into an int field is what destroys the range.
    instances: readInstances(raw.instances, where, state.warnings),
    instanceOfId: isInstance
      ? (asId(raw.containerId) ?? asId(raw.softwareSystemId))
      : undefined,
    instanceId: asFiniteNumber(raw.instanceId),
    deploymentGroups,
  }

  if (isInstance && element.instanceOfId === undefined) {
    state.warnings.push(
      `${where}: instance has no containerId/softwareSystemId, so it has no label`,
    )
  }

  state.elements.push(element)

  for (const entry of asArray(raw.relationships)) {
    readRelationship(entry, id, state)
  }

  for (const [key, childKind] of CHILD_COLLECTIONS) {
    for (const child of asArray(raw[key])) {
      walkElement(child, childKind, id, deploymentGroups, state)
    }
  }
}

function readInstances(
  value: unknown,
  where: string,
  warnings: string[],
): string | undefined {
  if (typeof value === 'string') return asTrimmedText(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value !== undefined && value !== null) {
    warnings.push(`${where}: ignored an "instances" value that is neither string nor number`)
  }
  return undefined
}

const INTERACTION_STYLES = new Set(['Synchronous', 'Asynchronous'])

/**
 * Relationships are nested under their SOURCE, at every depth, on every element
 * type; `model.relationships` does not exist and never did (T6). Looking for a
 * flat list yields the classic "boxes but no arrows" import.
 */
function readRelationship(input: unknown, enclosingId: string, state: WalkState): void {
  const raw = asRecord(input)
  if (!raw) {
    state.warnings.push(`model: skipped a relationship on "${enclosingId}" that is not an object`)
    return
  }

  let id = asId(raw.id)
  if (id === undefined) {
    id = synthesiseId(state, 'relationship')
    state.warnings.push(`model: relationship on "${enclosingId}" has no id; using ${id}`)
  }
  if (state.seenRelationshipIds.has(id) || state.seenElementIds.has(id)) {
    // One counter issues ids to elements AND relationships (§4.5), so a
    // collision across the two spaces is as real as one within either.
    state.warnings.push(`model: duplicate relationship id "${id}"; both kept`)
  }
  state.seenRelationshipIds.add(id)

  const destinationId = asId(raw.destinationId)
  if (destinationId === undefined) {
    // The only real graph information the object carries; without it there is
    // no edge to draw (§4.4).
    state.warnings.push(`model: dropped relationship "${id}" with no destinationId`)
    return
  }

  // `sourceId` is documented as a checksum — it always equals the enclosing
  // element's id (§5.4). Keep the DECLARED value when the two disagree, because
  // that is the one Structurizr hydrates against and therefore the edge the
  // customer saw; fall back to nesting only when the key is absent.
  const declaredSource = asId(raw.sourceId)
  if (declaredSource !== undefined && declaredSource !== enclosingId) {
    state.warnings.push(
      `model: relationship "${id}" declares sourceId "${declaredSource}" but is nested under "${enclosingId}"`,
    )
  }

  // structurizr-typescript misspells the key as `interactionStlye` in both the
  // property and the DTO; reading only the correct spelling turns EVERY
  // asynchronous edge from that producer synchronous (§12).
  const rawStyle = asTrimmedText(raw.interactionStyle) ?? asTrimmedText(raw.interactionStlye)
  let interactionStyle: string | undefined
  if (rawStyle !== undefined && INTERACTION_STYLES.has(rawStyle)) {
    interactionStyle = rawStyle
  } else if (rawStyle !== undefined) {
    // Exact-case Java constant names (§4.7). Case-insensitive guessing would
    // diverge from what Structurizr renders, so treat it as absent and say so.
    state.warnings.push(`model: relationship "${id}" has unknown interactionStyle "${rawStyle}"`)
  } else if (raw.interactionStyle !== undefined && raw.interactionStyle !== null) {
    // danbarua/.NET emits an integer here (§12); 0/1 is not a documented mapping.
    state.warnings.push(`model: relationship "${id}" has a non-string interactionStyle`)
  }

  const linkedRelationshipId = asId(raw.linkedRelationshipId)
  const styleTags = readTagTokens(raw.tags)
  const where = `model: relationship "${id}"`

  state.relationships.push({
    id,
    sourceId: declaredSource ?? enclosingId,
    destinationId,
    description: asText(raw.description),
    // Authoritative even on a derived edge — `setTechnology` may be overridden
    // for instance-to-instance edges, so never read it off the linked one (T8).
    technology: asText(raw.technology),
    tags: stripDefaultTags(styleTags, relationshipDefaultTags(interactionStyle, linkedRelationshipId)),
    styleTags,
    interactionStyle,
    url: asText(raw.url),
    properties: readProperties(raw.properties, where, state.warnings),
    linkedRelationshipId,
  })
}

// ── Views ────────────────────────────────────────────────────────────────────

/**
 * `enterpriseContextViews` is a live `@JsonSetter` alias for
 * `systemLandscapeViews` that Java never writes but old files still carry (§2).
 * It is listed alongside the modern key rather than instead of it because a
 * hand-merged file can legally contain both.
 */
const VIEW_COLLECTIONS: ReadonlyArray<readonly [string, SzViewKind]> = [
  ['systemLandscapeViews', 'systemLandscape'],
  ['enterpriseContextViews', 'systemLandscape'],
  ['systemContextViews', 'systemContext'],
  ['containerViews', 'container'],
  ['componentViews', 'component'],
  ['dynamicViews', 'dynamic'],
  ['deploymentViews', 'deployment'],
  ['customViews', 'custom'],
  ['imageViews', 'image'],
  ['filteredViews', 'filtered'],
]

/**
 * The scope lives under a different key per view kind, and two kinds have none.
 * `componentViews` carry ONLY `containerId` (`getSoftwareSystemId` is
 * @JsonIgnore'd there); `dynamicViews` carry `elementId`, which holds a system
 * id or a container id and does not say which (§6.1).
 */
function readScopeId(raw: Record<string, unknown>, kind: SzViewKind): string | undefined {
  switch (kind) {
    case 'systemContext':
    case 'container':
    case 'deployment':
      return asId(raw.softwareSystemId)
    case 'component':
      return asId(raw.containerId)
    case 'dynamic':
    case 'image':
      return asId(raw.elementId)
    default:
      return undefined
  }
}

function readElementViews(
  value: unknown,
  viewKey: string,
  warnings: string[],
): SzElementView[] {
  const out: SzElementView[] = []
  for (const entry of asArray(value)) {
    const raw = asRecord(entry)
    const id = asId(raw?.id)
    if (!raw || id === undefined) {
      warnings.push(`view "${viewKey}": dropped an element row with no id`)
      continue
    }
    // ABSENT is a real state and must not become 0: structurizr-python omits
    // x/y entirely and structurizr-php writes null, while a genuine 0 is a
    // position at the origin (T10). Only the per-view, per-kind heuristic
    // downstream may reinterpret a 0.
    out.push({ id, x: asFiniteNumber(raw.x), y: asFiniteNumber(raw.y) })
  }
  return out
}

function readRelationshipViews(
  value: unknown,
  viewKey: string,
  warnings: string[],
): SzRelationshipView[] {
  const out: SzRelationshipView[] = []
  for (const entry of asArray(value)) {
    const raw = asRecord(entry)
    const id = asId(raw?.id)
    if (!raw || id === undefined) {
      warnings.push(`view "${viewKey}": dropped a relationship row with no id`)
      continue
    }

    const vertices: Array<{ x: number; y: number }> = []
    for (const vertex of asArray(raw.vertices)) {
      const point = asRecord(vertex)
      const x = asFiniteNumber(point?.x)
      const y = asFiniteNumber(point?.y)
      if (x === undefined || y === undefined) {
        warnings.push(`view "${viewKey}": dropped a malformed vertex on relationship "${id}"`)
        continue
      }
      vertices.push({ x, y })
    }

    out.push({
      id,
      // A STRING on the wire — "1.1" and "2.0" are real values, so parsing it
      // as an int loses nested sequence numbers (§6.4).
      order: typeof raw.order === 'number' ? String(raw.order) : asText(raw.order),
      description: asText(raw.description),
      response: asBoolean(raw.response),
      vertices,
      // Absent means "inherit from the style", NOT Direct (§6.4).
      routing: asTrimmedText(raw.routing),
      position: asFiniteNumber(raw.position),
    })
  }
  return out
}

function readView(
  input: unknown,
  kind: SzViewKind,
  index: number,
  state: { warnings: string[]; synthesisedKeys: number },
): SzView | undefined {
  const raw = asRecord(input)
  if (!raw) {
    state.warnings.push(`views: skipped a ${kind} view that is not an object`)
    return undefined
  }

  // structurizr-typescript omits `key` on some deployment views (§12). A view
  // with no key cannot be referenced by `defaultView`/`baseViewKey`, but it is
  // still a diagram the customer drew — synthesise and report.
  let key = asTrimmedText(raw.key)
  if (key === undefined) {
    state.synthesisedKeys += 1
    key = `${kind}-${index + 1}`
    state.warnings.push(`views: a ${kind} view has no key; using "${key}"`)
  }

  // `setOrder` is `Math.max(1, order)`, so an explicit 0 reads back as 1 while
  // an ABSENT order is genuinely unset and is not backfilled (§6.2). The two
  // are different states and both occur.
  const rawOrder = asFiniteNumber(raw.order)
  const order = rawOrder === undefined ? undefined : Math.max(1, rawOrder)

  const filterTags = kind === 'filtered' ? readTagTokens(raw.tags) : []
  let filterMode: SzView['filterMode']
  if (kind === 'filtered') {
    const mode = asTrimmedText(raw.mode)
    if (mode === 'Include' || mode === 'Exclude') filterMode = mode
    // The field initialiser is `FilterMode.Exclude`, so ABSENT means Exclude
    // (§6.1). A wrong-case value is a third state Java reads as null; leave it
    // undefined so a consumer's `=== 'Include'` test lands on Exclude anyway.
    else if (mode === undefined) filterMode = 'Exclude'
    else state.warnings.push(`view "${key}": unknown filter mode "${mode}"`)
  }

  // `automaticLayout: null` is what structurizr-typescript writes for "none"
  // (§12); `{}` is a real, meaningful presence (the view was laid out by a
  // machine) even though every field inside it is optional.
  const autoLayout = asRecord(raw.automaticLayout)

  return {
    kind,
    key,
    scopeId: readScopeId(raw, kind),
    // `title` is what the user typed; `name` is computed and read-only, so it
    // is a display fallback and never identity (T16).
    title: asText(raw.title) ?? asText(raw.name),
    description: asText(raw.description),
    order,
    environment: kind === 'deployment' ? asTrimmedText(raw.environment) : undefined,
    baseViewKey: kind === 'filtered' ? asTrimmedText(raw.baseViewKey) : undefined,
    filterMode,
    filterTags,
    elements: readElementViews(raw.elements, key, state.warnings),
    relationships: readRelationshipViews(raw.relationships, key, state.warnings),
    automaticLayout: autoLayout
      ? // Unknown values make `setRankDirection(null)` throw in Java, i.e. the
        // whole file fails to load there; we keep the string as-is and let the
        // layout policy decide, because refusing the workspace is worse.
        { rankDirection: asTrimmedText(autoLayout.rankDirection) }
      : undefined,
  }
}

// ── Styles and themes ────────────────────────────────────────────────────────

/**
 * FILE ORDER, and no de-duplication (§18.1). `Styles` has no setter, so Jackson
 * field-injects an ArrayList rather than the declared TreeSet: corpus proof is
 * that an alphabetically-sorted (therefore Java-written) file still carries its
 * styles in declaration order. Resolution walks this array in order and merges
 * duplicates PER PROPERTY, so collapsing duplicates here — or sorting them —
 * silently changes the colours the customer sees.
 */
function readElementStyles(value: unknown, warnings: string[]): SzElementStyle[] {
  const out: SzElementStyle[] = []
  for (const entry of asArray(value)) {
    const raw = asRecord(entry)
    // Only the LOOKUP side is trimmed by `findElementStyle`, so a style whose
    // own tag carries stray whitespace matches nothing at all (T3).
    const declaredTag = asText(raw?.tag)
    const tag = declaredTag?.trim()
    if (!raw || tag === undefined || tag.length === 0) {
      warnings.push('views.configuration.styles.elements: dropped a style with no tag')
      continue
    }
    if (declaredTag !== tag) {
      warnings.push(`element style "${tag}": tag had stray whitespace and matched nothing`)
    }
    out.push({
      tag,
      background: asText(raw.background),
      color: asText(raw.color),
      stroke: asText(raw.stroke),
      shape: asTrimmedText(raw.shape),
      icon: asText(raw.icon),
      width: asFiniteNumber(raw.width),
      height: asFiniteNumber(raw.height),
      colorScheme: asTrimmedText(raw.colorScheme),
    })
  }
  return out
}

function readRelationshipStyles(value: unknown, warnings: string[]): SzRelationshipStyle[] {
  const out: SzRelationshipStyle[] = []
  for (const entry of asArray(value)) {
    const raw = asRecord(entry)
    const declaredTag = asText(raw?.tag)
    const tag = declaredTag?.trim()
    if (!raw || tag === undefined || tag.length === 0) {
      warnings.push('views.configuration.styles.relationships: dropped a style with no tag')
      continue
    }
    if (declaredTag !== tag) {
      warnings.push(`relationship style "${tag}": tag had stray whitespace and matched nothing`)
    }
    out.push({
      tag,
      color: asText(raw.color),
      // Legacy `dashed` and modern `style` co-exist in one file (§15); keep both.
      dashed: asBoolean(raw.dashed),
      style: asTrimmedText(raw.style),
      thickness: asFiniteNumber(raw.thickness),
      colorScheme: asTrimmedText(raw.colorScheme),
    })
  }
  return out
}

/**
 * Entries are theme URLs OR, since v6.0.0, bare installed-theme identifiers
 * (`amazon-web-services-2025.07`) — so never validate them as URLs. `theme`
 * (singular) is a live read-only alias with no getter (§2/T17).
 */
function readThemes(configuration: Record<string, unknown> | undefined): string[] {
  const out: string[] = []
  const push = (value: unknown) => {
    const theme = asTrimmedText(value)
    if (theme !== undefined && !out.includes(theme)) out.push(theme)
  }
  for (const entry of asArray(configuration?.themes)) push(entry)
  push(configuration?.theme)
  return out
}

// ── Document-level refusals ──────────────────────────────────────────────────

/**
 * §9.2. An encrypted workspace is NOT a workspace — `EncryptedWorkspace extends
 * AbstractWorkspace`, so it has no `model` and no `views` — yet it deserialises
 * cleanly into a valid, empty, plausibly-named one because
 * FAIL_ON_UNKNOWN_PROPERTIES is false. Detect it STRUCTURALLY, like the
 * reference webapp does; the Java client's unquoted `json.contains("ciphertext")`
 * false-positives on any workspace whose documentation happens to use the word.
 */
function encryptedWorkspaceMessage(root: RawWorkspaceJson): string | undefined {
  const ciphertext = asText(root.ciphertext)
  const strategy = asRecord(root.encryptionStrategy)
  if (ciphertext === undefined || strategy === undefined) return undefined

  const location = asTrimmedText(strategy.location)
  const where =
    location === 'Server'
      ? 'It was encrypted server-side, so a normally configured Structurizr server can export it decrypted.'
      : 'It was encrypted in the browser, so only the passphrase its author set can open it.'
  return (
    'This workspace is client-side encrypted: its model and views are stored as ciphertext ' +
    `and cannot be read without the passphrase. ${where} ` +
    'Open it in Structurizr, enter the passphrase, export an unencrypted copy, and import that.'
  )
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function parseWorkspaceJson(input: string): SzWorkspace {
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new StructurizrJsonError(
      `Expected a Structurizr workspace JSON document, but the file is not valid JSON: ${detail}`,
    )
  }

  const root = asRecord(parsed)
  if (!root) {
    const found =
      Array.isArray(parsed) ? 'a JSON array' : parsed === null ? 'null' : `a JSON ${typeof parsed}`
    throw new StructurizrJsonError(
      `Expected a Structurizr workspace JSON document (an object with "model" and/or "views"), but found ${found}.`,
    )
  }

  const encrypted = encryptedWorkspaceMessage(root as RawWorkspaceJson)
  if (encrypted !== undefined) throw new StructurizrJsonError(encrypted)

  const model = asRecord(root.model)
  const views = asRecord(root.views)
  if (!model && !views) {
    // MapleSpire's own export is the near-miss worth naming: it is a valid
    // JSON object full of diagrams, and a bare "not a workspace" would send
    // the user looking for a corrupt file.
    const ours = asText(root.format)?.startsWith('maplespire') === true
    throw new StructurizrJsonError(
      ours
        ? 'This is a MapleSpire model export, not a Structurizr workspace. Import it from the JSON model importer instead.'
        : 'Expected a Structurizr workspace JSON document, but the file has neither a "model" nor a "views" key.',
    )
  }

  const warnings: string[] = []
  const state: WalkState = {
    elements: [],
    relationships: [],
    warnings,
    seenElementIds: new Set(),
    seenRelationshipIds: new Set(),
    synthesised: 0,
  }

  if (model) {
    for (const entry of asArray(model.people)) walkElement(entry, 'person', undefined, [], state)
    for (const entry of asArray(model.softwareSystems)) {
      walkElement(entry, 'softwareSystem', undefined, [], state)
    }
    for (const entry of asArray(model.customElements)) {
      walkElement(entry, 'customElement', undefined, [], state)
    }
    // Top-level nodes ONLY; every descendant exists exclusively in `children[]`.
    for (const entry of asArray(model.deploymentNodes)) {
      walkElement(entry, 'deploymentNode', undefined, [], state)
    }
  }

  const viewState = { warnings, synthesisedKeys: 0 }
  const parsedViews: SzView[] = []
  if (views) {
    for (const [key, kind] of VIEW_COLLECTIONS) {
      const collection = asArray(views[key])
      collection.forEach((entry, index) => {
        const view = readView(entry, kind, index, viewState)
        if (view) parsedViews.push(view)
      })
    }
  }

  const configuration = asRecord(views?.configuration)
  const styles = asRecord(configuration?.styles)

  // Multi-character separators still load: v6.1 validates only
  // `Model.addProperty`, and the JSON path goes through `setProperties(Map)`
  // unvalidated (§5.1). Absence means groups are opaque — never guess "/" (T5).
  const modelProperties = readProperties(model?.properties, 'model.properties', warnings)
  const groupSeparator = modelProperties['structurizr.groupSeparator']

  const name = asText(root.name)
  if (name === undefined) warnings.push('workspace: no name')

  return {
    name: name ?? '',
    description: asText(root.description),
    groupSeparator: groupSeparator !== undefined && groupSeparator.length > 0 ? groupSeparator : undefined,
    elements: state.elements,
    relationships: state.relationships,
    views: parsedViews,
    elementStyles: readElementStyles(styles?.elements, warnings),
    relationshipStyles: readRelationshipStyles(styles?.relationships, warnings),
    themes: readThemes(configuration),
    warnings,
  }
}
