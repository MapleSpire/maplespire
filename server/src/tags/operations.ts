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
import type { TagOperationEventInput, TagOperationEventType, TagOperationSummary } from './types.js'

export type TagRateBucket = 'read' | 'mutation'

export interface TagRateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
  actorCount: number
  orgCount: number
}

interface TagRateLimits {
  actorLimit: number
  orgLimit: number
  windowSeconds: number
}

function positiveEnvironmentLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function configuredTagRateLimits(bucket: TagRateBucket): TagRateLimits {
  return bucket === 'read' ? {
    actorLimit: positiveEnvironmentLimit('TAG_READ_ACTOR_PER_MINUTE', 300),
    orgLimit: positiveEnvironmentLimit('TAG_READ_ORG_PER_MINUTE', 3_000),
    windowSeconds: 60,
  } : {
    actorLimit: positiveEnvironmentLimit('TAG_MUTATION_ACTOR_PER_MINUTE', 60),
    orgLimit: positiveEnvironmentLimit('TAG_MUTATION_ORG_PER_MINUTE', 600),
    windowSeconds: 60,
  }
}

/** Atomic database-backed limiter shared by every server instance. */
export async function consumeTagRateLimit(
  pool: Pool,
  input: { orgId: string; actorUserId: string; bucket: TagRateBucket; limits?: TagRateLimits },
): Promise<TagRateLimitDecision> {
  const limits = input.limits ?? configuredTagRateLimits(input.bucket)
  const { rows } = await pool.query<{
    scope_kind: 'actor' | 'org'
    request_count: number
    max_requests: number
    retry_after_seconds: number
  }>(
    `WITH requested(scope_kind, scope_id, max_requests) AS (
       VALUES ('actor'::text, $2::text, $5::integer), ('org'::text, $1::text, $6::integer)
     ), rate_window AS (
       SELECT to_timestamp(
         floor(extract(epoch FROM clock_timestamp()) / $4::integer) * $4::integer
       ) AS window_start
     ), upserted AS (
       INSERT INTO tag_rate_limit_buckets (
         org_id, scope_kind, scope_id, bucket, window_start, request_count
       )
       SELECT $1, requested.scope_kind, requested.scope_id, $3, rate_window.window_start, 1
       FROM requested CROSS JOIN rate_window
       ON CONFLICT (org_id, scope_kind, scope_id, bucket, window_start)
       DO UPDATE SET request_count = tag_rate_limit_buckets.request_count + 1
       RETURNING scope_kind, scope_id, request_count, window_start
     )
     SELECT upserted.scope_kind, upserted.request_count, requested.max_requests,
            greatest(1, ceil(extract(epoch FROM (
              upserted.window_start + make_interval(secs => $4::integer) - clock_timestamp()
            )))::integer) AS retry_after_seconds
     FROM upserted
     JOIN requested USING (scope_kind, scope_id)`,
    [input.orgId, input.actorUserId, input.bucket, limits.windowSeconds, limits.actorLimit, limits.orgLimit],
  )
  const actor = rows.find((row) => row.scope_kind === 'actor')
  const org = rows.find((row) => row.scope_kind === 'org')
  const allowed = Boolean(actor && org && actor.request_count <= actor.max_requests && org.request_count <= org.max_requests)
  if (!allowed && (
    (actor !== undefined && actor.request_count === actor.max_requests + 1)
    || (org !== undefined && org.request_count === org.max_requests + 1)
  )) {
    await pool.query(
      `INSERT INTO audit_log (org_id, actor_user_id, action, target_kind, target_id, detail)
       VALUES ($1, $2, 'tag.rate_limited', 'tag_catalog', $1, $3)`,
      [input.orgId, input.actorUserId, JSON.stringify({
        bucket: input.bucket,
        actorCount: actor?.request_count ?? 0,
        orgCount: org?.request_count ?? 0,
        actorLimit: limits.actorLimit,
        orgLimit: limits.orgLimit,
      })],
    ).catch((error) => console.warn('[tags] rate-limit audit failed:', error))
  }
  return {
    allowed,
    retryAfterSeconds: Math.max(actor?.retry_after_seconds ?? 1, org?.retry_after_seconds ?? 1),
    actorCount: actor?.request_count ?? 0,
    orgCount: org?.request_count ?? 0,
  }
}

/** Idempotent batch ingestion for device-local outbox lifecycle metrics. */
export async function recordTagOperationEvents(
  pool: Pool,
  input: { orgId: string; actorUserId: string; events: readonly TagOperationEventInput[] },
): Promise<{ received: number; inserted: number }> {
  if (input.events.length === 0) return { received: 0, inserted: 0 }
  const result = await pool.query(
    `INSERT INTO tag_operation_events (
       id, org_id, actor_user_id, event_type, item_kind, reason_code,
       age_ms, attempt_count, occurred_at
     )
     SELECT event.id, $1, $2, event.event_type, event.item_kind,
            event.reason_code, event.age_ms, event.attempt_count, event.occurred_at
     FROM jsonb_to_recordset($3::jsonb) AS event(
       id text, event_type text, item_kind text, reason_code text,
       age_ms bigint, attempt_count integer, occurred_at timestamptz
     )
     ON CONFLICT (id) DO NOTHING`,
    [input.orgId, input.actorUserId, JSON.stringify(input.events.map((event) => ({
      id: event.id,
      event_type: event.eventType,
      item_kind: event.itemKind,
      reason_code: event.reasonCode,
      age_ms: event.ageMs,
      attempt_count: event.attemptCount,
      occurred_at: event.occurredAt,
    })))],
  )
  return { received: input.events.length, inserted: result.rowCount ?? 0 }
}

