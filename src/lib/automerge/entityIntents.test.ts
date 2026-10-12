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
import type { C4Object, Connection, DecisionRecord, Group, Tag } from '../../types'
import { createMemoryKvStore } from '../modelQuery/kvStore'
import {
  PendingEntityIntents,
  deepEqualPlain,
  entityIntentTabId,
  flushEntityIntentPersistence,
  forgetIntentsOnceDurable,
  hydrateEntityIntents,
  isEntityPlannerKind,
  pendingEntityIntents,
  persistEntityIntents,
  planEntityIntentReplay,
  planSmallCollectionIntentReplay,
  splitResidentPlannableIntents,
  type EntityIntentReplayInput,
  type SerializedEntityIntent,
} from './entityIntents'

const WS = 'landscape-1::version-1'

function obj(id: string, name: string, extra: Partial<C4Object> = {}): C4Object {
  return { id, name, type: 'system', description: '', ...extra } as C4Object
}

function conn(id: string, label: string): Connection {
  return { id, fromId: 'a', toId: 'b', type: 'solid', label } as Connection
}

/** The upsert snapshot's name, for object intents (Connection has no name). */
function upsertName(intent: SerializedEntityIntent): string | undefined {
  return intent.op === 'upsert' ? (intent.snapshot as C4Object).name : undefined
}

const emptyReplayState: Omit<EntityIntentReplayInput, 'intents'> = {
  currentObjects: new Map<string, C4Object>(),
  currentConnections: new Map<string, Connection>(),
  objectBatchIds: new Set<string>(),
  connectionBatchIds: new Set<string>(),
  deletedObjectIds: new Set<string>(),
  deletedConnectionIds: new Set<string>(),
}

// A journal that forgets an intent before the edit is durable is the defect this
// module exists to close, so most of these tests are about WHEN entries die.
describe('PendingEntityIntents — latest-wins journal', () => {
  it('keeps one entry per kind:id, latest op wins in both directions', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'v1'))
    journal.recordDelete(WS, 'object', 'o1')
    expect(journal.pending(WS)).toHaveLength(1)
    expect(journal.pending(WS)[0].op).toBe('delete')

    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'v2'))
    expect(journal.pending(WS)).toHaveLength(1)
    const only = journal.pending(WS)[0]
    expect(only.op).toBe('upsert')
    expect(upsertName(only)).toBe('v2')
  })

  it('acknowledge respects the captured revision: an edit landing mid-flush survives', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'v1'))
    const captured = journal.revisionNow
    // The user keeps typing while the durable write is in flight.
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'v2'))
    journal.acknowledge(WS, 'object', ['o1'], captured)
    expect(journal.pending(WS)).toHaveLength(1)
    expect(journal.pending(WS)[0].revision).toBeGreaterThan(captured)
  })

  it('acknowledge is scoped by kind and by id', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'x', obj('x', 'o'))
    journal.recordUpsert(WS, 'connection', 'x', conn('x', 'c'))
    journal.acknowledge(WS, 'object', ['x'], journal.revisionNow)
    expect(journal.pending(WS)).toHaveLength(1)
    expect(journal.pending(WS)[0].kind).toBe('connection')
  })

  it('markWritten stamps only intents at or below the captured revision', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'v1'))
    journal.recordUpsert(WS, 'object', 'o2', obj('o2', 'v1'))
    const captured = journal.revisionNow
    journal.recordUpsert(WS, 'object', 'o2', obj('o2', 'v2')) // re-edit mid-flight
    journal.markWritten(WS, 'object', ['o1', 'o2'], captured, 'batch-A')
    const byId = new Map(journal.pending(WS).map((entry) => [entry.id, entry]))
    expect(byId.get('o1')?.writtenInBatchId).toBe('batch-A')
    // o2's live intent is the NEWER edit, which batch-A did not express.
    expect(byId.get('o2')?.writtenInBatchId).toBeUndefined()
  })

  it('is workspace-partitioned', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'a'))
    journal.recordUpsert('other::ws', 'object', 'o1', obj('o1', 'b'))
    journal.acknowledge(WS, 'object', ['o1'], journal.revisionNow)
    expect(journal.hasPending(WS)).toBe(false)
    expect(journal.hasPending('other::ws')).toBe(true)
  })

  it('serialize strips undefined from snapshot AND baseline, and never shares the live ref', () => {
    const journal = new PendingEntityIntents()
    const live = obj('o1', 'named', { parentId: undefined })
    const baseline = obj('o1', 'before', { parentId: undefined })
    journal.recordUpsert(WS, 'object', 'o1', live, baseline)
    const [entry] = journal.serialize(WS)
    expect(entry.op).toBe('upsert')
    if (entry.op !== 'upsert') throw new Error('unreachable')
    expect('parentId' in entry.snapshot).toBe(false)
    expect(entry.baseline && 'parentId' in entry.baseline).toBe(false)
    expect(entry.snapshot).not.toBe(live)
    expect(entry.baseline).not.toBe(baseline)
  })

  it('hydrate never clobbers a NEWER in-memory intent, and the revision counter continues past disk', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'stale-disk'))
    const disk = journal.serialize(WS)

    const fresh = new PendingEntityIntents()
    // Simulate a live session that re-edited before hydration finished.
    fresh.hydrate(WS, disk)
    fresh.recordUpsert(WS, 'object', 'o1', obj('o1', 'newer-live'))
    fresh.hydrate(WS, disk)
    const [only] = fresh.pending(WS)
    expect(upsertName(only)).toBe('newer-live')
    // A fresh record after hydrate must not reuse a revision the disk already
    // spent — otherwise an old ack could kill a new intent.
    expect(only.revision).toBeGreaterThan(disk[0].revision)
  })

  it('hydrate merges cross-tab entries by wall clock, not by incomparable revisions', () => {
    const journal = new PendingEntityIntents()
    const older: SerializedEntityIntent = {
      workspaceKey: WS, revision: 900, recordedAt: 1_000,
      kind: 'object', op: 'upsert', id: 'o1', snapshot: obj('o1', 'older-high-revision'),
    }
    const newer: SerializedEntityIntent = {
      workspaceKey: WS, revision: 3, recordedAt: 2_000,
      kind: 'object', op: 'upsert', id: 'o1', snapshot: obj('o1', 'newer-low-revision'),
    }
    journal.hydrate(WS, [older])
    journal.hydrate(WS, [newer])
    const [only] = journal.pending(WS)
    expect(upsertName(only)).toBe('newer-low-revision')
  })

  it('hydrate ignores entries from another workspace', () => {
    const journal = new PendingEntityIntents()
    const foreign = [{
      workspaceKey: 'other::ws', revision: 7, recordedAt: 1,
      kind: 'object', op: 'delete', id: 'o1',
    } satisfies SerializedEntityIntent]
    journal.hydrate(WS, foreign)
    expect(journal.hasPending(WS)).toBe(false)
  })
})

