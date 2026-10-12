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

// Explicit local-bench reads only; importing this module starts no I/O.
// Adapted from an earlier qualified cold reader; the configurable-origin
// adaptation needs its own qualification. Fresh memory-only peers read documents; they never create or change them.
// Reads can warm server caches and sync-state; PostgreSQL is a separate oracle.
import { validateHeaderValue } from 'node:http'
import { connect } from 'node:net'
import { performance } from 'node:perf_hooks'
import * as A from '@automerge/automerge'
import { Repo, isValidAutomergeUrl } from '@automerge/automerge-repo'
import { cbor } from '@automerge/automerge-repo/slim'
import WebSocket from 'ws'
import { AuthenticatedWebSocketClientAdapter } from './authenticatedWebSocketAdapter.mjs'
import { requestedDocumentShare } from './lib.mjs'

const HEAD = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const READ_MS = 20_000, CLOSE_MS = 5_000, RUN_MS = 180_000
function fail(code) { const e = new Error(code); e.publicCode = code; return e }
function requireValue(value, code) { if (!value) throw fail(code) }
function publicCode(error) { return /^[A-Z][A-Z0-9_]{1,80}$/.test(error?.publicCode ?? '') ? error.publicCode : 'COLD_READ_FAILED' }
function origin(baseUrl) {
  requireValue(typeof baseUrl === 'string' && baseUrl.length > 0, 'TASK_LAB_ORIGIN_REQUIRED')
  let url
  try { url = new URL(baseUrl) } catch { throw fail('TASK_LAB_ORIGIN_REQUIRED') }
  requireValue(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
    && /^[1-9][0-9]{0,4}$/.test(url.port) && Number(url.port) <= 65535
    && url.pathname === '/' && !url.search && !url.hash
    && !url.username && !url.password, 'TASK_LAB_ORIGIN_REQUIRED')
  return url.origin
}
function checkCookie(cookie) {
  requireValue(typeof cookie === 'string' && /^maplespire_session=[^;\s]+$/.test(cookie), 'SESSION_COOKIE_INVALID')
  validateHeaderValue('Cookie', cookie)
}
function deadline(ms, upstream) {
  requireValue(upstream === undefined || upstream instanceof AbortSignal, 'SIGNAL_INVALID')
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  upstream?.addEventListener('abort', onAbort, { once: true })
  if (upstream?.aborted) onAbort()
  const timer = setTimeout(onAbort, ms)
  return { signal: controller.signal, dispose() { clearTimeout(timer); upstream?.removeEventListener('abort', onAbort); controller.abort() } }
}
function untilAbort(promise, signal) {
  let onAbort
  const aborted = new Promise((_, reject) => { onAbort = () => reject(fail('READ_ABORTED_OR_TIMED_OUT')) })
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
}
async function boundedClose(promise) {
  let timer
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('CLEANUP_INCOMPLETE')), CLOSE_MS) })]) }
  finally { clearTimeout(timer) }
}

