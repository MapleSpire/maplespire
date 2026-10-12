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

import type { SkinConfig, SkinDefinition, SkinRarity } from './types'
import { getAllPlugins, getPlugin, getPluginConfig } from '../plugins/registry'
import type { ThemePlugin } from '../plugins/types'

/**
 * Backwards-compatible skin lookup API. These functions used to read a
 * compile-time `Map` of the four built-in skins; they now delegate to the
 * runtime plugin registry (`src/plugins/registry.ts`) so community plugins
 * registered at runtime resolve through the same paths. The public signatures
 * are unchanged for existing consumers (skinStore, RightSidebar, ShopModal,
 * SkinCard).
 */

function toDefinition(plugin: ThemePlugin): SkinDefinition {
  const { manifest, config } = plugin
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    rarity: manifest.rarity ?? config.rarity,
    price: manifest.price ?? config.price,
    config,
  }
}

export function getSkinById(id: string): SkinConfig | undefined {
  return getPluginConfig(id)
}

export function getAllSkins(): SkinConfig[] {
  return getAllPlugins().map((p) => p.config)
}

/** Definitions for the official ("Shop") tab — every built-in except `default`. */
export function getShopSkins(): SkinDefinition[] {
  return getAllPlugins()
    .filter((p) => p.manifest.source === 'builtin' && p.manifest.id !== 'default')
    .map(toDefinition)
}

/** All skin definitions, derived from the registry. */
export const skinDefinitions: SkinDefinition[] = getAllPlugins().map(toDefinition)

/** Resolve a single plugin's definition, or undefined if not registered. */
export function getSkinDefinition(id: string): SkinDefinition | undefined {
  const plugin = getPlugin(id)
  return plugin ? toDefinition(plugin) : undefined
}

export const rarityColors: Record<SkinRarity, string> = {
  common: '#9CA3AF',
  uncommon: '#22C55E',
  rare: '#3B82F6',
  epic: '#A855F7',
  legendary: '#F59E0B',
}

export const rarityLabels: Record<SkinRarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
}
