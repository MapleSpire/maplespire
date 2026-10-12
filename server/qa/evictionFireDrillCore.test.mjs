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

// The verdict of the two-arm fire drill, executed.
//
// A NOTE ON WHAT THIS FILE IS, because the same sentence belongs at the top of
// every oracle in this directory: these cases are evidence about the ORACLE
// and nothing else. They say that GIVEN a
// pair of arm readings, the drill grades them correctly. They say nothing about
// whether a server boots, whether the injection takes, or whether the two arms
// ever produce different readings — that is what running
// `npm run qa:eviction-fire-drill` establishes, and only that.
//
// Unit tests over an input shape the server never produces prove little, so the
// fixtures below carry the REAL numbers the drill measured, and the
// healthy/broken pair is the shape those runs actually returned rather than a
// shape invented here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateFireDrill, exitCodeForOutcome as drillExitCode } from './evictionFireDrillCore.mjs'
import { exitCodeForOutcome } from './diagramPeersCore.mjs'

// Measured, 3 runs, deterministic to the number: the fault-injected arm evicted
// TWO documents (the orphan and the one client B was holding) and both peer
// witnesses fell by exactly 1; the untouched arm evicted ONE (the orphan) and
// neither witness moved.
const brokenArm = (overrides = {}) => ({
  port: 3041,
  booted: true,
  gateExitCode: 1,
  portReleased: true,
  gateTimedOut: false,
  serverStderrTail: null,
  ...overrides,
  result: overrides.result === null ? null : {
    outcome: 'failed',
    evicted: 2,
    peerBoundDelta: -1,
    peerBindingDelta: -1,
    processBootId: 'boot-broken',
    reasons: ['1 document(s) that a connected client was holding lost their peer binding'],
    ...(overrides.result ?? {}),
  },
})

const healthyArm = (overrides = {}) => ({
  port: 3042,
  booted: true,
  gateExitCode: 0,
  portReleased: true,
  gateTimedOut: false,
  serverStderrTail: null,
  ...overrides,
  result: overrides.result === null ? null : {
    outcome: 'passed',
    evicted: 1,
    peerBoundDelta: 0,
    peerBindingDelta: 0,
    processBootId: 'boot-healthy',
    reasons: [],
    ...(overrides.result ?? {}),
  },
})

test('the drill PASSES when the gate discriminates, and says so as a fact', () => {
  const result = evaluateFireDrill({ broken: brokenArm(), healthy: healthyArm() })
  assert.equal(result.outcome, 'passed')
  assert.deepEqual(result.reasons, [])
  // Stated rather than inferred from the absence of complaints. "No reasons"
  // and "the gate discriminates" are different propositions, and a reader
  // should not have to derive the second from the first.
  assert.equal(result.discriminates, true)
  assert.deepEqual(result.bootIds, { broken: 'boot-broken', healthy: 'boot-healthy' })
})

