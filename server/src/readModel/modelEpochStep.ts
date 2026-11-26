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

import type { DocumentId, Repo } from '@automerge/automerge-repo'
import { createClaimedDocumentFromBinary } from '../rbac/docScope.js'
import { assertReadModelWriteFence } from './health.js'
import type { ModelEpochConfig } from './modelEpochConfig.js'
import { modelEpochLock, recoverModelEpoch, rollModelEpoch, type RollPorts, type RollResult } from './modelEpochRoll.js'
import { sqlEpochRowStore, storageDurableHeads, type FencedTransaction } from './modelEpochStore.js'
import { STATIC_PLANE_LOCK_WAIT_MS, assertReadModelPlane } from './projectionAuthority.js'
import type { WorkspaceKey } from './projector.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'

/**
 * The compaction pass's EPOCH STEP (G4-16f): after a
 * successful `compactOverlay`, with both `overlay-rotation:` keys still held
 * and the projector still detached, roll an epoch when one is due.
 *
 * Production ports for `rollModelEpoch` (`modelEpochRoll.ts`):
 *  - the row transactions run on the pass's OWN object-key client, as the
 *    settle does — `BEGIN; SET LOCAL lock_timeout`, the plane and the write
 *    fence asserted FOR UPDATE, then the rows; never through the projection
 *    mutex (A8, `lockEdgeScan.ts`);
 *  - the `model-epoch:` key on its own pooled client;
 *  - S5 reads DURABLE heads from `automerge_storage` itself, the document's
 *    snapshot and incremental chunks loaded into a fresh document — not the
 *    handle, which `Repo.flush` may have skipped;
 *  - the lifecycle lock for the whole roll, so promote, demote and the repair
 *    doors cannot rewrite the root under it.
 *
 * OFF unless `AM_MODEL_EPOCHS=on`: the step then runs ONE statement (are
 * there epoch rows, is one in flight), recovers an attempt a previous `on`
 * left in flight, and returns `disabled`.
 */
export interface ModelEpochStepDeps {
  readonly config: ModelEpochConfig
  readonly repo: Repo
  readonly rootUrl: string
  readonly db: Queryable
  readonly connect: () => Promise<ReleasableQueryable>
  /** The client holding the object `overlay-rotation:` key: the row
   * transactions run on it. */
  readonly rowClient: ReleasableQueryable
  readonly fenceHolder: string | null
  readonly instanceId: string
  readonly mayWrite: () => boolean
  /** `withLifecycleApplyLock`, bound to the pool. */
  readonly withLifecycleLock: <T>(critical: () => Promise<T>) => Promise<{ granted: false } | { granted: true; value: T }>
  readonly now?: () => Date
  readonly log?: (event: Record<string, unknown>) => void
}

export type ModelEpochStepOutcome =
  | RollResult
  | { outcome: 'disabled' }
  | { outcome: 'not_due'; publishedAt: Date }
  | { outcome: 'first_roll_not_due'; slot: number }
  | { outcome: 'lifecycle_lock_contended' }

/** A fenced transaction on `client` (no projection mutex). */
export function fencedOn(client: Queryable, key: WorkspaceKey, fenceHolder: string | null): FencedTransaction {
  return async (fn) => {
    let inTransaction = false
    try {
      await client.query(`BEGIN; SET LOCAL lock_timeout = '${STATIC_PLANE_LOCK_WAIT_MS}ms'`)
      inTransaction = true
      await assertReadModelPlane(client, key, 'ordinary')
      if (!fenceHolder) throw new Error('model epoch: no resident projector instance to assert the write fence for')
      await assertReadModelWriteFence(client, key, fenceHolder)
      const value = await fn(client)
      await client.query('COMMIT')
      inTransaction = false
      return value
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  }
}

/** Moved to `modelEpochStore.ts` (GC's epoch root reads it too); re-exported. */
export { storageDurableHeads } from './modelEpochStore.js'

const sameHeads = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i])

const DAY_MS = 86_400_000

/**
 * THE FIRST-ROLL SPREAD: a workspace that never
 * rolled is due only on ITS day of the period — a stable hash of its key
 * modulo `periodDays` — so turning the flag on does not rebuild every
 * workspace's base shards in the same night. Every workspace's first roll
 * lands within one period of the flag going on.
 */
