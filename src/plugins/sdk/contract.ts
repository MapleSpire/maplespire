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

import type { SkinConfig, SkinRenderMode } from '../../skins/types'
import type { C4Type } from '../../types'
import type { FloorSpec3D, NodeSpec3D } from '../../canvas3d/specs'

/**
 * Theme SDK contract. One contract, two executors:
 *  - official themes run on the main thread (trusted, fast) — `Draw` is the live
 *    CanvasRenderingContext2D (which is a structural superset of `Draw`);
 *  - community themes run in a hardened worker against an
 *    OffscreenCanvas, same method names.
 *
 * The engine never imports a theme — it talks to a ThemeRuntime via the bridge.
 * See docs/creating-theme-plugins.md.
 */

export type XY = { x: number; y: number }
export type Space = 'world' | 'screen'

/** Sampled animation outputs for the current frame (e.g. cyberpunk glow/glitch). */
export type AnimBag = Readonly<Record<string, number>>

/** Resolved render-style params handed to hooks. Reuses the existing typed shape. */
export type ResolvedRenderStyle = SkinConfig['renderStyle']

/**
 * Opaque gradient handle. On the trusted tier it wraps a real CanvasGradient; on
 * the community tier it is materialized worker-side. Structurally compatible with
 * what `fillStyle`/`strokeStyle` accept on both surfaces.
 */
export interface GradientHandle {
  addColorStop(offset: number, color: string): void
}

/**
 * The drawing surface a theme hook receives. Method/property names match
 * CanvasRenderingContext2D 1:1 so the live ctx satisfies this interface directly
 * on the trusted tier (no wrapper, byte-identical output), and an OffscreenCanvas
 * ctx satisfies it on the community tier.
 */
export interface Draw {
  save(): void
  restore(): void
  beginPath(): void
  closePath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw?: boolean): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void
  rect(x: number, y: number, w: number, h: number): void
  roundRect(x: number, y: number, w: number, h: number, radii?: number | number[]): void
  fill(): void
  stroke(): void
  clip(): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number, maxWidth?: number): void
  strokeText(text: string, x: number, y: number, maxWidth?: number): void
  measureText(text: string): { width: number }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientHandle
  translate(x: number, y: number): void
  rotate(angle: number): void
  scale(x: number, y: number): void
  setLineDash(segments: number[]): void

  // mutable style state (forwarded 1:1 to the underlying ctx)
  fillStyle: string | GradientHandle
  strokeStyle: string | GradientHandle
  lineWidth: number
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  miterLimit: number
  globalAlpha: number
  globalCompositeOperation: GlobalCompositeOperation
  shadowColor: string
  shadowBlur: number
  shadowOffsetX: number
  shadowOffsetY: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
}

/** Per-frame context handed to every hook. */
export interface RenderContext {
  readonly space: Space
  readonly viewport: { x: number; y: number; scale: number }
  readonly dpr: number
  /** CSS px (dpr already applied to the backing store). */
  readonly canvas: { width: number; height: number }
  /** Monotonic frame timestamp; replaces ad-hoc Date.now() in effect code. */
  readonly timeMs: number
  /** True while the user is interacting (pan/zoom/drag). Heavy passes MUST no-op. */
  readonly fastMode: boolean
  /** Animation values sampled once this frame from the active theme's animate(). */
  readonly anim: AnimBag
  readonly style: ResolvedRenderStyle
  worldToScreen(p: XY): XY
  screenToWorld(p: XY): XY
  /** Engine-canonical seeded PRNG (cyrb128+sfc32). Same algorithm everywhere. */
  rng(seedKey: string): () => number
}

// --- Per-item args (resolved by the engine, never recomputed by the theme) ---

export interface ObjectGeom { x: number; y: number; w: number; h: number; cornerRadius: number; cx: number; cy: number }
export interface ObjectState { selected: boolean; hovered: boolean; connectedToHover: boolean; focused: boolean; external: boolean; alpha: number }
export interface ObjectArgs {
  ctx: RenderContext
  id: string
  type: C4Type
  name: string
  geom: ObjectGeom
  state: ObjectState
  fill: string
  stroke: string
  strokeWidth: number
}

export interface ConnectionArgs {
  ctx: RenderContext
  id: string
  type: 'solid' | 'dashed' | 'dotted'
  state: { hovered: boolean; highlighted: boolean; focused: boolean; alpha: number; flowState: 'hidden' | 'dim' | 'active' | 'normal' }
  stroke: string
  strokeWidth: number
  /** Source object edge point (where the connection attaches). */
  from: XY
  /** Target object edge point — place arrowheads here so they reach the shape. */
  to: XY
  bezierAt(t: number): XY
}

export interface GroupArgs {
  ctx: RenderContext
  id: string
  /** Parent-wrapper groups (drawn around an expanded object) vs standard groups. */
  isParentWrapper: boolean
  geom: { x: number; y: number; w: number; h: number; cornerRadius: number }
  state: { selected: boolean }
  /** Engine-resolved fill color (parent-wrapper fill or the group's own color). */
  fill: string
  /** Engine-resolved stroke color. */
  stroke: string
  /** Resolved fill opacity (0 when the group's background is transparent). */
  fillAlpha: number
  /** Resolved stroke opacity (selected vs not). */
  strokeAlpha: number
  /** User border width in px; 0 means "use the theme's natural width". */
  strokeWidth: number
  /** True when the user set a custom background or border color on the group. */
  customColors: boolean
}

