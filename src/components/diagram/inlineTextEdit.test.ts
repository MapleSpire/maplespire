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
import { INLINE_EDIT_MAX_LEN, inlineEditSeed, planInlineTextEdit } from './inlineTextEdit'
import { projectInlineEditRect } from './inlineEditGeometry'
import type { C4Object } from '../../types'

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

describe('inlineEditSeed', () => {
  it('seeds from the STORE value, not the truncated painted text', () => {
    // The canvas paints a fitted, ellipsized string. Seeding from it would
    // write a literal '...' back into the model on the next commit.
    const long = 'A very long shape name that the canvas would truncate'

    expect(inlineEditSeed(object({ name: long }), 'title')).toBe(long)
  })

  it('reads a legacy description through the migration helper', () => {
    // No `shortDescription` key at all: the compact value still lives in
    // `description`, and that is what the canvas renders.
    expect(inlineEditSeed(object({ description: 'Legacy compact' }), 'description'))
      .toBe('Legacy compact')
  })

  it('prefers shortDescription once the object has been migrated', () => {
    const migrated = object({ shortDescription: 'Compact', description: '# Detailed markdown' })

    expect(inlineEditSeed(migrated, 'description')).toBe('Compact')
  })

  it('seeds an empty string when there is no description yet', () => {
    expect(inlineEditSeed(object(), 'description')).toBe('')
  })
})

describe('planInlineTextEdit', () => {
  it('THE MIGRATION TRAP: a description edit writes shortDescription, not description', () => {
    // Writing `{ description }` on a MIGRATED object edits the detailed
    // Markdown doc, which the canvas does not render — the shape would not
    // change and the user would read the editor as broken.
    const migrated = object({ shortDescription: 'Old', description: '# Detailed markdown' })

    const update = planInlineTextEdit(migrated, 'description', 'New')

    expect(update).toEqual({ shortDescription: 'New', description: '# Detailed markdown' })
  })

  it('retires the legacy overloaded value on a legacy object', () => {
    // Leaving `description` in place would let objectShortDescription keep
    // returning the OLD text, so the edit would appear not to stick.
    const legacy = object({ description: 'Legacy compact' })

    expect(planInlineTextEdit(legacy, 'description', 'New')).toEqual({
      shortDescription: 'New',
      description: '',
    })
  })

  it('returns null when nothing changed, so a blur writes nothing', () => {
    // Every updateObject mirrors onto parent-wrapper groups and re-runs the
    // sync bridge's model sweep. Opening and closing an editor must be free.
    expect(planInlineTextEdit(object({ name: 'API' }), 'title', 'API')).toBeNull()
    expect(planInlineTextEdit(object({ shortDescription: 'D' }), 'description', 'D')).toBeNull()
    expect(planInlineTextEdit(object(), 'description', '')).toBeNull()
  })

  it('refuses to blank a title', () => {
    // A nameless shape is unidentifiable on the canvas and in every list, and
    // this app has no undo.
    expect(planInlineTextEdit(object({ name: 'API' }), 'title', '')).toBeNull()
    expect(planInlineTextEdit(object({ name: 'API' }), 'title', '   ')).toBeNull()
  })

  it('allows a description to be cleared', () => {
    // Unlike the title, empty is a legitimate description.
    expect(planInlineTextEdit(object({ shortDescription: 'D' }), 'description', ''))
      .toMatchObject({ shortDescription: '' })
  })

  it('caps at the same length the sidebar enforces', () => {
    const over = 'x'.repeat(INLINE_EDIT_MAX_LEN + 20)

    expect((planInlineTextEdit(object(), 'title', over) as { name: string }).name)
      .toHaveLength(INLINE_EDIT_MAX_LEN)
    expect((planInlineTextEdit(object(), 'description', over) as { shortDescription: string }).shortDescription)
      .toHaveLength(INLINE_EDIT_MAX_LEN)
  })
})

describe('projectInlineEditRect', () => {
  const world = { x: 100, y: 50, width: 184, height: 13, fontSize: 13, lineHeight: 13 }

  it('follows a pan', () => {
    // The existing connection-label overlay projects once at open time and
    // never again, so it detaches on any pan or zoom — and a wheel zoom moves
    // no focus, so nothing closes it to hide the drift.
    const a = projectInlineEditRect(world, { x: 0, y: 0, scale: 1 })
    const b = projectInlineEditRect(world, { x: 40, y: -25, scale: 1 })

    expect(b.left - a.left).toBe(40)
    expect(b.top - a.top).toBe(-25)
  })

  it('derives line height from the CLAMPED font size', () => {
    // At 0.5 zoom the font is clamped up to a readable 11px. Scaling the line
    // height independently (as the older overlay does, 12 * scale) would put
    // 11px glyphs in a 6px line box and clip them. Fit-to-screen lands here.
    const projected = projectInlineEditRect(world, { x: 0, y: 0, scale: 0.5 })

    expect(projected.fontSize).toBe(11)
    expect(projected.lineHeight).toBeCloseTo(11 * 1.15)
    // The box must fit a whole LINE plus its own border and padding. Sizing it
    // from the glyph height alone leaves a content box shorter than one line,
    // which clips descenders and — at small sizes — the caret.
    expect(projected.height).toBeGreaterThan(projected.lineHeight)
  })

  it('scales with zoom when above the readable floor', () => {
    const projected = projectInlineEditRect(world, { x: 0, y: 0, scale: 2 })

    expect(projected.fontSize).toBe(26)
    expect(projected.width).toBe(368)
  })
})
