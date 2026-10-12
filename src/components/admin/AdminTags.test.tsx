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

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogTag, CatalogTagGroup } from '../../lib/tags/api'
import { AdminTags } from './AdminTags'

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
  listTagPage: vi.fn(),
  listTagGroupPage: vi.fn(),
  createCatalogTag: vi.fn(),
  createCatalogTagGroup: vi.fn(),
  updateCatalogTag: vi.fn(),
  updateCatalogTagGroup: vi.fn(),
  setCatalogTagLifecycle: vi.fn(),
  setCatalogTagGroupLifecycle: vi.fn(),
  mergeCatalogTags: vi.fn(),
  getCatalogTagUsageSummary: vi.fn(),
  getTagOperationSummary: vi.fn(),
  getReadModelHealth: vi.fn(),
  listCatalogTagAssignments: vi.fn(),
  listCatalogTagAudit: vi.fn(),
  batchUpdateCatalogTags: vi.fn(),
  listTagCatalogOutbox: vi.fn(),
  retryTagCatalogOutboxEntry: vi.fn(),
  discardTagCatalogOutboxEntry: vi.fn(),
  reconcileTagCatalogOutboxEntry: vi.fn(),
  reconcileTagGroupOutboxEntry: vi.fn(),
  subscribeTagCatalogOutbox: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ orgId: 'org-1' }) }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: mocks.t }),
}))
vi.mock('../../lib/tags/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tags/api')>(),
  listTagPage: mocks.listTagPage,
  listTagGroupPage: mocks.listTagGroupPage,
  createCatalogTag: mocks.createCatalogTag,
  createCatalogTagGroup: mocks.createCatalogTagGroup,
  updateCatalogTag: mocks.updateCatalogTag,
  updateCatalogTagGroup: mocks.updateCatalogTagGroup,
  setCatalogTagLifecycle: mocks.setCatalogTagLifecycle,
  setCatalogTagGroupLifecycle: mocks.setCatalogTagGroupLifecycle,
  mergeCatalogTags: mocks.mergeCatalogTags,
  getCatalogTagUsageSummary: mocks.getCatalogTagUsageSummary,
  getTagOperationSummary: mocks.getTagOperationSummary,
  listCatalogTagAssignments: mocks.listCatalogTagAssignments,
  listCatalogTagAudit: mocks.listCatalogTagAudit,
  batchUpdateCatalogTags: mocks.batchUpdateCatalogTags,
  listTagCatalogOutbox: mocks.listTagCatalogOutbox,
  retryTagCatalogOutboxEntry: mocks.retryTagCatalogOutboxEntry,
  discardTagCatalogOutboxEntry: mocks.discardTagCatalogOutboxEntry,
  reconcileTagCatalogOutboxEntry: mocks.reconcileTagCatalogOutboxEntry,
  reconcileTagGroupOutboxEntry: mocks.reconcileTagGroupOutboxEntry,
  subscribeTagCatalogOutbox: mocks.subscribeTagCatalogOutbox,
}))
vi.mock('../../lib/orgAdmin/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/orgAdmin/api')>(),
  getReadModelHealth: mocks.getReadModelHealth,
}))
vi.mock('../tags/TagCatalogPicker', () => ({
  TagCatalogPicker: ({ isOpen, onSelect }: {
    isOpen: boolean
    onSelect: (snapshot: object, tag: CatalogTag) => void
  }) => isOpen ? <button onClick={() => onSelect({}, riskHigh)}>select-existing-tag</button> : null,
}))
vi.mock('../tags/TagGroupCatalogPicker', () => ({
  TagGroupCatalogPicker: ({ isOpen, onSelect }: {
    isOpen: boolean
    onSelect: (group: CatalogTagGroup) => void
  }) => isOpen ? <button onClick={() => onSelect(riskGroup)}>select-existing-group</button> : null,
}))
vi.mock('../common/VirtualList', () => ({
  VirtualList: ({ items, renderRow, getKey, onEndReached, footer }: {
    items: Array<{ id: string }>
    renderRow: (item: never, index: number) => ReactNode
    getKey: (item: never, index: number) => string
    onEndReached?: () => void
    footer?: ReactNode
  }) => <div data-testid="admin-tags-virtual-list">
    {items.map((item, index) => <div key={getKey(item as never, index)}>{renderRow(item as never, index)}</div>)}
    {onEndReached && <button data-testid="admin-tags-end" onClick={onEndReached}>end</button>}
    {footer}
  </div>,
}))

