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

// The layout worker, run where a browser runs it: a global scope with a `self`
// and no `document`, every message structured-cloned both ways. elkjs decides at
// load time whether it is inside a worker — and inside one it installs ITSELF as
// the scope's message handler — so the calling-thread tests, where `self` does not
// exist, cannot see what a worker does with it. Measured 2026-10-22 in the dev
// stack: all four layout workers went silent on their first ELK job and were
// terminated as stuck, and every ELK candidate was dropped without a word.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { parseWorkspace } from '../structurizr/parser'
import { mapWorkspace } from '../structurizr/mapper'
import { strategiesFor } from './elk/elkConfig'
import { trimLayoutContext, type LayoutContext, type LayoutSolution } from './graph'
import type { LayoutJob, LayoutJobAnswer, LayoutJobMessage } from './layoutRunner'
import saoe from '../structurizr/fixtures/saoe.dsl?raw'

const mock = vi.hoisted(() => ({ run: null as null | ((job: LayoutJob) => Promise<unknown>) }))
vi.mock('./layoutRunner', async (importActual) => ({
  ...(await importActual<typeof import('./layoutRunner')>()),
  layoutWorkerPool: async () => (mock.run ? { run: mock.run } : null),
}))

interface WorkerScope {
  self?: unknown
  onmessage: ((event: { data: LayoutJobMessage }) => void) | null
  postMessage?: (message: LayoutJobAnswer) => void
}
const scope = globalThis as unknown as WorkerScope
const answers = new Map<number, LayoutJobAnswer>()
let lastId = 0

/** Post one job to the worker scope and wait for ITS answer. */
async function post(job: LayoutJob): Promise<LayoutJobAnswer> {
  const id = ++lastId
  scope.onmessage?.({ data: structuredClone({ id, job }) })
  await vi.waitFor(() => { if (!answers.has(id)) throw new Error(`job ${id} was never answered`) }, { timeout: 20_000, interval: 10 })
  return answers.get(id)!
}

/** A pool worker's `run`, through the worker scope. */
async function viaScope(job: LayoutJob): Promise<LayoutSolution | null> {
  const answer = await post(job)
  if (!answer.ok) throw new Error(answer.error)
  return answer.solution
}

let n = 0
const model = mapWorkspace(parseWorkspace(saoe), { idFactory: () => `id${++n}` })
const ctx: LayoutContext = { objects: model.objects, connections: model.connections, groups: model.groups }
const view = (name: string) => model.diagrams.find((d) => d.name === name)!

beforeAll(async () => {
  scope.self = globalThis
  scope.postMessage = (message) => answers.set(message.id, structuredClone(message))
  await import('./layoutWorker')
})

describe('layout worker — in a worker scope, as a browser runs it', () => {
  it('answers ELK candidates one after another: loading elkjs does not take the worker\'s messages', async () => {
    const d = view('FSSystemContext')
    const [first, second] = strategiesFor()
    for (const strategy of [first, second]) {
      const answer = await post({ kind: 'elk', strategy, diagram: d, ctx: trimLayoutContext(d, ctx) })
      expect(answer).toMatchObject({ ok: true, solution: { source: strategy.id } })
    }
    // The stand-in `document` that steers elkjs is gone once ELK is built.
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined')
  }, 60_000)

  it('passes the pool\'s warm-up', async () => {
    const { proveWorker } = await import('./layoutRunner')
    await expect(proveWorker({ run: viaScope, terminate: () => undefined })).resolves.toBeUndefined()
  }, 60_000)

  it('lays every view out exactly as the calling thread does', async () => {
    const { bestLayout } = await import('./index')
    for (const d of model.diagrams) {
      mock.run = null
      const inThread = await bestLayout(d, ctx)
      mock.run = viaScope
      const viaWorker = await bestLayout(d, ctx)
      mock.run = null
      expect({ view: d.name, source: viaWorker.source }).toEqual({ view: d.name, source: inThread.source })
      expect(viaWorker.layouts).toEqual(inThread.layouts)
      expect(viaWorker.connPatches).toEqual(inThread.connPatches)
      expect(viaWorker.metrics.score).toBe(inThread.metrics.score)
    }
  }, 600_000)
})
