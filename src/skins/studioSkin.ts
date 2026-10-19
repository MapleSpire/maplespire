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

import type { SkinConfig } from './types'
import { CLEAN_ANIM } from './connectionAnimation'

/**
 * "Studio" — the MapleSpire design system's C4 node, rendered faithfully on the
 * canvas. It is the design-system-canonical look: crisp stone-paper cards on a
 * 14px radius (`--radius-node`), a 1px `--color-line-strong` hairline, a lifted
 * `--shadow-lg` drop, and the calm `--color-c4-*` type accents. External objects
 * read back quieter on `--color-surface-50`.
 *
 * The signature detail lives in the paired theme plugin (`studio.theme.ts`): a
 * SELECTED node gets the DS focus treatment — a 2px coral border absorbed INWARD
 * (footprint unchanged) plus a crisp `0 0 0 4px` accent@15% ring — instead of the
 * engine's default outward stroke + blurred glow. Colours below are the light
 * variant; `studioSkinDark` is the dark counterpart (resolved via `skinVariants`).
 *
 * Tokens mirror `.claude/design-system/tokens/colors.css` and the handoff's
 * `components/diagram/C4Node.jsx` 1:1 (never hardcode off-palette hex).
 */
export const studioSkin: SkinConfig = {
  id: 'studio',
  name: 'Studio',
  description:
    'The design system C4 node, faithfully rendered — crisp stone-paper cards, a 14px radius, and a precise coral focus ring.',
  rarity: 'common',
  price: 0,
  appearance: 'light',
  canvas: {
    bg: '#E7E6E2', // --color-canvas
    grid: '#D8D5CE', // --color-canvas-grid
  },
  objects: {
    actor: {
      fill: '#FFFFFF', // --color-surface-100
      fillExternal: '#F7F5F2', // --color-surface-50
      stroke: '#E0DBD2', // --color-line-strong (DS node border)
      strokeWidth: 1,
      strokeSelected: '#D97A3D', // --color-accent
      strokeHover: '#C9C3BA', // --stone-500
      strokeConnected: '#D97A3D',
      icon: '#6F6A62', // --color-c4-actor
      iconExternal: '#6F6A62', // DS: external keeps the type colour (only bg + name quiet)
      text: '#1E1D1B', // --color-fg
      textExternal: '#56524C', // --color-fg-secondary (DS external name)
      description: '#9A958C', // --color-fg-subtle (DS sub)
      descriptionExternal: '#9A958C',
      badgeBg: '#F1EFEB', // --color-surface-200
      badgeText: '#56524C',
      // --shadow-lg: 0 4px 14px rgba(38,34,28,.08)
      shadowColor: 'rgba(38, 34, 28, 0.08)',
      shadowColorExternal: 'rgba(38, 34, 28, 0.04)',
      shadowBlur: 14,
      shadowBlurHover: 20,
      shadowOffsetY: 4,
      shadowOffsetYHover: 8,
      cornerRadius: 14, // DS --radius-node
      cylinderLine: 'rgba(255,255,255,0.5)',
      cylinderLineExternal: 'rgba(255,255,255,0.3)',
    },
    system: {
      fill: '#FFFFFF',
      fillExternal: '#F7F5F2',
      stroke: '#E0DBD2',
      strokeWidth: 1,
      strokeSelected: '#D97A3D',
      strokeHover: '#C9C3BA',
      strokeConnected: '#D97A3D',
      icon: '#7E8AA3', // --color-c4-system
      iconExternal: '#7E8AA3',
      text: '#1E1D1B',
      textExternal: '#56524C',
      description: '#9A958C',
      descriptionExternal: '#9A958C',
      badgeBg: '#F1EFEB',
      badgeText: '#56524C',
      shadowColor: 'rgba(38, 34, 28, 0.08)',
      shadowColorExternal: 'rgba(38, 34, 28, 0.04)',
      shadowBlur: 14,
      shadowBlurHover: 20,
      shadowOffsetY: 4,
      shadowOffsetYHover: 8,
      cornerRadius: 14,
      cylinderLine: 'rgba(255,255,255,0.5)',
      cylinderLineExternal: 'rgba(255,255,255,0.3)',
    },
    app: {
      fill: '#FFFFFF',
      fillExternal: '#F7F5F2',
      stroke: '#E0DBD2',
      strokeWidth: 1,
      strokeSelected: '#D97A3D',
      strokeHover: '#C9C3BA',
      strokeConnected: '#D97A3D',
      icon: '#C06A2C', // --color-c4-app
      iconExternal: '#C06A2C',
      text: '#1E1D1B',
      textExternal: '#56524C',
      description: '#9A958C',
      descriptionExternal: '#9A958C',
      badgeBg: '#F1EFEB',
      badgeText: '#56524C',
      shadowColor: 'rgba(38, 34, 28, 0.08)',
      shadowColorExternal: 'rgba(38, 34, 28, 0.04)',
      shadowBlur: 14,
      shadowBlurHover: 20,
      shadowOffsetY: 4,
      shadowOffsetYHover: 8,
      cornerRadius: 14,
      cylinderLine: 'rgba(255,255,255,0.5)',
      cylinderLineExternal: 'rgba(255,255,255,0.3)',
    },
    store: {
      fill: '#FFFFFF',
      fillExternal: '#F7F5F2',
      stroke: '#E0DBD2',
      strokeWidth: 1,
      strokeSelected: '#D97A3D',
      strokeHover: '#C9C3BA',
      strokeConnected: '#D97A3D',
      icon: '#6F6A62', // --color-c4-store
      iconExternal: '#6F6A62',
      text: '#1E1D1B',
      textExternal: '#56524C',
      description: '#9A958C',
      descriptionExternal: '#9A958C',
      badgeBg: '#F1EFEB',
      badgeText: '#56524C',
      shadowColor: 'rgba(38, 34, 28, 0.08)',
      shadowColorExternal: 'rgba(38, 34, 28, 0.04)',
      shadowBlur: 14,
      shadowBlurHover: 20,
      shadowOffsetY: 4,
      shadowOffsetYHover: 8,
      cornerRadius: 14,
      // Lid seam + highlight for the database cylinder (store only).
      cylinderLine: 'rgba(111, 106, 98, 0.28)',
      cylinderLineExternal: 'rgba(183, 177, 168, 0.4)',
    },
    component: {
      fill: '#FFFFFF',
      fillExternal: '#F7F5F2',
      stroke: '#E0DBD2',
      strokeWidth: 1,
      strokeSelected: '#D97A3D',
      strokeHover: '#C9C3BA',
      strokeConnected: '#D97A3D',
      icon: '#9A958C', // --color-c4-component
      iconExternal: '#9A958C',
      text: '#1E1D1B',
      textExternal: '#56524C',
      description: '#9A958C',
      descriptionExternal: '#9A958C',
      badgeBg: '#F1EFEB',
      badgeText: '#56524C',
      shadowColor: 'rgba(38, 34, 28, 0.08)',
      shadowColorExternal: 'rgba(38, 34, 28, 0.04)',
      shadowBlur: 14,
      shadowBlurHover: 20,
      shadowOffsetY: 4,
      shadowOffsetYHover: 8,
      cornerRadius: 14,
      cylinderLine: 'rgba(255,255,255,0.5)',
      cylinderLineExternal: 'rgba(255,255,255,0.3)',
    },
  },
  groups: {
    parentWrapperFill: 'rgba(231, 230, 226, 0.35)',
    standardFillAlpha: 0.3,
    standardStrokeAlpha: 0.5,
    standardStrokeSelectedAlpha: 0.9,
    label: '#8C877F',
    labelAlpha: 0.8,
    icon: '#8C877F',
    description: '#8C877F',
    typeLabel: '#9A958C',
    navColor: '#8C877F',
    navColorHover: '#D97A3D',
    expandColor: '#8C877F',
    expandColorHover: '#D97A3D',
    linkColor: '#9A958C',
    backText: '#D97A3D',
  },
  connections: {
    normal: '#B7B1A8', // --color-connection
    lower: '#DAD5CC',
    highlight: '#D97A3D', // --color-connection-highlight
    hover: '#8C877F',
    strokeWidth: 1.6,
    strokeWidthHighlight: 2.5,
    strokeWidthActive: 2.5,
    labelBg: '#E7E6E2',
    labelStroke: '#E7E6E2',
    labelText: '#8C877F',
  },
  selection: {
    stroke: '#D97A3D',
    glow: 'rgba(217, 122, 61, 0.15)',
    glowAlpha: 0.15,
    shadowBlur: 12,
  },
  flow: {
    introduction: '#22C55E',
    message: '#D97A3D',
    process: '#D97A3D',
    information: '#8B5CF6',
    conclusion: '#DC2626',
  },
  flowBadgeFallback: '#D97A3D',
  comments: {
    question: { bg: '#FCEFD8', border: '#D97706', text: '#9A5B12' },
    inaccuracy: { bg: '#FBEAE7', border: '#DC2626', text: '#B5392B' },
    idea: { bg: '#F1ECFB', border: '#7C3AED', text: '#6D4AC0' },
  },
  resizeHandles: {
    fill: '#FFFFFF',
    stroke: '#D97A3D',
    strokeHover: '#CB6C30',
  },
  anchors: {
    color: '#B7B1A8',
    colorHover: '#8C877F',
    colorHighlighted: '#D97A3D',
    colorLower: '#DAD5CC',
    stroke: '#FFFFFF',
  },
  copyCursor: {
    sizeColor: '#D97A3D',
    styleColor: '#8B5CF6',
    text: '#ffffff',
  },
  bottomBar: {
    height: 4,
    cornerRadius: 8,
    opacity: 1,
    technology: {
      React: '#61DAFB',
      'Node.js': '#339933',
      'Socket.io': '#010101',
      'Firebase Auth': '#FFCA28',
      S3: '#FF9900',
      PostgreSQL: '#336791',
      Redis: '#DC382D',
      'Pub/Sub': '#4285F4',
      Go: '#00ADD8',
      'Cloud Scheduler': '#4285F4',
    },
    status: {
      live: '#22C55E',
      draft: '#9A958C',
      down: '#DC2626',
      unstable: '#D97A3D',
    },
    tagColorMode: 'original',
    tagColors: [],
  },
  connectionAnimation: CLEAN_ANIM,
  // The LIT (PBR) flagship. Golden-hour studio light over the stone-paper board: warm key from the
  // north-west, soft hemisphere fill, procedural room IBL, PCFSoft shadows.
  // The reference is the "architecture maquette" photo mood: matte ceramic
  // slabs on warm drafting paper.
  three: {
    // Warm DRAFTING PAPER for the lit board — the 2D canvas token is a cool
    // stone grey and reads as concrete next to the reference maquette. The
    // paper is deliberately darker than near-white: near-white rides the top
    // of the ACES tone-mapping shoulder, so the lamp pool has no headroom. This
    // cream lands open paper ~190 display, giving the lamp pool a range to own.
    floorBg: '#CFC0A0',
    floorGrid: '#A8946F',
    environment: {
      background: { top: '#F3EBDD', bottom: '#E2D3BC' },
      lighting: {
        preset: 'studio',
        exposure: 1.12,
        // key + fill sit LOW on purpose: at 2.3/0.65 the open paper rode the
        // top of the ACES shoulder (~230+ display) and the desk lamp's pool had
        // no headroom to read against. This tune lands open paper ~190 display
        // and leaves the pool the top of the range (the lamp spot in Scene3D
        // owns 250+). A low ambient keeps the fill from flattening the frame:
        // the lamp pool + corner vignette own the exposure hierarchy, for a
        // single dominant warm key.
        sun: { color: '#FFDDB0', intensity: 2.1, azimuthDeg: -55, elevationDeg: 38 },
        ambient: { skyColor: '#FFF3E2', groundColor: '#CDB394', intensity: 0.48 },
        ibl: { intensity: 0.35 },
        shadows: { enabled: true, opacity: 0.63, mapSize: 2048 },
        material: { roughness: 0.62, metalness: 0, clearcoat: 0.22 },
        // threshold 0.9 → 1 (the theme contract's ceiling, specs.ts): the
        // composer's scene buffer is linear and untoned, and the white card
        // faces sat just over 0.9 — every card bloomed, and the veil lifted
        // the INK printed on it. Measured (view3d quality loop 4 r3, ink probe
        // on the run.mjs board, DPR 1, labels close-up): the #1E1D1B title's
        // darkest pixel read (106,101,94) under the high/medium post stacks
        // and (30,29,27) composer-less; at 1 it reads (33,31,29). The lamp's
        // specular glints still bloom.
        bloom: { strength: 0.35, threshold: 1 },
      },
    },
  },
  renderStyle: {
    mode: 'default',
    fontFamily: 'Inter',
    solidExternal: true, // external = quieter background, not the classic alpha fade
  },
}
