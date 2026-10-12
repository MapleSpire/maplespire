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
import { once } from 'node:events'
import { Repo } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { WebSocketServer } from 'ws'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { startB514Traffic } from './b514-traffic.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, ms = 3_000) {
  const deadline = performance.now() + ms
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('test witness timed out')
    await sleep(5)
  }
}
function fixture(t, overrides = {}, dependencies = {}) {
  const repo = new Repo()
  const handle = repo.create({ objects: {} })
  let disconnects = 0
  const options = { targetUrl: handle.url, workspace: { landscapeId: 'test-land', versionId: 'test-version' },
    baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/automerge', cookie: 'private-test-cookie=secret',
    runId: 'test', durationMs: 2_000, intervalMs: 10, ackIntervalMs: 10, requestTimeoutMs: 100,
    ...overrides }
  const traffic = startB514Traffic(options, {
    createPeer: () => ({ repo, disconnect() { disconnects += 1 } }),
    fetch: async (_url, request) => {
      const documents = JSON.parse(request.body).documents.map(({ documentId }) => ({ documentId, durable: false }))
      return { status: 200, text: async () => JSON.stringify({ documents }) }
    }, ...dependencies,
  })
  t.after(async () => { await traffic.stop().catch(() => {}); await repo.shutdown() })
  return { repo, handle, options, traffic, disconnects: () => disconnects }
}

test('real local Automerge changes remain unaccepted without durable acknowledgements; stop returns exact replay bytes', async t => {
  const { traffic, disconnects } = fixture(t)
  const admission = await traffic.ready
  assert.equal(traffic.ledger.attempts.length, 0, 'ready precedes the first write')
  await until(() => traffic.ledger.attempts.length >= 4 && traffic.ledger.acknowledgements.length > 0)
  const firstStop = traffic.stop()
  assert.equal(traffic.stop(), firstStop, 'shared stop flight')
  const result = await firstStop
  assert.equal(disconnects(), 1)
  assert.equal(result.transportsClosed, true)
  assert.deepEqual(result.ledger.confirmedSequences, [])
  const loaded = A.load(result.snapshot.bytes)
  for (const attempt of result.ledger.attempts) {
    assert.equal(attempt.outcome, 'locally-changed')
    assert.equal(loaded.objects[admission.objectId].properties[`seq${attempt.seq}`], attempt.marker)
    assert.ok(A.hasHeads(loaded, attempt.heads))
    assert.ok(attempt.completed.monoAt >= attempt.started.monoAt)
  }
  assert.equal(new Set(result.ledger.attempts.map(a => a.marker)).size, result.ledger.attempts.length)
  assert.equal(new Set(result.ledger.attempts.map(a => a.heads.join(','))).size, result.ledger.attempts.length)
  const count = result.ledger.attempts.length
  await sleep(30)
  assert.equal(result.ledger.attempts.length, count)
  assert.equal(result.ledger.reconnect, false)
})

test('only an exact document durable:true response confirms the requested heads and sequences', async t => {
  const requested = []
  const { traffic, handle } = fixture(t, {}, {
    fetch: async (url, request) => {
      assert.equal(url.pathname, '/api/automerge/durable-heads')
      assert.equal(url.searchParams.get('landscapeId'), 'test-land')
      const { documents } = JSON.parse(request.body)
      requested.push(documents)
      assert.equal(documents.length, 1)
      assert.equal(documents[0].documentId, handle.documentId)
      assert.ok(documents[0].heads.every(head => /^[a-f0-9]{64}$/.test(head)))
      return { status: 200, text: async () => JSON.stringify({ documents: [{ documentId: handle.documentId, durable: true }] }) }
    },
  })
  await traffic.ready
  await until(() => traffic.ledger.acknowledgements.some(a => a.durable === true))
  const { ledger } = await traffic.stop()
  assert.ok(requested.length > 0)
  const confirmed = ledger.acknowledgements.filter(a => a.durable === true).flatMap(a => a.sequences)
  assert.deepEqual(ledger.confirmedSequences, [...new Set(confirmed)].sort((a, b) => a - b))
  assert.ok(ledger.confirmedSequences.length > 0)
})

