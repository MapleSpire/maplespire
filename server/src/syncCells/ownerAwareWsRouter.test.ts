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
import { workspacePartition } from './assignment.js'
import { createOwnerAwareWsUpgradeHandler, type OwnerAwareWsRouterOptions } from './ownerAwareWsRouter.js'

function request(url: string) {
  return { url, headers: {} } as never
}

function socket() {
  const writes: string[] = []
  return {
    writes,
    destroyed: false,
    write(value: string) { writes.push(value); return true },
    destroy() { this.destroyed = true; return this },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('owner-aware WebSocket router', () => {
  it('resolves current and tunnels directly to the owner of the canonical partition', async () => {
    const canonical = { landscapeId: 'landscape-1', versionId: 'version-9' }
    const partitionCount = 8
    const expectedPartition = workspacePartition(canonical, partitionCount)
    const resolveOwner = vi.fn(async (partition: number) => ({
      cellId: 'cell-owner',
      token: '7',
      advertiseUrl: 'http://cell-owner:3001',
      partition,
    }))
    const proxyUpgrade = vi.fn(async () => true)
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount,
      resolveWorkspace: vi.fn(async () => canonical),
      resolveOwner,
      proxyUpgrade,
      sourceId: 'public-router',
    })
    const incoming = request('/automerge?landscapeId=landscape-1&versionId=current')

    await handler(incoming, socket() as never, Buffer.alloc(0))

    expect(resolveOwner).toHaveBeenCalledExactlyOnceWith(expectedPartition)
    expect(proxyUpgrade).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      request: incoming,
      advertiseUrl: 'http://cell-owner:3001',
      sourceCellId: 'public-router',
    }))
    expect((incoming as { url: string }).url)
      .toBe('/automerge?landscapeId=landscape-1&versionId=version-9')
  })

  it.each([
    ['/automerge', 400],
    ['/automerge?landscapeId=L1', 400],
    ['/elsewhere', 404],
  ])('fails closed for unsupported route %s', async (url, status) => {
    const resolveWorkspace = vi.fn()
    const resolveOwner = vi.fn()
    const target = socket()
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 2,
      resolveWorkspace,
      resolveOwner,
    })

    await handler(request(url), target as never, Buffer.alloc(0))

    expect(target.writes.join('')).toContain(`HTTP/1.1 ${status}`)
    expect(target.destroyed).toBe(true)
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(resolveOwner).not.toHaveBeenCalled()
  })

  it('returns 404 for a workspace that is not active', async () => {
    const target = socket()
    const resolveOwner = vi.fn()
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 2,
      resolveWorkspace: vi.fn(async () => null),
      resolveOwner,
    })

    await handler(
      request('/automerge?landscapeId=landscape-1&versionId=current'),
      target as never,
      Buffer.alloc(0),
    )

    expect(target.writes.join('')).toContain('HTTP/1.1 404')
    expect(resolveOwner).not.toHaveBeenCalled()
  })

  it('returns a retryable 503 instead of choosing a random cell when no owner is advertised', async () => {
    const target = socket()
    const proxyUpgrade = vi.fn()
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 2,
      resolveWorkspace: vi.fn(async () => ({ landscapeId: 'L1', versionId: 'V1' })),
      resolveOwner: vi.fn(async () => null),
      proxyUpgrade,
    })

    await handler(
      request('/automerge?landscapeId=L1&versionId=V1'),
      target as never,
      Buffer.alloc(0),
    )

    expect(target.writes.join('')).toContain('HTTP/1.1 503')
    expect(proxyUpgrade).not.toHaveBeenCalled()
  })

  it('coalesces staggered admission lookups briefly but rechecks ownership authoritatively', async () => {
    let now = 1_000
    let owner = {
      cellId: 'cell-a', token: '7', advertiseUrl: 'http://cell-a:3001', partition: 0,
    }
    const resolveOwner = vi.fn(async () => owner)
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 1,
      ownerRecheckMs: 60_000,
      ownerRouteCacheMs: 50,
      now: () => now,
      resolveWorkspace: vi.fn(async () => ({ landscapeId: 'L1', versionId: 'V1' })),
      resolveOwner,
      proxyUpgrade: vi.fn(async (options) => {
        options.onConnected?.({ close: vi.fn() })
        return true
      }),
    })

    await handler(request('/automerge?landscapeId=L1&versionId=V1'), socket() as never, Buffer.alloc(0))
    owner = { ...owner, cellId: 'cell-b', token: '8', advertiseUrl: 'http://cell-b:3001' }
    await handler(request('/automerge?landscapeId=L1&versionId=V1'), socket() as never, Buffer.alloc(0))
    expect(resolveOwner).toHaveBeenCalledTimes(1)

    now += 51
    await handler(request('/automerge?landscapeId=L1&versionId=V1'), socket() as never, Buffer.alloc(0))
    expect(resolveOwner).toHaveBeenCalledTimes(2)

    await handler.reconcileOwners()
    expect(resolveOwner).toHaveBeenCalledTimes(3)
    handler.stop()
  })

  it('does not cache an ownerless partition during takeover', async () => {
    const resolveOwner = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        cellId: 'cell-b', token: '8', advertiseUrl: 'http://cell-b:3001', partition: 0,
      })
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 1,
      ownerRouteCacheMs: 50,
      resolveWorkspace: vi.fn(async () => ({ landscapeId: 'L1', versionId: 'V1' })),
      resolveOwner,
      proxyUpgrade: vi.fn(async () => true),
    })

    await handler(request('/automerge?landscapeId=L1&versionId=V1'), socket() as never, Buffer.alloc(0))
    await handler(request('/automerge?landscapeId=L1&versionId=V1'), socket() as never, Buffer.alloc(0))
    expect(resolveOwner).toHaveBeenCalledTimes(2)
    handler.stop()
  })

  it('rejects an inconsistent owner record', async () => {
    const target = socket()
    const proxyUpgrade = vi.fn()
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 2,
      resolveWorkspace: vi.fn(async () => ({ landscapeId: 'L1', versionId: 'V1' })),
      resolveOwner: vi.fn(async (partition) => ({
        cellId: 'wrong-slot', token: '2', advertiseUrl: 'http://wrong:3001', partition: 1 - partition,
      })),
      proxyUpgrade,
    })

    await handler(
      request('/automerge?landscapeId=L1&versionId=V1'),
      target as never,
      Buffer.alloc(0),
    )

    expect(target.writes.join('')).toContain('HTTP/1.1 503')
    expect(proxyUpgrade).not.toHaveBeenCalled()
  })

  it('closes an established tunnel with 1012 as soon as the partition token changes', async () => {
    const close = vi.fn()
    let owner = {
      cellId: 'cell-a', token: '7', advertiseUrl: 'http://cell-a:3001', partition: 0,
    }
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 1,
      ownerRecheckMs: 60_000,
      resolveWorkspace: vi.fn(async () => ({ landscapeId: 'L1', versionId: 'V1' })),
      resolveOwner: vi.fn(async () => owner),
      proxyUpgrade: vi.fn(async (options) => {
        options.onConnected?.({ close })
        return true
      }),
    })
    await handler(
      request('/automerge?landscapeId=L1&versionId=V1'),
      socket() as never,
      Buffer.alloc(0),
    )

    await handler.reconcileOwners()
    expect(close).not.toHaveBeenCalled()
    owner = { ...owner, cellId: 'cell-b', token: '8', advertiseUrl: 'http://cell-b:3001' }
    await handler.reconcileOwners()

    expect(close).toHaveBeenCalledExactlyOnceWith(1012, 'Workspace owner changed')
    handler.stop()
  })

  it('SAYS it closed them (T-G1a) — and says nothing when it closed none', async () => {
    // THE LINE THAT MADE A CORRECT STACK LOOK BROKEN. The owning cell logs
    // `{"event":"sync.cell.workspace_drained","drainedSockets":0}` when this
    // router got to the socket first — `drainWorkspace` skips a socket already
    // closing — so before this event the 1012 the client received was
    // attributable to nothing in the logs, and the failover gate went red on
    // every run demanding the CELL win that race.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      let owner = { cellId: 'cell-a', token: '7', advertiseUrl: 'http://cell-a:3001', partition: 0 }
      const handler = createOwnerAwareWsUpgradeHandler({
        db: {} as never,
        partitionCount: 1,
        ownerRecheckMs: 60_000,
        resolveWorkspace: vi.fn(async () => ({ landscapeId: 'L1', versionId: 'V1' })),
        resolveOwner: vi.fn(async () => owner),
        proxyUpgrade: vi.fn(async (options) => {
          options.onConnected?.({ close: vi.fn() })
          return true
        }),
      })
      await handler(request('/automerge?landscapeId=L1&versionId=V1'), socket() as never, Buffer.alloc(0))

      // A reconcile that closes NOTHING must stay quiet: a line per tick would
      // drown the one that matters, and `closedTunnels: 0` in the log is
      // exactly the ambiguity this event exists to remove.
      await handler.reconcileOwners()
      expect(warn.mock.calls.flat().join('\n')).not.toContain('sync.router.tunnels_closed')

      owner = { ...owner, cellId: 'cell-b', token: '8', advertiseUrl: 'http://cell-b:3001' }
      await handler.reconcileOwners()
      const lines = warn.mock.calls.flat().filter((line): line is string => typeof line === 'string')
        .filter((line) => line.includes('sync.router.tunnels_closed'))
      expect(lines, 'the router closed a tunnel and did not say so').toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toEqual({
        event: 'sync.router.tunnels_closed',
        reason: 'owner-changed',
        partition: 0,
        closedTunnels: 1,
      })
      handler.stop()
    } finally {
      warn.mockRestore()
    }
  })

  it('aborts an upgrade still pending on a stale owner route', async () => {
    let owner = {
      cellId: 'cell-a', token: '7', advertiseUrl: 'http://cell-a:3001', partition: 0,
    }
    let observedSignal: AbortSignal | undefined
    const handler = createOwnerAwareWsUpgradeHandler({
      db: {} as never,
      partitionCount: 1,
      ownerRecheckMs: 60_000,
      resolveWorkspace: vi.fn(async () => ({ landscapeId: 'L1', versionId: 'V1' })),
      resolveOwner: vi.fn(async () => owner),
      proxyUpgrade: vi.fn(async (options) => {
        observedSignal = options.signal
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return false
      }),
    })
    const pending = handler(
      request('/automerge?landscapeId=L1&versionId=V1'),
      socket() as never,
      Buffer.alloc(0),
    )
    await vi.waitFor(() => expect(observedSignal).toBeDefined())

    owner = { ...owner, cellId: 'cell-b', token: '8', advertiseUrl: 'http://cell-b:3001' }
    await handler.reconcileOwners()
    await pending

    expect(observedSignal?.aborted).toBe(true)
    handler.stop()
  })
})

