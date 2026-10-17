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

import { interpretAsDocumentId, isValidAutomergeUrl, type DocHandle } from '@automerge/automerge-repo'

/**
 * Selective Automerge sync, plus the WS/sync auth gate (see docs/auth-setup.md).
 *
 * A server repo with `sharePolicy: async () => true` PROACTIVELY announces and
 * pushes EVERY document it holds to every client on connect.
 * For a sharded workspace that is ~300 docs (root + ModelMeta + ~100 model shards +
 * registry + ~200 per-diagram docs), so a client syncs the whole workspace on every
 * boot (~52s at 20k objects).
 *
 * `shareConfig` splits that into two independent gates:
 *   - `announce(peer, docId)` — proactively push the doc to a peer WITHOUT being asked.
 *   - `access(peer, docId)`   — serve the doc when the peer explicitly requests it.
 *
 * That split is covered by `automergePeerSyncPatch.test.ts` and the
 * `docScope.*` suites.
 *
 * So we announce ONLY the small "core" boot set (root + ModelMeta + the registry
 * shards holding the diagram list) and keep `access` open, so a client lazily
 * `find`s the model shards + diagram docs it actually needs and the server still
 * serves them. The flood is gone; correctness (any doc reachable on request,
 * offline reload, live co-editing of open docs) is preserved.
 *
 * The "core" set is derived from the live root doc (its `modelUrl` / `modelMetaUrl`
 * / `shardUrls`) and refreshed whenever the root changes (a client splitting the
 * monolith into shards sets `modelMetaUrl`; new registry shards append `shardUrls`).
 *
 * --- `accessCheck` layers RBAC on top of the same `access` gate -------------
 * `access(peerId, documentId)` is already called by automerge-repo's
 * `CollectionSynchronizer` on every inbound sync/request message (not just at
 * connect) AND when deciding whether to proactively push a doc — see the note
 * in auth/wsAuth.ts. That makes it the natural enforcement point for refusing
 * stale-epoch connections: no separate per-message epoch check is needed,
 * `accessCheck` is already on the per-message path.
 *
 * `createSelectiveSync` takes an optional `accessCheck(peerId, docId)` used as:
 *   - stage 'off'  -> always true (no auth).
 *   - stage 'dual' -> always true, but logs (throttled) when the check WOULD
 *     have denied — telemetry without enforcement, matching the dual contract.
 *   - stage 'on'   -> the check's own verdict is authoritative: unknown peer or
 *     unindexed doc denies by default (the doc index admits it once its parent
 *     link syncs — see rbac/docScope.ts).
 * `announce` additionally intersects the core set with the peer's allowed set
 * under 'on' — a connection must not even be proactively PUSHED a doc from a
 * workspace it can't read.
 */

type ShareDecision = (peerId: string, documentId?: string) => Promise<boolean>

export interface ShareConfig {
  announce: ShareDecision
  access: ShareDecision
}

/** `(peerId, docId) -> allowed?`. Returns false for "deny" — the caller
 * (createSelectiveSync) is the one that knows whether to enforce that verdict
 * or merely log it, per the AUTH stage. */
export type AccessCheck = (peerId: string, documentId: string) => Promise<boolean>

/** Stage-aware wrapper a caller can pass as `accessCheck` — resolves the AUTH
 * stage itself so selectiveSync.ts doesn't need to import auth/middleware.ts
 * (kept here so the off/dual/on semantics live in one place with the rest of
 * this file's doc comment). `rawCheck` is the actual RBAC decision (unknown
 * peer/doc => false); `stage()` reads the live stage on every call so a stage
 * flip at runtime (tests, `AUTH` env change without restart) takes effect
 * immediately rather than being captured once at construction. */
export function stageAwareAccessCheck(
  rawCheck: AccessCheck,
  stage: () => 'off' | 'dual' | 'on'
): AccessCheck {
  let lastDualWarnAt = 0
  let lastOnWarnAt = 0
  const DUAL_WARN_THROTTLE_MS = 60_000
  const ON_DENY_WARN_THROTTLE_MS = 10_000
  return async (peerId, documentId) => {
    const s = stage()
    if (s === 'off') return true
    const allowed = await rawCheck(peerId, documentId)
    if (s === 'dual') {
      if (!allowed) {
        const now = Date.now()
        if (now - lastDualWarnAt >= DUAL_WARN_THROTTLE_MS) {
          lastDualWarnAt = now
          console.warn(
            `[selectiveSync:dual] access check would DENY peer=${peerId} doc=${documentId} (not enforced — stage=dual)`
          )
        }
      }
      return true
    }
    // stage 'on': authoritative. Denials at the sync boundary are
    // security-relevant AND the only visible trace of a doc-index gap
    // (a wrongly-quarantined doc looks like silent data loss to the client) —
    // log them, throttled.
    if (!allowed) {
      const now = Date.now()
      if (now - lastOnWarnAt >= ON_DENY_WARN_THROTTLE_MS) {
        lastOnWarnAt = now
        console.warn(`[selectiveSync] DENIED peer=${peerId} doc=${documentId} (stage=on)`)
      }
    }
    return allowed
  }
}