test('the drill FAILS a gate that cannot FAIL, and names that disease', () => {
  // With the sweep's peer check disabled the server evicts a document a
  // connected client is holding, and the gate says nothing. Every outcome but `failed` is this, including `passed`.
  const result = evaluateFireDrill({
    broken: brokenArm({ gateExitCode: 0, result: { outcome: 'passed', peerBoundDelta: 0 } }),
    healthy: healthyArm(),
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.discriminates, false)
  assert.match(result.failures.join(' '), /did NOT detect the injected fault/)
  assert.match(result.failures.join(' '), /cannot fail/)
})

test('the drill FAILS a gate that cannot PASS, and names the OTHER disease', () => {
  // A gate reporting a defect against a correct server. Kept distinct from the case above because the remedies are
  // opposite — one needs a stronger witness, the other a weaker one — and a
  // drill that reported "the arms disagree" would leave the reader to guess.
  const result = evaluateFireDrill({
    broken: brokenArm(),
    healthy: healthyArm({ gateExitCode: 1, result: { outcome: 'failed', reasons: ['spurious binding drop'] } }),
  })
  assert.equal(result.outcome, 'failed')
  assert.match(result.failures.join(' '), /against an UNTOUCHED server/)
  assert.match(result.failures.join(' '), /cannot pass/)
  // The gate's own reason is carried through: a drill that says "the healthy
  // arm failed" without saying why sends the reader back to re-run it.
  assert.match(result.failures.join(' '), /spurious binding drop/)
})

test('the drill grades the EXIT CODE separately from the verdict, on both arms', () => {
  // `run-harness-suites.mjs`'s witness/verdict rule, one level down. A script
  // that exits 0 unconditionally while computing a `pass` field reports a
  // correct `failed` to no caller. Grading only the verdict is blind to that;
  // grading only the exit code is blind to the reverse.
  const rightVerdictWrongCode = evaluateFireDrill({
    broken: brokenArm({ gateExitCode: 0 }),
    healthy: healthyArm(),
  })
  assert.equal(rightVerdictWrongCode.outcome, 'failed')
  assert.match(rightVerdictWrongCode.failures.join(' '), /exited 0, not 1/)
  assert.match(rightVerdictWrongCode.failures.join(' '), /reaches no caller is not a gate/)

  const healthyWrongCode = evaluateFireDrill({
    broken: brokenArm(),
    healthy: healthyArm({ gateExitCode: 1 }),
  })
  assert.equal(healthyWrongCode.outcome, 'failed')
  assert.match(healthyWrongCode.failures.join(' '), /healthy arm's gate exited 1, not 0/)

  // A gate that CRASHED reports no exit code this drill can read as agreement.
  const crashed = evaluateFireDrill({ broken: brokenArm({ gateExitCode: null }), healthy: healthyArm() })
  assert.equal(crashed.outcome, 'failed')
})

test('an arm that did not RUN is void, never a gate defect', () => {
  // Grading the instrument instead of the subject. A server that never booted
  // says nothing about the gate's discrimination, and reporting it as `failed`
  // would send a reader to fix a gate that is fine.
  const noBoot = evaluateFireDrill({
    broken: brokenArm({ booted: false, result: null, serverStderrTail: 'EADDRINUSE' }),
    healthy: healthyArm(),
  })
  assert.equal(noBoot.outcome, 'void')
  assert.equal(noBoot.discriminates, null, 'a drill that did not run has no opinion, which is not the same as `false`')
  assert.match(noBoot.voids.join(' '), /never became healthy on port 3041/)
  // The server's own last words, or the reader has nothing to act on.
  assert.match(noBoot.voids.join(' '), /EADDRINUSE/)

  const noReport = evaluateFireDrill({ broken: brokenArm({ result: null }), healthy: healthyArm() })
  assert.equal(noReport.outcome, 'void')
  assert.match(noReport.voids.join(' '), /printed no QARESULT/)

  // The gate's own three-valued outcome passes THROUGH: an arm whose gate
  // voided measured nothing, so the drill measured nothing either.
  const gateVoided = evaluateFireDrill({
    broken: brokenArm(),
    healthy: healthyArm({ gateExitCode: 2, result: { outcome: 'void', reasons: ['the sweep evicted 0 document(s)'] } }),
  })
  assert.equal(gateVoided.outcome, 'void')
  assert.match(gateVoided.voids.join(' '), /voided its own run/)
  assert.match(gateVoided.voids.join(' '), /evicted 0 document/)

  // BOTH arms, looped: the guard is per-arm and a case covering one end only
  // would not notice the other being dropped.
  for (const dead of ['broken', 'healthy']) {
    const arms = { broken: brokenArm(), healthy: healthyArm() }
    arms[dead] = { ...arms[dead], booted: false, result: null }
    const result = evaluateFireDrill(arms)
    assert.equal(result.outcome, 'void', `a dead ${dead} arm must void`)
    assert.match(result.voids.join(' '), new RegExp(`the ${dead} arm`))
  }

  // `booted` UNREPORTED, not `booted: false`, so `!== true` cannot be narrowed
  // to `=== false` unnoticed (same as the `portReleased` guard).
  for (const blind of ['broken', 'healthy']) {
    const arms = { broken: brokenArm(), healthy: healthyArm() }
    arms[blind] = { ...arms[blind], booted: undefined }
    const result = evaluateFireDrill(arms)
    assert.equal(result.outcome, 'void', `an arm that never reported \`booted\` must void (${blind})`)
    assert.match(result.voids.join(' '), /never became healthy/)
  }

  assert.equal(evaluateFireDrill({}).outcome, 'void')
  assert.equal(evaluateFireDrill().outcome, 'void')
})

test('the drill VOIDs when ONE server answered both arms', () => {
  // The Windows orphan-port trap: killing a spawned `tsx` leaves the node
  // process holding the port, so a second arm can be served by the first arm's
  // server — and the fault-injected one answering the healthy arm produces a
  // confident wrong verdict rather than an error. The arms use separate ports
  // so this cannot happen by construction; this checks that the construction
  // argument holds.
  const oneServer = evaluateFireDrill({
    broken: brokenArm(),
    healthy: healthyArm({ result: { processBootId: 'boot-broken' } }),
  })
  assert.equal(oneServer.outcome, 'void')
  assert.match(oneServer.voids.join(' '), /answered by the SAME process/)

  for (const blind of ['broken', 'healthy']) {
    const arms = { broken: brokenArm(), healthy: healthyArm() }
    arms[blind] = blind === 'broken'
      ? brokenArm({ result: { processBootId: undefined } })
      : healthyArm({ result: { processBootId: undefined } })
    const result = evaluateFireDrill(arms)
    assert.equal(result.outcome, 'void', `a ${blind} arm with no boot id must void`)
    assert.match(result.voids.join(' '), /did not report `processBootId`/)
  }
})

test('the broken arm must fail ON THE WITNESS UNDER TEST, not merely fail', () => {
  // `faultInjectPeerCheck.mts` relies on this second check: the broken arm
  // must actually produce a peer-binding drop, not just `failed` and exit 1.
  //
  // It matters on the LIKELIEST alternative path. Evicting a document a client
  // is holding can CRASH the server; a crash makes the gate report `failed`
  // through its `serverAlive` branch with exit 1 — and without this check the
  // drill would publish `discriminates: true` while the peer witnesses never
  // moved.
  const crashedInsteadOfLosingABinding = evaluateFireDrill({
    broken: brokenArm({
      result: {
        outcome: 'failed',
        peerBoundDelta: null,
        peerBindingDelta: null,
        reasons: ['the server was not healthy after the sweep (serverAlive=false)'],
      },
    }),
    healthy: healthyArm(),
  })
  assert.equal(crashedInsteadOfLosingABinding.outcome, 'failed')
  assert.equal(crashedInsteadOfLosingABinding.discriminates, false)
  assert.match(crashedInsteadOfLosingABinding.failures.join(' '), /NOT on a peer-binding drop/)
  // The gate's own reason is carried, or the reader cannot tell a crash from a
  // wrong verdict.
  assert.match(crashedInsteadOfLosingABinding.failures.join(' '), /not healthy after the sweep/)

  // EITHER witness moving is enough — they are two reductions of one array and
  // a rule requiring both would fail on a shape the server can produce.
  for (const moved of [{ peerBoundDelta: -1, peerBindingDelta: 0 }, { peerBoundDelta: 0, peerBindingDelta: -1 }]) {
    const result = evaluateFireDrill({ broken: brokenArm({ result: moved }), healthy: healthyArm() })
    assert.equal(result.outcome, 'passed', `${JSON.stringify(moved)} is a peer-binding drop`)
  }

  // A drop of ZERO is not a drop. Pinned separately because `< 0` and `<= 0`
  // are one character apart and only one of them is right.
  const noDrop = evaluateFireDrill({
    broken: brokenArm({ result: { peerBoundDelta: 0, peerBindingDelta: 0 } }),
    healthy: healthyArm(),
  })
  assert.equal(noDrop.outcome, 'failed')
  assert.match(noDrop.failures.join(' '), /NOT on a peer-binding drop/)
})

test('an arm whose server survived the kill is void — isolation is a graded fact', () => {
  // The drill asserts the EFFECT of its tree-kill: a drill that left a
  // fault-injected server running must not pass. A surviving arm-1 server is
  // also concurrent with arm 2 against the same database, breaking the
  // sequencing argument the drill rests on.
  for (const leaked of ['broken', 'healthy']) {
    const arms = { broken: brokenArm(), healthy: healthyArm() }
    arms[leaked] = leaked === 'broken' ? brokenArm({ portReleased: false }) : healthyArm({ portReleased: false })
    const result = evaluateFireDrill(arms)
    assert.equal(result.outcome, 'void', `a leaked ${leaked} arm must void`)
    assert.match(result.voids.join(' '), /was not confirmed gone/)
    assert.equal(result.discriminates, null)
  }

  // An arm that never REPORTED is not an arm that reported success — the
  // unanswered question is not a negative answer.
  const unreported = evaluateFireDrill({ broken: brokenArm({ portReleased: undefined }), healthy: healthyArm() })
  assert.equal(unreported.outcome, 'void')
  assert.match(unreported.voids.join(' '), /portReleased=undefined/)
})

test('a gate the drill KILLED is void, not a gate that answered wrongly', () => {
  // `spawnSync` reports `status: null` on a timeout, and grading that as "the
  // gate exited null, not 1" accuses the subject of a defect that belongs to
  // the instrument's own deadline.
  for (const stalled of ['broken', 'healthy']) {
    const arms = { broken: brokenArm(), healthy: healthyArm() }
    arms[stalled] = stalled === 'broken'
      ? brokenArm({ gateTimedOut: true, gateExitCode: null })
      : healthyArm({ gateTimedOut: true, gateExitCode: null })
    const result = evaluateFireDrill(arms)
    assert.equal(result.outcome, 'void', `a stalled ${stalled} arm must void`)
    assert.match(result.voids.join(' '), /hit the drill's ceiling/)
  }
})

test('`discriminates` is null on EVERY void, not only the early ones', () => {
  // The late voids (not just the early return) must publish `null`, not
  // `false` — an accusation that the gate does not discriminate, about a run
  // that established nothing.
  const sameProcess = evaluateFireDrill({
    broken: brokenArm(),
    healthy: healthyArm({ result: { processBootId: 'boot-broken' } }),
  })
  assert.equal(sameProcess.outcome, 'void')
  assert.equal(sameProcess.discriminates, null, 'a void has no opinion about discrimination')

  const noBootId = evaluateFireDrill({
    broken: brokenArm({ result: { processBootId: undefined } }),
    healthy: healthyArm(),
  })
  assert.equal(noBootId.outcome, 'void')
  assert.equal(noBootId.discriminates, null)
})

test('an UNTOUCHED server that dies is a finding about the server, not about the gate', () => {
  // Everything else in the file grades the gate, so a healthy arm reporting
  // `failed` reads as "the gate cannot pass" — and if the untouched SERVER
  // crashed, that sends the reader to fix an instrument that is working.
  // Driven by the gate's TYPED `serverFault` field, not by regex-matching its
  // prose, so rewording a reason in the other module cannot flip it.
  for (const reason of [
    'the server was not healthy after the sweep (serverAlive=false)',
    'the server RESTARTED during the window (processBootId ["a","b"])',
    'the server DISCONNECTED a client this run was holding open (joinedConnections 1 -> 0)',
  ]) {
    const result = evaluateFireDrill({
      broken: brokenArm(),
      healthy: healthyArm({ gateExitCode: 1, result: { outcome: 'failed', serverFault: true, reasons: [reason] } }),
    })
    assert.equal(result.outcome, 'failed')
    assert.match(result.failures.join(' '), /finding about the SERVER, not about the gate/)
    assert.doesNotMatch(result.failures.join(' '), /cannot pass/)
  }

  // …while a healthy arm failing for a GATE reason still reads as the gate's
  // defect. The two must not collapse into one message.
  const gateDefect = evaluateFireDrill({
    broken: brokenArm(),
    healthy: healthyArm({ gateExitCode: 1, result: { outcome: 'failed', reasons: ['spurious binding drop'] } }),
  })
  assert.match(gateDefect.failures.join(' '), /cannot pass/)
})

test('a VOID outranks a FAILURE, so a drill that did not run never accuses the gate', () => {
  // A fixture that is both void AND failed pins the precedence.
  const bothConditions = evaluateFireDrill({
    // Fails (the broken arm passed) AND voids (its server leaked).
    broken: brokenArm({ portReleased: false, gateExitCode: 0, result: { outcome: 'passed' } }),
    healthy: healthyArm(),
  })
  assert.equal(bothConditions.outcome, 'void', 'an instrument that did not run cannot accuse the subject')
  assert.equal(bothConditions.discriminates, null)

  // THE RANKING EXPRESSION, not the early return. The case above trips an
  // ARM-level void, which takes an early `return` with a hardcoded outcome and
  // never reaches the ranking line at the end. A LATE void (both arms answered
  // by one process) is the only way to exercise that line.
  const lateVoidWithFailure = evaluateFireDrill({
    broken: brokenArm({ gateExitCode: 0, result: { outcome: 'passed', processBootId: 'one-process' } }),
    healthy: healthyArm({ result: { processBootId: 'one-process' } }),
  })
  assert.equal(lateVoidWithFailure.outcome, 'void', 'a late void must still outrank a failure')
  assert.equal(lateVoidWithFailure.discriminates, null)
  assert.ok(lateVoidWithFailure.failures.length > 0, 'and the failure must still be REPORTED, not discarded')
  assert.match(lateVoidWithFailure.voids.join(' '), /answered by the SAME process/)
})

test('the broken arm is graded on ANYTHING but `failed`, not only on `passed`', () => {
  // "Anything but `failed` here is the 'cannot fail' disease". A gate `void` is
  // intercepted earlier by `armIsVoid`, so a QARESULT with NO `outcome` field
  // (an older gate, a renamed field, a partial parse) is the case that keeps
  // `!== 'failed'` from being narrowed to `=== 'passed'`.
  const noOutcomeField = evaluateFireDrill({
    broken: brokenArm({ result: { outcome: undefined } }),
    healthy: healthyArm(),
  })
  assert.equal(noOutcomeField.outcome, 'failed')
  assert.equal(noOutcomeField.discriminates, false)
  assert.match(noOutcomeField.failures.join(' '), /it reported 'undefined', not 'failed'/)
})

test('the drill re-exports the shared exit-code mapping rather than restating it', () => {
  // A restated copy of the table can silently diverge (e.g. a different
  // default). Function identity is the assertion a copy cannot satisfy.
  assert.equal(drillExitCode, exitCodeForOutcome, 'evictionFireDrillCore must re-export, never restate')
  assert.equal(drillExitCode('passed'), 0)
  assert.equal(drillExitCode('failed'), 1)
  assert.equal(drillExitCode('void'), 2)
  // A drill that did not run must not exit 0 — the failure mode the whole
  // directory exists to deny.
  assert.notEqual(drillExitCode('void'), 0)
})
