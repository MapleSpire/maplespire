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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LoadUserCohort } from './loadUserCohort.mjs'

// A real Worker exercising the transport contract, deliberately without a Repo.
// SDK and socket behavior are covered separately by real CLI integration cases.
const workerSource = `
import { parentPort, workerData, threadId } from 'node:worker_threads';
const {cohortId,episodeId,user,config} = workerData;
const identity = {cohortId,episodeId,user,threadId,pid:process.pid};
if(config.mode==='startup-error') throw new Error('startup fixture error');
if(config.mode!=='hold-startup') parentPort.postMessage({type:'load-user-ready',protocol:1,...identity});
parentPort.on('message',request=>{
  const reply={type:'load-user-reply',...identity,requestId:request.requestId,
    operation:request.operation,context:request.context,ok:true,result:{closed:true}};
  if(request.operation==='shutdown') {
    parentPort.postMessage(reply);
    if(config.mode==='duplicate-shutdown') parentPort.postMessage(reply);
    parentPort.close(); return;
  }
  if(config.mode==='hold-reply') { Atomics.add(new Int32Array(config.counter),0,1); return; }
  if(config.wrong) reply[config.wrong] = config.wrong==='context' ? {pollId:99} : 'foreign';
  parentPort.postMessage(reply);
});`
const workerUrl = new URL('data:text/javascript,' + encodeURIComponent(workerSource))
const episodeId = '00000000-0000-4000-8000-000000000001'
function make(t, options = {}) {
  const cohort = new LoadUserCohort({ episodeId, workerUrl, readyTimeoutMs: 3_000,
    requestTimeoutMs: 1_000, closeTimeoutMs: 1_000, ...options })
  t.after(() => cohort.close())
  return cohort
}

test('cohort joins distinct real Workers and close is idempotent', { timeout: 10_000 }, async t => {
  const cohort = make(t)
  const first = await cohort.add(25, {})
  const second = await cohort.add(26, {})
  assert.notEqual(first.threadId, second.threadId)
  assert.deepEqual(await cohort.call(first, 'snapshot', { pollId: 3 }), { closed: true })
  const close = cohort.close()
  assert.equal(cohort.close(), close)
  const receipt = await close
  assert.equal(receipt.clean, true)
  assert.ok(receipt.workers.every(worker => worker.exited && worker.exitCode === 0 && !worker.forced))
})

test('real message replies cannot cross user, process, episode, request or poll identities', { timeout: 15_000 }, async t => {
  for (const wrong of ['cohortId', 'episodeId', 'user', 'threadId', 'pid', 'requestId', 'operation', 'context']) {
    const cohort = make(t)
    const user = await cohort.add(0, { wrong })
    await assert.rejects(cohort.call(user, 'snapshot', { pollId: 1 }))
    assert.equal(cohort.signal.aborted, true)
    assert.throws(() => cohort.call(user, 'snapshot', { pollId: 2 }))
    assert.equal((await cohort.close()).clean, false)
  }
})

test('a timed-out request is never replayed and its Worker is joined', { timeout: 10_000 }, async t => {
  const cohort = make(t)
  const counter = new SharedArrayBuffer(4)
  const user = await cohort.add(0, { mode: 'hold-reply', counter })
  await assert.rejects(cohort.call(user, 'write', { round: 0 }, {}, { timeoutMs: 50 }), /not replayed/)
  assert.equal(Atomics.load(new Int32Array(counter), 0), 1, 'the operation really ran before timeout')
  assert.throws(() => cohort.call(user, 'write', { round: 0 }), /not replayed/)
  const close = await cohort.close()
  assert.equal(close.clean, false)
  assert.equal(close.workers[0].forced, true)
  assert.equal(close.workers[0].exited, true)
  assert.equal(Atomics.load(new Int32Array(counter), 0), 1)
})

test('a duplicate after shutdown ACK cannot certify a clean exit-zero Worker', { timeout: 10_000 }, async t => {
  const cohort = make(t)
  await cohort.add(0, { mode: 'duplicate-shutdown' })
  const receipt = await cohort.close()
  assert.equal(receipt.clean, false)
  assert.equal(receipt.workers[0].exitCode, 0)
  assert.match(receipt.workers[0].error, /without an outstanding request/)
})

test('closing during startup rejects admission and joins the partially initialized Worker', { timeout: 10_000 }, async t => {
  const cohort = make(t)
  const admission = cohort.add(0, { mode: 'hold-startup' })
  const rejected = assert.rejects(admission, /closed during admission/)
  const receipt = await cohort.close()
  await rejected
  assert.equal(receipt.clean, false)
  assert.equal(receipt.workers[0].exited, true)
})

test('startup exceptions reject admission and remain failures after cleanup', { timeout: 10_000 }, async t => {
  const cohort = make(t)
  await assert.rejects(cohort.add(0, { mode: 'startup-error' }), /startup fixture error/)
  const receipt = await cohort.close()
  assert.equal(receipt.clean, false)
  assert.equal(receipt.workers[0].exited, true)
})

test('closure cancels an outstanding pacing timer as well as Worker admission', { timeout: 5_000 }, async t => {
  const cohort = make(t)
  const sleeping = cohort.wait(60_000)
  const rejected = assert.rejects(sleeping, error => error.name === 'AbortError')
  assert.equal((await cohort.close()).clean, true)
  await rejected
})
