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
 * `views.configuration` — styles and provenance — plus workspace documentation
 * and decisions.
 *
 * **Structurizr styles key on TAGS and on nothing else.** There is no per-element
 * colour anywhere in the format, so every appearance this file carries across has
 * to be expressed as "everything tagged X looks like this". That is a real
 * constraint, not a formatting choice: a landscape where two shapes carrying the
 * same tags look different cannot be stated, and this file says so out loud
 * (`ctx.warn`) rather than picking one of them and shipping a file that looks
 * subtly wrong.
 *
 * Three defaults from §7.4 decide most of what is worth emitting at all:
 *
 *  - an unstyled element is a `Box`, `#ffffff` on `#444444` in light mode, and a
 *    style that restates that is noise in a file the customer has to read;
 *  - an unstyled relationship is **DASHED**. Our connections are usually solid,
 *    and "solid" is only true if we say it — silence means dashed;
 *  - `stroke` is DERIVED from `background` when nothing sets it (§7.5), so
 *    emitting a stroke we did not get from the customer would replace a coherent
 *    shade with a guess.
 *
 * Those defaults are not re-typed here. They are read out of the IMPORTER's
 * resolver by resolving the empty tag list, so "what a reader draws without us"
 * has one definition in the codebase and this file cannot drift from the one the
 * import side implements.
 *
 * Colours are lowercase `#rrggbb` or they are not emitted: `#fff`, `rgb(…)` and
 * a colour name that is not one of Java's 148 all abort the read of the WHOLE
 * workspace (§7.7), so a colour we cannot convert is dropped with a warning
 * rather than risking the customer's entire file for one chip colour.
 */

import type { C4Object, Connection } from '../../../types'
import { STYLE_PREFIX } from '../../structurizr/json/provenance'
import { resolveElementStyle, resolveRelationshipStyle } from '../../structurizr/json/styles'
import { importedTagColor } from '../../structurizr/mapper'
import { absoluteIconUrl, artworkOf, isRelativeIconPath } from '../structurizrArtwork'
import { RESERVED_WIRE_TAGS, WIRE_DEFAULT_TAGS, scopeTagsFor } from './types'
import type {
  ExportContext,
  WireElementStyle,
  WireLineStyle,
  WireProperties,
  WireRelationshipStyle,
  WireShape,
  WireStyles,
  WireViewConfiguration,
} from './types'

// ── the tags this file styles ────────────────────────────────────────────────

/** Structurizr's own default tag on every person element (§7.1), so a style
 *  keyed on it needs nothing added to the model. */
const PERSON_STYLE_TAG = 'Person'
/** Likewise for components. */
const COMPONENT_STYLE_TAG = 'Component'
/**
 * A data store has NO default tag of its own — the wire calls it a `Container`
 * like any other. Structurizr's own examples tag one `Database` and style that,
 * and the tag is also what makes the round trip close: `isDatastore()` re-reads
 * the type from technology and tags, never from the shape, so a store exported
 * without this comes back as a plain application.
 */
export const DATASTORE_STYLE_TAG = 'Database'
/** The default tag on every relationship (§5.4), i.e. the whole-model baseline. */
const RELATIONSHIP_STYLE_TAG = 'Relationship'

/**
 * Tags the MODEL emitter must append to an element's `tags` string, beyond the
 * type defaults and the author's own tags.
 *
 * It lives here because the styles below are keyed on them: a `Cylinder` hung on
 * `Database` and an `icon` hung on `ms-icon-react` do nothing at all unless the
 * element carries those tags, and two emitters deciding independently which
 * synthetic tags exist is the failure this seam removes.
 */
export function styleTagsFor(ctx: ExportContext, object: C4Object): string[] {
  const existing = ctx.tagValues(object)
  const out: string[] = []
  if (object.type === 'store' && !existing.some((tag) => tag.toLowerCase() === DATASTORE_STYLE_TAG.toLowerCase())) {
    out.push(DATASTORE_STYLE_TAG)
  }
  const artwork = artworkOf(object, ctx.colorScheme === 'Dark' ? 'dark' : 'light')
  if (artwork && !existing.includes(artwork.tag)) out.push(artwork.tag)
  return out
}

/**
 * The FULL ordered tag list one element carries on the wire — the single reading
 * the model emitter writes out and every style decision here simulates.
 *
 * The order is not cosmetic and it is not arbitrary: Structurizr applies styles
 * left to right and the RIGHTMOST match wins per property (§7.2). The synthetic
 * tags this exporter adds therefore sit BEFORE the author's own, not after: they
 * are our defaults for a C4 level, and a customer who tagged their queue `Queue`
 * and styled it `Pipe` upstream must not have it redrawn as a `Cylinder` because
 * we appended `Database` to the right of their tag. That is exactly what
 * happened to `Order Queue` in `styled-scope-listed-and-routed-edges.json`.
 */