for (const [name, response] of [
  ['foreign document', { status: 200, body: { documents: [{ documentId: 'foreign', durable: true }] } }],
  ['missing document', { status: 200, body: { documents: [] } }],
  ['missing durable flag', { status: 200, body: { documents: [{}] } }],
  ['HTTP503 with misleading body', { status: 503, body: { documents: [{ durable: true }] } }],
]) {
  test(`${name} never confirms local edits`, async t => {
    const { traffic } = fixture(t, {}, { fetch: async () => ({ status: response.status, text: async () => JSON.stringify(response.body) }) })
    await traffic.ready
    await until(() => traffic.ledger.acknowledgements.length > 0)
    const { ledger } = await traffic.stop()
    assert.deepEqual(ledger.confirmedSequences, [])
    assert.equal(ledger.acknowledgements[0].durable, null)
    assert.notEqual(ledger.acknowledgements[0].outcome, 'durable')
  })
}

test('stop aborts pending acknowledgement, records its error without leaking the cookie, and disconnects before shutdown', async t => {
  let started = false, aborted = false
  const { traffic, repo, options, disconnects } = fixture(t, {}, { fetch: (_url, request) => new Promise((_, reject) => {
    started = true
    request.signal.addEventListener('abort', () => { aborted = true; reject(new Error('private-test-cookie=secret')) }, { once: true })
  }) })
  const originalShutdown = repo.shutdown.bind(repo)
  repo.shutdown = async () => { assert.equal(disconnects(), 1); await originalShutdown() }
  await traffic.ready
  await until(() => started)
  const { ledger } = await traffic.stop()
  assert.equal(aborted, true)
  assert.equal(ledger.acknowledgements[0].outcome, 'aborted')
  assert.equal(JSON.stringify(ledger).includes(options.cookie), false)
  assert.deepEqual(ledger.confirmedSequences, [])
})

test('a stuck Repo shutdown rejects within its bound instead of claiming transports and lifecycle are clean', async t => {
  const { traffic, repo } = fixture(t, { shutdownTimeoutMs: 40 })
  const original = repo.shutdown.bind(repo)
  await traffic.ready
  repo.shutdown = () => new Promise(() => {})
  try { await assert.rejects(traffic.stop(), /shutdown timed out/) } finally { repo.shutdown = original }
  await assert.rejects(traffic.done, /shutdown timed out/)
  assert.ok(traffic.ledger.cleanupError)
})

test('a failing record sink rejects done and cleans up the already-created peer', async t => {
  const { traffic, disconnects } = fixture(t, { onRecord: () => { throw new Error('sink is not writable') } })
  await assert.rejects(traffic.done, /record sink failed/)
  assert.equal(disconnects(), 1)
})

test('the configured duration ends traffic and preserves unacknowledged author state without an explicit stop', async t => {
  const { traffic } = fixture(t, { durationMs: 60 })
  await traffic.ready
  const result = await traffic.done
  assert.ok(result.ledger.attempts.length > 0)
  assert.deepEqual(result.ledger.confirmedSequences, [])
  assert.ok(result.snapshot.bytes.byteLength > 0)
  assert.equal(await traffic.stop(), result)
})

test('stop during an unresolved find aborts readiness and drains its setup flight', async t => {
  let findStarted = false, aborted = false, disconnected = false
  const source = new Repo()
  const target = source.create({ objects: {} })
  t.after(() => source.shutdown())
  const traffic = startB514Traffic({ targetUrl: target.url, workspace: { landscapeId: 'land', versionId: 'version' },
    baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/automerge', cookie: 'fixture=private', runId: 'pending' }, {
    createPeer: () => ({
      repo: {
        on() {},
        find(_url, { signal }) {
          findStarted = true
          return new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true }))
        },
        async shutdown() { assert.equal(disconnected, true) },
      },
      disconnect() { disconnected = true },
    }),
  })
  assert.equal(findStarted, true)
  const result = await traffic.stop()
  await assert.rejects(traffic.ready, /could not become ready/)
  assert.equal(aborted, true)
  assert.equal(result.snapshot, null)
  assert.equal(result.ledger.attempts.length, 0)
})

