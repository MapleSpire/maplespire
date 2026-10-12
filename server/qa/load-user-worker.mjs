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
import { parentPort, threadId, workerData } from 'node:worker_threads'
import { setTimeout as delay } from 'node:timers/promises'
import * as A from '@automerge/automerge'
import { newRepo, makeObject, changeCount } from './lib.mjs'
import { appendOverlayBatchId, loadRoundValue, objectMap, planWriters, resolveLoadHandle } from './loadUsersCore.mjs'
import { projectLoadObjects } from './loadUserSnapshots.mjs'

assert.ok(parentPort, 'load user must run in an owned Worker')
const { cohortId, episodeId, user, config } = workerData
const { rootUrl, ids, totalUsers, writers, objectAssignment, rounds, runBatchPrefix } = config
const plan = planWriters({ totalUsers, writers, objectAssignment, ids })
loadRoundValue(episodeId, rounds - 1)
assert.ok(Number.isSafeInteger(user) && user >= 0 && user < totalUsers)
const identity = { cohortId, episodeId, user, threadId, pid: process.pid }
let repo = null, handle = null, busy = false, closing = false, lastRequestId = 0, nextRound = 0

function requireHandle() {
  if (!handle) throw new Error('user document has not become ready')
  return handle
}

function snapshot(pollId) {
  assert.ok(Number.isSafeInteger(pollId) && pollId >= 0, 'poll identity')
  const startedAt = Date.now()
  const document = requireHandle().doc()
  const objects = projectLoadObjects(document, ids, plan.writersOf)
  const sampledAt = Date.now()
  return { user, episodeId, pollId, startedAt, sampledAt, objects }
}

/** Observe the actual socket before disconnect removes the adapter's listener.
 * Repo shutdown alone and a fixed sleep do not witness the close handshake. */
async function shutdown() {
  closing = true
  if (!repo) return { closed: true, repoCreated: false, socketClosed: true }
  let flushError = null
  try {
    await delay(200)
    await repo.flush?.()
  } catch (error) { flushError = error.message }
  const adapter = repo.__qaNetworkAdapter
  const socket = adapter?.socket
  let removeClose = () => {}
  const socketClose = !socket || socket.readyState === 3
    ? Promise.resolve({ observed: true, code: null, alreadyClosed: true })
    : new Promise(resolve => {
      const onClose = event => resolve({ observed: true, code: event.code, alreadyClosed: false })
      socket.addEventListener('close', onClose, { once: true })
      removeClose = () => socket.removeEventListener('close', onClose)
    })
  try {
    // Removal disconnects once. Repo.shutdown must not disconnect the upstream
    // unauthenticated adapter a second time after its socket was cleared.
    if (adapter) repo.networkSubsystem.removeNetworkAdapter(adapter)
    const closed = await socketClose
    await delay(100)
    await repo.shutdown()
    // Retain the former cohort grace period after all real socket closes.
    await delay(500)
    if (flushError) throw new Error(`Repo flush failed before cleanup: ${flushError}`)
    return { closed: true, repoCreated: true, socketClosed: closed.observed, closeCode: closed.code,
      alreadyClosed: closed.alreadyClosed, retryScheduled: Boolean(adapter?.retryTimer) }
  } finally { removeClose() }
}

async function dispatch(operation, context) {
  if (operation === 'connect') {
    assert.equal(repo, null, 'one cold Repo per user and episode')
    repo = newRepo([rootUrl])
    const pending = resolveLoadHandle(repo, rootUrl, { tries: 3, attemptTimeoutMs: 10_000,
      onRetry: ({ attempt, state }) => console.error(`document retry ${attempt} (${state})`) })
    repo.shareConfigChanged()
    const resolved = await pending
    handle = resolved.handle
    await handle.whenReady()
    return { documentReady: true, unavailableRetries: resolved.unavailableRetries,
      peerId: repo.peerId, actorId: A.getActorId(handle.doc()), ...identity }
  }
  if (operation === 'shutdown') return shutdown()
  const current = requireHandle()
  if (operation === 'seed') {
    const objects = objectMap(current.doc())
    if (!objects) throw new Error('load target is neither a model document nor an object shard')
    const missing = ids.filter(id => !objects[id])
    if (missing.length) current.change(document => {
      const target = objectMap(document)
      if (!target) throw new Error('load target lost its object collection')
      for (const id of missing) target[id] = makeObject(id, { name: `QA load ${id}` })
      appendOverlayBatchId(document, `${runBatchPrefix}-seed`)
    })
    return { seeded: missing }
  }
  if (operation === 'seed-status') {
    const objects = objectMap(current.doc())
    return { missing: ids.filter(id => !objects?.[id]) }
  }
  if (operation === 'write') {
    assert.ok(plan.isWriter(user), 'a reader cannot write')
    assert.equal(context.round, nextRound, 'write rounds must occur once, in order')
    assert.ok(nextRound < rounds)
    const assigned = plan.writesTo(user)
    const missing = []
    const startedAt = Date.now()
    current.change(document => {
      const objects = objectMap(document)
      if (!objects) throw new Error('load target lost its object collection')
      for (const id of assigned) {
        const object = objects[id]
        if (!object) { missing.push(id); continue }
        const value = loadRoundValue(episodeId, context.round)
        object[`u${user}`] = value
        object.hot = `u${user}-${value}`
      }
      appendOverlayBatchId(document, `${runBatchPrefix}-u${user}-r${context.round}`)
    })
    const completedAt = Date.now()
    nextRound++
    return { user, round: context.round, startedAt,
      completedAt: missing.length < assigned.length ? completedAt : null,
      skipped: missing.length ? { user, round: context.round, missingObjects: missing.length,
        objectCount: Object.keys(objectMap(current.doc()) ?? {}).length, changes: changeCount(current) } : null }
  }
  if (operation === 'own-fields') {
    assert.ok(plan.isWriter(user))
    const document = current.doc()
    return { user, values: plan.writesTo(user).map(id => objectMap(document)?.[id]?.[`u${user}`] ?? null) }
  }
  if (operation === 'snapshot') return snapshot(context.pollId)
  if (operation === 'diagnostics') {
    const memory = process.memoryUsage()
    return { user, network: repo.__qaNetworkAdapter?.diagnostics?.() ?? {},
      changes: context.sampleChanges ? changeCount(current) : null,
      isolateMemory: { heapUsed: memory.heapUsed, external: memory.external, arrayBuffers: memory.arrayBuffers } }
  }
  throw new Error(`unknown load user operation: ${operation}`)
}

parentPort.on('message', async request => {
  const reply = { type: 'load-user-reply', ...identity, requestId: request.requestId,
    operation: request.operation, context: request.context }
  if (busy || closing) {
    parentPort.postMessage({ ...reply, ok: false, error: 'overlapping request or closed user' })
    return
  }
  busy = true
  try {
    assert.equal(request.cohortId, cohortId)
    assert.equal(request.episodeId, episodeId)
    assert.equal(request.user, user)
    assert.equal(request.threadId, threadId)
    assert.ok(Number.isSafeInteger(request.requestId) && request.requestId > lastRequestId)
    lastRequestId = request.requestId
    const result = await dispatch(request.operation, request.context)
    parentPort.postMessage({ ...reply, ok: true, result })
  } catch (error) {
    parentPort.postMessage({ ...reply, ok: false, error: error.stack })
  } finally {
    busy = false
    if (closing) parentPort.close()
  }
})
parentPort.postMessage({ type: 'load-user-ready', protocol: 1, ...identity })
