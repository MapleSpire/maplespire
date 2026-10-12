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

import type { SkinConfig } from '../skins/types'
import type { Theme3dSource } from '../canvas3d/specs'
import { sanitizeEnvironment3d, sanitizeFloorSpec3d, sanitizeNodeSpec3d } from '../canvas3d/specs'
import { gateAssetManifest } from '../canvas3d/assetLimits'
import { isDark } from '../canvas3d/palette'
import { getOfficialTheme } from './official/registry'
import { communityThemeFor3d } from './theme3dCommunity'
import { createRng } from './sdk/rng'

/**
 * Resolve the 3D theme surface for a skin: the official plugin's
 * `object3d`/`floor3d` spec builders + the skin's declarative
 * `three.environment` + the meta pixel-snap capability, wrapped behind the
 * pure-data `Theme3dSource` boundary so `Scene3D` never imports plugin code.
 *
 * Every hook result passes the specs.ts sanitizers, and a throwing hook
 * degrades to the derived palette for that item (warned once per theme) —
 * a theme's 3D layer can never take the board down.
 *
 * Community themes: their declarative half (style.three incl. environment)
 * flows through the resolved SkinConfig and is covered here; their CODE hooks
 * execute in the worker sandbox via `resolveTheme3d` below (theme3dCommunity).
 */
export function themeFor3d(skin: SkinConfig): Theme3dSource | null {
  const plugin = getOfficialTheme(skin.id)
  const environment = sanitizeEnvironment3d(skin.three?.environment)
  const pixelSnap = plugin.meta.pixelSnap ?? null
  const assets = gateAssetManifest(plugin.meta.id, plugin.meta.assets)
  const hasHooks = !!plugin.object3d || !!plugin.floor3d
  if (!hasHooks && !environment && pixelSnap == null && !assets) return null

  let warned = false
  const guard = <T>(what: string, run: () => T | null): T | null => {
    try {
      return run()
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn(`theme "${plugin.meta.id}": ${what} hook failed — using the derived 3D look`, err)
      }
      return null
    }
  }
  const anim = () => guard('animate', () => plugin.animate?.(performance.now()) ?? null) ?? {}

  const dark = isDark(skin.canvas.bg)
  return {
    environment,
    pixelSnap,
    themeId: plugin.meta.id,
    assets,
    objectSpec: (args) =>
      plugin.object3d
        ? sanitizeNodeSpec3d(guard('object3d', () => plugin.object3d!({ ...args, type: args.type as never, dark, anim: anim(), rng: createRng })))
        : null,
    floorSpec: (args) =>
      plugin.floor3d
        ? sanitizeFloorSpec3d(guard('floor3d', () => plugin.floor3d!({ ...args, anim: anim(), rng: createRng })))
        : null,
  }
}

/**
 * Resolve a skin's full 3D surface: an installed COMMUNITY plugin runs its
 * hooks in the sandbox worker (async — `onUpdate` fires when specs land, the
 * host re-pushes `source` into the scene); everything else takes the official
 * main-thread path. `dispose` tears the worker down — call it on skin change
 * and on unmount.
 */
export function resolveTheme3d(
  skin: SkinConfig,
  onUpdate: () => void,
): { source: Theme3dSource | null; dispose: () => void } {
  const community = communityThemeFor3d(skin, onUpdate)
  if (community) return { source: community.source, dispose: community.dispose }
  return { source: themeFor3d(skin), dispose: noop }
}

function noop(): void {}
