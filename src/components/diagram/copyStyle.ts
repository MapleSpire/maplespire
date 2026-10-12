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

import type { C4Object, Group, ShapeIconAssignment } from '../../types'

/**
 * The style surface of "Copy style" — the single place that decides which
 * fields the command reads and which it writes.
 *
 * Capture and apply live together here so they cannot drift apart. Each kind
 * of drift reads to a user as "copy style doesn't work":
 *
 *  - the `iconAssignment` is what actually paints (`renderTechnologyIcon`
 *    resolves `iconAssignment?.displayName ?? icon`, and only the assignment
 *    carries the image paths), so copying `icon` alone changes nothing on a
 *    shape with an assignment and downgrades one without to a grey letter tile;
 *  - a group paints with 7 fields; copying fewer turns e.g. the Outline preset
 *    (`fillTransparent: true`, `borderWidth: 2`) into a solid filled box;
 *  - clearing `icon` but leaving `iconAssignment` behind is a state no other
 *    editor in the app can produce.
 *
 * Two rules:
 *
 *  1. **Every capture field has an apply field and vice versa.** A field that
 *     is captured but not applied is a silent no-op; a field applied but never
 *     captured is `undefined`, which CLEARS. Both are invisible in review.
 *  2. **`icon` and `iconAssignment` move as a pair, always.**
 *
 * ## What is deliberately NOT here
 *
 * `type`, `scope` and `status` are model semantics, not paint. Rewriting `type`
 * would let a paste silently turn a Component into a Container, in an app with
 * no undo. Excluding them is a product decision, not a bug fix.
 *
 * A consequence worth stating plainly: an object's fill and stroke are derived
 * from `skin.objects[obj.type]` and `scope` (`CanvasEngine.renderObject`), never
 * stored on the object. So with semantics excluded, an object's stored paint
 * surface IS the icon pair and nothing else. "Copy style" between objects
 * copies the icon — that is the whole of it, not an omission.
 */

/** The icon pair. Never move one of these without the other. */
interface CopiedIcon {
  icon?: string
  iconAssignment?: ShapeIconAssignment
}

/**
 * A captured style, tagged with the kind of entity it came from.
 *
 * The tag exists because the payload crosses the canvas as `unknown` and the
 * two kinds share only the icon pair. Untagged, a group payload applied to an
 * object would be indistinguishable from an object payload, and guessing from
 * field presence would make a `color`-less group paste as "clear the icon".
 */
export type CopiedStyle =
  | ({ kind: 'object' } & CopiedIcon)
  | ({ kind: 'group' } & CopiedIcon & {
      color: string
      borderColor?: string
      borderWidth?: number
      fillOpacity?: number
      fillTransparent?: boolean
    })

/**
 * A parent wrapper is the box drawn around an expanded/detailed shape. It is
 * not user-styled: `renderGroup` overrides its fill with
 * `skin.groups.parentWrapperFill`, its stroke with `skin.groups.navColor`, both
 * alphas with 1 and its border width with 0 — every field this command touches.
 *
 * So both directions are meaningless and both are refused:
 *  - copying FROM one hands over a `color` the wrapper has never displayed,
 *    which then paints for real on an ordinary group;
 *  - copying ONTO one writes fields nothing reads, i.e. a silent no-op the user
 *    correctly reads as a broken command.
 *
 * Geometry is refused too, though the reason is narrower than it looks:
 * `computeGroupBounds` excludes wrappers from the manual-size branch, so a
 * wrapper WITH members — the only state a user meets — recomputes from those
 * members and ignores stored geometry, making the write inert. (The
 * zero-members branch above it does honour stored geometry, wrapper or not, but
 * a wrapper with no members on the diagram is a degenerate state, not something
 * to let a resize land in.) This mirrors the `groupAutoSizeLocked === 'wrapper'`
 * rule already shipped for the auto-size switch.
 */
export function isParentWrapper(group: Pick<Group, 'parentObjectId'>): boolean {
  return !!group.parentObjectId
}

export function captureObjectStyle(obj: C4Object): CopiedStyle {
  return { kind: 'object', icon: obj.icon, iconAssignment: obj.iconAssignment }
}