test('two authors on the same history retain distinct objects, nonces and ledgers', async t => {
  const source = new Repo()
  const target = source.create({ objects: {} })
  const bytes = A.save(target.doc())
  const authors = []
  for (const runId of ['author-a', 'author-b']) {
    const repo = new Repo()
    const imported = repo.import(bytes, { docId: target.documentId })
    authors.push(startB514Traffic({ targetUrl: imported.url, workspace: { landscapeId: 'land', versionId: 'version' },
      baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/automerge', cookie: 'fixture=private', runId,
      intervalMs: 10, durationMs: 1_000 }, { createPeer: () => ({ repo, disconnect() {} }) }))
    t.after(() => repo.shutdown())
  }
  t.after(async () => { await Promise.all(authors.map(author => author.stop())); await source.shutdown() })
  await Promise.all(authors.map(author => author.ready))
  await until(() => authors.every(author => author.ledger.attempts.length > 1))
  const stopped = await Promise.all(authors.map(author => author.stop()))
  assert.notEqual(stopped[0].ledger.nonce, stopped[1].ledger.nonce)
  assert.notEqual(stopped[0].ledger.objectId, stopped[1].ledger.objectId)
  const documents = stopped.map(result => A.load(result.snapshot.bytes))
  const merged = A.merge(documents[0], documents[1])
  for (const result of stopped) for (const attempt of result.ledger.attempts) {
    assert.equal(merged.objects[result.ledger.objectId].properties[`seq${attempt.seq}`], attempt.marker)
    assert.ok(A.hasHeads(merged, attempt.heads))
  }
})

test('native HTTP acknowledgement timeout remains an error and its socket is closed by stop', async t => {
  const sockets = new Set()
  let requests = 0
  const server = createServer((_request, _response) => { requests += 1 })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const repo = new Repo()
  const target = repo.create({ objects: {} })
  const traffic = startB514Traffic({ targetUrl: target.url, workspace: { landscapeId: 'land', versionId: 'version' },
    baseUrl: `http://127.0.0.1:${server.address().port}`, wsUrl: 'ws://127.0.0.1:1/automerge',
    cookie: 'fixture=private', runId: 'timeout', durationMs: 2_000, ackIntervalMs: 10, requestTimeoutMs: 100 },
  { createPeer: () => ({ repo, disconnect() {} }) })
  t.after(async () => {
    await traffic.stop().catch(() => {})
    for (const socket of sockets) socket.destroy()
    await repo.shutdown()
    await new Promise(resolve => server.close(resolve))
  })
  await traffic.ready
  await until(() => traffic.ledger.acknowledgements.length > 0)
  assert.ok(requests > 0)
  assert.equal(traffic.ledger.acknowledgements[0].outcome, 'aborted')
  const result = await traffic.stop()
  await until(() => sockets.size === 0)
  assert.deepEqual(result.ledger.confirmedSequences, [])
})