export function wireTagsWith(
  ctx: ExportContext,
  object: C4Object,
  defaults: readonly string[],
): string[] {
  const author = ctx.tagValues(object)
  const deploymentKind = ctx.deploymentKindByObjectId.get(object.id)
  if (deploymentKind === 'containerInstance' || deploymentKind === 'softwareSystemInstance') {
    // §5.5: an instance carries neither `Element` nor the instantiated element's
    // tags — style resolution injects those — so only what is genuinely its own.
    const targetId = ctx.instantiatedByObjectId.get(object.id)
    const target = targetId === undefined ? undefined : ctx.objectById.get(targetId)
    const inherited = new Set(target ? ctx.tagValues(target) : [])
    return dedupeTags([...defaults, ...author.filter((tag) => !inherited.has(tag))])
  }
  const kind = ctx.kindByObjectId.get(object.id) ?? 'container'
  return dedupeTags([
    ...defaults,
    ...styleTagsFor(ctx, object),
    ...author,
    ...scopeTagsFor(object, kind, author),
  ])
}

/** The list `wireTagsWith` produces for an element the model emitter has not
 *  overridden the defaults of — which is every element but a stranded one. */
export function wireTagsFor(ctx: ExportContext, object: C4Object): string[] {
  return wireTagsWith(ctx, object, ctx.wireDefaultTagsFor(object.id))
}

/** Order-preserving dedupe on trimmed values. Tag order is meaningful, so this
 *  never sorts. */
export function dedupeTags(values: Iterable<string>): string[] {
  const out: string[] = []
  for (const value of values) {
    const token = value.trim()
    if (token && !out.includes(token)) out.push(token)
  }
  return out
}

// ── colour (§7.7) ────────────────────────────────────────────────────────────

const HEX_6 = /^#[0-9a-f]{6}$/i
const HEX_3 = /^#[0-9a-f]{3}$/i
const FUNCTIONAL_COLOR = /^(rgb|hsl)a?\(([^)]*)\)$/i

/** `#rrggbb` from whatever CSS colour MapleSpire happens to hold, or nothing.
 *
 *  `hsl(...)` is not an exotic case: every tag minted by an import that had no
 *  style for it gets one (`importedTag`), so refusing to convert would silently
 *  drop the palette of the most common workspace there is. */
function toWireColor(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === '') return undefined
  if (HEX_6.test(value)) return value.toLowerCase()
  if (HEX_3.test(value)) {
    const [, r, g, b] = value.toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }
  const functional = FUNCTIONAL_COLOR.exec(value)
  if (!functional) return undefined
  const parts = (functional[2] ?? '').split(/[\s,/]+/).filter((part) => part !== '')
  const numbers = parts.map((part) => ({ value: Number.parseFloat(part), percent: part.endsWith('%') }))
  if (numbers.length < 3 || numbers.slice(0, 3).some((n) => !Number.isFinite(n.value))) return undefined
  const [first, second, third] = numbers as [
    { value: number; percent: boolean },
    { value: number; percent: boolean },
    { value: number; percent: boolean },
  ]
  // Alpha is deliberately ignored: the wire has no alpha channel on a colour,
  // and `opacity` is a separate whole-element percentage that would apply to the
  // border and the text as well as to the fill.
  if ((functional[1] ?? '').toLowerCase() === 'rgb') {
    return toHex(
      first.percent ? (first.value / 100) * 255 : first.value,
      second.percent ? (second.value / 100) * 255 : second.value,
      third.percent ? (third.value / 100) * 255 : third.value,
    )
  }
  return hslToHex(first.value, second.value / 100, third.value / 100)
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => clampChannel(c).toString(16).padStart(2, '0')).join('')}`
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = Math.min(1, Math.max(0, saturation))
  const l = Math.min(1, Math.max(0, lightness))
  const c = (1 - Math.abs(2 * l - 1)) * s
  const h = (((hue % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] =
    h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255)
}

/** WCAG relative luminance of a normalised `#rrggbb`. */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => {
    const srgb = Number.parseInt(hex.slice(at, at + 2), 16) / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/** WCAG contrast ratio between two normalised `#rrggbb` colours. */
function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number]
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Black or white, whichever the reader can actually read on this background.
 *
 * Only used where the reader's own default text colour fails — a coloured tag is
 * otherwise worse than no tag at all, because the text stays at its `#444444`
 * default (§7.4) and `background: #08427b`, the single most common Structurizr
 * blue, renders dark grey on navy. Where the default IS readable it is left
 * alone: overriding it would restate the customer's file in our words for no
 * gain.
 */
function readableTextColor(background: string): string {
  return contrastRatio(background, '#000000') >= contrastRatio(background, '#ffffff') ? '#000000' : '#ffffff'
}

/** WCAG AA for body text. Below this the label is not readable, which is the
 *  only reason we would overrule the reader's default. */
const MINIMUM_CONTRAST = 4.5

// ── shapes (§16) ─────────────────────────────────────────────────────────────

/** An enum value the reader does not recognise reads back as `null` (§4.1) —
 *  silently, so a mis-cased shape is a diagram with the shape simply gone. */
const WIRE_SHAPES: ReadonlySet<string> = new Set<WireShape>([
  'Box', 'RoundedBox', 'Circle', 'Ellipse', 'Hexagon', 'Diamond', 'Cylinder', 'Bucket', 'Pipe',
  'Person', 'Robot', 'Folder', 'WebBrowser', 'Window', 'Terminal', 'Shell',
  'MobileDevicePortrait', 'MobileDeviceLandscape', 'Component',
])

