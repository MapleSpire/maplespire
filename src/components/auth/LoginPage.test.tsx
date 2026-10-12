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
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../../stores/authStore'
import { LoginPage } from './LoginPage'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/login/sso">{children}</a>,
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }),
}))

vi.mock('../../lib/auth/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/auth/api')>(),
  getProviders: vi.fn(async () => []),
}))

describe('LoginPage development login', () => {
  beforeEach(() => {
    useAuthStore.setState({
      config: { stage: 'on', devLogin: true },
      user: null,
      orgId: null,
      loading: false,
      impersonation: null,
    })
  })

  afterEach(cleanup)

  it('shows the email form when the server enables development login', () => {
    render(<LoginPage />)

    expect(screen.getByTestId('dev-login-email')).toBeTruthy()
    expect(screen.getByTestId('dev-login-submit')).toBeTruthy()
    expect(screen.queryByText('auth.login.noMethods')).toBeNull()
  })

  it('shows email and password fields when local authentication is enabled', () => {
    useAuthStore.setState({ config: { stage: 'on', devLogin: false, passwordLogin: true } })
    render(<LoginPage />)

    expect(screen.getByTestId('password-login-email')).toBeTruthy()
    expect(screen.getByTestId('password-login-password')).toBeTruthy()
    expect(screen.getByTestId('password-login-submit')).toBeTruthy()
    expect(screen.queryByText('auth.login.noMethods')).toBeNull()
  })

  it('gives the brand stronger hierarchy than the sign-in heading without a layout gap', () => {
    render(<LoginPage />)

    const card = screen.getByTestId('login-card')
    const lockup = screen.getByTestId('login-brand-lockup')
    const mark = lockup.querySelector('img')
    const name = screen.getByText('MapleSpire')
    const heading = screen.getByRole('heading', { level: 1 })

    expect(card.className).toContain('shadow-xl')
    expect(lockup.classList.contains('gap-1.5')).toBe(false)
    expect(mark?.getAttribute('height')).toBe('40')
    expect(name.className).toContain('text-[20px]')
    expect(heading.className).toContain('text-[17px]')
  })

  it('links both legal documents and requires explicit acceptance before authentication', () => {
    useAuthStore.setState({ config: { stage: 'on', devLogin: false, passwordLogin: true } })
    render(<LoginPage />)

    const terms = screen.getByText('auth.login.terms') as HTMLAnchorElement
    const privacy = screen.getByText('auth.login.privacy') as HTMLAnchorElement
    const submit = screen.getByTestId('password-login-submit') as HTMLButtonElement
    const acceptance = screen.getByTestId('legal-acceptance') as HTMLInputElement

    expect(terms.href).toBe('https://maplespire.ca/en/termsofservice/')
    expect(privacy.href).toBe('https://maplespire.ca/en/privacystatement/')
    expect(submit.disabled).toBe(true)
    fireEvent.click(acceptance)
    expect(submit.disabled).toBe(false)
  })
})
