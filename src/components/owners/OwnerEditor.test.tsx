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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../../stores/authStore'
import { OwnerEditor, OwnerPickerModal } from './OwnerEditor'
import { getMembers, getTeam, getTeams } from '../../lib/orgAdmin/api'

vi.mock('../../lib/orgAdmin/api', () => ({
  getTeams: vi.fn(),
  getMembers: vi.fn(),
  getTeam: vi.fn(),
}))

describe('OwnerPickerModal', () => {
  const writeText = vi.fn()

  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    useAuthStore.setState({ orgId: 'org-1' })
    vi.mocked(getTeams).mockResolvedValue({
      teams: [{ id: 'team-platform', name: 'Platform', archivedAt: null, memberCount: 2 }],
      nextCursor: null,
    })
    vi.mocked(getMembers).mockResolvedValue({
      members: [{ userId: 'alice', email: 'alice@example.test', name: 'Alice Martin', role: 'member', status: 'active', teams: [] }],
      nextCursor: null,
    })
    vi.mocked(getTeam).mockResolvedValue({
      team: { id: 'team-platform', name: 'Platform', archivedAt: null },
      members: [{ userId: 'alice', email: 'alice@example.test', name: 'Alice Martin' }],
      nextCursor: null,
    })
  })

  it('exposes the complete team member name on hover', async () => {
    render(
      <OwnerEditor
        assignments={[{
          id: 'team-platform',
          kind: 'team',
          source: 'platform',
          name: 'Platform',
          members: [{ id: 'alice', name: 'Alice Martin', email: 'alice@example.test' }],
        }]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show members of Platform' }))
    const memberName = (await screen.findAllByText('Alice Martin')).find((element) => element.closest('li'))!
    const memberRow = memberName.closest('li')

    expect(memberRow?.getAttribute('title')).toBe('Alice Martin')
    fireEvent.mouseEnter(memberRow!)
    expect(screen.getByRole('tooltip').textContent).toBe('Alice Martin')
  })

  it('keeps a team member name above the email instead of competing on one row', () => {
    render(
      <OwnerEditor
        assignments={[{
          id: 'team-platform',
          kind: 'team',
          source: 'platform',
          name: 'Platform',
          members: [{ id: 'alice', name: 'Alice Martin', email: 'alice@example.test' }],
        }]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show members of Platform' }))
    const member = screen.getByTestId('owner-member-alice')
    const name = within(member).getByTestId('owner-member-name')
    const email = within(member).getByTestId('owner-member-email')

    expect(name.parentElement).toBe(email.parentElement)
    expect(name.className).toContain('block')
    expect(email.className).toContain('block')
  })

  it('expands an individual owner to show the saved contact fields', () => {
    render(
      <OwnerEditor
        assignments={[{
          id: 'contact-qa',
          kind: 'person',
          source: 'external',
          name: 'Marie Tremblay',
          email: 'marie@partner.test',
          title: 'Architecte partenaire',
          organization: 'Partner Inc.',
        }]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show details for Marie Tremblay' }))

    expect(screen.getByText('Name').nextElementSibling?.textContent).toBe('Marie Tremblay')
    expect(screen.getByText('Email').nextElementSibling?.textContent).toBe('marie@partner.test')
    expect(screen.getByText('Role / title').nextElementSibling?.textContent).toBe('Architecte partenaire')
    expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe('Partner Inc.')
  })

  it('copies an individual owner email directly from the owner row', async () => {
    render(
      <OwnerEditor
        assignments={[{
          id: 'contact-qa',
          kind: 'person',
          source: 'external',
          name: 'Marie Tremblay',
          email: 'marie@partner.test',
        }]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy marie@partner.test' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('marie@partner.test'))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('copies all team emails or one member email', async () => {
    render(
      <OwnerEditor
        assignments={[{
          id: 'team-platform',
          kind: 'team',
          source: 'platform',
          name: 'Platform',
          members: [
            { id: 'alice', name: 'Alice Martin', email: 'alice@example.test' },
            { id: 'bob', name: 'Bob Nguyen', email: 'bob@example.test' },
          ],
        }]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy 2 emails for Platform' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('alice@example.test; bob@example.test'))

    fireEvent.click(screen.getByRole('button', { name: 'Show members of Platform' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy alice@example.test' }))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('alice@example.test'))
  })

  it('loads team members when copying a legacy team without a saved member snapshot', async () => {
    render(
      <OwnerEditor
        assignments={[{
          id: 'team-platform',
          kind: 'team',
          source: 'platform',
          name: 'Platform',
        }]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy team emails for Platform' }))

    await waitFor(() => expect(getTeam).toHaveBeenCalledWith('org-1', 'team-platform', { limit: 100 }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('alice@example.test'))
  })

  it('shows a team member list and snapshots it when assigning the team', async () => {
    const onSelect = vi.fn()
    render(<OwnerPickerModal isOpen assignedOwnerIds={[]} onClose={vi.fn()} onSelect={onSelect} />)

    await screen.findByText('Platform')
    fireEvent.click(screen.getByRole('button', { name: 'Show members of Platform' }))
    expect((await screen.findAllByText('Alice Martin')).some((element) => Boolean(element.closest('li')))).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { name: /Platform/ })[0])

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      id: 'team-platform',
      kind: 'team',
      name: 'Platform',
      members: [{ id: 'alice', name: 'Alice Martin', email: 'alice@example.test' }],
    })))
  })

  it('creates an external contact with company information', async () => {
    const onSelect = vi.fn()
    render(<OwnerPickerModal isOpen assignedOwnerIds={[]} onClose={vi.fn()} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'External contact' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Marie Tremblay' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'marie@partner.test' } })
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'Partner Inc.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add owner' }))

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'person',
      source: 'external',
      name: 'Marie Tremblay',
      email: 'marie@partner.test',
      organization: 'Partner Inc.',
    }))
  })
})
