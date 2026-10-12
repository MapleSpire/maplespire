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
 * REST client for Drafts. A draft is a forked version (kind='draft') of a
 * landscape's default version, edited in isolation; switching into it reuses the
 * ordinary workspace switch (its id is a versionId). Also covers the draft's
 * diff against its parent and its merge.
 */
import { apiFetch } from '../api/http'

import { API_BASE } from '../api/base'

export type DraftStatus = 'active' | 'merged' | 'discarded' | 'archived'

export interface DraftInfo {
  id: string
  landscapeId: string
  label: string
  rootUrl: string
  parentVersionId: string | null
  status: DraftStatus
  createdAt: string
}

export async function listDrafts(landscapeId: string): Promise<DraftInfo[]> {
  const res = await apiFetch(`${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/drafts`)
  if (!res.ok) throw new Error(`list drafts failed: HTTP ${res.status}`)
  return ((await res.json()) as { drafts: DraftInfo[] }).drafts
}

export async function createDraft(landscapeId: string, label: string): Promise<DraftInfo> {
  const res = await apiFetch(`${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, 'create draft'))
  return ((await res.json()) as { draft: DraftInfo }).draft
}

export async function setDraftStatus(
  landscapeId: string,
  draftId: string,
  status: DraftStatus
): Promise<void> {
  const res = await apiFetch(
    `${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/drafts/${encodeURIComponent(draftId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }
  )
  if (!res.ok) throw new Error(await errorMessage(res, 'update draft'))
}

// --- Changes: the draft's 3-way diff vs its parent ---

export type ChangeKind = 'created' | 'updated' | 'deleted'
export type ChangeCollection =
  | 'object' | 'connection' | 'group' | 'domain' | 'tag' | 'decisionRecord'
  | 'diagram' | 'layout' | 'flow'
export type ConflictKind = 'update/update' | 'update/delete' | 'delete/update' | 'unresolved'

export interface DraftChange {
  kind: ChangeKind
  collection: ChangeCollection
  id: string
  label: string
  diagramId?: string
}
/** A single differing field between the draft's value (mine) and the live model's (live). */
export interface ConflictDetail {
  field: string
  mine: string
  live: string
}

export interface DraftConflict {
  kind: ConflictKind
  collection: ChangeCollection
  id: string
  label: string
  diagramId?: string
  /** The fields that differ between mine (draft) and live — shown in the resolve UI. */
  details?: ConflictDetail[]
}
export interface DraftChanges {
  changes: DraftChange[]
  conflicts: DraftConflict[]
  counts: { model: number; diagrams: number; conflicts: number }
}

export async function getDraftChanges(landscapeId: string, draftId: string): Promise<DraftChanges> {
  const res = await apiFetch(
    `${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/drafts/${encodeURIComponent(draftId)}/changes`
  )
  if (!res.ok) throw new Error(`get draft changes failed: HTTP ${res.status}`)
  return (await res.json()) as DraftChanges
}

export type MergeResult =
  | { ok: true; versionId: string }
  | { ok: false; conflicts: DraftConflict[]; error?: string }

/** Per-conflict choice when merging: keep the draft's change, or keep the live value. */
export type ConflictResolution = 'draft' | 'live'

/** Merge a draft into the live model, applying optional per-conflict resolutions (keyed
 * by `${collection}:${id}:${diagramId}`). On HTTP 409 returns ok:false with either the
 * still-blocking conflicts (the red "Merge conflicts" path) or an `error` message (e.g.
 * the draft's base version moved). Other failures surface as ok:false with an `error`. */
export async function mergeDraft(
  landscapeId: string,
  draftId: string,
  resolutions: Record<string, ConflictResolution> = {}
): Promise<MergeResult> {
  const res = await apiFetch(
    `${API_BASE}/api/landscapes/${encodeURIComponent(landscapeId)}/drafts/${encodeURIComponent(draftId)}/merge`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolutions }) }
  )
  if (res.ok) {
    const body = (await res.json()) as { versionId: string }
    return { ok: true, versionId: body.versionId }
  }
  const body = (await res.json().catch(() => ({}))) as { conflicts?: DraftConflict[]; error?: string }
  return { ok: false, conflicts: body.conflicts ?? [], error: body.error ?? `merge failed: HTTP ${res.status}` }
}

async function errorMessage(res: Response, action: string): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return (body as { error?: string }).error ?? `${action} failed: HTTP ${res.status}`
}
