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

/**
 * REST client for the multi-landscape registry. Editable VERSIONS —
 * each is its own Automerge root — distinct from the parked head-manifest
 * "snapshots" in src/lib/landscapeVersions/api.ts.
 */
import { apiFetch } from '../api/http'

import { API_BASE } from '../api/base'

export interface VersionInfo {
  id: string
  landscapeId: string
  label: string
  rootUrl: string
  parentVersionId: string | null
  createdAt: string
}

export interface LandscapeInfo {
  id: string
  name: string
  defaultVersionId: string | null
  createdAt: string
  versions: VersionInfo[]
}

export async function listLandscapes(): Promise<LandscapeInfo[]> {
  const res = await apiFetch(`${API_BASE}/api/landscapes`)
  if (!res.ok) throw new Error(`list landscapes failed: HTTP ${res.status}`)
  return ((await res.json()) as { landscapes: LandscapeInfo[] }).landscapes
}

export async function createLandscape(name: string): Promise<LandscapeInfo> {
  const res = await apiFetch(`${API_BASE}/api/landscapes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'create landscape'))
  return ((await res.json()) as { landscape: LandscapeInfo }).landscape
}

/** Create a version: empty by default, or a deep copy of `forkFromVersionId`. */
export async function createVersion(
  landscapeId: string,
  label: string,
  forkFromVersionId?: string
): Promise<VersionInfo> {
  const res = await apiFetch(`${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, forkFromVersionId }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'create version'))
  return ((await res.json()) as { version: VersionInfo }).version
}

export async function setDefaultVersion(landscapeId: string, versionId: string): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/default-version`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    }
  )
  if (!res.ok) throw new Error(await errorMessage(res, 'set default version'))
}

export async function renameLandscape(landscapeId: string, name: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'rename landscape'))
}

export async function deleteLandscape(landscapeId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'delete landscape'))
}

export async function renameVersion(landscapeId: string, versionId: string, label: string): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/versions/${encodeURIComponent(versionId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }
  )
  if (!res.ok) throw new Error(await errorMessage(res, 'rename version'))
}

export async function deleteVersion(landscapeId: string, versionId: string): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/versions/${encodeURIComponent(versionId)}`,
    { method: 'DELETE' }
  )
  if (!res.ok) throw new Error(await errorMessage(res, 'delete version'))
}

async function errorMessage(res: Response, action: string): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return (body as { error?: string }).error ?? `${action} failed: HTTP ${res.status}`
}