describe('deepEqualPlain', () => {
  it('is key-order insensitive and array-order sensitive', () => {
    expect(deepEqualPlain({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true)
    expect(deepEqualPlain({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
  })
  it('distinguishes a missing key from a present one', () => {
    expect(deepEqualPlain({ a: 1 }, { a: 1, c: 3 })).toBe(false)
  })
})

describe('planEntityIntentReplay — the boot decision', () => {
  it('acknowledges by BATCH ID without comparing values: an accomplished intent never re-asserts over later history', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'mine'))
    journal.markWritten(WS, 'object', ['o1'], journal.revisionNow, 'batch-7')
    // A colleague changed the value AFTER our write reached the shard.
    const plan = planEntityIntentReplay({
      ...emptyReplayState,
      intents: journal.serialize(WS),
      currentObjects: new Map([['o1', obj('o1', 'colleague-newer')]]),
      objectBatchIds: new Set(['batch-7']),
    })
    expect(plan.replayObjects).toHaveLength(0)
    expect(plan.satisfied.map((s) => s.id)).toEqual(['o1'])
  })

  it('a stamped intent whose batch never reached the shard is NOT treated as accomplished', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'mine'))
    journal.markWritten(WS, 'object', ['o1'], journal.revisionNow, 'batch-lost')
    const plan = planEntityIntentReplay({
      ...emptyReplayState,
      intents: journal.serialize(WS),
      objectBatchIds: new Set(['some-other-batch']),
    })
    expect(plan.satisfied).toHaveLength(0)
    expect(plan.replayObjects.map((o) => o.name)).toEqual(['mine'])
  })

  it('DEFERS a stamped intent when no witness can vouch for absence — never a blind whole-snapshot replay', () => {
    // Stamped + batch ids consumed server-side + overlay compacted + server
    // unreachable: "accomplished then compacted" and "lost" are
    // indistinguishable. Re-asserting the whole snapshot could clobber an
    // entity beyond the per-field residual; the intent must simply stay.
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'maybe-accomplished'))
    journal.markWritten(WS, 'object', ['o1'], journal.revisionNow, 'batch-consumed')
    journal.recordUpsert(WS, 'object', 'o2', obj('o2', 'never-written'))
    const plan = planEntityIntentReplay({
      ...emptyReplayState,
      intents: journal.serialize(WS),
      witnessesReliable: false,
    })
    expect(plan.deferred).toBe(1)
    expect(plan.satisfied).toHaveLength(0)
    // The UNSTAMPED intent was never written anywhere — replaying it is the
    // only way it survives, witnesses or not.
    expect(plan.replayObjects.map((o) => o.name)).toEqual(['never-written'])
  })

  it('acknowledges (never re-writes) an upsert the model already holds — across undefined-field and key-order artifacts', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'same', { parentId: undefined }))
    // What the doc holds after stripUndefined + Automerge materialization: same
    // value, no undefined field, different key insertion order.
    const docValue = { description: '', type: 'system', name: 'same', id: 'o1' } as C4Object
    const plan = planEntityIntentReplay({
      ...emptyReplayState,
      intents: journal.serialize(WS),
      currentObjects: new Map([['o1', docValue]]),
    })
    expect(plan.replayObjects).toHaveLength(0)
    expect(plan.satisfied).toEqual([{ kind: 'object', id: 'o1', revision: 1 }])
  })

  it('replays as a per-field three-way merge: a colleague edit to an untouched field survives', () => {
    const journal = new PendingEntityIntents()
    const baseline = obj('o1', 'old-name', { description: 'their-field' })
    const snapshot = obj('o1', 'my-new-name', { description: 'their-field' })
    journal.recordUpsert(WS, 'object', 'o1', snapshot, baseline)
    const colleagueCurrent = obj('o1', 'old-name', { description: 'colleague-updated' })
    const plan = planEntityIntentReplay({
      ...emptyReplayState,
      intents: journal.serialize(WS),
      currentObjects: new Map([['o1', colleagueCurrent]]),
    })
    expect(plan.replayObjects).toHaveLength(1)
    const replayed = plan.replayObjects[0]
    expect(replayed.name).toBe('my-new-name')            // our change asserted
    expect(replayed.description).toBe('colleague-updated') // theirs preserved
  })

  it('a created entity (no baseline) replays whole when the model does not hold it', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'created-offline'))
    journal.recordUpsert(WS, 'connection', 'c1', conn('c1', 'flows'))
    const plan = planEntityIntentReplay({ ...emptyReplayState, intents: journal.serialize(WS) })
    expect(plan.replayObjects.map((o) => o.name)).toEqual(['created-offline'])
    expect(plan.replayConnections.map((c) => c.label)).toEqual(['flows'])
    expect(plan.satisfied).toHaveLength(0)
  })

  it('a delete is satisfied only when tombstoned in meta AND gone from the model', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'object', 'gone')
    journal.recordDelete(WS, 'object', 'half-gone')
    journal.recordDelete(WS, 'connection', 'c-gone')
    const plan = planEntityIntentReplay({
      ...emptyReplayState,
      intents: journal.serialize(WS),
      currentObjects: new Map([['half-gone', obj('half-gone', 'still-here')]]),
      deletedObjectIds: new Set(['gone', 'half-gone']),
    })
    expect(plan.satisfied.map((s) => s.id)).toEqual(['gone'])
    expect(plan.replayDeleteObjectIds).toEqual(['half-gone'])
    expect(plan.replayDeleteConnectionIds).toEqual(['c-gone'])
  })

  it('an upsert over a durably tombstoned id also lifts the tombstone', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'recreated'))
    const plan = planEntityIntentReplay({
      ...emptyReplayState,
      intents: journal.serialize(WS),
      deletedObjectIds: new Set(['o1']),
    })
    expect(plan.replayObjects.map((o) => o.id)).toEqual(['o1'])
    expect(plan.unTombObjectIds).toEqual(['o1'])
  })
})

