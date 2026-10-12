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

/**
 * THE AUTHORITY TO WRITE A WORKSPACE.
 *
 * An unrouted write does not fail; it succeeds on a cell that does not own the
 * workspace. This module is the authority a write handler asks before
 * writing. Its production call site is the draft-merge handler (`index.ts`).
 *
 * WHY THE MERGE AND NOT THE OTHER WRITE DOORS. The three summary doors and the
 * reference repair are already refused by the storage fence when the lease is
 * gone (`ownership-unavailable`, with no durable change). The merge is not:
 * `applyMerge` flushes a freshly created document before it claims it, so the
 * fence has no durable mapping row to check and the write would commit on a
 * cell holding neither the partition nor the lease. This authority stands in
 * that gap.
 *
 * ## What it is, and what it is not
 *
 * It is a PERMISSION plus the FENCING TOKEN that permission was granted under.
 * It is not a lock: nothing is held, nothing is released, and holding a granted
 * authority across an await does not stop ownership moving. That is what
 * `stillHeld()` is for — the caller re-asks immediately before the write, which
 * is the same shape `runWorkspaceCompaction`'s `stillSafeToWrite` uses and for
 * the same reason: a predicate read before an await guards nothing during it.
 *
 * ## Fail closed, and the default says so
 *
 * `required` defaults to TRUE. A caller that has not thought about the boot
 * window gets the strict answer, and the permissive one has to be asked for by
 * name — a knob's safe setting must not be the one nobody types.
 */

export type WriteAuthorityRefusal = 'warming-up' | 'not-owner'

export class WriteAuthorityUnavailableError extends Error {
  constructor(
    readonly reason: WriteAuthorityRefusal,
    readonly workspace: WorkspaceKey,
  ) {
    super(
      reason === 'warming-up'
        ? `write authority for ${workspace.landscapeId}/${workspace.versionId} is not decidable yet: `
          + 'sync-cell ownership has not been constructed, so this process cannot say whether it owns '
          + 'the workspace. Retry — this is the boot window, not a denial.'
        : `this cell does not own ${workspace.landscapeId}/${workspace.versionId}, so a write here `
          + 'would be applied by a process that does not speak for the workspace. Route it to the owner.',
    )
    this.name = 'WriteAuthorityUnavailableError'
  }

  /**
   * Is the condition transient FOR THIS PROCESS? `warming-up` is; `not-owner`
   * is not — the write belongs to another cell and no amount of waiting here
   * changes that.
   *
   * This is NOT the HTTP answer. A write is never answered with a route in the
   * response body (`SYNC_CELL_ADVERTISE_URL` is an internal address a browser
   * cannot resolve), and a client's retry goes back through the load balancer
   * and reaches the new owner — so `not-owner` is also 503 + `retryable` at
   * the HTTP boundary, as `index.ts` maps `classifyWorkspaceRefusal`. Callers
   * map this property at the boundary.
   */
  get retryable(): boolean {
    return this.reason === 'warming-up'
  }
}

/**
 * Thrown when the authority moved between its grant and the write. Distinct
 * from `WriteAuthorityUnavailableError` on purpose: that one means "you never
 * had it", this one means "you had it and lost it", and only the second is
 * worth retrying immediately against the new owner.
 *
 * Defined HERE (a leaf) and re-exported by `rbac/workspaceWriter.ts`, where it
 * was born, so that `runtime/dependencyOutageResponse.ts` can name it in an
 * `instanceof` without importing `docScope` — that module builds pools at
 * import time, which is the trap `automergeStorageErrors.ts` documents.
 */
export class WriteAuthorityLostError extends Error {
  readonly retryable = true

  constructor(readonly workspace: WorkspaceKey) {
    super(
      `write authority for ${workspace.landscapeId}/${workspace.versionId} was lost between the grant `
      + 'and the write — another cell now owns the workspace, or this cell re-acquired at a higher '
      + 'fencing token. Nothing was created.',
    )
    this.name = 'WriteAuthorityLostError'
  }
}

/** The slice of the ownership coordinator this module needs. Narrow on purpose:
 *  a wider type would let a future call site reach for `acquire`/`release` from
 *  a request path, which must never happen. */
export interface WriteAuthorityOwnership {
  readonly enabled: boolean
  owns(workspace: WorkspaceKey): boolean
  fencingToken(workspace: WorkspaceKey): string | null
}

export interface WriteAuthority {
  readonly workspace: WorkspaceKey
  /**
   * The token this authority was granted under, or `null` when sync cells are
   * disabled and there is no fence at all.
   *
   * `null` is NOT "no token was available" — that case throws. It is the
   * single-cell deployment where ownership is off by configuration, and the
   * difference matters: a caller that writes the token into a fenced statement
   * must be able to tell "there is no fence" from "the fence could not be read".
   */
  readonly fencingToken: string | null
  /**
   * Is the authority still good, RIGHT NOW?
   *
   * Re-asked immediately before the write, never once at the top of a handler.
   * A granted authority is a reading of a moment; ownership can move during any
   * await between the grant and the write, and a token that moved means the
   * statement would be fenced out anyway — the point of asking is to fail with
   * a reason instead of a constraint violation.
   */
  stillHeld(): boolean
}

/**
 * Decide whether this process may write this workspace, and under which token.
 *
 * FOUR ANSWERS, and each one is a different fact:
 *   - ownership DISABLED — granted, `fencingToken: null`. A single-cell
 *     deployment has no fence and no owner to be; refusing here would break
 *     every write on the configuration most installations run.
 *   - ownership ABSENT and required — `warming-up`. The coordinator has not been
 *     constructed, so "do we own it" has no answer yet. Refusing is not a denial
 *     and the error says so; granting would be deciding a question nobody asked.
 *   - ownership ENABLED and not the owner — `not-owner`. Terminal for this
 *     process: the write belongs to another cell.
 *   - ownership ENABLED and the owner — granted, carrying the live token.
 */
export function requireWriteAuthority(
  ownership: WriteAuthorityOwnership | null,
  workspace: WorkspaceKey,
  options: { required?: boolean } = {},
): WriteAuthority {
  const required = options.required ?? true

  if (ownership === null) {
    if (required) throw new WriteAuthorityUnavailableError('warming-up', workspace)
    // NOT the same as the disabled case, even though both grant with a null
    // token: this one is "we could not ask", and the caller opted into it.
    return { workspace, fencingToken: null, stillHeld: () => true }
  }

  if (!ownership.enabled) {
    // `stillHeld` is CONSTANT here rather than re-reading a disabled
    // coordinator: there is no lease to lose, so a re-read could only ever
    // return the same answer, and a predicate that reads something irrelevant
    // is how a guard starts tracking the wrong proposition.
    return { workspace, fencingToken: null, stillHeld: () => true }
  }

  if (!ownership.owns(workspace)) throw new WriteAuthorityUnavailableError('not-owner', workspace)

  const granted = ownership.fencingToken(workspace)
  return {
    workspace,
    fencingToken: granted,
    // BOTH halves, and neither is redundant. Ownership can be lost without the
    // token changing (the lease goes away and no successor has taken it yet),
    // and the token can change while `owns` still answers true (this cell
    // re-acquired at a higher token, which fences the statement the caller was
    // about to run under the old one).
    stillHeld: () => ownership.owns(workspace) && ownership.fencingToken(workspace) === granted,
  }
}
