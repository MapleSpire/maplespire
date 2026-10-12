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
import { sanitizeSceneDecor } from './decorSpec'

describe('sanitizeSceneDecor (decor persistence boundary)', () => {
  it('drops anything without at least one valid free choice', () => {
    expect(sanitizeSceneDecor(null)).toBeNull()
    expect(sanitizeSceneDecor('maquette-people')).toBeNull()
    expect(sanitizeSceneDecor({})).toBeNull()
    expect(sanitizeSceneDecor({ packId: '' })).toBeNull()
    expect(sanitizeSceneDecor({ packId: 'a/b' })).toBeNull()
    expect(sanitizeSceneDecor({ packId: 'x'.repeat(65) })).toBeNull()
    // density/seed alone never make an entry valid — they qualify a choice
    expect(sanitizeSceneDecor({ density: 'rich', seed: 7 })).toBeNull()
  })

  it('keeps a bare pack choice (back-compat: packId-only docs unchanged)', () => {
    expect(sanitizeSceneDecor({ packId: 'maquette-people' })).toEqual({ packId: 'maquette-people' })
  })

  it('accepts tray-only and background-only docs (three free choices)', () => {
    expect(sanitizeSceneDecor({ boardStyle: 'wood' })).toEqual({ boardStyle: 'wood' })
    expect(sanitizeSceneDecor({ background: 'city' })).toEqual({ background: 'city' })
    // seed rides without a pack — the city background consumes it too
    expect(sanitizeSceneDecor({ background: 'city', seed: 7 })).toEqual({ background: 'city', seed: 7 })
    // a malformed packId is dropped as a FIELD; the entry survives on the tray
    expect(sanitizeSceneDecor({ packId: 'a/b', boardStyle: 'museum' })).toEqual({ boardStyle: 'museum' })
  })

  it('gates enums, floors the seed to a uint32, drops unknown keys', () => {
    const out = sanitizeSceneDecor({
      packId: 'datacenter',
      density: 'rich',
      boardStyle: 'paper-grid',
      background: 'workbench',
      seed: 12.7,
      evil: 'nope',
    })!
    expect(out).toEqual({
      packId: 'datacenter', density: 'rich', boardStyle: 'paper-grid', background: 'workbench', seed: 13,
    })
    expect(sanitizeSceneDecor({ packId: 'p', density: 'ALL' })!.density).toBeUndefined()
    expect(sanitizeSceneDecor({ packId: 'p', seed: Number.NaN })!.seed).toBeUndefined()
    for (const boardStyle of ['default', 'paper-grid', 'wood', 'museum', 'clay']) {
      expect(sanitizeSceneDecor({ packId: 'p', boardStyle })!.boardStyle).toBe(boardStyle)
    }
    for (const background of ['default', 'workbench', 'city', 'studio', 'void']) {
      expect(sanitizeSceneDecor({ packId: 'p', background })!.background).toBe(background)
    }
  })

  it('drops junk tray/background values — never keeps a key holding undefined', () => {
    const out = sanitizeSceneDecor({ packId: 'p', boardStyle: 'lava', background: 12 })!
    expect(out).toEqual({ packId: 'p' })
    expect('boardStyle' in out).toBe(false)
    expect('background' in out).toBe(false)
    // junk-only docs collapse to null (caller strips the field entirely)
    expect(sanitizeSceneDecor({ boardStyle: 'lava' })).toBeNull()
    expect(sanitizeSceneDecor({ background: 'space' })).toBeNull()
  })

  it('sanitizes the reserved per-prop override map (id charset, clamps, cap)', () => {
    const out = sanitizeSceneDecor({
      packId: 'greenery',
      props: {
        'tree-tall:12:-4': { skip: true, dx: 9000, rotY: -720, scale: 0 },
        'bad key!': { skip: true },
        'tree-round:0:0': { unknown: 1 },
      },
    })!
    expect(out.props).toEqual({
      'tree-tall:12:-4': { skip: true, dx: 400, rotY: -360, scale: 0.5 },
    })

    // hostile-doc cap: 200 entries max survive
    const props: Record<string, { skip: boolean }> = {}
    for (let i = 0; i < 300; i++) props[`p:${i}`] = { skip: true }
    const capped = sanitizeSceneDecor({ packId: 'p', props })!
    expect(Object.keys(capped.props!).length).toBe(200)
  })
})
