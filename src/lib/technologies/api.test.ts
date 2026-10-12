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

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isSelectableTechnology,
  listSelectableTechnologies,
  resolveSelectableTechnologies,
  TECHNOLOGY_SELECTOR_PAGE_SIZE,
  type CatalogTechnology,
} from './api'

const technology = (overrides: Partial<CatalogTechnology> = {}): CatalogTechnology => ({
  id: 'tech-1',
  scope: 'public',
  lifecycleStatus: 'active',
  orgState: 'enabled',
  orgOverride: null,
  revision: {
    revision: 1,
    status: 'approved',
    privateApproved: false,
    name: 'React',
    description: null,
    aliases: [],
    iconLightPath: null,
    iconDarkPath: null,
    recommendedShapeTypes: ['app'],
    defaultRole: 'other',
  },
  ...overrides,
})

describe('selectable organization technology', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accepts approved enabled active or deprecated technologies', () => {
    expect(isSelectableTechnology(technology())).toBe(true)
    expect(isSelectableTechnology(technology({ lifecycleStatus: 'deprecated' }))).toBe(true)
  })

  it('keeps privately approved organization technologies selectable during public review', () => {
    for (const status of ['in_review', 'changes_requested', 'rejected']) {
      expect(isSelectableTechnology(technology({
        scope: 'org_private',
        orgState: 'hidden',
        revision: { ...technology().revision, status, privateApproved: true },
      }))).toBe(true)
    }
    expect(isSelectableTechnology(technology({
      scope: 'org_private',
      revision: { ...technology().revision, status: 'draft', privateApproved: false },
    }))).toBe(false)
  })

  it('rejects hidden, unapproved, retired and merged entries', () => {
    expect(isSelectableTechnology(technology({ orgState: 'hidden' }))).toBe(false)
    expect(isSelectableTechnology(technology({ revision: { ...technology().revision, status: 'draft' } }))).toBe(false)
    expect(isSelectableTechnology(technology({ lifecycleStatus: 'retired' }))).toBe(false)
    expect(isSelectableTechnology(technology({ lifecycleStatus: 'merged' }))).toBe(false)
  })

  it('requests only selectable entries and falls back to the offline cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ technologies: [technology()], nextCursor: null, policy: 'all' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const network = await listSelectableTechnologies('org-api-test', 'rea')
    expect(network.source).toBe('network')
    const requestUrl = String(fetchMock.mock.calls[0][0])
    expect(() => new URL(requestUrl, 'http://localhost')).not.toThrow()
    expect(requestUrl).toContain('/api/orgs/org-api-test/technologies?')
    expect(requestUrl).toContain('selectable=true')
    expect(requestUrl).toContain(`limit=${TECHNOLOGY_SELECTOR_PAGE_SIZE}`)
    expect(network.hasMore).toBe(false)

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const cachedNoMatch = await listSelectableTechnologies('org-api-test', 'no-match')
    expect(cachedNoMatch).toEqual({ technologies: [], source: 'cache', hasMore: false })
  })

  it('reports a bounded page and resolves selected IDs outside that page independently', async () => {
    const firstPage = Array.from({ length: TECHNOLOGY_SELECTOR_PAGE_SIZE }, (_, index) => technology({
      id: `tech-${index}`,
      revision: { ...technology().revision, name: `Technology ${index}` },
    }))
    const selected = technology({
      id: 'tech-selected-outside-page',
      revision: { ...technology().revision, name: 'Selected outside page' },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ technologies: firstPage, nextCursor: 'next-page', policy: 'all' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          technology: selected,
          resolution: {
            requestedId: selected.id,
            canonicalTechnologyId: selected.id,
            redirected: false,
            path: [selected.id],
          },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const page = await listSelectableTechnologies('org-bounded-page', '')
    expect(page.technologies).toHaveLength(TECHNOLOGY_SELECTOR_PAGE_SIZE)
    expect(page.hasMore).toBe(true)

    const resolved = await resolveSelectableTechnologies('org-bounded-page', [selected.id])
    expect(resolved.technologies).toEqual([selected])
    expect(String(fetchMock.mock.calls[1][0])).toContain('/technologies/tech-selected-outside-page')
  })
})

/**
 * `filterCached` is the ONLY production caller of the ranking, and deleting its
 * sort entirely used to leave every test green — the module was dead weight
 * that could be removed without a failure. This drives the real offline path.
 */
describe('the offline page is ranked, not in cache order', () => {
  afterEach(() => vi.unstubAllGlobals())

  const named = (id: string, name: string, aliases: string[] = []) => technology({
    id, revision: { ...technology().revision, name, aliases },
  })

  it('ranks the cached page the way the server ranks the live one', async () => {
    // Deliberately seeded in an order no rule would produce.
    const catalog = [
      named('t1', 'AlloyDB for PostgreSQL'),
      named('t2', 'Postman'),
      named('t3', 'PostgreSQL'),
      named('t4', 'Relay', ['post']),
    ]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ technologies: catalog, nextCursor: null, policy: 'all' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await listSelectableTechnologies('org-order-test', '')

    fetchMock.mockRejectedValue(new Error('offline'))
    const offline = await listSelectableTechnologies('org-order-test', 'post')

    expect(offline.source).toBe('cache')
    expect(offline.technologies.map((t) => t.revision.name)).toEqual([
      'Relay',                  // exact alias
      'PostgreSQL',             // name prefix, alphabetical
      'Postman',
      'AlloyDB for PostgreSQL', // contains
    ])
  })

  it('leaves an offline browse alphabetical', async () => {
    const catalog = [named('t1', 'Zookeeper'), named('t2', 'Ansible'), named('t3', 'Kafka')]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ technologies: catalog, nextCursor: null, policy: 'all' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await listSelectableTechnologies('org-browse-test', '')

    fetchMock.mockRejectedValue(new Error('offline'))
    const offline = await listSelectableTechnologies('org-browse-test', '')

    expect(offline.technologies.map((t) => t.revision.name)).toEqual(['Ansible', 'Kafka', 'Zookeeper'])
  })
})
