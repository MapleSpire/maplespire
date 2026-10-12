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
  __resetTagCatalogCacheForTest,
  batchUpdateCatalogTags,
  createCatalogTag,
  createCatalogTagGroup,
  discardTagCatalogOutboxEntry,
  flushTagCatalogOutbox,
  flushTagOperationEvents,
  getCatalogTagUsageSummary,
  getTagOperationSummary,
  listCatalogTagAssignments,
  listCatalogTagAudit,
  listTagCatalogOutbox,
  listTagPage,
  reconcileTagCatalogOutboxEntry,
  reconcileTagGroupOutboxEntry,
  reorderCatalogTag,
  reorderCatalogTagGroup,
  resolveCatalogTags,
  retryTagCatalogOutboxEntry,
  TAG_SELECTOR_PAGE_SIZE,
  tagSnapshotFromCatalog,
  type CatalogTag,
  type CatalogTagGroup,
} from './api'

const tag = (overrides: Partial<CatalogTag> = {}): CatalogTag => ({
  id: 'tag-risk-high',
  orgId: 'org-tags',
  groupId: 'taggrp-risk',
  groupName: 'Risk',
  value: 'High',
  color: '#E05252',
  lifecycleStatus: 'active',
  canonicalTagId: null,
  version: 3,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  ...overrides,
})

