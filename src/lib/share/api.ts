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

import { currentWorkspaceRef } from '../automerge/workspace'
import { apiFetch } from '../api/http'
import type { ShareSnapshot, ShareLinkMeta, ShareMode, ShareScope, ShareAudience } from './types'

import { API_BASE } from '../api/base'

export interface CreateShareRequest {
  mode: ShareMode
  scope: ShareScope
  diagramId: string | null
  limitToDiagram: boolean
  checkpointId?: string | null
  checkpointLabel?: string | null
  heads?: string[] | null
  snapshot: ShareSnapshot
  audience?: ShareAudience
  allowedEmailDomain?: string | null
  /** Whether visitors may switch the viewer to the 3D board (default true). */
  allow3d?: boolean
}

export interface CreateShareResult {
  token: string
  url: string | null
  share: ShareLinkMeta
}

/**
 * Every created share is tagged with the workspace it was made FROM
 * (`landscapeId`/`versionId`, read from `currentWorkspaceRef()`), so `app_sharelink`
 * capability tokens resolve back to the right (org, landscape, version). Folded in
 * here (not at each call site) so every caller gets it automatically.
 */
export async function createShare(req: CreateShareRequest): Promise<CreateShareResult> {
  const ref = currentWorkspaceRef()
  const res = await apiFetch(`${API_BASE}/api/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, landscapeId: ref.landscapeId, versionId: ref.versionId }),
  })
  if (!res.ok) throw new Error(`Failed to create share: HTTP ${res.status}`)
  return res.json()
}

export async function listShares(diagramId?: string): Promise<ShareLinkMeta[]> {
  const url = diagramId
    ? `${API_BASE}/api/shares?diagramId=${encodeURIComponent(diagramId)}`
    : `${API_BASE}/api/shares`
  const res = await apiFetch(url)
  if (!res.ok) throw new Error(`Failed to list shares: HTTP ${res.status}`)
  const data = (await res.json()) as { shares: ShareLinkMeta[] }
  return data.shares
}

export interface ShareFetchResult {
  snapshot: ShareSnapshot
  mode: ShareMode
  checkpointLabel: string | null
  updatedAt: string
  /** Absent from older servers → treat as true (the column defaults true too). */
  allow3d?: boolean
}

/** Discriminated outcome so the viewer can tell apart "gone", "restricted"
 * (needs sign-in or the caller lacks access) and a transient error. */
export type ShareFetchOutcome =
  | { kind: 'ok'; result: ShareFetchResult }
  | { kind: 'notfound' }
  | { kind: 'restricted'; needsAuth: boolean; audience: ShareAudience | null }
  | { kind: 'error' }

/** Public fetch (anonymous-by-design for public shares; org/domain shares gate on
 * the session cookie apiFetch rides along). Never throws — returns a discriminated
 * outcome the viewer branches on. */
export async function getShare(token: string): Promise<ShareFetchOutcome> {
  try {
    const res = await apiFetch(`${API_BASE}/api/shares/${encodeURIComponent(token)}`)
    if (res.status === 404) return { kind: 'notfound' }
    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { audience?: ShareAudience }
      return { kind: 'restricted', needsAuth: res.status === 401, audience: body.audience ?? null }
    }
    if (!res.ok) return { kind: 'error' }
    return { kind: 'ok', result: (await res.json()) as ShareFetchResult }
  } catch {
    return { kind: 'error' }
  }
}

export interface UpdateShareRequest {
  enabled?: boolean
  limitToDiagram?: boolean
  mode?: ShareMode
  scope?: ShareScope
  checkpointId?: string | null
  checkpointLabel?: string | null
  heads?: string[] | null
  snapshot?: ShareSnapshot
  audience?: ShareAudience
  allowedEmailDomain?: string | null
  allow3d?: boolean
}

export async function updateShare(token: string, patch: UpdateShareRequest): Promise<ShareLinkMeta> {
  const res = await apiFetch(`${API_BASE}/api/shares/${encodeURIComponent(token)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(`Failed to update share: HTTP ${res.status}`)
  const data = (await res.json()) as { share: ShareLinkMeta }
  return data.share
}

export async function revokeShare(token: string): Promise<boolean> {
  const res = await apiFetch(`${API_BASE}/api/shares/${encodeURIComponent(token)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Failed to revoke share: HTTP ${res.status}`)
  const data = (await res.json()) as { success: boolean }
  return Boolean(data.success)
}
