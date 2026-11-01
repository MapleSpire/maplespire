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

/** QA lens, 2026-10-31: unit cases that kill mutants the repoint-carry
 * battery left alive (see the QA report for the mutant ids). */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PendingEntityIntents,
  planCarriedUpsert,
  planDiagramCollectionIntentReplay,
  planSmallCollectionIntentReplay,
  type SerializedEntityIntent,
} from './entityIntents'
import { planDiagramStubReplay } from './diagramStubCapture'
import { PendingPlacementIntents } from './placementIntents'
import { ActiveDocumentShare } from './activeDocumentShare'
import {
  ensureMintedIdCapacity,
  mintedIdSupplyStats,
  noteMintedIdSupplyWorkspace,
  POOL_TARGET,
  startMintedIdSupply,
  stopMintedIdSupply,
  takeMintedDocumentIdBytes,
} from './mintedIdSupply'
import { createMemoryKvStore, workspaceKvStore, __setWorkspaceKvBaseForTest } from '../modelQuery/kvStore'
import { apiFetch } from '../api/http'
import type { DocumentId } from '@automerge/automerge-repo'

vi.mock('../api/http', () => ({ apiFetch: vi.fn() }))
const apiFetchMock = vi.mocked(apiFetch)

const WS = 'L/current'
const V1 = 'L/V1'
const V2 = 'L/V2'
const mark = (workspace: string | null) => ({ workspace, carriers: [{ documentId: 'carrier', heads: ['h1'] }] })
const ALL = Number.MAX_SAFE_INTEGER
const obj = (name: string, extra: Record<string, unknown> = {}) => ({
  id: 'o1', type: 'system', name, position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  tagAssignments: {}, tagOrder: [], properties: {}, ...extra,
}) as any

describe('entity journal — SENT stage edges', () => {
  it('createIfAbsent survives a CHAIN of SENT edits over a SENT creation (E13)', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('created'))
    journal.markSent(WS, 'object', ['o1'], ALL, mark(V1))
    journal.recordUpsert(WS, 'object', 'o1', obj('edit 1'), obj('created'))
    journal.markSent(WS, 'object', ['o1'], ALL, mark(V1))
    journal.recordUpsert(WS, 'object', 'o1', obj('edit 2'), obj('edit 1'))
    expect(journal.pending(WS)[0].createIfAbsent, 'the creation owed by the chain was forgotten').toBe(true)
  })

  it('a newer pending record is never overwritten by its own older SENT copy on a requeue (E15)', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('sent'))
    journal.markSent(WS, 'object', ['o1'], ALL, mark(V1))
    journal.recordUpsert(WS, 'object', 'o1', obj('newer'), obj('sent'))
    journal.requeueSent(WS, V2)
    const pending = journal.pending(WS)
    expect(pending).toHaveLength(1)
    expect((pending[0] as any).snapshot.name).toBe('newer')
  })

  it('a mark whose heads are not strings is not trusted: the intent hydrates PENDING (E18)', () => {
    const journal = new PendingEntityIntents()
    journal.hydrate(WS, [{
      workspaceKey: WS, kind: 'object', id: 'o1', op: 'upsert', revision: 1, recordedAt: 1,
      snapshot: obj('x'), sent: { workspace: V1, carriers: [{ documentId: 'd', heads: [42] }] },
    } as any])
    expect(journal.sentCount(WS)).toBe(0)
    expect(journal.pendingCount(WS)).toBe(1)
  })

  it('a STALE pending copy from disk never clobbers a newer SENT one held in memory (E20)', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'object', 'o1', obj('sent'))
    const [held] = journal.serialize(WS)
    journal.markSent(WS, 'object', ['o1'], ALL, mark(V1))
    journal.hydrate(WS, [{ ...held, recordedAt: held.recordedAt - 1 } as SerializedEntityIntent])
    expect(journal.sentCount(WS)).toBe(1)
    expect(journal.pendingCount(WS)).toBe(0)
  })
})

