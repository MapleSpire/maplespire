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

import type { ThemePlugin } from '../sdk/contract'
import type { SkinConfig } from '../../skins/types'
import { registerPlugin } from '../registry'
import { useSkinStore } from '../../stores/skinStore'

/**
 * Runtime registry of installed community theme plugins (the untrusted, worker-run
 * themes). Kept separate from the official registry. Populated by local installs
 * and by the server theme gallery.
 */
const communityThemes = new Map<string, ThemePlugin>()

export function registerCommunityTheme(plugin: ThemePlugin): void {
  communityThemes.set(plugin.meta.id, plugin)
}

export function getCommunityTheme(id: string): ThemePlugin | undefined {
  return communityThemes.get(id)
}

export function getAllCommunityThemes(): ThemePlugin[] {
  return Array.from(communityThemes.values())
}

/**
 * Install a community theme so it is selectable like any other skin: registers
 * the worker-run plugin, a skin-registry entry (so it shows in the picker and
 * provides the base look drawn under the overlay), and marks it installed.
 */
export function installCommunityTheme(plugin: ThemePlugin, baseConfig: SkinConfig): void {
  registerCommunityTheme(plugin)
  registerPlugin({
    manifest: {
      id: plugin.meta.id,
      name: plugin.meta.name,
      description: 'Community theme',
      author: 'community',
      authorId: 'community',
      version: plugin.meta.version,
      sdkVersion: '1.0.0',
      createdAt: 0,
      source: 'community',
    },
    config: baseConfig,
  })
  useSkinStore.getState().installSkin(plugin.meta.id)
}
