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
 * The Spotlight's "Recent" list: the last results you opened, per account and
 * per workspace, in this browser. A convenience, not data: a missing or
 * unreadable entry simply shows nothing.
 */

import { accountStorageKey } from '../auth/accountNamespace'
import { SPOTLIGHT_KIND_ORDER } from './spotlight/grammar'
import type { SpotlightKind } from './spotlight/grammar'

export interface SpotlightRecent {
  readonly kind: SpotlightKind
  readonly id: string
  /** The title when it was opened; shown when the entity is no longer resident. */
  readonly title: string
}

export const SPOTLIGHT_RECENT_LIMIT = 6

function storageKey(workspaceKey: string): string {
  return accountStorageKey(`maplespire:spotlight:recent:${workspaceKey}`)
}

function isRecent(value: unknown): value is SpotlightRecent {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && typeof v.title === 'string'
    && typeof v.kind === 'string' && (SPOTLIGHT_KIND_ORDER as readonly string[]).includes(v.kind)
}

export function readSpotlightRecent(workspaceKey: string): SpotlightRecent[] {
  try {
    const raw = localStorage.getItem(storageKey(workspaceKey))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, SPOTLIGHT_RECENT_LIMIT) : []
  } catch {
    return []
  }
}

/** Most recent first, one entry per result, capped. */
export function rememberSpotlightRecent(workspaceKey: string, entry: SpotlightRecent): SpotlightRecent[] {
  const next = [entry, ...readSpotlightRecent(workspaceKey).filter((r) => r.kind !== entry.kind || r.id !== entry.id)]
    .slice(0, SPOTLIGHT_RECENT_LIMIT)
  try {
    localStorage.setItem(storageKey(workspaceKey), JSON.stringify(next))
  } catch {
    /* storage unavailable or full: the list is a convenience */
  }
  return next
}

export function forgetSpotlightRecent(workspaceKey: string, kind: SpotlightKind, id: string): SpotlightRecent[] {
  const next = readSpotlightRecent(workspaceKey).filter((r) => r.kind !== kind || r.id !== id)
  try {
    localStorage.setItem(storageKey(workspaceKey), JSON.stringify(next))
  } catch {
    /* see above */
  }
  return next
}
