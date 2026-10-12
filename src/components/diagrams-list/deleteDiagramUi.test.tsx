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
import type { Diagram } from '../../types'

/**
 * Deleting a diagram on a SERVER-PAGED list — the card may vanish ONLY behind a
 * durable fact.
 *
 * The card menu is gated on `canManage`, so the only mode that reaches Delete
 * on a paged list is `registrySummaryOnly`. There, `deleteDiagram` posts an
 * intent the bridge turns into a `ModelMeta.deletedDiagramIds` tombstone — a
 * durable local write that converges offline — and publishes the set into the
 * store. The rule this file pins:
 *
 *     the card disappears IF AND ONLY IF a tombstone carries its id.
 *
 * Both directions are asserted, because both are live failure modes: hiding
 * without a tombstone (an optimistic splice of `serverDiagrams`) reports a
 * success that has not happened and the next refetch brings the card back;
 * NOT hiding with one leaves the user staring at a diagram they deleted
 * (offline, for as long as they stay offline).
 *
 * The fixture is the REALISTIC window: a summary-only workspace holds only the
 * diagrams opened or created this session in `state.diagrams`, never the whole
 * server page. Seeding the full set would let the file pass while asserting
 * nothing.
 */

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  loadDiagramDuplicateSource: vi.fn(),
  // A vi.fn, not a literal: `serverPaged` is derived from this, and the
  // tombstone filter has to hold on BOTH sides of that derivation. Pinned to
  // the paged mode only would leave the resident list — every ordinary
  // editable workspace — untested, with the whole file green.
  isRegistrySummaryOnlyActive: vi.fn(() => true),
}))

