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

export interface ObjectContentLayoutInput {
  x: number
  y: number
  width: number
  height: number
  /** Vertical adjustment calculated by the renderer for the available content. */
  contentTop?: number
}

export interface FittedObjectDescription {
  lines: string[]
  fontSize: number
  lineHeight: number
  truncated: boolean
}

interface FitObjectDescriptionInput {
  text: string
  maxWidth: number
  measureText: (text: string, fontSize: number) => number
  maxLines?: number
  baseSize?: number
  minSize?: number
  lineHeightFactor?: number
  maxHeight?: number
}

export const TYPE_BADGE_HEIGHT = 16
export const TYPE_BADGE_BOTTOM_INSET = 4
export const DESCRIPTION_TO_TYPE_BADGE_GAP = 5

function wrapMeasuredText(
  text: string,
  maxWidth: number,
  fontSize: number,
  measureText: FitObjectDescriptionInput['measureText'],
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (measureText(candidate, fontSize) <= maxWidth) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = word
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Fit the compact description with the 2D policy: shrink from 11px to a 9px
 * readability floor, then ellipsize. The 3D surface caps summaries at two lines
 * so perspective never turns a card into a paragraph surface.
 */
export function fitObjectDescription({
  text,
  maxWidth,
  measureText,
  maxLines = 2,
  baseSize = 11,
  minSize = 9,
  lineHeightFactor = 1.15,
  maxHeight = Number.POSITIVE_INFINITY,
}: FitObjectDescriptionInput): FittedObjectDescription {
  const safeWidth = Math.max(1, maxWidth)
  const safeMaxLines = Math.max(1, Math.floor(maxLines))
  const cleanText = text.trim().replace(/\s+/g, ' ')
  if (!cleanText) {
    return { lines: [], fontSize: baseSize, lineHeight: baseSize * lineHeightFactor, truncated: false }
  }

  for (let size = baseSize; size >= minSize; size -= 0.5) {
    const lines = wrapMeasuredText(cleanText, safeWidth, size, measureText)
    if (
      lines.length <= safeMaxLines &&
      lines.length * size * lineHeightFactor <= maxHeight &&
      lines.every((line) => measureText(line, size) <= safeWidth)
    ) {
      return { lines, fontSize: size, lineHeight: size * lineHeightFactor, truncated: false }
    }
  }

  const fontSize = minSize
  const wrapped = wrapMeasuredText(cleanText, safeWidth, fontSize, measureText)
  const lines = wrapped.slice(0, safeMaxLines)
  let last = lines[lines.length - 1] ?? ''
  while (last.length > 0 && measureText(`${last}…`, fontSize) > safeWidth) last = last.slice(0, -1).trimEnd()
  lines[lines.length - 1] = `${last}…`
  return { lines, fontSize, lineHeight: fontSize * lineHeightFactor, truncated: true }
}

/**
 * Renderer-neutral anatomy of a regular MapleSpire object card.
 *
 * The 2D canvas uses Y directly while the 3D board maps it to world Z. Keeping
 * these anchors in one place prevents the two renderers from drifting back to
 * different icon/title/description arrangements.
 */
export function objectContentLayout({
  x,
  y,
  width,
  height,
  contentTop = 0,
}: ObjectContentLayoutInput) {
  const centerX = x + width / 2
  return {
    centerX,
    iconCenterY: y + 22 + contentTop,
    titleTopY: y + 38 + contentTop,
    descriptionTopY: y + 54 + contentTop,
    typeBadgeTopY: y + height - TYPE_BADGE_HEIGHT - TYPE_BADGE_BOTTOM_INSET,
  }
}

export function centeredObjectContentTop({
  height,
  descriptionLines,
  hasBadge,
  titleSize = 13,
  descriptionSize = 11,
}: {
  height: number
  descriptionLines: number
  hasBadge: boolean
  titleSize?: number
  descriptionSize?: number
}): number {
  const blockTop = 12
  const lineHeight = Math.round(descriptionSize * 1.15)
  const blockBottom = descriptionLines > 0
    ? 54 + descriptionLines * lineHeight
    : 38 + titleSize
  const usableHeight = height - 10 - (hasBadge ? TYPE_BADGE_HEIGHT + TYPE_BADGE_BOTTOM_INSET + 8 : 12)
  return Math.max(0, Math.round((usableHeight - (blockBottom - blockTop)) / 2) - 2)
}