const LINE_STYLE_BY_CONNECTION_TYPE: Record<Connection['type'], WireLineStyle> = {
  solid: 'Solid',
  dashed: 'Dashed',
  dotted: 'Dotted',
}

// ── the shape of one draft style ─────────────────────────────────────────────

type ElementStyleDraft = Omit<WireElementStyle, 'tag'>
type RelationshipStyleDraft = Omit<WireRelationshipStyle, 'tag'>

/**
 * The one value every member agrees on, or nothing.
 *
 * A missing value counts as DISAGREEMENT, not as an abstention: attributing a
 * colour to a tag some of whose members do not have it would paint those members
 * a colour they never had, which is worse than losing the colour of the ones
 * that did.
 */
function unanimous<T>(values: readonly (T | undefined)[]): T | undefined {
  const first = values[0]
  if (values.length === 0 || first === undefined) return undefined
  return values.every((value) => value === first) ? first : undefined
}

/**
 * What the import side parked on an entity as `structurizr.style.*` — the
 * customer's own palette, resolved at import from a stylesheet we no longer
 * hold — normalised back to what the wire will accept.
 *
 * This is the primary source of an element's appearance in the file we write.
 * `Tag.color` is deliberately NOT consulted first, and usually not at all: it is
 * the tag CHIP colour, drawn by MapleSpire in the bottom-bar strip
 * (`canvas/bottomBarColors.ts`) and never as a shape's fill (`CanvasEngine`
 * fills from the skin), and every tag an import mints is given one
 * automatically. Consulting it ahead of the recorded properties invented a
 * palette for every imported workspace there is AND overwrote the palette the
 * customer actually had — `big-bank-plc.json` came back with nine of its shapes
 * white and five in colours the file never contained. `authoredTagColour` below
 * is the one narrow exception, for a colour a person really did choose.
 */
function recordedElementStyle(object: StyleSubject): ElementStyleDraft {
  const properties = object.properties ?? {}
  const shape = properties[`${STYLE_PREFIX}shape`]?.trim()
  const icon = properties[`${STYLE_PREFIX}icon`]?.trim()
  return {
    ...pick('background', toWireColor(properties[`${STYLE_PREFIX}background`])),
    ...pick('color', toWireColor(properties[`${STYLE_PREFIX}color`])),
    ...pick('stroke', toWireColor(properties[`${STYLE_PREFIX}stroke`])),
    ...pick('shape', shape !== undefined && WIRE_SHAPES.has(shape) ? (shape as WireShape) : undefined),
    // The customer's own icon: an imported `icon` URL (e.g. a RabbitMQ logo on
    // a queue) must be re-emitted, not only artwork MapleSpire holds itself.
    ...pick('icon', icon ? icon : undefined),
  }
}

function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/**
 * The style properties this file attributes to tags, as a `const` list.
 *
 * It is a list rather than a cast because it is read back out of a draft in the
 * loss check, and `Object.entries(draft) as ['background'|…, string][]` — which
 * is what stood there — asserts a key set the type does not have:
 * `ElementStyleDraft` also holds `strokeWidth`, `opacity`, `fontSize` and a
 * BOOLEAN `metadata`, so the moment any of those is recorded the cast types a
 * number as a string and the comparison silently compares the wrong things.
 */
const STYLED_PROPERTIES = ['background', 'color', 'stroke', 'shape', 'icon'] as const
type StyledProperty = (typeof STYLED_PROPERTIES)[number]

/**
 * The properties an export can INVENT against a customer — i.e. state for an
 * element that had none.
 *
 * `shape` and `icon` are absent because the `Cylinder` on a data store and the
 * artwork tag are this exporter's own statements about a C4 level. `color` is
 * absent because MapleSpire has no per-element text colour to lose: the value is
 * either the one recorded from the customer's file (which the LOSS half already
 * measures) or one computed here so a label stays readable on a background we
 * were given.
 */
const INVENTABLE: ReadonlySet<StyledProperty> = new Set<StyledProperty>(['background', 'stroke'])

/**
 * Everything a style can apply to. Not just `C4Object`: the import turns a
 * deployment node WITH CHILDREN into a `Group`, and a Group is still an element
 * on the wire — so leaving them out meant every deployment node in the file lost
 * the `RoundedBox` and the grey the customer's own stylesheet gave it.
 */
interface StyleSubject {
  id: string
  properties?: Record<string, string>
}

/** The deployment nodes the import stored as Groups, as style subjects, with the
 *  tag list the model emitter will write for them. */
function deploymentNodeSubjects(ctx: ExportContext): Array<{ subject: StyleSubject; tags: string[] }> {
  const out: Array<{ subject: StyleSubject; tags: string[] }> = []
  for (const group of ctx.bundle.groups) {
    if (ctx.groupRoleById.get(group.id) !== 'deploymentNode') continue
    out.push({
      subject: group,
      tags: dedupeTags([...WIRE_DEFAULT_TAGS.deploymentNode, ...ctx.tagValues(group)]),
    })
  }
  return out
}

