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

import type { DocHandle, Repo } from '@automerge/automerge-repo'
import type { WorkspaceKey } from './rbac/docScope.js'
import type { WorkspaceRef } from './rbac/documentIdMint.js'
import { createBootstrapDocument } from './bootstrapMint.js'
import { noteBootstrapPlacement, retireBootstrapPlacement } from './rbac/serverCreationPlacement.js'
import {
  requireWriteAuthority,
  WriteAuthorityLostError,
  WriteAuthorityUnavailableError,
  type WriteAuthority,
  type WriteAuthorityOwnership,
} from './syncCells/writeAuthority.js'
import type { MetricSample } from './runtime/metrics.js'

/**
 * THE BOOTSTRAP SCOPE — creating a document graph UNDER AN AUTHORITY, before
 * the workspace it is for exists.
 *
 * ## The hole
 *
 * The bootstrap family — `forkRoot`, `createEmptyRoot`, `createSparseDraftRoot`,
 * the merge's copies and overlay segments, the sparse on-demand clone — mints
 * N documents BEFORE a publisher inserts the `versions` row and claims them.
 * Until that claim the storage fence has no durable row to check a lease
 * against, and the two placement sources it consults answer only for documents
 * a route gate admitted or `createClaimedDocument` minted. Without this scope
 * the fence would admit every bootstrap save unconditionally — a merge, draft
 * or version could commit documents on a cell that owns no workspace at all
 * (a split-brain write).
 *
 * ## The key is the FORKER's lease, because nothing else is lease-able
 *
 * `sync_workspace_ownership.version_id REFERENCES versions(id)`, so no lease
 * and no fencing token can exist for the TARGET before its row is inserted;
 * and the target hashes to a partition that is in general not the forking
 * cell's, so the publisher cannot acquire it first either. The only lease-able
 * fact at mint time is "this cell holds the lease on the workspace the write
 * is authorised BY": the parent for a draft or a merge snapshot, the
 * landscape's default version for a new version (its source may be a merged
 * draft that no cell can ever lease — `OWNABLE_WORKSPACES_SQL` selects
 * `active`), the draft itself for a sparse clone, the parent for the merge's
 * copies. The router places those doors on the same key, so the cell a request
 * is proxied to is the one that can open the scope.
 *
 * Creations with NO forker — `createLandscape`, first-login provisioning —
 * have no lease-able key and say so: `{ kind: 'unfenced', reason: 'no-forker' }`
 * is a declared, counted population, not an omission.
 *
 * ## Same shape as `workspaceWriter.ts`, for a graph
 *
 * `workspaceWriter.ts` is the tree's "create under an authority": the workspace
 * COMES FROM the authority so the two cannot be supplied apart, and
 * `stillHeld()` is re-asked at the mint because a `WriteAuthority` is a reading
 * of a moment. This module is that shape for a GRAPH rather than a document:
 * `requireWriteAuthority(ownership, forker)` is asked ONCE at `open` — a
 * refusal there is atomic, nothing has been minted, and the HTTP layer answers
 * `wrote: 'nothing'` — and `stillHeld()` is re-asked at EVERY `create`, so a
 * lease lost mid-fork fails with a reason (`WriteAuthorityLostError`) instead
 * of a fence-mismatch on the flush. `createdDocumentIds` is produced by the act
 * of creating, so callers never assemble the id list by hand.
 *
 * The fence is the second line, not the first. The scope's authority answers
 * before any mint; the placement note it takes in the same synchronous frame as
 * the mint (`serverCreationPlacement.ts`, the FORKER tier) is what the storage
 * fence consults on every save until the claim commits, and what the durable
 * fencing-token comparison runs against. The note stores the WORKSPACE, not
 * the granted token: the fence compares the ownership row against this cell's
 * LIVE token at save time (`automergeStorage.ts`, slot `fencing_token`). So a
 * lease this cell no longer holds is refused by SQL; a lease this cell lost
 * and re-acquired at a higher token between two creates is admitted under the
 * new token, and only `stillHeld()` — checked between creates, not inside a
 * save — sees that it moved.
 *
 * ## Ownership reaches this module through ONE installed source
 *
 * Otherwise every bootstrap site would have to be handed the coordinator, a
 * parameter that a call site can forget without any test noticing.
 * `installBootstrapOwnership` is called once by `index.ts` with a
 * GETTER over its coordinator, so the boot window — `SYNC_CELL_OWNERSHIP=on`
 * and the coordinator not yet constructed — is `warming-up`, exactly as the
 * router's `ownershipRequired` treats it. Not installed at all (vitest, the gc
 * worker, an AUTH=off dev boot with ownership unset) means ownership absent and
 * not required: the scope is unfenced, notes nothing, and the storage adapter
 * on such a process has no `ownership` and never reads the map.
 */

