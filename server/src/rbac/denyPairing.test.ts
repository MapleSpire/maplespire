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
 * THE SECOND ARCHITECTURAL INVARIANT OF THE SYNC AUTHORIZATION BOUNDARY
 *
 *   Every deny that a repair could reverse must be paired with an eventual
 *   `Repo.shareConfigChanged()`. Every deny that a repair could NOT reverse
 *   must not be.
 *
 * The first half stops a lagging index from silently costing a user their
 * document for the life of a socket. The second half stops the reconciliation
 * loop from running forever on behalf of a document that is correctly refused.
 * A design that only satisfies one of them is not cheaper — it is broken in the
 * other direction.
 *
 * `docScope.gateLiveness.test.ts` is the sibling of this file and holds invariant
 * (A): no authorization decision may await an Automerge document. That one can
 * be asserted over each gate builder individually, because settling is a
 * property of a single call. This one cannot: pairing is a property of a call
 * PAIR separated in time and mediated by a repo the gate builders have no handle
 * on. So the table below sits over the composed check (`documentAccess.ts`),
 * which is the same object the ledger decorates.
 *
 * Adding a new deny path? Add a row, and say which half it belongs to.
 */

import { describe, it, expect, vi } from 'vitest'
import { createDocumentAccessCheck, type DocumentAccessDeps } from './documentAccess.js'
import { createDenyLedger, type DenyLedger, type DenyReason } from './denyLedger.js'
import type { WorkspaceKey } from './docScope.js'

/** The shape `logDenied` spreads into its JSON line. */
interface ReportedDeny {
  routeFailure?: DenyReason
  peerWorkspace?: string | null
  documentWorkspace?: string | null
}

const PEER_WS: WorkspaceKey = { landscapeId: 'L-peer', versionId: 'V-peer' }
const OTHER_WS: WorkspaceKey = { landscapeId: 'L-other', versionId: 'V-other' }

interface Scenario {
  name: string
  /** What the composed check is wired to see. */
  routeAllows?: boolean
  authAllows?: boolean
  /** Where the index places the document, if anywhere. */
  documentWorkspace?: WorkspaceKey | null
  /** No route bound for this peer. */
  unrouted?: boolean
  /** Something outside the gates throws. */
  faulty?: boolean
  /** The RBAC gate failed closed on its own fault, as `gateFault` makes it. */
  authFaulted?: boolean
  expectedVerdict: boolean
  /** true  — a repair could reverse this, so it MUST be re-evaluated.
   *  false — this refusal is correct, so it must NEVER be re-evaluated. */
  mustReevaluate: boolean
  /**
   * The reason the gate REPORTS, `null` for an allowed document.
   *
   * Required, not optional. The other assertions are `onReevaluate` counts and
   * `outstanding`, and several distinct reasons share a recoverability, so a
   * row that only states those passes whether the gate classified the denial
   * correctly or not ('rbac' and 'workspace-mismatch' are both permanent).
   */
  expectedReason: DenyReason | null
  /**
   * The workspace fields on the same payload, `undefined` where the row does
   * not care.
   *
   * Asserted separately because `expectedReason` alone does not cover them:
   * a deny logged with no workspace fields would otherwise pass every row.
   */
  expectedPeerWorkspace?: string | null
  expectedDocumentWorkspace?: string | null
}

