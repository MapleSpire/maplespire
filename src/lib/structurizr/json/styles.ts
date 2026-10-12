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
 * Structurizr style resolution — `docs/structurizr-json-format.md` §7.
 *
 * Resolution is what decides whether an imported diagram LOOKS like the one the
 * customer had. Two implementations of it exist upstream and they disagree;
 * `structurizr-ui.js` is the one that painted the customer's screen, so every
 * divergence in §7.6 is settled in its favour here, and the places where that
 * costs us are named at the call site.
 *
 * Decisions this file makes, because the format does not make them for us:
 *
 * - **We resolve the LIGHT scheme.** §18.4: nothing in the wire format states
 *   which `ColorScheme` a reader should pick, and §13 has no entry for it. Light
 *   is Structurizr's own default rendering and the one every corpus workspace
 *   was authored against (all five carry light-mode palettes such as `#08427b`
 *   on white). Styles carrying `colorScheme: "Dark"` are therefore SKIPPED, and
 *   `collectStyleWarnings` reports them so the customer is told rather than
 *   quietly shown the wrong palette. Passing `colorScheme: 'Dark'` resolves the
 *   other half; nothing here is hard-wired to light except the default.
 * - **We walk the style array in FILE order and merge per property** (§18.1).
 *   The document's own §7.2 claims a `TreeSet` ordering — scheme-agnostic first,
 *   then scheme-specific — but `Styles` has no setter, so Jackson field-injects
 *   an `ArrayList` and the corpus confirms declaration order survives. That also
 *   settles duplicate `(tag, colorScheme)` rows: they MERGE per property, they
 *   are not first-wins.
 * - **Empty-string style values are treated as unset** — a deliberate departure
 *   from the renderer, which copies any own-property (§7.6 #11) and then throws
 *   inside `shadeColor("")`. A diagram the renderer could not draw is not a
 *   diagram the customer saw, so the Java behaviour is the faithful one here.
 * - **Themes are never fetched** — import must work offline (§13.7). A themed
 *   workspace loses whatever the theme alone supplied (for the shipped themes,
 *   the icon; for cloud themes, stroke and text colour as well — §8.5). That is
 *   invisible in the output, so it is reported by `collectStyleWarnings`.
 *
 * What the shared contract cannot carry: `SzElementStyle` /
 * `SzRelationshipStyle` model background/color/stroke/shape/icon/width/height
 * and color/dashed/style/thickness. Structurizr additionally styles `opacity`,
 * `fontSize`, `border`, `strokeWidth`, `routing`, `position`, `metadata` and
 * `description`, so those cannot be resolved here at all — see the note in this
 * agent's summary; big-bank-plc.json really does carry `{"tag":"Failover",
 * "opacity":25}`, which we drop.
 */

import type { SzElementKind, SzElementStyle, SzRelationshipStyle } from './types'

export type SzColorScheme = 'Light' | 'Dark'

export interface StyleResolutionOptions {
  /** Defaults to `Light`; see the header for why that is our choice to make. */
  colorScheme?: SzColorScheme
}

/** A style entry minus its lookup key — i.e. what a match contributes. */
export type ElementStyleProperties = Omit<SzElementStyle, 'tag' | 'colorScheme'>
export type RelationshipStyleProperties = Omit<SzRelationshipStyle, 'tag' | 'colorScheme'>

export interface ResolvedElementStyle {
  background: string
  color: string
  stroke: string
  shape: string
  icon?: string
  width: number
  height: number
  /**
   * The tags that actually matched a style, in application order — Structurizr
   * returns the same thing as the resolved style's `tag`. It is PROVENANCE, not
   * a lookup key (§7.2); do not feed it back in.
   */
  matchedTags: string[]
  /**
   * Only what styles set, before the seed and the fallbacks. A mapper that wants
   * unstyled elements to follow MapleSpire's own theme (so they are not frozen
   * to `#ffffff` in our dark mode) needs to know which properties were really
   * authored, and comparing against the defaults cannot tell you that — a
   * customer may have set `#ffffff` deliberately.
   */
  explicit: ElementStyleProperties
  warnings: string[]
}

