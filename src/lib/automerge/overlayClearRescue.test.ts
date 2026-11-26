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

import * as A from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { clearedOverlayEditsToRestore, mergeStoredRescues, OVERLAY_COMPACTION_CLEAR_MESSAGE, rescuePatch } from './overlayClearRescue'

describe('the persisted rescues, merged per tab', () => {
  const r = (id: string, since: number, value = id) => ({ collection: 'objects', id, value, seen: null, since })

  it('adds into what is stored; removes only the SAME finding (key and since)', () => {
    const stored = [r('a', 1), r('b', 2)]
    expect(mergeStoredRescues(stored, [r('c', 3)], [])).toEqual([r('a', 1), r('b', 2), r('c', 3)])
    // Another tab found `a` again since (since 9): this tab's removal of its own `a` (since 1) leaves it.
    expect(mergeStoredRescues([r('a', 9), r('b', 2)], [], [r('a', 1)])).toEqual([r('a', 9), r('b', 2)])
    expect(mergeStoredRescues(stored, [], [r('a', 1)])).toEqual([r('b', 2)])
    // A newer finding of the same entity replaces the stored one.
    expect(mergeStoredRescues(stored, [r('a', 5, 'newer')], [])).toEqual([r('a', 5, 'newer'), r('b', 2)])
  })

  it('anything stored that is not a rescue is dropped; nothing stored is an empty list', () => {
    expect(mergeStoredRescues(undefined, [], [])).toEqual([])
    expect(mergeStoredRescues('garbage', [r('a', 1)], [])).toEqual([r('a', 1)])
    expect(mergeStoredRescues([null, { id: 'x' }, r('b', 2)], [], [])).toEqual([r('b', 2)])
  })
})

type Overlay = { objects: Record<string, { id: string; name: string; description?: string; tag?: A.ImmutableString }> }

/** The server's overlay, an entry a browser created; the browser's copy. */
function world() {
  const server = A.change(A.init<Overlay>({ actor: 'aa'.repeat(16) }), (d) => {
    d.objects = { e1: { id: 'e1', name: 'Created earlier', tag: new A.ImmutableString('t') }, e2: { id: 'e2', name: 'Other' } }
  })
  const browser = A.clone(server, { actor: 'bb'.repeat(16) })
  return { server, browser }
}

/** The compaction's clear of `id` (its message set, as `compaction.ts` does). */
const clear = (doc: A.Doc<Overlay>, id: string) => A.change(doc, { message: OVERLAY_COMPACTION_CLEAR_MESSAGE }, (d) => { delete d.objects[id] })

/** The browser receives `remote`: before, after, and the patches of the merge. */
function receive(browser: A.Doc<Overlay>, remote: A.Doc<Overlay>) {
  const after = A.merge(A.clone(browser), remote)
  const patches = A.diff(after, A.getHeads(browser), A.getHeads(after))
  return { before: browser, after, patches }
}

