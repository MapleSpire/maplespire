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

import type { DurableHeadResult } from '../durableHeads.js'
import type { MetricSample } from '../runtime/metrics.js'
import { databasePoolConfig } from '../dbConfig.js'
import { CLIENT_DEADLINE_MARGIN_MS, DEFAULT_POOL_CONNECTION_TIMEOUT_MS, queryWithStatementTimeout } from './epochStuckRows.js'

/**
 * G4-16j: what the SERVER sees of the epoch hop, on `/metrics`, per cell
 * (process: `instance`) and never per workspace.
 *
 * The hop runs in the browser (`src/lib/automerge/epochHop.ts`). The server
 * sees two things of it, both on `POST /api/automerge/durable-heads`: the
 * LATCH asks (`latch=1`, sent while the tab blocks input, up to 2 s per
 * latch) and the per-document answers whose epoch bits the hop decides on.
 * It counts those, and nothing else:
 *
 *  - `maplespire_model_epoch_latch_requests_total{outcome}` — one per latch
 *    ask answered (or failed). Granted: a forward pass was owed and the
 *    trigger kept the ask's priority. Refused: `demoted` (past the
 *    workspace's burst or the process's reserved share, served as an
 *    ordinary request) and `forward_busy` (the answer carried `forwardBusy`:
 *    the latch could not be served at once). `not_needed`: nothing was owed
 *    (every asked source already forwarded, no epoch source at all, or the
 *    roll not past S7 — see below). `failed`: the route answered 503.
 *  - `maplespire_model_epoch_latch_hold_seconds` — how long the route held
 *    one latch ask (histogram). It is the SERVER's share of the tab's input
 *    freeze: the tab's latch lasts at most 2 s and holds several asks, its
 *    own flush and its network time; the server cannot see those.
 *  - `maplespire_model_epoch_durable_heads_answers_total{outcome}` — one per
 *    answered document: `forwarded` (`forwarded: true`), `forward_pending`,
 *    `epoch_retired`, on every ask; `s7_unproven` on latch asks only: an old
 *    ModelMeta (a `meta` row of `read_model_model_epoch_docs`) answered with
 *    neither `forwarded` nor `epochRetired` — the bit the hop waits for as
 *    the proof that the roll passed S7 (`verdictOf`). Its meta has no
 *    superseded row: a roll stopped between S6b and S7.
 *  - `maplespire_model_epoch_hop_stalled_metas` — the metas that received
 *    `s7_unproven` latch asks in at least {@link HOP_STALL_MIN_CYCLES}
 *    distinct HOP CYCLES whose last latch is inside the last hour, and whose
 *    S7 no answer has proven since: a hop that loops. A cycle is a run of
 *    such latch asks on the same meta with no gap of
 *    {@link HOP_CYCLE_GAP_MS} or more. Inside one ordinary hop two latches
 *    are at most ~82 s apart (backoff 10, 30, 60 s, `EPOCH_HOP_BACKOFF_MS`,
 *    plus up to 20 s of busy drain, `EPOCH_HOP_BUSY_DRAIN_MAX_MS`), so its
 *    ten latches (about 8 min) are ONE cycle. A STARVED hop latches 10 to
 *    30 min apart (`EPOCH_HOP_STARVED_BACKOFF_MS`): each of its latches is a
 *    cycle of its own, and one starved tab stalls the gauge in about 35 min.
 *    A hop that gave up on S7 (`epoch_hop.s7_unproven`) does not latch again
 *    in the current client: its abandoned-hop probe (`bridge.ts`,
 *    10 → 160 min) is not a latch ask, and it hops again only once S7 is
 *    proven. Several tabs latching together on the same meta make ONE cycle;
 *    tabs reaching the hop at different times (a reconnection, a tab from a
 *    bundle older than that probe, whose abandoned hop restarts with
 *    latches every ~18 min) make one each. So a stuck roll seen by a single
 *    current tab, or by tabs that all hopped together, does NOT raise it;
 *    the stuck row itself is read from the database by
 *    `epochStuckRows.ts` (alert EpochRollStuckBeforeS7).
 *    Any later answer for the meta that carries the bit proves S7 and
 *    forgets it. The staleness guard compares RECORDING times, not the
 *    times the answers were computed: an unproven answer
 *    whose recording started before the proof was recorded is ignored; one
 *    computed before the proof but recorded after it (it waited on the
 *    route's capability read), or one whose meta was not tracked yet when
 *    the proof came, is counted — at most one phantom cycle, under the
 *    threshold, gone an hour later.
 *  - `maplespire_model_epoch_hop_meta_lookup_failures_total` — latch asks
 *    whose meta lookup failed (its 2 s statement timeout included): their
 *    `s7_unproven` answers were NOT counted, so the gauge is blind for them.
 *  - `maplespire_model_epoch_hop_meta_lookups_skipped_total` — latch asks
 *    whose lookup was not made because one was already in flight for the
 *    same workspace, or four in all. Each lookup runs
 *    under a 2 s statement_timeout AND a client deadline 2 s above it
 *    (`queryWithStatementTimeout`); one that never settles is dropped after
 *    {@link epochMetaLookupStaleMs} (the pool's connect patience + 5 s; 15 s
 *    by default) and counted as a failure, so the guard cannot stay held.
 *
 * WHAT IT CANNOT SEE: a tab that sends nothing (closed, offline), the latches
 * of a tab whose asks never reach this cell, and how many users a looping
 * meta touches (the gauge counts metas, not tabs). State is in memory: a
 * restart forgets the cycles (the gauge needs three new ones). A cycle
 * leaves the window an hour after its LAST latch (about 8 min after its
 * first for a full hop), so the gauge drops below the threshold then,
 * whether or not the roll is still stuck: it says that tabs are paying
 * latches, not that the row is still `repointing`. After a recovery it
 * drops only at the next answer that proves the meta's S7 — the
 * abandoned-hop probe comes 10 to 160 min later — or by expiry: up to an
 * hour.
 *
 * `not_needed` also counts a latch ask with a pass owed while the forward
 * trigger does not exist yet (before the read model wires it); latch asks
 * answered 400/403/404 are counted under no outcome.
 *
 * COST: counters are increments. The meta lookup is ONE indexed query
 * (`read_model_model_epoch_docs` primary key) per LATCH ask only, issued
 * after that ask's answer is sent (never inside the answer; it can overlap
 * the tab's next ask of the same latch). The tracked metas are bounded by
 * {@link HOP_STALL_TRACKED_MAX}.
 */