test('invalid workspace URLs are rejected before any network construction', async () => {
  let creates = 0
  const repo = new Repo()
  const handle = repo.create({ objects: {} })
  try {
    assert.throws(() => startB514Traffic({ targetUrl: handle.url, workspace: { landscapeId: 'land', versionId: 'version' },
      baseUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/automerge?landscapeId=foreign', cookie: 'session=private', runId: 'x' },
    { createPeer: () => { creates += 1 } }), /workspace mismatch/)
    assert.equal(creates, 0)
  } finally { await repo.shutdown() }
})

test('real WebSocket Repo and HTTP transports close before stop returns, with no DB or Redis', async t => {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    response.setHeader('Content-Type', 'application/json')
    // This is explicitly a synthetic ACK service, not PostgreSQL durability.
    response.end(JSON.stringify({ documents: body.documents.map(({ documentId }) => ({ documentId, durable: false })) }))
  })
  const wss = new WebSocketServer({ server })
  const serverRepo = new Repo({ network: [new WebSocketServerAdapter(wss)] })
  const root = serverRepo.create({ objects: {} })
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let traffic
  t.after(async () => {
    await traffic?.stop().catch(() => {})
    for (const socket of sockets) socket.destroy()
    await serverRepo.shutdown()
    wss.close()
    await new Promise(resolve => server.close(resolve))
  })
  const port = server.address().port
  traffic = startB514Traffic({ targetUrl: root.url, workspace: { landscapeId: 'local', versionId: 'synthetic' },
    baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/automerge`, cookie: 'fixture=private',
    runId: 'native', intervalMs: 20, ackIntervalMs: 20, durationMs: 2_000 })
  await traffic.ready
  await until(() => traffic.ledger.acknowledgements.length > 0 && traffic.ledger.attempts.length >= 2)
  const beforeDrain = traffic.ledger.attempts.length
  for (const socket of wss.clients) socket.close(1012, 'synthetic ownership loss')
  await until(() => traffic.ledger.records.some(record => record.kind === 'transport-close' && record.code === 1012))
  await until(() => traffic.ledger.attempts.length >= beforeDrain + 3)
  const result = await traffic.stop()
  await until(() => sockets.size === 0)
  assert.equal(result.transportsClosed, true)
  assert.equal(wss.clients.size, 0)
  assert.ok(result.ledger.records.some(record => record.kind === 'transport-open'))
  assert.ok(result.ledger.records.some(record => record.kind === 'transport-close'))
  assert.equal(result.ledger.records.filter(record => record.kind === 'transport-open').length, 1, 'no automatic replay after drain')
  const author = A.load(result.snapshot.bytes)
  for (const attempt of result.ledger.attempts) assert.ok(A.hasHeads(author, attempt.heads))
  assert.deepEqual(result.ledger.confirmedSequences, [])
})

async function barrierFixture(t, { respond, trafficOptions = {} } = {}) {
  const acknowledgements = []
  const sockets = new Set()
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const entry = { body, response, socket: request.socket, arrived: performance.now() }
    acknowledgements.push(entry)
    // Synthetic protocol ACK only: these tests exercise HTTP/WS lifetimes,
    // never claim that this in-memory service proves PostgreSQL durability.
    if (respond) respond(entry)
    else response.end(JSON.stringify({ documents: body.documents.map(({ documentId }) => ({ documentId, durable: true })) }))
  })
  const wss = new WebSocketServer({ server })
  const serverRepo = new Repo({ network: [new WebSocketServerAdapter(wss)] })
  const root = serverRepo.create({ objects: {} })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const traffic = startB514Traffic({ targetUrl: root.url,
    workspace: { landscapeId: 'local', versionId: 'synthetic' },
    baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/automerge`, cookie: 'fixture=private',
    runId: 'barrier', intervalMs: 15, ackIntervalMs: 20, durationMs: 10_000, requestTimeoutMs: 1_000,
    ...trafficOptions })
  t.after(async () => {
    await traffic.stop().catch(() => {})
    for (const socket of sockets) socket.destroy()
    await serverRepo.shutdown()
    wss.close()
    await new Promise(resolve => server.close(resolve))
  })
  await traffic.ready
  return { traffic, root, acknowledgements, wss, sockets }
}

