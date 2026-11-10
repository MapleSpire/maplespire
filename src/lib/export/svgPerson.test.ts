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
import type { C4Object } from '../../types'
import { renderExportSvg, type SvgScene } from './svg'
import { defaultSkin } from '../../skins/defaultSkin'
import { c4Skin } from '../../skins/c4Skin'
import { c4SkinDark } from '../../skins/c4SkinDark'
import { personGeometry, personNeckPathD, personPathD } from '../../canvas/personShape'

const measure = (t: string, size: number) => t.length * size * 0.55

const obj = (over: Partial<C4Object> & { id: string; type: C4Object['type'] }): C4Object =>
  ({
    name: over.id,
    position: { x: 0, y: 0 },
    size: { width: 160, height: 100 },
    scope: 'internal',
    status: 'live',
    properties: {},
    tagAssignments: {},
    tagOrder: [],
    ...over,
  }) as C4Object

const scene = (skin: SvgScene['skin']): SvgScene => ({
  diagramName: 'People',
  objects: [
    obj({ id: 'customer', type: 'actor', shortDescription: 'Buys things' }),
    obj({ id: 'shop', type: 'system', position: { x: 300, y: 0 } }),
  ],
  connections: [],
  groups: [],
  connectionGeoms: [],
  skin,
})

describe('renderExportSvg — the C4 person figure', () => {
  it('exports the actor as the same silhouette the canvas draws, with its neck seam and no type glyph', () => {
    const svg = renderExportSvg(scene(c4Skin), { measure })
    const pad = 48 // the export's page margin around the content bounds (svg.ts)
    const g = personGeometry(0, 0, 160, 100)
    const t = (v: number) => +(v + pad).toFixed(2)
    expect(svg).toContain(`d="${personPathD(g, t, t)}"`)
    expect(svg).toContain(`d="${personNeckPathD(g, t, t)}"`)
    expect(svg).toContain(`fill="${c4Skin.objects.actor.fill}"`)
    // the card's little head-and-shoulders glyph is not drawn: the figure is the icon
    expect(svg).not.toContain('r="5"')
    // the title sits in the body, under the head
    const titleY = Number(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>customer<`).exec(svg)?.[1])
    expect(titleY - pad).toBeGreaterThan(g.bodyY + 6)
  })

  it('the description wraps to the body (narrower than the box), and the dark seam is quieter', () => {
    const long = 'Places orders, tracks deliveries and manages their account'
    const svg = renderExportSvg(
      { ...scene(c4Skin), objects: [obj({ id: 'customer', type: 'actor', shortDescription: long })] },
      { measure },
    )
    const g = personGeometry(0, 0, 160, 100)
    const lines = [...svg.matchAll(/font-size="([\d.]+)" font-weight="400"[^>]*>([^<]+)</g)]
    expect(lines.length).toBeGreaterThan(0)
    for (const [, size, text] of lines) expect(measure(text, Number(size))).toBeLessThanOrEqual(g.bodyW - 16 + 1e-6)
    // a card-wide wrap (w − 16) would have produced a line longer than the body allows
    expect(measure(long, 9)).toBeGreaterThan(g.bodyW - 16)

    const dark = renderExportSvg(scene(c4SkinDark), { measure })
    expect(dark).toContain('stroke-opacity="0.45"')
    expect(renderExportSvg(scene(c4Skin), { measure })).toContain('stroke-opacity="0.7"')
  })

  it('every other element keeps its card, and other themes keep the card actor', () => {
    const c4 = renderExportSvg(scene(c4Skin), { measure })
    expect(c4).toMatch(/<rect x="[\d.]+" y="[\d.]+" width="160" height="100" rx="10"/) // the system
    const plain = renderExportSvg(scene(defaultSkin), { measure })
    expect(plain.match(/<rect x="[\d.]+" y="[\d.]+" width="160" height="100"/g)).toHaveLength(2)
    expect(plain).toContain('r="5"') // the actor glyph's head
  })
})