export const EPOCH_LATCH_OUTCOMES = ['granted', 'demoted', 'forward_busy', 'not_needed', 'failed'] as const
export type EpochLatchOutcome = typeof EPOCH_LATCH_OUTCOMES[number]

export const DURABLE_HEADS_EPOCH_OUTCOMES = ['forwarded', 'forward_pending', 'epoch_retired', 's7_unproven'] as const
export type DurableHeadsEpochOutcome = typeof DURABLE_HEADS_EPOCH_OUTCOMES[number]

/** Bucket bounds of the latch hold histogram, in seconds, as label values.
 * The route waits at most 1.5 s for a pass (`FORWARD_TRIGGER_WAIT_MS`), then
 * answers again: a hold past 2 s is a latch the tab has already lifted. */
export const LATCH_HOLD_BUCKETS = ['0.01', '0.05', '0.1', '0.25', '0.5', '1', '1.5', '2', '5', '+Inf'] as const

/** A gap of this long between two unproven latch asks on one meta starts a
 * new hop cycle. */
export const HOP_CYCLE_GAP_MS = 5 * 60_000
/** Cycles count while their last latch is this recent. */
export const HOP_STALL_WINDOW_MS = 60 * 60_000
/** Cycles inside the window for a meta to count as stalled. */
export const HOP_STALL_MIN_CYCLES = 3
/** At most this many metas tracked; the one latched least recently goes. */
export const HOP_STALL_TRACKED_MAX = 1024

type EpochAnswer = Pick<DurableHeadResult, 'documentId' | 'forwarded' | 'forwardPending' | 'forwardBusy' | 'epochRetired'>

/** Does this answer carry the bit that proves its document superseded (S7)? */
const provesS7 = (answer: EpochAnswer): boolean => 'forwarded' in answer || answer.epochRetired === true

