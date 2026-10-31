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

import { beforeAll, describe, expect, it } from 'vitest'
import type { C4Object } from '../../types'
import { defaultSkin } from '../../skins/defaultSkin'
import i18n from '../i18n'
import { exportIconPath, inlineExportIcons, renderExportSvg, type SvgScene } from './svg'

// Regression: the SVG export drew a type glyph for every object while the canvas
// and the PNG/PDF exports (which rasterise through CanvasEngine) drew the logo.

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

const measure = (t: string, size: number) => t.length * size * 0.55

const obj = (partial: Partial<C4Object> & { id: string; name: string }): C4Object => ({
  type: 'app',
  position: { x: 0, y: 0 },
  size: { width: 180, height: 110 },
  tagAssignments: {}, tagOrder: [], scope: 'internal',
  status: 'live',
  properties: {},
  ...partial,
})

const withLogo = (id: string, x: number, type: C4Object['type'] = 'app'): C4Object =>
  obj({
    id,
    name: `Node ${id}`,
    type,
    position: { x, y: 0 },
    icon: 'PostgreSQL',
    iconAssignment: {
      source: 'technology',
      mode: 'automatic',
      displayName: 'PostgreSQL',
      iconLightPath: '/icons/light/pg.png',
      iconDarkPath: '/icons/dark/pg.png',
    },
  })

const scene = (objects: C4Object[]): SvgScene => ({
  diagramName: 'Icons',
  objects,
  connections: [],
  groups: [],
  connectionGeoms: [],
  skin: defaultSkin,
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_URI = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`

describe('exportIconPath', () => {
  it('follows the canvas: icon + assignment, theme-selected with fallback', () => {
    const o = withLogo('a', 0)
    expect(exportIconPath(o, 'light')).toBe('/icons/light/pg.png')
    expect(exportIconPath(o, 'dark')).toBe('/icons/dark/pg.png')
    const lightOnly = { ...o, iconAssignment: { ...o.iconAssignment!, iconDarkPath: undefined } }
    expect(exportIconPath(lightOnly, 'dark')).toBe('/icons/light/pg.png')
  })

  it('has no artwork without an icon or without an assignment', () => {
    expect(exportIconPath({ ...withLogo('a', 0), icon: undefined }, 'light')).toBeUndefined()
    expect(exportIconPath({ ...withLogo('a', 0), iconAssignment: undefined }, 'light')).toBeUndefined()
  })
})

describe('inlineExportIcons', () => {
  it('turns a same-origin path into a self-contained data URI', async () => {
    const seen: string[] = []
    const fetchFn = (async (url: string) => {
      seen.push(url)
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    const icons = await inlineExportIcons(['/icons/light/pg.png', '/icons/light/pg.png'], fetchFn)
    expect(icons.get('/icons/light/pg.png')).toBe(PNG_URI)
    expect(seen).toEqual(['/icons/light/pg.png'])
  })

  it('leaves out assets that fail, are empty or are not images', async () => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith('missing.png')) return new Response('nope', { status: 404 })
      if (url.endsWith('empty.png')) return new Response(new Uint8Array(), { headers: { 'content-type': 'image/png' } })
      if (url.endsWith('html.png')) return new Response('<html>', { headers: { 'content-type': 'text/html' } })
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    const icons = await inlineExportIcons(['/missing.png', '/empty.png', '/html.png', '/offline.png'], fetchFn)
    expect(icons.size).toBe(0)
  })
})

describe('renderExportSvg technology artwork', () => {
  it('embeds the logo instead of the type glyph, once per distinct asset', () => {
    const icons = new Map([['/icons/light/pg.png', PNG_URI]])
    const svg = renderExportSvg(scene([withLogo('a', 0), withLogo('b', 300), withLogo('c', 600, 'store')]), {
      measure,
      icons,
    })
    // One embedded copy, three placements — stores included, as on the canvas.
    expect(svg.split(PNG_URI).length - 1).toBe(1)
    expect(svg.match(/<use href="#ms-icon-0"/g)).toHaveLength(3)
    expect(svg).toContain('<clipPath id="ms-icon-clip">')
    // No relative path survives into the file: it must open standalone.
    expect(svg).not.toContain('/icons/light/pg.png')
    // The app glyph letter is not drawn over/under the logo.
    expect(svg).not.toMatch(/font-weight="700"[^>]*>A<\/text>/)
  })

  it('picks the dark variant for the dark theme', () => {
    const icons = new Map([['/icons/dark/pg.png', PNG_URI]])
    const svg = renderExportSvg(scene([withLogo('a', 0)]), { measure, icons, theme: 'dark' })
    expect(svg).toContain('<use href="#ms-icon-0"')
  })

  it('keeps the type glyph when the artwork could not be embedded', () => {
    const svg = renderExportSvg(scene([withLogo('a', 0)]), { measure, icons: new Map() })
    expect(svg).not.toContain('<use ')
    expect(svg).not.toContain('<defs>')
    expect(svg).toMatch(/font-weight="700"[^>]*>A<\/text>/)
  })

  it('keeps the type glyph for a shape without artwork', () => {
    const icons = new Map([['/icons/light/pg.png', PNG_URI]])
    const plain = obj({ id: 'p', name: 'Plain', type: 'system' })
    const svg = renderExportSvg(scene([plain]), { measure, icons })
    expect(svg).not.toContain(PNG_URI)
    expect(svg).toMatch(/font-weight="700"[^>]*>S<\/text>/)
  })
})
