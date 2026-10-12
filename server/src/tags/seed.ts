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

import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export interface SeededTagDefinition {
  groupName: string
  value: string
  color: string
}

export const SEEDED_TAG_DEFINITIONS: readonly SeededTagDefinition[] = [
  { groupName: 'Risk', value: 'High', color: '#DC2626' },
  { groupName: 'Risk', value: 'Medium', color: '#F59E0B' },
  { groupName: 'Risk', value: 'Low', color: '#16A34A' },
  { groupName: 'Cost', value: 'Tier 1', color: '#7C3AED' },
  { groupName: 'Cost', value: 'Tier 2', color: '#8B5CF6' },
  { groupName: 'Security', value: 'PCI scope', color: '#DC2626' },
  { groupName: 'Security', value: 'Encrypted', color: '#2563EB' },
  { groupName: 'Region', value: 'ca-central-1', color: '#0891B2' },
  { groupName: 'Region', value: 'us-east-1', color: '#0D9488' },
  { groupName: 'Release', value: '2026.7', color: '#4F46E5' },
  { groupName: 'Deployment', value: 'Public cloud', color: '#0284C7' },
  { groupName: 'Deployment', value: 'Multi-region', color: '#0369A1' },
  { groupName: 'Hostnames', value: 'shop.example.test', color: '#475569' },
  { groupName: 'Accessibility', value: 'WCAG AA', color: '#16A34A' },
] as const

export const SEEDED_TAG_GROUPS = [
  'Risk', 'Cost', 'Security', 'Region', 'Release', 'Deployment', 'Hostnames', 'Accessibility',
] as const

function stableSuffix(orgId: string, kind: string, value: string): string {
  return createHash('sha256').update(`${orgId}\0${kind}\0${value}`).digest('hex').slice(0, 24)
}

export function seededTagGroupId(orgId: string, groupName: string): string {
  return `taggrp_seed_${stableSuffix(orgId, 'group', groupName.toLowerCase())}`
}

export function seededTagId(orgId: string, groupName: string, value: string): string {
  return `tag_seed_${stableSuffix(orgId, groupName.toLowerCase(), value.toLowerCase())}`
}

async function ensureSeededGroup(
  client: PoolClient,
  orgId: string,
  actorUserId: string,
  name: string,
  index: number,
): Promise<string> {
  const normalizedName = name.toLowerCase()
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM tag_groups
     WHERE org_id = $1 AND normalized_name = $2 AND lifecycle_status = 'active'
     LIMIT 1`,
    [orgId, normalizedName],
  )
  if (existing.rows[0]) return existing.rows[0].id

  const id = seededTagGroupId(orgId, name)
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tag_groups (
       id, org_id, name, normalized_name, description, icon_key, sort_key,
       lifecycle_status, version, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, NULL, $6, 'active', 1, $7, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      id, orgId, name, normalizedName,
      `${name} tags shared across this organization's landscapes.`,
      String((index + 1) * 1024).padStart(18, '0'), actorUserId,
    ],
  )
  if (inserted.rows[0]) return inserted.rows[0].id

  // Another catalog entry may own the semantic identity under a non-seeded ID.
  // Reuse it instead of violating uq_tag_groups_active_name.
  const semanticMatch = await client.query<{ id: string }>(
    `SELECT id FROM tag_groups
     WHERE org_id = $1 AND normalized_name = $2 AND lifecycle_status = 'active'
     LIMIT 1`,
    [orgId, normalizedName],
  )
  if (semanticMatch.rows[0]) return semanticMatch.rows[0].id

  // If this seed-owned identity was archived, restore it. The NOT EXISTS guard
  // keeps a concurrent semantic match authoritative.
  const restored = await client.query<{ id: string }>(
    `UPDATE tag_groups
     SET name = $3, normalized_name = $4, description = $5, sort_key = $6,
         lifecycle_status = 'active', version = version + 1,
         updated_by = $7, updated_at = now()
     WHERE id = $1 AND org_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM tag_groups active_group
         WHERE active_group.org_id = $2
           AND active_group.normalized_name = $4
           AND active_group.lifecycle_status = 'active'
       )
     RETURNING id`,
    [
      id, orgId, name, normalizedName,
      `${name} tags shared across this organization's landscapes.`,
      String((index + 1) * 1024).padStart(18, '0'), actorUserId,
    ],
  )
  if (restored.rows[0]) return restored.rows[0].id

  const concurrentMatch = await client.query<{ id: string }>(
    `SELECT id FROM tag_groups
     WHERE org_id = $1 AND normalized_name = $2 AND lifecycle_status = 'active'
     LIMIT 1`,
    [orgId, normalizedName],
  )
  if (concurrentMatch.rows[0]) return concurrentMatch.rows[0].id
  throw new Error(`Unable to seed tag group ${name}`)
}