export interface ResolvedRelationshipStyle {
  color: string
  /**
   * Derived from `style`, never reported independently of it: the wire's
   * `dashed` and `style` can contradict each other (§7.6 #5) and a consumer that
   * reads the wrong one draws the wrong line. `style` is authoritative; the raw
   * `dashed` is preserved in `explicit`.
   */
  dashed: boolean
  /** `Solid` | `Dashed` | `Dotted` — free text on the wire, so typed as string. */
  style: string
  thickness: number
  matchedTags: string[]
  explicit: RelationshipStyleProperties
  warnings: string[]
}

/** The element fields style resolution needs — `SzElement` satisfies it. */
export interface ElementStyleSubject {
  kind: SzElementKind
  /** The FULL tag list including the machine-generated defaults, in wire order. */
  styleTags: readonly string[]
  instanceOfId?: string
}

/** The relationship fields style resolution needs — `SzRelationship` satisfies it. */
export interface RelationshipStyleSubject {
  styleTags: readonly string[]
  linkedRelationshipId?: string
}

export interface StyleWarningSource {
  elementStyles?: readonly SzElementStyle[]
  relationshipStyles?: readonly SzRelationshipStyle[]
  themes?: readonly string[]
}

/** §7.4: the renderer's seed, which is NOT the same as Java's (§7.6 #2, #3). */
const ELEMENT_SEED = { shape: 'Box', width: 450, height: 300 } as const
const RELATIONSHIP_SEED = { thickness: 2, dashed: true } as const

/** §7.4. Java's `DEFAULT_*_LIGHT` / `_DARK`, identical in the renderer. */
interface SchemeDefaults {
  background: string
  color: string
  stroke: string
}

const SCHEME_DEFAULTS: Record<SzColorScheme, SchemeDefaults> = {
  Light: { background: '#ffffff', color: '#444444', stroke: '#444444' },
  Dark: { background: '#111111', color: '#cccccc', stroke: '#cccccc' },
}

/** §7.4: renderer-only, and only when no matched style sized the element. */
const PERSON_SHAPES = new Set(['Person', 'Robot'])
const PERSON_SIZE = 400

/** §7.4: a group honours these two shapes and nothing else. */
const GROUP_SHAPES = new Set(['Box', 'RoundedBox'])

const HEX_6 = /^#[0-9a-f]{6}$/i
const HEX_3 = /^#[0-9a-f]{3}$/i

// ── Colour handling (§7.7) ───────────────────────────────────────────────────

/**
 * Java rejects anything but `#rrggbb` and its 148 colour names, and the rejection
 * aborts the WHOLE workspace read. We are required to be strictly more tolerant
 * than the reference reader (§4.4), and the renderer is more tolerant too — files
 * exist that the browser paints and the Java reader refuses. So: normalise what we
 * can and pass the rest through untouched, because `lightblue` and `#fff` are both
 * things a browser draws correctly and neither is worth failing an import over.
 */
function normalizeColor(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === '') return undefined
  if (HEX_6.test(value)) return value.toLowerCase()
  if (HEX_3.test(value)) {
    const [, r, g, b] = value.toLowerCase()
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return value
}

/** True only for the normalised `#rrggbb` form, i.e. the shadeable form. */
export function isHexColor(value: string | undefined): boolean {
  return typeof value === 'string' && HEX_6.test(value)
}

/**
 * The renderer's `shadeColor(bg, -10)`: each channel 10% toward black.
 *
 * Java uses `Color.darker()` (×0.7) instead, and the two are visibly different —
 * `#dddddd` derives to `#c7c7c7` here and `#9a9a9a` in Java (§7.5). The customer
 * saw the renderer's. Returns undefined for a colour we cannot take apart, so the
 * caller falls back to the scheme default rather than inventing a stroke.
 */
export function shadeTowardBlack(color: string, factor = 0.9): string | undefined {
  if (!isHexColor(color)) return undefined
  const channels = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(color.slice(at, at + 2), 16)
    return Math.min(255, Math.max(0, Math.round(channel * factor)))
  })
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

