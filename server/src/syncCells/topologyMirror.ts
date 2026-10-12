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

import type { Queryable } from '../readModel/types.js'

/** A durable comparison witness of the Redis topology contract, never a source
 * for reseeding Redis. */
export async function ensureSyncTopologyContractSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sync_topology_contract (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      value TEXT NOT NULL,
      written_by TEXT NOT NULL,
      written_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

export async function readSyncTopologyContract(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ value: string }>(
    'SELECT value FROM sync_topology_contract WHERE singleton = TRUE',
  )
  return rows[0]?.value ?? null
}

/**
 * Called only by an incarnation that received Redis's real created:true.
 * A concurrent different witness must survive a delayed creator's publication.
 * false is a refused publication, not a successful write of zero rows.
 */
export async function publishSyncTopologyContract(
  db: Queryable,
  contract: { value: string; writtenBy: string },
): Promise<boolean> {
  const { rows } = await db.query<{ value: string }>(`
    INSERT INTO sync_topology_contract (singleton, value, written_by, written_at)
    VALUES (TRUE, $1, $2, NOW())
    ON CONFLICT (singleton) DO UPDATE
      SET written_by = EXCLUDED.written_by,
          written_at = EXCLUDED.written_at
      WHERE sync_topology_contract.value = EXCLUDED.value
    RETURNING value
  `, [contract.value, contract.writtenBy])
  return rows.length === 1
}
