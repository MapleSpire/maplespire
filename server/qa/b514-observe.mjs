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

import { request as httpRequest, validateHeaderValue } from 'node:http'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const stateFields = ['generatedAt', 'cellId', 'partitionIndex', 'partitionCount', 'partitionReady', 'ready', 'canServe',
  'partitionLossCount', 'partitionAcquisitionCount', 'ownedWorkspaceCount', 'expectedWorkspaceCount', 'topologyConfirmed',
  'configuredGeneration', 'effectiveGeneration', 'topologyGeneration',
  'topologyKeyCreatedAtBoot', 'bootObservedAt', 'storageFence']

function origin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('invalid observer origin') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('observer requires a plain loopback HTTP origin')
  }
  // No DNS lookup can send the supplied cookie outside loopback.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return url.origin
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid observer ${label}`)
}

// The caller owns faults, interpretation and durable output. Each readiness
// channel and each three-read ownership bracket is independent and sequential.
// Only complete JSON responses have a status; partial headers are diagnostic.
export function startB514Observation({ cells, routerUrl, cookie, onRecord,
  periodMs = 100, timeoutMs = 4000, maxBodyBytes = 2 * 1024 * 1024, now = () => performance.now() } = {}) {
  if (!Array.isArray(cells) || cells.length !== 2
    || cells.some(cell => !cell || typeof cell.service !== 'string' || !/^[a-z][a-z0-9-]*$/.test(cell.service) || cell.service === 'router')
    || new Set(cells.map(cell => cell.service)).size !== 2) throw new Error('observer requires two distinct cells')
  const targets = cells.map(cell => ({ service: cell.service, baseUrl: origin(cell.baseUrl) }))
  const router = origin(routerUrl)
  if (new Set([...targets.map(cell => cell.baseUrl), router]).size !== 3) throw new Error('observer origins must be distinct')
  if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 16384) throw new Error('invalid observer cookie')
  try { validateHeaderValue('Cookie', cookie) } catch { throw new Error('invalid observer cookie') }
  if (typeof onRecord !== 'function' || typeof now !== 'function') throw new Error('observer requires record and clock functions')
  integer(periodMs, 50, 1000, 'period')
  integer(timeoutMs, 3000, 10000, 'timeout')
  integer(maxBodyBytes, 1, 2 * 1024 * 1024, 'body limit')

  const records = [], requests = new Set(), sockets = new Set()
  const abort = new AbortController()
  let sequence = 0, fatal = null, lastAt = -Infinity, stopFlight
  const clock = () => {
    const at = now()
    if (!Number.isFinite(at) || at < lastAt) throw new Error('monotonic observer clock regressed or is invalid')
    lastAt = at
    return at
  }
  clock() // Invalid clocks fail before creating any request or timer.
  const fail = error => {
    fatal ??= error
    abort.abort()
  }
  const arrival = () => {
    try { return clock() } catch (error) { fail(error); return null }
  }
  const emit = record => {
    const value = { ...record, sequence: ++sequence, at: clock() }
    records.push(value)
    const result = onRecord(structuredClone(value))
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(() => undefined)
      throw new Error('observer onRecord must be synchronous')
    }
    return value
  }

  const request = (url, authenticated) => {
    const began = clock()
    if (abort.signal.aborted) return Promise.resolve({ began, ended: began, closedAt: began, status: null, responseStatus: null, error: 'aborted' })
    return new Promise(resolve => {
      let socket, socketClosed = false, requestClosed = false, responseStatus = null
      let responseEnded = false, ended = null, body, failure = null, settled = false, bytes = 0
      const chunks = []
      let timer
      const finish = () => {
        if (settled || !requestClosed || (socket && !socketClosed)) return
        settled = true
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', cancel)
        requests.delete(req)
        const closedAt = arrival()
        if (fatal) failure ??= 'collector-failed'
        const error = failure ?? (responseEnded ? null : 'incomplete-response')
        resolve({ began, ended: ended ?? closedAt, closedAt, status: error ? null : responseStatus,
          responseStatus, error, ...(error ? {} : { body }) })
      }
      const destroy = reason => {
        if (!responseEnded) failure ??= reason
        if (ended === null) ended = arrival()
        req.destroy()
        socket?.destroy()
      }
      const cancel = () => destroy('aborted')
      // agent:false creates a private, non-pooled connection. No global fetch
      // dispatcher, ambient proxy, DNS target or redirect is involved.
      const req = httpRequest(url, { agent: false, method: 'GET', headers: {
        Connection: 'close', ...(authenticated ? { Cookie: cookie } : {}),
      } }, response => {
        responseStatus = response.statusCode ?? null
        response.once('error', () => destroy('response-failed'))
        response.once('aborted', () => destroy('incomplete-response'))
        if (responseStatus >= 300 && responseStatus < 400) {
          destroy('redirect-refused')
          return
        }
        response.on('data', chunk => {
          bytes += chunk.length
          if (bytes > maxBodyBytes) { destroy('body-too-large'); return }
          chunks.push(chunk)
        })
        response.once('end', () => {
          ended = arrival()
          responseEnded = true
          clearTimeout(timer)
          if (!failure) {
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (!body || typeof body !== 'object' || Array.isArray(body)) failure = 'invalid-json-object'
            } catch { failure = 'invalid-json' }
          }
          // Finish the dedicated transport even if a peer ignores Connection:
          // close. Record arrival separately from the later close events.
          socket?.destroy()
        })
      })
      requests.add(req)
      req.once('socket', value => {
        socket = value
        sockets.add(socket)
        socket.once('close', () => { socketClosed = true; sockets.delete(socket); finish() })
      })
      req.once('error', () => destroy('request-failed'))
      req.once('close', () => { requestClosed = true; finish() })
      timer = setTimeout(() => destroy('timeout'), timeoutMs)
      abort.signal.addEventListener('abort', cancel, { once: true })
      if (abort.signal.aborted) cancel()
      req.end()
    })
  }

  const readiness = async baseUrl => {
    const { body, ...metadata } = await request(baseUrl + '/api/ready', false)
    return { ...metadata, checks: body?.checks ?? null }
  }
  const ownership = baseUrl => {
    let previousBootId = null
    return async () => {
      const before = await request(baseUrl + '/api/automerge/stats', true)
      const response = await request(baseUrl + '/api/platform/sync-cell', true)
      const after = await request(baseUrl + '/api/automerge/stats', true)
      const boot = value => ({ began: value.began, ended: value.ended, closedAt: value.closedAt,
        id: value.body?.processBootId ?? null, status: value.status, error: value.error })
      const beforeBoot = boot(before), afterBoot = boot(after)
      // Production processIdentity.ts mints crypto.randomUUID() once per boot.
      const identityValid = before.status === 200 && after.status === 200
        && typeof beforeBoot.id === 'string' && uuid.test(beforeBoot.id) && beforeBoot.id === afterBoot.id
      const identityChanged = beforeBoot.id !== afterBoot.id
        || (previousBootId !== null && (beforeBoot.id !== previousBootId || afterBoot.id !== previousBootId))
      const previousProcessBootId = previousBootId
      if (identityValid) previousBootId = afterBoot.id
      const { body, ...metadata } = response
      return { ...metadata, identityValid, identityChanged, previousProcessBootId, beforeBoot, afterBoot,
        state: body ? Object.fromEntries(stateFields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])) : null }
    }
  }
  const loop = async (channel, sample) => {
    try {
      while (!abort.signal.aborted) {
        const started = clock()
        const value = await sample()
        if (fatal) return
        emit({ kind: 'sample', channel, started, ...value })
        try { await delay(Math.max(0, periodMs - (clock() - started)), undefined, { signal: abort.signal }) }
        catch (error) { if (!abort.signal.aborted) throw error }
      }
    } catch (error) { fail(error) }
  }
  const channels = targets.flatMap(cell => [
    [cell.service + '/ready', () => readiness(cell.baseUrl)],
    [cell.service + '/ownership', ownership(cell.baseUrl)],
  ])
  channels.push(['router/ready', () => readiness(router)])
  // Defer startup until validation and the public control object are complete.
  const loops = channels.map(([channel, sample]) => Promise.resolve().then(() => loop(channel, sample)))
  const done = Promise.all(loops).then(() => {
    if (requests.size || sockets.size) throw new Error('observer transport cleanup incomplete')
    if (fatal) throw fatal
    return { records, periodMs, timeoutMs, maxBodyBytes,
      transport: { requestsRemaining: requests.size, socketsRemaining: sockets.size },
      clock: 'performance.now in the collector process',
      limitation: 'Ownership snapshots call pruneExpired; cadence participates in detecting local expiry. No continuous-ownership claim between samples.' }
  })
  void done.catch(() => undefined)
  return { records, done,
    mark(name, data = {}) {
      if (abort.signal.aborted) throw new Error('observer is stopped')
      try {
        if (typeof name !== 'string' || !name.trim()) throw new Error('invalid observer mark')
        return emit({ kind: 'mark', name, data })
      } catch (error) { fail(error); throw error }
    },
    stop() {
      if (!stopFlight) { abort.abort(); stopFlight = done }
      return stopFlight
    },
  }
}
