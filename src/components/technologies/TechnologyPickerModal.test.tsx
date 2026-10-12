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
import type { CatalogTechnology } from '../../lib/technologies/api'
import { TechnologyPickerModal } from './TechnologyPickerModal'

const mocks = vi.hoisted(() => ({
  listSelectableTechnologyPage: vi.fn(),
  listTechnologyCatalogFacets: vi.fn(),
}))

vi.mock('../../lib/technologies/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/technologies/api')>(),
  listSelectableTechnologyPage: mocks.listSelectableTechnologyPage,
  listTechnologyCatalogFacets: mocks.listTechnologyCatalogFacets,
}))

vi.mock('../common/VirtualList', () => ({
  VirtualList: ({
    items,
    renderRow,
    emptyState,
    onEndReached,
    footer,
  }: {
    items: CatalogTechnology[]
    renderRow: (item: CatalogTechnology, index: number) => React.ReactNode
    emptyState?: React.ReactNode
    onEndReached?: () => void
    footer?: React.ReactNode
  }) => (
    <div>
      {items.length ? items.map((item, index) => <div key={item.id}>{renderRow(item, index)}</div>) : emptyState}
      {onEndReached && <button data-testid="load-next-page" onClick={onEndReached}>load more</button>}
      {footer}
    </div>
  ),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const labels: Record<string, string> = {
        'layoutNav.rightSidebar.technologyShapeType.app': 'App',
        'layoutNav.rightSidebar.technologyShapeType.store': 'Store',
      }
      if (key === 'layoutNav.rightSidebar.technologyShapeWarning') {
        return `This technology should be used for ${values?.recommended}. Current shape: ${values?.current}.`
      }
      return labels[key] ?? key
    },
  }),
}))

const postgres: CatalogTechnology = {
  id: 'tech-postgresql',
  scope: 'public',
  lifecycleStatus: 'active',
  orgState: 'enabled',
  orgOverride: null,
  revision: {
    revision: 4,
    status: 'approved',
    privateApproved: true,
    name: 'PostgreSQL',
    description: null,
    aliases: ['Postgres'],
    category: 'Database',
    iconLightPath: '/icons/postgresql.svg',
    iconDarkPath: null,
    recommendedShapeTypes: ['store'],
    defaultRole: 'database',
  },
}

