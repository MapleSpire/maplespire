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

import { stats } from '@automerge/automerge'
import { envNumber } from '../envNumber.js'
import { parseWorkspaceKeyList } from './compactionAllowlist.js'
import type { WorkspaceKey } from './projector.js'

/**
 * Ordinary-workspace writer-head rotation — the CONFIG and the OBSERVER.
 *
 * An ordinary workspace's ModelMeta points at overlay write heads
 * (`editsObjectShardUrl` / `editsConnectionShardUrl`) whose Automerge history
 * nothing else bounds, and a new actor's first change into a long history is
 * what costs under load. The owner cell's projector reads `A.stats` on the
 * CURRENT heads and, once a head crosses a threshold:
 *
 *  - `shadow` (phase 1) writes one log line and nothing else — no Automerge
 *    document, no SQL (`ordinaryHeadRotation.test.ts` counts the `.change()`
 *    calls);
 *  - `on` (phase 3) also asks the rotator (`ordinaryHeadRotator.ts`) to replace
 *    the head with a fresh one. Late writes into the retired head are
 *    forwarded (`ordinaryHeadForwarding.ts`).
 *
 * `on` REQUIRES AN EXPLICIT ALLOW-LIST. `*` is refused at parse time with
 * `on`: the rotator creates documents and rewrites ModelMeta, and turning it
 * on for every workspace a cell will ever own is a decision nobody should be
 * able to make with one character. `shadow` keeps accepting `*` — it writes
 * nothing.
 */
export const ORDINARY_HEAD_ROTATION_FLAG = 'AM_ORDINARY_HEAD_ROTATION'
/** `landscapeId/versionId`, comma- or whitespace-separated, same entry rule as
 * `COMPACTION_WORKSPACE_ALLOWLIST`; `*` admits every workspace in `shadow`
 * and is refused with `on`. Empty admits none. */
export const ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV = 'AM_ORDINARY_HEAD_ROTATION_WORKSPACE_ALLOWLIST'
export const ORDINARY_HEAD_ROTATION_MAX_ACTORS_ENV = 'AM_ORDINARY_HEAD_ROTATION_MAX_ACTORS'
export const ORDINARY_HEAD_ROTATION_MAX_CHANGES_ENV = 'AM_ORDINARY_HEAD_ROTATION_MAX_CHANGES'
export const DEFAULT_ORDINARY_HEAD_MAX_ACTORS = 128
export const DEFAULT_ORDINARY_HEAD_MAX_CHANGES = 512
/** G4-16b phase 4: the ordinary CHAIN FOLD (`ordinaryChainFoldWriter.ts`),
 * `off` (default) or `on`. `on` is refused unless rotation is `on`: it
 * folds only what rotation retired, for the same allow-list. A binary older
 * than phase 4 step 2 mishandles a `folded` row, so turn it on only once
 * every replica runs step 2 or later. */
export const ORDINARY_CHAIN_FOLD_FLAG = 'AM_ORDINARY_CHAIN_FOLD'
/** Fold once at least this many retired heads of one kind are foldable. */
export const ORDINARY_CHAIN_FOLD_MIN_ENV = 'AM_ORDINARY_CHAIN_FOLD_MIN'
/** At most this many heads per fold. */
export const ORDINARY_CHAIN_FOLD_BUDGET_ENV = 'AM_ORDINARY_CHAIN_FOLD_BUDGET'
/** How long a folded head's document must outlive its listing (GC, step 5). */
export const ORDINARY_CHAIN_FOLD_RETAIN_HOURS_ENV = 'AM_ORDINARY_CHAIN_FOLD_RETAIN_HOURS'
export const DEFAULT_ORDINARY_CHAIN_FOLD_MIN = 8
export const DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET = 8
export const DEFAULT_ORDINARY_CHAIN_FOLD_RETAIN_HOURS = 168
/** G4-16e: with rotation `on` and the fold `off`, alert when the overlay list
 * ModelMeta names for a kind (`editsObjectShardUrls`) is LONGER than this
 * (`ordinaryRotationTelemetry.ts`: one log line on the crossing, a flag in
 * `/api/automerge/stats`). 0 disables. Read only when rotation is not `off`. */