export type BootstrapAuthorityRequest =
  /** Fenced under this workspace's lease — the parent, the landscape default,
   *  the draft a clone lands in. */
  | { kind: 'forker'; workspace: WorkspaceKey }
  /** No lease-able key exists: a landscape being created has no row yet. */
  | { kind: 'unfenced'; reason: 'no-forker' }

export interface BootstrapScope {
  readonly target: WorkspaceRef
  readonly authority: BootstrapAuthorityRequest
  /** A real `WriteAuthority` was granted and every create is fenced under it. */
  readonly fenced: boolean
  /** The lease this scope writes under, or null when unfenced. */
  readonly forker: WorkspaceKey | null
  /**
   * Mint one document for `target`. Re-asks the authority first when fenced;
   * takes the placement note in the same synchronous frame as the mint; adds
   * the id to `createdDocumentIds`. Synchronous like `repo.create` — callers
   * `await handle.whenReady()` as they always did.
   */
  create<T extends object>(repo: Repo, value: T): DocHandle<T>
  readonly createdDocumentIds: readonly string[]
  /**
   * After a publisher fails: mark this scope's entries as residue. They stay
   * readable by the fence — the armed write-back of a torn-down document must
   * still be refused on a lease-less cell — and are evicted ahead of live
   * entries at capacity. Idempotent.
   */
  retire(): void
}

export interface BootstrapOwnershipSource {
  /** Is ownership REQUIRED on this process (`SYNC_CELL_OWNERSHIP=on`)? Read at
   *  every open so a test can flip it. */
  required: () => boolean
  /** The coordinator, or null while it is not constructed yet. */
  current: () => WriteAuthorityOwnership | null
}

let ownershipSource: BootstrapOwnershipSource | null = null

/** Point every scope at the process's coordinator. Returns the uninstaller. */
export function installBootstrapOwnership(source: BootstrapOwnershipSource): () => void {
  ownershipSource = source
  return () => { ownershipSource = null }
}

let opened = 0
let refusedAtOpen = 0
let refusedAtOpenByReason: Record<'warming-up' | 'not-owner', number> = { 'warming-up': 0, 'not-owner': 0 }
let lostMidScope = 0
let unfenced = 0
let unfencedByReason: Record<'no-forker' | 'ownership-disabled' | 'ownership-not-installed', number> = {
  'no-forker': 0, 'ownership-disabled': 0, 'ownership-not-installed': 0,
}
let retired = 0

function assertAuthorityRequest(authority: unknown): asserts authority is BootstrapAuthorityRequest {
  const candidate = authority as Partial<BootstrapAuthorityRequest> | null | undefined
  if (candidate && candidate.kind === 'unfenced' && candidate.reason === 'no-forker') return
  if (candidate && candidate.kind === 'forker') {
    const workspace = (candidate as { workspace?: Partial<WorkspaceKey> }).workspace
    if (workspace && typeof workspace.landscapeId === 'string' && workspace.landscapeId.length > 0
      && typeof workspace.versionId === 'string' && workspace.versionId.length > 0) return
  }
  // A missing authority is a caller bug and it must fail on every path —
  // `server/` does not typecheck its test files, so a suite that forgot the
  // argument would otherwise pass on an unfenced scope and the omission would
  // surface in production, where the fence is on.
  throw new Error(
    'openBootstrapScope: an authority is required — { kind: "forker", workspace } or { kind: "unfenced", reason: "no-forker" }',
  )
}

