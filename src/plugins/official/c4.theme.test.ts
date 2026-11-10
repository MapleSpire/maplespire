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

import { describe, expect, it, vi } from 'vitest'
import { c4Theme, shadeHex } from './c4.theme'
import { getOfficialTheme } from './registry'
import { c4Skin } from '../../skins/c4Skin'
import { c4SkinDark } from '../../skins/c4SkinDark'
import { defaultSkin } from '../../skins/defaultSkin'
import { skinVariants, resolveSkinForTheme } from '../../skins/variants'
import { getShopSkins, getSkinById } from '../../skins/registry'
import { builtinPlugins } from '../builtin'
import { validateSkinConfig } from '../schema'
import { resolveConnectionAnimation } from '../../skins/connectionAnimation'
import { themeFor3d } from '../theme3d'
import { personGeometry } from '../../canvas/personShape'
import type { GroupArgs, ObjectArgs, RenderContext } from '../sdk/contract'
import type { C4Type } from '../../types'
import type { SkinConfig } from '../../skins/types'

const TYPES: C4Type[] = ['actor', 'system', 'app', 'store', 'component']

function luminance(color: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) throw new Error(`not a hex colour: ${color}`)
  const n = parseInt(m[1], 16)
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('C4 Model theme — registration', () => {
  it('ships as a built-in plugin, sold in the official shop, with its own render plugin', () => {
    expect(builtinPlugins.map((p) => p.manifest.id)).toContain('c4')
    expect(getShopSkins().map((s) => s.id)).toContain('c4')
    expect(getSkinById('c4')).toBe(c4Skin)
    expect(getOfficialTheme('c4')).toBe(c4Theme)
    expect(c4Theme.meta.id).toBe(c4Skin.id)
  })

  it('follows the app theme: a light and a dark variant under one id', () => {
    expect(skinVariants.c4).toEqual({ light: c4Skin, dark: c4SkinDark })
    expect(resolveSkinForTheme(c4Skin, 'light')).toBe(c4Skin)
    expect(resolveSkinForTheme(c4Skin, 'dark')).toBe(c4SkinDark)
    expect(c4SkinDark.id).toBe('c4')
    expect(c4Skin.appearance).toBe('light')
    expect(c4SkinDark.appearance).toBe('dark')
  })

  it('both variants pass the plugin config validator (safe colours, sane numbers)', () => {
    // Built-ins are trusted and the key-based walker also flags two non-colour
    // text fields on every one of them (`description`, `tagColorMode`); beyond
    // that baseline, nothing in the C4 configs may be rejected.
    const baseline = new Set(validateSkinConfig(defaultSkin).errors.map((e) => e.split(':')[0]))
    for (const skin of [c4Skin, c4SkinDark]) {
      const extra = validateSkinConfig(skin).errors.filter((e) => !baseline.has(e.split(':')[0]))
      expect(extra).toEqual([])
    }
  })

  it('carries the canonical C4 notation colours in the light variant', () => {
    expect(c4Skin.objects.actor.fill).toBe('#08427B') // Person
    expect(c4Skin.objects.system.fill).toBe('#1168BD') // Software System
    expect(c4Skin.objects.app.fill).toBe('#438DD5') // Container
    expect(c4Skin.objects.store.fill).toBe('#438DD5') // Container: database
    expect(c4Skin.objects.component.fill).toBe('#85BBF0') // Component
  })

  it('draws actors as the person figure in both variants; no other built-in does', () => {
    expect(c4Skin.renderStyle.actorShape).toBe('person')
    expect(c4SkinDark.renderStyle.actorShape).toBe('person')
    for (const [id, pair] of Object.entries(skinVariants)) {
      if (id === 'c4') continue
      expect(pair.light.renderStyle.actorShape, id).toBeUndefined()
      expect(pair.dark.renderStyle.actorShape, id).toBeUndefined()
    }
  })

  it('animates connections in its own blue ladder', () => {
    expect(resolveConnectionAnimation(c4Skin).color).toBe('#1168BD')
  })
})

