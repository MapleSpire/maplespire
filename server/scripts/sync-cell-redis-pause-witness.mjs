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

import { createConnection, isIPv4 } from 'node:net'
import { randomBytes } from 'node:crypto'

export const REDIS_FREEZE_WITNESS_LIMITS = Object.freeze({
  periodMs: 5,
  connectTimeoutMs: 500,
  responseTimeoutMs: 250,
  lifetimeMs: 3000,
  maxRequests: 1024,
  maxResponseBytes: 256,
  maxTxBytes: 128 * 1024,
  maxRxBytes: 128 * 1024,
  minAdmissionReplies: 2,
  maxAdmissionAgeMs: 50,
  closeTimeoutMs: 250,
  quantizationMs: 1,
  wallMonotonicToleranceMs: 2,
})

const MODEL = 'redis-ping-freeze-lower-v1'
const targetKeys = ['containerId', 'ip', 'port', 'networkName', 'networkId', 'project',
  'service', 'imageId', 'startedAt', 'restartCount']
const copy = (value) => JSON.parse(JSON.stringify(value))
const unique = (items) => [...new Set(items)]
const validStamp = (stamp) => stamp && Number.isFinite(stamp.at) && stamp.at >= 0
  && Number.isFinite(stamp.monoAt) && stamp.monoAt >= 0
  && Number.isSafeInteger(stamp.ordinal) && stamp.ordinal >= 0

function filteredTarget(target) {
  const result = Object.fromEntries(targetKeys.map((key) => [key, target?.[key]]))
  if (!/^[a-f0-9]{64}$/i.test(result.containerId ?? '')
    || !isIPv4(result.ip ?? '') || result.ip === '0.0.0.0'
    || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535
    || !/^[a-f0-9]{64}$/i.test(result.networkId ?? '')
    || !['networkName', 'project'].every((key) => typeof result[key] === 'string' && result[key].length > 0)
    || result.service !== 'redis' || !/^sha256:[a-f0-9]{64}$/i.test(result.imageId ?? '')
    || typeof result.startedAt !== 'string' || !Number.isFinite(Date.parse(result.startedAt))
    || !Number.isInteger(result.restartCount) || result.restartCount < 0) {
    throw new Error('Invalid Redis witness target')
  }
  return result
}

function validatedLimits(overrides = {}) {
  const result = { ...REDIS_FREEZE_WITNESS_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(result)) {
    if (!(key in REDIS_FREEZE_WITNESS_LIMITS) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error('Invalid Redis witness limits')
    }
  }
  // These two constants describe the clock model, not tunable test deadlines.
  if (result.quantizationMs !== 1 || result.wallMonotonicToleranceMs !== 2
    || result.maxRequests > 1024 || result.maxResponseBytes > 256
    || result.maxTxBytes > 128 * 1024 || result.maxRxBytes > 128 * 1024
    || result.minAdmissionReplies < 2) throw new Error('Invalid Redis witness limits')
  return result
}

function clockIssues(stamps, limits) {
  const issues = []
  let previous = null
  for (const entry of stamps) {
    const stamp = entry.stamp
    if (!validStamp(stamp)) {
      issues.push('invalid-clock-stamp')
      continue
    }
    if (Math.abs(stamp.at - stamp.monoAt) > limits.wallMonotonicToleranceMs) issues.push('wall-monotonic-disagreement')
    if (previous && (stamp.ordinal <= previous.ordinal || stamp.monoAt < previous.monoAt || stamp.at < previous.at)) {
      issues.push('clock-order-invalid')
    }
    previous = stamp
  }
  return unique(issues)
}

/** A reply is only a causal witness under the external, explicit assumption of
 * one identified Redis and no other pause/unpause/restart actor. Final identity
 * is checked by the caller. Neither TCP arrival nor Docker events date freeze. */
export function analyzeRedisFreezeWitness(artifact) {
  try { return analyzeArtifact(artifact) } catch {
    // A malformed saved artifact is not evidence and must not crash a gate.
    return { instrumentValid: false, issues: ['malformed-artifact'], qualifiedRecordIds: [], pauseLowerMs: null, gainMs: null }
  }
}

