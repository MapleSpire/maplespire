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
 * Standalone 2D canvas bench. Serve with `npx vite` and open
 * `/bench/canvas2d/index.html`; drive it from the console through
 * `window.__bench` (see the API at the bottom of this file).
 *
 * It drives the REAL engine through real DOM events (middle-button pan,
 * wheel zoom, shape drag, hover) on a dense synthetic diagram, and times every
 * `render()` call. No server, no store, no Automerge: only the canvas.
 *
 * A/B: when `src/canvas/engine/CanvasEngine.baseline.ts` exists (an untracked
 * copy of the engine at the comparison commit), `?engine=baseline` runs it
 * instead, and `pixelCompare()` renders identical states on both engines and
 * diffs them pixel by pixel.
 */

import { CanvasEngine } from '../../src/canvas/engine/CanvasEngine'
import type { C4Object, C4Type, Connection, ConnectionHighlightStyle, Group, SelectedItem } from '../../src/types'
import type { SkinConfig } from '../../src/skins/types'
import { defaultSkin } from '../../src/skins/defaultSkin'
import { defaultSkinDark } from '../../src/skins/defaultSkinDark'
import { studioSkin } from '../../src/skins/studioSkin'
import { studioSkinDark } from '../../src/skins/studioSkinDark'
import { slateSkin } from '../../src/skins/slateSkin'
import { cyberpunkSkin } from '../../src/skins/cyberpunkSkin'
import { eightBitSkin } from '../../src/skins/eightBitSkin'
import { graffitiSkin } from '../../src/skins/graffitiSkin'

type EngineCtor = typeof CanvasEngine
type EngineKind = 'current' | 'baseline'

const SKINS: Record<string, SkinConfig> = {
  default: defaultSkin,
  defaultDark: defaultSkinDark,
  studio: studioSkin,
  studioDark: studioSkinDark,
  slate: slateSkin,
  cyberpunk: cyberpunkSkin,
  eightBit: eightBitSkin,
  graffiti: graffitiSkin,
}

const WIDTH = 1600
const HEIGHT = 900

const baselineModules = import.meta.glob('../../src/canvas/engine/CanvasEngine.baseline.ts')

async function loadEngine(kind: EngineKind): Promise<EngineCtor> {
  if (kind === 'current') return CanvasEngine
  const loader = Object.values(baselineModules)[0]
  if (!loader) throw new Error('no CanvasEngine.baseline.ts next to the engine')
  const mod = (await loader()) as { CanvasEngine: EngineCtor }
  return mod.CanvasEngine
}

// --- deterministic synthetic scene ------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['Payment', 'Order', 'Identity', 'Catalog', 'Billing', 'Search', 'Gateway', 'Ledger',
  'Notification', 'Inventory', 'Shipping', 'Analytics', 'Pricing', 'Customer', 'Fraud', 'Reporting']
const SUFFIX = ['Service', 'API', 'Worker', 'Store', 'Portal', 'Engine', 'Adapter', 'Hub']
const DESCS = [
  'Handles card authorisation and settlement with the acquiring bank.',
  'Publishes domain events to downstream consumers over the shared message bus and retries on failure.',
  'Read model for the back-office.',
  'Owns the canonical customer profile, consent flags and contact preferences across every channel we operate.',
  '',
  'Batch job.',
]
const LABELS = ['calls', 'reads/writes', 'publishes events\nvia Kafka', 'HTTPS/JSON', 'gRPC', 'syncs nightly']
const TYPES: C4Type[] = ['system', 'app', 'component', 'store', 'app', 'actor']

export interface Scene {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
}