describe('C4 Model theme — legibility', () => {
  const variants: Array<[string, SkinConfig]> = [['light', c4Skin], ['dark', c4SkinDark]]
  for (const [name, skin] of variants) {
    it(`${name}: every title reads on its element (≥ 3:1, internal and external)`, () => {
      for (const type of TYPES) {
        const s = skin.objects[type]
        expect(contrast(s.text, s.fill), `${type} internal`).toBeGreaterThanOrEqual(3)
        expect(contrast(s.textExternal, s.fillExternal), `${type} external`).toBeGreaterThanOrEqual(3)
      }
    })

    it(`${name}: the hue ladder keeps its order — Person darkest, Component lightest`, () => {
      const l = (t: C4Type) => luminance(skin.objects[t].fill)
      expect(l('actor')).toBeLessThan(l('system'))
      expect(l('system')).toBeLessThan(l('app'))
      expect(l('app')).toBeLessThan(l('component'))
      const e = (t: C4Type) => luminance(skin.objects[t].fillExternal)
      expect(e('actor')).toBeLessThan(e('system'))
      expect(e('system')).toBeLessThan(e('app'))
      expect(e('app')).toBeLessThan(e('component'))
    })
  }

  it('dark: the darkest element still separates from the night canvas', () => {
    expect(contrast(c4SkinDark.objects.actor.stroke, c4SkinDark.canvas.bg)).toBeGreaterThanOrEqual(3)
  })
})

/** A recording 2D context: every call and property write, in order. */
function recorder() {
  const calls: Array<[string, unknown[]]> = []
  const state: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1 }
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key]
      if (key === 'createLinearGradient') {
        return (...args: unknown[]) => {
          calls.push([key, args])
          return { addColorStop: vi.fn() }
        }
      }
      return (...args: unknown[]) => {
        calls.push([key, args])
      }
    },
    set(target, key: string, value) {
      target[key] = value
      calls.push([`=${key}`, [value]])
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, state }
}

const renderCtx = (style: SkinConfig['renderStyle'], fastMode = false) =>
  ({ style, fastMode }) as unknown as RenderContext

function objectArgs(type: C4Type, over: Partial<ObjectArgs['state']> = {}): ObjectArgs {
  return {
    ctx: renderCtx(c4Skin.renderStyle),
    id: 'o1',
    type,
    name: 'Customer',
    geom: { x: 0, y: 0, w: 160, h: 100, cornerRadius: 12, cx: 80, cy: 50 },
    state: { selected: false, hovered: false, connectedToHover: false, focused: true, external: false, alpha: 1, ...over },
    fill: c4Skin.objects[type].fill,
    stroke: c4Skin.objects[type].stroke,
    strokeWidth: 1,
  }
}

describe('C4 Model theme — object hook', () => {
  it('owns the box (replace) and draws the actor as the person figure with its neck seam', () => {
    expect(c4Theme.object?.mode).toBe('replace')
    const { ctx, calls } = recorder()
    c4Theme.object!.draw(ctx as never, objectArgs('actor'))
    const arcs = calls.filter(([k]) => k === 'arc')
    // the head arc of the outline (over the crown) + the chin seam
    const headR = arcs.map(([, a]) => a[2] as number)
    expect(Math.max(...headR)).toBeGreaterThan(10)
    expect(calls.some(([k]) => k === 'fill')).toBe(true)
    expect(calls.some(([k]) => k === 'stroke')).toBe(true)
    // no rectangle-only box for the actor: the outline starts on the left side
    // of the (narrowed) body
    expect(calls.find(([k]) => k === 'moveTo')![1][0]).toBeCloseTo(personGeometry(0, 0, 160, 100).bodyX, 9)
  })

  it('the neck seam is quiet on a light border, quieter still under a lighter (dark-mode) border', () => {
    const seamAlpha = (fill: string, stroke: string) => {
      const { ctx, calls, state } = recorder()
      state.strokeStyle = stroke // the engine resolves the border before the hook
      c4Theme.object!.draw(ctx as never, { ...objectArgs('actor'), fill, stroke })
      return calls.filter(([k]) => k === '=globalAlpha').map(([, v]) => v[0])
    }
    expect(seamAlpha(c4Skin.objects.actor.fill, c4Skin.objects.actor.stroke)).toContain(0.7)
    const dark = seamAlpha(c4SkinDark.objects.actor.fill, c4SkinDark.objects.actor.stroke)
    expect(dark).toContain(0.45)
    expect(dark).not.toContain(0.7)
  })

  it('fills with a top-lit gradient of the element colour, and skips the sheen while interacting', () => {
    const lit = recorder()
    c4Theme.object!.draw(lit.ctx as never, objectArgs('system'))
    expect(lit.calls.filter(([k]) => k === 'createLinearGradient')).toHaveLength(2)
    const fast = recorder()
    c4Theme.object!.draw(fast.ctx as never, { ...objectArgs('system'), ctx: renderCtx(c4Skin.renderStyle, true) })
    expect(fast.calls.filter(([k]) => k === 'createLinearGradient')).toHaveLength(1)
  })

  it('outlines a resting grey external in a shade of its own grey, not its type blue', () => {
    const { ctx, calls } = recorder()
    const args = { ...objectArgs('system', { external: true }), fill: c4Skin.objects.system.fillExternal }
    c4Theme.object!.draw(ctx as never, args)
    const strokes = calls.filter(([k]) => k === '=strokeStyle').map(([, v]) => v[0])
    expect(strokes).toContain(shadeHex(c4Skin.objects.system.fillExternal, -0.22))
    expect(strokes).not.toContain(c4Skin.objects.system.stroke)
  })

  it('a selected element gains the accent ring outside its border', () => {
    const { ctx, calls } = recorder()
    const args = { ...objectArgs('app', { selected: true }), stroke: c4Skin.objects.app.strokeSelected }
    c4Theme.object!.draw(ctx as never, args)
    const strokes = calls.filter(([k]) => k === '=strokeStyle').map(([, v]) => v[0])
    expect(strokes).toContain('rgba(245, 158, 11, 0.3)')
  })

  it('stores keep the drum: a lid disc over the body', () => {
    const { ctx, calls } = recorder()
    c4Theme.object!.draw(ctx as never, objectArgs('store'))
    expect(calls.filter(([k]) => k === 'ellipse').length).toBeGreaterThanOrEqual(3)
  })

  it('shadeHex mixes toward white / black and passes non-hex colours through', () => {
    expect(shadeHex('#000000', 0.5)).toBe('#808080')
    expect(shadeHex('#FFFFFF', -1)).toBe('#000000')
    expect(shadeHex('rgba(1, 2, 3, 0.5)', 0.3)).toBe('rgba(1, 2, 3, 0.5)')
  })
})