describe('carried replay planners', () => {
  it('a field the user DELETED is deleted when the new version still holds the baseline value (E28)', () => {
    const decision = planCarriedUpsert({
      snapshot: { id: 'x', a: 1 },
      baseline: { id: 'x', a: 1, b: 2 },
      current: { id: 'x', a: 1, b: 2 } as Record<string, unknown>,
      tombstoned: false,
      createIfAbsent: false,
    })
    expect(decision).toEqual({ write: true, value: { id: 'x', a: 1 }, created: false })
  })

  it('small collections: a carried ADR creation does not resurrect an ADR the new version tombstoned (E31)', () => {
    const journal = new PendingEntityIntents()
    journal.recordUpsert(WS, 'decisionRecord', 'adr1', { id: 'adr1', title: 'Mine' } as any)
    journal.markSent(WS, 'decisionRecord', ['adr1'], ALL, mark(V1))
    journal.requeueSent(WS, V2)
    const plan = planSmallCollectionIntentReplay({
      intents: journal.pending(WS),
      current: { group: new Map(), domain: new Map(), tagSnapshot: new Map(), decisionRecord: new Map() },
      deletedDecisionRecordIds: new Set(['adr1']),
    })
    expect(plan.replayUpserts.decisionRecord).toEqual([])
    expect(plan.unTombDecisionRecordIds).toEqual([])
    expect(plan.satisfied.map((s) => s.id)).toEqual(['adr1'])
  })

  it('diagram collections: a carried edit is conflict-averse, and creates when the creation is owed (E32, E35)', () => {
    const journal = new PendingEntityIntents()
    const comment = (text: string, extra: Record<string, unknown> = {}) => ({ id: 'c1', diagramId: 'd1', text, ...extra }) as any
    // c1: created and SENT, then edited — the edit owes the creation.
    journal.recordUpsert(WS, 'comment', 'c1', comment('created'))
    journal.markSent(WS, 'comment', ['c1'], ALL, mark(V1))
    journal.recordUpsert(WS, 'comment', 'c1', comment('edited'), comment('created'))
    // c2: an edit of a comment someone else changed in the new version since.
    journal.recordUpsert(WS, 'comment', 'c2', { ...comment('mine'), id: 'c2' }, { ...comment('base'), id: 'c2' })
    journal.markSent(WS, 'comment', ['c1', 'c2'], ALL, mark(V1))
    journal.requeueSent(WS, V2)
    const plan = planDiagramCollectionIntentReplay({
      intents: journal.pending(WS),
      activeDiagramId: 'd1',
      current: { comment: new Map([['c2', { ...comment('theirs'), id: 'c2' }]]), flow: new Map() },
    })
    expect(plan.replayUpserts.comment.map((c: any) => [c.id, c.text])).toEqual([['c1', 'edited']])
    expect(plan.satisfied.map((s) => s.id)).toEqual(['c2'])
  })

  describe('diagram stubs (S01-S04)', () => {
    const stub = (id: string, name: string) => ({ id, name, type: 'context', docUrl: '', objectIds: [], connectionIds: [], groupIds: [], layouts: {} }) as any
    const carriedJournal = (record: (journal: PendingEntityIntents) => void) => {
      const journal = new PendingEntityIntents()
      record(journal)
      journal.markSent(WS, 'diagram', ['d1'], ALL, mark(V1))
      journal.requeueSent(WS, V2)
      return journal.pending(WS)
    }

    it('a carried creation never lifts the new version\'s tombstone', () => {
      const plan = planDiagramStubReplay({
        intents: carriedJournal((j) => j.recordUpsert(WS, 'diagram', 'd1', stub('d1', 'Mine'))),
        currentMetaStubs: new Map(), metasComplete: true, tombstonedIds: new Set(['d1']),
      })
      expect(plan.replayCreates).toEqual([])
      expect(plan.replayLifts).toEqual([])
      expect(plan.satisfied.map((s) => s.id)).toEqual(['d1'])
    })

    it('a carried rename of a diagram someone renamed in the new version since is NOT written', () => {
      const plan = planDiagramStubReplay({
        intents: carriedJournal((j) => j.recordUpsert(WS, 'diagram', 'd1', stub('d1', 'Mine'), stub('d1', 'Base'))),
        currentMetaStubs: new Map([['d1', { name: 'Theirs', type: 'context' }]]), metasComplete: true,
      })
      expect(plan.replayStubPatches).toEqual([])
      expect(plan.satisfied.map((s) => s.id)).toEqual(['d1'])
    })

    it('a carried delete of a present diagram is replayed', () => {
      const plan = planDiagramStubReplay({
        intents: carriedJournal((j) => j.recordDelete(WS, 'diagram', 'd1')),
        currentMetaStubs: new Map([['d1', { name: 'Base', type: 'context' }]]), metasComplete: true,
      })
      expect(plan.replayDeletes).toEqual(['d1'])
    })

    it('a carried edit that owes a SENT creation creates the diagram the new version lacks', () => {
      const journal = new PendingEntityIntents()
      journal.recordUpsert(WS, 'diagram', 'd1', stub('d1', 'Created'))
      journal.markSent(WS, 'diagram', ['d1'], ALL, mark(V1))
      journal.recordUpsert(WS, 'diagram', 'd1', stub('d1', 'Renamed'), stub('d1', 'Created'))
      journal.markSent(WS, 'diagram', ['d1'], ALL, mark(V1))
      journal.requeueSent(WS, V2)
      const plan = planDiagramStubReplay({ intents: journal.pending(WS), currentMetaStubs: new Map(), metasComplete: true })
      expect(plan.replayCreates.map((d) => [d.id, d.name])).toEqual([['d1', 'Renamed']])
    })

    // FINDING, RED on d904e7a1. Under a summary WINDOW absence proves nothing
    // (the ordinary branch RETAINS such an intent), but the carried branch
    // satisfied it — and a satisfied carried intent is marked SENT on the V2
    // shards and released once the server holds them: gone.
    it('a carried rename of a diagram outside the summary WINDOW is retained, not satisfied', () => {
      const plan = planDiagramStubReplay({
        intents: carriedJournal((j) => j.recordUpsert(WS, 'diagram', 'd1', stub('d1', 'Mine'), stub('d1', 'Base'))),
        currentMetaStubs: new Map(), metasComplete: false,
      })
      expect(plan.satisfied, 'dropped on an absence the window cannot prove').toEqual([])
      expect(plan.remaining).toBe(1)
    })

    it('a carried delete outside the window is re-expressed as a tombstone, or retained', () => {
      const intents = carriedJournal((j) => j.recordDelete(WS, 'diagram', 'd1'))
      const retained = planDiagramStubReplay({ intents, currentMetaStubs: new Map(), metasComplete: false })
      expect(retained.satisfied).toEqual([])
      expect(retained.remaining).toBe(1)
      const tombstone = planDiagramStubReplay({ intents, currentMetaStubs: new Map(), metasComplete: false, canTombstone: true })
      expect(tombstone.replayTombstones).toEqual(['d1'])
      expect(tombstone.satisfied).toEqual([])
      const already = planDiagramStubReplay({
        intents, currentMetaStubs: new Map(), metasComplete: false, canTombstone: true, tombstonedIds: new Set(['d1']),
      })
      expect(already.replayTombstones).toEqual([])
      expect(already.satisfied.map((s) => s.id)).toEqual(['d1'])
    })

    it('a carried creation outside the window still replays whole', () => {
      const plan = planDiagramStubReplay({
        intents: carriedJournal((j) => j.recordUpsert(WS, 'diagram', 'd1', stub('d1', 'Mine'))),
        currentMetaStubs: new Map(), metasComplete: false,
      })
      expect(plan.replayCreates.map((d) => d.id)).toEqual(['d1'])
      expect(plan.remaining).toBe(0)
    })
  })
})

