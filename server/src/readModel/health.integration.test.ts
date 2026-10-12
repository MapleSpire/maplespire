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

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { ensureReadModelSchema } from './schema.js'
import {
  beginReadModelProjection,
  clearReadModelWorkspaceDegraded,
  completeReadModelProjection,
  failReadModelProjection,
  getOrgReadModelHealth,
  markReadModelProjectorAttached,
  markReadModelProjectorDetached,
  markReadModelWorkspaceDegraded,
} from './health.js'
import type { WorkspaceKey } from './projector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
const ORG = 'org-health'
const WS: WorkspaceKey = { landscapeId: 'landscape-health', versionId: 'version-health' }

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({
    connectionString: URL,
    max: 2,
    connectionTimeoutMillis: 4000,
    options: '-c search_path=rmhealth_test,public',
  }), 'health')
  try {
    const client = await p.connect()
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS rmhealth_test')
      await client.query(`CREATE TABLE IF NOT EXISTS rmhealth_test.landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
      await client.query(`CREATE TABLE IF NOT EXISTS rmhealth_test.versions (
        id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, label TEXT NOT NULL
      )`)
      await client.query(`CREATE TABLE IF NOT EXISTS rmhealth_test.scopes (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL,
        landscape_id TEXT, version_id TEXT, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      // The out-of-band freshness signal reads these two. They live in `public`
      // in a real database, and `search_path` would happily resolve them there —
      // which is precisely the "never touch rows you did not create" failure
      // src/testing/isolatedSchema.ts exists to prevent, since the storage table
      // of a running dev stack is shared. Own local copies instead. Only the
      // columns the health query reads.
      await client.query(`CREATE TABLE IF NOT EXISTS rmhealth_test.automerge_storage (
        key TEXT PRIMARY KEY, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      await client.query(`CREATE TABLE IF NOT EXISTS rmhealth_test.automerge_document_workspace (
        document_id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL, version_id TEXT NOT NULL
      )`)
      await ensureReadModelSchema(client)
    } finally {
      client.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[read-model health] no Postgres at ${URL} — skipping`)

suite('read-model projector health', () => {
  beforeEach(async () => {
    await pool!.query(
      'TRUNCATE read_model_projection_state, scopes, versions, landscapes, automerge_storage, automerge_document_workspace'
    )
    await pool!.query(`INSERT INTO landscapes (id, name) VALUES ($1, 'Commerce')`, [WS.landscapeId])
    await pool!.query(`INSERT INTO versions (id, landscape_id, label) VALUES ($1, $2, 'Main')`, [WS.versionId, WS.landscapeId])
    await pool!.query(
      `INSERT INTO scopes (id, org_id, kind, landscape_id, version_id) VALUES ('scope-health', $1, 'version', $2, $3)`,
      [ORG, WS.landscapeId, WS.versionId]
    )
  })

  afterAll(async () => {
    const client = await pool!.connect()
    try {
      await client.query('DROP SCHEMA IF EXISTS rmhealth_test CASCADE')
    } finally {
      client.release()
      await pool!.end()
    }
  })

  it('tracks monotonic generations, unresolved failures and compare-and-set attachment', async () => {
    const cold = await beginReadModelProjection(pool!, WS, ORG, 'cold_build')
    await completeReadModelProjection(pool!, WS, cold)
    await markReadModelProjectorAttached(pool!, WS, ORG, 'projector-new')
    await markReadModelProjectorDetached(pool!, WS, 'projector-old')

    let summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.counts.healthy).toBe(1)
    expect(summary.workspaces).toEqual([])

    const failed = await beginReadModelProjection(pool!, WS, ORG, 'object_shard')
    await failReadModelProjection(pool!, WS, failed, new Error('customer model text must not be persisted'))
    summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.counts.failed).toBe(1)
    expect(summary.workspaces[0]).toMatchObject({
      landscapeName: 'Commerce',
      versionName: 'Main',
      status: 'failed',
      pendingGenerations: 1,
      lastErrorCode: 'error',
    })
    const persisted = await pool!.query(`SELECT last_error_code FROM read_model_projection_state WHERE landscape_id = $1`, [WS.landscapeId])
    expect(JSON.stringify(persisted.rows)).not.toContain('customer model text')

    await completeReadModelProjection(pool!, WS, failed)
    summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.counts.healthy).toBe(1)

    // An older concurrent failure that arrives after a newer success must not
    // regress the health cursor or replace the resolved error generation.
    const older = await beginReadModelProjection(pool!, WS, ORG, 'object_shard')
    const newer = await beginReadModelProjection(pool!, WS, ORG, 'object_shard')
    await completeReadModelProjection(pool!, WS, newer)
    await failReadModelProjection(pool!, WS, older, new Error('late older failure'))
    summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.counts.healthy).toBe(1)
    const staleFailure = await pool!.query(
      `SELECT last_error_generation, last_error_code FROM read_model_projection_state WHERE landscape_id = $1`,
      [WS.landscapeId]
    )
    expect(staleFailure.rows).toEqual([{ last_error_generation: null, last_error_code: null }])

    await beginReadModelProjection(pool!, WS, ORG, 'metadata')
    await markReadModelProjectorDetached(pool!, WS, 'projector-new')
    summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.counts.idle).toBe(1)
    expect(summary.workspaces[0]).toMatchObject({ status: 'idle', pendingGenerations: 1, projectorAttached: false })
  })

  it('reports a caught-up but incomplete workspace as degraded until a full projection clears it', async () => {
    const cold = await beginReadModelProjection(pool!, WS, ORG, 'cold_build')
    await completeReadModelProjection(pool!, WS, cold)
    await markReadModelProjectorAttached(pool!, WS, ORG, 'projector-1')
    expect((await getOrgReadModelHealth(pool!, ORG)).counts.healthy).toBe(1)

    await markReadModelWorkspaceDegraded(
      pool!, WS, ORG, 'document_resolution',
      Object.assign(new Error('customer diagram name must not be persisted'), {
        code: 'read_model_document_unavailable',
      })
    )

    let summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.counts).toMatchObject({ degraded: 1, healthy: 0 })
    expect(summary.workspaces[0]).toMatchObject({
      status: 'degraded',
      projectorAttached: true,
      degradedKind: 'document_resolution',
      degradedErrorCode: 'read_model_document_unavailable',
    })
    expect(summary.workspaces[0].degradedSince).not.toBeNull()
    const persisted = await pool!.query(
      `SELECT degraded_error_code FROM read_model_projection_state WHERE landscape_id = $1`,
      [WS.landscapeId]
    )
    expect(JSON.stringify(persisted.rows)).not.toContain('customer diagram name')

    // A later successful generation does NOT by itself restore healthy: the
    // workspace is still knowingly incomplete.
    const incremental = await beginReadModelProjection(pool!, WS, ORG, 'registry')
    await completeReadModelProjection(pool!, WS, incremental)
    expect((await getOrgReadModelHealth(pool!, ORG)).counts.degraded).toBe(1)

    // The first degradation timestamp survives a repeat during the same incident.
    const first = (await getOrgReadModelHealth(pool!, ORG)).workspaces[0].degradedSince
    await markReadModelWorkspaceDegraded(pool!, WS, ORG, 'registry', new Error('again'))
    expect((await getOrgReadModelHealth(pool!, ORG)).workspaces[0].degradedSince).toBe(first)

    await clearReadModelWorkspaceDegraded(pool!, WS)
    summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.counts).toMatchObject({ degraded: 0, healthy: 1 })
    expect(summary.workspaces).toEqual([])
  })

  it('ranks a failed workspace above a degraded one in the capped detail payload', async () => {
    const degradedOnly: WorkspaceKey = { landscapeId: 'landscape-degraded', versionId: 'version-degraded' }
    await pool!.query(`INSERT INTO landscapes (id, name) VALUES ($1, 'Billing')`, [degradedOnly.landscapeId])
    await pool!.query(
      `INSERT INTO versions (id, landscape_id, label) VALUES ($1, $2, 'Main')`,
      [degradedOnly.versionId, degradedOnly.landscapeId]
    )
    await pool!.query(
      `INSERT INTO scopes (id, org_id, kind, landscape_id, version_id) VALUES ('scope-degraded', $1, 'version', $2, $3)`,
      [ORG, degradedOnly.landscapeId, degradedOnly.versionId]
    )

    const degradedCold = await beginReadModelProjection(pool!, degradedOnly, ORG, 'cold_build')
    await completeReadModelProjection(pool!, degradedOnly, degradedCold)
    await markReadModelProjectorAttached(pool!, degradedOnly, ORG, 'projector-degraded')
    await markReadModelWorkspaceDegraded(pool!, degradedOnly, ORG, 'registry', new Error('flow projection failed'))

    const failedCold = await beginReadModelProjection(pool!, WS, ORG, 'cold_build')
    await completeReadModelProjection(pool!, WS, failedCold)
    await markReadModelProjectorAttached(pool!, WS, ORG, 'projector-failed')
    const broken = await beginReadModelProjection(pool!, WS, ORG, 'object_shard')
    await failReadModelProjection(pool!, WS, broken, new Error('boom'))

    const summary = await getOrgReadModelHealth(pool!, ORG)

    expect(summary.counts).toMatchObject({ failed: 1, degraded: 1 })
    expect(summary.workspaces.map((workspace) => workspace.status)).toEqual(['failed', 'degraded'])
  })

  it('counts all workspaces in SQL while capping the diagnostic detail payload', async () => {
    const landscapes = Array.from({ length: 55 }, (_, index) => `landscape-${index}`)
    for (const [index, landscapeId] of landscapes.entries()) {
      await pool!.query(`INSERT INTO landscapes (id, name) VALUES ($1, $2)`, [landscapeId, `Landscape ${index}`])
      await pool!.query(`INSERT INTO versions (id, landscape_id, label) VALUES ($1, $2, 'Main')`, [`version-${index}`, landscapeId])
      await pool!.query(
        `INSERT INTO scopes (id, org_id, kind, landscape_id, version_id) VALUES ($1, $2, 'version', $3, $4)`,
        [`scope-${index}`, ORG, landscapeId, `version-${index}`]
      )
    }

    const summary = await getOrgReadModelHealth(pool!, ORG)
    expect(summary.totalWorkspaceCount).toBe(56)
    expect(summary.counts.uninitialized).toBe(56)
    expect(summary.listedWorkspaceCount).toBe(50)
    expect(summary.workspaces).toHaveLength(50)
  })

  /**
   * The detector that can contradict `healthy`.
   *
   * Every other status in this file is derived from counters the projector
   * writes about itself, and `observed_generation` only advances from inside the
   * change watcher. Orphan that watcher and the counters freeze in a consistent,
   * caught-up-looking state forever: the workspace is wrong and every signal
   * says healthy, because the detector's input is produced by the path that
   * failed. `automerge_storage.updated_at` is written by the storage adapter
   * regardless, so it is the one input that can disagree.
   */
  describe('stale — durable writes the projector never observed', () => {
    /** Put the projector in the state an orphaned watcher leaves: attached,
     * caught up (observed == projected), last projection at a known instant. */
    async function projectedAgo(minutes: number): Promise<void> {
      const token = await beginReadModelProjection(pool!, WS, ORG, 'cold_build')
      await completeReadModelProjection(pool!, WS, token)
      await markReadModelProjectorAttached(pool!, WS, ORG, 'projector-stale-test')
      await pool!.query(
        `UPDATE read_model_projection_state SET last_projected_at = now() - ($1 || ' minutes')::interval
         WHERE landscape_id = $2 AND version_id = $3`,
        [String(minutes), WS.landscapeId, WS.versionId]
      )
    }

    async function durableWriteAgo(minutes: number, documentId = 'doc-stale'): Promise<void> {
      await pool!.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3)
         ON CONFLICT (document_id) DO NOTHING`,
        [documentId, WS.landscapeId, WS.versionId]
      )
      await pool!.query(
        `INSERT INTO automerge_storage (key, updated_at) VALUES ($1, now() - ($2 || ' minutes')::interval)`,
        [`${documentId}/chunk-${minutes}`, String(minutes)]
      )
    }

    it('reports stale, and surfaces the durable write that proves it', async () => {
      await projectedAgo(10)
      await durableWriteAgo(5)

      const summary = await getOrgReadModelHealth(pool!, ORG)
      expect(summary.counts.stale).toBe(1)
      expect(summary.counts.healthy).toBe(0)
      const workspace = summary.workspaces[0]
      expect(workspace).toMatchObject({ status: 'stale', projectorAttached: true, pendingGenerations: 0 })
      // The evidence, not just the verdict: an operator has to be able to tell
      // this from a projector that simply has nothing to do.
      expect(workspace.newestDurableWriteAt).not.toBeNull()
      expect(Date.parse(workspace.newestDurableWriteAt!)).toBeGreaterThan(Date.parse(workspace.lastProjectedAt!))
    })

    it('is NOT stale while the write is younger than the grace period', async () => {
      // A write landing just after a projection is ordinary. The projector is
      // about to notice it — at which point observed > projected and the status
      // is `catching_up`. Calling that stale would fire on every busy workspace,
      // which is how a detector gets switched off.
      await projectedAgo(10)
      await durableWriteAgo(0)

      const summary = await getOrgReadModelHealth(pool!, ORG)
      expect(summary.counts.stale).toBe(0)
      expect(summary.counts.healthy).toBe(1)
    })

    it('is NOT stale when the newest durable write predates the last projection', async () => {
      await projectedAgo(1)
      await durableWriteAgo(30)

      const summary = await getOrgReadModelHealth(pool!, ORG)
      expect(summary.counts.stale).toBe(0)
      expect(summary.counts.healthy).toBe(1)
    })

    it('a projector that knows it is behind reads catching_up, not stale', async () => {
      // Both conditions hold at once here, and the ranking has to prefer the one
      // that is self-correcting: `catching_up` means work is queued and moving.
      await projectedAgo(10)
      await durableWriteAgo(5)
      await beginReadModelProjection(pool!, WS, ORG, 'object_shard') // observed > projected

      const summary = await getOrgReadModelHealth(pool!, ORG)
      expect(summary.counts.stale).toBe(0)
      expect(summary.workspaces[0]).toMatchObject({ status: 'catching_up' })
    })

    it('only counts documents mapped to the workspace', async () => {
      // The join is through automerge_document_workspace. A write to some other
      // workspace's document must not make this one look stale — a detector that
      // fires on unrelated traffic is noise, and noise gets muted.
      await projectedAgo(10)
      await pool!.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ('doc-elsewhere', 'landscape-other', 'version-other')`
      )
      await pool!.query(
        `INSERT INTO automerge_storage (key, updated_at) VALUES ('doc-elsewhere/chunk', now() - interval '5 minutes')`
      )

      const summary = await getOrgReadModelHealth(pool!, ORG)
      expect(summary.counts.stale).toBe(0)
      expect(summary.counts.healthy).toBe(1)
      expect(summary.workspaces).toEqual([])
    })

    it('takes the NEWEST write across the workspace, not an arbitrary one', async () => {
      // max() over documents. With `min` or a first-row pick, an old chunk on a
      // quiet document would mask a recent write on a busy one.
      await projectedAgo(10)
      await durableWriteAgo(30, 'doc-quiet')
      await durableWriteAgo(5, 'doc-busy')

      const summary = await getOrgReadModelHealth(pool!, ORG)
      expect(summary.counts.stale).toBe(1)
    })
  })
})