/**
 * A colour a PERSON chose, as opposed to the hue `importedTag` hands every tag
 * an import mints.
 *
 * Nothing on a `Tag` records which of the two it is, so it is recovered by
 * recomputing the automatic one — `importedTagColor` is deterministic in the
 * tag's value, so this is exact for every tag nobody has recoloured, and
 * conservative (it says "not authored") for the one someone recoloured to
 * precisely the hue it already had.
 */
function authoredTagColour(ctx: ExportContext, value: string): string | undefined {
  const snapshot = ctx.bundle.tags.find((entry) => entry.value === value)
  if (!snapshot?.color) return undefined
  if (snapshot.color === importedTagColor(value)) return undefined
  return snapshot.color
}

/** Tag values to style, catalog order first so the file diffs stably, then any
 *  value carried by an entity whose snapshot the bundle does not hold. */
function styledTagOrder(ctx: ExportContext, usage: ReadonlyMap<string, unknown>): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const snapshot of ctx.bundle.tags) {
    if (usage.has(snapshot.value) && !seen.has(snapshot.value)) {
      ordered.push(snapshot.value)
      seen.add(snapshot.value)
    }
  }
  for (const value of usage.keys()) if (!seen.has(value)) ordered.push(value)
  return ordered
}

// ── element styles ───────────────────────────────────────────────────────────

/**
 * Attribute each element's recorded appearance to a TAG, which is the only thing
 * Structurizr styles by.
 *
 * The rule that makes this work is PRECEDENCE. An element's tags are emitted
 * general-to-specific (`Element`, then its kind, then ours, then the author's),
 * the rightmost match wins per property (§7.2), and therefore a tag is only
 * answerable for the members it is the last word on. `big-bank-plc` is the case
 * that forces it: three software systems, one `#1168bd` and two `#999999`, and
 * the only expressible answer is `Software System → #1168bd` corrected by
 * `Existing System → #999999`. Demanding unanimity across all three members —
 * which is what this did, and only over the AUTHOR's tags at that, never over
 * the kind defaults the importer strips — finds no answer at all and exports the
 * canonical Structurizr sample as an all-white diagram.
 *
 * Where a tag IS the last word, unanimity is still required, and a member with
 * no recorded value counts as disagreement rather than as an abstention: a tag
 * is what the wire styles, so anything attributed to it repaints every member,
 * including the ones that never had it.
 */
