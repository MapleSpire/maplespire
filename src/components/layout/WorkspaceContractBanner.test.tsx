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
 * The epoch guard's PIXEL, not just its boolean.
 *
 * `bridgeSummaryContract.test.ts` asserts `workspaceContractStale` flips; this
 * file asserts the banner actually renders and works. Without it, a banner that
 * rendered nothing — or was never mounted — would pass every test while the
 * user saw a session freeze in silence (a state-level assertion green while the
 * screen is black).
 */

// @vitest-environment jsdom

import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useAuthStore } from '../../stores/authStore'
import { WorkspaceContractBanner } from './WorkspaceContractBanner'

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('WorkspaceContractBanner', () => {
  const authSnapshot = useAuthStore.getState()

  beforeEach(() => {
    useAutomergeStatus.setState({ workspaceContractStale: false })
    useAuthStore.setState({ ...authSnapshot, impersonation: null })
  })

  afterEach(() => {
    // No global RTL cleanup is configured in this repo's vitest setup, so
    // unmount explicitly — otherwise every later `getByTestId` in this file
    // matches two banners.
    cleanup()
    useAutomergeStatus.setState({ workspaceContractStale: false })
    useAuthStore.setState({ ...authSnapshot, impersonation: null })
    vi.unstubAllGlobals()
  })

  it('renders nothing until the contract goes stale', () => {
    const { container } = render(<WorkspaceContractBanner />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the reload strip once the bridge marks the contract stale', () => {
    // Mutant: make the component return null unconditionally (or drop it from
    // the root route) → this fails, where the store-level test still passes.
    useAutomergeStatus.setState({ workspaceContractStale: true })
    render(<WorkspaceContractBanner />)

    const banner = screen.getByTestId('workspace-contract-banner')
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('workspace.contractChanged.message')
    // It APPEARS mid-session, on a remote event, with focus elsewhere — a
    // screen reader gets no other cue that the tab stopped saving.
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.getAttribute('aria-live')).toBe('polite')
  })

  it('the Reload button actually reloads', () => {
    // The banner's only affordance. A button that renders and does nothing is
    // worse than no banner: the user believes they acted.
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    useAutomergeStatus.setState({ workspaceContractStale: true })
    render(<WorkspaceContractBanner />)

    fireEvent.click(screen.getByTestId('workspace-contract-reload'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('steps below the impersonation banner instead of hiding under it', () => {
    // Both strips are `fixed … h-9`; stacked at top-0 the lower z-index simply
    // disappears, and an admin viewing-as a user is exactly the session likeliest
    // to be looking at a promoted workspace.
    useAutomergeStatus.setState({ workspaceContractStale: true })
    render(<WorkspaceContractBanner />)
    expect(screen.getByTestId('workspace-contract-banner').className).toContain('top-0')
    cleanup()

    useAuthStore.setState({ ...authSnapshot, impersonation: { actorEmail: 'admin@example.com' } as never })
    render(<WorkspaceContractBanner />)
    const banner = screen.getByTestId('workspace-contract-banner')
    expect(banner.className).toContain('top-9')
    expect(banner.className).not.toContain('top-0')
  })
})
