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

import type { VersionManifest } from '../automerge/landscapeVersions'
import { apiFetch } from '../api/http'

/**
 * REST client for the landscape-version registry (mirrors `src/lib/share/api.ts`).
 * The server stores the head-manifest opaquely; capture/restore are client-side.
 */

import { API_BASE } from '../api/base'

export interface LandscapeVersionMeta {
  id: string
  landscapeId: string
  label: string
  kind: string
  createdAt: string
}

export interface LandscapeVersionFull extends LandscapeVersionMeta {
  manifest: VersionManifest
}

function base(landscapeId: string): string {
  // Head-manifest "snapshots" (a parked feature). Editable VERSIONS live at
  // /versions and are served by src/lib/landscapes/api.ts.
  return `${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/snapshots`
}

export async function listVersions(landscapeId: string): Promise<LandscapeVersionMeta[]> {
  const res = await apiFetch(base(landscapeId))
  if (!res.ok) throw new Error(`list versions failed: HTTP ${res.status}`)
  return ((await res.json()) as { versions: LandscapeVersionMeta[] }).versions
}

export async function createVersion(
  landscapeId: string,
  label: string,
  manifest: VersionManifest,
  kind = 'named'
): Promise<LandscapeVersionMeta> {
  const res = await apiFetch(base(landscapeId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, kind, manifest }),
  })
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}))
    throw new Error((msg as { error?: string }).error ?? `create version failed: HTTP ${res.status}`)
  }
  return ((await res.json()) as { version: LandscapeVersionMeta }).version
}

export async function getVersion(landscapeId: string, id: string): Promise<LandscapeVersionFull> {
  const res = await apiFetch(`${base(landscapeId)}/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`get version failed: HTTP ${res.status}`)
  return ((await res.json()) as { version: LandscapeVersionFull }).version
}

export async function deleteVersion(landscapeId: string, id: string): Promise<boolean> {
  const res = await apiFetch(`${base(landscapeId)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`delete version failed: HTTP ${res.status}`)
  return ((await res.json()) as { success: boolean }).success
}
