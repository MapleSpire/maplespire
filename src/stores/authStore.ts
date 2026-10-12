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
import * as api from '../lib/auth/api'
import { applyServerLocale } from '../lib/i18n'

/**
 * Auth state (client phase). `config` is fetched once on boot (via the root route's
 * AuthBoot) and gates everything else: with `stage: 'off'` (default — no new server
 * env set) the app renders byte-identically to pre-auth, no redirects, AccountBadge
 * renders nothing. See docs/auth-setup.md for the stage semantics.
 */
/** Present on `claims.imp` while the current session is an active impersonation
 * (`GET /api/auth/me`'s `claims.imp?: {by}`). `by` is the impersonating admin's
 * identifier — the banner shows the TARGET's email (the signed-in `user.email`)
 * plus this to make "who is doing the impersonating" inspectable if needed. */
export interface ImpersonationClaim {
  by: string
}

interface AuthStoreState {
  config: api.AuthConfig | null
  user: api.AuthUser | null
  /** The org the current session is PINNED to (from the JWT claims via
   * GET /api/auth/me) — null while signed out or for an org-less session. */
  orgId: string | null
  loading: boolean
  /** Non-null while the current session is an impersonation (see ImpersonationClaim). */
  impersonation: ImpersonationClaim | null
  /** Fetch config, then (if not 'off') try to resolve the current session. Never
   * throws — an old/offline server or a 401 both resolve to a signed-out state. */
  load: () => Promise<void>
  devLogin: (email: string, intent?: 'invite') => Promise<void>
  passwordLogin: (email: string, password: string, legalVersion: string, intent?: 'invite') => Promise<void>
  logout: () => Promise<void>
  /** Patch the in-memory user after a successful profile edit (PATCH /api/me). */
  setUser: (user: api.AuthUser) => void
}

function extractImpersonation(claims: api.SessionClaimsInfo | undefined): ImpersonationClaim | null {
  const by = claims?.imp?.by
  return by === undefined ? null : { by }
}

export const useAuthStore = create<AuthStoreState>((set) => ({
  config: null,
  user: null,
  orgId: null,
  loading: true,
  impersonation: null,

  load: async () => {
    set({ loading: true })
    let config: api.AuthConfig
    try {
      config = await api.getConfig()
    } catch {
      // Old/offline server (no /api/auth/config route, or unreachable) — behave as
      // if auth doesn't exist. Never blocks or breaks the rest of the app.
      set({ config: { stage: 'off', devLogin: false, passwordLogin: false }, user: null, orgId: null, loading: false, impersonation: null })
      return
    }
    if (config.stage === 'off') {
      set({ config, user: null, orgId: null, loading: false, impersonation: null })
      return
    }
    try {
      const result = await api.me()
      // Cross-device language: a signed-in user's server-stored locale overrides
      // browser detection once the session resolves (no-op when unset).
      applyServerLocale(result?.user?.locale)
      set({
        config,
        user: result?.user ?? null,
        orgId: result?.claims.orgId ?? null,
        loading: false,
        impersonation: extractImpersonation(result?.claims),
      })
    } catch {
      // Network hiccup resolving the session — treat as signed-out, not fatal.
      set({ config, user: null, orgId: null, loading: false, impersonation: null })
    }
  },

  devLogin: async (email, intent) => {
    const { user, orgId } = await api.devLogin(email, intent)
    set({ user, orgId })
  },

  passwordLogin: async (email, password, legalVersion, intent) => {
    const { user, orgId } = await api.passwordLogin(email, password, legalVersion, intent)
    set({ user, orgId })
  },

  logout: async () => {
    await api.logout()
    set({ user: null, orgId: null, impersonation: null })
  },

  setUser: (user) => set({ user }),
}))
