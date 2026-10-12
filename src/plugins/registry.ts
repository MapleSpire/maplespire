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
import type { ThemePlugin, PluginSource } from './types'
import { builtinPlugins } from './builtin'

/**
 * Runtime registry of theme plugins: built-ins are registered at boot, and
 * community plugins can be registered/unregistered at runtime without rebuilding.
 */
const plugins = new Map<string, ThemePlugin>()

type Listener = () => void
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l()
}

/** Subscribe to registry changes (register/unregister). Returns an unsubscribe. */
export function subscribePlugins(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Add or replace a plugin (replace is how updates land). */
export function registerPlugin(plugin: ThemePlugin): void {
  plugins.set(plugin.manifest.id, plugin)
  emit()
}

/** Remove a plugin. Built-ins cannot be unregistered. */
export function unregisterPlugin(id: string): void {
  const plugin = plugins.get(id)
  if (!plugin || plugin.manifest.source === 'builtin') return
  plugins.delete(id)
  emit()
}

export function getPlugin(id: string): ThemePlugin | undefined {
  return plugins.get(id)
}

export function getAllPlugins(): ThemePlugin[] {
  return Array.from(plugins.values())
}

export function getPluginsBySource(source: PluginSource): ThemePlugin[] {
  return getAllPlugins().filter((p) => p.manifest.source === source)
}

/** Convenience: the render config for a plugin id, if registered. */
export function getPluginConfig(id: string): SkinConfig | undefined {
  return plugins.get(id)?.config
}

// Register the themes that ship with the app at module load so the registry is
// populated synchronously before any consumer reads it.
for (const plugin of builtinPlugins) {
  plugins.set(plugin.manifest.id, plugin)
}