test('manualWrites emits no automatic mutation, sends exactly one requested change, and keeps sealed writes local', async t => {
  const { traffic, root, acknowledgements, wss, sockets } = await barrierFixture(t, {
    trafficOptions: { manualWrites: true, intervalMs: 10 },
  })
  const baselineHeads = A.getHeads(root.doc())
  await sleep(80)
  assert.equal(traffic.ledger.attempts.length, 0, 'no initial or periodic write is armed')
  assert.deepEqual(A.getHeads(root.doc()), baselineHeads)
  assert.equal(acknowledgements.length, 0, 'no ACK is invented for an absent change')
  assert.equal(traffic.ledger.manualWrites, true)
  const first = traffic.writeOnce()
  assert.equal(traffic.ledger.attempts.length, 1, 'one synchronous call records one change')
  assert.equal(first.seq, 1)
  assert.equal(first.marker, `barrier:${traffic.ledger.nonce}:1`)
  assert.equal(first.objectId, traffic.ledger.objectId)
  assert.equal(first.documentId, root.documentId)
  assert.equal(first.outcome, 'locally-changed')
  assert.ok(first.heads.length > 0)
  assert.ok(first.completed.monoAt >= first.started.monoAt)
  await until(() => A.hasHeads(root.doc(), first.heads)
    && traffic.ledger.acknowledgements.some(record => record.durable === true))
  assert.equal(root.doc().objects[first.objectId].properties.seq1, first.marker)
  await sleep(80)
  assert.equal(traffic.ledger.attempts.length, 1, 'writeOnce never schedules its successor')
  assert.deepEqual(Object.keys(root.doc().objects[first.objectId].properties), ['seq1'])
  await traffic.suspendAcknowledgements()
  const ackCount = acknowledgements.length
  const barrier = await traffic.sealOutbound()
  const second = traffic.writeOnce()
  assert.equal(second.seq, 2)
  assert.equal(second.marker, `barrier:${traffic.ledger.nonce}:2`)
  assert.equal(traffic.ledger.attempts.length, 2)
  await until(() => traffic.ledger.records.some(record => record.kind === 'outbound-blocked'))
  await sleep(80)
  assert.equal(traffic.ledger.attempts.length, 2)
  assert.equal(wss.clients.size, 1)
  assert.equal([...wss.clients][0].readyState, 1, 'sealing keeps the real WS open')
  assert.equal(acknowledgements.length, ackCount, 'manual writes cannot restart suspended ACKs')
  assert.equal(root.doc().objects[second.objectId].properties.seq2, undefined)
  assert.equal(A.hasHeads(root.doc(), second.heads), false)
  assert.equal(traffic.ledger.records.some(record => record.kind === 'outbound-send-started'
    && record.outboundOrdinal > barrier.lastAdmittedOrdinal), false)
  first.heads.length = 0
  assert.ok(traffic.ledger.attempts[0].heads.length > 0, 'returned attempt cannot mutate the ledger')
  const result = await traffic.stop()
  assert.throws(() => traffic.writeOnce(), /stopped/)
  await until(() => sockets.size === 0)
  assert.equal(result.transportsClosed, true)
  const author = A.load(result.snapshot.bytes)
  try {
    assert.ok(A.hasHeads(author, second.heads))
    assert.equal(author.objects[second.objectId].properties.seq2, second.marker)
    assert.equal(result.ledger.attempts.length, 2)
  } finally { A.free(author) }
})

test('writeOnce refuses before readiness and immediately after stop without adding a ledger attempt', async t => {
  const { traffic } = fixture(t, { manualWrites: true })
  assert.throws(() => traffic.writeOnce(), /not ready/)
  assert.equal(traffic.ledger.attempts.length, 0)
  await traffic.ready
  const attempt = traffic.writeOnce()
  assert.equal(attempt.seq, 1)
  const stopping = traffic.stop()
  assert.throws(() => traffic.writeOnce(), /stopped/)
  const result = await stopping
  assert.equal(result.ledger.attempts.length, 1)
})

test('manual write callbacks cannot reenter a change with the same sequence', async t => {
  let nestedRefused = false
  const { traffic } = fixture(t, { manualWrites: true, onRecord: record => {
    if (record.kind === 'local-change') {
      assert.throws(() => traffic.writeOnce(), /already in progress/)
      nestedRefused = true
    }
  } })
  await traffic.ready
  traffic.writeOnce()
  assert.equal(nestedRefused, true)
  assert.deepEqual(traffic.ledger.attempts.map(attempt => attempt.seq), [1])
  const result = await traffic.stop()
  assert.equal(result.ledger.attempts.length, 1)
})

test('manualWrites remains duration-bounded without making any automatic change', async t => {
  const { traffic } = fixture(t, { manualWrites: true, durationMs: 40 })
  await traffic.ready
  const result = await traffic.done
  assert.equal(result.ledger.attempts.length, 0)
  assert.throws(() => traffic.writeOnce(), /stopped/)
  assert.equal(result.transportsClosed, true)
})

test('manualWrites requires a boolean before constructing any peer', async () => {
  const repo = new Repo()
  const target = repo.create({ objects: {} })
  let created = false
  try {
    assert.throws(() => startB514Traffic({ targetUrl: target.url,
      workspace: { landscapeId: 'land', versionId: 'version' },
      cookie: 'fixture=private', runId: 'manual-option', manualWrites: 'true' }, {
      createPeer() { created = true },
    }), /invalid manualWrites/)
    assert.equal(created, false)
  } finally { await repo.shutdown() }
})

