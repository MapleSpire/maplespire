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
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { waitForLoadBarrier } from './loadBarrier.mjs'

const barrierId = '905876c1-25ef-4114-b79c-41c407b85b73'
const releaseNonce = '58e74e0c-6ae2-4488-bd61-dbc3b0c0c501'
const moduleUrl = new URL('./loadBarrier.mjs', import.meta.url).href

async function childCase(t, onReady, timeoutMs = 150, abort = null) {
  const source = `import { waitForLoadBarrier } from ${JSON.stringify(moduleUrl)};
    const before = Object.fromEntries(['message','disconnect','error'].map(k => [k, process.listenerCount(k)]));
    const controller = new AbortController();
    const abortMode = ${JSON.stringify(abort)};
    if (abortMode === 'before') controller.abort(new Error('cohort failed before release'));
    if (abortMode === 'waiting') setTimeout(() => controller.abort(new Error('cohort failed before release')), 20);
    try {
      const result = await waitForLoadBarrier({ barrierId: ${JSON.stringify(barrierId)}, users:25,userOffset:0,totalUsers:100,timeoutMs:${timeoutMs},signal:controller.signal });
      console.log(JSON.stringify({ result, connected: process.connected, listeners: Object.fromEntries(Object.keys(before).map(k => [k, process.listenerCount(k) - before[k]])) }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = once(child, 'exit')
  const drained = Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')])
  let closeObserved = false
  child.once('close', () => { closeObserved = true })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    await drained
  })
  child.on('message', (message) => onReady(child, message))
  const [code, signal] = await exited
  await drained
  t.diagnostic(JSON.stringify({ childExitCode: code, childSignal: signal, closeObservedAtStreamsDrained: closeObserved }))
  return { code, signal, stdout, stderr, closeObserved }
}

test('native IPC barrier holds the child until the matching release and removes listeners/channel', { timeout: 5_000 }, async (t) => {
  let ready = false
  const result = await childCase(t, (child, message) => {
    assert.equal(message.type, 'load-baseline-ready')
    assert.equal(message.barrierId, barrierId)
    assert.equal(message.users, 25)
    ready = true
    assert.equal(Object.hasOwn(message, 'releaseNonce'), false, 'readiness cannot know the future release nonce')
    child.send({ type: 'load-baseline-release', barrierId, releaseNonce })
  })
  assert.equal(ready, true)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.signal, null)
  const data = JSON.parse(result.stdout)
  assert.equal(data.result.barrierId, barrierId)
  assert.equal(data.result.releaseNonce, releaseNonce)
  assert.ok(Number.isSafeInteger(data.result.releasedAt) && data.result.releasedAt > 0)
  assert.equal(data.connected, false)
  assert.deepEqual(data.listeners, { message: 0, disconnect: 0, error: 0 })
})

test('native IPC barrier rejects a missing, malformed or pre-admission release nonce', { timeout: 5_000 }, async (t) => {
  for (const nonce of [undefined, 'not-a-uuid', barrierId]) {
    const result = await childCase(t, child => child.send({ type: 'load-baseline-release', barrierId, releaseNonce: nonce }))
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.match(result.stderr, /separate UUID nonce/)
    assert.equal(result.stdout, '')
  }
})

test('native IPC barrier rejects a missing release and a foreign episode cannot open it', { timeout: 5_000 }, async (t) => {
  const result = await childCase(t, (child) => child.send({ type: 'load-baseline-release', barrierId: 'another-episode' }), 60)
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.match(result.stderr, /release exceeded 60 ms/)
  assert.equal(result.stdout, '')
})

test('native IPC barrier rejects when the parent disconnects before release', { timeout: 5_000 }, async (t) => {
  const result = await childCase(t, (child) => child.disconnect())
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.match(result.stderr, /parent disconnected before release/)
  assert.equal(result.stdout, '')
})

test('barrier refuses use without a parent IPC connection', async () => {
  await assert.rejects(waitForLoadBarrier({ barrierId, users: 25, userOffset: 0, totalUsers: 100 }), /connected parent IPC channel/)
})

test('a cohort failure aborts native IPC admission before or during the wait', { timeout: 5_000 }, async t => {
  for (const mode of ['before', 'waiting']) {
    let readyCount = 0
    const result = await childCase(t, () => { readyCount++ }, 1_000, mode)
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.match(result.stderr, /cohort failed before release/)
    assert.equal(readyCount, mode === 'before' ? 0 : 1)
  }
})
