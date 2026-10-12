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
 * Dark variant of "Studio" — the design system C4 node on dark. Gently elevated
 * espresso cards (`--color-surface-100` #211F1C) over a warm near-black canvas,
 * a `--color-line-strong` #3B362F hairline, the brightened coral accent #E89456,
 * and a deeper `--shadow-lg` cast in true black. Radius and anatomy match the
 * light variant; only the palette flips (resolved via `skinVariants`).
 *
 * Tokens mirror `.claude/design-system/tokens/colors.css` (`:root[data-theme='dark']`).
 */
export const studioSkinDark: SkinConfig = {
  id: 'studio',
  name: 'Studio',
  description:
    'The design system C4 node, faithfully rendered — crisp stone-paper cards, a 14px radius, and a precise coral focus ring.',
  rarity: 'common',
  price: 0,
  appearance: 'dark',
  canvas: {
    bg: '#161513', // --color-canvas (dark)
    grid: '#262320', // --color-canvas-grid (dark)
  },
  objects: {
    actor: {
      fill: '#211F1C', // --color-surface-100 (dark)
      fillExternal: '#1C1A17', // --color-surface-50 (dark)
      stroke: '#3B362F', // --color-line-strong (dark)
      strokeWidth: 1,
      strokeSelected: '#E89456', // --color-accent (dark)
      strokeHover: '#46423C', // --stone-500 (dark)
      strokeConnected: '#E89456',
      icon: '#A39E95', // --color-c4-actor (dark)
      iconExternal: '#A39E95', // DS: external keeps the type colour (only bg + name quiet)
      text: '#F2F0EC', // --color-fg (dark)
      textExternal: '#B4AFA7', // --color-fg-secondary (dark)
      description: '#837E75',
      descriptionExternal: '#837E75',
      badgeBg: '#2A2724',
      badgeText: '#C7C2BA',
      // --shadow-lg (dark): 0 6px 20px rgba(0,0,0,.5)
      shadowColor: 'rgba(0, 0, 0, 0.5)',
      shadowColorExternal: 'rgba(0, 0, 0, 0.28)',
      shadowBlur: 20,
      shadowBlurHover: 28,
      shadowOffsetY: 6,
      shadowOffsetYHover: 10,
      cornerRadius: 14,
      cylinderLine: 'rgba(255,255,255,0.06)',
      cylinderLineExternal: 'rgba(255,255,255,0.03)',
    },
    system: {
      fill: '#211F1C',
      fillExternal: '#1C1A17',
      stroke: '#3B362F',
      strokeWidth: 1,
      strokeSelected: '#E89456',
      strokeHover: '#46423C',
      strokeConnected: '#E89456',
      icon: '#94A0BD', // --color-c4-system (dark)
      iconExternal: '#94A0BD',
      text: '#F2F0EC',
      textExternal: '#B4AFA7',
      description: '#837E75',
      descriptionExternal: '#837E75',
      badgeBg: '#2A2724',
      badgeText: '#C7C2BA',
      shadowColor: 'rgba(0, 0, 0, 0.5)',
      shadowColorExternal: 'rgba(0, 0, 0, 0.28)',
      shadowBlur: 20,
      shadowBlurHover: 28,
      shadowOffsetY: 6,
      shadowOffsetYHover: 10,
      cornerRadius: 14,
      cylinderLine: 'rgba(255,255,255,0.06)',
      cylinderLineExternal: 'rgba(255,255,255,0.03)',
    },
    app: {
      fill: '#211F1C',
      fillExternal: '#1C1A17',
      stroke: '#3B362F',
      strokeWidth: 1,
      strokeSelected: '#E89456',
      strokeHover: '#46423C',
      strokeConnected: '#E89456',
      icon: '#E89456', // --color-c4-app (dark)
      iconExternal: '#E89456',
      text: '#F2F0EC',
      textExternal: '#B4AFA7',
      description: '#837E75',
      descriptionExternal: '#837E75',
      badgeBg: '#2A2724',
      badgeText: '#C7C2BA',
      shadowColor: 'rgba(0, 0, 0, 0.5)',
      shadowColorExternal: 'rgba(0, 0, 0, 0.28)',
      shadowBlur: 20,
      shadowBlurHover: 28,
      shadowOffsetY: 6,
      shadowOffsetYHover: 10,
      cornerRadius: 14,
      cylinderLine: 'rgba(255,255,255,0.06)',
      cylinderLineExternal: 'rgba(255,255,255,0.03)',
    },
    store: {
      fill: '#211F1C',
      fillExternal: '#1C1A17',
      stroke: '#3B362F',
      strokeWidth: 1,
      strokeSelected: '#E89456',
      strokeHover: '#46423C',
      strokeConnected: '#E89456',
      icon: '#A39E95', // --color-c4-store (dark)
      iconExternal: '#A39E95',
      text: '#F2F0EC',
      textExternal: '#B4AFA7',
      description: '#837E75',
      descriptionExternal: '#837E75',
      badgeBg: '#2A2724',
      badgeText: '#C7C2BA',
      shadowColor: 'rgba(0, 0, 0, 0.5)',
      shadowColorExternal: 'rgba(0, 0, 0, 0.28)',
      shadowBlur: 20,
      shadowBlurHover: 28,
      shadowOffsetY: 6,
      shadowOffsetYHover: 10,
      cornerRadius: 14,
      cylinderLine: 'rgba(163, 158, 149, 0.18)',
      cylinderLineExternal: 'rgba(255,255,255,0.03)',
    },
    component: {
      fill: '#211F1C',
      fillExternal: '#1C1A17',
      stroke: '#3B362F',
      strokeWidth: 1,
      strokeSelected: '#E89456',
      strokeHover: '#46423C',
      strokeConnected: '#E89456',
      icon: '#8F8A81', // --color-c4-component (dark)
      iconExternal: '#8F8A81',
      text: '#F2F0EC',
      textExternal: '#B4AFA7',
      description: '#837E75',
      descriptionExternal: '#837E75',
      badgeBg: '#2A2724',
      badgeText: '#C7C2BA',
      shadowColor: 'rgba(0, 0, 0, 0.5)',
      shadowColorExternal: 'rgba(0, 0, 0, 0.28)',
      shadowBlur: 20,
      shadowBlurHover: 28,
      shadowOffsetY: 6,
      shadowOffsetYHover: 10,
      cornerRadius: 14,
      cylinderLine: 'rgba(255,255,255,0.06)',
      cylinderLineExternal: 'rgba(255,255,255,0.03)',
    },
  },
  groups: {
    parentWrapperFill: 'rgba(22, 21, 19, 0.4)',
    standardFillAlpha: 0.3,
    standardStrokeAlpha: 0.5,
    standardStrokeSelectedAlpha: 0.9,
    label: '#8F8A81',
    labelAlpha: 0.8,
    icon: '#8F8A81',
    description: '#8F8A81',
    typeLabel: '#6E6960',
    navColor: '#8F8A81',
    navColorHover: '#E89456',
    expandColor: '#8F8A81',
    expandColorHover: '#E89456',
    linkColor: '#6E6960',
    backText: '#E89456',
  },
  connections: {
    normal: '#46423C', // --color-connection (dark)
    lower: '#332F2A',
    highlight: '#E89456', // --color-connection-highlight (dark)
    hover: '#837E75',
    strokeWidth: 1.6,
    strokeWidthHighlight: 2.5,
    strokeWidthActive: 2.5,
    labelBg: '#161513',
    labelStroke: '#161513',
    labelText: '#8F8A81',
  },
  selection: {
    stroke: '#E89456',
    glow: 'rgba(232, 148, 86, 0.28)', // --shadow-glow (dark)
    glowAlpha: 0.28,
    shadowBlur: 14,
  },
  flow: {
    introduction: '#5FC98C',
    message: '#E89456',
    process: '#E89456',
    information: '#B89DF2',
    conclusion: '#E5806F',
  },
  flowBadgeFallback: '#E89456',
  comments: {
    question: { bg: '#2C2410', border: '#E0A24B', text: '#E0A24B' },
    inaccuracy: { bg: '#2C1614', border: '#E5806F', text: '#E5806F' },
    idea: { bg: '#271F3A', border: '#B89DF2', text: '#C4B5FD' },
  },
  resizeHandles: {
    fill: '#161513',
    stroke: '#E89456',
    strokeHover: '#F0A268',
  },
  anchors: {
    color: '#46423C',
    colorHover: '#837E75',
    colorHighlighted: '#E89456',
    colorLower: '#332F2A',
    stroke: '#161513',
  },
  copyCursor: {
    sizeColor: '#E89456',
    styleColor: '#B89DF2',
    text: '#ffffff',
  },
  bottomBar: {
    height: 4,
    cornerRadius: 8,
    opacity: 1,
    technology: {
      React: '#61DAFB',
      'Node.js': '#3FA13F',
      'Socket.io': '#9CA3AF',
      'Firebase Auth': '#FFCA28',
      S3: '#FF9900',
      PostgreSQL: '#5B91C9',
      Redis: '#F0584B',
      'Pub/Sub': '#5C9DFF',
      Go: '#22C7E8',
      'Cloud Scheduler': '#5C9DFF',
    },
    status: {
      live: '#5FC98C',
      draft: '#6E6960',
      down: '#E5806F',
      unstable: '#E89456',
    },
    tagColorMode: 'original',
    tagColors: [],
  },
  connectionAnimation: CLEAN_ANIM,
  // LIT (PBR) flagship, night-studio variant: a dimmer, slightly cooler key
  // over the dark stone board; fill stays warm so the maquette never goes cold.
  three: {
    floorBg: '#242019',
    floorGrid: '#413828',
    environment: {
      background: { top: '#2A2521', bottom: '#171412' },
      lighting: {
        preset: 'studio',
        exposure: 1.05,
        sun: { color: '#FFD3A0', intensity: 1.7, azimuthDeg: -55, elevationDeg: 38 },
        ambient: { skyColor: '#3A342C', groundColor: '#191410', intensity: 0.68 },
        ibl: { intensity: 0.3 },
        shadows: { enabled: true, opacity: 0.66, mapSize: 2048 },
        material: { roughness: 0.62, metalness: 0, clearcoat: 0.22 },
        bloom: { strength: 0.4, threshold: 0.85 },
      },
    },
  },
  renderStyle: {
    mode: 'default',
    fontFamily: 'Inter',
    solidExternal: true, // external = quieter background, not the classic alpha fade
  },
}