function buildElementStyles(ctx: ExportContext): WireElementStyle[] {
  const objects = ctx.bundle.objects
  // What a reader draws for an element no style matched — asked of the import
  // side's resolver rather than re-typed, so the "is this just the default?"
  // test below can never disagree with the code that reads our own file back.
  const unstyled = resolveElementStyle([], [], { colorScheme: ctx.colorScheme })

  const nodes = deploymentNodeSubjects(ctx)
  const subjects: StyleSubject[] = [...objects, ...nodes.map((entry) => entry.subject)]
  const tagsByObject = new Map<string, string[]>([
    ...objects.map((object) => [object.id, wireTagsFor(ctx, object)] as const),
    ...nodes.map((entry) => [entry.subject.id, entry.tags] as const),
  ])
  const recordedByObject = new Map<string, ElementStyleDraft>(
    subjects.map((subject) => [subject.id, recordedElementStyle(subject)]),
  )

  const membersByTag = new Map<string, StyleSubject[]>()
  for (const subject of subjects) {
    for (const tag of tagsByObject.get(subject.id)!) {
      const bucket = membersByTag.get(tag)
      if (bucket) bucket.push(subject)
      else membersByTag.set(tag, [subject])
    }
  }

  // Candidate tags, ordered general → specific. `rank` is the earliest position
  // a tag ever occupies on an element, which puts the format's own defaults
  // first, then the synthetic ones, then the author's — the order they are
  // emitted in. Ties fall back to catalog order so the file diffs stably.
  const rank = new Map<string, number>()
  for (const object of subjects) {
    for (const [at, tag] of tagsByObject.get(object.id)!.entries()) {
      const known = rank.get(tag)
      if (known === undefined || at < known) rank.set(tag, at)
    }
  }
  const catalogOrder = new Map(styledTagOrder(ctx, membersByTag).map((tag, at) => [tag, at]))
  const candidates = [...rank.keys()].sort(
    (a, b) => rank.get(a)! - rank.get(b)! || (catalogOrder.get(a) ?? 0) - (catalogOrder.get(b) ?? 0),
  )
  const candidateSet = new Set(candidates)

  const impliedShapes = new Map<string, ElementStyleDraft>()
  const draftFor = (tag: string): ElementStyleDraft => {
    const existing = impliedShapes.get(tag)
    if (existing) return existing
    const created: ElementStyleDraft = {}
    impliedShapes.set(tag, created)
    return created
  }

  // 1. Shapes our own C4 level implies. Emitted first so an author tag that also
  //    sets a shape wins — the element carries the type default first and the
  //    author's tag after it, and the rightmost match wins per property (§7.2).
  // …but only for a landscape whose appearance nobody has already described.
  // Structurizr says "no shape style" by SAYING NOTHING, so adding our own C4
  // default on top of an imported stylesheet is not filling a gap: it redraws
  // every component in `big-bank-plc` as a `Component` box and every person in
  // `parallel-edges-and-dynamic` as a `Person`, neither of which the customer's
  // file asked for. Where nothing was ever recorded there is no palette to
  // overrule and these are the only statement about a C4 level there is.
  const describedElsewhere = [...recordedByObject.values()].some((recorded) => Object.keys(recorded).length > 0)
  for (const object of describedElsewhere ? [] : objects) {
    const kind = ctx.kindByObjectId.get(object.id)
    if (kind === 'person') draftFor(PERSON_STYLE_TAG).shape = 'Person'
    if (kind === 'component') draftFor(COMPONENT_STYLE_TAG).shape = 'Component'
    if (object.type === 'store') draftFor(DATASTORE_STYLE_TAG).shape = 'Cylinder'
  }

  // 3. One `icon` style per distinct piece of artwork MapleSpire holds itself.
  //    Indexed before the attribution passes below because they re-run, and an
  //    icon is not a judgement that can be withdrawn.
  const iconByTag = new Map<string, string>()
  for (const object of objects) {
    const artwork = artworkOf(object, ctx.colorScheme === 'Dark' ? 'dark' : 'light')
    if (artwork && !iconByTag.has(artwork.tag)) iconByTag.set(artwork.tag, artwork.path)
  }
  const unfetchable = [...iconByTag.values()].filter(
    (path) => isRelativeIconPath(path) && !ctx.iconOrigin,
  )
  if (unfetchable.length > 0) {
    ctx.warn(
      `${unfetchable.length} icon(s) are stored as same-origin paths and the export was given no origin ` +
        `to resolve them against, so another renderer cannot fetch them.`,
    )
  }

  // 2. The customer's recorded palette, attributed tag by tag — then CHECKED,
  //    because the precedence rule above is optimistic in one direction. It
  //    excludes a member that carries a later candidate tag on the assumption
  //    that the later tag will correct it, and a later tag only corrects a
  //    member if it actually states that property. `Element` is the case that
  //    proves it: `positioned-container-and-deployment.json` gives its container
  //    instances the literal tag `Element` (the import keeps it, because an
  //    instance's own defaults are just `Container Instance`), so `Element` is
  //    the last word on the instances and on nothing else — and attributing
  //    their `#ffffff` to it repainted all thirteen other elements in the
  //    workspace. So every assignment is measured against the resolver, and one
  //    that costs more than it saves is withdrawn and the pass re-run with it
  //    off the table, which lets the next-best tag (`Container Instance`) claim
  //    it instead.
  const droppedColors = new Set<string>()
  /**
   * What each element SHOULD look like — the yardstick the check below measures
   * against.
   *
   * It is the recorded palette where there is one, and otherwise the colour a
   * person gave the rightmost tag the element carries, which is the same
   * rightmost-wins rule Structurizr resolves by. Without that second half a
   * landscape drawn in MapleSpire has no stated intent at all, every colour it
   * exports scores as an invention, and the check withdraws the customer's whole
   * palette.
   */
  const intendedByObject = new Map<string, ElementStyleDraft>()
  for (const subject of subjects) {
    const intended = { ...recordedByObject.get(subject.id)! }
    if (intended.background === undefined) {
      for (const tag of [...tagsByObject.get(subject.id)!].reverse()) {
        if (RESERVED_WIRE_TAGS.has(tag)) continue
        const authored = authoredTagColour(ctx, tag)
        const value = authored === undefined ? undefined : toWireColor(authored)
        if (value !== undefined) {
          intended.background = value
          break
        }
      }
    }
    intendedByObject.set(subject.id, intended)
  }
  /** `${tag}\u0000${property}` pairs a previous pass proved harmful. */
  const withdrawn = new Set<string>()
  const keyOf = (tag: string, property: StyledProperty) => `${tag}\u0000${property}`

  interface Attribution {
    drafts: Map<string, ElementStyleDraft>
    /** Tags whose background the customer's file STATED, as opposed to one this
     *  export derived from a tag's chip colour. The difference decides whether a
     *  background equal to the reader's default may be dropped as noise: it may
     *  not, because §7.5 derives `stroke` from an EXPLICIT background, so an
     *  explicit `#ffffff` draws an `#e6e6e6` border and silence draws `#444444`. */
    stated: Set<string>
    /** Every (tag, property) this pass decided, in the order it decided them. */
    assigned: Array<{ tag: string; property: StyledProperty }>
  }

  const attribute = (): Attribution => {
    const drafts = new Map<string, ElementStyleDraft>(
      [...impliedShapes].map(([tag, draft]) => [tag, { ...draft }]),
    )
    const draftFor = (tag: string): ElementStyleDraft => {
      const existing = drafts.get(tag)
      if (existing) return existing
      const created: ElementStyleDraft = {}
      drafts.set(tag, created)
      return created
    }
    const stated = new Set<string>()
    const assigned: Array<{ tag: string; property: StyledProperty }> = []
    const resolvedSoFar = new Map<string, Partial<Record<StyledProperty, string>>>(
      subjects.map((subject) => [subject.id, {}]),
    )

    for (const tag of candidates) {
      const members = membersByTag.get(tag) ?? []
      for (const property of STYLED_PROPERTIES) {
        // The members this tag is the last word on, FOR THIS PROPERTY. A member
        // carrying a later candidate tag is that tag's problem — unless that tag
        // has been withdrawn for this property, in which case it will never
        // correct anything and this tag is answerable after all.
        const answerable = members.filter((member) => {
          const list = tagsByObject.get(member.id)!
          return !list
            .slice(list.indexOf(tag) + 1)
            .some((later) => candidateSet.has(later) && !withdrawn.has(keyOf(later, property)))
        })
        if (answerable.length === 0) continue
        if (withdrawn.has(keyOf(tag, property))) continue

        const wanted = answerable.map((member) => recordedByObject.get(member.id)![property] as string | undefined)
        let value = unanimous(wanted)
        if (value === undefined && property === 'background' && wanted.every((entry) => entry === undefined)) {
          // Nothing was recorded for these — an estate drawn in MapleSpire rather
          // than imported. A colour a person chose for the tag is then the only
          // statement about appearance there is, and it is a statement about
          // exactly this tag's members. Never for a tag the FORMAT owns: a
          // customer tag that happens to be spelled `Container` would otherwise
          // repaint every container in the workspace.
          if (!RESERVED_WIRE_TAGS.has(tag)) {
            const authored = authoredTagColour(ctx, tag)
            if (authored !== undefined) {
              value = toWireColor(authored)
              if (value === undefined) droppedColors.add(authored)
            }
          }
        }
        if (value === undefined) continue
        if (answerable.every((member) => resolvedSoFar.get(member.id)![property] === value)) continue
        draftFor(tag)[property] = value as never
        assigned.push({ tag, property })
        if (property === 'background' && wanted.some((entry) => entry !== undefined)) stated.add(tag)
        for (const member of members) resolvedSoFar.get(member.id)![property] = value
      }

      // A background nothing states a text colour for needs one wherever the
      // reader's own default would be unreadable on it (§7.4 draws `#444444`, and
      // `#08427b` — the most common Structurizr blue — is dark grey on navy).
      // …unless an earlier tag already gave these members one. `Existing System`
      // inherits `#ffffff` from `Software System`; computing a fresh readable
      // colour there overrode the customer's white label with black.
      const draft = drafts.get(tag)
      const members2 = membersByTag.get(tag) ?? []
      const alreadyLabelled = members2.some((member) => resolvedSoFar.get(member.id)!.color !== undefined)
      if (draft?.background !== undefined && draft.color === undefined && !alreadyLabelled) {
        if (contrastRatio(draft.background, unstyled.color) < MINIMUM_CONTRAST) {
          draft.color = readableTextColor(draft.background)
          assigned.push({ tag, property: 'color' })
          for (const member of members2) resolvedSoFar.get(member.id)!.color = draft.color
        }
      }
    }
    return { drafts, stated, assigned }
  }

  /** The styles block one attribution produces, with the icon layer on top. */
  const assemble = (attribution: Attribution): WireElementStyle[] => {
    const drafts = new Map([...attribution.drafts].map(([tag, draft]) => [tag, { ...draft }]))
    for (const [tag, path] of [...iconByTag].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const draft = drafts.get(tag) ?? {}
      draft.icon = absoluteIconUrl(path, ctx.iconOrigin)
      drafts.set(tag, draft)
    }
    const out: WireElementStyle[] = []
    for (const [tag, draft] of drafts) {
      const restatesDefaults =
        (draft.background === undefined ||
          (draft.background === unstyled.background && !attribution.stated.has(tag))) &&
        (draft.color === undefined || draft.color === unstyled.color) &&
        (draft.stroke === undefined || draft.stroke === unstyled.stroke) &&
        (draft.shape === undefined || draft.shape === unstyled.shape) &&
        draft.icon === undefined
      if (restatesDefaults) continue
      out.push({ tag, ...draft })
    }
    return out
  }

  /**
   * How wrong a styles block is, resolved with the import side's own resolver.
   *
   * A property the customer had and the file lost counts once; a COLOUR the file
   * states that the customer never had counts once too, and that second half is
   * the one that was missing — an export that repaints a workspace it was asked
   * to preserve looked perfect to a check that only counted losses. `shape` and
   * `icon` are exempt from the invention half: the `Cylinder` on a data store and
   * the artwork tag are this exporter's own statements about a C4 level.
   */
  const mismatchCount = (styles: readonly WireElementStyle[]): number => {
    let score = 0
    for (const [subjectId, intended] of intendedByObject) {
      const resolved = resolveElementStyle(tagsByObject.get(subjectId) ?? [], styles, {
        colorScheme: ctx.colorScheme,
      })
      for (const property of STYLED_PROPERTIES) {
        const want = intended[property] as string | undefined
        const got = resolved.explicit[property] as string | undefined
        if (want !== undefined && got !== want) score += 1
        else if (want === undefined && got !== undefined && INVENTABLE.has(property)) score += 1
      }
    }
    return score
  }

  let attribution = attribute()
  let styles = assemble(attribution)
  // Bounded because each round withdraws at least one assignment and there are
  // finitely many; the cap is belt and braces against a cycle nobody has found.
  for (let round = 0; round < 8; round += 1) {
    const baseline = mismatchCount(styles)
    let worst: { tag: string; property: StyledProperty } | undefined
    for (const assignment of attribution.assigned) {
      const without = assemble({
        ...attribution,
        drafts: new Map(
          [...attribution.drafts].map(([tag, draft]) => {
            if (tag !== assignment.tag) return [tag, draft]
            const copy = { ...draft }
            delete copy[assignment.property]
            return [tag, copy]
          }),
        ),
      })
      if (mismatchCount(without) <= baseline) {
        worst = assignment
        break
      }
    }
    if (worst === undefined) break
    withdrawn.add(keyOf(worst.tag, worst.property))
    attribution = attribute()
    styles = assemble(attribution)
  }

  if (droppedColors.size > 0) {
    ctx.warn(
      `${droppedColors.size} tag colour(s) are not a form Structurizr can read and were left out of the ` +
        `styles: ${[...droppedColors].join(', ')}. Structurizr accepts #rrggbb only, and rejecting one ` +
        `aborts its read of the whole file.`,
    )
  }

  warnAboutUnexpressibleElements(ctx, styles, tagsByObject, intendedByObject)
  return styles
}