export function buildScene(cols = 20, rows = 15, seed = 42): Scene {
  const r = rng(seed)
  const objects: C4Object[] = []
  const id = (c: number, row: number) => `o-${row}-${c}`
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < cols; c++) {
      const i = row * cols + c
      const type = TYPES[i % TYPES.length]
      const desc = DESCS[Math.floor(r() * DESCS.length)]
      objects.push({
        id: id(c, row),
        type,
        name: `${WORDS[Math.floor(r() * WORDS.length)]} ${SUFFIX[Math.floor(r() * SUFFIX.length)]}${r() < 0.2 ? ' Platform Long Name' : ''}`,
        shortDescription: desc,
        position: { x: c * 320, y: row * 240 },
        size: { width: type === 'actor' ? 160 : 220, height: type === 'store' ? 150 : 140 },
        tagAssignments: {},
        tagOrder: [],
        scope: i % 7 === 0 ? 'external' : 'internal',
        status: 'live',
        properties: {},
      })
    }
  }
  const connections: Connection[] = []
  let n = 0
  const add = (from: string, to: string) => {
    const roll = r()
    connections.push({
      id: `c-${n++}`,
      fromId: from,
      toId: to,
      label: roll < 0.4 ? LABELS[Math.floor(r() * LABELS.length)] : undefined,
      type: roll > 0.95 ? 'dotted' : roll > 0.8 ? 'dashed' : 'solid',
    })
  }
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < cols; c++) {
      if (c < cols - 1 && r() < 0.8) add(id(c, row), id(c + 1, row))
      if (row < rows - 1 && r() < 0.5) add(id(c, row), id(c, row + 1))
      if (r() < 0.12) {
        const tc = Math.min(cols - 1, Math.max(0, c + Math.floor(r() * 7) - 3))
        const tr = Math.min(rows - 1, Math.max(0, row + Math.floor(r() * 5) - 2))
        if (tc !== c || tr !== row) add(id(c, row), id(tc, tr))
      }
    }
  }
  const groups: Group[] = []
  const palette = ['#DBEAFE', '#DCFCE7', '#FEF3C7', '#FCE7F3', '#EDE9FE', '#E0F2FE']
  for (let g = 0; g < 6; g++) {
    const c0 = 1 + (g % 3) * 6
    const r0 = 1 + Math.floor(g / 3) * 7
    const ids: string[] = []
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) ids.push(id(c0 + dc, r0 + dr))
    groups.push({ id: `g-${g}`, name: `${WORDS[g]} Domain`, color: palette[g], objectIds: ids })
  }
  return { objects, connections, groups }
}

// --- engine host -------------------------------------------------------------

interface Host {
  engine: CanvasEngine
  canvas: HTMLCanvasElement
  scene: Scene
  /** Duration of every frame the engine painted (full renders + animation frames). */
  renders: number[]
  animFrames: number
  commits: number
}

