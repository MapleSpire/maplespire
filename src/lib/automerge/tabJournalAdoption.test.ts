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

import { describe, expect, it } from 'vitest'
import { createMemoryKvStore } from '../modelQuery/kvStore'
import type { KvStore } from '../modelQuery/kvStore'
import { adoptSingleKeyLegacyJournal, adoptTabJournalNamespace } from './tabJournalAdoption'

interface Entry { id: string; v: number }

const eq = (a: Entry[] | undefined, b: Entry[]): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Wrap a KvStore so every operation is appended to `ops` — the ORDERING
 * probe: the end state is identical whether re-homing happens before or after
 * the foreign keys are emptied, so only the sequence can catch a swapped
 * order. */
function recordingStore(base: KvStore, ops: string[]): KvStore {
  return {
    ...base,
    set: async (key, value) => { ops.push(`set:${key}`); return base.set(key, value) },
    del: async (key) => { ops.push(`del:${key}`); return base.del(key) },
    update: async (key, fn) => { ops.push(`update:${key}`); return base.update(key, fn) },
  }
}

describe('adoptTabJournalNamespace — crash-safety ordering', () => {
  it('re-homes the adopted intents under our own key BEFORE emptying any foreign key', async () => {
    // The contract this pins: a crash BETWEEN emptying a crashed sibling's
    // key and persisting the adoption would otherwise leave the intents only
    // in memory — silent loss on the recovery path itself. Both the entity
    // and the placement journal route through this helper.
    const ops: string[] = []
    const base = createMemoryKvStore()
    const store = recordingStore(base, ops)
    const adopted: Entry[] = [{ id: 'x1', v: 1 }]
    await base.set('j:v9:tab:dead-tab', adopted)
    await base.set('j:v9:tabs', ['dead-tab'])

    const memory: Entry[] = []
    await adoptTabJournalNamespace<Entry>({
      store,
      registryKey: 'j:v9:tabs',
      keyOfTab: (tabId) => `j:v9:tab:${tabId}`,
      ownTabId: 'me',
      includeSelf: true,
      hydrate: (entries) => memory.push(...entries),
      rehome: () => store.set('j:v9:tab:me', [...memory]),
      contentEquals: eq,
    })

    const rehomeAt = ops.indexOf('set:j:v9:tab:me')
    const firstForeignEmpty = ops.indexOf('update:j:v9:tab:dead-tab')
    expect(rehomeAt, 'the adoption re-homed under our key').toBeGreaterThanOrEqual(0)
    expect(firstForeignEmpty, 'the foreign key was conditionally emptied').toBeGreaterThanOrEqual(0)
    expect(rehomeAt, 're-home must PRECEDE the first foreign-key empty').toBeLessThan(firstForeignEmpty)
    expect(await base.get('j:v9:tab:me')).toEqual(adopted)
    expect(await base.get('j:v9:tab:dead-tab')).toEqual([])
  })

  it('a foreign-key empty that throws still leaves the adopted intents durable under our key', async () => {
    // Fault injection — the same property from the failure side: if emptying
    // rejects (quota, torn transaction), the adopted journal must already be
    // readable under the adopter's key.
    const base = createMemoryKvStore()
    const adopted: Entry[] = [{ id: 'x2', v: 2 }]
    await base.set('j:v9:tab:dead-tab', adopted)
    await base.set('j:v9:tabs', ['dead-tab'])
    const store: KvStore = {
      ...base,
      update: async (key, fn) => {
        if (key === 'j:v9:tab:dead-tab') throw new Error('injected: empty failed')
        return base.update(key, fn)
      },
    }

    const memory: Entry[] = []
    await expect(adoptTabJournalNamespace<Entry>({
      store,
      registryKey: 'j:v9:tabs',
      keyOfTab: (tabId) => `j:v9:tab:${tabId}`,
      ownTabId: 'me',
      includeSelf: true,
      hydrate: (entries) => memory.push(...entries),
      rehome: () => store.set('j:v9:tab:me', [...memory]),
      contentEquals: eq,
    })).rejects.toThrow('injected')

    expect(await base.get('j:v9:tab:me')).toEqual(adopted)
    // The foreign key was NOT emptied — nothing lost on either side.
    expect(await base.get('j:v9:tab:dead-tab')).toEqual(adopted)
  })
})

describe('adoptSingleKeyLegacyJournal — same ordering for the v1 single key', () => {
  it('re-homes before conditionally emptying the legacy key', async () => {
    const ops: string[] = []
    const base = createMemoryKvStore()
    const store = recordingStore(base, ops)
    const legacy: Entry[] = [{ id: 'L1', v: 7 }]
    await base.set('legacy:v1', legacy)

    const memory: Entry[] = []
    await adoptSingleKeyLegacyJournal<Entry>({
      store,
      legacyKey: 'legacy:v1',
      hydrate: (entries) => memory.push(...entries),
      rehome: () => store.set('j:v9:tab:me', [...memory]),
      contentEquals: eq,
    })

    const rehomeAt = ops.indexOf('set:j:v9:tab:me')
    const legacyEmpty = ops.indexOf('update:legacy:v1')
    expect(rehomeAt).toBeGreaterThanOrEqual(0)
    expect(legacyEmpty).toBeGreaterThanOrEqual(0)
    expect(rehomeAt, 're-home must PRECEDE the legacy-key empty').toBeLessThan(legacyEmpty)
    expect(await base.get('legacy:v1')).toEqual([])
  })
})
