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

export function objectMap(document) {
  if (document?.model?.objects && typeof document.model.objects === 'object') return document.model.objects
  if (document?.objects && typeof document.objects === 'object') return document.objects
  return null
}

/**
 * Appends a stable batch id to an overlay WRITE HEAD, creating the list the way
 * the client does (`src/lib/automerge/bridge.ts`, the flush path:
 * `if (!s.writeBatchIds) s.writeBatchIds = []` then a push through the
 * re-read list). Until 2026-10-22 the client wrote
 * `(s.writeBatchIds ??= []).push(batchId)`, which pushes onto the detached
 * literal: on the fresh head below its first batch id was lost.
 *
 * MEASURED, not reasoned (during load-gate qualification): a
 * workspace created by `createEmptyRoot` carries a head of shape `{ objects: {} }`
 * — no `writeBatchIds` until the first client write. The previous contract here
 * ("push only if the list exists, else return false") therefore dropped the load
 * gate's seed batch on EVERY fresh landscape, and the gate never read the return
 * value: the objects landed, the batch id did not, and the gate waited 45 s for
 * an acknowledgement of a batch that existed nowhere.
 *
 * Returns false only for a document that is not an overlay head — a monolithic
 * model document (`model.objects`) or one with no entity map at all. Nothing
 * reads a batch id there, so appending one would only look like coverage.
 */
export function appendOverlayBatchId(document, batchId) {
  if (!document || typeof document !== 'object') return false
  if (!Array.isArray(document.writeBatchIds)) {
    const isOverlayHead = (document.objects !== null && typeof document.objects === 'object')
      || (document.connections !== null && typeof document.connections === 'object')
    if (!isOverlayHead) return false
    document.writeBatchIds = []
  }
  if (!document.writeBatchIds.includes(batchId)) document.writeBatchIds.push(batchId)
  return true
}

