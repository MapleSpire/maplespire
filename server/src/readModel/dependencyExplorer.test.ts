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
import { roDependencyPeerPage } from './dependencyExplorer.js'

const workspace = { landscapeId: 'ls', versionId: 'v1' }

describe('dependency explorer', () => {
  it('aggregates a bounded incoming fan and returns exact totals', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain('c.to_id = $3 AND c.from_id <> $3')
      expect(sql).toContain('count(*) OVER ()')
      expect(sql).toContain('AS projected_generation')
      expect(params).toEqual(['ls', 'v1', 'focus', '%checkout%', '', null, 2])
      return { rows: [
        {
          peer_id: 'api', peer_kind: 'object',
          peer_data: { id: 'api', name: 'API', type: 'app' },
          representative_connection: { id: 'c1', fromId: 'api', toId: 'focus' },
          connection_count: 5, direct_count: 4, lower_count: 1,
          normalized_name: 'api', total_peers: 3, total_connections: 9, projected_generation: 21,
        },
        {
          peer_id: 'queue', peer_kind: 'object',
          peer_data: { id: 'queue', name: 'Queue', type: 'app' },
          representative_connection: { id: 'c2', fromId: 'queue', toId: 'focus' },
          connection_count: 2, direct_count: 2, lower_count: 0,
          normalized_name: 'queue', total_peers: 3, total_connections: 9, projected_generation: 21,
        },
      ], rowCount: 2 }
    })
    const result = await roDependencyPeerPage({ query }, workspace, {
      focusId: 'focus', direction: 'incoming', search: 'checkout', limit: 1,
    })
    expect(result).toMatchObject({
      projectionGeneration: 21,
      totalPeers: 3,
      totalConnections: 9,
      items: [{ peerId: 'api', connectionCount: 5, directCount: 4, lowerCount: 1 }],
    })
    expect(result.nextCursor).toMatch(/\./)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('caps server pages at fifty peers', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (!sql.includes('WITH edges AS')) return { rows: [], rowCount: 0 }
      expect(params?.at(-1)).toBe(51)
      return { rows: [], rowCount: 0 }
    })
    await roDependencyPeerPage({ query }, workspace, {
      focusId: 'focus', direction: 'outgoing', limit: 10_000,
    })
  })
})