function makeHost(Engine: EngineCtor, container: HTMLElement, skin: SkinConfig, scene: Scene): Host {
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  const host = { canvas, scene, renders: [] as number[], animFrames: 0, commits: 0 } as Host
  const select = (items: SelectedItem[]) => host.engine.setSelectedItems(items)
  const noop = () => {}
  host.engine = new Engine(canvas, {
    onObjectSelect: (oid) => select(oid ? [{ type: 'object', id: oid }] : []),
    onGroupSelect: (gid) => { if (gid) select([{ type: 'group', id: gid }]) },
    onConnectionSelect: (cid) => { if (cid) select([{ type: 'connection', id: cid }]) },
    // The app's round trip: store write → projection → setData with the new
    // placements. Reproduced so the drop frame pays what it pays in the app.
    onPlacementsCommit: (updates) => {
      host.commits += 1
      const byId = new Map(updates.objects.map((u) => [u.id, u]))
      host.scene = {
        ...host.scene,
        objects: host.scene.objects.map((o) => {
          const u = byId.get(o.id)
          return u ? { ...o, position: { ...u.position }, ...(u.size ? { size: { ...u.size } } : {}) } : o
        }),
      }
      host.engine.setData(host.scene.objects, host.scene.connections, host.scene.groups)
    },
    onObjectDoubleClick: noop,
    onGroupDoubleClick: noop,
    onConnectionDoubleClick: noop,
    onConnectionLabelMove: noop,
    onConnectionWaypointsChange: noop,
    onConnectionStart: noop,
    onConnectionEnd: noop,
    onConnectionAnchorMove: noop,
    onZoom: noop,
    onCommentClick: noop,
    onCommentMove: noop,
    onContextMenu: noop,
    onCopyApply: () => false,
    onExpandClick: noop,
  }, skin)
  host.engine.resize(WIDTH, HEIGHT)
  host.engine.setData(scene.objects, scene.connections, scene.groups)
  // The probe: time every render() the engine's own rAF loop performs.
  const probed = host.engine as unknown as { render: () => void }
  const original = probed.render.bind(host.engine)
  probed.render = () => {
    const t0 = performance.now()
    original()
    host.renders.push(performance.now() - t0)
  }
  // Animation-only frames (layered engines only) are timed into the same list,
  // tagged so `animFrames` can tell them apart from full renders.
  const animProbed = host.engine as unknown as { renderAnimationFrame?: () => void }
  if (animProbed.renderAnimationFrame) {
    const originalAnim = animProbed.renderAnimationFrame.bind(host.engine)
    animProbed.renderAnimationFrame = () => {
      const t0 = performance.now()
      originalAnim()
      host.renders.push(performance.now() - t0)
      host.animFrames += 1
    }
  }
  return host
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
async function frames(n: number) { for (let i = 0; i < n; i++) await frame() }

function client(host: Host, wx: number, wy: number) {
  const rect = host.canvas.getBoundingClientRect()
  const s = host.engine.worldToScreen(wx, wy)
  return { clientX: rect.left + s.x, clientY: rect.top + s.y }
}

function mouse(host: Host, type: string, at: { clientX: number; clientY: number }, button = 0) {
  host.canvas.dispatchEvent(new MouseEvent(type, {
    ...at, button, buttons: type === 'mouseup' ? 0 : 1 << (button === 1 ? 2 : 0), bubbles: true, cancelable: true,
  }))
}

function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0, max: 0, total: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]
  const total = xs.reduce((a, b) => a + b, 0)
  const r2 = (v: number) => Math.round(v * 100) / 100
  return { n: xs.length, mean: r2(total / xs.length), p50: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1]), total: r2(total) }
}

/** Run `steps` per-frame actions and report render cost + achieved frame pacing. */
async function measure(host: Host, steps: number, act: (i: number) => void) {
  await frames(10)
  host.renders = []
  host.animFrames = 0
  const stamps: number[] = []
  for (let i = 0; i < steps; i++) {
    act(i)
    stamps.push(await frame())
  }
  await frames(2)
  const intervals = stamps.slice(1).map((t, i) => t - stamps[i])
  return { render: stats(host.renders), animFrames: host.animFrames, frameInterval: stats(intervals) }
}

const SCENE_CENTER = { x: 10 * 320, y: 7 * 240 }

function centerAt(host: Host, scale: number) {
  host.engine.setViewport({ x: WIDTH / 2 - SCENE_CENTER.x * scale, y: HEIGHT / 2 - SCENE_CENTER.y * scale, scale })
}