interface TrackedMeta {
  /** Each cycle's first and last unproven latch ask, oldest first. */
  cycles: Array<{ first: number; last: number }>
  /** The `model_epoch.hop_stalled` line was written for this crossing. */
  stalledLogged: boolean
}

/**
 * The outcome of one answered latch ask, from what the forward wait returned
 * (`awaitTriggeredForward`) and the answer it produced.
 */
export function latchOutcome(
  waited: { ended: string; granted: boolean },
  acknowledged: readonly EpochAnswer[],
): EpochLatchOutcome {
  if (acknowledged.some((d) => d.forwardBusy === true)) return 'forward_busy'
  if (waited.ended === 'not-triggered') return 'not_needed'
  return waited.granted ? 'granted' : 'demoted'
}

export class EpochHopTelemetry {
  private readonly latches = new Map<EpochLatchOutcome, number>()
  private readonly answers = new Map<DurableHeadsEpochOutcome, number>()
  /** Cumulative bucket counts, aligned with {@link LATCH_HOLD_BUCKETS}. */
  private readonly holdBuckets: number[] = LATCH_HOLD_BUCKETS.map(() => 0)
  private holdSumSeconds = 0
  private holdCount = 0
  private lookupFailures = 0
  private lookupsSkipped = 0
  private readonly lookupsInFlight = new Map<string, { since: number }>()
  /** Old meta document id -> its unproven hop cycles. */
  private readonly tracked = new Map<string, TrackedMeta>()
  /** Tracked metas a later answer proved, and when (pruned to the window,
   * bounded like `tracked`): a slower unproven ask made before is ignored. */
  private readonly provenAt = new Map<string, number>()

  constructor(
    readonly now: () => number = () => Date.now(),
    /** The line naming a meta that just became stalled — the identity the
     * gauge cannot carry (bounded labels only). */
    private readonly log: (line: string) => void = (line) => console.warn(line),
    /** From the primary pool's connect patience
     * (`DB_CONNECTION_TIMEOUT_MS`, the env the pool is built from). */
    private readonly lookupStaleMsOverride?: number,
  ) {}

  /** Read when first needed: the module-level instance is built before the
   * constants below are initialised. */
  get lookupStaleMs(): number {
    return this.lookupStaleMsOverride
      ?? epochMetaLookupStaleMs(databasePoolConfig(process.env).connectionTimeoutMillis ?? DEFAULT_POOL_CONNECTION_TIMEOUT_MS)
  }

  /** One latch ask: its outcome and how long the route held it. */
  recordLatch(outcome: EpochLatchOutcome, heldMs: number): void {
    this.latches.set(outcome, (this.latches.get(outcome) ?? 0) + 1)
    const seconds = Math.max(0, heldMs) / 1000
    LATCH_HOLD_BUCKETS.forEach((bound, index) => {
      if (bound === '+Inf' || seconds <= Number(bound)) this.holdBuckets[index]! += 1
    })
    this.holdSumSeconds += seconds
    this.holdCount += 1
  }

  /** Every ask's answers: the epoch outcomes, and S7 proven for a tracked
   * meta (which is then forgotten). */
  recordAnswers(acknowledged: readonly EpochAnswer[]): void {
    for (const answer of acknowledged) {
      if (answer.forwarded === true) this.bump('forwarded')
      if (answer.forwardPending === true) this.bump('forward_pending')
      if (answer.epochRetired === true) this.bump('epoch_retired')
      if (provesS7(answer) && this.tracked.delete(answer.documentId)) {
        if (this.provenAt.size >= HOP_STALL_TRACKED_MAX) this.provenAt.delete(this.provenAt.keys().next().value!)
        this.provenAt.set(answer.documentId, this.now())
      }
    }
  }

