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

import { hasHeads } from '@automerge/automerge'
import type { DocumentId } from '@automerge/automerge-repo'
import type { PoolClient } from 'pg'
import {
  acquireOverlayRotationLock,
  overlayRotationLockKey,
  releaseOverlayRotationLock,
  reportOverlayRotationLockContended,
  type OverlayRotationLockState,
} from './overlayRotationLock.js'
import { STATIC_PLANE_LOCK_WAIT_MS } from './projectionAuthority.js'
import type { OverlayCollection } from './overlayHistoryProtocol.js'
import type { WorkspaceKey } from './projector.js'
import type { ReleasableQueryable } from './queryableShape.js'
import type { Queryable } from './types.js'

/**
 * Ordinary-workspace writer-head rotation — PHASE 3, THE ROTATOR.
 *
 * Replaces an ordinary workspace's CURRENT overlay write head with a fresh,
 * empty one, so the history every new actor's first change is applied against
 * starts again from nothing. Called by the owner cell's projector
 * (`projectorService.ts`) when `AM_ORDINARY_HEAD_ROTATION=on`, the workspace is
 * allow-listed, and the observer reports the head due
 * (`ordinaryHeadRotation.ts`). The retired head stays listed, claimed and
 * reachable; its late writes are forwarded (`ordinaryHeadForwarding.ts`).
 *
 * THE SEQUENCE, and what a crash after each step leaves:
 *
 *  1. ownership (synchronous), then the write fence and plane (database).
 *     Nothing written yet.
 *  2. the `overlay-rotation:` session advisory lock, the SAME key the static
 *     plane's rotation and fold take (`overlayRotationLock.ts`), by REFUSAL,
 *     never by waiting: only `'acquired'` licenses the work — `'unknown'` (an
 *     answer nobody can read) is not permission. Held to the end, released in
 *     the `finally` with the module's hand-back. Nothing written yet.
 *  3. ownership re-checked and the head still current, under the lock.
 *  4. the CHILD: created, FLUSHED, then CLAIMED for the workspace
 *     (`createClaimedOverlaySegment`, `overlaySegments.ts`). A crash here
 *     leaves a durable, claimed document nothing names — fsck's
 *     `document-orphaned` reports it and GC sweeps it; no pointer exists.
 *  5. H_r = the retired head's heads its projection has already PUBLISHED —
 *     never its live heads, which `A.stats` and the live document can be
 *     ahead of (phase-1 review). Refused when nothing is published yet or the
 *     document does not hold them.
 *  6. the retired head FLUSHED, so H_r is in its own storage before any row
 *     names it (the forwarder refuses a head it cannot find, for ever:
 *     `unknown-heads`). Ownership and "still current" re-checked.
 *  7. the `retired` row WITH H_r committed — BEFORE ModelMeta moves, the
 *     contract in `ordinaryHeadForwarding.ts`: the projector reads rows when a
 *     pointer moves, so a row that lands after the move is not seen until a
 *     re-attach and the head is projected directly meanwhile. On the lock's
 *     own client, with a bare BEGIN and the plane and fence asserted inside —
 *     NOT through `withReadModelProjectionTransaction`: that takes the
 *     `read-model-projection:` mutex, and the one global lock order is
 *     projection-mutex BEFORE overlay-rotation (`projectionTransaction.ts`),
 *     which a holder of the rotation key asking for the mutex would invert.
 *     A crash here leaves a `retired` row naming the STILL-CURRENT head. That
 *     is HARMLESS: the projector forwards a head only when another head is
 *     current (`isForwardedHead`), so this one keeps being projected; the
 *     compaction check skips the current head; the next rotation's upsert
 *     overwrites the row's H_r with the then-published heads and resets
 *     `forwarded_heads`. Promotion refuses while it exists (conservative).
 *  8. ownership and "still current" re-checked SYNCHRONOUSLY, then ONE
 *     ModelMeta change — repoint the head, append to both URL lists — with no
 *     await between the check and the change. A crash before the meta is
 *     saved loses the change or keeps it (peers may have synced it); either
 *     way it names only a durable, claimed child behind a committed row.
 *  9. ModelMeta flushed. The lock is released.
 *
 * WHAT IT DOES NOT DO: bound the chain. Every rotation appends one segment;
 * the chain fold (`ordinaryChainFoldWriter.ts`, phase 4) is what removes them.
 * Listed heads are kept by GC (`gc.ts` marks every `objectShardUrls` /
 * `edits*ShardUrls` entry).
 *
 * KNOWN LIMITS, each gating any allow-list beyond the bench (the full text,
 * with the code each one lives in, is in `docs/read-model-projector-health.md`,
 * "Known limits"):
 *  (a) the first write of an entity into the fresh head is a whole-entity put
 *      (`src/lib/automerge/bridge.ts`), so two ONLINE clients editing
 *      different fields of X right after a repoint produce a `$` conflict —
 *      healed against the SERVED value captured from `ro_objects`, so no edit
 *      is lost for objects (refuted 2026-11-06, G4-16g,
 *      `ordinaryHeadFirstWriteConflict.integration.test.ts`); connections are
 *      not exercised by that test;
 *  (b) the segment chain is bounded by the fold and retired heads are parked
 *      (phase 4); sealed products still grow with cumulative edits (G4-16f);
 *  (c) POOL: this holds its lock client for the whole rotation while
 *      `createChild` claims through a SECOND pool client (`docScope.ts`), so
 *      as many concurrent rotations as the pool has clients starve each other;
 *  (d) no ceiling on the row transaction's round trips (its `lock_timeout`
 *      bounds waits, not work) nor on the three flushes, all under the lock;
 *  (e) a rotated workspace can never be promoted: any row refuses it
 *      (`promoteSummaryWorkspace.ts`), and nothing removes rows;
 *  (f) the bench seeds NEW objects into each rotated head, so its rotation-on
 *      arm never forwards an existing entity: an A/B of the arms measures
 *      neither forwarding nor (a).
 */