test('sealing an OPEN WebSocket blocks later author changes without closing it or restarting ACKs', async t => {
  const { traffic, root, acknowledgements, wss, sockets } = await barrierFixture(t)
  await until(() => traffic.ledger.acknowledgements.some(record => record.durable === true))
  const suspension = await traffic.suspendAcknowledgements()
  assert.equal(suspension.qualified, true)
  const ackCount = acknowledgements.length
  const drain = traffic.sealOutbound()
  const sealed = traffic.ledger.records.find(record => record.kind === 'outbound-sealed')
  assert.ok(sealed, 'gate is closed synchronously before sealOutbound returns its promise')
  assert.equal(traffic.sealOutbound(), drain, 'a sealed peer cannot reopen its gate')
  const barrier = await drain
  assert.equal(barrier.qualified, true)
  const postSeal = () => traffic.ledger.attempts.filter(attempt => attempt.started.monoAt > sealed.monoAt)
  await until(() => postSeal().length >= 4 && traffic.ledger.records.some(record => record.kind === 'outbound-blocked'))
  await sleep(60)
  assert.equal(wss.clients.size, 1, 'same socket stays open throughout the gate')
  assert.equal([...wss.clients][0].readyState, 1)
  assert.equal(acknowledgements.length, ackCount, 'ACK scheduler stays suspended')
  for (const attempt of postSeal()) {
    assert.equal(root.doc().objects[attempt.objectId]?.properties[`seq${attempt.seq}`], undefined)
    assert.equal(A.hasHeads(root.doc(), attempt.heads), false)
  }
  const started = traffic.ledger.records.filter(record => record.kind === 'outbound-send-started')
  assert.ok(started.length > 0)
  assert.ok(started.every(record => record.outboundOrdinal <= barrier.lastAdmittedOrdinal && record.monoAt <= sealed.monoAt))
  for (const record of started) {
    assert.match(record.sha256, /^[0-9a-f]{64}$/)
    assert.ok(record.bytes > 0)
    const completed = traffic.ledger.records.find(candidate => candidate.kind === 'outbound-write-completed' && candidate.outboundOrdinal === record.outboundOrdinal)
    assert.ok(completed)
    assert.equal(completed.sha256, record.sha256)
    assert.equal(completed.bytes, record.bytes)
    assert.equal(completed.error, null)
    assert.ok(completed.monoAt >= record.monoAt)
  }
  const result = await traffic.stop()
  await until(() => sockets.size === 0)
  assert.equal(result.transportsClosed, true)
  const author = A.load(result.snapshot.bytes)
  for (const attempt of postSeal()) assert.ok(A.hasHeads(author, attempt.heads))
  A.free(author)
})

test('ACK suspension waits for the real pending HTTP response and socket closure without aborting it', async t => {
  const { traffic, acknowledgements, sockets } = await barrierFixture(t, { respond() {} })
  await until(() => acknowledgements.length === 1)
  let qualified = false
  const suspension = traffic.suspendAcknowledgements().then(result => { qualified = true; return result })
  assert.throws(() => traffic.sealOutbound(), /Suspend and qualify/)
  await sleep(35)
  assert.equal(qualified, false)
  assert.equal(acknowledgements[0].socket.destroyed, false)
  assert.equal(acknowledgements[0].response.destroyed, false)
  assert.equal(acknowledgements.length, 1)
  const sentAt = performance.now()
  acknowledgements[0].response.end(JSON.stringify({ documents: acknowledgements[0].body.documents.map(({ documentId }) => ({ documentId, durable: true })) }))
  const result = await suspension
  assert.equal(result.qualified, true)
  assert.equal(result.pendingAtSuspension, 1)
  assert.equal(result.ackOrdinals.length, 1)
  assert.ok(result.completed.monoAt >= sentAt)
  const ack = traffic.ledger.acknowledgements.find(record => record.ackOrdinal === result.ackOrdinals[0])
  assert.equal(ack.outcome, 'durable')
  assert.ok(result.completed.monoAt >= ack.responded.monoAt)
  await until(() => sockets.size === 1, 1_000) // only the WebSocket remains
  await traffic.sealOutbound()
  await sleep(70)
  assert.equal(acknowledgements.length, 1)
  await traffic.stop()
  await until(() => sockets.size === 0)
})

