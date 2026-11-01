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
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import * as A from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { NodeWSServerAdapter, WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { WebSocketServer } from 'ws'
import { assertLoadUserEvidence, parseClosedLoadOutput } from './loadUserEvidence.mjs'
import { adoptPersistentWriterActor, loadObjectIds, loadRoundValue, loadConvergenceState, persistentWriterActor, planWriters } from './loadUsersCore.mjs'

async function bounded(promise, ms, label, onTimeout = () => {}) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error(label)) }, ms)
    })])
  } finally { clearTimeout(timer) }
}

/** Real CLI -> Workers -> patched Repos -> authenticated adapter -> TCP server.
 * This small fixture proves generator wiring, not server authorization/SQL or
 * native fleet capacity. No fixture document is injected into a client. */
async function runCliCase({ assignment, abortBarrier = false, writerActors = 'fresh' }) {
  const episodeId = randomUUID()
  const objectPrefix = 'qa-worker-' + episodeId
  const ids = loadObjectIds(2, objectPrefix)
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end('Fixture has no production transport metrics')
  })
  const wss = new WebSocketServer({ server })
  const adapter = new NodeWSServerAdapter(wss)
  const repo = new Repo({ network: [adapter], peerId: 'qa-worker-fixture' })
  const handle = repo.create({ objects: {} })
  const initialHeads = A.getHeads(handle.doc())
  const sockets = new Set()
  const opened = [], closed = []
  let child, exited, joined, stdout = '', stderr = '', barrierError
  let readinessCount = 0, releaseNonce, closeEventObserved = false
  wss.on('connection', (socket, request) => {
    sockets.add(socket)
    opened.push({ cookie: request.headers.cookie, at: Date.now() })
    socket.on('close', code => { sockets.delete(socket); closed.push({ code, at: Date.now() }) })
    socket.on('error', () => {})
  })
  try {
    await bounded(new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    }), 2000, 'fixture listen deadline')
    const port = server.address().port
    const env = {
      ...process.env,
      QA_WS: 'ws://127.0.0.1:' + port + '/automerge',
      QA_API: 'http://127.0.0.1:' + port,
      QA_SESSION_COOKIE: 'qa-worker-fixture=1',
      QA_LOAD_EPISODE_ID: episodeId,
      QA_LOAD_BASELINE_BARRIER_ID: episodeId,
      QA_LOAD_OBJECT_PREFIX: objectPrefix,
    }
    delete env.QA_REQUIRE_TRANSPORT
    delete env.QA_LANDSCAPE_ID
    delete env.QA_VERSION_ID
    child = spawn(process.execPath, [
      fileURLToPath(new URL('./load-users.mjs', import.meta.url)),
      '--root', handle.url, '--users', '3', '--totalUsers', '3',
      '--writers', '2', '--objects', '2', '--rounds', '4',
      '--objectAssignment', assignment, '--writerActors', writerActors,
    ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    // Own the child and observe its real identity before readiness or results.
    const actualPid = child.pid
    exited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    exited.catch(() => {})
    const streams = [child.stdout, child.stderr].map(stream =>
      new Promise(resolve => stream.once('end', resolve)))
    joined = Promise.all([exited, ...streams]).then(([exit]) => exit)
    joined.catch(() => {})
    child.once('close', () => { closeEventObserved = true })
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('message', message => {
      Promise.resolve().then(async () => {
        readinessCount++
        assert.equal(readinessCount, 1)
        assert.equal(message.type, 'load-baseline-ready')
        assert.equal(message.barrierId, episodeId)
        assert.equal(message.users, 3)
        assert.equal(sockets.size, 3, 'three real sockets precede admission')
        assert.deepEqual(A.getHeads(handle.doc()), initialHeads, 'seed and edit await release')
        await delay(75)
        assert.deepEqual(A.getHeads(handle.doc()), initialHeads, 'withheld nonce keeps barrier closed')
        if (abortBarrier) child.disconnect()
        else {
          releaseNonce = randomUUID()
          child.send({ type: 'load-baseline-release', barrierId: episodeId, releaseNonce },
            error => { if (error) { barrierError = error; child.kill() } })
        }
      }).catch(error => { barrierError = error; child.kill() })
    })
    // Join the process exit and both pipe ends; close remains a diagnostic.
    const exit = await bounded(joined, 30_000, 'CLI exit/stream deadline', () => child.kill())
    assert.equal(barrierError, undefined, barrierError?.stack)
    assert.equal(readinessCount, 1)
    assert.equal(sockets.size, 0, 'server observes closure before joined child result')
    assert.equal(opened.length, 3)
    assert.ok(opened.every(entry => entry.cookie === 'qa-worker-fixture=1'))
    assert.equal(closed.length, 3)
    assert.ok(closed.every(entry => entry.code === 1000))
    const closeLines = stdout.split(/\r?\n/).filter(line => line.startsWith('QACLOSE '))
    assert.equal(closeLines.length, 1)
    const closure = JSON.parse(closeLines[0].slice(8))
    assert.equal(closure.pid, actualPid)
    assert.equal(closure.clean, true)
    assert.equal(closure.workers.length, 3)
    for (const worker of closure.workers) {
      assert.equal(worker.exited, true)
      assert.equal(worker.exitCode, 0)
      assert.equal(worker.forced, false)
      assert.equal(worker.shutdown.socketClosed, true)
      assert.equal(worker.shutdown.retryScheduled, false)
    }
    if (abortBarrier) {
      assert.equal(exit.code, 1, stderr)
      assert.equal(exit.signal, null)
      assert.ok(!stdout.includes('QARESULT '))
      assert.match(stderr, /parent disconnected before release/)
      assert.deepEqual(A.getHeads(handle.doc()), initialHeads, 'aborted barrier never seeds or edits')
      return { exit, socketsClosed: 3, workersClosed: 3, closeEventObserved }
    }
    assert.equal(exit.code, 0, stderr)
    assert.equal(exit.signal, null)
    const result = parseClosedLoadOutput(stdout)
    assertLoadUserEvidence(result, { pid: actualPid, ids, episodeId })
    assert.equal(result.fullyConverged, true)
    assert.equal(result.clientsConverged, 3)
    assert.equal(result.baselineBarrier.releaseNonce, releaseNonce)
    assert.equal(result.writesCompleted.length, 8)
    assert.equal(new Set(result.writesCompleted.map(write => write.user + ':' + write.round)).size, 8)
    assert.equal(result.lastWriteCompletedAt, Math.max(...result.writesCompleted.map(write => write.completedAt)))
    assert.ok(result.editCompletedAt - result.lastWriteCompletedAt >= 390, 'last400ms pause retained')
    assert.deepEqual(result.skippedObjectWrites, [])
    assert.equal(result.sampleChangeCounts.length, 3)
    const plan = planWriters({ totalUsers: 3, writers: 2, objectAssignment: assignment, ids })
    const document = handle.doc()
    const truth = loadConvergenceState({ clients: [{ i: 0, objects: document.objects }],
      ids, writersOf: plan.writersOf, expectedRound: loadRoundValue(episodeId, 3) })
    assert.equal(truth.fullyConverged, true, 'actual server received useful fields')
    assert.equal(document.writeBatchIds.length, 9, 'seed plus eight writer changes')
    const fixtureActor = A.decodeChange(A.getAllChanges(document)[0]).actor
    const actors = new Set(A.getAllChanges(document).map(change => A.decodeChange(change).actor))
    actors.delete(fixtureActor)
    const persistent = [0, 1].map(writer => persistentWriterActor(handle.url, writer))
    if (writerActors === 'persistent') {
      assert.deepEqual([...actors].filter(actor => !persistent.includes(actor)), [], 'D61: no writer change under a fresh actor')
      assert.ok(persistent.every(actor => actors.has(actor)), 'D61: both writers wrote under their persistent actor')
      const reported = result.clientIsolation.clients.map(client => client.actorId)
      assert.deepEqual(reported.slice(0, 2), persistent, 'D61 QA: each writer reports its own persistent actor')
      assert.notEqual(reported[2], persistentWriterActor(handle.url, 2), 'D61 QA: a reader keeps a fresh actor')
    } else {
      assert.equal(persistent.filter(actor => actors.has(actor)).length, 0, 'fresh mode never borrows a persistent actor')
    }
    return { exit, socketsClosed: 3, workersClosed: 3, writes: result.writesCompleted.length, closeEventObserved }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    const cleanupErrors = []
    if (exited) {
      try { await bounded(exited, 2000, 'forced child exit deadline') }
      catch (error) { cleanupErrors.push(error) }
    }
    if (joined) {
      try { await bounded(joined, 2000, 'pipe drain deadline') }
      catch (error) { cleanupErrors.push(error) }
      finally { child.stdout.destroy(); child.stderr.destroy() }
    }
    for (const socket of sockets) socket.terminate()
    try {
      await bounded(new Promise(resolve => wss.close(resolve)), 2000, 'fixture WebSocket close deadline')
    } catch (error) { cleanupErrors.push(error) } finally {
      try { repo.networkSubsystem.removeNetworkAdapter(adapter) }
      catch (error) { cleanupErrors.push(error) }
      try { await bounded(repo.shutdown(), 2000, 'fixture Repo shutdown deadline') }
      catch (error) { cleanupErrors.push(error) }
      finally {
        server.closeAllConnections()
        try { await bounded(new Promise(resolve => server.close(resolve)), 2000, 'fixture HTTP close deadline') }
        catch (error) { cleanupErrors.push(error) }
      }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'fixture cleanup failed')
  }
}

