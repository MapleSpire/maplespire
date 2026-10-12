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

import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads'
import { RedisRuntime, redisRuntimeConfig } from '../runtime/redis.js'

export interface WorkerPartitionLease {
  partition: number
  token: string
  ownerValue: string
  incarnation: number
}

type ExpectedLease = Pick<WorkerPartitionLease, 'partition' | 'ownerValue'> & { incarnation?: number }

interface PartitionLeaseWorkerOptions {
  cellId: string
  advertiseUrl: string | null
  generation: string
  ttlMs: number
  renewIntervalMs: number
  keyPrefix: string
  /** Must be threaded all the way to the RedisRuntime below. A timeout that
   * stays in the config object and never reaches a connection looks fixed and
   * changes nothing. */
  commandTimeoutMs: number
}

type WorkerRequest = { replyPort: MessagePort } & (
  | { id: number; type: 'acquire'; partition: number }
  | { id: number; type: 'release'; lease: ExpectedLease }
  | { id: number; type: 'stop' })

type ClientRequest =
  | { type: 'acquire'; partition: number }
  | { type: 'release'; lease: ExpectedLease }
  | { type: 'stop' }

type WorkerResponse =
  | { id: number; ok: true; value: WorkerPartitionLease | boolean | null }
  | { id: number; ok: false; error: string }
  | { type: 'lost'; lease: WorkerPartitionLease; reason: string }
  | { type: 'ready' }

/**
 * How long the thread may take to load its module graph and install its
 * message handler. That is not a Redis command, so the request deadline
 * (`commandTimeoutMs + 50`, 325 ms on the bench) must not cover it: measured
 * 2026-10-12, the import alone takes 156-170 ms inside the bench image on a
 * developer machine, and on a two-vCPU GitHub runner the first acquire
 * outlived 325 ms on every cell, latching `worker-unresponsive` so that no
 * cell ever became ready.
 */
const WORKER_BOOT_TIMEOUT_MS = 10_000

