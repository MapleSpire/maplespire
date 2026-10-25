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

// QA lens 2026-10-25: bestLayout's POOL path when workers fail, time out, answer
// nothing, or are given a direction hint. The pool runs each job with the very
// function a layout worker runs (layoutJob.ts), on this thread.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import type { LayoutContext } from './graph'
import type { LayoutJob } from './layoutRunner'
import { DeadlineError, WorkerDiedError } from './workerPool'
import saoe from '../structurizr/fixtures/saoe.dsl?raw'

const mock = vi.hoisted(() => ({ run: null as null | ((job: LayoutJob) => Promise<unknown>) }))
vi.mock('./layoutRunner', async (importActual) => ({
  ...(await importActual<typeof import('./layoutRunner')>()),
  layoutWorkerPool: async () => (mock.run ? { run: mock.run, alive: true } : null),
}))

const { bestLayout } = await import('./index')
const { runLayoutJob } = await import('./layoutJob')

let n = 0
const model = mapWorkspace(parseWorkspace(saoe), { idFactory: () => `id${++n}` })
const ctx: LayoutContext = { objects: model.objects, connections: model.connections, groups: model.groups }
const view = (name: string) => model.diagrams.find((d) => d.name === name)!

async function inThread(d: Parameters<typeof bestLayout>[0], hint?: Parameters<typeof bestLayout>[2]) {
  mock.run = null
  return bestLayout(d, ctx, hint)
}

afterEach(() => {
  mock.run = null
  vi.restoreAllMocks()
})

describe('bestLayout through the pool', () => {
  it('honours a direction hint exactly as the calling thread does', async () => {
    for (const d of model.diagrams.slice(0, 6)) {
      for (const hint of ['lr', 'tb'] as const) {
        const here = await inThread(d, hint)
        mock.run = runLayoutJob
        const pooled = await bestLayout(d, ctx, hint)
        expect({ view: d.name, hint, source: pooled.source }).toEqual({ view: d.name, hint, source: here.source })
        expect(pooled.layouts).toEqual(here.layouts)
      }
    }
  }, 300_000)

  it('sends workers the trimmed context, not the whole model', async () => {
    const sizes: number[] = []
    mock.run = (job) => { sizes.push(job.ctx.objects.length); return runLayoutJob(job) }
    await bestLayout(view('FSSystemContext'), ctx)
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.max(...sizes)).toBeLessThan(ctx.objects.length)
  }, 60_000)

  it('still answers when every job fails: the custom engine, laid out here', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mock.run = async () => { throw new Error('worker crashed') }
    expect((await bestLayout(view('FSSystemContext'), ctx)).source).toBe('custom')
  }, 60_000)

  it('still answers when every job ran out of time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mock.run = async () => { throw new DeadlineError('no answer within 30000 ms') }
    expect((await bestLayout(view('FSSystemContext'), ctx)).source).toBe('custom')
  }, 60_000)

  it('says so when ELK answers nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mock.run = (job) => (job.kind === 'elk' ? Promise.resolve(null) : runLayoutJob(job))
    await bestLayout(view('FSSystemContext'), ctx)
    expect(warn.mock.calls.some(([m]) => /ELK candidates missing/.test(String(m)))).toBe(true)
  }, 60_000)

  // A view whose overall best is the custom engine tells "custom laid out here" from
  // "custom left out" by the result alone.
  it('lays the custom engine out here after a job failure, not after a timeout or two crashed workers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let found = false
    for (const d of model.diagrams) {
      const here = await inThread(d)
      if (here.source !== 'custom') continue
      found = true
      mock.run = (job) => (job.kind === 'custom' ? Promise.reject(new Error('crashed')) : runLayoutJob(job))
      expect((await bestLayout(d, ctx)).source, `${d.name}: failure`).toBe('custom')
      mock.run = (job) => (job.kind === 'custom' ? Promise.reject(new DeadlineError('timeout')) : runLayoutJob(job))
      expect((await bestLayout(d, ctx)).source, `${d.name}: timeout`).not.toBe('custom')
      mock.run = (job) => (job.kind === 'custom' ? Promise.reject(new WorkerDiedError('crashed a second worker')) : runLayoutJob(job))
      expect((await bestLayout(d, ctx)).source, `${d.name}: crashed workers`).not.toBe('custom')
      break
    }
    expect(found, 'a saoe view whose best is the custom engine').toBe(true)
  }, 300_000)
})
