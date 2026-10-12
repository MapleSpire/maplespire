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

// The acceptance test for the latency instrument itself.
//
// A marker in DOCUMENT STATE (`doc.__bench`) converges: when several changes
// ride in one sync frame only the NEWEST marker survives, so that instrument
// recovers 1 emit of 5 — and the ones it throws away are the SLOWEST, i.e. it
// flatters exactly the p99 it exists to report.
//
// This file does not test a helper against itself. It drives a REAL Automerge
// sync exchange between two peers, coalescing five emits into one exchange, and
// then runs BOTH instruments over the same received document. The control
// (doc-state) must recover 1; the replacement (change metadata) must recover 5.
// A regression on either side is a regression of the whole bench.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as A from '@automerge/automerge'

import {
  BENCH_KEY,
  collectChangeMetaSamples,
  collectLatencySamples,
  encodeEmitMarker,
} from './diagramPeersCore.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN_ID = 'r1-test-run'

/** Run one sync exchange between two independent peers until both are quiet.
 *  Returns the receiving document; every change emitted by `a` in between rides
 *  in the SAME exchange, which is the coalescing the doc-state scheme loses to. */
function exchange(a, b) {
  let syncA = A.initSyncState()
  let syncB = A.initSyncState()
  let left = a
  let right = b
  for (let round = 0; round < 20; round += 1) {
    const [nsA, msgAB] = A.generateSyncMessage(left, syncA)
    syncA = nsA
    if (msgAB) {
      const [nb, nsB] = A.receiveSyncMessage(right, syncB, msgAB)
      right = nb
      syncB = nsB
    }
    const [nsB2, msgBA] = A.generateSyncMessage(right, syncB)
    syncB = nsB2
    if (msgBA) {
      const [na, nsA2] = A.receiveSyncMessage(left, syncA, msgBA)
      left = na
      syncA = nsA2
    }
    if (!msgAB && !msgBA) break
  }
  return { a: left, b: right }
}

test('change metadata recovers EVERY coalesced emit where document state recovers one', () => {
  // Sender and receiver, already agreeing on a diagram-shaped document.
  let sender = A.change(A.init(), (doc) => {
    doc.layouts = { o0: { position: { x: 0, y: 0 } } }
    doc[BENCH_KEY] = {}
  })
  let receiver = A.load(A.save(sender))
  const watermark = A.getHeads(receiver)
  const senderActor = A.getActorId(sender)

  // Five emits, no sync in between: they will arrive together.
  const emittedAt = []
  for (let seq = 1; seq <= 5; seq += 1) {
    const at = 1_000 + seq
    emittedAt.push(at)
    sender = A.change(
      sender,
      { message: encodeEmitMarker({ runId: RUN_ID, emittedAt: at }) },
      (doc) => {
        doc.layouts.o0.position.x += 1
        // The doc-state control, written exactly the way the shipped harness wrote it.
        doc[BENCH_KEY]['7'] = { run: RUN_ID, seq, emittedAt: at }
      },
    )
  }

  const synced = exchange(sender, receiver)
  receiver = synced.b

  // Control: the shipped doc-state instrument, on the state it actually observes.
  const docState = collectLatencySamples(receiver[BENCH_KEY], {}, 0, 2_000, RUN_ID)
  assert.equal(
    docState.samples.length,
    1,
    'the doc-state instrument recovers only the newest marker — this is the defect being replaced',
  )
  assert.equal(docState.samples[0].latencyMs, 2_000 - 1_005, 'and the one it keeps is the FASTEST')

  // Replacement: change metadata, which the wire carried in full.
  const metas = A.getChangesMetaSince(receiver, watermark)
  const meta = collectChangeMetaSamples(metas, {}, new Set([A.getActorId(receiver)]), 2_000, RUN_ID)
  assert.equal(meta.samples.length, 5, 'every coalesced emit must produce a sample')
  assert.deepEqual(
    meta.samples.map((s) => s.latencyMs).sort((x, y) => x - y),
    emittedAt.map((at) => 2_000 - at).sort((x, y) => x - y),
    'and the SLOW ones are present, not dropped',
  )
  assert.ok(
    meta.samples.every((s) => s.from === senderActor),
    'the emitter is identified by the native change actor, not by a re-invented id',
  )
})