/**
 * Open a scope for `target`. With a `forker`, asks the installed ownership for
 * the authority NOW and throws `WriteAuthorityUnavailableError` before anything
 * is minted when it is refused; the four answers are `requireWriteAuthority`'s
 * (disabled → unfenced grant; absent-and-required → `warming-up`; not the owner
 * → `not-owner`; owner → fenced under the live token).
 */
export function openBootstrapScope(target: WorkspaceRef, authority: BootstrapAuthorityRequest): BootstrapScope {
  assertAuthorityRequest(authority)
  opened += 1
  const ids: string[] = []
  let granted: WriteAuthority | null = null
  let fencedReason: keyof typeof unfencedByReason | null = null

  if (authority.kind === 'unfenced') {
    fencedReason = 'no-forker'
  } else {
    const source = ownershipSource
    const ownership = source?.current() ?? null
    const required = source !== null && source.required()
    if (source === null) {
      // No process ever installed a coordinator source: vitest, the gc worker.
      // A source that IS installed (index.ts) and answers null with ownership
      // not required — SYNC_CELL_OWNERSHIP off — falls through to
      // `requireWriteAuthority`, which grants with no token, and is counted
      // `ownership-disabled` below: the single-cell case it is.
      fencedReason = 'ownership-not-installed'
    } else {
      // Throws `warming-up` when required and absent, `not-owner` when the
      // coordinator says so. Counted on the way out, because a refusal here is
      // the "wrote: nothing" answer the HTTP layer reports and the bench reads.
      let authorityGranted: WriteAuthority
      try {
        authorityGranted = requireWriteAuthority(ownership, authority.workspace, { required })
      } catch (error) {
        if (error instanceof WriteAuthorityUnavailableError) {
          refusedAtOpen += 1
          refusedAtOpenByReason[error.reason] += 1
        }
        throw error
      }
      // `fencingToken` is null exactly when ownership is DISABLED (a granted
      // authority on an enabled coordinator always carries the live token —
      // `requireWriteAuthority` throws otherwise) or when the coordinator is
      // absent and not required. Both are unfenced grants.
      if (authorityGranted.fencingToken === null) fencedReason = 'ownership-disabled'
      else granted = authorityGranted
    }
  }
  if (fencedReason !== null) {
    unfenced += 1
    unfencedByReason[fencedReason] += 1
  }

  const fenced = granted !== null
  const forker = authority.kind === 'forker' ? authority.workspace : null
  let retiredAlready = false

  return {
    target,
    authority,
    fenced,
    forker: fenced ? forker : null,
    get createdDocumentIds(): readonly string[] { return ids },
    create<T extends object>(repo: Repo, value: T): DocHandle<T> {
      // RE-ASKED HERE, before the mint — not trusted from `open`. Everything
      // between the two is an await the caller made (a source read, a
      // `whenReady`), and ownership does not pause for it. Checked BEFORE the
      // handle exists, so a refusal leaves nothing behind.
      if (granted && !granted.stillHeld()) {
        lostMidScope += 1
        throw new WriteAuthorityLostError(granted.workspace)
      }
      return createBootstrapDocument<T>(repo, target, value, {
        // THE NOTE, IN THE SAME SYNCHRONOUS FRAME AS THE MINT. `repo.import`
        // and `repo.create` both arm the first save on a TIMER
        // (`StorageSource.attach` → `asyncThrottle`, a macrotask), so a note
        // taken before this frame yields precedes every save — and one taken
        // after any await does not. `bootstrapScope.test.ts` pins this through
        // a deferred-`whenReady` repo, as `workspaceWriter.ordering.seam.test.ts`
        // does for the owner tier.
        onMinted: (documentId) => {
          ids.push(documentId)
          if (granted && forker) noteBootstrapPlacement(documentId, forker)
        },
      })
    },
    retire(): void {
      if (retiredAlready) return
      retiredAlready = true
      if (!fenced) return
      retired += 1
      retireBootstrapPlacement(ids)
    },
  }
}

