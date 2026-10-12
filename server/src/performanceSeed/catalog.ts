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

import type { Pool } from 'pg'
import { seedTagCatalog } from '../tags/seed.js'
import { seedTechnologyCatalog } from '../technologies/seed.js'
import type { PerformanceTagSnapshot } from './types.js'

export async function preparePerformanceCatalog(
  db: Pool,
  orgId: string,
  actorUserId: string,
): Promise<PerformanceTagSnapshot[]> {
  await seedTechnologyCatalog(db, orgId, actorUserId)
  await seedTagCatalog(db, orgId, actorUserId)
  const { rows } = await db.query<{
    tag_id: string
    value: string
    color: string
    group_id: string
    group_name: string
    version: number
  }>(
    `SELECT tag.id AS tag_id, tag.value, tag.color, tag.group_id,
            tag_group.name AS group_name, tag.version
     FROM tags tag
     JOIN tag_groups tag_group
       ON tag_group.org_id = tag.org_id AND tag_group.id = tag.group_id
     WHERE tag.org_id = $1
       AND tag.lifecycle_status = 'active'
       AND tag_group.lifecycle_status = 'active'
     ORDER BY tag_group.sort_key, tag_group.id, tag.sort_key, tag.id`,
    [orgId],
  )
  if (rows.length < 3) throw new Error(`Performance seed needs at least three active Tags; found ${rows.length}`)
  return rows.map((row) => ({
    tagId: row.tag_id,
    value: row.value,
    color: row.color,
    groupId: row.group_id,
    groupName: row.group_name,
    catalogRevision: row.version,
  }))
}
