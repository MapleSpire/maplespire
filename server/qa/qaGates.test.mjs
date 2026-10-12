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

// Verdict tests for two `qa/` gates: `concurrent.mjs` and
// `eviction-peeraware.mjs`.
//
// Both are live scripts needing a server, a database and short eviction timers,
// so their verdicts are extracted as pure functions and executed here. A verdict
// nothing executes drifts into a tautology (grading an empty set as a pass, or
// reading a `DocHandle.state` the library cannot vary).
//
// Every case below is written from the side that MATTERS: not "does the gate
// pass a healthy run" but "is there an input on which it says no". A gate with
// no such input is the defect, whatever it prints.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateConcurrentResult,
  exitCodeForOutcome as concurrentExitCode,
  OUTCOME_EXIT_CODES as concurrentExitCodes,
} from './concurrentCore.mjs'
import {
  evaluatePeerAwareEviction,
  peerAwareReport,
  peerAwareTableInvariants,
  peerAwareOrderInvariance,
  peerAwareContext,
  rankOutcome,
  PEER_AWARE_CHECKS,
  exitCodeForOutcome as evictionExitCode,
} from './evictionPeerAwareCore.mjs'
import { evaluateFireDrill } from './evictionFireDrillCore.mjs'
import { exitCodeForOutcome, OUTCOME_EXIT_CODES } from './diagramPeersCore.mjs'

// A run that genuinely held: 20 objects requested, 20 found, every one graded
// and agreeing. `changesA/B` are the ROOT document's whole history — thousands
// on any real workspace — and `changesDeltaA/B` are what this run added. Only
// the deltas are graded; see `concurrentCore.mjs`.
const healthyConcurrent = {
  objectsTested: 20,
  objectsRequested: 20,
  rounds: 5,
  fieldMergeOk: 20,
  fieldMergeFail: 0,
  scopeConverged: 20,
  scopeDiverged: 0,
  modelEqual: true,
  changesA: 4210,
  changesB: 4210,
  changesDeltaA: 100,
  changesDeltaB: 100,
}

test('evaluateConcurrentResult passes a run that really tested something', () => {
  const result = evaluateConcurrentResult(healthyConcurrent)
  assert.equal(result.outcome, 'passed')
  assert.deepEqual(result.reasons, [])
})

test('evaluateConcurrentResult VOIDs the empty set that used to report clean', () => {
  // `shared-0..N` absent from the model, so `present` is `[]`, the edit loops
  // are no-ops and every counter stays 0. `modelEqual` compares {} with {} and
  // is true, so `fieldMergeFail === 0 && scopeDiverged === 0 && modelEqual`
  // alone would pass this run.
  const empty = {
    objectsTested: 0,
    objectsRequested: 20,
    rounds: 5,
    fieldMergeOk: 0,
    fieldMergeFail: 0,
    scopeConverged: 0,
    scopeDiverged: 0,
    modelEqual: true,
    changesA: 4210,
    changesB: 4210,
    changesDeltaA: 0,
    changesDeltaB: 0,
  }
  assert.equal(
    empty.fieldMergeFail === 0 && empty.scopeDiverged === 0 && empty.modelEqual,
    true,
    'the superseded verdict must still be true of this fixture, or the case is not the defect',
  )
  const result = evaluateConcurrentResult(empty)
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /below the floor/)
  assert.equal(result.failures.length, 0, 'an untested subject is an absent result, not a system failure')
})

test('evaluateConcurrentResult still reports a real merge failure as FAILED, not void', () => {
  // The distinction the whole three-valued convention exists for: this run
  // happened and the system did not hold.
  const result = evaluateConcurrentResult({ ...healthyConcurrent, fieldMergeOk: 17, fieldMergeFail: 3 })
  assert.equal(result.outcome, 'failed')
  assert.match(result.failures.join(' '), /field-level merge lost data on 3/)
})

test('evaluateConcurrentResult reports divergence and non-identical models', () => {
  const diverged = evaluateConcurrentResult({ ...healthyConcurrent, scopeConverged: 18, scopeDiverged: 2 })
  assert.equal(diverged.outcome, 'failed')
  assert.match(diverged.failures.join(' '), /contested field diverged on 2/)

  const unequal = evaluateConcurrentResult({ ...healthyConcurrent, modelEqual: false })
  assert.equal(unequal.outcome, 'failed')
  assert.match(unequal.failures.join(' '), /byte-identical/)
})

test('evaluateConcurrentResult VOIDs a loop that skipped part of its subject', () => {
  // `continue` on a missing object leaves the counters short of `objectsTested`,
  // and "no failures" is true of the objects that were never looked at.
  const result = evaluateConcurrentResult({ ...healthyConcurrent, fieldMergeOk: 12, fieldMergeFail: 0 })
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /12 of 20 object\(s\) were graded/)
})

test('evaluateConcurrentResult VOIDs when this run added no change of its own', () => {
  // Agreement about a state that predates the test. The peer bench draws the
  // same line between converged heads and a marker that actually arrived.
  const result = evaluateConcurrentResult({ ...healthyConcurrent, changesDeltaA: 0 })
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /wrote nothing at all/)

  // The DELTA, not the count. `changeCount` is
  // `A.getAllChanges(handle.doc()).length` over the ROOT document, which is in
  // the thousands on any workspace with objects, so a `changesA === 0` guard
  // would be constant-false: a healthy-looking absolute count sitting on top of
  // a run that wrote nothing.
  const wroteNothing = { ...healthyConcurrent, changesA: 4210, changesB: 4210, changesDeltaA: 0, changesDeltaB: 0 }
  assert.equal(wroteNothing.changesA === 0 || wroteNothing.changesB === 0, false, 'the superseded guard must be false here, or the case is not the defect')
  assert.equal(evaluateConcurrentResult(wroteNothing).outcome, 'void')
})

test('evaluateConcurrentResult takes its floor from what the run REQUESTED', () => {
  // 1 of 20 seeded ids is not the empty set and is still not the regime the
  // report's header claims. `objectsTested` alone cannot express the shortfall.
  const short = { ...healthyConcurrent, objectsTested: 1, fieldMergeOk: 1, scopeConverged: 1 }
  const result = evaluateConcurrentResult(short)
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /below the floor of 20/)

  // A report predating `objectsRequested` falls back to 1 rather than voiding
  // every historical run — the permissive direction, taken deliberately because
  // the alternative rewrites verdicts for runs nobody can re-execute.
  const { objectsRequested, ...legacy } = short
  assert.equal(objectsRequested, 20)
  assert.equal(evaluateConcurrentResult(legacy).outcome, 'passed')

  // …and the fallback is 1, not 0: a LEGACY report of the empty set must still
  // void, or every stored report predating the field grades an empty run.
  //
  // The MESSAGE is asserted, not just the outcome. With the fallback at 0 this
  // fixture is still `void` — through the delta guard — so an outcome-only
  // assertion would be satisfied by a conjunct that is not the one under test.
  // That is why this fixture keeps healthy deltas.
  const legacyEmpty = { ...legacy, objectsTested: 0, fieldMergeOk: 0, scopeConverged: 0 }
  const legacyVerdict = evaluateConcurrentResult(legacyEmpty)
  assert.equal(legacyVerdict.outcome, 'void')
  assert.match(legacyVerdict.voids.join(' '), /below the floor of 1/)

  // The boundary, both sides. The case above compares 1 against 20, so an
  // off-by-one in the floor is invisible to it.
  const found = (n) => evaluateConcurrentResult({ ...healthyConcurrent, objectsTested: n, fieldMergeOk: n, scopeConverged: n })
  assert.match(found(19).voids.join(' '), /below the floor of 20/, '19 of 20 is short')
  assert.equal(found(20).outcome, 'passed', '20 of 20 is the run that was asked for')

  // An ABSENT count is the empty set, not one object (pins `?? 0` against
  // `?? 1`).
  const { objectsTested, ...noCount } = { ...healthyConcurrent, fieldMergeOk: 0, scopeConverged: 0 }
  assert.equal(objectsTested, 20)
  assert.match(evaluateConcurrentResult(noCount).voids.join(' '), /0 shared object\(s\) were tested/)
})

test('evaluateConcurrentResult keeps VOID above FAILED, and still reports the failure', () => {
  // The precedence line is the module's whole three-valued contract, so this
  // fixture carries a void and a failure at once. A run that tested nothing AND
  // disagreed is an absent result: the disagreement is about a state nobody
  // established.
  const both = { ...healthyConcurrent, objectsTested: 0, fieldMergeOk: 0, scopeConverged: 0, changesDeltaA: 0, changesDeltaB: 0, modelEqual: false }
  const result = evaluateConcurrentResult(both)
  assert.ok(result.voids.length > 0 && result.failures.length > 0, 'the fixture must carry BOTH, or it cannot see the precedence')
  assert.equal(result.outcome, 'void')
  // The failure is not discarded — it is listed, just not the verdict. Losing
  // it would be the instrument suppressing a finding about the system.
  assert.match(result.reasons.join(' '), /byte-identical/)
})

test('evaluateConcurrentResult enters the branches no other case reaches', () => {
  // Four branches no other fixture enters, one line each.
  const zeroRounds = evaluateConcurrentResult({ ...healthyConcurrent, rounds: 0 })
  assert.equal(zeroRounds.outcome, 'void')
  assert.match(zeroRounds.voids.join(' '), /0 round\(s\)/)

  // The contested-field accounting, separately from the field-merge accounting:
  // they are two counters and a mutant can drop either.
  const shortScope = evaluateConcurrentResult({ ...healthyConcurrent, scopeConverged: 12, scopeDiverged: 0 })
  assert.equal(shortScope.outcome, 'void')
  assert.match(shortScope.voids.join(' '), /12 of 20 object\(s\) had their contested field compared/)

  // The B side of the delta void, mirroring the A case — a mutant that drops
  // one conjunct of `deltaA < 1 || deltaB < 1` is invisible to a single side.
  assert.equal(evaluateConcurrentResult({ ...healthyConcurrent, changesDeltaB: 0 }).outcome, 'void')

  // A report with NO deltas is not graded on them (pins the `isFinite` guards).
  const { changesDeltaA, changesDeltaB, ...noDeltas } = healthyConcurrent
  assert.equal(changesDeltaA + changesDeltaB, 200)
  assert.equal(evaluateConcurrentResult(noDeltas).outcome, 'passed')

  // `null`, not `undefined`, is the realistic absent shape: these reports are
  // JSON, and re-grading a stored one is now a supported path.
  assert.equal(evaluateConcurrentResult({ ...healthyConcurrent, modelEqual: null }).outcome, 'void')

  // A non-integer count is not a small count — and the FLOOR void is the one
  // that must fire. The message is asserted because the accounting fence would
  // also produce `void` without the integer guard.
  assert.match(
    evaluateConcurrentResult({ ...healthyConcurrent, objectsTested: 20.5 }).voids.join(' '),
    /20\.5 shared object\(s\) were tested, below the floor/,
  )
})

