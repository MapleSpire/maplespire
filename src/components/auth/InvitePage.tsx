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
import { useNavigate, useParams } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import * as api from '../../lib/auth/api'
import { Button } from '../ui/button'
import { stashPostLoginPath } from '../../lib/auth/postLoginPath'
import { BrandMark } from '../brand/BrandMark'

/** Org invite landing page: `GET /api/auth/invite/:token`. Signed-out visitors are
 * routed to /login (stashing this path so they land back here after sign-in);
 * signed-in visitors get an Accept button. */
export function InvitePage() {
  const { token } = useParams({ from: '/invite/$token' })
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const authLoading = useAuthStore((s) => s.loading)
  const { t } = useTranslation()

  const [invite, setInvite] = useState<api.InviteInfo | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [mismatchEmail, setMismatchEmail] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getInvite(token)
      .then((info) => {
        if (!cancelled) setInvite(info)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const handleSignIn = () => {
    stashPostLoginPath(`/invite/${token}`)
    navigate({ to: '/login' })
  }

  /** email_mismatch recovery: sign the wrong account out and return to login
   * with this invite stashed, so the user can come back with the right one.
   * HARD navigation on purpose — the wrong account's SPA state (model store,
   * current diagram, auth store) must not survive into the next session; a
   * soft navigate lets stale store state hijack the route. sessionStorage
   * (the stash) survives a same-tab hard load. */
  const handleSignInDifferently = async () => {
    stashPostLoginPath(`/invite/${token}`)
    try {
      await api.logout()
    } catch {
      // Best-effort — the login page works either way.
    }
    window.location.assign('/login')
  }

  const handleAccept = async () => {
    if (accepting) return
    setAccepting(true)
    setAcceptError(null)
    setMismatchEmail(null)
    try {
      await api.acceptInvite(token)
      // HARD navigation on purpose: accepting re-pinned the session cookie to
      // the joined org, and the Automerge WS claims are bound at upgrade time —
      // a full load re-authenticates the socket and boots the org's workspace.
      window.location.assign('/app')
    } catch (err) {
      if (err instanceof api.EmailMismatchError) {
        setMismatchEmail(err.invitedEmail)
        return
      }
      if ((err as Error).message.includes('unauthenticated')) {
        handleSignIn()
        return
      }
      setAcceptError(t('auth.invite.acceptError'))
    } finally {
      setAccepting(false)
    }
  }

  return (
    <div className="flex h-full min-h-screen w-full items-center justify-center bg-app px-4">
      <div className="w-full max-w-[400px] rounded-xl border border-line bg-surface-100 p-8 shadow-xl">
        <div className="mb-6 flex items-center justify-center">
          <BrandMark size={36} className="h-9 w-auto" />
          <span className="text-[18px] font-semibold tracking-[-0.02em] text-fg">MapleSpire</span>
        </div>

        {!invite && !loadError && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-5 w-5 animate-spin text-fg-secondary" />
            <p className="text-[13px] text-fg-secondary">{t('auth.invite.loading')}</p>
          </div>
        )}

        {loadError && (
          <div data-testid="invite-error" className="text-center">
            <p className="mb-1 text-[15px] font-semibold text-fg">{t('auth.invite.notFoundTitle')}</p>
            <p className="text-[13px] text-fg-secondary">
              {t('auth.invite.notFoundBody')}
            </p>
          </div>
        )}

        {invite && invite.expired && (
          <div data-testid="invite-expired" className="text-center">
            <p className="mb-1 text-[15px] font-semibold text-fg">{t('auth.invite.expiredTitle')}</p>
            <p className="text-[13px] text-fg-secondary">
              {t('auth.invite.expiredBody', { inviter: invite.inviterEmail, org: invite.orgName })}
            </p>
          </div>
        )}

        {invite && invite.accepted && (
          <div data-testid="invite-accepted" className="text-center">
            <p className="mb-1 text-[15px] font-semibold text-fg">{t('auth.invite.acceptedTitle')}</p>
            <p className="mb-4 text-[13px] text-fg-secondary">
              {t('auth.invite.acceptedBody', { org: invite.orgName })}
            </p>
            <Button variant="secondary" size="lg" className="w-full justify-center" onClick={() => navigate({ to: '/app' })}>
              {t('auth.invite.goToApp')}
            </Button>
          </div>
        )}

        {invite && !invite.expired && !invite.accepted && (
          <div className="text-center">
            <p className="mb-1 text-[15px] font-semibold text-fg">
              {t('auth.invite.joinTitle', { org: invite.orgName })}
            </p>
            <p className="mb-6 text-[13px] text-fg-secondary">
              {t('auth.invite.invitedAs', { inviter: invite.inviterEmail })}{' '}
              <span className="font-medium text-fg">{invite.role}</span>.
            </p>

            {acceptError && (
              <div className="mb-4 rounded-lg border border-line bg-error-bg px-3 py-2 text-left text-[12.5px] text-error-text">
                {acceptError}
              </div>
            )}

            {mismatchEmail && (
              <div
                data-testid="invite-email-mismatch"
                className="mb-4 rounded-lg border border-line bg-error-bg px-3 py-2 text-left text-[12.5px] text-error-text"
              >
                {t('auth.invite.mismatchSentTo')} <span className="font-medium">{mismatchEmail}</span>
                {user ? (
                  <>
                    {' '}
                    {t('auth.invite.mismatchSignedInAs')} <span className="font-medium">{user.email}</span>.
                  </>
                ) : (
                  '.'
                )}
                <button
                  type="button"
                  data-testid="invite-sign-in-differently"
                  onClick={() => void handleSignInDifferently()}
                  className="mt-1.5 block underline decoration-error-text/40 underline-offset-2 hover:decoration-error-text"
                >
                  {t('auth.invite.signInDifferently')}
                </button>
              </div>
            )}

            {authLoading ? (
              <div className="flex justify-center py-2">
                <Loader2 className="h-5 w-5 animate-spin text-fg-secondary" />
              </div>
            ) : user ? (
              <Button
                data-testid="invite-accept"
                variant="primary"
                size="lg"
                disabled={accepting}
                className="w-full justify-center"
                onClick={handleAccept}
              >
                {accepting ? t('auth.invite.joining') : t('auth.invite.acceptInvite')}
              </Button>
            ) : (
              <Button
                data-testid="invite-sign-in"
                variant="primary"
                size="lg"
                className="w-full justify-center"
                onClick={handleSignIn}
              >
                {t('auth.invite.signInToAccept')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