// One requested document per fresh peer.
async function readDocument({ role, url, wsUrl, cookie, signal, select, expected }) {
  requireValue(isValidAutomergeUrl(url), 'DOCUMENT_URL_INVALID')
  const window = deadline(READ_MS, signal), tcp = new Map(), requests = new Map(), sockets = new Map()
  const receipt = { role, url, beganAt: performance.now(), events: [], cleanup: { confirmed: false } }
  let adapter, repo, constructing = false, closing = false, error, selected, shutdownComplete = false
  const event = kind => receipt.events.push({ kind, at: performance.now() })
  const fault = code => { error ??= fail(code); interrupt.abort() }
  const interrupt = new AbortController()
  const readSignal = AbortSignal.any([window.signal, interrupt.signal])
  const track = (map, resource, kind) => {
    map.set(resource, new Promise(resolve => resource.once('close', () => { map.delete(resource); event(kind + '-close'); resolve() })))
    resource.on('error', () => undefined)
    return resource
  }
  class TrackedSocket extends WebSocket {
    constructor(address, init) {
      requireValue(address === wsUrl && !readSignal.aborted, 'READ_ABORTED_OR_TIMED_OUT')
      const target = new URL(wsUrl)
      super(address, { ...init, family: 4, followRedirects: false, handshakeTimeout: 5_000,
        createConnection: () => {
          requireValue(!readSignal.aborted, 'READ_ABORTED_OR_TIMED_OUT')
          return track(tcp, connect({ host: '127.0.0.1', port: Number(target.port), family: 4 }), 'tcp')
        },
        finishRequest: request => { track(requests, request, 'upgrade-request'); if (readSignal.aborted) request.destroy(); else request.end() },
      })
      sockets.set(this, new Promise(resolve => this.once('close', code => {
        sockets.delete(this); receipt.events.push({ kind: 'ws-close', code, at: performance.now() })
        if (!closing) fault('WS_CLOSED_EARLY')
        resolve()
      })))
      this.on('error', () => { if (!closing) fault('WS_FAILED') })
      this.once('open', () => event('ws-open'))
    }
  }
  try {
    requireValue(!readSignal.aborted, 'READ_ABORTED_OR_TIMED_OUT')
    adapter = new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 0, TrackedSocket)
    adapter.onError = () => undefined
    const onMessage = adapter.onMessage
    adapter.onMessage = message => {
      try { cbor.decode(new Uint8Array(message.data)); onMessage(message) }
      catch { fault('INVALID_AUTOMERGE_FRAME') }
    }
    adapter.on('peer-candidate', () => event('peer-ready'))
    constructing = true
    repo = new Repo({ network: [adapter], shareConfig: requestedDocumentShare([url]) })
    const handle = await untilAbort(repo.find(url, { signal: readSignal }), readSignal)
    if (error) throw error
    const document = handle.doc(), heads = document ? A.getHeads(document) : []
    requireValue(document && heads.length > 0 && heads.every(head => HEAD.test(head)), 'DOCUMENT_NOT_MATERIALIZED')
    requireValue(adapter.connectionHistory.length > 0 && receipt.events.some(item => item.kind === 'ws-open'), 'PEER_HANDSHAKE_MISSING')
    if (expected) requireValue(expected.url === url && A.hasHeads(document, expected.heads), 'PRIOR_HEADS_MISSING')
    selected = select(document)
    Object.assign(receipt, { documentId: handle.documentId, heads, materializedAt: performance.now(), priorHeadsPresent: expected ? true : null })
  } catch (caught) { error ??= fail(publicCode(caught)) }
  finally {
    closing = true
    window.dispose(); interrupt.abort()
    const closes = [...tcp.values(), ...requests.values(), ...sockets.values()], errors = []
    if (constructing && !repo) errors.push('repo-construction-incomplete')
    for (const current of new Set([adapter, ...(repo?.networkSubsystem.adapters ?? [])])) {
      try { current?.disconnect() } catch { errors.push('adapter-disconnect') }
    }
    for (const socket of sockets.keys()) { try { socket.terminate() } catch { errors.push('ws-terminate') } }
    for (const request of requests.keys()) { try { request.destroy() } catch { errors.push('request-destroy') } }
    for (const socket of tcp.keys()) { try { socket.destroy() } catch { errors.push('tcp-destroy') } }
    const shutdown = Promise.resolve().then(() => repo?.shutdown()).then(() => { shutdownComplete = true })
    try { await boundedClose(Promise.all([...closes, shutdown])) } catch { errors.push('shutdown-incomplete') }
    if (tcp.size || requests.size || sockets.size || !shutdownComplete) errors.push('remaining-resources')
    receipt.cleanup = { confirmed: errors.length === 0, repoConstructed: Boolean(repo), repoShutdownComplete: Boolean(repo) && shutdownComplete,
      tcpRemaining: tcp.size, wsRemaining: sockets.size, upgradeRequestsRemaining: requests.size, errors }
    receipt.endedAt = performance.now()
    if (errors.length) error ??= fail('CLEANUP_INCOMPLETE')
  }
  if (error) { error.evidence = receipt; throw error }
  return { selected, receipt }
}