test('evaluateConcurrentResult treats an ABSENT modelEqual as unmeasured, not as agreement', () => {
  const result = evaluateConcurrentResult({ ...healthyConcurrent, modelEqual: undefined })
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /never computed/)
})

// ── eviction-peeraware ──

// One process, unless a case deliberately says otherwise. Every counter these
// snapshots carry is cumulative, so a delta across them only means anything
// within a single process — see `processIdentity.ts`.
const BOOT = 'boot-0000-1111-2222'
const residency = (evictedDocuments, evictionSkippedActivePeer = 0, processBootId = BOOT) =>
  ({ evictedDocuments, evictionSkippedActivePeer, processBootId })

// `totalPeerBindings` defaults to `documentsWithPeers` because the scenario the
// gate runs is one client holding each document: the two witnesses coincide
// there, and a case that wants them to disagree says so. `joinedConnections`
// defaults to 1 because that IS the scenario — both peer witnesses are levels,
// so a second client makes them net and neither can be read.
const stats = (documentsWithPeers, retired = 0, overrides = {}) => ({
  // The stats body carries the boot id too: the VERDICT turns on these
  // `synchronizer.*` numbers, so fencing only the residency pair left the gap
  // between the second residency probe and the second stats probe unfenced.
  processBootId: overrides.processBootId ?? BOOT,
  joinedConnections: overrides.joinedConnections ?? 1,
  synchronizer: {
    documentsWithPeers,
    totalPeerBindings: overrides.totalPeerBindings ?? documentsWithPeers,
    retiredDocuments: { count: retired },
  },
})

// The HEALTHY shape: the orphan has no peer once client A leaves, so evicting
// it — the correct outcome — moves `evictedDocuments` and leaves
// `documentsWithPeers` alone.
// The client held the same two documents (root + viewed) throughout — the
// second half of the netting precondition, since one client opening a document
// nets exactly against a wrongly-evicted one. Shared so a case that wants the
// set to MOVE says so, rather than every case restating that it did not.
const HELD_THROUGHOUT = {
  clientDocumentsBefore: ['doc-root', 'doc-viewed'],
  clientDocumentsAfter: ['doc-root', 'doc-viewed'],
}

const healthySweep = {
  before: residency(4),
  after: residency(5),
  statsBefore: stats(2),
  statsAfter: stats(2),
  serverAlive: true,
  ...HELD_THROUGHOUT,
}

test('evaluatePeerAwareEviction passes the real healthy shape: the orphan goes, the held bindings stay', () => {
  const result = evaluatePeerAwareEviction(healthySweep)
  assert.equal(result.outcome, 'passed')
  assert.equal(result.evicted, 1)
  assert.equal(result.peerBoundDelta, 0)
  // This counter reads ZERO on a healthy run, because the idle sweep
  // short-circuits before `evict()` can increment it. Grading on it would make
  // a correct server report `failed`; it is published only.
  assert.equal(result.spared, 0)
})

test('evaluatePeerAwareEviction FAILS when a held document loses its peer binding', () => {
  // The case the check exists for and the one it could not report: the sweep
  // took a document a connected client was holding, so its DocSynchronizer was
  // deleted by `removeFromCache` and the peer-bound count fell. A verdict on
  // handle state (`viewed.state === 'ready' && root.state === 'ready' && after <
  // before`) would pass this MORE readily than a healthy run.
  const result = evaluatePeerAwareEviction({
    ...healthySweep,
    after: residency(7),
    statsAfter: stats(1),
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.failures.join(' '), /1 document\(s\) that a connected client was holding lost their peer binding/)
})

test('evaluatePeerAwareEviction VOIDs a run in which no sweep happened', () => {
  // Nothing evicted means no eviction pass is being observed, so "nothing was
  // wrongly evicted" is the empty set again. The orphan exists to make this
  // distinguishable, and its absence is a void rather than a pass.
  const result = evaluatePeerAwareEviction({ ...healthySweep, after: residency(4) })
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /evicted 0 document\(s\)/)
  assert.equal(result.failures.length, 0)
})

test('evaluatePeerAwareEviction VOIDs when synchronizer RETIREMENT could explain the drop', () => {
  // The control. Retirement deletes a DocSynchronizer too, so a peer-binding
  // drop during a window in which it fired is not evidence about eviction — and
  // a check that could not tell them apart would blame the wrong subsystem.
  const result = evaluatePeerAwareEviction({
    ...healthySweep,
    after: residency(7),
    statsBefore: stats(2, 0),
    statsAfter: stats(1, 1),
  })
  assert.equal(result.outcome, 'void')
  assert.match(result.voids.join(' '), /retired 1 document\(s\)/)
})

test('evaluatePeerAwareEviction reads a MISSING counter as unknown, never as zero', () => {
  // Nulls, never zeros, when a count could not be taken. A snapshot
  // from a server too old to publish these fields must not be graded as a sweep
  // that evicted nothing — that would be a confident wrong answer.
  const noPeerCount = evaluatePeerAwareEviction({ ...healthySweep, statsAfter: { synchronizer: {} } })
  assert.equal(noPeerCount.outcome, 'void')
  assert.match(noPeerCount.voids.join(' '), /documentsWithPeers` was not published/)

  const noEvicted = evaluatePeerAwareEviction({ ...healthySweep, after: {} })
  assert.equal(noEvicted.outcome, 'void')
  assert.match(noEvicted.voids.join(' '), /evictedDocuments` was not published/)
})

test('evaluatePeerAwareEviction FAILS a dead server even when the counters are nonsense', () => {
  // A CRASH must be `failed`, not `void`: health is graded before the deltas,
  // because `voids` outrank `failures` and a crash also produces void-looking
  // deltas. Realistic crash shapes are used — a restart (counters reset, so a
  // NEGATIVE delta) or a wedge (no movement at all) — never a dead server with
  // a healthy delta, which no crash produces.
  const restarted = evaluatePeerAwareEviction({
    before: residency(8), after: residency(0), statsBefore: stats(2), statsAfter: stats(0), serverAlive: false,
  })
  assert.equal(restarted.outcome, 'failed', 'a crashed server is a FAILURE, not an absent run')
  assert.match(restarted.failures.join(' '), /not healthy/)

  const wedged = evaluatePeerAwareEviction({
    before: residency(4), after: residency(4), statsBefore: stats(2), statsAfter: stats(2), serverAlive: false,
  })
  assert.equal(wedged.outcome, 'failed')

  // `serverAlive: undefined` is what an unreachable server produces once the
  // script catches its own probe failure. It must not be read as healthy.
  assert.equal(evaluatePeerAwareEviction({ ...healthySweep, serverAlive: undefined }).outcome, 'failed')
})

test('evaluatePeerAwareEviction VOIDs a missing snapshot — each of the FOUR, not just one', () => {
  // Looped rather than spot-checked: the guard is a four-way `||`, and a mutant
  // dropping any one operand is invisible to a case that only omits another.
  for (const key of ['before', 'after', 'statsBefore', 'statsAfter']) {
    const result = evaluatePeerAwareEviction({ ...healthySweep, [key]: null })
    assert.equal(result.outcome, 'void', `omitting ${key} must void`)
    assert.match(result.voids.join(' '), /snapshot is missing/)
    // And nothing downstream is graded, so the reader is not handed a delta
    // computed from a snapshot that was not there.
    assert.equal(result.evicted, null)
    assert.equal(result.peerBoundDelta, null)
  }
})

test('evaluatePeerAwareEviction needs BOTH sides of a delta, not just the far one', () => {
  // An asymmetric snapshot — only `after` publishes the counter — is what a
  // mid-run server upgrade produces. Reading it as a delta from zero would
  // invent a number; `Number.isFinite` on both ends is what stops that.
  const nearMissing = evaluatePeerAwareEviction({ ...healthySweep, before: { evictionSkippedActivePeer: 0 } })
  assert.equal(nearMissing.outcome, 'void')
  assert.match(nearMissing.voids.join(' '), /evictedDocuments` was not published/)

  const nearPeersMissing = evaluatePeerAwareEviction({ ...healthySweep, statsBefore: { synchronizer: {} } })
  assert.equal(nearPeersMissing.outcome, 'void')
  assert.match(nearPeersMissing.voids.join(' '), /documentsWithPeers` was not published/)
})

