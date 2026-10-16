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

export interface ChangedIds { upsertIds: string[]; deleteIds: string[] }

/** What one generation changed, per kind of cached row, when it is more than
 *  one kind (or diagram manifests, which have no event kind of their own). */
export interface ExactChanges {
  objects?: ChangedIds
  connections?: ChangedIds
  diagrams?: ChangedIds
}

export type ReadModelChangePayload =
  | { kind: 'objects'; upsertIds: string[]; deleteIds: string[] }
  | { kind: 'connections'; upsertIds: string[]; deleteIds: string[] }
  | { kind: 'reset'; scope: 'all' | 'groups' | 'diagrams' | 'connection_metrics' }
  /** Written, never read back as such: see `appendReadModelChange`. */
  | { kind: 'exact'; changes: ExactChanges }

/** A `reset`/`all` that carries `exact` is NOT a reset for a reader that knows
 *  the field: it is the precise list. A reader that predates the field sees a
 *  plain `reset`/`all` and rebuilds — exactly what every such pass published
 *  before, so an old tab is never told less than it was. */
export type ReadModelChangeEvent = (
  | { kind: 'objects'; upsertIds: string[]; deleteIds: string[] }
  | { kind: 'connections'; upsertIds: string[]; deleteIds: string[] }
  | { kind: 'reset'; scope: 'all' | 'groups' | 'diagrams' | 'connection_metrics'; exact?: ExactChanges }
) & { generation: number }

const MAX_CHANGE_IDS = 5_000

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))]
}

function normalizeIds(ids: ChangedIds | undefined): ChangedIds | undefined {
  if (!ids) return undefined
  const upsertIds = uniqueIds(ids.upsertIds)
  const deleteIds = uniqueIds(ids.deleteIds)
  return upsertIds.length || deleteIds.length ? { upsertIds, deleteIds } : undefined
}

function idCount(ids: ChangedIds | undefined): number {
  return ids ? ids.upsertIds.length + ids.deleteIds.length : 0
}

/** The stored form of an `exact` change: the plain kind every reader knows
 *  when only one kind of row moved, the envelope otherwise. */
function storedExact(changes: ExactChanges): ReadModelChangePayload {
  const objects = normalizeIds(changes.objects)
  const connections = normalizeIds(changes.connections)
  const diagrams = normalizeIds(changes.diagrams)
  if (!diagrams && !connections) {
    return { kind: 'objects', upsertIds: objects?.upsertIds ?? [], deleteIds: objects?.deleteIds ?? [] }
  }
  if (!diagrams && !objects) return { kind: 'connections', ...connections! }
  return {
    kind: 'exact',
    changes: {
      ...(objects ? { objects } : {}),
      ...(connections ? { connections } : {}),
      ...(diagrams ? { diagrams } : {}),
    },
  }
}

export async function appendReadModelChange(
  db: Queryable,
  key: WorkspaceKey,
  token: ProjectionToken,
  change: ReadModelChangePayload,
): Promise<void> {
  const normalized: ReadModelChangePayload = change.kind === 'reset'
    ? change
    : change.kind === 'exact'
      ? storedExact(change.changes)
      : {
          ...change,
          upsertIds: uniqueIds(change.upsertIds),
          deleteIds: uniqueIds(change.deleteIds),
        }
  const size = normalized.kind === 'reset'
    ? 0
    : normalized.kind === 'exact'
      ? idCount(normalized.changes.objects) + idCount(normalized.changes.connections)
        + idCount(normalized.changes.diagrams)
      : normalized.upsertIds.length + normalized.deleteIds.length
  // Never truncate a bulk mutation and let a cache silently diverge. A reset is
  // more expensive, but it is explicit, durable and correct after reconnect.
  const published: ReadModelChangePayload = size > MAX_CHANGE_IDS
    ? { kind: 'reset', scope: 'all' }
    : normalized
  // `exact` is stored as a reset/all carrying the lists — see ReadModelChangeEvent.
  const storedKind = published.kind === 'exact' ? 'reset' : published.kind
  const payload = published.kind === 'reset'
    ? { scope: published.scope }
    : published.kind === 'exact'
      ? { scope: 'all', exact: published.changes }
      : { upsertIds: published.upsertIds, deleteIds: published.deleteIds }
  await db.query(
    `INSERT INTO read_model_change_events (
       landscape_id, version_id, generation, change_kind, payload
     ) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (landscape_id, version_id, generation) DO UPDATE SET
       change_kind = EXCLUDED.change_kind, payload = EXCLUDED.payload, created_at = now()`,
    [key.landscapeId, key.versionId, token.generation, storedKind, JSON.stringify(payload)],
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

function readIds(value: unknown): ChangedIds {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const ids = (field: unknown) => Array.isArray(field) ? field.filter((id): id is string => typeof id === 'string') : []
  return { upsertIds: ids(record.upsertIds), deleteIds: ids(record.deleteIds) }
}

const EXACT_KINDS = new Set(['objects', 'connections', 'diagrams'])

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string')
}

/** `undefined` unless the stored envelope is well formed AND fully understood:
 *  anything else reads as the plain reset it also is, which is always safe. A
 *  kind this build does not know (a later build's `exact.flows`) must not be
 *  dropped while the rest is applied as if it were the whole change. */
function readExact(value: unknown): ExactChanges | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const exact: ExactChanges = {}
  for (const [kind, ids] of Object.entries(record)) {
    if (!EXACT_KINDS.has(kind)) return undefined
    if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return undefined
    const { upsertIds, deleteIds } = ids as Record<string, unknown>
    if (!isIdList(upsertIds) || !isIdList(deleteIds)) return undefined
    exact[kind as keyof ExactChanges] = { upsertIds, deleteIds }
  }
  return Object.keys(exact).length ? exact : undefined
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
      change_kind: 'objects' | 'connections' | 'reset'
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
      const exact = scope === 'all' ? readExact(row.payload.exact) : undefined
      return {
        generation,
        kind: 'reset',
        scope: scope === 'groups' || scope === 'diagrams' || scope === 'connection_metrics' ? scope : 'all',
        ...(exact ? { exact } : {}),
      }
    }
    return { generation, kind: row.change_kind, ...readIds(row.payload) }
  })
  let expected = afterGeneration + 1
  let gap = false
  for (const event of events) {
    if (event.generation !== expected) { gap = true; break }
    expected += 1
  }
  const resetRequired = gap || events.some((event) => event.kind === 'reset' && event.scope === 'all' && !event.exact)
    || (projectionGeneration > afterGeneration && events.length === 0)
  return {
    projectionGeneration,
    events,
    nextGeneration: events.at(-1)?.generation ?? afterGeneration,
    hasMore: rows.length > limit,
    resetRequired,
  }
}