describe('T-10h3 router placement and shutdown races', () => {
  const workspace = { landscapeId: 'L1', versionId: 'V1' }
  const owner = (partition: number) => ({
    partition, cellId: `cell-${partition}`, token: '7', advertiseUrl: `http://cell-${partition}:3001`,
  })
  const defaults = (): OwnerAwareWsRouterOptions => ({
    db: {} as never,
    partitionCount: 2,
    ownerRecheckMs: 60_000,
    ownerRouteCacheMs: 0,
    resolveWorkspace: async (_, requested) => requested.versionId === 'current' ? workspace : requested,
    resolveOwner: async (partition) => owner(partition),
  })
  const incoming = () => request('/automerge?landscapeId=L1&versionId=current')

  it('uses the synchronous placed partition of the canonical version for admission and tracking', async () => {
    const placed = 1 - workspacePartition(workspace, 2)
    const partitionOf = vi.fn(() => placed)
    const resolveOwner = vi.fn(async (partition: number) => owner(partition))
    const close = vi.fn()
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), partitionOf, resolveOwner,
      proxyUpgrade: async (options) => { options.onConnected?.({ close }); return true },
    })
    try {
      const req = incoming()
      await handler(req, socket() as never, Buffer.alloc(0))
      expect((req as { url: string }).url).toContain('versionId=V1')
      expect(partitionOf).toHaveBeenCalledWith(workspace, 2)
      expect(resolveOwner).toHaveBeenCalledExactlyOnceWith(placed)
      resolveOwner.mockClear()
      await handler.reconcileOwners()
      expect(resolveOwner).toHaveBeenCalledExactlyOnceWith(placed)
      expect(close).not.toHaveBeenCalled()
    } finally { await handler.stop() }
  })

  it('closes only a moved workspace while both partition owners remain identical', async () => {
    let moved = false
    const closeMoved = vi.fn(), closeStable = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), partitionOf: (key) => key.landscapeId === 'L1' && moved ? 1 : 0,
      proxyUpgrade: async (options) => {
        options.onConnected?.({ close: options.request.url?.includes('L1') ? closeMoved : closeStable })
        return true
      },
    })
    try {
      await handler(incoming(), socket() as never, Buffer.alloc(0))
      await handler(request('/automerge?landscapeId=L2&versionId=V2'), socket() as never, Buffer.alloc(0))
      await handler.reconcileOwners()
      expect(closeMoved).not.toHaveBeenCalled()
      moved = true
      await handler.reconcileOwners()
      expect(closeMoved).toHaveBeenCalledExactlyOnceWith(1012, 'Workspace placement changed')
      expect(closeStable).not.toHaveBeenCalled()
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
        event: 'sync.router.tunnels_closed', reason: 'workspace-moved', partition: 0, closedTunnels: 1,
      })
      await handler.reconcileOwners()
      expect(closeMoved).toHaveBeenCalledTimes(1)
    } finally { await handler.stop(); warn.mockRestore() }
  })

  it('aborts a moved pending upgrade even when the old partition owner is unchanged', async () => {
    let partition = 0
    let signal: AbortSignal | undefined
    const entered = deferred<void>()
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), partitionOf: () => partition,
      proxyUpgrade: async (options) => {
        signal = options.signal
        entered.resolve()
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return false
      },
    })
    try {
      const pending = handler(incoming(), socket() as never, Buffer.alloc(0))
      await entered.promise
      partition = 1
      await handler.reconcileOwners()
      await pending
      expect(signal?.aborted).toBe(true)
    } finally { await handler.stop() }
  })

  it('refuses a placement changed while the owner lookup was in flight', async () => {
    let partition = 0
    const lookup = deferred<ReturnType<typeof owner>>()
    const entered = deferred<void>()
    const proxyUpgrade = vi.fn()
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), partitionOf: () => partition, proxyUpgrade,
      resolveOwner: () => { entered.resolve(); return lookup.promise },
    })
    try {
      const target = socket()
      const pending = handler(incoming(), target as never, Buffer.alloc(0))
      await entered.promise
      partition = 1
      lookup.resolve(owner(0))
      await pending
      expect(proxyUpgrade).not.toHaveBeenCalled()
      expect(target.writes.join('')).toContain('HTTP/1.1 503')
    } finally { await handler.stop() }
  })

  it('closes a late onConnected after a move instead of enrolling a stale tunnel', async () => {
    let partition = 0
    const entered = deferred<Parameters<NonNullable<OwnerAwareWsRouterOptions['proxyUpgrade']>>[0]>()
    const finish = deferred<boolean>()
    const close = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), partitionOf: () => partition,
      proxyUpgrade: (options) => { entered.resolve(options); return finish.promise },
    })
    try {
      const pending = handler(incoming(), socket() as never, Buffer.alloc(0))
      const options = await entered.promise
      partition = 1
      options.onConnected?.({ close })
      finish.resolve(true)
      await pending
      expect(close).toHaveBeenCalledExactlyOnceWith(1012, 'Workspace placement changed')
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual({
        event: 'sync.router.route_result', outcome: 'failed', assignedPartition: 0,
      })
    } finally { await handler.stop(); log.mockRestore() }
  })

  it.each(['workspace', 'owner'] as const)('joins an upgrade stopped during its %s lookup without admitting it', async (stage) => {
    const entered = deferred<void>(), gate = deferred<void>()
    const proxyUpgrade = vi.fn()
    const resolveOwner = vi.fn(async (partition: number) => {
      if (stage === 'owner') { entered.resolve(); await gate.promise }
      return owner(partition)
    })
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), partitionOf: () => 0, proxyUpgrade, resolveOwner,
      resolveWorkspace: async () => {
        if (stage === 'workspace') { entered.resolve(); await gate.promise }
        return workspace
      },
    })
    const target = socket()
    const pending = handler(incoming(), target as never, Buffer.alloc(0))
    await entered.promise
    const stopping = handler.stop()
    expect(handler.stop()).toBe(stopping)
    let joined = false
    void stopping.then(() => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    gate.resolve()
    await Promise.all([pending, stopping])
    expect(joined).toBe(true)
    expect(proxyUpgrade).not.toHaveBeenCalled()
    if (stage === 'workspace') expect(resolveOwner).not.toHaveBeenCalled()
    expect(target.writes.join('')).toContain('HTTP/1.1 503')
  })

  it('retains an invalidation during an active-owner recheck', async () => {
    const close = vi.fn()
    const entered = deferred<void>(), gate = deferred<void>()
    let block = false, partition = 0
    const resolveOwner = vi.fn(async (index: number) => {
      if (block) { block = false; entered.resolve(); await gate.promise }
      return owner(index)
    })
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), partitionOf: () => partition, resolveOwner,
      proxyUpgrade: async (options) => { options.onConnected?.({ close }); return true },
    })
    await handler(incoming(), socket() as never, Buffer.alloc(0))
    block = true
    const checking = handler.reconcileOwners()
    await entered.promise
    partition = 1
    const invalidating = handler.reconcileOwners()
    expect(invalidating).toBe(checking)
    gate.resolve()
    await invalidating
    expect(close).toHaveBeenCalledExactlyOnceWith(1012, 'Workspace placement changed')
    await handler.stop()
  })

  it('does not turn slow timer rechecks into an endless flight, but replays explicit invalidation', async () => {
    vi.useFakeTimers()
    const gate = deferred<void>()
    let blocked = true
    const resolveOwner = vi.fn(async (partition: number) => {
      if (resolveOwner.mock.calls.length > 1 && blocked) await gate.promise
      return owner(partition)
    })
    const handler = createOwnerAwareWsUpgradeHandler({
      ...defaults(), ownerRecheckMs: 50, partitionOf: () => 0, resolveOwner,
      proxyUpgrade: async (options) => { options.onConnected?.({ close: vi.fn() }); return true },
    })
    try {
      await handler(incoming(), socket() as never, Buffer.alloc(0))
      await vi.advanceTimersByTimeAsync(50)
      expect(resolveOwner).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(200)
      expect(resolveOwner).toHaveBeenCalledTimes(2)
      blocked = false
      gate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(resolveOwner).toHaveBeenCalledTimes(2)
      const first = handler.reconcileOwners()
      await Promise.resolve()
      const second = handler.reconcileOwners()
      expect(second).toBe(first)
      await first
      expect(resolveOwner).toHaveBeenCalledTimes(4)
    } finally { await handler.stop(); vi.useRealTimers() }
  })
})
