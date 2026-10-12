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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ADRRelatedLinks } from './ADRRelatedLinks'
import type { ADRLink } from '../../types'

/**
 * The navigation half of ADR link handling. `resolveADRLink` decides what a
 * link IS; this file pins what the UI does about it — notably that a dead
 * diagram link does not land on `diagram-not-found`, and a dead record link
 * does not replace the pane the user is reading with the empty state.
 */

const mocks = vi.hoisted(() => ({
  setCurrentDiagram: vi.fn(),
  setCurrentView: vi.fn(),
  setSelectedADRId: vi.fn(),
  summaryOnly: false,
  serverTier: false,
  fetchDiagramMeta: vi.fn(),
  fetchDecisionRecordDetail: vi.fn(),
  windowOpen: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

vi.mock('../../stores/modelStore', () => {
  const state = {
    decisionRecords: [{
      id: 'r1', number: 7, title: 'Use Postgres', summary: '', status: 'approved',
      author: 'a', createdAt: '', updatedAt: '', content: '', related: [],
    }],
    diagrams: [{ id: 'd1', name: 'Payments C2', type: 'container', objectIds: [], connectionIds: [], groupIds: [] }],
    setCurrentDiagram: mocks.setCurrentDiagram,
  }
  const useModelStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useModelStore }
})

vi.mock('../../stores/uiStore', () => {
  const state = { setSelectedADRId: mocks.setSelectedADRId, setCurrentView: mocks.setCurrentView }
  const useUIStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  )
  return { useUIStore }
})

vi.mock('../../lib/automerge/bridge', () => ({
  isRegistrySummaryOnlyActive: () => mocks.summaryOnly,
}))
vi.mock('../../lib/modelQuery/tierFlag', () => ({
  isServerReadModelEnabled: () => mocks.serverTier,
}))
vi.mock('../../lib/modelQuery/diagramMeta', () => ({
  fetchDiagramMeta: mocks.fetchDiagramMeta,
}))
vi.mock('../../lib/modelQuery/decisionRecords', () => ({
  fetchDecisionRecordDetail: mocks.fetchDecisionRecordDetail,
}))

const link = (over: Partial<ADRLink> & { type: ADRLink['type'] }): ADRLink =>
  ({ id: 'l1', label: 'stored label', ...over })

const renderLinks = (links: ADRLink[], editable = false) =>
  render(<ADRRelatedLinks links={links} editable={editable} onChange={vi.fn()} />)

const chip = () => screen.getByTestId('adr-related-link')

beforeEach(() => {
  mocks.summaryOnly = false
  mocks.serverTier = false
  vi.stubGlobal('open', mocks.windowOpen)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('a link whose target is gone', () => {
  beforeEach(() => renderLinks([link({ type: 'diagram', targetId: 'deleted' })]))

  it('is not a button, so it cannot be clicked at all', () => {
    expect(screen.queryByRole('button')).toBeNull()
    expect(chip().getAttribute('data-link-state')).toBe('dangling')
  })

  it('says why, rather than showing the label as if nothing were wrong', () => {
    expect(screen.getByTitle('decisionRecords.relatedLinks.deletedTarget')).toBeTruthy()
  })

  it('is struck through — the one issue where the target really did exist', () => {
    expect(screen.getByText('stored label').className).toContain('line-through')
  })

  it('swaps the icon, because colour cannot carry this', () => {
    // `--color-line` is 1.26:1 against the chip fill in dark mode and
    // `--color-fg-subtle` is 3.02:1 — below AA at 11px. A different SHAPE is the
    // only cue that survives that, a greyscale print and a colour-blind reader.
    expect(chip().querySelector('svg')?.getAttribute('class')).toContain('unlink')
  })

  it('keeps the label readable — it is the one the user has to identify to remove', () => {
    // Measured on this fill: fg-subtle 3.02:1 (dark), fg-muted 3.57:1 (light).
    // Both fail AA at 11px. fg-secondary is 7.54 / 7.76.
    expect(chip().className).toContain('text-fg-secondary')
    expect(chip().className).not.toMatch(/text-fg-(subtle|muted)\b/)
  })

  it('never navigates, so the user is not sent to diagram-not-found', () => {
    fireEvent.click(screen.getByText('stored label'))
    expect(mocks.setCurrentDiagram).not.toHaveBeenCalled()
  })
})

describe('a link type this build does not know', () => {
  it('renders an inert chip instead of blanking the pane', () => {
    // Indexing LINK_TYPE_CONFIG with an unknown type threw, and src/ has no
    // ErrorBoundary — the whole decision record disappeared.
    renderLinks([{ id: 'l1', type: 'wiki' as ADRLink['type'], label: 'Wiki page' }])
    expect(chip().getAttribute('data-link-issue')).toBe('unsupported-type')
    expect(screen.getByText('Wiki page').className).not.toContain('line-through')
    // A distinct icon from the deleted case: broken data, not a dead reference.
    expect(chip().querySelector('svg')?.getAttribute('class')).toContain('circle-alert')
  })
})

describe('a url link', () => {
  it('opens a real web address', () => {
    renderLinks([link({ type: 'url', url: 'https://example.com/adr' })])
    fireEvent.click(screen.getByRole('button'))
    expect(mocks.windowOpen).toHaveBeenCalledWith('https://example.com/adr', '_blank', 'noopener,noreferrer')
  })

  it('refuses a bare host instead of opening it inside the app', () => {
    renderLinks([link({ type: 'url', url: 'example.com' })])
    expect(screen.queryByRole('button')).toBeNull()
    expect(chip().getAttribute('data-link-issue')).toBe('invalid-url')
  })

  it('refuses a javascript: url', () => {
    renderLinks([link({ type: 'url', url: 'javascript:alert(1)' })])
    expect(chip().getAttribute('data-link-issue')).toBe('invalid-url')
    expect(mocks.windowOpen).not.toHaveBeenCalled()
  })
})

describe('a link beyond the loaded window', () => {
  beforeEach(() => { mocks.summaryOnly = true })

  it('stays enabled — unknown must never render like dangling', () => {
    renderLinks([link({ type: 'diagram', targetId: 'far' })])
    expect(chip().getAttribute('data-link-state')).toBe('unknown')
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('resolves on click and navigates when the server confirms the target', async () => {
    mocks.fetchDiagramMeta.mockResolvedValue({ meta: {}, diagram: {}, comments: [], flows: [] })
    renderLinks([link({ type: 'diagram', targetId: 'far' })])
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(mocks.setCurrentDiagram).toHaveBeenCalledWith('far'))
    expect(mocks.setCurrentView).toHaveBeenCalledWith('diagram')
  })

  it('records a 404 as death and does NOT navigate', async () => {
    mocks.fetchDiagramMeta.mockResolvedValue(undefined)
    renderLinks([link({ type: 'diagram', targetId: 'far' })])
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(chip().getAttribute('data-link-state')).toBe('dangling'))
    expect(mocks.setCurrentDiagram).not.toHaveBeenCalled()
  })

  it('does not treat an unreachable server as proof the target is gone', async () => {
    // Offline is not a verdict. Marking the link dead here would strike out a
    // healthy reference for the rest of the session.
    mocks.fetchDiagramMeta.mockRejectedValue(new Error('offline'))
    renderLinks([link({ type: 'diagram', targetId: 'far' })])
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(mocks.setCurrentDiagram).toHaveBeenCalledWith('far'))
    expect(chip().getAttribute('data-link-state')).toBe('unknown')
  })
})

describe('an off-window record link', () => {
  beforeEach(() => { mocks.serverTier = true })

  it('does not deselect the record being read when the target is gone', async () => {
    // The old code set selectedADRId unconditionally; ADRDetail then rendered
    // the "nothing selected" screen and its recovery effect only fires when the
    // selection is falsy, so the user lost the record they were reading.
    mocks.fetchDecisionRecordDetail.mockRejectedValue(Object.assign(new Error('404'), { status: 404 }))
    renderLinks([link({ type: 'adr', targetId: 'ADR-4000' })])
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(chip().getAttribute('data-link-state')).toBe('dangling'))
    expect(mocks.setSelectedADRId).not.toHaveBeenCalled()
  })

  it('selects it once the server confirms it exists', async () => {
    mocks.fetchDecisionRecordDetail.mockResolvedValue({ id: 'ADR-4000' })
    renderLinks([link({ type: 'adr', targetId: 'ADR-4000' })])
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(mocks.setSelectedADRId).toHaveBeenCalledWith('ADR-4000'))
  })
})

