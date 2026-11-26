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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import { countModelEpochBlockers, modelEpochGcRoots, type FencedTransaction } from './modelEpochStore.js'
import { __resetRetireWalkCursorsForTest, isRetiredEpochDocument, RETIRE_WALK_BUDGET_MS, retireModelEpochDocs, type RetireDeps } from './modelEpochRetire.js'
import { gatherModelEpochFacts } from '../maintenance/modelEpochFsck.js'
import type { WorkspaceKey } from './projector.js'

/**
 * G4-16f — RETIREMENT against a real schema: the
 * age, the quiet test, `live → retiring → retired`, `pinned` and back, the
 * epoch row retired with its last document, GC no longer marking a retiring
 * document, promotion no longer blocked, and the deferral alert past 2N.
 * Storage is the `durableHeads` port: a document is "swept" when it answers null.
 *
 * Isolated schema, TEST_DATABASE_URL; skips without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
const WS: WorkspaceKey = { landscapeId: 'ls-epoch-retire', versionId: 'v1' }
let db: IsolatedSchemaDb

const fenced: FencedTransaction = (fn) => fn(db.pool)

/** Epochs 0..last: 0 legacy, the last published, the others retained. Epoch
 * k CREATED `m<k>` (meta) and `b<k>` (base); epoch k+1 superseded them. */
