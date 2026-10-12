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
import { documentContentChunkFilter } from '../documentContent.js'
import type { Queryable } from '../readModel/types.js'
import type { WorkspaceKey } from '../rbac/docScope.js'
import { CLAIM_PROTOCOL_VERSION } from '../rbac/documentClaims.js'

export const ACTIVITY_QUERY_CEILING_MS = 10_000

export interface ActivityFacts {
  readonly workspaceStatus: string | null
  readonly claimCoverageCurrent: boolean
  readonly admittedDocuments: number
  readonly missingContentDocuments: number
  /** Newest non-sync-state row, including unknown chunk kinds. Storage writes
   * use NOW() (transaction start), so a newly committed write can already have
   * an old timestamp. This is not a commit clock or a history of user edits. */
  readonly latestContentAt: string | null
  /** PostgreSQL statement time; content timestamps come from the same clock. */
  readonly observedAt: string
}

type UnknownReason = 'query-failed' | 'query-timeout' | 'query-in-flight' | 'stopped'
  | 'invalid-result' | 'workspace-not-active' | 'uncovered' | 'no-documents'
  | 'missing-content' | 'future-content-clock' | 'expired' | 'invalid-clock'

interface ActivityMetadata {
  readonly workspace: Readonly<WorkspaceKey>
  /** Actual queries dispatched by this witness, including failed attempts. */
  readonly sampleCount: number
  readonly requestStartedAt: string
  readonly observedAt: string | null
  /** Conservative age since dispatch, using the local monotonic clock. */
  readonly ageMs: number | null
}

export type ActivityVerdict = ActivityMetadata & (
  | { readonly kind: 'active'; readonly facts: ActivityFacts }
  | { readonly kind: 'idle'; readonly facts: ActivityFacts }
  | { readonly kind: 'unknown'; readonly reason: UnknownReason; readonly facts: ActivityFacts | null }
)

interface StoredVerdict {
  workspace: Readonly<WorkspaceKey>
  requestStartedAt: string
  startedMono: number
  facts: ActivityFacts | null
  kind: 'active' | 'idle' | 'unknown'
  reason?: UnknownReason
}

interface Flight {
  raw: Promise<void>
  halt: () => void
}

export interface ActivityWitnessOptions {
  /** A caller-selected lookback for durable content writes, not user presence. */
  idleAfterMs: number
  ceilingMs?: number
  clock?: { wall: () => number; monotonic: () => number }
}

type ActivityDatabase = Queryable & Pick<Pool, 'options'>

// Similar to the content-clock lateral in readModel/health.ts, but with a
// different scope, so that query's cost does not carry over. Read all facts in
// one snapshot, without trusting the projection's status or a process cache.
const ACTIVITY_SQL = `SELECT v.status AS workspace_status,
    statement_timestamp() AS observed_at,
    COALESCE(c.covered AND c.protocol >= $3, false) AS claim_coverage_current,
    d.admitted_documents::text, d.missing_content_documents::text,
    d.latest_content_at
  FROM (VALUES (1)) AS anchor(one)
  LEFT JOIN versions v ON v.landscape_id = $1 AND v.id = $2
  LEFT JOIN workspace_claim_coverage c ON c.landscape_id = $1 AND c.version_id = $2
  LEFT JOIN LATERAL (
    SELECT count(*) AS admitted_documents,
      count(*) FILTER (WHERE NOT newest.content_present) AS missing_content_documents,
      max(newest.updated_at) AS latest_content_at
    FROM automerge_document_workspace dw
    LEFT JOIN LATERAL (
      SELECT max(s.updated_at) AS updated_at,
        EXISTS (SELECT 1 FROM automerge_storage present
          WHERE split_part(present.key, '/', 1) = dw.document_id
            AND ${documentContentChunkFilter('present.key')}) AS content_present
      FROM automerge_storage s
      WHERE split_part(s.key, '/', 1) = dw.document_id
        AND split_part(s.key, '/', 2) <> 'sync-state'
    ) newest ON true
    WHERE dw.landscape_id = $1 AND dw.version_id = $2
  ) d ON true`

function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null
  return value.toISOString()
}

function factsFrom(rows: Record<string, unknown>[]): ActivityFacts | null {
  if (rows.length !== 1) return null
  const row = rows[0]!
  const count = (value: unknown): number => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value) : NaN
  const admittedDocuments = count(row.admitted_documents)
  const missingContentDocuments = count(row.missing_content_documents)
  const observedAt = timestamp(row.observed_at)
  const latestContentAt = timestamp(row.latest_content_at)
  if (!observedAt || (row.latest_content_at !== null && !latestContentAt)
    || (row.workspace_status !== null && typeof row.workspace_status !== 'string')
    || typeof row.claim_coverage_current !== 'boolean'
    || !Number.isSafeInteger(admittedDocuments) || !Number.isSafeInteger(missingContentDocuments)
    || missingContentDocuments > admittedDocuments
    || (admittedDocuments === 0 && latestContentAt !== null)
    || (admittedDocuments > missingContentDocuments && latestContentAt === null)) return null
  return Object.freeze({ workspaceStatus: row.workspace_status, claimCoverageCurrent: row.claim_coverage_current,
    admittedDocuments, missingContentDocuments, latestContentAt, observedAt })
}

/** One outstanding query for the entire witness, including after its verdict
 * times out. stop() joins that raw query; it neither cancels it nor closes the
 * caller's pool. The caller must retain this instance until stop() settles.
 * This class does no background polling of its own; callers decide when to
 * sample.
 *
 * Activity means content-chunk persistence (including rewrites/compaction),
 * not user edits or connected peers. Idle is conditional on the existing claim
 * protocol's coverage assertion and the admitted documents present in this
 * snapshot. It does not promise that no write can occur after the snapshot.
 */