// ── Tag string handling (§7.1, §7.8) ─────────────────────────────────────────

/**
 * Splits on `,` and trims, dropping empty segments.
 *
 * Arrays are split too, not just joined: instance injection and the
 * `linkedRelationshipId` walk both build their lookup input by string
 * concatenation, so `"Element,Container" + "," + ""` reaches here with empty
 * segments in it that the reference implementations skip (`Styles.java:289`; the
 * renderer's `tag.length > 0`).
 */
export function splitStyleTags(input: string | readonly string[]): string[] {
  const chunks = typeof input === 'string' ? [input] : input
  const tags: string[] = []
  for (const chunk of chunks) {
    if (typeof chunk !== 'string') continue
    for (const segment of chunk.split(',')) {
      const tag = segment.trim()
      if (tag !== '') tags.push(tag)
    }
  }
  return tags
}

/**
 * §7.1: an instance is looked up as `<underlying element's tags>,<own tags>`.
 *
 * Skip this and every deployment view renders as unstyled white boxes — an
 * instance's own tags are just `Container Instance` / `Software System Instance`,
 * which almost nobody styles, while the container's `Database` (etc.) is where
 * the customer's colours live.
 *
 * Deliberately NOT recursive: a container instance does not pick up the tags of
 * the container's software system, and deployment/infrastructure nodes get no
 * injection at all.
 */
export function elementStyleTags(
  element: ElementStyleSubject,
  elementsById?: ReadonlyMap<string, ElementStyleSubject>,
): { tags: string[]; warnings: string[] } {
  const own = splitStyleTags(element.styleTags)
  if (element.kind !== 'containerInstance' && element.kind !== 'softwareSystemInstance') {
    return { tags: own, warnings: [] }
  }
  if (element.instanceOfId === undefined || element.instanceOfId === '') {
    return {
      tags: own,
      warnings: ['Deployment instance has no instanceOfId; it is styled from its own tags only.'],
    }
  }
  const target = elementsById?.get(element.instanceOfId)
  if (!target) {
    return {
      tags: own,
      warnings: [
        `Deployment instance points at missing element "${element.instanceOfId}"; ` +
          `it is styled from its own tags only.`,
      ],
    }
  }
  return { tags: [...splitStyleTags(target.styleTags), ...own], warnings: [] }
}

/**
 * §7.1: walk `linkedRelationshipId`, PREPENDING each ancestor's tags, so the
 * final list runs root-most ancestor first and the styled edge last. A derived
 * edge — an implied relationship or a deployment replica — therefore looks
 * exactly like the authored edge it came from, with its own tags winning.
 *
 * Guards the reference implementations lack: a cycle spins forever in both Java
 * and JS, a dangling id NPEs in Java and throws in JS, and a literal
 * `"linkedRelationshipId": null` gets past the renderer's `!== undefined` test
 * and throws there too.
 */
export function relationshipStyleTags(
  relationship: RelationshipStyleSubject,
  relationshipsById?: ReadonlyMap<string, RelationshipStyleSubject>,
): { tags: string[]; warnings: string[] } {
  const warnings: string[] = []
  const ancestors: string[][] = []
  const seen = new Set<string>()
  let linkedId = relationship.linkedRelationshipId

  while (typeof linkedId === 'string' && linkedId !== '') {
    if (seen.has(linkedId)) {
      warnings.push(`Relationship link chain cycles at "${linkedId}"; the walk stopped there.`)
      break
    }
    seen.add(linkedId)
    const ancestor = relationshipsById?.get(linkedId)
    if (!ancestor) {
      warnings.push(
        `Relationship links to missing relationship "${linkedId}"; ` +
          `styling falls back to the tags resolved so far.`,
      )
      break
    }
    ancestors.unshift(splitStyleTags(ancestor.styleTags))
    linkedId = ancestor.linkedRelationshipId
  }

  return { tags: [...ancestors.flat(), ...splitStyleTags(relationship.styleTags)], warnings }
}

// ── Per-property merge (§7.2) ────────────────────────────────────────────────

