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
import { c4Node, c4Skin } from './c4Skin'

const ACCENT = '#FBBF24' // amber, one step brighter for the night canvas
const ON_DARK = '#FFFFFF'
const ON_DARK_SUB = 'rgba(255, 255, 255, 0.80)'
const ON_LIGHT = '#0A1F38'
const ON_LIGHT_SUB = 'rgba(10, 31, 56, 0.78)'
const GREY_INK = '#0F1722'
const GREY_INK_SUB = 'rgba(15, 23, 34, 0.74)'
const SHADOW = 'rgba(0, 0, 0, 0.55)'
const SHADOW_EXTERNAL = 'rgba(0, 0, 0, 0.35)'

/**
 * Dark variant of "C4 Model" (id 'c4'). The same C4 hue ladder — Person
 * darkest, Component lightest — lifted a step so the darkest blues still
 * separate from a deep navy canvas, with brighter borders carrying the edge.
 * The glyph disc turns light here because the engine prints the type letter
 * in the (dark) label background colour.
 */
export const c4SkinDark: SkinConfig = {
  ...c4Skin,
  appearance: 'dark',
  canvas: {
    bg: '#0B1220',
    grid: '#1A2538',
  },
  objects: {
    actor: c4Node({
      fill: '#0D4C8E',
      fillExternal: '#4A525D',
      stroke: '#3A7FCB',
      text: ON_DARK,
      textExternal: ON_DARK,
      description: ON_DARK_SUB,
      descriptionExternal: ON_DARK_SUB,
      icon: 'rgba(255, 255, 255, 0.86)',
      iconExternal: 'rgba(255, 255, 255, 0.80)',
      badgeBg: 'rgba(255, 255, 255, 0.14)',
      badgeText: '#EDF3FA',
      shadowColor: SHADOW,
      shadowColorExternal: SHADOW_EXTERNAL,
      strokeSelected: ACCENT,
      strokeHover: '#6AAAF0',
      cornerRadius: 12,
    }),
    system: c4Node({
      fill: '#1667BA',
      fillExternal: '#636C78',
      stroke: '#4F94DE',
      text: ON_DARK,
      textExternal: ON_DARK,
      description: ON_DARK_SUB,
      descriptionExternal: ON_DARK_SUB,
      icon: 'rgba(255, 255, 255, 0.86)',
      iconExternal: 'rgba(255, 255, 255, 0.80)',
      badgeBg: 'rgba(255, 255, 255, 0.14)',
      badgeText: '#EDF3FA',
      shadowColor: SHADOW,
      shadowColorExternal: SHADOW_EXTERNAL,
      strokeSelected: ACCENT,
      strokeHover: '#7DB6F2',
      cornerRadius: 10,
    }),
    app: c4Node({
      fill: '#3B82CC',
      fillExternal: '#8C95A1',
      stroke: '#73ADEA',
      text: ON_DARK,
      textExternal: GREY_INK,
      description: ON_DARK_SUB,
      descriptionExternal: GREY_INK_SUB,
      icon: 'rgba(255, 255, 255, 0.88)',
      iconExternal: 'rgba(255, 255, 255, 0.85)',
      badgeBg: 'rgba(255, 255, 255, 0.16)',
      badgeText: '#F4F8FD',
      shadowColor: SHADOW,
      shadowColorExternal: SHADOW_EXTERNAL,
      strokeSelected: ACCENT,
      strokeHover: '#A2CBF5',
      cornerRadius: 10,
    }),
    store: c4Node({
      fill: '#3B82CC',
      fillExternal: '#8C95A1',
      stroke: '#73ADEA',
      text: ON_DARK,
      textExternal: GREY_INK,
      description: ON_DARK_SUB,
      descriptionExternal: GREY_INK_SUB,
      icon: 'rgba(255, 255, 255, 0.88)',
      iconExternal: 'rgba(255, 255, 255, 0.85)',
      badgeBg: 'rgba(255, 255, 255, 0.16)',
      badgeText: '#F4F8FD',
      shadowColor: SHADOW,
      shadowColorExternal: SHADOW_EXTERNAL,
      strokeSelected: ACCENT,
      strokeHover: '#A2CBF5',
      cornerRadius: 10,
    }),
    component: c4Node({
      fill: '#7AB2EA',
      fillExternal: '#B3BBC5',
      stroke: '#A6CDF4',
      text: ON_LIGHT,
      textExternal: GREY_INK,
      description: ON_LIGHT_SUB,
      descriptionExternal: GREY_INK_SUB,
      icon: 'rgba(255, 255, 255, 0.92)',
      iconExternal: 'rgba(255, 255, 255, 0.85)',
      badgeBg: 'rgba(10, 31, 56, 0.12)',
      badgeText: ON_LIGHT,
      shadowColor: SHADOW,
      shadowColorExternal: SHADOW_EXTERNAL,
      strokeSelected: ACCENT,
      strokeHover: '#D2E6FA',
      cornerRadius: 8,
    }),
  },
  groups: {
    parentWrapperFill: 'rgba(90, 166, 242, 0.05)',
    standardFillAlpha: 0.3,
    standardStrokeAlpha: 0.85,
    standardStrokeSelectedAlpha: 1,
    label: '#C9D4E3',
    labelAlpha: 0.95,
    icon: '#93A3B8',
    description: '#8796AB',
    typeLabel: '#7C8BA0',
    navColor: '#7C8BA0',
    navColorHover: '#5AA6F2',
    expandColor: '#7C8BA0',
    expandColorHover: '#5AA6F2',
    linkColor: '#7C8BA0',
    backText: '#5AA6F2',
  },
  connections: {
    normal: '#748196',
    lower: '#2A3548',
    highlight: '#5AA6F2',
    hover: '#B4C2D4',
    strokeWidth: 1.5,
    strokeWidthHighlight: 2.5,
    strokeWidthActive: 2.5,
    labelBg: '#0B1220',
    labelStroke: '#0B1220',
    labelText: '#A9B6C8',
  },
  selection: {
    stroke: ACCENT,
    glow: 'rgba(251, 191, 36, 0.30)',
    glowAlpha: 0.3,
    shadowBlur: 16,
  },
  flow: {
    introduction: '#4ADE80',
    message: '#5AA6F2',
    process: '#5AA6F2',
    information: '#A78BFA',
    conclusion: '#F87171',
  },
  flowBadgeFallback: '#5AA6F2',
  comments: {
    question: { bg: '#2B2410', border: '#F59E0B', text: '#FBBF24' },
    inaccuracy: { bg: '#2C1515', border: '#F87171', text: '#FCA5A5' },
    idea: { bg: '#231C3A', border: '#A78BFA', text: '#C4B5FD' },
  },
  resizeHandles: {
    fill: '#0B1220',
    stroke: '#5AA6F2',
    strokeHover: '#8CC2F7',
  },
  anchors: {
    color: '#5E6C82',
    colorHover: '#93A3B8',
    colorHighlighted: ACCENT,
    colorLower: '#2A3548',
    stroke: '#0B1220',
  },
  copyCursor: {
    sizeColor: '#5AA6F2',
    styleColor: '#A78BFA',
    text: '#FFFFFF',
  },
  bottomBar: {
    ...c4Skin.bottomBar,
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
      live: '#4ADE80',
      draft: '#64748B',
      down: '#F87171',
      unstable: ACCENT,
    },
  },
  // 3D board: the blueprint at night — navy slab, faint blue grid, deep sky.
  three: {
    floorBg: '#111B2C',
    floorGrid: '#22324B',
    floorBorder: '#2C3E5A',
    shadowColor: 'rgba(0, 0, 0, 0.55)',
    platformStroke: '#4A5B74',
    tagBg: '#16233A',
    tagText: '#DCE6F2',
    standeeLight: '#5C9BDD',
    standeeDark: '#1D4F86',
    environment: {
      background: { top: '#101A2C', bottom: '#05090F' },
    },
  },
  renderStyle: {
    ...c4Skin.renderStyle,
    groupHudFill: 'rgba(90, 166, 242, 0.05)',
  },
}
