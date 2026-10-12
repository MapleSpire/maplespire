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

import { describe, expect, it } from 'vitest'
import {
  applyStyleToGroup,
  applyStyleToObject,
  captureGroupStyle,
  captureObjectStyle,
  isParentWrapper,
  planCopyWrites,
  planGroupSizeCopy,
} from './copyStyle'
import type { CopiedStyle } from './copyStyle'
import type { C4Object, Group, ShapeIconAssignment } from '../../types'

/** An icon as the technology editor assigns it — carrying provenance. */
const assignment = (displayName: string, technologyUsageId = 'usage-1'): ShapeIconAssignment => ({
  source: 'technology',
  mode: 'explicit',
  displayName,
  iconLightPath: `/icons/${displayName}-light.svg`,
  iconDarkPath: `/icons/${displayName}-dark.svg`,
  technologyUsageId,
})

/** The same icon as it must land on a paste: identical paint, no provenance. */
const pasted = (displayName: string): ShapeIconAssignment => ({
  source: 'generic',
  mode: 'explicit',
  displayName,
  iconLightPath: `/icons/${displayName}-light.svg`,
  iconDarkPath: `/icons/${displayName}-dark.svg`,
})

const object = (over: Partial<C4Object> = {}): C4Object => ({
  id: 'o1',
  type: 'app',
  name: 'API',
  position: { x: 0, y: 0 },
  size: { width: 200, height: 120 },
  tagAssignments: {},
  tagOrder: [],
  scope: 'internal',
  status: 'live',
  properties: {},
  ...over,
})

const group = (over: Partial<Group> = {}): Group => ({
  id: 'g1',
  name: 'Backend',
  color: '#3B82F6',
  objectIds: ['o1'],
  tagAssignments: {},
  tagOrder: [],
  ...over,
})

describe('copyStyle — the icon pair', () => {
  it('THE BUG: a paste that clears the icon clears the assignment with it', () => {
    // Not a paint bug in THIS direction: both renderers gate the icon on the
    // LABEL (`if (obj.icon)`, `if (group.icon)`), so once `icon` is cleared
    // nothing draws at all. What is left is a DANGLING RECORD — an assignment
    // with no label, a state no other editor in the app can produce. An apply
    // that wrote `icon` only would leave it behind.
    const source = captureObjectStyle(object({ icon: undefined, iconAssignment: undefined }))
    const update = applyStyleToObject(source)

    expect(update).toEqual({ icon: undefined, iconAssignment: undefined })
    expect('iconAssignment' in update).toBe(true) // present-and-undefined, i.e. it CLEARS
  })

  it('THE BUG, other direction: the assignment travels, not just the label', () => {
    // Copying `icon` alone could only ever produce the grey letter tile —
    // `resolveTechnologyIconPath` reads the image paths off the assignment.
    const source = captureObjectStyle(object({ icon: 'Postgres', iconAssignment: assignment('Postgres') }))

    expect(applyStyleToObject(source)).toEqual({
      icon: 'Postgres',
      iconAssignment: pasted('Postgres'),
    })
  })

  it('strips technology provenance: the paint travels, the usage id does not', () => {
    // The source's `technologyUsageId` names a TechnologyUsage the TARGET does
    // not own. Copied verbatim, `explicitTechnologyIconDependsOnUsage` (which
    // requires source==='technology' && the id to match) can never fire, so
    // removing the technology would never clear or re-point the icon — a shape
    // wearing a technology badge it has no technology for.
    const source = captureObjectStyle(object({ icon: 'Kafka', iconAssignment: assignment('Kafka', 'usage-on-source') }))
    const update = applyStyleToObject(source)

    expect(update.iconAssignment).not.toHaveProperty('technologyUsageId')
    expect(update.iconAssignment?.source).toBe('generic')
    // ...but everything the renderer reads is unchanged, so it looks identical.
    expect(update.iconAssignment?.displayName).toBe('Kafka')
    expect(update.iconAssignment?.iconLightPath).toBe('/icons/Kafka-light.svg')
    expect(update.iconAssignment?.iconDarkPath).toBe('/icons/Kafka-dark.svg')
  })

  it('two targets differing only in assignment end in the SAME painted state', () => {
    // Symptom guarded: "inconsistent even for same-type shapes". Merge the
    // update the way the store does, then resolve the icon the way
    // `renderTechnologyIcon` does — that resolution is where an icon /
    // assignment split shows up, so asserting on the update alone would miss it.
    const source = captureObjectStyle(object({ icon: 'Redis', iconAssignment: assignment('Redis') }))
    const update = applyStyleToObject(source)

    const bare = { ...object({ id: 'a' }), ...update }
    const assigned = { ...object({ id: 'b', icon: 'Mongo', iconAssignment: assignment('Mongo') }), ...update }
    const painted = (o: C4Object) => [o.iconAssignment?.displayName ?? o.icon, o.iconAssignment?.iconLightPath]

    expect(painted(bare)).toEqual(['Redis', '/icons/Redis-light.svg'])
    expect(painted(assigned)).toEqual(painted(bare))
  })
})