function urls(value) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 4
    && value.every(url => isValidAutomergeUrl(url)) && new Set(value).size === value.length, 'REFERENCE_LIST_UNSUPPORTED')
  return [...value]
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/** Cold client graph, not a PostgreSQL durability oracle. expected is an optional prior cold receipt.
 * The bootstrap has one starter Context diagram, automatically opened by the browser.
 * No persisted server-side active-diagram field is assumed; an ambiguous registry is refused.
 */
export async function coldRead({ fixture, cookie, baseUrl, expected, signal } = {}) {
  const base = origin(baseUrl)
  checkCookie(cookie)
  requireValue(ID.test(fixture?.landscapeId ?? '') && ID.test(fixture?.versionId ?? '') && isValidAutomergeUrl(fixture?.rootUrl), 'FIXTURE_INVALID')
  fixture = { landscapeId: fixture.landscapeId, versionId: fixture.versionId, rootUrl: fixture.rootUrl }
  if (expected) requireValue(expected.schema === 't13f-cold-read/v1' && expected.complete === true && expected.nativeResourcesClosed === true
    && JSON.stringify(expected.fixture) === JSON.stringify(fixture) && Array.isArray(expected.documents)
    && expected.documents.length >= 7 && expected.documents.every(doc => typeof doc.role === 'string' && isValidAutomergeUrl(doc.url)
      && Array.isArray(doc.heads) && doc.heads.length > 0 && doc.heads.every(head => HEAD.test(head)))
    && new Set(expected.documents.map(doc => doc.role)).size === expected.documents.length, 'PRIOR_RECEIPT_INVALID')
  const window = deadline(RUN_MS, signal), wsUrl = new URL('/automerge', base)
  wsUrl.protocol = 'ws:'
  wsUrl.searchParams.set('landscapeId', fixture.landscapeId); wsUrl.searchParams.set('versionId', fixture.versionId)
  const report = { schema: 't13f-cold-read/v1', complete: false, fixture: { ...fixture }, beganAt: performance.now(),
    clockDomain: 'caller-process-performance', documents: [], reads: [], nativeResourcesClosed: false,
    selection: 'unique starter diagram in registry; no persisted active-diagram field', failure: null }
  const read = async (role, url, select) => {
    const prior = expected?.documents.find(doc => doc.role === role)
    if (expected) requireValue(prior && prior.url === url, 'PRIOR_REFERENCE_CHANGED')
    try {
      const value = await readDocument({ role, url, select, wsUrl: wsUrl.href, cookie, signal: window.signal, expected: prior })
      report.reads.push(value.receipt)
      report.documents.push({ role, url, documentId: value.receipt.documentId, heads: value.receipt.heads })
      return value.selected
    } catch (error) { if (error.evidence) report.reads.push(error.evidence); throw error }
  }
  try {
    const root = await read('root', fixture.rootUrl, doc => {
      requireValue(isValidAutomergeUrl(doc.modelUrl) && isValidAutomergeUrl(doc.modelMetaUrl) && doc.registrySummaryOnly !== true, 'ROOT_SHAPE_UNSUPPORTED')
      return { modelUrl: doc.modelUrl, modelMetaUrl: doc.modelMetaUrl, shardUrls: urls(doc.shardUrls) }
    })
    await read('model', root.modelUrl, doc => {
      requireValue(['objects', 'connections', 'groups', 'domains', 'tagSnapshots', 'decisionRecords'].every(key => object(doc[key])), 'MODEL_SHAPE_INVALID')
    })
    const meta = await read('model-meta', root.modelMetaUrl, doc => {
      const objects = urls(doc.objectShardUrls), connections = urls(doc.connectionShardUrls)
      requireValue(objects.includes(doc.editsObjectShardUrl) && connections.includes(doc.editsConnectionShardUrl), 'MODEL_WRITE_HEADS_INVALID')
      return { objects, connections }
    })
    for (const [kind, list] of Object.entries(meta)) {
      for (const [index, url] of list.entries()) await read(kind + '-shard-' + index, url, doc => { requireValue(object(doc[kind]), 'MODEL_SHARD_INVALID') })
    }
    const diagrams = []
    for (const [index, url] of root.shardUrls.entries()) {
      diagrams.push(...await read('registry-' + index, url, doc => {
        requireValue(object(doc.diagrams), 'REGISTRY_SHAPE_INVALID')
        return Object.entries(doc.diagrams).map(([id, meta]) => {
          requireValue(ID.test(id) && meta?.id === id && isValidAutomergeUrl(meta.docUrl)
            && typeof meta.name === 'string' && typeof meta.type === 'string', 'DIAGRAM_REFERENCE_INVALID')
          return { id, url: meta.docUrl, name: meta.name, type: meta.type }
        })
      }))
    }
    requireValue(diagrams.length === 1, 'STARTER_DIAGRAM_AMBIGUOUS')
    const diagram = diagrams[0]
    await read('diagram', diagram.url, doc => {
      requireValue(doc.name === diagram.name && doc.type === diagram.type && diagram.type === 'context'
        && ['objectIds', 'connectionIds', 'groupIds', 'checkpoints'].every(key => Array.isArray(doc[key]))
        && ['layouts', 'comments', 'flows'].every(key => object(doc[key])), 'DIAGRAM_SHAPE_INVALID')
    })
    report.diagramId = diagram.id
    if (expected) requireValue(report.documents.length === expected.documents.length && report.diagramId === expected.diagramId, 'PRIOR_GRAPH_CHANGED')
    requireValue(!window.signal.aborted, 'READ_ABORTED_OR_TIMED_OUT')
    report.complete = true
  } catch (error) { report.failure = publicCode(error) }
  finally {
    window.dispose(); cookie = undefined
    report.endedAt = performance.now()
    report.nativeResourcesClosed = report.reads.length > 0 && report.reads.every(read => read.cleanup.confirmed)
    if (!report.nativeResourcesClosed) { report.complete = false; report.failure ??= 'CLEANUP_INCOMPLETE' }
  }
  if (!report.complete) { const error = fail(report.failure); error.evidence = report; throw error }
  return report
}

