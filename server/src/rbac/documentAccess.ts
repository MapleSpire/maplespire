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

/**
 * The one gate whose verdict automerge-repo CACHES.
 *
 * This is the function reached through `shareConfig.access`, and it is the only
 * authorization decision in the process that becomes sticky: the library
 * resolves it once per (document, peer) at `DocSynchronizer.#activatePeer` and
 * never asks again unless `Repo.shareConfigChanged()` runs. The write, ownership
 * and presence gates decide per message and are re-asked on the next frame, so
 * a wrong answer there costs one message; a wrong answer HERE costs the document
 * for the life of the socket.
 *
 * That asymmetry is why the composition lives in its own module rather than as a
 * closure inside `automergeServer`. Invariant (A) — never await a document —
 * is a property of a single call, so `docScope.gateLiveness.test.ts` can hold it
 * over the individual gate builders. Invariant (B) — every recoverable deny is
 * paired with an eventual re-evaluation — is a property of a call PAIR separated
 * in time, mediated by a repo none of those builders can see. It can only be
 * asserted over the composed check, so the composed check has to be something a
 * test can hold. See `denyPairing.test.ts`.
 */

import type { WorkspaceKey } from './docScope.js'
import { type DenyLedger, type DenyReason } from './denyLedger.js'

export type AccessVerdict = (peerId: string, documentId: string) => Promise<boolean>

export interface DocumentAccessDeps {
  /** Transport-level workspace isolation. Null when routing is not configured. */
  routeCheck: AccessVerdict | null
  /** RBAC, already wrapped by `stageAwareAccessCheck`. Null at stage 'off'. */
  authCheck: AccessVerdict | null
  /** Synchronous, cache-only. Awaiting anything here would break invariant (A). */
  workspaceForPeer: (peerId: string) => WorkspaceKey | null | undefined
  /** Index lookup. Resolves from PostgreSQL and process memory only — never
   * from an Automerge document (again, invariant (A)). */
  resolveDocWorkspace: (documentId: string) => Promise<WorkspaceKey | null>
  ledger: Pick<DenyLedger, 'recordDeny' | 'clear'>
  /**
   * The reporter for a gate that FAILED rather than decided. Not invoked by
   * `createDocumentAccessCheck` itself: the individual gates receive the same
   * reporter as their `onFault` and call it directly.
   *
   * A gate failing closed returns a bare `false`, which is indistinguishable
   * here from a real refusal — and on an indexed document the classification
   * below lands on 'rbac', which is permanent. So the fault has to arrive out of
   * band, before the verdict is classified. `recordDeny` then refuses to let the
   * derived 'rbac' evict it.
   */
  onGateFault?: (peerId: string, documentId: string, workspace: WorkspaceKey | null | undefined) => void
  onDenied?: (
    reason: 'workspace-route' | 'rbac' | 'gate-fault',
    documentId: string,
    details: Record<string, unknown>,
  ) => void
}

function sameWorkspace(a: WorkspaceKey, b: WorkspaceKey): boolean {
  return a.landscapeId === b.landscapeId && a.versionId === b.versionId
}

export function createDocumentAccessCheck(deps: DocumentAccessDeps): AccessVerdict {
  return async (peerId, documentId) => {
    try {
      if (deps.routeCheck && !(await deps.routeCheck(peerId, documentId))) {
        const peerWorkspace = deps.workspaceForPeer(peerId)
        // Resolved AFTER the denial, so it can disagree with what the gate saw:
        // an unindexed document schedules a repair, and if that repair lands
        // before this line runs the document is now indexed — to the peer's own
        // workspace. That case is reported as `indexed-after-denial` rather than
        // `workspace-mismatch`, whose identical workspace fields would read as a
        // tenancy bug. The denial was real; the reason was "not indexed yet".
        const documentWorkspace = await deps.resolveDocWorkspace(documentId)
        const reason: DenyReason = !peerWorkspace
          ? 'missing-peer-route'
          : !documentWorkspace
            ? 'unindexed-document'
            : sameWorkspace(peerWorkspace, documentWorkspace)
              ? 'indexed-after-denial'
              : 'workspace-mismatch'
        deps.ledger.recordDeny(peerId, documentId, reason, peerWorkspace ?? documentWorkspace)
        deps.onDenied?.('workspace-route', documentId, {
          routeFailure: reason,
          peerWorkspace: peerWorkspace ? `${peerWorkspace.landscapeId}/${peerWorkspace.versionId}` : null,
          documentWorkspace: documentWorkspace
            ? `${documentWorkspace.landscapeId}/${documentWorkspace.versionId}`
            : null,
        })
        return false
      }

      if (deps.authCheck && !(await deps.authCheck(peerId, documentId))) {
        // An RBAC denial is usually permanent — a grant change bumps the session
        // epoch, which forces a reconnect and a fresh resolution anyway. But
        // `buildAccessCheck` also denies an unindexed document, and THAT is
        // recoverable and schedules nothing of its own. One index lookup on the
        // deny path is what tells the two apart; without it the recoverable case
        // hides inside the permanent one and never gets re-evaluated.
        // The peer's route is read BEFORE the await: a peer that disconnects
        // during the index lookup loses its route, and reading it afterwards
        // would degrade the classification from `workspace-mismatch` to `rbac`.
        const peerWorkspace = deps.workspaceForPeer(peerId)
        const documentWorkspace = await deps.resolveDocWorkspace(documentId)
        // Three outcomes, not two. `buildAccessCheck` refuses on `!sameWorkspace`
        // as well as on a missing grant — e.g. a peer still routed to the OLD
        // default version after the alias was repointed presents an id the index
        // now places in the new one. That refusal is correct (serving it would
        // merge one version's content into a store scoped to another), but
        // logging it as `rbac` would send the reader to the grant tables. Both
        // are permanent; only the logged reason differs.
        const reason: DenyReason = !documentWorkspace
          ? 'unindexed-document'
          : peerWorkspace && !sameWorkspace(peerWorkspace, documentWorkspace)
            ? 'workspace-mismatch'
            : 'rbac'
        deps.ledger.recordDeny(peerId, documentId, reason, peerWorkspace ?? documentWorkspace)
        deps.onDenied?.('rbac', documentId, {
          routeFailure: reason,
          peerWorkspace: peerWorkspace ? `${peerWorkspace.landscapeId}/${peerWorkspace.versionId}` : null,
          documentWorkspace: documentWorkspace
            ? `${documentWorkspace.landscapeId}/${documentWorkspace.versionId}`
            : null,
        })
        return false
      }

      deps.ledger.clear(peerId, documentId)
      return true
    } catch (error) {
      // The individual gates already fail closed on their own faults; reaching
      // here means something outside them threw — the post-denial index lookup
      // above, most plausibly. Deny, but record it as recoverable: a fault says
      // nothing about the peer's rights and must not harden into a refusal.
      const peerWorkspace = deps.workspaceForPeer(peerId)
      deps.ledger.recordDeny(peerId, documentId, 'gate-fault', peerWorkspace)
      // `routeFailure` on every deny payload, this one included, so a fault can
      // be told apart from a refusal in the log.
      deps.onDenied?.('gate-fault', documentId, {
        routeFailure: 'gate-fault' satisfies DenyReason,
        peerWorkspace: peerWorkspace ? `${peerWorkspace.landscapeId}/${peerWorkspace.versionId}` : null,
        error: String(error),
      })
      return false
    }
  }
}
