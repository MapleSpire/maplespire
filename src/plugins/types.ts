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

import type { SkinConfig, SkinRarity } from '../skins/types'

/**
 * Version of the Theme SDK that the host implements. Plugins declare the
 * `sdkVersion` they target; the registry uses this to gate incompatible
 * plugins. Bump the MAJOR when the SDK makes
 * a breaking change to the contract a plugin's render code relies on.
 */
export const SDK_VERSION = '1.0.0'

/** Where a theme plugin comes from. Built-in plugins ship with the app and are
 * trusted; community plugins are authored by users and run sandboxed. */
export type PluginSource = 'builtin' | 'community'

/**
 * Metadata describing a theme plugin, kept separate from the render `config`.
 * This is the part that is shown in the shop, indexed in the gallery, and used
 * for attribution and update checks.
 */
export interface ThemePluginManifest {
  /** Unique id. Community ids are namespaced: `community:<authorId>:<slug>`. */
  id: string
  name: string
  description: string
  /** Display name of the author (e.g. "MapleSpire" for built-ins). */
  author: string
  /** Stable author identity. `official` for built-ins; a `clientId` for community. */
  authorId: string
  /** Semver of this plugin release. */
  version: string
  /** Semver of the Theme SDK this plugin targets. See {@link SDK_VERSION}. */
  sdkVersion: string
  createdAt: number
  source: PluginSource
  /** Shop rarity. Reserved for built-ins in v1; community themes may set it later. */
  rarity?: SkinRarity
  /** Price in V-Bux. 0/undefined means free. */
  price?: number
}

/**
 * A theme plugin = its manifest plus the declarative render config: a pure-data
 * {@link SkinConfig} (the existing skin shape).
 */
export interface ThemePlugin {
  manifest: ThemePluginManifest
  config: SkinConfig
}
