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

/**
 * G4-16f C6a: the object and connection seals MAINTAINED through the delta
 * writers, against a real PostgreSQL.
 *
 * The property: after every projection that declares a kind `maintained`,
 * the stored seal for that kind is dated at `projected_generation` AND equals
 * `digestSql` recomputed from the table. Driven over seeded random sequences
 * of the real writers (`applyObjectShardDelta`, `applyConnectionShardDelta`,
 * `deleteObjects` / `deleteConnections` as tombstones) over overlapping
 * shards — inserts, updates, deletes, re-inserts, duplicate ids inside a
 * shard, an id carried by two shards, ids that never existed — with the
 * recorder bound and the stamp written exactly as the projection runner
 * does (`runTracked`: begin, the projection transaction, bind, action,
 * `withRecordedDeltas`, stamp, complete). The runner's own wiring is pinned
 * by `projectorService.integration.test.ts` ("maintains the object and
 * connection seals…"); the static plane by
 * `staticDeltaProjector.duplicateIds.integration.test.ts` (C6a arm).
 *
 * And the failure direction: a writer path that cannot maintain the seal (no
 * recorder bound — the static plane's and the seed's shape — or a call site
 * that declares nothing) leaves it NOT comparable, never a match.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureReadModelSchema } from './schema.js'
import {
  applyConnectionShardDelta,
  applyObjectShardDelta,
  deleteConnections,
  deleteObjects,
  upsertObjects,
  type WorkspaceKey,
} from './projector.js'
import {
  digestOfIds,
  IdSetDeltaRecorder,
  withIdSetDeltaRecorder,
  type DigestKind,
} from './contentDigest.js'
import {
  hasIntegrityToStamp,
  invalidateContentDigests,
  stampProjectionIntegrity,
  verifyWorkspaceIntegrity,
  withRecordedDeltas,
  type ProjectionIntegrity,
} from './projectionIntegrity.js'
import { beginReadModelProjection, completeReadModelProjection } from './health.js'
import { withReadModelProjectionTransaction } from './projectionTransaction.js'
import type { ConnectionInput, ObjectInput, Queryable } from './types.js'

const CONNECTION = process.env.TEST_DATABASE_URL
const WS: WorkspaceKey = { landscapeId: 'ls-digest-maint', versionId: 'v1' }
/** Rows of ANOTHER workspace under the same ids: the seal is per workspace,
 * and a writer that leaked across keys would move it. */
const OTHER: WorkspaceKey = { landscapeId: 'ls-digest-maint', versionId: 'v2' }