/**
 * Say what the tag-keyed form could not carry.
 *
 * Measured by resolving our OWN output with the import side's resolver, not by
 * reasoning about it: this is the same check the tests make, and it is the only
 * thing that distinguishes a palette that survived from one that was merely
 * written down somewhere.
 *
 * Both directions count. A property the customer had and the file lost is a
 * loss; a property the file states that the customer never had is an INVENTION,
 * and an export that repaints a workspace it was asked to preserve is the worse
 * of the two — it was invisible here because only the first was ever counted.
 */
function warnAboutUnexpressibleElements(
  ctx: ExportContext,
  styles: readonly WireElementStyle[],
  tagsByObject: ReadonlyMap<string, readonly string[]>,
  intendedByObject: ReadonlyMap<string, ElementStyleDraft>,
): void {
  let lost = 0
  let invented = 0
  for (const [objectId, intended] of intendedByObject) {
    const resolved = resolveElementStyle(tagsByObject.get(objectId) ?? [], styles, {
      colorScheme: ctx.colorScheme,
    })
    let wrong = false
    let extra = false
    for (const property of STYLED_PROPERTIES) {
      const want = intended[property] as string | undefined
      const got = resolved.explicit[property] as string | undefined
      if (want !== undefined && got !== want) wrong = true
      if (want === undefined && got !== undefined && INVENTABLE.has(property)) extra = true
    }
    if (wrong) lost += 1
    if (extra) invented += 1
  }
  if (lost > 0) {
    ctx.warn(
      `${lost} shape(s) had a colour or shape of their own that no tag could express — Structurizr styles by ` +
        `tag, so two shapes sharing a tag cannot look different. They take the colour of the tags they carry.`,
    )
  }
  if (invented > 0) {
    ctx.warn(
      `${invented} shape(s) are drawn in a colour they do not have in MapleSpire, because a tag they share with ` +
        `other shapes had to state one. Structurizr has no per-element colour.`,
    )
  }
}

