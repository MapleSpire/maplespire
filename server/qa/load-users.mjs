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

// Multi-user load test: spin up N headless peers (= N concurrent users) that all
// edit the SAME shared objects through the server, then verify everyone converges
// and versions are correct. Each user writes their OWN field on each object
// (u<idx>) plus a contended `hot` field, so a correct CRDT ends with ALL N user
// fields present on every object on every client, and `hot` equal everywhere.
//
// Two PROFILE knobs:
//   --writers W            only users with global index < W write; the others
//                          connect, hold the document and must still converge.
//                          Default: every user writes (the historical shape).
//   --objectAssignment A   `shared` (default): every writer writes every object;
//                          `per-writer`: writer w writes object ids[w % objects]
//                          only, so writers ≤ objects means no contended object.
// Expected fields are derived from these: on object k, every writer whose
// assignment includes k must have u<w> = r<last>; `hot` is compared only on
// objects somebody writes.
//
// Usage: node qa/load-users.mjs [--root <url>] --users 40 --rounds 4
import {
  args, loadRootUrl, mem, t, ms, emit, log, fetchAutomergeStats,
} from './lib.mjs'
import assert from 'node:assert/strict'
import { evaluateLoadUsersResult, loadObjectIds, loadRoundValue, planWriters } from './loadUsersCore.mjs'
import { waitForLoadBarrier } from './loadBarrier.mjs'
import { LoadUserCohort } from './loadUserCohort.mjs'
import { aggregateLoadPoll } from './loadUserSnapshots.mjs'

