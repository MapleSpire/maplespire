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

import type { WorkspaceKey } from './docScope.js'
import type { MetricSample } from '../runtime/metrics.js'

/**
 * WHERE A SERVER-CREATED DOCUMENT BELONGS, BETWEEN ITS MINT AND ITS CLAIM —
 * AND UNDER WHOSE LEASE A BOOTSTRAP DOCUMENT IS BEING WRITTEN.
 *
 * `provisionalPlacementSource.ts` is the same seam for documents the ROUTE GATE
 * admitted. A document the SERVER mints has no request, no gate and no durable
 * row when its first chunk is written, so the storage fence has nothing to
 * check a lease against and admits unconditionally. The party that knows where
 * it belongs is the code that just minted it.
 *
 * ## Two tiers, two questions, one map class
 *
 * The OWNER tier holds documents minted through `createClaimedDocument`: the
 * entry names the document's OWN workspace, which already has a `versions` row
 * and therefore a lease. Its fence read is `placementForFence`, gated on
 * `SYNC_CELL_UNPLACED_CREATION=refuse`; its census read is
 * `serverCreationPlacementFor`, never gated.
 *
 * The FORKER tier holds the BOOTSTRAP family's documents — `forkRoot`,
 * `createEmptyRoot`, `createSparseDraftRoot`, the merge's copies and overlay
 * segments — minted BEFORE their target workspace has a `versions` row, so no
 * lease can exist for the target
 * (`sync_workspace_ownership.version_id REFERENCES versions(id)`). The entry
 * names the workspace whose lease AUTHORISES the write instead — the parent
 * being forked, the landscape's default version, the draft a sparse clone
 * lands in. Its fence read is `bootstrapPlacementFor`, NOT gated. Its entries
 * are never counted by the unplaced-creation census, which is why the tiers
 * are two instances rather than one map with mixed meanings.
 *
 * `purgeServerCreationPlacement` purges both, so a claim path cannot forget one.
 *
 * ## The window is short, and that is the whole design
 *
 * An entry is needed only until the durable `automerge_document_workspace`
 * row lands — after that the database is the authority and this map is WRONG
 * to consult. So the purge happens on the CLAIM'S COMMIT:
 *
 *   - not on a timer: no claim latency is right on both a fast and a loaded box;
 *   - not on a read: an evicting read fences the first save and nothing after
 *     it (multiple saves are reachable, e.g. `saveSyncState` once a peer
 *     engages);
 *   - on the COMMIT, not the statement: autocommit publishers purge in
 *     `notifyWorkspaceDocumentsCreated` after its guards, and `applyMerge`,
 *     whose claim runs in a transaction, purges after `COMMIT` — never inside
 *     `claimWorkspaceDocuments`, where a later `ROLLBACK` would leave a
 *     document with neither a row nor an entry.
 *
 * ## RETIRED entries: kept for the write-back, evicted first
 *
 * A fork that fails after minting leaves entries whose claim will never land.
 * They are NOT purged: Automerge's armed save can write torn-down documents
 * back after the rollback, and keeping the entry keeps that write-back fenced.
 * `retireBootstrapPlacement` marks them; at capacity the oldest RETIRED entry
 * is evicted before any live one and counted on its own series, so
 * `overflows_total` keeps meaning "a LIVE pre-claim document lost its fence".
 *
 * ## Bounded, and it says when it dropped something
 *
 * A process whose claims never land (e.g. one with no doc index, where
 * `notifyWorkspaceDocumentsCreated` returns false and nothing purges) would
 * grow an unbounded map forever. The bound caps memory; overflow counters are
 * exported to `/metrics` (`maplespire_server_creation_placement_overflows_total`
 * and the bootstrap equivalent) because an eviction silently returns that
 * document to unconditional admission.
 */

import { envNumber } from '../envNumber.js'

/**
 * How many un-claimed OWNER-tier documents to remember.
 *
 * 4096 is an arbitrary ceiling chosen high, not a measurement. The tier is fed
 * only by `createClaimedDocument` callers (model ops: a registry shard or a
 * diagram doc; compaction: one shard per batch), each held only until its
 * claim lands — roughly three orders of magnitude below this. If it is ever
 * too small, the exported overflow counter says so.
 */