// ── relationship styles ──────────────────────────────────────────────────────

interface ConnectionLook {
  style: WireLineStyle
  color?: string
  thickness?: number
}

function lookOf(connection: Connection): ConnectionLook {
  const properties = connection.properties ?? {}
  const thickness = Number.parseFloat(properties[`${STYLE_PREFIX}thickness`] ?? '')
  return {
    style: LINE_STYLE_BY_CONNECTION_TYPE[connection.type],
    ...pick('color', toWireColor(properties[`${STYLE_PREFIX}color`])),
    ...pick('thickness', Number.isFinite(thickness) ? thickness : undefined),
  }
}

/** `dashed` is emitted ONLY where a reader that ignores `style` would otherwise
 *  draw the wrong line. `style` is authoritative (§7.6 #5) and `dashed: true`
 *  restates the seed, so the single case worth stating twice is solid. */
function withDashedFlag(draft: RelationshipStyleDraft): RelationshipStyleDraft {
  return draft.style === 'Solid' ? { ...draft, dashed: false } : draft
}

function buildRelationshipStyles(ctx: ExportContext): WireRelationshipStyle[] {
  const connections = ctx.bundle.connections
  if (connections.length === 0) return []
  const unstyled = resolveRelationshipStyle([], [], { colorScheme: ctx.colorScheme })

  const looks = new Map<string, ConnectionLook>(connections.map((c) => [c.id, lookOf(c)]))
  const lookOfAll = (members: readonly Connection[]): RelationshipStyleDraft => ({
    ...pick('style', unanimous(members.map((c) => looks.get(c.id)?.style))),
    ...pick('color', unanimous(members.map((c) => looks.get(c.id)?.color))),
    ...pick('thickness', unanimous(members.map((c) => looks.get(c.id)?.thickness))),
  })

  // The baseline is the whole model, keyed on the tag every relationship carries.
  // Whatever the model agrees on belongs here rather than on any one tag.
  const base = lookOfAll(connections)
  const styles: WireRelationshipStyle[] = []
  const baseDraft: RelationshipStyleDraft = {
    ...pick('style', base.style !== undefined && base.style !== unstyled.style ? base.style : undefined),
    ...pick('color', base.color !== undefined && base.color !== unstyled.color ? base.color : undefined),
    ...pick(
      'thickness',
      base.thickness !== undefined && base.thickness !== unstyled.thickness ? base.thickness : undefined,
    ),
  }
  if (Object.keys(baseDraft).length > 0) {
    styles.push({ tag: RELATIONSHIP_STYLE_TAG, ...withDashedFlag(baseDraft) })
  }

  const connectionsByTag = new Map<string, Connection[]>()
  for (const connection of connections) {
    for (const value of ctx.tagValues(connection)) {
      const bucket = connectionsByTag.get(value)
      if (bucket) bucket.push(connection)
      else connectionsByTag.set(value, [connection])
    }
  }
  for (const value of styledTagOrder(ctx, connectionsByTag)) {
    const members = connectionsByTag.get(value) ?? []
    const agreed = lookOfAll(members)
    // Only what this tag says that the baseline does not — a per-tag style
    // repeating the baseline is noise, and one repeating a default is worse.
    const draft: RelationshipStyleDraft = {
      ...pick('style', agreed.style !== undefined && agreed.style !== (base.style ?? unstyled.style) ? agreed.style : undefined),
      ...pick('color', agreed.color !== undefined && agreed.color !== (base.color ?? unstyled.color) ? agreed.color : undefined),
      ...pick(
        'thickness',
        agreed.thickness !== undefined && agreed.thickness !== (base.thickness ?? unstyled.thickness)
          ? agreed.thickness
          : undefined,
      ),
    }
    if (Object.keys(draft).length > 0) styles.push({ tag: value, ...withDashedFlag(draft) })
  }

  let lost = 0
  for (const connection of connections) {
    const want = looks.get(connection.id)!
    const resolved = resolveRelationshipStyle(
      [RELATIONSHIP_STYLE_TAG, ...ctx.tagValues(connection)],
      styles,
      { colorScheme: ctx.colorScheme },
    )
    const colorLost = want.color !== undefined && resolved.color !== want.color
    const thicknessLost = want.thickness !== undefined && resolved.thickness !== want.thickness
    if (resolved.style !== want.style || colorLost || thicknessLost) lost += 1
  }
  if (lost > 0) {
    ctx.warn(
      `${lost} relationship(s) have a line style or colour no tag could express — Structurizr styles ` +
        `relationships by tag, so lines that share their tags cannot differ. They take the styled line.`,
    )
  }

  return styles
}

