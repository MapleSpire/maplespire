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

import type { KvStore } from '../modelQuery/kvStore'

/**
 * The per-tab journal adoption protocol, extracted from the entity-intent
 * journal (phase B) so the placement journal can share it instead of keeping
 * its single-shared-key defect. The contract it enforces:
 *
 * - Each tab only ever WRITES its own key; a registry key is the discovery
 *   index. A shared key each tab blindly rewrites/deletes lets a clean
 *   sibling erase the journal of the tab that still needs it.
 * - A foreign key is emptied only by a CONDITIONAL atomic update: inside the
 *   update transaction its current content is compared to exactly what was
 *   adopted, and a LIVE sibling that re-recorded since our read keeps its
 *   newer content untouched.
 * - Everything adopted is RE-HOMED under our own key BEFORE any foreign key
 *   is emptied, so a crash mid-adoption never leaves intents only in memory.
 * - The registry loses only ids whose keys were actually emptied (or empty
 *   at read time — a live owner re-registers itself on its next persist).
 */
export async function adoptTabJournalNamespace<T>(options: {
  store: KvStore
  registryKey: string
  keyOfTab: (tabId: string) => string
  ownTabId: string
  /** True for the CURRENT namespace (our own previous page load's key is
   * adopted through the registry like any crashed tab's); false for legacy
   * namespaces our tab id never writes to. */
  includeSelf: boolean
  hydrate: (entries: T[]) => void
  /** Persist the in-memory journal under OUR current-namespace key. */
  rehome: () => Promise<void>
  contentEquals: (current: T[] | undefined, adoptedAtRead: T[]) => boolean
}): Promise<void> {
  const { store, registryKey, keyOfTab, ownTabId, includeSelf, hydrate, rehome, contentEquals } = options
  const tabs = await store.get<string[]>(registryKey)
  const registry = Array.isArray(tabs) ? tabs : []
  const tabIds = includeSelf && !registry.includes(ownTabId)
    ? [...registry, ownTabId]
    : registry
  const adopted = new Map<string, T[]>()
  const emptyAtRead: string[] = []
  for (const tabId of tabIds) {
    const entries = await store.get<T[]>(keyOfTab(tabId))
    const foreign = !includeSelf || tabId !== ownTabId
    if (!entries?.length) {
      if (foreign) emptyAtRead.push(tabId)
      continue
    }
    hydrate(entries)
    if (foreign) adopted.set(tabId, entries)
  }
  await rehome()
  const emptied: string[] = [...emptyAtRead]
  for (const [tabId, entriesAtRead] of adopted) {
    let didEmpty = false
    await store.update<T[]>(keyOfTab(tabId), (current) => {
      if (contentEquals(current, entriesAtRead)) {
        didEmpty = true
        return []
      }
      return current ?? []
    })
    if (didEmpty) emptied.push(tabId)
  }
  await store.update<string[]>(registryKey, (tabIdsNow) =>
    (tabIdsNow ?? []).filter((tabId) => !emptied.includes(tabId)))
}

/**
 * Adopt a legacy SINGLE-KEY (pre-tab-scoping) journal: hydrate it, re-home it
 * under the caller's current-namespace key, then empty the legacy key only if
 * it still holds exactly what was read (an old-build sibling tab may have
 * re-written it since).
 */
export async function adoptSingleKeyLegacyJournal<T>(options: {
  store: KvStore
  legacyKey: string
  hydrate: (entries: T[]) => void
  rehome: () => Promise<void>
  contentEquals: (current: T[] | undefined, adoptedAtRead: T[]) => boolean
}): Promise<void> {
  const { store, legacyKey, hydrate, rehome, contentEquals } = options
  const entries = await store.get<T[]>(legacyKey)
  if (!entries?.length) return
  hydrate(entries)
  await rehome()
  await store.update<T[]>(legacyKey, (current) =>
    contentEquals(current, entries) ? [] : (current ?? []))
}