describe('placement journal — SENT stage edges', () => {
  const drag = (x: number) => ({ objects: [{ id: 'o1', position: { x, y: 0 }, size: { width: 10, height: 10 } }] })

  it('a record SENT by a session that could not name its workspace is neither requeued (L04) nor unreleasable (L09)', () => {
    const intents = new PendingPlacementIntents()
    intents.record(WS, 'd1', '2d', drag(5))
    intents.markSentWhere(WS, 'd1', intents.revisionNow, () => true, mark(null))
    expect(intents.requeueSent(WS, V2)).toEqual([])
    expect(intents.sentCount(WS)).toBe(1)
    expect(intents.releaseSent(WS, V2, () => true)).toBe(1)
  })

  it('a requeued record gets a FRESH revision: an ack captured before the move does not retire it (L10)', () => {
    const intents = new PendingPlacementIntents()
    intents.record(WS, 'd1', '2d', drag(5))
    intents.markSentWhere(WS, 'd1', intents.revisionNow, () => true, mark(V1))
    const before = intents.revisionNow
    intents.requeueSent(WS, V2)
    intents.acknowledge(WS, 'd1', before)
    expect(intents.snapshot(WS, 'd1')?.objects[0].position.x).toBe(5)
  })

  it('a STALE pending copy from disk never clobbers a newer SENT one (L11)', () => {
    const intents = new PendingPlacementIntents()
    intents.record(WS, 'd1', '2d', drag(5))
    const [held] = intents.serialize(WS)
    intents.markSentWhere(WS, 'd1', intents.revisionNow, () => true, mark(V1))
    intents.hydrate(WS, [{ ...held, recordedAt: (held.recordedAt ?? 1) - 1 }])
    expect(intents.sentCount(WS)).toBe(1)
    expect(intents.pendingCount(WS)).toBe(0)
  })

  it('a malformed persisted mark keeps the record PENDING instead of aborting the adoption (L08)', () => {
    const intents = new PendingPlacementIntents()
    intents.record(WS, 'd1', '2d', drag(5))
    const [held] = intents.serialize(WS)
    const fresh = new PendingPlacementIntents()
    expect(() => fresh.hydrate(WS, [{ ...held, sent: { workspace: V1, carriers: 'garbage' } } as any])).not.toThrow()
    expect(fresh.pendingCount(WS)).toBe(1)
    expect(fresh.sentCount(WS)).toBe(0)
  })
})