export const ORDINARY_CHAIN_ALERT_LENGTH_ENV = 'AM_ORDINARY_CHAIN_ALERT_LENGTH'
/** 64 segments: an attach (cold build) measured ~24 ms per listed segment on
 * the Mac (K = 10 / 100 / 1000: 0.38 / 2.3 / 23.8 s,
 * `docs/plan-cellulaire/mesures/G4-16e-rotation-rate.json`), so 64 adds
 * ~1.5 s — a threshold for a person to look, not a limit anything enforces. */
export const DEFAULT_ORDINARY_CHAIN_ALERT_LENGTH = 64
/** A due head is rotated once its writes have been quiet this long, or once
 * this much has passed since it was first found due, whichever comes first
 * (`projectorService.ts`, `requestRotation`). Measured on the PC bench
 * (2026-11-03, CPU profiles of the rotating cells, 8 rotations each): the
 * writes that make a head due arrive in a burst, and a rotation inside it
 * stacked the new head's and ModelMeta's sync to ~110 peers and the late
 * forwards onto the burst — 783 ms of main-thread CPU in its peak second
 * against ~470 for a burst alone, which is what took the event loop's p99
 * past 100 ms about once an hour. The bench's bursts last 2–3 s, 13 s apart.
 * That the deferral brings the p99 back under 100 ms is NOT measured yet: it
 * needs the 2 h soak run again. */
export const DEFAULT_ORDINARY_HEAD_ROTATION_QUIET_MS = 2_000
export const DEFAULT_ORDINARY_HEAD_ROTATION_MAX_DEFER_MS = 30_000

export type OrdinaryHeadKind = 'object' | 'connection'
type Dimension = 'actors' | 'changes'
/** Which threshold made a head due, on the FIRST pass that found it due:
 * `both` when that one pass crossed the two at once (G4-16e). */
export type OrdinaryHeadRotationTrigger = Dimension | 'both'
/** Two kinds, a handful of due-but-unrotated heads each: far above what one
 * projector holds, small enough never to matter. */
export const MAX_REMEMBERED_TRIGGERS = 16

export interface OrdinaryHeadRotationConfig {
  readonly mode: 'off' | 'shadow' | 'on'
  readonly allowlist: ReadonlySet<string> | 'all'
  readonly maxActors: number
  readonly maxChanges: number
  /** The rotation's quiet window and its cap; unset is the defaults above.
   * `quietMs: 0` rotates as soon as the head is due (no deferral). Not read
   * from the environment. */
  readonly deferral?: {
    readonly quietMs: number
    readonly maxMs: number
  }
  /** Present only with `AM_ORDINARY_CHAIN_FOLD=on`. */
  readonly chainFold?: {
    readonly minChain: number
    readonly budget: number
    readonly retainMs: number
  }
  /** `AM_ORDINARY_CHAIN_ALERT_LENGTH`; unset is the default above. Only
   * consulted with `on` and no `chainFold`. */
  readonly chainAlertLength?: number
}

export const ORDINARY_HEAD_ROTATION_OFF: OrdinaryHeadRotationConfig = Object.freeze({
  mode: 'off',
  allowlist: new Set<string>(),
  maxActors: DEFAULT_ORDINARY_HEAD_MAX_ACTORS,
  maxChanges: DEFAULT_ORDINARY_HEAD_MAX_CHANGES,
})

/** Missing, blank and `off` resolve to OFF before any other knob is read.
 * Anything else that is not `shadow` or `on` throws, and `on` with `*`
 * throws — see the module header. */
