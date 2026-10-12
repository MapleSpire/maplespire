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
import { useAuthStore } from '../../stores/authStore'
import { AccountBadge } from './AccountBadge'

// QA lens, 2026-10-11 (account-switch leak): a swallowed logout failure left
// every test green — the badge closed as if signed out while the server still
// held the session.

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }),
}))
vi.mock('../../lib/auth/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/auth/api')>(),
  myOrgs: vi.fn(async () => []),
}))

const logout = vi.fn<() => Promise<void>>()

beforeEach(() => {
  logout.mockReset()
  logout.mockResolvedValue(undefined)
  useAuthStore.setState({
    config: { stage: 'on', devLogin: true },
    user: { id: 'u1', email: 'previous@example.com', name: 'Previous' } as never,
    orgId: 'org-1',
    loading: false,
    impersonation: null,
    logout,
  })
})
afterEach(cleanup)

function clickSignOut() {
  render(<AccountBadge />)
  fireEvent.click(screen.getByTestId('account-badge'))
  fireEvent.click(screen.getByTestId('account-signout'))
}

describe('AccountBadge sign-out (QA)', () => {
  it('signs out directly — nothing on this device is deleted, so there is nothing to warn about', async () => {
    clickSignOut()
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
  })

  it('a failed logout is shown, not swallowed', async () => {
    logout.mockRejectedValue(new Error('HTTP 502'))
    clickSignOut()
    await screen.findByTestId('account-signout-error')
  })
})
