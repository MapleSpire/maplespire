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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CommandKind = 'acquire' | 'renew' | 'release'
type Lease = { partition: number; token: string; ownerValue: string; incarnation: number }
type Reply = { id: number; ok: boolean; value?: Lease | boolean | null; error?: string }
type Request = { type: 'acquire'; partition: number } | { type: 'release'; lease: Lease } | { type: 'stop' }
const epoch = 1_800_000_000_000
const options = {
  cellId: 'runtime-test-cell', advertiseUrl: 'http://runtime-test.invalid:3001', generation: 'test-generation',
  ttlMs: 750, renewIntervalMs: 200, keyPrefix: 'runtime-test', commandTimeoutMs: 275,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(epoch)
  vi.resetModules()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.doUnmock('node:worker_threads')
  vi.doUnmock('../runtime/redis.js')
  vi.restoreAllMocks()
})

async function boot() {
  const proof = new BigInt64Array(new SharedArrayBuffer(16))
  const parentMessages: unknown[] = []
  const parent = Object.assign(new EventEmitter(), {
    postMessage: vi.fn((message: unknown) => { parentMessages.push(structuredClone(message)) }),
  })
  const commands: Array<{ kind: CommandKind; at: number; args: string[] }> = []
  const plans: Record<CommandKind, Array<() => Promise<unknown>>> = { acquire: [], renew: [], release: [] }
  let token = 0
  const runtime = {
    start: vi.fn(async (): Promise<void> => {}),
    stop: vi.fn(async (): Promise<void> => {}),
    send: vi.fn(async (args: string[]): Promise<unknown> => {
      expect(args[0]).toBe('EVAL')
      const script = args[1]
      const kind: CommandKind = script.includes('PSETEX') ? 'acquire'
        : script.includes('PEXPIRE') ? 'renew' : script.includes("redis.call('DEL'") ? 'release'
          : (() => { throw new Error('unexpected Redis script in runtime test') })()
      commands.push({ kind, at: Date.now(), args: [...args] })
      const plan = plans[kind].shift()
      if (plan) return await plan()
      if (kind === 'acquire') {
        token++
        return [String(token), `${options.cellId}|${token}|${options.advertiseUrl}`]
      }
      return 1
    }),
  }
  const create = vi.fn()
  vi.doMock('node:worker_threads', async (original) => ({
    ...await original<typeof import('node:worker_threads')>(),
    isMainThread: false,
    parentPort: parent,
    workerData: { ...options, leaseProof: proof.buffer },
  }))
  vi.doMock('../runtime/redis.js', () => ({
    redisRuntimeConfig: () => ({ commandTimeoutMs: 1500, marker: 'base-runtime-config' }),
    RedisRuntime: function (...args: unknown[]) { create(...args); return runtime },
  }))
  await import('./partitionLeaseWorker.js')
  expect(create).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledWith({ commandTimeoutMs: 275, marker: 'base-runtime-config' }, 'partition-lease')
  expect(parent.listenerCount('message')).toBe(1)
  // The client holds every request until this arrives, so a worker that never
  // says it is ready can never acquire a partition.
  expect(parentMessages).toEqual([{ type: 'ready' }])
  parentMessages.length = 0
  const readProof = () => [Atomics.load(proof, 0), Atomics.load(proof, 1)]
  expect(readProof()).toEqual([0n, 0n])
  let requestId = 0
  const enqueue = (request: Request, throwReply = false) => {
    const id = ++requestId, replies: Reply[] = [], proofAtReply: bigint[][] = []
    const replyPort = {
      postMessage: vi.fn((reply: Reply) => {
        proofAtReply.push(readProof())
        if (throwReply) throw new Error('test reply port failed')
        replies.push(structuredClone(reply))
      }),
      close: vi.fn(),
    }
    parent.emit('message', { ...request, id, replyPort })
    return { id, replies, proofAtReply, replyPort }
  }
  // Flush only the controlled Promise queue, without advancing Date.now or
  // inventing a worker reply. Suspended Redis commands remain suspended.
  const flush = () => vi.advanceTimersByTimeAsync(0)
  const request = async (message: Request) => { const exchange = enqueue(message); await flush(); return exchange }
  const acquire = async (partition = 0) => {
    const exchange = await request({ type: 'acquire', partition })
    expect(exchange.replies).toHaveLength(1)
    expect(exchange.replies[0]).toMatchObject({ id: exchange.id, ok: true, value: { partition, incarnation: exchange.id } })
    expect(exchange.replyPort.close).toHaveBeenCalledTimes(1)
    return { lease: exchange.replies[0].value as Lease, exchange }
  }
  const stop = async () => {
    const exchange = await request({ type: 'stop' })
    expect(exchange.replies).toEqual([{ id: exchange.id, ok: true, value: true }])
    expect(exchange.replyPort.close).toHaveBeenCalledTimes(1)
    expect(readProof()[0]).toBe(0n)
    expect(vi.getTimerCount()).toBe(0)
  }
  return { proof, readProof, parentMessages, commands, plans, runtime, enqueue, request, acquire, stop, flush }
}

