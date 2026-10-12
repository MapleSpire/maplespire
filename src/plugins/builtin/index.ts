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

import type { SkinConfig } from '../../skins/types'
import type { ThemePlugin } from '../types'
import { SDK_VERSION } from '../types'
import { defaultSkin } from '../../skins/defaultSkin'
import { studioSkin } from '../../skins/studioSkin'
import { slateSkin } from '../../skins/slateSkin'
import { cyberpunkSkin } from '../../skins/cyberpunkSkin'
import { eightBitSkin } from '../../skins/eightBitSkin'
import { graffitiSkin } from '../../skins/graffitiSkin'

/**
 * Wrap an existing built-in {@link SkinConfig} into a {@link ThemePlugin}. The
 * manifest is derived from the fields already present on the config, so there is
 * no duplicated source of truth. Authored by "MapleSpire" / `official`.
 *
 * `config` is the existing pure-data skin; render-code hooks for official themes
 * live in `plugins/official/*.theme.ts` and are resolved through the Theme SDK.
 */
function builtin(config: SkinConfig): ThemePlugin {
  return {
    manifest: {
      id: config.id,
      name: config.name,
      description: config.description,
      author: 'MapleSpire',
      authorId: 'official',
      version: '1.0.0',
      sdkVersion: SDK_VERSION,
      createdAt: 0,
      source: 'builtin',
      rarity: config.rarity,
      price: config.price,
    },
    config,
  }
}

/** The themes that ship with the app, installed by default. */
export const builtinPlugins: ThemePlugin[] = [
  builtin(defaultSkin),
  builtin(studioSkin),
  builtin(slateSkin),
  builtin(cyberpunkSkin),
  builtin(eightBitSkin),
  builtin(graffitiSkin),
]

/** Id of the universal fallback theme. Never uninstallable. */
export const DEFAULT_PLUGIN_ID = defaultSkin.id