  /** A latch ask's answers for the documents known to be epoch metas: one
   * without the S7 bit is `s7_unproven`, and feeds its meta's hop cycles. */
  recordLatchMetas(
    acknowledged: readonly EpochAnswer[],
    metas: ReadonlySet<string>,
    workspace?: { landscapeId: string; versionId: string },
    /** When this ask's RECORDING started (default now): an
     * unproven answer recorded before a proof of the same meta is ignored. */
    askedAt?: number,
  ): void {
    const at = this.now()
    for (const answer of acknowledged) {
      if (!metas.has(answer.documentId) || provesS7(answer)) continue
      const proven = this.provenAt.get(answer.documentId)
      if (proven !== undefined && (askedAt ?? at) <= proven) continue
      this.bump('s7_unproven')
      const { meta, cycles } = this.noteUnproven(answer.documentId, at)
      // Once per crossing: when the meta reaches the threshold,
      // not again while it stays there — a starved hop that keeps 3 cycles
      // in the window logs once — and again only after it fell below.
      if (cycles >= HOP_STALL_MIN_CYCLES && !meta.stalledLogged) {
        meta.stalledLogged = true
        this.log(JSON.stringify({
          event: 'model_epoch.hop_stalled', metaDocumentId: answer.documentId,
          landscapeId: workspace?.landscapeId ?? null, versionId: workspace?.versionId ?? null, cycles,
          detail: 'latch asks in 3 hop cycles within the hour without the S7 proof; see https://github.com/MapleSpire/maplespire-sponsor-kit/blob/main/docs/operations/read-model-projector-health.md#runbook-epochhopstalled',
        }))
      }
    }
  }

  /** The meta lookup of a latch ask failed: its metas are unknown. */
  recordLookupFailure(): void {
    this.lookupFailures += 1
  }

  /** At most one meta lookup in flight PER
   * WORKSPACE and {@link EPOCH_META_LOOKUPS_MAX_IN_FLIGHT} in all. Null
   * (and counted as skipped): this ask's metas go unlooked. An entry older
   * than `lookupStaleMs` ({@link epochMetaLookupStaleMs}) is a lookup that
   * never settled: dropped and counted as a failure. */
  beginLookup(workspace: string): object | null {
    const at = this.now()
    for (const [key, entry] of this.lookupsInFlight) {
      if (at - entry.since >= this.lookupStaleMs) {
        this.lookupsInFlight.delete(key)
        this.lookupFailures += 1
      }
    }
    if (this.lookupsInFlight.has(workspace) || this.lookupsInFlight.size >= EPOCH_META_LOOKUPS_MAX_IN_FLIGHT) {
      this.lookupsSkipped += 1
      return null
    }
    const token = { since: at }
    this.lookupsInFlight.set(workspace, token)
    return token
  }

  /** Ends the lookup `token` started; a newer one for the workspace stays.
   * False when it was dropped as stale meanwhile (its failure counted). */
  endLookup(workspace: string, token: object): boolean {
    if (this.lookupsInFlight.get(workspace) !== token) return false
    this.lookupsInFlight.delete(workspace)
    return true
  }

  /** The metas whose hop loops (see the module comment). */
  stalledMetas(): number {
    const at = this.now()
    let stalled = 0
    for (const [id, provenAt] of this.provenAt) if (at - provenAt >= HOP_STALL_WINDOW_MS) this.provenAt.delete(id)
    for (const [id, meta] of this.tracked) {
      // A cycle leaves the window an hour after its LAST latch.
      meta.cycles = meta.cycles.filter((cycle) => at - cycle.last < HOP_STALL_WINDOW_MS)
      if (meta.cycles.length < HOP_STALL_MIN_CYCLES) meta.stalledLogged = false
      if (meta.cycles.length === 0) this.tracked.delete(id)
      else if (meta.cycles.length >= HOP_STALL_MIN_CYCLES) stalled += 1
    }
    return stalled
  }

  /** Tests: how many metas are tracked. */
  trackedCount(): number {
    return this.tracked.size
  }

