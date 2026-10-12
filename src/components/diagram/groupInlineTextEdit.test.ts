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

import { groupInlineEditSeed, isMirrorOfObject, planGroupInlineTextEdit, resolveInlineEditSubject } from './groupInlineTextEdit'
import { INLINE_EDIT_MAX_LEN } from './inlineTextEdit'
import type { C4Object, Group } from '../../types'

const group = (over: Partial<Group> = {}): Group => ({
  id: 'g1', name: 'Payments', objectIds: [], color: '#eee',
  tagAssignments: {}, tagOrder: [], ...over,
} as Group)

const object = (over: Partial<C4Object> = {}): C4Object => ({
  id: 'o1', type: 'app', name: 'Billing', position: { x: 0, y: 0 }, size: { width: 10, height: 10 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
} as C4Object)

describe('groupInlineEditSeed', () => {
  it('seeds a standard group from its own name', () => {
    expect(groupInlineEditSeed(group(), undefined, 'title')).toBe('Payments')
  })

  // The painted header is fitted and ellipsized; seeding from it would save a
  // literal '...' into the model on the next commit.
  it('seeds a wrapper from the PARENT OBJECT, not the mirrored group', () => {
    const wrapper = group({ parentObjectId: 'o1', name: 'stale mirror' })
    expect(groupInlineEditSeed(wrapper, object({ name: 'Billing' }), 'title')).toBe('Billing')
  })

  it('seeds a wrapper description from the object short description', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    expect(groupInlineEditSeed(wrapper, object({ shortDescription: 'Takes money' }), 'description'))
      .toBe('Takes money')
  })

  it('seeds an empty string rather than undefined when there is nothing yet', () => {
    expect(groupInlineEditSeed(group(), undefined, 'description')).toBe('')
    expect(groupInlineEditSeed(group({ parentObjectId: 'o1' }), object(), 'description')).toBe('')
  })
})

describe('planGroupInlineTextEdit', () => {
  it('renames a standard group on the group itself', () => {
    expect(planGroupInlineTextEdit(group(), undefined, 'title', 'Billing domain')).toEqual({
      target: 'group', id: 'g1', update: { name: 'Billing domain' },
    })
  })

  // Every write re-runs the sync bridge's model sweep and rebuilds the engine's
  // index maps, so a blur with no edit must not write.
  it('writes nothing when the value is unchanged', () => {
    expect(planGroupInlineTextEdit(group(), undefined, 'title', 'Payments')).toBeNull()
  })

  // A nameless group is unidentifiable on the canvas and in every list.
  it('refuses to blank a title', () => {
    expect(planGroupInlineTextEdit(group(), undefined, 'title', '   ')).toBeNull()
  })

  it('truncates at the shared inline-edit cap', () => {
    const long = 'x'.repeat(INLINE_EDIT_MAX_LEN + 40)
    const write = planGroupInlineTextEdit(group(), undefined, 'title', long)
    expect((write?.update as Partial<Group>).name).toHaveLength(INLINE_EDIT_MAX_LEN)
  })

  // The load-bearing rule. A wrapper's name is a MIRROR that `updateObject`
  // rewrites from the object, so writing it to the group survives only until the
  // next edit of the object and then silently reverts.
  it('routes a wrapper rename to the parent OBJECT, never to the group', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    expect(planGroupInlineTextEdit(wrapper, object(), 'title', 'Ledger')).toEqual({
      target: 'object', id: 'o1', update: { name: 'Ledger' },
    })
  })

  // Never a bare `{ description }`: on a legacy object that field is overloaded
  // and `objectShortDescription` keeps returning the old value, so the canvas
  // would not change. `separateObjectShortDescription` splits the two, writing
  // the short line AND preserving the detailed document beside it.
  it('keeps a migrated object\'s detailed document beside the edited short line', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    const write = planGroupInlineTextEdit(
      wrapper,
      object({ shortDescription: 'old', description: 'Long markdown that must survive' }),
      'description',
      'Takes money',
    )
    expect(write).toEqual({
      target: 'object',
      id: 'o1',
      update: { shortDescription: 'Takes money', description: 'Long markdown that must survive' },
    })
  })

  // On a LEGACY object `description` held the compact label, not documentation,
  // so it is retired rather than promoted — otherwise the old one-liner would
  // reappear as the object's detailed docs.
  it('retires a legacy overloaded description instead of promoting it', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    const write = planGroupInlineTextEdit(
      wrapper,
      object({ description: 'old compact label' }),
      'description',
      'Takes money',
    )
    expect(write).toEqual({
      target: 'object',
      id: 'o1',
      update: { shortDescription: 'Takes money', description: '' },
    })
  })

  it('compares a wrapper rename against the OBJECT name, not the mirror', () => {
    const wrapper = group({ parentObjectId: 'o1', name: 'stale mirror' })
    expect(planGroupInlineTextEdit(wrapper, object({ name: 'Billing' }), 'title', 'Billing')).toBeNull()
  })

  // Writing to the mirror instead would revert, so there is nothing safe to do.
  it('refuses a wrapper edit when the parent object is not in hand', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    expect(planGroupInlineTextEdit(wrapper, undefined, 'title', 'Ledger')).toBeNull()
    expect(planGroupInlineTextEdit(wrapper, undefined, 'description', 'anything')).toBeNull()
  })

  it('refuses to blank a wrapper title too', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    expect(planGroupInlineTextEdit(wrapper, object(), 'title', '')).toBeNull()
  })
})

