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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// THE WIRES of the account-switch fix (2026-10-11): per-user storage is pinned
// in src/lib/auth; these arms pin that the auth store selects it on every
// session it resolves and leaves it on sign-out.

const calls: string[] = []
const api = {
  logout: vi.fn(async () => { calls.push('api.logout') }),
  getConfig: vi.fn(async () => ({ stage: 'on', devLogin: false, passwordLogin: true })),
  meWithReason: vi.fn(async (): Promise<unknown> => ({
    kind: 'signed-in',
    result: { user: { id: 'user-b', email: 'b@x.test', isPlatformAdmin: false }, claims: { orgId: 'org-b' } },
  })),
}
vi.mock('../lib/auth/api', () => api)
vi.mock('../lib/i18n', () => ({ applyServerLocale: () => {} }))
const namespace = {
  enterAccountNamespace: vi.fn((): 'current' | 'reload' => 'current'),
  leaveAccountNamespace: vi.fn(() => { calls.push('leaveAccountNamespace') }),
}
vi.mock('../lib/auth/accountNamespace', () => namespace)

const reload = vi.fn()
const replace = vi.fn((path: string) => { calls.push(`replace ${path}`) })

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('window', { location: { reload, replace } })
  api.logout.mockClear()
  api.getConfig.mockClear()
  namespace.enterAccountNamespace.mockReset().mockReturnValue('current')
  namespace.leaveAccountNamespace.mockClear()
  reload.mockClear()
  replace.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('authStore.logout', () => {
  it('ends the server session, then leaves the account\'s storage, then hard-loads /login', async () => {
    const { useAuthStore } = await import('./authStore')
    await useAuthStore.getState().logout()
    expect(calls).toEqual(['api.logout', 'leaveAccountNamespace', 'replace /login'])
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('a refused server logout changes nothing locally and rejects for the badge', async () => {
    const { useAuthStore } = await import('./authStore')
    useAuthStore.setState({ user: { id: 'user-a', email: 'a@x.test', isPlatformAdmin: false } })
    api.logout.mockRejectedValueOnce(new Error('offline'))
    await expect(useAuthStore.getState().logout()).rejects.toThrow('offline')
    expect(namespace.leaveAccountNamespace).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.id).toBe('user-a')
  })
})

describe('authStore.load — the account\'s storage', () => {
  it('a page opened on someone else\'s storage reloads, and load() NEVER resolves (no caller acts on the dying page)', async () => {
    // Regression (review): AuthCompletePage consumed the stashed post-login
    // destination in load()'s `.then` on the page that was about to reload,
    // so an OIDC sign-in landed on /app instead of the invite.
    const { useAuthStore } = await import('./authStore')
    namespace.enterAccountNamespace.mockReturnValueOnce('reload')
    let settled = false
    void useAuthStore.getState().load().then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(namespace.enterAccountNamespace).toHaveBeenCalledWith('user-b')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    // `loading` stays true, so the bridge never boots on the wrong storage.
    expect(useAuthStore.getState().loading).toBe(true)
  })

  it('the user\'s own storage (control) boots normally', async () => {
    const { useAuthStore } = await import('./authStore')
    await useAuthStore.getState().load()
    expect(reload).not.toHaveBeenCalled()
    expect(useAuthStore.getState()).toMatchObject({ loading: false, user: { id: 'user-b' } })
  })

  it('a switch that cannot happen fails CLOSED: signed out, never booted on another user\'s storage', async () => {
    const { useAuthStore } = await import('./authStore')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    namespace.enterAccountNamespace.mockImplementationOnce(() => { throw new Error('quota') })
    await useAuthStore.getState().load()
    expect(useAuthStore.getState()).toMatchObject({ loading: false, user: null })
    expect(reload).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('a cookie the server refuses as stale boots signed out AND remembers why (the login page says so)', async () => {
    const { useAuthStore } = await import('./authStore')
    useAuthStore.setState({ sessionEnded: null })
    api.meWithReason.mockResolvedValueOnce({ kind: 'signed-out', reason: 'permissions-changed' })
    await useAuthStore.getState().load()
    expect(useAuthStore.getState()).toMatchObject({ loading: false, user: null, sessionEnded: 'permissions-changed' })
  })

  it('a plain signed-out boot carries no "session ended" reason', async () => {
    const { useAuthStore } = await import('./authStore')
    useAuthStore.setState({ sessionEnded: null })
    api.meWithReason.mockResolvedValueOnce({ kind: 'signed-out', reason: 'signed-out' })
    await useAuthStore.getState().load()
    expect(useAuthStore.getState()).toMatchObject({ loading: false, user: null, sessionEnded: null })
  })

  it('AUTH=off never selects a namespace: the install opens what it always opened', async () => {
    const { useAuthStore } = await import('./authStore')
    api.getConfig.mockResolvedValueOnce({ stage: 'off', devLogin: false, passwordLogin: false })
    await useAuthStore.getState().load()
    expect(namespace.enterAccountNamespace).not.toHaveBeenCalled()
  })
})
