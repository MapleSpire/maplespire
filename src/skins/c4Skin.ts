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
import { C4_ANIM } from './connectionAnimation'

type ObjectSkin = SkinConfig['objects']['actor']

/**
 * One C4 element style. Internal elements are the C4 blues, external ones the
 * C4 greys; the theme hook (`c4.theme.ts`) shades both with a top-lit gradient
 * and derives the resting border of a grey external from its own fill.
 */
export function c4Node(spec: {
  fill: string
  fillExternal: string
  stroke: string
  text: string
  textExternal: string
  description: string
  descriptionExternal: string
  icon: string
  iconExternal: string
  badgeBg: string
  badgeText: string
  shadowColor: string
  shadowColorExternal: string
  strokeSelected: string
  strokeHover: string
  cornerRadius: number
}): ObjectSkin {
  return {
    fill: spec.fill,
    fillExternal: spec.fillExternal,
    stroke: spec.stroke,
    strokeWidth: 1,
    strokeSelected: spec.strokeSelected,
    strokeHover: spec.strokeHover,
    strokeConnected: spec.strokeSelected,
    icon: spec.icon,
    iconExternal: spec.iconExternal,
    text: spec.text,
    textExternal: spec.textExternal,
    description: spec.description,
    descriptionExternal: spec.descriptionExternal,
    badgeBg: spec.badgeBg,
    badgeText: spec.badgeText,
    shadowColor: spec.shadowColor,
    shadowColorExternal: spec.shadowColorExternal,
    shadowBlur: 12,
    shadowBlurHover: 20,
    shadowOffsetY: 4,
    shadowOffsetYHover: 8,
    cornerRadius: spec.cornerRadius,
    cylinderLine: 'rgba(255, 255, 255, 0.45)',
    cylinderLineExternal: 'rgba(255, 255, 255, 0.35)',
  }
}

const ACCENT = '#F59E0B' // amber: the selection reads on every C4 blue and grey
const ON_DARK = '#FFFFFF'
const ON_DARK_SUB = 'rgba(255, 255, 255, 0.84)'
const ON_LIGHT = '#0B2545'
const ON_LIGHT_SUB = 'rgba(11, 37, 69, 0.78)'
const GREY_INK = '#18212C'
const GREY_INK_SUB = 'rgba(24, 33, 44, 0.74)'
const BLUE_SHADOW = 'rgba(8, 66, 123, 0.26)'
const GREY_SHADOW = 'rgba(40, 46, 54, 0.18)'

/**
 * "C4 Model" — the canonical C4 notation colours (Simon Brown's C4 model, as
 * drawn by Structurizr and C4-PlantUML): Person #08427B, Software System
 * #1168BD, Container #438DD5, Component #85BBF0, externals in grey — with
 * actors drawn as the C4 Person figure (`renderStyle.actorShape`), boundaries
 * as dashed frames, and top-lit gradient elements (see `c4.theme.ts`).
 *
 * Deliberate departures from the raw notation, for legibility: the external
 * greys are cool-toned and the lighter ones (container, component) carry dark
 * ink instead of white, so every title keeps a readable contrast. Light
 * variant; `c4SkinDark` is the dark counterpart (resolved via `skinVariants`).
 */