vi.mock('../../lib/modelQuery/diagrams', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/modelQuery/diagrams')>(),
  fetchDiagramListPage: mocks.fetchDiagramListPage,
}))
vi.mock('../../lib/diagrams/duplicateSource', () => ({
  loadDiagramDuplicateSource: mocks.loadDiagramDuplicateSource,
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.name ? `${key}:${String(vars.name)}` : key,
  }),
}))
vi.mock('../layout/WorkspaceShell', () => ({
  // Renders the footer rather than dropping it: the count is half of what a
  // paged mutation would have to keep in step, so stubbing it away would make
  // any assertion about it vacuous. Same for the RIGHT panel — it is fed from
  // `selected`, a second consumer of the filtered list that a shell stub used
  // to hide entirely.
  WorkspaceShell: ({ children, footer, right, pill }: {
    children: React.ReactNode
    footer?: Array<{ label: string; value: number | string }>
    right?: React.ReactNode
    pill?: React.ReactNode
  }) => (
    <div>
      {pill}
      {children}
      {/* PRESENCE only, not the panel's own text: the panel repeats the
          diagram name, and rendering it would make every `findByText` in this
          file ambiguous. Presence is exactly the property under test — the
          panel exists iff `selected` is non-null. */}
      <div data-testid="ws-right">{right ? 'panel' : ''}</div>
      <div data-testid="ws-footer">{(footer ?? []).map((f) => `${f.label}=${f.value}`).join(' ')}</div>
    </div>
  ),
  // A REAL search box, not a null stub: the offline window takes filtering back
  // from the server, and a stub made that claim untestable (its mutant passed).
  WorkspacePill: ({ searchValue, onSearchChange, searchTestId }: {
    searchValue: string
    onSearchChange: (value: string) => void
    searchTestId?: string
  }) => (
    <input
      data-testid={searchTestId ?? 'ws-search'}
      value={searchValue}
      onChange={(event) => onSearchChange(event.target.value)}
    />
  ),
  PillFilterPopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ShellRightPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ShellFieldRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../modals/ImportModal', () => ({ ImportModal: () => null }))
// Not leniency: the real VirtualGrid measures with ResizeObserver, which jsdom
// does not provide, so it paints zero cards and nothing is clickable.
vi.mock('../common/VirtualGrid', () => ({
  VirtualGrid: <T,>({ items, renderItem }: { items: T[]; renderItem: (item: T) => React.ReactNode }) => (
    <div>{items.map((item) => renderItem(item))}</div>
  ),
}))
// THE paged configuration: a summary-only registry with the server read model on.
vi.mock('../../lib/automerge/bridge', () => ({
  isRegistrySummaryOnlyActive: mocks.isRegistrySummaryOnlyActive,
}))
vi.mock('../../lib/modelQuery/tierFlag', () => ({ isServerReadModelEnabled: () => true }))

const { DiagramsListView } = await import('./DiagramsListView')
const { useModelStore } = await import('../../stores/modelStore')
const { diagramListItemFromDiagram } = await import('../../lib/modelQuery/diagrams')

const diagram = (id: string, name: string): Diagram => ({
  id, name, type: 'container', objectIds: [], connectionIds: [], groupIds: [], layouts: {},
})
const opened = diagram('dg-open', 'Opened this session')
const serverOwned = diagram('dg-server', 'Owned by the server')

const openMenu = (name: string) =>
  fireEvent.click(screen.getByLabelText(`dataViewsB.diagrams.card.menu.label:${name}`))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isRegistrySummaryOnlyActive.mockReturnValue(true)
  mocks.fetchDiagramListPage.mockResolvedValue({
    total: 2, limit: 60, nextCursor: null, nextOffset: null,
    items: [opened, serverOwned].map(diagramListItemFromDiagram),
  })
  useModelStore.setState({
    // The window: only what this session touched. `dg-server` is on the page but
    // NOT in the store, which is the normal state of a summary-only workspace.
    diagrams: [opened],
    objects: [], connections: [], groups: [], domains: [], flows: [],
    currentDiagramId: 'dg-open',
    workspaceReadOnly: false,
    selectedItems: [],
    pendingDeletedDiagramIds: [],
    deletedDiagramIds: [],
  })
})
afterEach(cleanup)

describe('deleting a diagram on a server-paged list', () => {
  it('records the delete INTENT even for a diagram outside the window', async () => {
    // Pinned where a user can see it: filtering `state.diagrams` alone is not
    // enough — off-window that array is rebuilt identical and NOTHING
    // downstream — registry plan, meta loop, crash journal — could observe that anything happened. The intent is the only
    // trace an off-window deletion has.
    render(<DiagramsListView />)
    await screen.findByText('Owned by the server')

    openMenu('Owned by the server')
    fireEvent.click(screen.getByTestId('diagram-delete'))

    await waitFor(() =>
      expect(useModelStore.getState().pendingDeletedDiagramIds).toEqual(['dg-server']))
    // …and the window is untouched, which is why the intent had to exist.
    expect(useModelStore.getState().diagrams.map((d) => d.id)).toEqual(['dg-open'])
  })

  it('keeps the card while no tombstone carries its id', async () => {
    // Direction 1 — no tombstone, no hiding. The bridge has not posted
    // a tombstone here (no bridge in this suite), so nothing durable says the
    // diagram is gone and the card must stay. A handler that splices
    // `serverDiagrams` itself passes the OTHER test and fails this one.
    render(<DiagramsListView />)
    await screen.findByText('Owned by the server')

    openMenu('Owned by the server')
    fireEvent.click(screen.getByTestId('diagram-delete'))

    await waitFor(() =>
      expect(useModelStore.getState().pendingDeletedDiagramIds).toEqual(['dg-server']))
    expect(screen.getByText('Owned by the server')).toBeTruthy()
    expect(screen.getByTestId('ws-footer').textContent).toBe('dataViewsB.diagrams.footer.diagrams=2')
  })

  it('retire la carte ET décrémente le total dès qu\'un tombstone porte son id', async () => {
    // Direction 2. The tombstone is what the bridge publishes once
    // `ModelMeta.deletedDiagramIds` carries the id — a durable local write that
    // converges offline. Mutant: filter the page but leave `serverTotal` alone,
    // and the grid shows one card under a footer that says two, for as long as
    // the asynchronous projector takes (for ever, offline).
    render(<DiagramsListView />)
    await screen.findByText('Owned by the server')

    useModelStore.setState({ deletedDiagramIds: ['dg-server'] })

    await waitFor(() => expect(screen.queryByText('Owned by the server')).toBeNull())
    expect(screen.getByText('Opened this session')).toBeTruthy()
    expect(screen.getByTestId('ws-footer').textContent).toBe('dataViewsB.diagrams.footer.diagrams=1')
  })

  it('applique le filtre à CHAQUE page reçue, pas seulement au premier rendu', async () => {
    // The in-flight-refetch resurrection: a page fetched before the tombstone
    // landed arrives after it, carrying the row again. The filter runs on the
    // rendered list rather than on a one-shot splice, so the row cannot come
    // back. (Renames and duplicates keep the pre-existing defect — separate.)
    useModelStore.setState({ deletedDiagramIds: ['dg-server'] })
    render(<DiagramsListView />)

    await screen.findByText('Opened this session')
    await waitFor(() => expect(mocks.fetchDiagramListPage).toHaveBeenCalled())

    expect(screen.queryByText('Owned by the server')).toBeNull()
  })

  it('le panneau de détails lâche aussi le diagramme tombstoné', async () => {
    // The grid is not the only consumer of the filtered list: `selected` feeds
    // the right-hand panel, and it is the one place the deleted diagram is
    // rendered LARGE, with its counts and an "open in editor" button. Sourcing
    // it from `rawDiagrams` leaves the user staring at a detail sheet — and a
    // working Open button — for a diagram whose card just vanished. The shell
    // stub must render the panel, or this branch is invisible to the suite.
    useModelStore.setState({ currentDiagramId: 'dg-server' })
    render(<DiagramsListView />)
    await screen.findByText('Owned by the server')
    // Anti-void guard: the panel really is rendered for this id to begin with.
    await waitFor(() => expect(screen.getByTestId('ws-right').textContent).toBe('panel'))

    useModelStore.setState({ deletedDiagramIds: ['dg-server'] })

    await waitFor(() => expect(screen.queryByText('Owned by the server')).toBeNull())
    expect(screen.getByTestId('ws-right').textContent).toBe('')
  })

  it('la liste RÉSIDENTE filtre le tombstone elle aussi, et son total suit', async () => {
    // The other side of the `serverPaged` fork — every ordinary editable
    // workspace. `rawDiagrams` is the resident array there, so a filter written
    // only against `serverDiagrams` would leave the card on screen after a
    // deletion that is already durable: the same defect as the paged one, in
    // the mode most users are actually in.
    mocks.isRegistrySummaryOnlyActive.mockReturnValue(false)
    useModelStore.setState({
      diagrams: [opened, serverOwned],
      currentDiagramId: null,
    })
    render(<DiagramsListView />)
    await screen.findByText('Owned by the server')
    // Anti-void guard: this really is the resident path — no page was fetched.
    expect(mocks.fetchDiagramListPage).not.toHaveBeenCalled()
    expect(screen.getByTestId('ws-footer').textContent).toBe('dataViewsB.diagrams.footer.diagrams=2')

    useModelStore.setState({ deletedDiagramIds: ['dg-server'] })

    await waitFor(() => expect(screen.queryByText('Owned by the server')).toBeNull())
    expect(screen.getByTestId('ws-footer').textContent).toBe('dataViewsB.diagrams.footer.diagrams=1')
  })

  it('hors-ligne le total compte les cartes rendues, jamais le total serveur moins les cachées', async () => {
    // `hiddenServerRows` corrects a SERVER total. On the offline window there is
    // no server total — the first page never arrived, so `serverTotal` is 0 —
    // and subtracting from it prints "0 diagrams" under a grid that is showing
    // one. Dropping `!localWindowFallback` from the footer branch is a one-token
    // mutant that no existing test could see: the offline suite asserts on the
    // partial-mode banner and the placeholders, never on the count.
    mocks.fetchDiagramListPage.mockRejectedValue(new Error('offline'))
    render(<DiagramsListView />)

    await screen.findByTestId('diagram-list-partial-offline')
    expect(screen.getByText('Opened this session')).toBeTruthy()
    expect(screen.getByTestId('ws-footer').textContent).toBe('dataViewsB.diagrams.footer.diagrams=1')
  })

  it('hors-ligne la fenêtre LOCALE gagne sur la ligne serveur périmée du même id', async () => {
    // The merge ORDER, which the code claims in a comment ("an id present in
    // both keeps the local (newer) copy") and nothing proved: swapping the two
    // arguments of `mergeUniquePageItems` passed the whole suite. What it costs
    // is a rename that reappears under its old name the moment the network
    // drops — the local edit is durable, the server row is a stale cache, and
    // the stale one would win exactly when the user cannot refresh it.
    mocks.fetchDiagramListPage.mockReset()
    mocks.fetchDiagramListPage.mockResolvedValueOnce({
      total: 2, limit: 60, nextCursor: null, nextOffset: null,
      items: [{ ...opened, name: 'Stale server name' }, serverOwned].map(diagramListItemFromDiagram),
    })
    mocks.fetchDiagramListPage.mockRejectedValue(new Error('offline'))
    useModelStore.setState({ diagrams: [{ ...opened, name: 'Renamed locally' }] })

    render(<DiagramsListView />)
    // Anti-void guard: the server really did answer first, with the stale row.
    await screen.findByText('Stale server name')

    // The network drops on the next query; 'a' matches both names, so the local
    // filter cannot be what removes the stale one.
    fireEvent.change(screen.getByTestId('diagrams-search'), { target: { value: 'a' } })

    await waitFor(() => expect(screen.getByTestId('diagram-list-partial-offline')).toBeTruthy())
    expect(screen.getByText('Renamed locally')).toBeTruthy()
    expect(screen.queryByText('Stale server name')).toBeNull()
  })

  it('hors-ligne la recherche filtre de nouveau côté client', async () => {
    // `filterLocally = !serverPaged || localWindowFallback`. Drop the second
    // term and the search box silently stops narrowing the instant the server
    // goes — the list is served locally but filtered by nobody. A stub pill
    // meant no test could ever type, so the mutant had nowhere to fail.
    mocks.fetchDiagramListPage.mockRejectedValue(new Error('offline'))
    useModelStore.setState({ diagrams: [opened, serverOwned] })

    render(<DiagramsListView />)
    await screen.findByTestId('diagram-list-partial-offline')
    expect(screen.getByText('Opened this session')).toBeTruthy()
    expect(screen.getByText('Owned by the server')).toBeTruthy()

    fireEvent.change(screen.getByTestId('diagrams-search'), { target: { value: 'Owned' } })

    await waitFor(() => expect(screen.queryByText('Opened this session')).toBeNull())
    expect(screen.getByText('Owned by the server')).toBeTruthy()
  })

  it('still removes an in-window diagram from the model', async () => {
    // A diagram this client opened or created IS in `state.diagrams`, so the
    // window mutation is real. NOTE what this does and does not prove: it
    // asserts the STORE only. Durability for a session-CREATED id comes from
    // `writeSummaryLocalRegistry` (which removes its write-head entry) and for
    // an id merely OPENED from the tombstone — neither is witnessed here.
    // The durability assertions live in
    // `src/lib/automerge/bridgeSummaryDelete.test.ts`, against real handles.
    render(<DiagramsListView />)
    await screen.findByText('Opened this session')

    openMenu('Opened this session')
    fireEvent.click(screen.getByTestId('diagram-delete'))

    await waitFor(() => expect(useModelStore.getState().diagrams).toEqual([]))
    expect(useModelStore.getState().pendingDeletedDiagramIds).toEqual(['dg-open'])
  })
})
