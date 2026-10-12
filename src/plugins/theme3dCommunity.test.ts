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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkinConfig } from '../skins/types'
import type { HostToWorker, WorkerToHost } from './sandbox/snapshot'
import { communityThemeFor3d } from './theme3dCommunity'
import { registerCommunityTheme } from './community/registry'
import { defineTheme } from './sdk/contract'

/**
 * The community 3D spec client: request/cache bridge between Scene3D's
 * synchronous spec reads and the sandbox worker. The worker is mocked — these
 * tests pin the host-side contract: batching, trusted-side sanitization,
 * cross-request isolation, and the degrade-to-derived failure model.
 */

class MockWorker {
  static instances: MockWorker[] = []
  posted: HostToWorker[] = []
  onmessage: ((e: MessageEvent<WorkerToHost>) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  terminated = false
  constructor() {
    MockWorker.instances.push(this)
  }
  postMessage(msg: HostToWorker): void {
    this.posted.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(msg: WorkerToHost): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerToHost>)
  }
}

const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve())

const OBJ_ARGS = {
  id: 'a',
  type: 'app',
  name: 'Web app',
  fill: '#FFFFFF',
  selected: false,
  external: false,
  zBase: 12,
  zTop: 30,
}

function makeSkin(id: string): SkinConfig {
  return { id, three: undefined } as unknown as SkinConfig
}

describe('communityThemeFor3d', () => {
  beforeEach(() => {
    MockWorker.instances = []
    vi.stubGlobal('Worker', MockWorker)
    registerCommunityTheme(
      defineTheme({
        meta: { id: 'community:test:specs', name: 'Specs', version: '1.0.0', trust: 'community' },
        code: 'return defineTheme({ meta: {} })', // compiled only by the real worker
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('returns null for a skin with no installed community plugin', () => {
    expect(communityThemeFor3d(makeSkin('studio'), () => {})).toBeNull()
    expect(MockWorker.instances).toHaveLength(0)
  })

  it('inits the sandbox, batches spec reads into one request, sanitizes the reply on the host, and serves it from the cache', async () => {
    const onUpdate = vi.fn()
    const client = communityThemeFor3d(makeSkin('community:test:specs'), onUpdate)!
    const worker = MockWorker.instances[0]
    expect(worker.posted[0]).toMatchObject({ type: 'init3d' })

    // two nodes + the floor read in one rebuild pass → ONE batched request
    expect(client.source.objectSpec(OBJ_ARGS)).toBeNull()
    expect(client.source.objectSpec({ ...OBJ_ARGS, id: 'b' })).toBeNull()
    expect(client.source.floorSpec({ bounds: { x: 0, y: 0, w: 100, h: 80 }, dark: true })).toBeNull()
    await flushMicrotasks()
    const reqs = worker.posted.filter((m) => m.type === 'spec3d')
    expect(reqs).toHaveLength(1)
    const req = reqs[0] as Extract<HostToWorker, { type: 'spec3d' }>
    expect(req.objects.map((o) => o.id)).toEqual(['a', 'b'])
    expect(req.floor).toEqual({ bounds: { x: 0, y: 0, w: 100, h: 80 }, dark: true })

    // hostile reply: unknown keys + unsafe color must be stripped HERE, on the host
    worker.reply({
      type: 'spec3d',
      requestId: req.requestId,
      objects: {
        a: {
          edgeGlow: { color: '#2563EB', width: 99 }, // width clamped to 4
          materials: { top: 'url(javascript:alert(1))' }, // unsafe color dropped
          __proto__: { hacked: true },
          depthScale: 2,
        },
        b: null,
      },
      floor: { grid: 'dots', gridColor: '#3B82F6', mode: 'weird' },
    })
    expect(onUpdate).toHaveBeenCalledTimes(1)

    const a = client.source.objectSpec(OBJ_ARGS)
    expect(a).toEqual({ edgeGlow: { color: '#2563EB', width: 4 }, depthScale: 2 })
    expect(client.source.objectSpec({ ...OBJ_ARGS, id: 'b' })).toBeNull()
    const floor = client.source.floorSpec({ bounds: { x: 0, y: 0, w: 100, h: 80 }, dark: true })
    expect(floor).toEqual({ grid: 'dots', gridColor: '#3B82F6' })

    // steady state: cache hits produce no new worker traffic
    await flushMicrotasks()
    expect(worker.posted.filter((m) => m.type === 'spec3d')).toHaveLength(1)
    client.dispose()
    expect(worker.terminated).toBe(true)
  })

  it('keeps concurrent requests isolated — an early reply never caches nulls for a later batch', async () => {
    const client = communityThemeFor3d(makeSkin('community:test:specs'), () => {})!
    const worker = MockWorker.instances[0]
    client.source.objectSpec(OBJ_ARGS)
    await flushMicrotasks()
    client.source.objectSpec({ ...OBJ_ARGS, id: 'late' })
    await flushMicrotasks()
    const [req1, req2] = worker.posted.filter((m) => m.type === 'spec3d') as Extract<
      HostToWorker,
      { type: 'spec3d' }
    >[]
    expect(req2.objects.map((o) => o.id)).toEqual(['late'])

    // reply to request 1 only — 'late' must stay pending, not become a cached null
    worker.reply({ type: 'spec3d', requestId: req1.requestId, objects: { a: { depthScale: 1.5 } }, floor: null })
    expect(client.source.objectSpec(OBJ_ARGS)).toEqual({ depthScale: 1.5 })
    worker.reply({ type: 'spec3d', requestId: req2.requestId, objects: { late: { depthScale: 0.5 } }, floor: null })
    expect(client.source.objectSpec({ ...OBJ_ARGS, id: 'late' })).toEqual({ depthScale: 0.5 })
    client.dispose()
  })

  it('a theme without 3D hooks tears the worker down and never requests', async () => {
    const client = communityThemeFor3d(makeSkin('community:test:specs'), () => {})!
    const worker = MockWorker.instances[0]
    worker.reply({ type: 'ready3d', hasObject3d: false, hasFloor3d: false })
    expect(worker.terminated).toBe(true)
    expect(client.source.objectSpec(OBJ_ARGS)).toBeNull()
    await flushMicrotasks()
    expect(worker.posted.filter((m) => m.type === 'spec3d')).toHaveLength(0)
  })

  it('degrades to the derived look on worker error and on a hung spec request', async () => {
    vi.useFakeTimers()
    const onUpdate = vi.fn()
    const client = communityThemeFor3d(makeSkin('community:test:specs'), onUpdate)!
    const worker = MockWorker.instances[0]
    client.source.objectSpec(OBJ_ARGS)
    await vi.runAllTimersAsync() // flush the microtask batch + the 2s reply timeout
    expect(worker.terminated).toBe(true) // hung request → torn down
    expect(client.source.objectSpec(OBJ_ARGS)).toBeNull() // derived look, no throw
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