export function ordinaryHeadRotationConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OrdinaryHeadRotationConfig {
  const flag = env[ORDINARY_HEAD_ROTATION_FLAG]?.trim()
  // BEFORE rotation's own early return: `fold=on` with rotation off is a
  // configuration that asked for something it will not get, so it is refused
  // rather than ignored.
  const fold = env[ORDINARY_CHAIN_FOLD_FLAG]?.trim()
  if (fold !== undefined && fold !== '' && fold !== 'off' && fold !== 'on') {
    throw new Error(`invalid-${ORDINARY_CHAIN_FOLD_FLAG}`)
  }
  if (fold === 'on' && flag !== 'on') {
    throw new Error(`${ORDINARY_CHAIN_FOLD_FLAG}=on needs ${ORDINARY_HEAD_ROTATION_FLAG}=on`)
  }
  if (flag === undefined || flag === '' || flag === 'off') return ORDINARY_HEAD_ROTATION_OFF
  if (flag !== 'shadow' && flag !== 'on') throw new Error(`invalid-${ORDINARY_HEAD_ROTATION_FLAG}`)
  const rawAllowlist = env[ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV]?.trim() ?? ''
  if (flag === 'on' && rawAllowlist === '*') {
    throw new Error(
      `${ORDINARY_HEAD_ROTATION_FLAG}=on refuses ${ORDINARY_HEAD_ROTATION_ALLOWLIST_ENV}=*: `
      + 'name each workspace (landscapeId/versionId) rotation may write',
    )
  }
  const bounds = { minimum: 1, maximum: 1_000_000, integer: true }
  return {
    ...(fold === 'on' ? {
      chainFold: {
        // Two is the smallest run a fold can merge.
        minChain: envNumber(ORDINARY_CHAIN_FOLD_MIN_ENV,
          { minimum: 2, maximum: 4_096, integer: true, fallback: DEFAULT_ORDINARY_CHAIN_FOLD_MIN }, env),
        budget: envNumber(ORDINARY_CHAIN_FOLD_BUDGET_ENV,
          { minimum: 2, maximum: 256, integer: true, fallback: DEFAULT_ORDINARY_CHAIN_FOLD_BUDGET }, env),
        retainMs: 3_600_000 * envNumber(ORDINARY_CHAIN_FOLD_RETAIN_HOURS_ENV,
          { minimum: 1, maximum: 24 * 365, integer: true, fallback: DEFAULT_ORDINARY_CHAIN_FOLD_RETAIN_HOURS }, env),
      },
    } : {}),
    mode: flag,
    allowlist: rawAllowlist === '*' ? 'all' : parseWorkspaceKeyList(rawAllowlist),
    maxActors: envNumber(ORDINARY_HEAD_ROTATION_MAX_ACTORS_ENV,
      { ...bounds, fallback: DEFAULT_ORDINARY_HEAD_MAX_ACTORS }, env),
    maxChanges: envNumber(ORDINARY_HEAD_ROTATION_MAX_CHANGES_ENV,
      { ...bounds, fallback: DEFAULT_ORDINARY_HEAD_MAX_CHANGES }, env),
    // Floor 0, not 1: an explicit 0 is the documented "disabled". A blank
    // still falls back to the default (`envNumber`), never to 0.
    chainAlertLength: envNumber(ORDINARY_CHAIN_ALERT_LENGTH_ENV,
      { minimum: 0, maximum: 1_000_000, integer: true, fallback: DEFAULT_ORDINARY_CHAIN_ALERT_LENGTH }, env),
  }
}

/** Is `key` named by `config` (any mode but `off`)? */
export function ordinaryHeadRotationAdmits(config: OrdinaryHeadRotationConfig, key: WorkspaceKey): boolean {
  return config.mode !== 'off' && (config.allowlist === 'all'
    || config.allowlist.has(`${key.landscapeId}/${key.versionId}`))
}

/**
 * One per projector, so one per owned workspace on the owner cell. The caller
 * decides ownership and "is this the CURRENT head"; this decides whether to
 * look, whether to speak, and whether the head is DUE.
 *
 * The LOG is deduplicated per head and dimension for the life of the
 * projector: both counts only grow within one head, so a crossing is a
 * one-time fact, and a per-pass line would repeat it on every edit. A
 * projector restart, takeover or LRU re-attach re-reports once, which is the
 * new projector learning it. The DUE answer is not deduplicated: a head that
 * crossed stays due on every later pass until it stops being current, which
 * is what lets a refused rotation be asked for again (by the next pass, or by
 * the rotator's own retry). A head with both dimensions reported is due
 * without being inspected again.
 *
 * `A.stats` reads the document's live state, not the snapshot it is handed
 * (pinned by "stats reads the live document" in the suite), so the counts
 * logged can be a pass ahead of the sample the projector is projecting. That
 * is why the rotator never takes the heads it retires at from here: it takes
 * the heads the projector last PUBLISHED (`ordinaryHeadRotator.ts`).
 *
 * `A.stats` measured O(1) on Automerge 3.2.6 — 1.5–2.6 µs per call from 101
 * changes / 2.7k ops to 20k changes / 605k ops (scratch timing, 2000 calls
 * each, 2026-11-01); the timing test in the suite bounds it.
 */