export interface RotateOrdinaryHeadArgs {
  key: WorkspaceKey
  collection: OverlayCollection
  /** The head this rotation retires — the one the observer found due. */
  retired: { url: string; documentId: DocumentId; doc(): unknown }
  /** ModelMeta, read live at every check. */
  meta: { documentId: DocumentId; doc(): Record<string, unknown> | undefined }
  /** The retired head's heads its projection last PUBLISHED, or null. */
  publishedHeads: () => readonly string[] | null
  /** Synchronous ownership (lease + projector not stopped). */
  mayWrite: () => boolean
  /** Fence and plane, read from the database before anything is written. */
  assertAuthority: () => Promise<void>
  /** A pooled client: the lock is session-scoped and the row is committed on it. */
  connect: () => Promise<ReleasableQueryable>
  /** Create → flush → claim; resolves only when all three are done. */
  createChild: () => Promise<{ url: string; documentId: DocumentId }>
  flush: (documentIds: DocumentId[]) => Promise<unknown>
  /** Inside the row's transaction: plane (`FOR KEY SHARE`) and write fence. */
  assertTransactionAuthority: (tx: Queryable) => Promise<void>
  /** The ONE ModelMeta change (`publishOverlaySegment`). Synchronous. */
  publish: (childUrl: string) => void
  log?: (line: string) => void
}

export type RotateOrdinaryHeadOutcome =
  | { outcome: 'not-owner' }
  | { outcome: 'not-current' }
  | { outcome: 'lock-refused'; state: OverlayRotationLockState }
  | { outcome: 'nothing-published' }
  /** The head stopped being ours to rotate after the child existed. */
  | { outcome: 'superseded'; childUrl: string; stage: 'before-row' | 'after-row' }
  | { outcome: 'rotated'; childUrl: string; retirementHeads: string[] }

const metaField = (collection: OverlayCollection) =>
  collection === 'object' ? 'editsObjectShardUrl' : 'editsConnectionShardUrl'

/**
 * Record the retirement of the CURRENT head: an upsert, because a row may
 * already name it — the crash at step 7 above. Overwriting is sound only
 * because the head is current (checked under the lock on both sides of this
 * commit): nothing forwards a current head, and everything it holds up to the
 * new H_r is published, so `forwarded_heads` restarts from the new H_r.
 */
export async function commitOrdinaryHeadRetirement(
  tx: Queryable,
  key: WorkspaceKey,
  collection: OverlayCollection,
  documentId: string,
  retirementHeads: readonly string[],
): Promise<void> {
  // Never over a `folded` row (G4-16b phase 4): folding is one-way, and
  // readers of the fold record rely on it. A head that is folded and current
  // again can only come from a ModelMeta write pointing back at it; refused
  // loudly, the rotation fails and is retried, nothing moves.
  const result = await tx.query(
    `INSERT INTO read_model_ordinary_head_retirements (
       landscape_id, version_id, collection, document_id, retirement_heads, status, origin
     ) VALUES ($1, $2, $3, $4, $5::text[], 'retired', 'rotation')
     ON CONFLICT (landscape_id, version_id, collection, document_id) DO UPDATE
     SET retirement_heads = EXCLUDED.retirement_heads,
         forwarded_heads = NULL,
         status = 'retired',
         -- G4-16e: the row now records THIS rotation (a product is never the
         -- current head, so this never relabels a fold product).
         origin = 'rotation',
         updated_at = now()
     WHERE read_model_ordinary_head_retirements.status <> 'folded'`,
    [key.landscapeId, key.versionId, collection, documentId, [...retirementHeads].sort()],
  )
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error(`ordinary head ${collection} ${documentId} of ${key.landscapeId}/${key.versionId} `
      + 'is folded; it cannot be retired again')
  }
}

