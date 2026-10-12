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

import { EventEmitter } from 'node:events'
import type { MessageChannel, MessagePort } from 'node:worker_threads'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PartitionLeaseWorkerClient, type WorkerPartitionLease } from './partitionLeaseWorker.js'

const transport = vi.hoisted(() => ({ create: vi.fn(), channels: [] as MessageChannel[] }))
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: function (...args: unknown[]) { return transport.create(...args) },
    // Keep the actual native queues and receiveMessageOnPort. Only the worker
    // is simulated: posting a reply does not synchronously deliver its event.
    MessageChannel: function () {
      const channel = new actual.MessageChannel()
      transport.channels.push(channel)
      return channel
    },
  }
})

interface Request {
  id: number
  type: 'acquire' | 'release' | 'stop'
  partition?: number
  lease?: WorkerPartitionLease
  replyPort: MessagePort
}

const fixtures: ReturnType<typeof fixture>[] = []
const cleanupCallbacks: Array<() => void> = []
const epoch = 1_800_000_000_000
const leaseA: WorkerPartitionLease = {
  partition: 0, token: '11', ownerValue: 'test|11|', incarnation: 1,
}
const leaseB: WorkerPartitionLease = {
  partition: 0, token: '12', ownerValue: 'test|12|', incarnation: 2,
}

function fixture({ booted = true } = {}) {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn<(message: Request, transferList?: unknown[]) => void>(),
    terminate: vi.fn(async () => 0),
  })
  transport.create.mockReturnValue(worker)
  const lost = vi.fn()
  const client = new PartitionLeaseWorkerClient({
    cellId: 'test', advertiseUrl: null, generation: 'test', ttlMs: 750,
    renewIntervalMs: 200, keyPrefix: 'test', commandTimeoutMs: 100,
  }, lost)
  // The real thread announces itself once its handler is installed.
  if (booted) worker.emit('message', { type: 'ready' })
  // Observe rejection immediately even if a fixture assertion throws before
  // the test reaches its await. Return the original promises unchanged.
  const observe = <T>(promise: Promise<T>): Promise<T> => {
    void promise.catch(() => undefined)
    return promise
  }
  const originalAcquire = client.acquire.bind(client)
  const originalRelease = client.release.bind(client)
  const originalStop = client.stop.bind(client)
  client.acquire = (partition) => observe(originalAcquire(partition))
  client.release = (lease) => observe(originalRelease(lease))
  client.stop = () => observe(originalStop())
  const options = transport.create.mock.calls.at(-1)?.[1] as {
    workerData: { leaseProof: SharedArrayBuffer }
  }
  const proof = () => new BigInt64Array(options.workerData.leaseProof)
  const publish = (lease: WorkerPartitionLease, startedAt = epoch) => {
    expect(options.workerData.leaseProof instanceof SharedArrayBuffer).toBe(true)
    expect(options.workerData.leaseProof.byteLength).toBe(16)
    Atomics.store(proof(), 1, BigInt(startedAt))
    Atomics.store(proof(), 0, BigInt(lease.incarnation))
  }
  const request = (index = worker.postMessage.mock.calls.length - 1): Request => {
    const call = worker.postMessage.mock.calls[index]
    // Assertion formatting must never traverse native MessagePort internals.
    expect(call !== undefined, `request ${index} was actually sent`).toBe(true)
    expect(call[0].replyPort !== undefined).toBe(true)
    expect(call[1]?.some((port) => port === call[0].replyPort)).toBe(true)
    return call[0]
  }
  const reply = (message: Request, value: WorkerPartitionLease | boolean | null) => {
    message.replyPort.postMessage({ id: message.id, ok: true, value })
  }
  const result = { worker, client, lost, proof, publish, request, reply }
  fixtures.push(result)
  return result
}

function fakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(epoch)
}

async function acquire(f: ReturnType<typeof fixture>, lease = leaseA) {
  const acquiring = f.client.acquire(lease.partition)
  f.publish(lease, Date.now())
  f.reply(f.request(), lease)
  // No timer advance: this exercises ordinary asynchronous MessagePort delivery.
  expect(await acquiring).toEqual(lease)
}

beforeEach(() => {
  transport.create.mockReset()
  transport.channels.length = 0
  fixtures.length = 0
  cleanupCallbacks.length = 0
})

