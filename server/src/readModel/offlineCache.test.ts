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
import {
  estimateBrowserCacheBytes,
  roConnectionCacheByEndpointIds,
  roConnectionCacheByIds,
  roOfflineCacheEstimate,
} from './offlineCache.js'

describe('offline cache estimate', () => {
  it('includes posting and browser index overhead, not only JSON payload bytes', () => {
    const estimated = estimateBrowserCacheBytes({
      objectCount: 100_000, groupCount: 1_000, connectionCount: 300_000,
      rawPayloadBytes: 200_000_000, searchCharacters: 2_000_000,
    })
    expect(estimated).toBeGreaterThan(600_000_000)
  })

  it('maps workspace-scoped PostgreSQL statistics', async () => {
    const query = vi.fn(async () => ({ rows: [{
      object_count: '10', group_count: '2', connection_count: '30',
      payload_bytes: '1000', search_characters: '50',
    }], rowCount: 1 }))
    const result = await roOfflineCacheEstimate({ query }, { landscapeId: 'ls', versionId: 'v1' })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ro_objects'), ['ls', 'v1'])
    expect(result).toMatchObject({ objectCount: 10, groupCount: 2, connectionCount: 30, rawPayloadBytes: 1000 })
    expect(result.estimatedBytes).toBeGreaterThan(1000)
  })

  it('fetches only changed connections with endpoint metadata', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('read_model_projection_state')) {
        return { rows: [{ projected_generation: 8 }], rowCount: 1 }
      }
      expect(params).toEqual(['ls', 'v1', ['c1']])
      return { rows: [{
        id: 'c1', data: { id: 'c1', fromId: 'a', toId: 'b', label: 'calls' },
        from_name: 'A', from_icon: null, from_type: 'app', from_domain_id: null,
        to_name: 'B', to_icon: null, to_type: 'store', to_domain_id: null,
        diagram_count: 2, flow_count: 1,
      }], rowCount: 1 }
    })
    const result = await roConnectionCacheByIds({ query }, { landscapeId: 'ls', versionId: 'v1' }, ['c1', 'c1'])
    expect(result).toEqual({
      projectionGeneration: 8,
      items: [{
        connection: { id: 'c1', fromId: 'a', toId: 'b', label: 'calls' },
        fromName: 'A', fromType: 'app', toName: 'B', toType: 'store', diagramCount: 2, flowCount: 1,
      }],
    })
  })

  it('cursor-pages connections adjacent to changed object identities', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('read_model_projection_state')) {
        return { rows: [{ projected_generation: 11 }], rowCount: 1 }
      }
      expect(params).toEqual(['ls', 'v1', ['a'], 2])
      return { rows: [
        {
          id: 'c1', data: { id: 'c1', fromId: 'a', toId: 'b' },
          from_name: 'A', from_icon: null, from_type: 'app', from_domain_id: null,
          to_name: 'B', to_icon: null, to_type: 'store', to_domain_id: null,
          diagram_count: 1, flow_count: 0,
        },
        {
          id: 'c2', data: { id: 'c2', fromId: 'a', toId: 'c' },
          from_name: 'A', from_icon: null, from_type: 'app', from_domain_id: null,
          to_name: 'C', to_icon: null, to_type: 'app', to_domain_id: null,
          diagram_count: 0, flow_count: 0,
        },
      ], rowCount: 2 }
    })
    const result = await roConnectionCacheByEndpointIds(
      { query }, { landscapeId: 'ls', versionId: 'v1' }, ['a'], { limit: 1 },
    )
    expect(result.projectionGeneration).toBe(11)
    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toMatch(/\./)
  })
})