const o = args({
  users: 40,
  userOffset: 0,
  totalUsers: null,
  rounds: 4,
  objects: 10,
  settle: 6000,
  stagger: 60,
  startDelay: 2000,
  roundDelay: 400,
  maxEventLoopP99: null,
  writers: null,
  objectAssignment: 'shared',
})
const totalUsers = o.totalUsers ?? o.users
if (!Number.isInteger(o.userOffset) || o.userOffset < 0
  || !Number.isInteger(totalUsers) || totalUsers < o.users
  || o.userOffset + o.users > totalUsers) {
  throw new Error('userOffset/users must identify a valid cohort within totalUsers')
}
const writers = o.writers ?? totalUsers
const rootUrl = loadRootUrl(o.root)
const runBatchPrefix = `qa-load-${Date.now()}-${process.pid}-u${o.userOffset}`
const ids = loadObjectIds(o.objects, process.env.QA_LOAD_OBJECT_PREFIX || 'shared-load')
const episodeId = process.env.QA_LOAD_EPISODE_ID || null
const expectedRound = loadRoundValue(episodeId, o.rounds - 1)
// Validated and derived before a single socket opens: a bad profile is a usage
// error, not a converged-to-nothing result.
const plan = planWriters({ totalUsers, writers, objectAssignment: o.objectAssignment, ids })
log(`load test: ${o.users} users × ${o.rounds} rounds on ${o.objects} shared objects (${writers} of ${totalUsers} write, ${o.objectAssignment})`)
const cohort = new LoadUserCohort({ episodeId })
let runError = null
let resultFailures = []
try {
const serverTransportBefore = await fetchAutomergeStats()
const generatorMemory = []
const sampleMemory = phase => generatorMemory.push({ phase, at: Date.now(), rssBytes: process.memoryUsage().rss })
sampleMemory('before-connect')

// Connect users one at a time with a small stagger — connecting many cold peers
// at once makes them race on the initial sync handshake (a peer with no local
// copy yet answers another peer's sync with "unavailable"). Staggering lets each
// receive the doc from the server first.
const users = []
let transientUnavailableRetries = 0
const connectStart = t()
for (let i = 0; i < o.users; i++) {
  // Match the browser's ActiveDocumentShare policy. The performance target is
  // a non-core overlay write-head, so a cold peer must explicitly announce the
  // exact document it is about to request under selective sync.
  // Own partial initialization too, before either add or connect can reject.
  const user = await cohort.add(o.userOffset + i, { rootUrl, ids, totalUsers, writers,
    objectAssignment: o.objectAssignment, rounds: o.rounds, runBatchPrefix })
  // Three 10 s resolution attempts plus retry/cache work must fit inside the
  // transport deadline; the outer fleet-admission deadline remains unchanged.
  const connected = await cohort.call(user, 'connect', { phase: 'connect' }, {}, { timeoutMs: 35_000 })
  assert.equal(connected.documentReady, true)
  assert.equal(connected.user, user.i)
  assert.equal(connected.threadId, user.threadId)
  assert.equal(connected.pid, process.pid)
  assert.ok(typeof connected.peerId === 'string' && connected.peerId.length > 0)
  assert.ok(typeof connected.actorId === 'string' && connected.actorId.length > 0)
  user.identity = connected
  transientUnavailableRetries += connected.unavailableRetries
  users.push(user)
  await cohort.wait(o.stagger)
}
assert.equal(new Set(users.map(user => user.threadId)).size, o.users)
assert.equal(new Set(users.map(user => user.identity.peerId)).size, o.users)
assert.equal(new Set(users.map(user => user.identity.actorId)).size, o.users)
const connectMs = ms(connectStart)
sampleMemory('connected')
await cohort.wait(o.startDelay) // settle all connections / failure-injection arm window
log(`${o.users} users connected in ${connectMs}ms`)
// Active WebSocket counts alone do not prove that the first selective-sync
// document is ready. Multi-cell failure injectors wait for this explicit
// barrier before pausing an owner.
console.log(`QAPHASE ${JSON.stringify({ phase: 'ready-for-failure', users: o.users, connectMs })}`)

let baselineBarrier = null
if (process.env.QA_LOAD_BASELINE_BARRIER_ID) {
  baselineBarrier = await waitForLoadBarrier({
    barrierId: process.env.QA_LOAD_BASELINE_BARRIER_ID,
    users: o.users, userOffset: o.userOffset, totalUsers, signal: cohort.signal,
  })
}

const seeded = await cohort.call(users[0], 'seed', { phase: 'seed' })
const seedStart = t()
function remainingBudget(start, phase) {
  const remaining = o.settle - ms(start)
  if (remaining <= 0) throw new Error(`${phase} exceeded ${o.settle} ms`)
  return remaining
}
async function seedLag() {
  for (const user of users) {
    const state = await cohort.call(user, 'seed-status', { phase: 'seed' }, {},
      { timeoutMs: remainingBudget(seedStart, 'seed') })
    if (state.missing.length) return true
  }
  return false
}
if (seeded.seeded.length > 0) {
  while (await seedLag()) await cohort.wait(Math.min(100, remainingBudget(seedStart, 'seed')))
}
// The assignment — which objects a writer writes, and, per object, which
// writers are expected on it — is `plan`, derived once above so the edit loop,
// the own-field read-back and the convergence check cannot disagree.
const { writesTo, writersOf, expectedUserFieldsPerObject } = plan
const cohortWriters = users.filter((u) => plan.isWriter(u.i))
log(`editing ${ids.length} shared objects — ${cohortWriters.length} writers and ${users.length - cohortWriters.length} readers in this cohort`)

const editStartedAt = Date.now()
const editStart = t()
// A write the Worker cannot place is COUNTED, never just skipped: a client
// whose copy lacks the shared objects would otherwise write changes carrying a
// batch id and no field, and nothing in the result would say why.
const skippedObjectWrites = []
const writesCompleted = []
let lastWriteCompletedAt = null
for (let round = 0; round < o.rounds; round++) {
  // Preserve writer order and roundDelay, without extra pacing. RPC introduces
  // yields between writers, so timing is not identical to a single shared
  // JavaScript task. Keep actual mutation dates.
  for (const u of cohortWriters) {
    const write = await cohort.call(u, 'write', { phase: 'edit', round })
    assert.equal(write.user, u.i)
    assert.equal(write.round, round)
    if (write.completedAt !== null) {
      assert.ok(Number.isSafeInteger(write.startedAt) && Number.isSafeInteger(write.completedAt)
        && write.completedAt >= write.startedAt)
      lastWriteCompletedAt = Math.max(lastWriteCompletedAt ?? 0, write.completedAt)
      writesCompleted.push({ user: u.i, round, startedAt: write.startedAt, completedAt: write.completedAt })
    }
    if (write.skipped) skippedObjectWrites.push(write.skipped)
  }
  sampleMemory(`round-${round}`)
  await cohort.wait(o.roundDelay)
}
const editMs = ms(editStart)
const editCompletedAt = Date.now()
if (skippedObjectWrites.length) {
  log(`${skippedObjectWrites.length} user-rounds skipped writes because the shared objects were absent from the client's copy`)
}
// Writers only: a reader has no own field to read back, and an empty entry
// would be counted as "no refusal" by the gate rather than as "not a writer".
for (const user of cohortWriters) {
  const own = await cohort.call(user, 'own-fields', { phase: 'after-edit' })
  assert.equal(own.user, user.i)
  assert.equal(own.values.length, writesTo(user.i).length)
  user.ownFields = own.values
}
const localOwnFieldsAfterEdit = cohortWriters.map((user) => ({ user: user.i, values: user.ownFields }))

let pollId = 0
const snapshotWindows = []
let finalSnapshots
async function convergenceState() {
  const snapshots = []
  const currentPoll = ++pollId
  for (const user of users) snapshots.push(await cohort.call(user, 'snapshot',
    { phase: 'convergence', pollId: currentPoll }, {},
    { timeoutMs: remainingBudget(convergenceStart, 'convergence') }))
  const poll = aggregateLoadPoll(snapshots, {
    pollId: currentPoll, episodeId, users: users.map(user => user.i), ids, writersOf, expectedRound,
  })
  snapshotWindows.push({ ...poll.window, receivedAt: Date.now() })
  finalSnapshots = snapshots
  return poll
}

// Poll instead of sleeping blindly so the result captures actual convergence
// latency. Every RPC consumes the same --settle deadline; an abandoned request
// fails the instrument and is joined by cleanup, never retried as a new poll.
const convergenceStart = t()
let poll = await convergenceState()
while (!poll.state.fullyConverged && ms(convergenceStart) < o.settle) {
  await cohort.wait(Math.min(100, Math.max(0, o.settle - ms(convergenceStart))))
  if (ms(convergenceStart) >= o.settle) break
  poll = await convergenceState()
}
const convergence = poll.state
const convergenceMs = ms(convergenceStart)
const convergedAt = poll.window.completedAt
sampleMemory('after-convergence')
const serverTransportAfter = await fetchAutomergeStats()
const diagnostics = []
for (const [index, user] of users.entries()) diagnostics.push(await cohort.call(user, 'diagnostics', { phase: 'diagnostics', sampleChanges: index < 3 }))
const sample = diagnostics.slice(0, 3).map(entry => ({ user: entry.user, changes: entry.changes }))
sampleMemory('after-diagnostics')

function transportSummary(before, after) {
  if (!after?.transport) return null
  const previous = before?.transport ?? {}
  const current = after.transport
  const delta = (section, key) => Number(current[section]?.[key] ?? 0) - Number(previous[section]?.[key] ?? 0)
  return {
    activeConnections: Number(current.connections?.active ?? 0),
    peakActiveConnections: Number(current.connections?.peak ?? 0),
    inboundFramesDelta: delta('traffic', 'inboundFrames'),
    outboundFramesDelta: delta('traffic', 'outboundFrames'),
    backpressureDisconnectsDelta: delta('backpressure', 'disconnects'),
    droppedOutboundFramesDelta: delta('traffic', 'outboundDroppedBackpressure'),
    maxRecipientsPerDocument: Number(current.fanoutWindow?.maxRecipientsPerDocument ?? 0),
    eventLoopDelayP99Ms: Number(current.eventLoopDelayMs?.p99 ?? 0),
    rssBytes: Number(current.processMemoryBytes?.rss ?? 0),
  }
}

const result = {
  test: 'load-users',
  episodeId,
  ...(baselineBarrier ? { baselineBarrier } : {}),
  rootUrl,
  users: o.users,
  userOffset: o.userOffset,
  totalUsers,
  writers,
  cohortWriters: cohortWriters.length,
  objectAssignment: o.objectAssignment,
  rounds: o.rounds,
  objectsTested: ids.length,
  connectMs,
  editMs,
  editStartedAt,
  editCompletedAt,
  lastWriteCompletedAt,
  writesCompleted,
  convergedAt,
  expectedUserFieldsPerObject,
  convergenceMs,
  convergenceBudgetMs: o.settle,
  convergedWithinBudget: convergence.fullyConverged && convergenceMs <= o.settle,
  missingFields: convergence.missingFields,
  staleFields: convergence.staleFields,
  hotDiverged: convergence.hotDiverged,
  clientsWithFieldLag: convergence.clientsWithFieldLag,
  clientsWithHotDivergence: convergence.clientsWithHotDivergence,
  clientsConverged: convergence.clientsConverged,
  clientsTotal: o.users,
  transientUnavailableRetries,
  fullyConverged: convergence.fullyConverged,
  hotValues: poll.hotValues,
  sampleChangeCounts: sample,
  localOwnFieldsAfterEdit,
  // One entry per (user, round) whose change carried no field because the
  // client's copy had no such object at that instant — see the edit loop.
  skippedObjectWrites,
  networkDiagnostics: diagnostics.map(entry => ({ user: entry.user, ...entry.network })),
  serverTransport: transportSummary(serverTransportBefore, serverTransportAfter),
  mem: { ...mem(), heapScope: 'coordinator-only', rssScope: 'whole-cohort-process' },
  clientIsolation: { kind: 'worker-per-user', cohortId: cohort.id, pid: process.pid,
    clients: users.map(user => user.identity), objectIds: ids, generatorMemory,
    isolateMemory: diagnostics.map(entry => ({ user: entry.user, ...entry.isolateMemory })),
    writeScheduling: 'sequential-rpc-with-yields', snapshotWindows, finalSnapshots },
}
cohort.check()
emit(result)

resultFailures = evaluateLoadUsersResult(result, {
  requireTransport: process.env.QA_REQUIRE_TRANSPORT === 'on',
  maxEventLoopP99Ms: o.maxEventLoopP99 == null ? null : Number(o.maxEventLoopP99),
})
} catch (error) { runError = error }
finally {
  // A result precedes cleanup. The close receipt and process status must still
  // reject a forced or failed shutdown after a provisional green result.
  const closure = await cohort.close()
  console.log('QACLOSE ' + JSON.stringify(closure))
  if (process.connected) process.disconnect()
  if (!closure.clean) runError ??= new Error('load user Workers did not close cleanly')
}
if (runError) throw runError
if (resultFailures.length > 0) {
  log(`load gate failed: ${resultFailures.join('; ')}`)
  process.exitCode = 1
}