const CAPACITY = envNumber('SERVER_CREATION_PLACEMENT_CAPACITY', {
  fallback: 4_096, minimum: 16, maximum: 1_048_576, integer: true,
})

/**
 * How many FORKER-tier entries to remember.
 *
 * Not a measurement either. A fork creates one entry per document of the
 * SOURCE graph, and the largest fork that can complete at all is bounded by a
 * WASM memory wall measured between 9 000 and 10 000 documents. 65 536 covers
 * about SIX such maximal forks in flight at once; a seventh evicts the oldest
 * live entry and the overflow counter says so. Residue from failed forks is
 * retired and evicted ahead of live entries.
 */
const BOOTSTRAP_CAPACITY = envNumber('BOOTSTRAP_PLACEMENT_CAPACITY', {
  fallback: 65_536, minimum: 256, maximum: 4_194_304, integer: true,
})

export interface PlacementMapSnapshot {
  /** Live + retired. */
  size: number
  live: number
  retired: number
  capacity: number
  /** LIVE entries evicted at capacity — each one a pre-claim document that
   *  silently returned to unconditional admission. */
  overflowCount: number
  /** RETIRED entries evicted at capacity — residue of failed forks whose armed
   *  write-back had long since landed or been refused. Not an overflow. */
  retiredEvictions: number
}

/**
 * An insertion-ordered, bounded map of document → workspace, with a retired
 * tier that is evicted first. `Map` already guarantees insertion order, so the
 * oldest entry of either tier is the first key its iterator yields.
 *
 * `note` is a no-op for an id already present in EITHER tier. Without that,
 * re-noting at capacity would evict the oldest entry and then re-`set` a key
 * already present — losing a live placement and bumping the overflow counter
 * for nothing. (It is not about FIFO stability: `Map.set` on an existing key
 * does not move it.)
 *
 * `get` returns A FRESH OBJECT PER READ, so a consumer mutating what it was
 * given cannot corrupt the map.
 */
export class BoundedPlacementMap {
  private readonly live = new Map<string, WorkspaceKey>()
  private readonly retired = new Map<string, WorkspaceKey>()
  private overflows = 0
  private retiredEvicted = 0
  readonly capacity: number

  // An explicit field, not a parameter property: the root build runs `tsc -b`
  // with `erasableSyntaxOnly`, which refuses `constructor(readonly x)`.
  constructor(capacity: number) {
    this.capacity = capacity
  }

  note(documentId: string, workspace: WorkspaceKey): void {
    if (this.live.has(documentId) || this.retired.has(documentId)) return
    if (this.live.size + this.retired.size >= this.capacity) this.evictOne()
    this.live.set(documentId, { landscapeId: workspace.landscapeId, versionId: workspace.versionId })
  }

  /** The oldest RETIRED entry first; a live one only when no residue is left. */
  private evictOne(): void {
    const retired = this.retired.keys().next()
    if (!retired.done) {
      this.retired.delete(retired.value)
      this.retiredEvicted += 1
      return
    }
    const oldest = this.live.keys().next()
    if (!oldest.done) {
      this.live.delete(oldest.value)
      this.overflows += 1
    }
  }

  /** READS DO NOT EVICT — see the module docblock for why an evicting read is
   *  the worst of both. A retired entry still answers: that is what keeps the
   *  write-back of a failed fork fenced. */
  get(documentId: string): WorkspaceKey | null {
    const found = this.live.get(documentId) ?? this.retired.get(documentId)
    return found ? { landscapeId: found.landscapeId, versionId: found.versionId } : null
  }

  purge(documentIds: readonly string[]): void {
    for (const documentId of documentIds) {
      this.live.delete(documentId)
      this.retired.delete(documentId)
    }
  }

  /** Move live entries to the retired tier. Unknown ids are ignored; an entry
   *  already retired stays where it is (its retirement order is what governs
   *  eviction, and re-inserting it would make it look newer than it is). */
  retire(documentIds: readonly string[]): void {
    for (const documentId of documentIds) {
      const workspace = this.live.get(documentId)
      if (!workspace) continue
      this.live.delete(documentId)
      this.retired.set(documentId, workspace)
    }
  }

  snapshot(): PlacementMapSnapshot {
    return {
      size: this.live.size + this.retired.size,
      live: this.live.size,
      retired: this.retired.size,
      capacity: this.capacity,
      overflowCount: this.overflows,
      retiredEvictions: this.retiredEvicted,
    }
  }

