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
 * 3D theme spec surface — PURE DATA, no three.js imports.
 *
 * Theme hooks (`object3d` / `floor3d`) return these specs; the engine applies
 * them. Community code never touches GL — everything here passes through the
 * sanitizers below (unknown keys dropped, numbers clamped, colors gated by the
 * same `isSafeColor` the 2D schema walker uses), so a hostile or buggy theme
 * can at worst produce an ugly board, never an unsafe one. Official themes go
 * through the exact same sanitizers: one contract, uniformly enforced.
 *
 * This module is imported by BOTH the lazy `canvas3d` chunk and the main-bundle
 * SDK contract — keep it dependency-free (no three, no engine imports).
 */

import { isSafeColor } from '../plugins/schema'
import type { ThemeAssetDecl } from './assetLimits'

/** meta.assets id — short, filesystem-safe (same charset the manifest gate uses). */
const ASSET_ID = /^[\w.-]{1,64}$/

/**
 * Per-theme LIT render profile (the PBR switch).
 * The PRESENCE of this block flips the engine from the historical unlit
 * pipeline to the lit one for that theme; themes migrate one by one and the
 * unlit reference themes ('default', eightbit) simply never declare it.
 *
 * The light topology is FIXED — one directional key + one hemisphere fill +
 * procedural IBL (PMREM of RoomEnvironment) — themes tune parameters, never
 * add lights, so the GPU cost of a lit theme stays bounded and a hostile
 * config cannot multiply passes. Enum-gated preset: unknown ⇒ the whole block
 * is dropped ⇒ the theme stays unlit.
 */
export interface Lighting3D {
  /** Rig recipe (v1: only 'studio'). Gate for the whole block. */
  preset: 'studio'
  /** Renderer tone-mapping exposure (clamp [0.5, 2]; engine default 1.1). */
  exposure?: number
  /** Tone-mapping curve (engine default 'aces'). */
  toneMapping?: 'aces' | 'neutral'
  /** Directional key light ("sun"). */
  sun?: {
    color?: string
    /** clamp [0, 4] */
    intensity?: number
    /** Horizontal direction, degrees (clamp [-180, 180]). */
    azimuthDeg?: number
    /** Elevation above the board, degrees (clamp [15, 80]). */
    elevationDeg?: number
  }
  /** Hemisphere fill. */
  ambient?: {
    skyColor?: string
    groundColor?: string
    /** clamp [0, 2] */
    intensity?: number
  }
  /** Image-based lighting — PMREM(RoomEnvironment), procedural, no asset. */
  ibl?: {
    /** scene.environmentIntensity (clamp [0, 1.5]). */
    intensity?: number
  }
  /** Key-light shadow map (PCFSoft). On by default when the block is present. */
  shadows?: {
    enabled?: boolean
    /** clamp [0, 1] */
    opacity?: number
    mapSize?: 1024 | 2048
  }
  /** Global lit-surface response (the lit material family's defaults). */
  material?: {
    /** clamp [0.05, 1] */
    roughness?: number
    /** clamp [0, 0.5] */
    metalness?: number
    /** clamp [0, 1] */
    clearcoat?: number
  }
  /** Post bloom (takes effect once the post stack is live). */
  bloom?: {
    /** clamp [0, 1.5] */
    strength?: number
    /** clamp [0, 1] */
    threshold?: number
  }
}

/** WebGL-only environment block (declarative — `skin.three.environment`). */
export interface Environment3D {
  /** Scene background: flat color, a vertical top→bottom gradient, or an
   * equirect texture from `meta.assets` (rendered as the skybox). */
  background?: string | { top: string; bottom: string } | { asset: string }
  /** Slab-top texture (`meta.assets` id), tiled at the 20-unit dot pitch and
   * drawn under the dot grid. */
  floorTexture?: string
  /** Exponential fog. Density is heavily clamped — the unlit look reads badly
   * through thick fog, this is an atmosphere accent, not a hiding mechanic. */
  fog?: { color?: string; density: number }
  /** Shading modifiers (clamped) — the unlit pipeline has no GPU lights to
   * expose, these scale the kit's pre-mixed depth cues instead. */
  shading?: {
    /** Scales the wall color-mix strength (1 = kit look). */
    wallMix?: number
    /** Scales the drum cos-law contrast (1 = kit look). */
    drumContrast?: number
  }
  /** Lit render profile — presence flips the theme to the PBR pipeline. */
  lighting?: Lighting3D
}

