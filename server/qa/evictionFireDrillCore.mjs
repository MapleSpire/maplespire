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

// The verdict of the two-arm fire drill.
//
// WHAT A PASSING `eviction-peeraware` RUN DOES NOT ESTABLISH. It grades one
// server and says "nothing a client was holding got evicted". It cannot say
// whether it WOULD have noticed. The oracle's unit tests and the real-sweep
// binding test are evidence about the ORACLE: given these snapshots, does the
// verdict come out right. None of it exercises the script, the endpoints it
// reads, the shapes the server really publishes, or the wiring between them.
//
// A gate can break in that gap in either direction: one that cannot PASS (e.g.
// a call whose arguments shifted after a signature change) or one that cannot
// FAIL (a pass predicate whose conjuncts are constants).
//
// Two arms are what tells those apart, and neither arm alone can. Running the
// gate against a server with the sweep's peer check disabled must produce
// `failed`; running it against an untouched server must produce `passed`. A
// gate that answers the same thing to both is broken whichever answer it gives,
// and the reasons below name WHICH of the two diseases it has, because the
// remedies are opposite.
//
// WHY THE ARMS ARE GRADED ON THE EXIT CODE AND THE VERDICT SEPARATELY. Same
// reason `run-harness-suites.mjs` keeps `witness` and `verdict` apart: the
// script computes a verdict and then has to REPORT it, and the two halves can
// disagree (a script that exits 0 unconditionally reports a correct `failed` to
// no caller). Grading only
// the exit code would miss a verdict that is right and unreported; grading only
// the verdict would miss the reverse. The drill asserts both, per arm.

/** Was this arm's reading usable at all? Separated from the verdict for the
 *  reason above: "the arm did not run" and "the arm disagreed" are different
 *  facts, and folding them makes a boot failure look like a gate defect. */
function armIsVoid(arm, label) {
  if (!arm) return `VOID: the ${label} arm was not run at all`
  if (arm.booted !== true) {
    const tail = arm.serverStderrTail ? ` — last server output: ${arm.serverStderrTail}` : ''
    return `VOID: the ${label} arm's server never became healthy on port ${arm.port ?? '?'}${tail}`
  }
  if (!arm.result) {
    return `VOID: the ${label} arm's server booted but the gate printed no QARESULT line — it did not reach its own report`
  }
  if (arm.gateTimedOut) {
    // The drill gave up on the gate; the gate did not answer wrongly. Grading
    // `status: null` as "exited null, not 1" would be an accusation against the
    // subject for the instrument's own deadline.
    return `VOID: the ${label} arm's gate hit the drill's ceiling and was killed — it never reported an exit code`
  }
  if (arm.portReleased !== true) {
    // `!== true`, not `=== false`: "the port was not released" and "the arm
    // never reported whether it was" are both reasons this run's isolation
    // cannot be established, and an unanswered question is not a negative
    // answer (nulls, never zeros). The runner always sets the field, so
    // the difference is only reachable through a defect — which is the case
    // worth catching.
    //
    // The arm's server survived the kill. This run's isolation is gone — the
    // surviving process is concurrent with the other arm against the same
    // database, still sweeping, still holding connections — and the NEXT run
    // will find the port held.
    return `VOID: the ${label} arm's server was not confirmed gone (portReleased=${JSON.stringify(arm.portReleased)}) ` +
      `on port ${arm.port} — this run had no isolation and the next one may inherit the process`
  }
  // The gate's own three-valued outcome passes THROUGH the drill. An arm that
  // voided measured nothing, and calling that a gate defect would blame the
  // subject for the instrument — this file's entire subject, one level up.
  if (arm.result.outcome === 'void') {
    return `VOID: the ${label} arm's gate voided its own run (${arm.result.reasons?.[0] ?? 'no reason given'})`
  }
  return null
}

/** Grade a two-arm fire drill.
 *
 * `broken` ran the gate against a server whose sweep peer check was disabled;
 * `healthy` ran it against an untouched server. Each arm is
 * `{ port, booted, gateExitCode, result, serverStderrTail }`, where `result` is
 * the parsed QARESULT object or null.
 */