function analyzeArtifact(artifact) {
  const issues = []
  const add = (condition, issue) => { if (condition) issues.push(issue) }
  let limits
  try { limits = validatedLimits(artifact?.limits); filteredTarget(artifact?.target) } catch {
    return { instrumentValid: false, issues: ['invalid-artifact-configuration'], qualifiedRecordIds: [], pauseLowerMs: null, gainMs: null }
  }
  const stamps = Array.isArray(artifact.stamps) ? artifact.stamps : []
  const records = Array.isArray(artifact.records) ? artifact.records : []
  const marks = artifact.marks ?? {}
  add(artifact.model !== MODEL, 'invalid-model')
  add(!Array.isArray(artifact.stamps) || !Array.isArray(artifact.records), 'missing-records-or-stamps')
  issues.push(...clockIssues(stamps, limits))
  issues.push(...(Array.isArray(artifact.transportIssues) ? artifact.transportIssues : ['missing-transport-issues']))
  const known = (stamp, kind, recordId) => validStamp(stamp) && stamps.some((entry) => entry.stamp?.ordinal === stamp.ordinal
    && entry.stamp.at === stamp.at && entry.stamp.monoAt === stamp.monoAt
    && (kind === undefined || entry.kind === kind) && (recordId === undefined || entry.recordId === recordId))
  add(!known(artifact.createdAt, 'created') || !known(artifact.connectedAt, 'connected'), 'missing-connection-stamps')
  if (known(artifact.createdAt) && known(artifact.connectedAt)) add(
    artifact.connectedAt.ordinal <= artifact.createdAt.ordinal
      || artifact.connectedAt.monoAt - artifact.createdAt.monoAt >= limits.connectTimeoutMs
      || artifact.connectedAt.monoAt >= limits.lifetimeMs, 'connection-deadline-or-order-invalid')
  for (const [name, kind] of [['pauseAttempted', 'pause-attempted'], ['pauseAcknowledged', 'pause-acknowledged'],
    ['sealed', 'sealed'], ['stopped', 'stopped']]) add(!known(marks[name], kind), `missing-${name}`)
  if (['pauseAttempted', 'pauseAcknowledged', 'sealed', 'stopped'].every((name) => known(marks[name]))) {
    add(!(marks.pauseAttempted.ordinal < marks.pauseAcknowledged.ordinal
      && marks.pauseAcknowledged.ordinal < marks.sealed.ordinal && marks.sealed.ordinal <= marks.stopped.ordinal), 'phase-order-invalid')
  }
  if (known(marks.pauseAttempted)) add(marks.pauseAttempted.monoAt >= limits.lifetimeMs, 'pause-attempt-deadline-exceeded')
  if (known(marks.pauseAcknowledged)) add(marks.pauseAcknowledged.monoAt >= limits.lifetimeMs, 'pause-ack-deadline-exceeded')
  add(artifact.admission?.valid !== true || !known(artifact.admission?.checkedAt, 'admission'), 'admission-refused-or-missing')
  add(artifact.cleanup?.cleanupConfirmed !== true || artifact.cleanup?.pendingRequests !== 0
    || artifact.cleanup?.activeTimers !== 0 || artifact.cleanup?.socketClosed !== true
    || artifact.cleanup?.socketCreated !== true || artifact.cleanup?.socketDestroyed !== true
    || artifact.cleanup?.closeTimedOut !== false, 'cleanup-unconfirmed')
  add(artifact.counts?.connections !== 1, 'connection-count-invalid')
  for (const name of ['connections', 'txBytes', 'rxBytes', 'skippedBusy']) {
    add(!Number.isSafeInteger(artifact.counts?.[name]) || artifact.counts[name] < 0, 'counts-invalid')
  }
  add(records.length > limits.maxRequests || artifact.counts?.txBytes > limits.maxTxBytes
    || artifact.counts?.rxBytes > limits.maxRxBytes, 'byte-or-request-budget-exceeded')
  const ids = new Set()
  const nonces = new Set()
  const qualified = []
  let previousResponse = null
  let previousIncomplete = false
  let txBytes = 0
  let rxBytes = 0
  let seed = null
  for (const record of records) {
    add(!Number.isSafeInteger(record.id) || record.id !== ids.size + 1 || ids.has(record.id), 'record-id-invalid')
    add(typeof record.nonce !== 'string' || !/^g1b3:[a-f0-9]{32}:\d{4}$/.test(record.nonce)
      || nonces.has(record.nonce), 'nonce-invalid-or-reused')
    ids.add(record.id); nonces.add(record.nonce)
    if (typeof record.nonce === 'string') {
      const parts = record.nonce.split(':')
      seed ??= parts[1]
      add(parts[1] !== seed || Number(parts[2]) !== record.id, 'nonce-sequence-invalid')
      txBytes += Buffer.byteLength(`*2\r\n$4\r\nPING\r\n$${Buffer.byteLength(record.nonce)}\r\n${record.nonce}\r\n`)
    }
    add(!Number.isSafeInteger(record.receivedBytes) || record.receivedBytes < 0, 'record-byte-count-invalid')
    rxBytes += record.receivedBytes
    add(typeof record.writeBuffered !== 'boolean' || typeof record.admittedBeforeSeal !== 'boolean', 'record-flags-invalid')
    add(!known(record.requestedAt, 'request', record.id), 'missing-request-stamp')
    add(previousIncomplete, 'request-after-terminal-response')
    add(!['matched', 'timeout', 'lifetime', 'cancelled', 'invalid'].includes(record.outcome), 'outcome-invalid')
    add(record.outcome === 'invalid', 'invalid-response-record')
    if (known(record.requestedAt)) add(record.requestedAt.monoAt >= limits.lifetimeMs
      || (known(artifact.connectedAt) && record.requestedAt.ordinal <= artifact.connectedAt.ordinal), 'request-deadline-or-order-invalid')
    if (known(record.requestedAt) && known(marks.pauseAcknowledged)) {
      add(record.requestedAt.ordinal >= marks.pauseAcknowledged.ordinal, 'request-after-pause-ack')
    }
    if (previousResponse && known(record.requestedAt)) add(record.requestedAt.ordinal <= previousResponse.ordinal, 'overlapping-requests')
    if (record.outcome !== 'matched') {
      previousIncomplete = true
      add(record.responseAt !== null || record.admittedBeforeSeal !== false, 'incomplete-response-has-success-data')
      continue
    }
    const expectedBytes = Buffer.byteLength(`$${Buffer.byteLength(record.nonce)}\r\n${record.nonce}\r\n`)
    add(record.receivedBytes !== expectedBytes || record.receivedBytes > limits.maxResponseBytes, 'response-framing-invalid')
    add(!known(record.responseAt, 'data', record.id), 'missing-response-stamp')
    if (!known(record.requestedAt) || !known(record.responseAt)) continue
    previousResponse = record.responseAt
    add(record.responseAt.ordinal <= record.requestedAt.ordinal, 'response-order-invalid')
    add(record.responseAt.monoAt - record.requestedAt.monoAt >= limits.responseTimeoutMs
      || record.responseAt.monoAt >= limits.lifetimeMs, 'response-deadline-exceeded')
    if (record.admittedBeforeSeal === true && known(marks.sealed)
      && record.responseAt.ordinal < marks.sealed.ordinal
      && record.responseAt.at + limits.quantizationMs <= marks.sealed.at) qualified.push(record)
  }
  add(txBytes !== artifact.counts?.txBytes || !Number.isSafeInteger(rxBytes) || rxBytes > artifact.counts?.rxBytes, 'byte-counts-disagree')
  // Recompute admission from raw, complete replies rather than trusting its flag.
  if (known(artifact.admission?.checkedAt)) {
    const at = artifact.admission.checkedAt
    const completed = records.filter((record) => record.outcome === 'matched' && known(record.responseAt)
      && record.responseAt.ordinal < at.ordinal && known(record.requestedAt))
    const last = completed.at(-1)
    add(completed.length < limits.minAdmissionReplies || !last, 'admission-insufficient-replies')
    if (last) add(at.monoAt - last.requestedAt.monoAt > limits.maxAdmissionAgeMs
      || at.monoAt - last.responseAt.monoAt > limits.maxAdmissionAgeMs, 'admission-stale')
    if (known(marks.pauseAttempted)) add(at.ordinal >= marks.pauseAttempted.ordinal, 'admission-after-pause')
  }
  const finalIssues = unique(issues)
  const instrumentValid = finalIssues.length === 0
  const pauseLowerMs = instrumentValid && qualified.length
    ? Math.max(...qualified.map((record) => record.requestedAt.at - limits.quantizationMs)) : null
  return {
    instrumentValid, issues: finalIssues,
    qualifiedRecordIds: instrumentValid ? qualified.map((record) => record.id) : [],
    pauseLowerMs,
    // Informative relative to this module's marker. The observer uses its own
    // earlier historical pause-begin when combining the independent models.
    gainMs: instrumentValid ? Math.max(0, (pauseLowerMs ?? marks.pauseAttempted.at) - marks.pauseAttempted.at) : null,
  }
}

