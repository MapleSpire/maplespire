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
 * The DECISIONS behind `/api/platform/workspace/{promote,demote,repair}-summary`,
 * as pure functions.
 *
 * They live outside `index.ts` because that file boots a server: nothing in it
 * can be unit-tested, and every one of these decisions is a security or
 * correctness verdict.
 *
 * ── WHY THESE THREE ROUTES ARE NOT LIKE THE OTHER `/api/platform/*` ──
 *
 * They do NOT use `requirePlatformAdminAtStageOn`. That gate returns TRUE for
 * every caller whenever `authStage() !== 'on'` — correct for a report, a stats
 * page or a GC sweep, and wrong here: below stage 'on' an unauthenticated
 * `curl -XPOST` could flip a workspace's BOOT CONTRACT, with no identified actor
 * for the audit entry (`req.auth` is absent at stage 'off' by construction).
 *
 * These are the only platform routes that change a boot contract, so they get
 * their own rule:
 *
 *   REPORT (`apply` absent/false)  — open below stage 'on', platform admin at
 *                                    stage 'on'. It reads and writes nothing.
 *   APPLY  (`apply: true`)         — an IDENTIFIED platform admin, at EVERY
 *                                    stage. No claims, no apply.
 *
 * At stage 'off' nothing populates `req.auth` (auth/middleware.ts returns
 * immediately), so this makes the apply half unreachable over HTTP on an
 * AUTH-less development stack — deliberately, and with a way out that is not a
 * weakening: the operator scripts (`npm run promote-summary -- --apply
 * --assume-quiesced`) run with database credentials, which IS the authority a
 * stage-'off' stack has. What the route must never be is an anonymous version
 * of the script that also has no audit trail.
 *
 * ── AND WHY `apply` MUST BE EXPLICIT ──
 *
 * A promotion names one workspace rather than sweeping a fleet, but the blast
 * radius is not the fleet — it is the contract, and it is not
 * undone by re-running: the promotion mints a write head and `demote-summary` is
 * a separate, costly decision. Every other apply-shaped platform route in this
 * server (reference-integrity/repair, and both maintenance scripts) requires the
 * word `apply`; a POST that mutates because a field was OMITTED is the one shape
 * a `curl` typo reaches by accident.
 */

import type { AuthStage } from '../auth/middleware.js'

export interface SummaryMigrationTarget {
  landscapeId: string
  versionId: string
}

/** `{landscapeId, versionId}` or null — the routes 400 on null. Never fleet-wide. */
export function summaryMigrationTarget(body: unknown): SummaryMigrationTarget | null {
  const value = (body ?? {}) as { landscapeId?: unknown; versionId?: unknown }
  const landscapeId = typeof value.landscapeId === 'string' ? value.landscapeId.trim() : ''
  const versionId = typeof value.versionId === 'string' ? value.versionId.trim() : ''
  return landscapeId && versionId ? { landscapeId, versionId } : null
}

/**
 * Does this body ask for an APPLY? Only `apply: true` does, and `dryRun: true`
 * overrides it even then (a body carrying both is a caller who does not know
 * what it wants; the safe reading of a contradiction is the one that writes
 * nothing).
 */
export function summaryMigrationApplies(body: unknown): boolean {
  const value = (body ?? {}) as { apply?: unknown; dryRun?: unknown }
  if (value.dryRun === true) return false
  return value.apply === true
}

export interface SummaryMigrationCaller {
  stage: AuthStage
  /** `req.auth?.isPlatformAdmin === true`. */
  isPlatformAdmin: boolean
  /** Whether the request carries verified claims at all (`req.auth` present). */
  authenticated: boolean
}

export type SummaryMigrationAuthorization =
  | { allowed: true }
  | { allowed: false; status: 403; error: string }

/**
 * The authorization verdict. See the module header for why it is stricter than
 * `requirePlatformAdminAtStageOn` — this is the only class of platform route
 * that changes a workspace's boot contract.
 */
export function authorizeSummaryMigration(
  caller: SummaryMigrationCaller,
  apply: boolean,
): SummaryMigrationAuthorization {
  if (caller.isPlatformAdmin) return { allowed: true }
  if (apply) {
    return {
      allowed: false,
      status: 403,
      error: caller.authenticated
        ? 'forbidden: applying a workspace boot-contract migration requires a platform admin'
        : 'forbidden: applying a workspace boot-contract migration requires an identified platform admin, '
          + `and this request carries no session (AUTH stage '${caller.stage}'). Run the operator script `
          + '(npm run promote-summary / demote-summary / repair-summary-flag -- --apply) on a stack without '
          + 'authentication, or enable AUTH and sign in as a platform admin.',
    }
  }
  // A REPORT below stage 'on' stays open, exactly like every other platform
  // read on a development stack. It writes nothing.
  if (caller.stage !== 'on') return { allowed: true }
  return { allowed: false, status: 403, error: 'forbidden' }
}

export interface SummaryMigrationOutcome {
  apply: boolean
  blockers: number
  /** Did the primitive actually apply something? */
  applied: boolean
}

/**
 * HTTP status for a finished migration call.
 *
 *   blockers > 0                → 409  (refused, and the body says why)
 *   apply && nothing applied    → 500  (see below)
 *   otherwise                   → 200
 *
 * The 500 is the one that matters. An apply that ends with zero blockers and
 * `applied: null` must not answer 200 — the shape an operator's `curl`, a
 * script's exit code and an e2e's `response.ok()` all read as "done". The
 * primitive pushes a blocker for every early return it knows about, and this
 * line is the backstop for the ones it does not. A 200 must mean the workspace
 * changed.
 */
export function summaryMigrationHttpStatus(outcome: SummaryMigrationOutcome): 200 | 409 | 500 {
  if (outcome.blockers > 0) return 409
  if (outcome.apply && !outcome.applied) return 500
  return 200
}

/**
 * The actor an audit entry is stamped with.
 *
 * The audit is never skipped for lack of `req.auth?.userId`: the runs with no
 * identified actor are the ones an operator would most want to find later.
 * Authorization requires an identified platform admin for every apply, so the
 * fallback should be unreachable; it
 * exists because "unreachable" is a claim about today's gate, and an audit trail
 * with a hole in it is worse than one with an unattributed row in it.
 *
 * A sentinel rather than NULL because `audit_log.actor_user_id` is `TEXT NOT
 * NULL`: writing null would throw inside `appendAudit` and turn a missing audit
 * row into a failed request.
 */
export const UNATTRIBUTED_ACTOR = 'system:unattributed'

export function summaryMigrationAuditActor(userId: string | undefined | null): string {
  return userId ?? UNATTRIBUTED_ACTOR
}