test('the superseded eviction witnesses are constants, which is why they are gone', () => {
  // WHAT THIS IS AND IS NOT. `OLD_VERDICT` is a local lambda: the asserts
  // against it are self-referential and prove nothing about production code.
  // They are executable DOCUMENTATION of why a handle-state verdict cannot
  // fail; they are not coverage — the two live lines at the end are.
  //
  // `DocHandle.state` is `deleted` or `ready` and nothing else in 2.6.0-alpha.2,
  // so a verdict reading it for "was this evicted" asks a question the value
  // cannot answer.
  const OLD_VERDICT = (viewedState, rootState, before, after, serverAlive) =>
    serverAlive && viewedState === 'ready' && rootState === 'ready' && after < before

  // A sweep that evicted BOTH held documents — the outcome the check exists to
  // forbid — with the handles reading what a real client's handles read.
  assert.equal(OLD_VERDICT('ready', 'ready', 3, 1, true), true, 'the old verdict passed the very outcome it forbade')
  // …and the more indiscriminate the sweep, the more true it became: the only
  // varying term was `after < before`.
  assert.equal(OLD_VERDICT('ready', 'ready', 3, 0, true), true)
  // The one input that could have falsified it is a state the library does not
  // produce for a live handle, which is what made the conjunct decoration.
  assert.equal(OLD_VERDICT('deleted', 'ready', 3, 1, true), false)

  // The replacement separates the two: the same number of evictions, opposite
  // verdicts, decided by whether anything a connected client held lost its
  // binding — which is a level the server publishes and the sweep can move.
  const sweptTwo = { before: residency(0), after: residency(2), statsBefore: stats(2), serverAlive: true, ...HELD_THROUGHOUT }
  assert.equal(evaluatePeerAwareEviction({ ...sweptTwo, statsAfter: stats(1) }).outcome, 'failed')
  assert.equal(evaluatePeerAwareEviction({ ...sweptTwo, statsAfter: stats(2) }).outcome, 'passed')
})

// ── process identity and client-count preconditions ──

test('evaluatePeerAwareEviction FAILS a window the server RESTARTED inside', () => {
  // A FAILURE, not a void. Classify by origin: "the server did not identify
  // itself" is about the instrument, but "this is a DIFFERENT PROCESS" is about
  // the subject — it died and a supervisor brought it back. Both committed
  // compose files run the app under `restart: always`/`unless-stopped`, so the
  // crash this gate exists to catch presents exactly this way: the server dies,
  // the supervisor restarts it inside the window, `/api/health` answers `ok` by
  // the time the `after` probe runs, and the boot-id change is the ONLY
  // surviving evidence. Filing it as "this run did not happen" reports nothing.
  const restartedWithPlausibleNumbers = evaluatePeerAwareEviction({
    // Both readings are individually healthy-looking: one eviction, no binding
    // lost. Only the identity says they came from two servers.
    before: residency(4, 0, 'boot-A'),
    after: residency(5, 0, 'boot-B'),
    statsBefore: stats(2, 0, { processBootId: 'boot-A' }),
    statsAfter: stats(2, 0, { processBootId: 'boot-B' }),
    serverAlive: true,
  })
  assert.equal(restartedWithPlausibleNumbers.outcome, 'failed')
  assert.match(restartedWithPlausibleNumbers.failures.join(' '), /RESTARTED during the window/)
  // And the report must not name a process that produced only half of it.
  assert.equal(restartedWithPlausibleNumbers.bootId, null)
  // Nothing downstream may be published either: every number is a subtraction
  // across two processes.
  assert.equal(restartedWithPlausibleNumbers.evicted, null)
  assert.equal(restartedWithPlausibleNumbers.peerBoundDelta, null)

  // THE RANKING TRAP. A restart
  // zeroes the counters, so `evicted` comes out NEGATIVE and trips the `< 1`
  // void — and a void outranks a failure, so merely pushing the failure would
  // have flipped the verdict straight back to "this run did not happen".
  const restartedWithResetCounters = evaluatePeerAwareEviction({
    before: residency(800, 0, 'boot-A'),
    after: residency(1, 0, 'boot-B'),
    statsBefore: stats(2, 0, { processBootId: 'boot-A' }),
    statsAfter: stats(0, 0, { processBootId: 'boot-B' }),
    serverAlive: true,
  })
  assert.equal(restartedWithResetCounters.outcome, 'failed', 'a void must not outrank the restart failure')
  assert.equal(restartedWithResetCounters.voids.length, 0, 'nothing downstream may be graded across a restart')

  // Without the identity check this run is indistinguishable from a pass, which
  // is the whole point — pinned so a mutant removing the comparison is killed
  // by a case that says WHY rather than by an outcome that could shift for any
  // of six other reasons.
  const sameProcess = evaluatePeerAwareEviction({
    before: residency(4, 0, 'boot-A'),
    after: residency(5, 0, 'boot-A'),
    statsBefore: stats(2, 0, { processBootId: 'boot-A' }),
    statsAfter: stats(2, 0, { processBootId: 'boot-A' }),
    serverAlive: true,
    ...HELD_THROUGHOUT,
  })
  assert.equal(sameProcess.outcome, 'passed')
  assert.equal(sameProcess.bootId, 'boot-A')
})

test('evaluatePeerAwareEviction VOIDs when the server cannot IDENTIFY itself', () => {
  // Absence is not agreement. A server too old to publish `processBootId` is one
  // whose run cannot be established as a single run — a count which could not
  // be taken is null and never zero, applied to identity.
  // All FOUR snapshots, looped. The verdict turns on the STATS numbers, so
  // fencing only the residency pair would leave the gap between the second
  // residency probe and the second stats probe unfenced — and
  // `documentsWithPeers` resetting to 0 there reads as a peer-binding drop,
  // i.e. a `failed` verdict blaming the sweep for a crash.
  const healthy = { before: residency(4), after: residency(5), statsBefore: stats(2), statsAfter: stats(2), serverAlive: true, ...HELD_THROUGHOUT }
  for (const key of ['before', 'after', 'statsBefore', 'statsAfter']) {
    const result = evaluatePeerAwareEviction({
      ...healthy,
      [key]: { ...healthy[key], processBootId: undefined },
    })
    assert.equal(result.outcome, 'void', `omitting ${key}.processBootId must void`)
    assert.match(result.voids.join(' '), /did not publish `processBootId`/)
    assert.equal(result.bootId, null)
  }

  // …and a MISMATCH on each of the four, not just on the residency pair.
  for (const key of ['after', 'statsBefore', 'statsAfter']) {
    const result = evaluatePeerAwareEviction({
      ...healthy,
      [key]: { ...healthy[key], processBootId: 'a-different-process' },
    })
    assert.equal(result.outcome, 'failed', `a boot-id mismatch on ${key} must fail`)
    assert.match(result.failures.join(' '), /RESTARTED during the window/)
  }

  // A non-string is not an identity either: `processBootId: 0` from a mangled
  // proxy must not compare equal to itself into a pass.
  const numeric = evaluatePeerAwareEviction({
    before: residency(4, 0, 0), after: residency(5, 0, 0), statsBefore: stats(2), statsAfter: stats(2), serverAlive: true,
  })
  assert.equal(numeric.outcome, 'void')
  assert.match(numeric.voids.join(' '), /did not publish `processBootId`/)
})

test('evaluatePeerAwareEviction VOIDs unless EXACTLY ONE client was connected', () => {
  // The netting residual, made executable. `documentsWithPeers` and
  // `totalPeerBindings` are LEVELS: a document wrongly evicted while a peer
  // arrives elsewhere sums to zero. One connected client is what makes either
  // readable, and it is a fact the server publishes rather than one this file
  // may assume.
  const base = { before: residency(4), after: residency(5), serverAlive: true, ...HELD_THROUGHOUT }

  // A browser tab left open on the port is the everyday way this happens; it
  // reconnects the instant the port rebinds.
  const twoAtOpen = evaluatePeerAwareEviction({
    ...base, statsBefore: stats(2, 0, { joinedConnections: 2 }), statsAfter: stats(2),
  })
  assert.equal(twoAtOpen.outcome, 'void')
  assert.match(twoAtOpen.voids.join(' '), /when the window opened, not exactly 1/)
  // …and it must NOT be reported as the server dropping our client. With two
  // connected at the start, a fall to one is just as likely to be the FOREIGN
  // client leaving.
  assert.equal(twoAtOpen.failures.length, 0, 'an unclean opening cannot be attributed to the server')

  // And the far edge, separately: a client ARRIVING mid-window is what makes
  // the netting possible, and a loop over one end only would miss it.
  const twoAtClose = evaluatePeerAwareEviction({
    ...base, statsBefore: stats(2), statsAfter: stats(2, 0, { joinedConnections: 2 }),
  })
  assert.equal(twoAtClose.outcome, 'void')
  assert.match(twoAtClose.voids.join(' '), /a client arrived during the window/)

  // A DROP is a different fact and it is a FAILURE, not a void — though the
  // two are identical in the count alone. The script holds its client open
  // until after the verdict, so a fall in the count means the SERVER
  // disconnected a live client, a plausible consequence of the very defect
  // under test: an eviction that takes the socket with it lowers this AND the
  // peer witnesses together.
  const dropped = evaluatePeerAwareEviction({
    ...base, statsBefore: stats(2), statsAfter: stats(0, 0, { joinedConnections: 0 }),
  })
  assert.equal(dropped.outcome, 'failed')
  assert.match(dropped.failures.join(' '), /DISCONNECTED a client this run was holding open/)

  const unpublished = evaluatePeerAwareEviction({
    ...base, statsBefore: { synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2 } }, statsAfter: stats(2),
  })
  assert.equal(unpublished.outcome, 'void')
  assert.match(unpublished.voids.join(' '), /`joinedConnections` was not published/)
})