describe('isMirrorOfObject', () => {
  it('is exactly "has a parent object"', () => {
    expect(isMirrorOfObject(group())).toBe(false)
    expect(isMirrorOfObject(group({ parentObjectId: 'o1' }))).toBe(true)
  })
})

/**
 * The bug this file's earlier version certified as correct.
 *
 * `planGroupInlineTextEdit` refuses a wrapper edit with no parent object in
 * hand, and a test above pins that refusal as intended — which it is. What no
 * test could see from inside the planner is that the CALLER could never supply
 * one: it resolved the parent from the current diagram's composition, and a
 * wrapper's parent object is by construction never in its own child diagram.
 * Every wrapper edit was silently discarded. These test the resolution instead.
 */
describe('resolveInlineEditSubject', () => {
  const lookups = (over: Partial<Parameters<typeof resolveInlineEditSubject>[1]> = {}) => ({
    diagramObject: () => undefined,
    diagramGroup: () => undefined,
    modelObject: () => undefined,
    ...over,
  })

  it('resolves a wrapper against the MODEL, not the diagram it is drawn on', () => {
    const wrapper = group({ id: 'w1', parentObjectId: 'o1' })
    const parent = object({ id: 'o1' })

    const subject = resolveInlineEditSubject({ kind: 'group', id: 'w1' }, lookups({
      // Exactly the production shape: the child diagram holds the wrapper and
      // NOT the parent object, so a diagram-scoped object lookup finds nothing.
      diagramGroup: (id) => (id === 'w1' ? wrapper : undefined),
      diagramObject: () => undefined,
      modelObject: (id) => (id === 'o1' ? parent : undefined),
    }))

    expect(subject).toEqual({ kind: 'group', group: wrapper, parentObject: parent })
    // …and the write the editor would then make actually lands.
    expect(planGroupInlineTextEdit(wrapper, parent, 'title', 'Ledger')).toEqual({
      target: 'object', id: 'o1', update: { name: 'Ledger' },
    })
  })

  it('opens no editor at all when a wrapper has lost its parent object', () => {
    const wrapper = group({ id: 'w1', parentObjectId: 'gone' })
    expect(resolveInlineEditSubject({ kind: 'group', id: 'w1' }, lookups({
      diagramGroup: () => wrapper,
    }))).toBeNull()
  })

  it('needs no parent object for a standard group', () => {
    const plain = group({ id: 'g1' })
    expect(resolveInlineEditSubject({ kind: 'group', id: 'g1' }, lookups({
      diagramGroup: () => plain,
    }))).toEqual({ kind: 'group', group: plain })
  })

  // Diagram-scoped on purpose: an entity that left this diagram has no painted
  // rect, so the overlay would track nothing and park over unrelated canvas.
  it('closes when the group has left the current diagram', () => {
    expect(resolveInlineEditSubject({ kind: 'group', id: 'g1' }, lookups())).toBeNull()
  })

  it('closes when the shape has left the current diagram', () => {
    expect(resolveInlineEditSubject({ kind: 'object', id: 'o1' }, lookups({
      // Still in the model — but not on this diagram, which is what counts.
      modelObject: () => object({ id: 'o1' }),
    }))).toBeNull()
  })

  it('resolves a shape from the diagram', () => {
    const shape = object({ id: 'o1' })
    expect(resolveInlineEditSubject({ kind: 'object', id: 'o1' }, lookups({
      diagramObject: () => shape,
    }))).toEqual({ kind: 'object', object: shape })
  })
})

describe('the mutants the first cut of this file let through', () => {
  it('seeds a standard group from the GROUP even when an object is in hand', () => {
    // Drops `isMirrorOfObject(group) &&` from the seed condition and this fails.
    expect(groupInlineEditSeed(group({ name: 'Payments' }), object({ name: 'Billing' }), 'title'))
      .toBe('Payments')
  })

  it('refuses a whitespace-only wrapper title, not just an empty one', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    expect(planGroupInlineTextEdit(wrapper, object(), 'title', '   ')).toBeNull()
  })

  it('truncates a wrapper title at the cap', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    const write = planGroupInlineTextEdit(wrapper, object(), 'title', 'x'.repeat(INLINE_EDIT_MAX_LEN + 40))
    expect((write?.update as Partial<C4Object>).name).toHaveLength(INLINE_EDIT_MAX_LEN)
  })

  it('truncates a wrapper description at the cap', () => {
    const wrapper = group({ parentObjectId: 'o1' })
    const write = planGroupInlineTextEdit(wrapper, object(), 'description', 'x'.repeat(INLINE_EDIT_MAX_LEN + 40))
    expect((write?.update as Partial<C4Object>).shortDescription).toHaveLength(INLINE_EDIT_MAX_LEN)
  })

  // Unreachable from the canvas today (a standard group paints no description
  // band), but the module documents itself as total rather than throwing.
  it('keeps the standard-group description branch honest', () => {
    expect(planGroupInlineTextEdit(group(), undefined, 'description', 'Handles payouts')).toEqual({
      target: 'group', id: 'g1', update: { description: 'Handles payouts' },
    })
    expect(planGroupInlineTextEdit(group({ description: 'same' }), undefined, 'description', 'same')).toBeNull()
  })
})
