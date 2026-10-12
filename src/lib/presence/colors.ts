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

export interface PresenceAppearance {
  background: string
  foreground: string
}

interface PaletteAppearance extends PresenceAppearance {
  hue: number
  lightnessTier: number
}

export const PRESENCE_PALETTE_SIZE = 100
const GOLDEN_ANGLE = 137.507764
const PRESENCE_LIGHTNESS = [
  'var(--presence-lightness-1, 66%)',
  'var(--presence-lightness-2, 71%)',
  'var(--presence-lightness-3, 75%)',
] as const

/**
 * One hundred calm collaboration colors, distributed around the hue wheel by
 * the golden angle and across three tightly controlled pastel lightness tiers.
 * Theme tokens tune the whole palette for light/dark mode without turning it
 * into the greys used by C4 semantic colors.
 */
export const PRESENCE_APPEARANCES: readonly PaletteAppearance[] = Array.from(
  { length: PRESENCE_PALETTE_SIZE },
  (_, index) => {
    const hue = (index * GOLDEN_ANGLE) % 360
    const lightnessTier = index % 3
    return {
      background: `hsl(${hue.toFixed(2)}deg var(--presence-saturation) ${PRESENCE_LIGHTNESS[lightnessTier]})`,
      foreground: 'var(--presence-on-color)',
      hue,
      lightnessTier,
    }
  },
)

function presenceHash(participantId: string): number {
  let hash = 0
  for (let index = 0; index < participantId.length; index += 1) {
    hash = Math.imul(hash ^ participantId.charCodeAt(index), 0x45d9f3b) >>> 0
  }
  return hash
}

function paletteDistance(left: PaletteAppearance, right: PaletteAppearance): number {
  const hueDelta = Math.abs(left.hue - right.hue)
  const circularHueDistance = Math.min(hueDelta, 360 - hueDelta)
  return circularHueDistance + Math.abs(left.lightnessTier - right.lightnessTier) * 12
}

export function presenceAppearance(participantId: string): PresenceAppearance {
  return PRESENCE_APPEARANCES[presenceHash(participantId) % PRESENCE_APPEARANCES.length]
}

export function assignPresenceAppearances(
  participantIds: readonly string[],
): ReadonlyMap<string, PresenceAppearance> {
  const assignments = new Map<string, PresenceAppearance>()
  const used = new Set<number>()
  const uniqueIds = [...new Set(participantIds)].sort()

  for (const participantId of uniqueIds) {
    const preferred = presenceHash(participantId) % PRESENCE_APPEARANCES.length
    let paletteIndex = preferred

    if (used.size > 0 && used.size < PRESENCE_APPEARANCES.length) {
      let bestScore = -1
      let bestTieBreak = Number.POSITIVE_INFINITY
      for (let candidate = 0; candidate < PRESENCE_APPEARANCES.length; candidate += 1) {
        if (used.has(candidate)) continue
        let score = Number.POSITIVE_INFINITY
        for (const assigned of used) {
          score = Math.min(score, paletteDistance(
            PRESENCE_APPEARANCES[candidate],
            PRESENCE_APPEARANCES[assigned],
          ))
        }
        const clockwise = (candidate - preferred + PRESENCE_APPEARANCES.length)
          % PRESENCE_APPEARANCES.length
        if (score > bestScore || (score === bestScore && clockwise < bestTieBreak)) {
          paletteIndex = candidate
          bestScore = score
          bestTieBreak = clockwise
        }
      }
    } else if (used.size >= PRESENCE_APPEARANCES.length) {
      paletteIndex = preferred
    }

    used.add(paletteIndex)
    assignments.set(participantId, PRESENCE_APPEARANCES[paletteIndex])
  }

  return assignments
}

export function presenceColor(participantId: string): string {
  return presenceAppearance(participantId).background
}
