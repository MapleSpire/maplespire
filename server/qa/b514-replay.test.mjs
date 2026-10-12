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
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import * as A from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { WebSocketServer } from 'ws'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { mergeB514Snapshots, replayB514Snapshots } from './b514-replay.mjs'

const COOKIE = 'session=synthetic-private-replay'
async function until(predicate, timeoutMs = 1500) {
  const started = performance.now()
  while (!predicate() && performance.now() - started < timeoutMs) await delay(5)
  assert.ok(predicate(), 'bounded real transport condition was not observed')
}
function snapshot(handle, author) {
  let doc = A.clone(handle.doc())
  try {
    doc = A.change(doc, draft => {
      draft.objects[author] = { properties: { seq1: `${author}:one`, seq2: `${author}:two` } }
    })
    return { documentId: handle.documentId, targetUrl: handle.url, heads: A.getHeads(doc), bytes: A.save(doc) }
  } finally { A.free(doc) }
}
async function fixture(t, { respond, rejectWebSocket = false, handshakeOnly = false } = {}) {
  const sockets = new Set(), requests = [], upgrades = [], flights = []
  let handle
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const entry = { request, response, body: JSON.parse(Buffer.concat(chunks).toString()) }
      requests.push(entry)
      if (respond) { respond(entry); return }
      // A real Automerge WS exchange plus a synthetic HTTP protocol ACK. This
      // fixture has no PostgreSQL and does not claim database durability.
      const requested = entry.body.documents[0]
      const durable = A.hasHeads(handle.doc(), requested.heads)
      response.setHeader('Connection', 'keep-alive')
      response.end(JSON.stringify({ documents: [{ documentId: requested.documentId, durable }] }))
    } catch { response.destroy() }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ url: request.url, cookie: request.headers.cookie })
    if (rejectWebSocket) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  })
  const repo = new Repo({ network: handshakeOnly ? [] : [new WebSocketServerAdapter(wss)] })
  handle = repo.create({ objects: { seed: { value: 'same-history' } } })
  const snapshots = [snapshot(handle, 'authorA'), snapshot(handle, 'authorB')]
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const options = { snapshots, workspace: { landscapeId: 'fixture-land', versionId: 'fixture-version' },
    baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/automerge`,
    cookie: COOKIE, runId: 'replay-test', readPgBeforeReplayVerified: true,
    timeoutMs: 1500, requestTimeoutMs: 200, shutdownTimeoutMs: 500, pollMs: 10 }
  t.after(async () => {
    await Promise.allSettled(flights)
    for (const socket of wss.clients) socket.terminate()
    for (const socket of sockets) socket.destroy()
    await repo.shutdown()
    await new Promise(resolve => wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })
  return { repo, handle, snapshots, options, requests, upgrades, sockets, wss,
    start(overrides = {}, dependencies = {}) {
      const flight = replayB514Snapshots({ ...options, ...overrides }, dependencies)
      flights.push(flight)
      void flight.catch(() => undefined)
      return flight
    },
    async closed() {
      await until(() => sockets.size === 0 && wss.clients.size === 0)
    },
  }
}

test('merges both author histories with no new change, reuses the document ID, and closes native HTTP/WS after an exact ACK', async t => {
  const f = await fixture(t)
  const result = await f.start()
  await f.closed()
  assert.equal(result.transportsClosed, true)
  assert.equal(result.snapshot.documentId, f.handle.documentId)
  assert.equal(result.snapshot.targetUrl, f.handle.url)
  const doc = A.load(result.snapshot.bytes)
  try {
    for (const author of ['authorA', 'authorB']) {
      assert.equal(doc.objects[author].properties.seq1, `${author}:one`)
      assert.equal(doc.objects[author].properties.seq2, `${author}:two`)
      assert.equal(f.handle.doc().objects[author].properties.seq2, `${author}:two`, 'real server Repo received both histories')
    }
    assert.equal(A.getAllChanges(doc).length, 3, 'one shared base plus two authored changes, no replay change')
    for (const input of f.snapshots) assert.ok(A.hasHeads(doc, input.heads))
    assert.deepEqual(A.getHeads(doc).sort(), result.mergedHeads)
  } finally { A.free(doc) }
  assert.equal(f.upgrades.length, 1, 'one fresh peer, without automatic reconnect')
  assert.equal(f.upgrades[0].cookie, COOKIE)
  const wsUrl = new URL(f.upgrades[0].url, f.options.baseUrl)
  assert.equal(wsUrl.searchParams.get('landscapeId'), 'fixture-land')
  assert.equal(wsUrl.searchParams.get('versionId'), 'fixture-version')
  assert.ok(f.requests.length >= 1)
  for (const { request, body } of f.requests) {
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.cookie, COOKIE)
    assert.equal(request.headers.connection, 'close')
    assert.equal(body.documents.length, 1)
    assert.equal(body.documents[0].documentId, f.handle.documentId)
    assert.deepEqual(body.documents[0].heads, result.mergedHeads)
  }
  const ack = result.ledger.acknowledgements.find(value => value.durable === true)
  assert.ok(ack.ended >= ack.began && ack.closedAt >= ack.ended)
  assert.ok(result.ledger.closedAt >= result.ledger.acknowledgedAt)
  assert.ok(result.ledger.closedAt >= result.ledger.closeBeganAt && result.ledger.closeBeganAt >= result.ledger.acknowledgedAt)
  assert.deepEqual(result.ledger.transport, { tcpRemaining: 0, wsRemaining: 0, requestsRemaining: 0 })
  assert.ok(result.ledger.records.filter(record => record.kind === 'tcp-close').length >= 2, 'native WS and HTTP sockets were both tracked')
  assert.ok(!JSON.stringify(result.ledger).includes(COOKIE))
})

test('refuses replay before the orchestrator authorizes the PostgreSQL read, without starting any peer or HTTP request', async t => {
  const f = await fixture(t)
  for (const value of [undefined, false, 'true', 1]) {
    await assert.rejects(f.start({ readPgBeforeReplayVerified: value }), /PostgreSQL read/)
  }
  assert.equal(f.upgrades.length, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.sockets.size, 0)
})

test('validates target, workspace, endpoints, cookie, timeout and snapshot metadata before I/O', async t => {
  const f = await fixture(t)
  const bad = [
    { workspace: null }, { cookie: '' }, { cookie: 'cookie' + String.fromCharCode(10) + 'header' },
    { baseUrl: 'http://example.com' }, { wsUrl: 'ws://192.0.2.1/automerge' },
    { baseUrl: f.options.baseUrl + '/prefix' }, { wsUrl: f.options.wsUrl + '?landscapeId=foreign' },
    { wsUrl: f.options.wsUrl + '?token=unexpected' }, { timeoutMs: 99 }, { pollMs: 0 },
    { targetUrl: 'automerge:foreign' }, { documentId: 'foreign' },
    { snapshots: [f.snapshots[0]] },
    { snapshots: [f.snapshots[0], { ...f.snapshots[1], targetUrl: f.handle.url + '#changed' }] },
    { snapshots: [f.snapshots[0], { ...f.snapshots[1], documentId: 'different' }] },
    { snapshots: [f.snapshots[0], { ...f.snapshots[1], heads: f.snapshots[0].heads }] },
    { snapshots: [f.snapshots[0], { ...f.snapshots[1], bytes: new Uint8Array([1, 2, 3]) }] },
  ]
  for (const override of bad) await assert.rejects(f.start(override))
  assert.equal(f.requests.length, 0)
  assert.equal(f.upgrades.length, 0)
  assert.equal(f.sockets.size, 0)
})

test('same document ID labels cannot turn unrelated binary histories into a valid replay', async t => {
  const f = await fixture(t)
  const unrelated = A.from({ objects: { unrelated: true } })
  try {
    await assert.rejects(f.start({ snapshots: [f.snapshots[0], {
      ...f.snapshots[1], bytes: A.save(unrelated), heads: A.getHeads(unrelated),
    }] }), /no shared history/)
  } finally { A.free(unrelated) }
  assert.equal(f.upgrades.length, 0)
})

test('a valid false ACK is retained and retried before a later true ACK', async t => {
  let count = 0
  const f = await fixture(t, { respond: ({ response, body }) => {
    response.end(JSON.stringify({ documents: [{ documentId: body.documents[0].documentId, durable: ++count > 1 }] }))
  } })
  const result = await f.start()
  await f.closed()
  assert.equal(result.ledger.acknowledgements[0].durable, false)
  assert.equal(result.ledger.acknowledgements[1].durable, true)
})

for (const [name, makeBody, status] of [
  ['wrong document', () => ({ documents: [{ documentId: 'foreign', durable: true }] }), 200],
  ['missing document', () => ({ documents: [] }), 200],
  ['duplicate documents', id => ({ documents: [{ documentId: id, durable: true }, { documentId: id, durable: true }] }), 200],
  ['nonboolean durable', id => ({ documents: [{ documentId: id, durable: 'true' }] }), 200],
  ['always false', id => ({ documents: [{ documentId: id, durable: false }] }), 200],
  ['HTTP503 with a true body', id => ({ documents: [{ documentId: id, durable: true }] }), 503],
]) {
  test(`${name} is never accepted and closes every real connection`, async t => {
    const f = await fixture(t, { respond: ({ response, body }) => {
      response.statusCode = status
      response.end(JSON.stringify(makeBody(body.documents[0].documentId)))
    } })
    let failure
    await assert.rejects(f.start({ timeoutMs: 200 }), error => { failure = error; return true })
    await f.closed()
    assert.ok(failure.evidence.acknowledgements.length > 0)
    assert.ok(failure.evidence.acknowledgements.every(ack => ack.durable !== true))
    assert.equal(failure.evidence.acknowledgedAt, undefined)
    assert.equal(failure.evidence.transportsClosed, true)
  })
}

test('a real HTTP timeout after partial 200 headers is not an ACK, and both transports close', async t => {
  const f = await fixture(t, { respond: ({ response }) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.flushHeaders()
  } })
  let failure
  await assert.rejects(f.start({ requestTimeoutMs: 100 }), error => { failure = error; return true })
  await f.closed()
  assert.equal(failure.evidence.acknowledgements[0].error, 'timeout')
  assert.equal(failure.evidence.acknowledgements[0].responseStatus, 200)
  assert.equal(failure.evidence.acknowledgements[0].status, null)
  assert.equal(failure.evidence.acknowledgements[0].durable, null)
})

test('oversized streaming HTTP bodies are stopped before their end', async t => {
  const f = await fixture(t, { respond: ({ response }) => { response.writeHead(200); response.write('x'.repeat(64 * 1024 + 1)) } })
  let failure
  await assert.rejects(f.start(), error => { failure = error; return true })
  await f.closed()
  assert.equal(failure.evidence.acknowledgements[0].error, 'body-too-large')
})

test('redirects cannot forward the supplied credential', async t => {
  let hits = 0
  const target = createServer((_request, response) => { hits++; response.end('{}') })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => target.close(resolve)))
  const f = await fixture(t, { respond: ({ response }) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/credential-target` })
    response.end('{}')
  } })
  let failure
  await assert.rejects(f.start(), error => { failure = error; return true })
  await f.closed()
  assert.equal(failure.evidence.acknowledgements[0].error, 'redirect-refused')
  assert.equal(hits, 0)
})