afterEach(async () => {
  // A failed assertion must not leave native ports or fake worker requests alive.
  for (const cleanup of cleanupCallbacks) cleanup()
  for (const f of fixtures) {
    f.worker.emit('error', new Error('test cleanup'))
    await f.client.stop().catch(() => undefined)
  }
  for (const channel of transport.channels) {
    channel.port1.close()
    channel.port2.close()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('bounds stop when a worker never answers and reaches termination', async () => {
  const f = fixture()
  const stopping = f.client.stop().then(() => 'settled', () => 'settled')
  let ceiling: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    stopping,
    new Promise<string>((resolve) => { ceiling = setTimeout(() => resolve('hung'), 195) }),
  ])
  try {
    expect(outcome).toBe('settled')
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  } finally {
    clearTimeout(ceiling)
    // Answer the pending request so `stop()` settles even if the implementation
    // loses its bound and this test is failing.
    const request = f.worker.postMessage.mock.calls[0]?.[0]
    if (request?.replyPort) f.reply(request, true)
    else if (request) f.worker.emit('message', { id: request.id, ok: true, value: true })
    await stopping
  }
})

it('takes an already queued native reply before declaring a timer-first timeout', async () => {
  fakeClock()
  const f = fixture()
  let delivered = false
  const acquiring = f.client.acquire(0).then((value) => { delivered = true; return value })
  const close = vi.spyOn(transport.channels[0].port1, 'close')
  f.publish(leaseA)
  f.reply(f.request(), leaseA)
  expect(delivered).toBe(false)
  // Do not yield to poll: run an overdue timer while the native reply is queued.
  vi.setSystemTime(epoch + 3_000)
  f.publish(leaseA, Date.now())
  vi.advanceTimersByTime(151)
  expect(await acquiring).toEqual(leaseA)
  expect(f.lost).not.toHaveBeenCalled()
  expect(f.worker.terminate).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('lets ordinary native reply delivery settle and cancel its request timer', async () => {
  fakeClock()
  const f = fixture()
  await acquire(f)
  expect(f.client.lastRenewStartedAt(leaseA)).toBe(epoch)
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(1_000)
  expect(f.lost).not.toHaveBeenCalled()
  expect(f.worker.terminate).not.toHaveBeenCalled()
})

it('drains each pending request from its own reply port when both answers are queued', async () => {
  fakeClock()
  const f = fixture()
  const first = f.client.acquire(0), second = f.client.acquire(0)
  const results = Promise.all([first, second])
  const request1 = f.request(0), request2 = f.request(1)
  expect(request1.id).not.toBe(request2.id)
  expect(request1.replyPort !== request2.replyPort).toBe(true)
  f.publish(leaseA)
  f.reply(request2, leaseA)
  f.reply(request1, leaseA)
  vi.advanceTimersByTime(151)
  expect(await results).toEqual([leaseA, leaseA])
  expect(f.worker.terminate).not.toHaveBeenCalled()
  expect(f.lost).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not treat a queued response for another request as its own completion', async () => {
  fakeClock()
  const f = fixture()
  const acquiring = f.client.acquire(0)
  const refused = expect(acquiring).rejects.toThrow('worker-unresponsive')
  const request = f.request()
  f.publish(leaseA)
  request.replyPort.postMessage({ id: request.id + 1, ok: true, value: leaseA })
  vi.advanceTimersByTime(151)
  await refused
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('fails all pending requests once, even while a separate lease heartbeat stays fresh', async () => {
  fakeClock()
  const f = fixture()
  await acquire(f)
  const all = Promise.allSettled([f.client.acquire(0), f.client.acquire(1)])
  expect(f.worker.postMessage).toHaveBeenCalledTimes(3)
  vi.advanceTimersByTime(100)
  f.publish(leaseA, Date.now())
  vi.advanceTimersByTime(51)
  const results = await all
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  for (const result of results) {
    if (result.status === 'rejected') expect(String(result.reason)).toContain('worker-unresponsive')
  }
  expect(f.lost).toHaveBeenCalledExactlyOnceWith(leaseA, 'worker-failed')
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not resurrect a timed-out acquire from a late reply or shared publication', async () => {
  fakeClock()
  const f = fixture()
  const acquiring = f.client.acquire(0)
  const refused = expect(acquiring).rejects.toThrow('worker-unresponsive')
  const oldRequest = f.request()
  vi.advanceTimersByTime(151)
  await refused
  f.publish(leaseA, Date.now())
  f.reply(oldRequest, leaseA)
  await Promise.resolve()
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  await expect(f.client.acquire(0)).rejects.toThrow()
  expect(f.worker.postMessage).toHaveBeenCalledTimes(1)
  await f.client.stop().catch(() => undefined)
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('settles stop if the worker exits before acknowledging it', async () => {
  fakeClock()
  const f = fixture()
  const stopped = Promise.allSettled([f.client.stop()])
  f.worker.emit('exit', 0)
  expect(await stopped).toHaveLength(1)
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('cleans pending requests and proof on unexpected error followed by exit', async () => {
  fakeClock()
  const f = fixture()
  await acquire(f)
  const acquiring = f.client.acquire(0)
  const rejected = expect(acquiring).rejects.toThrow('worker broke')
  f.worker.emit('error', new Error('worker broke'))
  f.worker.emit('exit', 1)
  await rejected
  expect(f.lost).toHaveBeenCalledExactlyOnceWith(leaseA, 'worker-failed')
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('cleans a synchronous postMessage failure and never reuses the failed worker', async () => {
  fakeClock()
  const f = fixture()
  f.worker.postMessage.mockImplementation(() => { throw new Error('cannot transfer') })
  await expect(f.client.acquire(0)).rejects.toThrow('cannot transfer')
  await expect(f.client.acquire(0)).rejects.toThrow()
  expect(f.worker.postMessage).toHaveBeenCalledTimes(1)
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('makes repeated stop callers await the same actual termination', async () => {
  fakeClock()
  const f = fixture()
  let finishTermination!: (code: number) => void
  const termination = new Promise<number>((resolve) => { finishTermination = resolve })
  f.worker.terminate.mockReturnValue(termination)
  cleanupCallbacks.push(() => finishTermination(0))
  let firstSettled = false, secondSettled = false
  const first = f.client.stop().then(() => { firstSettled = true })
  const second = f.client.stop().then(() => { secondSettled = true })
  expect(f.worker.postMessage).toHaveBeenCalledTimes(1)
  f.reply(f.request(), true)
  vi.advanceTimersByTime(151)
  await Promise.resolve()
  await Promise.resolve()
  try {
    expect(f.worker.terminate).toHaveBeenCalledTimes(1)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
  } finally {
    finishTermination?.(0)
  }
  await Promise.all([first, second])
  expect(firstSettled && secondSettled).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses an acquire that completes after stop has begun', async () => {
  fakeClock()
  const f = fixture()
  const acquiring = f.client.acquire(0)
  const acquisitionResult = Promise.allSettled([acquiring])
  const acquireRequest = f.request()
  const stopping = f.client.stop()
  const stopResult = Promise.allSettled([stopping])
  const stopRequest = f.request()
  f.publish(leaseA)
  f.reply(acquireRequest, leaseA)
  f.reply(stopRequest, true)
  vi.advanceTimersByTime(151)
  const result = (await acquisitionResult)[0]
  expect(result.status === 'rejected' || result.value === null).toBe(true)
  expect((await stopResult)[0].status).toBe('fulfilled')
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('invalidates before awaiting release and refuses another acquire during release', async () => {
  fakeClock()
  const f = fixture()
  await acquire(f)
  const releasing = f.client.release(leaseA)
  const releaseRequest = f.request()
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  await expect(f.client.acquire(0)).rejects.toThrow()
  expect(f.worker.postMessage).toHaveBeenCalledTimes(2)
  f.reply(releaseRequest, true)
  expect(await releasing).toBe(true)
  await acquire(f, leaseB)
  expect(f.client.lastRenewStartedAt(leaseB)).toBe(Date.now())
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('requires a current matching incarnation and a complete representable timestamp', async () => {
  fakeClock()
  const f = fixture()
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  await acquire(f)
  expect(f.client.lastRenewStartedAt({ ...leaseA, incarnation: 2 })).toBeNull()
  expect(f.client.lastRenewStartedAt({ ...leaseA, ownerValue: 'foreign|11|' })).toBeNull()
  Atomics.store(f.proof(), 0, 0n)
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  Atomics.store(f.proof(), 0, 2n)
  expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  Atomics.store(f.proof(), 0, 1n)
  for (const timestamp of [-1n, BigInt(Date.now() + 1), BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    Atomics.store(f.proof(), 1, timestamp)
    expect(f.client.lastRenewStartedAt(leaseA)).toBeNull()
  }
  f.publish(leaseA)
  expect(f.client.lastRenewStartedAt(leaseA)).toBe(epoch)
})

it('refuses nonpositive or unsafe acquisition incarnations even when shared words agree', async () => {
  fakeClock()
  const f = fixture()
  for (const incarnation of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...leaseA, incarnation }
    const acquiring = f.client.acquire(0)
    f.publish(invalid)
    f.reply(f.request(), invalid)
    expect(await acquiring).toBeNull()
    expect(f.client.lastRenewStartedAt(invalid)).toBeNull()
  }
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the new proof when an old lease loss or release arrives', async () => {
  fakeClock()
  const f = fixture()
  await acquire(f)
  const releasingA = f.client.release(leaseA)
  f.reply(f.request(), true)
  await releasingA
  await acquire(f, leaseB)
  f.worker.emit('message', { type: 'lost', lease: leaseA, reason: 'lease-lost' })
  expect(f.client.lastRenewStartedAt(leaseB)).toBe(epoch)
  const oldRelease = f.client.release(leaseA)
  expect(f.client.lastRenewStartedAt(leaseB)).toBe(epoch)
  f.reply(f.request(), false)
  expect(await oldRelease).toBe(false)
  expect(f.client.lastRenewStartedAt(leaseB)).toBe(epoch)
  f.worker.emit('message', { type: 'lost', lease: leaseB, reason: 'lease-lost' })
  expect(f.client.lastRenewStartedAt(leaseB)).toBeNull()
  expect(f.lost).toHaveBeenLastCalledWith(leaseB, 'lease-lost')
})

it('cleans a rejected worker response while allowing a later request', async () => {
  fakeClock()
  const f = fixture()
  const first = f.client.acquire(0)
  const rejected = expect(first).rejects.toThrow('redis-unavailable')
  const request = f.request()
  request.replyPort.postMessage({ id: request.id, ok: false, error: 'redis-unavailable' })
  await rejected
  expect(vi.getTimerCount()).toBe(0)
  const second = f.client.acquire(1)
  f.reply(f.request(), null)
  expect(await second).toBeNull()
  expect(f.worker.terminate).not.toHaveBeenCalled()
  expect(f.lost).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not count a slow thread boot against the request deadline', async () => {
  fakeClock()
  const f = fixture({ booted: false })
  const acquiring = f.client.acquire(0)
  // Far past the 150 ms request deadline: nothing was sent, so nothing expired.
  await vi.advanceTimersByTimeAsync(5_000)
  expect(f.worker.postMessage).not.toHaveBeenCalled()
  expect(f.worker.terminate).not.toHaveBeenCalled()
  f.worker.emit('message', { type: 'ready' })
  await vi.advanceTimersByTimeAsync(0)
  f.publish(leaseA, Date.now())
  f.reply(f.request(), leaseA)
  expect(await acquiring).toEqual(leaseA)
  expect(f.lost).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('fails a thread that never reports ready, and every request waiting on it', async () => {
  fakeClock()
  const f = fixture({ booted: false })
  const refused = expect(f.client.acquire(0)).rejects.toThrow('worker-boot-timeout')
  expect(f.client.failed).toBeNull()
  await vi.advanceTimersByTimeAsync(9_999)
  expect(f.worker.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await refused
  // The coordinator replaces a client on this signal; it must name the failure.
  expect(f.client.failed?.message).toBe('worker-boot-timeout')
  expect(f.worker.postMessage).not.toHaveBeenCalled()
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  await expect(f.client.acquire(1)).rejects.toThrow('worker-boot-timeout')
  expect(vi.getTimerCount()).toBe(0)
})

it('releases a request waiting on boot when the thread exits first', async () => {
  fakeClock()
  const f = fixture({ booted: false })
  const refused = expect(f.client.acquire(0)).rejects.toThrow('exited before completion')
  f.worker.emit('exit', 1)
  await refused
  expect(f.worker.postMessage).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('stops a thread that never reported ready without waiting out its boot deadline', async () => {
  fakeClock()
  const f = fixture({ booted: false })
  const refused = expect(f.client.acquire(0)).rejects.toThrow('worker-stopped')
  await f.client.stop()
  await refused
  expect(f.worker.postMessage).not.toHaveBeenCalled()
  expect(f.worker.terminate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
