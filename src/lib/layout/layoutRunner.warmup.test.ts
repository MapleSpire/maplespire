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

// QA lens 2026-10-25: the warm-up, driven through layoutWorkerPool with workers
// that fail it the ways the comments name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutJob, LayoutJobMessage } from './layoutRunner'

type Reply = (job: LayoutJob, n: number) => 'silent' | { solution: unknown }

class FakeWorker {
  static reply: Reply = () => ({ solution: { source: 'x' } })
  static all: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  terminated = false
  received = 0
  constructor() { FakeWorker.all.push(this) }
  postMessage(message: LayoutJobMessage) {
    const { id, job } = message
    const r = FakeWorker.reply(job, this.received++)
    queueMicrotask(() => {
      if (this.terminated || r === 'silent') return
      this.onmessage?.({ data: { id, ok: true, solution: r.solution } })
    })
  }
  terminate() { this.terminated = true }
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('window', {})
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function poolAfterWarmup() {
  const { layoutWorkerPool } = await import('./layoutRunner')
  const pending = layoutWorkerPool()
  await vi.advanceTimersByTimeAsync(10_001)
  return pending
}

describe('layoutWorkerPool — the warm-up keeps only workers that will answer', () => {
  it('control: workers that answer everything are kept', async () => {
    FakeWorker.reply = () => ({ solution: { source: 'x' } })
    const pool = await poolAfterWarmup()
    expect(pool?.alive).toBe(true)
  })

  it('rejects a worker silent on its first ELK job (elkjs took its messages)', async () => {
    FakeWorker.reply = (job) => (job.kind === 'elk' ? 'silent' : { solution: { source: 'custom' } })
    expect(await poolAfterWarmup()).toBeNull()
    expect(FakeWorker.all.length).toBeGreaterThan(0)
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true)
  })

  it('rejects a worker whose ELK answers the warm-up with nothing', async () => {
    FakeWorker.reply = (job) => ({ solution: job.kind === 'elk' ? null : { source: 'custom' } })
    expect(await poolAfterWarmup()).toBeNull()
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true)
  })

  it('rejects a worker that answers its first job and goes silent on the next', async () => {
    FakeWorker.reply = (_job, n) => (n === 0 ? { solution: { source: 'x' } } : 'silent')
    expect(await poolAfterWarmup()).toBeNull()
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true)
  })
})
