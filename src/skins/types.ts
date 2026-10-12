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

import type { C4Type, FlowStepType } from '../types'
import type { Lighting3D } from '../canvas3d/specs'
import type { ConnectionAnimationColors } from './connectionAnimation'

export type SkinRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'

export type SkinRenderMode = 'default' | 'cyberpunk' | 'eightbit' | 'graffiti'

/**
 * 3D "blueprint board" colors (the 2D/3D canvas view). EVERY field is optional:
 * whatever a theme omits is derived from its existing colors (see
 * `resolve3dPalette` in src/canvas3d/palette.ts), so old themes render a
 * coherent board with zero changes. Theme creators override to art-direct the
 * 3D look — walls, board, platforms, standee drums (see the Theme SDK's 3D seams
 * for full custom 3D rendering).
 */
export interface SkinThreeConfig {
  /** Extruded node walls: camera-facing edge / side edges. Derived per-node from its fill when omitted. */
  wallFront?: string
  wallSide?: string
  /** Wall tint for the selected object (defaults to the selection stroke). */
  wallSelected?: string
  /** The floor slab ("board"): background, its dot grid, border. */
  floorBg?: string
  floorGrid?: string
  floorBorder?: string
  /** Soft ground/floor shadow color (rgba with alpha encouraged). */
  shadowColor?: string
  /** Raised platform (standard groups) wash + edge. */
  platformFill?: string
  platformStroke?: string
  /** Store standee: drum shading poles, footprint pad, name tag. */
  standeeLight?: string
  standeeDark?: string
  padFill?: string
  padBorder?: string
  tagBg?: string
  tagText?: string
  /**
   * WebGL-only environment: scene background (color or vertical gradient),
   * clamped exponential fog, and shading modifiers scaling the pre-mixed depth
   * cues. Sanitized through `canvas3d/specs.sanitizeEnvironment3d` before the
   * engine consumes it — safe for community-supplied configs.
   */
  environment?: {
    /** Flat color, vertical gradient, or an equirect `meta.assets` texture. */
    background?: string | { top: string; bottom: string } | { asset: string }
    fog?: { color?: string; density: number }
    shading?: { wallMix?: number; drumContrast?: number }
    /** Slab-top texture (`meta.assets` id) tiled at the 20-unit dot pitch. */
    floorTexture?: string
    /** Lit (PBR) render profile — presence migrates the theme off the unlit
     * pipeline (sanitized via `canvas3d/specs.sanitizeLighting3d`; an unknown
     * preset drops the block and the theme stays unlit). */
    lighting?: Lighting3D
  }
}

