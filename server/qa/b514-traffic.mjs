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

import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import WebSocket from 'ws'
import * as A from '@automerge/automerge'
import { Repo, isValidAutomergeUrl, isValidDocumentId } from '@automerge/automerge-repo'
import { cbor } from '@automerge/automerge-repo/slim'
import { AuthenticatedWebSocketClientAdapter } from './authenticatedWebSocketAdapter.mjs'
import { makeObject, requestedDocumentShare } from './lib.mjs'
import { appendOverlayBatchId, objectMap } from './loadUsersCore.mjs'

const publicError = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null })
const stamp = () => ({ monoAt: performance.now(), wallAt: Date.now() })
function integer(value, fallback, min, max, label) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`invalid ${label}`)
  return result
}
function endpoint(value, protocols, label) {
  let url
  try { url = new URL(value) } catch { throw new Error(`invalid ${label}`) }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`invalid ${label}`)
  return url
}
function bounded(promise, timeoutMs, label, onTimeout = () => {}) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout(); reject(new Error(`${label} timed out`)) }, timeoutMs)
  })]).finally(() => clearTimeout(timer))
}

// A dedicated, non-pooled HTTP connection. Settle only after its socket closes:
// stop() must not leave even the acknowledgement transport behind a cold check.
function requestAcknowledgement(url, options) {
  return new Promise((resolve, reject) => {
    let socket, response, body = '', failure, ended = false, settled = false
    const finish = () => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', abort)
      if (failure || !ended) reject(failure ?? new Error('incomplete acknowledgement'))
      else resolve({ status: response.statusCode, text: async () => body })
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST', agent: false, headers: { ...options.headers, Connection: 'close' },
    }, incoming => {
      response = incoming
      incoming.setEncoding('utf8')
      incoming.on('data', chunk => {
        body += chunk
        if (Buffer.byteLength(body) > 64 * 1024) {
          failure = new Error('durable acknowledgement body too large')
          request.destroy(failure)
        }
      })
      incoming.once('end', () => { ended = true })
      incoming.once('error', error => { failure ??= error })
    })
    const abort = () => {
      failure ??= new Error('durable acknowledgement aborted')
      request.destroy(failure)
    }
    request.once('socket', value => { socket = value; socket.once('close', finish) })
    request.once('error', error => { failure ??= error; if (!socket) finish() })
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
    request.end(options.body)
  })
}