const SCENARIOS: Scenario[] = [
  // ---- must be re-evaluated -------------------------------------------------
  {
    name: 'routed socket, document not in the index yet',
    routeAllows: false,
    documentWorkspace: null,
    expectedVerdict: false,
    mustReevaluate: true,
    expectedReason: 'unindexed-document',
  },
  {
    name: 'route denied on a stale read, indexed by the time we looked again',
    routeAllows: false,
    documentWorkspace: PEER_WS,
    expectedVerdict: false,
    mustReevaluate: true,
    expectedReason: 'indexed-after-denial',
  },
  {
    // The path the route check cannot cover: with AM_WORKSPACE_ROUTING off it
    // returns !routeRequired === true without scheduling anything, and the
    // denial then comes from the RBAC gate's own unindexed-document branch.
    // That is the documented dev-stack configuration.
    name: 'unrouted socket, RBAC denies because the document is unindexed',
    routeAllows: true,
    authAllows: false,
    documentWorkspace: null,
    unrouted: true,
    expectedVerdict: false,
    mustReevaluate: true,
    expectedReason: 'unindexed-document',
  },
  {
    name: 'a gate fault (database down) must not harden into a refusal',
    faulty: true,
    expectedVerdict: false,
    mustReevaluate: true,
    expectedReason: 'gate-fault',
  },
  {
    // THE REACHABLE FAULT SHAPE. The row above throws out of `routeCheck`, but
    // production gates never throw — `gateFault` makes them fail CLOSED. What
    // actually reaches the composed check is a
    // bare `false` on a document that is still perfectly well indexed, because
    // `resolveDocWorkspace` answers it from `byDoc` in memory without touching
    // the database that just failed.
    //
    // Classified naively, that is indistinguishable from "this user has no
    // grant" — permanent — so the deny is never re-evaluated and a five-second
    // database blip costs the peer that document for the life of its socket,
    // unless the gate reports the fault out of band.
    name: 'a gate that FAILED CLOSED on an indexed document is not a grant denial',
    routeAllows: true,
    authAllows: false,
    authFaulted: true,
    documentWorkspace: PEER_WS,
    expectedVerdict: false,
    mustReevaluate: true,
    // The REPORTED reason is the derived one; the LEDGER keeps 'gate-fault',
    // which is what `recordDeny` refuses to let this evict and what makes the
    // row re-evaluable. Two different facts, and the column asserts the one an
    // operator reads.
    expectedReason: 'rbac',
  },

  // ---- must NOT be re-evaluated (the anti-vacuity half) ---------------------
  {
    name: 'document belongs to another workspace',
    routeAllows: false,
    documentWorkspace: OTHER_WS,
    expectedVerdict: false,
    mustReevaluate: false,
    expectedReason: 'workspace-mismatch',
  },
  {
    name: 'no route bound for the peer',
    routeAllows: false,
    documentWorkspace: PEER_WS,
    unrouted: true,
    expectedVerdict: false,
    mustReevaluate: false,
    expectedReason: 'missing-peer-route',
  },
  {
    name: 'indexed document, no RBAC grant',
    routeAllows: true,
    authAllows: false,
    documentWorkspace: PEER_WS,
    expectedVerdict: false,
    mustReevaluate: false,
    expectedReason: 'rbac',
  },
  {
    // The repoint shape, and the row that needs the `expectedReason` column.
    // An administrator moved the `current` alias from V1 to V2; a peer still
    // routed to V1 presents an id the index now places in V2.
    // `buildAccessCheck` refuses on `!sameWorkspace`, which is CORRECT —
    // serving it would merge V2 content into a store scoped to V1.
    //
    // 'rbac' and 'workspace-mismatch' are both permanent, so `mustReevaluate`
    // and `outstanding` are identical either way; only the reported reason and
    // workspace fields distinguish a correct classification.
    name: 'RBAC refuses a document the index places in ANOTHER workspace',
    routeAllows: true,
    authAllows: false,
    documentWorkspace: OTHER_WS,
    expectedVerdict: false,
    mustReevaluate: false,
    expectedReason: 'workspace-mismatch',
    expectedPeerWorkspace: 'L-peer/V-peer',
    expectedDocumentWorkspace: 'L-other/V-other',
  },
  {
    // The dev-stack shape: with AM_WORKSPACE_ROUTING off there is no route, so
    // `workspaceForPeer` answers null while the document IS indexed. Without
    // this row, widening the mismatch test to `!peerWorkspace || !same(…)`
    // would pass — and report `workspace-mismatch` with `peerWorkspace: null`,
    // a misleading log line.
    name: 'unrouted socket, RBAC denies an INDEXED document — not a mismatch',
    routeAllows: true,
    authAllows: false,
    documentWorkspace: PEER_WS,
    unrouted: true,
    expectedVerdict: false,
    mustReevaluate: false,
    expectedReason: 'rbac',
    expectedPeerWorkspace: null,
    expectedDocumentWorkspace: 'L-peer/V-peer',
  },
  {
    name: 'allowed document',
    routeAllows: true,
    authAllows: true,
    documentWorkspace: PEER_WS,
    expectedVerdict: true,
    mustReevaluate: false,
    expectedReason: null,
  },
]

