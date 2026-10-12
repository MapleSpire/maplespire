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

import type { ProjectionToken } from './health.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

export const READ_MODEL_CHANGE_CHANNEL = 'read_model_change_event'

export type ReadModelChangePayload =
  | { kind: 'objects'; upsertIds: string[]; deleteIds: string[] }
  | { kind: 'connections'; upsertIds: string[]; deleteIds: string[] }
  | { kind: 'reset'; scope: 'all' | 'groups' | 'diagrams' | 'connection_metrics' }

export type ReadModelChangeEvent = ReadModelChangePayload & { generation: number }

const MAX_CHANGE_IDS = 5_000

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))]
}

export async function appendReadModelChange(
  db: Queryable,
  key: WorkspaceKey,
  token: ProjectionToken,
  change: ReadModelChangePayload,
): Promise<void> {
  const normalized = change.kind === 'reset'
    ? change
    : {
        ...change,
        upsertIds: uniqueIds(change.upsertIds),
        deleteIds: uniqueIds(change.deleteIds),
      }
  // Never truncate a bulk mutation and let a cache silently diverge. A reset is
  // more expensive, but it is explicit, durable and correct after reconnect.
  const published: ReadModelChangePayload = normalized.kind !== 'reset'
    && normalized.upsertIds.length + normalized.deleteIds.length > MAX_CHANGE_IDS
    ? { kind: 'reset', scope: 'all' }
    : normalized
  const payload = published.kind === 'reset'
    ? { scope: published.scope }
    : { upsertIds: published.upsertIds, deleteIds: published.deleteIds }
  await db.query(
    `INSERT INTO read_model_change_events (
       landscape_id, version_id, generation, change_kind, payload
     ) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (landscape_id, version_id, generation) DO UPDATE SET
       change_kind = EXCLUDED.change_kind, payload = EXCLUDED.payload, created_at = now()`,
    [key.landscapeId, key.versionId, token.generation, published.kind, JSON.stringify(payload)],
  )
  // Bounded operational history. A client older than this window receives
  // resetRequired and rebuilds a clean snapshot instead of guessing at gaps.
  await db.query(
    `DELETE FROM read_model_change_events
     WHERE landscape_id = $1 AND version_id = $2 AND generation < GREATEST(0, $3::bigint - 10000)`,
    [key.landscapeId, key.versionId, token.generation],
  )
  // NOTIFY is only a low-latency wake-up. The table above remains the durable
  // source and clients replay it after reconnecting. Because pg_notify runs in
  // the surrounding projection transaction, PostgreSQL delivers it only after
  // the read-model rows, generation and change event commit together.
  await db.query('SELECT pg_notify($1, $2)', [
    READ_MODEL_CHANGE_CHANNEL,
    JSON.stringify({
      landscapeId: key.landscapeId.slice(0, 256),
      versionId: key.versionId.slice(0, 256),
      generation: token.generation,
    }),
  ])
}

export async function roReadModelChanges(
  db: Queryable,
  key: WorkspaceKey,
  opts: { afterGeneration?: number; limit?: number } = {},
): Promise<{
  projectionGeneration: number
  events: ReadModelChangeEvent[]
  nextGeneration: number
  hasMore: boolean
  resetRequired: boolean
}> {
  const afterGeneration = Math.max(0, Math.floor(opts.afterGeneration ?? 0))
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)))
  const [state, eventResult] = await Promise.all([
    db.query<{ projected_generation: string | number }>(
      `SELECT projected_generation FROM read_model_projection_state
       WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId],
    ),
    db.query<{
      generation: string | number
      change_kind: ReadModelChangePayload['kind']
      payload: Record<string, unknown>
    }>(
      `SELECT generation, change_kind, payload
       FROM read_model_change_events
       WHERE landscape_id = $1 AND version_id = $2 AND generation > $3
       ORDER BY generation
       LIMIT $4`,
      [key.landscapeId, key.versionId, afterGeneration, limit + 1],
    ),
  ])
  const projectionGeneration = Number(state.rows[0]?.projected_generation ?? 0)
  const rows = eventResult.rows.filter((row) => Number(row.generation) <= projectionGeneration)
  const page = rows.slice(0, limit)
  const events: ReadModelChangeEvent[] = page.map((row) => {
    const generation = Number(row.generation)
    if (row.change_kind === 'reset') {
      const scope = row.payload.scope
      return { generation, kind: 'reset', scope: scope === 'groups' || scope === 'diagrams' || scope === 'connection_metrics' ? scope : 'all' }
    }
    return {
      generation,
      kind: row.change_kind,
      upsertIds: Array.isArray(row.payload.upsertIds) ? row.payload.upsertIds.filter((id): id is string => typeof id === 'string') : [],
      deleteIds: Array.isArray(row.payload.deleteIds) ? row.payload.deleteIds.filter((id): id is string => typeof id === 'string') : [],
    }
  })
  let expected = afterGeneration + 1
  let gap = false
  for (const event of events) {
    if (event.generation !== expected) { gap = true; break }
    expected += 1
  }
  const resetRequired = gap || events.some((event) => event.kind === 'reset' && event.scope === 'all')
    || (projectionGeneration > afterGeneration && events.length === 0)
  return {
    projectionGeneration,
    events,
    nextGeneration: events.at(-1)?.generation ?? afterGeneration,
    hasMore: rows.length > limit,
    resetRequired,
  }
}