const OPERATION_WINDOWS = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' } as const

export async function tagOperationSummary(
  pool: Pool,
  orgId: string,
  window: keyof typeof OPERATION_WINDOWS,
): Promise<TagOperationSummary> {
  const interval = OPERATION_WINDOWS[window]
  const { rows } = await pool.query<{
    from_at: Date | string
    to_at: Date | string
    last_event_at: Date | string | null
    queued: string
    replay_succeeded: string
    attention: string
    discarded: string
    reconciled: string
    p50_resolution_ms: string | null
    p95_resolution_ms: string | null
  }>(
    `WITH bounds AS (
       SELECT now() - $2::interval AS from_at, now() AS to_at
     )
     SELECT bounds.from_at, bounds.to_at, max(events.occurred_at) AS last_event_at,
            count(*) FILTER (WHERE events.event_type = 'queued')::text AS queued,
            count(*) FILTER (WHERE events.event_type = 'replay_succeeded')::text AS replay_succeeded,
            count(*) FILTER (WHERE events.event_type = 'attention')::text AS attention,
            count(*) FILTER (WHERE events.event_type = 'discarded')::text AS discarded,
            count(*) FILTER (WHERE events.event_type = 'reconciled')::text AS reconciled,
            percentile_disc(0.50) WITHIN GROUP (ORDER BY events.age_ms)
              FILTER (WHERE events.event_type IN ('replay_succeeded', 'discarded', 'reconciled'))::text AS p50_resolution_ms,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY events.age_ms)
              FILTER (WHERE events.event_type IN ('replay_succeeded', 'discarded', 'reconciled'))::text AS p95_resolution_ms
     FROM bounds
     LEFT JOIN tag_operation_events events
       ON events.org_id = $1 AND events.occurred_at >= bounds.from_at AND events.occurred_at <= bounds.to_at
     GROUP BY bounds.from_at, bounds.to_at`,
    [orgId, interval],
  )
  const row = rows[0]
  const reasons = await pool.query<{ reason_code: string; count: string }>(
    `SELECT reason_code, count(*)::text AS count
     FROM tag_operation_events
     WHERE org_id = $1 AND occurred_at >= now() - $2::interval
       AND event_type = 'attention' AND reason_code IS NOT NULL
     GROUP BY reason_code ORDER BY count(*) DESC, reason_code LIMIT 5`,
    [orgId, interval],
  )
  const counts = Object.fromEntries(([
    'queued', 'replay_succeeded', 'attention', 'discarded', 'reconciled',
  ] as TagOperationEventType[]).map((type) => [type, Number(row?.[type] ?? 0)])) as Record<TagOperationEventType, number>
  return {
    window,
    from: new Date(row?.from_at ?? Date.now()).toISOString(),
    to: new Date(row?.to_at ?? Date.now()).toISOString(),
    counts,
    p50ResolutionMs: row?.p50_resolution_ms === null || row?.p50_resolution_ms === undefined
      ? null : Number(row.p50_resolution_ms),
    p95ResolutionMs: row?.p95_resolution_ms === null || row?.p95_resolution_ms === undefined
      ? null : Number(row.p95_resolution_ms),
    topAttentionReasons: reasons.rows.map((reason) => ({ code: reason.reason_code, count: Number(reason.count) })),
    lastEventAt: row?.last_event_at ? new Date(row.last_event_at).toISOString() : null,
  }
}

/** Bounded maintenance for expired replay keys and old rate windows. */
export async function gcTagOperationalState(pool: Pool, limit = 10_000): Promise<{
  idempotencyKeysDeleted: number
  rateBucketsDeleted: number
  telemetryEventsDeleted: number
}> {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 100_000)
  const idempotency = await pool.query(
    `DELETE FROM tag_idempotency_keys
     WHERE ctid IN (
       SELECT ctid FROM tag_idempotency_keys WHERE expires_at <= now() ORDER BY expires_at LIMIT $1
     )`,
    [bounded],
  )
  const rate = await pool.query(
    `DELETE FROM tag_rate_limit_buckets
     WHERE ctid IN (
       SELECT ctid FROM tag_rate_limit_buckets
       WHERE window_start < now() - interval '2 days'
       ORDER BY window_start LIMIT $1
     )`,
    [bounded],
  )
  const retentionDays = Math.min(Math.max(positiveEnvironmentLimit('TAG_OPERATION_RETENTION_DAYS', 35), 31), 365)
  const telemetry = await pool.query(
    `DELETE FROM tag_operation_events
     WHERE ctid IN (
       SELECT ctid FROM tag_operation_events
       WHERE occurred_at < now() - make_interval(days => $2::integer)
       ORDER BY occurred_at LIMIT $1
     )`,
    [bounded, retentionDays],
  )
  return {
    idempotencyKeysDeleted: idempotency.rowCount ?? 0,
    rateBucketsDeleted: rate.rowCount ?? 0,
    telemetryEventsDeleted: telemetry.rowCount ?? 0,
  }
}