describe('TechnologyPickerModal usage metadata', () => {
  beforeEach(() => {
    useAuthStore.setState({ orgId: 'org-1' })
    mocks.listSelectableTechnologyPage.mockReset().mockResolvedValue({
      technologies: [postgres], source: 'network', hasMore: false, nextCursor: null,
    })
    mocks.listTechnologyCatalogFacets.mockReset().mockResolvedValue({
      categories: [{ value: 'Database', count: 1 }],
      shapeTypes: [{ value: 'store', count: 1 }],
      roles: [{ value: 'database', count: 1 }],
    })
  })

  afterEach(cleanup)

  it('shows shape guidance and snapshots it with the catalog default role', async () => {
    const onSelect = vi.fn()
    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={[]}
        shapeType="app"
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    )

    await screen.findByText('PostgreSQL')
    expect(screen.getByTestId('technology-shape-warning').getAttribute('title'))
      .toBe('This technology should be used for Store. Current shape: App.')

    fireEvent.click(screen.getByRole('button', { name: /PostgreSQL/ }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0]).toMatchObject({
      technologyId: 'tech-postgresql',
      catalogRevision: 4,
      role: 'database',
      snapshot: {
        name: 'PostgreSQL',
        iconLightPath: '/icons/postgresql.svg',
        recommendedShapeTypes: ['store'],
        defaultRole: 'database',
      },
    })
  })

  it('does not show a warning when the current shape is recommended', async () => {
    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={[]}
        shapeType="store"
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    await waitFor(() => expect(mocks.listSelectableTechnologyPage).toHaveBeenCalled())
    await screen.findByText('PostgreSQL')
    expect(screen.queryByTestId('technology-shape-warning')).toBeNull()
  })

  it('sends category, recommended shape and role filters to PostgreSQL paging', async () => {
    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={[]}
        shapeType="store"
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    await screen.findByText('PostgreSQL')
    fireEvent.change(screen.getByTestId('technology-category-filter'), { target: { value: 'Database' } })
    fireEvent.change(screen.getByTestId('technology-shape-filter'), { target: { value: 'store' } })
    fireEvent.change(screen.getByTestId('technology-role-filter'), { target: { value: 'database' } })

    await waitFor(() => expect(mocks.listSelectableTechnologyPage).toHaveBeenLastCalledWith(
      'org-1',
      expect.objectContaining({ category: 'Database', shapeType: 'store', role: 'database' }),
      expect.any(AbortSignal),
    ))
  })

  it('appends cursor pages without replacing the virtualized catalog', async () => {
    const redis: CatalogTechnology = {
      ...postgres,
      id: 'tech-redis',
      revision: { ...postgres.revision, name: 'Redis', aliases: [] },
    }
    mocks.listSelectableTechnologyPage
      .mockReset()
      .mockResolvedValueOnce({ technologies: [postgres], source: 'network', hasMore: true, nextCursor: 'page-2' })
      .mockResolvedValueOnce({ technologies: [redis], source: 'network', hasMore: false, nextCursor: null })

    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={[]}
        shapeType="store"
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    await screen.findByText('PostgreSQL')
    fireEvent.click(screen.getByTestId('load-next-page'))
    expect(await screen.findByText('Redis')).toBeTruthy()
    expect(screen.getByText('PostgreSQL')).toBeTruthy()
    expect(mocks.listSelectableTechnologyPage).toHaveBeenLastCalledWith(
      'org-1',
      expect.objectContaining({ after: 'page-2' }),
    )
  })

  it('lets the icon workflow reuse an assigned technology and exposes generic icons secondarily', async () => {
    const onSelect = vi.fn()
    const onBrowseGenericIcons = vi.fn()
    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={['tech-postgresql']}
        allowAssignedSelection
        shapeType="store"
        onClose={vi.fn()}
        onSelect={onSelect}
        onBrowseGenericIcons={onBrowseGenericIcons}
      />,
    )

    // The row's accessible name carries the category as well as the name, so a
    // screen-reader user can tell near-neighbours in a catalog search apart.
    const technology = await screen.findByRole('button', { name: 'PostgreSQL, Database' })
    expect((technology as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(technology)
    expect(onSelect.mock.calls[0][0].technologyId).toBe('tech-postgresql')

    fireEvent.click(screen.getByRole('button', { name: 'layoutNav.rightSidebar.browseGenericIcons' }))
    expect(onBrowseGenericIcons).toHaveBeenCalledOnce()
  })

  it('labels approved private organization technologies without consulting the generic catalog', async () => {
    mocks.listSelectableTechnologyPage.mockResolvedValue({
      technologies: [{
        ...postgres,
        id: 'tech-private-kimi',
        scope: 'org_private',
        revision: {
          ...postgres.revision,
          name: 'Kimi',
          iconLightPath: '/assets/technologies/kimi-light.svg',
          iconDarkPath: '/assets/technologies/kimi-dark.svg',
        },
      }],
      source: 'network',
      hasMore: false,
      nextCursor: null,
    })

    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={[]}
        shapeType="app"
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('technology-option-tech-private-kimi')).toBeTruthy()
    expect(screen.getByText('layoutNav.rightSidebar.privateTechnology')).toBeTruthy()
  })

  it('opens beside its trigger and can be moved from the shared header', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 900, y: 120, left: 900, top: 120, right: 940, bottom: 152,
      width: 40, height: 32, toJSON: () => ({}),
    })

    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={[]}
        shapeType="store"
        triggerRef={{ current: trigger }}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    const picker = await screen.findByTestId('technology-picker')
    await waitFor(() => expect(picker.style.left).toBe('212px'))
    expect(picker.style.top).toBe('120px')

    fireEvent.mouseDown(screen.getByTestId('technology-picker-drag-handle'), { clientX: 220, clientY: 130 })
    fireEvent.mouseMove(window, { clientX: 260, clientY: 170 })
    await waitFor(() => expect(picker.style.left).toBe('252px'))
    fireEvent.mouseUp(window)
    trigger.remove()
  })
})

