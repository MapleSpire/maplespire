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

import { describe, it, expect, afterEach } from 'vitest'
import { createMemoryKvStore, namespacedKvStore, workspaceKvStore, __resetWorkspaceKvStores } from './kvStore'
import { setActiveWorkspaceRef, DEFAULT_WORKSPACE_REF } from '../automerge/workspace'

describe('namespacedKvStore', () => {
  it('prefixes every write and strips it back off on read', async () => {
    const base = createMemoryKvStore()
    const ns = namespacedKvStore(base, 'ns1')
    await ns.set('o:A', { id: 'A' })
    // The base store sees the namespaced key, not the bare one.
    expect(await base.get('o:A')).toBeUndefined()
    expect(await base.get('ns1::o:A')).toEqual({ id: 'A' })
    // The namespaced view reads its own key back unprefixed.
    expect(await ns.get('o:A')).toEqual({ id: 'A' })
  })

  it('two namespaces over the SAME base store never collide', async () => {
    const base = createMemoryKvStore()
    const a = namespacedKvStore(base, 'a')
    const b = namespacedKvStore(base, 'b')
    await a.set('o:X', { v: 'from-a' })
    await b.set('o:X', { v: 'from-b' })
    expect(await a.get('o:X')).toEqual({ v: 'from-a' })
    expect(await b.get('o:X')).toEqual({ v: 'from-b' })
  })

  it('scanPrefix only enumerates this namespace, with keys unprefixed', async () => {
    const base = createMemoryKvStore()
    const a = namespacedKvStore(base, 'a')
    const b = namespacedKvStore(base, 'b')
    await a.setMany([['o:1', 1], ['o:2', 2]])
    await b.setMany([['o:1', 99]])
    const rows = await a.scanPrefix<number>('o:')
    expect(rows.sort()).toEqual([['o:1', 1], ['o:2', 2]])
  })

  it('clear() wipes ONLY this namespace — a sibling namespace on the same base is untouched', async () => {
    const base = createMemoryKvStore()
    const a = namespacedKvStore(base, 'a')
    const b = namespacedKvStore(base, 'b')
    await a.set('o:1', 'a-val')
    await b.set('o:1', 'b-val')
    await a.clear()
    expect(await a.get('o:1')).toBeUndefined()
    expect(await b.get('o:1')).toBe('b-val')
  })

  it('getMany/delMany round-trip through the namespace', async () => {
    const base = createMemoryKvStore()
    const ns = namespacedKvStore(base, 'ns')
    await ns.setMany([['k1', 'v1'], ['k2', 'v2']])
    expect(await ns.getMany(['k1', 'k2', 'missing'])).toEqual(['v1', 'v2', undefined])
    await ns.delMany(['k1'])
    expect(await ns.getMany(['k1', 'k2'])).toEqual([undefined, 'v2'])
  })
})

describe('workspaceKvStore — memoized per active workspace', () => {
  afterEach(() => {
    setActiveWorkspaceRef(DEFAULT_WORKSPACE_REF)
    __resetWorkspaceKvStores()
  })

  it('returns the SAME store instance across repeated calls in the same workspace', () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-1' })
    const s1 = workspaceKvStore()
    const s2 = workspaceKvStore()
    expect(s1).toBe(s2)
  })

  it('returns a DIFFERENT store instance after switching workspace', () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-1' })
    const s1 = workspaceKvStore()
    setActiveWorkspaceRef({ landscapeId: 'ls-2', versionId: 'v-1' })
    const s2 = workspaceKvStore()
    expect(s1).not.toBe(s2)
  })

  it('switching back to a previously-seen workspace returns its ORIGINAL instance (memoized, not rebuilt)', () => {
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-1' })
    const s1 = workspaceKvStore()
    setActiveWorkspaceRef({ landscapeId: 'ls-2', versionId: 'v-1' })
    workspaceKvStore()
    setActiveWorkspaceRef({ landscapeId: 'ls-1', versionId: 'v-1' })
    const s1Again = workspaceKvStore()
    expect(s1Again).toBe(s1)
  })
})