/** The root-doc fields that point at the documents a client needs to boot. */
interface RootLike {
  modelUrl?: string
  modelMetaUrl?: string
  shardUrls?: string[]
}

export interface SelectiveSync {
  shareConfig: ShareConfig
  /** Recompute the core doc-id set from the current root doc. Call once after the
   * root exists and on every root 'change'. */
  refresh(): void
  /** Pin one small live document in the proactive set. Owners are replaceable:
   * rotating a write-head removes the previous id without disturbing another
   * workspace that may reference the same document. */
  setPinnedCore(owner: string, documentId?: string): string | undefined
  /** The current core doc-id set (for logging/tests). */
  coreIds(): string[]
}

/**
 * Build a `shareConfig` that announces only the core boot docs (root + model +
 * meta + registry shards) and serves everything else on request. `getRoot` is a
 * late-bound getter because the repo is constructed before the root handle is
 * resolved.
 *
 * `accessCheck` (optional): layered onto BOTH gates.
 *   - `access`: `hasAccess = await accessCheck(peerId, documentId)`; when absent,
 *     the default is "never refuse" (the server always passes one since
 *     2026-10-16; at AUTH=off it is the claim-only check, which never refuses
 *     either — rbac/claimOnlyAccessCheck.ts).
 *   - `announce`: the doc must be in the core set AND pass `accessCheck` — a
 *     connection that can't access a workspace must not be proactively pushed
 *     its core docs either. `accessCheck` is expected to already be
 *     stage-aware (see `stageAwareAccessCheck` above), so stage 'off'/'dual'
 *     returning true leaves `announce` as plain core-set membership.
 */
export function createSelectiveSync(
  getRoot: () => DocHandle<unknown> | null,
  accessCheck?: AccessCheck
): SelectiveSync {
  const rootCore = new Set<string>()
  const pinnedCoreByOwner = new Map<string, string>()
  const pinnedCore = new Set<string>()

  const coreIds = (): string[] => [...new Set([
    ...rootCore,
    ...pinnedCore,
  ])]

  const hasCore = (documentId: string): boolean =>
    rootCore.has(documentId) || pinnedCore.has(documentId)

  const refresh = (): void => {
    rootCore.clear()
    const handle = getRoot()
    if (!handle) return
    rootCore.add(String(handle.documentId))
    const root = handle.doc() as RootLike | undefined
    if (!root) return
    // NOTE: deliberately NOT announcing root.modelUrl (the monolithic pre-split
    // ModelDoc — the whole ~20k-object model). Announcing it makes the server push it
    // to every client, who then waits ~40s for it to sync even though sharded /
    // boot-from-server clients never use it. Legacy monolith clients still get it on
    // demand via `access` (they explicitly find() it). Core = root + ModelMeta +
    // registry shards (the diagram list).
    const urls = [root.modelMetaUrl, ...(root.shardUrls ?? [])]
    for (const url of urls) {
      if (url && isValidAutomergeUrl(url)) rootCore.add(String(interpretAsDocumentId(url)))
    }
  }

  const setPinnedCore = (owner: string, documentId?: string): string | undefined => {
    const previousDocumentId = pinnedCoreByOwner.get(owner)
    if (documentId) pinnedCoreByOwner.set(owner, documentId)
    else pinnedCoreByOwner.delete(owner)
    pinnedCore.clear()
    for (const id of pinnedCoreByOwner.values()) pinnedCore.add(id)
    return previousDocumentId
  }

  const shareConfig: ShareConfig = {
    // Proactively share ONLY the core docs the peer is also allowed to access.
    // (docId is undefined for the peer-level call used by remote-heads gossip —
    // disabled here — so returning false is safe.)
    announce: async (peerId, documentId) => {
      if (documentId == null || !hasCore(String(documentId))) return false
      const allowed = accessCheck ? await accessCheck(peerId, String(documentId)) : true
      return allowed
    },
    // Without an access check: never refuse a document a client explicitly asks for.
    // With `accessCheck` set, defer to it (default-deny is the check's job —
    // see docScope.ts / wsAuth.ts).
    access: async (peerId, documentId) => {
      if (!accessCheck) return true
      if (documentId == null) return true // peer-level call, no doc to check
      return accessCheck(peerId, String(documentId))
    },
  }

  return { shareConfig, refresh, setPinnedCore, coreIds }
}
