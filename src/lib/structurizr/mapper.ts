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

// Map a parsed Structurizr Workspace AST onto MapleSpire's C4 model + diagrams.
//
// Produces shared model entities (objects/connections/groups) plus a set of
// diagrams (context / container / component) with their composition. Layout is
// NOT computed here — `layouts` are filled in by the layout phase. See
// docs/structurizr-import.md for what gets generated.

import type { C4Object, C4Type, Connection, Diagram, Flow, FlowStep, Group, Tag } from '../../types'
import { seededTechnologyUsages } from '../technologyUsage'
import { objectLink } from '../objectLinks'
import { generateId } from '../utils'
import type { RawElement, RawView, Workspace } from './types'
import {
  DATASTORE_RE,
  EXTERNAL_TAG_RE,
  INTERNAL_TAG_RE,
  SIZE_BY_TYPE,
  detectScope as detectScopeShared,
  compareOrder,
  isDatastore as isDatastoreShared,
  parseTechnologies,
} from './conventions'
import {
  IMPLIED_RELATIONSHIP_PROPERTY,
  ownerFields,
  reviveMapleSpireFacts,
  withTechnologyDetails,
} from './maplespireFacts'
import { URL_PROPERTY } from './json/provenance'
import type { ImportStats } from '../import/types'

export type { ImportStats }

// Re-exported for the tests and the exporter that already read them from here.
// The definitions live in `./conventions.ts` — the ONE place both importers'
// judgements are allowed to live (see that file's header).
export { DATASTORE_RE, EXTERNAL_TAG_RE, INTERNAL_TAG_RE, SIZE_BY_TYPE }

export type LayoutDirection = 'tb' | 'bt' | 'lr' | 'rl'

export interface MappedWorkspace {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  /** Snapshots for every distinct tag the DSL declared. Tags are the linchpin of
   *  Structurizr — styles, themes and filtered views all key on them — so they
   *  round-trip as real model data rather than being read once as heuristic
   *  fodder and thrown away. */
  tags: Tag[]
  /** Diagrams with composition set; `layouts` are filled by the layout phase. */
  diagrams: Diagram[]
  /** Per-diagram layout hints from the view's `autoLayout` directive. */
  layoutHints: Record<string, { direction?: LayoutDirection }>
  /** Dynamic views, as ordered message flows hung off their own diagram. */
  flows: Flow[]
  entryDiagramId: string | null
  warnings: string[]
  stats: ImportStats
}

export interface MapOptions {
  /** Injectable id factory (tests pass a deterministic counter). */
  idFactory?: () => string
}

function mapKind(el: RawElement): C4Type {
  switch (el.kind) {
    case 'person':
      return 'actor'
    case 'softwareSystem':
      return 'system'
    case 'component':
      return 'component'
    case 'container':
      return isDatastore(el) ? 'store' : 'app'
  }
}

function isDatastore(el: RawElement): boolean {
  return isDatastoreShared(el.technology, el.tags)
}

function detectScope(el: RawElement): 'internal' | 'external' {
  // `enterprise` is the DSL's own scope statement; the shared rule decides how
  // it ranks against the tags and against the container-level override.
  const level =
    el.kind === 'person'
      ? 'person'
      : el.kind === 'container' || el.kind === 'component'
        ? 'containerLevel'
        : 'softwareSystem'
  return detectScopeShared(level, el.tags, el.enterpriseScope)
}

/** Where an imported element remembers the identifier the DSL gave it.
 *  `properties` already round-trips losslessly in both directions. */
export const SOURCE_IDENTIFIER_PROPERTY = 'structurizr.identifier'

/** Prefix of the synthetic tags the exporter mints to hang an icon style on.
 *  Lives here, not in the exporter, because the importer has to recognise and
 *  drop them and export already depends on this module (not the reverse). */
export const ICON_TAG_PREFIX = 'ms-icon-'

/** The one tag group imported tags land in, so they are visibly not governed
 *  catalog entries someone curated. */
const IMPORT_TAG_GROUP_ID = 'taggrp-structurizr-import'
const IMPORT_TAG_GROUP_NAME = 'Imported (Structurizr)'

/** Structurizr matches styles on the tag STRING, so the string is the identity.
 *  A deterministic id keeps re-importing the same workspace idempotent instead
 *  of minting a parallel set of tags on every import. */
