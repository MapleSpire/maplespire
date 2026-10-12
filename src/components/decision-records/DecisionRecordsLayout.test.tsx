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
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionRecord } from '../../types'
import { ADRList } from './ADRList'
import { ADRRelatedLinks } from './ADRRelatedLinks'
import { ADRStatusBadge } from './ADRStatusBadge'
import { DecisionRecordsAIAssistButton } from './DecisionRecordsView'

const mocks = vi.hoisted(() => ({
  record: {
    id: 'adr-24',
    number: 24,
    title: 'Adopt S3 for Digital Health Platform Appointments',
    summary: 'Summary',
    status: 'in-progress' as const,
    author: 'Architect',
    createdAt: '2025-12-24T12:00:00.000Z',
    updatedAt: '2025-12-24T12:00:00.000Z',
    content: '',
    related: [],
  },
  newestRecord: {
    id: 'adr-251',
    number: 251,
    title: 'Newest local decision',
    summary: 'Newest',
    status: 'in-progress' as const,
    author: 'Architect',
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
    content: '',
    related: [],
  },
  olderRecord: {
    id: 'adr-1',
    number: 1,
    title: 'Old decision',
    summary: 'Oldest',
    status: 'approved' as const,
    author: 'Architect',
    createdAt: '2024-01-01T12:00:00.000Z',
    updatedAt: '2024-01-01T12:00:00.000Z',
    content: '',
    related: [],
  },
  setSelectedADRId: vi.fn(),
  setCurrentDiagram: vi.fn(),
  setCurrentView: vi.fn(),
  toggleAIAssist: vi.fn(),
}))

const record: DecisionRecord = mocks.record

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../lib/i18n', () => ({
  normalizeLanguage: (language: string) => language === 'fr' ? 'fr' : 'en',
  default: {
    language: 'fr',
    resolvedLanguage: 'fr',
    on: vi.fn(),
    off: vi.fn(),
    changeLanguage: vi.fn(),
  },
}))

/** The related-link track is measured against a LIVE target: a chip whose
 *  diagram is absent now resolves to `dangling` and renders as an inert span,
 *  which would make the truncation assertion below test the wrong element.
 *  The name is inlined because vi.mock factories hoist above module consts. */
vi.mock('../../stores/modelStore', () => {
  const state = {
    decisionRecords: [mocks.record, mocks.olderRecord, mocks.newestRecord],
    diagrams: [{
      id: 'diagram-1',
      name: 'Digital Health Platform / Appointments / ca-central-1 — Component Interaction View 00024',
      type: 'component',
      objectIds: [],
      connectionIds: [],
      groupIds: [],
    }],
    setCurrentDiagram: mocks.setCurrentDiagram,
  }
  const useModelStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useModelStore }
})

vi.mock('../../stores/uiStore', () => {
  const state = {
    selectedADRId: mocks.record.id,
    setSelectedADRId: mocks.setSelectedADRId,
    adrSearchQuery: '',
    setCurrentView: mocks.setCurrentView,
    aiAssistOpen: false,
    toggleAIAssist: mocks.toggleAIAssist,
  }
  const useUIStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useUIStore }
})

vi.mock('../common/VirtualList', () => ({
  useVirtualRows: ({ count }: { count: number }) => ({
    virtualItems: Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 52 })),
    totalSize: count * 52,
    measureElement: vi.fn(),
  }),
}))

afterEach(cleanup)

describe('decision-record layout regressions', () => {
  it('keeps a status badge on one line', () => {
    render(<ADRStatusBadge status="in-progress" />)
    expect(screen.getByRole('button').className).toContain('whitespace-nowrap')
  })

  it('exposes AI Assist from the ADR toolbar', () => {
    render(<DecisionRecordsAIAssistButton />)
    const button = screen.getByTestId('adr-ai-assist')
    expect(button.textContent).toBe('decisionRecords.view.aiAssist')
    fireEvent.click(button)
    expect(mocks.toggleAIAssist).toHaveBeenCalledOnce()
  })

  it('keeps related items in a single horizontal track', () => {
    const label = 'Digital Health Platform / Appointments / ca-central-1 — Component Interaction View 00024'
    render(
      <ADRRelatedLinks
        links={[{ id: 'link-1', type: 'diagram', targetId: 'diagram-1', label }]}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByTestId('adr-related-links-track').className).toContain('flex-nowrap')
    expect(screen.getByRole('button', { name: label }).className).toContain('whitespace-nowrap')
  })

  it('extends the selected list-row background behind the floating navigation', () => {
    render(<ADRList />)

    const rail = screen.getByTestId('adr-list-rail')
    const selectedRow = screen.getByTestId(`adr-list-row-${record.id}`)
    expect(rail.className).toContain('w-[calc(var(--pad-l)+264px)]')
    expect(selectedRow.className).toContain('w-full')
    expect(selectedRow.className).toContain('bg-accent-subtle')
    expect(selectedRow.style.paddingLeft).toBe('calc(var(--pad-l) + 14px)')
  })

  it('renders an unsorted local record collection with the newest ADR first', () => {
    render(<ADRList />)

    const rowIds = screen.getAllByTestId(/^adr-list-row-/).map((row) => row.getAttribute('data-testid'))
    expect(rowIds).toEqual([
      'adr-list-row-adr-251',
      `adr-list-row-${record.id}`,
      'adr-list-row-adr-1',
    ])
  })
})
