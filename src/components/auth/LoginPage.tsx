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

import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAuthStore } from '../../stores/authStore'
import * as api from '../../lib/auth/api'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { takePostLoginPath, peekPostLoginPath } from '../../lib/auth/postLoginPath'
import { BrandMark } from '../brand/BrandMark'
import { LEGAL_VERSION, legalDocumentUrls } from '../../lib/legal'

const ERROR_KEYS: Record<string, string> = {
  unknown_provider: 'auth.login.error.unknownProvider',
  invalid_state: 'auth.login.error.invalidState',
  exchange_failed: 'auth.login.error.exchangeFailed',
  unverified_email: 'auth.login.error.unverifiedEmail',
  no_email: 'auth.login.error.noEmail',
  server_error: 'auth.login.error.serverError',
  verification_failed: 'auth.login.error.verificationFailed',
  legal_required: 'auth.login.error.legalRequired',
  legal_acceptance_required: 'auth.login.error.legalRequired',
  account_inactive: 'auth.login.error.accountInactive',
  org_suspended: 'auth.login.error.orgSuspended',
}

function errorCodeFromQuery(): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get('error')
}

/** `?session=ended`: the live-page banner's "Sign in again" (SessionEndedBanner). */
function sessionEndedFromQuery(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('session') === 'ended'
}

function verifiedFromQuery(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('verified') === '1'
}

function errorMessage(code: string | null, t: TFunction): string | null {
  if (!code) return null
  return t(ERROR_KEYS[code] ?? ERROR_KEYS.server_error)
}

export interface LoginPageProps {
  /** 'public' (default): anyone — Google + Microsoft/common. 'sso': the
   * isolated org-restricted page (server surface `?surface=sso`) — never
   * shows the public providers, never shows the dev-login shortcut (a real
   * SSO landing page doesn't offer a password-less bypass). */
  surface?: 'public' | 'sso'
}

function copyFor(surface: 'public' | 'sso', t: TFunction) {
  return surface === 'public'
    ? {
        heading: t('auth.login.publicHeading'),
        subheading: t('auth.login.publicSubheading'),
        crossLink: { to: '/login/sso' as const, label: t('auth.login.crossLinkToSso') },
      }
    : {
        heading: t('auth.login.ssoHeading'),
        subheading: t('auth.login.ssoSubheading'),
        crossLink: { to: '/login' as const, label: t('auth.login.crossLinkToPublic') },
      }
}

/** Centered warm-stone login card. Providers come from the server (hidden when
 * empty); the dev email form only renders on the public surface when the server
 * has AUTH_DEV_LOGIN=on. */