function importedTagId(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `tag-szr-${slug || 'unnamed'}`
}

/**
 * Stable hue per tag value — the same tag is the same colour across imports,
 * and across workspaces, which is what makes a tag perspective readable.
 *
 * Exported because it is also the ONLY way to tell an auto-assigned chip colour
 * apart from one the customer chose. Nothing in a `Tag` records where its colour
 * came from, and the difference matters: the Structurizr export used to write
 * `Tag.color` into the file as an element `background`, which turned every tag
 * an import minted — i.e. every tag in every imported workspace — into a
 * fabricated palette the customer's file never had.
 */
export function importedTagColor(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return `hsl(${hash % 360} 55% 45%)`
}

/** One tag snapshot for a Structurizr tag string, whichever importer mints it.
 *  Shared so the DSL and JSON exports of the SAME workspace produce the same
 *  tagIds — otherwise importing both forms mints two parallel tag registries. */
export function importedTag(value: string): Tag {
  return {
    tagId: importedTagId(value),
    value,
    color: importedTagColor(value),
    groupId: IMPORT_TAG_GROUP_ID,
    groupName: IMPORT_TAG_GROUP_NAME,
    catalogRevision: 1,
  }
}

function flatten(elements: RawElement[]): RawElement[] {
  const out: RawElement[] = []
  const walk = (list: RawElement[]) => {
    for (const e of list) {
      out.push(e)
      walk(e.children)
    }
  }
  walk(elements)
  return out
}