/** What an `object3d` hook returns for one node (null = engine default). */
export interface NodeSpec3D {
  /** Replace the node's BODY: 'billboard' = a camera-facing textured plane,
   * 'gltf' = a sanitized theme model — both backed by a `meta.assets` id.
   * The engine keeps the name label readable above custom bodies, and falls
   * back to the default slab/drum until the asset decodes (or if it fails). */
  geometry?: 'billboard' | 'gltf'
  /** `meta.assets` id backing the custom geometry (required with `geometry`). */
  asset?: string
  /** Uniform scale multiplier for the mounted asset (clamp [0.25, 3]). */
  scale?: number
  /** Card material overrides (top face fill / extruded walls). */
  materials?: {
    top?: string
    wallFront?: string
    wallSide?: string
    /** Whole-card opacity (clamped ≥ 0.35 — cards must stay readable). */
    opacity?: number
  }
  /** Multiplies the preset extrusion depth (0 = flat tile, clamp [0, 3]). */
  depthScale?: number
  /** Top-face corner radius override (clamp [0, 20]). */
  cornerRadius?: number
  /** Neon rim strip around the top face edge (the cyberpunk signature). */
  edgeGlow?: { color: string; width?: number }
  /** Slow yaw spin, degrees/second (drums only — cards carry flat text). */
  spin?: { speed: number }
  /** Gentle vertical bob: amplitude in world px, speed in Hz. */
  bob?: { amp: number; speed: number }
}

/** What a `floor3d` hook returns for the board (null = engine default). */
export interface FloorSpec3D {
  /** 'none' = no board at all (theme supplies ground via environment). */
  mode?: 'default' | 'none'
  /** Slab corner radius (clamp [0, 60]). */
  cornerRadius?: number
  /** Dot grid on the slab top: 'none' hides it, gridColor recolors it. */
  grid?: 'dots' | 'none'
  gridColor?: string
  /** 'flat' = thin slab without the hanging stone walls. */
  edge?: 'walls' | 'flat'
  /** Soft ground shadow under the board. */
  shadow?: boolean
  /** Slab padding around the content bounds (clamp [24, 200]). */
  pad?: { x?: number; y?: number }
  /** Decorative terrain fragments dissolving off the board edges. ONE
   * instanced draw call, with deterministic placement. */
  scatter?: {
    /** Fragment colors (≤ 6 safe colors; none valid → scatter dropped). */
    colors: string[]
    /** Geometry language. `grid-fracture` keeps fragments flat and retracts
     * the slab so they read as pieces detached from its surface. */
    pattern?: 'cubes' | 'grid-fracture'
    /** Fragment count (clamp [8, 120], default 64). */
    count?: number
    /** Base grid-cell / cube size in world px (clamp [3, 16], default 8). */
    size?: number
    /** How far beyond the slab edge fragments drift (clamp [30, 220], default 120). */
    spread?: number
    /** Max float height above the ground (clamp [0, 100], default 46). */
    rise?: number
    /** Loose edge fragments can be grabbed/kicked locally. This interaction is
     * scene-only and never enters the persisted diagram model. */
    interactive?: boolean
  }
}

/**
 * The theme surface Scene3D consumes — built OUTSIDE the chunk (see
 * `src/plugins/theme3d.ts`) so the engine never imports plugin code. All spec
 * outputs are already sanitized when they cross this boundary.
 */
export interface Theme3dSource {
  environment: Environment3D | null
  /** Pixel-snap step from the theme meta (eightbit): chunky extrusion + snapped
   * placement + sharp corners — the free-inheritance layer, no 3D code needed. */
  pixelSnap: number | null
  /** Theme id — the asset cache namespace. */
  themeId: string
  /** The theme's VALIDATED asset manifest (null when absent or over the caps);
   * specs/environment reference these by id, the engine decodes lazily. */
  assets: Record<string, ThemeAssetDecl> | null
  objectSpec(args: {
    id: string
    type: string
    name: string
    fill: string
    selected: boolean
    external: boolean
    zBase: number
    zTop: number
  }): NodeSpec3D | null
  floorSpec(args: { bounds: { x: number; y: number; w: number; h: number }; dark: boolean }): FloorSpec3D | null
}

// ── sanitizers ────────────────────────────────────────────────────────────────

function clampNum(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(hi, Math.max(lo, v))
}

function safeColor(v: unknown): string | undefined {
  return typeof v === 'string' && isSafeColor(v) ? v : undefined
}

function hasAnyKey(o: object): boolean {
  return Object.values(o).some((v) => v !== undefined)
}

