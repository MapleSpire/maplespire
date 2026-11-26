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

import { Repo } from '@automerge/automerge-repo'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeWithDurabilityTracking,
  DurableHeadLedger,
  DURABLE_ENTRY_ACTORS_MAX,
  durableConnectionStatus,
  mergeDurableHeadSnapshots,
  pendingDurabilityDebts,
  setLocalDocumentChangeListener,
  withChangeMessage,
} from './durableSync'
import { decodeChange, getAllChanges } from '@automerge/automerge'

afterEach(() => setLocalDocumentChangeListener(null))

describe('durable sync ledger', () => {
  it('does not call a connected document synced while PostgreSQL acknowledgement is pending', () => {
    expect(durableConnectionStatus(true, 1)).toBe('saving')
    expect(durableConnectionStatus(true, 0)).toBe('ready')
    expect(durableConnectionStatus(false, 0)).toBe('offline')
  })

  it('counts EVERY durability debt — journaled entity intents and an unread journal included', () => {
    const clean = {
      durableHeadCount: 0,
      durableLedgerHydrated: true,
      writeSchedulerPending: false,
      entityIntentCount: 0,
      entityIntentsHydrated: true,
      placementIntentCount: 0,
      placementIntentsHydrated: true,
    }
    expect(pendingDurabilityDebts(clean)).toBe(0)
    // The historical lie: heads drained + scheduler idle, but an entity edit
    // sits journaled because its write head is missing. Never 'ready'.
    expect(pendingDurabilityDebts({ ...clean, entityIntentCount: 1 })).toBeGreaterThan(0)
    // A journal not yet read is a debt, not an empty journal.
    expect(pendingDurabilityDebts({ ...clean, entityIntentsHydrated: false })).toBeGreaterThan(0)
    expect(pendingDurabilityDebts({ ...clean, durableHeadCount: 2 })).toBe(2)
    expect(pendingDurabilityDebts({ ...clean, writeSchedulerPending: true })).toBe(1)
    // The placement journal is in the sum — otherwise a hydrated off-active
    // placement (or a flush that bailed on a missing handle) would leave the
    // badge saying 'Synced' over unsaved geometry.
    expect(pendingDurabilityDebts({ ...clean, placementIntentCount: 3 })).toBe(3)
    expect(pendingDurabilityDebts({ ...clean, placementIntentsHydrated: false })).toBeGreaterThan(0)
    // Before the persisted ledger is read, the documents an earlier session
    // left unacknowledged are not in durableHeadCount.
    expect(pendingDurabilityDebts({ ...clean, durableLedgerHydrated: false })).toBeGreaterThan(0)
  })

  it('clears only the exact frontier sent to the server', () => {
    const ledger = new DurableHeadLedger()
    ledger.mark('doc-1' as never, ['a'.repeat(64)])
    const sent = ledger.snapshot()
    ledger.mark('doc-1' as never, ['b'.repeat(64)])

    ledger.acknowledge(sent, [{ documentId: 'doc-1', durable: true }])

    expect(ledger.snapshot()).toEqual([
      { documentId: 'doc-1', heads: ['b'.repeat(64)] },
    ])
  })

  it('an entry keeps its WRITERS until acknowledged — persisted, merged with another tab\'s, unknown when a mark names none or past the bound', () => {
    const ledger = new DurableHeadLedger()
    const head = (c: string) => [c.repeat(64)]
    ledger.mark('doc-1' as never, head('a'), undefined, 'aa11')
    ledger.mark('doc-1' as never, head('b'), undefined, 'bb22')
    expect([...ledger.writersOf('doc-1' as never)!].sort()).toEqual(['aa11', 'bb22'])
    expect(ledger.snapshot()[0]!.actors?.sort()).toEqual(['aa11', 'bb22'])
    // A mark that names no writer (a creation, a resumed handle): unknown.
    ledger.mark('doc-1' as never, head('c'))
    expect(ledger.writersOf('doc-1' as never)).toBeNull()
    expect(ledger.snapshot()[0]).not.toHaveProperty('actors')
    // Acknowledged, the entry closes; the next local write opens a new one.
    ledger.acknowledge(ledger.snapshot(), [{ documentId: 'doc-1', durable: true }])
    expect(ledger.writersOf('doc-1' as never)).toBeUndefined()
    ledger.mark('doc-1' as never, head('d'), undefined, 'cc33')
    expect([...ledger.writersOf('doc-1' as never)!]).toEqual(['cc33'])
    // Past the bound: unknown, never a truncated list.
    for (let i = 0; i < DURABLE_ENTRY_ACTORS_MAX; i += 1) ledger.mark('doc-2' as never, head('e'), undefined, i.toString(16).padStart(4, '0'))
    expect(ledger.writersOf('doc-2' as never)?.size).toBe(DURABLE_ENTRY_ACTORS_MAX)
    ledger.mark('doc-2' as never, head('e'), undefined, 'ffff')
    expect(ledger.writersOf('doc-2' as never)).toBeNull()

    const id = new Repo({ network: [] }).create({}).documentId
    const hydrated = new DurableHeadLedger()
    hydrated.hydrate([{ documentId: id, heads: head('a'), actors: ['aa11'] }])
    expect([...hydrated.writersOf(id)!]).toEqual(['aa11'])
    // An entry persisted before the field: unknown.
    const legacy = new DurableHeadLedger()
    legacy.hydrate([{ documentId: id, heads: head('a') }])
    expect(legacy.writersOf(id)).toBeNull()
    // Merged with another tab's entry: both writers; unknown on one side, unknown.
    expect(mergeDurableHeadSnapshots([{ documentId: id, heads: head('a'), actors: ['aa11'] }], [{ documentId: id, heads: head('b'), actors: ['bb22'] }])[0]!.actors?.sort())
      .toEqual(['aa11', 'bb22'])
    expect(mergeDurableHeadSnapshots([{ documentId: id, heads: head('a') }], [{ documentId: id, heads: head('b'), actors: ['bb22'] }])[0])
      .not.toHaveProperty('actors')
    expect(mergeDurableHeadSnapshots([], [{ documentId: id, heads: head('b'), actors: ['bb22'] }])[0]!.actors).toEqual(['bb22'])
  })

  it('a document marked DURING hydration keeps the persisted writers too; an unknown set never becomes known by a later mark', () => {
    const head = (c: string) => [c.repeat(64)]
    const id = new Repo({ network: [] }).create({}).documentId
    // A boot-time write marks it (actor a2) before the persisted ledger is read…
    const ledger = new DurableHeadLedger()
    ledger.mark(id, head('b'), undefined, 'a2a2')
    // …whose entry holds an earlier session's unacknowledged edits (a1).
    ledger.hydrate([{ documentId: id, heads: head('a'), actors: ['a1a1'] }])
    expect([...ledger.writersOf(id)!].sort()).toEqual(['a1a1', 'a2a2'])
    // A persisted entry with unknown writers makes them unknown.
    const unknown = new DurableHeadLedger()
    unknown.mark(id, head('b'), undefined, 'a2a2')
    unknown.hydrate([{ documentId: id, heads: head('a') }])
    expect(unknown.writersOf(id)).toBeNull()
    // Unknown stays unknown: a later LOCAL mark does not make it known (Wd).
    const opened = new DurableHeadLedger()
    opened.mark('doc-1' as never, head('a'))
    opened.mark('doc-1' as never, head('b'), undefined, 'a3a3')
    expect(opened.writersOf('doc-1' as never)).toBeNull()
  })

  it('forget() drops exactly the named documents (the epoch-retired path: never durable, exported)', () => {
    const ledger = new DurableHeadLedger()
    ledger.mark('retired' as never, ['a'.repeat(64)])
    ledger.mark('live' as never, ['b'.repeat(64)])
    ledger.forget(['retired' as never])
    expect(ledger.size).toBe(1)
    expect(ledger.snapshot().map((e) => e.documentId)).toEqual(['live'])
  })

  it('keeps rejected documents pending and clears durable documents independently', () => {
    const ledger = new DurableHeadLedger()
    ledger.mark('doc-1' as never, ['a'.repeat(64)])
    ledger.mark('doc-2' as never, ['b'.repeat(64)])
    const sent = ledger.snapshot()

    ledger.acknowledge(sent, [
      { documentId: 'doc-1', durable: true },
      { documentId: 'doc-2', durable: false },
    ])

    expect(ledger.snapshot()).toEqual([
      { documentId: 'doc-2', heads: ['b'.repeat(64)] },
    ])
  })

  it('notifies durability tracking for real writes but not no-op changes', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create({ value: 1 })
    const listener = vi.fn()
    setLocalDocumentChangeListener(listener)

    changeWithDurabilityTracking(handle, (doc) => { doc.value = 1 })
    expect(listener).not.toHaveBeenCalled()
    changeWithDurabilityTracking(handle, (doc) => { doc.value = 2 })
    expect(listener).toHaveBeenCalledWith(handle)
  })

  it('withChangeMessage tags every change inside it; nested restores the outer; an exception restores none', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create<{ value: number }>({ value: 1 })
    const lastMessage = () => {
      const changes = getAllChanges(handle.doc() as never)
      return decodeChange(changes[changes.length - 1]!).message ?? null
    }
    withChangeMessage('outer', () => {
      changeWithDurabilityTracking(handle, (doc) => { doc.value = 2 })
      expect(lastMessage()).toBe('outer')
      withChangeMessage('inner', () => {
        changeWithDurabilityTracking(handle, (doc) => { doc.value = 3 })
      })
      expect(lastMessage()).toBe('inner')
      changeWithDurabilityTracking(handle, (doc) => { doc.value = 4 })
      expect(lastMessage()).toBe('outer')
    })
    expect(() => withChangeMessage('boom', () => { throw new Error('x') })).toThrow('x')
    changeWithDurabilityTracking(handle, (doc) => { doc.value = 5 })
    expect(lastMessage()).toBeNull()
  })

  it('restores only valid pending frontiers after a browser restart', () => {
    const ledger = new DurableHeadLedger()
    const documentId = new Repo({ network: [] }).create({ value: 1 }).documentId
    ledger.hydrate([
      { documentId, heads: ['a'.repeat(64)] },
      { documentId: 'doc-2' as never, heads: ['invalid'] },
    ])
    expect(ledger.persisted()).toEqual([
      { documentId, heads: ['a'.repeat(64)] },
    ])
  })

  it('hydrating keeps what was marked during the read, with its newer frontier', () => {
    const memory = new Repo({ network: [] })
    const editedDuringRead = memory.create({ value: 1 }).documentId
    const leftByEarlierSession = memory.create({ value: 2 }).documentId
    const ledger = new DurableHeadLedger()
    ledger.mark(editedDuringRead, ['b'.repeat(64)])

    ledger.hydrate([
      { documentId: editedDuringRead, heads: ['a'.repeat(64)] },
      { documentId: leftByEarlierSession, heads: ['c'.repeat(64)] },
    ])

    expect(ledger.persisted()).toEqual([
      { documentId: editedDuringRead, heads: ['b'.repeat(64)] },
      { documentId: leftByEarlierSession, heads: ['c'.repeat(64)] },
    ])
  })

  it('a write before the read only adds to the persisted ledger', () => {
    const memory = new Repo({ network: [] })
    const persistedOnly = memory.create({ value: 1 }).documentId
    const both = memory.create({ value: 2 }).documentId
    const localOnly = memory.create({ value: 3 }).documentId
    const persisted = [
      { documentId: persistedOnly, heads: ['a'.repeat(64)] },
      { documentId: both, heads: ['b'.repeat(64)] },
      { documentId: 'not-a-document', heads: ['c'.repeat(64)] },
    ]

    expect(mergeDurableHeadSnapshots(persisted, [
      { documentId: both, heads: ['d'.repeat(64)] },
      { documentId: localOnly, heads: ['e'.repeat(64)] },
    ])).toEqual([
      { documentId: persistedOnly, heads: ['a'.repeat(64)] },
      { documentId: both, heads: ['d'.repeat(64)] },
      { documentId: localOnly, heads: ['e'.repeat(64)] },
    ])
    // An empty local snapshot changes nothing — the shape of StrictMode's stop.
    expect(mergeDurableHeadSnapshots(persisted, [])).toHaveLength(2)
    expect(mergeDurableHeadSnapshots(undefined, [])).toEqual([])
    expect(mergeDurableHeadSnapshots('garbage', [])).toEqual([])
    expect(mergeDurableHeadSnapshots({ length: 1 }, [])).toEqual([])
  })

  it('drops every malformed persisted entry, one condition at a time, without throwing', () => {
    // Browser storage: a value that THROWS here leaves the session unhydrated,
    // i.e. a badge on 'saving' for the rest of it. Each entry breaks ONE rule.
    const documentId = new Repo({ network: [] }).create({ value: 1 }).documentId
    const good = { documentId, heads: ['a'.repeat(64)] }
    const malformed: unknown[] = [
      null,
      'not an object',
      { documentId, heads: 'a'.repeat(64) },
      { documentId, heads: [] },
      { documentId, heads: ['A'.repeat(64)] },
      { documentId, heads: ['a'.repeat(63)] },
      { documentId, heads: ['a'.repeat(64), 7] },
      { documentId: 42, heads: ['a'.repeat(64)] },
    ]
    for (const entry of malformed) {
      expect(mergeDurableHeadSnapshots([entry], []), JSON.stringify(entry)).toEqual([])
      const ledger = new DurableHeadLedger()
      ledger.hydrate([entry])
      expect(ledger.persisted(), JSON.stringify(entry)).toEqual([])
    }
    // Control: the same document, well formed, is kept by both.
    expect(mergeDurableHeadSnapshots([good], [])).toEqual([good])
    const ledger = new DurableHeadLedger()
    ledger.hydrate([good])
    expect(ledger.persisted()).toEqual([good])
  })

  it('hydrating nothing, or something that is not a list, leaves the ledger as it was', () => {
    const documentId = new Repo({ network: [] }).create({ value: 1 }).documentId
    const ledger = new DurableHeadLedger()
    ledger.mark(documentId, ['a'.repeat(64)])
    for (const entries of [undefined, null, {}, { length: 1 }, 'x']) {
      ledger.hydrate(entries)
      expect(ledger.snapshot(), String(entries)).toEqual([{ documentId, heads: ['a'.repeat(64)] }])
    }
  })

  // The workspace tag is what tells a repointed session's documents from the
  // old version's (bridge.ts `partitionDurableLedger`): lost on any of these
  // paths, an old-version document reads as untagged and is re-presented on
  // the new version's socket — the measured split.
  it('the workspace tag survives persistence, hydration and the add-only merge', () => {
    const repo = new Repo({ network: [] })
    const tagged = repo.create({ value: 1 }).documentId
    const untagged = repo.create({ value: 2 }).documentId
    const heads = ['b'.repeat(64)]
    const ledger = new DurableHeadLedger()
    ledger.mark(tagged, heads, 'L/V1')
    ledger.mark(untagged, heads)
    // An unknown workspace on a later mark leaves the tag as it was.
    ledger.mark(tagged, heads, undefined)
    expect(ledger.workspaceOf(tagged)).toBe('L/V1')
    expect(ledger.workspaceOf(untagged)).toBeUndefined()
    const persisted = ledger.persisted()
    expect(persisted).toEqual([
      { documentId: tagged, heads, workspace: 'L/V1' },
      { documentId: untagged, heads },
    ])

    const reloaded = new DurableHeadLedger()
    reloaded.hydrate(persisted)
    expect(reloaded.workspaceOf(tagged)).toBe('L/V1')
    expect(reloaded.workspaceOf(untagged)).toBeUndefined()
    expect(reloaded.dormantEntries()).toEqual(persisted)

    // A local entry with no tag keeps the persisted one; a local tag wins.
    const newer = ['c'.repeat(64)]
    expect(mergeDurableHeadSnapshots(persisted, [{ documentId: tagged, heads: newer }]))
      .toContainEqual({ documentId: tagged, heads: newer, workspace: 'L/V1' })
    expect(mergeDurableHeadSnapshots(persisted, [{ documentId: untagged, heads: newer, workspace: 'L/V2' }]))
      .toContainEqual({ documentId: untagged, heads: newer, workspace: 'L/V2' })

    // A malformed tag reads as none.
    const odd = new DurableHeadLedger()
    odd.hydrate([{ documentId: tagged, heads, workspace: 42 }])
    expect(odd.workspaceOf(tagged)).toBeUndefined()
  })

  // DORMANT: hydrated entries are held but not owed until the session names
  // its workspace and activates its own (bridge.ts `partitionDurableLedger`).
  // Owed too early, an old version's document is asked about, re-presented
  // and counted in the new version's session; dropped instead, a move back to
  // the old version freezes it (the withhold-for-good defect both lenses found).
  it('hydrated entries are dormant until activated: persisted, but not owed, asked about or counted', () => {
    const repo = new Repo({ network: [] })
    const mine = repo.create({ value: 1 }).documentId
    const elsewhere = repo.create({ value: 2 }).documentId
    const markedNow = repo.create({ value: 3 }).documentId
    const heads = ['d'.repeat(64)]
    const ledger = new DurableHeadLedger()
    ledger.mark(markedNow, heads, 'L/V2')
    ledger.hydrate([
      { documentId: mine, heads, workspace: 'L/V2' },
      { documentId: elsewhere, heads, workspace: 'L/V1' },
    ])
    expect(ledger.snapshot().map((entry) => entry.documentId)).toEqual([markedNow])
    expect(ledger.size).toBe(1)
    expect(ledger.dormantEntries().map((entry) => entry.documentId)).toEqual([mine, elsewhere])
    expect(ledger.persisted()).toHaveLength(3)

    ledger.activate([mine])
    expect(ledger.snapshot().map((entry) => entry.documentId)).toEqual([markedNow, mine])
    expect(ledger.size).toBe(2)
    // A dormant entry is never sent, so an acknowledgement cannot clear it;
    // an activated one clears as ever.
    ledger.acknowledge(ledger.snapshot(), [{ documentId: mine, durable: true }, { documentId: elsewhere, durable: true }])
    expect(ledger.persisted().map((entry) => entry.documentId)).toEqual([markedNow, elsewhere])
    expect(ledger.dormantEntries().map((entry) => entry.documentId)).toEqual([elsewhere])
    // A later mark of a dormant document keeps it dormant (and owed nowhere) —
    // and keeps its tag, even when the late write names the NEW version: the
    // next boot would otherwise activate it there.
    ledger.mark(elsewhere, ['e'.repeat(64)], 'L/V2')
    expect(ledger.size).toBe(1)
    expect(ledger.workspaceOf(elsewhere)).toBe('L/V1')
  })
})
