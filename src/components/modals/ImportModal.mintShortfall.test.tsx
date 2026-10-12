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
import type { ImportResult, ImportSource } from '../../lib/import/types'

/**
 * The VISIBILITY half of the bulk-id pre-provision.
 *
 * `ensureMintedIdCapacity` is best-effort by contract: a short answer still
 * imports, and that is correct — refusing to import offline would be a worse
 * failure than the one it prevents. But a short answer must not be SILENT: the
 * function returns a number and never throws, so a `try/catch` alone cannot
 * surface it — the return value has to be checked and the shortfall shown.
 */

const mocks = vi.hoisted(() => ({
  ensureMintedIdCapacity: vi.fn<(count: number) => Promise<number>>(),
  importModel: vi.fn(),
  setCurrentDiagram: vi.fn(),
  clearSelection: vi.fn(),
  setCurrentView: vi.fn(),
  loadWorkspaces: vi.fn(async () => undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}))

vi.mock('../../lib/automerge/mintedIdSupply', () => ({
  ensureMintedIdCapacity: mocks.ensureMintedIdCapacity,
}))

/** TWO diagrams, because the number under test is `diagrams.length + 1` (the
 *  registry shard). No `as` anywhere: a cast here would hide exactly the fields
 *  the modal reads (e.g. `stats.byLevel`, which the preview dereferences). */
const RESULT: ImportResult = {
  objects: [],
  connections: [],
  groups: [],
  tags: [],
  diagrams: [
    { id: 'd1', name: 'One', type: 'context', objectIds: [], connectionIds: [], groupIds: [] },
    { id: 'd2', name: 'Two', type: 'container', objectIds: [], connectionIds: [], groupIds: [] },
  ],
  entryDiagramId: null,
  warnings: [],
  stats: {
    objects: 3,
    connections: 0,
    groups: 0,
    diagrams: 2,
    byLevel: { context: 1, container: 1, component: 0 },
  },
}

/** A source with NO target picker — the default path. `run` never touches the
 *  real parser. */
const source: ImportSource = {
  id: 'structurizr',
  label: 'Structurizr',
  description: 'test source',
  status: 'available',
  run: async () => RESULT,
}

vi.mock('../../lib/import', () => ({
  importSources: [source],
  getImportSource: (id: string) => (id === 'structurizr' ? source : undefined),
}))

vi.mock('../../stores/modelStore', () => ({
  useModelStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ importModel: mocks.importModel }),
    { getState: () => ({ importModel: mocks.importModel, objects: [], connections: [], groups: [], tags: [], diagrams: [] }) },
  ),
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({
      setCurrentDiagram: mocks.setCurrentDiagram,
      clearSelection: mocks.clearSelection,
      setCurrentView: mocks.setCurrentView,
    }),
    { getState: () => ({
      setCurrentDiagram: mocks.setCurrentDiagram,
      clearSelection: mocks.clearSelection,
      setCurrentView: mocks.setCurrentView,
    }) },
  ),
}))

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ landscapes: [], readOnly: false }),
    { getState: () => ({ load: mocks.loadWorkspaces, landscapes: [], error: null }) },
  ),
}))

vi.mock('../../stores/draftsStore', () => ({
  useDraftsStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ drafts: [] }),
    { getState: () => ({ create: vi.fn(), error: null }) },
  ),
}))

const { ImportModal } = await import('./ImportModal')

async function importTwoDiagrams(onClose: () => void): Promise<void> {
  render(<ImportModal open onClose={onClose} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'workspace {}' } })
  fireEvent.click(screen.getByText(/parseAndPreview/))
  await waitFor(() => { expect(screen.getByTestId('import-generate')).toBeTruthy() })
  fireEvent.click(screen.getByTestId('import-generate'))
}

describe('ImportModal — a short minted-id pre-provision is stated, not swallowed', () => {
  beforeEach(() => {
    mocks.ensureMintedIdCapacity.mockReset()
    mocks.importModel.mockReset()
  })
  afterEach(cleanup)

  it('names the shortfall and HOLDS the modal open', async () => {
    // 2 diagrams + 1 registry shard = 3 asked for; 1 granted.
    mocks.ensureMintedIdCapacity.mockResolvedValue(1)
    const onClose = vi.fn()
    await importTwoDiagrams(onClose)

    const warning = await screen.findByTestId('import-mint-shortfall')
    // The COUNT, not just "something went wrong": the warning names how many
    // documents may need a reconnection.
    expect(warning.textContent).toContain('modalsCore.import.mintShortfall:{"count":2}')
    // The import still happened — best-effort is the contract…
    expect(mocks.importModel).toHaveBeenCalledTimes(1)
    // …and the modal stays up, because it is the only surface this app has to
    // say so. There is no toast component in src/.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says nothing and closes when the whole burst was covered', async () => {
    mocks.ensureMintedIdCapacity.mockResolvedValue(3)
    const onClose = vi.fn()
    await importTwoDiagrams(onClose)

    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1) })
    expect(screen.queryByTestId('import-mint-shortfall')).toBeNull()
    expect(mocks.importModel).toHaveBeenCalledTimes(1)
  })

  it('treats a THROWN pre-provision as a total shortfall rather than a silent pass', async () => {
    // The `catch` that could never fire for a short answer can still fire for a
    // synchronous fault, and it must not report success.
    mocks.ensureMintedIdCapacity.mockRejectedValue(new Error('mint exploded'))
    const onClose = vi.fn()
    await importTwoDiagrams(onClose)

    const warning = await screen.findByTestId('import-mint-shortfall')
    expect(warning.textContent).toContain('{"count":3}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