test('a rejected real WebSocket upgrade closes its TCP socket and never sends an ACK request', async t => {
  const f = await fixture(t, { rejectWebSocket: true })
  let failure
  await assert.rejects(f.start(), error => { failure = error; return true })
  await f.closed()
  assert.equal(f.upgrades.length, 1)
  assert.equal(f.requests.length, 0)
  assert.equal(failure.evidence.transportsClosed, true)
})

test('a WebSocket without a peer response is bounded and closes after the replay deadline', async t => {
  const f = await fixture(t, { handshakeOnly: true })
  await assert.rejects(f.start({ timeoutMs: 100 }), /deadline/)
  await f.closed()
  assert.equal(f.requests.length, 0)
})

test('orchestrator abort cancels a live request and closes the real WS before rejecting', async t => {
  const f = await fixture(t, { respond: () => {} })
  const abort = new AbortController()
  const flight = f.start({ signal: abort.signal })
  await until(() => f.requests.length > 0)
  abort.abort()
  await assert.rejects(flight, /orchestrator/)
  await f.closed()
})

test('an already-cancelled replay creates no transport', async t => {
  const f = await fixture(t)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(f.start({ signal: abort.signal }), /cancelled before startup/)
  assert.equal(f.upgrades.length, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.sockets.size, 0)
})