function createPeer({ targetUrl, wsUrl, cookie, reconnect, record }) {
  const sockets = new Set()
  const sends = new Map()
  const sendFailures = []
  let socketOrdinal = 0, outboundOrdinal = 0, lastAdmittedOrdinal = null
  let outboundSealed = false, outboundSealFlight
  class TrackedSocket extends WebSocket {
    constructor(url, options) {
      super(url, options)
      this.b514SocketOrdinal = ++socketOrdinal
      sockets.add(this)
      this.on('open', () => record({ kind: 'transport-open', socketOrdinal: this.b514SocketOrdinal, ...stamp() }))
      this.on('error', error => record({ kind: 'transport-error', ...stamp(), error: publicError(error) }))
      this.on('close', code => {
        sockets.delete(this)
        record({ kind: 'transport-close', ...stamp(), code })
      })
    }

    send(data, ...args) {
      const callback = typeof args.at(-1) === 'function' ? args.pop() : null
      const bytes = typeof data === 'string' ? Buffer.from(data)
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data)
      // Hash the exact application payload handed to ws, copied before an async
      // compression/write could observe its caller mutating the original bytes.
      const info = { outboundOrdinal: ++outboundOrdinal, socketOrdinal: this.b514SocketOrdinal,
        bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
        messageType: null, documentId: null }
      try {
        const message = cbor.decode(new Uint8Array(bytes))
        if (typeof message?.type === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(message.type)) info.messageType = message.type
        if (isValidDocumentId(message?.documentId)) info.documentId = message.documentId
      } catch { /* Non-CBOR payloads retain only their size and fingerprint. */ }
      if (outboundSealed) {
        record({ kind: 'outbound-blocked', ...info, ...stamp() })
        // No super.send, no queue to reopen later. An optional ws callback must
        // not mistake a deliberately blocked frame for a successful write.
        if (callback) queueMicrotask(() => callback(new Error('B5.14 outbound is sealed')))
        return
      }
      lastAdmittedOrdinal = info.outboundOrdinal
      let resolveWrite, settled = false
      const write = new Promise(resolve => { resolveWrite = resolve })
      sends.set(info.outboundOrdinal, write)
      const complete = error => {
        if (settled) return
        settled = true
        const result = { kind: 'outbound-write-completed', ...info, ...stamp(), error: error ? publicError(error) : null }
        if (error) sendFailures.push(result)
        sends.delete(info.outboundOrdinal)
        record(result)
        resolveWrite(result)
        callback?.(error)
      }
      // This is an invocation of super.send, followed by its actual callback.
      // Neither event claims that the server received or accepted the mutation.
      const departed = stamp()
      // No record callback between the gate check and super.send: a caller may
      // seal in onRecord itself. Publish the already-admitted call afterwards.
      try { super.send(typeof data === 'string' ? data : bytes, ...args, complete) }
      catch (error) {
        record({ kind: 'outbound-send-started', ...info, ...departed })
        complete(error)
        throw error
      }
      record({ kind: 'outbound-send-started', ...info, ...departed })
    }
  }
  const adapter = new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, reconnect ? 500 : 0, TrackedSocket)
  // The tracked socket records a redacted error; do not print an arbitrary
  // remote error string through the shared adapter's console handler.
  adapter.onError = () => {}
  let repo
  try {
    repo = new Repo({ network: [adapter], shareConfig: requestedDocumentShare([targetUrl]) })
  } catch (error) {
    adapter.disconnect()
    for (const socket of sockets) socket.terminate()
    throw error
  }
  return {
    repo,
    sealOutbound() {
      if (outboundSealFlight) return outboundSealFlight
      // A closure shared by ALL current and future TrackedSockets, including
      // an already-scheduled reconnect. This assignment precedes every await.
      outboundSealed = true
      const sealed = stamp()
      const pendingOrdinals = [...sends.keys()]
      record({ kind: 'outbound-sealed', ...sealed, scope: 'application-data', lastAdmittedOrdinal, pendingOrdinals })
      outboundSealFlight = Promise.all([...sends.values()]).then(() => {
        if (sendFailures.length) throw new Error('B5.14 outbound write did not complete successfully')
        const drained = stamp()
        record({ kind: 'outbound-drained', ...drained, lastAdmittedOrdinal })
        return { sealed, drained, scope: 'application-data', lastAdmittedOrdinal, pendingOrdinals, qualified: true }
      })
      return outboundSealFlight
    },
    disconnect() {
      // Install close listeners BEFORE disconnect detaches adapter listeners.
      const closed = [...sockets].map(socket => new Promise(resolve => {
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return }
        socket.once('close', resolve)
      }))
      const errors = []
      const adapters = new Set([adapter, ...repo.networkSubsystem.adapters])
      for (const current of adapters) {
        try { current.disconnect() } catch (error) { errors.push(error) }
      }
      for (const socket of sockets) {
        try { socket.terminate() } catch (error) { errors.push(error) }
      }
      return Promise.all(closed).then(() => {
        if (errors.length) throw new AggregateError(errors, 'transport disconnect failed')
      })
    },
  }
}

/**
 * Starts one bounded, in-memory author on an EXISTING mapped model/overlay.
 * Importing this module starts nothing. ready precedes the first local edit.
 * done settles after automatic duration expiry or explicit stop(). A successful
 * stop returns the exact local snapshot, for replay ONLY AFTER the orchestrator
 * has independently checked PostgreSQL without any client reinjection.
 *
 * Before a fault: await suspendAcknowledgements(), then await sealOutbound().
 * sealOutbound closes the send gate SYNCHRONOUSLY on invocation and waits only
 * for writes already admitted to ws. The gate and ACK suspension never reopen.
 * WS control frames (ping/pong/close) are not document emissions and stay live.
 * Old sync state may have advanced past blocked frames: replay the exported
 * snapshot in a NEW peer after the independent PostgreSQL check.
 * manualWrites:true arms no write timer. After ready, writeOnce() makes one
 * synchronous local change and returns its ledger entry; it never schedules
 * another write. ACK scheduling and the total duration remain unchanged.
 *
 * dependencies are test seams; production uses a real Repo/WS and native HTTP.
 */
