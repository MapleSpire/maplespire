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
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftsTable } from './DraftsTable'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
  open: vi.fn(),
  setStatus: vi.fn(),
  clearError: vi.fn(),
  navigate: vi.fn(),
  setCurrentView: vi.fn(),
  error: 'Failed to create draft',
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }))

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    ref: { landscapeId: 'land', versionId: 'live' },
    landscapes: [],
  }),
}))

vi.mock('../../stores/draftsStore', () => ({
  useDraftsStore: (selector: (state: unknown) => unknown) => selector({
    drafts: [],
    loading: false,
    busy: false,
    error: mocks.error,
    load: mocks.load,
    create: mocks.create,
    open: mocks.open,
    setStatus: mocks.setStatus,
    clearError: mocks.clearError,
  }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({ setCurrentView: mocks.setCurrentView }),
}))

vi.mock('../../stores/modelStore', () => ({
  useModelStore: (selector: (state: unknown) => unknown) => selector({ workspaceReadOnly: false }),
}))

vi.mock('../layout/WorkspaceShell', () => ({
  WorkspaceShell: ({ pill, children, right }: { pill: ReactNode; children: ReactNode; right?: ReactNode }) => (
    <main>{pill}{children}{right}</main>
  ),
  WorkspacePill: ({ add }: { add?: { label: string; onClick: () => void; testId?: string } }) => (
    add ? <button data-testid={add.testId} onClick={add.onClick}>{add.label}</button> : null
  ),
  PageColumnHeader: () => null,
  ShellRightPanel: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  ShellFieldRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ShellSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}))

describe('DraftsTable create regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.create.mockResolvedValue(null)
  })
  afterEach(cleanup)

  it('keeps the form open and exposes the real error when creation fails', async () => {
    render(<DraftsTable />)
    fireEvent.click(screen.getByTestId('new-draft-button'))
    const input = screen.getByPlaceholderText('drafts.table.draftNamePlaceholder')
    fireEvent.change(input, { target: { value: 'Enterprise change' } })
    fireEvent.click(screen.getByTestId('create-draft-confirm'))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('land', 'Enterprise change'))
    expect((screen.getByPlaceholderText('drafts.table.draftNamePlaceholder') as HTMLInputElement).value)
      .toBe('Enterprise change')
    expect(screen.getByRole('alert').textContent).toContain('Failed to create draft')
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('does not overwrite the workspace navigation performed by a successful draft switch', async () => {
    mocks.create.mockResolvedValue({ id: 'draft-v', landscapeId: 'land' })
    render(<DraftsTable />)
    fireEvent.click(screen.getByTestId('new-draft-button'))
    fireEvent.change(screen.getByPlaceholderText('drafts.table.draftNamePlaceholder'), {
      target: { value: 'Successful draft' },
    })
    fireEvent.click(screen.getByTestId('create-draft-confirm'))

    await waitFor(() => expect(mocks.setCurrentView).toHaveBeenCalledWith('diagram'))
    expect(screen.queryByPlaceholderText('drafts.table.draftNamePlaceholder')).toBeNull()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