  samples(): MetricSample[] {
    return [
      {
        name: 'maplespire_model_epoch_latch_requests_total',
        help: 'Epoch hop latch asks (durable-heads latch=1) answered by this cell, by outcome. Granted: a forward pass was owed and kept its priority. Refused: demoted (past the burst or the reserved share) and forward_busy (answered forwardBusy). not_needed: nothing was owed. failed: answered 503.',
        type: 'counter',
        values: EPOCH_LATCH_OUTCOMES.map((outcome) => ({ labels: { outcome }, value: this.latches.get(outcome) ?? 0 })),
      },
      {
        name: 'maplespire_model_epoch_latch_hold_seconds',
        help: 'How long this cell held one epoch hop latch ask: the server share of the tab input freeze (a latch lasts at most 2 s and holds several asks).',
        type: 'histogram',
        values: [
          ...LATCH_HOLD_BUCKETS.map((le, index) => ({ suffix: '_bucket' as const, labels: { le }, value: this.holdBuckets[index]! })),
          { suffix: '_sum', value: Number(this.holdSumSeconds.toFixed(6)) },
          { suffix: '_count', value: this.holdCount },
        ],
      },
      {
        name: 'maplespire_model_epoch_durable_heads_answers_total',
        help: 'Durable-heads answers of this cell by epoch outcome, one per document: forwarded, forward_pending, epoch_retired on every ask; s7_unproven on latch asks only, for an old ModelMeta answered without the S7 proof (a roll stopped between S6b and S7).',
        type: 'counter',
        values: DURABLE_HEADS_EPOCH_OUTCOMES.map((outcome) => ({ labels: { outcome }, value: this.answers.get(outcome) ?? 0 })),
      },
      {
        name: 'maplespire_model_epoch_hop_stalled_metas',
        help: 'Old ModelMetas that received s7_unproven latch asks in at least 3 hop cycles (runs of latches 5 min or more apart) in the last hour, with no answer proving their S7 since: an epoch hop that loops. Per cell, in memory.',
        type: 'gauge',
        values: [{ value: this.stalledMetas() }],
      },
      {
        name: 'maplespire_model_epoch_hop_meta_lookup_failures_total',
        help: 'Latch asks whose epoch meta lookup failed: their s7_unproven answers were not counted and the stalled-metas gauge did not see them.',
        type: 'counter',
        values: [{ value: this.lookupFailures }],
      },
      {
        name: 'maplespire_model_epoch_hop_meta_lookups_skipped_total',
        help: 'Latch asks whose epoch meta lookup was not made because one was already in flight for the same workspace, or 4 in all: their s7_unproven answers were not counted.',
        type: 'counter',
        values: [{ value: this.lookupsSkipped }],
      },
    ]
  }

  private bump(outcome: DurableHeadsEpochOutcome): void {
    this.answers.set(outcome, (this.answers.get(outcome) ?? 0) + 1)
  }

  /** Feeds the meta's cycles; `cycles` is how many are in the window when
   * this ask STARTED a cycle, 0 when it joined the current one. */
  private noteUnproven(id: string, at: number): { meta: TrackedMeta; cycles: number } {
    let meta = this.tracked.get(id)
    if (!meta) {
      if (this.tracked.size >= HOP_STALL_TRACKED_MAX) this.evictLeastRecent()
      meta = { cycles: [], stalledLogged: false }
      this.tracked.set(id, meta)
    }
    const current = meta.cycles[meta.cycles.length - 1]
    if (current && at - current.last < HOP_CYCLE_GAP_MS) {
      current.last = Math.max(current.last, at)
      return { meta, cycles: 0 }
    }
    meta.cycles = meta.cycles.filter((cycle) => at - cycle.last < HOP_STALL_WINDOW_MS)
    if (meta.cycles.length < HOP_STALL_MIN_CYCLES) meta.stalledLogged = false
    meta.cycles.push({ first: at, last: at })
    return { meta, cycles: meta.cycles.length }
  }

  private evictLeastRecent(): void {
    let oldest: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, meta] of this.tracked) {
      const last = meta.cycles[meta.cycles.length - 1]?.last ?? Number.NEGATIVE_INFINITY
      if (last < oldestAt) { oldest = id; oldestAt = last }
    }
    if (oldest !== null) this.tracked.delete(oldest)
  }
}

/** The process's telemetry (one per cell). */
export const epochHopTelemetry = new EpochHopTelemetry()

/** The /metrics samples, built HERE so their presence is unit-testable;
 * index.ts spreads them into its payload. */
export function epochHopMetricSamples(telemetry: EpochHopTelemetry = epochHopTelemetry): MetricSample[] {
  return telemetry.samples()
}

/**
 * The durable-heads route's telemetry, called AFTER the answer was sent.
 * `latch` carries a latch ask's outcome and hold; `metaDocumentIds` resolves
 * which asked documents are epoch metas (a latch ask only). Never throws.
 */