const scenarios: Record<string, (host: Host) => Promise<unknown>> = {
  async pan(host) {
    centerAt(host, 1)
    const start = { clientX: 400, clientY: 300 }
    mouse(host, 'mousedown', start, 1)
    const out = await measure(host, 120, (i) => mouse(host, 'mousemove', { clientX: 400 - i * 6, clientY: 300 - i * 4 }, 1))
    mouse(host, 'mouseup', start, 1)
    return out
  },
  async panMid(host) {
    centerAt(host, 0.6)
    const start = { clientX: 400, clientY: 300 }
    mouse(host, 'mousedown', start, 1)
    const out = await measure(host, 120, (i) => mouse(host, 'mousemove', { clientX: 400 - i * 6, clientY: 300 - i * 4 }, 1))
    mouse(host, 'mouseup', start, 1)
    return out
  },
  async panFit(host) {
    host.engine.zoomToFit()
    const start = { clientX: 400, clientY: 300 }
    mouse(host, 'mousedown', start, 1)
    const out = await measure(host, 120, (i) => mouse(host, 'mousemove', { clientX: 400 - i * 3, clientY: 300 - i * 2 }, 1))
    mouse(host, 'mouseup', start, 1)
    return { ...out, scale: host.engine.getZoom() }
  },
  async zoom(host) {
    centerAt(host, 1)
    const rect = host.canvas.getBoundingClientRect()
    return measure(host, 120, (i) => {
      host.canvas.dispatchEvent(new WheelEvent('wheel', {
        clientX: rect.left + WIDTH / 2, clientY: rect.top + HEIGHT / 2,
        deltaY: i < 60 ? 40 : -40, bubbles: true, cancelable: true,
      }))
    })
  },
  async drag(host) {
    centerAt(host, 1)
    const target = host.scene.objects.find((o) => o.id === 'o-7-10')!
    const from = client(host, target.position.x + 40, target.position.y + 30)
    mouse(host, 'mousedown', from)
    const out = await measure(host, 120, (i) => mouse(host, 'mousemove', { clientX: from.clientX + i * 4, clientY: from.clientY + i * 3 }))
    host.renders = []
    const t0 = performance.now()
    mouse(host, 'mouseup', { clientX: from.clientX + 480, clientY: from.clientY + 360 })
    await frames(2)
    return { ...out, drop: { ms: Math.round((performance.now() - t0) * 100) / 100, firstRender: stats(host.renders) }, commits: host.commits }
  },
  async hover(host) {
    centerAt(host, 1)
    const rect = host.canvas.getBoundingClientRect()
    return measure(host, 120, (i) => mouse(host, 'mousemove', { clientX: rect.left + 100 + i * 11, clientY: rect.top + 150 + (i % 40) * 15 }))
  },
  async idleSelected(host) {
    centerAt(host, 1)
    host.engine.setSelectedItems([{ type: 'object', id: 'o-7-10' }])
    return measure(host, 120, () => {})
  },
  async idle(host) {
    centerAt(host, 1)
    host.engine.setSelectedItems([])
    return measure(host, 120, () => {})
  },
}

// --- pixel comparison ----------------------------------------------------------

interface ShotState {
  name: string
  scale: number | 'fit'
  select?: string
  hover?: string
  /** Connection highlight animation style while something is selected. */
  style?: ConnectionHighlightStyle
  /** Capture an animation-only frame (layers re-composited) after the full one. */
  animFrame?: boolean
}

const HIGHLIGHT_STYLES: ConnectionHighlightStyle[] = [
  'traveling-dot', 'gradient-flow', 'lightning', 'pulse', 'sparkle', 'energy-beam', 'neon-dash', 'strands', 'electric',
]

const SHOT_STATES: ShotState[] = [
  { name: 'fit', scale: 'fit' },
  { name: 'z0.5', scale: 0.5 },
  { name: 'z1', scale: 1 },
  { name: 'z1.37', scale: 1.37 },
  { name: 'z2.6', scale: 2.6 },
  { name: 'selected', scale: 1, select: 'o-7-10' },
  { name: 'hover', scale: 1, hover: 'o-7-11' },
  ...HIGHLIGHT_STYLES.flatMap((style): ShotState[] => [
    { name: `sel-${style}`, scale: 0.8, select: 'o-7-10', style },
    { name: `sel-${style}-anim`, scale: 0.8, select: 'o-7-10', style, animFrame: true },
  ]),
]

const FIXED_NOW = 1_800_000_000_123

function renderShot(Engine: EngineCtor, container: HTMLElement, skin: SkinConfig, state: ShotState): HTMLCanvasElement {
  const host = makeHost(Engine, container, skin, buildScene())
  if (state.scale === 'fit') host.engine.zoomToFit()
  else centerAt(host, state.scale)
  if (state.style) host.engine.setConnectionHighlightStyle(state.style)
  if (state.select) host.engine.setSelectedItems([{ type: 'object', id: state.select }])
  if (state.hover) {
    const o = host.scene.objects.find((x) => x.id === state.hover)!
    mouse(host, 'mousemove', client(host, o.position.x + o.size.width / 2, o.position.y + o.size.height / 2))
  }
  const priv = host.engine as unknown as { render: () => void; renderAnimationFrame?: () => void }
  priv.render()
  if (state.animFrame) {
    // The baseline has no animation-only path: it repaints the whole scene.
    if (priv.renderAnimationFrame) priv.renderAnimationFrame()
    else priv.render()
  }
  host.engine.destroy()
  return host.canvas
}

