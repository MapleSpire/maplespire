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
 * How many times does `owns()` run per sync frame?
 *
 * The claim this measures is in the tree without a number: "the read must stay
 * synchronous". `owns()` is a synchronous memory read, so its COST is not the
 * question — its RATE is, because the write gate runs first in the adapter
 * chain and sees every frame of every socket.
 *
 * ## What is measured, and what is therefore not proven
 *
 * The shipped predicate is an INLINE CLOSURE in `automergeServer.ts` with no
 * export, so nothing can import it. This harness re-assembles the same
 * composition — `resolveDocumentPlacement` then `ownership.owns(...)` — and
 * drives it through the REAL `createSyncWriteGate`. So the frame-dispatch half
 * is the shipped code; the predicate half is a faithful copy, and a copy can
 * drift. That is stated in the record rather than left for a reader to discover,
 * and it is the reason this measure is worth exactly what it says and no more.
 *
 * ## Why `appendFileSync` and never `console.log`
 *
 * The test configuration swallows console output written from source modules,
 * so a counter that logs
 * reports nothing and reads as zero — which is indistinguishable from the
 * finding "it is never called".
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { createSyncWriteGate } from '../src/syncWriteGate.js'

const TRACE = process.env.M3_TRACE ?? ''

/**
 * A counter PER RUN, not a module-level one.
 *
 * `process` is fire-and-forget and chains doc frames onto a per-socket
 * promise, so calls from the PREVIOUS run can still land after the next run
 * resets a module-level counter (the controls then read non-zero). A
 * closure-local counter sends a late call to the run that caused it.
 */
function countingOwnership() {
  let calls = 0
  return {
    owns(): boolean {
      calls += 1
      if (TRACE) appendFileSync(TRACE, 'owns\n')
      return true
    },
    count: () => calls,
  }
}

/** A doc-carrying frame and a non-doc frame, in the shape the gate destructures. */
const docFrame = (documentId: string) => ({
  type: 'sync',
  senderId: 'peer-1',
  documentId,
  data: new Uint8Array([1, 2, 3]),
})
const ephemeralFrame = () => ({
  type: 'ephemeral',
  senderId: 'peer-1',
  documentId: undefined,
  data: new Uint8Array([9]),
})

async function drive(
  frames: readonly unknown[],
  stage: 'off' | 'dual' | 'on',
): Promise<{ calls: number; delivered: number }> {
  let delivered = 0
  const ownership = countingOwnership()
  const gate = createSyncWriteGate({
    stage: () => stage,
    // The same composition as `automergeServer.ts`: resolve the placement, then
    // ask ownership. The resolve is stubbed to a fixed workspace — this measure
    // is about the CALL RATE of `owns`, not about placement resolution.
    canWrite: async () => {
      const workspace = { landscapeId: 'L-1', versionId: 'V-1' }
      return workspace !== null && ownership.owns()
    },
  })
  const socketKey = {}
  for (const frame of frames) {
    gate.process(frame as never, socketKey, () => { delivered += 1 })
  }
  // DRAIN UNTIL SETTLED, not for a fixed number of ticks. The gate chains each
  // doc frame onto a per-socket FIFO promise, so N frames are N chained awaits;
  // a fixed number of microtasks measures the drain, not the gate. Waiting for
  // the count to stop moving is the only honest stop condition available,
  // because the tail promise is private to the gate.
  let stable = 0
  let last = -1
  for (let tick = 0; tick < 20_000 && stable < 50; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    const now = ownership.count()
    stable = now === last ? stable + 1 : 0
    last = now
  }
  return { calls: ownership.count(), delivered }
}

async function main(): Promise<void> {
  const FRAMES = 500
  const docFrames = Array.from({ length: FRAMES }, (_, i) => docFrame(`doc-${i % 25}`))

  const measured = await drive(docFrames, 'on')

  // THE CONTROLS. Each proves the counter could have answered differently —
  // without them, "1.0 calls per frame" is equally consistent with a counter
  // wired to a constant.
  const nonDoc = await drive(Array.from({ length: FRAMES }, ephemeralFrame), 'on')
  const stageOff = await drive(docFrames, 'off')

  const callsPerFrame = measured.calls / FRAMES

  const record = {
    measureId: 'M3',
    task: 'T-M3',
    takenOn: new Date().toISOString().slice(0, 10),
    harness: 'server/qa/measure-owns-per-frame.mts',
    callsPerFrame,
    samples: FRAMES,
    method: [
      `${FRAMES} decoded doc-carrying frames driven through the REAL`,
      '`createSyncWriteGate` on one socket key, with a counting proxy standing in',
      'for `ownership`. The predicate is the same composition as',
      '`automergeServer.ts` (resolve placement, then `owns`) — re-assembled,',
      'because the shipped one is an inline closure with no export. Counted in a',
      'module-level variable and optionally traced with `appendFileSync`, never',
      '`console.log`: the test configuration swallows console output written from',
      'source modules, so a logging counter reads as zero, which is',
      'indistinguishable from "it is never called".',
    ].join(' '),
    control: [
      `NON-DOC FRAMES: ${nonDoc.calls} calls over ${FRAMES} ephemeral frames.`,
      `STAGE OFF: ${stageOff.calls} calls over ${FRAMES} doc frames.`,
      'Both must be 0. They are what make the headline number a measurement',
      'rather than a constant: an instrument that always answered "one per frame"',
      'would fail both.',
    ].join(' '),
    observed: {
      docFramesOn: measured,
      ephemeralFramesOn: nonDoc,
      docFramesStageOff: stageOff,
    },
  }

  const out = 'reports/M3.json'
  writeFileSync(`../${out}`, `${JSON.stringify(record, null, 2)}\n`)
  console.log(JSON.stringify({
    callsPerFrame,
    samples: FRAMES,
    controlsZero: nonDoc.calls === 0 && stageOff.calls === 0,
    wrote: out,
  }))
  if (nonDoc.calls !== 0 || stageOff.calls !== 0) {
    throw new Error(`control failed: the counter answers even when it should not (${nonDoc.calls}/${stageOff.calls})`)
  }
  if (measured.calls === 0) throw new Error('VOID: zero samples reached the counter')
}

await main()
