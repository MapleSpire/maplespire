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

import { describe, expect, it, vi } from 'vitest'
import {
  ColdBuildAdmission,
  ColdBuildAdmissionStoppedError,
  ColdBuildQueueFullError,
  coldBuildAdmissionConfig,
} from './coldBuildAdmission.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('ColdBuildAdmission', () => {
  it('bounds concurrency and starts queued jobs in FIFO order', async () => {
    const admission = new ColdBuildAdmission({ maxConcurrent: 2, maxQueued: 4 })
    const first = deferred<string>()
    const second = deferred<string>()
    const third = deferred<string>()
    const starts: string[] = []

    const p1 = admission.run(async () => { starts.push('first'); return first.promise })
    const p2 = admission.run(async () => { starts.push('second'); return second.promise })
    const p3 = admission.run(async () => { starts.push('third'); return third.promise })
    await Promise.resolve()
    expect(starts).toEqual(['first', 'second'])
    expect(admission.snapshot()).toMatchObject({ active: 2, queued: 1, maxObservedActive: 2 })

    second.resolve('second')
    await p2
    await Promise.resolve()
    expect(starts).toEqual(['first', 'second', 'third'])
    third.resolve('third')
    first.resolve('first')
    expect(await Promise.all([p1, p3])).toEqual(['first', 'third'])
    expect(admission.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 3, failed: 0 })
  })

  it('rejects beyond the queue bound without starting the rejected job', async () => {
    const admission = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 1 })
    const active = deferred<void>()
    const queued = deferred<void>()
    const rejected = vi.fn(async () => undefined)
    const p1 = admission.run(() => active.promise)
    const p2 = admission.run(() => queued.promise)

    await expect(admission.run(rejected)).rejects.toBeInstanceOf(ColdBuildQueueFullError)
    expect(rejected).not.toHaveBeenCalled()
    expect(admission.snapshot()).toMatchObject({ active: 1, queued: 1, rejected: 1 })

    active.resolve()
    await p1
    queued.resolve()
    await p2
  })

  it('does not leak a slot when a job fails', async () => {
    const admission = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 1 })
    const next = vi.fn(async () => 'ok')
    const failed = admission.run(async () => { throw new Error('cold build failed') })
    const queued = admission.run(next)
    await expect(failed).rejects.toThrow('cold build failed')
    expect(await queued).toBe('ok')
    expect(next).toHaveBeenCalledOnce()
    expect(admission.snapshot()).toMatchObject({ active: 0, failed: 1, completed: 1 })
  })

  it('cancels queued jobs on stop and refuses future work', async () => {
    const admission = new ColdBuildAdmission({ maxConcurrent: 1, maxQueued: 2 })
    const active = deferred<void>()
    const running = admission.run(() => active.promise)
    const queued = admission.run(async () => undefined)
    admission.stop()

    await expect(queued).rejects.toBeInstanceOf(ColdBuildAdmissionStoppedError)
    await expect(admission.run(async () => undefined)).rejects.toBeInstanceOf(ColdBuildAdmissionStoppedError)
    active.resolve()
    await running
    expect(admission.snapshot()).toMatchObject({ stopped: true, active: 0, queued: 0, cancelled: 1 })
  })
})

describe('coldBuildAdmissionConfig', () => {
  it('uses safe defaults and supports a zero-length queue', () => {
    expect(coldBuildAdmissionConfig({})).toEqual({ maxConcurrent: 2, maxQueued: 32 })
    expect(coldBuildAdmissionConfig({
      READ_MODEL_MAX_COLD_BUILDS: '999',
      READ_MODEL_MAX_COLD_BUILD_QUEUE: '0',
    })).toEqual({ maxConcurrent: 64, maxQueued: 0 })
    expect(coldBuildAdmissionConfig({
      READ_MODEL_MAX_COLD_BUILDS: '0',
      READ_MODEL_MAX_COLD_BUILD_QUEUE: '-1',
    })).toEqual({ maxConcurrent: 2, maxQueued: 32 })
  })
})