function styleApplies(
  style: { tag: string; colorScheme?: string },
  tag: string,
  scheme: SzColorScheme,
): boolean {
  if (typeof style.tag !== 'string' || style.tag.trim() !== tag) return false
  const styleScheme = style.colorScheme
  if (typeof styleScheme !== 'string' || styleScheme.trim() === '') return true
  return styleScheme.trim().toLowerCase() === scheme.toLowerCase()
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function trimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * The merge is per PROPERTY, never per style — a later style that sets only
 * `background` must not clear a `shape` an earlier one set. Getting this wrong
 * turns a themed or multi-tagged workspace into a pile of default boxes.
 */
function mergeElementProperties(into: ElementStyleProperties, from: SzElementStyle): void {
  const background = normalizeColor(from.background)
  if (background !== undefined) into.background = background
  const color = normalizeColor(from.color)
  if (color !== undefined) into.color = color
  const stroke = normalizeColor(from.stroke)
  if (stroke !== undefined) into.stroke = stroke
  const shape = trimmed(from.shape)
  if (shape !== undefined) into.shape = shape
  // §7.8: `ElementStyle.setIcon` trims, so a padded icon reference still resolves.
  const icon = trimmed(from.icon)
  if (icon !== undefined) into.icon = icon
  const width = finite(from.width)
  if (width !== undefined) into.width = width
  const height = finite(from.height)
  if (height !== undefined) into.height = height
}

function mergeRelationshipProperties(
  into: RelationshipStyleProperties,
  from: SzRelationshipStyle,
): void {
  const color = normalizeColor(from.color)
  if (color !== undefined) into.color = color
  // A boolean must be copied by presence, not by truth: `dashed: false` is the
  // whole point of the field and a truthiness test drops exactly the case that
  // matters.
  if (typeof from.dashed === 'boolean') into.dashed = from.dashed
  const style = trimmed(from.style)
  if (style !== undefined) into.style = style
  const thickness = finite(from.thickness)
  if (thickness !== undefined) into.thickness = thickness
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve an element's style from its FULL comma-separated tag list.
 *
 * `styleTags` is the wire tag string (or the already-split list): defaults such
 * as `Element` / `Container` first, author tags after. Tags apply LEFT TO RIGHT,
 * so the rightmost matching tag wins per property.
 */
export function resolveElementStyle(
  styleTags: string | readonly string[],
  styles: readonly SzElementStyle[],
  options: StyleResolutionOptions = {},
): ResolvedElementStyle {
  const scheme = options.colorScheme ?? 'Light'
  const defaults = SCHEME_DEFAULTS[scheme]
  const explicit: ElementStyleProperties = {}
  const matchedTags: string[] = []

  for (const tag of splitStyleTags(styleTags)) {
    let matched = false
    for (const style of styles) {
      if (!styleApplies(style, tag, scheme)) continue
      matched = true
      mergeElementProperties(explicit, style)
    }
    // Java records the tag once per matching lookup, duplicates included, and the
    // provenance list is the only place a caller can see WHY a style applied.
    if (matched) matchedTags.push(tag)
  }

  const sizedByStyle = explicit.width !== undefined || explicit.height !== undefined
  const background = explicit.background ?? defaults.background
  const stroke =
    explicit.stroke ??
    (explicit.background !== undefined ? shadeTowardBlack(explicit.background) : undefined) ??
    defaults.stroke

  const resolved: ResolvedElementStyle = {
    background,
    color: explicit.color ?? defaults.color,
    stroke,
    shape: explicit.shape ?? ELEMENT_SEED.shape,
    icon: explicit.icon,
    width: explicit.width ?? ELEMENT_SEED.width,
    height: explicit.height ?? ELEMENT_SEED.height,
    matchedTags,
    explicit,
    warnings: [],
  }

  if (!sizedByStyle && PERSON_SHAPES.has(resolved.shape)) {
    resolved.width = PERSON_SIZE
    resolved.height = PERSON_SIZE
  }
  // The swaps apply to authored sizes too — the renderer is enforcing the
  // orientation the shape name promises, not just fixing up its own defaults.
  if (resolved.shape === 'MobileDevicePortrait' && resolved.height < resolved.width) {
    ;[resolved.width, resolved.height] = [resolved.height, resolved.width]
  }
  if (resolved.shape === 'MobileDeviceLandscape' && resolved.height > resolved.width) {
    ;[resolved.width, resolved.height] = [resolved.height, resolved.width]
  }

  return resolved
}

/** `resolveElementStyle` with §7.1's instance tag injection applied first. */
export function resolveStyleForElement(
  element: ElementStyleSubject,
  elementsById: ReadonlyMap<string, ElementStyleSubject> | undefined,
  styles: readonly SzElementStyle[],
  options: StyleResolutionOptions = {},
): ResolvedElementStyle {
  const { tags, warnings } = elementStyleTags(element, elementsById)
  const resolved = resolveElementStyle(tags, styles, options)
  resolved.warnings = warnings
  return resolved
}

/**
 * Resolve a relationship's style from its full tag list.
 *
 * The most visible default in the whole format lives here: an unstyled
 * Structurizr relationship is DASHED. An importer that draws solid by default
 * mis-renders every unstyled workspace at a glance.
 */
export function resolveRelationshipStyle(
  styleTags: string | readonly string[],
  styles: readonly SzRelationshipStyle[],
  options: StyleResolutionOptions = {},
): ResolvedRelationshipStyle {
  const scheme = options.colorScheme ?? 'Light'
  const defaults = SCHEME_DEFAULTS[scheme]
  const explicit: RelationshipStyleProperties = {}
  const matchedTags: string[] = []

  for (const tag of splitStyleTags(styleTags)) {
    let matched = false
    for (const style of styles) {
      if (!styleApplies(style, tag, scheme)) continue
      matched = true
      mergeRelationshipProperties(explicit, style)
    }
    if (matched) matchedTags.push(tag)
  }

  // §7.6 #5: `style` is authoritative; `dashed` is consulted only when nothing
  // set `style`. Java leaves the seeded `Dashed` in place even when `dashed` is
  // false, which contradicts itself; the renderer derives, and that is what was
  // on screen.
  const dashed = explicit.dashed ?? RELATIONSHIP_SEED.dashed
  const lineStyle = explicit.style ?? (dashed ? 'Dashed' : 'Solid')

  return {
    color: explicit.color ?? defaults.color,
    dashed: lineStyle !== 'Solid',
    style: lineStyle,
    // Renderer-only clamp (§7.6 #6): a 0 or a 40 in the JSON still draws a line.
    thickness: Math.min(10, Math.max(1, explicit.thickness ?? RELATIONSHIP_SEED.thickness)),
    matchedTags,
    explicit,
    warnings: [],
  }
}

/** `resolveRelationshipStyle` with §7.1's `linkedRelationshipId` walk applied. */
export function resolveStyleForRelationship(
  relationship: RelationshipStyleSubject,
  relationshipsById: ReadonlyMap<string, RelationshipStyleSubject> | undefined,
  styles: readonly SzRelationshipStyle[],
  options: StyleResolutionOptions = {},
): ResolvedRelationshipStyle {
  const { tags, warnings } = relationshipStyleTags(relationship, relationshipsById)
  const resolved = resolveRelationshipStyle(tags, styles, options)
  resolved.warnings = warnings
  return resolved
}

/**
 * §7.4's group pseudo-element: looked up as `Group, Group:<name>`, with the
 * `Group:` prefix stripped from the provenance, and every shape other than
 * `Box`/`RoundedBox` forced back to `Box`.
 *
 * The tag string is composed and then re-split exactly as the renderer does, so
 * a group whose name contains a comma degrades the same way it does upstream
 * rather than silently resolving differently here.
 *
 * Not carried: the group default border is `Dotted` rather than `Solid`, and
 * `SzElementStyle` has no `border`, so a border a customer set on a group is
 * lost regardless of what we do.
 */
export function resolveGroupStyle(
  groupName: string,
  styles: readonly SzElementStyle[],
  options: StyleResolutionOptions = {},
): ResolvedElementStyle {
  const resolved = resolveElementStyle(`Group,Group:${groupName}`, styles, options)
  if (!GROUP_SHAPES.has(resolved.shape)) resolved.shape = 'Box'
  resolved.matchedTags = resolved.matchedTags.map((tag) =>
    tag.startsWith('Group:') ? tag.slice('Group:'.length) : tag,
  )
  return resolved
}

// ── Warnings the caller must surface (§8.5, §18.4, §7.7) ─────────────────────

/**
 * Everything about a workspace's styling that resolution cannot honour.
 *
 * These are per-WORKSPACE facts, not per-element ones — reporting them from
 * inside `resolveElementStyle` would repeat the same warning once per element
 * that happens to carry the tag. Call this once at import and show the result.
 */
export function collectStyleWarnings(
  source: StyleWarningSource,
  options: StyleResolutionOptions = {},
): string[] {
  const scheme = options.colorScheme ?? 'Light'
  const warnings: string[] = []
  const elementStyles = source.elementStyles ?? []
  const relationshipStyles = source.relationshipStyles ?? []
  const themes = source.themes ?? []

  if (themes.length > 0) {
    // §8.5, measured: one corpus workspace defines 4 element styles while 8 of
    // its tags are styled only by the AWS theme — skip fetching and those 8 lose
    // icon, stroke and colour with nothing to fall back on.
    warnings.push(
      `${themes.length} theme(s) are referenced but not fetched, so any icon, stroke or ` +
        `colour they alone supply is missing: ${themes.join(', ')}`,
    )
  }

  const skipped = new Set<string>()
  const seenKeys = new Set<string>()
  const duplicated = new Set<string>()
  const unrecognisedColors = new Set<string>()

  const inspect = (
    kind: 'element' | 'relationship',
    style: { tag: string; colorScheme?: string },
    colors: Array<string | undefined>,
  ) => {
    const tag = typeof style.tag === 'string' ? style.tag.trim() : ''
    if (tag === '') {
      warnings.push(`A ${kind} style has no tag, so it can never match anything.`)
      return
    }
    const styleScheme = trimmed(style.colorScheme)
    if (styleScheme !== undefined && styleScheme.toLowerCase() !== scheme.toLowerCase()) {
      skipped.add(`${tag} (${styleScheme})`)
      return
    }
    // JSON.stringify, not a NUL-joined template: two raw 0x00 bytes made
    // ripgrep classify this whole file as binary and skip it, so the module
    // was invisible to the project's own code search and to any grep-based
    // check. The tuple is unambiguous without needing an illegal separator.
    const key = JSON.stringify([kind, tag, styleScheme ?? ''])
    if (seenKeys.has(key)) duplicated.add(tag)
    seenKeys.add(key)
    for (const raw of colors) {
      const normalized = normalizeColor(raw)
      if (normalized !== undefined && !isHexColor(normalized)) unrecognisedColors.add(normalized)
    }
  }

  for (const style of elementStyles) {
    inspect('element', style, [style.background, style.color, style.stroke])
  }
  for (const style of relationshipStyles) {
    inspect('relationship', style, [style.color])
  }

  if (skipped.size > 0) {
    warnings.push(
      `Import resolves the ${scheme.toLowerCase()} colour scheme, so ${skipped.size} style(s) ` +
        `for the other scheme were not applied: ${[...skipped].join(', ')}`,
    )
  }
  if (duplicated.size > 0) {
    warnings.push(
      `Duplicate style entries were merged property by property for: ${[...duplicated].join(', ')}`,
    )
  }
  if (unrecognisedColors.size > 0) {
    // Kept, not dropped: a browser draws `lightblue` fine. What is lost is the
    // derived stroke, because we cannot take the colour apart to shade it.
    warnings.push(
      `${unrecognisedColors.size} colour value(s) are not #rrggbb and were kept as written; ` +
        `a stroke cannot be derived from them: ${[...unrecognisedColors].join(', ')}`,
    )
  }

  return warnings
}