export interface BootstrapScopeSnapshot {
  opened: number
  refusedAtOpen: number
  refusedAtOpenByReason: Record<'warming-up' | 'not-owner', number>
  lostMidScope: number
  unfenced: number
  unfencedByReason: Record<'no-forker' | 'ownership-disabled' | 'ownership-not-installed', number>
  retired: number
  installed: boolean
}

/** Process-wide counters, exposed on `/api/platform/sync-cell` beside the
 *  storage fence's, so a 503 can be attributed to THIS mechanism rather than
 *  to whatever else answers 503 during an outage. */
export function bootstrapScopeSnapshot(): BootstrapScopeSnapshot {
  return {
    opened,
    refusedAtOpen,
    refusedAtOpenByReason: { ...refusedAtOpenByReason },
    lostMidScope,
    unfenced,
    unfencedByReason: { ...unfencedByReason },
    retired,
    installed: ownershipSource !== null,
  }
}

/** TEST SEAM. Counters are process-wide; the installed source is left alone
 *  (tests that install one uninstall it through the returned function). */
export function resetBootstrapScopeCountersForTest(): void {
  opened = 0
  refusedAtOpen = 0
  refusedAtOpenByReason = { 'warming-up': 0, 'not-owner': 0 }
  lostMidScope = 0
  unfenced = 0
  unfencedByReason = { 'no-forker': 0, 'ownership-disabled': 0, 'ownership-not-installed': 0 }
  retired = 0
}

/** Read as DELTAS, never as absolutes — nothing resets them in production. */
export function bootstrapScopeMetricSamples(): MetricSample[] {
  return [
    {
      name: 'maplespire_bootstrap_scopes_opened_total',
      help: 'Bootstrap scopes opened (a fork, an empty root, a sparse draft, a merge). One per document GRAPH, not per document.',
      type: 'counter',
      values: [{ value: opened }],
    },
    {
      name: 'maplespire_bootstrap_scopes_refused_total',
      help: 'Bootstrap scopes refused at open because this cell held no authority for the forker workspace — nothing was minted. Non-zero on a cell that is serving means bootstrap writes are reaching a cell that does not own their forker: routed doors should not produce this (the router proxies first, the three direct AI tool doors included since B2-10a), nor should the /api/ai/chat and /api/ai/run agent loops (their placed tool calls are relayed to the owner before any scope opens, since B2-10b); a bootstrap tool called through /mcp still does.',
      type: 'counter',
      values: [
        { value: refusedAtOpenByReason['not-owner'], labels: { reason: 'not-owner' } },
        { value: refusedAtOpenByReason['warming-up'], labels: { reason: 'warming-up' } },
      ],
    },
    {
      name: 'maplespire_bootstrap_scopes_lost_total',
      help: 'Bootstrap scopes whose authority moved between open and a later mint — the lease was lost mid-fork. The fork is rolled back; nothing durable is claimed.',
      type: 'counter',
      values: [{ value: lostMidScope }],
    },
    {
      name: 'maplespire_bootstrap_scopes_unfenced_total',
      help: 'Bootstrap scopes opened WITHOUT a fence, by reason: no-forker (createLandscape, provisioning — no lease-able key exists), ownership-disabled (SYNC_CELL_OWNERSHIP off or a granted authority with no token: single-cell, no fence at all), ownership-not-installed (a process that never installed a coordinator source: vitest, the gc worker). On a SYNC_CELL_OWNERSHIP=on cell only no-forker is expected.',
      type: 'counter',
      values: [
        { value: unfencedByReason['no-forker'], labels: { reason: 'no-forker' } },
        { value: unfencedByReason['ownership-disabled'], labels: { reason: 'ownership-disabled' } },
        { value: unfencedByReason['ownership-not-installed'], labels: { reason: 'ownership-not-installed' } },
      ],
    },
  ]
}
