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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assignPresenceAppearances,
  PRESENCE_APPEARANCES,
  PRESENCE_PALETTE_SIZE,
} from './colors'

describe('presence colors', () => {
  it('keeps the palette tokens available in light and dark themes', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
    const lightRoot = /@theme static\s*\{(?<tokens>[\s\S]*?)\}/u.exec(css)?.groups?.tokens ?? ''
    const darkRoot = /:root\[data-theme='dark'\]\s*\{(?<tokens>[\s\S]*?)\}/u.exec(css)?.groups?.tokens ?? ''
    for (const token of [
      '--presence-saturation',
      '--presence-lightness-1',
      '--presence-lightness-2',
      '--presence-lightness-3',
      '--presence-on-color',
    ]) {
      expect(lightRoot).toContain(token)
      expect(darkRoot).toContain(token)
    }
  })

  it('assigns 100 distinct deterministic pastels', () => {
    expect(PRESENCE_APPEARANCES).toHaveLength(PRESENCE_PALETTE_SIZE)
    const ids = Array.from({ length: PRESENCE_PALETTE_SIZE }, (_, index) => `participant-${index}`)
    const first = assignPresenceAppearances(ids)
    const reversed = assignPresenceAppearances([...ids].reverse())
    expect(new Set(ids.map((id) => first.get(id)?.background))).toHaveLength(ids.length)
    expect([...first.entries()]).toEqual([...reversed.entries()])
  })
})