/** Sanitize a raw lighting block. Unknown preset ⇒ null (theme stays unlit). */
export function sanitizeLighting3d(raw: unknown): Lighting3D | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.preset !== 'studio') return null
  const out: Lighting3D = { preset: 'studio' }
  const exposure = clampNum(r.exposure, 0.5, 2)
  if (exposure !== undefined) out.exposure = exposure
  if (r.toneMapping === 'aces' || r.toneMapping === 'neutral') out.toneMapping = r.toneMapping
  if (r.sun && typeof r.sun === 'object') {
    const s = r.sun as Record<string, unknown>
    const sun: NonNullable<Lighting3D['sun']> = {}
    const color = safeColor(s.color)
    if (color) sun.color = color
    const intensity = clampNum(s.intensity, 0, 4)
    if (intensity !== undefined) sun.intensity = intensity
    const azimuthDeg = clampNum(s.azimuthDeg, -180, 180)
    if (azimuthDeg !== undefined) sun.azimuthDeg = azimuthDeg
    const elevationDeg = clampNum(s.elevationDeg, 15, 80)
    if (elevationDeg !== undefined) sun.elevationDeg = elevationDeg
    if (hasAnyKey(sun)) out.sun = sun
  }
  if (r.ambient && typeof r.ambient === 'object') {
    const a = r.ambient as Record<string, unknown>
    const ambient: NonNullable<Lighting3D['ambient']> = {}
    const skyColor = safeColor(a.skyColor)
    if (skyColor) ambient.skyColor = skyColor
    const groundColor = safeColor(a.groundColor)
    if (groundColor) ambient.groundColor = groundColor
    const intensity = clampNum(a.intensity, 0, 2)
    if (intensity !== undefined) ambient.intensity = intensity
    if (hasAnyKey(ambient)) out.ambient = ambient
  }
  if (r.ibl && typeof r.ibl === 'object') {
    const intensity = clampNum((r.ibl as Record<string, unknown>).intensity, 0, 1.5)
    if (intensity !== undefined) out.ibl = { intensity }
  }
  if (r.shadows && typeof r.shadows === 'object') {
    const s = r.shadows as Record<string, unknown>
    const shadows: NonNullable<Lighting3D['shadows']> = {}
    if (typeof s.enabled === 'boolean') shadows.enabled = s.enabled
    const opacity = clampNum(s.opacity, 0, 1)
    if (opacity !== undefined) shadows.opacity = opacity
    if (s.mapSize === 1024 || s.mapSize === 2048) shadows.mapSize = s.mapSize
    if (hasAnyKey(shadows)) out.shadows = shadows
  }
  if (r.material && typeof r.material === 'object') {
    const m = r.material as Record<string, unknown>
    const material: NonNullable<Lighting3D['material']> = {}
    const roughness = clampNum(m.roughness, 0.05, 1)
    if (roughness !== undefined) material.roughness = roughness
    const metalness = clampNum(m.metalness, 0, 0.5)
    if (metalness !== undefined) material.metalness = metalness
    const clearcoat = clampNum(m.clearcoat, 0, 1)
    if (clearcoat !== undefined) material.clearcoat = clearcoat
    if (hasAnyKey(material)) out.material = material
  }
  if (r.bloom && typeof r.bloom === 'object') {
    const b = r.bloom as Record<string, unknown>
    const bloom: NonNullable<Lighting3D['bloom']> = {}
    const strength = clampNum(b.strength, 0, 1.5)
    if (strength !== undefined) bloom.strength = strength
    const threshold = clampNum(b.threshold, 0, 1)
    if (threshold !== undefined) bloom.threshold = threshold
    if (hasAnyKey(bloom)) out.bloom = bloom
  }
  return out
}

/** Sanitize a raw environment block. Returns null when nothing valid remains. */
export function sanitizeEnvironment3d(raw: unknown): Environment3D | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: Environment3D = {}

  if (typeof r.background === 'string') {
    const c = safeColor(r.background)
    if (c) out.background = c
  } else if (r.background && typeof r.background === 'object') {
    const g = r.background as Record<string, unknown>
    if (typeof g.asset === 'string' && ASSET_ID.test(g.asset)) {
      out.background = { asset: g.asset }
    } else {
      const top = safeColor(g.top)
      const bottom = safeColor(g.bottom)
      if (top && bottom) out.background = { top, bottom }
    }
  }

  if (typeof r.floorTexture === 'string' && ASSET_ID.test(r.floorTexture)) out.floorTexture = r.floorTexture

  if (r.fog && typeof r.fog === 'object') {
    const f = r.fog as Record<string, unknown>
    const density = clampNum(f.density, 0, 0.0025)
    if (density !== undefined && density > 0) {
      out.fog = { density, ...(safeColor(f.color) ? { color: safeColor(f.color) } : {}) }
    }
  }

  if (r.shading && typeof r.shading === 'object') {
    const s = r.shading as Record<string, unknown>
    const wallMix = clampNum(s.wallMix, 0.25, 1.8)
    const drumContrast = clampNum(s.drumContrast, 0, 1.5)
    const shading: Environment3D['shading'] = {}
    if (wallMix !== undefined) shading.wallMix = wallMix
    if (drumContrast !== undefined) shading.drumContrast = drumContrast
    if (hasAnyKey(shading)) out.shading = shading
  }

  const lighting = sanitizeLighting3d(r.lighting)
  if (lighting) out.lighting = lighting

  return hasAnyKey(out) ? out : null
}