function diff(a: HTMLCanvasElement, b: HTMLCanvasElement) {
  const da = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data
  const db = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data
  let any = 0, over8 = 0, over32 = 0, max = 0
  const out = document.createElement('canvas')
  out.width = a.width
  out.height = a.height
  const octx = out.getContext('2d')!
  const img = octx.createImageData(a.width, a.height)
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]))
    if (d > 0) any++
    if (d > 8) over8++
    if (d > 32) over32++
    if (d > max) max = d
    const v = Math.min(255, d * 4)
    img.data[i] = v; img.data[i + 1] = d > 0 ? 0 : 255; img.data[i + 2] = 0; img.data[i + 3] = d > 0 ? 255 : 40
  }
  octx.putImageData(img, 0, 0)
  return { pixels: da.length / 4, any, over8, over32, max, diffImage: out }
}

async function ensureFonts() {
  await Promise.all(['400', '500', '600', '700', 'bold'].map((w) => document.fonts.load(`${w} 13px Inter`)))
  await document.fonts.load('10px "Press Start 2P"')
  await document.fonts.ready
}

// --- grid micro-bench ----------------------------------------------------------------

type GridVariant = (ctx: CanvasRenderingContext2D, xs: number[], ys: number[], r: number) => void

const GRID_VARIANTS: Record<string, GridVariant> = {
  perDot(ctx, xs, ys, r) {
    for (const x of xs) for (const y of ys) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill() }
  },
  onePath(ctx, xs, ys, r) {
    ctx.beginPath()
    for (const x of xs) for (const y of ys) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2) }
    ctx.fill()
  },
  path2d(ctx, xs, ys, r) {
    const p = new Path2D()
    for (const x of xs) for (const y of ys) { p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2) }
    ctx.fill(p)
  },
  rects(ctx, xs, ys, r) {
    for (const x of xs) for (const y of ys) ctx.fillRect(x - r, y - r, 2 * r, 2 * r)
  },
}

/**
 * Cost of drawing the dot grid alone, GPU raster included: N frames of
 * clear + background + grid at a drifting offset (a pan), then ONE synchronous
 * 1-pixel readback that waits for every queued draw. Total / N per frame.
 */
async function gridBench(scale: number, frameCount = 120) {
  const dpr = window.devicePixelRatio
  const out: Record<string, number> = {}
  for (const [name, draw] of Object.entries(GRID_VARIANTS)) {
    const c = document.createElement('canvas')
    c.width = WIDTH * dpr
    c.height = HEIGHT * dpr
    const ctx = c.getContext('2d')!
    let spacing = 20
    while (spacing * scale < 12) spacing *= 2
    const r = Math.min(2.5, Math.max(0.5, 1.5 / scale))
    const run = (n: number) => {
      for (let f = 0; f < n; f++) {
        const vx = -f * 6, vy = -f * 4
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, WIDTH, HEIGHT)
        ctx.fillStyle = '#F8FAFC'
        ctx.fillRect(0, 0, WIDTH, HEIGHT)
        ctx.translate(vx, vy)
        ctx.scale(scale, scale)
        const x0 = Math.floor(-vx / scale / spacing), x1 = Math.floor((WIDTH - vx) / scale / spacing)
        const y0 = Math.floor(-vy / scale / spacing), y1 = Math.floor((HEIGHT - vy) / scale / spacing)
        const xs: number[] = [], ys: number[] = []
        for (let i = x0; i <= x1; i++) xs.push(i * spacing)
        for (let i = y0; i <= y1; i++) ys.push(i * spacing)
        ctx.fillStyle = '#CBD5E1'
        draw(ctx, xs, ys, r)
      }
      ctx.getImageData(0, 0, 1, 1)
    }
    run(5) // warm-up
    await frame()
    const t0 = performance.now()
    run(frameCount)
    out[name] = Math.round(((performance.now() - t0) / frameCount) * 100) / 100
  }
  return out
}

