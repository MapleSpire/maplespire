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
