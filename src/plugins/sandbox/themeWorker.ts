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

/// <reference lib="webworker" />
import { createRng } from '../sdk/rng'
import { defineTheme, type ThemePlugin, type RenderContext, type Seam, type XY } from '../sdk/contract'
import type { FrameSnapshot, HostToWorker, SnapshotConnection, SnapshotGroup, SnapshotObject, WorkerToHost } from './snapshot'
import { compileTheme } from './compile'

/**
 * Sandbox worker for community theme plugins. Runs untrusted theme
 * render code against a transferred OffscreenCanvas overlay, decoupled from the
 * main thread. SECURITY: network/storage globals are neutralized before any
 * untrusted code runs (see hardenGlobals) — this is the primary boundary for a
 * dedicated worker. A blob-loaded worker + worker-scoped CSP is the intended
 * deployment hardening on top (not `connect-src 'none'` on the document, which
 * would break the app's own sync/HMR).
 */

const ctxPost = (msg: WorkerToHost) => (self as DedicatedWorkerGlobalScope).postMessage(msg)

// --- Security: neutralize egress + storage + nested execution BEFORE theme runs ---
function hardenGlobals() {
  const blocked = (api: string) => () => {
    ctxPost({ type: 'blocked', api })
    throw new Error(`${api} is blocked in theme sandbox`)
  }
  const g = self as unknown as Record<string, unknown>
  const stubNames = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
    'Worker', 'SharedWorker', 'BroadcastChannel', 'RTCPeerConnection',
  ]
  for (const name of stubNames) {
    try {
      const stub = blocked(name)
      Object.defineProperty(g, name, { value: stub, writable: false, configurable: false })
    } catch { /* already locked */ }
  }
  // Storage accessors (getters on the global) → throw on access.
  for (const name of ['indexedDB', 'caches', 'localStorage', 'sessionStorage']) {
    try {
      Object.defineProperty(g, name, {
        get: blocked(name) as () => never,
        configurable: false,
      })
    } catch { /* not present / locked */ }
  }
  try {
    const nav = (self as unknown as { navigator?: Record<string, unknown> }).navigator
    if (nav && 'sendBeacon' in nav) nav.sendBeacon = blocked('sendBeacon')
  } catch { /* ignore */ }
  // Freeze the prototypes most likely used to break out.
  for (const proto of [Object.prototype, Array.prototype, Function.prototype]) {
    try { Object.freeze(proto) } catch { /* ignore */ }
  }
}

hardenGlobals()

// --- Theme execution state ---
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let plugin: ThemePlugin | null = null
let snapshot: FrameSnapshot | null = null
let dpr = 1
let cssW = 0
let cssH = 0
let frameCount = 0
let rafId = 0

/** Compile + instantiate the untrusted theme. The single SDK capability
 *  (`defineTheme`) is injected as a parameter; no module loader is exposed, so
 *  the code cannot import anything else. (TS→JS transform via Sucrase is added in
 *  the next slice; for now the code is authored as a JS function body.) */
function loadTheme(code: string): ThemePlugin {
  const body = compileTheme(code)
   
  const factory = new Function('defineTheme', `"use strict";\n${body}`)
  const result = factory(defineTheme)
  if (!result || typeof result !== 'object' || !result.meta) {
    throw new Error('theme did not return a valid plugin (use `return defineTheme({...})`)')
  }
  return result as ThemePlugin
}

function listSeams(p: ThemePlugin): Seam[] {
  const all: Seam[] = ['background', 'grid', 'group', 'connectionLine', 'object', 'connectionOverlay', 'selection', 'screenOverlay']
  return all.filter((s) => !!p[s])
}

function makeContext(space: 'world' | 'screen', snap: FrameSnapshot, p: ThemePlugin): RenderContext {
  const vp = snap.viewport
  return {
    space,
    viewport: vp,
    dpr: snap.dpr,
    canvas: snap.canvas,
    timeMs: snap.timeMs,
    fastMode: snap.fastMode,
    anim: {},
    style: (p.style?.renderStyle ?? {}) as RenderContext['style'],
    worldToScreen: (q: XY) => ({ x: q.x * vp.scale + vp.x, y: q.y * vp.scale + vp.y }),
    screenToWorld: (q: XY) => ({ x: (q.x - vp.x) / vp.scale, y: (q.y - vp.y) / vp.scale }),
    rng: createRng,
  }
}

