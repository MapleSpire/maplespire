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

import { useState } from 'react'
import { Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import { exitImpersonation } from '../../lib/platform/api'

/**
 * Global impersonation safety banner — the safety centerpiece of platform
 * impersonation. Mounted at the ROOT route next to
 * `AuthBoot` so it renders above every surface — editor, admin consoles,
 * everything — whenever the current session is a platform-admin "view as"
 * session (`authStore.impersonation`, sourced from `GET /api/auth/me`'s
 * `claims.imp`).
 *
 * Fixed to the very top, above the app's own chrome (which itself uses lower
 * z-indices), with a matching `padding-top` spacer pushed into the DOM flow so
 * nothing sits underneath it unreachable.
 */
export function ImpersonationBanner() {
  const { t } = useTranslation()
  const impersonation = useAuthStore((s) => s.impersonation)
  const user = useAuthStore((s) => s.user)
  const [exiting, setExiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!impersonation) return null

  const handleExit = async () => {
    setExiting(true)
    setError(null)
    try {
      await exitImpersonation()
      // Full reload — the whole app reboots back under the admin's own session,
      // mirroring how impersonation itself is entered (full nav to /app).
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('platform.impersonationBanner.exitFailed'))
      setExiting(false)
    }
  }

  return (
    <>
      <div
        data-testid="impersonation-banner"
        className="fixed inset-x-0 top-0 z-[9999] flex h-9 items-center justify-center gap-3 bg-warning-bg px-4 text-warning-text shadow-md"
      >
        <Eye className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate text-[12.5px] font-medium">
          {t('platform.impersonationBanner.viewingAs', { email: user?.email ?? t('platform.impersonationBanner.thisUser') })}
        </span>
        {error && <span className="truncate text-[11.5px] text-error-text">{error}</span>}
        <button
          data-testid="impersonation-exit"
          onClick={handleExit}
          disabled={exiting}
          className="rounded-md border border-warning-text/30 bg-warning-text/10 px-2.5 py-1 text-[11.5px] font-semibold text-warning-text transition-colors hover:bg-warning-text/20 disabled:opacity-50"
        >
          {exiting ? t('platform.impersonationBanner.exiting') : t('platform.impersonationBanner.exit')}
        </button>
      </div>
      {/* Spacer so the fixed banner never overlaps app content underneath it. */}
      <div aria-hidden className="h-9 shrink-0" />
    </>
  )
}