const kafka: CatalogTechnology = {
  ...postgres,
  id: 'tech-kafka',
  revision: { ...postgres.revision, name: 'Apache Kafka', category: 'Messaging', aliases: [] },
}

describe('TechnologyPickerModal multi-select', () => {
  beforeEach(() => {
    useAuthStore.setState({ orgId: 'org-1' })
    mocks.listSelectableTechnologyPage.mockReset().mockResolvedValue({
      technologies: [postgres, kafka], source: 'network', hasMore: false, nextCursor: null,
    })
    mocks.listTechnologyCatalogFacets.mockReset().mockResolvedValue({
      categories: [], shapeTypes: [], roles: [],
    })
  })

  afterEach(cleanup)

  it('stays open while staging and commits the whole basket once', async () => {
    const onSelect = vi.fn()
    const onSelectMany = vi.fn()
    const onClose = vi.fn()
    render(
      <TechnologyPickerModal
        isOpen
        multiple
        assignedTechnologyIds={[]}
        onClose={onClose}
        onSelect={onSelect}
        onSelectMany={onSelectMany}
      />,
    )

    await screen.findByText('PostgreSQL')
    fireEvent.click(screen.getByTestId('technology-option-tech-postgresql'))
    fireEvent.click(screen.getByTestId('technology-option-tech-kafka'))

    // The single-item path must not fire, and the picker must not close: that
    // pair is the whole point of the mode.
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('staged-tech-postgresql')).toBeTruthy()
    expect(screen.getByTestId('staged-tech-kafka')).toBeTruthy()

    fireEvent.click(screen.getByTestId('commit-staged'))
    expect(onSelectMany).toHaveBeenCalledTimes(1)
    expect(onSelectMany.mock.calls[0][0].map((usage: { technologyId: string }) => usage.technologyId))
      .toEqual(['tech-postgresql', 'tech-kafka'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toggles a staged row back off', async () => {
    const onSelectMany = vi.fn()
    render(
      <TechnologyPickerModal
        isOpen
        multiple
        assignedTechnologyIds={[]}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSelectMany={onSelectMany}
      />,
    )

    await screen.findByText('PostgreSQL')
    const row = screen.getByTestId('technology-option-tech-postgresql')
    fireEvent.click(row)
    expect(row.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(row)
    expect(row.getAttribute('aria-pressed')).toBe('false')

    expect(screen.queryByTestId('staged-tech-postgresql')).toBeNull()
    expect((screen.getByTestId('commit-staged') as HTMLButtonElement).disabled).toBe(true)
  })

  it('discards the basket when the picker is closed and reopened', async () => {
    const onSelectMany = vi.fn()
    const props = {
      multiple: true,
      assignedTechnologyIds: [],
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onSelectMany,
    }
    const { rerender } = render(<TechnologyPickerModal isOpen {...props} />)

    await screen.findByText('PostgreSQL')
    fireEvent.click(screen.getByTestId('technology-option-tech-postgresql'))
    expect(screen.getByTestId('staged-tech-postgresql')).toBeTruthy()

    rerender(<TechnologyPickerModal isOpen={false} {...props} />)
    rerender(<TechnologyPickerModal isOpen {...props} />)

    await screen.findByText('PostgreSQL')
    expect(screen.queryByTestId('staged-tech-postgresql')).toBeNull()
  })

  it('keeps the single-select contract when multiple is not asked for', async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(
      <TechnologyPickerModal
        isOpen
        assignedTechnologyIds={[]}
        onClose={onClose}
        onSelect={onSelect}
      />,
    )

    await screen.findByText('PostgreSQL')
    expect(screen.queryByTestId('technology-selection-tray')).toBeNull()
    fireEvent.click(screen.getByTestId('technology-option-tech-postgresql'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores multiple when the caller supplied no batch handler', async () => {
    const onSelect = vi.fn()
    render(
      <TechnologyPickerModal
        isOpen
        multiple
        assignedTechnologyIds={[]}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    )

    await screen.findByText('PostgreSQL')
    expect(screen.queryByTestId('technology-selection-tray')).toBeNull()
    fireEvent.click(screen.getByTestId('technology-option-tech-postgresql'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