/** One cold root read through the supplied public origin, no create/change.
 * Establish the baseline graph separately with coldRead; each movement must
 * provide its prior root heads. */
export async function coldReadRoot({ fixture, cookie, baseUrl, expected, signal } = {}) {
  const base = origin(baseUrl)
  checkCookie(cookie)
  requireValue(ID.test(fixture?.landscapeId ?? '') && ID.test(fixture?.versionId ?? '')
    && isValidAutomergeUrl(fixture?.rootUrl), 'FIXTURE_INVALID')
  requireValue(expected?.role === 'root' && expected.url === fixture.rootUrl
    && Array.isArray(expected.heads) && expected.heads.length > 0
    && expected.heads.every(head => HEAD.test(head)), 'PRIOR_ROOT_REQUIRED')
  const wsUrl = new URL('/automerge', base)
  wsUrl.protocol = 'ws:'
  wsUrl.searchParams.set('landscapeId', fixture.landscapeId)
  wsUrl.searchParams.set('versionId', fixture.versionId)
  const result = await readDocument({ role: 'root', url: fixture.rootUrl,
    wsUrl: wsUrl.href, cookie, signal, expected, select: () => null })
  requireValue(result.receipt.cleanup.confirmed && result.receipt.priorHeadsPresent === true,
    'ROOT_OR_CLEANUP_UNCONFIRMED')
  return result.receipt
}
