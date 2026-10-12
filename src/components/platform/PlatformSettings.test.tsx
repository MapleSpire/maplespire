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
import { PlatformSettings } from './PlatformSettings'

const mocks = vi.hoisted(() => ({
  getPlatformSettings: vi.fn(),
  updatePlatformSettings: vi.fn(),
}))

vi.mock('../../lib/platform/api', () => mocks)
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

describe('PlatformSettings', () => {
  beforeEach(() => {
    mocks.getPlatformSettings.mockReset().mockResolvedValue({
      requireIndependentTechnologyReview: true,
      activePlatformAdminCount: 1,
      independentTechnologyReviewEffective: false,
    })
    mocks.updatePlatformSettings.mockReset().mockResolvedValue({
      requireIndependentTechnologyReview: false,
      activePlatformAdminCount: 1,
      independentTechnologyReviewEffective: false,
    })
  })

  afterEach(cleanup)

  it('explains the automatic sole-admin bypass while preserving the configured policy', async () => {
    render(<PlatformSettings />)

    const toggle = await screen.findByRole('switch', {
      name: 'platform.settings.independentReview.title',
    })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('platform.settings.independentReview.soleAdminTitle')).toBeTruthy()
    expect(screen.getByText('platform.settings.independentReview.soleAdminDescription')).toBeTruthy()
  })

  it('persists the policy immediately and renders the returned effective state', async () => {
    render(<PlatformSettings />)
    const toggle = await screen.findByRole('switch', {
      name: 'platform.settings.independentReview.title',
    })
    fireEvent.click(toggle)

    await waitFor(() => expect(mocks.updatePlatformSettings).toHaveBeenCalledWith({
      requireIndependentTechnologyReview: false,
    }))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('shows when independent review is effective for multiple administrators', async () => {
    mocks.getPlatformSettings.mockResolvedValueOnce({
      requireIndependentTechnologyReview: true,
      activePlatformAdminCount: 2,
      independentTechnologyReviewEffective: true,
    })
    render(<PlatformSettings />)
    expect(await screen.findByText('platform.settings.independentReview.effectiveTitle')).toBeTruthy()
    expect(screen.getByText('platform.settings.independentReview.effectiveDescription')).toBeTruthy()
  })
})
