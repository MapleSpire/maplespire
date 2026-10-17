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
 * THE ACCESS CHECK OF A SERVER THAT ENFORCES NOTHING, BUT STILL KEEPS THE BOOKS.
 *
 * With AUTH off and AM_WORKSPACE_ROUTING unset, nothing is enforced on the
 * sync path: every document is admitted to every peer. That has always been
 * so, and stays so. What this server used to skip as well was the route gate's
 * SIDE EFFECT — the claim into `automerge_document_workspace` (the minted fast
 * path) and the repair walk an unindexed document schedules. That table is
 * what `POST /api/automerge/durable-heads` acknowledges against, so without it
 * every document answered `durable:false` forever and the badge never left
 * "saving" (2026-10-16; e2e/boot/new-landscape-durable.spec.ts).
 *
 * So the route gate RUNS, and its verdict is DISCARDED:
 *
 *  - never awaited — admission latency is what it was (none), and a slow
 *    displaced-id scan cannot hold a peer's first message;
 *  - never a deny — running the gate's verdict here would put the
 *    deny-then-lift path (repair walk + deny ledger) under every unminted
 *    browser document on a stack with no AUTH_SECRET, the path that once lost
 *    13 diagrams when the mint endpoint was blocked. That is a security
 *    boundary nobody on this configuration asked for;
 *  - a rejection is logged, never thrown: it would surface as an unhandled
 *    rejection, and the admission does not depend on it.
 *
 * What keeps an unindexed browser document from staying unclaimed without a
 * deny to re-ask: the walk the gate schedules attaches change listeners to the
 * workspace's control documents, and the registry write that references the
 * new document re-walks and claims it (`WorkspaceDocIndex.trackResidency`).
 */
export function createClaimOnlyAccessCheck(
  routeCheck: (peerId: string, documentId: string) => Promise<boolean>,
  onError: (documentId: string, error: unknown) => void = (documentId, error) => {
    console.warn('[docScope] claim-only route gate failed', documentId, error)
  },
): (peerId: string, documentId: string) => Promise<boolean> {
  return async (peerId, documentId) => {
    try {
      void routeCheck(peerId, documentId).catch((error: unknown) => onError(documentId, error))
    } catch (error) {
      // A synchronous throw from an async-looking callee is still a throw.
      onError(documentId, error)
    }
    return true
  }
}

/**
 * Which access check `startAutomergeSync` installs. The polarity lives here
 * because no test boots that function: sending AUTH-off through the
 * ENFORCING branch passes every e2e (measured 2026-10-16 with a mutant — the
 * deny path only shows as a slower badge), so this is its only witness.
 */
export function accessCheckMode(
  stage: 'off' | 'dual' | 'on',
  workspaceRoutingRequired: boolean,
): 'claim-only' | 'enforcing' {
  return stage === 'off' && !workspaceRoutingRequired ? 'claim-only' : 'enforcing'
}
