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

// Two headless clients (= two browsers) edit SHARED objects concurrently through
// the server, then we assert the model converges and versions are correct:
//   - different fields of the same object both survive (field-level merge)
//   - the same field edited on both sides converges to ONE value on both clients
//   - both clients (and therefore the server) end up byte-identical
//
// Usage: node qa/concurrent.mjs [--root <url>] [--objects 20] [--rounds 5]
import {
  newRepo, args, loadRootUrl, changeCount, mem, t, ms, emit, log, flushAndClose,
} from './lib.mjs'
import { evaluateConcurrentResult, exitCodeForOutcome } from './concurrentCore.mjs'
import * as A from '@automerge/automerge'

const o = args({ objects: 20, rounds: 5, settle: 3000 })
const rootUrl = loadRootUrl(o.root)
log(`concurrent test on ${rootUrl}: ${o.objects} shared objects × ${o.rounds} rounds`)

// Create repoA first and wait for it to fully receive the root doc from the
// server before connecting repoB. Without this stagger, the two peers race
// during the initial sync handshake: one peer (which has no local copy yet)
// receives a sync message from the other peer and signals "unavailable",
// causing an unhandled rejection before either has gotten the doc from the server.
const repoA = newRepo()
const A1 = await repoA.find(rootUrl)
await A1.whenReady()
await new Promise((r) => setTimeout(r, 500)) // ensure A is fully settled

const repoB = newRepo()
const B1 = await repoB.find(rootUrl)
await B1.whenReady()
await new Promise((r) => setTimeout(r, 1500)) // let both fully catch up

const ids = Array.from({ length: o.objects }, (_, k) => `shared-${k}`)
// Only test ids that actually exist in the model.
const present = ids.filter((id) => A1.doc().model.objects[id])
// The root document's change count BEFORE any of this test's edits. `changeCount`
// is the whole document's history — thousands on any real workspace — so the
// absolute number can never be zero and a floor on it would be constant-true.
// The DELTA is what says this test's writes landed: assert the delta across the
// burst, never the counter.
const changesBeforeA = changeCount(A1)
const changesBeforeB = changeCount(B1)
log(`testing ${present.length} shared objects that exist in the model`)

const start = t()
for (let round = 0; round < o.rounds; round++) {
  // Fire both sides' edits in the SAME tick so they are genuinely concurrent
  // before the server round-trips them.
  A1.change((r) => {
    for (const id of present) {
      const ob = r.model.objects[id]
      if (!ob) continue
      ob.name = `A-name-r${round}` // A owns `name`
      ob.scope = 'external' // contested field (both sides write `scope`)
    }
  })
  B1.change((r) => {
    for (const id of present) {
      const ob = r.model.objects[id]
      if (!ob) continue
      ob.description = `B-desc-r${round}` // B owns `description`
      ob.scope = 'internal' // contested field
    }
  })
  await new Promise((r) => setTimeout(r, 600)) // let this round sync
}

// Settle, then re-read both sides.
await new Promise((r) => setTimeout(r, o.settle))
const convergeMs = ms(start)
const da = A1.doc()
const db = B1.doc()

let fieldMergeOk = 0
let fieldMergeFail = 0
let scopeConverged = 0
let scopeDiverged = 0
const failures = []

for (const id of present) {
  const oa = da.model.objects[id]
  const ob = db.model.objects[id]
  // An object that existed when `present` was built and is gone on one side now
  // is a REAL convergence failure. Graded rather than thrown (a TypeError on
  // the next line would kill the script before it printed any verdict).
  if (!oa || !ob) {
    fieldMergeFail++
    scopeDiverged++
    if (failures.length < 5) failures.push({ id, missingOnA: !oa, missingOnB: !ob })
    continue
  }
  // A's field and B's field must BOTH be present on both clients.
  const aName = `A-name-r${o.rounds - 1}`
  const bDesc = `B-desc-r${o.rounds - 1}`
  const fieldOk =
    oa.name === aName && ob.name === aName && oa.description === bDesc && ob.description === bDesc
  if (fieldOk) fieldMergeOk++
  else {
    fieldMergeFail++
    if (failures.length < 5) failures.push({ id, aName: oa.name, bName: ob.name, aDesc: oa.description, bDesc: ob.description })
  }
  // Contested `scope` must be EQUAL on both clients (converged), value either.
  if (oa.scope === ob.scope) scopeConverged++
  else scopeDiverged++
}

// Whole-model convergence: both clients byte-identical?
const modelEqual = JSON.stringify(sortKeys(da.model.objects)) === JSON.stringify(sortKeys(db.model.objects))

const observed = {
  test: 'concurrent',
  rootUrl,
  objectsTested: present.length,
  // What was ASKED for, beside what was found. `objectsTested` alone cannot say
  // that 1 of 20 seeded ids existed: the shortfall is invisible to the evaluator
  // and to an operator reading the report. Same move as `loadRequest` on the
  // peer bench — supply the missing fact rather than inferring it.
  objectsRequested: o.objects,
  rounds: o.rounds,
  fieldMergeOk,
  fieldMergeFail,
  scopeConverged,
  scopeDiverged,
  modelEqual,
  changesA: changeCount(A1),
  changesB: changeCount(B1),
  changesEqual: changeCount(A1) === changeCount(B1),
  // The deltas across this test's own rounds — see `changesBeforeA` above.
  changesDeltaA: changeCount(A1) - changesBeforeA,
  changesDeltaB: changeCount(B1) - changesBeforeB,
  convergeMs,
}

// The verdict, including the floor that keeps an empty `present` from passing,
// lives in `concurrentCore.mjs`.
const evaluation = evaluateConcurrentResult(observed)

emit({
  ...observed,
  outcome: evaluation.outcome,
  reasons: evaluation.reasons,
  pass: evaluation.outcome === 'passed',
  failures,
  mem: mem(),
})
for (const reason of evaluation.reasons) console.error(`[concurrent] ${reason}`)

await flushAndClose(repoA, 500)
await flushAndClose(repoB, 500)
// The exit code carries the verdict, so callers can read it.
process.exit(exitCodeForOutcome(evaluation.outcome))

function sortKeys(obj) {
  const out = {}
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? sortKeys(v) : v
  }
  return out
}