export class OrdinaryHeadRotationObserver {
  private readonly admitted: boolean
  private readonly reported = new Map<string, Set<Dimension>>()
  /** The last counts `observe` read, per kind (G4-16e telemetry). */
  private readonly latest = new Map<OrdinaryHeadKind, { url: string; actors: number; changes: number }>()
  /** url -> what made it due first (G4-16e: does rotation follow sessions,
   * the actors threshold, or edit volume, the changes one?). Taken (deleted)
   * by the rotation that retires the head, and capped at
   * {@link MAX_REMEMBERED_TRIGGERS} oldest-first for heads that were due and
   * never rotated (a lost lease, a stop): one per head otherwise, for ever. */
  private readonly triggers = new Map<string, OrdinaryHeadRotationTrigger>()

  constructor(
    private readonly config: OrdinaryHeadRotationConfig,
    private readonly key: WorkspaceKey,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {
    this.admitted = ordinaryHeadRotationAdmits(config, key)
  }

  /** `on` and allow-listed: a due head is to be rotated, not only reported. */
  get rotates(): boolean {
    return this.admitted && this.config.mode === 'on'
  }

  /** The counts the last `observe` of `url` read, or null when the last head
   * observed for `kind` was another (or none). No stats call: a head reported
   * on both dimensions is not inspected again, so its counts stay those of
   * the pass that found it due. */
  lastObserved(kind: OrdinaryHeadKind, url: string | undefined): { actors: number; changes: number } | null {
    const latest = this.latest.get(kind)
    return latest && latest.url === url ? { actors: latest.actors, changes: latest.changes } : null
  }

  /** What made `url` due first, or null if it never was (G4-16e). */
  trigger(url: string): OrdinaryHeadRotationTrigger | null {
    return this.triggers.get(url) ?? null
  }

  /** {@link trigger}, forgetting it: called once the head is retired. */
  takeTrigger(url: string): OrdinaryHeadRotationTrigger | null {
    const trigger = this.trigger(url)
    this.triggers.delete(url)
    return trigger
  }

  /** Is this head at or past a threshold? False whenever nothing is observed
   * (`off`, not allow-listed, no document, not Automerge). */
  observe(kind: OrdinaryHeadKind, url: string, doc: unknown): boolean {
    if (!this.admitted || !doc) return false
    const reported = this.reported.get(url)
    if (reported?.size === 2) return true
    let numActors: number
    let numChanges: number
    try {
      ({ numActors, numChanges } = stats(doc as never))
    } catch {
      // Not an Automerge document (a fake resolver's plain object). Nothing to
      // observe, and the projection that called this must not fail over it.
      return Boolean(reported?.size)
    }
    this.latest.set(kind, { url, actors: numActors, changes: numChanges })
    const crossed: Dimension[] = []
    if (numActors >= this.config.maxActors) crossed.push('actors')
    if (numChanges >= this.config.maxChanges) crossed.push('changes')
    const fresh = crossed.filter((dimension) => !reported?.has(dimension))
    if (crossed.length && !this.triggers.has(url)) {
      this.triggers.set(url, crossed.length === 2 ? 'both' : crossed[0]!)
      // Insertion order is age: drop the oldest beyond the cap.
      for (const old of this.triggers.keys()) {
        if (this.triggers.size <= MAX_REMEMBERED_TRIGGERS) break
        this.triggers.delete(old)
      }
    }
    if (fresh.length) {
      this.reported.set(url, new Set([...(reported ?? []), ...fresh]))
      this.log(JSON.stringify({
        event: 'read_model.ordinary_head_rotation_due',
        mode: this.config.mode,
        workspace: `${this.key.landscapeId}/${this.key.versionId}`,
        kind,
        url,
        numActors,
        numChanges,
        crossed,
        newlyCrossed: fresh,
        thresholds: { maxActors: this.config.maxActors, maxChanges: this.config.maxChanges },
      }))
    }
    return crossed.length > 0
  }
}
