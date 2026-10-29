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

import type { C4Object, Diagram } from '../../types'
import { SOURCE_IDENTIFIER_PROPERTY } from '../structurizr/mapper'
import { objectLinkUrl } from '../objectLinks'
import { absoluteIconUrl, artworkOf } from './structurizrArtwork'
import { DATASTORE_STYLE_TAG } from './structurizrJson/styles'
import {
  SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION,
  SYNTHETIC_UNGROUPED_SYSTEM_NAME,
  buildExportContext,
  createExportIds,
  scopeTagsFor,
  type ExportContext,
  type WireElementKind,
} from './structurizrJson/types'
import type { ExportBundle } from './types'
import {
  IMPLIED_RELATIONSHIP_PROPERTY,
  isDerivedMapleSpireKey,
  technologyStringOf,
} from '../structurizr/maplespireFacts'
import { DSL_IDENTIFIER_PROPERTY, URL_PROPERTY } from '../structurizr/json/provenance'
import { maplespireConnectionProperties, maplespireObjectProperties } from './structurizrJson/model'

/**
 * Export the model as a Structurizr DSL workspace — the inverse of
 * `lib/structurizr/mapper.ts`, mirroring its conventions so a round-trip
 * re-imports cleanly:
 *   actor → person · system → softwareSystem · app/store → container ·
 *   component → component; external systems carry an "External" tag, internal
 *   actors an "Internal" tag (the import's scope detection reads those);
 *   technology usages join into the technology string (store technology re-triggers
 *   the importer's datastore detection).
 * Diagrams become structural views (systemLandscape / systemContext /
 * container / component). Model-level groups are not emitted (the DSL `group`
 * block wraps declarations lexically, which our free-form groups can't map to);
 * boundary groups are re-synthesised by the importer from the hierarchy.
 *
 * The JUDGEMENTS are not re-derived here. `buildExportContext` — the same index
 * the workspace-JSON exporter reads — answers what each object is on the wire,
 * which element it is emitted under, and which have no system above them; and
 * `ExportIds.viewKey` mints the view keys. That is not tidiness: the two
 * exporters are two serialisations of ONE landscape, and a customer holding both
 * files was getting two different answers out of them. The DSL demoted nothing,
 * so a person nested in a software system produced DSL that does not parse; it
 * slugged view keys to lower case while the JSON preserved them, so one diagram
 * had two names; and it emitted `element "Database" { shape Cylinder }` keyed on
 * a tag `tagsOf` never applied to anything.
 */

const IDENT_RE = /[^a-zA-Z0-9_]/g

function escapeDsl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')
}

const q = (s: string) => `"${escapeDsl(s)}"`

/** Assign every object a unique, DSL-safe identifier derived from its name. */
function buildIdentifiers(objects: C4Object[]): Map<string, string> {
  const used = new Set<string>()
  const byId = new Map<string, string>()
  for (const o of objects) {
    // Prefer the identifier the workspace was imported with. Re-slugging the
    // display name means renaming an element silently rewrites its identifier
    // and every relationship line that references it, so a checked-in .dsl
    // cannot be diffed against the source it came from.
    const source = o.properties?.[SOURCE_IDENTIFIER_PROPERTY]?.trim()
    let base = source || o.name.toLowerCase().replace(IDENT_RE, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_')
    if (!base || /^\d/.test(base)) base = `el_${base}`
    let ident = base
    for (let i = 2; used.has(ident); i++) ident = `${base}_${i}`
    used.add(ident)
    byId.set(o.id, ident)
  }
  return byId
}

/** Versions included (`"Angular 17, TypeScript"`); the importer parses them back. */
function technologyOf(o: Pick<C4Object, 'technologyUsages' | 'technologyUsageOrder'>): string {
  return technologyStringOf(o) ?? ''
}

/**
 * The `properties { … }` block of an element or relationship: the customer's
 * own properties, minus our stamps that are emitted as something else (the
 * identifier IS the DSL identifier, the url IS `url`) and minus stale copies of
 * the MapleSpire facts, plus those facts re-derived from the live fields —
 * status, owners, domain, extra links, the compact summary, technology
 * versions and notes, a connection's Markdown. Writing `properties` raw sent
 * the stale copies out and every live MapleSpire field not at all.
 */
function propertiesOf(own: Readonly<Record<string, string>> | undefined, facts: Record<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, value] of Object.entries(own ?? {})) {
    if (key === SOURCE_IDENTIFIER_PROPERTY || key === DSL_IDENTIFIER_PROPERTY || key === URL_PROPERTY) continue
    if (isDerivedMapleSpireKey(key)) continue
    out.push([key, String(value)])
  }
  for (const [key, value] of Object.entries(facts)) out.push([key, value])
  return out
}