describe('splitResidentPlannableIntents — a delete never proves itself by absence', () => {
  const journalWith = (...records: Array<(j: PendingEntityIntents) => void>) => {
    const journal = new PendingEntityIntents()
    for (const record of records) record(journal)
    return journal.pending(WS)
  }

  it('DEFERS a delete whose id is absent from the local docs (the blocker scenario)', () => {
    // Session 1 (BFS, shards never loaded locally) deletes an entity that only
    // ever existed in the server copy; crash before the tombstone is durable.
    // Session 2 boots resident on a copy that does not contain the entity. If
    // that absence counted as the tombstone, the delete would be ACKNOWLEDGED
    // and sync would later resurrect the entity with the journal already
    // purged. A planner that plans every delete fails here.
    const intents = journalWith((j) => j.recordDelete(WS, 'object', 'ghost'))
    const { plannable, deferredDeletes } = splitResidentPlannableIntents(intents, new Map(), new Map())
    expect(plannable).toEqual([])
    expect(deferredDeletes).toHaveLength(1)
    expect(deferredDeletes[0].id).toBe('ghost')
    // And the planner, fed the plannable set with NO fabricated tombstones,
    // neither satisfies nor replays it — the journal keeps it.
    const plan = planEntityIntentReplay({ ...emptyReplayState, intents: plannable })
    expect(plan.satisfied).toEqual([])
    expect(plan.replayDeleteObjectIds).toEqual([])
  })

  it('PLANS a delete whose id IS present locally — removing it emits a real CRDT delete', () => {
    const intents = journalWith((j) => j.recordDelete(WS, 'connection', 'c1'))
    const current = new Map([['c1', conn('c1', 'kill me')]])
    const { plannable, deferredDeletes } = splitResidentPlannableIntents(intents, new Map(), current)
    expect(deferredDeletes).toEqual([])
    const plan = planEntityIntentReplay({
      ...emptyReplayState, intents: plannable, currentConnections: current,
    })
    expect(plan.replayDeleteConnectionIds).toEqual(['c1'])
    expect(plan.satisfied).toEqual([])
  })

  it('leaves upserts alone in both directions (absent → replay is the SAFE direction)', () => {
    const intents = journalWith(
      (j) => j.recordUpsert(WS, 'object', 'o1', obj('o1', 'wanted')),
      (j) => j.recordDelete(WS, 'object', 'gone'),
    )
    const { plannable, deferredDeletes } = splitResidentPlannableIntents(intents, new Map(), new Map())
    expect(plannable.map((intent) => intent.id)).toEqual(['o1'])
    expect(deferredDeletes.map((intent) => intent.id)).toEqual(['gone'])
    const plan = planEntityIntentReplay({ ...emptyReplayState, intents: plannable })
    expect(plan.replayObjects.map((o) => o.id)).toEqual(['o1'])
  })
})