function objectArgs(rc: RenderContext, o: SnapshotObject) {
  return {
    ctx: rc,
    id: o.id,
    type: o.type,
    name: o.name,
    geom: { x: o.x, y: o.y, w: o.w, h: o.h, cornerRadius: o.cornerRadius, cx: o.x + o.w / 2, cy: o.y + o.h / 2 },
    state: { selected: o.selected, hovered: o.hovered, connectedToHover: false, focused: false, external: o.external, alpha: o.alpha },
    fill: '',
    stroke: '',
    strokeWidth: 0,
  }
}

function groupArgs(rc: RenderContext, g: SnapshotGroup) {
  return {
    ctx: rc,
    id: g.id,
    isParentWrapper: g.isParentWrapper,
    geom: { x: g.x, y: g.y, w: g.w, h: g.h, cornerRadius: g.cornerRadius },
    state: { selected: g.selected },
    fill: '',
    stroke: '',
    fillAlpha: g.isParentWrapper ? 1 : 0.3,
    strokeAlpha: g.isParentWrapper ? 1 : (g.selected ? 0.9 : 0.5),
    strokeWidth: 0,
    customColors: false,
  }
}

function bezierPoint(c: SnapshotConnection, t: number): XY {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const cc = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * c.fromX + b * c.cp1x + cc * c.cp2x + d * c.toX,
    y: a * c.fromY + b * c.cp1y + cc * c.cp2y + d * c.toY,
  }
}

function connectionArgs(rc: RenderContext, c: SnapshotConnection) {
  return {
    ctx: rc,
    id: c.id,
    type: c.type,
    state: { hovered: c.hovered, highlighted: c.highlighted, focused: false, alpha: c.alpha, flowState: 'normal' as const },
    stroke: '',
    strokeWidth: 0,
    from: { x: c.fromEdgeX, y: c.fromEdgeY },
    to: { x: c.toEdgeX, y: c.toEdgeY },
    bezierAt: (t: number) => bezierPoint(c, t),
  }
}

function safeHook(fn: () => void) {
  try {
    fn()
  } catch (err) {
    ctxPost({ type: 'error', message: `hook threw: ${(err as Error)?.message ?? err}` })
  }
}

/** Render one frame of a theme into a 2D context. Shared by the live overlay
 *  loop and the one-shot thumbnail renderer. */
function drawScene(
  ctx2d: OffscreenCanvasRenderingContext2D,
  p: ThemePlugin,
  snap: FrameSnapshot,
  dprLocal: number,
  w: number,
  h: number,
  fillBackground = false,
) {
  const draw = ctx2d as unknown as import('../sdk/contract').Draw
  ctx2d.setTransform(dprLocal, 0, 0, dprLocal, 0, 0)
  ctx2d.clearRect(0, 0, w, h)

  // Thumbnails have no base canvas underneath, so paint the theme's backdrop.
  if (fillBackground) {
    ctx2d.fillStyle = snap.bg
    ctx2d.fillRect(0, 0, w, h)
  }

  if (p.background) {
    const rc = makeContext('screen', snap, p)
    safeHook(() => p.background!.draw(draw, { ctx: rc, width: snap.canvas.width, height: snap.canvas.height, bg: snap.bg }))
  }

  // World-space seams (draw order matches the engine: groups → connections → objects)
  ctx2d.translate(snap.viewport.x, snap.viewport.y)
  ctx2d.scale(snap.viewport.scale, snap.viewport.scale)
  const worldCtx = makeContext('world', snap, p)
  if (p.group) for (const g of snap.groups) safeHook(() => p.group!.draw(draw, groupArgs(worldCtx, g)))
  if (p.connectionLine) for (const c of snap.connections) safeHook(() => p.connectionLine!.draw(draw, connectionArgs(worldCtx, c)))
  if (p.object) for (const o of snap.objects) safeHook(() => p.object!.draw(draw, objectArgs(worldCtx, o)))
  if (p.screenOverlay) {
    ctx2d.setTransform(dprLocal, 0, 0, dprLocal, 0, 0)
    const rc = makeContext('screen', snap, p)
    safeHook(() => p.screenOverlay!.draw(draw, { ctx: rc }))
  }
}