/**
 * Tags the importer reads back, merged with the object's own.
 *
 * `Database` is here because the STYLE below is keyed on it. It was not, so the
 * DSL exporter emitted `element "Database" { shape Cylinder }` matching nothing,
 * and a data store came back from a `.dsl` round trip as a plain application
 * unless its technology string happened to trip `isDatastore`. The
 * workspace-JSON exporter got this right; the two files described the same
 * customer's store differently.
 *
 * The order mirrors the JSON side exactly — synthetic tags before the author's —
 * because the DSL resolves styles the same way, rightmost match wins, and an
 * author who styled their queue `Pipe` must not have it redrawn as a `Cylinder`.
 * The scope tags come from `scopeTagsFor`, which reads the same
 * `EXTERNAL_TAG_RE` / `INTERNAL_TAG_RE` the importer matches against — this file
 * used its own inline `/external/i`, a second spelling of one rule.
 */
function tagsOf(o: C4Object, bundle: ExportBundle, kind: WireElementKind): string[] {
  const byId = new Map(bundle.tags.map((tag) => [tag.tagId, tag]))
  const author = o.tagOrder.map((tagId) => byId.get(tagId)?.value ?? tagId)
  const tags: string[] = []
  if (o.type === 'store' && !author.some((t) => t.toLowerCase() === DATASTORE_STYLE_TAG.toLowerCase())) {
    tags.push(DATASTORE_STYLE_TAG)
  }
  const artwork = artworkOf(o)
  if (artwork && !author.includes(artwork.tag)) tags.push(artwork.tag)
  tags.push(...author, ...scopeTagsFor(o, kind, author))
  return tags
}

/** The DSL keyword for a wire kind. One mapping, from the shared index. */
function keywordFor(kind: WireElementKind): string {
  return kind
}