export function LoginPage({ surface = 'public' }: LoginPageProps) {
  const config = useAuthStore((s) => s.config)
  const user = useAuthStore((s) => s.user)
  const sessionEnded = useAuthStore((s) => s.sessionEnded)
  const runDevLogin = useAuthStore((s) => s.devLogin)
  const runPasswordLogin = useAuthStore((s) => s.passwordLogin)
  const { t, i18n } = useTranslation()

  const [providers, setProviders] = useState<api.AuthProvider[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [confirmationSent, setConfirmationSent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [legalAccepted, setLegalAccepted] = useState(false)
  const queryError = errorMessage(errorCodeFromQuery(), t)
  const copy = copyFor(surface, t)
  const showDevLogin = surface === 'public' && config?.devLogin
  const showPasswordLogin = surface === 'public' && config?.passwordLogin
  const legalUrls = legalDocumentUrls(i18n.resolvedLanguage ?? i18n.language)

  useEffect(() => {
    let cancelled = false
    api
      .getProviders(surface)
      .then((list) => {
        if (!cancelled) setProviders(list)
      })
      .catch(() => {
        // Providers unreachable — just show none; the dev form (if enabled) still works.
      })
    return () => {
      cancelled = true
    }
  }, [surface])

  useEffect(() => {
    if (!user) return
    const dest = takePostLoginPath() ?? '/app'
    // HARD navigation (full document load), NOT a client-side route change. The
    // Automerge sync socket is a module singleton that opens as soon as the app
    // bundle loads — i.e. while this page is still anonymous — and at AUTH=on the
    // server REJECTS that upgrade (401). A client-side nav into the editor would
    // reuse that poisoned socket, so the bridge boots to "Document … is
    // unavailable" until the user manually reloads. Reloading re-opens the socket
    // WITH the freshly-set session cookie → authenticated on the first handshake.
    // Same reason switchOrg hard-reloads (see lib/auth/api.ts): WS claims bind at
    // upgrade time, so only a document load re-authenticates the peer. `replace`
    // (not `assign`) keeps the login page out of history.
    window.location.replace(dest)
  }, [user])

  if (user) return null

  // A login that started from an invite link must NOT auto-provision a
  // personal org for a brand-new user — they're joining the inviter's org.
  // Peek (don't consume): the stash still drives the post-login redirect.
  const inviteIntent = peekPostLoginPath()?.startsWith('/invite/') ? ('invite' as const) : undefined

  const handleProviderClick = (providerId: string) => {
    if (!legalAccepted) {
      setFormError(t('auth.login.legalRequired'))
      return
    }
    window.location.assign(api.loginUrl(providerId, LEGAL_VERSION, inviteIntent))
  }

  const handleDevLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || submitting || !legalAccepted) return
    setSubmitting(true)
    setFormError(null)
    try {
      await runDevLogin(email.trim(), inviteIntent)
      // No navigate here: setting `user` triggers the redirect effect above —
      // the ONLY consumer of the post-login stash. Navigating from both spots
      // double-consumed it (the second read got null → '/app') and clobbered
      // an invite destination.
    } catch {
      setFormError(t('auth.login.devLoginError'))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasswordAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password || submitting || !legalAccepted) return
    setSubmitting(true)
    setFormError(null)
    try {
      if (authMode === 'register') {
        await api.registerWithPassword(email.trim(), password, LEGAL_VERSION)
        setConfirmationSent(true)
      } else {
        await runPasswordLogin(email.trim(), password, LEGAL_VERSION, inviteIntent)
      }
    } catch (err) {
      if (err instanceof api.AuthApiError && err.code === 'email_not_verified') {
        setFormError(t('auth.login.emailNotVerified'))
      } else {
        setFormError(t(authMode === 'register' ? 'auth.login.registrationError' : 'auth.login.passwordLoginError'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleResend = async () => {
    if (!email.trim() || submitting) return
    setSubmitting(true)
    setFormError(null)
    try {
      await api.resendVerification(email.trim())
      setConfirmationSent(true)
    } catch {
      setFormError(t('auth.login.registrationError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen w-full items-start justify-center overflow-y-auto bg-app px-4 py-6">
      <div data-testid="login-card" className="my-auto w-full max-w-[380px] rounded-xl border border-line bg-surface-100 p-6 shadow-xl sm:p-8">
        <div data-testid="login-brand-lockup" className="mb-7 flex items-center justify-center">
          <BrandMark size={40} className="h-10 w-auto" />
          <span className="text-[20px] font-semibold tracking-[-0.025em] text-fg">MapleSpire</span>
        </div>

        <h1 className="mb-1 text-center text-[17px] font-semibold text-fg">{copy.heading}</h1>
        <p className="mb-6 text-center text-[13px] text-fg-secondary">{copy.subheading}</p>

        {queryError && (
          <div
            data-testid="login-error"
            className="mb-4 rounded-lg border border-line bg-error-bg px-3 py-2 text-[12.5px] text-error-text"
          >
            {queryError}
          </div>
        )}
        {(sessionEnded || sessionEndedFromQuery()) && (
          <div data-testid="session-ended-notice" className="mb-4 rounded-lg border border-line bg-surface-200 px-3 py-2 text-[12.5px] text-fg">
            {t('auth.sessionEnded.loginNotice')}
          </div>
        )}
        {verifiedFromQuery() && (
          <div className="mb-4 rounded-lg border border-line bg-surface-200 px-3 py-2 text-[12.5px] text-fg">
            {t('auth.login.emailVerified')}
          </div>
        )}
        {confirmationSent && (
          <div data-testid="confirmation-sent" className="mb-4 rounded-lg border border-line bg-surface-200 px-3 py-2 text-[12.5px] text-fg">
            {t('auth.login.confirmationSent')}
          </div>
        )}
        {formError && (
          <div className="mb-4 rounded-lg border border-line bg-error-bg px-3 py-2 text-[12.5px] text-error-text">
            {formError}
          </div>
        )}

        <div className="mb-5 rounded-lg border border-line bg-surface-200/60 p-3 text-[11.5px] leading-relaxed text-fg-secondary">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              data-testid="legal-acceptance"
              type="checkbox"
              checked={legalAccepted}
              onChange={(event) => {
                setLegalAccepted(event.target.checked)
                if (event.target.checked && formError === t('auth.login.legalRequired')) setFormError(null)
              }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            <span>
              {t('auth.login.legalPrefix')}{' '}
              <a className="font-medium text-fg underline decoration-line underline-offset-2" href={legalUrls.terms} target="_blank" rel="noreferrer">
                {t('auth.login.terms')}
              </a>{' '}
              {t('auth.login.legalJoin')}{' '}
              <a className="font-medium text-fg underline decoration-line underline-offset-2" href={legalUrls.privacy} target="_blank" rel="noreferrer">
                {t('auth.login.privacy')}
              </a>.
            </span>
          </label>
        </div>

        {providers.length > 0 && (
          <div className="mb-2 flex flex-col gap-2">
            {providers.map((p) => (
              <Button
                key={p.id}
                type="button"
                variant="secondary"
                size="lg"
                className="w-full justify-center"
                onClick={() => handleProviderClick(p.id)}
                disabled={!legalAccepted || submitting}
              >
                {t('auth.login.continueWith', { provider: p.label })}
              </Button>
            ))}
          </div>
        )}

        {providers.length > 0 && (showDevLogin || showPasswordLogin) && (
          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[11px] uppercase tracking-wide text-fg-subtle">{t('auth.login.or')}</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        )}

        {showPasswordLogin && (
          <form onSubmit={handlePasswordAuth} className="flex flex-col gap-3">
            <label htmlFor="password-login-email" className="text-[12px] font-medium text-fg-secondary">
              {t('auth.login.emailLabel')}
            </label>
            <Input
              id="password-login-email"
              data-testid="password-login-email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label htmlFor="password-login-password" className="text-[12px] font-medium text-fg-secondary">
              {t('auth.login.passwordLabel')}
            </label>
            <Input
              id="password-login-password"
              data-testid="password-login-password"
              type="password"
              autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
              minLength={12}
              maxLength={128}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {authMode === 'register' && <p className="text-[11.5px] text-fg-subtle">{t('auth.login.passwordHint')}</p>}
            <Button type="submit" data-testid="password-login-submit" variant="primary" size="lg" disabled={submitting || !legalAccepted} className="w-full justify-center">
              {submitting ? t('auth.login.working') : t(authMode === 'register' ? 'auth.login.createAccount' : 'auth.login.signIn')}
            </Button>
            <button
              type="button"
              className="text-[12.5px] text-fg-secondary underline decoration-line underline-offset-2 hover:text-fg"
              onClick={() => { setAuthMode(authMode === 'login' ? 'register' : 'login'); setFormError(null); setConfirmationSent(false) }}
            >
              {t(authMode === 'login' ? 'auth.login.switchToRegister' : 'auth.login.switchToLogin')}
            </button>
            {formError === t('auth.login.emailNotVerified') && (
              <button type="button" className="text-[12.5px] text-fg-secondary underline" onClick={handleResend}>
                {t('auth.login.resendConfirmation')}
              </button>
            )}
          </form>
        )}

        {showPasswordLogin && showDevLogin && <div className="my-5 h-px bg-line" />}

        {showDevLogin && (
          <form onSubmit={handleDevLogin} className="flex flex-col gap-2">
            <label htmlFor="dev-login-email" className="text-[12px] font-medium text-fg-secondary">
              {t('auth.login.devSignInLabel')}
            </label>
            <Input
              id="dev-login-email"
              data-testid="dev-login-email"
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              type="submit"
              data-testid="dev-login-submit"
              variant="primary"
              size="lg"
              disabled={submitting || !legalAccepted}
              className="w-full justify-center"
            >
              {submitting ? t('auth.login.signingIn') : t('auth.login.continue')}
            </Button>
          </form>
        )}

        {providers.length === 0 && !showDevLogin && !showPasswordLogin && (
          <p className="text-center text-[12.5px] text-fg-subtle">
            {t('auth.login.noMethods')}
          </p>
        )}

        <div className="mt-6 text-center">
          <Link
            to={copy.crossLink.to}
            className="text-[12.5px] text-fg-secondary underline decoration-line underline-offset-2 hover:text-fg"
          >
            {copy.crossLink.label}
          </Link>
        </div>
      </div>
    </div>
  )
}

/** The isolated org-SSO login page (`/login/sso`) — same card, `surface="sso"`. */
export function SsoLoginPage() {
  return <LoginPage surface="sso" />
}