describe('the overlay clear rescue', () => {
  it('an edit made OFFLINE inside an entry the compaction cleared meanwhile is restored — Automerge alone loses it', () => {
    const { server, browser } = world()
    // Offline: her edit, a field INSIDE the entry (as the bridge writes it).
    const edited = A.change(browser, (d) => { d.objects.e1!.description = 'Her offline edit' })
    // Meanwhile the compaction folds e1 and clears it (it never saw her edit).
    const cleared = clear(server, 'e1')
    const { before, after, patches } = receive(edited, cleared)
    // Automerge's merge: the delete wins, her edit is unreachable.
    expect(after.objects.e1).toBeUndefined()
    const restore = clearedOverlayEditsToRestore(before, after, patches)
    expect(restore).toHaveLength(1)
    expect(restore[0]).toMatchObject({ collection: 'objects', id: 'e1', value: { id: 'e1', name: 'Created earlier', description: 'Her offline edit' } })
    // Written back as a put of the whole entry, it survives the merge with the server.
    const restored = A.change(after, (d) => { d.objects.e1 = restore[0]!.value as never })
    const merged = A.merge(A.clone(cleared), restored)
    expect(merged.objects.e1?.description).toBe('Her offline edit')
    expect(String(merged.objects.e1?.tag)).toBe('t')
  })

  it('an ORDINARY clear — of an entry it saw whole — restores nothing; nor does this browser\'s own delete', () => {
    const { server, browser } = world()
    const ordinary = receive(browser, clear(server, 'e1'))
    expect(clearedOverlayEditsToRestore(ordinary.before, ordinary.after, ordinary.patches)).toEqual([])
    // Her own delete (a local change) is never undone.
    const own = A.change(A.clone(browser), (d) => { delete d.objects.e1 })
    const patches = A.diff(own, A.getHeads(browser), A.getHeads(own))
    expect(clearedOverlayEditsToRestore(browser, own, patches)).toEqual([])
    // An edit the clear DID see (it arrived first): nothing to restore.
    const edited = A.change(A.clone(browser), (d) => { d.objects.e1!.description = 'Seen by the server' })
    const seen = receive(edited, clear(A.merge(A.clone(server), edited), 'e1'))
    expect(clearedOverlayEditsToRestore(seen.before, seen.after, seen.patches)).toEqual([])
  })

  it('a colleague\'s EXPLICIT delete (no clear message) is never undone, whatever she edited', () => {
    const { server, browser } = world()
    const edited = A.change(browser, (d) => { d.objects.e1!.description = 'Hers, unseen' })
    const deleted = A.change(server, (d) => { delete d.objects.e1 })
    const { before, after, patches } = receive(edited, deleted)
    expect(clearedOverlayEditsToRestore(before, after, patches)).toEqual([])
  })

  it('only the overlay\'s collections, only deletes of an entry', () => {
    const { server, browser } = world()
    const edited = A.change(browser, (d) => { d.objects.e1!.description = 'Mine' })
    const { before, after, patches } = receive(edited, clear(server, 'e1'))
    expect(clearedOverlayEditsToRestore(before, after, patches, ['connections'])).toEqual([])
    expect(clearedOverlayEditsToRestore(before, after, [])).toEqual([])
  })
})

describe('what a rescue writes back', () => {
  it('a field she ADDED is owed although the store shows a default there — compared with the documents, not the store', () => {
    const seen = { id: 'e1', name: 'A' }
    const mine = { id: 'e1', name: 'A', description: 'Added offline' }
    // The documents hold no description; the projection shows ''.
    expect(rescuePatch(mine, seen, { id: 'e1', name: 'A' }, { id: 'e1', name: 'A', description: '' })).toEqual({ description: 'Added offline' })
  })

  it('a nested map is merged KEY BY KEY: her key beside a colleague\'s later key', () => {
    const seen = { id: 'e1', properties: { a: '1', b: '1' } }
    const mine = { id: 'e1', properties: { a: 'hers', b: '1' } }
    const doc = { id: 'e1', properties: { a: '1', b: 'colleague' } }
    expect(rescuePatch(mine, seen, doc, doc)).toEqual({ properties: { a: 'hers', b: 'colleague' } })
    // A key she removed is removed.
    expect(rescuePatch({ id: 'e1', properties: { b: '1' } }, seen, seen, seen)).toEqual({ properties: { b: '1' } })
  })

  it('nothing owed once her value is in the documents, or a later write superseded it', () => {
    const seen = { id: 'e1', description: 'old' }
    const mine = { id: 'e1', description: 'hers' }
    expect(rescuePatch(mine, seen, { id: 'e1', description: 'hers' }, { id: 'e1', description: 'hers' })).toBeNull()
    expect(rescuePatch(mine, seen, { id: 'e1', description: 'later' }, { id: 'e1', description: 'later' })).toBeNull()
    // Immutable strings compare by their value.
    expect(rescuePatch({ id: 'e1', kind: new A.ImmutableString('x') }, { id: 'e1', kind: new A.ImmutableString('x') }, { id: 'e1' }, { id: 'e1' })).toBeNull()
  })
})
