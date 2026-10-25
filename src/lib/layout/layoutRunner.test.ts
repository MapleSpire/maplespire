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

// The layout worker pool's lifetime, against a stand-in `Worker` (review lenses,
// 2026-10-25): a pool whose workers were all retired, or a warm-up that failed
// once, used to leave the whole session laying out on the page's thread.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutJob, LayoutJobMessage } from './layoutRunner'

type Behaviour = 'answer' | 'refuse' | 'die'

class FakeWorker {
  static behaviour: Behaviour = 'answer'
  static all: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  terminated = false
  constructor() {
    if (FakeWorker.behaviour === 'refuse') throw new Error('workers blocked')
    FakeWorker.all.push(this)
  }
  postMessage(message: LayoutJobMessage) {
    const { id, job } = message
    queueMicrotask(() => {
      if (this.terminated) return
      if (FakeWorker.behaviour === 'die') this.onerror?.({ message: 'crashed' })
      else this.onmessage?.({ data: { id, ok: true, solution: { source: job.kind } } })
    })
  }
  terminate() {
    this.terminated = true
  }
}

const job: LayoutJob = { kind: 'custom', direction: 'tb', diagram: {} as LayoutJob['diagram'], ctx: { objects: [], connections: [], groups: [] } }

beforeEach(() => {
  vi.resetModules()
  FakeWorker.behaviour = 'answer'
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('window', {})
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('layoutWorkerPool — a pool that can come back', () => {
  it('lays out on the calling thread after a failed start, and tries again a minute later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { layoutWorkerPool } = await import('./layoutRunner')
    FakeWorker.behaviour = 'refuse'
    expect(await layoutWorkerPool()).toBeNull()
    FakeWorker.behaviour = 'answer'
    vi.setSystemTime(Date.now() + 59_000)
    expect(await layoutWorkerPool()).toBeNull()
    expect(FakeWorker.all).toHaveLength(0)
    vi.setSystemTime(Date.now() + 2_000)
    const pool = await layoutWorkerPool()
    expect(pool?.alive).toBe(true)
    expect(FakeWorker.all.length).toBeGreaterThan(0)
  })

  it('starts a new pool once every worker of the last one is gone', async () => {
    const { layoutWorkerPool } = await import('./layoutRunner')
    const first = (await layoutWorkerPool())!
    const firstWorkers = [...FakeWorker.all]
    expect(firstWorkers.length).toBeGreaterThan(0)
    FakeWorker.behaviour = 'die'
    const jobs = firstWorkers.map(() => first.run(job).catch(() => null))
    await Promise.all(jobs)
    expect(first.alive).toBe(false)
    expect(firstWorkers.every((w) => w.terminated)).toBe(true)
    FakeWorker.behaviour = 'answer'
    const second = await layoutWorkerPool()
    expect(second).not.toBe(first)
    expect(second?.alive).toBe(true)
    expect(await second!.run(job)).toEqual({ source: 'custom' })
  })
})

describe('readyWorker — a replacement is warmed up like the first ones, before it joins', () => {
  it('hands the worker over once it has passed the warm-up', async () => {
    const { readyWorker, wrapWorker } = await import('./layoutRunner')
    const raw = new FakeWorker()
    const sent: string[] = []
    const post = raw.postMessage.bind(raw)
    raw.postMessage = (m: LayoutJobMessage) => { sent.push(m.job.kind); post(m) }
    const worker = await readyWorker(() => wrapWorker(raw as unknown as Worker))
    expect(sent).toEqual(['elk', 'custom'])
    expect(worker).not.toBeNull()
    expect(raw.terminated).toBe(false)
  })

  it('terminates it and hands over nothing when the warm-up fails', async () => {
    const { readyWorker, wrapWorker } = await import('./layoutRunner')
    const raw = new FakeWorker()
    raw.postMessage = (m: LayoutJobMessage) => queueMicrotask(() => raw.onmessage?.({ data: { id: m.id, ok: true, solution: null } }))
    expect(await readyWorker(() => wrapWorker(raw as unknown as Worker))).toBeNull()
    expect(raw.terminated).toBe(true)
  })
})

describe('wrapWorker — a Worker as a pool worker', () => {
  it('rejects a job the worker cannot receive instead of waiting for an answer', async () => {
    const { wrapWorker } = await import('./layoutRunner')
    const worker = new FakeWorker()
    worker.postMessage = () => {
      throw new DOMException('could not be cloned', 'DataCloneError')
    }
    await expect(wrapWorker(worker as unknown as Worker).run(job)).rejects.toThrow('could not be cloned')
  })

  it('rejects a job sent after the worker was terminated', async () => {
    const { wrapWorker } = await import('./layoutRunner')
    const wrapped = wrapWorker(new FakeWorker() as unknown as Worker)
    wrapped.terminate()
    await expect(wrapped.run(job)).rejects.toThrow('terminated')
  })
})