/** `null` when the group has no style a user can copy (a parent wrapper). */
export function captureGroupStyle(group: Group): CopiedStyle | null {
  if (isParentWrapper(group)) return null
  return {
    kind: 'group',
    icon: group.icon,
    iconAssignment: group.iconAssignment,
    color: group.color,
    borderColor: group.borderColor,
    borderWidth: group.borderWidth,
    fillOpacity: group.fillOpacity,
    fillTransparent: group.fillTransparent,
  }
}

/**
 * Strip technology PROVENANCE from a pasted icon, keeping everything that
 * paints.
 *
 * A `ShapeIconAssignment` with `source: 'technology'` carries a
 * `technologyUsageId` naming a `TechnologyUsage` on the SOURCE entity. Copied
 * verbatim, the target ends up pointing at a usage it does not own, and
 * `explicitTechnologyIconDependsOnUsage` — which requires
 * `source === 'technology' && mode === 'explicit' && technologyUsageId === id`
 * (`technologyUsage.ts`) — can then never match it. Removing the technology
 * from the target would never clear or re-point the icon, leaving a shape
 * wearing a technology badge it has no technology for and no way to manage.
 *
 * A paste is the user choosing an icon, which is exactly what
 * `source: 'generic', mode: 'explicit'` means. The display name and both image
 * paths are what the renderer reads, so the icon looks identical.
 */
function asPastedIcon(assignment: ShapeIconAssignment | undefined): ShapeIconAssignment | undefined {
  if (!assignment) return undefined
  return {
    source: 'generic',
    mode: 'explicit',
    displayName: assignment.displayName,
    iconLightPath: assignment.iconLightPath,
    iconDarkPath: assignment.iconDarkPath,
  }
}

/**
 * Objects store exactly one paint field — the icon pair — so a group source
 * degrades to it rather than being refused: copying a group's icon onto a shape
 * is coherent, and it is the only field the two kinds share.
 *
 * `undefined` is written, not skipped. Copy style means "look like that", so a
 * source with no icon clears the target's; skipping would make the command
 * one-way. Explicit `undefined` is safe here: the reconcile layer turns a
 * target key of `undefined` into `delete draft[key]` rather than assigning it
 * (`reconcile.ts`), and the icon remove button in `RightSidebar` already
 * writes exactly this shape.
 *
 * Clearing both halves matters for coherence rather than for paint: both
 * renderers gate the icon on the LABEL (`if (obj.icon)`, `if (group.icon)`), so
 * an assignment left behind after `icon` is cleared paints nothing — it is a
 * dangling record, not a visible artefact. The visible half of the bug is the
 * other direction, where `icon` is overwritten and a stale assignment keeps
 * winning inside `renderTechnologyIcon`.
 */
export function applyStyleToObject(style: CopiedStyle): Partial<C4Object> {
  return { icon: style.icon, iconAssignment: asPastedIcon(style.iconAssignment) }
}

/** `null` when the target cannot show the style (a parent wrapper). */
export function applyStyleToGroup(style: CopiedStyle, target: Pick<Group, 'parentObjectId'>): Partial<Group> | null {
  if (isParentWrapper(target)) return null
  const icon: Partial<Group> = { icon: style.icon, iconAssignment: asPastedIcon(style.iconAssignment) }
  // An object source carries no group paint. Writing the absent fields anyway
  // would reset the target's colour and borders to the defaults, which is a
  // destructive reading of "copy the icon".
  if (style.kind === 'object') return icon
  return {
    ...icon,
    // `color` is a REQUIRED field on Group, and an undefined value here would
    // reconcile to a delete. A source group always has one; this keeps a
    // malformed one from stripping the target's.
    ...(style.color === undefined ? {} : { color: style.color }),
    borderColor: style.borderColor,
    borderWidth: style.borderWidth,
    fillOpacity: style.fillOpacity,
    fillTransparent: style.fillTransparent,
  }
}

export interface CopiedSize {
  width: number
  height: number
}

export interface CopyApplyTarget {
  id: string
  type: 'object' | 'group'
}

