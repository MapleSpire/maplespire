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
import {
  appendOverlayBatchId,
  evaluateLoadUsersResult,
  loadObjectIds,
  loadRoundValue,
  loadConvergenceState,
  objectMap,
  percentile,
  planWriters,
  resolveLoadHandle,
} from './loadUsersCore.mjs'
import { requestedDocumentShare } from './lib.mjs'
import {
  closeQaSocket,
} from './authenticatedWebSocketAdapter.mjs'

test('a later episode cannot converge on the previous episode values', () => {
  const previous = '00000000-0000-4000-8000-000000000001'
  const current = '00000000-0000-4000-8000-000000000002'
  const clients = [0, 1].map(i => ({ i, objects: { a: {
    u0: `${previous}:r3`, hot: `u0-${previous}:r3`,
  } } }))
  const state = () => loadConvergenceState({ clients, ids: ['a'], writersOf: { a: [0] }, expectedRound: loadRoundValue(current, 3) })
  assert.equal(state().fullyConverged, false)
  assert.equal(state().staleFields, 2)
  assert.equal(state().hotDiverged, 2)
  for (const client of clients) client.objects.a.u0 = `${current}:r3`
  assert.equal(state().fullyConverged, false, 'equal but old hot values are not fresh')
  for (const client of clients) client.objects.a.hot = `u0-${current}:r3`
  assert.equal(state().fullyConverged, true)
  assert.equal(state().clientsConverged, 2)
})

test('episode and round are validated before opening a transport', () => {
  assert.equal(loadRoundValue(null, 3), 'r3')
  assert.throws(() => loadRoundValue('old-episode', 3), /UUID/)
  assert.throws(() => loadRoundValue(null, -1), /nonnegative/)
})

test('intentional shutdown consumes the ws error raised while connecting', () => {
  let errorListener
  let closed = false
  const socket = {
    readyState: 0,
    once(event, listener) {
      assert.equal(event, 'error')
      errorListener = listener
    },
    close(code, reason) {
      assert.equal(code, 1000)
      assert.equal(reason, 'QA peer shutdown')
      closed = true
      assert.doesNotThrow(() => errorListener(new Error('WebSocket was closed before connection')))
    },
  }

  closeQaSocket(socket)
  assert.equal(closed, true)
})

test('cold selective-sync peers announce only their explicit target', async () => {
  const share = requestedDocumentShare([
    'automerge:requested-head',
    'automerge:requested-with-query?foo=bar',
  ])
  assert.equal(await share.announce('peer', 'requested-head'), true)
  assert.equal(await share.announce('peer', 'requested-with-query'), true)
  assert.equal(await share.announce('peer', 'historical-segment'), false)
  assert.equal(await share.announce('peer', undefined), false)
  assert.equal(await share.access('peer', 'requested-head'), true)
  assert.equal(await share.access('peer', 'historical-segment'), false)
  assert.equal(await share.access('peer', undefined), false)
})

test('supports monolithic and sharded object documents', () => {
  const monolith = { model: { objects: { a: { id: 'a' } } } }
  const shard = { objects: { b: { id: 'b' } } }
  assert.equal(objectMap(monolith).a.id, 'a')
  assert.equal(objectMap(shard).b.id, 'b')
  assert.equal(objectMap({ modelUrl: 'automerge:root' }), null)
})

test('adds stable overlay batch ids to overlay write heads, creating the list the way the client does', () => {
  const overlay = { objects: {}, writeBatchIds: [] }
  assert.equal(appendOverlayBatchId(overlay, 'batch-1'), true)
  assert.equal(appendOverlayBatchId(overlay, 'batch-1'), true)
  assert.deepEqual(overlay.writeBatchIds, ['batch-1'])
  // A head straight out of `createEmptyRoot` — `{ objects: {} }`, no list yet.
  // The client creates the list on its first write; so does this helper —
  // returning false here would send the load gate's seed batch nowhere.
  const fresh = { objects: {} }
  assert.equal(appendOverlayBatchId(fresh, 'batch-2'), true)
  assert.deepEqual(fresh.writeBatchIds, ['batch-2'])
  const freshConnections = { connections: {} }
  assert.equal(appendOverlayBatchId(freshConnections, 'batch-3'), true)
  assert.deepEqual(freshConnections.writeBatchIds, ['batch-3'])
  // Not overlay heads: a monolithic model document and a root. Nothing reads a
  // batch id there, so nothing is written.
  const monolith = { model: { objects: {} } }
  assert.equal(appendOverlayBatchId(monolith, 'batch-4'), false)
  assert.equal('writeBatchIds' in monolith, false)
  assert.equal(appendOverlayBatchId({ modelUrl: 'automerge:root' }, 'batch-5'), false)
  assert.equal(appendOverlayBatchId(null, 'batch-6'), false)
})