export async function recordDurableHeadsTelemetry(input: {
  telemetry?: EpochHopTelemetry
  /** Named in the `model_epoch.hop_stalled` line only, never a label. */
  workspace?: { landscapeId: string; versionId: string }
  acknowledged: readonly EpochAnswer[]
  latch: { outcome: EpochLatchOutcome; heldMs: number } | null
  metaDocumentIds: (documentIds: string[]) => Promise<ReadonlySet<string>>
}): Promise<void> {
  const telemetry = input.telemetry ?? epochHopTelemetry
  const askedAt = telemetry.now()
  try {
    telemetry.recordAnswers(input.acknowledged)
    if (!input.latch) return
    telemetry.recordLatch(input.latch.outcome, input.latch.heldMs)
    if (input.latch.outcome === 'failed' || input.acknowledged.length === 0) return
  } catch (error) {
    // Called with `void` after the answer: a rejection would be unhandled.
    console.warn('durable-heads: epoch hop telemetry failed', error)
    return
  }
  const lookupKey = input.workspace ? `${input.workspace.landscapeId}/${input.workspace.versionId}` : ''
  const token = telemetry.beginLookup(lookupKey)
  if (!token) return
  let metas: ReadonlySet<string>
  try {
    metas = await input.metaDocumentIds(input.acknowledged.map((a) => a.documentId))
  } catch (error) {
    if (telemetry.endLookup(lookupKey, token)) telemetry.recordLookupFailure()
    console.warn('durable-heads: the epoch meta lookup of a latch ask failed; its s7_unproven answers are not counted', error)
    return
  }
  // Dropped as stale meanwhile (already counted a failure): a late answer
  // records nothing.
  if (!telemetry.endLookup(lookupKey, token)) return
  try {
    telemetry.recordLatchMetas(input.acknowledged, metas, input.workspace, askedAt)
  } catch (error) {
    console.warn('durable-heads: epoch hop telemetry failed', error)
  }
}

/** The meta lookup's statement_timeout: 2 s. A primary-key read (`= ANY`
 * on `document_id`); anything near this is a lock wait. Bounds how long one
 * lookup holds its primary-pool client. */
export const EPOCH_META_LOOKUP_TIMEOUT_MS = 2_000
/** Lookups in flight at once, over all workspaces (one per
 * workspace). A small bound: each holds one primary-pool client (default
 * pool max 10, `dbConfig.ts`) for at most its client deadline. */
export const EPOCH_META_LOOKUPS_MAX_IN_FLIGHT = 4
/** A lookup in flight longer than this never settled:
 * the pool's own connect patience (`connectionTimeoutMillis`) plus the
 * lookup's client deadline (2 + 2 s) plus 1 s — never shorter than what
 * the pool may make it wait. 15 s with the default pool. */
export function epochMetaLookupStaleMs(connectionTimeoutMs: number): number {
  return connectionTimeoutMs + EPOCH_META_LOOKUP_TIMEOUT_MS + CLIENT_DEADLINE_MARGIN_MS + 1_000
}
export const EPOCH_META_LOOKUP_STALE_MS = epochMetaLookupStaleMs(DEFAULT_POOL_CONNECTION_TIMEOUT_MS)

/** Which of `documentIds` are a ModelMeta of one of the workspace's epochs
 * (`read_model_model_epoch_docs.role = 'meta'`, the legacy epoch 0 included).
 * Empty when the table does not exist. */
export async function epochMetaDocumentIds(
  db: Parameters<typeof queryWithStatementTimeout>[0],
  workspace: { landscapeId: string; versionId: string },
  documentIds: string[],
): Promise<Set<string>> {
  try {
    const { rows } = await queryWithStatementTimeout<{ document_id: string }>(db,
      `SELECT document_id FROM read_model_model_epoch_docs
        WHERE document_id = ANY($3::text[]) AND landscape_id = $1 AND version_id = $2 AND role = 'meta'`,
      [workspace.landscapeId, workspace.versionId, documentIds], EPOCH_META_LOOKUP_TIMEOUT_MS)
    return new Set(rows.map((r) => r.document_id))
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') return new Set()
    throw error
  }
}
