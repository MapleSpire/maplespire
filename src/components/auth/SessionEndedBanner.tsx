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

import { LogIn } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import { stashPostLoginPath } from '../../lib/auth/postLoginPath'

/**
 * Says, on a live page, that the session is over (`authStore.sessionEnded`, set
 * by lib/auth/sessionWatch.ts) — instead of a sync that silently stops. Mounted
 * at the root route next to the impersonation banner, same fixed-top pattern.
 *
 * Only on a page that still holds a user: a page that boots on a dead cookie is
 * sent to /login by AuthBoot, where LoginPage shows the notice instead.
 */
export function SessionEndedBanner() {
  const { t } = useTranslation()
  const sessionEnded = useAuthStore((s) => s.sessionEnded)
  const user = useAuthStore((s) => s.user)

  if (!sessionEnded || !user) return null

  const signInAgain = () => {
    // Come back to what was on screen. A FULL load, like every sign-in: the
    // sync socket authenticates at upgrade, so only a new document re-binds it.
    stashPostLoginPath(window.location.pathname + window.location.search)
    window.location.assign('/login?session=ended')
  }

  return (
    <>
      <div
        role="alert"
        data-testid="session-ended-banner"
        className="fixed inset-x-0 top-0 z-[9999] flex h-9 items-center justify-center gap-3 bg-error-bg px-4 text-error-text shadow-md"
      >
        <span className="truncate text-[12.5px] font-medium">
          {sessionEnded === 'permissions-changed' ? t('auth.sessionEnded.permissionsChanged') : t('auth.sessionEnded.expired')}
        </span>
        <button
          data-testid="session-ended-sign-in"
          onClick={signInAgain}
          className="inline-flex items-center gap-1.5 rounded-md border border-error-text/30 bg-error-text/10 px-2.5 py-1 text-[11.5px] font-semibold text-error-text transition-colors hover:bg-error-text/20"
        >
          <LogIn className="h-3.5 w-3.5" />
          {t('auth.sessionEnded.signInAgain')}
        </button>
      </div>
      {/* Spacer so the fixed banner never overlaps app content underneath it. */}
      <div aria-hidden className="h-9 shrink-0" />
    </>
  )
}
