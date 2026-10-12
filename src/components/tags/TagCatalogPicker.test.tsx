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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../../stores/authStore'
import type { CatalogTag } from '../../lib/tags/api'
import { TagCatalogPicker } from './TagCatalogPicker'

const mocks = vi.hoisted(() => ({
  createCatalogTag: vi.fn(),
  listTagPage: vi.fn(),
  listTagGroupPage: vi.fn(),
}))

vi.mock('../../lib/tags/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tags/api')>(),
  listTagPage: mocks.listTagPage,
  listTagGroupPage: mocks.listTagGroupPage,
  createCatalogTag: mocks.createCatalogTag,
}))

vi.mock('../common/VirtualList', () => ({
  VirtualList: ({ items, renderRow, emptyState, onEndReached, footer }: {
    items: CatalogTag[]
    renderRow: (item: CatalogTag, index: number) => React.ReactNode
    emptyState?: React.ReactNode
    onEndReached?: () => void
    footer?: React.ReactNode
  }) => (
    <div>
      {items.length ? items.map((item, index) => <div key={item.id}>{renderRow(item, index)}</div>) : emptyState}
      {onEndReached && <button data-testid="load-next-tag-page" onClick={onEndReached}>load more</button>}
      {footer}
    </div>
  ),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const riskHigh: CatalogTag = {
  id: 'tag-risk-high',
  orgId: 'org-1',
  groupId: 'taggrp-risk',
  groupName: 'Risk',
  value: 'High',
  color: '#E05252',
  lifecycleStatus: 'active',
  canonicalTagId: null,
  version: 3,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
}

describe('TagCatalogPicker', () => {
  beforeEach(() => {
    useAuthStore.setState({ orgId: 'org-1' })
    mocks.listTagGroupPage.mockReset().mockResolvedValue({
      items: [{
        id: 'taggrp-risk', orgId: 'org-1', name: 'Risk', description: null, iconKey: null,
        lifecycleStatus: 'active', version: 1, createdAt: '', updatedAt: '',
      }],
      nextCursor: null,
      source: 'network',
    })
    mocks.listTagPage.mockReset().mockResolvedValue({ items: [riskHigh], nextCursor: null, source: 'network' })
    mocks.createCatalogTag.mockReset().mockResolvedValue(riskHigh)
  })

  afterEach(cleanup)

  it('searches the server, filters by group and returns a stable snapshot', async () => {
    const onSelect = vi.fn()
    render(<TagCatalogPicker isOpen assignedTagIds={[]} onClose={vi.fn()} onSelect={onSelect} />)

    await screen.findByText('High')
    fireEvent.change(screen.getByTestId('tag-group-filter'), { target: { value: 'taggrp-risk' } })
    await waitFor(() => expect(mocks.listTagPage).toHaveBeenLastCalledWith(
      'org-1',
      expect.objectContaining({ groupIds: ['taggrp-risk'], status: 'active' }),
      expect.any(AbortSignal),
    ))

    fireEvent.click(screen.getByTestId('tag-option-tag-risk-high'))
    expect(onSelect).toHaveBeenCalledWith({
      tagId: 'tag-risk-high', value: 'High', color: '#E05252', groupId: 'taggrp-risk',
      groupName: 'Risk', catalogRevision: 3,
    }, riskHigh)
  })

  it('appends cursor pages and disables already-assigned identities', async () => {
    const cost = { ...riskHigh, id: 'tag-cost-high', groupId: 'taggrp-cost', groupName: 'Cost' }
    mocks.listTagPage
      .mockReset()
      .mockResolvedValueOnce({ items: [riskHigh], nextCursor: 'page-2', source: 'network' })
      .mockResolvedValueOnce({ items: [cost], nextCursor: null, source: 'network' })

    render(<TagCatalogPicker isOpen assignedTagIds={['tag-risk-high']} onClose={vi.fn()} onSelect={vi.fn()} />)
    const assigned = await screen.findByTestId('tag-option-tag-risk-high') as HTMLButtonElement
    expect(assigned.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('load-next-tag-page'))
    expect(await screen.findByText('Cost')).toBeTruthy()
    expect(mocks.listTagPage).toHaveBeenLastCalledWith(
      'org-1',
      expect.objectContaining({ after: 'page-2' }),
    )
  })

  it('creates a governed Tag from an empty grouped search and selects it', async () => {
    mocks.listTagPage.mockReset().mockResolvedValue({ items: [], nextCursor: null, source: 'network' })
    const onSelect = vi.fn()
    render(<TagCatalogPicker isOpen allowCreate assignedTagIds={[]} onClose={vi.fn()} onSelect={onSelect} />)

    await screen.findByText('misc.tagPicker.noCatalogTags')
    fireEvent.change(screen.getByTestId('tag-group-filter'), { target: { value: 'taggrp-risk' } })
    fireEvent.change(screen.getByTestId('tag-catalog-search'), { target: { value: 'Critical' } })
    const create = await screen.findByTestId('create-tag-from-search')
    fireEvent.click(create)

    await waitFor(() => expect(mocks.createCatalogTag).toHaveBeenCalledWith('org-1', expect.objectContaining({
      groupId: 'taggrp-risk',
      value: 'Critical',
    })))
    expect(onSelect).toHaveBeenCalled()
  })

  it('THE BUG: creating is still offered when the search MATCHES something', async () => {
    // The create affordance must not live only in the list's `emptyState`
    // (rendered only when `items.length === 0`), or it disappears the moment
    // any row matches — precisely when a user typed a name that is not listed.
    // "High" is in the catalog, so searching "Hig" returns a row.
    render(<TagCatalogPicker isOpen allowCreate assignedTagIds={[]} onClose={vi.fn()} onSelect={vi.fn()} />)

    await screen.findByText('High')
    fireEvent.change(screen.getByTestId('tag-group-filter'), { target: { value: 'taggrp-risk' } })
    fireEvent.change(screen.getByTestId('tag-catalog-search'), { target: { value: 'Hig' } })

    // The matching row is still there...
    expect(await screen.findByTestId('tag-option-tag-risk-high')).toBeTruthy()
    // ...and so is the way to create the thing that was actually typed.
    expect(await screen.findByTestId('create-tag-from-search')).toBeTruthy()
  })

  it('hides the create offer once the typed value EXACTLY exists', async () => {
    // The counterpart: without this the footer is permanent noise, offering to
    // create a duplicate of the row sitting right above it.
    render(<TagCatalogPicker isOpen allowCreate assignedTagIds={[]} onClose={vi.fn()} onSelect={vi.fn()} />)

    await screen.findByText('High')
    fireEvent.change(screen.getByTestId('tag-group-filter'), { target: { value: 'taggrp-risk' } })
    fireEvent.change(screen.getByTestId('tag-catalog-search'), { target: { value: '  hIgH ' } })

    await waitFor(() => expect(screen.queryByTestId('create-tag-from-search')).toBeNull())
  })
})

const riskLow: CatalogTag = { ...riskHigh, id: 'tag-risk-low', value: 'Low', color: '#3F9142' }

describe('TagCatalogPicker multi-select', () => {
  beforeEach(() => {
    useAuthStore.setState({ orgId: 'org-1' })
    mocks.listTagGroupPage.mockReset().mockResolvedValue({
      items: [{
        id: 'taggrp-risk', orgId: 'org-1', name: 'Risk', description: null, iconKey: null,
        lifecycleStatus: 'active', version: 1, createdAt: '', updatedAt: '',
      }],
      nextCursor: null,
      source: 'network',
    })
    mocks.listTagPage.mockReset().mockResolvedValue({
      items: [riskHigh, riskLow], nextCursor: null, source: 'network',
    })
    mocks.createCatalogTag.mockReset().mockResolvedValue(riskHigh)
  })

  afterEach(cleanup)

  it('stages across searches and commits the basket once', async () => {
    const onSelect = vi.fn()
    const onSelectMany = vi.fn()
    const onClose = vi.fn()
    render(
      <TagCatalogPicker
        isOpen
        multiple
        assignedTagIds={[]}
        onClose={onClose}
        onSelect={onSelect}
        onSelectMany={onSelectMany}
      />,
    )

    await screen.findByText('High')
    fireEvent.click(screen.getByTestId('tag-option-tag-risk-high'))

    // Changing the query re-renders the list from a fresh server page; the
    // basket lives above it and has to survive that.
    fireEvent.change(screen.getByTestId('tag-catalog-search'), { target: { value: 'low' } })
    await waitFor(() => expect(screen.getByTestId('staged-tag-risk-high')).toBeTruthy())
    fireEvent.click(screen.getByTestId('tag-option-tag-risk-low'))

    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('commit-staged'))
    expect(onSelectMany).toHaveBeenCalledTimes(1)
    expect(onSelectMany.mock.calls[0][0].map((snapshot: { value: string }) => snapshot.value))
      .toEqual(['High', 'Low'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('adds a tag created mid-basket to the basket instead of committing it alone', async () => {
    mocks.listTagPage.mockReset().mockResolvedValue({ items: [], nextCursor: null, source: 'network' })
    const onSelect = vi.fn()
    const onSelectMany = vi.fn()
    const onClose = vi.fn()
    render(
      <TagCatalogPicker
        isOpen
        multiple
        allowCreate
        assignedTagIds={[]}
        onClose={onClose}
        onSelect={onSelect}
        onSelectMany={onSelectMany}
      />,
    )

    await screen.findByText('misc.tagPicker.noCatalogTags')
    fireEvent.change(screen.getByTestId('tag-group-filter'), { target: { value: 'taggrp-risk' } })
    fireEvent.change(screen.getByTestId('tag-catalog-search'), { target: { value: 'High' } })
    fireEvent.click(await screen.findByTestId('create-tag-from-search'))

    await waitFor(() => expect(screen.getByTestId('staged-tag-risk-high')).toBeTruthy())
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves closeOnSelect callers alone', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<TagCatalogPicker isOpen assignedTagIds={[]} onClose={onClose} onSelect={onSelect} />)

    await screen.findByText('High')
    expect(screen.queryByTestId('tag-selection-tray')).toBeNull()
    fireEvent.click(screen.getByTestId('tag-option-tag-risk-high'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
