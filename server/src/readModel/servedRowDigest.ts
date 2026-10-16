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

/**
 * Which cached rows a projection actually moved — the ids its change-feed event
 * may name, and must name.
 *
 * A projection pass rewrites far more than it changes (a whole shard, every
 * group, every diagram's membership), so the ids it WROTE say nothing about
 * what a client holding the served rows would see differ. Each pass instead
 * digests the exact rows an endpoint serves, before and after its writes, in
 * its own transaction, and publishes the difference.
 *
 * `servedSql` is the endpoint's own SQL text, parameterised as
 * `$1` landscape, `$2` version, `$3` the id array, and exposing an `id`
 * column — one text for both readers, so the feed cannot drift from the rows a
 * client fetches by id.
 */
export async function servedRowDigests(
  db: Queryable,
  servedSql: string,
  key: WorkspaceKey,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (!uniqueIds.length) return new Map()
  const { rows } = await db.query<{ id: string; digest: string }>(
    // Aggregated per id: one id may serve several rows (a group and an object
    // sharing it), and one digest must cover them in a plan-independent order.
    // sha256, not md5: md5() raises under a FIPS-mode OpenSSL (PostgreSQL 14+),
    // which would fail every projection that publishes ids.
    `SELECT served.id,
            encode(sha256(convert_to(
              string_agg(to_jsonb(served)::text, ',' ORDER BY to_jsonb(served)::text), 'UTF8')), 'hex') AS digest
     FROM (${servedSql}) AS served
     GROUP BY served.id`,
    [key.landscapeId, key.versionId, uniqueIds],
  )
  return new Map(rows.map((row) => [row.id, row.digest]))
}

/** The candidates whose served row differs between two digests — appeared,
 * disappeared or changed. An id with no row on either side is not a change. */
export function changedCacheRowIds(
  candidates: readonly string[],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...new Set(candidates)].filter((id) => before.get(id) !== after.get(id))
}

/** What a write did to the served rows of `candidates`: ids whose row is gone
 * (`deleteIds`), and ids whose row appeared or changed (`upsertIds`). */
export interface ServedRowChanges { upsertIds: string[]; deleteIds: string[] }

/** Digest `candidates` through `servedSql`, run `write`, digest again — all on
 * `tx`. `candidates` may be a function: it is then evaluated BEFORE the write,
 * on the rows as they stand, which is when neighbours are still findable. */
export async function servedRowsChangedBy(
  tx: Queryable,
  key: WorkspaceKey,
  servedSql: string,
  candidates: readonly string[] | (() => Promise<readonly string[]>),
  write: () => Promise<void>,
): Promise<ServedRowChanges> {
  const ids = typeof candidates === 'function' ? await candidates() : candidates
  const before = await servedRowDigests(tx, servedSql, key, ids)
  await write()
  const after = await servedRowDigests(tx, servedSql, key, ids)
  const changed = changedCacheRowIds(ids, before, after)
  return {
    upsertIds: changed.filter((id) => after.has(id)),
    deleteIds: changed.filter((id) => !after.has(id)),
  }
}
