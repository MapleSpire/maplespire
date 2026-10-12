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
 * PER-USER LOCAL STORAGE.
 *
 * Every local cache used to be keyed by WORKSPACE, never by user. Reproduced
 * 2026-10-11 (app.maplespire.ca, then on a local AUTH=on stack): after signing
 * out and creating a new account in the same browser, the new account was
 * shown the previous account's objects, read from this browser's IndexedDB,
 * after a stale un-scoped `maplespire:workspaceRef` pointed its first query at
 * the previous account's landscape. Deleting the data on sign-out was tried
 * first and rejected in review (a delete blocked by another tab can run later
 * against the next user's edits; keeping a previous user's unsynced work mixed
 * two accounts in one store).
 *
 * So each user gets their own storage, and nothing is deleted on a switch:
 *  - IndexedDB names carry `@<userId>` (`accountDatabaseName`);
 *  - localStorage pointers that name workspaces or documents carry it too
 *    (`accountStorageKey`) — last-open landscape, cached root urls, 3D toggles;
 *  - a different user signing in reloads the page into their own storage
 *    (`authStore.load`), and other tabs follow (`installAccountNamespaceListener`).
 * A previous user's unsynced edits wait in that user's storage until they sign
 * in again.
 *
 * The namespace must be known SYNCHRONOUSLY at module load — `repo.ts` opens
 * the Automerge store at module scope, long before `/api/auth/me` answers — so
 * it is the LAST signed-in user, read from localStorage, and frozen for the
 * page: a page never touches two users' storage, and a namespace change is
 * always followed by a reload.
 *
 * No namespace (never signed in, signed out, AUTH=off) keeps the legacy
 * un-suffixed names: an AUTH=off install opens exactly what it opened before.
 * Legacy storage is never opened by a namespaced page; its rebuildable caches
 * are deleted by `public/legacy-db-cleanup.js`, and its durable stores (the
 * Automerge store, the model index's crash journals, the catalogs' outboxes)
 * are left untouched rather than deleted (owner decision, 2026-10-11).
 */

export const ACCOUNT_NAMESPACE_KEY = 'maplespire:accountNamespace'

/** A Worker has no localStorage: the page passes the namespace in the
 * Worker's `name` (`accountWorkerName`), readable there as `self.name`. */
const WORKER_NAME_PREFIX = 'maplespire-account:'

/** Database names may carry only these. Server user ids are base64url
 * (server/src/auth/users.ts), which always match. */
const SAFE_NAMESPACE = /^[A-Za-z0-9_-]{1,128}$/

let frozen: string | null | undefined

function readNamespace(): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      const value = localStorage.getItem(ACCOUNT_NAMESPACE_KEY)
      return value !== null && SAFE_NAMESPACE.test(value) ? value : null
    }
  } catch {
    return null
  }
  const workerName = (globalThis as { name?: unknown }).name
  if (typeof workerName === 'string' && workerName.startsWith(WORKER_NAME_PREFIX)) {
    const value = workerName.slice(WORKER_NAME_PREFIX.length)
    return SAFE_NAMESPACE.test(value) ? value : null
  }
  return null
}

/** The account whose storage this page uses — read once, then frozen. */
export function currentAccountNamespace(): string | null {
  if (frozen === undefined) frozen = readNamespace()
  return frozen
}

/** `base` for no namespace (legacy, AUTH=off), else `base@<userId>`. */
export function accountDatabaseName(base: string): string {
  const namespace = currentAccountNamespace()
  return namespace === null ? base : `${base}@${namespace}`
}

/** A localStorage key that names one account's workspaces or documents. */
export function accountStorageKey(key: string): string {
  return accountDatabaseName(key)
}

/** The `name` option for a Worker that opens account databases. */
export function accountWorkerName(): string | undefined {
  const namespace = currentAccountNamespace()
  return namespace === null ? undefined : `${WORKER_NAME_PREFIX}${namespace}`
}

export type AccountSwitch =
  /** This page already uses this user's storage. */
  | 'current'
  /** The page was opened on another user's (or no user's) storage; the
   * namespace is now this user's, and the caller must reload. */
  | 'reload'

/**
 * An authenticated user resolved: make the next page use their storage.
 * Compares against the FROZEN namespace — what this page actually opened —
 * not against storage, so a page opened on no namespace still reloads, and
 * the reloaded page (whose frozen value is now this user) answers 'current'.
 *
 * THROWS when the switch cannot be recorded (an id that cannot name a
 * database, storage that refuses the write) while the page sits on ANOTHER
 * user's storage: booting this user there is the original defect, so the
 * caller must not boot. On a page with no namespace a failed write is
 * harmless — legacy storage is what an un-namespaced page always used.
 */
export function enterAccountNamespace(userId: string, storage: Storage = localStorage): AccountSwitch {
  const current = currentAccountNamespace()
  if (current === userId) return 'current'
  try {
    if (!SAFE_NAMESPACE.test(userId)) throw new Error('user id cannot name local storage')
    storage.setItem(ACCOUNT_NAMESPACE_KEY, userId)
    return 'reload'
  } catch (error) {
    if (current === null) return 'current'
    throw error
  }
}

/** Sign-out: the next page (the login page) opens nobody's storage. */
export function leaveAccountNamespace(storage: Storage = localStorage): void {
  storage.removeItem(ACCOUNT_NAMESPACE_KEY)
}

/**
 * Reload this tab when ANOTHER tab changes the namespace — a sign-out, a
 * sign-in as someone else, an impersonation start or stop, the invite page's
 * "sign in with another account". The `storage` event fires only in OTHER tabs
 * of the origin, so the tab making the change keeps its own navigation. A tab
 * that stayed on a previous account would otherwise keep that account's model
 * on screen and fetch with the new session's cookie into the previous
 * account's storage. Returns the uninstaller.
 */
export function installAccountNamespaceListener(
  reload: () => void = () => window.location.reload(),
): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ACCOUNT_NAMESPACE_KEY && event.key !== null) return
    const next = event.key === null ? null : event.newValue
    if (next !== currentAccountNamespace()) reload()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

/** Test hook: forget the frozen namespace. */
export function __resetAccountNamespaceForTest(): void {
  frozen = undefined
}