async function ensureSeededTag(
  client: PoolClient,
  orgId: string,
  actorUserId: string,
  definition: SeededTagDefinition,
  groupId: string,
  index: number,
): Promise<void> {
  const normalizedValue = definition.value.toLowerCase()
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM tags
     WHERE org_id = $1 AND group_id = $2 AND normalized_value = $3
       AND lifecycle_status = 'active'
     LIMIT 1`,
    [orgId, groupId, normalizedValue],
  )
  if (existing.rows[0]) return

  const insert = async (id: string) => client.query<{ id: string }>(
    `INSERT INTO tags (
       id, org_id, group_id, value, normalized_value, color, sort_key,
       lifecycle_status, version, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 1, $8, $8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      id, orgId, groupId, definition.value, normalizedValue, definition.color,
      String(index * 1024).padStart(18, '0'), actorUserId,
    ],
  )

  const inserted = await insert(seededTagId(orgId, definition.groupName, definition.value))
  if (inserted.rows[0]) return

  const semanticMatch = await client.query<{ id: string }>(
    `SELECT id FROM tags
     WHERE org_id = $1 AND group_id = $2 AND normalized_value = $3
       AND lifecycle_status = 'active'
     LIMIT 1`,
    [orgId, groupId, normalizedValue],
  )
  if (semanticMatch.rows[0]) return

  // A deterministic ID can already belong to an archived tag from a previous
  // group identity. Preserve that history and create a stable replacement.
  const replacementId = `tag_seed_${stableSuffix(orgId, groupId, normalizedValue)}`
  const replacement = await insert(replacementId)
  if (replacement.rows[0]) return

  const concurrentMatch = await client.query<{ id: string }>(
    `SELECT id FROM tags
     WHERE org_id = $1 AND group_id = $2 AND normalized_value = $3
       AND lifecycle_status = 'active'
     LIMIT 1`,
    [orgId, groupId, normalizedValue],
  )
  if (!concurrentMatch.rows[0]) throw new Error(`Unable to seed tag ${definition.groupName}/${definition.value}`)
}

export async function seedTagCatalog(pool: Pool, orgId: string, actorUserId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const groupIds = new Map<string, string>()
    for (let index = 0; index < SEEDED_TAG_GROUPS.length; index++) {
      const name = SEEDED_TAG_GROUPS[index]
      groupIds.set(name, await ensureSeededGroup(client, orgId, actorUserId, name, index))
    }
    const perGroupIndex = new Map<string, number>()
    for (const definition of SEEDED_TAG_DEFINITIONS) {
      const index = (perGroupIndex.get(definition.groupName) ?? 0) + 1
      perGroupIndex.set(definition.groupName, index)
      const groupId = groupIds.get(definition.groupName)
      if (!groupId) throw new Error(`Missing seeded tag group ${definition.groupName}`)
      await ensureSeededTag(client, orgId, actorUserId, definition, groupId, index)
    }
    await client.query(
      `INSERT INTO audit_log (org_id, actor_user_id, action, target_kind, target_id, detail)
       VALUES ($1, $2, 'tag.catalog_seeded', 'tag_catalog', $1, $3)`,
      [orgId, actorUserId, JSON.stringify({ groups: SEEDED_TAG_GROUPS.length, tags: SEEDED_TAG_DEFINITIONS.length })],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
