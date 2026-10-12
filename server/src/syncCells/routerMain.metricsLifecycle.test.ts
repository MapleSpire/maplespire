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

import { afterEach, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

it.each(['metrics-bind', 'connections'] as const)('joins %s before closing the real entrypoint\'s late metrics handle', async (pause) => {
  vi.resetModules()
  const bound = deferred<{ port: number; address: string; stop: () => Promise<void> }>()
  const connection = deferred<void>()
  const entered = deferred<void>()
  const exited = deferred<number | undefined>()
  const timeline: string[] = []
  const listener = { port: 9464, address: '0.0.0.0', stop: vi.fn(async () => { timeline.push('metrics-closed') }) }
  const query = vi.fn(async () => {
    if (pause === 'connections') { entered.resolve(); await connection.promise }
    return { rows: [] }
  })
  const signals = new Map<string, () => void>()
  const once = process.once.bind(process)
  vi.spyOn(process, 'once').mockImplementation(((event: string, callback: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') { signals.set(event, callback); return process }
    return once(event, callback)
  }) as typeof process.once)
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    exited.resolve(typeof code === 'number' ? code : undefined)
    return undefined as never
  })
  vi.doMock('../db.js', () => ({ pool: { query, end: vi.fn(async () => { timeline.push('pool-ended') }) } }))
  vi.doMock('../runtime/redis.js', () => ({ redisRuntime: {
    ready: true, start: vi.fn(async () => {}), stop: vi.fn(async () => { timeline.push('redis-stopped') }),
  } }))
  vi.doMock('../runtime/metricsListener.js', () => ({ startMetricsListener: vi.fn(async () => {
    if (pause === 'metrics-bind') { entered.resolve(); return bound.promise }
    return listener
  }) }))
  // No guard, owner resolver, placement listener or HTTP server is reached on
  // either stopped-boot path. These doubles avoid unrelated imports doing I/O.
  vi.doMock('./assignment.js', () => ({ syncCellPartitionConfig: () => ({ partitionCount: 1 }) }))
  vi.doMock('./ownership.js', () => ({ FencedPartitionLeaseStore: class {} }))
  vi.doMock('./routerTopology.js', () => ({ startRouterTopologyGuard: vi.fn(), SyncCellRouterTopologyMismatchError: class extends Error {} }))
  vi.doMock('./routerPlacement.js', () => ({ RouterPlacementRefresh: class {} }))
  vi.doMock('./ownerAwareWsRouter.js', () => ({ createOwnerAwareWsUpgradeHandler: vi.fn() }))
  const boot = import('./routerMain.js')
  await entered.promise
  expect(signals.has('SIGTERM')).toBe(true)
  signals.get('SIGTERM')!()
  expect(listener.stop).not.toHaveBeenCalled()
  if (pause === 'metrics-bind') bound.resolve(listener)
  else connection.resolve()
  await boot
  expect(await exited.promise).toBe(0)
  expect(listener.stop).toHaveBeenCalledTimes(1)
  expect(timeline[0]).toBe('metrics-closed')
  expect(timeline).toContain('pool-ended')
  if (pause === 'metrics-bind') expect(query).not.toHaveBeenCalled()
})
