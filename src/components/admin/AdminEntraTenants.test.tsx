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
import { AdminEntraTenants } from './AdminEntraTenants'
import { OrgAdminApiError, type OrgTenantPolicy } from '../../lib/orgAdmin/api'

const mocks = vi.hoisted(() => ({
  getOrgTenantPolicy: vi.fn(),
  addOrgAllowedTenant: vi.fn(),
  removeOrgAllowedTenant: vi.fn(),
  setOrgPersonalMicrosoftAccounts: vi.fn(),
}))

vi.mock('../../lib/orgAdmin/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/orgAdmin/api')>(),
  ...mocks,
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

const CORP = '11111111-2222-4333-8444-555555555555'

const policy = (over: Partial<OrgTenantPolicy> = {}): OrgTenantPolicy => ({
  tenants: [],
  microsoftPersonalAccountsAllowed: false,
  warning: 'no_tenant_restriction',
  ...over,
})
const listed = policy({
  tenants: [{ provider: 'microsoft', tenantId: CORP, addedBy: 'admin-1', addedAt: '2026-11-08T00:00:00.000Z' }],
  warning: null,
})

describe('AdminEntraTenants', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
  })
  afterEach(cleanup)

  it('warns while no tenant is listed, and the warning goes once one is added', async () => {
    mocks.getOrgTenantPolicy.mockResolvedValue(policy())
    mocks.addOrgAllowedTenant.mockResolvedValue(listed)
    render(<AdminEntraTenants orgId="org-1" />)

    expect(await screen.findByTestId('entra-tenants-warning')).toBeTruthy()
    expect(mocks.getOrgTenantPolicy).toHaveBeenCalledWith('org-1', expect.any(AbortSignal))

    const input = screen.getByRole('textbox', { name: 'admin.settings.entraTenants.inputLabel' })
    const add = screen.getByRole('button', { name: 'admin.settings.entraTenants.add' }) as HTMLButtonElement
    fireEvent.change(input, { target: { value: 'contoso.onmicrosoft.com' } })
    expect(add.disabled).toBe(true)

    fireEvent.change(input, { target: { value: `  ${CORP.toUpperCase()} ` } })
    expect(add.disabled).toBe(false)
    fireEvent.click(add)

    await waitFor(() => expect(mocks.addOrgAllowedTenant).toHaveBeenCalledWith('org-1', CORP))
    expect(await screen.findByText(CORP)).toBeTruthy()
    expect(screen.queryByTestId('entra-tenants-warning')).toBeNull()
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('removes a tenant and toggles personal Microsoft accounts', async () => {
    mocks.getOrgTenantPolicy.mockResolvedValue(listed)
    mocks.setOrgPersonalMicrosoftAccounts.mockResolvedValue({ ...listed, microsoftPersonalAccountsAllowed: true })
    mocks.removeOrgAllowedTenant.mockResolvedValue(policy({ microsoftPersonalAccountsAllowed: true }))
    render(<AdminEntraTenants orgId="org-1" />)

    const toggle = await screen.findByRole('switch', { name: 'admin.settings.entraTenants.personalTitle' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(mocks.setOrgPersonalMicrosoftAccounts).toHaveBeenCalledWith('org-1', true))
    await waitFor(() => expect(screen.getByRole('switch', {
      name: 'admin.settings.entraTenants.personalTitle',
    }).getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(screen.getByRole('button', { name: 'admin.settings.entraTenants.remove' }))
    await waitFor(() => expect(mocks.removeOrgAllowedTenant).toHaveBeenCalledWith('org-1', CORP))
    expect(await screen.findByTestId('entra-tenants-warning')).toBeTruthy()
  })

  it('explains a refused self-lockout and keeps the list unchanged', async () => {
    mocks.getOrgTenantPolicy.mockResolvedValue(policy())
    mocks.addOrgAllowedTenant.mockRejectedValue(
      new OrgAdminApiError(409, 'would_lock_out_self', 'would_lock_out_self', { error: 'would_lock_out_self' }),
    )
    render(<AdminEntraTenants orgId="org-1" />)
    const input = await screen.findByRole('textbox', { name: 'admin.settings.entraTenants.inputLabel' })
    fireEvent.change(input, { target: { value: CORP } })
    fireEvent.click(screen.getByRole('button', { name: 'admin.settings.entraTenants.add' }))

    expect((await screen.findByRole('alert')).textContent).toBe('admin.settings.entraTenants.error.lockOutSelf')
    expect(screen.getByTestId('entra-tenants-warning')).toBeTruthy()
    expect(screen.queryByText(CORP)).toBeNull()
  })
})
