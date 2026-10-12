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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogTechnology } from '../../lib/technologies/api'
import { useThemeStore } from '../../stores/themeStore'
import { TechnologyFilterSelector } from './TechnologyFilterSelector'

const mocks = vi.hoisted(() => ({
  listSelectableTechnologies: vi.fn(),
  resolveSelectableTechnologies: vi.fn(),
}))

vi.mock('../../lib/technologies/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/technologies/api')>(),
  listSelectableTechnologies: mocks.listSelectableTechnologies,
  resolveSelectableTechnologies: mocks.resolveSelectableTechnologies,
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) => values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}))

function technology(
  id: string,
  name: string,
  icons: { light?: string; dark?: string } = {},
): CatalogTechnology {
  return {
    id,
    scope: 'public',
    lifecycleStatus: 'active',
    orgState: 'enabled',
    orgOverride: null,
    revision: {
      revision: 1,
      status: 'approved',
      privateApproved: false,
      name,
      description: null,
      aliases: [],
      iconLightPath: icons.light ?? null,
      iconDarkPath: icons.dark ?? null,
      recommendedShapeTypes: ['app'],
      defaultRole: 'other',
    },
  }
}

describe('TechnologyFilterSelector catalog scale', () => {
  const page = Array.from({ length: 50 }, (_, index) => technology(`tech-${index}`, `Technology ${index}`))
  const selected = technology('tech-selected', 'Selected outside current page')

  beforeEach(() => {
    useThemeStore.setState({ mode: 'light', resolved: 'light', systemPrefersDark: false })
    mocks.listSelectableTechnologies.mockReset().mockImplementation((_orgId: string, query: string) => Promise.resolve(
      query === 'postgres'
        ? { technologies: [technology('tech-postgres', 'PostgreSQL')], source: 'network', hasMore: false }
        : { technologies: page, source: 'network', hasMore: true },
    ))
    mocks.resolveSelectableTechnologies.mockReset().mockResolvedValue({
      technologies: [selected], source: 'network',
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders one bounded result page and pins selections that are outside it', async () => {
    const onToggle = vi.fn()
    const { container } = render(
      <TechnologyFilterSelector
        orgId="org-50k"
        selectedIds={[selected.id]}
        onToggle={onToggle}
        testIdPrefix="model-technology-filter"
        variant="chips"
      />,
    )

    await screen.findByText(selected.revision.name)
    await screen.findByText('Technology 49')
    expect(container.querySelectorAll('[data-testid^="model-technology-filter-tech-"]')).toHaveLength(51)
    expect(screen.getByText('common.technologyFilter.resultsLimited:50')).toBeTruthy()
    expect(screen.getByTestId(`model-technology-filter-${selected.id}`).getAttribute('aria-pressed')).toBe('true')

    fireEvent.change(screen.getByTestId('model-technology-filter-search'), { target: { value: 'postgres' } })
    await waitFor(() => expect(mocks.listSelectableTechnologies).toHaveBeenLastCalledWith(
      'org-50k', 'postgres', expect.any(AbortSignal),
    ))
    await screen.findByText('PostgreSQL')

    expect(screen.getByText(selected.revision.name)).toBeTruthy()
    expect(container.querySelectorAll('[data-testid^="model-technology-filter-tech-"]')).toHaveLength(2)
    expect(screen.queryByText('Technology 49')).toBeNull()
    fireEvent.click(screen.getByTestId(`model-technology-filter-${selected.id}`))
    expect(onToggle).toHaveBeenCalledWith(selected.id)
  })

  it('debounces remote searches so rapid input does not query every keystroke', async () => {
    vi.useFakeTimers()
    render(
      <TechnologyFilterSelector
        orgId="org-50k"
        selectedIds={[]}
        onToggle={() => undefined}
        testIdPrefix="technology-filter"
      />,
    )
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(mocks.listSelectableTechnologies).toHaveBeenCalledWith(
      'org-50k', '', expect.any(AbortSignal),
    )

    fireEvent.change(screen.getByTestId('technology-filter-search'), { target: { value: 'p' } })
    fireEvent.change(screen.getByTestId('technology-filter-search'), { target: { value: 'postgres' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(mocks.listSelectableTechnologies).toHaveBeenCalledTimes(2)
    expect(mocks.listSelectableTechnologies.mock.calls.map((call) => call[1])).toEqual(['', 'postgres'])
  })

  it('does not auto-query non-selective short terms but allows Enter for names such as Go', async () => {
    vi.useFakeTimers()
    render(
      <TechnologyFilterSelector
        orgId="org-50k"
        selectedIds={[]}
        onToggle={() => undefined}
        testIdPrefix="technology-filter"
      />,
    )
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    const input = screen.getByTestId('technology-filter-search')

    fireEvent.change(input, { target: { value: 'go' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(mocks.listSelectableTechnologies).toHaveBeenCalledTimes(1)
    expect(screen.getByText('common.technologyFilter.shortQuery')).toBeTruthy()

    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(mocks.listSelectableTechnologies).toHaveBeenLastCalledWith(
      'org-50k', 'go', expect.any(AbortSignal),
    )
  })

  it.each([
    ['checklist', 'technology-filter'],
    ['chips', 'model-technology-filter'],
  ] as const)('renders catalog light/dark artwork in the %s variant', async (variant, testIdPrefix) => {
    const iconLightPath = `/assets/technologies/${'a'.repeat(64)}.svg`
    const iconDarkPath = `/assets/technologies/${'b'.repeat(64)}.svg`
    const postgres = technology('tech-postgres', 'PostgreSQL custom', {
      light: iconLightPath,
      dark: iconDarkPath,
    })
    mocks.listSelectableTechnologies.mockResolvedValue({
      technologies: [postgres],
      source: 'network',
      hasMore: false,
    })

    render(
      <TechnologyFilterSelector
        orgId="org-icons"
        selectedIds={[]}
        onToggle={() => undefined}
        testIdPrefix={testIdPrefix}
        variant={variant}
      />,
    )

    const control = await screen.findByTestId(`${testIdPrefix}-${postgres.id}`)
    const image = (control.closest('label') ?? control).querySelector('img')
    expect(image?.getAttribute('src')).toBe(iconLightPath)
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('aria-hidden')).toBe('true')

    useThemeStore.setState({ mode: 'dark', resolved: 'dark', systemPrefersDark: false })
    await waitFor(() => expect(image?.getAttribute('src')).toBe(iconDarkPath))
  })
})
