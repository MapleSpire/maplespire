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
import * as A from '@automerge/automerge'
import { Repo, type DocHandle } from '@automerge/automerge-repo'
import { startReadModelProjector } from './projectorService.js'
import { roConnection, roGroup, roObject } from './queries.js'
import { fleetDefectSummary, liveDuplicateIdDropCount, verifyWorkspaceIntegrity } from './projectionIntegrity.js'
import type { WorkspaceKey } from './projector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * G4-16f C7, second and third reviews: the LIVE passes with a duplicate id —
 * one inner id under two map keys of ONE document. The full extraction
 * already drops those (`extractModelEntities`); these paths each read one
 * document and used to send its raw list:
 *
 *  - the ModelMeta pass (`syncGroups` → `bulkUpsert`, ON CONFLICT DO UPDATE
 *    per 1 000 rows): two copies in one chunk raise 21000 on every ModelMeta
 *    change; across chunks `group_count` counts the id twice and the group
 *    seal digests n+1 ids over n rows, a false corruption;
 *  - an object-shard and a connection-shard delta (`applyObjectShardDelta`,
 *    `applyConnectionShardDelta`): the same 21000 on every delta of the shard.
 *
 * THE TIE-BREAK, and what "the client's order" is. The rule is the cold
 * build's (`lastOccurrenceById`): the last copy in `Object.values` order of
 * the map wins — the order the client's by-id maps see too
 * (`Object.values(mergeObjectShards(...))` then `new Map(list.map(...))`,
 * last wins). But that order is NOT a function of the document. An
 * Automerge map lists its keys in the order the REPLICA materialised them:
 * KEY order after a load (`A.load`, `repo.import`, a page reload, a server
 * boot), and the order the replica applied them for keys that arrived
 * after — write order for its own writes, arrival order for synced ones.
 * Measured with @automerge/automerge 3.2.6 (the version both packages
 * install): {o1, o2} then 'aa-twin' lists [o1, o2, aa-twin] in-session and
 * [aa-twin, o1, o2] after save/load; two concurrent inserts list in the
 * order each replica merged them. So for a twin, "key order" and "write
 * order" each describe SOME replica, and the arms below pin both: a twin
 * that is in the document when it is LOADED (key order: the original,
 * written first, wins) and a twin written in-session under a key that sorts
 * FIRST (the replica's order puts it last: the twin wins). Neither "most
 * recently written" nor "key order" passes both. The consequence, named:
 * two replicas can disagree on which copy they show until one of them
 * writes (`byIdMap`, bridge.ts, collapses the pair to its own last copy),
 * and the read model can flip on a restart.
 *
 * The counter is process-global, so every count below is an EXACT delta
 * measured around the one step that should move it.
 *
 * Real Automerge repo, real projector, real PostgreSQL, its own schema;
 * skips without a database.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
const SCHEMA = 'rmdupid_test'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({
    connectionString: URL, max: 2, connectionTimeoutMillis: 4000, options: `-c search_path=${SCHEMA},public`,
  }), 'liveDuplicateIds')
  try {
    const c = await p.connect()
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
      const { ensureReadModelSchema } = await import('./schema.js')
      await ensureReadModelSchema(c)
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[readModel live duplicates] no Postgres at ${URL} — skipping`)

const WS: WorkspaceKey = { landscapeId: 'ls-dup', versionId: 'v1' }

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

type Named = { id: string; name?: string; label?: string }
/** The copy of `id` the last-wins rule keeps: the last in `Object.values`
 * order of the document's map, as THIS replica materialised it. */
const lastCopy = (map: Record<string, Named>, id: string): Named =>
  Object.values(map).filter((entity) => entity.id === id).at(-1)!

suite('live passes with a duplicate id (in-process Automerge → Postgres)', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    } finally {
      c.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    await pool!.query(`TRUNCATE ro_objects, ro_connections, ro_groups, ro_group_objects, ro_workspace_stats,
      read_model_projection_state, read_model_change_events`)
  })

  const state = async () => (await pool!.query<{
    observed: number; projected: number; failures: number; last_error: string | null
  }>(
    `SELECT observed_generation::int AS observed, projected_generation::int AS projected,
            consecutive_failures AS failures, last_error_generation::text AS last_error
     FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
    [WS.landscapeId, WS.versionId],
  )).rows[0]
  const groupCount = async () => Number((await pool!.query<{ n: string }>(
    'SELECT group_count::text AS n FROM ro_workspace_stats WHERE landscape_id = $1 AND version_id = $2',
    [WS.landscapeId, WS.versionId],
  )).rows[0]?.n ?? -1)
  const groupRows = async () => Number((await pool!.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM ro_groups WHERE landscape_id = $1 AND version_id = $2',
    [WS.landscapeId, WS.versionId],
  )).rows[0].n)
  const rowCount = async (table: string) => Number((await pool!.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE landscape_id = $1 AND version_id = $2`,
    [WS.landscapeId, WS.versionId],
  )).rows[0].n)
  /** Settled and healthy: every observed generation projected, no failure. */
  const expectSettledAndHealthy = async (label: string) => {
    const settled = await until(state, (value) => !!value && value.observed === value.projected)
    expect(settled, label).toMatchObject({ failures: 0, last_error: null })
    expect(settled.observed, label).toBe(settled.projected)
  }
  /** `initial`, then `twin` written in a LATER change, saved and loaded
   * into `repo`: the document as a replica that LOADS it sees it. */
  const loadedWithTwin = <T,>(repo: Repo, initial: T, twin: (doc: T) => void): DocHandle<T> =>
    repo.import<T>(A.save(A.change(A.from(initial as Record<string, unknown>) as A.Doc<T>, twin)))

  for (const { label, groups } of [
    { label: 'both copies in one 1 000-row chunk', groups: 3 },
    { label: 'the copies in different chunks (more than 1 000 groups)', groups: 1_500 },
  ]) {
    it(`a ModelMeta pass with a duplicate group, ${label}: succeeds, last copy wins, count and seal are the rows'`, async () => {
      const repo = new Repo({})
      const os0 = repo.create({ objects: { o1: { id: 'o1', name: 'O' } } })
      const initial: Record<string, Named & { objectIds?: string[] }> = {}
      for (let i = 0; i < groups; i++) {
        const id = `g${String(i).padStart(4, '0')}`
        initial[id] = { id, name: `name-${id}`, objectIds: i === 0 ? ['o1'] : [] }
      }
      const meta = repo.create({ objectShardUrls: [os0.url], connectionShardUrls: [], groups: initial })
      const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
      await Promise.all([os0, meta, root].map((h) => h.whenReady()))

      const stop = await startReadModelProjector(repo, root.url, pool!, WS)
      try {
        expect(await groupRows(), label).toBe(groups)
        const dropsBefore = liveDuplicateIdDropCount()
        // The twin of g0000 under a key that sorts BEFORE every other one,
        // written LAST: this replica lists it last (it applied it last), so
        // with more than 1 000 groups it sits in a later chunk than g0000.
        meta.change((doc: { groups: Record<string, unknown> }) => {
          doc.groups['aa-twin'] = { id: 'g0000', name: 'TWIN', objectIds: [] }
        })
        const docGroups = (meta.doc() as { groups: Record<string, Named> }).groups
        const winner = lastCopy(docGroups, 'g0000')
        // CONTROL: in this replica the twin is LAST (write order), though its
        // key sorts first — the order the projector reads.
        expect(winner.name, label).toBe('TWIN')
        expect(Object.keys(docGroups).at(-1), label).toBe('aa-twin')
        const values = Object.values(docGroups)
        // CONTROL: the document really holds the pair, and (for the large
        // case) one copy in each of the first two 1 000-row chunks.
        const positions = values.flatMap((entity, index) => entity.id === 'g0000' ? [index] : [])
        expect(positions, label).toHaveLength(2)
        if (groups > 1_000) expect([Math.floor(positions[0] / 1_000), Math.floor(positions[1] / 1_000)], label).toEqual([0, 1])
        else expect(Math.floor(positions[0] / 1_000), label).toBe(Math.floor(positions[1] / 1_000))

        const row = await until(() => roGroup(pool!, WS, 'g0000'), (value) => value?.name === winner.name)
        expect(row?.name, label).toBe(winner.name)
        await expectSettledAndHealthy(label)
        expect(await groupRows(), label).toBe(groups)
        expect(await groupCount(), label).toBe(groups)
        // The group seal is over the rows: `verifyWorkspaceIntegrity`
        // recomputes `digestSql` from them and compares.
        const integrity = await verifyWorkspaceIntegrity(pool!, WS)
        const groupVerdict = integrity.verdicts.find((verdict) => verdict.kind === 'group')
        expect(groupVerdict?.outcome, `${label}: ${integrity.summary}`).toBe('match')
        expect(groupVerdict?.expected?.n, label).toBe(groups)
        // The drop was recorded, once: one ModelMeta pass, one id.
        expect(liveDuplicateIdDropCount() - dropsBefore, label).toBe(1)
      } finally {
        stop()
      }
    }, 60_000)
  }

  it('an object-shard delta and a connection-shard delta with an in-shard duplicate: succeed, last copy wins', async () => {
    const repo = new Repo({})
    const os0 = repo.create({ objects: { o1: { id: 'o1', name: 'A' }, o2: { id: 'o2', name: 'B' } } })
    const cs0 = repo.create({ connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'L' } } })
    const meta = repo.create({ objectShardUrls: [os0.url], connectionShardUrls: [cs0.url], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([os0, cs0, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      const objectDropsBefore = liveDuplicateIdDropCount()
      // Key sorts FIRST, written LAST (see the header).
      os0.change((doc: { objects: Record<string, unknown> }) => {
        doc.objects['aa-twin'] = { id: 'o1', name: 'TWIN' }
      })
      const objects = (os0.doc() as { objects: Record<string, Named> }).objects
      expect(Object.values(objects).filter((o) => o.id === 'o1')).toHaveLength(2)
      expect(Object.keys(objects)).toEqual(['o1', 'o2', 'aa-twin'])
      expect(lastCopy(objects, 'o1').name).toBe('TWIN')
      const object = await until(() => roObject(pool!, WS, 'o1'), (value) => value?.name === 'TWIN')
      expect(object?.name).toBe('TWIN')
      await expectSettledAndHealthy('object shard')
      expect(await rowCount('ro_objects')).toBe(2)
      expect(liveDuplicateIdDropCount() - objectDropsBefore, 'object shard delta').toBe(1)

      const connectionDropsBefore = liveDuplicateIdDropCount()
      cs0.change((doc: { connections: Record<string, unknown> }) => {
        doc.connections['aa-twin'] = { id: 'c1', fromId: 'o1', toId: 'o2', label: 'TWIN' }
      })
      const connections = (cs0.doc() as { connections: Record<string, Named> }).connections
      expect(Object.keys(connections)).toEqual(['c1', 'aa-twin'])
      expect(lastCopy(connections, 'c1').label).toBe('TWIN')
      const connection = await until(() => roConnection(pool!, WS, 'c1'), (value) => value?.label === 'TWIN')
      expect(connection?.label).toBe('TWIN')
      await expectSettledAndHealthy('connection shard')
      expect(await rowCount('ro_connections')).toBe(1)
      expect(liveDuplicateIdDropCount() - connectionDropsBefore, 'connection shard delta').toBe(1)
    } finally {
      stop()
    }
  }, 60_000)

  it('shards that ALREADY hold a duplicate at boot: the cold build drops, logs and stamps them; the original (key order) wins', async () => {
    // Mutant survivor #2, the boot half: every arm above adds the twin AFTER
    // attach. Here the shards are LOADED with the twin in them, as a server
    // boot reads them from storage, so the cold build's extraction meets the
    // pair, not a live delta.
    const repo = new Repo({})
    const os0 = loadedWithTwin(repo,
      { objects: { o1: { id: 'o1', name: 'ORIGINAL' }, o2: { id: 'o2', name: 'B' } } as Record<string, Named> },
      (doc) => { doc.objects['aa-twin'] = { id: 'o1', name: 'TWIN' } })
    const cs0 = loadedWithTwin(repo,
      { connections: { c1: { id: 'c1', fromId: 'o1', toId: 'o2', label: 'ORIGINAL' } } as Record<string, Named & { fromId: string; toId: string }> },
      (doc) => { doc.connections['aa-twin'] = { id: 'c1', fromId: 'o1', toId: 'o2', label: 'TWIN' } })
    // CONTROL: loaded, the maps list keys in KEY order, so the original —
    // written first — is the last copy.
    expect(Object.keys(os0.doc()!.objects)).toEqual(['aa-twin', 'o1', 'o2'])
    expect(Object.keys(cs0.doc()!.connections)).toEqual(['aa-twin', 'c1'])
    const meta = repo.create({ objectShardUrls: [os0.url], connectionShardUrls: [cs0.url], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([meta, root].map((h) => h.whenReady()))

    const gaugeBefore = (await fleetDefectSummary(pool!, { worstLimit: 0 })).totalDuplicateIds
    const liveBefore = liveDuplicateIdDropCount()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let stop: (() => void) | undefined
    let coldBuildDefectLines: string[]
    try {
      stop = await startReadModelProjector(repo, root.url, pool!, WS)
      await expectSettledAndHealthy('boot')
      // Captured INSIDE the try: `mockRestore` clears `mock.calls`.
      coldBuildDefectLines = warn.mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes('cold build') && line.includes('duplicate-id'))
    } finally {
      warn.mockRestore()
    }
    try {
      expect((await roObject(pool!, WS, 'o1'))?.name).toBe('ORIGINAL')
      expect((await roConnection(pool!, WS, 'c1'))?.label).toBe('ORIGINAL')
      expect(await rowCount('ro_objects')).toBe(2)
      expect(await rowCount('ro_connections')).toBe(1)
      // Logged: the cold build's defect line names both drops.
      expect(coldBuildDefectLines).toHaveLength(1)
      expect(coldBuildDefectLines[0]).toContain('recorded 2 model defect(s)')
      // Counted where a full extraction counts: the workspace's stamp, which
      // the duplicate gauge reads.
      const stamp = (await pool!.query<{ defect_count: number; duplicate_id_count: number; trusted: boolean }>(
        `SELECT defect_count, duplicate_id_count, duplicate_ids_observed_at = defects_observed_at AS trusted
           FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
        [WS.landscapeId, WS.versionId],
      )).rows[0]
      expect(stamp).toEqual({ defect_count: 2, duplicate_id_count: 2, trusted: true })
      expect((await fleetDefectSummary(pool!, { worstLimit: 0 })).totalDuplicateIds - gaugeBefore).toBe(2)
      // NOT also counted as live drops: no live pass ran (the heads at
      // attach equal the extraction's), so the same pair is not counted
      // twice.
      expect(liveDuplicateIdDropCount() - liveBefore).toBe(0)
    } finally {
      stop?.()
    }
  }, 60_000)

  it('shards that ALREADY hold a duplicate when they are appended mid-session: the initial apply drops and counts them', async () => {
    // Mutant survivor #2, the attach half: a shard created (here: loaded) with
    // the twin BEFORE the projector starts, attached later by a meta change
    // — the initial apply (`watchObjectShard(url, true)`), not a delta.
    const repo = new Repo({})
    const base = repo.create({ objects: { o0: { id: 'o0', name: 'BASE' } } })
    const osNew = loadedWithTwin(repo,
      { objects: { o1: { id: 'o1', name: 'ORIGINAL' } } as Record<string, Named> },
      (doc) => { doc.objects['aa-twin'] = { id: 'o1', name: 'TWIN' } })
    const csNew = loadedWithTwin(repo,
      { connections: { c1: { id: 'c1', fromId: 'o0', toId: 'o1', label: 'ORIGINAL' } } as Record<string, Named & { fromId: string; toId: string }> },
      (doc) => { doc.connections['aa-twin'] = { id: 'c1', fromId: 'o0', toId: 'o1', label: 'TWIN' } })
    expect(Object.keys(osNew.doc()!.objects)).toEqual(['aa-twin', 'o1'])
    expect(Object.keys(csNew.doc()!.connections)).toEqual(['aa-twin', 'c1'])
    const meta = repo.create<{ objectShardUrls: string[]; connectionShardUrls: string[]; groups: Record<string, never> }>(
      { objectShardUrls: [base.url], connectionShardUrls: [], groups: {} })
    const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
    await Promise.all([base, meta, root].map((h) => h.whenReady()))

    const stop = await startReadModelProjector(repo, root.url, pool!, WS)
    try {
      await expectSettledAndHealthy('boot')
      const objectBefore = liveDuplicateIdDropCount()
      meta.change((doc) => { doc.objectShardUrls.push(osNew.url) })
      const object = await until(() => roObject(pool!, WS, 'o1'), (value) => value?.name === 'ORIGINAL')
      expect(object?.name).toBe('ORIGINAL')
      await expectSettledAndHealthy('object shard appended')
      expect(await rowCount('ro_objects')).toBe(2)
      expect(liveDuplicateIdDropCount() - objectBefore, 'object shard initial apply').toBe(1)

      const connectionBefore = liveDuplicateIdDropCount()
      meta.change((doc) => { doc.connectionShardUrls.push(csNew.url) })
      const connection = await until(() => roConnection(pool!, WS, 'c1'), (value) => value?.label === 'ORIGINAL')
      expect(connection?.label).toBe('ORIGINAL')
      await expectSettledAndHealthy('connection shard appended')
      expect(await rowCount('ro_connections')).toBe(1)
      expect(liveDuplicateIdDropCount() - connectionBefore, 'connection shard initial apply').toBe(1)
    } finally {
      stop()
    }
  }, 60_000)
})
