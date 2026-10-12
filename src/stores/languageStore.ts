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

import { create } from 'zustand'
import i18n, { normalizeLanguage, type AppLanguage } from '../lib/i18n'
import { useAuthStore } from './authStore'
import * as authApi from '../lib/auth/api'

/**
 * Thin reactive wrapper over i18next's active language.
 *
 * `setLanguage` is the single entry point the UI uses:
 *  - flips i18next (which re-renders every `useTranslation` consumer and, via the
 *    detector's localStorage cache, remembers the choice on this browser), and
 *  - when a session is present (AUTH stage `dual`/`on` with a signed-in user),
 *    persists it to `users.locale` so it follows the user across devices. The
 *    server write is best-effort — offline or a hiccup still keeps the local
 *    choice, so language never depends on the server being up.
 */
interface LanguageState {
  language: AppLanguage
  setLanguage: (lng: AppLanguage) => void
}

export const useLanguageStore = create<LanguageState>((set, get) => {
  i18n.on('languageChanged', (lng) => {
    const next = normalizeLanguage(lng)
    if (get().language !== next) set({ language: next })
  })

  return {
    language: normalizeLanguage(i18n.language),

    setLanguage: (lng) => {
      if (get().language === lng) return
      void i18n.changeLanguage(lng)

      const { user, config } = useAuthStore.getState()
      if (user && config && config.stage !== 'off') {
        authApi
          .updateProfile({ locale: lng })
          .then((u) => useAuthStore.getState().setUser(u))
          .catch(() => {
            /* offline / server down — the localStorage cache still holds the choice */
          })
      }
    },
  }
})