export function loadObjectIds(count, prefix = 'shared-load') {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`)
}

/** Qualified cycles share one episode across cohorts. Reusing the same final
 * value on the same head cannot witness delivery of a later cycle's writes. */
export function loadRoundValue(episodeId, round) {
  if (episodeId !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(episodeId)) {
    throw new Error('load episode must be a UUID')
  }
  if (!Number.isSafeInteger(round) || round < 0) throw new Error('load round must be nonnegative')
  return episodeId === null ? `r${round}` : `${episodeId}:r${round}`
}

/** Reads actual client documents. The expected episode is supplied by the
 * parent, never inferred from a document that may still hold an older cycle. */
export function loadConvergenceState({ clients, ids, writersOf, expectedRound }) {
  if (!clients.length) throw new Error('convergence requires clients')
  const ref = clients[0].objects
  let allFieldsPresent = 0
  let missingFields = 0
  let staleFields = 0
  let hotConverged = 0
  let hotDiverged = 0
  let clientsConverged = 0
  const clientsWithFieldLag = []
  const clientsWithHotDivergence = []
  for (const { i, objects } of clients) {
    if (!objects) throw new Error(`client ${i} lost its object collection`)
    let fieldLag = false
    let hotLag = false
    for (const id of ids) {
      for (const writer of writersOf[id]) {
        const value = objects[id]?.[`u${writer}`]
        if (value === undefined) { missingFields++; fieldLag = true }
        else if (value !== expectedRound) { staleFields++; fieldLag = true }
        else if (i === 0) allFieldsPresent++
      }
      if (writersOf[id].length === 0) continue
      // Matching each other is insufficient when every reader holds the old hot.
      const validHot = writersOf[id].some(writer => objects[id]?.hot === `u${writer}-${expectedRound}`)
      if (validHot && objects[id]?.hot === ref?.[id]?.hot) {
        if (i !== 0) hotConverged++
      } else { hotDiverged++; hotLag = true }
    }
    if (fieldLag) clientsWithFieldLag.push(i)
    if (hotLag) clientsWithHotDivergence.push(i)
    if (!fieldLag && !hotLag) clientsConverged++
  }
  return {
    allFieldsPresent, missingFields, staleFields, hotConverged, hotDiverged,
    clientsWithFieldLag, clientsWithHotDivergence, clientsConverged,
    fullyConverged: clientsConverged === clients.length && missingFields === 0 && staleFields === 0 && hotDiverged === 0,
  }
}

/**
 * Who writes what (the load PROFILE — see `load-users.mjs`).
 *
 * Users with global index below `writers` write; the rest only hold the
 * document. `shared` sends every writer to every object; `per-writer` sends
 * writer w to `ids[w % ids.length]` alone. The three derived views — a writer's
 * objects, an object's writers, and the largest expected field count — come
 * from ONE definition so the edit loop, the own-field read-back and the
 * convergence check cannot disagree about the assignment.
 */
export function planWriters({ totalUsers, writers = totalUsers, objectAssignment = 'shared', ids }) {
  if (!Number.isInteger(totalUsers) || totalUsers < 1) throw new Error('totalUsers must be a positive integer')
  if (!Number.isInteger(writers) || writers < 1 || writers > totalUsers) {
    throw new Error('writers must be an integer from 1 to totalUsers')
  }
  if (!['shared', 'per-writer'].includes(objectAssignment)) {
    throw new Error('objectAssignment must be shared or per-writer')
  }
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('at least one object id is required')
  const isWriter = (globalIndex) => Number.isInteger(globalIndex) && globalIndex >= 0 && globalIndex < writers
  const writesTo = (globalIndex) => {
    if (!isWriter(globalIndex)) return []
    return objectAssignment === 'shared' ? ids : [ids[globalIndex % ids.length]]
  }
  const writersOf = Object.fromEntries(ids.map((id) => [id, []]))
  for (let w = 0; w < writers; w += 1) {
    for (const id of writesTo(w)) writersOf[id].push(w)
  }
  return {
    writers,
    objectAssignment,
    isWriter,
    writesTo,
    writersOf,
    expectedUserFieldsPerObject: Math.max(...ids.map((id) => writersOf[id].length)),
  }
}

export async function resolveLoadHandle(repo, url, options = {}) {
  const tries = Math.max(1, options.tries ?? 50)
  const delayMs = Math.max(0, options.delayMs ?? 100)
  const attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? 10_000)
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const documentId = url.replace(/^automerge:/, '').split('?')[0]
  let lastError

  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Document ${documentId} resolution timed out after ${attemptTimeoutMs} ms`)
          error.code = 'QA_HANDLE_TIMEOUT'
          reject(error)
        }, attemptTimeoutMs)
      })
      return {
        handle: await Promise.race([repo.find(url), timeout]).finally(() => clearTimeout(timer)),
        unavailableRetries: attempt,
      }
    } catch (error) {
      lastError = error
      const progress = repo.findWithProgress?.(url)
      const state = typeof progress?.peek === 'function' ? progress.peek().state : progress?.state
      const unavailable = error instanceof Error && /Document .* is unavailable/.test(error.message)
      const timedOut = error?.code === 'QA_HANDLE_TIMEOUT'
      if ((!unavailable && !timedOut) || state === 'failed') throw error
      if (state === 'unavailable' || timedOut) {
        if (typeof repo.removeFromCache !== 'function') throw error
        await repo.removeFromCache(documentId)
      }
      options.onRetry?.({ attempt: attempt + 1, state: state ?? 'unknown' })
      if (attempt < tries - 1) await sleep(delayMs)
    }
  }

  throw lastError
}

export function percentile(values, quantile) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

export function evaluateLoadUsersResult(result, options = {}) {
  const failures = []
  if (result.objectsTested < 1) failures.push('no model object was exercised')
  if (!result.fullyConverged || !result.convergedWithinBudget) failures.push('clients did not converge within budget')
  if (result.missingFields !== 0) failures.push(`${result.missingFields} user fields are missing`)
  if (Number(result.staleFields ?? 0) !== 0) failures.push(`${result.staleFields} user fields are stale`)
  if (result.hotDiverged !== 0) failures.push(`${result.hotDiverged} contended values diverged`)
  if (options.requireTransport && !result.serverTransport) failures.push('server transport telemetry is required')
  if (result.serverTransport) {
    if (result.serverTransport.backpressureDisconnectsDelta > 0) failures.push('backpressure disconnected a client')
    if (result.serverTransport.droppedOutboundFramesDelta > 0) failures.push('backpressure dropped an outbound frame')
    if (options.maxEventLoopP99Ms != null
      && result.serverTransport.eventLoopDelayP99Ms > options.maxEventLoopP99Ms) {
      failures.push(`event-loop p99 exceeded ${options.maxEventLoopP99Ms} ms`)
    }
  }
  return failures
}
