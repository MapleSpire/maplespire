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
import { AdminTeams } from './AdminTeams'

const mocks = vi.hoisted(() => ({
  getTeams: vi.fn(),
  getTeam: vi.fn(),
  getMembers: vi.fn(),
  createTeam: vi.fn(),
  updateTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({ useParams: () => ({ orgId: 'org-1' }) }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('../../lib/orgAdmin/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/orgAdmin/api')>(),
  ...mocks,
}))

function members(first: number, count: number) {
  return Array.from({ length: count }, (_, offset) => {
    const index = first + offset
    return { userId: `user-${String(index).padStart(5, '0')}`, email: `user-${index}@example.test`, name: `User ${index}` }
  })
}

describe('AdminTeams dense membership paging', () => {
  beforeEach(() => {
    mocks.getTeams.mockReset().mockResolvedValue({
      teams: [{ id: 'team-dense', name: 'Enterprise guild', archivedAt: null, memberCount: 10_000 }],
      nextCursor: null,
    })
    mocks.getTeam.mockReset()
      .mockResolvedValueOnce({
        team: { id: 'team-dense', name: 'Enterprise guild', archivedAt: null },
        members: members(0, 100),
        nextCursor: 'user-00099',
      })
      .mockResolvedValueOnce({
        team: { id: 'team-dense', name: 'Enterprise guild', archivedAt: null },
        // A concurrent add can make an already-rendered member appear in a
        // later keyset page. The drawer must not duplicate that row.
        members: [...members(99, 1), ...members(100, 1)],
        nextCursor: null,
      })
    mocks.getMembers.mockReset().mockResolvedValue({
      members: [{
        userId: 'candidate-1', email: 'candidate@example.test', name: 'Candidate',
        role: 'member', status: 'active', teams: [],
      }],
      nextCursor: null,
    })
    mocks.createTeam.mockReset()
    mocks.updateTeam.mockReset()
    mocks.addTeamMember.mockReset().mockResolvedValue(undefined)
    mocks.removeTeamMember.mockReset().mockResolvedValue(undefined)
  })

  afterEach(cleanup)

  it('keeps a 10k-member team as paged 100-row windows and pages candidates on the server', async () => {
    render(<AdminTeams />)
    fireEvent.click(await screen.findByRole('button', { name: 'Enterprise guild' }))

    await waitFor(() => expect(mocks.getTeam).toHaveBeenCalledWith(
      'org-1', 'team-dense', { limit: 100 },
    ))
    expect(await screen.findAllByTestId('team-member-row')).toHaveLength(100)
    await waitFor(() => expect(mocks.getMembers).toHaveBeenCalledWith('org-1', {
      q: undefined,
      excludeTeamId: 'team-dense',
      limit: 50,
    }))

    fireEvent.click(screen.getByTestId('team-members-load-more'))
    await waitFor(() => expect(screen.getAllByTestId('team-member-row')).toHaveLength(101))
    expect(mocks.getTeam).toHaveBeenLastCalledWith(
      'org-1', 'team-dense', { after: 'user-00099', limit: 100 },
    )
  })
})