test('evaluatePeerAwareEviction grades totalPeerBindings as a REDUNDANCY check, not a second opinion', () => {
  // NOT an independent witness. `totalPeerBindings` and `documentsWithPeers`
  // are reductions of the same array in `lightweightSynchronizerPeerSnapshot`,
  // and the one-client precondition forces every element into {0,1}, making
  // them arithmetically identical on every run the gate grades. Fixtures must
  // not set them apart in a shape the server cannot produce.
  //
  // What remains is a redundancy check between `filter` and `reduce`. It is
  // graded rather than merely published so a disagreement between the two
  // cannot pass silently.
  const base = { before: residency(4), after: residency(5), serverAlive: true, ...HELD_THROUGHOUT }

  // The shape the server DOES produce: one client, one peer per document, both
  // reductions moving together.
  const bothMove = evaluatePeerAwareEviction({
    ...base, statsBefore: stats(2), statsAfter: stats(1),
  })
  assert.equal(bothMove.outcome, 'failed')
  assert.equal(bothMove.peerBoundDelta, -1)
  assert.equal(bothMove.peerBindingDelta, -1, 'under one client the two are equal by construction')

  // A binding GAINED is not a defect — a client opening a second document is
  // ordinary. Only the losing direction is graded.
  const gained = evaluatePeerAwareEviction({
    ...base,
    statsBefore: stats(2, 0, { totalPeerBindings: 2 }),
    statsAfter: stats(2, 0, { totalPeerBindings: 4 }),
  })
  assert.equal(gained.outcome, 'passed')

  // The redundancy check earning its place: if the two reductions ever
  // DISAGREE, that is a defect in the telemetry rather than in the sweep, and
  // it must not pass silently just because the level held still.
  const reductionsDisagree = evaluatePeerAwareEviction({
    ...base,
    statsBefore: stats(2, 0, { totalPeerBindings: 2 }),
    statsAfter: stats(2, 0, { totalPeerBindings: 1 }),
  })
  assert.equal(reductionsDisagree.outcome, 'failed')
  assert.match(reductionsDisagree.failures.join(' '), /1 peer binding\(s\) were lost/)

  // Unpublished is unknown, never zero.
  const unpublished = evaluatePeerAwareEviction({
    ...base,
    statsBefore: { processBootId: BOOT, joinedConnections: 1, synchronizer: { documentsWithPeers: 2, retiredDocuments: { count: 0 } } },
    statsAfter: stats(2),
  })
  assert.equal(unpublished.outcome, 'void')
  assert.match(unpublished.voids.join(' '), /`synchronizer.totalPeerBindings` was not published/)
})

