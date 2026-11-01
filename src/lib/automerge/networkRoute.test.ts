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
import { WorkspaceNetworkRouter, workspaceWebSocketUrl, type NetworkAdapterLike } from './networkRoute'
import {
  __resetWorkspaceBindingFramesForTest,
  installWorkspaceBindingHandler,
  noteWorkspaceBinding,
} from './workspaceBinding'

interface FakeAdapter extends NetworkAdapterLike {
  url: string
}

describe('workspaceWebSocketUrl', () => {
  it('binds the socket URL to one encoded workspace and preserves deployment params', () => {
    expect(workspaceWebSocketUrl('wss://sync.example.test/automerge?region=ca', {
      landscapeId: 'landscape_A',
      versionId: 'current',
    })).toBe('wss://sync.example.test/automerge?region=ca&landscapeId=landscape_A&versionId=current')
  })
})

describe('WorkspaceNetworkRouter', () => {
  it('keeps one adapter and removes the previous route before attaching the next', async () => {
    const events: string[] = []
    const network = {
      addNetworkAdapter: vi.fn((adapter: FakeAdapter) => events.push(`add:${adapter.url}`)),
      removeNetworkAdapter: vi.fn((adapter: FakeAdapter) => events.push(`remove:${adapter.url}`)),
    }
    const router = new WorkspaceNetworkRouter<FakeAdapter>(
      network,
      (url) => ({ url, disconnect: vi.fn() }),
      'ws://localhost:3001/automerge',
    )

    await router.route({ landscapeId: 'L1', versionId: 'V1' })
    await router.route({ landscapeId: 'L1', versionId: 'V1' })
    await router.route({ landscapeId: 'L2', versionId: 'V2' })

    expect(network.addNetworkAdapter).toHaveBeenCalledTimes(2)
    expect(network.removeNetworkAdapter).toHaveBeenCalledTimes(1)
    expect(events.map((event) => event.replace(/%2F/g, '/'))).toEqual([
      'add:ws://localhost:3001/automerge?landscapeId=L1&versionId=V1',
      'remove:ws://localhost:3001/automerge?landscapeId=L1&versionId=V1',
      'add:ws://localhost:3001/automerge?landscapeId=L2&versionId=V2',
    ])
  })

  it('retires a binding frame no handler took when it swaps the adapter that sent it', async () => {
    // The frame states where ONE socket is bound. Kept for the next handler
    // (workspaceBinding.ts), it must not outlive the adapter that produced it:
    // after a HOLD and a reload, the held socket's frame names the held version.
    const network = { addNetworkAdapter: vi.fn(), removeNetworkAdapter: vi.fn() }
    const adapters: FakeAdapter[] = []
    const router = new WorkspaceNetworkRouter<FakeAdapter>(
      network,
      (url) => {
        const adapter = { url, disconnect: vi.fn() }
        adapters.push(adapter)
        return adapter
      },
      'ws://localhost/automerge',
    )
    const ref = { landscapeId: 'L1', versionId: 'current' }
    const seen: string[] = []
    try {
      await router.route(ref)
      noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V2' }, adapters[0]!)
      // THE CONTROL: the same route is a no-op, so the frame survives it.
      await router.route(ref)
      const uninstall = installWorkspaceBindingHandler((b) => { seen.push(b.versionId) })
      expect(seen).toEqual(['V2'])
      uninstall()

      noteWorkspaceBinding({ landscapeId: 'L1', versionId: 'V1' }, adapters[0]!)
      await router.route(ref, true)
      expect(adapters).toHaveLength(2)
      installWorkspaceBindingHandler((b) => { seen.push(`stale:${b.versionId}`) })
      expect(seen).toEqual(['V2'])
    } finally {
      __resetWorkspaceBindingFramesForTest()
    }
  })

  it('force-routes the same ref for a moving current-version pointer', async () => {
    const network = {
      addNetworkAdapter: vi.fn(),
      removeNetworkAdapter: vi.fn(),
    }
    const router = new WorkspaceNetworkRouter<FakeAdapter>(
      network,
      (url) => ({ url, disconnect: vi.fn() }),
      'ws://localhost/automerge',
    )
    const ref = { landscapeId: 'L1', versionId: 'current' }
    await router.route(ref)
    await router.route(ref, true)
    expect(network.addNetworkAdapter).toHaveBeenCalledTimes(2)
    expect(network.removeNetworkAdapter).toHaveBeenCalledTimes(1)
  })
})