test('a receiver never samples its own emits, and a second pass adds nothing', () => {
  let sender = A.change(A.init(), (doc) => { doc.layouts = { o0: { position: { x: 0, y: 0 } } } })
  let receiver = A.load(A.save(sender))
  const receiverActor = A.getActorId(receiver)
  const watermark = A.getHeads(receiver)

  // Both sides emit; the receiver must count the sender's three and none of its own.
  for (let seq = 1; seq <= 3; seq += 1) {
    sender = A.change(sender, { message: encodeEmitMarker({ runId: RUN_ID, emittedAt: 10 }) },
      (doc) => { doc.layouts.o0.position.x += 1 })
    receiver = A.change(receiver, { message: encodeEmitMarker({ runId: RUN_ID, emittedAt: 10 }) },
      (doc) => { doc.layouts.o0.position.y += 1 })
  }
  const synced = exchange(sender, receiver)
  receiver = synced.b

  const metas = A.getChangesMetaSince(receiver, watermark)
  const first = collectChangeMetaSamples(metas, {}, new Set([receiverActor]), 50, RUN_ID)
  assert.equal(first.samples.length, 3)
  assert.equal(first.skipped.self, 3, 'the receiver own changes are recognised by actor and skipped')

  // Re-running over the SAME metadata (a duplicate change event) must add nothing.
  const second = collectChangeMetaSamples(metas, first.seen, new Set([receiverActor]), 900, RUN_ID)
  assert.equal(second.samples.length, 0, 'a replayed change event must not inflate the sample count')
})

test('a foreign campaign sharing the document contributes no samples', () => {
  let sender = A.change(A.init(), (doc) => { doc.layouts = { o0: { position: { x: 0, y: 0 } } } })
  let receiver = A.load(A.save(sender))
  const watermark = A.getHeads(receiver)

  sender = A.change(sender, { message: encodeEmitMarker({ runId: 'some-other-run', emittedAt: 1 }) },
    (doc) => { doc.layouts.o0.position.x += 1 })
  sender = A.change(sender, { message: 'a human commit message' },
    (doc) => { doc.layouts.o0.position.x += 1 })
  sender = A.change(sender, { message: encodeEmitMarker({ runId: RUN_ID, emittedAt: 1 }) },
    (doc) => { doc.layouts.o0.position.x += 1 })

  receiver = exchange(sender, receiver).b
  const metas = A.getChangesMetaSince(receiver, watermark)
  const result = collectChangeMetaSamples(metas, {}, new Set([A.getActorId(receiver)]), 11, RUN_ID)
  assert.equal(result.samples.length, 1, 'only this campaign marks count')
  assert.equal(result.skipped.foreign, 2)
})

test('the load runner no longer writes the instrument into the document', () => {
  // Not only are the numbers right: `__bench` would add one operation per emit
  // to the journal of the very document whose journal growth is under study.
  const source = readFileSync(join(HERE, '..', 'scripts', 'verify-diagram-peer-load.mjs'), 'utf8')
  // Comments are stripped first, on purpose: naming `__bench` in a docblock is
  // fine; only an executable reference is a regression.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!code.includes('BENCH_KEY'), 'the runner must not import or write the doc-state marker')
  assert.ok(!code.includes('__bench'), 'no document-state instrument may remain in the runner')
  assert.ok(code.includes('getChangesMetaSince'), 'the runner must read latency from change metadata')
  assert.ok(code.includes('encodeEmitMarker'), 'the emit marker must ride on the change, not in the document')
})