test('a pending HTTP timeout permanently disqualifies the suspension and never allows outbound sealing', async t => {
  const { traffic, acknowledgements, sockets } = await barrierFixture(t, { respond() {}, trafficOptions: { requestTimeoutMs: 100 } })
  await until(() => acknowledgements.length === 1)
  const suspension = traffic.suspendAcknowledgements()
  assert.equal(traffic.suspendAcknowledgements(), suspension)
  await assert.rejects(suspension, /suspension is unqualified/)
  assert.equal(traffic.ledger.ackSuspension.qualified, false)
  assert.equal(traffic.ledger.acknowledgements[0].outcome, 'aborted')
  assert.throws(() => traffic.sealOutbound(), /Suspend and qualify/)
  await sleep(60)
  assert.equal(acknowledgements.length, 1)
  await traffic.stop()
  await until(() => sockets.size === 0)
})

test('a future reconnect cannot bypass the shared sealed gate, even for its join frame', async t => {
  const { traffic, root, wss, sockets } = await barrierFixture(t, { trafficOptions: { reconnect: true } })
  await until(() => traffic.ledger.acknowledgements.some(record => record.durable === true))
  await traffic.suspendAcknowledgements()
  const barrier = await traffic.sealOutbound()
  for (const socket of wss.clients) socket.close(1012, 'synthetic restart without a real Redis')
  await until(() => traffic.ledger.records.filter(record => record.kind === 'transport-open').length >= 2)
  await until(() => traffic.ledger.records.some(record => record.kind === 'outbound-blocked' && record.socketOrdinal >= 2 && record.messageType === 'join'))
  const later = traffic.ledger.attempts.filter(attempt => attempt.started.monoAt > barrier.sealed.monoAt)
  assert.ok(later.length > 0)
  for (const attempt of later) assert.equal(A.hasHeads(root.doc(), attempt.heads), false)
  assert.equal(traffic.ledger.records.some(record => record.kind === 'outbound-send-started' && record.socketOrdinal >= 2), false)
  await traffic.stop()
  await until(() => sockets.size === 0)
})

test('an unavailable or malformed pending ACK also disqualifies suspension without reopening its scheduler', async t => {
  for (const response of [{ status: 503, body: { documents: [] } }, { status: 200, body: { documents: [{ documentId: 'foreign', durable: true }] } }]) {
    const { traffic, acknowledgements, sockets } = await barrierFixture(t, { respond() {} })
    await until(() => acknowledgements.length === 1)
    const suspension = traffic.suspendAcknowledgements()
    acknowledgements[0].response.statusCode = response.status
    acknowledgements[0].response.end(JSON.stringify(response.body))
    await assert.rejects(suspension, /suspension is unqualified/)
    assert.equal(traffic.ledger.ackSuspension.qualified, false)
    assert.throws(() => traffic.sealOutbound(), /Suspend and qualify/)
    await sleep(40)
    assert.equal(acknowledgements.length, 1)
    await traffic.stop()
    await until(() => sockets.size === 0)
  }
})

test('a timeout completed before suspension cannot be forgotten as an empty pending set', async t => {
  const { traffic, acknowledgements, sockets } = await barrierFixture(t, {
    respond() {}, trafficOptions: { requestTimeoutMs: 100, ackIntervalMs: 300 },
  })
  await until(() => traffic.ledger.acknowledgements.some(record => record.outcome === 'aborted'))
  const suspension = traffic.suspendAcknowledgements()
  await assert.rejects(suspension, /suspension is unqualified/)
  assert.equal(traffic.ledger.ackSuspension.pendingAtSuspension, 0)
  assert.equal(traffic.ledger.ackSuspension.qualified, false)
  assert.throws(() => traffic.sealOutbound(), /Suspend and qualify/)
  assert.equal(acknowledgements.length, 1)
  await traffic.stop()
  await until(() => sockets.size === 0)
})
