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

import type { WorkspaceKey } from '../rbac/docScope.js'
import {
  requireWriteAuthority,
  WriteAuthorityUnavailableError,
  type WriteAuthority,
  type WriteAuthorityOwnership,
} from './writeAuthority.js'

/**
 * EVERYTHING THE DRAFT MERGE DOES BEFORE IT WRITES.
 *
 * ## Why this is a module and not lines inside the handler
 *
 * `index.ts` exports nothing and no test can load it, so logic inline there
 * (the authority check, the rotation witness, the cross-partition warning) is
 * untestable. The refusal that stands between a merge and a split-brain write
 * lives here so `mergePlacement.test.ts` can execute it.
 *
 * ## The ordering is the product, not an implementation detail
 *
 *   1. Take the authority for the PARENT — the workspace `applyMerge` claims
 *      its documents into — BEFORE the root loop. A refusal here is genuinely
 *      atomic, because nothing has run.
 *   2. Walk `[draft, parent]` and let each half's root be repaired. The DRAFT
 *      comes first, which is why the rotation witness is OR-ed rather than
 *      assigned: a witness set only by the last iteration would report "nothing
 *      written" for exactly the case that needs reporting.
 *   3. Re-ask `stillHeld()`. Everything between step 1 and here is an await, and
 *      a predicate read before an await guards nothing during it.
 *
 * ## What the refusal proves, and what it does not
 *
 * `stillHeld()` proves ownership at THAT INSTANT. It does not follow the write
 * into `applyMerge`, which flushes a freshly created document BEFORE it claims
 * it — so the storage fence has no durable mapping row to check on the first
 * write of a merge. That window is the bootstrap scope's concern
 * (`bootstrapScope.ts`, `bootstrapMint.ts`), not this module's.
 *
 * Which is why the refusal carries `wrote`. By the time step 3 runs, step 2 may
 * already have rotated a root durably; a 503 that said "nothing was written"
 * would be false exactly when it mattered.
 */

/** The half of the merge a rotation happened on. Both are written; only the
 *  parent is placed. */
export type MergeHalf = 'draft' | 'parent'

export interface MergePlacementRefusal {
  status: 503
  retryAfterSeconds: string
  body: {
    error: string
    retryable: true
    /** `'nothing'`, or what step 2 durably wrote before this refusal fired. */
    wrote: string
  }
}

export interface MergePlacementOptions {
  /** `null` is the boot window; `requireWriteAuthority` answers `warming-up`. */
  ownership: WriteAuthorityOwnership | null
  landscapeId: string
  draftId: string
  /** `null` for a draft that names no parent. Nothing is placed, and nothing is
   *  asked of the authority — manufacturing a key with an empty versionId to
   *  have something to ask about would hash into a real partition. */
  parentVersionId: string | null
  /** `landscapes.ts`'s `resolveRootUrl`, curried. Falsy means "no root", and
   *  the loop then touches nothing. A failed read throws (an explicit key has
   *  no fallback root) and ends the merge before `applyMerge`. */
  resolveRootUrl: (key: WorkspaceKey) => Promise<string | null>
  /** `index.ts`'s `ensureCanonicalWorkspaceRoot`. Calls `onRotated` EXACTLY
   *  when it published a fresh root and swapped `versions.root_url` — not when
   *  it merely returned a healthy one. */
  ensureCanonicalRoot: (key: WorkspaceKey, url: string, observe: { onRotated: () => void }) => Promise<unknown>
  /** Emitted when a root was rotated on a workspace this cell does NOT own.
   *  Reported, never refused — see `sync.cell.merge_root_rotated_unowned` at the
   *  call site for why refusing is not available to us. */
  onUnownedRotation?: (event: { half: MergeHalf; key: WorkspaceKey }) => void
}

/**
 * Returns `null` when the merge may proceed, or the refusal to answer.
 *
 * THROWS `WriteAuthorityUnavailableError` from step 1 — deliberately, and not
 * folded into the return type. Step 1's refusal is a different fact from step
 * 3's: nothing whatsoever has run, so the caller can say `wrote: 'nothing'`
 * without qualification. `writeAuthorityRefusal` below is that mapping, shared
 * so the two spellings cannot drift.
 */
export async function placeMergeWrite(options: MergePlacementOptions): Promise<MergePlacementRefusal | null> {
  const { landscapeId, draftId, parentVersionId } = options
  const authority: WriteAuthority | null = parentVersionId
    ? requireWriteAuthority(options.ownership, { landscapeId, versionId: parentVersionId })
    : null

  let rotated: MergeHalf | null = null
  for (const versionId of [draftId, parentVersionId].filter((id): id is string => Boolean(id))) {
    const key = { landscapeId, versionId }
    const half: MergeHalf = versionId === parentVersionId ? 'parent' : 'draft'
    const candidate = await options.resolveRootUrl(key)
    if (!candidate) continue
    await options.ensureCanonicalRoot(key, candidate, {
      onRotated: () => {
        // OR-ed, not assigned: the DRAFT is first, so `rotated = half` would
        // erase a draft-side rotation the moment the parent iteration ran
        // cleanly — reporting "nothing written" for the case that needs it.
        rotated ??= half
        if (options.ownership?.enabled && !options.ownership.owns(key)) {
          options.onUnownedRotation?.({ half, key })
        }
      },
    })
  }

  if (!authority || authority.stillHeld()) return null
  return {
    status: 503,
    retryAfterSeconds: '1',
    body: {
      error: 'workspace owner changed while the merge was being prepared',
      retryable: true,
      wrote: rotated === null
        ? 'nothing'
        : `a ${rotated} workspace root was rotated before this refusal`,
    },
  }
}

/**
 * `WriteAuthorityUnavailableError` as an HTTP answer.
 *
 * 503 + `retryable: true` for BOTH reasons, and the mapping lives at the
 * boundary on purpose. The error's own `retryable` is false for `not-owner`
 * because it describes THIS PROCESS, for which the answer is terminal; the HTTP
 * answer describes the CLIENT, whose retry goes back through the load balancer
 * and reaches the new owner. `index.ts`'s `ensureWorkspace` maps
 * `classifyWorkspaceRefusal` the same way: `owns() = false` yields 503 +
 * `retryable`.
 *
 * `wrote: 'nothing'` is unqualified here, and that is a property of WHERE the
 * throw comes from: step 1 of `placeMergeWrite`, before the root loop.
 */
export function writeAuthorityRefusal(error: WriteAuthorityUnavailableError): MergePlacementRefusal & {
  body: { reason: string }
} {
  return {
    status: 503,
    retryAfterSeconds: error.retryable ? '2' : '1',
    body: { error: error.message, reason: error.reason, retryable: true, wrote: 'nothing' },
  }
}
