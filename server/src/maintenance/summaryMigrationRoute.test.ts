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
 * The three route decisions of the summary migration: WHO may apply, WHAT
 * counts as an apply, and WHICH status a finished call answers with.
 *
 * They are tested here rather than through the routes because `index.ts` boots
 * a server — and because each has a failure a route-level smoke test would not
 * distinguish: authorization allowing everyone below stage 'on', apply being
 * the DEFAULT, and an apply that changed nothing answering 200.
 */

import { describe, it, expect } from 'vitest'
import {
  UNATTRIBUTED_ACTOR,
  authorizeSummaryMigration,
  summaryMigrationApplies,
  summaryMigrationAuditActor,
  summaryMigrationHttpStatus,
  summaryMigrationTarget,
  type SummaryMigrationCaller,
} from './summaryMigrationRoute.js'

const anonymous = (stage: SummaryMigrationCaller['stage']): SummaryMigrationCaller => ({
  stage, isPlatformAdmin: false, authenticated: false,
})
const member = (stage: SummaryMigrationCaller['stage']): SummaryMigrationCaller => ({
  stage, isPlatformAdmin: false, authenticated: true,
})
const admin = (stage: SummaryMigrationCaller['stage']): SummaryMigrationCaller => ({
  stage, isPlatformAdmin: true, authenticated: true,
})

describe('summaryMigrationApplies', () => {
  it('refuses to apply without an explicit apply flag', () => {
    // With `value.apply !== false`, a POST with no body at all — a `curl` with
    // the wrong quoting, a retried request whose payload was dropped — would
    // migrate the workspace. Every other apply-shaped surface in
    // this server (reference-integrity/repair, both maintenance scripts)
    // requires the word.
    expect(summaryMigrationApplies({})).toBe(false)
    expect(summaryMigrationApplies(undefined)).toBe(false)
    expect(summaryMigrationApplies(null)).toBe(false)
    expect(summaryMigrationApplies({ landscapeId: 'L', versionId: 'V' })).toBe(false)
    // …and the near-misses a caller might expect to work.
    expect(summaryMigrationApplies({ apply: 'true' })).toBe(false)
    expect(summaryMigrationApplies({ apply: 1 })).toBe(false)
    expect(summaryMigrationApplies({ apply: false })).toBe(false)

    expect(summaryMigrationApplies({ apply: true })).toBe(true)
  })

  it('a body asking for both an apply and a dry run writes nothing', () => {
    expect(summaryMigrationApplies({ apply: true, dryRun: true })).toBe(false)
  })
})

describe('summaryMigrationTarget', () => {
  it('requires both halves and trims them — a migration is never fleet-wide', () => {
    expect(summaryMigrationTarget({ landscapeId: ' L ', versionId: 'V' })).toEqual({ landscapeId: 'L', versionId: 'V' })
    expect(summaryMigrationTarget({ landscapeId: 'L' })).toBeNull()
    expect(summaryMigrationTarget({ versionId: 'V' })).toBeNull()
    expect(summaryMigrationTarget({ landscapeId: '   ', versionId: 'V' })).toBeNull()
    expect(summaryMigrationTarget(undefined)).toBeNull()
  })
})

describe('authorizeSummaryMigration', () => {
  it('refuses to apply when the platform admin cannot be identified — at EVERY stage', () => {
    // THE SECURITY FOLD. `requirePlatformAdminAtStageOn` returns true for
    // everyone whenever the stage is not 'on', which is right for a stats page
    // and wrong for the only routes that change a workspace's BOOT CONTRACT:
    // on a stage-off dev stack and on a stage-dual cutover stack, an
    // unauthenticated POST flipped a landscape — and the audit was skipped too,
    // because it was conditioned on `req.auth?.userId`.
    for (const stage of ['off', 'dual', 'on'] as const) {
      const verdict = authorizeSummaryMigration(anonymous(stage), true)
      expect(verdict.allowed, `anonymous apply at stage ${stage}`).toBe(false)
      expect(verdict.allowed === false && verdict.status).toBe(403)
      // The refusal must name the way FORWARD, or the operator's next move is
      // to weaken the gate.
      expect(verdict.allowed === false && verdict.error).toContain('promote-summary')
    }
    // A signed-in NON-admin is refused just as hard.
    for (const stage of ['off', 'dual', 'on'] as const) {
      expect(authorizeSummaryMigration(member(stage), true).allowed, `member apply at stage ${stage}`).toBe(false)
    }
  })

  it('an identified platform admin may apply at every stage', () => {
    // The anti-void half: without it the test above passes against a function
    // that refuses everything.
    for (const stage of ['off', 'dual', 'on'] as const) {
      expect(authorizeSummaryMigration(admin(stage), true)).toEqual({ allowed: true })
    }
  })

  it('a REPORT stays open below stage on, and needs the admin at stage on', () => {
    // The report writes nothing, and a dev stack with no auth must still be
    // able to ask "what would this do?" — that is the parity with every other
    // platform read, and the reason the fold is scoped to `apply`.
    expect(authorizeSummaryMigration(anonymous('off'), false)).toEqual({ allowed: true })
    expect(authorizeSummaryMigration(anonymous('dual'), false)).toEqual({ allowed: true })
    expect(authorizeSummaryMigration(member('dual'), false)).toEqual({ allowed: true })

    const onStage = authorizeSummaryMigration(anonymous('on'), false)
    expect(onStage.allowed).toBe(false)
    expect(onStage.allowed === false && onStage.status).toBe(403)
    expect(authorizeSummaryMigration(admin('on'), false)).toEqual({ allowed: true })
  })
})

describe('summaryMigrationHttpStatus', () => {
  it('an apply that resolved nothing answers 500 — never 200', () => {
    // THE FOLD. The primitive could return `{blockers: [], applied: null}` when
    // a control document did not resolve, and the route answered 200. An
    // operator's `curl`, a script's exit code and an e2e's `response.ok()` all
    // read that as done. A 200 must mean the workspace changed.
    expect(summaryMigrationHttpStatus({ apply: true, blockers: 0, applied: false })).toBe(500)
    // A REPORT that applied nothing is exactly what a report is.
    expect(summaryMigrationHttpStatus({ apply: false, blockers: 0, applied: false })).toBe(200)
    // Blockers win over both — the caller gets the reasons, not a 500.
    expect(summaryMigrationHttpStatus({ apply: true, blockers: 3, applied: false })).toBe(409)
    expect(summaryMigrationHttpStatus({ apply: false, blockers: 1, applied: false })).toBe(409)
    // The success.
    expect(summaryMigrationHttpStatus({ apply: true, blockers: 0, applied: true })).toBe(200)
  })
})

describe('summaryMigrationAuditActor', () => {
  it('names an unattributed actor instead of skipping the audit entry', () => {
    // Conditioning the audit on `req.auth?.userId` would leave no trace of
    // exactly the runs worth finding later. `audit_log.actor_user_id` is NOT
    // NULL, so the fallback is a
    // sentinel rather than a null: writing null would throw inside appendAudit
    // and turn a missing row into a failed request.
    expect(summaryMigrationAuditActor('user-7')).toBe('user-7')
    expect(summaryMigrationAuditActor(undefined)).toBe(UNATTRIBUTED_ACTOR)
    expect(summaryMigrationAuditActor(null)).toBe(UNATTRIBUTED_ACTOR)
    expect(UNATTRIBUTED_ACTOR.length).toBeGreaterThan(0)
  })
})