test('malformed JSON cannot become a durable acknowledgement and its socket closes', async t => {
  const f = await fixture(t, { respond: ({ response }) => response.end('{invalid') })
  let failure
  await assert.rejects(f.start(), error => { failure = error; return true })
  await f.closed()
  assert.equal(failure.evidence.acknowledgements[0].error, 'invalid-json')
  assert.equal(failure.evidence.acknowledgements[0].durable, null)
})

test('record writer failure is redacted and cannot leak HTTP/WS transports', async t => {
  const f = await fixture(t)
  let failure
  await assert.rejects(f.start({ onRecord: record => {
    if (record.kind === 'ws-open') throw new Error(COOKIE)
  } }), error => { failure = error; return true })
  await f.closed()
  assert.match(failure.message, /record writer/)
  assert.ok(!JSON.stringify(failure.evidence).includes(COOKIE))
  assert.ok(!failure.message.includes(COOKIE))
})

test('a stuck Repo shutdown rejects within its bound even after a true ACK and closed sockets', async t => {
  const f = await fixture(t)
  let peer, actualShutdown, failure
  try {
    await assert.rejects(f.start({ shutdownTimeoutMs: 30 }, { createRepo: options => {
      peer = new Repo(options)
      actualShutdown = peer.shutdown.bind(peer)
      peer.shutdown = () => new Promise(() => {})
      return peer
    } }), error => { failure = error; return true })
    await f.closed()
    assert.equal(failure.evidence.transportsClosed, false, 'a lifecycle timeout cannot become a successful cleanup')
    assert.ok(failure.evidence.acknowledgements.some(ack => ack.durable === true), 'preserve the ACK despite failed cleanup')
    assert.deepEqual(failure.evidence.transport, { tcpRemaining: 0, wsRemaining: 0, requestsRemaining: 0 })
  } finally { if (peer) { peer.shutdown = actualShutdown; await actualShutdown() } }
})

test('the pure merger owns the bytes and preserves heads without changing its inputs', async t => {
  const f = await fixture(t)
  const before = f.snapshots.map(value => new Uint8Array(value.bytes))
  const merged = mergeB514Snapshots(f.snapshots)
  assert.deepEqual(f.snapshots.map(value => value.bytes), before)
  for (const input of f.snapshots) input.bytes.fill(0)
  const doc = A.load(merged.snapshot.bytes)
  try {
    assert.equal(doc.objects.authorA.properties.seq1, 'authorA:one')
    assert.equal(doc.objects.authorB.properties.seq1, 'authorB:one')
  } finally { A.free(doc) }
  assert.equal(f.upgrades.length, 0)
})