/** Sanitize a raw object3d hook result. Returns null when nothing valid remains. */
export function sanitizeNodeSpec3d(raw: unknown): NodeSpec3D | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: NodeSpec3D = {}

  // custom body: geometry + asset travel together or not at all
  if ((r.geometry === 'billboard' || r.geometry === 'gltf') && typeof r.asset === 'string' && ASSET_ID.test(r.asset)) {
    out.geometry = r.geometry
    out.asset = r.asset
    const scale = clampNum(r.scale, 0.25, 3)
    if (scale !== undefined) out.scale = scale
  }

  if (r.materials && typeof r.materials === 'object') {
    const m = r.materials as Record<string, unknown>
    const materials: NodeSpec3D['materials'] = {}
    const top = safeColor(m.top)
    const wallFront = safeColor(m.wallFront)
    const wallSide = safeColor(m.wallSide)
    const opacity = clampNum(m.opacity, 0.35, 1)
    if (top) materials.top = top
    if (wallFront) materials.wallFront = wallFront
    if (wallSide) materials.wallSide = wallSide
    if (opacity !== undefined) materials.opacity = opacity
    if (hasAnyKey(materials)) out.materials = materials
  }

  const depthScale = clampNum(r.depthScale, 0, 3)
  if (depthScale !== undefined) out.depthScale = depthScale
  const cornerRadius = clampNum(r.cornerRadius, 0, 20)
  if (cornerRadius !== undefined) out.cornerRadius = cornerRadius

  if (r.edgeGlow && typeof r.edgeGlow === 'object') {
    const e = r.edgeGlow as Record<string, unknown>
    const color = safeColor(e.color)
    if (color) {
      const width = clampNum(e.width, 0.5, 4)
      out.edgeGlow = { color, ...(width !== undefined ? { width } : {}) }
    }
  }

  if (r.spin && typeof r.spin === 'object') {
    const speed = clampNum((r.spin as Record<string, unknown>).speed, -90, 90)
    if (speed !== undefined && speed !== 0) out.spin = { speed }
  }

  if (r.bob && typeof r.bob === 'object') {
    const b = r.bob as Record<string, unknown>
    const amp = clampNum(b.amp, 0, 6)
    const speed = clampNum(b.speed, 0, 2)
    if (amp !== undefined && amp > 0 && speed !== undefined && speed > 0) out.bob = { amp, speed }
  }

  return hasAnyKey(out) ? out : null
}

/** Sanitize a raw floor3d hook result. Returns null when nothing valid remains. */
export function sanitizeFloorSpec3d(raw: unknown): FloorSpec3D | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: FloorSpec3D = {}

  if (r.mode === 'none' || r.mode === 'default') out.mode = r.mode
  const cornerRadius = clampNum(r.cornerRadius, 0, 60)
  if (cornerRadius !== undefined) out.cornerRadius = cornerRadius
  if (r.grid === 'dots' || r.grid === 'none') out.grid = r.grid
  const gridColor = safeColor(r.gridColor)
  if (gridColor) out.gridColor = gridColor
  if (r.edge === 'walls' || r.edge === 'flat') out.edge = r.edge
  if (typeof r.shadow === 'boolean') out.shadow = r.shadow

  if (r.pad && typeof r.pad === 'object') {
    const p = r.pad as Record<string, unknown>
    const x = clampNum(p.x, 24, 200)
    const y = clampNum(p.y, 24, 200)
    const pad: FloorSpec3D['pad'] = {}
    if (x !== undefined) pad.x = x
    if (y !== undefined) pad.y = y
    if (hasAnyKey(pad)) out.pad = pad
  }

  if (r.scatter && typeof r.scatter === 'object') {
    const s = r.scatter as Record<string, unknown>
    const colors = (Array.isArray(s.colors) ? s.colors : [])
      .map((c) => safeColor(c))
      .filter((c): c is string => !!c)
      .slice(0, 6)
    if (colors.length > 0) {
      const scatter: NonNullable<FloorSpec3D['scatter']> = { colors }
      if (s.pattern === 'cubes' || s.pattern === 'grid-fracture') scatter.pattern = s.pattern
      const count = clampNum(s.count, 8, 120)
      if (count !== undefined) scatter.count = Math.round(count)
      const size = clampNum(s.size, 3, 16)
      if (size !== undefined) scatter.size = size
      const spread = clampNum(s.spread, 30, 220)
      if (spread !== undefined) scatter.spread = spread
      const rise = clampNum(s.rise, 0, 100)
      if (rise !== undefined) scatter.rise = rise
      if (typeof s.interactive === 'boolean') scatter.interactive = s.interactive
      out.scatter = scatter
    }
  }

  return hasAnyKey(out) ? out : null
}