test('scopes shared load objects to one qualification run and write head', () => {
  assert.deepEqual(loadObjectIds(3, 'qa-run-head'), [
    'qa-run-head-0',
    'qa-run-head-1',
    'qa-run-head-2',
  ])
})

test('computes an upper-nearest-rank percentile', () => {
  assert.equal(percentile([30, 10, 20, 40], 0.99), 40)
  assert.equal(percentile([30, 10, 20, 40], 0.5), 20)
  assert.equal(percentile([], 0.99), 0)
})

test('retries a transient 2.6 unavailable query by evicting the real Repo cache', async () => {
  const documentId = 'load-root'
  const readyHandle = { documentId }
  let attempts = 0
  const removed = []
  const repo = {
    async find() {
      attempts += 1
      if (attempts === 1) throw new Error(`Document ${documentId} is unavailable`)
      return readyHandle
    },
    findWithProgress() {
      return { peek: () => ({ state: 'unavailable' }) }
    },
    async removeFromCache(id) {
      removed.push(id)
    },
  }

  const result = await resolveLoadHandle(repo, `automerge:${documentId}`, {
    tries: 2,
    delayMs: 0,
  })
  assert.equal(result.handle, readyHandle)
  assert.equal(result.unavailableRetries, 1)
  assert.deepEqual(removed, [documentId])
})

test('does not retry terminal query failures', async () => {
  let removals = 0
  const repo = {
    async find() { throw new Error('storage checksum failure') },
    findWithProgress() {
      return { peek: () => ({ state: 'failed' }) }
    },
    async removeFromCache() { removals += 1 },
  }
  await assert.rejects(resolveLoadHandle(repo, 'automerge:broken', { tries: 3 }), /checksum/)
  assert.equal(removals, 0)
})

test('continues when a 2.6 unavailable rejection has already returned to loading', async () => {
  let attempts = 0
  let removals = 0
  const repo = {
    async find() {
      attempts += 1
      if (attempts === 1) throw new Error('Document reconnecting is unavailable')
      return { documentId: 'reconnecting' }
    },
    findWithProgress() {
      return { peek: () => ({ state: 'loading' }) }
    },
    async removeFromCache() { removals += 1 },
  }
  const result = await resolveLoadHandle(repo, 'automerge:reconnecting', { tries: 2, delayMs: 0 })
  assert.equal(result.unavailableRetries, 1)
  assert.equal(removals, 0)
})

test('bounds a transport query that never settles and retries from a clean cache', async () => {
  let attempts = 0
  const removed = []
  const repo = {
    find() {
      attempts += 1
      return attempts === 1 ? new Promise(() => {}) : Promise.resolve({ documentId: 'bounded' })
    },
    findWithProgress() {
      return { peek: () => ({ state: 'loading' }) }
    },
    async removeFromCache(id) { removed.push(id) },
  }

  const result = await resolveLoadHandle(repo, 'automerge:bounded', {
    tries: 2,
    attemptTimeoutMs: 5,
    delayMs: 0,
  })
  assert.equal(result.handle.documentId, 'bounded')
  assert.equal(result.unavailableRetries, 1)
  assert.deepEqual(removed, ['bounded'])
})

test('reports a deterministic timeout instead of leaving top-level await unsettled', async () => {
  const repo = {
    find: () => new Promise(() => {}),
    findWithProgress: () => ({ peek: () => ({ state: 'loading' }) }),
    removeFromCache: async () => undefined,
  }
  await assert.rejects(
    resolveLoadHandle(repo, 'automerge:never', { tries: 2, attemptTimeoutMs: 2, delayMs: 0 }),
    /resolution timed out/,
  )
})