  reset(): void {
    this.live.clear()
    this.retired.clear()
    this.overflows = 0
    this.retiredEvicted = 0
  }
}

/** The OWNER tier: `createClaimedDocument`'s documents, keyed on their own workspace. */
const ownerPlacements = new BoundedPlacementMap(CAPACITY)
/** The FORKER tier: the bootstrap family's documents, keyed on the lease that authorises the write. */
const forkerPlacements = new BoundedPlacementMap(BOOTSTRAP_CAPACITY)

/**
 * Remember where a just-minted OWNER-tier document belongs.
 *
 * Called from `createClaimedDocument` in the same synchronous step as
 * `repo.create`, and THAT POSITION IS LOAD-BEARING. `repo.create()` schedules
 * the first save on a TIMER while a fresh handle becomes ready on a MICROTASK,
 * so ready wins only while nothing yields between the two. One added await in
 * that function — an audit write, a metrics call — and the save lands first,
 * unfenced. `workspaceWriter.ordering.seam.test.ts` covers this with a repo
 * whose `whenReady` defers by one macrotask.
 */
export function noteServerCreationPlacement(documentId: string, workspace: WorkspaceKey): void {
  ownerPlacements.note(documentId, workspace)
}

/**
 * Remember under whose lease a just-minted BOOTSTRAP document is being
 * written. Same synchronous discipline as the owner tier — `bootstrapScope.ts`
 * takes the note in the frame that mints — and a different KEY: `forker` is
 * the workspace that authorises the write, never the document's own target,
 * which has no lease yet.
 */
export function noteBootstrapPlacement(documentId: string, forker: WorkspaceKey): void {
  forkerPlacements.note(documentId, forker)
}

/**
 * The census's read of the OWNER tier. Null means nobody minted this document
 * here through `createClaimedDocument`, which keeps the unconditional admission
 * — same contract, and same reasoning, as `provisionalPlacementFor`.
 */
export function serverCreationPlacementFor(documentId: string): WorkspaceKey | null {
  return ownerPlacements.get(documentId)
}

/**
 * THE FENCE'S read of the OWNER tier, which is NOT the same as the census's.
 *
 * ## Why this is gated and `serverCreationPlacementFor` is not
 *
 * Handing this map to the storage fence ARMS A REFUSAL: `withFencedMutation`
 * throws `StaleSyncCellWriteError` when it has a workspace and no local token
 * (`automergeStorage.ts`), so a document minted on a cell that does not own its
 * workspace goes from "admitted unconditionally" to "the save fails". With
 * `SYNC_CELL_OWNERSHIP` on, that is a production behaviour change, so it is
 * opt-in via `SYNC_CELL_UNPLACED_CREATION=refuse` — meant to be enabled once
 * the census reports zero unplaced creations.
 *
 * The map is populated and readable in every mode, so the census can count
 * and enabling the refusal is a config change rather than a code change.
 * `observe` is the default in every committed manifest.
 */
export function placementForFence(documentId: string): WorkspaceKey | null {
  if (unplacedCreationMode() !== 'refuse') return null
  return ownerPlacements.get(documentId)
}

/**
 * THE FENCE'S read of the FORKER tier — and it is NOT gated.
 *
 * A bootstrap save on a cell holding no lease for the forker is refused; the
 * entry points that reach this family are already routed to the owner, so a
 * refused caller has somewhere to go. `SYNC_CELL_UNPLACED_CREATION` does not
 * apply to these documents. There is deliberately no kill switch: a refusal
 * on the OWNER would mean a wrong key, which is a defect to fix.
 */
export function bootstrapPlacementFor(documentId: string): WorkspaceKey | null {
  return forkerPlacements.get(documentId)
}

/**
 * Read at every call rather than cached at module load, so a test can set the
 * variable without re-importing the module — and so an operator flipping it
 * does not need a deploy to see the effect on a process that is already up.
 *
 * Anything other than `refuse` is `observe`, including a typo: the safe
 * setting is the one nobody has to type correctly.
 */
function unplacedCreationMode(): 'observe' | 'refuse' {
  return process.env.SYNC_CELL_UNPLACED_CREATION?.trim().toLowerCase() === 'refuse'
    ? 'refuse'
    : 'observe'
}