/** One connection, no reconnect; PING nonce is the only command ever written.
 * All dates come from the caller's original observation clock, including the
 * absolute 3 s lifetime. A deadline bounds client work, not Redis execution.
 * Cancellation is explicit stop(), which the owner must await; no AbortSignal
 * or background retry owns another resource outside this controller. */
export function startRedisFreezeWitness({ target, clock, limits: overrides }, seams = {}) {
  target = filteredTarget(target)
  const limits = validatedLimits(overrides)
  if (typeof clock !== 'function') throw new Error('Redis witness requires the observation clock')
  const connect = seams.connect ?? createConnection
  const entropy = (seams.randomBytes ?? randomBytes)(16)
  if (!Buffer.isBuffer(entropy) || entropy.length !== 16) throw new Error('Invalid witness entropy')
  const seed = entropy.toString('hex')
  const timers = {
    setTimeout: seams.setTimeout ?? setTimeout, clearTimeout: seams.clearTimeout ?? clearTimeout,
    setInterval: seams.setInterval ?? setInterval, clearInterval: seams.clearInterval ?? clearInterval,
  }
  const handles = new Map()
  const data = {
    model: MODEL, target, limits, createdAt: null, connectedAt: null,
    marks: { pauseAttempted: null, pauseAcknowledged: null, sealed: null, stopped: null },
    admission: null, records: [], stamps: [], transportIssues: [],
    counts: { connections: 0, txBytes: 0, rxBytes: 0, skippedBusy: 0 }, cleanup: null,
  }
  let socket = null
  let pending = null
  let connected = false
  let closed = false
  let halted = false
  let acknowledged = false
  let sealed = false
  let stopping = false
  let stopPromise = null
  let resolveStop = null
  let closeTimedOut = false

  function cancel(name) {
    const handle = handles.get(name)
    if (!handle) return
    handles.delete(name)
    timers[handle.interval ? 'clearInterval' : 'clearTimeout'](handle.id)
  }
  function schedule(name, callback, delay, interval = false) {
    cancel(name)
    const id = timers[interval ? 'setInterval' : 'setTimeout'](() => {
      if (!interval) handles.delete(name)
      callback()
    }, delay)
    handles.set(name, { id, interval })
  }
  function cancelWork() { for (const name of [...handles.keys()]) if (name !== 'close') cancel(name) }
  function finishPending(outcome) {
    if (pending) { pending.record.outcome = outcome; pending = null }
    cancel('response')
  }
  function destroy() {
    halted = true
    cancelWork()
    try { socket?.destroy() } catch { data.transportIssues.push('socket-destroy-failed') }
  }
  function fault(code) {
    data.transportIssues.push(code)
    finishPending('invalid')
    destroy()
  }
  function stamp(kind, recordId) {
    let raw
    try { raw = clock() } catch { data.transportIssues.push('clock-read-failed'); return null }
    const value = { at: Number.isFinite(raw?.at) ? raw.at : null,
      monoAt: Number.isFinite(raw?.monoAt) ? raw.monoAt : null,
      ordinal: Number.isSafeInteger(raw?.ordinal) ? raw.ordinal : null }
    const entry = { kind, ...(recordId === undefined ? {} : { recordId }), stamp: value }
    const previous = data.stamps.at(-1)
    data.stamps.push(entry)
    const issues = clockIssues(previous ? [previous, entry] : [entry], limits)
    if (issues.length) { data.transportIssues.push(...issues); return null }
    return value
  }
  function expired(now, request = pending) {
    if (!now) { fault('clock-unusable'); return true }
    if (now.monoAt >= limits.lifetimeMs) {
      if (!acknowledged) fault('lifetime-exhausted-before-ack')
      else { finishPending('lifetime'); destroy() }
      return true
    }
    if (request && now.monoAt - request.record.requestedAt.monoAt >= limits.responseTimeoutMs) {
      finishPending('timeout')
      if (!data.marks.pauseAttempted) fault('response-timeout-before-pause')
      else destroy()
      return true
    }
    return false
  }
  function deadline(name, at, callback) {
    const check = () => {
      const now = stamp(`${name}-deadline`, pending?.record.id)
      if (!now) { fault('clock-unusable'); return }
      if (now.monoAt < at) schedule(name, check, Math.ceil(at - now.monoAt))
      else callback(now)
    }
    const latest = data.stamps.at(-1)?.stamp
    schedule(name, check, Math.max(1, Math.ceil(at - latest.monoAt)))
  }
  function send() {
    if (halted || acknowledged || sealed || stopping || !connected) return
    if (pending) { data.counts.skippedBusy++; return }
    const id = data.records.length + 1
    const nonce = `g1b3:${seed}:${String(id).padStart(4, '0')}`
    const command = Buffer.from(`*2\r\n$4\r\nPING\r\n$${nonce.length}\r\n${nonce}\r\n`)
    const expected = Buffer.from(`$${nonce.length}\r\n${nonce}\r\n`)
    if (id > limits.maxRequests || data.counts.txBytes + command.length > limits.maxTxBytes
      || expected.length > limits.maxResponseBytes) { fault('request-budget-exhausted'); return }
    const requestedAt = stamp('request', id)
    if (expired(requestedAt, null)) return
    const record = { id, nonce, requestedAt, responseAt: null, outcome: 'pending', receivedBytes: 0,
      writeBuffered: false, admittedBeforeSeal: false }
    data.records.push(record)
    pending = { record, expected }
    data.counts.txBytes += command.length
    deadline('response', requestedAt.monoAt + limits.responseTimeoutMs, (now) => {
      if (pending) expired(now)
    })
    try { record.writeBuffered = !socket.write(command) } catch { fault('socket-write-failed') }
  }
  function receive(chunk) {
    const now = stamp('data', pending?.record.id)
    data.counts.rxBytes += chunk.length
    if (data.counts.rxBytes > limits.maxRxBytes) { fault('receive-budget-exhausted'); return }
    if (!pending) { fault('unsolicited-response'); return }
    if (expired(now)) return
    const { record, expected } = pending
    const start = record.receivedBytes
    record.receivedBytes += chunk.length
    if (record.receivedBytes > limits.maxResponseBytes || record.receivedBytes > expected.length
      || !Buffer.isBuffer(chunk) || !chunk.equals(expected.subarray(start, record.receivedBytes))) {
      fault('response-framing-invalid'); return
    }
    if (record.receivedBytes === expected.length) {
      record.responseAt = now
      record.admittedBeforeSeal = !sealed && !stopping
      finishPending('matched')
    }
  }
  function completeStop() {
    if (!resolveStop) return
    cancel('close')
    data.cleanup = {
      cleanupConfirmed: closed && handles.size === 0 && pending === null,
      socketCreated: socket !== null, socketClosed: closed, socketDestroyed: socket?.destroyed === true,
      closeTimedOut, pendingRequests: pending ? 1 : 0, activeTimers: handles.size,
    }
    const report = copy(data)
    Object.assign(report, analyzeRedisFreezeWitness(report))
    const resolve = resolveStop
    resolveStop = null
    resolve(report)
  }
  data.createdAt = stamp('created')
  if (!data.createdAt || data.createdAt.monoAt >= limits.lifetimeMs) fault('invalid-initial-clock')
  else {
    deadline('lifetime', limits.lifetimeMs, (now) => expired(now))
    deadline('connect', data.createdAt.monoAt + limits.connectTimeoutMs, () => fault('connect-timeout'))
    try {
      data.counts.connections++
      socket = connect({ host: target.ip, port: target.port, family: 4 })
      socket.on('error', () => fault('socket-error'))
      socket.on('data', receive)
      socket.on('end', () => { if (!halted && !stopping) fault('unexpected-socket-end') })
      socket.on('close', () => {
        closed = true
        stamp('socket-closed')
        if (!halted && !stopping) fault('unexpected-socket-close')
        completeStop()
      })
      socket.once('connect', () => {
        const now = stamp('connected')
        if (!now || now.monoAt - data.createdAt.monoAt >= limits.connectTimeoutMs) { fault('connect-timeout'); return }
        if (halted || stopping || expired(now, null)) return
        if (typeof socket.remoteAddress !== 'string'
          || socket.remoteAddress.replace(/^::ffff:/, '') !== target.ip || socket.remotePort !== target.port) {
          fault('remote-endpoint-mismatch'); return
        }
        cancel('connect')
        connected = true
        data.connectedAt = now
        try { socket.setNoDelay(true) } catch { fault('socket-configuration-failed'); return }
        schedule('period', send, limits.periodMs, true)
        send()
      })
    } catch { fault('socket-connect-failed'); if (!socket) closed = true }
  }

  function admissionBeforePause() {
    if (data.admission?.valid === false) return copy(data.admission)
    const checkedAt = stamp('admission')
    const issues = [...data.transportIssues, ...clockIssues(data.stamps, limits)]
    if (!checkedAt || checkedAt.monoAt >= limits.lifetimeMs) issues.push('admission-lifetime-exhausted')
    if (!connected || closed || halted || acknowledged || sealed || stopping) issues.push('admission-not-active')
    const completed = data.records.filter((record) => record.outcome === 'matched')
    const last = completed.at(-1)
    if (completed.length < limits.minAdmissionReplies) issues.push('admission-insufficient-replies')
    if (last && checkedAt && (checkedAt.monoAt - last.requestedAt.monoAt > limits.maxAdmissionAgeMs
      || checkedAt.monoAt - last.responseAt.monoAt > limits.maxAdmissionAgeMs)) issues.push('admission-stale')
    if (pending && checkedAt && checkedAt.monoAt - pending.record.requestedAt.monoAt >= limits.responseTimeoutMs) {
      issues.push('admission-pending-expired')
    }
    data.admission = { valid: issues.length === 0, issues: unique(issues), checkedAt,
      completedReplies: completed.length, pendingRequests: pending ? 1 : 0,
      latestRequestAt: last?.requestedAt ?? null, latestResponseAt: last?.responseAt ?? null }
    return copy(data.admission)
  }
  function pauseAttempted() {
    if (data.marks.pauseAttempted || !admissionBeforePause().valid) throw new Error('Redis witness admission refused')
    const now = stamp('pause-attempted')
    if (!now) { fault('pause-attempt-clock-invalid'); throw new Error('Redis witness clock invalid') }
    // Admission and this stamp are separate reads. Refuse before the owner's
    // POST if the last read crossed the absolute observation lifetime.
    if (now.monoAt >= limits.lifetimeMs) {
      data.admission = { ...data.admission, valid: false,
        issues: unique([...data.admission.issues, 'pause-attempt-deadline-exceeded']) }
      fault('pause-attempt-deadline-exceeded')
      throw new Error('Redis witness pause attempt exceeds lifetime')
    }
    data.marks.pauseAttempted = now
  }
  function pauseAcknowledged() {
    // Stop writes before a clock read that can fail. A delayed timer does not
    // make an ACK outside the lifetime valid or excuse the owner's cleanup.
    cancel('period')
    if (data.marks.pauseAcknowledged) return
    const now = stamp('pause-acknowledged')
    if (!now || !data.marks.pauseAttempted || sealed || stopping) { fault('pause-ack-invalid'); return }
    data.marks.pauseAcknowledged = now
    if (now.monoAt >= limits.lifetimeMs) { fault('pause-ack-deadline-exceeded'); return }
    acknowledged = true
  }
  function sealBeforeUnpause() {
    if (sealed) return
    sealed = true
    cancel('period')
    data.marks.sealed = stamp('sealed')
    if (!data.marks.sealed) fault('seal-clock-invalid')
  }
  // Intentionally not async: repeated callers get this exact same Promise.
  function stop(reason) {
    if (stopPromise) return stopPromise
    stopPromise = new Promise((resolve) => { resolveStop = resolve })
    stopping = true
    sealBeforeUnpause()
    data.marks.stopped = stamp('stopped')
    if (reason) data.transportIssues.push('caller-reported-error')
    finishPending('cancelled')
    destroy()
    if (!socket) closed = true
    if (closed) completeStop()
    else schedule('close', () => {
      closeTimedOut = true
      data.transportIssues.push('socket-close-timeout')
      completeStop()
    }, limits.closeTimeoutMs)
    return stopPromise
  }
  return { admissionBeforePause, pauseAttempted, pauseAcknowledged, sealBeforeUnpause, stop }
}
