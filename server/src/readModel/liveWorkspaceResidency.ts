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

/**
 * RESIDENCY FOLLOWS THE LIVE WORKSPACE.
 *
 * Without this, after a failover the new owner's projector becomes resident
 * only when a READ asks for one: a workspace that is only being WRITTEN keeps
 * a stale read model, and every batch written after the takeover stays
 * unacknowledged in the clients' journals until some read attaches the
 * projector.
 *
 * The rule here: any document message a peer sends on a workspace THIS CELL
 * OWNS — a write, or the handshake that precedes one — makes that workspace's
 * projector resident, without waiting for a read. The ownership gate
 * (`automergeServer.ts`) already resolves the document's workspace and the
 * cell's ownership for every `sync`/`request` frame; this class is what it
 * tells. It never decodes a payload (the gate's hot-path rule), never awaits
 * inside the gate, never throws, and asks the fleet at most once per workspace
 * per `throttleMs`.
 *
 * WHAT THE THROTTLE PROTECTS. Not a lost lease: a frame on a workspace whose
 * lease is gone is `owned === false` at the gate and never reaches this class
 * (the gate's `owns()` and the fleet's `ownsWorkspace` are one predicate read
 * in one synchronous tick). It bounds the per-frame cost of a REFUSED or UNRESOLVED
 * `ensure()` — an admission slot (two wide), the static-workspace `SELECT
 * EXISTS`, a `resolveRoot`, an Error allocation, a log line. A refusal the
 * fleet marks `retryable: false` (a static workspace, a stopped admission) is
 * not asked again for `suppressMs` — ten minutes — because waiting five
 * seconds cannot change that answer.
 *
 * THE CAP IS A BUDGET, NOT AN OBSERVATION: with more
 * live workspaces than `READ_MODEL_MAX_PROJECTORS` (8) on one cell, ensuring
 * the ninth evicts the first, whose next frame — seconds away — ensures it
 * back and evicts the second: a self-sustaining chain of cold builds at socket
 * cadence, bounded only by the admission's width. So a frame that finds the
 * fleet FULL does not ensure; it is counted (`capSaturated`) and the workspace
 * falls back to read-driven residency — a read decides. And a frame
 * on a RESIDENT workspace `touch()`es it, so the eviction's "least recently
 * used" means least recently written or read, not first attached.
 *
 * COST: the projector's own share of a resident workspace is its heap,
 * measured at ~3 KB per object as an upper bound on small single-shard
 * workspaces (larger workspaces with base shards and diagrams cost more). The
 * documents a written workspace needs are already loaded on the owner, since
 * the writes arrive there.
 */

/** The fleet calls this class makes — `ProjectorFleet`'s, narrowed. */
export interface ResidencyFleet {
  isResident(key: WorkspaceKey): boolean
  /** Resolves FALSE, without throwing, when the workspace resolves to no root. */
  ensure(key: WorkspaceKey): Promise<boolean>
  /** Resident projectors right now, and the cap the eviction enforces. */
  size(): number
  capacity(): number
  /** Recency for the eviction; false when the key is not resident. */
  touch(key: WorkspaceKey): boolean
}

export interface LiveWorkspaceResidencyOptions {
  /** Read PER CALL: the fleet is constructed after the sync server that hosts
   * the gate, so the wiring hands a lazy accessor, never the instance. `null`
   * means "no fleet yet" — counted, never an error. */
  fleet: () => ResidencyFleet | null
  /** A refusal the fleet is entitled to: not an owner any more, a static
   * workspace, a saturated or stopped cold-build queue. Counted as `refused`,
   * never logged per frame. Everything else is `failed` and logged once per
   * workspace per window. */
  isExpectedRefusal: (error: unknown) => boolean
  throttleMs?: number
  /** How long a `retryable: false` answer keeps a workspace from being asked. */
  suppressMs?: number
  log?: (message: string, error: unknown) => void
  now?: () => number
}

export interface LiveWorkspaceResidencySnapshot {
  /** Owned document frames the gate reported. */
  activity: number
  /** Frames that found the projector already resident — the steady state. */
  alreadyResident: number
  /** Frames that arrived inside a workspace's throttle window. */
  throttled: number
  /** Frames that found the fleet at its cap: no ensure, a read decides. */
  capSaturated: number
  /** Frames on a workspace whose last answer was `retryable: false`. */
  suppressed: number
  /** `ensure()` calls actually issued. */
  ensuresRequested: number
  /** `ensure()` calls that resolved true — a projector is resident. */
  ensured: number
  /** `ensure()` resolved false: the workspace resolves to no root. */
  unresolved: number
  /** `ensure()` threw an expected refusal. */
  refused: number
  /** `ensure()` threw anything else (logged). */
  failed: number
  /** The synchronous prefix (fleet accessor, `isResident`) threw (logged). */
  noteFailed: number
  /** Frames seen before the fleet existed. */
  fleetUnavailable: number
}