for (const assignment of ['per-writer', 'shared']) {
  test('real load-users CLI closes three isolated users after ' + assignment + ' writes',
    { timeout: 40_000 }, async t => {
      t.diagnostic(JSON.stringify(await runCliCase({ assignment })))
    })
}
test('real load-users CLI closes all loaded users when its external barrier is abandoned',
  { timeout: 40_000 }, async t => {
    t.diagnostic(JSON.stringify(await runCliCase({ assignment: 'per-writer', abortBarrier: true })))
  })

test('D61 real load-users CLI writes every writer change under its persistent actor',
  { timeout: 40_000 }, async t => {
    t.diagnostic(JSON.stringify(await runCliCase({ assignment: 'per-writer', writerActors: 'persistent' })))
  })

test('D61 two successive cold Repos keep one writer actor with a continuous sequence through a real server', { timeout: 30_000 }, async () => {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const adapter = new NodeWSServerAdapter(wss)
  const repo = new Repo({ network: [adapter], peerId: 'qa-d61-fixture' })
  const handle = repo.create({ objects: { o: { name: 'seed' } } })
  await bounded(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }), 2000, 'listen')
  const url = 'ws://127.0.0.1:' + server.address().port
  const actor = persistentWriterActor(handle.url, 0)
  try {
    for (let cycle = 1; cycle <= 3; cycle++) {
      const client = new Repo({ network: [new WebSocketClientAdapter(url)] })
      try {
        const cold = await bounded(client.find(handle.url), 10_000, 'cold find ' + cycle)
        await cold.whenReady()
        assert.equal(adoptPersistentWriterActor(cold, handle.url, 0), actor)
        cold.change(doc => { doc.objects.o.u0 = 'cycle-' + cycle })
        await bounded((async () => {
          while (handle.doc().objects.o.u0 !== 'cycle-' + cycle) await delay(20)
        })(), 10_000, 'server receives cycle ' + cycle)
      } finally {
        await client.shutdown()
      }
    }
    const own = A.getAllChanges(handle.doc()).map(change => A.decodeChange(change)).filter(change => change.actor === actor)
    assert.deepEqual(own.map(change => change.seq), [1, 2, 3], 'one actor, sequence continued across three cold Repos')
    assert.equal(new Set(A.getAllChanges(handle.doc()).map(change => A.decodeChange(change).actor)).size, 2, 'fixture plus the one writer actor')
  } finally {
    for (const client of wss.clients) client.terminate()
    await new Promise(resolve => wss.close(resolve))
    repo.networkSubsystem.removeNetworkAdapter(adapter)
    await repo.shutdown()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