describe('copyStyle — model semantics are not style', () => {
  it('does not carry type, scope or status', () => {
    // Rewriting `type` would let a paste silently turn a Component into a
    // Container — in an app with no undo.
    const source = captureObjectStyle(object({ type: 'actor', scope: 'external', status: 'draft' }))

    expect(source).not.toHaveProperty('type')
    expect(source).not.toHaveProperty('scope')
    expect(source).not.toHaveProperty('status')
    expect(applyStyleToObject(source)).not.toHaveProperty('type')
  })
})

describe('copyStyle — group paint surface', () => {
  it('THE BUG: the Outline preset survives the round trip', () => {
    // Built-in preset. Capturing only `color` + `icon` would paste a
    // border-only box as a SOLID FILLED box — the visual opposite.
    const outline = group({ color: '#0F172A', borderColor: '#0F172A', fillTransparent: true, borderWidth: 2 })

    const update = applyStyleToGroup(captureGroupStyle(outline)!, group({ id: 'g2' }))

    expect(update).toMatchObject({ color: '#0F172A', borderColor: '#0F172A', fillTransparent: true, borderWidth: 2 })
  })

  it('carries every field the renderer paints with', () => {
    // Guards the drift rule: a field `renderGroup` reads but capture omits is a
    // silent partial paste. These are the seven it reads.
    const update = applyStyleToGroup(
      captureGroupStyle(group({
        color: '#111', borderColor: '#222', borderWidth: 3, fillOpacity: 0.7, fillTransparent: false,
        icon: 'AWS', iconAssignment: assignment('AWS'),
      }))!,
      group({ id: 'g2' }),
    )

    expect(Object.keys(update!).sort()).toEqual(
      ['borderColor', 'borderWidth', 'color', 'fillOpacity', 'fillTransparent', 'icon', 'iconAssignment'],
    )
  })

  it('clears the paint fields the source left unset', () => {
    // A plain group pasted onto a heavily styled one must reset it, not merge —
    // otherwise the command is one-way and the target keeps a border the source
    // does not have.
    const update = applyStyleToGroup(captureGroupStyle(group())!, group({ id: 'g2', borderWidth: 8 }))

    expect(update).toMatchObject({ borderWidth: undefined, fillTransparent: undefined, borderColor: undefined })
  })
})

describe('copyStyle — parent wrappers', () => {
  const wrapper = group({ id: 'w1', parentObjectId: 'o1' })

  it('identifies a wrapper the way the renderer does', () => {
    expect(isParentWrapper(wrapper)).toBe(true)
    expect(isParentWrapper(group())).toBe(false)
  })

  it('refuses to capture from one', () => {
    // Its `color` is never painted — `renderGroup` overrides fill with
    // `parentWrapperFill`. Copying it hands over a colour the wrapper has never
    // displayed, which then paints for real on an ordinary group.
    expect(captureGroupStyle(wrapper)).toBeNull()
  })

  it('refuses to apply onto one', () => {
    expect(applyStyleToGroup(captureGroupStyle(group())!, wrapper)).toBeNull()
  })

  it('refuses a size paste onto one', () => {
    // A wrapper WITH members — the only state a user meets — is excluded from
    // `computeGroupBounds`' manual-size branch and recomputes from those
    // members, so the write would be inert.
    expect(planGroupSizeCopy({ width: 300, height: 200 }, wrapper, { x: 0, y: 0 })).toBeNull()
  })
})

describe('copyStyle — cross-kind paste', () => {
  it('an object source onto a group carries the icon and nothing else', () => {
    // It must NOT write the absent group paint fields: that would reset the
    // target's colour and borders, which is a destructive reading of "copy the
    // icon".
    const source: CopiedStyle = captureObjectStyle(object({ icon: 'Kafka', iconAssignment: assignment('Kafka') }))

    const update = applyStyleToGroup(source, group({ id: 'g2', color: '#ABCDEF', borderWidth: 4 }))

    // Assert the exact KEY SET, not `toEqual` — `toEqual` ignores keys whose
    // value is `undefined`, so a mutant writing `borderWidth: undefined` (which
    // reconciles to a DELETE on the target) passes it. That mutant survived
    // until this line existed.
    expect(Object.keys(update!).sort()).toEqual(['icon', 'iconAssignment'])
    expect(update).toEqual({ icon: 'Kafka', iconAssignment: pasted('Kafka') })
  })

  it('a group source onto an object carries the icon pair', () => {
    const source = captureGroupStyle(group({ icon: 'Azure', iconAssignment: assignment('Azure'), color: '#FF0000' }))!

    expect(applyStyleToObject(source)).toEqual({ icon: 'Azure', iconAssignment: pasted('Azure') })
  })
})

