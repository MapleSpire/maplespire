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

import type { MetricSample } from '../runtime/metrics.js'
import {
  DEFAULT_ORDINARY_CHAIN_ALERT_LENGTH,
  type OrdinaryHeadKind,
  type OrdinaryHeadRotationConfig,
  type OrdinaryHeadRotationTrigger,
} from './ordinaryHeadRotation.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16e: how fast an allow-listed ordinary workspace rotates, and how long
 * its chain has become — published by the owner cell in `/api/automerge/stats`
 * (per workspace and collection, `automergeStatsBody.ts`) and, without any
 * workspace label, in `/metrics` (`ordinaryRotationMetricSamples`, alerted by
 * `ReadModelOrdinaryChainUnbounded` in `infra/monitoring/alerts.yml`).
 *
 * COST. Nothing here loads a document or issues SQL. Rotations are counted
 * where the rotator returns `rotated` (`projectorService.ts`). The rest is
 * read, at snapshot time, from what the workspace's projector already holds:
 * the length of two ModelMeta lists on its resident ModelMeta handle, its
 * parked-head map, its cached retirement rows (reloaded on every write-head
 * pointer move, so after every rotation) and the last `A.stats` of the current
 * head its rotation observer read (`ordinaryHeadRotation.ts`). A snapshot is
 * O(retirement rows + parked heads) of the registered projectors, and a
 * projector is registered only when it ROTATES (`on`, explicitly
 * allow-listed) and owns the workspace at attach, so the workspace keys the
 * stats body exposes are the ones an operator named.
 *
 * TWO RATES, and which is authoritative.
 *  - `rotationsLast24h` / `7d` / `30d` are DURABLE: counted from the
 *    `created_at` of the workspace's `retired` and `folded` retirement rows
 *    the ROTATOR wrote (`origin`; a fold product's row is not a rotation),
 *    so they survive a restart and an owner move. They are THE rotation rate
 *    ON THE OWNER (`resident: true`): a cell that lost the workspace keeps
 *    the rows it last read, and its windows then DECAY as time moves past
 *    them (`observedAt` says how old they are). With the fold on, a folded row
 *    is swept once its product is folded again and its `retain_until` has
 *    passed (168 h by default), so the 30-day window undercounts there; a
 *    product row written before the `origin` column whose fold record was
 *    already swept is counted as a rotation (`schema.ts`).
 *  - `rotations` and `rotationsByTrigger` are counted by THIS process since it
 *    booted (`processBootId` tells a restart from a fall), for every projector
 *    it ran for the workspace. Kept for the trigger — which threshold made the
 *    head due first, the open question of G4-16e (does rotation follow
 *    sessions, the actors threshold, or edit volume, the changes one?) — and
 *    for `maplespire_read_model_ordinary_head_rotations_total`, whose `rate()`
 *    Prometheus takes across restarts itself.
 *
 * NOT RESIDENT. When the projector is gone (LRU eviction, release, stop) the
 * entry keeps the LAST KNOWN chain and rows (`observedAt` says when), so the
 * alert does not flap with residency: with the fold off the chain only grows.
 * `parkedHeads` and `currentHead` are facts of a live projector and are null.
 *
 * THE ALERT (G4-16e step 3). With rotation `on` and the fold `off`, nothing
 * ever shortens the chain (`docs/read-model-projector-health.md`, "Unbounded
 * segment chain"). When the overlay list ModelMeta names for a kind is longer
 * than `AM_ORDINARY_CHAIN_ALERT_LENGTH` (0 disables), the entry carries
 * `chainAlert: true`, the snapshot counts it in `chainAlerts` (and so does
 * the gauge), and one `read_model.ordinary_chain_length_alert` line is logged
 * on the crossing — once per workspace and kind for the life of the process,
 * again only after the list fell back under the threshold. With the fold `on`
 * the alert is off: the fold has its own concern on the bench.
 */

/** What a projector reports for one kind, read live at snapshot time. */
export interface OrdinaryRotationLiveView {
  /** ModelMeta's read order (`objectShardUrls`) and overlay list
   * (`editsObjectShardUrls`) lengths; null when ModelMeta is not resident. */
  listed(kind: OrdinaryHeadKind): { shards: number | null; overlay: number | null }
  parkedHeads(kind: OrdinaryHeadKind): number
  /** Cached retirement rows by status (`ordinaryHeadForwarding.ts`), and the
   * `created_at` (epoch ms) of every `retired` or `folded` one. */
  rows(kind: OrdinaryHeadKind): { retired: number; folded: number; createdAtMs: readonly number[] }
  /** The current head's last observed counts, or null if never observed. */
  currentHead(kind: OrdinaryHeadKind): { actors: number; changes: number } | null
}

export type OrdinaryRotationTriggerCounts = Record<OrdinaryHeadRotationTrigger | 'unknown', number>

export interface OrdinaryRotationTelemetryEntry {
  workspace: string
  collection: OrdinaryHeadKind
  /** A projector of this process reports the live fields now. */
  resident: boolean
  /** When the chain and rows below were last read from a live projector. */
  observedAt: string | null
  /** This process, since boot. */
  rotations: number
  rotationsByTrigger: OrdinaryRotationTriggerCounts
  lastRotatedAt: string | null
  /** Durable, from the rotator's rows' `created_at`; null when never
   * observed. The rate only while `resident`: otherwise frozen rows against
   * a moving clock, decaying (see `observedAt`). */
  rotationsLast24h: number | null
  rotationsLast7d: number | null
  rotationsLast30d: number | null
  /** ModelMeta's read order for the kind: what an attach or a cold build walks. */
  listedShards: number | null
  /** ModelMeta's overlay list for the kind: what a rotation grows and a fold
   * shortens; the alert's subject. Last known when not resident. */
  overlayChain: number | null
  parkedHeads: number | null
  retiredRows: number | null
  foldedRows: number | null
  /** The current head's counts as the observer last read them — NOT the
   * retired head's at its rotation: right after a rotation the new head has
   * not been observed yet and this is null. The trigger counts above are
   * what says which threshold a rotation crossed. */
  currentHead: { actors: number; changes: number } | null
  chainAlert: boolean
}

export interface OrdinaryRotationTelemetrySnapshot {
  mode: OrdinaryHeadRotationConfig['mode']
  chainFold: boolean
  /** Rotation `on` for a non-empty allow-list with the fold `off`: the
   * configuration under which nothing bounds the chain. */
  unboundedChainConfig: boolean
  /** 0: the alert cannot fire (disabled, fold on, or rotation not on). */
  chainAlertLength: number
  chainAlerts: number
  entries: OrdinaryRotationTelemetryEntry[]
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
const KINDS: readonly OrdinaryHeadKind[] = ['object', 'connection']
const TRIGGERS: ReadonlyArray<OrdinaryHeadRotationTrigger | 'unknown'> = ['actors', 'changes', 'both', 'unknown']
const noTriggers = (): OrdinaryRotationTriggerCounts => ({ actors: 0, changes: 0, both: 0, unknown: 0 })

const workspaceOf = (key: WorkspaceKey): string => `${key.landscapeId}/${key.versionId}`

/** The alert's threshold for this config: 0 when it cannot fire (rotation not
 * `on`, or the fold `on`) or was disabled. */
export function ordinaryChainAlertLength(config: OrdinaryHeadRotationConfig): number {
  if (config.mode !== 'on' || config.chainFold) return 0
  return config.chainAlertLength ?? DEFAULT_ORDINARY_CHAIN_ALERT_LENGTH
}

/** Rotation `on`, something allow-listed, the fold `off`. */
export function ordinaryChainUnboundedConfig(config: OrdinaryHeadRotationConfig): boolean {
  return config.mode === 'on' && !config.chainFold
    && (config.allowlist === 'all' || config.allowlist.size > 0)
}

/** The boot line for {@link ordinaryChainUnboundedConfig}, or null. */
export function ordinaryChainUnboundedBootWarning(config: OrdinaryHeadRotationConfig): string | null {
  if (!ordinaryChainUnboundedConfig(config)) return null
  return JSON.stringify({
    event: 'read_model.ordinary_chain_unbounded_config',
    rotation: 'on',
    chainFold: 'off',
    workspaces: config.allowlist === 'all' ? 'all' : config.allowlist.size,
    chainAlertLength: ordinaryChainAlertLength(config),
    detail: 'every rotation appends a segment and nothing removes one; see docs/read-model-projector-health.md, "Runbook: ReadModelOrdinaryChainUnbounded"',
  })
}

interface LastKnown {
  at: number
  listedShards: number | null
  overlayChain: number | null
  retiredRows: number | null
  foldedRows: number | null
  createdAtMs: readonly number[] | null
}

export class OrdinaryRotationTelemetry {
  private readonly totals = new Map<string, { count: number; last: number; byTrigger: OrdinaryRotationTriggerCounts }>()
  /** workspace -> the view of the projector registered LAST for it. */
  private readonly views = new Map<string, { token: symbol; view: OrdinaryRotationLiveView }>()
  /** workspace/kind -> what the last live read said. Bounded by the
   * allow-list: one per workspace this process has rotated, times two. */
  private readonly lastKnown = new Map<string, LastKnown>()
  /** workspace/kind over the threshold, already logged. */
  private readonly alerted = new Set<string>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** A projector's view, until the returned function is called. A later
   * registration for the same workspace replaces it (a re-attach), and the
   * earlier one's unregister then does nothing. */
  register(key: WorkspaceKey, view: OrdinaryRotationLiveView): () => void {
    const workspace = workspaceOf(key)
    const token = Symbol(workspace)
    this.views.set(workspace, { token, view })
    return () => {
      if (this.views.get(workspace)?.token !== token) return
      // One last read, so what the entry keeps is the chain as it was when
      // the projector let go, not as it was at the last scrape.
      for (const kind of KINDS) this.readLive(`${workspace}/${kind}`, view, kind)
      this.views.delete(workspace)
    }
  }

  recordRotation(key: WorkspaceKey, kind: OrdinaryHeadKind, trigger: OrdinaryHeadRotationTrigger | null): void {
    const id = `${workspaceOf(key)}/${kind}`
    const total = this.totals.get(id) ?? { count: 0, last: 0, byTrigger: noTriggers() }
    total.count += 1
    total.last = this.now()
    total.byTrigger[trigger ?? 'unknown'] += 1
    this.totals.set(id, total)
  }

  /**
   * Called when the overlay list may have grown (attach, after a rotation).
   * Logs once on the crossing; returns whether the list is over the threshold.
   */
  observeChain(
    key: WorkspaceKey,
    kind: OrdinaryHeadKind,
    overlay: number | null,
    config: OrdinaryHeadRotationConfig,
    shards: number | null = null,
  ): boolean {
    const id = `${workspaceOf(key)}/${kind}`
    if (overlay !== null) {
      const known = this.lastKnown.get(id)
      this.lastKnown.set(id, {
        at: this.now(), listedShards: shards, overlayChain: overlay,
        retiredRows: known?.retiredRows ?? null, foldedRows: known?.foldedRows ?? null,
        createdAtMs: known?.createdAtMs ?? null,
      })
    }
    const threshold = ordinaryChainAlertLength(config)
    const over = threshold > 0 && overlay !== null && overlay > threshold
    if (!over) {
      this.alerted.delete(id)
      return false
    }
    if (!this.alerted.has(id)) {
      this.alerted.add(id)
      this.log(JSON.stringify({
        event: 'read_model.ordinary_chain_length_alert',
        workspace: workspaceOf(key),
        kind,
        overlay,
        shards,
        threshold,
        chainFold: 'off',
      }))
    }
    return true
  }

  snapshot(config: OrdinaryHeadRotationConfig): OrdinaryRotationTelemetrySnapshot {
    const at = this.now()
    const threshold = ordinaryChainAlertLength(config)
    const ids = new Set<string>([...this.totals.keys(), ...this.lastKnown.keys()])
    for (const workspace of this.views.keys()) for (const kind of KINDS) ids.add(`${workspace}/${kind}`)
    const entries: OrdinaryRotationTelemetryEntry[] = []
    for (const id of [...ids].sort()) {
      const cut = id.lastIndexOf('/')
      const workspace = id.slice(0, cut)
      const collection = id.slice(cut + 1) as OrdinaryHeadKind
      const total = this.totals.get(id)
      const view = this.views.get(workspace)?.view
      const live = view ? this.readLive(id, view, collection) : null
      const known = this.lastKnown.get(id)
      const since = (ms: number) => (known?.createdAtMs ? known.createdAtMs.filter((t) => t > at - ms).length : null)
      const overlayChain = known?.overlayChain ?? null
      entries.push({
        workspace,
        collection,
        resident: live !== null,
        observedAt: known ? new Date(known.at).toISOString() : null,
        rotations: total?.count ?? 0,
        rotationsByTrigger: { ...(total?.byTrigger ?? noTriggers()) },
        lastRotatedAt: total ? new Date(total.last).toISOString() : null,
        rotationsLast24h: since(DAY_MS),
        rotationsLast7d: since(7 * DAY_MS),
        rotationsLast30d: since(30 * DAY_MS),
        listedShards: known?.listedShards ?? null,
        overlayChain,
        parkedHeads: live?.parkedHeads ?? null,
        retiredRows: known?.retiredRows ?? null,
        foldedRows: known?.foldedRows ?? null,
        currentHead: live?.currentHead ?? null,
        chainAlert: threshold > 0 && overlayChain !== null && overlayChain > threshold,
      })
    }
    return {
      mode: config.mode,
      chainFold: Boolean(config.chainFold),
      unboundedChainConfig: ordinaryChainUnboundedConfig(config),
      chainAlertLength: threshold,
      chainAlerts: entries.filter((entry) => entry.chainAlert).length,
      entries,
    }
  }

  /** Tests only: forget everything. */
  resetForTest(): void {
    this.totals.clear()
    this.views.clear()
    this.lastKnown.clear()
    this.alerted.clear()
  }

  /** Read a view and remember it; null when it throws (a reader's problem,
   * never the stats route's — the last known values stay). */
  private readLive(id: string, view: OrdinaryRotationLiveView, kind: OrdinaryHeadKind): {
    parkedHeads: number
    currentHead: { actors: number; changes: number } | null
  } | null {
    try {
      const listed = view.listed(kind)
      const rows = view.rows(kind)
      const live = { parkedHeads: view.parkedHeads(kind), currentHead: view.currentHead(kind) }
      const previous = this.lastKnown.get(id)
      this.lastKnown.set(id, {
        at: this.now(),
        // ModelMeta not resident: keep what was known rather than forget it.
        listedShards: listed.shards ?? previous?.listedShards ?? null,
        overlayChain: listed.overlay ?? previous?.overlayChain ?? null,
        retiredRows: rows.retired,
        foldedRows: rows.folded,
        createdAtMs: [...rows.createdAtMs],
      })
      return live
    } catch { return null }
  }
}

/** The process's one instance: projectors write it, the routes read it. */
export const ordinaryRotationTelemetry = new OrdinaryRotationTelemetry()

/**
 * The `/metrics` samples (G4-16e step 3). NO WORKSPACE LABELS, as for
 * `overlayRotationLockMetricSamples`: the stats body and the log line say
 * which workspace; these say whether any. Per CELL, not fleet facts: each cell
 * reports the workspaces it rotated, and a cell that lost one keeps its last
 * known chain, so the rule takes `max()` across cells (`sum()` would count a
 * workspace twice after a takeover).
 */
export function ordinaryRotationMetricSamples(
  config: OrdinaryHeadRotationConfig,
  telemetry: OrdinaryRotationTelemetry = ordinaryRotationTelemetry,
): MetricSample[] {
  const snapshot = telemetry.snapshot(config)
  const longest = (kind: OrdinaryHeadKind) => Math.max(0, ...snapshot.entries
    .filter((entry) => entry.collection === kind && entry.overlayChain !== null)
    .map((entry) => entry.overlayChain!))
  return [
    {
      name: 'maplespire_read_model_ordinary_chain_alerts',
      help: 'Rotating workspace/collection pairs whose overlay chain is longer than AM_ORDINARY_CHAIN_ALERT_LENGTH, with rotation on and the fold off (last known when not resident). Zero is healthy.',
      type: 'gauge',
      values: [{ value: snapshot.chainAlerts }],
    },
    {
      name: 'maplespire_read_model_ordinary_overlay_chain_max',
      help: 'Longest overlay chain (edits*ShardUrls) among the workspaces this cell rotates, per collection; 0 when none. An attach costs ~24 ms per listed segment (G4-16e).',
      type: 'gauge',
      values: KINDS.map((collection) => ({ labels: { collection }, value: longest(collection) })),
    },
    {
      name: 'maplespire_read_model_ordinary_rotation_unbounded_chain',
      help: '1 when this cell runs ordinary head rotation on for an allow-list with the chain fold off: nothing shortens the chain.',
      type: 'gauge',
      values: [{ value: snapshot.unboundedChainConfig ? 1 : 0 }],
    },
    {
      name: 'maplespire_read_model_ordinary_head_rotations_total',
      help: 'Ordinary write-head rotations by this process since start, by collection and by the threshold that made the head due first (actors, changes, both, unknown).',
      type: 'counter',
      values: KINDS.flatMap((collection) => TRIGGERS.map((trigger) => ({
        labels: { collection, trigger },
        value: snapshot.entries.filter((entry) => entry.collection === collection)
          .reduce((sum, entry) => sum + entry.rotationsByTrigger[trigger], 0),
      }))),
    },
  ]
}
