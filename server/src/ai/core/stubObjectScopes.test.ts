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
import * as Automerge from '@automerge/automerge'
import { syncStubObjectScopes } from './stubObjectScopes.js'

type Shard = { diagrams: Record<string, Record<string, unknown>> }
const plain = (doc: Automerge.Doc<Shard>) => JSON.parse(JSON.stringify(doc)) as Shard

describe('syncStubObjectScopes (registry stub copy of a DiagramDoc\'s overrides)', () => {
  const seeded = () => Automerge.from<Shard>({ diagrams: { d1: { id: 'd1', name: 'D' } } })

  it('writes, then follows a clear by emptying the map (the map itself is kept)', () => {
    let shard = Automerge.change(seeded(), (s) => syncStubObjectScopes(s.diagrams.d1, { bank: 'external' }))
    expect(plain(shard).diagrams.d1.objectScopes).toEqual({ bank: 'external' })
    shard = Automerge.change(shard, (s) => syncStubObjectScopes(s.diagrams.d1, undefined))
    expect(plain(shard).diagrams.d1.objectScopes).toEqual({})
  })

  it('a PARTIAL clear drops exactly the cleared key (QA mutant A1: stale key kept)', () => {
    let shard = Automerge.change(seeded(), (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'external', b: 'internal' }))
    shard = Automerge.change(shard, (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'external' }))
    expect(plain(shard).diagrams.d1.objectScopes).toEqual({ a: 'external' })
  })

  it('creates nothing when there are no overrides and never were', () => {
    const shard = Automerge.change(seeded(), (s) => syncStubObjectScopes(s.diagrams.d1, {}))
    expect(plain(shard).diagrams.d1).not.toHaveProperty('objectScopes')
  })

  it('drops values that are not a scope', () => {
    const shard = Automerge.change(seeded(), (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'external', b: 'sideways', c: 3 }))
    expect(plain(shard).diagrams.d1.objectScopes).toEqual({ a: 'external' })
  })

  it('works on a plain stub object (the draft merge builds one before inserting it)', () => {
    const stub: Record<string, unknown> = { id: 'd1' }
    syncStubObjectScopes(stub, { a: 'internal' })
    expect(stub.objectScopes).toEqual({ a: 'internal' })
  })

  it('merges two writers overriding DIFFERENT objects per key', () => {
    const base = Automerge.change(seeded(), (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'external' }))
    const left = Automerge.change(Automerge.clone(base), (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'external', b: 'external' }))
    const right = Automerge.change(Automerge.clone(base), (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'internal' }))
    expect(plain(Automerge.merge(left, right)).diagrams.d1.objectScopes).toEqual({ a: 'internal', b: 'external' })
  })

  it('keeps a peer\'s concurrent override when the other side clears the LAST one (no container delete)', () => {
    const base = Automerge.change(seeded(), (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'external' }))
    const clearer = Automerge.change(Automerge.clone(base), (s) => syncStubObjectScopes(s.diagrams.d1, {}))
    const setter = Automerge.change(Automerge.clone(base), (s) => syncStubObjectScopes(s.diagrams.d1, { a: 'external', b: 'internal' }))
    expect(plain(Automerge.merge(clearer, setter)).diagrams.d1.objectScopes).toEqual({ b: 'internal' })
  })
})