export function startB514Traffic(options, dependencies = {}) {
  const targetUrl = options.targetUrl ?? options.rootUrl
  if (typeof targetUrl !== 'string' || !isValidAutomergeUrl(targetUrl)) throw new Error('invalid targetUrl')
  const { landscapeId, versionId } = options.workspace ?? {}
  if (![landscapeId, versionId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('workspace is required')
  if (typeof options.cookie !== 'string' || !options.cookie || /[\r\n]/.test(options.cookie)) throw new Error('one cookie header is required')
  if (typeof options.runId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(options.runId)) throw new Error('invalid runId')
  if (options.reconnect !== undefined && typeof options.reconnect !== 'boolean') throw new Error('invalid reconnect')
  if (options.manualWrites !== undefined && typeof options.manualWrites !== 'boolean') throw new Error('invalid manualWrites')
  if (options.onRecord !== undefined && typeof options.onRecord !== 'function') throw new Error('invalid onRecord')
  const base = endpoint(options.baseUrl, ['http:', 'https:'], 'baseUrl')
  if (base.search || base.pathname !== '/') throw new Error('baseUrl must be an origin')
  const ws = endpoint(options.wsUrl, ['ws:', 'wss:'], 'wsUrl')
  for (const [key, value] of Object.entries({ landscapeId, versionId })) {
    if (ws.searchParams.has(key) && ws.searchParams.get(key) !== value) throw new Error('WebSocket workspace mismatch')
    ws.searchParams.set(key, value)
  }
  if ([...ws.searchParams.keys()].some(key => !['landscapeId', 'versionId'].includes(key))) throw new Error('unexpected WebSocket query parameter')
  const intervalMs = integer(options.intervalMs, 100, 10, 10_000, 'intervalMs')
  const manualWrites = options.manualWrites ?? false
  const durationMs = integer(options.durationMs, 30_000, 1, 300_000, 'durationMs')
  if (!manualWrites && Math.ceil(durationMs / intervalMs) > 5_000) throw new Error('traffic exceeds 5000 attempts')
  const ackIntervalMs = integer(options.ackIntervalMs, 250, 10, 10_000, 'ackIntervalMs')
  const requestTimeoutMs = integer(options.requestTimeoutMs, 5_000, 100, 30_000, 'requestTimeoutMs')
  const shutdownTimeoutMs = integer(options.shutdownTimeoutMs, 3_000, 10, 30_000, 'shutdownTimeoutMs')
  const readyTimeoutMs = integer(options.readyTimeoutMs, 20_000, 100, 60_000, 'readyTimeoutMs')
  const nonce = randomUUID()
  const objectId = `b514-${nonce}`
  const ledger = { schemaVersion: 1, runId: options.runId, nonce, objectId, targetUrl,
    reconnect: options.reconnect ?? false, manualWrites, started: stamp(), records: [], attempts: [], acknowledgements: [] }
  let peer, handle, setupFlight, stopped = false, stopFlight, fatal = null, writeTimer, ackTimer, durationTimer
  let writeInProgress = false
  let readyResolve, readyReject, doneResolve, doneReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject })
  // Internal observers prevent an automatic failure becoming unhandled before
  // the caller reaches done; the original promises still reject for the caller.
  void ready.catch(() => {})
  void done.catch(() => {})
  const setupAbort = new AbortController()
  const requests = new Set()
  const pending = new Set()
  const confirmed = new Set()
  let ackOrdinal = 0, acknowledgementsSuspended = false, ackSuspensionQualified = false
  let ackSuspensionFlight, outboundSealFlight
  const emit = record => {
    const entry = structuredClone({ runId: options.runId, ...record })
    ledger.records.push(entry)
    try { options.onRecord?.(structuredClone(entry)) } catch {
      fatal ??= new Error('traffic record sink failed')
      queueMicrotask(() => { void stop().catch(() => {}) })
    }
    return entry
  }
  const fail = (where, error) => {
    fatal ??= new Error(`B5.14 traffic ${where} failed`)
    emit({ kind: 'instrument-error', where, ...stamp(), error: publicError(error) })
    void stop().catch(() => {})
  }
  const ackUrl = new URL('/api/automerge/durable-heads', base)
  ackUrl.search = new URLSearchParams({ landscapeId, versionId }).toString()
  const fetchResponse = dependencies.fetch ?? requestAcknowledgement

  async function acknowledge() {
    const attempts = ledger.attempts.filter(attempt => attempt.heads.length > 0 && !confirmed.has(attempt.seq)).slice(0, 64)
    if (!attempts.length || stopped || acknowledgementsSuspended) return null
    const heads = [...new Set(attempts.flatMap(attempt => attempt.heads))]
    const controller = new AbortController()
    requests.add(controller)
    const requested = stamp()
    let timer
    const record = { kind: 'durable-ack', ackOrdinal: ++ackOrdinal, requested, sequences: attempts.map(a => a.seq), heads,
      documentId: handle.documentId, status: null, durable: null, outcome: 'unknown' }
    try {
      timer = setTimeout(() => controller.abort(), requestTimeoutMs)
      const response = await fetchResponse(ackUrl, { method: 'POST',
        headers: { Cookie: options.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents: [{ documentId: handle.documentId, heads }] }), signal: controller.signal })
      record.status = response.status
      // Bounded read and parsing are within the same abort lifetime as fetch.
      const text = await response.text()
      if (text.length > 64 * 1024) throw new Error('durable acknowledgement body too large')
      if (response.status !== 200) record.outcome = 'http-unavailable'
      else {
        const body = JSON.parse(text)
        if (!Array.isArray(body?.documents) || body.documents.length !== 1
          || body.documents[0]?.documentId !== handle.documentId
          || typeof body.documents[0]?.durable !== 'boolean') throw new Error('invalid durable acknowledgement')
        record.durable = body.documents[0].durable
        record.outcome = record.durable ? 'durable' : 'not-yet-durable'
        if (record.durable) for (const attempt of attempts) confirmed.add(attempt.seq)
      }
    } catch (error) {
      record.error = publicError(error)
      record.outcome = controller.signal.aborted ? 'aborted' : 'error'
    } finally {
      clearTimeout(timer)
      requests.delete(controller)
      record.responded = stamp()
      ledger.acknowledgements.push(structuredClone(record))
      emit(record)
    }
    return record
  }

  function ackTick() {
    if (stopped || acknowledgementsSuspended) return
    const flight = acknowledge()
    pending.add(flight)
    void flight.catch(error => fail('acknowledgement', error)).finally(() => {
      pending.delete(flight)
      if (!stopped && !acknowledgementsSuspended) ackTimer = setTimeout(ackTick, ackIntervalMs)
    })
  }

  function suspendAcknowledgements() {
    if (ackSuspensionFlight) return ackSuspensionFlight
    if (stopped) return Promise.reject(new Error('B5.14 traffic is already stopped'))
    if (!ledger.ready) return Promise.reject(new Error('B5.14 traffic is not ready'))
    acknowledgementsSuspended = true
    clearTimeout(ackTimer)
    const flights = [...pending]
    const suspension = { started: stamp(), pendingAtSuspension: flights.length,
      lastRequestedOrdinal: ackOrdinal, completed: null, qualified: false }
    ledger.ackSuspension = suspension
    emit({ kind: 'ack-suspension-started', ...suspension.started,
      pendingAtSuspension: flights.length, lastRequestedOrdinal: ackOrdinal })
    ackSuspensionFlight = (async () => {
      try {
        // Do not abort these requests: their server-side Repo.flush is not
        // cancelled by an HTTP abort. Their ordinary request deadline still
        // applies; any failure makes this one-way barrier unqualified.
        const results = await bounded(Promise.allSettled(flights), requestTimeoutMs + shutdownTimeoutMs,
          'acknowledgement suspension')
        const records = results.filter(result => result.status === 'fulfilled' && result.value !== null).map(result => result.value)
        const history = ledger.acknowledgements.filter(record => record.ackOrdinal <= suspension.lastRequestedOrdinal)
        if (results.some(result => result.status === 'rejected')
          || history.length !== suspension.lastRequestedOrdinal
          || history.some(record => record.status !== 200 || !['durable', 'not-yet-durable'].includes(record.outcome))) {
          // A request that timed out BEFORE suspension is no longer in pending,
          // but its server-side flush may still be running. A later successful
          // ACK is not proof that this earlier work ended; refuse the episode.
          throw new Error('an acknowledgement did not finish with a valid response')
        }
        if (requests.size !== 0 || stopped || fatal) throw new Error('acknowledgement suspension did not drain an active healthy author')
        suspension.completed = stamp()
        suspension.qualified = true
        suspension.ackOrdinals = records.map(record => record.ackOrdinal)
        suspension.checkedAckCount = history.length
        ackSuspensionQualified = true
        emit({ kind: 'ack-suspension-qualified', ...suspension.completed, ackOrdinals: suspension.ackOrdinals })
        return structuredClone(suspension)
      } catch (error) {
        suspension.completed = stamp()
        suspension.error = publicError(error)
        emit({ kind: 'ack-suspension-unqualified', ...suspension.completed, error: suspension.error })
        throw new Error('B5.14 acknowledgement suspension is unqualified', { cause: error })
      }
    })()
    void ackSuspensionFlight.catch(() => {})
    return ackSuspensionFlight
  }

  function sealOutbound() {
    if (outboundSealFlight) return outboundSealFlight
    if (!ackSuspensionQualified) throw new Error('Suspend and qualify acknowledgements before sealing outbound traffic')
    if (stopped || fatal || typeof peer?.sealOutbound !== 'function') throw new Error('B5.14 outbound transport cannot be sealed')
    // peer.sealOutbound closes its shared gate before it returns this promise.
    const flight = peer.sealOutbound()
    ledger.outboundBarrier = { qualified: false }
    outboundSealFlight = bounded(flight, shutdownTimeoutMs, 'outbound writes drain').then(result => {
      if (stopped || fatal) throw new Error('B5.14 traffic stopped while sealing outbound')
      ledger.outboundBarrier = result
      return structuredClone(result)
    }).catch(error => {
      ledger.outboundBarrier.error = publicError(error)
      emit({ kind: 'outbound-unqualified', ...stamp(), error: publicError(error) })
      throw error
    })
    void outboundSealFlight.catch(() => {})
    return outboundSealFlight
  }
  function writeOnce() {
    if (stopped) throw new Error('B5.14 traffic is already stopped')
    if (!ledger.ready) throw new Error('B5.14 traffic is not ready')
    if (fatal) throw fatal
    if (writeInProgress) throw new Error('B5.14 local change is already in progress')
    if (ledger.attempts.length >= 5_000) throw new Error('traffic exceeds 5000 attempts')
    writeInProgress = true
    const seq = ledger.attempts.length + 1
    const marker = `${options.runId}:${nonce}:${seq}`
    const attempt = { kind: 'local-change', seq, marker, objectId, documentId: handle.documentId,
      started: stamp(), completed: null, heads: [], outcome: 'unknown' }
    try {
      handle.change(document => {
        const objects = objectMap(document)
        if (!objects) throw new Error('target has no object collection')
        objects[objectId] ??= makeObject(objectId)
        objects[objectId].properties[`seq${seq}`] = marker
        appendOverlayBatchId(document, marker)
      })
      const heads = A.getHeads(handle.doc())
      if (!heads.length || heads.some(head => !/^[a-f0-9]{64}$/.test(head))) throw new Error('invalid local heads')
      attempt.heads = [...heads]
      attempt.outcome = 'locally-changed'
    } catch (error) {
      attempt.error = publicError(error)
      fail('local change', error)
      throw fatal
    } finally {
      attempt.completed = stamp()
      ledger.attempts.push(structuredClone(attempt))
      try { emit(attempt) } finally { writeInProgress = false }
    }
    if (fatal) throw fatal
    return structuredClone(attempt)
  }
  function writeTick() {
    if (stopped) return
    try {
      writeOnce()
      if (!stopped && !manualWrites) writeTimer = setTimeout(writeTick, intervalMs)
    } catch (error) {
      // Automatic callers have no direct result promise; fail also rejects
      // done and closes the peer, so an unsuccessful tick cannot disappear.
      if (!fatal) fail('local change', error)
    }
  }

  function stop() {
    if (stopFlight) return stopFlight
    stopped = true
    clearTimeout(writeTimer); clearTimeout(ackTimer); clearTimeout(durationTimer)
    setupAbort.abort()
    for (const controller of requests) controller.abort()
    // Invoke disconnect synchronously, before yielding or taking a snapshot.
    let disconnect
    try { disconnect = Promise.resolve(peer?.disconnect()) } catch (error) { disconnect = Promise.reject(error) }
    stopFlight = (async () => {
      const failures = []
      const tasks = [disconnect, Promise.allSettled([...pending])]
      // Qualification failures belong to their API promises; still join their
      // record-writing continuations so no barrier record appears after stop.
      tasks.push(Promise.allSettled([ackSuspensionFlight, outboundSealFlight].filter(Boolean)))
      if (setupFlight) tasks.push(setupFlight)
      // Repo.shutdown flushes FIRST. Transports have already been disconnected,
      // so this cannot replay author state before the caller's PostgreSQL check.
      if (peer) tasks.push(Promise.resolve().then(() => peer.repo.shutdown()))
      const settled = await bounded(Promise.allSettled(tasks), shutdownTimeoutMs, 'traffic shutdown')
      for (const result of settled) if (result.status === 'rejected') failures.push(publicError(result.reason))
      if (failures.length) throw new Error('traffic shutdown did not complete cleanly')
      const doc = handle?.doc()
      const snapshot = doc ? { documentId: handle.documentId, targetUrl,
        heads: A.getHeads(doc), bytes: A.save(doc) } : null
      ledger.stopped = stamp()
      ledger.confirmedSequences = [...confirmed].sort((a, b) => a - b)
      emit({ kind: 'stopped', ...ledger.stopped, snapshotAvailable: snapshot !== null })
      if (fatal) throw fatal
      return { ledger, snapshot, transportsClosed: true }
    })()
    stopFlight.then(doneResolve, error => {
      ledger.cleanupError = publicError(error)
      doneReject(error)
    })
    return stopFlight
  }

  setupFlight = (async () => {
    try {
      peer = (dependencies.createPeer ?? createPeer)({ targetUrl, wsUrl: ws.toString(),
        cookie: options.cookie, reconnect: options.reconnect ?? false, record: emit })
      peer.repo.on('storage-error', error => fail('local storage', error))
      handle = await bounded(peer.repo.find(targetUrl, { signal: setupAbort.signal }), readyTimeoutMs,
        'traffic document resolution', () => setupAbort.abort())
      if (stopped) throw new Error('traffic stopped before ready')
      const doc = handle.doc()
      if (!objectMap(doc) || A.getHeads(doc).length === 0) throw new Error('target is not a materialized model/overlay')
      ledger.documentId = handle.documentId
      ledger.ready = stamp()
      emit({ kind: 'ready', ...ledger.ready, documentId: handle.documentId, objectId })
      readyResolve({ documentId: handle.documentId, targetUrl, objectId, nonce, heads: A.getHeads(doc) })
      if (!manualWrites) writeTimer = setTimeout(writeTick, 0)
      ackTimer = setTimeout(ackTick, ackIntervalMs)
      durationTimer = setTimeout(() => { void stop().catch(() => {}) }, durationMs)
    } catch (error) {
      readyReject(new Error('B5.14 traffic could not become ready'))
      if (!stopped) fail('setup', error)
    }
  })()
  return { ready, done, stop, writeOnce, suspendAcknowledgements, sealOutbound, ledger }
}
