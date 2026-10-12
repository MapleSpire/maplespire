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

/**
 * The LATENCY MASK, and the ways it could become a lie.
 *
 * The source of truth is server-side: a diagram written to the registry write
 * head gets a `ro_diagrams` row. This mask only covers the gap between the click and
 * that row arriving, for what THIS page instance just wrote.
 *
 * Three bounds make it a mask and not a second truth, and each is a test here:
 *
 *  1. It goes through `mergeUniquePageItems`, so the server row REPLACES the
 *     stub in place when it lands. The mutant is `[...current, item]`, which
 *     renders the diagram twice once the server row arrives.
 *  2. It is bounded by the bridge's session-local id set, so a diagram the
 *     bridge has dropped (deleted in session) leaves the mask at once.
 *  3. It is subject to the SAME `tombstonedIds` filter as every other card.
 *
 * And one bound is deliberately NOT tested here because it is structural: the
 * mask lives in this component's `useState`, so it does not survive an unmount.
 * That is what stops it from ever hiding a regression of the server side — the
 * next visit to the page shows the truth. The e2e's cold-profile oracle is the
 * assertion for that half.
 */

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Diagram } from '../../types'
import type { DiagramListItem } from '../../lib/modelQuery/diagrams'

const mocks = vi.hoisted(() => ({
  fetchDiagramListPage: vi.fn(),
  loadDiagramDuplicateSource: vi.fn(),
  isRegistrySummaryOnlyActive: vi.fn(),
  isServerReadModelEnabled: vi.fn(),
  sessionLocalDiagramIds: vi.fn(),
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.name ? `${key}:${String(vars.name)}` : key,
  }),
}))
vi.mock('../../lib/modelQuery/diagrams', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/modelQuery/diagrams')>(),
  fetchDiagramListPage: mocks.fetchDiagramListPage,
}))
vi.mock('../../lib/diagrams/duplicateSource', () => ({
  loadDiagramDuplicateSource: mocks.loadDiagramDuplicateSource,
}))
vi.mock('../../lib/automerge/bridge', () => ({
  isRegistrySummaryOnlyActive: mocks.isRegistrySummaryOnlyActive,
  sessionLocalDiagramIds: mocks.sessionLocalDiagramIds,
}))
vi.mock('../../lib/modelQuery/tierFlag', () => ({
  isServerReadModelEnabled: mocks.isServerReadModelEnabled,
}))
vi.mock('../layout/WorkspaceShell', () => ({
  WorkspaceShell: ({ children, pill }: { children: React.ReactNode; pill?: React.ReactNode }) => (
    <div>{pill}{children}</div>
  ),
  // The search box is REAL here (the rest of the pill is chrome): changing a
  // filter is how the page refetches, and that refetch is what delivers the
  // server row the mask has to step aside for.
  WorkspacePill: ({ searchValue, onSearchChange, searchTestId }: {
    searchValue: string
    onSearchChange: (value: string) => void
    searchTestId?: string
  }) => (
    <input
      data-testid={searchTestId}
      value={searchValue}
      onChange={(event) => onSearchChange(event.target.value)}
    />
  ),
  PillFilterPopover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ShellRightPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ShellFieldRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('../modals/ImportModal', () => ({ ImportModal: () => null }))
// VirtualGrid measures with ResizeObserver and jsdom reports every box at 0, so
// the real one renders NO cards and every assertion below would be vacuous.
vi.mock('../common/VirtualGrid', () => ({
  VirtualGrid: <T,>({ items, renderItem }: { items: T[]; renderItem: (item: T) => React.ReactNode }) => (
    <div>{items.map((item) => renderItem(item))}</div>
  ),
}))

const { DiagramsListView } = await import('./DiagramsListView')
const { useModelStore } = await import('../../stores/modelStore')

const SOURCE: Diagram = {
  id: 'dg-source',
  name: 'Contexte',
  type: 'context',
  objectIds: ['o1'],
  connectionIds: [],
  groupIds: [],
  layouts: { o1: { position: { x: 0, y: 0 }, size: { width: 10, height: 10 } } },
}

const listItem = (id: string, name: string): DiagramListItem => ({
  id,
  name,
  type: 'context',
  objectCount: 1,
  connectionCount: 0,
  groupCount: 0,
  // Required arrays the card maps over. Omit them and the render THROWS, the
  // tree unmounts, and every query returns [] — a crash that reads exactly like
  // "the mask never rendered".
  previewObjectIds: [],
  previewObjectTypes: [],
})

const serverPage = (items: DiagramListItem[]) => ({
  items, total: items.length, limit: 60, nextCursor: null, nextOffset: null,
})

const cardsFor = (id: string) => screen.queryAllByTestId(`diagram-card-${id}`)

/** The id `duplicateDiagram` minted, read from the store the action wrote to.
 * The store is FIXTURE here, never the oracle — every assertion below is on
 * what the page renders. */
function duplicatedId(): string {
  const created = useModelStore.getState().diagrams.find((d) => d.id !== SOURCE.id)
  if (!created) throw new Error('the duplicate action created no diagram — the gesture missed')
  return created.id
}

async function duplicateFromTheMenu(): Promise<string> {
  // The first server page has to have landed, or the menu this clicks does not
  // exist yet and the "gesture" is a lookup failure dressed as a defect.
  await waitFor(() => expect(cardsFor(SOURCE.id)).toHaveLength(1))
  fireEvent.click(screen.getByTestId(`diagram-menu-${SOURCE.id}`))
  fireEvent.click(screen.getByTestId('diagram-duplicate'))
  await waitFor(() => expect(useModelStore.getState().diagrams.length).toBe(2))
  const id = duplicatedId()
  await waitFor(() => expect(cardsFor(id)).toHaveLength(1))
  return id
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isRegistrySummaryOnlyActive.mockReturnValue(true)
  mocks.isServerReadModelEnabled.mockReturnValue(true)
  // A FAITHFUL fake of the bridge's session set: derived at CALL TIME from the
  // store, exactly as the real one is derived from what this session created.
  // A `mockReturnValue` snapshot would be read once by the memo and never
  // updated, so the mask would look broken for a reason that exists only in
  // the test — and the removal half could not be exercised at all.
  mocks.sessionLocalDiagramIds.mockImplementation(() => new Set(
    useModelStore.getState().diagrams.filter((d) => d.id !== SOURCE.id).map((d) => d.id),
  ))
  mocks.loadDiagramDuplicateSource.mockResolvedValue({ diagram: SOURCE, flows: [] })
  mocks.fetchDiagramListPage.mockResolvedValue(serverPage([listItem(SOURCE.id, 'Contexte')]))
  useModelStore.setState({
    diagrams: [SOURCE],
    objects: [], connections: [], groups: [], domains: [], flows: [], comments: [],
    deletedDiagramIds: [],
    currentDiagramId: SOURCE.id,
    workspaceReadOnly: false,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('#41 — the latency mask on a summary workspace', () => {
  it('T6 — la carte apparaît UNE fois, pas deux, quand la ligne serveur arrive', async () => {
    // THE mutant: `setServerDiagrams((current) => [...current, item])`. Once
    // the server row arrives, that shape renders the same diagram twice, for
    // ever.
    render(<DiagramsListView />)
    await waitFor(() => expect(cardsFor(SOURCE.id)).toHaveLength(1))

    const id = await duplicateFromTheMenu()

    // The projection lands: a new server page arrives CARRYING the same id.
    mocks.fetchDiagramListPage.mockResolvedValue(serverPage([
      listItem(SOURCE.id, 'Contexte'),
      listItem(id, 'Contexte (copie)'),
    ]))
    // Refetch the way the page really does: change a filter.
    fireEvent.change(screen.getByTestId('diagrams-search'), { target: { value: 'Contexte' } })

    await waitFor(() => expect(mocks.fetchDiagramListPage).toHaveBeenCalledTimes(2))
    // EXACTLY one. Not "at least one" — the whole defect this kills is a second
    // copy, and `toBeTruthy()` on a query would pass on two.
    await waitFor(() => expect(cardsFor(id)).toHaveLength(1))
    expect(cardsFor(SOURCE.id)).toHaveLength(1)
  })

  it('T7 — une carte créée en session disparaît quand le diagramme est supprimé (pierre tombale)', async () => {
    // The mask must obey the ONE filter that may remove a card. Exempting it —
    // the natural mistake when a second display source is added — would make a
    // just-created diagram undeletable on screen.
    render(<DiagramsListView />)
    const id = await duplicateFromTheMenu()

    useModelStore.setState({ deletedDiagramIds: [id] })

    await waitFor(() => expect(cardsFor(id)).toHaveLength(0))
  })

  it('T7b — et elle se retire dès que le pont ne la tient plus pour locale à la session', async () => {
    // The bound that is NOT covered by the resident window, and the reason the
    // mask is keyed on the bridge's set rather than on component state alone.
    //
    // The case is the remote deletion: another client deletes a diagram THIS
    // session created, and the absence sweep retires the id from
    // `summaryLocalDiagramIds` (bridge.ts) — while the resident window can still
    // carry the entry. `pendingLocalIds` is component state and never shrinks,
    // so without this bound the mask would keep re-injecting a diagram that no
    // longer exists anywhere, for as long as the page stays mounted.
    render(<DiagramsListView />)
    const id = await duplicateFromTheMenu()

    // The diagram STAYS in the resident window on purpose: if it left, the card
    // would go for a reason that has nothing to do with the bound under test,
    // and the assertion below would be vacuous.
    mocks.sessionLocalDiagramIds.mockReturnValue(new Set<string>())
    // Something unrelated re-renders the page, as any store change would.
    useModelStore.setState({ domains: [{ id: 'dom-1', name: 'Domaine' }] })

    await waitFor(() => expect(cardsFor(id)).toHaveLength(0))
    // …and the window really did keep it, so the card went for the right reason.
    expect(useModelStore.getState().diagrams.some((d) => d.id === id)).toBe(true)
  })

  it('ne masque rien sur un espace non-summary', async () => {
    // The mask exists for ONE contract. On a classic workspace the resident
    // registry is the whole 30 000-entry list and the page is not server-paged;
    // leaking a second display source into that mode would scan exactly what
    // paging exists to avoid.
    mocks.isRegistrySummaryOnlyActive.mockReturnValue(false)
    mocks.isServerReadModelEnabled.mockReturnValue(false)
    render(<DiagramsListView />)

    await waitFor(() => expect(cardsFor(SOURCE.id)).toHaveLength(1))
    expect(mocks.fetchDiagramListPage).not.toHaveBeenCalled()
    expect(mocks.sessionLocalDiagramIds).not.toHaveBeenCalled()
  })
})