function build(scenario: Scenario) {
  const onReevaluate = vi.fn()
  const scheduleRepair = vi.fn()
  const reported: ReportedDeny[] = []
  let tick: (() => void) | null = null
  const ledger: DenyLedger = createDenyLedger({
    onReevaluate,
    scheduleRepair,
    schedule: (fn) => { tick = fn; return { cancel: () => { tick = null } } },
  })
  const deps: DocumentAccessDeps = {
    onGateFault: (peerId, documentId, workspace) => {
      ledger.recordDeny(peerId, documentId, 'gate-fault', workspace)
    },
    routeCheck: async () => {
      if (scenario.faulty) throw new Error('remaining connection slots are reserved')
      return scenario.routeAllows ?? true
    },
    authCheck: async (peerId: string, documentId: string) => {
      if (scenario.authFaulted) {
        // Exactly what `gateFault` does: report the fault out of band, then
        // return a fail-closed verdict.
        deps.onGateFault?.(peerId, documentId, PEER_WS)
        return false
      }
      return scenario.authAllows ?? true
    },
    workspaceForPeer: () => (scenario.unrouted ? null : PEER_WS),
    resolveDocWorkspace: async () => scenario.documentWorkspace ?? null,
    ledger,
    onDenied: (_kind, _documentId, details) => {
      reported.push(details as ReportedDeny)
    },
  }
  return {
    check: createDocumentAccessCheck(deps),
    ledger,
    onReevaluate,
    /**
     * Every `onDenied` payload, in order.
     *
     * Length is 1 on every deny row and 0 on the allow row — never more:
     * `createDocumentAccessCheck` is the only caller and every branch returns
     * after it, and `onGateFault` records to the ledger without logging.
     * `at(-1)` is used because it states the intent — the composed check's
     * own verdict — not because a second entry exists.
     */
    reported,
    fire: () => { if (tick) tick() },
  }
}

describe('sync authorization boundary — deny pairing invariant', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.mustReevaluate ? 're-evaluates' : 'never re-evaluates'}: ${scenario.name}`, async () => {
      const h = build(scenario)

      const verdict = await h.check('peer-1', 'doc-1')
      expect(verdict).toBe(scenario.expectedVerdict)

      // WHICH refusal, not just whether. Several reasons share a
      // recoverability, so the assertions below cannot tell them apart and a
      // misclassified denial passes them all — see the `expectedReason` doc.
      const payload = h.reported.at(-1)
      expect(
        payload?.routeFailure ?? null,
        'the gate must say WHICH refusal this was',
      ).toBe(scenario.expectedReason)
      if (scenario.expectedPeerWorkspace !== undefined) {
        expect(payload?.peerWorkspace ?? null).toBe(scenario.expectedPeerWorkspace)
      }
      if (scenario.expectedDocumentWorkspace !== undefined) {
        expect(payload?.documentWorkspace ?? null).toBe(scenario.expectedDocumentWorkspace)
      }

      // Reconcile enough times to expose a loop that fires late as well as one
      // that never fires. Asserting on a single tick would pass a design that
      // re-evaluates once and then abandons the entry.
      h.fire()
      h.fire()

      if (scenario.mustReevaluate) {
        expect(h.onReevaluate.mock.calls.length).toBeGreaterThan(0)
        expect(h.ledger.snapshot().outstanding).toBe(1)
      } else {
        expect(h.onReevaluate).not.toHaveBeenCalled()
        expect(h.ledger.snapshot().outstanding).toBe(0)
      }
    })
  }

  it('a repaired index drains the entry instead of re-evaluating forever', async () => {
    // The whole point of the ledger: the deny is transient, and the evidence
    // that it was transient is that the ledger empties on its own.
    let indexed: WorkspaceKey | null = null
    const onReevaluate = vi.fn()
    let tick: (() => void) | null = null
    const ledger = createDenyLedger({
      onReevaluate,
      schedule: (fn) => { tick = fn; return { cancel: () => { tick = null } } },
    })
    const check = createDocumentAccessCheck({
      routeCheck: async () => indexed !== null,
      authCheck: async () => true,
      workspaceForPeer: () => PEER_WS,
      resolveDocWorkspace: async () => indexed,
      ledger,
    })

    expect(await check('peer-1', 'doc-1')).toBe(false)
    expect(ledger.snapshot().outstanding).toBe(1)

    tick!()
    expect(onReevaluate).toHaveBeenCalledTimes(1)

    // The repair lands — exactly what `shareConfigChanged()` exists to pick up.
    indexed = PEER_WS

    expect(await check('peer-1', 'doc-1')).toBe(true)
    expect(ledger.snapshot().outstanding).toBe(0)

    tick!()
    expect(onReevaluate).toHaveBeenCalledTimes(1)
  })

  it('a disconnected peer stops driving re-evaluation', async () => {
    const h = build(SCENARIOS[0]!)
    await h.check('peer-1', 'doc-1')
    h.ledger.forgetPeer('peer-1')

    h.fire()

    expect(h.onReevaluate).not.toHaveBeenCalled()
  })
})