describe('planCopyWrites', () => {
  // Kept out of a `CanvasView` callback so a unit test can reach it — the
  // same reason `contextMenuTarget.ts`
  // exists. It is also what makes a one-transaction commit possible.
  const ctx = (over: Partial<Parameters<typeof planCopyWrites>[3]> = {}) => ({
    group: (id: string) => (id === 'g1' ? group({ id: 'g1' }) : id === 'w1' ? group({ id: 'w1', parentObjectId: 'o' }) : undefined),
    groupBounds: () => ({ x: 900, y: 560 }),
    objectExists: (id: string) => id !== 'gone',
    ...over,
  })

  it('plans one write per target for a whole selection', () => {
    const style = captureObjectStyle(object({ icon: 'Redis', iconAssignment: assignment('Redis') }))
    const writes = planCopyWrites(
      [{ id: 'a', type: 'object' }, { id: 'b', type: 'object' }, { id: 'g1', type: 'group' }],
      'style', style, ctx(),
    )

    expect(writes.map((w) => w.id)).toEqual(['a', 'b', 'g1'])
  })

  it('OMITS a refusing target rather than failing the batch', () => {
    // One unstyleable shape must not veto the other nine.
    const style = captureObjectStyle(object({ icon: 'Redis' }))
    const writes = planCopyWrites(
      [{ id: 'a', type: 'object' }, { id: 'w1', type: 'group' }],
      'style', style, ctx(),
    )

    expect(writes.map((w) => w.id)).toEqual(['a'])
  })

  it('returns EMPTY when every target refuses — which keeps the cursor armed', () => {
    const style = captureObjectStyle(object({ icon: 'Redis' }))

    expect(planCopyWrites([{ id: 'w1', type: 'group' }], 'style', style, ctx())).toEqual([])
  })

  it('a stale object id is not counted as a write', () => {
    // `updateObject` is a silent no-op on an unknown id, so counting it would
    // report a success that never happened and disarm the cursor.
    const style = captureObjectStyle(object({ icon: 'Redis' }))

    expect(planCopyWrites([{ id: 'gone', type: 'object' }], 'style', style, ctx())).toEqual([])
  })

  it('a stale GROUP id is not counted either', () => {
    const style = captureObjectStyle(object({ icon: 'Redis' }))

    expect(planCopyWrites([{ id: 'nope', type: 'group' }], 'style', style, ctx())).toEqual([])
  })

  it('SIZE mode too: a stale object id is not counted as a write', () => {
    // The style path had this covered and the size path did not — a mutant that
    // dropped the existence check only in size mode survived the whole suite.
    // Both modes reach `updateObject`, which no-ops silently on an unknown id.
    expect(planCopyWrites([{ id: 'gone', type: 'object' }], 'size', { width: 10, height: 10 }, ctx())).toEqual([])
  })

  it('SIZE mode too: a refusing target is omitted, not fatal to the batch', () => {
    const writes = planCopyWrites(
      [{ id: 'a', type: 'object' }, { id: 'w1', type: 'group' }],
      'size', { width: 400, height: 250 }, ctx(),
    )

    expect(writes.map((w) => w.id)).toEqual(['a'])
  })

  it('size mode plans a size for objects and full geometry for groups', () => {
    const writes = planCopyWrites(
      [{ id: 'a', type: 'object' }, { id: 'g1', type: 'group' }],
      'size', { width: 400, height: 250 }, ctx(),
    )

    expect(writes[0]).toEqual({ id: 'a', type: 'object', update: { size: { width: 400, height: 250 } } })
    expect(writes[1].update).toMatchObject({ position: { x: 900, y: 560 }, autoSize: false })
  })
})

describe('planGroupSizeCopy', () => {
  it('THE BUG: an auto-sized target gets a position, so the size is honoured', () => {
    // `computeGroupBounds` honours a stored size ONLY when position is stored
    // too. Writing `{ size, autoSize: false }` with no position leaves the
    // group auto-sizing while its auto-size switch reads "off".
    const update = planGroupSizeCopy({ width: 400, height: 250 }, group(), { x: 40, y: 60 })

    expect(update).toEqual({ position: { x: 40, y: 60 }, size: { width: 400, height: 250 }, autoSize: false })
  })

  it('THE REGRESSION: live bounds WIN over the stored position — no teleport', () => {
    // The store's group carries the CREATE-TIME position (the create palette
    // hardcodes {200,200}); the geometry the user is looking at lives in
    // `diagram.layouts[groupId]` and reaches only the engine. Preferring the
    // stored field snaps the group back to where it was created — a worse
    // version of the bug this fix exists to remove. An earlier draft of this
    // file asserted the wrong precedence and passed.
    const update = planGroupSizeCopy(
      { width: 400, height: 250 },
      group({ position: { x: 200, y: 200 } }),   // stale model position
      { x: 900, y: 560 },                        // where it is actually drawn
    )

    expect(update!.position).toEqual({ x: 900, y: 560 })
  })

  it('falls back to the stored position only when there are no live bounds', () => {
    const update = planGroupSizeCopy({ width: 400, height: 250 }, group({ position: { x: 10, y: 20 } }), null)

    expect(update!.position).toEqual({ x: 10, y: 20 })
  })

  it('refuses when neither a stored position nor live bounds are available', () => {
    // Writing `autoSize: false` without geometry is the exact state that made
    // the switch lie; refusing keeps the group auto-sized and leaves the cursor
    // armed.
    expect(planGroupSizeCopy({ width: 400, height: 250 }, group(), null)).toBeNull()
  })
})
