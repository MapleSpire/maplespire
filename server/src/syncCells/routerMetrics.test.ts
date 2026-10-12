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
import { renderPrometheus } from '../runtime/metrics.js'
import { createOwnerAwareWsUpgradeHandler, type OwnerAwareWsRouterOptions } from './ownerAwareWsRouter.js'
import { syncRouterMetricSamples } from './routerMetrics.js'

const workspace = { landscapeId: 'L1', versionId: 'V1' }
const owner = { partition: 0, cellId: 'cell-a', token: '7', advertiseUrl: 'http://cell-a:3001' }
const url = '/automerge?landscapeId=L1&versionId=V1'
function request(path = url) { return { url: path, headers: {} } as never }
function socket() { return { write: vi.fn(() => true), destroy: vi.fn() } as never }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function make(options: Partial<OwnerAwareWsRouterOptions> = {}) {
  return createOwnerAwareWsUpgradeHandler({
    db: {} as never, partitionCount: 1, ownerRecheckMs: 60_000,
    resolveWorkspace: async () => workspace, resolveOwner: async () => owner,
    proxyUpgrade: async () => true, ...options,
  })
}

describe('router telemetry at the real upgrade handler', () => {
  it.each([
    ['connected', url, {}],
    ['rejected', '/elsewhere', {}],
    ['rejected', '/automerge', {}],
    ['rejected', url, { resolveWorkspace: async () => null }],
    ['rejected', url, { resolveOwner: async () => null }],
    ['failed', url, { resolveOwner: async () => { throw new Error('read failed') } }],
    ['failed', url, { proxyUpgrade: async () => false }],
    ['failed', url, { proxyUpgrade: async () => { throw new Error('proxy failed') } }],
  ] as const)('counts one terminal %s for %s', async (outcome, path, options) => {
    const handler = make(options)
    try {
      await handler(request(path), socket(), Buffer.alloc(0))
      expect(handler.metricsSnapshot().admissions).toEqual({
        connected: outcome === 'connected' ? 1 : 0,
        rejected: outcome === 'rejected' ? 1 : 0,
        failed: outcome === 'failed' ? 1 : 0,
      })
    } finally { await handler.stop() }
  })

  it('counts neither a pending admission nor a pending owner read as completed', async () => {
    const read = deferred<typeof owner>()
    const started = deferred<void>()
    const handler = make({ resolveOwner: () => { started.resolve(); return read.promise } })
    const flight = handler(request(), socket(), Buffer.alloc(0))
    await started.promise
    expect(handler.metricsSnapshot()).toEqual({
      admissions: { connected: 0, rejected: 0, failed: 0 }, ownerRefreshAgeSeconds: Number.NaN,
    })
    const stop = handler.stop()
    read.resolve(owner)
    await flight
    await stop
    expect(handler.metricsSnapshot().admissions).toEqual({ connected: 0, rejected: 1, failed: 0 })
    await handler(request(), socket(), Buffer.alloc(0))
    expect(handler.metricsSnapshot().admissions).toEqual({ connected: 0, rejected: 2, failed: 0 })
  })

  it('does not credit a late connection retired during stop', async () => {
    const entered = deferred<void>()
    const resume = deferred<void>()
    const tunnel = { close: vi.fn() }
    const handler = make({ proxyUpgrade: async (options) => {
      entered.resolve()
      await resume.promise
      options.onConnected?.(tunnel as never)
      return true
    } })
    const flight = handler(request(), socket(), Buffer.alloc(0))
    await entered.promise
    const stop = handler.stop()
    resume.resolve()
    await flight
    await stop
    expect(tunnel.close).toHaveBeenCalledWith(1012, 'Router stopping')
    expect(handler.metricsSnapshot().admissions).toEqual({ connected: 0, rejected: 0, failed: 1 })
  })

  it('ages from read completion; cache hits, failures, idle reconciles and scrapes do not refresh it', async () => {
    let now = 1_000
    const resolveOwner = vi.fn(async () => owner as typeof owner | null)
    const resolveWorkspace = vi.fn(async () => workspace)
    const handler = make({ now: () => now, metricsNow: () => now, ownerRouteCacheMs: 250, resolveOwner, resolveWorkspace })
    try {
      expect(handler.metricsSnapshot().ownerRefreshAgeSeconds).toBeNaN()
      await handler(request(), socket(), Buffer.alloc(0))
      now = 1_100
      await handler(request(), socket(), Buffer.alloc(0))
      expect(resolveOwner).toHaveBeenCalledTimes(1)
      expect(handler.metricsSnapshot().ownerRefreshAgeSeconds).toBe(0.1)
      now = 1_300
      resolveOwner.mockRejectedValueOnce(new Error('transport'))
      await handler(request(), socket(), Buffer.alloc(0))
      expect(handler.metricsSnapshot().ownerRefreshAgeSeconds).toBe(0.3)
      await handler.reconcileOwners() // no registered tunnels: no raw owner read
      const counts = [resolveOwner.mock.calls.length, resolveWorkspace.mock.calls.length]
      for (let index = 0; index < 10; index += 1) {
        const snapshot = handler.metricsSnapshot()
        renderPrometheus(syncRouterMetricSamples('confirmed', snapshot))
        snapshot.admissions.connected = 9_999 // a snapshot cannot mutate the counter
      }
      expect([resolveOwner.mock.calls.length, resolveWorkspace.mock.calls.length]).toEqual(counts)
      expect(handler.metricsSnapshot().admissions).toEqual({ connected: 2, rejected: 0, failed: 1 })
      expect(handler.metricsSnapshot().ownerRefreshAgeSeconds).toBe(0.3)
      now = 1_400
      resolveOwner.mockResolvedValueOnce(null)
      await handler(request(), socket(), Buffer.alloc(0))
      expect(handler.metricsSnapshot().ownerRefreshAgeSeconds).toBe(0)
      now = 1_500
      expect(handler.metricsSnapshot().ownerRefreshAgeSeconds).toBe(0.1)
    } finally { await handler.stop() }
  })

  it('observes successful active-tunnel rechecks independently of admission cache hits', async () => {
    let now = 1_000
    const resolveOwner = vi.fn(async () => owner)
    const close = vi.fn()
    const handler = make({ metricsNow: () => now, resolveOwner, proxyUpgrade: async (options) => {
      options.onConnected?.({ close } as never)
      return true
    } })
    try {
      await handler(request(), socket(), Buffer.alloc(0))
      now = 2_000
      await handler.reconcileOwners()
      now = 2_500
      expect(handler.metricsSnapshot().ownerRefreshAgeSeconds).toBe(0.5)
      expect(resolveOwner).toHaveBeenCalledTimes(2)
      expect(close).not.toHaveBeenCalled()
      expect(handler.metricsSnapshot().admissions).toEqual({ connected: 1, rejected: 0, failed: 0 })
    } finally { await handler.stop() }
  })
})

describe('router exposition', () => {
  it.each([['pending', 0], ['confirmed', 1], ['mismatch', 2]] as const)('represents %s without inventing an owner refresh', (state, value) => {
    const text = renderPrometheus(syncRouterMetricSamples(state))
    expect(text).toContain(`maplespire_sync_router_topology_state ${value}\n`)
    expect(text).toContain('maplespire_sync_router_owner_refresh_age_seconds NaN\n')
    expect(text.split('\n').filter((line) => line.startsWith('maplespire_sync_router_admissions_total'))).toEqual([
      'maplespire_sync_router_admissions_total{outcome="connected"} 0',
      'maplespire_sync_router_admissions_total{outcome="rejected"} 0',
      'maplespire_sync_router_admissions_total{outcome="failed"} 0',
    ])
  })
})
