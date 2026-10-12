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
import type { Queryable } from './types.js'
import { roConnectionExplorerPage } from './connectionExplorer.js'

const workspace = { landscapeId: 'landscape-a', versionId: 'version-a' }

describe('connection explorer', () => {
  it('paginates the default name view before enriching endpoints and counts', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT c.id, c.data')) {
        return {
          rows: [
            {
              id: 'c1', data: { id: 'c1' }, sort_text: 'calls', sort_number: null,
              from_name: 'API', from_icon: null, from_type: 'app', from_domain_id: null,
              to_name: 'DB', to_icon: null, to_type: 'store', to_domain_id: null,
              diagram_count: 1, flow_count: 0,
              page_total: 300_000, projected_generation: 8,
            },
            {
              id: 'c2', data: { id: 'c2' }, sort_text: 'reads', sort_number: null,
              from_name: 'API', from_icon: null, from_type: 'app', from_domain_id: null,
              to_name: 'Cache', to_icon: null, to_type: 'store', to_domain_id: null,
              diagram_count: 0, flow_count: 0,
              page_total: 300_000, projected_generation: 8,
            },
          ],
          rowCount: 2,
        }
      }
      return { rows: [], rowCount: 0 }
    })

    const page = await roConnectionExplorerPage({ query } as unknown as Queryable, workspace, { limit: 1 })

    expect(page).toMatchObject({ total: 300_000, projectionGeneration: 8 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toMatch(/\./)
    const pageCall = query.mock.calls.find(([sql]) => sql.includes('SELECT c.id, c.data'))
    expect(pageCall?.[0]).not.toContain('count(*) OVER')
    expect(pageCall?.[0]).not.toContain('ro_diagram_connections')
    expect(pageCall?.[0]).not.toContain('ro_connection_flows')
    expect(pageCall?.[1]?.at(-1)).toBe(2)
  })

  it('uses a bounded signed keyset page with server-side endpoint/count enrichment', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT c.id, c.data')) return {
          rows: [
            {
              id: 'c1', data: { id: 'c1', fromId: 'a', toId: 'b', label: 'Calls' },
              from_name: 'API', from_icon: null, from_type: 'app', from_domain_id: 'domain-a',
              to_name: 'Database', to_icon: null, to_type: 'store', to_domain_id: 'domain-a',
              diagram_count: 3, flow_count: 2, sort_text: 'calls', sort_number: null,
              page_total: 10, projected_generation: 5,
            },
            {
              id: 'c2', data: { id: 'c2', fromId: 'a', toId: 'c', label: 'Reads' },
              from_name: 'API', from_icon: null, from_type: 'app', from_domain_id: 'domain-a',
              to_name: 'Cache', to_icon: null, to_type: 'store', to_domain_id: 'domain-a',
              diagram_count: 1, flow_count: 0, sort_text: 'reads', sort_number: null,
              page_total: 10, projected_generation: 5,
            },
          ],
          rowCount: 2,
        }
      return { rows: [], rowCount: 0 }
    })
    const page = await roConnectionExplorerPage({ query } as unknown as Queryable, workspace, {
      query: 'api', domainId: 'domain-a', sortBy: 'name', sortAsc: true, limit: 1,
    })
    expect(page).toMatchObject({ total: 10, projectionGeneration: 5 })
    expect(page.items).toEqual([expect.objectContaining({
      connection: expect.objectContaining({ id: 'c1' }), fromName: 'API', toName: 'Database', diagramCount: 3, flowCount: 2,
    })])
    expect(page.nextCursor).toMatch(/\./)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('JOIN ro_connection_stats')
    expect(sql).not.toContain('ro_diagram_connections')
    expect(sql).not.toContain('ro_connection_flows')
    expect(sql).toContain('ORDER BY c.normalized_label COLLATE "C" ASC')
    expect(sql).toContain('WITH matched_connections AS MATERIALIZED')
    expect(sql).toContain('lower(search_connection.label) LIKE $3')
    expect(sql).toContain('search_stats.normalized_from_name LIKE $3')
    expect(sql).toContain('search_stats.normalized_to_name LIKE $3')
    expect(sql).toContain('JOIN matched_connections matched ON matched.connection_id = c.id')
    expect(sql).toContain('FROM matched_connections count_match')
    expect(sql).not.toContain('(c.normalized_label LIKE $3')
    expect(params[2]).toBe('%api%')
    expect(params.at(-1)).toBe(2)
  })

  it('keeps sub-trigram searches on the joined scan instead of expanding three whole-index arms', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))

    await roConnectionExplorerPage(
      { query } as unknown as Queryable,
      workspace,
      { query: 'ch', limit: 50 },
    )

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).not.toContain('WITH matched_connections AS MATERIALIZED')
    expect(sql).toContain('(c.normalized_label LIKE $3')
    expect(sql).toContain('OR s.normalized_from_name LIKE $3')
    expect(sql).toContain('OR s.normalized_to_name LIKE $3')
    expect(params[2]).toBe('%ch%')
  })

  it('uses numeric ordering for diagram and flow counts', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('read_model_projection_state')
      ? { rows: [], rowCount: 0 }
      : { rows: [], rowCount: 0 })
    await roConnectionExplorerPage({ query } as unknown as Queryable, workspace, { sortBy: 'flows', sortAsc: false })
    const [sql] = query.mock.calls[0] as unknown as [string]
    expect(sql).toContain('s.flow_count::integer AS sort_number')
    expect(sql).toContain('ORDER BY s.flow_count DESC')
  })

  it('returns page, total and generation from one attributed SQL statement', async () => {
    const stages: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const query = vi.fn(async (sql: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      if (sql.includes('SELECT c.id, c.data')) return { rows: [{
        id: 'c1', data: { id: 'c1' }, sort_text: 'calls', sort_number: null,
        from_name: 'API', from_icon: null, from_type: 'app', from_domain_id: null,
        to_name: 'DB', to_icon: null, to_type: 'store', to_domain_id: null,
        diagram_count: 0, flow_count: 0, page_total: 300_000, projected_generation: 12,
      }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const timing = {
      measure: async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
        stages.push(name)
        return operation()
      },
    }

    const page = await roConnectionExplorerPage(
      { query } as unknown as Queryable,
      workspace,
      { limit: 50 },
      timing,
    )

    expect(page).toMatchObject({ total: 300_000, projectionGeneration: 12 })
    expect(stages).toEqual(['page_sql'])
    expect(query).toHaveBeenCalledTimes(1)
    expect(maxInFlight).toBe(1)
  })

  it('uses one metadata fallback when the requested page is empty', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT c.id, c.data')
      ? { rows: [], rowCount: 0 }
      : { rows: [{ page_total: 300_000, projected_generation: 21 }], rowCount: 1 })
    const stages: string[] = []
    const page = await roConnectionExplorerPage(
      { query } as unknown as Queryable,
      workspace,
      { limit: 50 },
      { measure: async <T>(name: string, operation: () => Promise<T>) => {
        stages.push(name)
        return operation()
      } },
    )

    expect(page).toMatchObject({ items: [], total: 300_000, projectionGeneration: 21 })
    expect(stages).toEqual(['page_sql', 'metadata_sql'])
    expect(query).toHaveBeenCalledTimes(2)
  })
})