const DEFAULT_THROTTLE_MS = 5_000
const DEFAULT_SUPPRESS_MS = 10 * 60_000
/** Bound on the per-workspace maps: a wholesale clear, like the gate's own
 * denial throttles — losing one costs one extra `ensure()`, never a verdict. */
const MAP_LIMIT = 10_000

export class LiveWorkspaceResidency {
  private readonly lastEnsureAt = new Map<string, number>()
  private readonly suppressedUntil = new Map<string, number>()
  private readonly counters: LiveWorkspaceResidencySnapshot = {
    activity: 0,
    alreadyResident: 0,
    throttled: 0,
    capSaturated: 0,
    suppressed: 0,
    ensuresRequested: 0,
    ensured: 0,
    unresolved: 0,
    refused: 0,
    failed: 0,
    noteFailed: 0,
    fleetUnavailable: 0,
  }
  private readonly throttleMs: number
  private readonly suppressMs: number
  private readonly log: (message: string, error: unknown) => void
  private readonly now: () => number
  private lastNoteFailureLoggedAt = -Infinity
  /** The `ensure()` currently in flight per workspace, so a test (or a caller
   * that must know) can await the residency this frame started. */
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly options: LiveWorkspaceResidencyOptions) {
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
    this.suppressMs = options.suppressMs ?? DEFAULT_SUPPRESS_MS
    this.log = options.log ?? ((message, error) => console.warn(message, error))
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Called by the ownership gate, SYNCHRONOUSLY, for a document frame on a
   * workspace this cell owns. Returns at once and never throws — the gate's
   * `canWrite` turns any throw into "not writable", which would DROP the
   * owner's own clients' changes — so the synchronous prefix is under `try`
   * too, not only the fleet call.
   */
  noteOwnedActivity(workspace: WorkspaceKey): void {
    this.counters.activity += 1
    try {
      this.follow(workspace)
    } catch (error) {
      this.counters.noteFailed += 1
      const now = this.now()
      if (now - this.lastNoteFailureLoggedAt >= this.throttleMs) {
        this.lastNoteFailureLoggedAt = now
        this.log(`[read-model] live residency could not consult the fleet for ${workspace.landscapeId}/${workspace.versionId}`, error)
      }
    }
  }

  private follow(workspace: WorkspaceKey): void {
    const fleet = this.options.fleet()
    if (!fleet) {
      this.counters.fleetUnavailable += 1
      return
    }
    if (fleet.isResident(workspace)) {
      this.counters.alreadyResident += 1
      fleet.touch(workspace)
      return
    }
    const key = `${workspace.landscapeId}/${workspace.versionId}`
    const now = this.now()
    const suppressed = this.suppressedUntil.get(key)
    if (suppressed !== undefined) {
      if (now < suppressed) {
        this.counters.suppressed += 1
        return
      }
      this.suppressedUntil.delete(key)
    }
    const last = this.lastEnsureAt.get(key)
    if (last !== undefined && now - last < this.throttleMs) {
      this.counters.throttled += 1
      return
    }
    if (fleet.size() >= fleet.capacity()) {
      // Not stamped: the moment a slot frees up, the next frame ensures.
      this.counters.capSaturated += 1
      return
    }
    if (this.lastEnsureAt.size >= MAP_LIMIT) this.lastEnsureAt.clear()
    this.lastEnsureAt.set(key, now)
    this.counters.ensuresRequested += 1
    const task = this.ensure(fleet, workspace, key)
      .finally(() => {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key)
      })
      // `ensure` swallows its own errors; this guards the callbacks it calls
      // (`isExpectedRefusal`, `log`) so nothing can reach `unhandledRejection`.
      .catch(() => undefined)
    this.inFlight.set(key, task)
  }

  /** The residency a frame started for `workspace`, if one is in flight. */
  pending(workspace: WorkspaceKey): Promise<void> | undefined {
    return this.inFlight.get(`${workspace.landscapeId}/${workspace.versionId}`)
  }

  snapshot(): LiveWorkspaceResidencySnapshot {
    return { ...this.counters }
  }

  private async ensure(fleet: ResidencyFleet, workspace: WorkspaceKey, key: string): Promise<void> {
    try {
      if (await fleet.ensure(workspace)) this.counters.ensured += 1
      else this.counters.unresolved += 1
    } catch (error) {
      if ((error as { retryable?: unknown } | null)?.retryable === false) {
        if (this.suppressedUntil.size >= MAP_LIMIT) this.suppressedUntil.clear()
        this.suppressedUntil.set(key, this.now() + this.suppressMs)
      }
      if (this.options.isExpectedRefusal(error)) {
        this.counters.refused += 1
        return
      }
      this.counters.failed += 1
      this.log(`[read-model] live residency for ${key} failed; the next frame retries after ${this.throttleMs} ms`, error)
    }
  }
}
