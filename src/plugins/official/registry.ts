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

import { defineTheme, type ThemePlugin } from '../sdk/contract'
import { defaultSkin } from '../../skins/defaultSkin'
import { studioTheme } from './studio.theme'
import { cyberpunkTheme } from './cyberpunk.theme'
import { eightbitTheme } from './eightbit.theme'
import { graffitiTheme } from './graffiti.theme'

/**
 * Maps a skin id → its official ThemePlugin. The engine resolves a plugin here
 * in setSkin and hands it to the ThemeBridge.
 *
 * `default` has no hooks (the engine's default path renders it). studio carries
 * an `object` hook for the design-system focus treatment (inset border + crisp
 * ring); cyberpunk / 8-bit / graffiti carry `object` hooks (and cyberpunk the
 * animation lifecycle + scan-line overlay); their remaining connection/group
 * effects migrate next.
 */

const defaultTheme = defineTheme({
  meta: { id: defaultSkin.id, name: defaultSkin.name, version: '1.0.0', trust: 'official', mode: 'default' },
  style: { renderStyle: defaultSkin.renderStyle },
})

const officialThemes = new Map<string, ThemePlugin>([
  [defaultTheme.meta.id, defaultTheme],
  [studioTheme.meta.id, studioTheme],
  [cyberpunkTheme.meta.id, cyberpunkTheme],
  [eightbitTheme.meta.id, eightbitTheme],
  [graffitiTheme.meta.id, graffitiTheme],
])

/** Resolve the official theme for a skin id, falling back to the default theme. */
export function getOfficialTheme(id: string): ThemePlugin {
  return officialThemes.get(id) ?? defaultTheme
}
