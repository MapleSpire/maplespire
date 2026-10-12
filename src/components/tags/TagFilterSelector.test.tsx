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
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useModelStore } from '../../stores/modelStore'
import { TagFilterSelector } from './TagFilterSelector'

const mocks = vi.hoisted(() => ({ resolveCatalogTags: vi.fn() }))

vi.mock('../../lib/tags/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tags/api')>(),
  resolveCatalogTags: mocks.resolveCatalogTags,
}))
vi.mock('./TagCatalogPicker', () => ({
  TagCatalogPicker: ({ isOpen, onSelect }: { isOpen: boolean; onSelect: (snapshot: { tagId: string }) => void }) => isOpen
    ? <button data-testid="mock-tag-catalog-choice" onClick={() => onSelect({ tagId: 'tag-region-ca' })}>Canada</button>
    : null,
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('TagFilterSelector', () => {
  beforeEach(() => {
    useModelStore.setState({ tags: [
      { tagId: 'tag-risk-high', value: 'High', color: '#E05252', groupId: 'taggrp-risk', groupName: 'Risk', catalogRevision: 1 },
      { tagId: 'tag-risk-low', value: 'Low', color: '#4F9D69', groupId: 'taggrp-risk', groupName: 'Risk', catalogRevision: 1 },
    ] })
    mocks.resolveCatalogTags.mockReset().mockRejectedValue(new Error('offline'))
  })

  afterEach(cleanup)

  it('groups retained selections and toggles catalog identities without loading all tags', () => {
    const onToggle = vi.fn()
    render(<TagFilterSelector orgId="org-1" selectedIds={['tag-risk-high', 'tag-risk-low']} onToggle={onToggle} />)
    expect(screen.getByText('Risk')).toBeTruthy()
    expect(screen.getByText('High')).toBeTruthy()
    expect(screen.getByText('Low')).toBeTruthy()

    fireEvent.click(screen.getByTestId('model-tag-filter-tag-risk-high'))
    expect(onToggle).toHaveBeenCalledWith('tag-risk-high')
    fireEvent.click(screen.getByRole('button', { name: 'misc.tagPicker.browseFilters' }))
    fireEvent.click(screen.getByTestId('mock-tag-catalog-choice'))
    expect(onToggle).toHaveBeenCalledWith('tag-region-ca')
  })
})