/**
 * Forget documents whose durable row has COMMITTED — in BOTH tiers.
 *
 * Called from the claim's commit points, because that is the exact moment the
 * map stops being the best answer and starts being a stale one. Ids that were
 * never noted are ignored: the claim path also handles documents this process
 * did not mint. One function for both tiers, so a publisher cannot purge the
 * one it knows about and leave the other fencing a claimed document under a
 * lease that has since moved on.
 */
export function purgeServerCreationPlacement(documentIds: readonly string[]): void {
  ownerPlacements.purge(documentIds)
  forkerPlacements.purge(documentIds)
}

/**
 * Mark a failed fork's entries as residue. They stay readable —
 * the armed write-back must still meet the fence — and are the first evicted
 * at capacity. See the module docblock, § RETIRED entries.
 */
export function retireBootstrapPlacement(documentIds: readonly string[]): void {
  forkerPlacements.retire(documentIds)
}

/** Diagnostics for the OWNER tier. */
export function serverCreationPlacementSnapshot(): PlacementMapSnapshot {
  return ownerPlacements.snapshot()
}

/** Diagnostics for the FORKER tier. */
export function bootstrapPlacementSnapshot(): PlacementMapSnapshot {
  return forkerPlacements.snapshot()
}

/** TEST SEAM. Both maps are process-wide, so a suite that asserts on `size` or
 *  `overflowCount` needs to start from a known state — otherwise the first
 *  arm's leftovers decide the second arm's verdict. */
export function resetServerCreationPlacementForTest(): void {
  ownerPlacements.reset()
  forkerPlacements.reset()
}

/**
 * Exports both tiers' state to `/metrics` so overflows reach an operator.
 *
 * `size` is a GAUGE (it falls as claims land, so `increase()` over it is
 * meaningless) and `overflows_total` a COUNTER (only rises, which is what an
 * alert needs). Read the counters as a DELTA, never as an absolute: nothing
 * resets them outside the test seam, so an absolute value depends on test order.
 */
export function serverCreationPlacementMetricSamples(): MetricSample[] {
  const owner = ownerPlacements.snapshot()
  const forker = forkerPlacements.snapshot()
  return [
    {
      name: 'maplespire_server_creation_placements',
      help: 'Server-minted documents whose workspace is remembered while their durable claim has not landed. Falls as claims land; a value pinned near capacity means claims are not landing.',
      type: 'gauge',
      values: [{ value: owner.size }],
    },
    {
      name: 'maplespire_server_creation_placement_overflows_total',
      help: 'Server-minted documents whose remembered workspace was DROPPED because the map was full. Each one silently returns to unfenced admission for the rest of its pre-claim window, and nothing else in the process reports it. Non-zero means raise SERVER_CREATION_PLACEMENT_CAPACITY or find the claim path that stopped landing.',
      type: 'counter',
      values: [{ value: owner.overflowCount }],
    },
    {
      name: 'maplespire_bootstrap_placements',
      help: 'Bootstrap-family documents (fork, empty root, sparse draft, merge copies and segments) whose authorising lease is remembered while their publisher has not committed a claim. LIVE entries only; falls as publishers commit. A value pinned near capacity means publishers are not committing.',
      type: 'gauge',
      values: [{ value: forker.live }],
    },
    {
      name: 'maplespire_bootstrap_placements_retired',
      help: 'Residue of failed forks: entries kept so the armed write-back of a torn-down document still meets the storage fence, evicted ahead of live entries when the map is full.',
      type: 'gauge',
      values: [{ value: forker.retired }],
    },
    {
      name: 'maplespire_bootstrap_placement_overflows_total',
      help: 'LIVE bootstrap entries DROPPED because the map was full. Each one silently returns to unfenced admission for the rest of its pre-claim window. Non-zero means more than BOOTSTRAP_PLACEMENT_CAPACITY documents were in flight across concurrent forks — raise it, or find the publisher that stopped committing.',
      type: 'counter',
      values: [{ value: forker.overflowCount }],
    },
    {
      name: 'maplespire_bootstrap_placement_retired_evictions_total',
      help: 'Retired (failed-fork) bootstrap entries evicted to make room. Housekeeping, not a loss: their documents were torn down and their write-back has long landed or been refused.',
      type: 'counter',
      values: [{ value: forker.retiredEvictions }],
    },
  ]
}