describe('partition lease worker runtime shared proof', () => {
  it('publishes the full acquire departure only after Redis succeeds, before replying', async () => {
    const f = await boot(), starting = deferred<void>(), acquiring = deferred<unknown>()
    f.runtime.start.mockImplementationOnce(() => starting.promise)
    f.plans.acquire.push(() => acquiring.promise)
    const exchange = f.enqueue({ type: 'acquire', partition: 0 })
    await f.flush()
    expect(f.commands).toEqual([])
    expect(f.readProof()[0]).toBe(0n)
    vi.setSystemTime(epoch + 100)
    starting.resolve()
    await f.flush()
    expect(f.commands).toHaveLength(1)
    expect(f.commands[0]).toMatchObject({ kind: 'acquire', at: epoch + 100 })
    expect(f.readProof()[0]).toBe(0n)
    expect(exchange.replies).toEqual([])
    vi.setSystemTime(epoch + 400)
    acquiring.resolve(['7', 'runtime-test-cell|7|http://runtime-test.invalid:3001'])
    await f.flush()
    expect(f.readProof()).toEqual([BigInt(exchange.id), BigInt(epoch + 100)])
    expect(exchange.proofAtReply).toEqual([[BigInt(exchange.id), BigInt(epoch + 100)]])
    expect(exchange.replies).toEqual([{ id: exchange.id, ok: true, value: {
      partition: 0, token: '7', ownerValue: 'runtime-test-cell|7|http://runtime-test.invalid:3001', incarnation: exchange.id,
    } }])
    expect(exchange.replyPort.close).toHaveBeenCalledTimes(1)
    await f.stop()
  })

  it('renews by successful departure and never waits for the parent to consume an ACK', async () => {
    const f = await boot(), renewal = deferred<unknown>()
    const { exchange } = await f.acquire()
    f.plans.renew.push(() => renewal.promise)
    await vi.advanceTimersByTimeAsync(200)
    expect(f.commands.at(-1)).toMatchObject({ kind: 'renew', at: epoch + 200 })
    expect(f.readProof()).toEqual([BigInt(exchange.id), BigInt(epoch)])
    await vi.advanceTimersByTimeAsync(400)
    expect(f.commands.filter(c => c.kind === 'renew')).toHaveLength(1)
    expect(f.readProof()).toEqual([BigInt(exchange.id), BigInt(epoch)])
    renewal.resolve(1)
    await f.flush()
    expect(f.readProof()).toEqual([BigInt(exchange.id), BigInt(epoch + 200)])
    expect(f.parentMessages).toEqual([])
    // The reply was posted and closed, but no simulated parent handler has
    // consumed it. Subsequent shared proof does not depend on message delivery.
    expect(exchange.replies).toHaveLength(1)
    await f.stop()
  })

  it.each(['compare-miss', 'reject'] as const)('does not publish an acquisition proof on %s', async outcome => {
    const f = await boot()
    f.plans.acquire.push(() => outcome === 'compare-miss' ? Promise.resolve(['0', 'foreign-owner']) : Promise.reject(new Error('acquire unavailable')))
    const exchange = await f.request({ type: 'acquire', partition: 0 })
    expect(exchange.replies).toEqual([outcome === 'compare-miss'
      ? { id: exchange.id, ok: true, value: null }
      : { id: exchange.id, ok: false, error: 'acquire unavailable' }])
    expect(f.readProof()[0]).toBe(0n)
    expect(exchange.replyPort.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await f.stop()
  })

  it('returns a cached lease without changing its incarnation or renewing its timestamp', async () => {
    const f = await boot(), { lease } = await f.acquire(2)
    const acquired = f.readProof()
    vi.setSystemTime(epoch + 60_000)
    const same = await f.request({ type: 'acquire', partition: 2 })
    expect(same.replies).toEqual([{ id: same.id, ok: true, value: lease }])
    const other = await f.request({ type: 'acquire', partition: 1 })
    expect(other.replies).toEqual([{ id: other.id, ok: true, value: null }])
    expect(f.commands.filter(c => c.kind === 'acquire')).toHaveLength(1)
    expect(f.readProof()).toEqual(acquired)
    expect(same.replyPort.close).toHaveBeenCalledTimes(1)
    expect(other.replyPort.close).toHaveBeenCalledTimes(1)
    await f.stop()
  })

  it.each(['compare-miss', 'reject'] as const)('invalidates a lost lease on renew %s without publishing that departure', async outcome => {
    const f = await boot(), { lease } = await f.acquire()
    f.plans.renew.push(() => outcome === 'compare-miss' ? Promise.resolve(0) : Promise.reject(new Error('renew transport failure')))
    await vi.advanceTimersByTimeAsync(200)
    expect(f.readProof()[0]).toBe(0n)
    expect(f.parentMessages).toEqual([{ type: 'lost', lease, reason: outcome === 'compare-miss' ? 'lease-lost' : 'redis-unavailable' }])
    await vi.advanceTimersByTimeAsync(400)
    expect(f.commands.filter(c => c.kind === 'renew')).toHaveLength(1)
    expect(f.parentMessages).toHaveLength(1)
    await f.stop()
  })

  it.each([
    ['success', false], ['compare-miss', false], ['reject', false],
    ['success', true], ['reject', true],
  ] as const)('an old renewal settled as %s cannot change a newer incarnation (same owner value: %s)', async (outcome, sameOwnerValue) => {
    const f = await boot(), old = deferred<unknown>(), { lease: leaseA } = await f.acquire()
    f.plans.renew.push(() => old.promise)
    await vi.advanceTimersByTimeAsync(200)
    const release = await f.request({ type: 'release', lease: leaseA })
    expect(release.replies).toEqual([{ id: release.id, ok: true, value: true }])
    expect(f.readProof()[0]).toBe(0n)
    vi.setSystemTime(epoch + 300)
    // An explicit adapter-level alias tests incarnation, rather than merely
    // retesting ownerValue inequality. It is not a Redis-restart measurement.
    if (sameOwnerValue) f.plans.acquire.push(async () => [leaseA.token, leaseA.ownerValue])
    const { lease: leaseB } = await f.acquire()
    const proofB = f.readProof()
    expect(leaseB.incarnation).not.toBe(leaseA.incarnation)
    if (sameOwnerValue) expect(leaseB.ownerValue).toBe(leaseA.ownerValue)
    else expect(leaseB.ownerValue).not.toBe(leaseA.ownerValue)
    expect(proofB).toEqual([BigInt(leaseB.incarnation), BigInt(epoch + 300)])
    vi.setSystemTime(epoch + 500)
    if (outcome === 'reject') old.reject(new Error('late failure for A'))
    else old.resolve(outcome === 'success' ? 1 : 0)
    await f.flush()
    expect(f.readProof()).toEqual(proofB)
    expect(f.parentMessages).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(f.commands.filter(c => c.kind === 'renew').at(-1)?.args).toContain(leaseB.ownerValue)
    expect(f.readProof()[0]).toBe(BigInt(leaseB.incarnation))
    expect(f.readProof()[1]).toBeGreaterThan(proofB[1])
    await f.stop()
  })

  it('clears proof before awaiting release, including a failed Redis release', async () => {
    const f = await boot(), releasing = deferred<unknown>(), { lease } = await f.acquire()
    f.plans.release.push(() => releasing.promise)
    const exchange = f.enqueue({ type: 'release', lease })
    await f.flush()
    expect(f.commands.at(-1)?.kind).toBe('release')
    expect(f.readProof()[0]).toBe(0n)
    expect(exchange.replies).toEqual([])
    releasing.reject(new Error('release unavailable'))
    await f.flush()
    expect(exchange.replies).toEqual([{ id: exchange.id, ok: false, error: 'release unavailable' }])
    expect(exchange.replyPort.close).toHaveBeenCalledTimes(1)
    await f.stop()
  })

  it('a stale release cannot clear the proof of the current incarnation', async () => {
    const f = await boot(), { lease: leaseA } = await f.acquire()
    await f.request({ type: 'release', lease: leaseA })
    vi.setSystemTime(epoch + 100)
    const { lease: leaseB } = await f.acquire()
    const before = f.readProof()
    f.plans.release.push(async () => 0)
    const stale = await f.request({ type: 'release', lease: leaseA })
    expect(stale.replies).toEqual([{ id: stale.id, ok: true, value: false }])
    expect(f.readProof()).toEqual(before)
    expect(f.readProof()[0]).toBe(BigInt(leaseB.incarnation))
    await f.stop()
  })

  it('refuses an ABA release before Redis when ownerValue matches but the incarnation changed', async () => {
    const f = await boot(), { lease: leaseA } = await f.acquire()
    await f.request({ type: 'release', lease: leaseA })
    f.plans.acquire.push(async () => [leaseA.token, leaseA.ownerValue])
    vi.setSystemTime(epoch + 100)
    const { lease: leaseB } = await f.acquire()
    expect(leaseB.ownerValue).toBe(leaseA.ownerValue)
    expect(leaseB.incarnation).not.toBe(leaseA.incarnation)
    const proofB = f.readProof(), releasesBefore = f.commands.filter(c => c.kind === 'release').length
    const stale = await f.request({ type: 'release', lease: leaseA })
    expect(stale.replies).toEqual([{ id: stale.id, ok: true, value: false }])
    expect(stale.replyPort.close).toHaveBeenCalledTimes(1)
    expect(f.commands.filter(c => c.kind === 'release')).toHaveLength(releasesBefore)
    expect(f.readProof()).toEqual(proofB)
    const current = await f.request({ type: 'release', lease: leaseB })
    expect(current.replies).toEqual([{ id: current.id, ok: true, value: true }])
    expect(f.commands.filter(c => c.kind === 'release')).toHaveLength(releasesBefore + 1)
    expect(f.readProof()[0]).toBe(0n)
    await f.stop()
  })

  it('admitting stop while acquire is in Redis prevents publication and skips runtime.start for stop', async () => {
    const f = await boot(), acquiring = deferred<unknown>()
    f.plans.acquire.push(() => acquiring.promise)
    const acquire = f.enqueue({ type: 'acquire', partition: 0 })
    await f.flush()
    expect(f.commands.at(-1)?.kind).toBe('acquire')
    const stopping = f.enqueue({ type: 'stop' })
    expect(f.readProof()[0]).toBe(0n)
    expect(vi.getTimerCount()).toBe(0)
    acquiring.resolve(['9', 'runtime-test-cell|9|http://runtime-test.invalid:3001'])
    await f.flush()
    expect(acquire.replies).toEqual([{ id: acquire.id, ok: false, error: 'worker-stopped' }])
    expect(f.commands.at(-1)?.kind).toBe('release')
    expect(f.commands.at(-1)?.args).toContain('runtime-test-cell|9|http://runtime-test.invalid:3001')
    expect(f.readProof()[0]).toBe(0n)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(f.runtime.stop).toHaveBeenCalledTimes(1)
    expect(stopping.replies).toEqual([{ id: stopping.id, ok: true, value: true }])
    expect(acquire.replyPort.close).toHaveBeenCalledTimes(1)
    expect(stopping.replyPort.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop admitted during runtime.start prevents the queued acquire from reaching Redis', async () => {
    const f = await boot(), starting = deferred<void>()
    f.runtime.start.mockImplementationOnce(() => starting.promise)
    const acquire = f.enqueue({ type: 'acquire', partition: 0 })
    await f.flush()
    const stopping = f.enqueue({ type: 'stop' })
    starting.resolve()
    await f.flush()
    expect(f.commands).toEqual([])
    expect(f.readProof()[0]).toBe(0n)
    expect(acquire.replies).toEqual([{ id: acquire.id, ok: false, error: 'worker-stopped' }])
    expect(stopping.replies).toEqual([{ id: stopping.id, ok: true, value: true }])
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(acquire.replyPort.close).toHaveBeenCalledTimes(1)
    expect(stopping.replyPort.close).toHaveBeenCalledTimes(1)
  })

  it('stop admission clears current proof and timers before its queued release settles', async () => {
    const f = await boot(), renewal = deferred<unknown>(), releasing = deferred<unknown>()
    await f.acquire()
    f.plans.renew.push(() => renewal.promise)
    await vi.advanceTimersByTimeAsync(200)
    f.plans.release.push(() => releasing.promise)
    const stopping = f.enqueue({ type: 'stop' })
    expect(f.readProof()[0]).toBe(0n)
    expect(vi.getTimerCount()).toBe(0)
    await f.flush()
    expect(stopping.replies).toEqual([])
    renewal.resolve(1)
    await f.flush()
    expect(f.readProof()[0]).toBe(0n)
    releasing.resolve(1)
    await f.flush()
    expect(stopping.replies).toEqual([{ id: stopping.id, ok: true, value: true }])
    expect(stopping.replyPort.close).toHaveBeenCalledTimes(1)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(f.runtime.stop).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.commands.filter(c => c.kind === 'renew')).toHaveLength(1)
  })

  it('closes each reply port after Redis start or stop failure', async () => {
    const f = await boot()
    f.runtime.start.mockRejectedValueOnce(new Error('start unavailable'))
    const failed = await f.request({ type: 'acquire', partition: 0 })
    expect(failed.replies).toEqual([{ id: failed.id, ok: false, error: 'start unavailable' }])
    expect(failed.replyPort.close).toHaveBeenCalledTimes(1)
    f.runtime.stop.mockRejectedValueOnce(new Error('stop unavailable'))
    const stopping = await f.request({ type: 'stop' })
    expect(stopping.replies).toEqual([{ id: stopping.id, ok: false, error: 'stop unavailable' }])
    expect(stopping.replyPort.close).toHaveBeenCalledTimes(1)
    expect(f.runtime.start).toHaveBeenCalledTimes(1)
    expect(f.readProof()[0]).toBe(0n)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes the reply port even when posting the response throws', async () => {
    const f = await boot()
    const exchange = f.enqueue({ type: 'acquire', partition: 0 }, true)
    await f.flush()
    expect(f.commands.filter(c => c.kind === 'acquire')).toHaveLength(1)
    expect(exchange.replyPort.postMessage).toHaveBeenCalled()
    expect(exchange.replyPort.close).toHaveBeenCalledTimes(1)
    await f.stop()
  })
})