export class ActivityWitness {
  private readonly ceilingMs: number
  private readonly clock: NonNullable<ActivityWitnessOptions['clock']>
  private readonly idleAfterMs: number
  private flight: Flight | null = null
  private last: StoredVerdict | null = null
  private sampleCount = 0
  private stopped = false

  constructor(private readonly db: ActivityDatabase, options: ActivityWitnessOptions) {
    this.ceilingMs = options.ceilingMs ?? ACTIVITY_QUERY_CEILING_MS
    this.idleAfterMs = options.idleAfterMs
    const patience = db.options.connectionTimeoutMillis
    if (!Number.isSafeInteger(patience) || patience! <= 0
      || !Number.isSafeInteger(this.ceilingMs) || this.ceilingMs < patience!
      || this.ceilingMs > 2_147_483_647) {
      throw new Error('Activity query ceiling must cover the pool finite positive connectionTimeoutMillis')
    }
    const statementTimeout = db.options.statement_timeout
    if (typeof statementTimeout !== 'number' || !Number.isSafeInteger(statementTimeout) || statementTimeout <= 0) {
      throw new Error('Activity database pool must configure a finite positive statement_timeout')
    }
    if (!Number.isSafeInteger(this.idleAfterMs) || this.idleAfterMs <= 0) {
      throw new Error('Activity lookback must be a finite positive integer')
    }
    this.clock = options.clock ?? { wall: Date.now, monotonic: () => performance.now() }
  }

  /** A cached verdict ages without querying or refreshing observedAt. */
  snapshot(): ActivityVerdict | null {
    return this.last ? this.describe(this.last) : null
  }

  sample(workspace: WorkspaceKey): Promise<ActivityVerdict> {
    const state: StoredVerdict = { workspace: Object.freeze({ ...workspace }),
      requestStartedAt: new Date(this.clock.wall()).toISOString(), startedMono: this.clock.monotonic(),
      facts: null, kind: 'unknown' }
    if (this.stopped || this.flight) {
      state.reason = this.stopped ? 'stopped' : 'query-in-flight'
      return Promise.resolve(this.describe(state))
    }
    this.last = state
    let finish!: (verdict: StoredVerdict) => void
    const visible = new Promise<ActivityVerdict>(resolve => {
      let finished = false
      finish = verdict => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        this.last = verdict
        resolve(this.describe(verdict))
      }
    })
    const unknown = (reason: UnknownReason): void => finish({ ...state, kind: 'unknown', reason })
    const timer = setTimeout(() => unknown('query-timeout'), this.ceilingMs)
    const flight: Flight = { raw: Promise.resolve(), halt: () => unknown('stopped') }
    this.flight = flight
    flight.raw = Promise.resolve().then(async () => {
      try {
        if (this.stopped) return
        this.sampleCount += 1
        const { rows } = await this.db.query(ACTIVITY_SQL,
          [state.workspace.landscapeId, state.workspace.versionId, CLAIM_PROTOCOL_VERSION])
        const elapsed = this.clock.monotonic() - state.startedMono
        if (!Number.isFinite(elapsed) || elapsed < 0) return unknown('invalid-clock')
        if (elapsed >= this.ceilingMs) return unknown('query-timeout')
        const facts = factsFrom(rows)
        if (!facts) return unknown('invalid-result')
        const known = { ...state, facts }
        if (facts.workspaceStatus !== 'active') return finish({ ...known, reason: 'workspace-not-active' })
        const newest = facts.latestContentAt ? Date.parse(facts.latestContentAt) : null
        const observed = Date.parse(facts.observedAt)
        if (newest !== null && newest > observed) return finish({ ...known, reason: 'future-content-clock' })
        if (newest !== null && newest >= observed - this.idleAfterMs) return finish({ ...known, kind: 'active' })
        if (!facts.claimCoverageCurrent) return finish({ ...known, reason: 'uncovered' })
        if (!facts.admittedDocuments) return finish({ ...known, reason: 'no-documents' })
        if (facts.missingContentDocuments) return finish({ ...known, reason: 'missing-content' })
        finish({ ...known, kind: 'idle' })
      } catch {
        // The typed unknown is the observable failure. Do not publish database
        // error text, which may contain connection details or user data.
        unknown('query-failed')
      } finally {
        clearTimeout(timer)
        this.flight = null
      }
    })
    return visible
  }

  async stop(): Promise<void> {
    this.stopped = true
    const flight = this.flight
    if (flight) {
      flight.halt()
      await flight.raw
    }
  }

  private describe(state: StoredVerdict): ActivityVerdict {
    const elapsed = this.clock.monotonic() - state.startedMono
    const invalidClock = !Number.isFinite(elapsed) || elapsed < 0
    const metadata: ActivityMetadata = { workspace: state.workspace, sampleCount: this.sampleCount,
      requestStartedAt: state.requestStartedAt, observedAt: state.facts?.observedAt ?? null,
      ageMs: state.facts && !invalidClock ? elapsed : null }
    if (invalidClock) return { ...metadata, facts: state.facts, kind: 'unknown', reason: 'invalid-clock' }
    if (this.stopped) return { ...metadata, facts: state.facts, kind: 'unknown', reason: 'stopped' }
    if (state.kind !== 'unknown' && elapsed >= this.ceilingMs) {
      return { ...metadata, facts: state.facts, kind: 'unknown', reason: 'expired' }
    }
    if (state.kind === 'unknown') return { ...metadata, facts: state.facts, kind: 'unknown', reason: state.reason ?? 'query-in-flight' }
    return { ...metadata, facts: state.facts!, kind: state.kind }
  }
}