function withoutShadows(skin: SkinConfig): SkinConfig {
  const objects = Object.fromEntries(Object.entries(skin.objects).map(([type, s]) => [type, { ...s, shadowBlur: 0, shadowBlurHover: 0 }]))
  return { ...skin, objects: objects as SkinConfig['objects'], selection: { ...skin.selection, shadowBlur: 0 } }
}

/**
 * Full-frame cost, GPU raster included: `frameCount` synchronous render() calls
 * (panning by a few pixels each when `pan`), then ONE 1-pixel readback that
 * waits for the GPU to finish everything queued. `fast` forces the engine's
 * interaction mode (what a pan/drag/wheel frame gets in the app).
 */
async function frameBench(kind: EngineKind, opts: {
  scale?: number; fast?: boolean; select?: string; pan?: boolean; animate?: boolean; perspective?: boolean
  skinId?: string; noShadow?: boolean; frameCount?: number
} = {}) {
  await ensureFonts()
  const Engine = await loadEngine(kind)
  stage.replaceChildren()
  const skin = SKINS[opts.skinId ?? 'default']
  const host = makeHost(Engine, stage, opts.noShadow ? withoutShadows(skin) : skin, buildScene())
  const scale = opts.scale ?? 1
  centerAt(host, scale)
  if (opts.select) host.engine.setSelectedItems([{ type: 'object', id: opts.select }])
  if (opts.perspective) {
    // A managed perspective with a hidden facet: every visibility query resolves it.
    host.engine.setBottomTab('technology')
    host.engine.setManagedPerspectiveInteractions('technology', null, [], null, ['tech:none'])
  }
  const priv = host.engine as unknown as {
    render: () => void; renderAnimationFrame?: () => void; isInteracting: boolean; animLayersValid?: boolean
  }
  await frames(5)
  const n = opts.frameCount ?? 120
  const base = host.engine.getViewport()
  const ctx = host.canvas.getContext('2d')!
  // `animate`: what the engine's own loop does on an idle selection — one full
  // render, then animation-only frames while the layers hold (a baseline engine
  // has no such path and repaints everything every frame).
  const run = (count: number) => {
    if (opts.animate) priv.render()
    for (let i = 0; i < count; i++) {
      priv.isInteracting = !!opts.fast
      if (opts.pan) host.engine.setViewport({ ...base, x: base.x - i * 6, y: base.y - i * 4 })
      if (opts.animate && priv.renderAnimationFrame && priv.animLayersValid) priv.renderAnimationFrame()
      else priv.render()
    }
    ctx.getImageData(0, 0, 1, 1)
  }
  run(5)
  const t0 = performance.now()
  run(n)
  const perFrame = (performance.now() - t0) / n
  host.renders = []
  priv.isInteracting = false
  host.engine.destroy()
  return Math.round(perFrame * 100) / 100
}

// --- interaction-handler micro-bench -------------------------------------------------

/**
 * Synchronous cost of the engine's own mouse handlers, without painting: each
 * event is dispatched and timed on its own (`dispatchEvent` runs the listener
 * synchronously; the paint it schedules is a separate rAF and not counted).
 * `cols × rows` scales the scene so an O(scene) handler shows as such.
 */
