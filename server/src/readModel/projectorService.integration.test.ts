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

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { startReadModelProjector } from './projectorService.js'
import { documentRetryRegistry } from './documentRetryQueue.js'
import { roObject, roGroup, roConnectionCount } from './queries.js'
import { verifyWorkspaceIntegrity } from './projectionIntegrity.js'
import type { WorkspaceKey } from './projector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const WS: WorkspaceKey = { landscapeId: 'ls1', versionId: 'v1' }

/**
 * End-to-end wiring test: an in-process Automerge repo + the live projector →
 * Postgres → query functions. Isolated in its own schema (rmwire_test) so the live
 * async subscription writes don't collide with the txn-isolated suites; skips when
 * no DB is reachable.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  // Dedicated schema so this file's committed writes never touch public ro_* tables.
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 4000, options: '-c search_path=rmwire_test,public' }), 'projectorService')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS rmwire_test')
      await ensureReadModelSchemaForTest(c)
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

async function ensureReadModelSchemaForTest(db: pg.PoolClient): Promise<void> {
  const { ensureReadModelSchema } = await import('./schema.js')
  await ensureReadModelSchema(db)
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[readModel wiring] no Postgres at ${URL} — skipping`)

/** Poll a condition (the projector's incremental writes are async, fire-and-forget). */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

