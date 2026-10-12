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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getIconByName } from '../../lib/techIcons'
import { IconCatalogBrowser } from './IconCatalogBrowser'

const mocks = vi.hoisted(() => ({
  getIconPage: vi.fn(),
  getIconPacks: vi.fn(),
}))

vi.mock('../../lib/icons/api', () => mocks)
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../common/VirtualList', () => ({
  VirtualList: ({
    items,
    renderRow,
    emptyState,
  }: {
    items: Array<{ name: string }>
    renderRow: (item: { name: string }, index: number) => React.ReactNode
    emptyState?: React.ReactNode
  }) => <div>{items.length ? items.map((item, index) => <div key={item.name}>{renderRow(item, index)}</div>) : emptyState}</div>,
}))

const postgres = getIconByName('PostgreSQL')!

beforeEach(() => {
  mocks.getIconPacks.mockReset().mockResolvedValue([{ name: 'AWS', iconCount: 500 }])
  mocks.getIconPage.mockReset().mockResolvedValue({ icons: [postgres], nextCursor: 'page-2', total: 3_987 })
})
afterEach(cleanup)

describe('IconCatalogBrowser', () => {
  it('shares paged catalog selection metadata and shape compatibility feedback', async () => {
    const onSelect = vi.fn()
    render(
      <IconCatalogBrowser
        initialSearch="PostgreSQL"
        currentIcon="PostgreSQL"
        shapeType="system"
        onSelect={onSelect}
      />,
    )

    const option = await screen.findByRole('button', { name: 'PostgreSQL' })
    expect(option.getAttribute('aria-pressed')).toBe('true')
    expect(within(option).getByLabelText('Recommended for: store, group')).toBeTruthy()
    fireEvent.click(option)

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      name: 'PostgreSQL',
      compatibleWith: ['store', 'group'],
      iconLight: expect.stringMatching(/^\/icons\/light\//),
      iconDark: expect.stringMatching(/^\/icons\/dark\//),
    }))
    await waitFor(() => expect(mocks.getIconPage).toHaveBeenCalledWith(expect.objectContaining({
      q: 'PostgreSQL',
      limit: 50,
    })))
    expect(screen.getAllByTestId('icon-option')).toHaveLength(1)
  })

  it('keeps visual shape compatibility metadata with same-origin artwork', () => {
    expect(postgres.compatibleWith).toEqual(['store', 'group'])
    expect(postgres.iconLight).toMatch(/^\/icons\/light\//)
    expect(postgres.iconDark).toMatch(/^\/icons\/dark\//)
  })
})