export function firstRollSlot(key: WorkspaceKey, periodDays: number): number {
  let h = 0x811c9dc5
  for (const ch of `${key.landscapeId}/${key.versionId}`) {
    h ^= ch.codePointAt(0)!
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % periodDays
}
export const firstRollDue = (key: WorkspaceKey, periodDays: number, now: Date) =>
  Math.floor(now.getTime() / DAY_MS) % periodDays === firstRollSlot(key, periodDays)
/** The first instant, at or after `from`, on which the workspace's first roll is due. */
export function firstRollDate(key: WorkspaceKey, periodDays: number, from: Date = new Date()): Date {
  const day = Math.floor(from.getTime() / DAY_MS)
  const wait = (firstRollSlot(key, periodDays) - (day % periodDays) + periodDays) % periodDays
  return wait === 0 ? from : new Date((day + wait) * DAY_MS)
}

interface EpochRowsState {
  any: boolean
  inFlight: boolean
  published: { at: Date | null; kind: string } | null
}

/** ONE statement: whether the workspace has epoch rows at all, one in flight,
 * and its published epoch. With no row, nothing else of the step runs. */
async function epochRowsState(db: Queryable, key: WorkspaceKey): Promise<EpochRowsState> {
  const { rows } = await db.query<{ state: string; kind: string; published_at: Date | null }>(
    `SELECT state, kind, published_at FROM read_model_model_epochs
      WHERE landscape_id = $1 AND version_id = $2
        AND state IN ('preparing', 'prepared', 'repointing', 'published')`,
    [key.landscapeId, key.versionId])
  const published = rows.find((r) => r.state === 'published')
  return {
    any: rows.length > 0,
    inFlight: rows.some((r) => r.state !== 'published'),
    published: published ? { at: published.published_at, kind: published.kind } : null,
  }
}

function epochDue(key: WorkspaceKey, rows: EpochRowsState, periodDays: number, now: Date): { due: boolean; publishedAt: Date | null } {
  const publishedAt = rows.published?.at ?? null
  if (!publishedAt) return { due: firstRollDue(key, periodDays, now), publishedAt: null }
  return { due: now.getTime() - new Date(publishedAt).getTime() >= periodDays * DAY_MS, publishedAt }
}

/** `kind`: `full` in the compaction pass (base shards recreated); `meta` in
 * the meta-only job of a workspace the compaction does not admit. */
export async function runModelEpochStep(key: WorkspaceKey, deps: ModelEpochStepDeps, kind: 'full' | 'meta' = 'full'): Promise<ModelEpochStepOutcome> {
  const rows = await epochRowsState(deps.db, key)
  const ports = rollPorts(key, deps)
  // RECOVERY FIRST, under EVERY value of the flag:
  // a crash after S6a is rolled forward on the very next pass, not at the
  // next due date — and still once the flag is off. Also redone with the
  // flag on: a missing S8 (its hint, its hash record).
  if (rows.inFlight || (deps.config.enabled && rows.published && rows.published.kind !== 'legacy')) {
    const recovered = await deps.withLifecycleLock(() => recoverModelEpoch(ports))
    if (!recovered.granted) return { outcome: 'lifecycle_lock_contended' }
    if (recovered.value.outcome !== 'nothing_in_flight') {
      deps.log?.({ event: 'model_epoch.step.recovery', result: recovered.value })
      if (recovered.value.outcome === 'recovered' || recovered.value.outcome === 'skipped') return recovered.value
    }
  }
  if (!deps.config.enabled) return { outcome: 'disabled' }
  const due = epochDue(key, rows, deps.config.periodDays, (deps.now ?? (() => new Date()))())
  if (!due.due) return due.publishedAt ? { outcome: 'not_due', publishedAt: due.publishedAt } : { outcome: 'first_roll_not_due', slot: firstRollSlot(key, deps.config.periodDays) }
  const locked = await deps.withLifecycleLock(() => rollModelEpoch(ports, kind))
  if (!locked.granted) return { outcome: 'lifecycle_lock_contended' }
  return locked.value
}

/** The production roll ports — the step's own, and `epoch:resolve-repointing`'s. */
export function modelEpochRollPorts(key: WorkspaceKey, deps: ModelEpochStepDeps): RollPorts {
  return rollPorts(key, deps)
}

function rollPorts(key: WorkspaceKey, deps: ModelEpochStepDeps): RollPorts {
  return {
    repo: deps.repo,
    key,
    rootUrl: deps.rootUrl,
    instanceId: deps.instanceId,
    rows: sqlEpochRowStore(fencedOn(deps.rowClient, key, deps.fenceHolder), key),
    lock: modelEpochLock({ connect: deps.connect as never }, key),
    createFromBinary: (binary) => createClaimedDocumentFromBinary(deps.repo, key, deps.rootUrl, binary),
    verifyDurable: async (expected) => {
      for (const { documentId, heads } of expected) {
        const durable = await storageDurableHeads(deps.db, String(documentId as DocumentId))
        if (!durable || !sameHeads(durable, heads)) return false
      }
      return true
    },
    mayWrite: deps.mayWrite,
    log: deps.log,
  }
}
