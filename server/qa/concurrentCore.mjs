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

// The verdict of `qa/concurrent.mjs`, extracted so it can be executed by a test
// instead of only by an operator with a live stack.
//
// A verdict of `fieldMergeFail === 0 && scopeDiverged === 0 && modelEqual` alone
// passes a run that tested nothing: against a workspace not seeded with the
// `shared-0..N` ids, `present` is `[]`, every counter stays 0 and `modelEqual`
// compares `{}` with `{}`. So the ABSENCE of a subject is a VOID, never a pass,
// and the counters must account for the subject.

/** Grade a concurrent-editing run.
 *
 * Returns `{ outcome, failures, voids, reasons }` with the same three-valued
 * convention `evaluatePeerLoadResult` uses: `voids` are the ways the run did not
 * happen, `failures` are the ways the SYSTEM did not hold, and only the second
 * kind is a result about the server.
 */
export function evaluateConcurrentResult(result, { minObjects, minRounds = 1 } = {}) {
  const failures = []
  const voids = []

  const objectsTested = result?.objectsTested ?? 0
  const rounds = result?.rounds ?? 0
  // The floor is what the run ASKED for. A default of 1 passes a run that found
  // one of twenty seeded ids — technically not the empty set, and still not the
  // regime whose header it wears. `objectsRequested` is published by the script;
  // 1 remains the fallback for a report that predates it.
  const floor = minObjects ?? result?.objectsRequested ?? 1

  if (!Number.isInteger(objectsTested) || objectsTested < floor) {
    voids.push(
      `VOID: ${objectsTested} shared object(s) were tested, below the floor of ${floor} — ` +
      'the ids this check edits (`shared-0..N`) do not all exist in this model, so the ' +
      'assertions below describe a smaller run than the one requested',
    )
  }
  if (!Number.isInteger(rounds) || rounds < minRounds) {
    voids.push(`VOID: ${rounds} round(s) of concurrent edits, below the floor of ${minRounds} — no edit was ever made concurrent`)
  }

  // The counters must account for the subject. This is a FENCE against a future
  // edit, not a live check: the grading loop in `concurrent.mjs` has exactly one
  // `continue` — the one that grades a vanished object — and increments one of
  // each pair on every other path, so `graded === objectsTested` is a structural
  // identity today; it is kept to pin that identity.
  // No `objectsTested > 0 &&` guard on these two: `objectsTested` is
  // `present.length` and the counters only move inside the loop over `present`,
  // so zero implies zero and the floor above has already voided that case.
  const graded = (result?.fieldMergeOk ?? 0) + (result?.fieldMergeFail ?? 0)
  if (graded !== objectsTested) {
    voids.push(`VOID: ${graded} of ${objectsTested} object(s) were graded — the field-merge loop did not visit its subject`)
  }
  const scoped = (result?.scopeConverged ?? 0) + (result?.scopeDiverged ?? 0)
  if (scoped !== objectsTested) {
    voids.push(`VOID: ${scoped} of ${objectsTested} object(s) had their contested field compared`)
  }

  // Nothing this test wrote crossed the wire, so `modelEqual` is agreement about
  // a state that predates it — the same distinction the peer bench draws between
  // converged heads and a marker that actually arrived.
  //
  // The DELTA, not the count. `changeCount` is the whole root document's history,
  // in the thousands on any workspace that has objects at all, so a check on
  // the count would never fire. A report without the deltas is not graded on
  // them rather than being graded as zero.
  const deltaA = result?.changesDeltaA
  const deltaB = result?.changesDeltaB
  if (Number.isFinite(deltaA) && Number.isFinite(deltaB) && (deltaA < 1 || deltaB < 1)) {
    voids.push(`VOID: this run added ${deltaA}/${deltaB} change(s) to the two clients — at least one wrote nothing at all`)
  }

  if (result?.fieldMergeFail > 0) {
    failures.push(`field-level merge lost data on ${result.fieldMergeFail} of ${objectsTested} object(s)`)
  }
  if (result?.scopeDiverged > 0) {
    failures.push(`the contested field diverged on ${result.scopeDiverged} of ${objectsTested} object(s)`)
  }
  if (result?.modelEqual === false) {
    failures.push('the two clients did not end byte-identical')
  }
  // Absent is not false. A report that never computed `modelEqual` has not shown
  // the clients agree; reading `undefined` as "no failure" would let the empty
  // set pass.
  if (result?.modelEqual === undefined || result?.modelEqual === null) {
    voids.push('VOID: whole-model equality was never computed')
  }

  const outcome = voids.length > 0 ? 'void' : (failures.length > 0 ? 'failed' : 'passed')
  return { outcome, failures, voids, reasons: [...voids, ...failures] }
}

// The exit-code mapping is NOT restated here: it is imported, so there is one
// of it and copies cannot diverge.
export { exitCodeForOutcome, OUTCOME_EXIT_CODES } from './diagramPeersCore.mjs'