const riskGroup: CatalogTagGroup = {
  id: 'taggrp-risk', orgId: 'org-1', name: 'Risk', description: 'Delivery risk', iconKey: null,
  lifecycleStatus: 'active', version: 1, createdAt: '', updatedAt: '',
}
const riskHigh: CatalogTag = {
  id: 'tag-risk-high', orgId: 'org-1', groupId: riskGroup.id, groupName: riskGroup.name,
  value: 'High', color: '#E05252', lifecycleStatus: 'active', canonicalTagId: null, version: 2,
  createdAt: '', updatedAt: '',
}

describe('AdminTags', () => {
  beforeEach(() => {
    mocks.listTagGroupPage.mockReset().mockResolvedValue({ items: [riskGroup], nextCursor: null, source: 'network' })
    mocks.listTagPage.mockReset().mockResolvedValue({ items: [riskHigh], nextCursor: null, source: 'network' })
    mocks.createCatalogTag.mockReset().mockResolvedValue(riskHigh)
    mocks.createCatalogTagGroup.mockReset().mockResolvedValue(riskGroup)
    mocks.updateCatalogTag.mockReset()
    mocks.updateCatalogTagGroup.mockReset()
    mocks.setCatalogTagLifecycle.mockReset()
    mocks.setCatalogTagGroupLifecycle.mockReset()
    mocks.mergeCatalogTags.mockReset()
    mocks.getCatalogTagUsageSummary.mockReset().mockResolvedValue([{
      tagId: riskHigh.id, objectAssignments: 5, groupAssignments: 2, totalAssignments: 7,
    }])
    mocks.getTagOperationSummary.mockReset().mockResolvedValue({
      window: '7d',
      from: '2026-07-11T12:00:00.000Z',
      to: '2026-07-18T12:00:00.000Z',
      counts: { queued: 8, replay_succeeded: 5, attention: 2, discarded: 0, reconciled: 1 },
      p50ResolutionMs: 1_500,
      p95ResolutionMs: 90_000,
      topAttentionReasons: [{ code: 'duplicate_tag', count: 2 }],
      lastEventAt: '2026-07-18T11:59:00.000Z',
    })
    mocks.getReadModelHealth.mockReset().mockResolvedValue({
      enabled: true,
      generatedAt: '2026-07-18T12:00:00.000Z',
      // Deliberately WITHOUT `stale`, mirroring an older server answering a newer
      // page during a rolling deploy. The panel must render the count as 0, not
      // throw — an undefined here must not take the whole Operations dialog down.
      counts: { healthy: 3, degraded: 1, catching_up: 1, failed: 0, idle: 1, uninitialized: 0 },
      worstLagMs: 2_500,
      totalWorkspaceCount: 6,
      listedWorkspaceCount: 3,
      workspaces: [
        {
          landscapeId: 'landscape-1', landscapeName: 'Commerce', versionId: 'current', versionName: 'Main',
          status: 'catching_up', projectorAttached: true, observedGeneration: 4, projectedGeneration: 3,
          pendingGenerations: 1, lagMs: 2_500, stalenessMs: 2_500,
          lastProjectedAt: '2026-07-18T11:59:57.500Z', lastDurationMs: 12, lastErrorAt: null, lastErrorCode: null,
          degradedSince: null, degradedKind: null, degradedErrorCode: null,
        },
        {
          landscapeId: 'landscape-2', landscapeName: 'Warehouse', versionId: 'v1', versionName: 'Main',
          status: 'idle', projectorAttached: false, observedGeneration: 2, projectedGeneration: 2,
          pendingGenerations: 0, lagMs: 0, stalenessMs: 60_000,
          lastProjectedAt: '2026-07-18T11:59:00.000Z', lastDurationMs: 9, lastErrorAt: null, lastErrorCode: null,
          degradedSince: null, degradedKind: null, degradedErrorCode: null,
        },
        {
          landscapeId: 'landscape-3', landscapeName: 'Billing', versionId: 'v2', versionName: 'Main',
          status: 'degraded', projectorAttached: true, observedGeneration: 7, projectedGeneration: 7,
          pendingGenerations: 0, lagMs: 0, stalenessMs: 1_000,
          lastProjectedAt: '2026-07-18T11:59:59.000Z', lastDurationMs: 11, lastErrorAt: null, lastErrorCode: null,
          degradedSince: '2026-07-18T11:50:00.000Z',
          degradedKind: 'document_resolution',
          degradedErrorCode: 'read_model_document_unavailable',
        },
      ],
    })
    mocks.listCatalogTagAssignments.mockReset().mockResolvedValue({ items: [], nextCursor: null })
    mocks.listCatalogTagAudit.mockReset().mockResolvedValue({ items: [], nextCursor: null })
    mocks.batchUpdateCatalogTags.mockReset().mockResolvedValue([{ ...riskHigh, lifecycleStatus: 'archived', version: 3 }])
    mocks.listTagCatalogOutbox.mockReset().mockResolvedValue([])
    mocks.retryTagCatalogOutboxEntry.mockReset().mockResolvedValue(false)
    mocks.discardTagCatalogOutboxEntry.mockReset().mockResolvedValue(true)
    mocks.reconcileTagCatalogOutboxEntry.mockReset().mockResolvedValue({ source: riskHigh, canonical: riskHigh })
    mocks.reconcileTagGroupOutboxEntry.mockReset().mockResolvedValue({ group: riskGroup, updatedDependentTags: 0 })
    mocks.subscribeTagCatalogOutbox.mockReset().mockReturnValue(() => {})
  })

  afterEach(cleanup)

  it('filters on the server and appends keyset pages in a virtual list', async () => {
    const costHigh = { ...riskHigh, id: 'tag-cost-high', groupId: 'taggrp-cost', groupName: 'Cost' }
    mocks.listTagPage
      .mockReset()
      .mockResolvedValueOnce({ items: [riskHigh], nextCursor: 'page-2', source: 'network' })
      .mockResolvedValueOnce({ items: [costHigh], nextCursor: null, source: 'network' })
      .mockResolvedValue({ items: [riskHigh], nextCursor: null, source: 'network' })

    render(<AdminTags />)
    expect(await screen.findByText('High')).toBeTruthy()
    fireEvent.click(screen.getByTestId('admin-tags-end'))
    expect(await screen.findByText('Cost')).toBeTruthy()
    expect(mocks.listTagPage).toHaveBeenLastCalledWith('org-1', expect.objectContaining({ after: 'page-2' }))

    fireEvent.change(screen.getByDisplayValue('admin.tags.allGroups'), { target: { value: riskGroup.id } })
    await waitFor(() => expect(mocks.listTagPage).toHaveBeenLastCalledWith(
      'org-1',
      expect.objectContaining({ groupIds: [riskGroup.id] }),
      expect.any(AbortSignal),
    ))
  })

  it('creates a Tag only inside an explicit active group', async () => {
    render(<AdminTags />)
    await screen.findByText('High')
    fireEvent.click(screen.getByRole('button', { name: /admin.tags.addTag/ }))
    fireEvent.change(screen.getByLabelText('admin.tags.value'), { target: { value: 'Critical' } })
    fireEvent.change(screen.getByLabelText('admin.tags.colorHex'), { target: { value: '#B42318' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => expect(mocks.createCatalogTag).toHaveBeenCalledWith('org-1', {
      value: 'Critical',
      groupId: riskGroup.id,
      color: '#B42318',
    }))
  })

  it('archives a loaded multi-selection atomically after showing assignment impact', async () => {
    render(<AdminTags />)
    await screen.findByText('High')

    fireEvent.click(screen.getByLabelText('admin.tags.selectTag'))
    expect(screen.getByText('admin.tags.selectedCount')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.archiveSelected' }))

    expect(await screen.findByText('7')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(mocks.getCatalogTagUsageSummary).toHaveBeenCalledWith('org-1', [riskHigh.id])

    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.bulk.archiveAction' }))
    await waitFor(() => expect(mocks.batchUpdateCatalogTags).toHaveBeenCalledWith(
      'org-1',
      [riskHigh],
      'archive',
      expect.objectContaining({ color: '#D97A3D', groupId: '' }),
    ))
  })

  it('opens virtualized assignment and append-only audit details for a Tag', async () => {
    mocks.listCatalogTagAssignments
      .mockResolvedValueOnce({
        items: [{
          kind: 'object', landscapeId: 'landscape-1', landscapeName: 'Commerce',
          versionId: 'current', versionName: 'Main', entityId: 'object-1',
          entityName: 'Checkout API', entityType: 'app',
        }],
        nextCursor: 'assignment-page-2',
      })
      .mockResolvedValueOnce({
        items: [{
          kind: 'group', landscapeId: 'landscape-1', landscapeName: 'Commerce',
          versionId: 'current', versionName: 'Main', entityId: 'group-1',
          entityName: 'Checkout boundary', entityType: null,
        }],
        nextCursor: null,
      })
    mocks.listCatalogTagAudit.mockResolvedValue({
      items: [{
        id: '42', at: '2026-07-18T12:00:00.000Z', actorUserId: 'admin-1', actorEmail: 'admin@example.test',
        impersonatorUserId: null, impersonatorEmail: null, action: 'tag.update', targetKind: 'tag',
        targetId: riskHigh.id, detail: { before: { color: '#111111' }, after: { color: '#E05252' } },
      }],
      nextCursor: null,
    })

    render(<AdminTags />)
    await screen.findByText('High')
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.details.open' }))
    expect(await screen.findByText('Checkout API')).toBeTruthy()
    expect(mocks.listCatalogTagAssignments).toHaveBeenCalledWith(
      'org-1', riskHigh.id, { kind: 'all', limit: 50 }, expect.any(AbortSignal),
    )

    fireEvent.click(screen.getAllByTestId('admin-tags-end').at(-1)!)
    expect(await screen.findByText('Checkout boundary')).toBeTruthy()
    expect(mocks.listCatalogTagAssignments).toHaveBeenLastCalledWith(
      'org-1', riskHigh.id, { kind: 'all', after: 'assignment-page-2', limit: 50 },
    )

    fireEvent.click(screen.getByRole('tab', { name: 'admin.tags.details.activity' }))
    expect(await screen.findByText('admin.tags.details.actions.tag_update')).toBeTruthy()
    expect(screen.getByText('admin.tags.details.byActor')).toBeTruthy()
    expect(mocks.listCatalogTagAudit).toHaveBeenCalledWith(
      'org-1', riskHigh.id, { action: undefined, limit: 50 }, expect.any(AbortSignal),
    )
  })

  it('shows device-local outbox conflicts and exposes retry and confirmed discard actions', async () => {
    mocks.listTagCatalogOutbox.mockResolvedValue([{
      id: 'tag-outbox-tag_client_1',
      orgId: 'org-1',
      kind: 'tag',
      clientId: 'tag_client_1',
      label: 'High',
      groupId: riskGroup.id,
      groupName: 'Risk',
      color: '#E05252',
      description: null,
      iconKey: null,
      state: 'attention',
      createdAt: Date.parse('2026-07-18T12:00:00.000Z'),
      attemptCount: 1,
      lastAttemptAt: Date.parse('2026-07-18T12:01:00.000Z'),
      lastError: { code: 'duplicate_tag', message: 'A Tag with this value already exists in Risk.', status: 409 },
    }])

    render(<AdminTags />)
    await screen.findByText('High')
    await waitFor(() => expect(mocks.listTagCatalogOutbox).toHaveBeenCalledWith('org-1'))
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.open' }))

    expect(await screen.findByTitle('A Tag with this value already exists in Risk.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.retry' }))
    await waitFor(() => expect(mocks.retryTagCatalogOutboxEntry).toHaveBeenCalledWith('org-1', 'tag-outbox-tag_client_1'))

    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.discardLabel' }))
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.confirmDiscard' }))
    await waitFor(() => expect(mocks.discardTagCatalogOutboxEntry).toHaveBeenCalledWith('org-1', 'tag-outbox-tag_client_1'))
  })

  it('shows privacy-minimized synchronization metrics and switches reporting windows', async () => {
    render(<AdminTags />)
    await screen.findByText('High')
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.operations.open' }))

    expect(await screen.findByRole('dialog', { name: 'admin.tags.operations.title' })).toBeTruthy()
    await waitFor(() => expect(mocks.getTagOperationSummary).toHaveBeenCalledWith(
      'org-1', '7d', expect.any(AbortSignal),
    ))
    expect(screen.getByText('admin.tags.operations.privacyTitle')).toBeTruthy()
    expect(screen.getByText('admin.tags.operations.reasons.duplicate_tag')).toBeTruthy()
    await waitFor(() => expect(mocks.getReadModelHealth).toHaveBeenCalledWith('org-1', expect.any(AbortSignal)))
    expect(screen.getByText('admin.tags.operations.readModel.title')).toBeTruthy()
    expect(screen.getByText('Commerce')).toBeTruthy()
    expect(screen.getByText('Warehouse')).toBeTruthy()
    expect(screen.getByText('2.5 s')).toBeTruthy()
    expect(screen.getByText('1.5 s')).toBeTruthy()
    expect(screen.getByText('1.5 min')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('admin.tags.operations.window'), { target: { value: '30d' } })
    await waitFor(() => expect(mocks.getTagOperationSummary).toHaveBeenLastCalledWith(
      'org-1', '30d', expect.any(AbortSignal),
    ))
  })

  it('compares a duplicate local draft before mapping it to a canonical Tag', async () => {
    const localItem = {
      id: 'tag-outbox-tag_client_2',
      orgId: 'org-1',
      kind: 'tag' as const,
      clientId: 'tag_client_2',
      label: 'HIGH',
      groupId: riskGroup.id,
      groupName: riskGroup.name,
      color: '#B42318',
      description: null,
      iconKey: null,
      state: 'attention' as const,
      createdAt: Date.parse('2026-07-18T12:00:00.000Z'),
      attemptCount: 1,
      lastAttemptAt: Date.parse('2026-07-18T12:01:00.000Z'),
      lastError: { code: 'duplicate_tag', message: 'Duplicate', status: 409 },
    }
    mocks.listTagCatalogOutbox.mockResolvedValue([localItem])

    render(<AdminTags />)
    await screen.findByText('High')
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'admin.tags.outbox.resolve' }))
    fireEvent.click(await screen.findByText('select-existing-tag'))

    expect(await screen.findByTestId('tag-outbox-resolution-dialog')).toBeTruthy()
    expect(screen.getAllByText('HIGH').length).toBeGreaterThan(0)
    expect(screen.getAllByText('High').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.mapToExisting' }))
    await waitFor(() => expect(mocks.reconcileTagCatalogOutboxEntry).toHaveBeenCalledWith(
      'org-1', localItem.id, riskHigh,
    ))
  })

  it('maps a local Tag Group and delegates dependent Tag rewrites to the outbox transaction', async () => {
    const localGroupItem = {
      id: 'tag-outbox-taggrp_client_1',
      orgId: 'org-1',
      kind: 'group' as const,
      clientId: 'taggrp_client_1',
      label: 'Risks',
      groupId: null,
      groupName: null,
      color: null,
      description: 'Local duplicate',
      iconKey: null,
      state: 'attention' as const,
      createdAt: Date.parse('2026-07-18T12:00:00.000Z'),
      attemptCount: 1,
      lastAttemptAt: Date.parse('2026-07-18T12:01:00.000Z'),
      lastError: { code: 'duplicate_tag_group', message: 'Duplicate', status: 409 },
    }
    mocks.listTagCatalogOutbox.mockResolvedValue([localGroupItem])

    render(<AdminTags />)
    await screen.findByText('High')
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'admin.tags.outbox.resolve' }))
    fireEvent.click(await screen.findByText('select-existing-group'))
    expect((await screen.findAllByText('Risks')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'admin.tags.outbox.mapToExisting' }))

    await waitFor(() => expect(mocks.reconcileTagGroupOutboxEntry).toHaveBeenCalledWith(
      'org-1', localGroupItem.id, riskGroup,
    ))
  })
})
