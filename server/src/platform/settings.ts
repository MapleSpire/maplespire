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

import type { QueryResult, QueryResultRow } from 'pg'

type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
}

export interface PlatformSettings {
  requireIndependentTechnologyReview: boolean
}

export interface PlatformSettingsState extends PlatformSettings {
  activePlatformAdminCount: number
  independentTechnologyReviewEffective: boolean
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  requireIndependentTechnologyReview: true,
}

type SettingsRow = {
  settings: unknown
  active_platform_admin_count: number | string
}

function parseSettings(value: unknown): PlatformSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PLATFORM_SETTINGS
  const settings = value as Record<string, unknown>
  return {
    requireIndependentTechnologyReview:
      typeof settings.requireIndependentTechnologyReview === 'boolean'
        ? settings.requireIndependentTechnologyReview
        : DEFAULT_PLATFORM_SETTINGS.requireIndependentTechnologyReview,
  }
}

/** Read the configured policy and active operator count in one snapshot. */
export async function getPlatformSettingsState(db: Queryable): Promise<PlatformSettingsState> {
  const { rows } = await db.query<SettingsRow>(
    `SELECT COALESCE(
              (SELECT settings FROM platform_settings WHERE id = 'global'),
              '{}'::jsonb
            ) AS settings,
            count(*) FILTER (
              WHERE is_platform_admin = true AND status = 'active'
            )::int AS active_platform_admin_count
       FROM users`,
  )
  const settings = parseSettings(rows[0]?.settings)
  const activePlatformAdminCount = Number(rows[0]?.active_platform_admin_count ?? 0)
  return {
    ...settings,
    activePlatformAdminCount,
    independentTechnologyReviewEffective:
      settings.requireIndependentTechnologyReview && activePlatformAdminCount > 1,
  }
}

export async function updatePlatformSettings(
  db: Queryable,
  actorUserId: string,
  patch: Partial<PlatformSettings>,
): Promise<void> {
  if (patch.requireIndependentTechnologyReview === undefined) return
  await db.query(
    `INSERT INTO platform_settings (id, settings, updated_at, updated_by)
     VALUES (
       'global',
       jsonb_build_object('requireIndependentTechnologyReview', $1::boolean),
       now(),
       $2
     )
     ON CONFLICT (id) DO UPDATE
       SET settings = jsonb_set(
             platform_settings.settings,
             '{requireIndependentTechnologyReview}',
             to_jsonb($1::boolean),
             true
           ),
           updated_at = now(),
           updated_by = $2`,
    [patch.requireIndependentTechnologyReview, actorUserId],
  )
}