describe('forgetIntentsOnceDurable — the ordering that makes the journal a journal', () => {
  it('a flush that NEVER settles keeps the intents forever', async () => {
    // Fails if intents are acknowledged before (or without) the carrier flush.
    let forgot = false
    let persisted = false
    void forgetIntentsOnceDurable(
      () => new Promise(() => { /* the adapter save that never completes */ }),
      () => { forgot = true },
      async () => { persisted = true },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(forgot).toBe(false)
    expect(persisted).toBe(false)
  })

  it('a flush that REJECTS forgets nothing and propagates', async () => {
    let forgot = false
    await expect(forgetIntentsOnceDurable(
      () => Promise.reject(new Error('adapter save failed')),
      () => { forgot = true },
      async () => { /* unreachable */ },
    )).rejects.toThrow('adapter save failed')
    expect(forgot).toBe(false)
  })

  it('a flush that resolves forgets THEN persists, in that order', async () => {
    const order: string[] = []
    await forgetIntentsOnceDurable(
      async () => { order.push('flush') },
      () => { order.push('forget') },
      async () => { order.push('persist') },
    )
    expect(order).toEqual(['flush', 'forget', 'persist'])
  })
})

describe('persistence — per-tab keys + registry (IndexedDB via KvStore)', () => {
  it('persists under THIS tab\'s key, registers the tab, and cleans both when drained', async () => {
    const store = createMemoryKvStore()
    const ws = `${WS}:tabkey`
    pendingEntityIntents.recordUpsert(ws, 'object', 'o1', obj('o1', 'durable-intent'))
    await persistEntityIntents(store, ws)
    const ownKey = `pending-entity-intents:v4:tab:${entityIntentTabId}`
    expect(await store.get(ownKey)).toHaveLength(1)
    expect(await store.get('pending-entity-intents:v4:tabs')).toContain(entityIntentTabId)

    pendingEntityIntents.acknowledge(ws, 'object', ['o1'], pendingEntityIntents.revisionNow)
    await flushEntityIntentPersistence(store, ws)
    expect(await store.get(ownKey)).toBeUndefined()
    // Deregistration is an atomic SUBTRACT, never a delete of the whole key —
    // a concurrent sibling registration must survive it.
    expect(await store.get('pending-entity-intents:v4:tabs')).toEqual([])
  })

  it('registry mutations never recompose from a stale read: a registration landing MID-hydration survives', async () => {
    const base = createMemoryKvStore()
    const ws = `${WS}:race`
    await base.set('pending-entity-intents:v4:tab:dead-tab', [{
      workspaceKey: ws, revision: 1, recordedAt: Date.now(),
      kind: 'object', op: 'upsert', id: 'oR', snapshot: obj('oR', 'orphan'),
    } satisfies SerializedEntityIntent])
    await base.set('pending-entity-intents:v4:tabs', ['dead-tab'])
    // Interleaving harness: the instant hydration performs its FIRST registry
    // read, a sibling tab registers 'live-late'. A survivor write recomposed
    // from that first read would erase the registration — stranding the
    // sibling's journal key forever if it crashes before re-persisting.
    let raced = false
    const store = {
      ...base,
      get: async <T,>(key: string): Promise<T | undefined> => {
        const value = await base.get<T>(key)
        if (key === 'pending-entity-intents:v4:tabs' && !raced) {
          raced = true
          await base.update<string[]>('pending-entity-intents:v4:tabs', (tabs) => [...(tabs ?? []), 'live-late'])
        }
        return value
      },
    }
    await hydrateEntityIntents(store, ws)
    const registry = await base.get<string[]>('pending-entity-intents:v4:tabs')
    expect(registry).toContain('live-late')
    expect(registry).not.toContain('dead-tab')
    pendingEntityIntents.acknowledge(ws, 'object', ['oR'], pendingEntityIntents.revisionNow)
    await flushEntityIntentPersistence(store, ws)
  })

  it('adopts a crashed tab\'s journal at hydration, re-homes it, and drops the orphan key', async () => {
    const store = createMemoryKvStore()
    const ws = `${WS}:adopt`
    // A previous page load (different tab id) died with one pending intent.
    const crashed: SerializedEntityIntent = {
      workspaceKey: ws, revision: 42, recordedAt: Date.now(),
      kind: 'object', op: 'upsert', id: 'oX', snapshot: obj('oX', 'from-crashed-tab'),
    }
    await store.set('pending-entity-intents:v4:tab:dead-tab', [crashed])
    await store.set('pending-entity-intents:v4:tabs', ['dead-tab'])

    await hydrateEntityIntents(store, ws)
    expect(pendingEntityIntents.hasPending(ws)).toBe(true)
    const [only] = pendingEntityIntents.pending(ws)
    expect(upsertName(only)).toBe('from-crashed-tab')
    // Re-homed under OUR key; the orphan key is EMPTIED (a conditional atomic
    // update, never a blind delete); registry no longer lists the dead tab.
    expect(await store.get('pending-entity-intents:v4:tab:dead-tab')).toEqual([])
    expect(await store.get(`pending-entity-intents:v4:tab:${entityIntentTabId}`)).toHaveLength(1)
    expect(await store.get('pending-entity-intents:v4:tabs')).toEqual([entityIntentTabId])

    pendingEntityIntents.acknowledge(ws, 'object', ['oX'], pendingEntityIntents.revisionNow)
    await flushEntityIntentPersistence(store, ws)
  })

  it('adoption never wipes a LIVE sibling that re-recorded mid-adoption', async () => {
    // The first draft deleted foreign keys outright: a sibling that recorded a
    // new intent between our read and our delete lost it from disk — the
    // stale-read disease one level above the registry. The conditional atomic
    // empty must leave the newer content untouched AND keep the sibling
    // registered.
    const base = createMemoryKvStore()
    const ws = `${WS}:live-adopt`
    const staleEntry: SerializedEntityIntent = {
      workspaceKey: ws, revision: 1, recordedAt: 1_000,
      kind: 'object', op: 'upsert', id: 'oA', snapshot: obj('oA', 'adopted-old'),
    }
    const newerEntry: SerializedEntityIntent = {
      workspaceKey: ws, revision: 2, recordedAt: 2_000,
      kind: 'object', op: 'upsert', id: 'oB', snapshot: obj('oB', 'recorded-mid-adoption'),
    }
    await base.set('pending-entity-intents:v4:tab:live-sib', [staleEntry])
    await base.set('pending-entity-intents:v4:tabs', ['live-sib'])
    let raced = false
    const store = {
      ...base,
      get: async <T,>(key: string): Promise<T | undefined> => {
        const value = await base.get<T>(key)
        if (key === 'pending-entity-intents:v4:tab:live-sib' && !raced) {
          raced = true
          // The live sibling records a NEW intent right after our read.
          await base.set('pending-entity-intents:v4:tab:live-sib', [staleEntry, newerEntry])
        }
        return value
      },
    }
    await hydrateEntityIntents(store, ws)
    // The sibling's key kept its newer content — nothing was wiped.
    const sibling = await base.get<SerializedEntityIntent[]>('pending-entity-intents:v4:tab:live-sib')
    expect(sibling?.map((entry) => entry.id)).toEqual(['oA', 'oB'])
    // And it stays registered, so its journal remains adoptable later.
    expect(await base.get('pending-entity-intents:v4:tabs')).toContain('live-sib')
    // We still adopted the stale entry we DID read.
    expect(pendingEntityIntents.pending(ws).map((entry) => entry.id)).toContain('oA')
    pendingEntityIntents.acknowledge(ws, 'object', ['oA'], pendingEntityIntents.revisionNow)
    await flushEntityIntentPersistence(store, ws)
  })

  it('a sibling tab persisting an empty journal does not erase this tab\'s key', async () => {
    const store = createMemoryKvStore()
    const ws = `${WS}:sibling`
    // Another live tab holds a pending intent under its own key.
    await store.set('pending-entity-intents:v4:tab:live-sibling', [{
      workspaceKey: ws, revision: 1, recordedAt: Date.now(),
      kind: 'object', op: 'upsert', id: 'oS', snapshot: obj('oS', 'sibling-pending'),
    } satisfies SerializedEntityIntent])
    await store.set('pending-entity-intents:v4:tabs', ['live-sibling'])
    // THIS tab has nothing pending and persists (e.g. after an ack).
    await persistEntityIntents(store, ws)
    expect(await store.get('pending-entity-intents:v4:tab:live-sibling')).toHaveLength(1)
    expect(await store.get('pending-entity-intents:v4:tabs')).toContain('live-sibling')
  })
})

// ── the small-collection families (groups/domains/tagSnapshots/ADRs) ─────────

function group(id: string, name: string, extra: Record<string, unknown> = {}): Group {
  return { id, name, objectIds: [], ...extra } as unknown as Group
}

function adr(id: string, title: string, extra: Record<string, unknown> = {}): DecisionRecord {
  return {
    id, number: 1, title, summary: '', status: 'proposed', author: '',
    content: '', createdAt: 't0', updatedAt: 't0', ...extra,
  } as unknown as DecisionRecord
}

function tagSnap(tagId: string, label: string): Tag {
  return { tagId, id: tagId, label } as unknown as Tag
}

const emptySmallCurrent = () => ({
  group: new Map<string, Record<string, unknown>>(),
  domain: new Map<string, Record<string, unknown>>(),
  tagSnapshot: new Map<string, Record<string, unknown>>(),
  decisionRecord: new Map<string, Record<string, unknown>>(),
})

describe('small-collection journal (round 8)', () => {
  it('records, counts and latest-wins the new kinds exactly like entities — the badge is free', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'group', 'g1', group('g1', 'v1'))
    journal.recordUpsert(WS, 'group', 'g1', group('g1', 'v2'))
    journal.recordDelete(WS, 'domain', 'd1')
    journal.recordUpsert(WS, 'tagSnapshot', 'tag-a', tagSnap('tag-a', 'A'))
    journal.recordUpsert(WS, 'decisionRecord', 'adr1', adr('adr1', 'Choose DB'))
    // Latest-wins per kind:id — g1 collapsed to one entry.
    expect(journal.pendingCount(WS)).toBe(4)
    // A delete replaces a pending upsert across the new kinds too.
    journal.recordDelete(WS, 'group', 'g1')
    expect(journal.pending(WS).find((i) => i.kind === 'group' && i.id === 'g1')?.op).toBe('delete')
  })

  it('adopts a LEGACY v2 journal at hydration — a pre-round-8 build must never read the new kinds', async () => {
    // Storage bumped to v3 because the old planner dispatches binary
    // (`kind === 'object' ? … : connection`): a rolled-back build hydrating a
    // 'group' upsert would write the Group into the CONNECTION overlay shard.
    // Old builds see only v2; new builds adopt
    // leftover v2 journals like any crashed sibling tab's.
    const store = createMemoryKvStore()
    const crashedV2: SerializedEntityIntent = {
      workspaceKey: WS, revision: 4, recordedAt: 100,
      kind: 'object', op: 'upsert', id: 'legacy-o1', snapshot: obj('legacy-o1', 'from-v2'),
    }
    await store.set('pending-entity-intents:v2:tab:old-build-tab', [crashedV2])
    await store.set('pending-entity-intents:v2:tabs', ['old-build-tab'])
    await hydrateEntityIntents(store, WS)
    try {
      const hydrated = pendingEntityIntents.pending(WS).find((entry) => entry.id === 'legacy-o1')
      expect(hydrated).toBeTruthy()
      // Re-homed under the v3 namespace; the v2 key emptied, its registry pruned.
      expect(await store.get(`pending-entity-intents:v4:tab:${entityIntentTabId}`)).toBeTruthy()
      expect(await store.get('pending-entity-intents:v2:tab:old-build-tab')).toEqual([])
      expect(await store.get('pending-entity-intents:v2:tabs')).toEqual([])
    } finally {
      pendingEntityIntents.acknowledge(WS, 'object', ['legacy-o1'], pendingEntityIntents.revisionNow)
      await persistEntityIntents(store, WS)
    }
  })

  it('adopts a LEGACY v3 journal at hydration — a round-8 build must never read the diagram kinds', async () => {
    // Storage bumped to v4 because the v3-era entity dispatch is the
    // NEGATIVE `!isSmallCollectionKind(kind)`: a hydrated 'flow' upsert would
    // fall through and be planned as a CONNECTION. Old builds see only v3/v2;
    // this build adopts leftover v3 journals like any crashed sibling tab's.
    const store = createMemoryKvStore()
    const crashedV3: SerializedEntityIntent = {
      workspaceKey: WS, revision: 6, recordedAt: 200,
      kind: 'group', op: 'upsert', id: 'legacy-g1', snapshot: group('legacy-g1', 'from-v3'),
    }
    await store.set('pending-entity-intents:v3:tab:round8-tab', [crashedV3])
    await store.set('pending-entity-intents:v3:tabs', ['round8-tab'])
    await hydrateEntityIntents(store, WS)
    try {
      const hydrated = pendingEntityIntents.pending(WS).find((entry) => entry.id === 'legacy-g1')
      expect(hydrated).toBeTruthy()
      expect(await store.get(`pending-entity-intents:v4:tab:${entityIntentTabId}`)).toBeTruthy()
      expect(await store.get('pending-entity-intents:v3:tab:round8-tab')).toEqual([])
      expect(await store.get('pending-entity-intents:v3:tabs')).toEqual([])
    } finally {
      pendingEntityIntents.acknowledge(WS, 'group', ['legacy-g1'], pendingEntityIntents.revisionNow)
      await persistEntityIntents(store, WS)
    }
  })

  it('the entity planner admission is POSITIVE: an unknown kind is parked, never planned as a connection', () => {
    // The guard the bridge dispatch filters use. A negative filter
    // (`!isSmallCollectionKind`) would route any future kind into the binary
    // object/connection planner — a 'flow' would be written into the
    // connection overlay shard.
    expect(isEntityPlannerKind('object')).toBe(true)
    expect(isEntityPlannerKind('connection')).toBe(true)
    expect(isEntityPlannerKind('group')).toBe(false)
    expect(isEntityPlannerKind('comment')).toBe(false)
    expect(isEntityPlannerKind('flow')).toBe(false)
    expect(isEntityPlannerKind('diagram')).toBe(false)
    expect(isEntityPlannerKind('hologram' as never)).toBe(false)
  })

  it('pendingCreation is true only while the pending intent is a baseline-less upsert', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'diagram', 'dNew', { id: 'dNew', name: 'Fresh', type: 'container', objectIds: [], connectionIds: [], groupIds: [] })
    expect(journal.pendingCreation(WS, 'diagram', 'dNew')).toBe(true)
    journal.recordDelete(WS, 'diagram', 'dNew')
    expect(journal.pendingCreation(WS, 'diagram', 'dNew')).toBe(false)
    expect(journal.pendingCreation(WS, 'diagram', 'absent')).toBe(false)
    journal.recordUpsert(
      WS, 'group', 'g1', group('g1', 'edited'), group('g1', 'durable'),
    )
    expect(journal.pendingCreation(WS, 'group', 'g1')).toBe(false)
  })

  it('an op flip on a pending intent demands immediate persistence (pendingOp)', () => {
    const journal = new PendingEntityIntents()
    journal.recordDelete(WS, 'group', 'g1')
    expect(journal.pendingOp(WS, 'group', 'g1')).toBe('delete')
    // The undo/re-create: until this persists, the DISK holds the delete —
    // a hard kill inside the coalescing window would replay a delete of an
    // entity the user just restored. The capture layer reads
    // this to force persistEntityIntentsNow.
    journal.recordUpsert(WS, 'group', 'g1', group('g1', 'restored'))
    expect(journal.pendingOp(WS, 'group', 'g1')).toBe('upsert')
    expect(journal.pendingOp(WS, 'group', 'missing')).toBeNull()
  })

  it('round-trips the new kinds through persistence and hydration', async () => {
    const store = createMemoryKvStore()
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'group', 'g1', group('g1', 'crashed'), group('g1', 'base'))
    journal.recordDelete(WS, 'decisionRecord', 'adr9')
    const key = `pending-entity-intents:v4:tab:${entityIntentTabId}`
    await store.set(key, journal.serialize(WS))
    const revived = new PendingEntityIntents()
    revived.hydrate(WS, await store.get(key))
    expect(revived.pendingCount(WS)).toBe(2)
    const g = revived.pending(WS).find((i) => i.kind === 'group')
    expect(g?.op).toBe('upsert')
    expect(g && g.op === 'upsert' ? (g.baseline as Group | undefined)?.name : null).toBe('base')
  })

  describe('planSmallCollectionIntentReplay', () => {
    const intentFor = (journal: PendingEntityIntents) => journal.pending(WS)

    it('acknowledges a deep-equal value without re-writing, replays a missing one whole', () => {
      const journal = new PendingEntityIntents()
      journal.recordUpsert(WS, 'group', 'g1', group('g1', 'durable'))
      journal.recordUpsert(WS, 'group', 'g2', group('g2', 'lost'))
      const current = emptySmallCurrent()
      current.group.set('g1', group('g1', 'durable') as unknown as Record<string, unknown>)
      const plan = planSmallCollectionIntentReplay({
        intents: intentFor(journal), current, deletedDecisionRecordIds: new Set(),
      })
      expect(plan.satisfied.map((s) => s.id)).toEqual(['g1'])
      expect(plan.replayUpserts.group.map((g) => (g as { id: string }).id)).toEqual(['g2'])
    })

    it('replays per-FIELD onto the current value: a colleague edit to an untouched field survives', () => {
      const journal = new PendingEntityIntents()
      // Local crash-journaled edit: renamed the group (name base->mine), color untouched.
      journal.recordUpsert(
        WS, 'group', 'g1',
        group('g1', 'mine', { color: 'blue' }),
        group('g1', 'base', { color: 'blue' }),
      )
      // Meanwhile a colleague recolored it (durable value).
      const current = emptySmallCurrent()
      current.group.set('g1', group('g1', 'base', { color: 'red' }) as unknown as Record<string, unknown>)
      const plan = planSmallCollectionIntentReplay({
        intents: intentFor(journal), current, deletedDecisionRecordIds: new Set(),
      })
      expect(plan.replayUpserts.group).toHaveLength(1)
      const merged = plan.replayUpserts.group[0] as { name: string; color: string }
      expect(merged.name).toBe('mine')
      expect(merged.color).toBe('red')
    })

    it('plans a full-set-family delete even when the target is already absent — removing an absent key is a no-op, deferring would hold the badge forever', () => {
      const journal = new PendingEntityIntents()
      journal.recordDelete(WS, 'group', 'g-gone')
      journal.recordDelete(WS, 'domain', 'd-gone')
      const plan = planSmallCollectionIntentReplay({
        intents: intentFor(journal), current: emptySmallCurrent(), deletedDecisionRecordIds: new Set(),
      })
      expect(plan.replayDeletes.group).toEqual(['g-gone'])
      expect(plan.replayDeletes.domain).toEqual(['d-gone'])
      expect(plan.satisfied).toHaveLength(0)
    })

    it('ADR deletes have a positive artifact: tombstoned AND absent is satisfied, anything else replays', () => {
      const journal = new PendingEntityIntents()
      journal.recordDelete(WS, 'decisionRecord', 'adr-done')
      journal.recordDelete(WS, 'decisionRecord', 'adr-pending')
      const current = emptySmallCurrent()
      current.decisionRecord.set('adr-pending', adr('adr-pending', 'still here') as unknown as Record<string, unknown>)
      const plan = planSmallCollectionIntentReplay({
        intents: intentFor(journal), current,
        deletedDecisionRecordIds: new Set(['adr-done']),
      })
      expect(plan.satisfied.map((s) => s.id)).toEqual(['adr-done'])
      expect(plan.replayDeletes.decisionRecord).toEqual(['adr-pending'])
    })

    it('an ADR upsert over a durable tombstone lifts it, or a delta-mode meta keeps excluding the record', () => {
      const journal = new PendingEntityIntents()
      journal.recordUpsert(WS, 'decisionRecord', 'adr1', adr('adr1', 'revived'))
      const plan = planSmallCollectionIntentReplay({
        intents: intentFor(journal), current: emptySmallCurrent(),
        deletedDecisionRecordIds: new Set(['adr1']),
      })
      expect(plan.replayUpserts.decisionRecord).toHaveLength(1)
      expect(plan.unTombDecisionRecordIds).toEqual(['adr1'])
    })

    it('skips an UNKNOWN kind cleanly instead of poisoning the pass (closed-world guard)', () => {
      // With an open-world `kind !== object/connection` check, a hydrated
      // intent of a FUTURE kind would classify as small-collection, throw on
      // the missing `current` map, and the caught throw would abort the whole
      // replay forever — one poison record disabling recovery while the badge
      // counts it.
      const journal = new PendingEntityIntents()
      journal.hydrate(WS, [{
        workspaceKey: WS, revision: 5, recordedAt: 10,
        kind: 'flow' as never, op: 'upsert' as const, id: 'f1',
        snapshot: { id: 'f1' } as never,
      } as SerializedEntityIntent])
      journal.recordUpsert(WS, 'group', 'g1', group('g1', 'ok'))
      const plan = planSmallCollectionIntentReplay({
        intents: journal.pending(WS), current: emptySmallCurrent(), deletedDecisionRecordIds: new Set(),
      })
      // The unknown kind is neither replayed nor satisfied — it stays
      // journaled, waiting for a build that knows it — and the known intent
      // still plans.
      expect(plan.replayUpserts.group).toHaveLength(1)
      expect(plan.satisfied).toHaveLength(0)
    })

    it('treats a value that already carries every changed field as satisfied (merge predicate)', () => {
      // Raw equality would call a previously-MERGED value unsatisfied forever:
      // snapshot {name:mine,color:blue}, durable {name:mine,color:red} (a
      // colleague recolored; an earlier replay already asserted the rename).
      // Nothing of the user's edit is missing — re-planning it would loop.
      const journal = new PendingEntityIntents()
      journal.recordUpsert(
        WS, 'group', 'g1',
        group('g1', 'mine', { color: 'blue' }),
        group('g1', 'base', { color: 'blue' }),
      )
      const current = emptySmallCurrent()
      current.group.set('g1', group('g1', 'mine', { color: 'red' }) as unknown as Record<string, unknown>)
      const plan = planSmallCollectionIntentReplay({
        intents: journal.pending(WS), current, deletedDecisionRecordIds: new Set(),
      })
      expect(plan.satisfied.map((s) => s.id)).toEqual(['g1'])
      expect(plan.replayUpserts.group).toHaveLength(0)
    })

    it('ignores object/connection intents — they belong to the entity planner', () => {
      const journal = new PendingEntityIntents()
      journal.recordUpsert(WS, 'object', 'o1', obj('o1', 'x'))
      journal.recordUpsert(WS, 'group', 'g1', group('g1', 'y'))
      const plan = planSmallCollectionIntentReplay({
        intents: intentFor(journal), current: emptySmallCurrent(), deletedDecisionRecordIds: new Set(),
      })
      expect(plan.replayUpserts.group).toHaveLength(1)
      expect(plan.replayDeletes.group).toHaveLength(0)
      // No object leaked into any small-collection bucket.
      const total = Object.values(plan.replayUpserts).reduce((n, list) => n + list.length, 0)
      expect(total).toBe(1)
    })
  })
})