/** One resolved write: the entity to change and the fields to change on it. */
export type PlannedCopyWrite =
  | { id: string; type: 'object'; update: Partial<C4Object> }
  | { id: string; type: 'group'; update: Partial<Group> }

export interface CopyApplyContext {
  /** The group as the STORE holds it, or undefined when the id is stale. */
  group: (id: string) => Group | undefined
  /** Live bounds from the engine — see `planGroupSizeCopy`. */
  groupBounds: (id: string) => { x: number; y: number } | null
  /** Whether an object id still exists; a stale id must not count as a write. */
  objectExists: (id: string) => boolean
}

/**
 * Resolve every write a Copy style / Copy size click implies, for one target or
 * a whole selection, WITHOUT touching the store.
 *
 * Split out for two reasons.
 *
 * It is the decision the feature is made of — partial refusal, stale ids, the
 * wrapper rule — and inline in a `CanvasView` callback it would be unreachable
 * from a unit test. Same reason `contextMenuTarget.ts` exists.
 *
 * And returning writes instead of performing them lets the caller commit them
 * in ONE store transaction. Applying per target issues one `set()` each, and
 * every notification re-runs the Automerge bridge's `detectEdits()`, which
 * walks the whole model — O(targets × model) inside a single mousedown. The
 * store's own convention for this is a single looping `set()`
 * (`addTagToSelected`, `updatePlacementsBatch`), and `gestureBatch.test.ts`
 * pins a multi-entity commit at exactly one notification.
 *
 * A target that cannot take the paste is OMITTED, not failed: an empty result
 * means nothing will be written, which is what leaves the copy cursor armed.
 */
export function planCopyWrites(
  targets: readonly CopyApplyTarget[],
  mode: 'size' | 'style',
  data: unknown,
  ctx: CopyApplyContext,
): PlannedCopyWrite[] {
  const writes: PlannedCopyWrite[] = []
  for (const target of targets) {
    if (mode === 'size') {
      const size = data as CopiedSize
      if (target.type === 'object') {
        if (!ctx.objectExists(target.id)) continue
        writes.push({ id: target.id, type: 'object', update: { size: { width: size.width, height: size.height } } })
        continue
      }
      const group = ctx.group(target.id)
      if (!group) continue
      const update = planGroupSizeCopy(size, group, ctx.groupBounds(target.id))
      if (update) writes.push({ id: target.id, type: 'group', update })
      continue
    }
    const style = data as CopiedStyle
    if (target.type === 'object') {
      if (!ctx.objectExists(target.id)) continue
      writes.push({ id: target.id, type: 'object', update: applyStyleToObject(style) })
      continue
    }
    const group = ctx.group(target.id)
    if (!group) continue
    const update = applyStyleToGroup(style, group)
    if (update) writes.push({ id: target.id, type: 'group', update })
  }
  return writes
}

/**
 * Resolve the geometry a copied size must be written with.
 *
 * `computeGroupBounds` honours a stored size ONLY when `position` is stored too
 * (`group.autoSize === false && group.position && group.size`). Copy size used
 * to write `{ size, autoSize: false }` with no position, so on an auto-sized
 * group — the common case, since auto-size is the default — the size was stored
 * and then ignored: the group kept auto-sizing while its auto-size switch read
 * "off". The user saw the command do nothing.
 *
 * `currentBounds` must come from `CanvasEngine.getGroupBoundsById` and takes
 * PRECEDENCE over `target.position`. The store's group carries the create-time
 * position (`{x:200,y:200}` from the create palette, or the drop point); the
 * geometry the user is looking at lives in `diagram.layouts[groupId]` and is
 * merged in only on the way to the engine. Preferring the stored field would
 * teleport the group back to where it was created — turning a fidelity fix into
 * a worse version of the bug it replaces.
 */
export function planGroupSizeCopy(
  size: CopiedSize,
  target: Pick<Group, 'parentObjectId' | 'position'>,
  currentBounds: { x: number; y: number } | null,
): Partial<Group> | null {
  if (isParentWrapper(target)) return null
  const position = currentBounds ? { x: currentBounds.x, y: currentBounds.y } : target.position ?? null
  if (!position) return null
  return { position, size: { width: size.width, height: size.height }, autoSize: false }
}
