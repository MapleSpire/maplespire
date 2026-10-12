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
import { aggregateLoadPoll } from './loadUserSnapshots.mjs'
import { loadRoundValue, planWriters } from './loadUsersCore.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const timestamp = value => Number.isSafeInteger(value) && value > 0

/** Recompute the final predicate from raw per-user observations and bind the
 * close receipt to those exact users. The launching parent supplies the actual
 * child PID and object IDs; a provisional QARESULT is never closure evidence. */
export function assertLoadUserEvidence(result, { pid = result.childProcess?.pid,
  ids = result.clientIsolation?.objectIds, episodeId = result.episodeId } = {}) {
  const isolation = result.clientIsolation
  assert.equal(isolation?.kind, 'worker-per-user', 'per-user isolation evidence missing')
  assert.match(isolation.cohortId, uuid, 'cohort UUID')
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'actual child PID missing')
  assert.equal(isolation.pid, pid, 'cohort process identity')
  assert.equal(result.episodeId, episodeId, 'result episode identity')
  assert.equal(isolation.writeScheduling, 'sequential-rpc-with-yields')
  assert.ok(Number.isSafeInteger(result.users) && result.users > 0)
  assert.deepEqual(isolation.objectIds, ids, 'target object identities')
  assert.equal(ids.length, result.objectsTested)
  const users = Array.from({ length: result.users }, (_, i) => result.userOffset + i)
  const plan = planWriters({ totalUsers: result.totalUsers, writers: result.writers,
    objectAssignment: result.objectAssignment, ids })
  assert.equal(isolation.clients?.length, users.length, 'complete Worker admission')
  for (const [index, client] of isolation.clients.entries()) {
    assert.equal(client.user, users[index], 'admitted user identity/order')
    assert.equal(client.pid, pid)
    assert.equal(client.episodeId, episodeId)
    assert.equal(client.cohortId, isolation.cohortId)
    assert.equal(client.documentReady, true)
    assert.ok(Number.isSafeInteger(client.threadId) && client.threadId > 0)
    for (const field of ['peerId', 'actorId']) assert.ok(typeof client[field] === 'string' && client[field].length > 0)
  }
  for (const field of ['threadId', 'peerId', 'actorId']) {
    assert.equal(new Set(isolation.clients.map(client => client[field])).size, users.length, `distinct ${field}`)
  }
  const windows = isolation.snapshotWindows
  assert.ok(Array.isArray(windows) && windows.length > 0, 'snapshot windows missing')
  let previous = result.editCompletedAt
  for (const [index, window] of windows.entries()) {
    assert.equal(window.pollId, index + 1, 'poll sequence')
    assert.equal(window.clients, users.length)
    assert.equal(window.freshEpisode, episodeId !== null)
    assert.ok([window.startedAt, window.completedAt, window.receivedAt].every(timestamp)
      && window.startedAt >= previous && window.completedAt >= window.startedAt
      && window.receivedAt >= window.completedAt, 'poll interval/receipt order')
    if (index < windows.length - 1) assert.equal(window.fullyConverged, false, 'polling continued after convergence')
    previous = window.receivedAt
  }
  const final = windows.at(-1)
  const poll = aggregateLoadPoll(isolation.finalSnapshots, { pollId: final.pollId, episodeId,
    users, ids, writersOf: plan.writersOf, expectedRound: loadRoundValue(episodeId, result.rounds - 1) })
  const { receivedAt: _receivedAt, ...measuredWindow } = final
  assert.deepEqual(measuredWindow, poll.window, 'window must derive from actual snapshots')
  for (const field of ['fullyConverged', 'missingFields', 'staleFields', 'hotDiverged', 'clientsConverged']) {
    assert.equal(result[field], poll.state[field], `raw snapshot predicate: ${field}`)
  }
  assert.deepEqual(result.hotValues, poll.hotValues, 'raw snapshot hot values')
  assert.equal(result.convergedAt, poll.window.completedAt, 'convergence must use snapshot end, not RPC arrival')
  for (const write of result.writesCompleted) {
    assert.ok(timestamp(write.startedAt) && timestamp(write.completedAt)
      && write.startedAt >= result.editStartedAt && write.completedAt >= write.startedAt
      && write.completedAt <= result.editCompletedAt, 'actual mutation interval')
  }
  const close = result.workerClosure
  assert.equal(close?.cohortId, isolation.cohortId, 'close cohort identity')
  assert.equal(close.episodeId, episodeId)
  assert.equal(close.pid, pid)
  assert.equal(close.clean, true, 'Workers did not close cleanly')
  assert.ok(timestamp(close.startedAt) && close.startedAt >= final.receivedAt
    && timestamp(close.completedAt) && close.completedAt >= close.startedAt, 'closure interval')
  assert.equal(close.workers?.length, users.length, 'complete Worker closure')
  for (const [index, worker] of close.workers.entries()) {
    assert.equal(worker.user, users[index])
    assert.equal(worker.threadId, isolation.clients[index].threadId)
    assert.equal(worker.exited, true)
    assert.equal(worker.exitCode, 0)
    assert.equal(worker.forced, false)
    assert.equal(worker.error, null)
    assert.equal(worker.shutdown?.closed, true)
    assert.equal(worker.shutdown.repoCreated, true)
    assert.equal(worker.shutdown.socketClosed, true)
    assert.equal(worker.shutdown.retryScheduled, false)
  }
}

/** Exactly one result followed by one joined-close receipt is required. */
export function parseClosedLoadOutput(stdout) {
  const records = stdout.split(/\r?\n/).filter(line => /^(QARESULT|QACLOSE) /.test(line))
  assert.equal(records.length, 2, 'one QARESULT and one QACLOSE required')
  assert.ok(records[0].startsWith('QARESULT ') && records[1].startsWith('QACLOSE '), 'result must precede closure')
  return { ...JSON.parse(records[0].slice(9)), workerClosure: JSON.parse(records[1].slice(8)) }
}