describe('share withhold (A07)', () => {
  it('a withhold re-evaluates the documents it denies', async () => {
    const share = new ActiveDocumentShare()
    const changed = vi.fn()
    share.bindLeaseChanged(changed)
    share.beginSession('a/current')
    share.pin('doc' as DocumentId, 'durability-pending')
    await new Promise((resolve) => setTimeout(resolve, 0))
    changed.mockClear()
    share.withhold(['doc' as DocumentId])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(changed).toHaveBeenCalledWith(['doc'])
  })
})

describe('minted id supply after the note (M03, M04)', () => {
  const RESERVE_KEY = 'mintedIds/reserve@2'
  const REF = { landscapeId: 'default', versionId: 'current' }
  function fakeMintedId(marker: number): string {
    const bytes = new Uint8Array(24)
    bytes[0] = 1
    bytes[1] = marker & 0xff
    bytes[2] = (marker >> 8) & 0xff
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  }
  const markerOf = (id: Uint8Array): number => id[1]! + (id[2]! << 8)

  beforeEach(() => {
    __setWorkspaceKvBaseForTest(createMemoryKvStore())
    apiFetchMock.mockReset()
  })
  afterEach(() => {
    stopMintedIdSupply()
    __setWorkspaceKvBaseForTest(null)
  })

  it('ensureMintedIdCapacity after the note counts only the NEW version\'s ids, so the carried document gets one', async () => {
    await workspaceKvStore().set(RESERVE_KEY, {
      ids: Array.from({ length: POOL_TARGET }, (_v, i) => fakeMintedId(i + 1)), workspace: 'default/v1',
    })
    let next = 1000
    apiFetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const { count } = JSON.parse(String(init?.body)) as { count: number }
      const ids = Array.from({ length: count }, () => fakeMintedId(next++))
      return { ok: true, status: 200, json: async () => ({ landscapeId: 'default', versionId: 'v2', ids }) } as unknown as Response
    })
    startMintedIdSupply(REF)
    await vi.waitFor(() => expect(mintedIdSupplyStats().available).toBeGreaterThan(0))
    await noteMintedIdSupplyWorkspace('default/v2')
    await ensureMintedIdCapacity(1)
    const bytes = takeMintedDocumentIdBytes()
    expect(bytes, 'the carried document fell back to a random id').not.toBeNull()
    expect(markerOf(bytes!)).toBeGreaterThanOrEqual(1000)
  })
})