export const c4Skin: SkinConfig = {
  id: 'c4',
  name: 'C4 Model',
  description:
    'The classic C4 notation — Person, Software System, Container and Component blues, external greys, the person figure and dashed boundaries.',
  rarity: 'rare',
  price: 0,
  appearance: 'light',
  canvas: {
    bg: '#F6F8FB',
    grid: '#DCE3EC',
  },
  objects: {
    // C4 Person — the darkest blue; drawn as the head-and-shoulders figure.
    actor: c4Node({
      fill: '#08427B',
      fillExternal: '#5B6470',
      stroke: '#05325E',
      text: ON_DARK,
      textExternal: ON_DARK,
      description: ON_DARK_SUB,
      descriptionExternal: ON_DARK_SUB,
      icon: 'rgba(255, 255, 255, 0.24)',
      iconExternal: 'rgba(255, 255, 255, 0.24)',
      badgeBg: 'rgba(255, 255, 255, 0.16)',
      badgeText: '#EDF3FA',
      shadowColor: BLUE_SHADOW,
      shadowColorExternal: GREY_SHADOW,
      strokeSelected: ACCENT,
      strokeHover: '#3D8BE0',
      cornerRadius: 12,
    }),
    // C4 Software System.
    system: c4Node({
      fill: '#1168BD',
      fillExternal: '#7A838F',
      stroke: '#0B4C8C',
      text: ON_DARK,
      textExternal: ON_DARK,
      description: ON_DARK_SUB,
      descriptionExternal: ON_DARK_SUB,
      icon: 'rgba(255, 255, 255, 0.24)',
      iconExternal: 'rgba(255, 255, 255, 0.24)',
      badgeBg: 'rgba(255, 255, 255, 0.16)',
      badgeText: '#EDF3FA',
      shadowColor: BLUE_SHADOW,
      shadowColorExternal: GREY_SHADOW,
      strokeSelected: ACCENT,
      strokeHover: '#5AA2EC',
      cornerRadius: 10,
    }),
    // C4 Container.
    app: c4Node({
      fill: '#438DD5',
      fillExternal: '#AEB6C1',
      stroke: '#2C71B5',
      text: ON_DARK,
      textExternal: GREY_INK,
      description: ON_DARK_SUB,
      descriptionExternal: GREY_INK_SUB,
      icon: 'rgba(255, 255, 255, 0.26)',
      iconExternal: 'rgba(24, 33, 44, 0.55)',
      badgeBg: 'rgba(255, 255, 255, 0.18)',
      badgeText: '#F4F8FD',
      shadowColor: BLUE_SHADOW,
      shadowColorExternal: GREY_SHADOW,
      strokeSelected: ACCENT,
      strokeHover: '#1E6AB8',
      cornerRadius: 10,
    }),
    // C4 Container: database — the same container blue, drawn as a drum.
    store: c4Node({
      fill: '#438DD5',
      fillExternal: '#AEB6C1',
      stroke: '#2C71B5',
      text: ON_DARK,
      textExternal: GREY_INK,
      description: ON_DARK_SUB,
      descriptionExternal: GREY_INK_SUB,
      icon: 'rgba(255, 255, 255, 0.26)',
      iconExternal: 'rgba(24, 33, 44, 0.55)',
      badgeBg: 'rgba(255, 255, 255, 0.18)',
      badgeText: '#F4F8FD',
      shadowColor: BLUE_SHADOW,
      shadowColorExternal: GREY_SHADOW,
      strokeSelected: ACCENT,
      strokeHover: '#1E6AB8',
      cornerRadius: 10,
    }),
    // C4 Component — the lightest blue, dark ink.
    component: c4Node({
      fill: '#85BBF0',
      fillExternal: '#CDD3DB',
      stroke: '#5A9BDC',
      text: ON_LIGHT,
      textExternal: GREY_INK,
      description: ON_LIGHT_SUB,
      descriptionExternal: GREY_INK_SUB,
      icon: '#0B4C8C',
      iconExternal: 'rgba(24, 33, 44, 0.55)',
      badgeBg: 'rgba(11, 37, 69, 0.10)',
      badgeText: ON_LIGHT,
      shadowColor: 'rgba(17, 104, 189, 0.20)',
      shadowColorExternal: GREY_SHADOW,
      strokeSelected: ACCENT,
      strokeHover: '#1168BD',
      cornerRadius: 8,
    }),
  },
  groups: {
    parentWrapperFill: 'rgba(17, 104, 189, 0.035)',
    standardFillAlpha: 0.3,
    standardStrokeAlpha: 0.85,
    standardStrokeSelectedAlpha: 1,
    label: '#2E3B4E',
    labelAlpha: 0.95,
    icon: '#4F5E73',
    description: '#5F6E82',
    typeLabel: '#6B7A8F',
    navColor: '#5F6E82', // the dashed C4 boundary
    navColorHover: '#1168BD',
    expandColor: '#5F6E82',
    expandColorHover: '#1168BD',
    linkColor: '#6B7A8F',
    backText: '#1168BD',
  },
  connections: {
    normal: '#707A88', // C4 relationship grey
    lower: '#C9D1DC',
    highlight: '#1168BD',
    hover: '#3E4A5A',
    strokeWidth: 1.5,
    strokeWidthHighlight: 2.5,
    strokeWidthActive: 2.5,
    labelBg: '#F6F8FB',
    labelStroke: '#F6F8FB',
    labelText: '#4A5668',
  },
  selection: {
    stroke: ACCENT,
    glow: 'rgba(245, 158, 11, 0.32)',
    glowAlpha: 0.32,
    shadowBlur: 14,
  },
  flow: {
    introduction: '#16A34A',
    message: '#1168BD',
    process: '#1168BD',
    information: '#7C3AED',
    conclusion: '#DC2626',
  },
  flowBadgeFallback: '#1168BD',
  comments: {
    question: { bg: '#FEF3C7', border: '#D97706', text: '#92400E' },
    inaccuracy: { bg: '#FEE2E2', border: '#DC2626', text: '#991B1B' },
    idea: { bg: '#EDE9FE', border: '#7C3AED', text: '#5B21B6' },
  },
  resizeHandles: {
    fill: '#FFFFFF',
    stroke: '#1168BD',
    strokeHover: '#08427B',
  },
  anchors: {
    color: '#8A96A6',
    colorHover: '#4F5E73',
    colorHighlighted: ACCENT,
    colorLower: '#C9D1DC',
    stroke: '#FFFFFF',
  },
  copyCursor: {
    sizeColor: '#1168BD',
    styleColor: '#7C3AED',
    text: '#FFFFFF',
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
      draft: '#94A3B8',
      down: '#EF4444',
      unstable: ACCENT,
    },
    tagColorMode: 'original',
    tagColors: [],
  },
  connectionAnimation: C4_ANIM,
  // 3D board: a blueprint table — cool paper slab under a pale blue sky; the
  // C4 blues extrude as their own walls (derived from each element's fill).
  three: {
    floorBg: '#EEF3F9',
    floorGrid: '#C3D1E3',
    floorBorder: '#AFC0D6',
    shadowColor: 'rgba(8, 66, 123, 0.24)',
    platformStroke: '#7F90A6',
    tagBg: '#FFFFFF',
    tagText: '#0B2545',
    standeeLight: '#6FA8E3',
    standeeDark: '#2C6CB0',
    environment: {
      background: { top: '#F7FAFD', bottom: '#D8E3F0' },
    },
  },
  renderStyle: {
    mode: 'default',
    fontFamily: 'Inter',
    solidExternal: true, // C4 externals are solid greys, not faded blues
    actorShape: 'person',
    // Boundary wash under the dashed C4 frame (read by the theme's group hook).
    groupHudFill: 'rgba(17, 104, 189, 0.035)',
  },
}
