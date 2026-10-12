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
import {
  ACCOUNT_NAMESPACE_KEY,
  __resetAccountNamespaceForTest,
  accountDatabaseName,
  accountStorageKey,
  accountWorkerName,
  currentAccountNamespace,
  enterAccountNamespace,
  installAccountNamespaceListener,
  leaveAccountNamespace,
} from './accountNamespace'

// Regression, 2026-10-11 (app.maplespire.ca, reproduced locally): a new
// account in the same browser was shown the previous account's objects from
// the shared local storage. Each user now has their own.

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial))
  return {
    get length() { return m.size },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
}

let storage: Storage
beforeEach(() => {
  __resetAccountNamespaceForTest()
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
})
afterEach(() => {
  vi.unstubAllGlobals()
  __resetAccountNamespaceForTest()
})

describe('names', () => {
  it('no namespace (signed out, never signed in, AUTH=off): the legacy name, unchanged', () => {
    expect(accountDatabaseName('maplespire-automerge')).toBe('maplespire-automerge')
    expect(accountStorageKey('maplespire:workspaceRef:org-a')).toBe('maplespire:workspaceRef:org-a')
    expect(accountWorkerName()).toBeUndefined()
  })

  it('a signed-in user\'s page: databases AND workspace pointers carry the user', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-A_1')
    expect(accountDatabaseName('maplespire-automerge')).toBe('maplespire-automerge@user-A_1')
    expect(accountStorageKey('maplespire:workspaceRef:org-a')).toBe('maplespire:workspaceRef:org-a@user-A_1')
    expect(accountWorkerName()).toBe('maplespire-account:user-A_1')
  })

  it('is FROZEN for the page: a later change never splits one page across two users', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-a')
    expect(accountDatabaseName('db')).toBe('db@user-a')
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-b')
    expect(accountDatabaseName('db')).toBe('db@user-a')
  })

  it('a stored value that is not an id we issue is ignored', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, '../../evil name')
    expect(accountDatabaseName('db')).toBe('db')
  })

  it('a Worker (no localStorage) reads the namespace from its name', () => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('name', 'maplespire-account:user-w')
    expect(currentAccountNamespace()).toBe('user-w')
    expect(accountDatabaseName('maplespire-model-read-cache')).toBe('maplespire-model-read-cache@user-w')
  })
})

describe('entering and leaving', () => {
  it('a page opened on nobody\'s storage asks to reload into the user\'s', () => {
    expect(enterAccountNamespace('user-b', storage)).toBe('reload')
    expect(storage.getItem(ACCOUNT_NAMESPACE_KEY)).toBe('user-b')
  })

  it('a page opened on ANOTHER user\'s storage asks to reload into this user\'s', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-a')
    currentAccountNamespace() // the page opened user-a's
    expect(enterAccountNamespace('user-b', storage)).toBe('reload')
    expect(storage.getItem(ACCOUNT_NAMESPACE_KEY)).toBe('user-b')
  })

  it('the reloaded page is already this user\'s: no second reload (no loop)', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-b')
    expect(enterAccountNamespace('user-b', storage)).toBe('current')
  })

  it('switching deletes nothing: the previous account\'s pointers stay theirs', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-a')
    currentAccountNamespace()
    storage.setItem('maplespire:workspaceRef:org-a@user-a', '{"landscapeId":"a","versionId":"current"}')
    enterAccountNamespace('user-b', storage)
    expect(storage.getItem('maplespire:workspaceRef:org-a@user-a')).not.toBeNull()
  })

  it('a switch that cannot be recorded, on ANOTHER user\'s storage, throws (the caller must not boot)', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-a')
    currentAccountNamespace()
    const refusing = { ...storage, setItem: () => { throw new DOMException('quota', 'QuotaExceededError') } } as Storage
    expect(() => enterAccountNamespace('user-b', refusing)).toThrow()
    expect(() => enterAccountNamespace('a/b', storage)).toThrow()
  })

  it('…but on a page with no namespace it is harmless: legacy storage is what that page always used', () => {
    const refusing = { ...storage, setItem: () => { throw new DOMException('quota', 'QuotaExceededError') } } as Storage
    expect(enterAccountNamespace('user-b', refusing)).toBe('current')
  })

  it('signing out leaves the namespace', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-a')
    leaveAccountNamespace(storage)
    expect(storage.getItem(ACCOUNT_NAMESPACE_KEY)).toBeNull()
  })
})

describe('other tabs follow', () => {
  function fakeWindow() {
    const listeners = new Set<(e: StorageEvent) => void>()
    return {
      addEventListener: (_: string, fn: (e: StorageEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: StorageEvent) => void) => listeners.delete(fn),
      fire: (key: string | null, newValue: string | null) =>
        listeners.forEach((fn) => fn({ key, newValue } as StorageEvent)),
    }
  }

  it('a sign-out, a sign-in as someone else, or a cleared storage in another tab reloads this one; anything else does not', () => {
    storage.setItem(ACCOUNT_NAMESPACE_KEY, 'user-a')
    currentAccountNamespace()
    const win = fakeWindow()
    vi.stubGlobal('window', win)
    const reload = vi.fn()
    const uninstall = installAccountNamespaceListener(reload)

    win.fire('maplespire:theme', 'dark')
    win.fire(ACCOUNT_NAMESPACE_KEY, 'user-a') // same account (org switch)
    expect(reload).not.toHaveBeenCalled()

    win.fire(ACCOUNT_NAMESPACE_KEY, null) // signed out elsewhere
    win.fire(ACCOUNT_NAMESPACE_KEY, 'user-b') // signed in as someone else
    win.fire(null, null) // storage cleared
    expect(reload).toHaveBeenCalledTimes(3)

    uninstall()
    win.fire(ACCOUNT_NAMESPACE_KEY, null)
    expect(reload).toHaveBeenCalledTimes(3)
  })
})