const ACQUIRE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then return { '0', current } end
local token = redis.call('INCR', KEYS[2])
local value = ARGV[1] .. '|' .. tostring(token) .. '|' .. ARGV[3]
redis.call('PSETEX', KEYS[1], ARGV[2], value)
return { tostring(token), value }
`

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

function keys(options: PartitionLeaseWorkerOptions, partition: number): [string, string] {
  const base = `${options.keyPrefix}:sync-cell:partition:${options.generation}:${partition}`
  return [`${base}:owner`, `${base}:fence`]
}

async function runPartitionLeaseWorker(options: PartitionLeaseWorkerOptions & { leaseProof: SharedArrayBuffer }): Promise<void> {
  if (!parentPort) throw new Error('partition lease worker requires a parent port')
  const port = parentPort
  const proof = new BigInt64Array(options.leaseProof)
  // The lease connection gets the DERIVED timeout, not the general runtime's
  // 1500 ms default — which equals the partition lease TTL, so one stalled
  // renew would consume the entire lease and drop the partition.
  const runtime = new RedisRuntime(
    { ...redisRuntimeConfig(), commandTimeoutMs: options.commandTimeoutMs },
    'partition-lease',
  )
  let current: WorkerPartitionLease | null = null
  let renewTimer: ReturnType<typeof setInterval> | null = null
  let renewFlight: Promise<void> | null = null
  let stopped = false

  const post = (message: WorkerResponse): void => port.postMessage(message)
  const lose = (reason: string): void => {
    const lease = current
    current = null
    Atomics.store(proof, 0, 0n)
    if (lease) post({ type: 'lost', lease, reason })
  }
  const renew = async (): Promise<void> => {
    if (stopped || !current || renewFlight) return
    const lease = current
    const [ownerKey] = keys(options, lease.partition)
    const startedAt = Date.now()
    const running = (async () => {
      try {
        const renewed = Number(await runtime.send<number>([
          'EVAL', RENEW_SCRIPT, '1', ownerKey, lease.ownerValue, String(options.ttlMs),
        ])) === 1
        if (current === lease && !stopped) {
          if (renewed) Atomics.store(proof, 1, BigInt(startedAt))
          else lose('lease-lost')
        }
      } catch {
        if (current === lease && !stopped) lose('redis-unavailable')
      }
    })().finally(() => {
      if (renewFlight === running) renewFlight = null
    })
    renewFlight = running
    await running
  }
  const ensureTimer = (): void => {
    if (renewTimer) return
    renewTimer = setInterval(() => { void renew() }, options.renewIntervalMs)
    renewTimer.unref?.()
  }
  const release = async (lease: ExpectedLease): Promise<boolean> => {
    if (current?.ownerValue === lease.ownerValue && current.partition === lease.partition
      && current.incarnation !== lease.incarnation) return false
    if (current?.ownerValue === lease.ownerValue && current.partition === lease.partition) {
      current = null
      Atomics.store(proof, 0, 0n)
    }
    const [ownerKey] = keys(options, lease.partition)
    return Number(await runtime.send<number>([
      'EVAL', RELEASE_SCRIPT, '1', ownerKey, lease.ownerValue,
    ])) === 1
  }
  const handle = async (message: WorkerRequest): Promise<void> => {
    const reply = (response: WorkerResponse): void => message.replyPort.postMessage(response)
    try {
      if (message.type === 'stop') {
        if (current) await release(current).catch(() => false)
        await runtime.stop()
        reply({ id: message.id, ok: true, value: true })
        return
      }
      if (stopped) throw new Error('worker-stopped')
      await runtime.start()
      if (stopped) throw new Error('worker-stopped')
      if (message.type === 'acquire') {
        if (current) {
          // The main event loop can temporarily forget its local proof while
          // this isolated keeper still owns another partition. Never discard
          // that live lease merely because the deterministic probe loop asks
          // about an earlier partition first; it will reach the owned one.
          reply({
            id: message.id,
            ok: true,
            value: current.partition === message.partition ? current : null,
          })
          return
        }
        const [ownerKey, sequenceKey] = keys(options, message.partition)
        const startedAt = Date.now()
        const result = await runtime.send<Array<string | number>>([
          'EVAL', ACQUIRE_SCRIPT, '2', ownerKey, sequenceKey,
          options.cellId, String(options.ttlMs), options.advertiseUrl ?? '',
        ])
        const token = String(result[0] ?? '0')
        const acquired = token === '0'
          ? null
          : { partition: message.partition, token, ownerValue: String(result[1]), incarnation: message.id }
        if (stopped) {
          if (acquired) await release(acquired).catch(() => false)
          throw new Error('worker-stopped')
        }
        current = acquired
        if (current) {
          // One writer; an incarnation is never reused. Invalidate before
          // replacing the pair so a bounded id/time/id read cannot mix leases.
          Atomics.store(proof, 0, 0n)
          Atomics.store(proof, 1, BigInt(startedAt))
          Atomics.store(proof, 0, BigInt(current.incarnation))
          ensureTimer()
        }
        reply({ id: message.id, ok: true, value: current })
        return
      }
      if (message.type === 'release') {
        reply({ id: message.id, ok: true, value: await release(message.lease) })
        return
      }
    } catch (error) {
      reply({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      message.replyPort.close()
    }
  }
  let queue = Promise.resolve()
  port.on('message', (message: WorkerRequest) => {
    // Admission of stop is terminal even when an earlier command owns the
    // queue. Its eventual completion must not publish or renew authority.
    if (message.type === 'stop') {
      stopped = true
      Atomics.store(proof, 0, 0n)
      if (renewTimer) clearInterval(renewTimer)
    }
    queue = queue.then(() => handle(message)).catch(() => undefined)
  })
  post({ type: 'ready' })
}

export class PartitionLeaseWorkerClient {
  private readonly worker: Worker
  private readonly proof = new BigInt64Array(new SharedArrayBuffer(16))
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<number, {
    resolve: (value: WorkerPartitionLease | boolean | null) => void
    reject: (error: Error) => void
    cleanup: () => void
  }>()
  private nextId = 1
  private current: WorkerPartitionLease | null = null
  private stopping = false
  private failure: Error | null = null
  private stopFlight: Promise<void> | null = null
  private terminateFlight: Promise<number> | null = null
  private releasePending = 0
  private authorityEpoch = 0
  private ready = false
  /** Settles when the thread reports ready, fails or exits; never rejects. */
  private readonly booted: Promise<void>
  private settleBoot: () => void = () => undefined
  private bootTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    options: PartitionLeaseWorkerOptions,
    private readonly onLost: (lease: WorkerPartitionLease, reason: string) => void,
  ) {
    this.requestTimeoutMs = options.commandTimeoutMs + 50
    this.booted = new Promise((resolve) => {
      this.settleBoot = () => {
        if (this.bootTimer) clearTimeout(this.bootTimer)
        this.bootTimer = null
        resolve()
      }
    })
    this.worker = new Worker(new URL('./partitionLeaseWorker.js', import.meta.url), {
      workerData: { ...options, leaseProof: this.proof.buffer },
    })
    this.bootTimer = setTimeout(() => this.fail(new Error('worker-boot-timeout')), WORKER_BOOT_TIMEOUT_MS)
    this.worker.on('message', (message: WorkerResponse) => {
      if ('type' in message && message.type === 'ready') {
        this.ready = true
        this.settleBoot()
        return
      }
      if (!('id' in message) && !this.stopping && !this.failure
        && this.current?.incarnation === message.lease.incarnation
        && this.current.partition === message.lease.partition
        && this.current.ownerValue === message.lease.ownerValue) {
        this.current = null
        this.authorityEpoch += 1
        this.onLost(message.lease, message.reason)
      }
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => {
      this.settleBoot()
      if (!this.stopping || this.pending.size > 0) {
        this.fail(new Error(`partition lease worker exited before completion with code ${code}`))
      }
    })
  }

  /** A failure is terminal for this client: every later request rethrows it.
   * The coordinator replaces a failed client rather than reusing it. */
  get failed(): Error | null {
    return this.failure
  }

  async acquire(partition: number): Promise<WorkerPartitionLease | null> {
    if (this.stopping) throw new Error('worker-stopped')
    if (this.releasePending) throw new Error('worker-release-pending')
    const epoch = this.authorityEpoch
    const result = await this.request({ type: 'acquire', partition })
    if (this.failure) throw this.failure
    if (this.stopping || epoch !== this.authorityEpoch) return null
    if (!result || typeof result !== 'object' || this.readProof(result) === null) return null
    this.current = result
    return result
  }

  async release(lease: ExpectedLease): Promise<boolean> {
    if (this.current?.ownerValue === lease.ownerValue && this.current.partition === lease.partition
      && this.current.incarnation === lease.incarnation) this.current = null
    this.authorityEpoch += 1
    this.releasePending += 1
    try {
      return await this.request({ type: 'release', lease }) === true
    } finally {
      this.releasePending -= 1
    }
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight
    this.stopping = true
    this.current = null
    this.authorityEpoch += 1
    this.stopFlight = (async () => {
      // A thread that has not reported ready has been sent nothing, so it can
      // hold no lease: terminate it rather than wait out its boot deadline.
      if (!this.ready) {
        this.settleBoot()
        await this.terminate()
        return
      }
      try {
        await this.request({ type: 'stop' })
      } finally {
        await this.terminate()
      }
    })()
    return this.stopFlight
  }

  lastRenewStartedAt(expectedLease: ExpectedLease): number | null {
    if (this.stopping || this.failure || !this.current
      || this.current.partition !== expectedLease.partition
      || this.current.ownerValue !== expectedLease.ownerValue
      || this.current.incarnation !== expectedLease.incarnation) return null
    return this.readProof(expectedLease)
  }

  private readProof(expectedLease: ExpectedLease): number | null {
    const incarnation = Atomics.load(this.proof, 0)
    const startedAt = Number(Atomics.load(this.proof, 1))
    if (incarnation <= 0n || incarnation !== Atomics.load(this.proof, 0)
      || !Number.isSafeInteger(expectedLease.incarnation)
      || incarnation !== BigInt(expectedLease.incarnation!)
      || !Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > Date.now()) return null
    return startedAt
  }

  private request(message: ClientRequest): Promise<WorkerPartitionLease | boolean | null> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.stopping && message.type !== 'stop') return Promise.reject(new Error('worker-stopped'))
    // Nothing is posted before the thread is ready, so the deadline below
    // starts with the worker able to answer. `booted` also settles on failure
    // and exit, which is why `ready` is checked again rather than assumed.
    if (!this.ready) {
      return this.booted.then(() => {
        if (!this.ready) throw this.failure ?? new Error('worker-stopped')
        return this.request(message)
      })
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel()
      const settle = (response: WorkerResponse): void => {
        const request = this.pending.get(id)
        if (!request || !('id' in response) || response.id !== id) return
        this.pending.delete(id)
        request.cleanup()
        if (response.ok) request.resolve(response.value)
        else request.reject(new Error(response.error))
      }
      const timer = setTimeout(() => {
        // The worker may have answered while this thread was blocked. Consume
        // that response synchronously before treating a late timer as silence.
        const queued = receiveMessageOnPort(port1)
        if (queued) settle(queued.message as WorkerResponse)
        if (this.pending.has(id)) this.fail(new Error('worker-unresponsive'))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, cleanup: () => {
        clearTimeout(timer)
        port1.close()
        port2.close()
      } })
      port1.on('message', settle)
      try {
        this.worker.postMessage({ ...message, id, replyPort: port2 } as WorkerRequest, [port2])
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.settleBoot()
    const pending = [...this.pending.values()]
    this.pending.clear()
    const lease = this.current
    this.current = null
    this.authorityEpoch += 1
    for (const request of pending) {
      request.cleanup()
      request.reject(error)
    }
    // Termination is also needed after an unacknowledged acquire: the worker
    // may hold and renew a lease that the coordinator never got to publish.
    void this.terminate().catch(() => undefined)
    if (lease) this.onLost(lease, 'worker-failed')
  }

  private terminate(): Promise<number> {
    this.terminateFlight ??= this.worker.terminate()
    return this.terminateFlight
  }
}

if (!isMainThread) {
  void runPartitionLeaseWorker(workerData as PartitionLeaseWorkerOptions & { leaseProof: SharedArrayBuffer }).catch((error) => {
    console.error('[sync-cell] partition lease worker failed:', error)
    process.exitCode = 1
  })
}