test('planWriters: the historical shape — every user writes every object — is the default', () => {
  const ids = ['o-0', 'o-1', 'o-2']
  const plan = planWriters({ totalUsers: 4, ids })
  assert.equal(plan.writers, 4)
  assert.equal(plan.objectAssignment, 'shared')
  assert.deepEqual([0, 1, 2, 3].map(plan.isWriter), [true, true, true, true])
  assert.deepEqual(plan.writesTo(3), ids)
  assert.deepEqual(plan.writersOf, { 'o-0': [0, 1, 2, 3], 'o-1': [0, 1, 2, 3], 'o-2': [0, 1, 2, 3] })
  assert.equal(plan.expectedUserFieldsPerObject, 4)
})

test('planWriters: readers write nothing, and per-writer sends each writer to one object', () => {
  const ids = ['o-0', 'o-1', 'o-2']
  const plan = planWriters({ totalUsers: 10, writers: 4, objectAssignment: 'per-writer', ids })
  assert.deepEqual([3, 4, 9].map(plan.isWriter), [true, false, false])
  // MUTANT: make writesTo ignore isWriter and a reader gets an object.
  assert.deepEqual(plan.writesTo(4), [])
  assert.deepEqual(plan.writesTo(0), ['o-0'])
  assert.deepEqual(plan.writesTo(3), ['o-0'], 'writer 3 wraps onto object 0 when writers exceed objects')
  assert.deepEqual(plan.writersOf, { 'o-0': [0, 3], 'o-1': [1], 'o-2': [2] })
  assert.equal(plan.expectedUserFieldsPerObject, 2)
  // Fewer writers than objects leaves objects nobody writes — an empty list,
  // which the convergence check reads as "no hot to compare".
  const sparse = planWriters({ totalUsers: 100, writers: 2, objectAssignment: 'per-writer', ids })
  assert.deepEqual(sparse.writersOf, { 'o-0': [0], 'o-1': [1], 'o-2': [] })
  assert.equal(sparse.expectedUserFieldsPerObject, 1)
  // Shared with a subset of writers: every object expects exactly the writers.
  const shared = planWriters({ totalUsers: 100, writers: 10, objectAssignment: 'shared', ids })
  assert.deepEqual(shared.writersOf['o-2'], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(shared.writesTo(99), [])
})

test('planWriters: an impossible profile is a usage error, not a result', () => {
  const ids = ['o-0']
  assert.throws(() => planWriters({ totalUsers: 4, writers: 5, ids }), /1 to totalUsers/)
  assert.throws(() => planWriters({ totalUsers: 4, writers: 0, ids }), /1 to totalUsers/)
  assert.throws(() => planWriters({ totalUsers: 4, objectAssignment: 'random', ids }), /shared or per-writer/)
  assert.throws(() => planWriters({ totalUsers: 4, ids: [] }), /at least one object/)
  assert.throws(() => planWriters({ totalUsers: 0, ids }), /positive integer/)
})

test('fails convergence, backpressure and missing telemetry explicitly', () => {
  const base = {
    objectsTested: 3,
    fullyConverged: true,
    convergedWithinBudget: true,
    missingFields: 0,
    staleFields: 0,
    hotDiverged: 0,
    serverTransport: {
      backpressureDisconnectsDelta: 0,
      droppedOutboundFramesDelta: 0,
      eventLoopDelayP99Ms: 18,
    },
  }
  assert.deepEqual(evaluateLoadUsersResult(base, { requireTransport: true, maxEventLoopP99Ms: 200 }), [])
  assert.match(evaluateLoadUsersResult({ ...base, fullyConverged: false })[0], /did not converge/)
  assert.match(evaluateLoadUsersResult({ ...base, staleFields: 1 })[0], /stale/)
  assert.match(evaluateLoadUsersResult({ ...base, serverTransport: null }, { requireTransport: true })[0], /required/)
  assert.match(evaluateLoadUsersResult({
    ...base,
    serverTransport: { ...base.serverTransport, backpressureDisconnectsDelta: 1 },
  })[0], /backpressure/)
})