export function buildWireStyles(ctx: ExportContext): WireStyles {
  const elements = buildElementStyles(ctx)
  const relationships = buildRelationshipStyles(ctx)
  return {
    ...(elements.length > 0 ? { elements } : {}),
    ...(relationships.length > 0 ? { relationships } : {}),
  }
}

// ── the rest of `views.configuration` ────────────────────────────────────────

/**
 * `views.configuration` in full: the styles, the entry view, and enough
 * provenance that a support engineer holding a customer's file can tell where it
 * came from and what its coordinates mean.
 *
 * `terminology` is NOT emitted, and neither is `branding` — the latter is §2
 * legacy (Structurizr deletes it on the next save), and MapleSpire uses C4's own
 * words for every element level, so a terminology block would say "a Person is
 * called a Person" in five keys. `themes` is not emitted either: the import side
 * resolves a theme into the styles it produced and keeps no reference string, so
 * there is nothing faithful left to re-emit (the styles above ARE the theme,
 * inlined).
 */
export function buildWireViewConfiguration(ctx: ExportContext): WireViewConfiguration {
  const styles = buildWireStyles(ctx)
  const activeDiagram = ctx.bundle.activeDiagramId
    ? ctx.diagramById.get(ctx.bundle.activeDiagramId)
    : undefined
  const properties: WireProperties = {
    'maplespire.export': 'structurizr-json',
    'maplespire.exportedAt': ctx.now,
    'maplespire.landscape': ctx.bundle.landscapeName,
    // Both of these are answers to questions a support engineer actually asks of
    // a file that looks wrong: "which half of the palette is this?" and "why are
    // the coordinates not the ones in our database?". The scale is the DEFAULT —
    // the one each view refines — and each view now stamps the factor it was
    // actually written with in its own `properties`, because this number alone
    // is one no view had used.
    'maplespire.colorScheme': ctx.colorScheme,
    'maplespire.defaultLayoutScale': String(ctx.layoutScale),
  }
  return {
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
    ...(activeDiagram ? { defaultView: ctx.ids.viewKey(activeDiagram) } : {}),
    properties,
  }
}

// ── documentation and decisions ────────────────────────────────────────────
//
// NOT here. `buildWireDocumentation` is implemented in `./model.ts`, which is
// what `index.ts` imports, and a second implementation of one exported contract
// is exactly the drift splitting this module was meant to avoid. Two things in
// that one are worth fixing THERE rather than forking it: §5.6 requires CR and
// CRLF in decision content to be normalised to LF (a Windows-authored record
// otherwise reads back changed on every round trip, and shows up as a diff that
// is not a change), and `DecisionRecord.summary` — the one line of a decision
// most people read — has no field of its own on the wire, so it has to be folded
// into `content` or it is dropped.