async function epochs(last: number) {
  for (let k = 0; k <= last; k += 1) {
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [WS.landscapeId, WS.versionId, k, k === 0 ? 'legacy' : 'full', k === last ? 'published' : 'retained', k === 0 ? null : k - 1, `automerge:m${k}`])
    for (const [id, role] of [[`m${k}`, 'meta'], [`b${k}`, 'base']] as const) {
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, superseded_epoch, forward_cursor)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text[])`,
        [id, WS.landscapeId, WS.versionId, k, role, k === last ? null : k + 1, ['h']])
    }
  }
}
const state = async (id: string) => (await db.pool.query<{ state: string; pinned_by: string | null }>(
  'SELECT state, pinned_by FROM read_model_model_epoch_docs WHERE document_id = $1', [id])).rows[0]
const epochState = async (n: number) => (await db.pool.query<{ state: string }>(
  'SELECT state FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3', [WS.landscapeId, WS.versionId, n])).rows[0]?.state

function deps(storage: Map<string, string[] | null>, log: Array<Record<string, unknown>> = []): RetireDeps {
  return {
    db: db.pool, fenced, key: WS, config: { retain: 3, periodDays: 30 },
    durableHeads: async (id) => (storage.has(id) ? storage.get(id)! : ['h']),
    log: (e) => log.push(e),
  }
}

suite('model epoch retirement (G4-16f)', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'model_epoch_retire')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL)`)
    await db.pool.query(`INSERT INTO versions VALUES ('v1', 'ls-epoch-retire')`)
    await db.pool.query(`CREATE TABLE landscape_versions (id SERIAL PRIMARY KEY, manifest JSONB NOT NULL)`)
    await db.pool.query(`CREATE TABLE automerge_storage (key TEXT PRIMARY KEY, data BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
  })
  afterAll(async () => { await db?.teardown() })
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE read_model_model_epochs, read_model_model_epoch_docs, read_model_model_epoch_forwards, landscape_versions, automerge_storage`)
  })

  it('a late write landing AFTER the quiet check — GC keeps the retiring document, the next pass moves it back to live', async () => {
    await epochs(4)
    expect((await retireModelEpochDocs(deps(new Map()))).retiring.sort()).toEqual(['b0', 'm0'])
    // CONTROL: quiet in storage (no chunk = nothing to lose), GC sweeps it.
    expect((await modelEpochGcRoots(db.pool)).urls).not.toContain('automerge:b0')
    // The late write reaches storage between the check and GC: b0's durable
    // heads are no longer its cursor (['h']).
    await db.pool.query(`INSERT INTO automerge_storage (key, data) VALUES ('b0/snapshot/late', $1)`,
      [Buffer.from(A.save(A.from({ objects: { late: { id: 'late' } } })))])
    const roots = await modelEpochGcRoots(db.pool)
    expect(roots.urls).toContain('automerge:b0') // KEPT
    expect(roots.urls).not.toContain('automerge:m0') // still quiet: still swept
    // The next pass: back to `live` — a source the forwarder reads again.
    const log: Array<Record<string, unknown>> = []
    const report = await retireModelEpochDocs(deps(new Map([['b0', ['h', 'late']], ['m0', null]]), log))
    expect(report.revived).toEqual(['b0'])
    expect(report.retired).toEqual(['m0'])
    expect((await state('b0'))!.state).toBe('live')
    expect(log.find((e) => e.event === 'model_epoch.retire_revived')).toMatchObject({ documentId: 'b0', from: 'retiring' })
    // …and a PINNED one too.
    await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'pinned', pinned_by = 'manifest:1' WHERE document_id = 'b1'`)
    expect((await retireModelEpochDocs(deps(new Map([['b1', ['h', 'late']], ['b0', ['h', 'late']]])))).revived).toEqual(['b1'])
  })

  it('discard exports are pruned WITH RETIREMENT past their minimum retention, and past their maximum in any case', async () => {
    await epochs(4)
    await db.pool.query('TRUNCATE read_model_model_epoch_discards')
    const discard = (journal: string, source: string, daysAgo: number) => db.pool.query(
      `INSERT INTO read_model_model_epoch_discards (journal_id, landscape_id, version_id, source_document_id, payload, discarded_at)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, now() - ($5::int * interval '1 day'))`, [journal, WS.landscapeId, WS.versionId, source, daysAgo])
    await discard('young-of-retired', 'm0', 1) // its source retires below, but too young
    await discard('old-of-retired', 'b0', 40) // its source retires below: pruned
    await discard('old-of-live', 'm3', 40) // its source is live: kept
    await discard('ancient-of-live', 'b3', 200) // past the maximum: pruned
    await db.pool.query(`INSERT INTO read_model_model_epoch_discards (journal_id, landscape_id, version_id, source_document_id, payload, discarded_at)
      VALUES ('other-workspace', 'ls-other', 'v9', 'b0', '{}'::jsonb, now() - interval '400 days')`)
    const retention = { minMs: 30 * 86_400_000, maxMs: 180 * 86_400_000 }
    // Pass 1: b0 and m0 only RETIRING; the ancient export goes already.
    const first = await retireModelEpochDocs({ ...deps(new Map()), discardRetention: retention })
    expect(first.retiring.sort()).toEqual(['b0', 'm0'])
    expect(first.discardsPruned).toBe(1)
    expect((await db.pool.query('SELECT 1 FROM read_model_model_epoch_discards WHERE journal_id = $1', ['old-of-retired'])).rowCount).toBe(1)
    // Pass 2: swept, so RETIRED — the old export of b0 goes with it.
    const report = await retireModelEpochDocs({ ...deps(new Map([['b0', null], ['m0', null]])), discardRetention: retention })
    expect(report.retired.sort()).toEqual(['b0', 'm0'])
    expect(report.discardsPruned).toBe(1)
    const { rows } = await db.pool.query<{ journal_id: string }>('SELECT journal_id FROM read_model_model_epoch_discards ORDER BY journal_id')
    expect(rows.map((r) => r.journal_id)).toEqual(['old-of-live', 'other-workspace', 'young-of-retired'])
  })

  it('the walk\'s READS are bounded by its budget — the next pass resumes after the last one read, so every document is still visited', async () => {
    __resetRetireWalkCursorsForTest()
    await epochs(9) // m0..b5 are past N = 3 (age 4..9): 12 documents to read
    await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring' WHERE superseded_epoch <= 6`)
    let clock = 0
    const read: string[] = []
    // Each read costs 10 ms of the clock; the budget is 25 ms: three reads a pass.
    const budgeted = (): RetireDeps => ({
      ...deps(new Map()), budgetMs: 25, now: () => clock,
      durableHeads: async (id) => { read.push(id); clock += 10; return ['h'] },
    })
    const first = await retireModelEpochDocs(budgeted())
    expect(read).toHaveLength(3)
    // The walk's 18 superseded rows (epochs 0–8), 3 of them visited.
    expect(first.leftForNextPass).toBe(15)
    const passes = [first]
    for (let i = 0; i < 3; i += 1) passes.push(await retireModelEpochDocs(budgeted()))
    // Four passes: every one of the twelve read once, none twice.
    expect(read).toHaveLength(12)
    expect(new Set(read).size).toBe(12)
    expect(passes.every((p) => (p.leftForNextPass ?? 0) > 0)).toBe(true)
    // Without the cursor the same three would be read on every pass; with it
    // the fifth pass starts the round again.
    await retireModelEpochDocs(budgeted())
    expect(read.slice(12)).toEqual(read.slice(0, 3))
    // A budget that covers them all: one pass, nothing left.
    const all = await retireModelEpochDocs({ ...budgeted(), budgetMs: 10_000 })
    expect(read).toHaveLength(15 + 12)
    expect(all.leftForNextPass).toBeUndefined()
  })

  it('the cursor is a POSITION — the document last read retiring meanwhile, the next pass still resumes after it, not from the start', async () => {
    __resetRetireWalkCursorsForTest()
    await epochs(9)
    await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring' WHERE superseded_epoch <= 6`)
    let clock = 0
    const read: string[] = []
    const budgeted = (): RetireDeps => ({
      ...deps(new Map()), budgetMs: 25, now: () => clock,
      durableHeads: async (id) => { read.push(id); clock += 10; return ['h'] },
    })
    await retireModelEpochDocs(budgeted())
    expect(read).toHaveLength(3)
    // GC swept the last one read: the walk no longer lists it.
    await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retired' WHERE document_id = $1`, [read[2]])
    await retireModelEpochDocs(budgeted())
    expect(read.slice(3)).toHaveLength(3)
    expect(read.slice(3).some((id) => read.slice(0, 3).includes(id))).toBe(false)
  })

  it('the walk orders ids in BYTE order, as its cursor compares them — base58 ids differing only by case are all visited', async () => {
    __resetRetireWalkCursorsForTest()
    await epochs(9)
    await db.pool.query(`DELETE FROM read_model_model_epoch_docs`)
    // A linguistic collation (ICU: case folded first) orders these ab, Ab,
    // aZ, B1; the cursor's `>` (UTF-16 units, as "C") orders them Ab, B1,
    // aZ, ab — a walk ordered one way and resumed the other skips. The column
    // is given one for this test (the database's own default may be bytewise:
    // musl's `en_US.utf8` is).
    await db.pool.query(`ALTER TABLE read_model_model_epoch_docs ALTER COLUMN document_id TYPE text COLLATE "und-x-icu"`)
    const ids = ['ab', 'aZ', 'B1', 'Ab']
    for (const id of ids) {
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, superseded_epoch, forward_cursor, state)
         VALUES ($1, $2, $3, 0, 'base', 1, $4::text[], 'retiring')`,
        [id, WS.landscapeId, WS.versionId, ['h']])
    }
    let clock = 0
    const read: string[] = []
    // One read per pass.
    const budgeted = (): RetireDeps => ({
      ...deps(new Map()), budgetMs: 5, now: () => clock,
      durableHeads: async (id) => { read.push(id); clock += 10; return ['h'] },
    })
    try {
      for (let i = 0; i < ids.length; i += 1) await retireModelEpochDocs(budgeted())
      expect(read).toEqual(['Ab', 'B1', 'aZ', 'ab'])
    } finally {
      await db.pool.query(`ALTER TABLE read_model_model_epoch_docs ALTER COLUMN document_id TYPE text COLLATE "default"`)
    }
  })

  it('the default budget is 2 s; a budget already spent still reads ONE document; the cheap reasons read none', async () => {
    expect(RETIRE_WALK_BUDGET_MS).toBe(2_000)
    __resetRetireWalkCursorsForTest()
    await epochs(6)
    await db.pool.query(`UPDATE read_model_model_epoch_docs SET state = 'retiring' WHERE document_id = 'b0'`)
    // b1: a late write within a period — deferred without a read.
    await db.pool.query(`UPDATE read_model_model_epoch_docs SET last_late_write_at = now() WHERE document_id = 'b1'`)
    const read: string[] = []
    await retireModelEpochDocs({
      ...deps(new Map()), budgetMs: 0, now: () => 0,
      durableHeads: async (id) => { read.push(id); return ['h'] },
    })
    expect(read).toHaveLength(1)
    __resetRetireWalkCursorsForTest()
    const all: string[] = []
    const report = await retireModelEpochDocs({
      ...deps(new Map()), budgetMs: 60_000,
      durableHeads: async (id) => { all.push(id); return ['h'] },
    })
    expect(all).not.toContain('b1')
    expect(report.deferred.find((d) => d.documentId === 'b1')?.reason).toBe('late-write-within-a-period')
  })

  it('a document a journal names as a TARGET (not its source) is not retired', async () => {
    await epochs(4)
    await db.pool.query(
      `INSERT INTO read_model_model_epoch_forwards (id, landscape_id, version_id, source_document_id, from_heads, to_heads, parts, owner_instance, quarantined_at)
       VALUES ('jq', $1, $2, 'elsewhere', '{}', '{}', $3::jsonb, 'c', now())`,
      [WS.landscapeId, WS.versionId, JSON.stringify([{ documentId: 'b0', paths: [], aligned: false, plannedInserts: [], adoptUrls: [] }])])
    const report = await retireModelEpochDocs(deps(new Map()))
    expect(report.deferred.find((d) => d.documentId === 'b0')?.reason).toBe('journal-open')
    expect(report.retiring).toEqual(['m0'])
  })

  it('within N epochs nothing retires; past N, a quiet document goes retiring, then retired once swept, and its epoch with it', async () => {
    await epochs(3) // epoch-0 documents superseded by 1: age 3 (1, 2, 3) = N, still readable
    let report = await retireModelEpochDocs(deps(new Map()))
    expect(report.retiring).toEqual([])
    await db.pool.query(`UPDATE read_model_model_epochs SET state = 'retained' WHERE epoch_no = 3 AND landscape_id = $1`, [WS.landscapeId])
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, published_at)
       VALUES ($1, $2, 4, 'full', 'published', 3, 'automerge:m4', now())`, [WS.landscapeId, WS.versionId])
    expect(await countModelEpochBlockers(db.pool, WS)).toBeGreaterThan(0)
    report = await retireModelEpochDocs(deps(new Map()))
    expect(report.retiring.sort()).toEqual(['b0', 'm0']) // age 4 > 3
    expect((await state('m1'))!.state).toBe('live') // age 3
    // GC no longer marks them…
    const roots = await modelEpochGcRoots(db.pool)
    expect(roots.urls).not.toContain('automerge:b0')
    expect(roots.urls).not.toContain('automerge:m0')
    expect(roots.urls).toContain('automerge:b1')
    // …once swept, retired; the epoch whose every document retired too.
    report = await retireModelEpochDocs(deps(new Map([['m0', null], ['b0', null]])))
    expect(report.retired.sort()).toEqual(['b0', 'm0'])
    expect(report.epochsRetired).toEqual([0])
    expect(await epochState(0)).toBe('retired')
    expect(await isRetiredEpochDocument(db.pool, 'b0')).toBe(true)
    expect(await isRetiredEpochDocument(db.pool, 'b1')).toBe(false)
  })

  it('a document still receiving late writes, or with its cursor behind storage, is DEFERRED; past 2N with an alert', async () => {
    await epochs(8)
    await db.pool.query(`UPDATE read_model_model_epoch_docs SET last_late_write_at = now() WHERE document_id = 'b0'`)
    const log: Array<Record<string, unknown>> = []
    const report = await retireModelEpochDocs(deps(new Map([['m0', ['h', 'late']]]), log))
    expect(report.deferred.map((d) => [d.documentId, d.reason]).sort()).toEqual([
      ['b0', 'late-write-within-a-period'], ['m0', 'cursor-behind-durable-heads'],
    ])
    expect(report.retiring).toContain('b1')
    expect(log.filter((e) => e.event === 'model_epoch.retire_deferred' && e.alert === true)).toHaveLength(2) // age 8 > 2N = 6
    expect((await state('b0'))!.state).toBe('live')
  })

  it('the fsck facts are gathered from the real tables (one in flight, one journal, retention, a source behind)', async () => {
    expect((await gatherModelEpochFacts(db.pool, WS, { durableHeads: async () => ['h'] }))!.any).toBe(false)
    await epochs(3)
    await db.pool.query(
      `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url)
       VALUES ($1, $2, 4, 'full', 'repointing', 3, 'automerge:m4')`, [WS.landscapeId, WS.versionId])
    await db.pool.query(
      `INSERT INTO read_model_model_epoch_forwards (id, landscape_id, version_id, source_document_id, from_heads, to_heads, owner_instance)
       VALUES ('j1', $1, $2, 'b1', '{}', '{}', 'c')`, [WS.landscapeId, WS.versionId])
    const facts = (await gatherModelEpochFacts(db.pool, WS, { durableHeads: async (id) => (id === 'b2' ? ['h', 'late'] : ['h']) }))!
    expect(facts).toMatchObject({ any: true, epochsSoFar: 4, retained: 3, published: { epochNo: 3, metaUrl: 'automerge:m3' } })
    expect(facts.repointing.map((r) => r.epochNo)).toEqual([4])
    expect(facts.journals.map((j) => [j.id, j.quarantined])).toEqual([['j1', false]])
    expect(facts.sources.filter((s) => s.behind).map((s) => s.documentId)).toEqual(['b2'])
    expect(facts.supersededIds.sort()).toEqual(['b0', 'b1', 'b2', 'm0', 'm1', 'm2'])
  })

  it('a retiring document a snapshot manifest still names is PINNED, readable, and goes back to retiring when the pin goes', async () => {
    await epochs(4)
    await retireModelEpochDocs(deps(new Map()))
    expect((await state('b0'))!.state).toBe('retiring')
    await db.pool.query(`INSERT INTO landscape_versions (manifest) VALUES ($1::jsonb)`, [JSON.stringify({ docs: [{ url: 'automerge:b0' }] })])
    const report = await retireModelEpochDocs(deps(new Map()))
    expect(report.pinned.map((p) => p.documentId)).toEqual(['b0'])
    expect((await state('b0'))!.pinned_by).toMatch(/^manifest:/)
    expect((await modelEpochGcRoots(db.pool)).urls).toContain('automerge:b0') // a pinned document stays marked
    expect(await countModelEpochBlockers(db.pool, WS)).toBe(6) // epochs 1-3's documents, not the pinned one
    await db.pool.query('TRUNCATE landscape_versions')
    expect((await retireModelEpochDocs(deps(new Map()))).unpinned).toEqual(['b0'])
    expect((await state('b0'))!.state).toBe('retiring')
  })
})
