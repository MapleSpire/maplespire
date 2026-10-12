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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SQL_CHECKED_KINDS,
  classifyReferenceFinding,
  scanReferenceIntegrity,
  type ReferenceKind,
} from './referenceIntegrityScan.js'
import { DOCUMENT_CHECKED_KINDS, UNCHECKED_KINDS } from './referenceFindings.js'

describe('classifyReferenceFinding', () => {
  it('treats a connection with a missing endpoint as orphaned, not repairable by clearing', () => {
    // There is no half-connection: the only repair is deleting it, which is
    // destructive and must never ride a bulk apply.
    expect(classifyReferenceFinding('connection.endpoint'))
      .toEqual({ severity: 'orphaned', repairIsRemoval: false })
  })

  it('reports a dangling object parent as EXPECTED rather than an error', () => {
    // Client and server deliberately disagree about cascading `parentId`, and
    // both read paths already re-root a dangling parent on purpose. Flagging it
    // as damage would make every scan permanently red on a healthy model.
    expect(classifyReferenceFinding('object.parentId').severity).toBe('expected')
  })

  it('treats every other kind as a plain dangling reference the referrer survives', () => {
    for (const kind of SQL_CHECKED_KINDS) {
      if (kind === 'connection.endpoint' || kind === 'object.parentId') continue
      expect(classifyReferenceFinding(kind), kind)
        .toEqual({ severity: 'dangling', repairIsRemoval: true })
    }
  })

  it('names what NEITHER leg checks, so a clean report is not read as a clean model', () => {
    // Only two survive now that the document walk exists, and each is a
    // deliberate refusal rather than a gap: skins are client plugins the server
    // cannot resolve, and a comment lives inside its DiagramDoc so it cannot
    // dangle at all.
    expect([...UNCHECKED_KINDS].sort()).toEqual(['comment.diagramId', 'diagram.skinId'])
    for (const kind of UNCHECKED_KINDS) {
      expect(SQL_CHECKED_KINDS).not.toContain(kind as unknown as ReferenceKind)
      expect(DOCUMENT_CHECKED_KINDS).not.toContain(kind as unknown as ReferenceKind)
    }
  })

  it('claims a kind on both legs ONLY where the two see disjoint populations', () => {
    // The default remains one kind, one leg: a kind claimed by neither is
    // silently dropped by the shared classifier, and one claimed by both is
    // double-reported for no gain.
    //
    // The ADR kinds are the deliberate exception, and the exception is forced.
    // `ro_decision_records` is written ONLY by the static delta projector and the
    // one-shot performance baseline, so on an ORDINARY workspace the SQL leg
    // queries an empty table and is structurally blind; on a PAGED workspace the
    // document holds only the edit overlay and the document leg abstains. Each
    // leg is the only one that can answer for its half.
    //
    // If this list ever grows, the new entry needs the same argument: name the
    // population the other leg cannot see. "Belt and braces" is not one — the
    // repair would then plan the same removal twice.
    const overlap = SQL_CHECKED_KINDS.filter((k) => (DOCUMENT_CHECKED_KINDS as readonly string[]).includes(k))
    expect([...overlap].sort()).toEqual(['decisionRecord.related.adr', 'decisionRecord.related.diagram'])
  })
})

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('scanReferenceIntegrity (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb
  const WS = { landscapeId: 'L1', versionId: 'V1' }
  const OTHER = { landscapeId: 'L1', versionId: 'V2' }

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'reference_integrity')
    const { ensureReadModelSchema } = await import('../readModel/schema.js')
    await ensureReadModelSchema(db.pool)

    const q = (text: string, params: unknown[] = []) => db.pool.query(text, params)
    const w = [WS.landscapeId, WS.versionId]
    const o = [OTHER.landscapeId, OTHER.versionId]

    // ── the surviving model ──────────────────────────────────────────────────
    await q(`INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES
      ($1,$2,'obj-live','{}'::jsonb), ($1,$2,'obj-child','{}'::jsonb)`, w)
    await q(`UPDATE ro_objects SET parent_id = 'obj-live' WHERE id = 'obj-child'`)
    await q(`INSERT INTO ro_groups (landscape_id, version_id, id, name, data) VALUES ($1,$2,'grp-live','G','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES
      ($1,$2,'dg-live','{}'::jsonb), ($1,$2,'dg-holder','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_decision_records (landscape_id, version_id, id, data) VALUES
      ($1,$2,'adr-live','{"related":[]}'::jsonb)`, w)

    // ── one planted break per check, each with a healthy twin beside it ──────
    await q(`INSERT INTO ro_decision_records (landscape_id, version_id, id, data) VALUES ($1,$2,'adr-src',$3::jsonb)`,
      [...w, JSON.stringify({ related: [
        { id: 'k1', type: 'diagram', targetId: 'dg-live' },     // healthy
        { id: 'k2', type: 'diagram', targetId: 'dg-gone' },     // dangling
        { id: 'k3', type: 'adr', targetId: 'adr-live' },        // healthy
        { id: 'k4', type: 'draft', targetId: 'adr-gone' },      // dangling
        { id: 'k5', type: 'url', url: 'https://example.test' }, // never a model ref
        { id: 'k6', type: 'diagram' },                          // no targetId at all
      ] })])
    await q(`UPDATE ro_diagrams SET parent_object_id = 'obj-live' WHERE id = 'dg-live'`)
    await q(`UPDATE ro_diagrams SET parent_object_id = 'obj-gone' WHERE id = 'dg-holder'`)
    await q(`INSERT INTO ro_diagram_groups (landscape_id, version_id, diagram_id, group_id) VALUES
      ($1,$2,'dg-holder','grp-live'), ($1,$2,'dg-holder','grp-gone'), ($1,$2,'dg-holder','grp-gone2')`, w)
    await q(`INSERT INTO ro_diagram_objects (landscape_id, version_id, diagram_id, object_id) VALUES
      ($1,$2,'dg-holder','obj-live'), ($1,$2,'dg-holder','obj-gone')`, w)
    await q(`INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data) VALUES
      ($1,$2,'conn-live','obj-live','obj-child','{}'::jsonb),
      ($1,$2,'conn-group','grp-live','obj-live','{}'::jsonb),
      ($1,$2,'conn-broken','obj-live','obj-gone','{}'::jsonb)`, w)
    await q(`INSERT INTO ro_diagram_connections (landscape_id, version_id, diagram_id, connection_id) VALUES
      ($1,$2,'dg-holder','conn-live'), ($1,$2,'dg-holder','conn-gone')`, w)
    await q(`INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1,$2,'obj-orphan','{}'::jsonb)`, w)
    await q(`UPDATE ro_objects SET parent_id = 'obj-gone' WHERE id = 'obj-orphan'`)

    // ── a DIFFERENT version holding the same ids, all healthy there ─────────
    // `forkRoot` copies ADR shards across versions with ids preserved, so an
    // unscoped join would resolve a reference against a foreign version.
    await q(`INSERT INTO ro_diagrams (landscape_id, version_id, id, data) VALUES ($1,$2,'dg-gone','{}'::jsonb)`, o)
    await q(`INSERT INTO ro_decision_records (landscape_id, version_id, id, data) VALUES ($1,$2,'adr-gone','{}'::jsonb)`, o)
    await q(`INSERT INTO ro_objects (landscape_id, version_id, id, data) VALUES ($1,$2,'obj-gone','{}'::jsonb)`, o)
    await q(`INSERT INTO ro_groups (landscape_id, version_id, id, name, data) VALUES ($1,$2,'grp-gone','G','{}'::jsonb)`, o)
  })

  afterAll(async () => { await db?.teardown() })

  const report = () => scanReferenceIntegrity(db.pool, { ...WS, now: () => new Date('2026-08-08T00:00:00Z') })
  const of = async (kind: ReferenceKind) => (await report()).findings.filter((f) => f.kind === kind)

  it('finds a decision-record link to a deleted diagram, and leaves the healthy one alone', async () => {
    const hits = await of('decisionRecord.related.diagram')
    expect(hits.map((f) => f.targetId)).toEqual(['dg-gone'])
    expect(hits[0].sourceId).toBe('adr-src')
  })

  it('finds a link to a deleted record across both adr and draft types', async () => {
    expect((await of('decisionRecord.related.adr')).map((f) => f.targetId)).toEqual(['adr-gone'])
  })

  it('ignores url links and links with no targetId', async () => {
    // A url link has no model target at all (sanitisation, not integrity), and a
    // link with no targetId is broken DATA, not a dangling reference. Reporting
    // either as dangling would make the console cry wolf.
    const all = (await report()).findings
    expect(all.some((f) => f.targetId === null || f.targetId === '')).toBe(false)
    expect(all.some((f) => f.targetId?.startsWith('https://'))).toBe(false)
  })

  it('finds a detail diagram whose parent object is gone', async () => {
    const hits = await of('diagram.parentObjectId')
    expect(hits.map((f) => f.sourceId)).toEqual(['dg-holder'])
    expect(hits[0].targetId).toBe('obj-gone')
  })

  it('finds every deleted group a diagram still lists, not just the first', async () => {
    // Group deletion no longer leaves these behind, but older workspaces can
    // still carry them.
    expect((await of('diagram.groupIds')).map((f) => f.targetId)).toEqual(['grp-gone', 'grp-gone2'])
  })

  it('finds diagram composition entries whose object or connection is gone', async () => {
    expect((await of('diagram.objectIds')).map((f) => f.targetId)).toEqual(['obj-gone'])
    expect((await of('diagram.connectionIds')).map((f) => f.targetId)).toEqual(['conn-gone'])
  })

  it('finds a connection with a missing endpoint WITHOUT flagging group endpoints', async () => {
    // Checking only ro_objects would report every group-anchored connection as
    // broken — the mistake that would make the whole console untrustworthy.
    const hits = await of('connection.endpoint')
    expect(hits.map((f) => f.sourceId)).toEqual(['conn-broken'])
    expect(hits[0].targetId).toBe('obj-gone')
    expect(hits[0].severity).toBe('orphaned')
  })

  it('reports a re-rooted object as expected, not as damage', async () => {
    const hits = await of('object.parentId')
    expect(hits.map((f) => f.sourceId)).toEqual(['obj-orphan'])
    expect(hits[0].severity).toBe('expected')
  })

  it('never resolves a reference against a DIFFERENT version that happens to share the id', async () => {
    // Every planted target exists under V2. If any check leaked across the
    // workspace boundary these findings would vanish.
    const kinds = new Set((await report()).findings.map((f) => f.kind))
    expect(kinds.has('decisionRecord.related.diagram')).toBe(true)
    expect(kinds.has('diagram.groupIds')).toBe(true)
  })

  it('reports an explicit zero for every check that found nothing', async () => {
    const clean = await scanReferenceIntegrity(db.pool, OTHER)
    expect(clean.findings).toEqual([])
    for (const kind of SQL_CHECKED_KINDS) expect(clean.countsByKind[kind], kind).toBe(0)
  })

  it('says which references it did not look at, on every report', async () => {
    const clean = await scanReferenceIntegrity(db.pool, OTHER)
    expect(clean.uncheckedKinds.length).toBeGreaterThan(0)
    expect(clean.reportOnly).toBe(true)
  })

  it('flags truncation rather than passing a capped list off as complete', async () => {
    // `diagram.groupIds` has two findings, so a limit of 1 must cut it AND say so.
    const capped = await scanReferenceIntegrity(db.pool, { ...WS, limit: 1 })
    expect(capped.truncated).toBe(true)
    expect(capped.countsByKind['diagram.groupIds']).toBe(1)
    expect((await report()).truncated).toBe(false)
  })

  it('sweeps every workspace when none is named', async () => {
    const all = await scanReferenceIntegrity(db.pool)
    expect(all.findings.length).toBeGreaterThan(0)
    expect(all.findings.every((f) => f.landscapeId === 'L1')).toBe(true)
  })

  it('mutates nothing', async () => {
    const countRows = async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM ro_objects) + (SELECT count(*) FROM ro_connections)
              + (SELECT count(*) FROM ro_diagram_groups) + (SELECT count(*) FROM ro_decision_records) AS n`)
      return rows[0].n
    }
    const before = await countRows()
    await report()
    expect(await countRows()).toBe(before)
  })
})
