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
import type { ResolvedTheme } from '../stores/themeStore'
import { defaultSkin } from './defaultSkin'
import { defaultSkinDark } from './defaultSkinDark'
import { studioSkin } from './studioSkin'
import { studioSkinDark } from './studioSkinDark'
import { slateSkin } from './slateSkin'
import { slateSkinDark } from './slateSkinDark'
import { cyberpunkSkin } from './cyberpunkSkin'
import { cyberpunkSkinLight } from './cyberpunkSkinLight'
import { eightBitSkin } from './eightBitSkin'
import { eightBitSkinDark } from './eightBitSkinDark'
import { graffitiSkin } from './graffitiSkin'
import { graffitiSkinDark } from './graffitiSkinDark'

/**
 * Per-theme appearance variants for the built-in skins. The skin store consults
 * this when resolving a diagram's skin so the canvas follows the app theme:
 * a light app shows the `light` config, a dark app shows the `dark` config.
 *
 * A skin that only provides one variant (community themes, or any skin missing
 * from this map) falls back to its single config — i.e. "if only one is provided
 * it is used for both".
 */
export interface SkinVariantPair {
  light: SkinConfig
  dark: SkinConfig
}

export const skinVariants: Record<string, SkinVariantPair> = {
  default: { light: defaultSkin, dark: defaultSkinDark },
  studio: { light: studioSkin, dark: studioSkinDark },
  slate: { light: slateSkin, dark: slateSkinDark },
  cyberpunk: { light: cyberpunkSkinLight, dark: cyberpunkSkin },
  eightbit: { light: eightBitSkin, dark: eightBitSkinDark },
  graffiti: { light: graffitiSkin, dark: graffitiSkinDark },
}

/**
 * Pick the appearance variant of `base` that matches `theme`. If the skin has a
 * registered variant pair, return the matching one; otherwise (community/custom
 * skins, or anything without a pair) return `base` unchanged.
 */
export function resolveSkinForTheme(base: SkinConfig, theme: ResolvedTheme): SkinConfig {
  const pair = skinVariants[base.id]
  if (!pair) return base
  return theme === 'dark' ? pair.dark : pair.light
}
