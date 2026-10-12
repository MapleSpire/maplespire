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

import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

export type StaticEntityKind = 'object' | 'connection' | 'group' | 'diagram' | 'decision_record'
export type StaticMembershipKind =
  | 'diagram_object'
  | 'diagram_group'
  | 'diagram_connection'
  | 'group_object'
  | 'connection_flow'
  /** Which diagrams a registry SHARD carries. The owner is the shard's
   * document id, so the reconciliation of a write head can compute what left
   * THAT shard without ever looking at the rest of the workspace. */
  | 'registry_shard_diagram'

export interface StaticMembershipValue {
  entityId: string
  auxiliaryId?: string
}

/** Persist the compact effective delta in the SAME transaction as the ro_*
 * projection. Upserts replace a prior tombstone; deletes replace prior data.
 * There is never one row per event, so edit history cannot grow the query path. */
export async function recordStaticEntityDeltas(
  db: Queryable,
  key: WorkspaceKey,
  kind: StaticEntityKind,
  generation: number,
  upserts: readonly Record<string, unknown>[],
  deleteIds: readonly string[] = [],
): Promise<void> {
  const byId = new Map<string, Record<string, unknown>>()
  for (const value of upserts) {
    if (typeof value.id === 'string' && value.id) byId.set(value.id, value)
  }
  const deleted = [...new Set(deleteIds.filter(Boolean))].filter((id) => !byId.has(id))
  if (byId.size) {
    await db.query(
      `INSERT INTO read_model_static_entity_deltas (
         landscape_id, version_id, entity_kind, entity_id, data,
         tombstone, generation, updated_at
       )
       SELECT $2, $3, $4, item.id, item.data, false, $5, now()
       FROM jsonb_to_recordset($1::jsonb) AS item(id text, data jsonb)
       ON CONFLICT (landscape_id, version_id, entity_kind, entity_id) DO UPDATE SET
         data = EXCLUDED.data,
         tombstone = false,
         generation = EXCLUDED.generation,
         updated_at = now()`,
      [
        JSON.stringify([...byId].map(([id, data]) => ({ id, data }))),
        key.landscapeId,
        key.versionId,
        kind,
        generation,
      ],
    )
  }
  if (deleted.length) {
    await db.query(
      `INSERT INTO read_model_static_entity_deltas (
         landscape_id, version_id, entity_kind, entity_id, data,
         tombstone, generation, updated_at
       )
       SELECT $1, $2, $3, id, NULL, true, $5, now()
       FROM unnest($4::text[]) AS id
       ON CONFLICT (landscape_id, version_id, entity_kind, entity_id) DO UPDATE SET
         data = NULL,
         tombstone = true,
         generation = EXCLUDED.generation,
         updated_at = now()`,
      [key.landscapeId, key.versionId, kind, deleted, generation],
    )
  }
}

/** Replace one owner's compact membership delta. Values missing from the new
 * snapshot become tombstones, so removals from an immutable baseline remain
 * explicit and replayable. */
export async function recordStaticMembershipSnapshot(
  db: Queryable,
  key: WorkspaceKey,
  kind: StaticMembershipKind,
  ownerId: string,
  generation: number,
  previous: readonly StaticMembershipValue[],
  current: readonly StaticMembershipValue[],
): Promise<void> {
  const id = (value: StaticMembershipValue) => `${value.entityId}\u0000${value.auxiliaryId ?? ''}`
  const previousMap = new Map(previous.map((value) => [id(value), value]))
  const currentMap = new Map(current.map((value) => [id(value), value]))
  const rows = [...new Set([...previousMap.keys(), ...currentMap.keys()])].map((keyValue) => {
    const value = currentMap.get(keyValue) ?? previousMap.get(keyValue)!
    return {
      entityId: value.entityId,
      auxiliaryId: value.auxiliaryId ?? '',
      tombstone: !currentMap.has(keyValue),
    }
  })
  if (!rows.length) return
  await db.query(
    `INSERT INTO read_model_static_membership_deltas (
       landscape_id, version_id, membership_kind, owner_id, entity_id,
       auxiliary_id, tombstone, generation, updated_at
     )
     SELECT $2, $3, $4, $5, item."entityId", item."auxiliaryId",
            item.tombstone, $6, now()
     FROM jsonb_to_recordset($1::jsonb) AS item(
       "entityId" text, "auxiliaryId" text, tombstone boolean
     )
     ON CONFLICT (
       landscape_id, version_id, membership_kind, owner_id, entity_id, auxiliary_id
     ) DO UPDATE SET
       tombstone = EXCLUDED.tombstone,
       generation = EXCLUDED.generation,
       updated_at = now()`,
    [JSON.stringify(rows), key.landscapeId, key.versionId, kind, ownerId, generation],
  )
}