suite('read-model projector wiring (in-process Automerge → Postgres)', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query('DROP SCHEMA IF EXISTS rmwire_test CASCADE')
    } finally {
      c.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    await pool!.query('TRUNCATE ro_objects, ro_connections, ro_groups, read_model_projection_state')
  })

  it('seals a digest a REAL cold build can be verified against, and detects a row removed behind its back', async () => {
    // The seam nothing else covers. The unit tests drive the projector with a
    // fake database, and the integrity suite drives a real database with a fake
    // projector; only here do a real Automerge repo, the real projector and a
    // real PostgreSQL meet, which is the combination the guarantee is claimed on.
    const repo = new Repo({})
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } } })
    const cs0 = repo.create({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } })
    const meta = repo.create({
      objectShardUrls: [os0.url], connectionShardUrls: [cs0.url], groups: { g1: { id: 'g1', name: 'G' } },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, cs0, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const sealed = await verifyWorkspaceIntegrity(pool!, WS)
      expect(sealed.outcome).toBe('verified')
      expect(sealed.defectCount).toBe(0)
      expect(sealed.verdicts.filter((verdict) => verdict.outcome === 'match')).toHaveLength(4)

      // A row disappears without the projector's knowledge — a partial commit, a
      // stray DELETE, a restore that lost rows. No CRDT comparison sees this
      // without re-deriving both sides; one aggregate does.
      await pool!.query(
        'DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
        [WS.landscapeId, WS.versionId, 'o1'],
      )
      const broken = await verifyWorkspaceIntegrity(pool!, WS)
      expect(broken.outcome).toBe('mismatch')
      const objectVerdict = broken.verdicts.find((verdict) => verdict.kind === 'object')
      expect(objectVerdict?.expected?.n).toBe(2)
      expect(objectVerdict?.actual?.n).toBe(1)

      // And once the projector advances, the sealed digest is honestly reported
      // as un-comparable rather than as a match or as corruption.
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['o9'] = { id: 'o9', name: 'Z' }
      })
      await until(() => roObject(pool!, WS, 'o9'), (value) => !!value)
      const moved = await until(
        () => verifyWorkspaceIntegrity(pool!, WS),
        (report) => report.verdicts.find((verdict) => verdict.kind === 'object')?.outcome === 'not-verifiable',
      )
      expect(moved.verdicts.find((verdict) => verdict.kind === 'object')?.outcome).toBe('not-verifiable')
      expect(moved.outcome).not.toBe('mismatch')
      // The other half of the carry-forward contract, and the half that makes it
      // honest: an object-shard delta invalidates ONLY `object`. If it also
      // dragged the kinds it never touched to `not-verifiable`, one edit anywhere
      // would blind the whole feature.
      for (const kind of ['connection', 'group', 'diagram'] as const) {
        expect(moved.verdicts.find((verdict) => verdict.kind === kind)?.outcome, kind).toBe('match')
      }
    } finally {
      stop()
    }
  }, 30_000)

  it('is still verifiable after boot on a workspace that HAS diagram documents', async () => {
    // `reconcileDiagramDocs` runs at the end of every boot and projects one
    // `registry` generation per resolvable diagram document
    // (syncConnectionFlows). Every projection bumps the generation, so a
    // projection that neither re-seals nor carries the digests forward leaves
    // all four kinds dated to a generation the read model has already left —
    // once per diagram, before `startReadModelProjector` even returns.
    //
    // A fixture whose diagrams have no `docUrl` never attaches one and never
    // sees this, hence the diagram documents here.
    const repo = new Repo({})
    const diagramDoc = repo.create({ layouts: {}, comments: {}, flows: {} })
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
    const registry = repo.create({
      diagrams: { d1: { id: 'd1', name: 'D', type: 'context', docUrl: diagramDoc.url } },
    })
    const meta = repo.create({ objectShardUrls: [os0.url], connectionShardUrls: [], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([diagramDoc, os0, registry, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const report = await verifyWorkspaceIntegrity(pool!, WS)
      expect(report.outcome).toBe('verified')
      // Every kind, not just the ones the flow projection happened to leave
      // alone: syncConnectionFlows writes only ro_connection_flows.
      expect(report.verdicts.filter((verdict) => verdict.outcome === 'match')).toHaveLength(4)
    } finally {
      stop()
    }
  }, 30_000)

  it('never re-dates a seal that had ALREADY gone stale, even from an honest carry-forward', async () => {
    // The carry-forward mechanism's trap:
    //
    //   g=N   cold build seals object {n:1}
    //   g=N+1 an object-shard delta adds an id and correctly declines to re-seal
    //   g=N+2 an unrelated GROUP edit truthfully reports it touched no objects
    //
    // Carrying the object seal forward at g=N+2 re-dates the g=N digest onto rows
    // that have since gained an id, and a HEALTHY read model reports corruption.
    // `not-verifiable` is honest; a false `mismatch` reads as data loss and is
    // strictly worse than silence.
    const repo = new Repo({})
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' } } })
    const meta = repo.create({
      objectShardUrls: [os0.url], connectionShardUrls: [], groups: { g1: { id: 'g1', name: 'G' } },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      expect((await verifyWorkspaceIntegrity(pool!, WS)).outcome).toBe('verified')

      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['o1'] = { id: 'o1', name: 'B' }
      })
      await until(() => roObject(pool!, WS, 'o1'), (value) => !!value)
      const afterObjectEdit = await until(
        () => verifyWorkspaceIntegrity(pool!, WS),
        (report) => report.verdicts.find((v) => v.kind === 'object')?.outcome === 'not-verifiable',
      )
      expect(afterObjectEdit.outcome).not.toBe('mismatch')

      meta.change((doc: { groups: Record<string, unknown> }) => {
        doc.groups['g2'] = { id: 'g2', name: 'H' }
      })
      await until(() => roGroup(pool!, WS, 'g2'), (value) => !!value)
      // Give the metadata projection room to publish, then assert on the steady
      // state: the object seal must still be honest about being un-comparable.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const afterGroupEdit = await verifyWorkspaceIntegrity(pool!, WS)
      expect(afterGroupEdit.verdicts.find((v) => v.kind === 'object')?.outcome).toBe('not-verifiable')
      expect(afterGroupEdit.outcome).not.toBe('mismatch')
      // …while the group seal, which WAS re-sealed by that same projection, is
      // comparable again. Both halves matter: one without the other is either a
      // false alarm or a dead feature.
      expect(afterGroupEdit.verdicts.find((v) => v.kind === 'group')?.outcome).toBe('match')
    } finally {
      stop()
    }
  }, 30_000)

  it('refuses to wipe a diagram\'s flows when its document resolves with no flows map', async () => {
    // `syncConnectionFlows` DELETEs every row for the diagram before
    // re-inserting, so an uninitialised diagram document could erase its flows
    // and report success — the same tolerance defect as the shard deltas, on a
    // path where empty documents occur in practice. ro_connection_flows carries
    // no digest, so nothing else would notice.
    const repo = new Repo({})
    const good = repo.create({
      layouts: {}, comments: {}, flows: { f1: { id: 'f1', steps: [{ connectionId: 'c0' }] } },
    })
    const registry = repo.create({ diagrams: { d1: { id: 'd1', name: 'D', docUrl: good.url } } })
    const meta = repo.create({ objectShardUrls: [], connectionShardUrls: [], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([good, registry, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const rows = async () => (await pool!.query<{ count: string }>(
        'SELECT count(*) AS count FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2',
        [WS.landscapeId, WS.versionId],
      )).rows[0]!.count
      const projected = await until(rows, (count) => count === '1')
      expect(projected).toBe('1')

      // The document loses its flows map entirely — an uninitialised document,
      // not a user deleting every flow.
      good.change((doc: Record<string, unknown>) => { delete doc.flows })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await rows()).toBe('1')
    } finally {
      stop()
    }
  }, 30_000)

  it('records a defect for a shard document that resolves with no objects map', async () => {
    // `repo.create({})` reproduces the real-world condition — a document that is
    // perfectly resolvable and carries nothing — without needing a corrupted
    // storage row.
    const repo = new Repo({})
    const empty = repo.create({})
    const meta = repo.create({ objectShardUrls: [empty.url], connectionShardUrls: [], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([empty, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const report = await verifyWorkspaceIntegrity(pool!, WS)
      expect(report.defectCount).toBe(1)
      expect(report.defectSummary).toContain('object-shard/document-uninitialised')
      // The read model is still internally consistent — it holds exactly what
      // was readable. Completeness and consistency are separate claims, and this
      // is precisely why the defect count cannot be derived from a comparison.
      expect(report.outcome).toBe('verified')
    } finally {
      stop()
    }
  }, 30_000)

  it('cold-builds a sharded model and then projects per-shard changes incrementally', async () => {
    const repo = new Repo({})
    const os0 = repo.create({ objects: { o0: { id: 'o0', name: 'A' }, o1: { id: 'o1', name: 'B' } } })
    const os1 = repo.create({ objects: { o2: { id: 'o2', name: 'C' } } })
    const cs0 = repo.create({ connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o1' } } })
    const meta = repo.create({ objectShardUrls: [os0.url, os1.url], connectionShardUrls: [cs0.url], groups: { g1: { id: 'g1', name: 'G' } } })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, os1, cs0, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const coldHealth = await pool!.query(
        `SELECT observed_generation::int, projected_generation::int, projector_attached
         FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId]
      )
      expect(coldHealth.rows).toEqual([{ observed_generation: 1, projected_generation: 1, projector_attached: true }])

      // Cold build landed all entities.
      expect((await roObject(pool!, WS, 'o0'))?.name).toBe('A')
      expect((await roObject(pool!, WS, 'o2'))?.name).toBe('C')
      expect((await roGroup(pool!, WS, 'g1'))?.name).toBe('G')
      expect(await roConnectionCount(pool!, WS, 'o0')).toBe(1)

      // A REAL run records arrival watermarks — for exactly the entity shard
      // documents and NOTHING else: root/meta/registry have no re-stamping
      // path, so stamping them once would turn any later write into a
      // PERMANENT exact refusal.
      const watermarks = await pool!.query<{ document_id: string }>(
        `SELECT document_id FROM read_model_document_watermarks
         WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )
      const stamped = new Set(watermarks.rows.map((row) => row.document_id))
      // The workspace key is shared across this suite's tests, so assert
      // MEMBERSHIP for this test's documents rather than the exact set.
      for (const handle of [os0, os1, cs0]) {
        expect(stamped.has(handle.documentId), `entity shard ${handle.documentId} must be stamped`).toBe(true)
      }
      for (const handle of [root, meta]) {
        expect(stamped.has(handle.documentId), 'root/meta must NOT be stamped (C2)').toBe(false)
      }

      // Add an object to shard os1 → incremental upsert.
      const flush = vi.spyOn(repo, 'flush')
      os1.change((d: { objects: Record<string, unknown> }) => {
        d.objects['o3'] = { id: 'o3', name: 'D' }
      })
      const o3 = await until(() => roObject(pool!, WS, 'o3'), (v) => !!v)
      expect(o3?.name).toBe('D')
      expect(flush).toHaveBeenCalledWith([os1.documentId])
      const caughtUp = await until(
        async () => (await pool!.query<{ observed: number; projected: number }>(
          `SELECT observed_generation::int AS observed, projected_generation::int AS projected
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
          [WS.landscapeId, WS.versionId]
        )).rows[0],
        (value) => value.observed >= 2 && value.observed === value.projected
      )
      expect(caughtUp.observed).toBe(caughtUp.projected)

      // Remove o1 from shard os0 → incremental delete.
      os0.change((d: { objects: Record<string, unknown> }) => {
        delete d.objects['o1']
      })
      const gone = await until(() => roObject(pool!, WS, 'o1'), (v) => v === undefined)
      expect(gone).toBeUndefined()

      // Add a connection shard member → adjacency reflects it.
      cs0.change((d: { connections: Record<string, unknown> }) => {
        d.connections['c1'] = { id: 'c1', fromId: 'o2', toId: 'o0' }
      })
      const deg = await until(() => roConnectionCount(pool!, WS, 'o0'), (v) => v === 2)
      expect(deg).toBe(2)
    } finally {
      stop()
      const detached = await until(
        async () => (await pool!.query<{ attached: boolean }>(
          `SELECT projector_attached AS attached FROM read_model_projection_state
           WHERE landscape_id = $1 AND version_id = $2`,
          [WS.landscapeId, WS.versionId]
        )).rows[0],
        (value) => value?.attached === false
      )
      expect(detached.attached).toBe(false)
    }
  })

  it('cold-builds a monolithic model (no shards)', async () => {
    const repo = new Repo({})
    const model = repo.create({
      objects: { o0: { id: 'o0', name: 'Mono' } },
      connections: { c0: { id: 'c0', fromId: 'o0', toId: 'o0' } },
      groups: { g1: { id: 'g1', name: 'MG' } },
    })
    const root = repo.create({ modelUrl: model.url, shardUrls: [] })
    await Promise.all([model, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      expect((await roObject(pool!, WS, 'o0'))?.name).toBe('Mono')
      expect((await roGroup(pool!, WS, 'g1'))?.name).toBe('MG')
      expect(await roConnectionCount(pool!, WS, 'o0')).toBe(1) // self-loop once
    } finally {
      stop()
    }
  })

  it('keeps the read model available when a legacy diagram document is missing', async () => {
    const repo = new Repo({})
    const unavailableRepo = new Repo({})
    const unavailableDiagram = unavailableRepo.create({ flows: {} })
    const objectShard = repo.create({ objects: { o0: { id: 'o0', name: 'Still available' } } })
    const connectionShard = repo.create({ connections: {} })
    const meta = repo.create({
      objectShardUrls: [objectShard.url],
      connectionShardUrls: [connectionShard.url],
      groups: {},
    })
    const registry = repo.create({
      diagrams: {
        dMissing: {
          id: 'dMissing',
          name: 'Legacy diagram',
          docUrl: unavailableDiagram.url,
          objectIds: ['o0'],
        },
      },
    })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([objectShard, connectionShard, meta, registry, root].map((handle) => handle.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      expect((await roObject(pool!, WS, 'o0'))?.name).toBe('Still available')
      const projectedDiagram = await pool!.query<{ id: string }>(
        `SELECT id FROM ro_diagrams
         WHERE landscape_id = $1 AND version_id = $2 AND id = 'dMissing'`,
        [WS.landscapeId, WS.versionId],
      )
      expect(projectedDiagram.rows).toEqual([{ id: 'dMissing' }])

      // The missing leaf costs ONE queue entry and ONE shared wake timer for
      // the workspace — never a timer and an unbounded retry loop of its own.
      expect(documentRetryRegistry.snapshot()).toMatchObject({
        queues: 1,
        pendingDepth: 1,
        activeTimers: 1,
      })
      // A document that simply has not arrived is not a degradation: the rows
      // that exist are complete and consistent.
      const health = await pool!.query<{ degraded_since: Date | null }>(
        `SELECT degraded_since FROM read_model_projection_state
         WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )
      expect(health.rows[0]?.degraded_since ?? null).toBeNull()
    } finally {
      stop()
    }
    // Detaching the projector cancels every pending retry.
    expect(documentRetryRegistry.snapshot()).toMatchObject({ queues: 0, pendingDepth: 0, activeTimers: 0 })
  }, 30_000)
})