describe('a resolvable link', () => {
  it('shows the CURRENT target name, not the label frozen at creation', () => {
    renderLinks([link({ type: 'diagram', targetId: 'd1', label: 'Old name' })])
    expect(screen.getByRole('button').textContent).toBe('Payments C2')
  })

  it('navigates without a round trip, because nothing needs resolving', () => {
    renderLinks([link({ type: 'diagram', targetId: 'd1' })])
    fireEvent.click(screen.getByRole('button'))
    expect(mocks.fetchDiagramMeta).not.toHaveBeenCalled()
    expect(mocks.setCurrentDiagram).toHaveBeenCalledWith('d1')
  })
})

describe('removal', () => {
  it('stays available on a dead chip, which is the only way to clean it up', () => {
    renderLinks([link({ type: 'diagram', targetId: 'deleted' })], true)
    expect(screen.getByTitle('decisionRecords.relatedLinks.removeLink')).toBeTruthy()
  })
})

describe('la memoisation ne doit pas figer un drapeau de module (revue m3)', () => {
  // `isRegistrySummaryOnlyActive()` is a plain module value in the bridge, not
  // a subscribed store value — it flips when the workspace changes, with no
  // prop moving with it. The lookup memo was keyed on `[diagrams,
  // deadTargetIds]` while its BODY read that flag, so after the flip it kept
  // serving the old answer: "complete", i.e. a live diagram resolved to
  // `dangling` on a workspace where the resident registry is only a WINDOW and
  // a miss proves nothing.
  //
  // The rerender below passes the SAME props on purpose. That is the whole
  // point: if the deps do not carry the flag, nothing can invalidate the memo.
  it('reevalue quand isRegistrySummaryOnlyActive change sans que les props bougent', () => {
    const links = [link({ type: 'diagram', targetId: 'absent-de-la-fenetre' })]
    const view = render(<ADRRelatedLinks links={links} editable={false} onChange={vi.fn()} />)
    expect(chip().getAttribute('data-link-state')).toBe('dangling')

    mocks.summaryOnly = true
    view.rerender(<ADRRelatedLinks links={links} editable={false} onChange={vi.fn()} />)

    expect(chip().getAttribute('data-link-state')).toBe('unknown')
  })
})
