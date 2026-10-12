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
import { planReferenceRepair, repairReferenceIntegrity } from './referenceIntegrityRepair.js'
import { scanReferenceIntegrity } from './referenceIntegrityScan.js'
import {
  DOCUMENT_CHECKED_KINDS, SQL_CHECKED_KINDS,
  type ReferenceFinding, type ReferenceKind,
} from './referenceFindings.js'

const finding = (kind: ReferenceKind): ReferenceFinding => ({
  landscapeId: 'L1', versionId: 'V1', kind, field: 'f',
  sourceId: 'src', targetId: 'gone', severity: 'dangling', repairIsRemoval: true,
})

describe('planReferenceRepair', () => {
  it('strips a dangling id out of every diagram composition that lists it', () => {
    for (const kind of ['diagram.groupIds', 'diagram.objectIds', 'diagram.connectionIds'] as const) {
      expect(planReferenceRepair(finding(kind)), kind)
        .toMatchObject({ action: 'strip-composition', safeToApply: true })
    }
  })

  it('clears a detail diagram whose parent object is gone', () => {
    expect(planReferenceRepair(finding('diagram.parentObjectId')))
      .toMatchObject({ action: 'clear-parent-object', safeToApply: true })
  })

  it('never auto-repairs a connection with a missing endpoint', () => {
    // The only repair is deleting it. A bulk apply that quietly deletes
    // connections is how a repair tool becomes the incident.
    const plan = planReferenceRepair(finding('connection.endpoint'))
    expect(plan.action).toBe('manual')
    expect(plan.safeToApply).toBe(false)
    expect(plan.reason).toMatch(/destructive/)
  })

  it('never rewrites documents to achieve what the readers already do', () => {
    // A dangling object parent is by design on both sides.
    const plan = planReferenceRepair(finding('object.parentId'))
    expect(plan.action).toBe('none')
    expect(plan.safeToApply).toBe(false)
  })

  it('cannot decide an ADR link from the kind alone, and says so', () => {
    // The old refusal blamed immutable baseline shards. That was wrong — the
    // overlay precedence is settled and two shipping writers rely on it. What
    // the kind genuinely cannot decide is whether the TARGET is gone, and an
    // ADRLink is user-authored content: `ro_decision_records` has two writers,
    // neither the ordinary projector, so a stale projection would report every
    // link as dangling. The documents are the evidence, not the read model.
    for (const kind of ['decisionRecord.related.diagram', 'decisionRecord.related.adr'] as const) {
      const plan = planReferenceRepair(finding(kind))
      expect(plan.action, kind).toBe('manual')
      expect(plan.safeToApply, kind).toBe(false)
      expect(plan.reason, kind).toMatch(/pending/)
    }
  })

  it('clears a group parent that is gone — the finding with the visible symptom', () => {
    expect(planReferenceRepair(finding('group.parentObjectId')))
      .toMatchObject({ action: 'clear-group-parent', safeToApply: true })
  })

  it('drops a deleted object from a group member list', () => {
    expect(planReferenceRepair(finding('group.objectIds')))
      .toMatchObject({ action: 'drop-group-member', safeToApply: true })
  })

  it('gives a layout key its OWN action, not the composition strip', () => {
    // stripIdsFromAllDiagrams only opens a DiagramDoc when the registry stub's
    // COMPOSITION mentions the id — and a layout-key finding is by definition an
    // id that is in `layouts` and not in the composition. Routing it there
    // reported applied=1 and changed nothing, live.
    expect(planReferenceRepair(finding('diagram.layouts')))
      .toMatchObject({ action: 'drop-layout-key', safeToApply: true })
  })

  it('refuses a flow step whose endpoint is gone', () => {
    const plan = planReferenceRepair(finding('flowStep.refs'))
    expect(plan.action).toBe('manual')
    expect(plan.reason).toMatch(/content decision/)
  })

  it('cannot decide an unreadable document from the kind alone, and says pending', () => {
    // Whether the entry may be dropped depends on storage ownership, which needs
    // a query. Answering anything else here would be a guess.
    const plan = planReferenceRepair(finding('diagram.docUrl'))
    expect(plan.action).toBe('manual')
    expect(plan.safeToApply).toBe(false)
    expect(plan.reason).toMatch(/pending/)
  })

  it('gives every kind EITHER leg can report a plan and a reason when it declines', () => {
    // A finding with no plan would render as a blank row in the console.
    for (const kind of [...SQL_CHECKED_KINDS, ...DOCUMENT_CHECKED_KINDS]) {
      const plan = planReferenceRepair(finding(kind))
      expect(plan.action, kind).toBeTruthy()
      if (!plan.safeToApply) expect(plan.reason, kind).toBeTruthy()
    }
  })
})

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('repairReferenceIntegrity (live Postgres + real Automerge)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  const WS = { landscapeId: 'L1', versionId: 'V1' }
  let repo: Repo
  let rootUrl: string

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'reference_repair')
    const { ensureReadModelSchema } = await import('../readModel/schema.js')
    await ensureReadModelSchema(db.pool)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS versions (
      landscape_id TEXT NOT NULL, id TEXT NOT NULL, root_url TEXT NOT NULL,
      PRIMARY KEY (landscape_id, id))`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_storage (key TEXT PRIMARY KEY)`)
    await db.pool.query(`CREATE TABLE IF NOT EXISTS automerge_document_workspace (document_id TEXT PRIMARY KEY)`)
  })

  afterAll(async () => { await db?.teardown() })

  beforeEach(async () => {
    // ── the Automerge side: a registry shard + one DiagramDoc ────────────────
    repo = new Repo({})
    const diagramDoc = repo.create<Record<string, unknown>>({
      name: 'Holder', type: 'container',
      objectIds: ['obj-live', 'obj-gone'],
      connectionIds: ['conn-live'],
      groupIds: ['grp-live', 'grp-gone', 'grp-gone2'],
      layouts: {
        'obj-gone': { position: { x: 9, y: 9 } },
        'obj-live': { position: { x: 1, y: 1 } },
        // In `layouts` but NOT in any composition array — the only way a
        // diagram.layouts finding arises, and the case the composition strip
        // cannot reach because it never opens this document for it.
        'ghost-2d': { position: { x: 7, y: 7 } },
      },
      layouts3d: { 'ghost-3d': { position: { x: 8, y: 8 } } },
      parentObjectId: 'obj-parent-gone',
    })
    await diagramDoc.whenReady()
    const shard = repo.create<Record<string, unknown>>({
      diagrams: {
        'dg-holder': {
          id: 'dg-holder', name: 'Holder', type: 'container', docUrl: diagramDoc.url,
          objectIds: ['obj-live', 'obj-gone'], connectionIds: ['conn-live'],
          groupIds: ['grp-live', 'grp-gone', 'grp-gone2'], parentObjectId: 'obj-parent-gone',
        },
      },
    })
    await shard.whenReady()
    const model = repo.create<Record<string, unknown>>({
      objects: {}, connections: {}, domains: {}, tagSnapshots: {},
      deletedDecisionRecordIds: [],
      decisionRecords: {
        'adr-1': {
          id: 'adr-1', number: 1, title: 'T', summary: '', status: 'approved', author: 'a',
          createdAt: '', updatedAt: '', content: 'BASELINE CONTENT',
          related: [
            { id: 'k-live', type: 'diagram', targetId: 'dg-holder' },
            { id: 'k-dead', type: 'diagram', targetId: 'dg-gone' },
          ],
        },
      },
      groups: {
        'grp-live': { id: 'grp-live', name: 'Live', objectIds: ['obj-live'] },
        // The visible symptom: wrapper chrome + a live "create detail diagram"
        // control anchored to an object that is gone.
        // TWO adjacent dangling members: with a head-first splice the second one
        // is skipped as the indices shift, which a single one cannot reveal.
        'grp-orphan': { id: 'grp-orphan', name: 'Orphan', parentObjectId: 'obj-parent-gone', objectIds: ['obj-live', 'obj-gone', 'obj-gone2'] },
      },
    })
    await model.whenReady()
    const root = repo.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
    await root.whenReady()
    rootUrl = root.url

    // ── the SQL side, describing exactly the same workspace ─────────────────
    const q = (text: string, params: unknown[] = []) => db.pool.query(text, params)
    // `read_model_static_workspaces` is in this list because the lock arms
    // write it to simulate a promotion committing; without cleanup a retry or
    // a shuffled order would fail inside the seam on a unique violation rather
    // than on the assertion.
    for (const table of ['ro_objects', 'ro_groups', 'ro_connections', 'ro_diagrams', 'ro_diagram_groups', 'ro_diagram_objects', 'ro_diagram_connections', 'ro_decision_records', 'read_model_static_workspaces', 'versions']) {
      await q(`DELETE FROM ${table}`)
    }
    const w = [WS.landscapeId, WS.versionId]
    await q(`INSERT INTO versions (landscape_id, id, root_url) VALUES ($1,$2,$3)`, [...w, rootUrl])
    // A HEALTHY projection state. Without a row the repair now refuses outright
    // — see `readModelUntrustworthyReason` — because an unprojected workspace
    // has empty `ro_*` tables and every reference in it would read as dangling.
    // The fixture describes a workspace that WAS projected cleanly, which is
    // what every case below means to exercise.
    await q(`INSERT INTO read_model_projection_state
               (landscape_id, version_id, observed_generation, projected_generation)
             VALUES ($1,$2,1,1)
             ON CONFLICT (landscape_id, version_id) DO UPDATE
               SET projected_generation = 1, degraded_since = NULL,
                   defect_count = NULL, last_error_generation = NULL`, w)
    await q(`INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1,$2,'obj-live','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_groups (landscape_id, version_id, id, name, data) VALUES ($1,$2,'grp-live','G','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data)
             VALUES ($1,$2,'conn-live','obj-live','obj-live','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_diagrams (landscape_id, version_id, id, parent_object_id, data)
             VALUES ($1,$2,'dg-holder','obj-parent-gone','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_diagram_groups (landscape_id, version_id, diagram_id, group_id) VALUES
             ($1,$2,'dg-holder','grp-live'), ($1,$2,'dg-holder','grp-gone'), ($1,$2,'dg-holder','grp-gone2')`, w)
    await q(`INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id) VALUES
             ($1,$2,'dg-holder','obj-live'), ($1,$2,'dg-holder','obj-gone')`, w)
    await q(`INSERT INTO ro_diagram_connections (landscape_id, version_id, diagram_id, connection_id)
             VALUES ($1,$2,'dg-holder','conn-live')`, w)
    await q(`INSERT INTO ro_decision_records (landscape_id, version_id, id, data) VALUES ($1,$2,'adr-1',$3::jsonb)`,
      [...w, JSON.stringify({ id: 'adr-1', related: [
        { id: 'k-live', type: 'diagram', targetId: 'dg-holder' },
        { id: 'k-dead', type: 'diagram', targetId: 'dg-gone' },
      ] })])
  })

  const groupState = async () => {
    const { findReadyDocument } = await import('../automergeRepoCompat.js')
    const rootDoc = (await findReadyDocument<{ modelUrl?: string }>(repo, rootUrl)).doc()
    const meta = (await findReadyDocument<{ groups?: Record<string, { parentObjectId?: string; objectIds?: string[] }> }>(
      repo, rootDoc!.modelUrl!)).doc()
    return meta!.groups!
  }

  const diagramState = async () => {
    const { findDiagram } = await import('../ai/core/modelOps.js')
    const found = await findDiagram(repo, rootUrl, 'dg-holder')
    const doc = found!.doc.doc() as Record<string, unknown>
    return {
      objectIds: doc.objectIds as string[],
      groupIds: doc.groupIds as string[],
      layoutKeys: Object.keys((doc.layouts ?? {}) as Record<string, unknown>),
      parentObjectId: doc.parentObjectId,
      stub: (found!.shard.doc() as { diagrams: Record<string, Record<string, unknown>> }).diagrams['dg-holder'],
    }
  }

  it('writes NOTHING on a dry run, which is the default', async () => {
    const before = await diagramState()
    const result = await repairReferenceIntegrity(db.pool, repo, WS)
    expect(result.reportOnly).toBe(true)
    expect(result.applied).toBe(0)
    expect(result.plans.length).toBeGreaterThan(0)
    expect(await diagramState()).toEqual(before)
  })

  it('removes the dangling group and object from the diagram, and their layout keys', async () => {
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
    const after = await diagramState()
    expect(after.groupIds).toEqual(['grp-live'])
    expect(after.objectIds).toEqual(['obj-live'])
    // A layout key is membership, not existence: leaving it would resurrect the
    // old position if the id ever came back.
    //
    // `ghost-2d` SURVIVES here, and must: the walk was not enabled, so nothing
    // reported it — and the composition strip could not have removed it anyway,
    // since it never opens a document whose composition does not name the id.
    expect([...after.layoutKeys].sort()).toEqual(['ghost-2d', 'obj-live'])
  })

  it('clears a parent object that no longer exists, in the doc AND the registry stub', async () => {
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
    const after = await diagramState()
    expect(after.parentObjectId).toBeUndefined()
    expect(after.stub.parentObjectId).toBeUndefined()
  })

  it('keeps the registry stub in step with the document it denormalises', async () => {
    // The stub is what every OTHER diagram view reads; repairing only the doc
    // would leave the dangling reference visible everywhere that matters.
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
    const after = await diagramState()
    expect(after.stub.groupIds).toEqual(['grp-live'])
    expect(after.stub.objectIds).toEqual(['obj-live'])
  })

  it('leaves everything that still resolves completely alone', async () => {
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
    const after = await diagramState()
    expect(after.objectIds).toContain('obj-live')
    expect((after.stub.connectionIds as string[])).toEqual(['conn-live'])
  })

  it('is idempotent — a second apply finds nothing left to do', async () => {
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
    // The read model is stale by design here (the projector has not re-run), so
    // re-scanning SQL would report the same rows. Prove it on the documents: a
    // second apply must not corrupt what the first one fixed.
    const afterFirst = await diagramState()
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
    expect(await diagramState()).toEqual(afterFirst)
  })

  it('refuses a workspace whose root document it cannot resolve', async () => {
    // Repairing a workspace we cannot name is unrecoverable, so it fails loudly
    // rather than writing into whatever root happens to be at hand.
    await db.pool.query(`DELETE FROM versions`)
    await expect(repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
      .rejects.toThrow(/no root document/)
  })

  it('does not need the root document for a dry run', async () => {
    await db.pool.query(`DELETE FROM versions`)
    const result = await repairReferenceIntegrity(db.pool, repo, WS)
    expect(result.reportOnly).toBe(true)
    expect(result.plans.length).toBeGreaterThan(0)
  })

  it('counts what it declined to touch instead of hiding it', async () => {
    // Two findings here are by-design (`object.parentId` is absent, but the
    // scan reports composition + parent), so skipped is 0 in this fixture —
    // what matters is that the field is derived, not hardcoded.
    const result = await repairReferenceIntegrity(db.pool, repo, WS)
    const declined = result.plans.filter((p) => !p.safeToApply).length
    expect(result.skipped).toBe(declined)
    expect(result.plans.length).toBe(result.skipped + result.plans.filter((p) => p.safeToApply).length)
  })

  it('deletes a layout key that no composition mentions, in BOTH layers', async () => {
    // The regression: routed through the composition strip this reported
    // applied=1 and left the key exactly where it was.
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true, documents: true })
    const after = await diagramState()
    expect(after.layoutKeys).toEqual(['obj-live'])
    const { findDiagram } = await import('../ai/core/modelOps.js')
    const found = await findDiagram(repo, rootUrl, 'dg-holder')
    const doc = found!.doc.doc() as Record<string, unknown>
    expect(Object.keys((doc.layouts3d ?? {}) as Record<string, unknown>)).toEqual([])
  })

  it('clears a group parent that is gone, without touching the group beside it', async () => {
    // `ro_groups` has no parent column, so the SQL leg alone would never see it.
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true, documents: true })
    const groups = await groupState()
    expect(groups['grp-orphan'].parentObjectId).toBeUndefined()
    expect(groups['grp-live']).toEqual({ id: 'grp-live', name: 'Live', objectIds: ['obj-live'] })
  })

  it('drops EVERY deleted member from the group, not just the first', async () => {
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true, documents: true })
    expect((await groupState())['grp-orphan'].objectIds).toEqual(['obj-live'])
  })

  it('keeps every other field of a repaired group intact', async () => {
    // A whole-object write would clobber a concurrent edit; the repair must touch
    // only what it repairs.
    await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true, documents: true })
    expect((await groupState())['grp-orphan'].name).toBe('Orphan')
  })

  it('leaves the documents alone on a dry run WITH the walk enabled', async () => {
    const before = JSON.stringify(await groupState())
    const result = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
    expect(result.reportOnly).toBe(true)
    expect(result.plans.some((p) => p.action === 'clear-group-parent')).toBe(true)
    expect(JSON.stringify(await groupState())).toBe(before)
  })

  it('does not walk the documents unless asked', async () => {
    const sqlOnly = await repairReferenceIntegrity(db.pool, repo, WS)
    expect(sqlOnly.plans.some((p) => p.finding.kind === 'group.parentObjectId')).toBe(false)
    const both = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
    expect(both.plans.some((p) => p.finding.kind === 'group.parentObjectId')).toBe(true)
  })

  describe('a registry entry whose document will not load', () => {
    const DEAD = 'automerge:2WyBVsaDzJvZFT3TPFALam924frT'
    const DEAD_ID = DEAD.slice('automerge:'.length)

    const withDeadEntry = async () => {
      const orphanShard = repo.create<Record<string, unknown>>({
        diagrams: { 'dg-dead': { id: 'dg-dead', docUrl: DEAD } },
      })
      await orphanShard.whenReady()
      const root = await repo.find<{ shardUrls: string[] }>(rootUrl as `automerge:${string}`)
      root.change((r) => { r.shardUrls.push(orphanShard.url) })
      return orphanShard
    }
    const planFor = async () => {
      const result = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
      return result.plans.find((p) => p.finding.kind === 'diagram.docUrl')!
    }

    beforeEach(async () => {
      for (const t of ['automerge_storage', 'automerge_document_workspace']) await db.pool.query(`DELETE FROM ${t}`)
      await withDeadEntry()
    })

    it('drops the entry when the document is provably absent from storage', async () => {
      const plan = await planFor()
      expect(plan).toMatchObject({ action: 'drop-registry-entry', safeToApply: true })

      await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true, apply: true })
      const after = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
      expect(after.plans.some((p) => p.finding.kind === 'diagram.docUrl')).toBe(false)
    })

    it('refuses when the document IS in storage — the walk timed out, it is not missing', async () => {
      // A timeout is `unknown`, not `dangling`. Storage is the evidence; the
      // walk's failure to resolve is only an observation.
      await db.pool.query(`INSERT INTO automerge_storage (key) VALUES ($1)`, [`${DEAD_ID}/snapshot`])
      const plan = await planFor()
      expect(plan.safeToApply).toBe(false)
      expect(plan.reason).toMatch(/in storage/)
    })

    it('refuses when the document is still mapped to a workspace', async () => {
      await db.pool.query(`INSERT INTO automerge_document_workspace (document_id) VALUES ($1)`, [DEAD_ID])
      const plan = await planFor()
      expect(plan.safeToApply).toBe(false)
      expect(plan.reason).toMatch(/mapped/)
    })

    it('refuses when the document is still projected into the read model', async () => {
      await db.pool.query(
        `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1,$2,'dg-projected',$3::jsonb)`,
        [WS.landscapeId, WS.versionId, JSON.stringify({ docUrl: DEAD })])
      const plan = await planFor()
      expect(plan.safeToApply).toBe(false)
      expect(plan.reason).toMatch(/projected/)
    })

    it('leaves the registry alone on a dry run', async () => {
      const before = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
      expect(before.reportOnly).toBe(true)
      const still = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
      expect(still.plans.some((p) => p.finding.kind === 'diagram.docUrl')).toBe(true)
    })
  })

  describe('a decision-record link whose target is gone', () => {
    const adrState = async () => {
      const { findReadyDocument } = await import('../automergeRepoCompat.js')
      const rootDoc = (await findReadyDocument<{ modelUrl?: string }>(repo, rootUrl)).doc()
      const meta = (await findReadyDocument<{ decisionRecords?: Record<string, { content?: string; related?: Array<{ id: string }> }> }>(
        repo, rootDoc!.modelUrl!)).doc()
      return meta!.decisionRecords!['adr-1']
    }
    const adrPlan = async (over = {}) => {
      const result = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true, ...over })
      return result.plans.find((p) => p.finding.kind.startsWith('decisionRecord.related.'))!
    }

    it('is promoted once the documents confirm the target is absent', async () => {
      expect(await adrPlan()).toMatchObject({ action: 'strip-adr-link', safeToApply: true })
    })

    it('refuses when the target IS in the documents — the read model is stale', async () => {
      // `ro_decision_records` has two writers, neither the ordinary projector.
      // Deleting authored content on its word alone is the failure to avoid.
      await db.pool.query(
        `INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1,$2,'dg-orphan','{}'::jsonb)`,
        [WS.landscapeId, WS.versionId])
      const shard = repo.create<Record<string, unknown>>({ diagrams: { 'dg-gone': { id: 'dg-gone', docUrl: '' } } })
      await shard.whenReady()
      const root = await repo.find<{ shardUrls: string[] }>(rootUrl as `automerge:${string}`)
      root.change((r) => { r.shardUrls.push(shard.url) })

      const plan = await adrPlan()
      expect(plan.safeToApply).toBe(false)
      expect(plan.reason).toMatch(/not missing/)
    })

    it('splices the dead link and leaves the rest of the record untouched', async () => {
      await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true, apply: true })
      const adr = await adrState()
      expect(adr.related!.map((l) => l.id)).toEqual(['k-live'])
      expect(adr.content).toBe('BASELINE CONTENT')
    })

    it('counts applied from EFFECTS: a second run repairs nothing and says so', async () => {
      const first = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true, apply: true })
      const again = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true, apply: true })
      const plan = again.plans.find((p) => p.action === 'strip-adr-link')!
      expect(plan.outcome).toBe('not-found')
      // The NUMBER, not just the outcome. The read model is stale within a run
      // (the projector has not re-run), so the same findings are planned again —
      // but the link contributed to `applied` the first time and must not the
      // second. Reporting the plan count is how a repair claims a change it did
      // not make.
      // `applied` must be the actionable count MINUS this link, which planned
      // safely and then found nothing. Equality with the plan count is the bug.
      expect(again.applied).toBe(again.plans.filter((p) => p.safeToApply).length - 1)
      expect(first.plans.some((p) => p.outcome?.startsWith('removed'))).toBe(true)
    })

    it('writes nothing on a dry run', async () => {
      const before = JSON.stringify(await adrState())
      const result = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
      expect(result.reportOnly).toBe(true)
      expect(JSON.stringify(await adrState())).toBe(before)
    })

    /**
     * The absence proof.
     *
     * "The target is not in the documents read" only means "the target is
     * gone" if they were ALL read. A diagram leg abandoned on a bad URL or the
     * deadline without recording it would make an incomplete walk
     * indistinguishable from an empty one, and links to live diagrams would be
     * promoted to `safeToApply`.
     */
    describe('a walk that did not finish is never read as absence', () => {
      const pushShardUrl = async (url: string) => {
        const root = await repo.find<{ shardUrls: string[] }>(rootUrl as `automerge:${string}`)
        root.change((r) => { r.shardUrls.unshift(url) })
      }
      /** A syntactically valid URL for a document this repo does not have. With
       *  no network adapter attached, `find` rejects rather than hanging. */
      const absentUrl = async () => {
        const elsewhere = new Repo({})
        const doc = elsewhere.create<Record<string, unknown>>({ diagrams: {} })
        await doc.whenReady()
        return doc.url
      }

      it('a malformed shard URL does not hide the shards after it', async () => {
        // `break` here was the defect: one bad entry and every diagram behind it
        // vanished from `liveDiagrams`, which reads as "deleted".
        const shard = repo.create<Record<string, unknown>>({ diagrams: { 'dg-gone': { id: 'dg-gone', docUrl: '' } } })
        await shard.whenReady()
        await pushShardUrl(shard.url)
        await pushShardUrl('automerge:not-a-real-url')

        const plan = await adrPlan()
        expect(plan.safeToApply).toBe(false)
        expect(plan.reason).toMatch(/not missing/)
      })

      it('refuses to promote when a shard URL was malformed and the target was not found', async () => {
        await pushShardUrl('automerge:not-a-real-url')
        const plan = await adrPlan()
        expect(plan.safeToApply).toBe(false)
        expect(plan.reason).toMatch(/^pending: /)
      })

      it('refuses — and does not THROW — when a registry shard cannot be read', async () => {
        // A dry run is the diagnostic. `findReadyDocument` rejects on an
        // unreadable document, and an uncaught rejection here 500s the whole
        // report, taking every unrelated finding with it.
        await pushShardUrl(await absentUrl())
        const result = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
        const plan = result.plans.find((p) => p.finding.kind.startsWith('decisionRecord.related.'))!
        expect(plan.safeToApply).toBe(false)
        expect(plan.reason).toMatch(/^pending: /)
        // Everything else still gets reported.
        expect(result.plans.filter((p) => p.safeToApply).length).toBeGreaterThan(0)
      })

      it('reports an incomplete walk as truncated, so "nothing promoted" is not read as "nothing wrong"', async () => {
        await pushShardUrl('automerge:not-a-real-url')
        expect((await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })).truncated).toBe(true)
      })

      it('refuses an ADR target when the baseline is not in the documents at all', async () => {
        // `toPerformanceControlMeta` publishes `staticBaseline: true` WITH
        // `decisionRecordShardUrls: []` — the ADRs live in PostgreSQL. Walking
        // zero shards then proves nothing, and `meta.decisionRecords` is an edit
        // overlay, so every link to a baseline-resident ADR looks dangling.
        const { findReadyDocument } = await import('../automergeRepoCompat.js')
        const rootDoc = (await findReadyDocument<{ modelUrl?: string }>(repo, rootUrl)).doc()
        const meta = await findReadyDocument<Record<string, unknown>>(repo, rootDoc!.modelUrl!)
        meta.change((m) => {
          const adr = (m.decisionRecords as Record<string, { related: unknown[] }>)['adr-1']
          adr.related.push({ id: 'k-adr', type: 'adr', targetId: 'adr-baseline' })
        })
        await db.pool.query(
          `UPDATE ro_decision_records SET data = jsonb_set(data, '{related}', data->'related' || $3::jsonb)
           WHERE landscape_id = $1 AND version_id = $2 AND id = 'adr-1'`,
          [WS.landscapeId, WS.versionId, JSON.stringify([{ id: 'k-adr', type: 'adr', targetId: 'adr-baseline' }])])

        // CONTROL: inline meta IS the collection, so absence there is real.
        const inline = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
        expect(inline.plans.find((p) => p.finding.kind === 'decisionRecord.related.adr'))
          .toMatchObject({ action: 'strip-adr-link', safeToApply: true })

        meta.change((m) => { m.staticBaseline = true; m.decisionRecordShardUrls = [] })
        const plan = (await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true }))
          .plans.find((p) => p.finding.kind === 'decisionRecord.related.adr')!
        expect(plan.safeToApply).toBe(false)
        expect(plan.reason).toMatch(/static relational baseline/)
        // The DIAGRAM leg is unaffected — the two legs carry their own coverage,
        // so one that cannot answer must not silence the one that can.
        const diagram = (await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true }))
          .plans.find((p) => p.finding.kind === 'decisionRecord.related.diagram')!
        expect(diagram).toMatchObject({ action: 'strip-adr-link', safeToApply: true })
      })
    })

    it('counts BOTH findings when one ADR names the same dead target twice', async () => {
      // The scan is a `CROSS JOIN LATERAL` with no DISTINCT, so a duplicated
      // link yields two findings; the repair strips both in one pass. Sent
      // undeduped, the second reported `not-found` and a genuinely-repaired
      // finding was reported to the operator as deliberately left alone.
      const { findReadyDocument } = await import('../automergeRepoCompat.js')
      const rootDoc = (await findReadyDocument<{ modelUrl?: string }>(repo, rootUrl)).doc()
      const meta = await findReadyDocument<Record<string, unknown>>(repo, rootDoc!.modelUrl!)
      meta.change((m) => {
        const adr = (m.decisionRecords as Record<string, { related: unknown[] }>)['adr-1']
        adr.related.push({ id: 'k-dead2', type: 'diagram', targetId: 'dg-gone' })
      })
      await db.pool.query(
        `UPDATE ro_decision_records SET data = jsonb_set(data, '{related}', data->'related' || $3::jsonb)
         WHERE landscape_id = $1 AND version_id = $2 AND id = 'adr-1'`,
        [WS.landscapeId, WS.versionId, JSON.stringify([{ id: 'k-dead2', type: 'diagram', targetId: 'dg-gone' }])])

      const result = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true, apply: true })
      const links = result.plans.filter((p) => p.action === 'strip-adr-link')
      // FOUR findings for TWO links, and only because this FIXTURE is not a
      // shape production reaches: it seeds `ro_decision_records` on an ordinary
      // workspace, which nothing but the static delta projector ever does. In
      // production the legs are disjoint — an ordinary workspace has an empty
      // table so only the document leg fires, and a paged one makes the document
      // leg abstain — so the real duplicate source is a single ADR naming the
      // same dead target twice, which is two genuine links and two genuine
      // removals. The fixture is kept because it is the strongest available test
      // of the grouping: one splice pass, every finding still attributed.
      expect(links).toHaveLength(4)
      expect(links.map((p) => p.outcome)).toEqual(['removed:2', 'removed:2', 'removed:2', 'removed:2'])
      expect(result.applied).toBe(result.plans.filter((p) => p.safeToApply).length)
      expect(result.skipped).toBe(result.plans.length - result.applied)
      expect((await adrState()).related!.map((l) => l.id)).toEqual(['k-live'])
    })
  })

  describe('a workspace whose read model is a redirect', () => {
    // A sparse draft registers `base_version_id = <parent>`, so its `ro_*` rows
    // live under the PARENT's version_id. Every check here resolves referrers
    // from the draft's documents against targets queried by the draft's own id,
    // which returns nothing — so the whole draft reads as dangling and an apply
    // strips its compositions, group members, layout keys and ADR links.
    // A DISTINCT version id: `staticReadModelQueryWorkspaceIfPresent` caches
    // positive identities on a TTL, so redirecting the shared WS and deleting
    // the row again would leave the cache asserting the redirect for every
    // later test in the file.
    const DRAFT = { landscapeId: WS.landscapeId, versionId: 'V-DRAFT' }
    beforeEach(async () => {
      await db.pool.query(
        `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source, base_version_id)
         VALUES ($1, $2, 'sparse-draft', $3)
         ON CONFLICT (landscape_id, version_id) DO UPDATE SET base_version_id = EXCLUDED.base_version_id`,
        [DRAFT.landscapeId, DRAFT.versionId, WS.versionId])
      await db.pool.query(
        `INSERT INTO versions (landscape_id, id, root_url) VALUES ($1,$2,$3)
         ON CONFLICT (landscape_id, id) DO UPDATE SET root_url = EXCLUDED.root_url`,
        [DRAFT.landscapeId, DRAFT.versionId, rootUrl])
    })
    afterEach(async () => {
      await db.pool.query(`DELETE FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2`,
        [DRAFT.landscapeId, DRAFT.versionId])
    })

    it('refuses the DRY RUN, not just the apply', async () => {
      // Refusing only the apply would still show an operator a page of false
      // findings and a live Apply button.
      await expect(repairReferenceIntegrity(db.pool, repo, DRAFT)).rejects.toThrow(/sparse draft/)
    })

    it('refuses an apply and writes nothing', async () => {
      // The root resolves and the documents are real — the refusal is about the
      // read model being somewhere else, not about a missing workspace.
      const before = await diagramState()
      await expect(repairReferenceIntegrity(db.pool, repo, { ...DRAFT, documents: true, apply: true }))
        .rejects.toThrow(new RegExp(WS.versionId))
      expect(await diagramState()).toEqual(before)
    })
  })

  // A CROSS-BRANCH DEFECT: neither side had it alone.
  //
  // This repair reads "absent from ro_*" as "deleted", and classifies
  // diagram.objectIds / diagram.connectionIds / group.objectIds as
  // safeToApply: true — an apply strips the ids from every diagram AND deletes
  // their saved layout positions. Meanwhile the read-model hardening made a
  // projection able to COMPLETE WITH HOLES (`readEntityMapOrDefect` returns an
  // empty map plus a recorded defect when a shard is unreadable) and made
  // projectors per-workspace and LRU-capped, so empty ro_* tables are routine.
  //
  // Put together, one unreadable object shard at projection time would have let
  // an apply permanently delete those objects from every diagram. Refusing is
  // the same answer, and for the same reason, as the sparse-draft refusal
  // directly above it in the source.
  describe('a read model that cannot be trusted as ground truth', () => {
    const setState = async (sql: string, params: unknown[] = []) =>
      db.pool.query(`UPDATE read_model_projection_state SET ${sql}
                      WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId, ...params])

    it('refuses when the workspace has never been projected', async () => {
      await db.pool.query('DELETE FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId])
      await expect(repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
        .rejects.toThrow(/never been projected/)
    })

    it('refuses while the projector is degraded', async () => {
      await setState('degraded_since = now()')
      await expect(repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
        .rejects.toThrow(/degraded since/)
    })

    // The one that matters most: the projection SUCCEEDED, and recorded that it
    // could not read some documents. Everything those documents contained is
    // missing from ro_* and would read here as deleted.
    it('refuses when the last extraction recorded unreadable documents', async () => {
      await setState("defect_count = 3, defect_summary = 'object shard unreadable'")
      await expect(repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
        .rejects.toThrow(/3 unreadable document/)
    })

    it('refuses when the last projection attempt failed', async () => {
      await setState('observed_generation = 5, projected_generation = 4, last_error_generation = 5')
      await expect(repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
        .rejects.toThrow(/generation 5\) failed/)
    })

    // The DRY RUN is refused too, deliberately: the console shows its findings
    // to a human who is about to click apply, and a list of false deletions is
    // not a safer thing to show than a false deletion.
    it('refuses the dry run as well, not just the apply', async () => {
      await setState('degraded_since = now()')
      await expect(repairReferenceIntegrity(db.pool, repo, { ...WS }))
        .rejects.toThrow(/cannot be checked right now/)
    })
  })

  it('reports the scan cap so a partial repair is never read as a complete one', async () => {
    // `diagram.groupIds` alone has two findings, so a cap of 1 must cut it.
    const result = await repairReferenceIntegrity(db.pool, repo, { ...WS, limit: 1 })
    const full = await scanReferenceIntegrity(db.pool, WS)
    expect(full.countsByKind['diagram.groupIds']).toBe(2)
    expect(result.truncated).toBe(true)
    expect((await repairReferenceIntegrity(db.pool, repo, WS)).truncated).toBe(false)
  })

  // ── the LIFECYCLE apply lock ───────────────────────────────────────────────
  //
  // Each arm builds the losing interleaving, with a witness proving both
  // halves ran, so it fails if the lock is removed.
  //
  // THE TRAP THIS SUITE AVOIDS: when nothing is actionable, the apply returns
  // `applied: 0` and throws nothing, from an early return that happens BEFORE
  // the lock is ever asked for. So "the apply changed nothing" is satisfied by
  // a fixture with nothing to repair, identically on locked and unlocked code.
  // Every arm therefore asserts the THROWN refusal, and the first one carries a
  // control proving the same fixture applies when the key is free.
  describe('the lifecycle apply lock', () => {
    const LIFECYCLE_LOCK_CLASS = 0x5359

    // Recomputed from the key TEXT rather than imported from the module under
    // test, on purpose: a test that calls `lifecycleLockKey` cannot notice
    // `lifecycleLockKey` changing, and this hash IS the wire format of an
    // exclusion between processes — a door on the old build must keep excluding
    // a door on the new one.
    const lockKey = (landscapeId: string, versionId: string): number => {
      const text = `promote-summary:${landscapeId}:${versionId}`
      let hash = 0x811c9dc5
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
      }
      return hash | 0
    }
    const KEY = lockKey(WS.landscapeId, WS.versionId)

    /**
     * Held copies of THIS workspace's key.
     *
     * Filtered by `objid` as well as `classid`, unlike the copies of this query
     * in `promoteSummaryWorkspace.integration.test.ts`: isolated SCHEMAS share
     * one database, so a classid-only count in a parallel vitest worker also
     * sees that suite's keys. `objid` is an unsigned `oid` while the key is a
     * signed int4, hence the `>>> 0` and the bigint comparison.
     */
    const heldForWorkspaceNow = async (): Promise<number> => {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND objid::bigint = $2
            AND objsubid = 2 AND granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [LIFECYCLE_LOCK_CLASS, KEY >>> 0],
      )
      return Number(rows[0].n)
    }

    /**
     * The same count, with the instrument's OWN CONTROL taken on every call.
     *
     * WHY. Most arms assert `toBe(0)`, and a witness that can only return zero
     * (e.g. a predicate broken into `AND false`) satisfies `toBe(0)` forever.
     * A control in a neighbouring arm does not protect the others.
     *
     * BOTH BRANCHES ARE THE CONTROL, which is what lets one helper serve arms
     * that expect 0 and arms that expect 1:
     *
     *  - the key is free, so we take it: the count must rise by EXACTLY one.
     *    `+1` rather than `> 0` — a witness that miscounts some other way is a
     *    different defect and `> 0` would pass straight through it.
     *  - the key is held, so our `pg_try_` is refused: that refusal is itself
     *    proof a key exists, so a witness answering zero is provably blind.
     *
     * Every call therefore carries its own evidence, and no arm depends on
     * another arm having run.
     */
    const heldForWorkspace = async (): Promise<number> => {
      const before = await heldForWorkspaceNow()
      const client = await db.pool.connect()
      try {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1, $2) AS locked', [LIFECYCLE_LOCK_CLASS, KEY],
        )
        if (rows[0]?.locked === true) {
          const witnessed = await heldForWorkspaceNow()
          await client.query('SELECT pg_advisory_unlock($1, $2)', [LIFECYCLE_LOCK_CLASS, KEY])
          if (witnessed !== before + 1) {
            throw new Error(
              `the pg_locks witness cannot report a held key: ${before} with none of its own held, `
              + `${witnessed} while holding one. Every assertion backed by it is vacuous.`,
            )
          }
        } else if (before === 0) {
          throw new Error(
            'the pg_locks witness reported 0 held keys while pg_try_advisory_lock was REFUSED the '
            + 'same key — somebody holds it and the witness cannot see it.',
          )
        }
      } finally {
        client.release()
      }
      return before
    }

    /** A neighbouring lifecycle door holding the key on its own session. */
    const neighbourTakesKey = async (): Promise<() => Promise<void>> => {
      const client = await db.pool.connect()
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked', [LIFECYCLE_LOCK_CLASS, KEY])
      // LIVENESS. Without this the refusal below could be a refusal for any
      // other reason and the test would still be green.
      expect(rows[0].locked).toBe(true)
      return async () => {
        const { rows: out } = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1, $2) AS unlocked', [LIFECYCLE_LOCK_CLASS, KEY])
        client.release(out[0].unlocked !== true)
      }
    }

    /**
     * A frozen copy of EVERYTHING the apply can touch.
     *
     * Frozen because `diagramState()` reads through live Automerge proxies, so
     * a plain reference would follow the document and make `not.toEqual` pass
     * for the wrong reason.
     *
     * WIDE because `diagramState()` alone reads one diagram's
     * `objectIds`/`groupIds`/`layoutKeys`/`parentObjectId`/`stub`; it cannot see
     * the model doc's groups or decision records, or `layouts3d`. A write to
     * those (e.g. ADR links stripped before the re-read refuses) would pass
     * every "nothing was written" assertion otherwise.
     */
    const snapshot = async () => {
      const { findReadyDocument } = await import('../automergeRepoCompat.js')
      const rootDoc = (await findReadyDocument<{ modelUrl?: string }>(repo, rootUrl)).doc()
      const model = (await findReadyDocument<Record<string, unknown>>(repo, rootDoc!.modelUrl!)).doc()
      const { findDiagram } = await import('../ai/core/modelOps.js')
      const found = await findDiagram(repo, rootUrl, 'dg-holder')
      const diagram = found?.doc.doc() as Record<string, unknown> | undefined
      return JSON.parse(JSON.stringify({
        diagram: await diagramState(),
        // The three the narrow snapshot could not see.
        layouts3d: diagram?.layouts3d ?? null,
        groups: model?.groups ?? null,
        decisionRecords: model?.decisionRecords ?? null,
      })) as unknown
    }

    it('REFUSES an apply while a neighbour holds the key — and applies once it is free', async () => {
      const before = await snapshot()
      const release = await neighbourTakesKey()
      await expect(repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
        .rejects.toThrow(/holds the apply lock/)
      // The half that makes this a data test rather than a blocker test.
      expect(await snapshot()).toEqual(before)
      await release()

      // THE CONTROL. The identical call on the identical fixture APPLIES once
      // the key is free, which is what rules out "it rejected because there was
      // nothing to do" — that path never reaches the lock at all.
      const applied = await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
      expect(applied.applied).toBeGreaterThan(0)
      expect(await snapshot()).not.toEqual(before)
    })

    it('leaves the DRY RUN ungated — it is the report an operator reads mid-promotion', async () => {
      const release = await neighbourTakesKey()
      try {
        const result = await repairReferenceIntegrity(db.pool, repo, WS)
        expect(result.reportOnly).toBe(true)
        expect(result.plans.length).toBeGreaterThan(0)
      } finally {
        await release()
      }
    })

    it('refuses when a promotion COMPLETES between the evidence and the apply', async () => {
      // The lock excludes a neighbour running NOW; it says nothing about one
      // that committed and released while this run was scanning — and the
      // promotion's own window between its static commit and its root flip is
      // ≥15 s, so that is the common case. This is the arm that proves the
      // re-read under the lock is load-bearing and not ornament.
      const before = await snapshot()
      await expect(repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        onStep: async (step) => {
          if (step !== 'planned') return
          // Exactly what a promotion commits at its step 3.
          await db.pool.query(
            `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
             VALUES ($1, $2, 'promote-summary-workspace')
             ON CONFLICT (landscape_id, version_id) DO UPDATE SET source = EXCLUDED.source`,
            [WS.landscapeId, WS.versionId],
          )
        },
      })).rejects.toThrow(/read_model_static_workspaces\.source moved from none to promote-summary-workspace/)
      expect(await snapshot()).toEqual(before)
      // The throw came from INSIDE the critical section, which is the easiest
      // way there is to leak a session lock.
      expect(await heldForWorkspace()).toBe(0)
    })

    it('refuses a transition that lands DURING THE SCAN, not only after it', async () => {
      // The fingerprint must cover the whole evidence window, not just the part
      // after the scan. The other arms' seam fires after the scan, the walk
      // AND the planner, so they cannot tell an early sample from a late one.
      // This arm fires in the earlier window: a late sample would read the
      // already-mutated value and NOT refuse.
      const before = await snapshot()
      await expect(repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        documents: true,
        onStep: async (step) => {
          if (step !== 'fingerprint-taken') return
          await db.pool.query(
            `INSERT INTO read_model_static_workspaces (landscape_id, version_id, source)
             VALUES ($1, $2, 'promote-summary-workspace')
             ON CONFLICT (landscape_id, version_id) DO UPDATE SET source = EXCLUDED.source`,
            [WS.landscapeId, WS.versionId],
          )
        },
      })).rejects.toThrow(/read_model_static_workspaces\.source moved/)
      expect(await snapshot()).toEqual(before)
      expect(await heldForWorkspace()).toBe(0)
    })

    it('refuses when the ROOT CONTRACT moves — the door that moves no SQL at all', async () => {
      // Why the fingerprint is four fields and not just
      // `read_model_static_workspaces.source` and `versions.root_url`:
      // `repairSummaryFlag` writes NO SQL whatsoever and flips the root in
      // place, same url. It could run to completion inside this run's evidence
      // window, change which registry the workspace reads and writes, and be
      // invisible to both SQL witnesses.
      const before = await snapshot()
      await expect(repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        onStep: async (step) => {
          if (step !== 'planned') return
          // Exactly what the flag repair's root half does: set the summary
          // contract on the root, in place.
          const { findReadyDocument } = await import('../automergeRepoCompat.js')
          const handle = await findReadyDocument<Record<string, unknown>>(repo, rootUrl)
          handle.change((doc) => {
            doc.registrySummaryOnly = true
            doc.registryWriteUrl = 'automerge:2FreshWriteHead'
          })
          await repo.flush()
        },
      })).rejects.toThrow(/registrySummaryOnly moved from false to true/)
      expect(await snapshot()).toEqual(before)
      expect(await heldForWorkspace()).toBe(0)
    })

    it('refuses when only the WRITE HEAD moves, with the summary flag already set', async () => {
      // The flag repair sets `registrySummaryOnly` and `registryWriteUrl`
      // together, so the arm above trips on the first check and leaves the
      // second one unexercised. A workspace that is ALREADY summary-only can
      // still have its write head re-pointed (a promotion mints a fresh one),
      // and that alone means the plans name a registry the workspace has
      // stopped writing to.
      const { findReadyDocument } = await import('../automergeRepoCompat.js')
      const handle = await findReadyDocument<Record<string, unknown>>(repo, rootUrl)
      handle.change((doc) => {
        doc.registrySummaryOnly = true
        doc.registryWriteUrl = 'automerge:2HeadBefore'
      })
      await repo.flush()

      await expect(repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        onStep: async (step) => {
          if (step !== 'planned') return
          handle.change((doc) => { doc.registryWriteUrl = 'automerge:2HeadAfter' })
          await repo.flush()
        },
      })).rejects.toThrow(/registryWriteUrl moved from automerge:2HeadBefore to automerge:2HeadAfter/)
      expect(await heldForWorkspace()).toBe(0)
    })

    it('refuses when the root moves under the run — the plans address the OLD registry', async () => {
      const before = await snapshot()
      await expect(repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        onStep: async (step) => {
          if (step !== 'planned') return
          await db.pool.query(
            `UPDATE versions SET root_url = 'automerge:2ForkedElsewhere'
              WHERE landscape_id = $1 AND id = $2`,
            [WS.landscapeId, WS.versionId],
          )
        },
      })).rejects.toThrow(/versions\.root_url moved/)
      expect(await snapshot()).toEqual(before)
    })

    it('refuses when the read model goes untrustworthy under the run', async () => {
      // The entry point already refuses a degraded projection — on a SNAPSHOT
      // taken before the scan. This arm is the one that shows the snapshot was
      // not enough: the degradation lands after that check has passed.
      await expect(repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        onStep: async (step) => {
          if (step !== 'planned') return
          await db.pool.query(
            `UPDATE read_model_projection_state SET degraded_since = now()
              WHERE landscape_id = $1 AND version_id = $2`,
            [WS.landscapeId, WS.versionId],
          )
        },
      })).rejects.toThrow(/no longer trustworthy/)
    })

    it('RELEASES the key on every path — with a control that sees it held', async () => {
      expect(await heldForWorkspace()).toBe(0)

      // CONTROL: the instrument can report a held key. A zero from a query that
      // can only ever return zero is the measurement this repository has been
      // burned by most often.
      const release = await neighbourTakesKey()
      expect(await heldForWorkspace()).toBe(1)
      await expect(repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
        .rejects.toThrow(/holds the apply lock/)
      // Still exactly one — the refused acquire released its probe connection
      // without taking anything, so it neither leaked nor stole the neighbour's.
      expect(await heldForWorkspace()).toBe(1)
      await release()
      expect(await heldForWorkspace()).toBe(0)

      // The success path.
      expect((await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })).applied)
        .toBeGreaterThan(0)
      expect(await heldForWorkspace()).toBe(0)
    })

    it('passes `limit` through to the DOCUMENT WALK — and does not pretend it bounds everything', async () => {
      // `limit` caps the SQL leg and the walk's per-diagram pass. It does NOT
      // bound the group leg: `group.*` findings come from ONE ModelMeta
      // document that the walk always reads whole, so no caller-supplied number
      // reduces them. That is why an oversized apply SLICES instead of refusing.
      const walked = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
      const groupKinds = new Set(['group.parentObjectId', 'group.objectIds'])
      const groupFindings = (result: { plans: { finding: { kind: string } }[] }) =>
        result.plans.filter((plan) => groupKinds.has(plan.finding.kind)).length
      // CONTROL: the fixture really produces group findings, so the equality
      // below is between two populated numbers rather than two zeroes.
      expect(groupFindings(walked)).toBeGreaterThan(0)
      const narrowed = await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true, limit: 1 })
      expect(groupFindings(narrowed)).toBe(groupFindings(walked))
      // And the option really is threaded: the SQL leg — the one `limit` has
      // always bounded — shrinks in the same call.
      expect(narrowed.plans.length).toBeLessThan(walked.plans.length)
    })

    it('REFUSES when the writing session cannot prove it holds the key — nothing is written', async () => {
      // The possession check in `assertWorkspaceHeldStill`, exercised through
      // this call site. The lock module's own suite exercises
      // `sessionHoldsLifecycleLock` DIRECTLY, which cannot prove this door
      // actually calls it.
      //
      // DRIVEN, not simulated: the proxy lets the real `pg_try_advisory_lock`
      // run and then issues `pg_advisory_unlock_all()` on the SAME pinned
      // client, so the session genuinely stops holding the key it just took —
      // the state a killed backend leaves for anyone still holding a reference.
      // Everything downstream is the real check on a real connection.
      const before = await snapshot()
      let dropped = 0
      const losesTheKey = new Proxy(db.pool, {
        get(target, property, receiver) {
          if (property !== 'connect') {
            const value = Reflect.get(target, property, receiver) as unknown
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
          }
          return async () => {
            const client = await target.connect()
            return new Proxy(client, {
              get(clientTarget, clientProperty, clientReceiver) {
                if (clientProperty !== 'query') {
                  const value = Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown
                  return typeof value === 'function'
                    ? (value as (...a: unknown[]) => unknown).bind(clientTarget) : value
                }
                return async (text: string, params?: unknown[]) => {
                  const result = await clientTarget.query(text, params)
                  if (typeof text === 'string' && text.includes('pg_try_advisory_lock')) {
                    await clientTarget.query('SELECT pg_advisory_unlock_all()')
                    dropped += 1
                  }
                  return result
                }
              },
            })
          }
        },
      }) as typeof db.pool

      const refusal = await repairReferenceIntegrity(losesTheKey, repo, { ...WS, apply: true })
        .then(() => null, (error: unknown) => error)
      // LIVENESS: the fault really was injected, so a refusal for some other
      // reason cannot pass as this one.
      expect(dropped).toBe(1)
      expect((refusal as { code?: string } | null)?.code).toBe('exclusion-unproven')
      expect((refusal as Error).message).toMatch(/NOTHING was written/)
      // The check is the FIRST statement of the re-read for this reason: every
      // line after it reads state in order to decide whether to write.
      expect(await snapshot()).toEqual(before)
      expect(await heldForWorkspace()).toBe(0)

      // CONTROL: the identical fixture through the real pool APPLIES, which
      // rules out "it refused because there was nothing to do" — that path
      // returns `applied: 0` from an early return and never reaches the lock.
      const applied = await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
      expect(applied.applied).toBeGreaterThan(0)
      expect(await snapshot()).not.toEqual(before)
    })

    it('measures the hold rather than pinning its TYPE — heldForMs reflects real elapsed time', async () => {
      // THE SURVIVOR: `heldForMs` was asserted only as `expect.any(Number)`, so
      // hard-wiring it to 0 left every arm green. That also silently disables
      // `LOCK_HOLD_SOFT_CEILING_MS`, whose whole stated purpose is to PRODUCE
      // the measurement nobody has taken — a detector that can never fire.
      const held = 40
      const result = await repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        onStep: async (step) => {
          if (step !== 'applied') return
          await new Promise((resolve) => setTimeout(resolve, held))
        },
      })
      expect(result.applied).toBeGreaterThan(0)
      // A LOWER bound only. An upper one would be a timing bet on a shared CI
      // machine, and this arm is about "is it measured", not "is it fast".
      expect(result.applyIntegrity?.heldForMs).toBeGreaterThanOrEqual(held)
    })

    it('SLICES an apply too large for one held-lock window, and converges over runs', async () => {
      // SLICING rather than refusing: `limit` does not reach the group
      // findings, which come from one ModelMeta document, so a refusal telling
      // the operator to "re-run with a smaller `limit`" could block a workspace
      // with many dangling group members permanently.
      //
      // 502 actionable findings: 501 dangling composition rows plus the
      // fixture's own `obj-gone`. They sort AFTER it, so the first slice
      // contains the real repair and the arm measures documents changing.
      const bulk = Array.from({ length: 501 }, (_, index) => `zz-bulk-${String(index).padStart(3, '0')}`)
      await db.pool.query(
        `INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id)
         SELECT $1, $2, 'dg-holder', unnest($3::text[])`,
        [WS.landscapeId, WS.versionId, bulk],
      )
      const before = await snapshot()

      const first = await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true, limit: 600 })
      // BOUNDED: strictly fewer than were actionable, and not more than the cap.
      expect(first.applied).toBeLessThanOrEqual(500)
      expect(first.applied).toBeGreaterThan(0)
      // AND IT SAYS SO. `truncated` is the field the console already reads as
      // "this is not the whole story"; without it a partial apply is
      // indistinguishable from a complete one, which is the silent direction.
      expect(first.truncated).toBe(true)
      expect(await snapshot()).not.toEqual(before)
      expect(await heldForWorkspace()).toBe(0)

      // RE-RUNNABLE, which is the property that makes slicing safe: the next
      // run is ADMITTED and applies again, rather than hitting a state the
      // operator cannot leave.
      //
      // It does NOT converge to `truncated: false` on this fixture: the repair
      // writes DOCUMENTS and never touches `ro_*`, so the same read-model rows
      // produce the same findings on every pass. Convergence is a property of
      // a workspace whose projector re-runs, not of this fixture.
      const second = await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true, limit: 600 })
      expect(second.applied).toBeGreaterThan(0)

      // THE BOUND IS TAKEN BEFORE THE LOCK, and this is what proves it rather
      // than asserting it. `heldForWorkspace()` is sampled after release and
      // cannot see a lock taken and given back, so it cannot tell where the
      // check runs. With
      // a neighbour holding the key the two orderings answer DIFFERENTLY:
      // taken before, the slice is computed and the door is then refused for
      // the lock; taken inside, the slicing never happens at all.
      await db.pool.query(
        `INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id)
         SELECT $1, $2, 'dg-holder', unnest($3::text[])`,
        [WS.landscapeId, WS.versionId, bulk.map((id) => `${id}-b`)],
      )
      const release = await neighbourTakesKey()
      try {
        const refused = await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true, limit: 600 })
          .then(() => null, (error: unknown) => error)
        expect((refused as { code?: string } | null)?.code).toBe('lock-unavailable')
      } finally {
        await release()
      }
    })

    it('REPORTS a read model that goes untrustworthy DURING the apply — and stays quiet otherwise', async () => {
      // THE RESIDUE: "the re-read is an invariant only against doors that take
      // this key. `degraded_since` is written by the projector, which takes no
      // lifecycle lock, so a workspace can degrade IN THE MIDDLE of an apply
      // and nothing here sees it."
      //
      // Every guard before the writes passes, the writes land, and the workspace
      // is degraded by then. The run is NOT failed — the documents are already
      // written and there is nothing to refuse — so the contract is that it says
      // so, loudly and in the result.
      const degraded = await repairReferenceIntegrity(db.pool, repo, {
        ...WS,
        apply: true,
        onStep: async (step) => {
          if (step !== 'applied') return
          // Exactly what `projectorService` writes when a projection fails.
          await db.pool.query(
            `UPDATE read_model_projection_state SET degraded_since = now()
              WHERE landscape_id = $1 AND version_id = $2`,
            [WS.landscapeId, WS.versionId],
          )
        },
      })
      expect(degraded.applied).toBeGreaterThan(0)
      expect(degraded.applyIntegrity?.degradedDuringApply).toMatch(/projector has been degraded/)
      // The exclusion itself was never in doubt — the two are independent
      // failures and reporting one must not imply the other.
      expect(degraded.applyIntegrity?.exclusionProven).toBe(true)

      // CONTROL: the same call with no degradation reports none. Without it
      // this arm passes against a field wired to a constant.
      await db.pool.query(
        `UPDATE read_model_projection_state SET degraded_since = NULL
          WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )
      await db.pool.query(
        `INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id)
         VALUES ($1, $2, 'dg-holder', 'obj-second-round')`,
        [WS.landscapeId, WS.versionId],
      )
      const healthy = await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
      expect(healthy.applied).toBeGreaterThan(0)
      expect(healthy.applyIntegrity).toEqual({
        exclusionProven: true,
        degradedDuringApply: null,
        heldForMs: expect.any(Number),
      })
    })

    it('FLUSHES exactly the documents it changed, and never the whole process', async () => {
      // THE RESIDUE: "no wall-clock ceiling on the critical section, where
      // `repo.flush()` with no argument drains every document resident in the
      // process — a cost this task MOVED INSIDE the lock. Passing the touched
      // ids is the obvious fix and is not done here."
      //
      // WHY THIS ARM AND NOT A READING OF THE CODE. Scoping a flush fails in
      // the silent direction: a document that changed and is not named is
      // reported durable while it lives only in memory, and a crash then loses
      // a repair the operator was told had succeeded. Nothing about that is
      // visible in a passing suite. So the set is not asserted — it is DIFFED
      // against what actually changed.
      type Handles = Record<string, { doc: () => unknown }>
      const contentOf = (): Map<string, string> => {
        const out = new Map<string, string>()
        // A synchronous walk with no `await` inside it, so the snapshot array
        // does not pin every DocHandle and its WASM document — the trap
        // `automergeRepoCompat.ts` documents for exactly this loop shape.
        for (const [id, handle] of Object.entries(repo.handles as unknown as Handles)) {
          out.set(id, JSON.stringify(handle.doc() ?? null))
        }
        return out
      }

      // Make every document this apply can reach RESIDENT first, so "changed"
      // below is a comparison and not a first sighting.
      await repairReferenceIntegrity(db.pool, repo, { ...WS, documents: true })
      const before = contentOf()
      expect(before.size).toBeGreaterThan(1)

      const flushable = repo as unknown as { flush: (ids?: string[]) => Promise<void> }
      const realFlush = flushable.flush.bind(repo)
      let flushed: string[] | undefined
      let wholeProcessFlushes = 0
      flushable.flush = async (ids?: string[]) => {
        if (ids === undefined) wholeProcessFlushes += 1
        else flushed = [...ids]
        return realFlush(ids)
      }
      try {
        const applied = await repairReferenceIntegrity(db.pool, repo, {
          ...WS, apply: true, documents: true,
        })
        expect(applied.applied).toBeGreaterThan(0)
      } finally {
        flushable.flush = realFlush
      }

      const after = contentOf()
      const changed = [...after.keys()].filter((id) => before.get(id) !== after.get(id))
      // CONTROL. Without it, an empty `missing` is satisfied by an apply that
      // changed nothing at all — which is the same vacuity trap the rest of
      // this block was built around.
      expect(changed.length).toBeGreaterThan(0)

      // THE PROPERTY: nothing changed that was not flushed.
      expect(changed.filter((id) => !flushed?.includes(id))).toEqual([])
      // AND the scoping itself, which the line above cannot see: a repo-wide
      // flush would also satisfy it, while waiting on every other workspace's
      // documents inside a lock three sibling doors are blocked on.
      expect(wholeProcessFlushes).toBe(0)
      expect(flushed).toBeDefined()
    })

    it('leaves applyIntegrity ABSENT when no write happened — absence is "no apply", not "all fine"', async () => {
      // The field's whole contract in one arm. A dry run and an apply with
      // nothing actionable both take no lock and write nothing, so reporting
      // `exclusionProven: true` for them would be a guarantee about a critical
      // section that never existed.
      const dry = await repairReferenceIntegrity(db.pool, repo, WS)
      expect(dry.reportOnly).toBe(true)
      expect(dry.applyIntegrity).toBeUndefined()

      // CONTROL: an apply that DOES write carries the field. Both halves are
      // needed — `toBeUndefined()` alone passes against a field nothing ever
      // sets.
      expect((await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true }))
        .applyIntegrity).toBeDefined()

      // Now drain the EVIDENCE, not the documents. Re-running the repair is not
      // enough: it repairs the CRDT and never touches `ro_*`, so the same SQL
      // rows produce the same findings on every pass.
      await db.pool.query(`DELETE FROM ro_diagram_objects WHERE object_id <> 'obj-live'`)
      await db.pool.query(`DELETE FROM ro_diagram_groups WHERE group_id <> 'grp-live'`)
      await db.pool.query(`UPDATE ro_diagrams SET parent_object_id = NULL`)
      await db.pool.query(`DELETE FROM ro_decision_records`)

      const empty = await repairReferenceIntegrity(db.pool, repo, { ...WS, apply: true })
      expect(empty.plans.filter((plan) => plan.safeToApply)).toEqual([])
      expect(empty.applied).toBe(0)
      expect(empty.applyIntegrity).toBeUndefined()
    })
  })
})