describe('C4 Model theme — boundaries (group hook)', () => {
  const groupArgs = (over: Partial<GroupArgs> = {}): GroupArgs => ({
    ctx: renderCtx(c4Skin.renderStyle),
    id: 'g1',
    isParentWrapper: false,
    geom: { x: 0, y: 0, w: 300, h: 200, cornerRadius: 12 },
    state: { selected: false },
    fill: '#F1F5F9',
    stroke: c4Skin.groups.navColor,
    fillAlpha: 0.3,
    strokeAlpha: 0.85,
    strokeWidth: 0,
    customColors: false,
    ...over,
  })

  it('draws a dashed frame over the theme wash and hands back a solid dash', () => {
    const { ctx, calls, state } = recorder()
    c4Theme.group!.draw(ctx as never, groupArgs())
    const dashes = calls.filter(([k]) => k === 'setLineDash').map(([, a]) => a[0])
    expect(dashes[0]).toEqual([7, 5])
    expect(dashes[dashes.length - 1]).toEqual([])
    expect(calls.filter(([k]) => k === '=fillStyle').map(([, v]) => v[0])).toContain(c4Skin.renderStyle.groupHudFill)
    // like the default box: the stroke alpha stays set for the header that follows
    expect(state.globalAlpha).toBe(0.85)
  })

  it('honours a user background and a transparent group', () => {
    const custom = recorder()
    c4Theme.group!.draw(custom.ctx as never, groupArgs({ customColors: true, fill: '#FF0000', fillAlpha: 0.4 }))
    expect(custom.calls.filter(([k]) => k === '=fillStyle').map(([, v]) => v[0])).toContain('#FF0000')
    const clear = recorder()
    c4Theme.group!.draw(clear.ctx as never, groupArgs({ fillAlpha: 0 }))
    expect(clear.calls.some(([k]) => k === 'fill')).toBe(false)
    expect(clear.calls.some(([k]) => k === 'stroke')).toBe(true)
  })
})

describe('C4 Model theme — 3D board', () => {
  it('tints the database drum with the element colour; other nodes keep the engine default', () => {
    const source = themeFor3d(c4Skin)!
    expect(source).not.toBeNull()
    const base = { id: 'n', name: 'n', selected: false, external: false, zBase: 0, zTop: 10 }
    expect(source.objectSpec({ ...base, type: 'store', fill: '#438DD5' })).toEqual({ materials: { top: '#438DD5' } })
    expect(source.objectSpec({ ...base, type: 'app', fill: '#438DD5' })).toBeNull()
  })

  it('rims a grey external card in its own grey (2D parity); a selected one keeps the accent', () => {
    const source = themeFor3d(c4Skin)!
    const fill = c4Skin.objects.system.fillExternal
    const base = { id: 'n', name: 'n', type: 'system' as const, fill, external: true, zBase: 0, zTop: 10 }
    expect(source.objectSpec({ ...base, selected: false })).toEqual({ materials: { border: shadeHex(fill, -0.22) } })
    expect(source.objectSpec({ ...base, selected: true })).toBeNull()
  })
})
