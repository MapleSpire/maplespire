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
import { AdminSettings } from './AdminSettings'

const mocks = vi.hoisted(() => ({
  getTagSettings: vi.fn(),
  updateTagSettings: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ orgId: 'org-1' }) }))
vi.mock('../../lib/tags/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tags/api')>(),
  getTagSettings: mocks.getTagSettings,
  updateTagSettings: mocks.updateTagSettings,
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('AdminSettings Tag governance', () => {
  beforeEach(() => {
    mocks.getTagSettings.mockReset().mockResolvedValue({
      allowMemberTagCreation: true,
      allowEditorTagGroupCreation: false,
      version: 4,
      updatedAt: null,
      updatedBy: null,
    })
    mocks.updateTagSettings.mockReset().mockResolvedValue({
      allowMemberTagCreation: false,
      allowEditorTagGroupCreation: false,
      version: 5,
      updatedAt: '2026-07-18T00:00:00.000Z',
      updatedBy: 'admin-1',
    })
  })

  afterEach(cleanup)

  it('renders secure defaults and saves with optimistic concurrency', async () => {
    render(<AdminSettings />)
    const memberCreation = await screen.findByRole('switch', { name: 'admin.settings.tags.memberCreationTitle' })
    const groupCreation = screen.getByRole('switch', { name: 'admin.settings.tags.editorGroupCreationTitle' })
    expect(memberCreation.getAttribute('aria-checked')).toBe('true')
    expect(groupCreation.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(memberCreation)
    await waitFor(() => expect(mocks.updateTagSettings).toHaveBeenCalledWith('org-1', {
      allowMemberTagCreation: false,
      allowEditorTagGroupCreation: false,
    }, 4))
    await waitFor(() => expect(screen.getByRole('switch', {
      name: 'admin.settings.tags.memberCreationTitle',
    }).getAttribute('aria-checked')).toBe('false'))
  })
})