function renderFrame() {
  rafId = self.requestAnimationFrame(renderFrame)
  if (!ctx || !plugin || !snapshot) return
  drawScene(ctx, plugin, snapshot, dpr, cssW, cssH)
  frameCount++
  ctxPost({ type: 'tick', frame: frameCount })
}

/** 3D-spec mode: run the theme's object3d/floor3d PURE-DATA hooks
 * for a batch of nodes + the floor. Hook failures skip that item (the host
 * falls back to the derived look); results return RAW — sanitization happens
 * on the trusted side. */
function runSpec3d(msg: Extract<HostToWorker, { type: 'spec3d' }>) {
  const objects: Record<string, unknown> = {}
  let floor: unknown = null
  if (plugin) {
    let anim: Record<string, number> = {}
    try {
      anim = plugin.animate?.(msg.timeMs) ?? {}
    } catch { /* animate threw — hooks get an empty bag */ }
    if (plugin.object3d) {
      for (const o of msg.objects) {
        try {
          objects[o.id] = plugin.object3d({ ...o, type: o.type as never, dark: msg.dark, anim, rng: createRng })
        } catch { /* this node keeps the derived look */ }
      }
    }
    if (plugin.floor3d && msg.floor) {
      try {
        floor = plugin.floor3d({ ...msg.floor, anim, rng: createRng })
      } catch { /* derived floor */ }
    }
  }
  ctxPost({ type: 'spec3d', requestId: msg.requestId, objects, floor })
}

self.onmessage = (e: MessageEvent<HostToWorker>) => {
  const msg = e.data
  if (msg.type === 'init3d') {
    // spec-only mode: compile the theme, no overlay canvas, no render loop
    try {
      plugin = loadTheme(msg.code)
      ctxPost({ type: 'ready3d', hasObject3d: !!plugin.object3d, hasFloor3d: !!plugin.floor3d })
    } catch (err) {
      ctxPost({ type: 'error', message: (err as Error)?.message ?? String(err) })
    }
  } else if (msg.type === 'spec3d') {
    runSpec3d(msg)
  } else if (msg.type === 'init') {
    try {
      canvas = msg.canvas
      ctx = canvas.getContext('2d')
      plugin = loadTheme(msg.code)
      ctxPost({ type: 'ready', seams: listSeams(plugin) })
      rafId = self.requestAnimationFrame(renderFrame)
    } catch (err) {
      ctxPost({ type: 'error', message: (err as Error)?.message ?? String(err) })
    }
  } else if (msg.type === 'frame') {
    snapshot = msg.snapshot
    dpr = msg.snapshot.dpr
    cssW = msg.snapshot.canvas.width
    cssH = msg.snapshot.canvas.height
    if (canvas && (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr))) {
      canvas.width = Math.round(cssW * dpr)
      canvas.height = Math.round(cssH * dpr)
    }
  } else if (msg.type === 'thumbnail') {
    // One-shot: compile + render a single frame to an offscreen canvas the
    // worker owns, then hand back an ImageBitmap (transferred). Used by the shop.
    try {
      const p = loadTheme(msg.code)
      const oc = new OffscreenCanvas(Math.round(msg.width * msg.dpr), Math.round(msg.height * msg.dpr))
      const octx = oc.getContext('2d')
      if (!octx) throw new Error('no 2d context')
      drawScene(octx, p, msg.snapshot, msg.dpr, msg.width, msg.height, true)
      const bitmap = oc.transferToImageBitmap()
      ;(self as DedicatedWorkerGlobalScope).postMessage({ type: 'thumbnail', bitmap }, [bitmap])
    } catch (err) {
      ctxPost({ type: 'error', message: (err as Error)?.message ?? String(err) })
    }
  } else if (msg.type === 'dispose') {
    if (rafId) self.cancelAnimationFrame(rafId)
    rafId = 0
    plugin = null
    snapshot = null
  }
}