async function handlerBench(kind: EngineKind, opts: {
  cols?: number; rows?: number; scale?: number; mode: 'hoverEmpty' | 'hoverShapes' | 'groupDrag' | 'drop'
  events?: number
}) {
  await ensureFonts()
  const Engine = await loadEngine(kind)
  stage.replaceChildren()
  const scene = buildScene(opts.cols ?? 20, opts.rows ?? 15)
  const host = makeHost(Engine, stage, defaultSkin, scene)
  centerAt(host, opts.scale ?? 1)
  await frames(3)
  const n = opts.events ?? 200
  const times: number[] = []
  const timed = (fn: () => void) => { const t0 = performance.now(); fn(); times.push(performance.now() - t0) }
  if (opts.mode === 'hoverEmpty' || opts.mode === 'hoverShapes') {
    // Gap between cards (320×240 pitch, cards ≤ 220×150) vs the card centres.
    const pts: Array<{ clientX: number; clientY: number }> = []
    for (let i = 0; i < n; i++) {
      const c = 5 + (i % 10), r = 3 + (Math.floor(i / 10) % 8)
      pts.push(opts.mode === 'hoverEmpty'
        ? client(host, c * 320 + 270, r * 240 + 195 + (i % 3) * 7)
        : client(host, c * 320 + 100, r * 240 + 60 + (i % 3) * 7))
    }
    for (const p of pts) timed(() => mouse(host, 'mousemove', p))
  } else if (opts.mode === 'groupDrag') {
    // g-0 spans cols 1-3, rows 1-3; grab its header band, above the first card
    // and clear of every connection.
    host.engine.setViewport({ x: 0, y: 0, scale: opts.scale ?? 1 })
    const start = client(host, 1 * 320 + 10, 1 * 240 - 40)
    mouse(host, 'mousedown', start)
    for (let i = 1; i <= n; i++) timed(() => mouse(host, 'mousemove', { clientX: start.clientX + i, clientY: start.clientY + i }))
    mouse(host, 'mouseup', start)
    const dragged = host.engine.getGroupBoundsById('g-0')
    if (!dragged || host.commits === 0) throw new Error('groupDrag did not drag the group')
  } else {
    // drop: the mouseup that commits a shape drag, i.e. commit + setData round trip.
    for (let i = 0; i < n; i++) {
      const target = host.scene.objects[(i * 7) % host.scene.objects.length]
      host.engine.setViewport({ x: WIDTH / 2 - target.position.x, y: HEIGHT / 2 - target.position.y, scale: 1 })
      const at = client(host, target.position.x + 30, target.position.y + 30)
      mouse(host, 'mousedown', at)
      mouse(host, 'mousemove', { clientX: at.clientX + 5, clientY: at.clientY + 5 })
      timed(() => mouse(host, 'mouseup', { clientX: at.clientX + 5, clientY: at.clientY + 5 }))
    }
  }
  host.engine.destroy()
  return { ...stats(times), objects: scene.objects.length, connections: scene.connections.length }
}

/**
 * Differential check of hover resolution: the same cursor path is replayed on
 * the baseline and current engines and every resulting hover state compared.
 * The path is a fine raster (every `step` world units) over a region dense in
 * edges, anchors, labels and gaps, at several zooms.
 */
async function hoverEquivalence(opts: { scales?: number[]; step?: number } = {}) {
  await ensureFonts()
  const Baseline = await loadEngine('baseline')
  const scratch = document.createElement('div')
  scratch.style.cssText = `position:absolute;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px`
  document.body.appendChild(scratch)
  const keys = ['hoveredId', 'hoveredGroupId', 'hoveredAnchorIndex', 'hoveredLabelConnId', 'hoveredConnectionId',
    'hoveredLinkId', 'hoveredExpandId', 'hoveredGroupExpandId', 'hoveredGroupNavigateId'] as const
  let compared = 0
  const mismatches: string[] = []
  const nonNull: Record<string, number> = {}
  try {
    for (const scale of opts.scales ?? [0.5, 1, 2]) {
      const a = makeHost(Baseline, scratch, defaultSkin, buildScene())
      const b = makeHost(CanvasEngine, scratch, defaultSkin, buildScene())
      for (const h of [a, b]) centerAt(h, scale)
      const step = opts.step ?? 6
      // Rows 6-8, cols 8-12 hold a group edge (g-1), labels, curved and long edges.
      for (let wy = 6 * 240 - 60; wy < 9 * 240; wy += step) {
        for (let wx = 8 * 320 - 60; wx < 13 * 320; wx += step) {
          for (const h of [a, b]) mouse(h, 'mousemove', client(h, wx, wy))
          const sa = a.engine as unknown as Record<string, unknown>
          const sb = b.engine as unknown as Record<string, unknown>
          compared++
          for (const k of keys) {
            if (sa[k] !== null && sa[k] !== undefined) nonNull[k] = (nonNull[k] ?? 0) + 1
            if (sa[k] !== sb[k] && mismatches.length < 20) mismatches.push(`z${scale} (${wx},${wy}) ${k}: ${String(sa[k])} vs ${String(sb[k])}`)
          }
          if (a.canvas.style.cursor !== b.canvas.style.cursor && mismatches.length < 20) {
            mismatches.push(`z${scale} (${wx},${wy}) cursor`)
          }
        }
      }
      a.engine.destroy()
      b.engine.destroy()
    }
  } finally {
    scratch.remove()
  }
  return { compared, mismatches, nonNull }
}