export function buildStructurizrDsl(
  bundle: ExportBundle,
  options: {
    /**
     * Origin to resolve stored icon paths against. Icons are same-origin
     * (`/icons/light/<hash>.png`), so without it the exported `icon` styles
     * point at a path no other renderer can fetch. Callers in the browser pass
     * `window.location.origin`; tests pass a fixed value.
     */
    iconOrigin?: string
  } = {},
): string {
  const { iconOrigin } = options
  const objects = bundle.objects
  const identById = buildIdentifiers(objects)
  // The one index both exporters read. It has already hoisted people to the top
  // level, demoted a nested software system to a container, flattened a
  // component inside a component onto its container, and listed the shapes with
  // no system above them.
  const ctx: ExportContext = buildExportContext(bundle)
  const objById = ctx.objectById
  const childrenOf = (objectId: string): C4Object[] =>
    ctx
      .childObjectIds(objectId)
      .map((id) => objById.get(id))
      .filter((child): child is C4Object => child !== undefined)
  const kindOf = (o: C4Object): WireElementKind => ctx.kindByObjectId.get(o.id) ?? 'container'
  const topLevel = ctx.rootObjectIds
    .map((id) => objById.get(id))
    .filter((o): o is C4Object => o !== undefined)

  const lines: string[] = []
  const push = (depth: number, s: string) => lines.push('    '.repeat(depth) + s)

  // One element declaration, with its children nested. `asKind` lets the
  // synthetic wrappers re-home invalid placements (see below).
  const emitElement = (o: C4Object, depth: number, asKind = kindOf(o)): void => {
    const ident = identById.get(o.id)!
    const tech = technologyOf(o)
    const head = [`${ident} = ${keywordFor(asKind)}`, q(o.name)]
    if (o.description || tech || asKind === 'container' || asKind === 'component') head.push(q(o.description ?? ''))
    if (tech || asKind === 'container' || asKind === 'component') head.push(q(tech))
    const tags = tagsOf(o, bundle, asKind)
    const kids = childrenOf(o.id)
    const props = propertiesOf(o.properties, maplespireObjectProperties(ctx, o))
    const hasBody = tags.length > 0 || (o.links?.length ?? 0) > 0 || kids.length > 0 || props.length > 0
    if (!hasBody) {
      push(depth, head.join(' '))
      return
    }
    push(depth, `${head.join(' ')} {`)
    if (tags.length) push(depth + 1, `tags ${tags.map(q).join(' ')}`)
    if (o.links?.[0]) push(depth + 1, `url ${q(objectLinkUrl(o.links[0]))}`)
    if (props.length) {
      push(depth + 1, 'properties {')
      for (const [k, v] of props) push(depth + 2, `${q(k)} ${q(String(v))}`)
      push(depth + 1, '}')
    }
    // No re-derivation: `ctx.childObjectIds` only yields children this element
    // legally owns, and `ctx.kindByObjectId` has already decided what each is.
    // The rule that stood here kept `person` and `softwareSystem` un-demoted,
    // which emits `person` inside `softwareSystem` — DSL that does not parse.
    for (const kid of kids) emitElement(kid, depth + 1)
    push(depth, '}')
  }

  push(0, `workspace ${q(bundle.landscapeName)} {`)
  push(1, 'model {')

  // Top-level persons and systems first, in stable model order.
  const orphanIds = new Set(ctx.orphanObjectIds)
  const orphans: C4Object[] = []
  for (const o of topLevel) {
    if (orphanIds.has(o.id)) orphans.push(o)
    else emitElement(o, 2)
  }
  // Containers/components with no parent aren't valid at the top level of a DSL
  // model — wrap them in a synthetic system so nothing is lost on export. The
  // name and the description are shared with the JSON exporter: two exports of
  // one landscape that disagree about them give a customer two different
  // systems.
  if (orphans.length) {
    push(
      2,
      `ungrouped = softwareSystem ${q(SYNTHETIC_UNGROUPED_SYSTEM_NAME)} ` +
        `${q(SYNTHETIC_UNGROUPED_SYSTEM_DESCRIPTION)} {`,
    )
    for (const o of orphans) emitElement(o, 3, 'container')
    push(2, '}')
  }

  if (bundle.connections.length) push(2, '')
  for (const c of bundle.connections) {
    // Structurizr derives implied relationships itself; writing one makes it authored.
    if (c.properties?.[IMPLIED_RELATIONSHIP_PROPERTY] === 'true') continue
    const from = identById.get(c.fromId)
    const to = identById.get(c.toId)
    if (!from || !to) continue
    // `a -> b "description" "technology" { tags / url / properties }`. Only the
    // label went out before: technology, tags, url, properties, status, owners
    // and the Markdown were all dropped on every DSL export.
    const tech = technologyOf(c)
    const head = `${from} -> ${to}`
    const args = c.label || tech ? ` ${q(c.label ?? '')}${tech ? ` ${q(tech)}` : ''}` : ''
    const tags = ctx.tagValues(c)
    const url = c.properties?.[URL_PROPERTY]?.trim()
    const facts = maplespireConnectionProperties(c)
    const props = propertiesOf(c.properties, facts)
    if (tags.length === 0 && !url && props.length === 0) {
      push(2, `${head}${args}`)
      continue
    }
    push(2, `${head}${args} {`)
    if (tags.length) push(3, `tags ${tags.map(q).join(' ')}`)
    if (url) push(3, `url ${q(url)}`)
    if (props.length) {
      push(3, 'properties {')
      for (const [k, v] of props) push(4, `${q(k)} ${q(v)}`)
      push(3, '}')
    }
    push(2, '}')
  }
  push(1, '}')

  // ── views: one structural view per diagram ───────────────────────────────────
  push(1, 'views {')
  // Minted by `ExportIds`, shared with the workspace-JSON exporter. View keys
  // are deep-link targets, `filtered <baseKey>` references and `defaultView`
  // values, so the two files a customer holds for one landscape have to agree on
  // them — and they did not: this slugged to lower case and deduped
  // case-SENSITIVELY, while `View.compareTo` upstream is case-insensitive, so
  // `Ctx` was `ctx` in one file and `Ctx` in the other.
  const ids = createExportIds([])
  const viewKey = (d: Diagram): string => ids.viewKey(d)
  /** The scope element a drill-down view needs: the diagram's parent object, or
   * the shared parent of its members. */
  const scopeFor = (d: Diagram, memberType: 'system' | 'appstore'): string | null => {
    if (d.parentObjectId && identById.has(d.parentObjectId)) return identById.get(d.parentObjectId)!
    for (const oid of d.objectIds) {
      const o = objById.get(oid)
      const okType = memberType === 'system' ? o && (o.type === 'app' || o.type === 'store') : o?.type === 'component'
      if (okType && o?.parentId && identById.has(o.parentId)) return identById.get(o.parentId)!
    }
    return null
  }
  for (const d of bundle.diagrams) {
    const key = viewKey(d)
    // Sorted, not in objectIds order. Membership is derived from a Set whose
    // iteration order follows insertion, so it differs between the original
    // import and a re-import of our own export — which showed up as a spurious
    // diff on every round trip of a checked-in .dsl. The set is what matters
    // here, not the order, so pick an order that cannot drift.
    const includes = d.objectIds
      .map((id) => identById.get(id))
      .filter((ident): ident is string => Boolean(ident))
      .sort()
      .join(' ')
    if (!includes) continue
    if (d.type === 'context') {
      const scope = d.parentObjectId && identById.has(d.parentObjectId) ? identById.get(d.parentObjectId)! : null
      if (scope) {
        push(2, `systemContext ${scope} ${q(key)} {`)
      } else {
        push(2, `systemLandscape ${q(key)} {`)
      }
    } else if (d.type === 'container') {
      const scope = scopeFor(d, 'system')
      if (!scope) {
        push(2, `# container view ${q(key)} skipped: no parent system resolvable`)
        continue
      }
      push(2, `container ${scope} ${q(key)} {`)
    } else {
      const scope = scopeFor(d, 'appstore')
      if (!scope) {
        push(2, `# component view ${q(key)} skipped: no parent container resolvable`)
        continue
      }
      push(2, `component ${scope} ${q(key)} {`)
    }
    push(3, `include ${includes}`)
    push(3, 'autoLayout')
    push(2, '}')
  }

  // ── styles ───────────────────────────────────────────────────────────────
  // Without this a MapleSpire landscape re-opens in Structurizr as uniformly
  // blue rounded boxes: no icons, no cylinders for datastores, no person
  // shapes. Emitted INLINE rather than as a `theme <url>`, because a theme has
  // to be hosted somewhere before it resolves and an inline block does not.
  const artworkByTag = new Map<string, { label: string; path: string }>()
  for (const o of objects) {
    const artwork = artworkOf(o)
    if (artwork && !artworkByTag.has(artwork.tag)) {
      artworkByTag.set(artwork.tag, { label: artwork.label, path: artwork.path })
    }
  }
  const shapeStyles: Array<[string, string]> = []
  if (objects.some((o) => o.type === 'actor')) shapeStyles.push(['Person', 'Person'])
  if (objects.some((o) => o.type === 'store')) shapeStyles.push(['Database', 'Cylinder'])
  if (objects.some((o) => o.type === 'component')) shapeStyles.push(['Component', 'Component'])

  if (shapeStyles.length || artworkByTag.size) {
    push(2, 'styles {')
    for (const [tag, shape] of shapeStyles) {
      push(3, `element ${q(tag)} {`)
      push(4, `shape ${shape}`)
      push(3, '}')
    }
    for (const [tag, { path }] of [...artworkByTag].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      push(3, `element ${q(tag)} {`)
      push(4, `icon ${q(absoluteIconUrl(path, iconOrigin))}`)
      push(3, '}')
    }
    push(2, '}')
  }

  push(1, '}')
  push(0, '}')
  return lines.join('\n') + '\n'
}