export async function rotateOrdinaryHead(args: RotateOrdinaryHeadArgs): Promise<RotateOrdinaryHeadOutcome> {
  const log = args.log ?? ((line: string) => console.warn(line))
  const field = metaField(args.collection)
  const stillCurrent = () => args.meta.doc()?.[field] === args.retired.url
  if (!args.mayWrite()) return { outcome: 'not-owner' }
  // BEFORE the client: a projector that lost its fence or its plane costs one
  // read, no connection and no lock.
  await args.assertAuthority()
  const lockKey = overlayRotationLockKey(args.key.landscapeId, args.key.versionId, args.collection)
  const client = await args.connect()
  // `unknown`, not `refused`, is the safe start: a throw from the acquisition
  // leaves exactly that gap, and its hand-back DESTROYS the session.
  let lock: OverlayRotationLockState = 'unknown'
  let inTransaction = false
  try {
    lock = await acquireOverlayRotationLock(client as unknown as PoolClient, lockKey)
    // `!== 'acquired'`, NOT `=== 'refused'`: three states, one licence.
    if (lock !== 'acquired') {
      reportOverlayRotationLockContended({
        path: 'rotate', landscapeId: args.key.landscapeId, versionId: args.key.versionId,
        kind: args.collection, state: lock,
      })
      return { outcome: 'lock-refused', state: lock }
    }
    if (!args.mayWrite()) return { outcome: 'not-owner' }
    if (!stillCurrent()) return { outcome: 'not-current' }
    // A head with nothing published is not rotated: H_r would have to be
    // invented, and an empty H_r would forward the head's whole history.
    const precheck = args.publishedHeads()
    if (!precheck?.length) return { outcome: 'nothing-published' }

    const child = await args.createChild()

    // H_r read AFTER the child exists: the retired head kept being projected
    // meanwhile, and a later H_r leaves less to forward.
    const retirementHeads = [...(args.publishedHeads() ?? precheck)]
    if (!hasHeads(args.retired.doc() as never, retirementHeads)) {
      // Unreachable while the published heads come from this document's own
      // samples; reported rather than recorded, because a row naming heads the
      // document lacks refuses every forward of it for ever.
      log(JSON.stringify({
        event: 'read_model.ordinary_head_rotation_refused',
        reason: 'published-heads-not-in-document',
        workspace: `${args.key.landscapeId}/${args.key.versionId}`,
        collection: args.collection,
        retired: args.retired.documentId,
      }))
      return { outcome: 'nothing-published' }
    }
    await args.flush([args.retired.documentId])
    if (!args.mayWrite() || !stillCurrent()) {
      return { outcome: 'superseded', childUrl: child.url, stage: 'before-row' }
    }

    // ONE statement for BEGIN + the bound, as `beginBoundedTransaction` does:
    // as two, a BEGIN that succeeded and a SET that threw would leave the
    // transaction open while `inTransaction` still said false.
    await client.query(`BEGIN; SET LOCAL lock_timeout = '${STATIC_PLANE_LOCK_WAIT_MS}ms'`)
    inTransaction = true
    await args.assertTransactionAuthority(client)
    await commitOrdinaryHeadRetirement(
      client, args.key, args.collection, args.retired.documentId, retirementHeads,
    )
    // ONE authority check, not a second after the INSERT (removed in the
    // phase-3 review: no mutant was found that a second one kills).
    //  - The FENCE half cannot change in between: the check above took
    //    `read_model_projection_state` FOR UPDATE, held to COMMIT, and every
    //    writer of `write_fence` (a takeover's CAS, `claimLifecycleWriteFence`)
    //    is an UPDATE of that row and waits for this transaction.
    //  - The PLANE half locks nothing on an ordinary workspace (its authority
    //    is the ABSENCE of a `read_model_static_workspaces` row), so a re-read
    //    could in principle see a static row committed in between — but only
    //    one written by a door that does not take the fence. The promotion
    //    takes it in the SAME transaction as that row, so its row commits
    //    after this one, and it then re-counts the retirement rows behind the
    //    fence and refuses (`promoteSummaryWorkspace.ts`, step 3). The other
    //    writers of that row (`landscapes.ts` sparse drafts, the performance
    //    seed) create a workspace rather than convert a live one. And a second
    //    read would only have shrunk the window to one INSERT: the repoint
    //    after COMMIT is not re-checked against the plane either.
    await client.query('COMMIT')
    inTransaction = false

    // NO await between this check and the change.
    if (!args.mayWrite() || !stillCurrent()) {
      return { outcome: 'superseded', childUrl: child.url, stage: 'after-row' }
    }
    args.publish(child.url)
    await args.flush([args.meta.documentId])
    log(JSON.stringify({
      event: 'read_model.ordinary_head_rotated',
      workspace: `${args.key.landscapeId}/${args.key.versionId}`,
      collection: args.collection,
      retired: args.retired.documentId,
      child: child.documentId,
      retirementHeads: retirementHeads.length,
    }))
    return { outcome: 'rotated', childUrl: child.url, retirementHeads: [...retirementHeads].sort() }
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await releaseOverlayRotationLock(client as unknown as PoolClient, lockKey, lock)
  }
}