// --- API -------------------------------------------------------------------------

const status = document.getElementById('status')!
const stage = document.getElementById('stage')!
const compare = document.getElementById('compare')!

const api = {
  /** Fresh engine on the stage, then one scenario. Reload the page between arms. */
  async run(kind: EngineKind, scenario: string, skinId = 'default') {
    await ensureFonts()
    const Engine = await loadEngine(kind)
    stage.replaceChildren()
    const host = makeHost(Engine, stage, SKINS[skinId], buildScene())
    await frames(20)
    const result = await scenarios[scenario](host)
    host.engine.destroy()
    return { kind, scenario, skinId, dpr: window.devicePixelRatio, visibility: document.visibilityState, ...(result as object) }
  },
  async runAll(kind: EngineKind, skinId = 'default') {
    const out: Record<string, unknown> = {}
    for (const name of Object.keys(scenarios)) out[name] = await api.run(kind, name, skinId)
    return out
  },
  /** Render every SHOT_STATE on both engines with a frozen clock and diff them. */
  async pixelCompare(skinIds: string[] = Object.keys(SKINS), show?: string) {
    await ensureFonts()
    const Baseline = await loadEngine('baseline')
    const realNow = Date.now
    Date.now = () => FIXED_NOW
    const scratch = document.createElement('div')
    scratch.style.cssText = `position:absolute;left:-${WIDTH * 2}px;top:0;width:${WIDTH}px;height:${HEIGHT}px`
    document.body.appendChild(scratch)
    const results: Record<string, unknown> = {}
    compare.replaceChildren()
    try {
      for (const skinId of skinIds) {
        for (const state of SHOT_STATES) {
          scratch.replaceChildren()
          const a = renderShot(Baseline, scratch, SKINS[skinId], state)
          const b = renderShot(CanvasEngine, scratch, SKINS[skinId], state)
          const d = diff(a, b)
          results[`${skinId}/${state.name}`] = { any: d.any, over8: d.over8, over32: d.over32, max: d.max }
          if (show === `${skinId}/${state.name}`) {
            for (const [label, c] of [['baseline', a], ['current', b], ['diff', d.diffImage]] as const) {
              const fig = document.createElement('figure')
              const img = document.createElement('img')
              img.src = c.toDataURL()
              const cap = document.createElement('figcaption')
              cap.textContent = `${show} — ${label}`
              fig.append(img, cap)
              compare.append(fig)
            }
          }
        }
      }
    } finally {
      Date.now = realNow
      scratch.remove()
    }
    return results
  },
  /** Show one engine at one state on the stage, for a real screenshot. */
  async show(kind: EngineKind, skinId = 'default', stateName = 'z1') {
    await ensureFonts()
    const Engine = await loadEngine(kind)
    stage.replaceChildren()
    const state = SHOT_STATES.find((s) => s.name === stateName)!
    const host = makeHost(Engine, stage, SKINS[skinId], buildScene())
    if (state.scale === 'fit') host.engine.zoomToFit()
    else centerAt(host, state.scale)
    if (state.select) host.engine.setSelectedItems([{ type: 'object', id: state.select }])
    if (state.hover) {
      const o = host.scene.objects.find((x) => x.id === state.hover)!
      mouse(host, 'mousemove', client(host, o.position.x + o.size.width / 2, o.position.y + o.size.height / 2))
    }
    return { kind, skinId, stateName }
  },
  gridBench,
  frameBench,
  handlerBench,
  hoverEquivalence,
  skins: Object.keys(SKINS),
  scenarios: Object.keys(scenarios),
  hasBaseline: Object.keys(baselineModules).length > 0,
}

;(window as unknown as { __bench: typeof api }).__bench = api
status.textContent = `ready — baseline ${api.hasBaseline ? 'available' : 'absent'}; scenarios: ${api.scenarios.join(', ')}`