describe('organization Tag catalog client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    __resetTagCatalogCacheForTest()
  })

  it('pages active tags on the server and uses a bounded offline cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [tag()], nextCursor: 'page-2' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const page = await listTagPage('org-tags', { query: 'high', groupIds: ['taggrp-risk'] })
    expect(page).toMatchObject({ source: 'network', nextCursor: 'page-2' })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/orgs/org-tags/tags?')
    expect(url).toContain(`limit=${TAG_SELECTOR_PAGE_SIZE}`)
    expect(url).toContain('groupIds=taggrp-risk')

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const cached = await listTagPage('org-tags', { query: 'risk' })
    expect(cached.source).toBe('cache')
    expect(cached.items.map((item) => item.id)).toEqual(['tag-risk-high'])
  })

  it('resolves redirected IDs and produces the minimal Automerge snapshot', async () => {
    const canonical = tag({ id: 'tag-risk-critical', value: 'Critical', version: 7 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        resolved: [{ requestedId: 'tag-old', canonicalTagId: canonical.id, redirected: true, tag: canonical }],
        unresolvedIds: [],
      }),
    }))

    const result = await resolveCatalogTags('org-tags', ['tag-old'])
    expect(result.resolved[0].canonicalTagId).toBe('tag-risk-critical')
    expect(tagSnapshotFromCatalog(canonical)).toEqual({
      tagId: 'tag-risk-critical',
      value: 'Critical',
      color: '#E05252',
      groupId: 'taggrp-risk',
      groupName: 'Risk',
      catalogRevision: 7,
    })
  })

  it('reorders Groups and Tags by relative stable IDs with optimistic versions', async () => {
    const group = {
      id: 'taggrp-risk', orgId: 'org-tags', name: 'Risk', description: null, iconKey: null,
      lifecycleStatus: 'active' as const, version: 5, createdAt: '', updatedAt: '',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ group: { ...group, version: 6 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tag: tag({ version: 4 }) }) })
    vi.stubGlobal('fetch', fetchMock)

    await reorderCatalogTagGroup('org-tags', group, { beforeId: 'taggrp-cost' })
    await reorderCatalogTag('org-tags', tag(), { afterId: 'tag-risk-low' })

    expect(fetchMock.mock.calls[0][0]).toContain('/tag-groups/reorder')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      groupId: 'taggrp-risk', expectedVersion: 5, beforeId: 'taggrp-cost', afterId: null,
    })
    expect(fetchMock.mock.calls[1][0]).toContain('/tags/reorder')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      tagId: 'tag-risk-high', expectedVersion: 3, beforeId: null, afterId: 'tag-risk-low',
    })
  })

  it('sends bounded optimistic bulk commands and loads assignment impact on demand', async () => {
    const changed = tag({ color: '#ABCDEF', version: 4 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        usage: [{ tagId: tag().id, objectAssignments: 4, groupAssignments: 1, totalAssignments: 5 }],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tags: [changed] }) })
    vi.stubGlobal('fetch', fetchMock)

    expect(await getCatalogTagUsageSummary('org-tags', [tag().id, tag().id])).toEqual([
      { tagId: tag().id, objectAssignments: 4, groupAssignments: 1, totalAssignments: 5 },
    ])
    await batchUpdateCatalogTags('org-tags', [tag()], 'recolor', { color: '#ABCDEF' })

    expect(fetchMock.mock.calls[0][0]).toContain('/tags/usage-summary')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ tagIds: [tag().id] })
    expect(fetchMock.mock.calls[1][0]).toContain('/tags/batch')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      action: 'recolor',
      items: [{ id: tag().id, expectedVersion: 3 }],
      color: '#ABCDEF',
    })
  })

  it('pages tenant-scoped Tag audit and assignment details without loading the catalog', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        items: [{
          id: '81', at: '2026-07-18T12:00:00.000Z', actorUserId: 'admin-1', actorEmail: 'admin@example.test',
          impersonatorUserId: null, impersonatorEmail: null, action: 'tag.update', targetKind: 'tag',
          targetId: tag().id, detail: { before: { color: '#111111' }, after: { color: '#222222' } },
        }],
        nextCursor: '80',
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        items: [{
          kind: 'object', landscapeId: 'landscape-1', landscapeName: 'Commerce',
          versionId: 'current', versionName: 'Main', entityId: 'object-1',
          entityName: 'Checkout API', entityType: 'app',
        }],
        nextCursor: 'assignment-cursor',
      }) })
    vi.stubGlobal('fetch', fetchMock)

    expect((await listCatalogTagAudit('org-tags', tag().id, {
      action: 'tag.update', after: '90', limit: 25,
    })).items[0]).toMatchObject({ action: 'tag.update', actorEmail: 'admin@example.test' })
    expect((await listCatalogTagAssignments('org-tags', tag().id, {
      kind: 'object', after: 'cursor-1', limit: 25,
    })).items[0]).toMatchObject({ entityName: 'Checkout API', entityType: 'app' })

    expect(String(fetchMock.mock.calls[0][0])).toContain(`/tags/${tag().id}/audit?action=tag.update&after=90&limit=25`)
    expect(String(fetchMock.mock.calls[1][0])).toContain(`/tags/${tag().id}/assignments?kind=object&after=cursor-1&limit=25`)
  })

  it('queues offline creation with a stable ID and replays the same idempotent mutation', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)

    const optimistic = await createCatalogTag('org-tags', {
      groupId: 'taggrp-risk',
      value: 'Critical',
      color: '#B42318',
      workspace: { landscapeId: 'landscape-1', versionId: 'current' },
    })

    expect(optimistic.id).toMatch(/^tag_client_[0-9a-f]{32}$/)
    expect(optimistic.pendingSync).toBe(true)
    const replayed = { ...optimistic, pendingSync: undefined }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ tag: replayed }) })

    const [firstFlush, concurrentFlush] = await Promise.all([
      flushTagCatalogOutbox('org-tags'),
      flushTagCatalogOutbox('org-tags'),
    ])
    expect(firstFlush).toEqual({ flushed: 1, pending: 0 })
    expect(concurrentFlush).toEqual({ flushed: 1, pending: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = fetchMock.mock.calls[0][1]
    const replay = fetchMock.mock.calls[1][1]
    expect(first.headers['idempotency-key']).toBe(replay.headers['idempotency-key'])
    expect(JSON.parse(first.body).clientId).toBe(optimistic.id)
    expect(JSON.parse(replay.body).clientId).toBe(optimistic.id)
  })

  it('surfaces non-retryable replay conflicts and can discard the local optimistic draft', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)

    const optimistic = await createCatalogTag('org-tags', {
      groupId: 'taggrp-risk',
      value: 'High',
      color: '#E05252',
    })
    expect(await listTagCatalogOutbox('org-tags')).toEqual([
      expect.objectContaining({
        clientId: optimistic.id,
        label: 'High',
        state: 'pending',
        attemptCount: 0,
        lastError: null,
      }),
    ])

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'duplicate_tag', message: 'A Tag with this value already exists in Risk.' }),
    })
    expect(await retryTagCatalogOutboxEntry('org-tags', `tag-outbox-${optimistic.id}`)).toBe(false)
    expect(await listTagCatalogOutbox('org-tags')).toEqual([
      expect.objectContaining({
        state: 'attention',
        attemptCount: 1,
        lastError: {
          code: 'duplicate_tag',
          message: 'A Tag with this value already exists in Risk.',
          status: 409,
        },
      }),
    ])

    const callsAfterConflict = fetchMock.mock.calls.length
    expect(await flushTagCatalogOutbox('org-tags')).toEqual({ flushed: 0, pending: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterConflict)
    expect((await listTagCatalogOutbox('org-tags'))[0].attemptCount).toBe(1)

    expect(await discardTagCatalogOutboxEntry('org-tags', `tag-outbox-${optimistic.id}`)).toBe(true)
    expect(await listTagCatalogOutbox('org-tags')).toEqual([])

    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect((await listTagPage('org-tags')).items).toEqual([])
  })

  it('batches deduplicated outbox lifecycle metrics without catalog content or local IDs', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const optimistic = await createCatalogTag('org-tags', {
      groupId: 'taggrp-risk', value: 'Sensitive local value', color: '#E05252',
    })

    const conflict = {
      ok: false,
      status: 409,
      json: async () => ({ error: 'duplicate_tag', message: 'A duplicate exists.' }),
    }
    fetchMock.mockResolvedValueOnce(conflict).mockResolvedValueOnce(conflict)
    expect(await retryTagCatalogOutboxEntry('org-tags', `tag-outbox-${optimistic.id}`)).toBe(false)
    expect(await retryTagCatalogOutboxEntry('org-tags', `tag-outbox-${optimistic.id}`)).toBe(false)
    await discardTagCatalogOutboxEntry('org-tags', `tag-outbox-${optimistic.id}`)

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ received: 3, inserted: 3 }) })
    const [first, concurrent] = await Promise.all([
      flushTagOperationEvents('org-tags'),
      flushTagOperationEvents('org-tags'),
    ])
    expect(first).toEqual({ flushed: 3, pending: 0 })
    expect(concurrent).toEqual({ flushed: 3, pending: 0 })
    const telemetryCall = fetchMock.mock.calls[3]
    expect(String(telemetryCall[0])).toContain('/tag-operations/events')
    const serialized = String(telemetryCall[1].body)
    expect(serialized).not.toContain('Sensitive local value')
    expect(serialized).not.toContain(optimistic.id)
    expect(serialized).not.toContain('taggrp-risk')
    const payload = JSON.parse(serialized) as { events: Array<Record<string, unknown>> }
    expect(payload.events.map((event) => event.eventType)).toEqual(['queued', 'attention', 'discarded'])
    expect(payload.events.filter((event) => event.eventType === 'attention')).toHaveLength(1)
    expect(payload.events.every((event) => (
      typeof event.id === 'string'
      && !('orgId' in event)
      && !('value' in event)
      && !('clientId' in event)
      && !('groupId' in event)
    ))).toBe(true)

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ summary: {
        window: '7d', from: '', to: '',
        counts: { queued: 3, replay_succeeded: 1, attention: 1, discarded: 1, reconciled: 0 },
        p50ResolutionMs: 500, p95ResolutionMs: 1_500,
        topAttentionReasons: [{ code: 'duplicate_tag', count: 1 }], lastEventAt: '',
      } }),
    })
    expect(await getTagOperationSummary('org-tags')).toMatchObject({
      window: '7d', counts: { attention: 1 }, p95ResolutionMs: 1_500,
    })
    expect(String(fetchMock.mock.calls[4][0])).toContain('/tag-operations/summary?window=7d')
  })

  it('maps an offline Tag ID durably to an existing canonical Tag', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const optimistic = await createCatalogTag('org-tags', {
      groupId: 'taggrp-risk', value: 'High', color: '#E05252',
    })
    const canonical = tag()
    const source = tag({
      id: optimistic.id,
      value: optimistic.value,
      lifecycleStatus: 'merged',
      canonicalTagId: canonical.id,
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ source, canonical }),
    })

    await expect(reconcileTagCatalogOutboxEntry(
      'org-tags', `tag-outbox-${optimistic.id}`, canonical,
    )).resolves.toEqual({ source, canonical })
    expect(String(fetchMock.mock.calls[1][0])).toContain('/tags/reconcile-local')
    expect(fetchMock.mock.calls[1][1].headers['idempotency-key']).toBe(`tag-reconcile-${optimistic.id}`)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      clientId: optimistic.id,
      targetTagId: canonical.id,
    })
    expect(await listTagCatalogOutbox('org-tags')).toEqual([])
  })

  it('atomically repoints dependent offline Tags when a local Group maps to an existing Group', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline group'))
      .mockRejectedValueOnce(new TypeError('offline tag'))
    vi.stubGlobal('fetch', fetchMock)
    const localGroup = await createCatalogTagGroup('org-tags', { name: 'Local Risk' })
    const localTag = await createCatalogTag('org-tags', {
      groupId: localGroup.id, value: 'Critical', color: '#B42318',
    })
    const existingGroup: CatalogTagGroup = {
      id: 'taggrp-risk', orgId: 'org-tags', name: 'Risk', description: null, iconKey: null,
      lifecycleStatus: 'active', version: 2, createdAt: '', updatedAt: '',
    }
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ group: existingGroup }) })

    await expect(reconcileTagGroupOutboxEntry(
      'org-tags', `tag-outbox-${localGroup.id}`, existingGroup,
    )).resolves.toEqual({ group: existingGroup, updatedDependentTags: 1 })
    expect(await listTagCatalogOutbox('org-tags')).toEqual([
      expect.objectContaining({
        clientId: localTag.id,
        groupId: existingGroup.id,
        groupName: existingGroup.name,
        state: 'pending',
      }),
    ])

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      tag: tag({ id: localTag.id, value: 'Critical', color: '#B42318' }),
    }) })
    expect(await retryTagCatalogOutboxEntry('org-tags', `tag-outbox-${localTag.id}`)).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({ groupId: existingGroup.id })
  })
})