const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe.skipIf(!CONNECTION)('content digest maintained through the delta writers (Postgres)', () => {
  let database: IsolatedSchemaDb
  const db = (): Queryable => database.pool
  const unmaintainedTally: number[] = []

  beforeAll(async () => {
    database = await createIsolatedSchemaDb(CONNECTION!, 'read_model_digest_maintenance')
    await ensureReadModelSchema(database.pool)
  })
  afterAll(async () => { await database?.teardown() })

  beforeEach(async () => {
    for (const table of [
      'ro_objects', 'ro_connections', 'ro_object_child_stats', 'ro_connection_stats', 'ro_workspace_stats',
      'read_model_projection_state',
    ]) {
      await database.pool.query(`DELETE FROM ${table} WHERE landscape_id = $1`, [WS.landscapeId])
    }
  })

  /** One projection, in the runner's order. `bind: false` is a writer with
   * no recorder — the static plane's and the seed's shape. */
  async function project(
    integrity: ProjectionIntegrity | undefined,
    action: (tx: Queryable) => Promise<void>,
    { bind = true }: { bind?: boolean } = {},
  ): Promise<void> {
    const token = await beginReadModelProjection(db(), WS, null, 'object_shard')
    await withReadModelProjectionTransaction(db(), WS, 'ordinary', async (tx) => {
      const recorder = new IdSetDeltaRecorder()
      if (bind) await withIdSetDeltaRecorder(tx, recorder, () => action(tx))
      else await action(tx)
      const sealed = withRecordedDeltas(integrity, recorder)
      if (hasIntegrityToStamp(sealed)) await stampProjectionIntegrity(tx, WS, token.generation, sealed!)
      await completeReadModelProjection(tx, WS, token)
    })
  }

  const tableIds = async (table: 'ro_objects' | 'ro_connections'): Promise<string[]> =>
    (await database.pool.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [WS.landscapeId, WS.versionId],
    )).rows.map((row) => row.id)

  /** The cold build's role: re-seal both kinds from the full id set. */
  async function reseal(): Promise<void> {
    const digests = {
      object: digestOfIds(await tableIds('ro_objects')),
      connection: digestOfIds(await tableIds('ro_connections')),
      group: digestOfIds([]),
      diagram: digestOfIds([]),
    }
    await project({ digests }, async () => {})
  }

  async function expectMaintained(label: string, kinds: readonly DigestKind[] = ['object', 'connection']) {
    const report = await verifyWorkspaceIntegrity(db(), WS)
    for (const kind of kinds) {
      const verdict = report.verdicts.find((v) => v.kind === kind)!
      expect(verdict.outcome, `${label}: ${kind} — ${verdict.reason ?? summarize(verdict)}`).toBe('match')
      expect(verdict.expected?.g, `${label}: ${kind} dated at the current generation`).toBe(report.projectedGeneration)
    }
  }
  const summarize = (verdict: { expected: unknown; actual: unknown }) =>
    `sealed ${JSON.stringify(verdict.expected)} rows ${JSON.stringify(verdict.actual)}`

  async function expectNotComparable(label: string, kind: DigestKind) {
    const report = await verifyWorkspaceIntegrity(db(), WS)
    const verdict = report.verdicts.find((v) => v.kind === kind)!
    expect(verdict.outcome, `${label}: ${kind}`).toBe('not-verifiable')
  }

  const obj = (id: string, name: string, parentId?: string): ObjectInput =>
    ({ id, name, type: 'system', ...(parentId ? { parentId } : {}) }) as ObjectInput
  const conn = (id: string, fromId: string, toId: string, label: string): ConnectionInput =>
    ({ id, fromId, toId, label })

  it.each([1, 7, 42, 2026, 99991])('random delta sequence, seed %i: the seal equals digestSql after every step', async (seed) => {
    const random = prng(seed)
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const objectPool = Array.from({ length: 24 }, (_, i) => `o${i}`)
    const connectionPool = Array.from({ length: 16 }, (_, i) => `c${i}`)
    // Three object shards and two connection shards whose id ranges OVERLAP,
    // so an id is regularly carried by two shards (base + overlay).
    const objectShards = new Map<string, string[]>([['s0', []], ['s1', []], ['s2', []]])
    const connectionShards = new Map<string, string[]>([['k0', []], ['k1', []]])

    // A neighbour workspace sharing every id. Never touched by the steps.
    await upsertObjects(db(), OTHER, null, objectPool.slice(0, 6).map((id) => obj(id, 'other')))

    await reseal()
    await expectMaintained('empty cold build')

    let unmaintainedSteps = 0
    for (let step = 0; step < 40; step += 1) {
      const roll = random()
      const label = `seed ${seed} step ${step}`
      if (roll < 0.4) {
        const shard = pick([...objectShards.keys()])
        const chosen = objectPool.filter(() => random() < 0.25)
        const objects = chosen.map((id) => obj(id, `n${step}`, random() < 0.3 ? pick(objectPool) : undefined))
        // A duplicate id inside the shard: two map keys, one inner id.
        if (chosen.length && random() < 0.3) objects.push(obj(pick(chosen), `twin${step}`))
        await project({ unchanged: ['connection', 'group', 'diagram'], maintained: ['object'] },
          async (tx) => { await applyObjectShardDelta(tx, WS, null, objectShards.get(shard)!, objects) })
        objectShards.set(shard, [...new Set(chosen)])
        await expectMaintained(`${label} object shard ${shard}`)
      } else if (roll < 0.7) {
        const shard = pick([...connectionShards.keys()])
        const chosen = connectionPool.filter(() => random() < 0.3)
        const connections = chosen.map((id) => conn(id, pick(objectPool), pick(objectPool), `l${step}`))
        if (chosen.length && random() < 0.3) connections.push(conn(pick(chosen), 'o0', 'o1', `twin${step}`))
        await project({ unchanged: ['object', 'group', 'diagram'], maintained: ['connection'] },
          async (tx) => { await applyConnectionShardDelta(tx, WS, null, connectionShards.get(shard)!, connections) })
        connectionShards.set(shard, [...new Set(chosen)])
        await expectMaintained(`${label} connection shard ${shard}`)
      } else if (roll < 0.9) {
        // Tombstones (the metadata pass): present ids, absent ids, repeats.
        const objectIds = [...objectPool.filter(() => random() < 0.15), 'never-existed', 'never-existed']
        const connectionIds = [...connectionPool.filter(() => random() < 0.15), 'c-ghost']
        if (objectIds.length > 2) objectIds.push(objectIds[0]!)
        await project({ unchanged: ['diagram', 'group'], maintained: ['object', 'connection'] }, async (tx) => {
          await deleteObjects(tx, WS, objectIds)
          await deleteConnections(tx, WS, connectionIds)
        })
        await expectMaintained(`${label} tombstones`)
      } else {
        // A writer that CANNOT maintain the seal: rows move with no recorder
        // bound (the static plane's shape), the generation advances, nothing
        // is stamped. Not comparable, then a cold build re-seals.
        unmaintainedSteps += 1
        const id = `unmaintained-${step}`
        await project(undefined, async (tx) => { await upsertObjects(tx, WS, null, [obj(id, 'x')]) }, { bind: false })
        await expectNotComparable(`${label} unmaintained writer`, 'object')
        await expectNotComparable(`${label} unmaintained writer`, 'connection')
        await reseal()
        await expectMaintained(`${label} after re-seal`)
      }
    }
    // CONTROL: the sequence really exercised the table, not an empty set.
    const finalObjects = await tableIds('ro_objects')
    const report = await verifyWorkspaceIntegrity(db(), WS)
    expect(report.verdicts.find((v) => v.kind === 'object')?.actual?.n).toBe(finalObjects.length)
    expect(report.projectedGeneration).toBeGreaterThan(40)
    // The neighbour workspace's rows were never this workspace's delta.
    expect((await database.pool.query(
      'SELECT count(*)::int AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2',
      [OTHER.landscapeId, OTHER.versionId],
    )).rows[0].n).toBe(6)
    unmaintainedTally.push(unmaintainedSteps)
  }, 120_000)

  it('CONTROL: the seeds above reached the unmaintained-writer branch at least once', () => {
    expect(unmaintainedTally).toHaveLength(5)
    expect(unmaintainedTally.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })

  it('the generation rule: a delta on a seal that is already stale leaves it stale', async () => {
    await reseal()
    await expectMaintained('sealed')
    // Rows move and the generation advances with no stamp: stale.
    await project(undefined, async (tx) => { await upsertObjects(tx, WS, null, [obj('x1', 'x')]) }, { bind: false })
    await expectNotComparable('stale', 'object')
    // A maintained delta now must NOT XOR into the stale seal and re-date it.
    await project({ unchanged: ['connection', 'group', 'diagram'], maintained: ['object'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, [], [obj('x2', 'y')]) })
    await expectNotComparable('still stale after a maintained delta', 'object')
    // …and the untouched connection seal, carried forward without a delta,
    // is still stale too (it went stale with the same generation).
    await expectNotComparable('connection carried from stale', 'connection')
  })

  it('a call site that declares nothing for a kind it moved leaves that kind not comparable', async () => {
    await reseal()
    // Recorder bound and recording, but `object` in neither list.
    await project({ unchanged: ['connection', 'group', 'diagram'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, [], [obj('y1', 'y')]) })
    await expectNotComparable('undeclared', 'object')
    await expectMaintained('the declared-unchanged kind stays current', ['connection'])
  })

  it('a writer on a kind declared UNCHANGED still moves its seal (the recorder is the truth)', async () => {
    await reseal()
    await project({ unchanged: ['object', 'connection', 'group', 'diagram'] },
      async (tx) => { await deleteObjects(tx, WS, ['nothing-here']); await applyObjectShardDelta(tx, WS, null, [], [obj('z1', 'z')]) })
    await expectMaintained('unchanged-but-written')
  })

  it('a SKIPPED stamp (a newer generation already committed) un-seals the kinds this transaction moved', async () => {
    await reseal()
    const before = await verifyWorkspaceIntegrity(db(), WS)
    // A stamp at a generation the row has already reached is skipped by
    // `projected_generation < $6`; its rows still land, so the moved kind
    // must not stay comparable.
    await withReadModelProjectionTransaction(db(), WS, 'ordinary', async (tx) => {
      const recorder = new IdSetDeltaRecorder()
      await withIdSetDeltaRecorder(tx, recorder, () => applyObjectShardDelta(tx, WS, null, [], [obj('late', 'l')]).then(() => undefined))
      const wrote = await stampProjectionIntegrity(tx, WS, before.projectedGeneration!,
        withRecordedDeltas({ unchanged: ['connection', 'group', 'diagram'], maintained: ['object'] }, recorder)!)
      expect(wrote).toBe(false)
    })
    const after = await verifyWorkspaceIntegrity(db(), WS)
    expect(after.verdicts.find((v) => v.kind === 'object')?.outcome).toBe('not-verifiable')
    expect(after.verdicts.find((v) => v.kind === 'object')?.expected).toBeNull()
    // Only the moved kind: connection had no delta and is still the old seal.
    expect(after.verdicts.find((v) => v.kind === 'connection')?.outcome).toBe('match')

    // A skipped RE-SEAL of a kind the recorder does not track (a metadata
    // pass's group sync): that kind moved too, so it goes as well.
    await withReadModelProjectionTransaction(db(), WS, 'ordinary', async (tx) => {
      const wrote = await stampProjectionIntegrity(tx, WS, after.projectedGeneration!,
        { digests: { group: digestOfIds(['g-late']) }, unchanged: ['connection', 'diagram'] })
      expect(wrote).toBe(false)
    })
    const resealSkipped = await verifyWorkspaceIntegrity(db(), WS)
    expect(resealSkipped.verdicts.find((v) => v.kind === 'group')?.expected).toBeNull()
    expect(resealSkipped.verdicts.find((v) => v.kind === 'connection')?.outcome).toBe('match')
  })

  it('invalidateContentDigests removes exactly the named kinds', async () => {
    await reseal()
    await withReadModelProjectionTransaction(db(), WS, 'ordinary', (tx) => invalidateContentDigests(tx, WS, ['object', 'group']))
    const report = await verifyWorkspaceIntegrity(db(), WS)
    expect(report.verdicts.map((v) => [v.kind, v.outcome])).toEqual([
      ['object', 'not-verifiable'], ['connection', 'match'], ['group', 'not-verifiable'], ['diagram', 'match'],
    ])
  })

  it('a direct upsertObjects whose duplicate id falls in two CHUNKS enters the table once, and once in the seal', async () => {
    // `applyObjectShardDelta` dedupes before writing, so only a direct caller
    // can hand `upsertObjects` one id twice; in one 1 000-row chunk that is
    // 21000, across two chunks the second statement updates the row the first
    // inserted. The recorder must count the id ONCE (XORed twice it cancels).
    await reseal()
    const objects = [obj('dup', 'first'), ...Array.from({ length: 999 }, (_, i) => obj(`bulk${i}`, 'b')), obj('dup', 'second')]
    await project({ unchanged: ['connection', 'group', 'diagram'], maintained: ['object'] },
      async (tx) => { await upsertObjects(tx, WS, null, objects) })
    expect((await tableIds('ro_objects')).length).toBe(1000)
    await expectMaintained('duplicate across chunks')
  })

  it('an empty-string id and a NUMERIC id: inserted once, updated without re-entering', async () => {
    // `''` is a row and `digestSql` hashes it; a numeric id reaches the
    // table as text through node-postgres, and must be compared as the text
    // the SELECT returns, or an update would re-enter it.
    await reseal()
    const numeric = { id: 7 as unknown as string, name: 'n', type: 'system' } as ObjectInput
    await project({ unchanged: ['connection', 'group', 'diagram'], maintained: ['object'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, [], [obj('', 'empty'), numeric]) })
    expect((await tableIds('ro_objects')).sort()).toEqual(['', '7'])
    await expectMaintained('inserted')
    await project({ unchanged: ['connection', 'group', 'diagram'], maintained: ['object'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, ['', '7'], [obj('', 'empty 2'), { ...numeric, name: 'n2' }]) })
    await expectMaintained('updated')
  })

  it('a malformed stored seal is left stale and does not cost the projection its other seals', async () => {
    await reseal()
    // `n` a JSON number that is not an integer: `jsonb_typeof` says number,
    // a `::bigint` cast would raise and roll the whole stamp back.
    await database.pool.query(
      `UPDATE read_model_projection_state
          SET content_digest = jsonb_set(content_digest, '{object,n}', '1.5'::jsonb)
        WHERE landscape_id = $1 AND version_id = $2`,
      [WS.landscapeId, WS.versionId],
    )
    await project({ unchanged: ['connection', 'group', 'diagram'], maintained: ['object'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, [], [obj('m1', 'm')]) })
    await expectNotComparable('malformed object seal', 'object')
    // The stamp itself survived: the carried kinds moved to the new generation.
    await expectMaintained('carried despite the malformed neighbour', ['connection'])
  })

  it('an update of an existing row moves nothing, a delete of it and a re-insert move it out and back', async () => {
    await reseal()
    await project({ maintained: ['object'], unchanged: ['connection', 'group', 'diagram'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, [], [obj('a', '1'), obj('b', '1')]) })
    const first = (await verifyWorkspaceIntegrity(db(), WS)).verdicts.find((v) => v.kind === 'object')!.expected!
    await project({ maintained: ['object'], unchanged: ['connection', 'group', 'diagram'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, ['a', 'b'], [obj('a', '2'), obj('b', '2')]) })
    const updated = (await verifyWorkspaceIntegrity(db(), WS)).verdicts.find((v) => v.kind === 'object')!.expected!
    expect({ n: updated.n, x: updated.x }).toEqual({ n: first.n, x: first.x })
    expect(updated.g).toBeGreaterThan(first.g)
    await project({ maintained: ['object'], unchanged: ['connection', 'group', 'diagram'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, ['a', 'b'], [obj('a', '3')]) })
    const deleted = (await verifyWorkspaceIntegrity(db(), WS)).verdicts.find((v) => v.kind === 'object')!.expected!
    expect({ n: deleted.n, x: deleted.x }).toEqual(digestOfIds(['a']))
    await project({ maintained: ['object'], unchanged: ['connection', 'group', 'diagram'] },
      async (tx) => { await applyObjectShardDelta(tx, WS, null, ['a'], [obj('a', '4'), obj('b', '4')]) })
    await expectMaintained('re-inserted')
    const back = (await verifyWorkspaceIntegrity(db(), WS)).verdicts.find((v) => v.kind === 'object')!.expected!
    expect({ n: back.n, x: back.x }).toEqual(digestOfIds(['a', 'b']))
  })
})