export function mapWorkspace(ws: Workspace, opts: MapOptions = {}): MappedWorkspace {
  const newId = opts.idFactory ?? generateId
  const warnings = [...ws.warnings]

  const all = flatten(ws.elements)
  // Paths are unique; bare identifiers are not. `!identifiers hierarchical`
  // exists precisely so two systems may each declare a `web`.
  const byPath = new Map<string, RawElement>()
  const byPathLower = new Map<string, RawElement>()
  for (const el of all) {
    byPath.set(el.path, el)
    byPathLower.set(el.path.toLowerCase(), el)
  }
  // Bare-identifier index, keeping EVERY match so an ambiguous reference can be
  // recognised as ambiguous instead of silently taking whichever one happened to
  // be registered last.
  const byLeaf = new Map<string, RawElement[]>()
  for (const el of all) {
    const key = el.identifier.toLowerCase()
    const bucket = byLeaf.get(key)
    if (bucket) bucket.push(el)
    else byLeaf.set(key, [el])
  }
  const ambiguousRefs = new Set<string>()

  // Mint one snapshot per distinct declared tag, in first-declaration order.
  // Structurizr resolves styles by tag order (last match wins), and MapleSpire's
  // own tagOrder drives which tag colours a shape, so the order is meaningful in
  // both directions and is preserved rather than sorted.
  const tagByValue = new Map<string, Tag>()
  const rememberTag = (raw: string): Tag | undefined => {
    const value = raw.trim()
    if (!value) return undefined
    const existing = tagByValue.get(value)
    if (existing) return existing
    const tag = importedTag(value)
    tagByValue.set(value, tag)
    return tag
  }
  const assignTags = (raw: readonly string[]) => {
    const tagOrder: string[] = []
    for (const value of raw) {
      // `ms-icon-*` is an artefact our own exporter synthesises to hang an icon
      // style on — it is not something the user tagged anything with. Importing
      // it would surface machine noise in the tag perspective AND make the round
      // trip non-idempotent, since the next export would re-derive it from the
      // icon and find it already present as a real tag.
      if (value.trim().toLowerCase().startsWith(ICON_TAG_PREFIX)) continue
      const tag = rememberTag(value)
      if (tag && !tagOrder.includes(tag.tagId)) tagOrder.push(tag.tagId)
    }
    return {
      tagOrder,
      tagAssignments: Object.fromEntries(tagOrder.map((tagId) => [tagId, { tagId }])),
    }
  }

  /**
   * Resolve a DSL reference, honouring the scope it was written in.
   *
   * `web -> api` inside system `beta` means beta's web and api. Resolving it
   * globally picks one arbitrary `web`, so beta's edge lands on alpha's
   * containers wearing beta's label — a plausible-looking edge between the wrong
   * elements, which is worse than no edge at all.
   */
  const resolveRef = (ref: string | undefined, scopePath?: string): RawElement | undefined => {
    if (!ref) return undefined
    // 1. Innermost scope outwards: `beta.web`, then `web` at the model root.
    if (scopePath) {
      const segments = scopePath.split('.')
      for (let depth = segments.length; depth > 0; depth -= 1) {
        const prefix = segments.slice(0, depth).join('.')
        const hit = byPath.get(`${prefix}.${ref}`) ?? byPathLower.get(`${prefix}.${ref}`.toLowerCase())
        if (hit) return hit
      }
    }
    // 2. An absolute path, including the three-level form.
    const absolute = byPath.get(ref) ?? byPathLower.get(ref.toLowerCase())
    if (absolute) return absolute
    // 3. A bare identifier, only when it names exactly one element.
    const matches = byLeaf.get(ref.toLowerCase())
    if (!matches || matches.length === 0) return undefined
    if (matches.length > 1) {
      ambiguousRefs.add(ref)
      return undefined
    }
    return matches[0]
  }

  // ── objects ────────────────────────────────────────────────────────────────
  const objectIdByRef = new Map<string, string>()
  const objects: C4Object[] = []
  for (const el of all) {
    const type = mapKind(el)
    const id = newId()
    const technologies = parseTechnologies(el.technology)
    // Facts our own exporter parked in `properties` because Structurizr has no
    // field for them (status, owners, the compact summary, technology notes).
    // Revived into their real fields so an export → import → export round trip
    // does not lose them: the exporter strips those keys and re-derives them
    // from the live fields, so leaving them as plain properties dropped them on
    // the second export.
    const revived = reviveMapleSpireFacts(el.properties)
    objectIdByRef.set(el.path, id)
    objects.push({
      id,
      type,
      name: el.name,
      description: el.description,
      ...(revived.shortDescription ? { shortDescription: revived.shortDescription } : {}),
      ...(technologies.length
        ? { technologyUsages: seededTechnologyUsages(id, withTechnologyDetails(technologies, revived.technologies)) }
        : {}),
      icon: technologies[0]?.name,
      position: { x: 0, y: 0 },
      size: { ...SIZE_BY_TYPE[type] },
      ...assignTags(el.tags),
      links: [...(el.url ? [objectLink(el.url)] : []), ...revived.extraLinks.map((url) => objectLink(url))],
      scope: detectScope(el),
      status: revived.status ?? 'live',
      ...ownerFields(revived.owners),
      // Keep the identifier the DSL actually used so an export re-emits it
      // rather than re-slugging the display name — renaming an element should
      // not rewrite its identifier and every relationship line that names it.
      properties: { ...revived.properties, [SOURCE_IDENTIFIER_PROPERTY]: el.identifier },
      // parentId wired after the loop (needs the parent's object id)
    })
  }
  // Wire parentId now that every element has an object id.
  for (const el of all) {
    if (!el.parentPath) continue
    const childId = objectIdByRef.get(el.path)
    const parentId = objectIdByRef.get(el.parentPath)
    if (childId && parentId) {
      const obj = objects.find((o) => o.id === childId)
      if (obj) obj.parentId = parentId
    }
  }
  const objectById = new Map(objects.map((o) => [o.id, o]))

  // ── connections (one per from→to + description, as Structurizr's model has) ──
  //
  // Structurizr refuses a second relationship only when it repeats the SAME
  // description between the same two elements; `employeeVille -> saoeWeb` with
  // four different descriptions is four relationships (fixtures/saoe.dsl).
  // Deduping on the endpoints alone kept the first label and lost the other
  // three, along with every dynamic-view step that described one of them.
  const connections: Connection[] = []
  const connKey = new Set<string>()
  /** Every connection between two objects, in declaration order — the
   *  dynamic-view steps resolve against these. */
  const connIdsByEndpoints = new Map<string, string[]>()
  /** Every relationship that resolved, scope-aware, duplicates included — the
   *  view scoping below reads neighbourhoods off these, never off a second,
   *  scope-blind resolution of the same text. */
  const resolvedRelationships: Array<{ src: RawElement; dst: RawElement; description?: string }> = []
  let unresolved = 0
  for (const rel of ws.relationships) {
    const src = resolveRef(rel.sourceRef, rel.scopeRef)
    const dst = resolveRef(rel.destRef, rel.scopeRef)
    if (!src || !dst) {
      unresolved++
      continue
    }
    resolvedRelationships.push({ src, dst, description: rel.description })
    const fromId = objectIdByRef.get(src.path)!
    const toId = objectIdByRef.get(dst.path)!
    const endpoints = `${fromId}→${toId}`
    const key = `${endpoints}→${rel.description ?? ''}`
    if (connKey.has(key)) continue
    connKey.add(key)
    const label = rel.description || rel.technology || ''
    const id = newId()
    connIdsByEndpoints.set(endpoints, [...(connIdsByEndpoints.get(endpoints) ?? []), id])
    const technologies = parseTechnologies(rel.technology)
    const revived = reviveMapleSpireFacts(rel.properties ?? {})
    const connection: Connection = {
      id,
      fromId,
      toId,
      label,
      ...(technologies.length
        ? { technologyUsages: seededTechnologyUsages(id, withTechnologyDetails(technologies, revived.technologies)) }
        : {}),
      ...(revived.description ? { description: revived.description } : {}),
      ...(revived.status ? { status: revived.status } : {}),
      ...ownerFields(revived.owners),
      type: 'solid',
      shape: 'curved',
      ...assignTags(rel.tags),
      ...(rel.url || Object.keys(revived.properties).length
        ? { properties: { ...revived.properties, ...(rel.url ? { [URL_PROPERTY]: rel.url } : {}) } }
        : {}),
    }
    connections.push(connection)
  }
  if (ambiguousRefs.size > 0) {
    // Named explicitly: this is a fixable DSL problem, and the previous
    // behaviour — silently binding to whichever element registered last — was
    // how one system's relationship ended up drawn between another's containers.
    warnings.push(
      `Ambiguous identifier(s) matched more than one element and were skipped: ${[...ambiguousRefs].sort().join(', ')}. ` +
        'Qualify them (system.container) or make them unique.',
    )
  }
  if (unresolved > 0) {
    warnings.push(`${unresolved} relationship(s) referenced unknown elements and were skipped.`)
  }

  // ── groups (model-declared) ──────────────────────────────────────────────────
  // Map each RawGroup to a Group whose members are the elements whose groupIds
  // chain includes it (precise, scope-aware membership from the parser).
  const groups: Group[] = []
  const groupMembers = new Map<string, string[]>() // groupId(model) → member objectIds
  const groupColors = ['#DBEAFE', '#F3E8FF', '#DCFCE7', '#FEF3C7', '#FEE2E2', '#E0E7FF', '#CCFBF1', '#FCE7F3']
  let colorIdx = 0
  for (const rg of ws.groups) {
    const memberObjectIds = all
      .filter((el) => el.groupIds.includes(rg.id))
      .map((el) => objectIdByRef.get(el.path)!)
      .filter(Boolean)
    if (memberObjectIds.length === 0) continue
    const id = newId()
    groupMembers.set(id, memberObjectIds)
    groups.push({
      id,
      name: rg.name,
      color: groupColors[colorIdx++ % groupColors.length],
      objectIds: memberObjectIds,
      autoSize: false,
      tagAssignments: {},
      tagOrder: [],
    })
  }

  // ── diagrams ─────────────────────────────────────────────────────────────────
  const diagrams: Diagram[] = []
  const connectionsAmong = (ids: Set<string>): string[] => {
    const out: string[] = []
    for (const c of connections) {
      if (ids.has(c.fromId) && ids.has(c.toId)) out.push(c.id)
    }
    return out
  }
  const modelGroupsFor = (objectIds: Set<string>): string[] => {
    // A model-declared group appears when ≥2 of its members are on the diagram.
    const out: string[] = []
    for (const g of groups) {
      const present = g.objectIds.filter((oid) => objectIds.has(oid))
      if (present.length >= 2) out.push(g.id)
    }
    return out
  }
  // ── view scoping: Structurizr's `include *`, at the C4 level of each view ─────
  //
  // A view shows the elements IN SCOPE (the focal's children) plus the elements
  // DIRECTLY connected to them, each drawn at the abstraction level the view
  // allows. Two rules the previous scoping broke, both reported on a real
  // workspace (fixtures/saoe.dsl, component view of "Oracle Form"):
  //
  //  1. The neighbourhood is read off the in-scope CHILDREN, not off the focal.
  //     `employeeVille -> of` is a relationship to the container the view is
  //     drawn INSIDE; nothing on a component view represents `of` except its
  //     boundary, so the person landed on the canvas with no edge at all — and
  //     then dragged in its edges to other neighbours (`employeeVille -> files`)
  //     that have nothing to do with Oracle Form's components.
  //  2. A neighbour is rolled up to the level the view draws. A component view
  //     shows people, software systems and containers of the SAME system; a
  //     container view shows people and software systems; a context view only
  //     people and software systems. A container of ANOTHER system appears as
  //     that system, which is what C4 draws and what Structurizr's implied
  //     relationships produce. The canvas re-derives the rolled-up edge (a
  //     `lower` connection) from the model, and the layout already counts it.
  //
  // `exclude <identifier>` and explicit `include <identifier>` are honoured;
  // expression forms (`->x->`, `element.tag==…`) are not, and say so.
  const pathOf = (el: RawElement) => el.path
  const isWithin = (el: RawElement, ancestor: RawElement): boolean =>
    el.path === ancestor.path || el.path.startsWith(`${ancestor.path}.`)
  const topLevelOf = (el: RawElement): RawElement => {
    let cur = el
    while (cur.parentPath) {
      const parent = byPath.get(cur.parentPath)
      if (!parent) break
      cur = parent
    }
    return cur
  }
  /** The ancestor-or-self of `el` that is a direct child of `scope`, if any. */
  const childOfScopeContaining = (el: RawElement, scope: RawElement): RawElement | undefined => {
    let cur: RawElement | undefined = el
    while (cur && cur.parentPath !== scope.path) cur = cur.parentPath ? byPath.get(cur.parentPath) : undefined
    return cur
  }
  /**
   * Paths directly connected to anything inside `inScope`, each mapped through
   * `represent` — the element the view draws for that endpoint, or undefined
   * when the view has no box for it (the focal itself, one of its ancestors).
   */
  const neighbours = (
    inScope: (el: RawElement) => boolean,
    represent: (el: RawElement) => RawElement | undefined,
  ): Set<string> => {
    const out = new Set<string>()
    for (const { src, dst } of resolvedRelationships) {
      for (const [near, far] of [[src, dst], [dst, src]] as const) {
        if (!inScope(near) || inScope(far)) continue
        const shown = represent(far)
        if (shown) out.add(pathOf(shown))
      }
    }
    return out
  }
  const unsupportedExpressions = new Set<string>()
  /** `include *` (or no include at all) → the defaults; plus explicit
   *  identifiers; minus excluded identifiers. Order-stable. */
  const scopeMembers = (view: RawView | null, defaults: () => Iterable<string>): Set<string> => {
    const includes = view?.includes ?? []
    const members = new Set<string>()
    if (includes.length === 0 || includes.includes('*')) for (const p of defaults()) members.add(p)
    const asElement = (token: string): RawElement | undefined => {
      if (/->|==|^element\.|^relationship\./i.test(token)) {
        unsupportedExpressions.add(token)
        return undefined
      }
      return resolveRef(token)
    }
    for (const token of includes) {
      if (token === '*') continue
      const el = asElement(token)
      if (el) members.add(el.path)
    }
    for (const token of view?.excludes ?? []) {
      if (token === '*') {
        members.clear()
        continue
      }
      const el = asElement(token)
      if (el) members.delete(el.path)
    }
    return members
  }
  const objIds = (refs: Iterable<string>): string[] => {
    const out: string[] = []
    for (const r of refs) {
      const id = objectIdByRef.get(r)
      if (id) out.push(id)
    }
    return out
  }

  const addBoundaryGroup = (name: string, parentObjectId: string, memberObjectIds: string[]): string => {
    const id = newId()
    groups.push({
      id,
      name,
      color: '#F1F5F9',
      objectIds: memberObjectIds,
      parentObjectId,
      type: objectById.get(parentObjectId)?.type
        ? capitalize(objectById.get(parentObjectId)!.type)
        : undefined,
      description: objectById.get(parentObjectId)?.description,
      autoSize: false,
      tagAssignments: {},
      tagOrder: [],
    })
    groupMembers.set(id, memberObjectIds)
    return id
  }

  const topLevelSystemsAndPeople = all.filter(
    (e) => !e.parentRef && (e.kind === 'softwareSystem' || e.kind === 'person'),
  )

  const buildContext = (view: RawView | null, focalRef: string | null): Diagram | null => {
    let memberRefs: Set<string>
    if (focalRef) {
      // systemContext: the focal + the people and software systems directly
      // connected to it OR TO ANYTHING INSIDE IT — a container's relationship to
      // another system's container is a relationship between the two systems —
      // each rolled up to its top-level person/system.
      const focal = resolveRef(focalRef)
      if (!focal) return null
      memberRefs = scopeMembers(view, () => [
        focal.path,
        ...neighbours(
          (el) => isWithin(el, focal),
          (el) => topLevelOf(el),
        ),
      ])
      memberRefs.add(focal.path)
    } else {
      // systemLandscape: all top-level systems + people.
      memberRefs = scopeMembers(view, () => topLevelSystemsAndPeople.map((e) => e.path))
    }
    const ids = objIds(memberRefs)
    if (ids.length === 0) return null
    const idSet = new Set(ids)
    return {
      id: newId(),
      name: view?.key || view?.description || (focalRef ? `${resolveRef(focalRef)?.name} - System Context` : (ws.name ? `${ws.name} - System Landscape` : 'System Landscape')),
      ...(view?.key ? { sourceViewKey: view.key } : {}),
      ...(view?.description ? { description: view.description } : {}),
      type: 'context',
      objectIds: ids,
      connectionIds: connectionsAmong(idSet),
      groupIds: modelGroupsFor(idSet),
    }
  }

  /**
   * container / component views share one shape: the focal's children of
   * `childKind` inside a boundary, plus their rolled-up neighbours.
   */
  const buildDrillDown = (
    view: RawView | null,
    focalRef: string,
    childKind: 'container' | 'component',
  ): Diagram | null => {
    const focal = resolveRef(focalRef)
    if (!focal) return null
    const childRefs = focal.children.filter((c) => c.kind === childKind)
    if (childRefs.length === 0) return null
    const childPaths = new Set(childRefs.map(pathOf))
    const inScope = (el: RawElement): boolean => childRefs.some((child) => isWithin(el, child))
    // The software system a component view lives in; a container view's focal
    // IS the system.
    const system = topLevelOf(focal)
    const represent = (el: RawElement): RawElement | undefined => {
      // The focal and its ancestors are the boundary, not a box.
      if (isWithin(focal, el)) return undefined
      // Same system, other container: a component view draws that container.
      if (childKind === 'component' && isWithin(el, system)) return childOfScopeContaining(el, system)
      // Anything else is drawn as its person/software system.
      return topLevelOf(el)
    }
    const memberRefs = scopeMembers(view, () => [...childPaths, ...neighbours(inScope, represent)])
    const focalObjId = objectIdByRef.get(focal.path)!
    const ids = objIds(memberRefs)
    if (ids.length === 0) return null
    const idSet = new Set(ids)
    // The boundary wraps the children that are actually on the view — an
    // excluded container must not keep a slot inside it.
    const boundaryId = addBoundaryGroup(
      focal.name,
      focalObjId,
      objIds([...childPaths].filter((p) => memberRefs.has(p))),
    )
    const suffix = childKind === 'container' ? 'Containers' : 'Components'
    return {
      id: newId(),
      name: view?.key || `${focal.name} - ${suffix}`,
      ...(view?.key ? { sourceViewKey: view.key } : {}),
      ...(view?.description ? { description: view.description } : {}),
      type: childKind,
      parentObjectId: focalObjId,
      objectIds: ids,
      connectionIds: connectionsAmong(idSet),
      // Only the focal's boundary on a drill-down diagram — model-level groups
      // belong on the landscape/context level, not here.
      groupIds: [boundaryId],
    }
  }
  const buildContainer = (view: RawView | null, focalRef: string) => buildDrillDown(view, focalRef, 'container')
  const buildComponent = (view: RawView | null, focalRef: string) => buildDrillDown(view, focalRef, 'component')

  const layoutHints: Record<string, { direction?: LayoutDirection }> = {}
  // Original Structurizr view kind per generated diagram — used to pick the entry
  // diagram precisely (a systemLandscape view, regardless of its name/key).
  const viewKindByDiagram = new Map<string, RawView['kind']>()

  const structuralViews = ws.views.filter(
    (v) => v.kind === 'systemLandscape' || v.kind === 'systemContext' || v.kind === 'container' || v.kind === 'component',
  )

  if (structuralViews.length > 0) {
    for (const v of structuralViews) {
      let d: Diagram | null = null
      if (v.kind === 'systemLandscape') d = buildContext(v, null)
      else if (v.kind === 'systemContext') d = buildContext(v, v.scopeRef ?? null)
      else if (v.kind === 'container' && v.scopeRef) d = buildContainer(v, v.scopeRef)
      else if (v.kind === 'component' && v.scopeRef) d = buildComponent(v, v.scopeRef)
      if (d) {
        diagrams.push(d)
        viewKindByDiagram.set(d.id, v.kind)
        if (v.autoLayout?.direction) layoutHints[d.id] = { direction: v.autoLayout.direction }
      }
    }
  } else {
    // No views declared — synthesize a sensible default set.
    const landscape = buildContext(null, null)
    if (landscape) diagrams.push(landscape)
    for (const sys of all.filter((e) => e.kind === 'softwareSystem')) {
      const c = buildContainer(null, sys.path)
      if (c) diagrams.push(c)
    }
    for (const cont of all.filter((e) => e.kind === 'container')) {
      const c = buildComponent(null, cont.path)
      if (c) diagrams.push(c)
    }
    if (diagrams.length === 0 && landscape == null) {
      // Degenerate model with elements but no relationships/systems — still show all.
      const ids = objects.map((o) => o.id)
      diagrams.push({
        id: newId(),
        name: ws.name || 'Imported diagram',
        type: 'context',
        objectIds: ids,
        connectionIds: connectionsAmong(new Set(ids)),
        groupIds: modelGroupsFor(new Set(ids)),
      })
    }
  }

  // ── dynamic views → a diagram of the participants + a Flow of the steps ──────
  //
  // Each step is resolved to a model relationship the way Structurizr's own
  // DynamicView.add does, so the flow walks the edges the model declares:
  //   1. a source → destination relationship with the step's description,
  //   2. else any source → destination relationship,
  //   3. else a destination → source one, walked backwards (the reply leg),
  //   4. else an IMPLIED one — a relationship between elements inside the two
  //      endpoints (`complaintSLAFlow -> inspecteur` implies
  //      `powerAutomate -> inspecteur`). Structurizr's model holds implied
  //      relationships as real ones, and the JSON importer imports them as
  //      connections, so one is minted here — on this diagram only: the
  //      structural views were composed above and draw it as the roll-up the
  //      canvas already derives.
  // A step none of these explains is named, never invented.
  const flows: Flow[] = []
  const impliedConnectionIds = new Map<string, string>()
  const firstMatching = (ids: readonly string[], description: string | undefined): string | undefined =>
    (description ? ids.find((id) => connectionById(id)?.label === description) : undefined) ?? ids[0]
  const connectionById = (id: string) => connections.find((c) => c.id === id)
  const impliedConnection = (from: RawElement, to: RawElement): string | undefined => {
    const fromId = objectIdByRef.get(from.path)!
    const toId = objectIdByRef.get(to.path)!
    const key = `${fromId}→${toId}`
    const known = impliedConnectionIds.get(key)
    if (known) return known
    const underlying = resolvedRelationships.find(
      (r) => isWithin(r.src, from) && isWithin(r.dst, to) && !(r.src === from && r.dst === to),
    )
    if (!underlying) return undefined
    const id = newId()
    connections.push({
      id,
      fromId,
      toId,
      label: underlying.description ?? '',
      type: 'solid',
      shape: 'curved',
      tagAssignments: {},
      tagOrder: [],
      // Derived, not authored: the DSL exporter leaves it out (see the key).
      properties: { [IMPLIED_RELATIONSHIP_PROPERTY]: 'true' },
    })
    impliedConnectionIds.set(key, id)
    return id
  }
  const unexplainedSteps: string[] = []
  for (const view of ws.views) {
    if (view.kind !== 'dynamic') continue
    const scope = view.scopeRef ? resolveRef(view.scopeRef) : undefined
    const label = view.title?.trim() || view.key || view.description || `${scope?.name ?? ws.name ?? 'Workspace'} - Dynamic`
    const indexed = (view.steps ?? []).map((step, index) => ({ step, index }))
    if (indexed.some(({ step }) => step.order !== undefined)) {
      // An explicit `2:` places a step; one without keeps its file position
      // relative to the others without one (the JSON importer's rule).
      indexed.sort((a, b) => {
        const ao = a.step.order
        const bo = b.step.order
        if (ao === undefined && bo === undefined) return a.index - b.index
        if (ao === undefined) return 1
        if (bo === undefined) return -1
        return compareOrder(ao, bo) || a.index - b.index
      })
    }
    const objectIds: string[] = []
    const memberKinds = new Set<RawElement['kind']>()
    const connectionIds: string[] = []
    const steps: FlowStep[] = []
    for (const { step } of indexed) {
      const from = resolveRef(step.sourceRef, scope?.path)
      const to = resolveRef(step.destRef, scope?.path)
      if (!from || !to) {
        unexplainedSteps.push(`${label}: ${step.sourceRef} -> ${step.destRef} (unknown element)`)
        continue
      }
      const fromId = objectIdByRef.get(from.path)!
      const toId = objectIdByRef.get(to.path)!
      // The step keeps its own direction; a reverse match only picks the edge.
      const connectionId =
        firstMatching(connIdsByEndpoints.get(`${fromId}→${toId}`) ?? [], step.description) ??
        firstMatching(connIdsByEndpoints.get(`${toId}→${fromId}`) ?? [], step.description) ??
        impliedConnection(from, to) ??
        impliedConnection(to, from)
      if (!connectionId) {
        unexplainedSteps.push(`${label}: ${step.sourceRef} -> ${step.destRef} (no relationship in the model)`)
        continue
      }
      for (const [id, el] of [[fromId, from], [toId, to]] as const) {
        if (!objectIds.includes(id)) objectIds.push(id)
        memberKinds.add(el.kind)
      }
      if (!connectionIds.includes(connectionId)) connectionIds.push(connectionId)
      steps.push({
        id: newId(),
        order: steps.length + 1,
        type: 'message',
        // The step's own words: the same relationship is often walked with a
        // different description per flow ("8. Upsert account").
        title: step.description ?? connectionById(connectionId)?.label ?? '',
        fromObjectId: fromId,
        toObjectId: toId,
        connectionId,
      })
    }
    if (steps.length === 0) continue
    const diagram: Diagram = {
      id: newId(),
      name: label,
      ...(view.key ? { sourceViewKey: view.key } : {}),
      ...(view.description ? { description: view.description } : {}),
      type: memberKinds.has('component') ? 'component' : memberKinds.has('container') ? 'container' : 'context',
      objectIds,
      connectionIds,
      groupIds: modelGroupsFor(new Set(objectIds)),
    }
    diagrams.push(diagram)
    viewKindByDiagram.set(diagram.id, 'dynamic')
    if (view.autoLayout?.direction) layoutHints[diagram.id] = { direction: view.autoLayout.direction }
    flows.push({ id: newId(), name: label, diagramId: diagram.id, steps })
  }
  if (unexplainedSteps.length > 0) {
    warnings.push(
      `Dynamic-view step(s) with no matching relationship were skipped: ${unexplainedSteps.join('; ')}.`,
    )
  }

  if (unsupportedExpressions.size > 0) {
    warnings.push(
      `View include/exclude expressions are not supported and were ignored: ${[...unsupportedExpressions].sort().join(', ')}.`,
    )
  }

  // Entry diagram: prefer an actual systemLandscape view (by view kind, not name —
  // a landscape view may use any key/name), then a name match as a fallback for
  // synthesized diagrams, then the first context, then the first diagram.
  const entry =
    diagrams.find((d) => viewKindByDiagram.get(d.id) === 'systemLandscape') ??
    diagrams.find((d) => /landscape/i.test(d.name)) ??
    diagrams.find((d) => d.type === 'context') ??
    diagrams[0] ??
    null

  const stats: ImportStats = {
    objects: objects.length,
    connections: connections.length,
    groups: groups.length,
    diagrams: diagrams.length,
    byLevel: {
      context: diagrams.filter((d) => d.type === 'context').length,
      container: diagrams.filter((d) => d.type === 'container').length,
      component: diagrams.filter((d) => d.type === 'component').length,
    },
  }

  return {
    objects,
    connections,
    groups,
    tags: [...tagByValue.values()],
    diagrams,
    layoutHints,
    flows,
    entryDiagramId: entry?.id ?? null,
    warnings,
    stats,
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
