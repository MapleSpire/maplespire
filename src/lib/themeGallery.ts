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
import type { ThemePlugin } from '../plugins/sdk/contract'
import { SDK_VERSION } from '../plugins/types'
import { installCommunityTheme } from '../plugins/community/registry'
import { apiFetch } from './api/http'

export { compareSemver, isSdkCompatible } from '../plugins/sdk/version'

/**
 * Client for the community theme gallery. Publish/browse/install
 * community themes via the server. Theme `code` is only ever executed in the
 * worker sandbox — never trusted here or on the server.
 */

import { API_BASE } from './api/base'

const API_BASE_URL = API_BASE

export interface GalleryTheme {
  id: string
  name: string
  author: string
  version: string
  sdkVersion: string
  code: string
  baseConfig: SkinConfig
  price: number
  installs: number
  createdAt: string
  updatedAt: string
}

export interface PublishInput {
  id: string
  name: string
  author: string
  version: string
  code: string
  baseConfig: SkinConfig
  price: number
}

export async function fetchGalleryThemes(): Promise<GalleryTheme[]> {
  const res = await apiFetch(`${API_BASE_URL}/api/themes`)
  if (!res.ok) throw new Error(`Gallery unavailable (${res.status})`)
  const data = (await res.json()) as { themes?: GalleryTheme[] }
  return data.themes ?? []
}

export async function publishGalleryTheme(input: PublishInput): Promise<GalleryTheme> {
  const res = await apiFetch(`${API_BASE_URL}/api/themes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, sdkVersion: SDK_VERSION }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Publish failed (${res.status})`)
  }
  return ((await res.json()) as { theme: GalleryTheme }).theme
}

/** A gallery theme as the runtime ThemePlugin the sandbox/preview consume. */
export function galleryThemeToPlugin(theme: GalleryTheme): ThemePlugin {
  return {
    code: theme.code,
    meta: { id: theme.id, name: theme.name, version: theme.version, trust: 'community', sdkVersion: theme.sdkVersion },
  }
}

/** Install a gallery theme locally so it's selectable like any skin. */
export function installGalleryTheme(theme: GalleryTheme): void {
  installCommunityTheme(galleryThemeToPlugin(theme), theme.baseConfig)
  void apiFetch(`${API_BASE_URL}/api/themes/${encodeURIComponent(theme.id)}/install`, { method: 'POST' }).catch(() => {})
}

/** Report a theme for moderation (auto-hidden server-side past a threshold). */
export async function reportGalleryTheme(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE_URL}/api/themes/${encodeURIComponent(id)}/report`, { method: 'POST' })
  if (!res.ok) throw new Error(`Report failed (${res.status})`)
}