// --- 3D board spec-builder args — pure data in, pure data out. ---
// Unlike the 2D seams there is NO Draw surface: hooks return a NodeSpec3D /
// FloorSpec3D (see src/canvas3d/specs.ts) and the WebGL engine applies it.
// Every result passes the specs.ts sanitizers regardless of trust tier.

export interface Object3dArgs {
  id: string
  type: C4Type
  name: string
  /** Resolved card fill (external/selected already applied). */
  fill: string
  selected: boolean
  external: boolean
  /** Whether the resolved skin reads as dark (per-appearance packs branch here). */
  dark: boolean
  /** World-px lift of the node's base and top face (platform + extrusion). */
  zBase: number
  zTop: number
  /** Animation values sampled from the theme's own animate() (may be empty). */
  anim: AnimBag
  /** Engine-canonical seeded PRNG — same algorithm as the 2D RenderContext. */
  rng(seedKey: string): () => number
}

export interface Floor3dArgs {
  /** Content bounds the board will wrap (world px). */
  bounds: { x: number; y: number; w: number; h: number }
  /** Whether the resolved skin reads as dark. */
  dark: boolean
  anim: AnimBag
  rng(seedKey: string): () => number
}

export interface BackgroundArgs { ctx: RenderContext; width: number; height: number; bg: string }
export interface GridArgs { ctx: RenderContext }
export interface SelectionArgs { ctx: RenderContext; target: ObjectArgs | GroupArgs }
export interface OverlayArgs { ctx: RenderContext }

// --- Hooks + lifecycle ---

export type HookMode = 'pre' | 'post' | 'replace'
// pre  = draw before the engine default (augment under)
// post = draw after the engine default (augment over)
// replace = own the primitive; engine SKIPS its default for this item
export interface Hook<A> {
  mode: HookMode
  draw(d: Draw, args: A): void
}

/** Safe host surface handed to onActivate (no DOM / network / storage). */
export interface ThemeHost {
  requestRender(): void
  rng(seedKey: string): () => number
  readonly selectionActive: boolean
  /** Create + return a fresh overlay canvas for a community theme's worker. */
  acquireOverlayCanvas(): HTMLCanvasElement
  /** Remove the overlay canvas (on deactivate / failure). */
  releaseOverlayCanvas(): void
  /** Revert to the default theme (on community theme failure). */
  revertToDefault(): void
  /** Surface a user-facing notice (e.g. unsupported browser / theme failure). */
  notify(message: string): void
}

/** The 8 ordered draw seams, matching render() draw order. */
export type Seam =
  | 'background'
  | 'grid'
  | 'group'
  | 'connectionLine'
  | 'object'
  | 'connectionOverlay'
  | 'selection'
  | 'screenOverlay'

export interface ThemePlugin {
  /** Untrusted render source (community themes only). Executed in the worker
   *  sandbox; never evaluated on the main thread. */
  code?: string
  meta: {
    id: string
    name: string
    version: string
    trust: 'official' | 'community'
    /** SDK version the theme targets; used to gate activation (community themes). */
    sdkVersion?: string
    /** The render mode this theme maps to (transitional — engine still branches on it for unmigrated seams). */
    mode?: SkinRenderMode
    fonts?: { family: string; src?: string; minSize?: number }[]
    /**
     * Pixel-snap step (px). When set, the engine snaps object/group geometry to
     * this grid and forces sharp corners — a plugin-declared capability that
     * replaces the old `mode === 'eightbit'` geometry checks.
     */
    pixelSnap?: number
    /** Minimum font size (px) the theme enforces. Replaces the eightbit font floor. */
    fontMinSize?: number
    /**
     * Embedded 3D assets for the board: GLTF models / textures a
     * NodeSpec3D `asset` or environment `floorTexture`/background can reference.
     * Data URIs ONLY — external URIs are rejected at activation, and every
     * asset passes the canvas3d sanitizer caps (512KB each / 1MB total, 20k
     * tris, ≤1024² textures, ≤20 draw calls) before it can reach the GPU.
     */
    assets?: Record<string, { kind: 'gltf' | 'texture'; dataUri: string }>
  }
  /** Declarative half — the existing SkinConfig surface. */
  style?: Partial<SkinConfig>

  onActivate?(host: ThemeHost): void
  onDeactivate?(): void
  isAnimating?(): boolean
  animate?(timeMs: number): AnimBag

  background?: Hook<BackgroundArgs>
  grid?: Hook<GridArgs>
  group?: Hook<GroupArgs>
  connectionLine?: Hook<ConnectionArgs>
  object?: Hook<ObjectArgs>
  connectionOverlay?: Hook<ConnectionArgs>
  selection?: Hook<SelectionArgs>
  screenOverlay?: Hook<OverlayArgs>

  /** 3D board spec builders — pure data, no GL access. `null` = engine default
   * for that item. Community themes run them in the sandbox worker
   * (`theme3dCommunity.ts`). */
  object3d?(args: Object3dArgs): NodeSpec3D | null
  floor3d?(args: Floor3dArgs): FloorSpec3D | null
}

/**
 * Validate + freeze a theme definition. For official themes this is a cheap
 * identity-with-guards; the heavier untrusted validation (clamping, unknown-key
 * rejection) is layered on in the sandbox compile path.
 */
export function defineTheme(plugin: ThemePlugin): ThemePlugin {
  if (!plugin || typeof plugin !== 'object') throw new Error('defineTheme: plugin must be an object')
  if (!plugin.meta || typeof plugin.meta.id !== 'string') throw new Error('defineTheme: meta.id required')
  return plugin
}