export function evaluateFireDrill({ broken, healthy } = {}) {
  const failures = []
  const voids = []

  for (const [arm, label] of [[broken, 'broken'], [healthy, 'healthy']]) {
    const reason = armIsVoid(arm, label)
    if (reason) voids.push(reason)
  }
  if (voids.length > 0) {
    return { outcome: 'void', failures, voids, reasons: [...voids], discriminates: null, bootIds: null }
  }

  // Did the two arms measure two DIFFERENT processes? On Windows, killing a
  // spawned `tsx` orphans the node process and it keeps the port, so a second
  // arm can be answered by the first arm's server — and the fault-injected one
  // answering the healthy arm produces a confident wrong verdict rather than an
  // error. The arms run on separate ports so this cannot happen by
  // construction; the check verifies that construction argument.
  const brokenBoot = broken.result.processBootId ?? null
  const healthyBoot = healthy.result.processBootId ?? null
  // A RESTART is not a missing identity. The gate deliberately NULLS `bootId`
  // when the four snapshots disagree, so "the arm never reported an identity"
  // and "the gate nulled it because it found a restart" arrive here
  // byte-identical. Reporting the second as the first buries a dead server
  // under a void about the instrument. Check the typed `restarted` fact first.
  if (broken.result.restarted === true || healthy.result.restarted === true) {
    // Falls through to the server-fault classification below, which reports it
    // as a finding about the SERVER rather than about the gate.
  } else if (brokenBoot === null || healthyBoot === null) {
    voids.push(
      'VOID: an arm did not report `processBootId`, so the drill cannot prove its two arms measured two different ' +
      'servers — a leaked process answering both would be indistinguishable from a clean run',
    )
  } else if (brokenBoot === healthyBoot) {
    voids.push(
      `VOID: both arms were answered by the SAME process (processBootId ${brokenBoot}) — one server served both, ` +
      'so the two readings are one reading and the comparison below is vacuous',
    )
  }

  // THE BROKEN ARM. A disabled peer check means the sweep evicts documents the
  // connected client is holding, which is the data-loss shape the gate exists
  // to report. Anything but `failed` here is the "cannot fail" disease.
  const brokenOutcome = broken.result.outcome
  if (brokenOutcome !== 'failed') {
    failures.push(
      `the gate did NOT detect the injected fault: with the sweep's peer check disabled it reported ` +
      `'${brokenOutcome}', not 'failed'. This is a gate that cannot fail — the shape ` +
      '`qa/eviction-peeraware.mjs` shipped with, where every conjunct of the pass condition was a constant',
    )
  } else if (broken.result.serverFault === true) {
    // The SYMMETRIC branch of the healthy arm's — and a crash is MORE likely
    // here, since evicting a document a client holds is exactly what this arm
    // provokes. The gate reports it correctly; calling it "the gate failed for
    // the wrong reason" would accuse a working instrument. A VOID, because the
    // fault killed the server before the peer witness could be read, so the
    // experiment produced no reading about discrimination.
    voids.push(
      `VOID: the injected fault brought the server DOWN before the peer witness could be read ` +
      `(${broken.result.reasons?.join('; ') || 'no reason given'}) — the gate reported that correctly, ` +
      'but this arm establishes nothing about whether it can detect a wrongly-evicted document',
    )
  } else if (!((broken.result.peerBoundDelta < 0) || (broken.result.peerBindingDelta < 0))) {
    // FAILING FOR THE RIGHT REASON. With the peer check disabled the sweep
    // evicts documents a connected client holds, which can CRASH the server.
    // A crash that is not flagged `serverFault` would make the gate report
    // `failed` and exit 1 while the peer witnesses never moved, certifying
    // detection on the strength of something else. Requiring the witness under
    // test to have MOVED makes the arm evidence about that witness.
    failures.push(
      'the broken arm failed, but NOT on a peer-binding drop ' +
      `(peerBoundDelta=${JSON.stringify(broken.result.peerBoundDelta)}, ` +
      `peerBindingDelta=${JSON.stringify(broken.result.peerBindingDelta)}): ` +
      `${broken.result.reasons?.join('; ') || 'no reason given'}. ` +
      'A gate that fails for a different reason has not been shown to detect THIS fault',
    )
  }
  if (broken.gateExitCode !== 1) {
    failures.push(
      `the broken arm's gate exited ${broken.gateExitCode}, not 1 — a verdict that reaches no caller is not a gate, ` +
      'which is how this same script exited 0 unconditionally while computing a `pass` field nobody could read',
    )
  }

  // THE HEALTHY ARM. Anything but `passed` is the opposite disease, and the one
  // that is harder to live with: a gate that cries wolf gets switched off.
  const healthyOutcome = healthy.result.outcome
  const healthyReasons = healthy.result.reasons?.join('; ') || 'no reason given'
  // A TYPED field, not a regex over the other module's reason prose: rewording
  // a message in `evictionPeerAwareCore.mjs` must not silently flip this
  // classification.
  if (healthyOutcome !== 'passed' && healthy.result.serverFault === true) {
    // The untouched server did not survive its own window. Blaming the gate
    // here would send the reader to fix an instrument that is working.
    failures.push(
      `the UNTOUCHED server did not survive the window: ${healthyReasons}. ` +
      'This is a finding about the SERVER, not about the gate — the gate reported it correctly',
    )
  } else if (healthyOutcome !== 'passed') {
    failures.push(
      `the gate reported '${healthyOutcome}' against an UNTOUCHED server: ${healthyReasons}. ` +
      'This is a gate that cannot pass — ' +
      "`qa/eviction-check.mts`'s own defect, and the blocker two review lenses found in this gate's first rewrite",
    )
  }
  if (healthy.gateExitCode !== 0) {
    failures.push(`the healthy arm's gate exited ${healthy.gateExitCode}, not 0`)
  }

  const outcome = voids.length > 0 ? 'void' : (failures.length > 0 ? 'failed' : 'passed')
  return {
    outcome,
    failures,
    voids,
    reasons: [...voids, ...failures],
    // The single fact the drill exists to establish, stated as a fact rather
    // than left for a reader to infer from the absence of complaints.
    //
    // THREE-valued, matching the outcome: a drill that did not run has no
    // opinion, which is not the same as `false`. This covers the later voids
    // (a missing boot id, both arms on one process) as well as the early
    // return above.
    discriminates: outcome === 'passed' ? true : (outcome === 'void' ? null : false),
    bootIds: { broken: brokenBoot, healthy: healthyBoot },
  }
}

export { exitCodeForOutcome } from './diagramPeersCore.mjs'