export interface SkinConfig {
  id: string
  name: string
  description: string
  rarity: SkinRarity
  price: number
  /**
   * Which app theme this palette is designed for. A theme can ship a `light`
   * and a `dark` variant (see `src/skins/variants.ts`); the skin store resolves
   * the one matching the active app theme. If a theme provides only one variant,
   * it is used for both. Defaults to `'light'` when omitted.
   */
  appearance?: 'light' | 'dark'
  canvas: {
    bg: string
    grid: string
  }
  objects: Record<
    C4Type,
    {
      fill: string
      fillExternal: string
      stroke: string
      strokeWidth: number
      strokeSelected: string
      strokeHover: string
      strokeConnected: string
      icon: string
      iconExternal: string
      text: string
      textExternal: string
      description: string
      descriptionExternal: string
      badgeBg: string
      badgeText: string
      shadowColor: string
      shadowColorExternal: string
      shadowBlur: number
      shadowBlurHover: number
      shadowOffsetY: number
      shadowOffsetYHover: number
      cornerRadius: number
      // Cylinder lines for store icon
      cylinderLine: string
      cylinderLineExternal: string
    }
  >
  groups: {
    parentWrapperFill: string
    standardFillAlpha: number
    standardStrokeAlpha: number
    standardStrokeSelectedAlpha: number
    label: string
    labelAlpha: number
    icon: string
    description: string
    typeLabel: string
    navColor: string
    navColorHover: string
    expandColor: string
    expandColorHover: string
    linkColor: string
    backText: string
  }
  connections: {
    normal: string
    lower: string
    highlight: string
    hover: string
    strokeWidth: number
    strokeWidthHighlight: number
    strokeWidthActive: number
    labelBg: string
    labelStroke: string
    labelText: string
    /**
     * Cyberpunk double-curve connection colours, decoupled from the object
     * border's `renderStyle.doubleStroke` so connections can keep the yellow+cyan
     * double line while shapes use a same-colour border. Falls back to the
     * doubleStroke colours when omitted.
     */
    doubleOuterColor?: string
    doubleInnerColor?: string
  }
  selection: {
    stroke: string
    glow: string
    glowAlpha: number
    shadowBlur: number
  }
  flow: Record<FlowStepType, string>
  flowBadgeFallback: string
  comments: Record<
    'question' | 'inaccuracy' | 'idea',
    { bg: string; border: string; text: string }
  >
  resizeHandles: {
    fill: string
    stroke: string
    strokeHover: string
  }
  anchors: {
    color: string
    colorHover: string
    colorHighlighted: string
    colorLower: string
    stroke: string
  }
  copyCursor: {
    sizeColor: string
    styleColor: string
    text: string
  }
  bottomBar: {
    height: number
    cornerRadius: number
    opacity: number
    technology: Record<string, string>
    status: { live: string; draft: string; down: string; unstable: string }
    tagColorMode: 'original' | 'theme'
    tagColors: string[]
  }
  /**
   * Colors for the connection focus animation (drawn over a shape's connections
   * when it is selected — see `renderConnectionHighlightEffect`). Optional: a
   * theme that omits it inherits the built-in palette for its id, then the
   * classic blue. See `src/skins/connectionAnimation.ts`.
   */
  connectionAnimation?: ConnectionAnimationColors
  /** 3D board colors — optional, fully derived from the skin when omitted. */
  three?: SkinThreeConfig
  renderStyle: {
    mode: SkinRenderMode
    /**
     * When true, external-scope objects are NOT dimmed with the default 0.55 alpha
     * fade — the internal↔external difference is carried by the quieter `*External`
     * colours alone (a solid, calmer card). This is the design-system treatment
     * (`.ba-node--external` only swaps the background); omit for the classic fade.
     */
    solidExternal?: boolean
    glowIntensity?: number
    roughness?: number
    pixelSize?: number
    ditherPattern?: boolean
    monochrome?: boolean
    fontFamily?: string
    titleFontFamily?: string
    /** Font for GROUP titles only (falls back to fontFamily). Lets a theme keep a
     *  decorative face on group headers while bodies use a readable one. */
    groupTitleFontFamily?: string
    titleSize?: {
      base: number
      min: number
    }
    titleShadow?: {
      enabled: boolean
      shadows: {
        color: string
        offsetX: number
        offsetY: number
        alpha?: number
      }[]
    }
    doubleStroke?: {
      enabled: boolean
      outerWidth: number
      innerWidth: number
      gapColor: string
      outerColor?: string
      innerColor?: string
      offset?: number
    }
    chromaticAberration?: {
      enabled: boolean
      offset: number
      secondaryColor: string
    }
    scanLines?: {
      enabled: boolean
      density: number
      opacity: number
      speed: number
    }
    neonGlow?: {
      enabled: boolean
      pulseSpeed: number
      intensity: number
    }
    imperfectShapes?: {
      enabled: boolean
      roughness: number
      segmentCount: number
    }
    scratchPaint?: {
      enabled: boolean
      scratchCount: number
      scratchOpacity: number
      scratchWidth: number
      revealColor: string
    }
    glitch?: {
      enabled: boolean
      interval: number
      duration: number
      intensity: number
    }
    /** Cyberpunk HUD: translucent fill for group panels (the tinted zone). */
    groupHudFill?: string
    /** Cyberpunk HUD: colour of the corner brackets drawn around groups. */
    groupHudStroke?: string
    /** Cyberpunk: colour of the screen-space scan-line overlay. */
    scanLineColor?: string
  }
}

export interface SkinDefinition {
  id: string
  name: string
  description: string
  rarity: SkinRarity
  price: number
  config: SkinConfig
}
