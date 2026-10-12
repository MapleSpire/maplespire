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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DOCUMENT_CHECKED_KINDS, scanDocumentReferences, type DocumentReferenceKind } from './referenceIntegrityDocuments.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('scanDocumentReferences (live Postgres + real Automerge)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  const WS = { landscapeId: 'L1', versionId: 'V1' }
  let repo: Repo
  let rootUrl: string

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'reference_documents')
    const { ensureReadModelSchema } = await import('../readModel/schema.js')
    await ensureReadModelSchema(db.pool)
  })

  afterAll(async () => { await db?.teardown() })

  beforeEach(async () => {
    repo = new Repo({})
    const diagramDoc = repo.create<Record<string, unknown>>({
      name: 'Holder', type: 'container',
      objectIds: ['obj-live'], connectionIds: ['conn-live'], groupIds: ['grp-live'],
      layouts: {
        'obj-live': { position: { x: 1, y: 1 } },
        'conn-live': { position: { x: 2, y: 2 } },
        'grp-live': { position: { x: 3, y: 3 } },
        'obj-gone': { position: { x: 9, y: 9 } },   // names nothing at all
      },
      layouts3d: { 'ghost-3d': { position: { x: 0, y: 0 } } },
      flows: {
        f1: {
          id: 'f1', name: 'Checkout', diagramId: 'dg-holder',
          steps: [
            { id: 's1', type: 'message', fromObjectId: 'obj-live', toObjectId: 'obj-gone', connectionId: 'conn-live' },
            { id: 's2', type: 'process', objectId: 'obj-gone' },
            { id: 's3', type: 'message', fromObjectId: 'obj-live', toObjectId: 'obj-live', connectionId: 'conn-gone' },
            { id: 's4', type: 'introduction' },   // carries no refs at all
          ],
        },
      },
    })
    await diagramDoc.whenReady()
    const shard = repo.create<Record<string, unknown>>({
      diagrams: { 'dg-holder': { id: 'dg-holder', docUrl: diagramDoc.url } },
    })
    await shard.whenReady()
    const meta = repo.create<Record<string, unknown>>({
      groups: {
        'grp-live': { id: 'grp-live', objectIds: ['obj-live'] },
        // The visible symptom: wrapper chrome and a live "create detail diagram"
        // control anchored to an object that no longer exists.
        'grp-orphan': { id: 'grp-orphan', parentObjectId: 'obj-gone', objectIds: ['obj-live', 'obj-gone'] },
      },
      objects: {}, connections: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    await meta.whenReady()
    const root = repo.create<Record<string, unknown>>({ modelMetaUrl: meta.url, shardUrls: [shard.url] })
    await root.whenReady()
    rootUrl = root.url

    const q = (t: string, p: unknown[] = []) => db.pool.query(t, p)
    // `ro_diagrams` belongs here too: the ADR block seeds it, and without a
    // reset every test declared after that block inherits its rows, which makes
    // the file order-dependent.
    for (const table of ['ro_objects', 'ro_groups', 'ro_connections', 'ro_diagrams']) await q(`DELETE FROM ${table}`)
    const w = [WS.landscapeId, WS.versionId]
    await q(`INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1,$2,'obj-live','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_groups (landscape_id, version_id, id, name, data) VALUES ($1,$2,'grp-live','G','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data)
             VALUES ($1,$2,'conn-live','obj-live','obj-live','{}'::jsonb)`, w)
  })

  const scan = (over: Partial<Parameters<typeof scanDocumentReferences>[3]> = {}) =>
    scanDocumentReferences(db.pool, repo, rootUrl, { ...WS, ...over })
  const of = async (kind: DocumentReferenceKind) => (await scan()).findings.filter((f) => f.kind === kind)

  /**
   * The ADR half, and the reason it lives here at all.
   *
   * `ro_decision_records` is written ONLY by the static delta projector and the
   * one-shot performance baseline — `readModel/projector.ts` never writes it — so
   * on an ordinary workspace the SQL leg's two ADR checks query an empty table
   * and can never report anything, however broken the links are.
   *
   * Note what the fixture does NOT do: it never inserts into
   * `ro_decision_records`. Seeding that table by hand would hide exactly this
   * blind spot.
   */
  describe('ADR related links', () => {
    const patchMeta = async (mutate: (meta: Record<string, unknown>) => void) => {
      const { findReadyDocument } = await import('../automergeRepoCompat.js')
      const rootDoc = (await findReadyDocument<{ modelMetaUrl?: string }>(repo, rootUrl)).doc()
      const meta = await findReadyDocument<Record<string, unknown>>(repo, rootDoc!.modelMetaUrl!)
      meta.change(mutate)
    }
    const withRecords = (records: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      patchMeta((meta) => { meta.decisionRecords = records; Object.assign(meta, extra) })
    const link = (type: string, targetId: string) => ({ id: `k-${targetId}`, type, targetId })

    beforeEach(async () => {
      await db.pool.query(
        `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1,$2,'dg-holder','{}'::jsonb)`,
        [WS.landscapeId, WS.versionId])
    })

    it('finds a link to a deleted diagram with NOTHING in ro_decision_records', async () => {
      await withRecords({ 'adr-1': { id: 'adr-1', related: [link('diagram', 'dg-gone')] } })
      const hits = await of('decisionRecord.related.diagram')
      expect(hits.map((f) => `${f.sourceId}->${f.targetId}`)).toEqual(['adr-1->dg-gone'])
    })

    it('leaves a link to a diagram that still exists alone', async () => {
      await withRecords({ 'adr-1': { id: 'adr-1', related: [link('diagram', 'dg-holder')] } })
      expect(await of('decisionRecord.related.diagram')).toEqual([])
    })

    it('finds adr AND draft links to a record that is gone', async () => {
      await withRecords({
        'adr-1': { id: 'adr-1', related: [link('adr', 'adr-gone'), link('draft', 'adr-gone-2')] },
      })
      const hits = await of('decisionRecord.related.adr')
      expect(hits.map((f) => f.targetId).sort()).toEqual(['adr-gone', 'adr-gone-2'])
    })

    it('treats a tombstoned target as gone, and skips a tombstoned SOURCE entirely', async () => {
      // `deletedDecisionRecordIds` wins over the overlay on every read path; a
      // scan that ignored it would both miss real breakage and report links held
      // by a record the user already deleted.
      await withRecords({
        'adr-1': { id: 'adr-1', related: [link('adr', 'adr-2')] },
        'adr-2': { id: 'adr-2', related: [] },
        'adr-3': { id: 'adr-3', related: [link('adr', 'adr-nope')] },
      }, { deletedDecisionRecordIds: ['adr-2', 'adr-3'] })
      const hits = await of('decisionRecord.related.adr')
      expect(hits.map((f) => `${f.sourceId}->${f.targetId}`)).toEqual(['adr-1->adr-2'])
    })

    it('leaves an adr link whose target still exists alone', async () => {
      // The mirror of the diagram case. Without it, an implementation that
      // reports EVERY adr link passes the suite — and the repair would then
      // strip every ADR-to-ADR link in the workspace.
      await withRecords({
        'adr-1': { id: 'adr-1', related: [link('adr', 'adr-2')] },
        'adr-2': { id: 'adr-2', related: [] },
      })
      expect(await of('decisionRecord.related.adr')).toEqual([])
    })

    it('ABSTAINS on BOTH kinds for a paged workspace, not just the record kind', async () => {
      // `staticBaseline` means the collection is in PostgreSQL and
      // `decisionRecords` holds edits only. The static delta projector mirrors
      // that overlay into `ro_decision_records`, so the SQL leg sees every
      // record here — baseline AND overlay. Answering the diagram kind as well
      // would double-report every overlayed record's links: one dangling link,
      // two findings, and an operator told "repaired 2" for a single splice.
      await withRecords(
        { 'adr-1': { id: 'adr-1', related: [link('adr', 'adr-in-postgres'), link('diagram', 'dg-gone')] } },
        { staticBaseline: true, decisionRecordShardUrls: [] },
      )
      const report = await scan()
      expect(report.findings.filter((f) => f.kind.startsWith('decisionRecord.'))).toEqual([])
    })

    it('abstains for a shard-paged workspace too, not just a static one', async () => {
      await withRecords(
        { 'adr-1': { id: 'adr-1', related: [link('adr', 'adr-in-a-shard'), link('diagram', 'dg-gone')] } },
        { decisionRecordShardUrls: ['automerge:fake'] },
      )
      const report = await scan()
      expect(report.findings.filter((f) => f.kind.startsWith('decisionRecord.'))).toEqual([])
    })

    it('ignores links with no usable target or an unknown type', async () => {
      await withRecords({ 'adr-1': { id: 'adr-1', related: [
        { id: 'a', type: 'diagram' }, { id: 'b', type: 'diagram', targetId: '' },
        { id: 'c', type: 'url', targetId: 'dg-gone' }, { id: 'd', type: 'diagram', targetId: 7 }, null,
      ] } })
      const report = await scan()
      expect(report.findings.filter((f) => f.kind.startsWith('decisionRecord.'))).toEqual([])
    })

    it('survives a record whose `related` is not an array, iterable or not', async () => {
      // A string is the ONE truthy non-array that `for…of` walks happily, so a
      // truthiness check instead of `Array.isArray` passes on `'nope'` alone. An
      // object or a number throws "is not iterable" and takes the whole scan
      // down — every SQL finding with it.
      for (const related of ['nope', { nope: true }, 5, true]) {
        await withRecords({ 'adr-1': { id: 'adr-1', related }, 'adr-2': null })
        const report = await scan()
        expect(report.findings.filter((f) => f.kind.startsWith('decisionRecord.')), String(related)).toEqual([])
      }
    })
  })

  /**
   * A sparse draft registers `read_model_static_workspaces.base_version_id =
   * <parent>`, so every `ro_*` row it reads lives under the PARENT's version_id.
   * This walk resolves referrers from the draft's documents against targets
   * queried by the draft's OWN id — which returns nothing — so without a guard
   * the entire draft reads as dangling, and an apply strips it.
   */
  describe('a workspace whose read model is a redirect', () => {
    // A DISTINCT version id, deliberately. `staticReadModelQueryWorkspaceIfPresent`
    // caches positive identities on a TTL, so marking the shared `WS` as
    // redirected and deleting the row again leaves the cache asserting the
    // redirect for every later test in the file — which is exactly what
    // happened: eight unrelated tests went to zero findings.
    const DRAFT = { landscapeId: WS.landscapeId, versionId: 'V-DRAFT' }
    beforeEach(async () => {
      await db.pool.query(
        `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source, base_version_id)
         VALUES ($1, $2, 'sparse-draft', $3)
         ON CONFLICT (landscape_id, version_id) DO UPDATE SET base_version_id = EXCLUDED.base_version_id`,
        [DRAFT.landscapeId, DRAFT.versionId, WS.versionId])
    })
    afterEach(async () => {
      await db.pool.query(`DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2`,
        [DRAFT.landscapeId, DRAFT.versionId])
    })

    it('reports NOTHING and says the walk did not happen', async () => {
      // The same documents report group.parentObjectId, group.objectIds,
      // diagram.layouts and flowStep.refs when the workspace is not redirected —
      // see the tests above. Every one of those would be a false positive here,
      // and `repairReferenceIntegrity` would strip them.
      const report = await scanDocumentReferences(db.pool, repo, rootUrl, DRAFT)
      expect(report.findings).toEqual([])
      expect(report.checkedKinds).toEqual([])
      // `truncated` is what stops "0 findings" being read as "0 problems".
      expect(report.truncated).toBe(true)
    })
  })

  it('finds the group whose parent object is gone — the one SQL cannot see at all', async () => {
    // ro_groups is (id, name) only, so this reference has no column to check.
    const hits = await of('group.parentObjectId')
    expect(hits.map((f) => f.sourceId)).toEqual(['grp-orphan'])
    expect(hits[0].targetId).toBe('obj-gone')
  })

  it('finds a deleted object still listed as a group member, and leaves the live one alone', async () => {
    const hits = await of('group.objectIds')
    expect(hits.map((f) => `${f.sourceId}->${f.targetId}`)).toEqual(['grp-orphan->obj-gone'])
  })

  it('finds a layout key that names nothing, across both the 2D and 3D layers', async () => {
    const hits = await of('diagram.layouts')
    expect(hits.map((f) => `${f.field}:${f.targetId}`).sort()).toEqual(['layouts3d:ghost-3d', 'layouts:obj-gone'])
  })

  it('leaves the layout keys of live objects, connections AND groups alone', async () => {
    // An endpoint may be any of the three; checking only objects would report
    // every group and connection placement as dead weight.
    const hits = await of('diagram.layouts')
    for (const live of ['obj-live', 'conn-live', 'grp-live']) {
      expect(hits.some((f) => f.targetId === live), live).toBe(false)
    }
  })

  it('finds flow steps citing a deleted shape or connection, whatever the field', async () => {
    const hits = await of('flowStep.refs')
    expect(hits.map((f) => `${f.field}:${f.targetId}`).sort())
      .toEqual(['connectionId:conn-gone', 'objectId:obj-gone', 'toObjectId:obj-gone'])
  })

  it('reports a registry entry pointing at a document it cannot read', async () => {
    // Entity-vs-DOCUMENT: no SQL check can see this, and it is what the
    // `[docScope] … is unavailable` noise in the server log actually is.
    const orphanShard = repo.create<Record<string, unknown>>({
      diagrams: { 'dg-dead': { id: 'dg-dead', docUrl: 'automerge:2WyBVsaDzJvZFT3TPFALam924frT' } },
    })
    await orphanShard.whenReady()
    const root = await repo.find<{ shardUrls: string[] }>(rootUrl as `automerge:${string}`)
    root.change((r) => { r.shardUrls.push(orphanShard.url) })

    const report = await scan({ documentTimeoutMs: 800 })
    const hits = report.findings.filter((f) => f.kind === 'diagram.docUrl')
    expect(hits.map((f) => f.sourceId)).toEqual(['dg-dead'])
    expect(hits[0].severity).toBe('unreadable')
  })

  it('keeps walking after an unreadable document instead of losing every later finding', async () => {
    const orphanShard = repo.create<Record<string, unknown>>({
      diagrams: { 'dg-dead': { id: 'dg-dead', docUrl: 'automerge:2WyBVsaDzJvZFT3TPFALam924frT' } },
    })
    await orphanShard.whenReady()
    const root = await repo.find<{ shardUrls: string[] }>(rootUrl as `automerge:${string}`)
    // FIRST, so a walk that aborts on it would report nothing else.
    root.change((r) => { r.shardUrls.unshift(orphanShard.url) })

    const report = await scan({ documentTimeoutMs: 800 })
    expect(report.countsByKind['diagram.docUrl']).toBe(1)
    expect(report.countsByKind['flowStep.refs']).toBe(3)
  })

  it('stops at the document cap and says so rather than reporting a partial sweep as whole', async () => {
    const report = await scan({ maxDiagrams: 0 })
    expect(report.truncated).toBe(true)
    expect(report.diagramsWalked).toBe(0)
    expect(report.diagramsSkipped).toBe(1)
    // The ModelMeta checks are one document, so they still ran.
    expect(report.countsByKind['group.parentObjectId']).toBe(1)
  })

  it('stops at the wall clock too, not only the count', async () => {
    let t = 0
    const report = await scan({ deadlineMs: 10, now: () => (t += 100) })
    expect(report.truncated).toBe(true)
    expect(report.diagramsWalked).toBe(0)
  })

  it('reports an explicit zero for every check, so a clean walk is legible', async () => {
    const report = await scan()
    for (const kind of DOCUMENT_CHECKED_KINDS) expect(report.countsByKind[kind], kind).toBeGreaterThanOrEqual(0)
    expect(Object.keys(report.countsByKind).sort()).toEqual([...DOCUMENT_CHECKED_KINDS].sort())
  })

  it('mutates nothing', async () => {
    const before = JSON.stringify((await repo.find<Record<string, unknown>>(rootUrl as `automerge:${string}`)).doc())
    await scan()
    expect(JSON.stringify((await repo.find<Record<string, unknown>>(rootUrl as `automerge:${string}`)).doc())).toBe(before)
  })
})
