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
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

/** A bounded observation, not cancellation. A false result is retained as an
 * unconfirmed cleanup obligation by the caller. */
export async function observeSettlement(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([Promise.resolve(promise).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })])
  } finally { clearTimeout(timer) }
}

async function stopWindowsTree(child, spawnProcess, killTimeoutMs) {
  const result = { code: null, signal: null, closed: false, timedOut: false, spawnError: false }
  let killer
  try {
    killer = spawnProcess('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => { result.spawnError = true })
    const closed = new Promise(done => killer.once('close', (code, signal) => {
      result.closed = true; result.code = code; result.signal = signal; done()
    }))
    if (!await observeSettlement(closed, killTimeoutMs)) {
      result.timedOut = true
      // This is our still-owned ChildProcess handle, not a PID rediscovered
      // after exit. A failed kill remains invalid even if close arrives later.
      try { killer.kill('SIGKILL') } catch { result.killFailed = true }
      await observeSettlement(closed, killTimeoutMs)
      if (!result.closed) killer.unref()
    }
  } catch { result.spawnError = true; killer?.unref() }
  return { ...result }
}

/** stdout/stderr closure is not a census of descendants. If the root already
 * exited, its PID cannot safely identify an orphan tree on Windows. Return a
 * bounded, explicitly unconfirmed receipt instead of hanging or certifying
 * a forced local pipe closure as successful process cleanup. */
export async function captureDedicatedNative(file, args, {
  cwd, env, signal, timeoutMs = 30_000, joinTimeoutMs = 5_000, killTimeoutMs = 5_000,
  spawnProcess = spawn, platform = process.platform,
} = {}) {
  for (const value of [timeoutMs, joinTimeoutMs, killTimeoutMs]) assert.ok(Number.isSafeInteger(value) && value > 0)
  const receipt = { startedAt: new Date().toISOString(), startedAtMs: performance.now(), pid: null,
    closed: false, rootExited: false, code: null, signal: null, timedOut: false, aborted: false,
    spawnError: null, captureError: null, captureDetached: false, cleanupConfirmed: false, cleanupIssues: [],
    cleanupScope: 'Direct child close and captured pipes only; no descendant census.' }
  const buffers = [[], []], lengths = [0, 0]
  let child, timer, abort, closedPromise, streamsClosed = [], captureFailed
  const failedCapture = new Promise(resolve => { captureFailed = resolve })
  try {
    assert.ok(!signal?.aborted, 'Native command was aborted before spawn')
    child = spawnProcess(file, args, { cwd, env, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    receipt.pid = child.pid ?? null
    streamsClosed = [child.stdout, child.stderr].map(stream => new Promise(done => stream.once('close', done)))
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      stream.on('data', bytes => {
        lengths[index] += bytes.length
        if (lengths[index] <= 8 * 1024 * 1024) buffers[index].push(Buffer.from(bytes))
        else { receipt.captureError = 'output-limit'; captureFailed('capture-failed') }
      })
      stream.once('error', () => { receipt.captureError = 'pipe-error'; captureFailed('capture-failed') })
    }
    child.once('error', error => { receipt.spawnError = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'spawn-error' })
    child.once('exit', () => { receipt.rootExited = true })
    closedPromise = new Promise(done => child.once('close', (code, endSignal) => {
      receipt.closed = true; receipt.code = code; receipt.signal = endSignal; done('closed')
    }))
    const aborted = new Promise(resolve => {
      abort = () => { receipt.aborted = true; resolve('aborted') }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    const deadline = new Promise(resolve => { timer = setTimeout(() => { receipt.timedOut = true; resolve('timeout') }, timeoutMs) })
    const outcome = await Promise.race([closedPromise, deadline, aborted, failedCapture])
    if (outcome !== 'closed') {
      if (receipt.rootExited || child.exitCode !== null) {
        receipt.cleanupIssues.push('root-exited-before-pipe-close')
      } else if (child.pid) {
        if (platform === 'win32') {
          receipt.treeKill = await stopWindowsTree(child, spawnProcess, killTimeoutMs)
          if (!receipt.treeKill.closed || receipt.treeKill.code !== 0 || receipt.treeKill.signal
            || receipt.treeKill.timedOut || receipt.treeKill.spawnError || receipt.treeKill.killFailed) {
            receipt.killError = true; receipt.cleanupIssues.push('tree-kill-unconfirmed')
          }
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); receipt.treeKill = { group: child.pid, sent: true } }
          catch { receipt.killError = true; receipt.cleanupIssues.push('tree-kill-unconfirmed') }
        }
      }
      if (!await observeSettlement(closedPromise, joinTimeoutMs)) {
        receipt.cleanupIssues.push('native-close-deadline')
        receipt.captureDetached = true
        child.stdout.destroy(); child.stderr.destroy(); child.unref()
        if (!await observeSettlement(Promise.all(streamsClosed), joinTimeoutMs)) receipt.cleanupIssues.push('capture-close-deadline')
      }
    }
    receipt.cleanupConfirmed = receipt.closed && !receipt.captureDetached && receipt.cleanupIssues.length === 0
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
    receipt.completedAtMs = performance.now(); receipt.completedAt = new Date().toISOString()
  }
  const [stdout, stderr] = buffers.map(chunks => Buffer.concat(chunks).toString('utf8'))
  // Late ChildProcess events may still be delivered after forced detachment.
  // They cannot rewrite the public receipt or erase its cleanup obligation.
  return { receipt: { ...receipt, cleanupIssues: [...receipt.cleanupIssues] }, stdout, stderr }
}
