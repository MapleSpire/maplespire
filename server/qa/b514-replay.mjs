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

import { createHash } from 'node:crypto'
import { request as httpRequest, validateHeaderValue } from 'node:http'
import { connect as netConnect } from 'node:net'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import * as A from '@automerge/automerge'
import { Repo, isValidDocumentId } from '@automerge/automerge-repo'
import WebSocket from 'ws'
import { AuthenticatedWebSocketClientAdapter } from './authenticatedWebSocketAdapter.mjs'
import { requestedDocumentShare } from './lib.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const headPattern = /^[0-9a-f]{64}$/
const sameHeads = (a, b) => {
  const sorted = [...b].sort()
  return a.length === b.length && [...a].sort().every((value, index) => value === sorted[index])
}
function integer(value, fallback, min, max, name) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`invalid replay ${name}`)
  return result
}
function endpoint(value, protocol) {
  let url
  try { url = new URL(value) } catch { throw new Error('invalid replay endpoint') }
  if (url.protocol !== protocol || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.hash) throw new Error('replay requires explicit loopback HTTP/WS endpoints')
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url
}

/** Pure merge of two exported authors. No new Automerge change or document ID.
 * Snapshot metadata is an association supplied by the orchestrator: Automerge
 * binary history itself does not embed the Repo documentId.
 */
export function mergeB514Snapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length !== 2) throw new Error('replay requires two author snapshots')
  const documentId = snapshots[0]?.documentId
  if (!isValidDocumentId(documentId)) throw new Error('invalid replay documentId')
  const targetUrl = `automerge:${documentId}`
  const inputs = snapshots.map(snapshot => {
    if (snapshot?.documentId !== documentId || snapshot.targetUrl !== targetUrl
      || !(snapshot.bytes instanceof Uint8Array) || snapshot.bytes.byteLength === 0 || snapshot.bytes.byteLength > 16 * 1024 * 1024
      || !Array.isArray(snapshot.heads) || snapshot.heads.length === 0 || snapshot.heads.length > 512
      || snapshot.heads.some(head => typeof head !== 'string' || !headPattern.test(head))
      || new Set(snapshot.heads).size !== snapshot.heads.length) throw new Error('invalid or mismatched replay snapshot')
    return { bytes: new Uint8Array(snapshot.bytes), heads: [...snapshot.heads] }
  })
  let merged
  const proofs = []
  let firstHistory
  try {
    for (const input of inputs) {
      let doc
      try {
        doc = A.load(input.bytes)
        if (!sameHeads(A.getHeads(doc), input.heads)) throw new Error('snapshot frontier does not match its bytes')
        const history = new Set(A.getAllChanges(doc).map(change => A.decodeChange(change).hash))
        if (firstHistory && ![...history].some(change => firstHistory.has(change))) throw new Error('author snapshots have no shared history')
        firstHistory ??= history
        if (!merged) { merged = doc; doc = undefined }
        else merged = A.merge(merged, doc)
      } finally { if (doc) A.free(doc) }
      proofs.push({ heads: input.heads, bytes: input.bytes.byteLength, sha256: hash(input.bytes) })
    }
    if (inputs.some(input => !A.hasHeads(merged, input.heads))) throw new Error('merge did not retain every author frontier')
    const bytes = A.save(merged), heads = A.getHeads(merged).sort()
    if (bytes.byteLength > 32 * 1024 * 1024 || heads.length > 512) throw new Error('merged replay exceeds its budget')
    return { snapshot: { documentId, targetUrl, heads, bytes }, inputs: proofs }
  } finally { if (merged) A.free(merged) }
}

function awaitSignal(promise, signal) {
  let rejectAbort
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(new Error('replay interrupted')) })
  signal.addEventListener('abort', rejectAbort, { once: true })
  if (signal.aborted) rejectAbort()
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', rejectAbort))
}
function bounded(promise, timeoutMs) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('replay shutdown timed out')), timeoutMs)
  })]).finally(() => clearTimeout(timer))
}

