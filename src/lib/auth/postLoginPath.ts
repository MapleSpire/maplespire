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

/**
 * Shared sessionStorage key used to stash "where to go after sign-in" across the
 * redirect round-trip (InvitePage → LoginPage → OIDC provider → AuthCompletePage, or
 * InvitePage → LoginPage → dev-login). Read-once: `takePostLoginPath` removes it so a
 * later unrelated sign-in doesn't replay a stale destination.
 */
export const POST_LOGIN_PATH_KEY = 'maplespire:postLoginPath'

export function stashPostLoginPath(path: string): void {
  try {
    sessionStorage.setItem(POST_LOGIN_PATH_KEY, path)
  } catch {
    // sessionStorage unavailable (e.g. private mode edge cases) — fall back to '/app'.
  }
}

/** Read WITHOUT consuming — for callers that only need to know where the login
 * will land (e.g. the invite-intent flag on the login URL) while leaving the
 * stash intact for the actual post-login redirect. */
export function peekPostLoginPath(): string | null {
  try {
    return sessionStorage.getItem(POST_LOGIN_PATH_KEY)
  } catch {
    return null
  }
}

export function takePostLoginPath(): string | null {
  try {
    const path = sessionStorage.getItem(POST_LOGIN_PATH_KEY)
    if (path) sessionStorage.removeItem(POST_LOGIN_PATH_KEY)
    return path
  } catch {
    return null
  }
}
