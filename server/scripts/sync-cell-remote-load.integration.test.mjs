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

// BOTH SIDES ON LOCALHOST: the gate's own `startLoadProcess`, once with local
// children and once through a real agent process
// (`sync-cell-remote-load.mjs --once`), against one fixture sync server. The
// fixture proves the wiring — argv, QA_* environment, IPC barrier, stdout
// records, closure receipt, exit status — not the product's authorisation or
// capacity. The claim under test: every criterion the gate derives from a
// cohort's result comes out the same through either path.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Repo } from '@automerge/automerge-repo'
import { NodeWSServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { WebSocketServer } from 'ws'
import { makeObject } from '../qa/lib.mjs'
import { loadObjectIds } from '../qa/loadUsersCore.mjs'
import { REMOTE_LOAD_SECRET_ENV, startRemoteLoadServer } from './sync-cell-remote-load-core.mjs'
import {
  bindRemoteLoadSession, convergedResult, qualificationObjectPrefix, releaseCohortsIfReady, startLoadProcess,
  summarizeCycleConvergence, writeOverlapsTakeover,
} from './verify-sync-cell-load-soak.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const agentScript = resolve(here, 'sync-cell-remote-load.mjs')
const SECRET = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')

async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url === '/api/ready') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ready":true}'); return }
    response.writeHead(404)
    response.end('fixture has no production transport metrics')
  })
  const wss = new WebSocketServer({ server })
  const adapter = new NodeWSServerAdapter(wss)
  const repo = new Repo({ network: [adapter], peerId: `remote-load-fixture-${randomUUID()}` })
  const sockets = new Set()
  wss.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen) })
  return {
    port: server.address().port, repo, sockets,
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise((r) => wss.close(r))
      try { repo.networkSubsystem.removeNetworkAdapter(adapter) } catch { /* already gone */ }
      await repo.shutdown().catch(() => {})
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

function startAgent(port) {
  const child = spawn(process.execPath, [agentScript, `--connect=127.0.0.1:${port}`, '--once'], {
    env: { ...process.env, [REMOTE_LOAD_SECRET_ENV]: SECRET }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.resume()
  const exited = new Promise((r) => child.once('close', (code, signal) => r({ code, signal })))
  return { child, exited, stderr: () => stderr }
}

const cohorts = [{ index: 0, offset: 0, users: 2 }, { index: 1, offset: 2, users: 2 }]

/** One episode exactly as `runLoadPair` launches it: two partitions × two
 * cohorts behind one barrier, released together, results joined. */
async function runEpisode(fixture, label) {
  const config = {
    host: '127.0.0.1', routerPort: fixture.port, runId: `qa-${label}-${randomUUID().slice(0, 8)}`,
    usersPerWorkspace: 4, clientsPerProcess: 2, rounds: 2, objects: 2, settleMs: 20_000, staggerMs: 10,
    writersPerWorkspace: 2, objectAssignment: 'per-writer', writerActors: 'fresh',
  }
  // The gate seeds the hot objects before load (`resolveLoadTarget`); so does this.
  const targets = [0, 1].map(() => {
    const handle = fixture.repo.create({ objects: {} })
    const ids = loadObjectIds(config.objects, qualificationObjectPrefix(config.runId, handle.url))
    handle.change((document) => { for (const id of ids) document.objects[id] = makeObject(id, { name: `QA load ${id}` }) })
    return handle
  })
  const barrierId = randomUUID()
  const received = []
  const processes = [0, 1].flatMap((partition) => cohorts.map((cohort) => startLoadProcess(config,
    { workspace: { landscapeId: `fixture-${partition}`, versionId: 'v1' } }, targets[partition].url, 'qa-fixture=1',
    `${label} partition ${partition} cohort ${cohort.index}`, 200, partition, cohort, barrierId, (row) => received.push(row))))
  for (const entry of processes) entry.promise.catch(() => {})
  const deadline = Date.now() + 30_000
  let admission = null
  while (!admission) {
    const broken = processes.find((entry) => entry.barrier.error || entry.child.exitCode !== null)
    if (broken) throw broken.barrier.error ?? new Error(`${label}: a cohort exited before admission`)
    if (Date.now() > deadline) throw new Error(`${label}: barrier admission timed out`)
    admission = await releaseCohortsIfReady(barrierId, processes)
    if (!admission) await delay(100)
  }
  const results = await Promise.all(processes.map((entry) => entry.promise))
  return { results, received, barrierId, admission }
}

/** The criteria the gate derives from one cohort result, with the episode id
 * (random per run) and the timings (physical, never equal) taken out. */
function criteria(row, barrierId) {
  const normalized = convergedResult(row)
  const marker = (value) => (typeof value === 'string' ? value.replaceAll(barrierId, 'EPISODE') : value)
  return {
    partition: normalized.partition, cohort: normalized.cohort,
    fullyConverged: normalized.fullyConverged, missingFields: normalized.missingFields, staleFields: normalized.staleFields,
    hotDiverged: normalized.hotDiverged, clientsConverged: normalized.clientsConverged, clientsTotal: normalized.clientsTotal,
    rejectedClientEdits: normalized.rejectedClientEdits, cohortWriters: normalized.cohortWriters,
    hotValues: normalized.hotValues.map(marker),
    localOwnFieldsAfterEdit: normalized.localOwnFieldsAfterEdit.map((entry) => ({ user: entry.user, values: entry.values.map(marker) })),
    writes: normalized.writesCompleted.map((write) => `${write.user}:${write.round}`).sort(),
    episodeIsBarrier: normalized.episodeId === barrierId,
    released: row.baselineBarrier?.barrierId === barrierId,
    exitCode: normalized.childProcess.exitCode, signal: normalized.childProcess.signal,
    networkKeys: Object.keys(normalized.network ?? {}).sort(),
    workerClosureClean: normalized.workerClosure.clean,
  }
}

// Key structure only: how many polls or connection events a cohort recorded is
// physical, not part of the record's shape.
// Object ids carry the run id, which differs per episode by construction.
const objectKey = (key) => key.replace(/^qa-(?:local|remote)-[a-f0-9]{8}-[^-]+-/, 'OBJECT-')
const shape = (value) => (Array.isArray(value) ? (value.length ? [shape(value[0])] : [])
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).map((key) => [objectKey(key), shape(value[key])])
    .sort(([left], [right]) => left.localeCompare(right)))
    : typeof value)

test('the same episode through local children and through a localhost agent yields the same criteria', { timeout: 180_000 }, async (t) => {
  const fixture = await startFixture()
  const server = await startRemoteLoadServer({ bind: '127.0.0.1', port: 0, secret: SECRET,
    router: { host: '127.0.0.1', port: fixture.port }, log: (line) => t.diagnostic(line), clockIntervalMs: 0 })
  const agent = startAgent(server.address.port)
  try {
    bindRemoteLoadSession(null)
    const local = await runEpisode(fixture, 'local')
    const session = await server.waitForAgent(30_000)
    bindRemoteLoadSession(session)
    const remote = await runEpisode(fixture, 'remote')
    bindRemoteLoadSession(null)

    // Every cohort passed the gate's own evidence check (`assertLoadUserEvidence`
    // inside `startLoadProcess` rejects otherwise) and converged.
    const localCriteria = local.results.map((row) => criteria(row, local.barrierId))
    const remoteCriteria = remote.results.map((row) => criteria(row, remote.barrierId))
    assert.ok(localCriteria.every((entry) => entry.fullyConverged && entry.episodeIsBarrier && entry.released))
    assert.deepEqual(remoteCriteria, localCriteria, 'per-cohort criteria')

    // The cycle summary the evaluators threshold, and the provisional results
    // the rehearsal observer receives while the episode runs.
    const cycle = (episode) => summarizeCycleConvergence(episode.results.map(convergedResult))
      .map((entry) => ({ partition: entry.partition, finite: Number.isFinite(entry.convergenceMs) && entry.convergenceMs >= 0 }))
    assert.deepEqual(cycle(remote), cycle(local))
    assert.deepEqual(cycle(local), [{ partition: 0, finite: true }, { partition: 1, finite: true }])
    assert.equal(remote.received.length, local.received.length)
    assert.deepEqual(remote.received.map((row) => `${row.partition}:${row.cohort}`).sort(), local.received.map((row) => `${row.partition}:${row.cohort}`).sort())

    // The same record shape, except the one stamp a remote cohort adds.
    const strip = (row) => ({ ...row, childProcess: { ...row.childProcess, remote: undefined } })
    assert.deepEqual(shape(remote.results.map(strip)), shape(local.results.map(strip)), 'result shape')
    for (const row of local.results) assert.deepEqual(Object.keys(row.childProcess).sort(), ['exitCode', 'pid', 'signal'], 'a local child carries no remote stamp')
    for (const row of remote.results) {
      const stamp = row.childProcess.remote
      assert.equal(stamp.sessionId, session.sessionId)
      assert.equal(stamp.pid, row.clientIsolation.pid, 'the pid the gate checked is the agent child\'s')
      assert.notEqual(stamp.pid, process.pid)
      assert.ok(Number.isFinite(stamp.clockOffsetMs) && Number.isFinite(stamp.clockUncertaintyMs))
      // One host, one clock: the measured offset is within its own uncertainty
      // (plus scheduling slack on a busy runner).
      assert.ok(Math.abs(stamp.clockOffsetMs) <= stamp.clockUncertaintyMs + 5, JSON.stringify(stamp))
    }
    // The cross-clock criterion: a window around partition zero's edits.
    for (const episode of [local, remote]) {
      const writer = episode.results.find((row) => row.partition === 0 && row.cohortWriters > 0)
      const window = { startedAt: writer.editStartedAt - 1_000, completedAt: writer.editCompletedAt + 1_000 }
      assert.equal(writeOverlapsTakeover(writer, window), true)
      assert.equal(writeOverlapsTakeover(writer, { startedAt: writer.editCompletedAt + 5_000, completedAt: writer.editCompletedAt + 6_000 }), false)
    }

    const evidence = await server.close('test done')
    assert.equal(evidence.spawned, 4)
    assert.equal(evidence.lost, null)
    assert.equal(evidence.routerProbe.ok, true)
    assert.equal(evidence.clock.initial.samples, 16)
    assert.equal(evidence.clock.final.label, 'final')
    assert.equal(evidence.agent.address, '127.0.0.1')
    assert.ok(!JSON.stringify(evidence).includes(SECRET))
    const exit = await agent.exited
    assert.deepEqual(exit, { code: 0, signal: null }, agent.stderr())
    assert.ok(!agent.stderr().includes(SECRET), 'the agent never prints the secret')
  } finally {
    bindRemoteLoadSession(null)
    await server.close().catch(() => {})
    if (agent.child.exitCode === null) agent.child.kill('SIGKILL')
    await fixture.close()
  }
})

test('a gate that drops the connection mid-episode stops the agent\'s cohorts; the gate sees a failed cohort', { timeout: 120_000 }, async (t) => {
  const fixture = await startFixture()
  const server = await startRemoteLoadServer({ bind: '127.0.0.1', port: 0, secret: SECRET,
    router: { host: '127.0.0.1', port: fixture.port }, log: (line) => t.diagnostic(line), clockIntervalMs: 0 })
  const agent = startAgent(server.address.port)
  try {
    const session = await server.waitForAgent(30_000)
    bindRemoteLoadSession(session)
    const config = { host: '127.0.0.1', routerPort: fixture.port, runId: 'qa-drop', usersPerWorkspace: 2, clientsPerProcess: 2,
      rounds: 2, objects: 2, settleMs: 20_000, staggerMs: 10, writersPerWorkspace: 2, objectAssignment: 'per-writer', writerActors: 'fresh' }
    const handle = fixture.repo.create({ objects: {} })
    const barrierId = randomUUID()
    const entry = startLoadProcess(config, { workspace: { landscapeId: 'drop', versionId: 'v1' } }, handle.url, 'qa-fixture=1',
      'drop', 200, 0, { index: 0, offset: 0, users: 2 }, barrierId)
    entry.promise.catch(() => {})
    const deadline = Date.now() + 30_000
    while (!entry.barrier.ready && Date.now() < deadline) await delay(50)
    assert.ok(entry.barrier.ready, 'the remote cohort reached the barrier over the control connection')
    assert.equal(fixture.sockets.size, 2, 'its two clients hold real sockets on the fixture')
    // The abandonment path: synchronous, no bye.
    server.destroy()
    await assert.rejects(entry.promise, /remote load|connection|destroyed/)
    assert.equal(entry.child.remoteLost, true)
    const exit = await Promise.race([agent.exited, delay(30_000, 'timeout', { ref: false })])
    assert.notEqual(exit, 'timeout', 'the agent returns once its cohorts are stopped')
    assert.equal(exit.code, 1, agent.stderr())
    assert.match(agent.stderr(), /stopping 1 load cohort/)
    const closed = Date.now() + 10_000
    while (fixture.sockets.size > 0 && Date.now() < closed) await delay(50)
    assert.equal(fixture.sockets.size, 0, 'no client of the stopped cohort is left connected')
  } finally {
    bindRemoteLoadSession(null)
    if (agent.child.exitCode === null) agent.child.kill('SIGKILL')
    await fixture.close()
  }
})