/** Replay is allowed only AFTER the orchestrator's independent PostgreSQL read.
 * The explicit flag is its authorization, not a PostgreSQL proof manufactured
 * here. Return only after the exact-head ACK and actual transport closure.
 * Errors carry redacted evidence, including any ACK received before cleanup
 * failed. No Redis verdict or new local edit is produced by this helper.
 */
export async function replayB514Snapshots(options = {}, dependencies = {}) {
  if (options.readPgBeforeReplayVerified !== true) throw new Error('independent PostgreSQL read must authorize replay first')
  const { landscapeId, versionId } = options.workspace ?? {}
  if (![landscapeId, versionId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512)) throw new Error('replay workspace is required')
  if (typeof options.cookie !== 'string' || !options.cookie.trim() || options.cookie.length > 16384) throw new Error('replay cookie is required')
  try { validateHeaderValue('Cookie', options.cookie) } catch { throw new Error('invalid replay cookie') }
  if (typeof options.runId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(options.runId)) throw new Error('invalid replay runId')
  if (options.onRecord !== undefined && typeof options.onRecord !== 'function') throw new Error('invalid replay record writer')
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('invalid replay signal')
  const base = endpoint(options.baseUrl, 'http:'), ws = endpoint(options.wsUrl, 'ws:')
  if (base.pathname !== '/' || base.search) throw new Error('replay baseUrl must be an origin')
  for (const [key, value] of Object.entries({ landscapeId, versionId })) {
    if (ws.searchParams.has(key) && ws.searchParams.get(key) !== value) throw new Error('replay WebSocket workspace mismatch')
    ws.searchParams.set(key, value)
  }
  if ([...ws.searchParams.keys()].some(key => !['landscapeId', 'versionId'].includes(key))) throw new Error('unexpected replay WebSocket query')
  const timeoutMs = integer(options.timeoutMs, 20_000, 100, 60_000, 'timeout')
  const requestTimeoutMs = integer(options.requestTimeoutMs, 5_000, 100, 30_000, 'request timeout')
  const shutdownTimeoutMs = integer(options.shutdownTimeoutMs, 3_000, 10, 30_000, 'shutdown timeout')
  const pollMs = integer(options.pollMs, 100, 10, 1000, 'poll period')
  if (options.signal?.aborted) throw new Error('replay was cancelled before startup')
  const merged = mergeB514Snapshots(options.snapshots)
  const { snapshot } = merged
  if ((options.documentId !== undefined && options.documentId !== snapshot.documentId)
    || (options.targetUrl !== undefined && options.targetUrl !== snapshot.targetUrl)) throw new Error('replay target differs from author snapshots')

  const abort = new AbortController()
  const tcp = new Map(), webSockets = new Map(), requests = new Map()
  const ledger = { schema: 'b514-replay/v1', runId: options.runId, documentId: snapshot.documentId,
    targetUrl: snapshot.targetUrl, authorization: 'orchestrator-confirmed-independent-pg-read',
    inputs: merged.inputs, mergedHeads: [...snapshot.heads], mergedSha256: hash(snapshot.bytes),
    startedAt: performance.now(), records: [], acknowledgements: [], transportsClosed: false }
  let repo, adapter, fatal, closing = false, acknowledged = false
  const fail = message => { fatal ??= new Error(message); abort.abort() }
  const externalAbort = () => fail('replay cancelled by orchestrator')
  options.signal?.addEventListener('abort', externalAbort, { once: true })
  if (options.signal?.aborted) externalAbort()
  const timer = setTimeout(() => fail('replay deadline exceeded without a completed result'), timeoutMs)
  const record = value => {
    const entry = { ...value, runId: options.runId, documentId: snapshot.documentId,
      at: performance.now(), sequence: ledger.records.length + 1 }
    ledger.records.push(entry)
    try {
      const result = options.onRecord?.(structuredClone(entry))
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => undefined)
        fail('replay record writer must be synchronous')
      }
    } catch { fail('replay record writer failed') }
    return entry
  }
  const trackTcp = socket => {
    if (tcp.has(socket)) return socket
    tcp.set(socket, new Promise(resolve => socket.once('close', () => {
      tcp.delete(socket); record({ kind: 'tcp-close' }); resolve()
    })))
    return socket
  }
  class ReplaySocket extends WebSocket {
    constructor(url, init) {
      super(url, { ...init, followRedirects: false, handshakeTimeout: requestTimeoutMs,
        // A dedicated native socket, pinned to the already-validated loopback
        // destination. Track even an HTTP upgrade that never becomes a WS.
        createConnection: () => trackTcp(netConnect({ host: ws.hostname.replace(/^\[|\]$/g, ''), port: Number(ws.port || 80) })),
      })
      webSockets.set(this, new Promise(resolve => this.once('close', code => {
        webSockets.delete(this); record({ kind: 'ws-close', code }); resolve()
        if (!closing) fail('replay WebSocket closed before completion')
      })))
      this.on('open', () => record({ kind: 'ws-open' }))
      this.on('error', () => { if (!closing) fail('replay WebSocket failed') })
    }
  }

  const ackUrl = new URL('/api/automerge/durable-heads', base)
  ackUrl.search = new URLSearchParams({ landscapeId, versionId }).toString()
  const requestBody = JSON.stringify({ documents: [{ documentId: snapshot.documentId, heads: snapshot.heads }] })
  const acknowledge = () => {
    const observation = { ordinal: ledger.acknowledgements.length + 1, began: performance.now(), ended: null,
      closedAt: null, status: null, responseStatus: null, durable: null, error: null, requestedHeads: [...snapshot.heads] }
    record({ kind: 'ack-start', ordinal: observation.ordinal, began: observation.began })
    if (abort.signal.aborted) return Promise.reject(new Error('replay interrupted before acknowledgement'))
    return new Promise(resolve => {
      let socket, socketClosed = false, requestClosed = false, responseEnded = false, settled = false, length = 0, requestTimer
      const chunks = []
      const finish = () => {
        if (settled || !requestClosed || (socket && !socketClosed)) return
        settled = true
        clearTimeout(requestTimer)
        abort.signal.removeEventListener('abort', cancel)
        requests.delete(req)
        observation.closedAt = performance.now()
        if (!responseEnded) observation.error ??= 'incomplete-response'
        if (observation.error) observation.status = null
        ledger.acknowledgements.push(observation)
        record({ kind: 'ack-result', ...observation })
        resolve(observation)
      }
      const destroy = error => {
        if (!responseEnded) observation.error ??= error
        observation.ended ??= performance.now()
        req.destroy(); socket?.destroy()
      }
      const cancel = () => destroy('aborted')
      const req = httpRequest(ackUrl, { method: 'POST', agent: false,
        headers: { Cookie: options.cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody), Connection: 'close' },
      }, response => {
        observation.responseStatus = response.statusCode
        response.once('error', () => destroy('response-failed'))
        response.once('aborted', () => destroy('incomplete-response'))
        if (response.statusCode >= 300 && response.statusCode < 400) { destroy('redirect-refused'); return }
        response.on('data', chunk => {
          length += chunk.length
          if (length > 64 * 1024) { destroy('body-too-large'); return }
          chunks.push(chunk)
        })
        response.once('end', () => {
          responseEnded = true
          observation.ended = performance.now()
          clearTimeout(requestTimer)
          if (!observation.error) {
            observation.status = response.statusCode
            if (response.statusCode === 200) {
              try {
                const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                if (!Array.isArray(result?.documents) || result.documents.length !== 1
                  || result.documents[0]?.documentId !== snapshot.documentId || typeof result.documents[0].durable !== 'boolean') {
                  observation.error = 'invalid-acknowledgement'
                } else observation.durable = result.documents[0].durable
              } catch { observation.error = 'invalid-json' }
            }
          }
          socket?.destroy()
        })
      })
      requests.set(req, new Promise(done => req.once('close', () => { requestClosed = true; done(); finish() })))
      req.once('socket', value => {
        socket = trackTcp(value)
        socket.once('close', () => { socketClosed = true; finish() })
      })
      req.once('error', () => destroy('request-failed'))
      requestTimer = setTimeout(() => destroy('timeout'), requestTimeoutMs)
      abort.signal.addEventListener('abort', cancel, { once: true })
      if (abort.signal.aborted) cancel()
      req.end(requestBody)
    })
  }

  try {
    record({ kind: 'replay-start', requestedHeads: snapshot.heads, inputSha256: merged.inputs.map(input => input.sha256) })
    if (fatal) throw fatal
    repo = dependencies.createRepo?.({ shareConfig: requestedDocumentShare([snapshot.targetUrl]) })
      ?? new Repo({ shareConfig: requestedDocumentShare([snapshot.targetUrl]) })
    const handle = repo.import(snapshot.bytes, { docId: snapshot.documentId })
    if (handle.documentId !== snapshot.documentId || handle.url !== snapshot.targetUrl
      || !sameHeads(A.getHeads(handle.doc()), snapshot.heads)) throw new Error('replay import changed document identity or history')
    adapter = new AuthenticatedWebSocketClientAdapter(ws.href, options.cookie, 0, ReplaySocket)
    adapter.onError = () => {}
    repo.networkSubsystem.addNetworkAdapter(adapter)
    await awaitSignal(adapter.whenReady(), abort.signal)
    record({ kind: 'peer-ready' })
    while (!abort.signal.aborted) {
      const response = await acknowledge()
      if (response.status === 200 && response.durable === true && !response.error) {
        ledger.acknowledgedAt = response.ended
        acknowledged = true
        break
      }
      if (response.error || ![200, 500, 503].includes(response.status)) throw new Error('replay acknowledgement failed')
      await delay(pollMs, undefined, { signal: abort.signal })
    }
    if (fatal || !acknowledged) throw fatal ?? new Error('replay was not durably acknowledged')
  } catch (error) {
    fatal ??= new Error(error?.name === 'AbortError' ? 'replay interrupted' : 'replay failed')
  } finally {
    clearTimeout(timer)
    closing = true
    ledger.closeBeganAt = performance.now()
    record({ kind: 'replay-close-start' })
    abort.abort()
    options.signal?.removeEventListener('abort', externalAbort)
    const closes = [...tcp.values(), ...webSockets.values(), ...requests.values()]
    const cleanupErrors = []
    for (const current of new Set([adapter, ...(repo?.networkSubsystem.adapters ?? [])])) {
      try { current?.disconnect() } catch { cleanupErrors.push('adapter-disconnect') }
    }
    for (const socket of webSockets.keys()) {
      try { socket.terminate() } catch { cleanupErrors.push('ws-terminate') }
    }
    for (const request of requests.keys()) request.destroy()
    for (const socket of tcp.keys()) socket.destroy()
    try {
      await bounded((async () => { await Promise.all(closes); await repo?.shutdown() })(), shutdownTimeoutMs)
      if (tcp.size || webSockets.size || requests.size) cleanupErrors.push('remaining-transports')
    } catch { cleanupErrors.push('shutdown-incomplete') }
    ledger.closedAt = performance.now()
    ledger.transport = { tcpRemaining: tcp.size, wsRemaining: webSockets.size, requestsRemaining: requests.size }
    ledger.transportsClosed = cleanupErrors.length === 0
    if (cleanupErrors.length) { ledger.cleanupErrors = cleanupErrors; fatal ??= new Error('replay cleanup failed') }
    record({ kind: 'replay-closed', transportsClosed: ledger.transportsClosed, transport: ledger.transport })
  }
  if (fatal) {
    const error = new Error(fatal.message)
    error.evidence = ledger
    throw error
  }
  return { snapshot, mergedHeads: [...snapshot.heads], ledger, transportsClosed: true }
}
