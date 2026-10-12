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
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

/** Own every Worker before awaiting initialization. An abandoned operation is
 * never replayed: its mutation may already have happened. The main process's
 * AbortSignal stops admission, sleeps and the external baseline barrier too. */
export class LoadUserCohort {
  // Startup is a module load (Automerge's wasm included), not a request to the
  // product, so it gets the request ceiling: on a two-vCPU GitHub runner shared
  // with three cells and the other load processes, user 16's Worker outlived
  // 10 s (load-soak leg, run 38189789130).
  constructor({ episodeId, readyTimeoutMs = 30_000, requestTimeoutMs = 30_000,
    closeTimeoutMs = 10_000, workerUrl = new URL('./load-user-worker.mjs', import.meta.url) }) {
    this.id = randomUUID()
    this.episodeId = episodeId
    this.readyTimeoutMs = readyTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.closeTimeoutMs = closeTimeoutMs
    this.workerUrl = workerUrl
    this.clients = []
    this.sequence = 0
    this.controller = new AbortController()
    this.signal = this.controller.signal
    this.closing = false
    this.closePromise = null
  }

  check() {
    this.signal.throwIfAborted()
    if (this.closing) throw new Error('load cohort is closing')
  }

  fail(error, client) {
    const cause = error instanceof Error ? error : new Error(String(error))
    if (client) client.error ??= cause.message
    if (this.closing) {
      this.rejectPending(client, cause)
      return
    }
    if (!this.signal.aborted) this.controller.abort(cause)
    for (const entry of this.clients) {
      entry.rejectReady(cause)
      this.rejectPending(entry, cause)
    }
  }

  rejectPending(client, error) {
    if (!client?.pending) return
    const pending = client.pending
    client.pending = null
    client.abandoned = true
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  async add(user, config) {
    this.check()
    assert.ok(Number.isSafeInteger(user) && user >= 0)
    assert.ok(!this.clients.some(client => client.i === user), 'duplicate load user')
    let resolveReady, rejectReady, resolveExit
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    ready.catch(() => {})
    const exit = new Promise(resolve => { resolveExit = resolve })
    const client = { i: user, ready: false, exited: false, exitCode: null,
      pending: null, abandoned: false, error: null, rejectReady, exit, worker: null }
    const worker = new Worker(this.workerUrl, {
      workerData: { cohortId: this.id, episodeId: this.episodeId, user, config },
      stdout: true, stderr: true, execArgv: [],
    })
    client.worker = worker
    client.threadId = worker.threadId
    this.clients.push(client)
    // Resource ownership precedes timers, message handling and every await.
    worker.on('error', error => this.fail(error, client))
    worker.on('messageerror', error => this.fail(error, client))
    worker.on('exit', code => {
      clearTimeout(client.readyTimer)
      client.exited = true
      client.exitCode = code
      resolveExit(code)
      if (!this.closing || client.pending) this.fail(new Error(`user ${user} exited unexpectedly (${code})`), client)
    })
    const output = chunk => process.stderr.write(`[load user ${user}] ${chunk}`)
    worker.stdout.on('data', output)
    worker.stderr.on('data', output)
    worker.on('message', message => {
      try {
        assert.equal(message?.cohortId, this.id, 'cohort identity')
        assert.equal(message.episodeId, this.episodeId, 'episode identity')
        assert.equal(message.user, user, 'user identity')
        assert.equal(message.threadId, client.threadId, 'actual Worker identity')
        assert.equal(message.pid, process.pid, 'Worker process identity')
        if (message.type === 'load-user-ready') {
          assert.equal(client.ready, false, 'duplicate Worker readiness')
          assert.equal(message.protocol, 1)
          client.ready = true
          clearTimeout(client.readyTimer)
          resolveReady(client)
          return
        }
        assert.equal(message.type, 'load-user-reply')
        const pending = client.pending
        assert.ok(pending, 'reply without an outstanding request')
        assert.equal(message.requestId, pending.requestId, 'request identity')
        assert.equal(message.operation, pending.operation, 'operation identity')
        assert.deepEqual(message.context, pending.context, 'phase/round/poll identity')
        client.pending = null
        clearTimeout(pending.timer)
        if (message.ok !== true) {
          const error = new Error(`user ${user} ${pending.operation}: ${message.error ?? 'unknown failure'}`)
          pending.reject(error)
          this.fail(error, client)
          return
        }
        pending.resolve(message.result)
      } catch (error) { this.fail(error, client) }
    })
    client.readyTimer = setTimeout(() => this.fail(new Error(`user ${user} Worker startup timed out`), client), this.readyTimeoutMs)
    await ready
    this.check()
    return client
  }

  call(client, operation, context = {}, payload = {}, { cleanup = false, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!cleanup) this.check()
    assert.ok(this.clients.includes(client) && client.ready && !client.exited, 'live owned Worker required')
    assert.equal(client.pending, null, 'one request per Worker at a time')
    const requestId = ++this.sequence
    const copiedContext = structuredClone(context)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`user ${client.i} ${operation} timed out; operation not replayed`), client), timeoutMs)
      client.pending = { requestId, operation, context: copiedContext, resolve, reject, timer }
      try {
        client.worker.postMessage({ cohortId: this.id, episodeId: this.episodeId,
          user: client.i, threadId: client.threadId, requestId, operation,
          context: copiedContext, payload })
      } catch (error) { this.fail(error, client) }
    })
  }

  async wait(ms) {
    this.check()
    await delay(ms, undefined, { signal: this.signal })
    this.check()
  }

  close() {
    this.closePromise ??= this.closeAll()
    return this.closePromise
  }

  async closeAll() {
    this.closing = true
    if (!this.signal.aborted) this.controller.abort(new Error('load cohort closed'))
    const startedAt = Date.now()
    const deadline = performance.now() + this.closeTimeoutMs
    const receipts = await Promise.all(this.clients.map(async client => {
      clearTimeout(client.readyTimer)
      client.rejectReady(new Error('load cohort closed during admission'))
      const receipt = { user: client.i, threadId: client.threadId, forced: false,
        shutdown: null, error: null, exited: false, exitCode: null }
      let timer
      try {
        if (!client.exited && client.ready && !client.abandoned) {
          receipt.shutdown = await this.call(client, 'shutdown', { phase: 'cleanup' }, {}, {
            cleanup: true, timeoutMs: Math.max(1, deadline - performance.now()),
          })
        }
        if (!client.exited) {
          if (!client.ready || client.abandoned) throw new Error('incomplete or abandoned Worker needs termination')
          await Promise.race([client.exit, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Worker exit deadline')), Math.max(1, deadline - performance.now()))
          })])
        }
        if (client.exitCode !== 0) throw new Error(`Worker exited ${client.exitCode}`)
      } catch (error) {
        receipt.error = error.message
        if (!client.exited) {
          receipt.forced = true
          await client.worker.terminate()
          await client.exit
        }
      } finally {
        clearTimeout(timer)
        this.rejectPending(client, new Error('load cohort closed'))
        receipt.exited = client.exited
        receipt.exitCode = client.exitCode
        receipt.error ??= client.error
      }
      return receipt
    }))
    return { cohortId: this.id, episodeId: this.episodeId, pid: process.pid,
      startedAt, completedAt: Date.now(), workers: receipts,
      clean: receipts.every(r => r.exited && r.exitCode === 0 && !r.forced && !r.error && r.shutdown?.closed === true) }
  }
}
