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

import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import { takePostLoginPath } from '../../lib/auth/postLoginPath'

/** Landing spot for the OIDC redirect (APP_URL/auth/complete). The session cookie is
 * already set by the server at this point — this page just re-resolves the client's
 * auth state from it and forwards on. */
export function AuthCompletePage() {
  const navigate = useNavigate()
  const load = useAuthStore((s) => s.load)
  const ranRef = useRef(false)
  const { t } = useTranslation()

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    load()
      .then(() => {
        const dest = takePostLoginPath() ?? '/app'
        navigate({ to: dest, replace: true })
      })
      .catch(() => {
        // Plain href (not `navigate({ search })`) — /login has no validateSearch schema,
        // so this avoids fighting the router's search-param typing for one query param.
        window.location.assign('/login?error=server_error')
      })
  }, [load, navigate])

  return (
    <div className="flex h-full min-h-screen w-full flex-col items-center justify-center gap-3 bg-app">
      <Loader2 className="h-6 w-6 animate-spin text-fg-secondary" />
      <p className="text-[13px] text-fg-secondary">{t('auth.complete.finishing')}</p>
    </div>
  )
}