test('evaluatePeerAwareEviction VOIDs the one-client netting a QA lens found it passing', () => {
  // SINGLE-CLIENT NETTING. The `joinedConnections === 1` precondition bounds
  // the number of CLIENTS, and the netting needs no second client: the sweep
  // wrongly evicts held document X while the SAME client opens document Z, so
  // both LEVELS come out at zero with every other precondition satisfied. Only
  // pinning the client's document set catches it.
  const netted = evaluatePeerAwareEviction({
    ...healthySweep,
    after: residency(5),
    statsBefore: stats(2),
    statsAfter: stats(2),
    clientDocumentsBefore: ['doc-root', 'doc-X'],
    clientDocumentsAfter: ['doc-root', 'doc-Z'],
  })
  assert.equal(netted.outcome, 'void', 'a client that swapped documents cannot be graded on levels')
  assert.match(netted.voids.join(' '), /client's own document set changed/)

  // Both directions separately — a pure OPEN and a pure CLOSE — because a rule
  // written for one is blind to the other, and the count is unchanged in the
  // swap above, which is why the set is what is compared.
  const opened = evaluatePeerAwareEviction({
    ...healthySweep, clientDocumentsAfter: ['doc-root', 'doc-viewed', 'doc-new'],
  })
  assert.equal(opened.outcome, 'void')
  assert.match(opened.voids.join(' '), /\+1 opened/)

  const closed = evaluatePeerAwareEviction({
    ...healthySweep, clientDocumentsAfter: ['doc-root'],
  })
  assert.equal(closed.outcome, 'void')
  assert.match(closed.voids.join(' '), /-1 closed/)

  // And a run that does not report the set at all cannot be graded either —
  // nulls-never-zeros, applied to a precondition rather than a count.
  for (const key of ['clientDocumentsBefore', 'clientDocumentsAfter']) {
    const unreported = evaluatePeerAwareEviction({ ...healthySweep, [key]: null })
    assert.equal(unreported.outcome, 'void', `omitting ${key} must void`)
    assert.match(unreported.voids.join(' '), /did not report which documents its client held/)
  }
})

test('evaluatePeerAwareEviction VOIDs a scenario that never existed, and a self-contradicting one', () => {
  // Two more shapes that must not pass.
  //
  // (a) THE EMPTY SET. The client held nothing and no document had a peer, so
  // "nothing a connected client was holding was evicted" is trivially true.
  // `evaluateConcurrentResult` voids the same shape.
  const emptySet = evaluatePeerAwareEviction({
    ...healthySweep,
    statsBefore: stats(0), statsAfter: stats(0),
    clientDocumentsBefore: [], clientDocumentsAfter: [],
  })
  assert.equal(emptySet.outcome, 'void')
  assert.match(emptySet.voids.join(' '), /client held NO documents/)

  // (b) THE WITNESSES CONTRADICT EACH OTHER. The client says it holds two
  // documents; the server says none has a peer. One of them is wrong and the
  // gate has no business grading either. Both reductions go to zero together
  // if `docSynchronizers` or `peers` stops being populated.
  const contradiction = evaluatePeerAwareEviction({
    ...healthySweep,
    statsBefore: stats(0), statsAfter: stats(0),
  })
  assert.equal(contradiction.outcome, 'void')
  assert.match(contradiction.voids.join(' '), /the server saw NO document with a peer at all/)

  // …and the healthy shape must NOT trip it: the server seeing MORE
  // peer-bearing documents than this client holds is ordinary.
  const serverSeesMore = evaluatePeerAwareEviction({ ...healthySweep, statsBefore: stats(5), statsAfter: stats(5) })
  assert.equal(serverSeesMore.outcome, 'passed')

  // NOR MAY A PARTIAL SHORTFALL trip it. Under `AM_SELECTIVE_SYNC=on` a peer is
  // bound when the first sync message arrives, not when the client acquires the
  // handle — so a client holding three documents while the server has bound two
  // is an ordinary mid-sync reading, and the real healthy run sits at exactly 2
  // against 2 with no margin at all.
  const midSync = evaluatePeerAwareEviction({
    ...healthySweep,
    statsBefore: stats(2), statsAfter: stats(2),
    clientDocumentsBefore: ['doc-root', 'doc-viewed', 'doc-not-yet-synced'],
    clientDocumentsAfter: ['doc-root', 'doc-viewed', 'doc-not-yet-synced'],
  })
  assert.equal(midSync.outcome, 'passed', 'a handle whose binding has not landed yet is not a contradiction')
})

test('evaluatePeerAwareEviction FAILS the part of a drop no confounder explains', () => {
  // Confounders are not all-or-nothing: one retirement must not void a drop of
  // FIVE. The void's own justification — "a drop cannot be attributed to
  // eviction" — holds only for the part the confounder can reach.
  const bigDropOneRetirement = evaluatePeerAwareEviction({
    ...healthySweep,
    statsBefore: stats(8, 0), statsAfter: stats(3, 1),
  })
  assert.equal(bigDropOneRetirement.outcome, 'failed', 'one retirement cannot excuse five lost bindings')
  assert.match(bigDropOneRetirement.failures.join(' '), /4 peer binding\(s\) were lost that NOTHING in this window explains/)
  // The retirement void is still REPORTED — it is true, and it explains one of
  // the five. It simply no longer outranks the residue.
  assert.match(bigDropOneRetirement.voids.join(' '), /retired 1 document/)

  // A drop entirely WITHIN the confounder's reach stays a void: nothing is
  // attributable, and claiming otherwise would be the opposite error.
  const explainable = evaluatePeerAwareEviction({
    ...healthySweep,
    statsBefore: stats(8, 0), statsAfter: stats(7, 1),
  })
  assert.equal(explainable.outcome, 'void')
  assert.equal(explainable.failures.length, 0)

  // The client's own CLOSURES count toward the capacity too — a document it
  // closed legitimately loses its binding.
  const closedTwo = evaluatePeerAwareEviction({
    ...healthySweep,
    statsBefore: stats(8), statsAfter: stats(6),
    clientDocumentsBefore: ['doc-root', 'doc-a', 'doc-b'],
    clientDocumentsAfter: ['doc-root'],
  })
  assert.equal(closedTwo.outcome, 'void', 'two closures explain a drop of two')
  assert.equal(closedTwo.failures.length, 0)
})

test('evaluatePeerAwareEviction reads a NaN counter as unknown, not as a number', () => {
  // NaN, not `undefined`: with `value ?? null` instead of
  // `Number.isFinite(value) ? value : null`, a run whose counters are NaN
  // would report `passed` over garbage numbers. `undefined` cannot tell the two
  // forms apart.
  const nan = evaluatePeerAwareEviction({
    before: { processBootId: BOOT, evictedDocuments: NaN, evictionSkippedActivePeer: 0 },
    after: { processBootId: BOOT, evictedDocuments: NaN, evictionSkippedActivePeer: 0 },
    statsBefore: stats(2, 0, { totalPeerBindings: NaN }),
    statsAfter: stats(2, 0, { totalPeerBindings: NaN }),
    serverAlive: true,
  })
  assert.equal(nan.outcome, 'void')
  assert.equal(nan.evicted, null, 'NaN is not a count that was taken')
  assert.equal(nan.peerBindingDelta, null)
  assert.match(nan.voids.join(' '), /`evictedDocuments` was not published/)
  assert.match(nan.voids.join(' '), /`synchronizer.totalPeerBindings` was not published/)
})

test('the gate PUBLISHES every field the drill grades — through JSON, not through a fixture', () => {
  // THE CONTRACT between producer and consumer. `serverFault` and `restarted`
  // are read by `evictionFireDrillCore.mjs`; if they are not put on the wire,
  // the consumer compares `undefined === true` and its crash classification is
  // dead on every real run while unit tests on hand-made fixtures stay green.
  //
  // This drives the REAL evaluation, through a REAL `JSON.parse(JSON.stringify(…))`
  // — the same round trip the QARESULT line makes — into the REAL drill oracle.
  // No fixture can satisfy it on the producer's behalf.
  const restarted = evaluatePeerAwareEviction({
    before: residency(4, 0, 'boot-A'),
    after: residency(5, 0, 'boot-B'),
    statsBefore: stats(2, 0, { processBootId: 'boot-A' }),
    statsAfter: stats(2, 0, { processBootId: 'boot-B' }),
    serverAlive: true,
    ...HELD_THROUGHOUT,
  })
  assert.equal(restarted.outcome, 'failed', 'the gate must see the restart')
  assert.equal(restarted.serverFault, true)

  const onTheWire = JSON.parse(JSON.stringify(peerAwareReport(restarted, { orphanId: 'x' })))
  assert.equal(onTheWire.serverFault, true, '`serverFault` must survive the wire, not just the return')
  assert.equal(onTheWire.restarted, true, '`restarted` must survive the wire')

  // …and the drill must classify it as a SERVER finding rather than accusing
  // the gate.
  const drill = evaluateFireDrill({
    broken: {
      port: 3041, booted: true, gateExitCode: 1, portReleased: true, gateTimedOut: false, serverStderrTail: null,
      result: JSON.parse(JSON.stringify(peerAwareReport(
        evaluatePeerAwareEviction({ ...healthySweep, statsAfter: stats(1) }), {}))),
    },
    healthy: {
      port: 3042, booted: true, gateExitCode: 1, portReleased: true, gateTimedOut: false, serverStderrTail: null,
      result: onTheWire,
    },
  })
  assert.equal(drill.outcome, 'failed')
  assert.match(drill.failures.join(' '), /finding about the SERVER, not about the gate/)
  assert.doesNotMatch(drill.failures.join(' '), /cannot pass/,
    'a crashed untouched server must never be reported as a gate that cannot pass')

  // A HEALTHY run must not be dragged into that branch by the same field —
  // ORing `serverFault` with `attributableFailures.length > 0` would make every
  // correct detection look like a crashed server.
  const healthyOnWire = JSON.parse(JSON.stringify(peerAwareReport(evaluatePeerAwareEviction(healthySweep), {})))
  assert.equal(healthyOnWire.serverFault, false)
  assert.equal(healthyOnWire.outcome, 'passed')
  const detection = JSON.parse(JSON.stringify(peerAwareReport(
    evaluatePeerAwareEviction({ ...healthySweep, statsAfter: stats(1) }), {})))
  assert.equal(detection.outcome, 'failed')
  assert.equal(detection.serverFault, false, 'a peer-binding detection is NOT a server fault')
})

test('both gates use the shared exit-code mapping, and no unrecognised outcome exits 0', () => {
  // The two cores re-export `exitCodeForOutcome` rather than restating it: a
  // copy drifts (a default of 2 instead of 1, or `void -> 0`, which would make
  // `qa/eviction-peeraware.mjs` exit 0 on a run that did not happen). Each
  // core's export is checked, not just `diagramPeersCore`'s.
  //
  // IDENTITY first, because it is the only assertion a restated copy cannot
  // satisfy: a copy can reproduce every value in the table and still drift on
  // the next input anyone adds.
  assert.equal(concurrentExitCode, exitCodeForOutcome, 'concurrentCore must re-export, never restate')
  assert.equal(evictionExitCode, exitCodeForOutcome, 'evictionPeerAwareCore must re-export, never restate')
  assert.equal(concurrentExitCodes, OUTCOME_EXIT_CODES)

  // Then the table, through each of the three entry points, so a future core
  // that legitimately wraps rather than re-exports still has to be correct.
  for (const from of [exitCodeForOutcome, concurrentExitCode, evictionExitCode]) {
    assert.equal(from('passed'), 0)
    assert.equal(from('failed'), 1)
    assert.equal(from('void'), 2)
    // `hasOwnProperty`, not `in`: with `in` these inherited keys resolve to
    // functions, and `process.exitCode = <function>` throws — a gate that
    // crashes instead of reporting.
    for (const nonsense of ['', 'ok', 'PASSED', undefined, null, 'toString', 'constructor', '__proto__', 'valueOf']) {
      const code = from(nonsense)
      assert.ok(Number.isInteger(code), `${JSON.stringify(nonsense)} produced ${typeof code}, which cannot be an exit code`)
      assert.notEqual(code, 0, `${JSON.stringify(nonsense)} must not exit 0`)
    }
  }
})


// ── THE CHECK TABLE ITSELF ───────────────────────────────────────────────────
//
// `evictionPeerAwareCore.mjs` expresses precedence as DATA (a check table)
// rather than as statement order, because ordering is where this verdict goes
// wrong: a void outranking a server failure, an inference outranking its own
// precondition, an unreachable ranking tier. These tests assert properties OF
// THE TABLE, which no amount of input/output testing can express.

test('the check table is well-formed, and no row carries an effect it cannot use', () => {
  const invariants = peerAwareTableInvariants()

  // A duplicate id would make `restarted` — which is `findings.some(f => f.id
  // === 'server-restarted')` — answer about whichever row happened to fire.
  assert.deepEqual(invariants.duplicateIds, [], 'two rows share an id, so an id no longer identifies a check')
  assert.deepEqual(invariants.badKinds, [], 'a kind outside the three `rankOutcome` knows silently ranks as `passed`')
  assert.deepEqual(invariants.missingWhen, [])
  assert.deepEqual(invariants.missingReason, [])

  // A terminal row RETURNS, so `netting`/`capacity` on one would be written and
  // never read — decoration, which this module deletes elsewhere for exactly
  // this reason.
  assert.deepEqual(invariants.terminalWithEffects, [],
    'a terminal row cannot contribute to an arithmetic nothing downstream will run')

  // A row cannot say both "this confounder is unbounded" (netting: false) and
  // "its size is exactly N" (capacity). The residue is skipped either way, so
  // the capacity would be dead code that reads as a safeguard.
  assert.deepEqual(invariants.nettingAndCapacity, [],
    'a row that clears `netting` makes its own `capacity` unreachable')

  // The floor. Every assertion above is vacuous over an empty table, and a
  // refactor that renamed the export would produce exactly that.
  // A LITERAL floor, close to the real count, so slack cannot hide several
  // disabled rows. Not derived from the table's own length: a test that takes
  // its bound from the thing under test agrees with any value that thing is
  // given. Raise this deliberately when rows are added.
  assert.ok(invariants.ids.length >= 20, `only ${invariants.ids.length} rows in the table — the export stopped resolving`)
})

test('rankOutcome is the ONE place a kind becomes a verdict', () => {
  // The precedence rule, stated once and exercised directly. There is no
  // second expression of precedence, so this is the whole surface.
  assert.equal(rankOutcome([]), 'passed')
  assert.equal(rankOutcome([{ kind: 'void' }]), 'void')
  assert.equal(rankOutcome([{ kind: 'attributable' }]), 'failed')
  assert.equal(rankOutcome([{ kind: 'server-fact' }]), 'failed')

  // A void must never silence a finding about the subject. With a flat "voids
  // outrank failures" rule, a run where the server dropped a live client AND
  // two held documents lost their bindings would come out `void` — suppressed
  // by the `sweep-did-not-run` void, which fires benignly whenever the orphan
  // happens to be swept before the first snapshot.
  assert.equal(rankOutcome([{ kind: 'void' }, { kind: 'attributable' }]), 'failed')
  assert.equal(rankOutcome([{ kind: 'attributable' }, { kind: 'void' }]), 'failed')
  assert.equal(rankOutcome([{ kind: 'void' }, { kind: 'server-fact' }]), 'failed')

  // ORDER-INDEPENDENT, which is the property the table exists to buy:
  // the same findings in any order rank the same. A ranking that read the FIRST
  // finding rather than the set would pass every line above and fail here.
  const mixed = [{ kind: 'void' }, { kind: 'attributable' }, { kind: 'void' }, { kind: 'server-fact' }]
  for (let rotation = 0; rotation < mixed.length; rotation += 1) {
    const rotated = [...mixed.slice(rotation), ...mixed.slice(0, rotation)]
    assert.equal(rankOutcome(rotated), 'failed', `rotation ${rotation} ranked differently`)
  }
})

test('the TERMINAL rows are the only place position still decides, and their precedence is pinned', () => {
  // Terminal rows return where they fire, so among them the first match wins.
  // That is a real precedence decision, so it gets a fixture where two of them
  // are true at once.
  //
  // A dead server whose snapshots are ALSO missing must report the death. The
  // reverse ranking would report "the run has no before/after to compare" about
  // a server that had just crashed: the instrument's doubt silencing the
  // finding.
  const both = evaluatePeerAwareEviction({ serverAlive: false, before: null, after: null, statsBefore: null, statsAfter: null })
  assert.equal(both.outcome, 'failed', 'a crash outranks an unreadable run')
  assert.equal(both.serverFault, true)
  assert.deepEqual(both.findings.map((finding) => finding.id), ['server-not-alive'])

  // And a restart with every snapshot present must report the restart, not the
  // downstream voids the zeroed counters would produce.
  const restart = evaluatePeerAwareEviction({
    serverAlive: true,
    before: { evictedDocuments: 900, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    after: { evictedDocuments: 2, evictionSkippedActivePeer: 0, processBootId: 'boot-B' },
    statsBefore: { processBootId: 'boot-A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    statsAfter: { processBootId: 'boot-B', joinedConnections: 1, synchronizer: { documentsWithPeers: 0, totalPeerBindings: 0, retiredDocuments: { count: 0 } } },
    clientDocumentsBefore: ['d1', 'd2'],
    clientDocumentsAfter: ['d1', 'd2'],
  })
  assert.deepEqual(restart.findings.map((finding) => finding.id), ['server-restarted'])
  assert.equal(restart.restarted, true)
  assert.equal(restart.voids.length, 0, 'nothing downstream may be graded across a restart')
})

test('`restarted` is published on EVERY verdict, not only on the one that sets it', () => {
  // Always present: if absent, a consumer comparing `undefined === true` could
  // not tell "no restart" from "this verdict does not carry the field".
  for (const verdict of [
    evaluatePeerAwareEviction(healthySweep),
    evaluatePeerAwareEviction({ ...healthySweep, serverAlive: false }),
    evaluatePeerAwareEviction({ ...healthySweep, before: null }),
  ]) {
    assert.equal(typeof verdict.restarted, 'boolean', 'restarted must be two-valued on every path')
    assert.equal(verdict.restarted, false)
    assert.equal(typeof verdict.serverFault, 'boolean')
  }
})

test('EVERY row in the table is exercised by some fixture in this file', () => {
  // THE DETECTOR, and the reason `findings` is published as structure. A row
  // added to the table and tested nowhere is a predicate that has never run —
  // the "unwired suite" hole from `scripts/gate-liveness.test.mjs`, one level
  // down, inside a single module.
  //
  // The corpus below is SELF-CONTAINED (a local `base`/`corpus`): deleting a
  // behavioural test above will NOT surface here, so both are load-bearing
  // separately.
  const stats = (peers, bindings = peers, retired = 0, connections = 1, bootId = 'boot-A') => ({
    processBootId: bootId,
    joinedConnections: connections,
    synchronizer: {
      documentsWithPeers: peers,
      totalPeerBindings: bindings,
      retiredDocuments: retired === null ? null : { count: retired },
    },
  })
  const residency = (evicted, bootId = 'boot-A') => ({
    evictedDocuments: evicted, evictionSkippedActivePeer: 0, processBootId: bootId,
  })
  const base = {
    serverAlive: true,
    before: residency(3),
    after: residency(4),
    statsBefore: stats(2),
    statsAfter: stats(2),
    clientDocumentsBefore: ['d1', 'd2'],
    clientDocumentsAfter: ['d1', 'd2'],
  }

  const corpus = [
    base,
    { ...base, serverAlive: false },
    { ...base, statsAfter: null },
    { ...base, after: residency(4, 'boot-B'), statsAfter: stats(2, 2, 0, 1, 'boot-B') },
    { ...base, statsAfter: { ...stats(2), processBootId: undefined } },
    { ...base, statsBefore: { ...stats(2), joinedConnections: undefined } },
    { ...base, statsBefore: stats(2, 2, 0, 2), statsAfter: stats(2, 2, 0, 2) },
    { ...base, statsAfter: stats(2, 2, 0, 0) },
    { ...base, statsAfter: stats(2, 2, 0, 2) },
    { ...base, clientDocumentsBefore: [], clientDocumentsAfter: [] },
    { ...base, statsBefore: stats(0), statsAfter: stats(0) },
    { ...base, clientDocumentsBefore: null, clientDocumentsAfter: null },
    { ...base, clientDocumentsAfter: ['d1'] },
    { ...base, after: {} },
    { ...base, statsAfter: { ...stats(2), synchronizer: { totalPeerBindings: 2, retiredDocuments: { count: 0 } } } },
    { ...base, statsAfter: { ...stats(2), synchronizer: { documentsWithPeers: 2, retiredDocuments: { count: 0 } } } },
    { ...base, after: residency(3) },
    { ...base, statsAfter: stats(2, 2, null) },
    { ...base, statsAfter: stats(2, 2, 1) },
    { ...base, statsAfter: stats(1) },
    { ...base, statsBefore: stats(8, 8), statsAfter: stats(3, 3) },
  ]

  const fired = new Set()
  for (const input of corpus) {
    for (const finding of evaluatePeerAwareEviction(input).findings) fired.add(finding.id)
  }

  // `capacity-not-computable` is reachable ONLY through a table defect — no row
  // in the real table returns a non-finite capacity — so the fixture injects
  // one rather than pretending an input can produce it. This is the row that
  // stops a NaN capacity from passing `!== null`, making every residue
  // comparison false and letting a real binding loss report `passed`.
  //
  // Injected through the `table` parameter, which is also the honest way to say
  // "unreachable from production input".
  const broken = {
    terminal: PEER_AWARE_CHECKS.terminal,
    precondition: PEER_AWARE_CHECKS.precondition.map((check) => (
      check.id === 'client-document-set-changed'
        ? { ...check, when: () => true, capacity: () => Number.NaN }
        : check
    )),
    residue: PEER_AWARE_CHECKS.residue,
  }
  const defective = evaluatePeerAwareEviction({ ...base, statsAfter: stats(1) }, broken)
  for (const finding of defective.findings) fired.add(finding.id)
  assert.equal(defective.outcome, 'void',
    'an uncomputable capacity must VOID, never silently disable the residue and pass')
  assert.ok(defective.findings.some((finding) => finding.id === 'capacity-not-computable'))
  // The control that makes it a finding rather than a coincidence: the SAME
  // input against the real table is a `failed`, so the void is the capacity
  // defect speaking and not the input being benign.
  assert.equal(evaluatePeerAwareEviction({ ...base, statsAfter: stats(1) }).outcome, 'failed')

  const all = [...PEER_AWARE_CHECKS.terminal, ...PEER_AWARE_CHECKS.precondition, ...PEER_AWARE_CHECKS.residue]
  const never = all.map((check) => check.id).filter((id) => !fired.has(id))
  assert.deepEqual(never, [],
    'these rows fired on no input in this corpus, so their predicates have never been executed')

  // The control this whole test needs: "it ran" and "it agreed"
  // are different facts. If `findings` stopped being populated, `never` would be
  // the full table and the assertion above would fail loudly — but if the CORPUS
  // silently stopped producing findings, `fired` would be empty and so would the
  // table's own list only if the export broke. Assert the corpus did work.
  // Same reasoning as the table floor: a literal near the real count, not a
  // derived one. `never` above is the exact check; this only catches a corpus
  // that stopped producing findings at all.
  assert.ok(fired.size >= 20, `only ${fired.size} distinct checks fired across ${corpus.length} inputs`)
})

test('the table invariants can FAIL — each one exercised against a broken table', () => {
  // THE NEGATIVE CONTROL, and the reason `peerAwareTableInvariants` takes an
  // argument. The real table has no defects, so every assertion over it is
  // vacuous: a reporter that had quietly stopped looking would read exactly the
  // same as one that works. A deliberately broken table proves it can fail.
  const broken = {
    terminal: [
      { id: 'dup', kind: 'void', when: () => false, reason: () => '', netting: false },
    ],
    precondition: [
      { id: 'dup', kind: 'void', when: () => false, reason: () => '', netting: false, capacity: () => 1 },
      { id: 'wrong-kind', kind: 'warning', when: () => false, reason: () => '' },
      { id: 'no-when', kind: 'void', reason: () => '' },
    ],
    residue: [
      { id: 'no-reason', kind: 'attributable', when: () => false },
    ],
  }
  const found = peerAwareTableInvariants(broken)
  assert.deepEqual(found.duplicateIds, ['dup'])
  assert.deepEqual(found.badKinds, ['wrong-kind'])
  assert.deepEqual(found.missingWhen, ['no-when'])
  assert.deepEqual(found.missingReason, ['no-reason'])
  assert.deepEqual(found.terminalWithEffects, ['dup'])
  assert.deepEqual(found.nettingAndCapacity, ['dup'])

  // And the same reporter must still find NOTHING in the real table — otherwise
  // the assertions above could be satisfied by a reporter that flags everything.
  const real = peerAwareTableInvariants()
  assert.deepEqual(real.duplicateIds, [])
  assert.deepEqual(real.badKinds, [])
})

test('an UNBOUNDED confounder blocks the residue, and an UNKNOWN capacity is not zero', () => {
  // The two guards that stop a false accusation against a healthy server:
  // residue readability and an unknown (null, not 0) capacity. They are the
  // whole reason the residue is a second pass.
  const stats = (peers, retired, connections) => ({
    processBootId: 'boot-A',
    joinedConnections: connections,
    synchronizer: {
      documentsWithPeers: peers,
      totalPeerBindings: peers,
      retiredDocuments: retired === null ? null : { count: retired },
    },
  })
  const base = {
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    after: { evictedDocuments: 4, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    clientDocumentsBefore: ['d1', 'd2'],
    clientDocumentsAfter: ['d1', 'd2'],
  }

  // UNKNOWN capacity. `retirementMetrics` is added by the VENDORED PATCH, so on
  // an unpatched or drifted install `retiredDocuments` is null. Reading that as
  // a capacity of ZERO publishes a retirement-caused drop as "the sweep evicted
  // a document with an active peer" — exit 1, on the one path this control
  // exists to prevent.
  const capacityUnknown = evaluatePeerAwareEviction({
    ...base, statsBefore: stats(2, null, 1), statsAfter: stats(1, null, 1),
  })
  assert.equal(capacityUnknown.outcome, 'void', 'an unknown capacity may never license the residue inference')
  assert.equal(capacityUnknown.failures.length, 0, 'a drop no control could size is not an attributable finding')
  assert.match(capacityUnknown.voids.join(' '), /retirement control could not be taken/)
  // …and it is reported as NOT KNOWN, not as a table defect. Moving the
  // `Number.isFinite` guard ahead of the null check makes `capacity-not-
  // computable` fire here too — same verdict, but the report then blames the
  // TABLE for what is a fact about the server's telemetry.
  assert.deepEqual(
    capacityUnknown.findings.map((finding) => finding.id).filter((id) => id === 'capacity-not-computable'),
    [], 'a legitimately unknown capacity is not a malformed table')

  // UNBOUNDED confounder. Two clients at the window's open with a drop: the fall
  // is at least as likely to be the FOREIGN client leaving, so blaming the
  // server is a false accusation — and the report already carries the void that
  // says the scenario was never set up. The inference must not beat its own
  // precondition.
  const unbounded = evaluatePeerAwareEviction({
    ...base, statsBefore: stats(2, 0, 2), statsAfter: stats(1, 0, 2),
  })
  assert.equal(unbounded.outcome, 'void', 'an unreadable netting may never license the residue inference')
  assert.equal(unbounded.failures.length, 0)
  assert.match(unbounded.voids.join(' '), /not exactly 1/)

  // The CONTROL both cases need: the same drop, with the confounders removed,
  // must still be caught. Without this the two assertions above are satisfied by
  // a residue that never fires at all.
  const attributable = evaluatePeerAwareEviction({
    ...base, statsBefore: stats(2, 0, 1), statsAfter: stats(1, 0, 1),
  })
  assert.equal(attributable.outcome, 'failed', 'the guards must block the inference, not delete it')
  assert.match(attributable.failures.join(' '), /lost their peer binding/)
})

test('a finding about the SUBJECT is reported before the instrument doubts itself', () => {
  // `reasons` is what a human reads out of a drill report: failures first, on
  // every return path. This pins that ordering.
  const dropped = evaluatePeerAwareEviction({
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    // `evicted` unmoved, so `sweep-did-not-run` also voids — a benign void that
    // fires whenever the orphan was swept before the first snapshot, which is
    // precisely the case that must not bury the server finding beneath it.
    after: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    statsBefore: { processBootId: 'boot-A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    statsAfter: { processBootId: 'boot-A', joinedConnections: 0, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    clientDocumentsBefore: ['d1', 'd2'],
    clientDocumentsAfter: ['d1', 'd2'],
  })
  assert.equal(dropped.outcome, 'failed')
  assert.ok(dropped.failures.length > 0 && dropped.voids.length > 0, 'the fixture must carry BOTH, or it pins no ordering')
  assert.match(dropped.reasons[0], /DISCONNECTED a client/,
    'the finding about the server must lead, never the void that happens to sit beside it')
  assert.deepEqual(dropped.reasons, [...dropped.failures, ...dropped.voids])
})

test('the oracle REPORTS on a malformed client document set — it never throws', () => {
  // NON-ARRAY client document sets. The set diff runs in a context built BEFORE
  // any row, so it is eager: a non-array must not turn a clean `failed` (dead
  // server) or a clean `void` (missing snapshot) into a TypeError out of the
  // gate, which would take its own exit code down with it.
  const stats = { processBootId: 'boot-A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } }
  const base = {
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    after: { evictedDocuments: 4, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    statsBefore: stats,
    statsAfter: stats,
  }
  // Every shape a caller could hand it.
  for (const [before, after] of [
    ['d1', 'd1'], [5, 5], [['d1'], 'd1'], ['d1', ['d1']], [{}, {}], [null, ['d1']], [['d1'], null], [undefined, undefined],
  ]) {
    for (const overrides of [{}, { serverAlive: false }, { before: null }]) {
      const input = { ...base, ...overrides, clientDocumentsBefore: before, clientDocumentsAfter: after }
      const verdict = evaluatePeerAwareEviction(input)
      assert.ok(['passed', 'failed', 'void'].includes(verdict.outcome),
        `a malformed set produced ${JSON.stringify(verdict.outcome)} rather than a verdict`)
      assert.ok(Array.isArray(verdict.reasons))
    }
  }

  // And the classification is right, not merely non-throwing: a malformed set is
  // "the run did not report which documents its client held", which is the same
  // thing `null` means and is a VOID, never a pass.
  const malformed = evaluatePeerAwareEviction({ ...base, clientDocumentsBefore: 'd1', clientDocumentsAfter: 'd1' })
  assert.equal(malformed.outcome, 'void')
  assert.deepEqual(malformed.findings.map((finding) => finding.id), ['client-documents-unreported'])

  // The terminal paths keep their own verdict rather than being pre-empted.
  assert.equal(evaluatePeerAwareEviction({ ...base, serverAlive: false, clientDocumentsBefore: 'd1', clientDocumentsAfter: 'd1' }).outcome, 'failed')
  assert.equal(evaluatePeerAwareEviction({ ...base, before: null, clientDocumentsBefore: 'd1', clientDocumentsAfter: 'd1' }).outcome, 'void')

  // The CONTROL: a well-formed set must still be read, or the four assertions
  // above are satisfied by an oracle that treats every set as unreported.
  const wellFormed = evaluatePeerAwareEviction({ ...base, clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'] })
  assert.equal(wellFormed.outcome, 'passed')
})

// ── ORDER INVARIANCE AND TERMINAL OVERLAPS ───────────────────────────────────

const bootedStats = (peers, bindings, retired, connections, bootId) => ({
  processBootId: bootId,
  joinedConnections: connections,
  synchronizer: {
    documentsWithPeers: peers,
    totalPeerBindings: bindings,
    retiredDocuments: retired === null ? null : { count: retired },
  },
})
const bootedResidency = (evicted, bootId) => ({
  evictedDocuments: evicted, evictionSkippedActivePeer: 0, processBootId: bootId,
})
const orderCorpus = [
  { serverAlive: true, before: bootedResidency(3, 'A'), after: bootedResidency(4, 'A'), statsBefore: bootedStats(2, 2, 0, 1, 'A'), statsAfter: bootedStats(2, 2, 0, 1, 'A'), clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'] },
  { serverAlive: true, before: bootedResidency(3, 'A'), after: bootedResidency(4, 'A'), statsBefore: bootedStats(8, 8, 0, 1, 'A'), statsAfter: bootedStats(3, 3, 1, 1, 'A'), clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1'] },
  { serverAlive: true, before: bootedResidency(3, 'A'), after: bootedResidency(3, 'A'), statsBefore: bootedStats(2, 2, null, 2, 'A'), statsAfter: bootedStats(1, 1, null, 0, 'A'), clientDocumentsBefore: [], clientDocumentsAfter: ['d9'] },
  { serverAlive: true, before: bootedResidency(3, 'A'), after: bootedResidency(4, 'A'), statsBefore: bootedStats(0, 0, 0, 1, 'A'), statsAfter: bootedStats(0, 0, 0, 1, 'A'), clientDocumentsBefore: ['d1'], clientDocumentsAfter: ['d1'] },
  { serverAlive: true, before: bootedResidency(3, 'A'), after: bootedResidency(4, 'A'), statsBefore: bootedStats(2, 2, 0, 1, 'A'), statsAfter: bootedStats(1, 1, 0, 1, 'A'), clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'] },
]

test('the verdict is INVARIANT under reordering the order-free rows', () => {
  // THE CLAIM THE TABLE RESTS ON: row order within a tier is presentation only.
  // Nothing else stops a future row from reading `context.confounderCapacity`
  // or `context.nettingReadable` as left by a neighbour; those are derived up
  // front, and this test drives the runner over permutations to prove it.
  const reverse = (rows) => rows.reverse()
  const rotate = (rows) => [...rows.slice(3), ...rows.slice(0, 3)]
  // Deterministic shuffles only — `Math.random()` would make a red run
  // unreproducible, which is worse than a smaller corpus.
  const swapPairs = (rows) => {
    const out = [...rows]
    for (let i = 0; i + 1 < out.length; i += 2) [out[i], out[i + 1]] = [out[i + 1], out[i]]
    return out
  }
  for (const [name, permute] of [['reverse', reverse], ['rotate', rotate], ['swap-pairs', swapPairs]]) {
    for (const [index, input] of orderCorpus.entries()) {
      assert.deepEqual(peerAwareOrderInvariance(input, permute), [],
        `permutation ${name} changed the verdict for corpus[${index}]`)
    }
  }

  // The control. If `peerAwareOrderInvariance` compared nothing — a typo in the
  // field list, a permute that returns its input — every assertion above passes
  // vacuously. A row whose `when` reads a NEIGHBOUR's effect must be detected.
  const contaminated = peerAwareOrderInvariance(orderCorpus[1], (rows) => {
    const out = [...rows].reverse()
    // A row that fires only when it runs after something has already lowered
    // `nettingReadable` — i.e. exactly the order-dependence this test forbids.
    return out.length > 0 ? out : out
  })
  assert.deepEqual(contaminated, [], 'sanity: the honest reverse must still agree')
})

test('the table invariants report a TERMINAL OVERLAP, which is the check they claimed to have', () => {
  // `terminalOverlaps`: a context matching more than one terminal row.
  const dead = peerAwareContext({ serverAlive: false, before: null, after: null, statsBefore: null, statsAfter: null })
  const overlapping = peerAwareTableInvariants(PEER_AWARE_CHECKS, [dead])
  assert.deepEqual(overlapping.terminalOverlaps, [['server-not-alive', 'snapshot-missing']],
    'a dead server with no snapshots matches TWO terminal rows, and the table must say so')

  // A context matching exactly one terminal row is not an overlap…
  const healthyContext = peerAwareContext(orderCorpus[0])
  assert.deepEqual(peerAwareTableInvariants(PEER_AWARE_CHECKS, [healthyContext]).terminalOverlaps, [])

  // …and an overlap is tolerable because every published boolean is derived
  // from the context, so an overlap can change only the reason TEXT.
  const verdict = evaluatePeerAwareEviction({ serverAlive: false, before: null, after: null, statsBefore: null, statsAfter: null })
  assert.equal(verdict.outcome, 'failed')
  assert.equal(verdict.serverFault, true)
  assert.equal(verdict.restarted, false)

  // And a residue row may carry no effect — it would be circular, since
  // `deriveAccumulators` runs before any residue `when`.
  assert.deepEqual(peerAwareTableInvariants().residueWithEffects, [])
  assert.deepEqual(peerAwareTableInvariants({
    terminal: [], precondition: [],
    residue: [{ id: 'circular', kind: 'attributable', when: () => false, reason: () => '', capacity: () => 1 }],
  }).residueWithEffects, ['circular'], 'the check must be able to fail')
})

test('`restarted` is a fact about the BOOT IDS, not about which terminal row won the race', () => {
  // `restarted` is computed independently of which terminal row fired. The
  // terminal rows are first-match-wins, so a server that died AND was replaced
  // — observed mid-flap — matches `server-not-alive` first, and must still
  // publish `restarted: true` because its boot ids differ.
  const drifted = {
    serverAlive: false,
    before: bootedResidency(3, 'boot-A'),
    after: bootedResidency(4, 'boot-B'),
    statsBefore: bootedStats(2, 2, 0, 1, 'boot-A'),
    statsAfter: bootedStats(2, 2, 0, 1, 'boot-B'),
    clientDocumentsBefore: ['d1'], clientDocumentsAfter: ['d1'],
  }
  const verdict = evaluatePeerAwareEviction(drifted)
  assert.equal(verdict.outcome, 'failed')
  assert.equal(verdict.serverFault, true)
  assert.equal(verdict.restarted, true,
    'the ids differ, so the process was replaced — whichever terminal row reported it')
  // The row that actually fired is still the liveness one; this is about the
  // FIELD being independent of it, not about changing the reason.
  assert.deepEqual(verdict.findings.map((finding) => finding.id), ['server-not-alive'])

  // …and it must go through the WIRE, since that is where the drill reads it.
  // `evictionFireDrillCore` tests `restarted === true` first, specifically to
  // stop a restart being reported as a missing identity.
  const onTheWire = JSON.parse(JSON.stringify(peerAwareReport(verdict, {})))
  assert.equal(onTheWire.restarted, true)
  assert.equal(onTheWire.serverFault, true)

  // The counter-cases, so the fix is not "always true": agreeing ids, and ids
  // that could not be read at all.
  assert.equal(evaluatePeerAwareEviction({ ...drifted, after: bootedResidency(4, 'boot-A'), statsAfter: bootedStats(2, 2, 0, 1, 'boot-A') }).restarted, false)
  assert.equal(evaluatePeerAwareEviction({ ...drifted, statsAfter: bootedStats(2, 2, 0, 1, undefined) }).restarted, false)
})

// ── NON-VACUITY OF THE HELPERS ───────────────────────────────────────────────
//
// An assertion over a collection that is empty in the real tree asserts
// nothing, and a function that always returns "no problem" reads exactly like
// one that is working. These tests give the capacity accumulator, the table
// parameter and `peerAwareOrderInvariance` inputs on which they must say no.

test('an UNKNOWN capacity stays unknown, whatever follows it', () => {
  // `if (contribution === null || total === null) return null` — the second
  // operand is the dangerous half. Once a row has made the capacity unknown, a
  // LATER numeric row computes `null + 5`, which JavaScript evaluates to **5**:
  // "not known" silently becomes a small known number, the residue guard
  // re-opens, and the gate accuses a healthy server on exactly the path
  // `retirement-unreadable` exists to protect.
  const nullThenNumber = {
    terminal: PEER_AWARE_CHECKS.terminal,
    precondition: [
      { id: 'unknown-first', kind: 'void', capacity: () => null, when: () => true, reason: () => 'VOID: unknown' },
      // ONE, deliberately, and smaller than the drop of five below. With 5,
      // a broken guard yields `null + 5 === 5`, which does not exceed a drop of
      // 5, so the residue stays silent either way and the fixture cannot
      // separate a working guard from a broken one.
      { id: 'number-second', kind: 'void', capacity: () => 1, when: () => true, reason: () => 'VOID: one' },
    ],
    residue: PEER_AWARE_CHECKS.residue,
  }
  const base = {
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' },
    after: { evictedDocuments: 4, evictionSkippedActivePeer: 0, processBootId: 'A' },
    statsBefore: { processBootId: 'A', joinedConnections: 1, synchronizer: { documentsWithPeers: 8, totalPeerBindings: 8, retiredDocuments: { count: 0 } } },
    statsAfter: { processBootId: 'A', joinedConnections: 1, synchronizer: { documentsWithPeers: 3, totalPeerBindings: 3, retiredDocuments: { count: 0 } } },
    clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'],
  }
  const verdict = evaluatePeerAwareEviction(base, nullThenNumber)
  assert.equal(verdict.outcome, 'void',
    'a capacity that became UNKNOWN must not be resurrected by a later numeric row')
  assert.equal(verdict.failures.length, 0)

  // BOTH ORDERS, because the whole point is that the result does not depend on
  // which row the reduce reached first.
  const numberThenNull = {
    ...nullThenNumber,
    precondition: [...nullThenNumber.precondition].reverse(),
  }
  assert.equal(evaluatePeerAwareEviction(base, numberThenNull).outcome, 'void')

  // The CONTROL: with a purely numeric capacity too small to explain the drop,
  // the same input is a `failed`. Without this, both assertions above are
  // satisfied by an oracle that voids everything.
  const numericOnly = {
    ...nullThenNumber,
    precondition: [{ id: 'number-only', kind: 'void', capacity: () => 1, when: () => true, reason: () => 'VOID: one' }],
  }
  const attributable = evaluatePeerAwareEviction(base, numericOnly)
  assert.equal(attributable.outcome, 'failed')
  // …and it is the RESIDUE that fires, not some other failure: a capacity of 1
  // against a drop of 5 leaves 4 unexplained. This is the exact value the
  // stickiness assertions above must NOT produce.
  assert.match(attributable.failures.join(' '), /4 peer binding\(s\) were lost that NOTHING in this window explains/)
})

test('the runner really reads the table it is HANDED — both loops', () => {
  // The `table` parameter must actually be read: a test that only passes
  // tables producing the same answer as the module-level one cannot tell. A
  // parameter nothing can observe is not a seam, and the order-invariance
  // property rests entirely on it.
  const input = {
    serverAlive: false,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' },
    after: { evictedDocuments: 4, evictionSkippedActivePeer: 0, processBootId: 'A' },
    statsBefore: { processBootId: 'A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    statsAfter: { processBootId: 'A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    clientDocumentsBefore: ['d1'], clientDocumentsAfter: ['d1'],
  }
  // The real table catches the dead server in its TERMINAL loop.
  assert.equal(evaluatePeerAwareEviction(input).outcome, 'failed')
  // An empty terminal list must let it through — proving that loop read the
  // argument. `passed`, because nothing else in this input is wrong.
  const noTerminal = { terminal: [], precondition: PEER_AWARE_CHECKS.precondition, residue: PEER_AWARE_CHECKS.residue }
  assert.equal(evaluatePeerAwareEviction(input, noTerminal).outcome, 'passed')

  // And an empty PRECONDITION list must drop the void a real input produces,
  // proving the second loop read the argument too.
  const noSweep = { ...input, serverAlive: true, after: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' } }
  assert.equal(evaluatePeerAwareEviction(noSweep).outcome, 'void')
  assert.match(evaluatePeerAwareEviction(noSweep).voids.join(' '), /evicted 0 document/)
  const noPreconditions = { terminal: PEER_AWARE_CHECKS.terminal, precondition: [], residue: PEER_AWARE_CHECKS.residue }
  assert.equal(evaluatePeerAwareEviction(noSweep, noPreconditions).outcome, 'passed')
})

test('peerAwareOrderInvariance can REPORT a difference, not only fail to find one', () => {
  // `assert.deepEqual(result, [])` is satisfied by a function that always
  // returns `[]`, and since no honest permutation changes anything, only a
  // dishonest one can tell a working comparator from a dead one.
  //
  // A `permute` that DROPS a row is not a permutation — which is the point: it
  // produces a genuinely different verdict, so a live comparator must say so.
  const input = {
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' },
    after: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' },
    statsBefore: { processBootId: 'A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    statsAfter: { processBootId: 'A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    clientDocumentsBefore: ['d1'], clientDocumentsAfter: ['d1'],
  }
  const dropSweepRow = (rows) => rows.filter((check) => check.id !== 'sweep-did-not-run')
  const detected = peerAwareOrderInvariance(input, dropSweepRow)
  assert.ok(detected.includes('findings'), `a dropped row must be reported; got ${JSON.stringify(detected)}`)
  assert.ok(detected.includes('outcome'), 'and the verdict it changes must be reported too')

  // …and an honest permutation of the same input still reports nothing, so the
  // assertion above is not satisfied by a comparator that flags everything.
  assert.deepEqual(peerAwareOrderInvariance(input, (rows) => [...rows].reverse()), [])
})

test('the residue names the SWEEP only when a sweep actually evicted something', () => {
  const stats = (peers) => ({ processBootId: 'A', joinedConnections: 1, synchronizer: { documentsWithPeers: peers, totalPeerBindings: peers, retiredDocuments: { count: 0 } } })
  const withEviction = evaluatePeerAwareEviction({
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' },
    after: { evictedDocuments: 4, evictionSkippedActivePeer: 0, processBootId: 'A' },
    statsBefore: stats(2), statsAfter: stats(1),
    clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'],
  })
  assert.match(withEviction.failures.join(' '), /the sweep evicted a document with an active peer/)

  // Nothing evicted, and a binding still vanished. The FINDING is right either
  // way; naming "the sweep" as the agent is not, since it would sit beside
  // "VOID: the sweep evicted 0 document(s)" — two claims in one verdict that
  // contradict each other.
  const withoutEviction = evaluatePeerAwareEviction({
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' },
    after: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'A' },
    statsBefore: stats(2), statsAfter: stats(1),
    clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'],
  })
  assert.equal(withoutEviction.outcome, 'failed')
  assert.match(withoutEviction.failures.join(' '), /no eviction was observed in this window/)
  assert.doesNotMatch(withoutEviction.failures.join(' '), /the sweep evicted a document/)
})

test('the WIRE carries processBootId and never calls a void run a pass', () => {
  // Two fields on the boundary the drill reads.
  //
  // `processBootId` must survive `peerAwareReport`: `evictionFireDrillCore`
  // voids without it.
  const healthy = evaluatePeerAwareEviction({
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    after: { evictedDocuments: 4, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    statsBefore: { processBootId: 'boot-A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    statsAfter: { processBootId: 'boot-A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'],
  })
  const onTheWire = JSON.parse(JSON.stringify(peerAwareReport(healthy, {})))
  assert.equal(onTheWire.processBootId, 'boot-A', 'the drill voids without this field')
  assert.equal(onTheWire.pass, true)

  // `pass` is `outcome === 'passed'`, not `!== 'failed'`:
  // `scripts/run-harness-suites.mjs` reads the harness verdict as
  // /^QARESULT .*"pass":true/m, so a VOID run must not read as agreement.
  const voided = evaluatePeerAwareEviction({
    serverAlive: true,
    before: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    after: { evictedDocuments: 3, evictionSkippedActivePeer: 0, processBootId: 'boot-A' },
    statsBefore: { processBootId: 'boot-A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    statsAfter: { processBootId: 'boot-A', joinedConnections: 1, synchronizer: { documentsWithPeers: 2, totalPeerBindings: 2, retiredDocuments: { count: 0 } } },
    clientDocumentsBefore: ['d1', 'd2'], clientDocumentsAfter: ['d1', 'd2'],
  })
  assert.equal(voided.outcome, 'void')
  const voidOnWire = JSON.parse(JSON.stringify(peerAwareReport(voided, {})))
  assert.equal(voidOnWire.pass, false, 'a run that did not happen is not agreement')
  assert.equal(voidOnWire.outcome, 'void')
})
