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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import { WorkspaceDocIndex, notifyWorkspaceCreated, buildWorkspaceRouteCheck } from './docScope.js'
import { mintDocumentIdBytes, DISPLACED_SCAN_MAX_CANDIDATES } from './documentIdMint.js'
import { resolveWorkspaceRoute } from '../syncCells/workspaceRoute.js'
import { ensureSyncCellOwnershipSchema } from '../syncCells/ownership.js'
import { ensureReadModelSchema } from '../readModel/schema.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('WorkspaceDocIndex durable registry', () => {
  let db: IsolatedSchemaDb
  let repo: Repo
  let rootId: string

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'docscope_durable')
    // `default_version_id` mirrors production's landscapes table just enough
    // for `resolveWorkspaceRoute` to canonicalise the `current` alias — the
    // repoint tests below drive the real resolver, not a hand-built route.
    await db.pool.query('CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)')
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    repo = new Repo({})
    const model = repo.create({ objects: {} })
    const root = repo.create({ modelUrl: model.url, shardUrls: [] as string[] })
    await Promise.all([model.whenReady(), root.whenReady()])
    rootId = String(root.documentId)
    await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('L1', 'One'), ('L2', 'Two')")
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES
       ('V1', 'L1', 'Main', $1),
       ('V2', 'L2', 'Main', $1)`,
      [root.url],
    )
    await ensureSyncCellOwnershipSchema(db.pool)
    await ensureReadModelSchema(db.pool)
  })

  afterAll(async () => {
    await repo?.shutdown()
    await db?.teardown()
  })

  it('persists first-owner-wins and resolves it directly after a process-cache restart', async () => {
    const first = new WorkspaceDocIndex(repo, db.pool)
    notifyWorkspaceCreated({ landscapeId: 'L1', versionId: 'V1', rootUrl: `automerge:${rootId}` })

    const deadline = Date.now() + 2_000
    let resolved = await first.resolveDocWorkspace(rootId)
    while (!resolved && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      resolved = await first.resolveDocWorkspace(rootId)
    }
    expect(resolved).toEqual({ landscapeId: 'L1', versionId: 'V1' })

    notifyWorkspaceCreated({ landscapeId: 'L2', versionId: 'V2', rootUrl: `automerge:${rootId}` })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const { rows } = await db.pool.query<{ landscape_id: string; version_id: string }>(
      'SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1',
      [rootId],
    )
    expect(rows).toEqual([{ landscape_id: 'L1', version_id: 'V1' }])

    const restarted = new WorkspaceDocIndex(repo, db.pool)
    expect(await restarted.resolveDocWorkspace(rootId)).toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  // SECURITY. `isValidAutomergeUrl` accepts a heads section and a path, so
  // `automerge:<id>/`, `automerge:<id>#` and `automerge:<id>/x` are all valid
  // and all resolve to the bare `<id>` (in automerge-repo 2.6.0-alpha.2, three
  // of those four forms diverge from `handle.documentId` as plain strings).
  //
  // Deriving the id with `url.replace(/^automerge:/, '')` would hand
  // `claimDocument` a decorated string no other workspace could collide with,
  // so the INSERT always wins and the REAL document's durable owner is never
  // consulted. A registry shard carrying a foreign document's url plus one
  // trailing slash could then capture that document, for reads AND writes.
  //
  // Mutant this test must fail against: `url.replace(/^automerge:/, '')` at the
  // `const id =` line in `reference()`.
  for (const [caseIndex, suffix] of ['/', '#', '/x'].entries()) {
    it(`refuses a foreign document referenced through a "${suffix}"-decorated url`, async () => {
      const victim = repo.create({ name: 'owned by L2' })
      const victimRegistry = repo.create({ diagrams: { d: { docUrl: victim.url } } })
      const victimRoot = repo.create({ modelUrl: '', shardUrls: [victimRegistry.url] })
      // The attacker's registry points at the victim's document, decorated.
      const attackerRegistry = repo.create({ diagrams: { d: { docUrl: `${victim.url}${suffix}` } } })
      const attackerRoot = repo.create({ modelUrl: '', shardUrls: [attackerRegistry.url] })
      await Promise.all([victim, victimRegistry, victimRoot, attackerRegistry, attackerRoot]
        .map((h) => h.whenReady()))

      const landscape = `L-case${caseIndex}`
      await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1), ($2, $2)',
        [`${landscape}-victim`, `${landscape}-attacker`])
      await db.pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3), ($4, $5, 'Main', $6)`,
        [`${landscape}-vv`, `${landscape}-victim`, victimRoot.url,
          `${landscape}-av`, `${landscape}-attacker`, attackerRoot.url],
      )

      const index = new WorkspaceDocIndex(repo, db.pool)
      // The VICTIM is walked first, so it is the legitimate first owner — the
      // exact situation the durable table exists to defend.
      notifyWorkspaceCreated({ landscapeId: `${landscape}-victim`, versionId: `${landscape}-vv`, rootUrl: victimRoot.url })
      const deadline = Date.now() + 3_000
      let owner = await index.resolveDocWorkspace(String(victim.documentId))
      while (!owner && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
        owner = await index.resolveDocWorkspace(String(victim.documentId))
      }
      expect(owner, 'the victim workspace must own its own document first').toEqual(
        { landscapeId: `${landscape}-victim`, versionId: `${landscape}-vv` })

      notifyWorkspaceCreated({ landscapeId: `${landscape}-attacker`, versionId: `${landscape}-av`, rootUrl: attackerRoot.url })
      await new Promise((r) => setTimeout(r, 300))

      expect(
        await index.resolveDocWorkspace(String(victim.documentId)),
        'a decorated url must not move a document to another workspace',
      ).toEqual({ landscapeId: `${landscape}-victim`, versionId: `${landscape}-vv` })

      // And the durable row must be keyed on the BARE document id, with no
      // decorated twin — a stray row would resolve on a later cold process.
      const { rows } = await db.pool.query<{ document_id: string; landscape_id: string }>(
        `SELECT document_id, landscape_id FROM automerge_document_workspace
          WHERE document_id LIKE $1`,
        [`${String(victim.documentId)}%`],
      )
      expect(rows).toEqual([{ document_id: String(victim.documentId), landscape_id: `${landscape}-victim` }])
    })
  }

  // A minted document is ADMITTED by the MAC alone, and the durable
  // row is backfilled behind it so every other reader of
  // `automerge_document_workspace` keeps working without knowing the scheme
  // exists: the projector, the residency snapshot, the reference-integrity scan.
  //
  // The row is written on first VERIFIED sight rather than at mint time, because
  // at mint time the server holds only raw bytes and automerge-repo does not
  // export the encoder — and because a minted-but-unused id (the offline pool
  // mints ahead of use) would otherwise leave a row for a document that does not
  // exist.
  it('backfills the durable claim for a minted document, without gating on it', async () => {
    const savedSecret = process.env.AUTH_SECRET
    process.env.AUTH_SECRET = 'durable-mint-secret'
    try {
      const workspace = { landscapeId: 'L-minted', versionId: 'V-minted' }
      const mintRoot = repo.create({ modelUrl: '', shardUrls: [] as string[] })
      await mintRoot.whenReady()
      await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('L-minted', 'Minted')")
      await db.pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('V-minted', 'L-minted', 'Main', $1)`,
        [mintRoot.url],
      )

      const minting = new Repo({ idFactory: async () => mintDocumentIdBytes(workspace) })
      const doc = await minting.create2({ made: 'by the client' })
      const documentId = String(doc.documentId)

      const index = new WorkspaceDocIndex(repo, db.pool)
      const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => workspace }, true)

      // Admitted with nothing in the table — this is the O(1) path.
      const { rows: before } = await db.pool.query(
        'SELECT 1 FROM automerge_document_workspace WHERE document_id = $1', [documentId])
      expect(before).toEqual([])
      expect(await gate('peer', documentId)).toBe(true)

      // ...and the row appears behind it.
      let rows: unknown[] = []
      const deadline = Date.now() + 5_000
      while (rows.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
        rows = (await db.pool.query(
          'SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1',
          [documentId])).rows
      }
      expect(rows).toEqual([{ landscape_id: 'L-minted', version_id: 'V-minted' }])

      // And a cold index — the state after any restart — now resolves it the
      // ordinary way, which is what the projector and the scans rely on.
      const cold = new WorkspaceDocIndex(repo, db.pool)
      expect(await cold.resolveDocWorkspace(documentId)).toEqual(workspace)
    } finally {
      if (savedSecret === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = savedSecret
    }
  })

  // The in-memory twin of this (`indexes every leaf while resolving only the
  // root, ModelMeta and registry shards`) runs with `durable: false`, where
  // `claimDocument` short-circuits to a Map write. The walk does not resolve
  // leaves, so the durable INSERT is the ONLY thing that makes a leaf servable.
  // A regression in that SQL would leave every diagram document unindexed,
  // with the in-memory test still green.
  it('durably claims a leaf it never resolves, and it survives a cold index', async () => {
    const leaves = await Promise.all(Array.from({ length: 12 }, async (_v, i) => {
      const h = repo.create({ name: `leaf-${i}` })
      await h.whenReady()
      return h
    }))
    const registry = repo.create({
      diagrams: Object.fromEntries(leaves.map((h, i) => [`d${i}`, { docUrl: h.url }])),
    })
    const leafRoot = repo.create({ modelUrl: '', shardUrls: [registry.url] })
    await Promise.all([registry, leafRoot].map((h) => h.whenReady()))

    await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('L-leaf', 'Leaf')")
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ('V-leaf', 'L-leaf', 'Main', $1)`,
      [leafRoot.url],
    )

    const resolved: string[] = []
    const countingRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === 'find') {
          return (url: string, opts?: unknown) => {
            resolved.push(String(url))
            return (target as unknown as { find: (u: string, o?: unknown) => unknown }).find(url, opts)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const index = new WorkspaceDocIndex(countingRepo, db.pool)
    notifyWorkspaceCreated({ landscapeId: 'L-leaf', versionId: 'V-leaf', rootUrl: leafRoot.url })
    for (const leaf of leaves) {
      const deadline = Date.now() + 10_000
      let owner = await index.resolveDocWorkspace(String(leaf.documentId))
      while (!owner && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20))
        owner = await index.resolveDocWorkspace(String(leaf.documentId))
      }
      expect(owner, `leaf ${String(leaf.documentId)} was never admitted`)
        .toEqual({ landscapeId: 'L-leaf', versionId: 'V-leaf' })
    }
    expect(resolved.filter((u) => leaves.some((h) => h.url === u))).toEqual([])

    // The row is the whole mechanism, so assert the row — keyed on the bare id.
    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automerge_document_workspace
        WHERE landscape_id = 'L-leaf' AND document_id = ANY($1::text[])`,
      [leaves.map((h) => String(h.documentId))],
    )
    expect(rows[0]!.n).toBe(String(leaves.length))

    // A cold index — no in-process cache at all — must still admit them, which
    // is the situation after every restart and every sync-cell failover.
    const cold = new WorkspaceDocIndex(repo, db.pool)
    expect(await cold.resolveDocWorkspace(String(leaves[7]!.documentId)))
      .toEqual({ landscapeId: 'L-leaf', versionId: 'V-leaf' })
  })

  // The three cases above put the decoration on a DIAGRAM url, and leaves are
  // claim-only (the walk does not resolve them): under the mutant derivation
  // the attacker claims `<id>/` and the bare id never reaches `newDocIds`. Only
  // their "no decorated twin row" assertion discriminates the mutant; they are
  // kept for that, and because they pin the derivation itself.
  //
  // This case is the one where the FULL capture mechanism exists. A CONTROL
  // url — `root.shardUrls[i]` — is resolved, and `watch(handle, true)` writes
  // `String(handle.documentId)` into both `newDocIds` and `controlDocWorkspace`,
  // bypassing `claimDocument` entirely. Decorated, the mutant derivation claims
  // a harmless twin while the genuine id is smuggled in through the tail loop,
  // and `resolveDocWorkspace` consults `byDoc` before the durable table.
  it('refuses a foreign CONTROL document referenced through a decorated shard url', async () => {
    const victimShard = repo.create({ diagrams: {} as Record<string, unknown> })
    const victimRoot = repo.create({ modelUrl: '', shardUrls: [victimShard.url] })
    // The attacker lists the victim's registry shard as one of its own, decorated.
    const attackerRoot = repo.create({ modelUrl: '', shardUrls: [`${victimShard.url}/`] })
    await Promise.all([victimShard, victimRoot, attackerRoot].map((h) => h.whenReady()))

    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $1), ($2, $2)',
      ['L-ctl-victim', 'L-ctl-attacker'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3), ($4, $5, 'Main', $6)`,
      ['L-ctl-vv', 'L-ctl-victim', victimRoot.url, 'L-ctl-av', 'L-ctl-attacker', attackerRoot.url],
    )

    const index = new WorkspaceDocIndex(repo, db.pool)
    notifyWorkspaceCreated({ landscapeId: 'L-ctl-victim', versionId: 'L-ctl-vv', rootUrl: victimRoot.url })
    const deadline = Date.now() + 3_000
    let owner = await index.resolveDocWorkspace(String(victimShard.documentId))
    while (!owner && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
      owner = await index.resolveDocWorkspace(String(victimShard.documentId))
    }
    expect(owner).toEqual({ landscapeId: 'L-ctl-victim', versionId: 'L-ctl-vv' })

    notifyWorkspaceCreated({ landscapeId: 'L-ctl-attacker', versionId: 'L-ctl-av', rootUrl: attackerRoot.url })
    await new Promise((r) => setTimeout(r, 400))

    expect(
      await index.resolveDocWorkspace(String(victimShard.documentId)),
      'a decorated CONTROL url must not move a registry shard to another workspace',
    ).toEqual({ landscapeId: 'L-ctl-victim', versionId: 'L-ctl-vv' })

    const { rows } = await db.pool.query<{ document_id: string; landscape_id: string }>(
      `SELECT document_id, landscape_id FROM automerge_document_workspace WHERE document_id LIKE $1`,
      [`${String(victimShard.documentId)}%`],
    )
    expect(rows).toEqual([{ document_id: String(victimShard.documentId), landscape_id: 'L-ctl-victim' }])
  })

  // The PRODUCTION loser path, not a hand-copied
  // statement: a COLD index walks a workspace whose leaf rows are already
  // durably owned, partly by ANOTHER workspace. The batched INSERT conflicts,
  // the batched loser SELECT resolves the winners, and the foreign row must
  // come out untouched. A drift in the production SQL (`= $1` on an array, a
  // renamed column) passes the unit fakes — they dispatch on parameter shape,
  // not on what Postgres accepts — and only this test would go red.
  it('a COLD walk over rows durably owned elsewhere leaves them the winner\'s — production loser path', async () => {
    const monolith = repo.create({ objects: {} })
    const d0 = repo.create({ name: 'lp-d0' })
    const d1 = repo.create({ name: 'lp-d1' })
    const registry = repo.create({ diagrams: { d0: { docUrl: d0.url }, d1: { docUrl: d1.url } } })
    const walkRoot = repo.create({ modelUrl: monolith.url, shardUrls: [registry.url] })
    await Promise.all([monolith, d0, d1, registry, walkRoot].map((h) => h.whenReady()))
    // One leaf durably foreign, seeded through the production single-row path
    // shape (VALUES is fine here: the seed is the OTHER workspace's history).
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, 'L2', 'V2') ON CONFLICT DO NOTHING`,
      [String(d1.documentId)],
    )

    const cold = new WorkspaceDocIndex(repo, db.pool)
    notifyWorkspaceCreated({ landscapeId: 'L1', versionId: 'V1', rootUrl: walkRoot.url })
    await vi.waitFor(async () => {
      expect(await cold.resolveDocWorkspace(String(d0.documentId)))
        .toEqual({ landscapeId: 'L1', versionId: 'V1' })
    }, { timeout: 5_000 })

    const { rows } = await db.pool.query<{ landscape_id: string; version_id: string }>(
      'SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1',
      [String(d1.documentId)],
    )
    expect(rows).toEqual([{ landscape_id: 'L2', version_id: 'V2' }])
    // And the in-process index agrees with the table: never our workspace.
    expect(await cold.resolveDocWorkspace(String(d1.documentId)))
      .not.toEqual({ landscapeId: 'L1', versionId: 'V1' })

    // Restart variant: every row already OURS, a second cold index re-walks —
    // RETURNING is empty end to end and the announcement must still fire.
    const restarted = new WorkspaceDocIndex(repo, db.pool)
    let announced = 0
    restarted.onWorkspaceIndexRepaired = (k) => {
      if (k.landscapeId === 'L1') announced += 1
    }
    notifyWorkspaceCreated({ landscapeId: 'L1', versionId: 'V1', rootUrl: walkRoot.url })
    await vi.waitFor(() => { expect(announced).toBeGreaterThan(0) }, { timeout: 5_000 })
    expect(await restarted.resolveDocWorkspace(String(d0.documentId)))
      .toEqual({ landscapeId: 'L1', versionId: 'V1' })
  })

  // ============================================================
  // The displaced verdict against real Postgres.
  // ============================================================

  /** Seed one landscape with two versions, the first as default. Returns the
   * per-test ids so the suite's tests stay order-independent. */
  async function seedRepointLandscape(tag: string): Promise<{
    landscapeId: string; v1: string; v2: string
  }> {
    const landscapeId = `L-${tag}`
    const v1 = `V-${tag}-1`
    const v2 = `V-${tag}-2`
    const repointRoot = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    await repointRoot.whenReady()
    await db.pool.query(
      'INSERT INTO landscapes (id, name, default_version_id) VALUES ($1, $1, $2)',
      [landscapeId, v1],
    )
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3), ($4, $2, 'Repointed', $3)`,
      [v1, landscapeId, repointRoot.url, v2],
    )
    return { landscapeId, v1, v2 }
  }

  it('repoint end to end: minted for (L,V1), default moved to V2, the canonicalised socket is admitted and the table reads (L,V2)', async () => {
    const { landscapeId, v1, v2 } = await seedRepointLandscape('rp')

    // The client minted while V1 was the default...
    const minting = new Repo({ idFactory: async () => mintDocumentIdBytes({ landscapeId, versionId: v1 }) })
    const documentId = String((await minting.create2({ made: 'offline, pre-repoint' })).documentId)

    // ...the landscape was repointed while it was offline...
    await db.pool.query('UPDATE landscapes SET default_version_id = $1 WHERE id = $2', [v2, landscapeId])

    // ...and its socket reconnects on the alias, which the REAL resolver — the
    // one the HTTP upgrade uses — canonicalises to V2. This is the route the
    // gate sees; the query string is never trusted.
    const route = await resolveWorkspaceRoute(db.pool, { landscapeId, versionId: 'current' })
    expect(route).toEqual({ landscapeId, versionId: v2 })

    const index = new WorkspaceDocIndex(repo, db.pool)
    const announced: string[] = []
    index.onWorkspaceIndexRepaired = (key) => { announced.push(`${key.landscapeId}/${key.versionId}`) }
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => route! }, true)

    expect(await gate('peer', documentId)).toBe(true)

    // The durable row lands on the route the user is ACTUALLY on — the gate
    // awaited this claim as its verdict, so no polling is needed.
    const { rows } = await db.pool.query(
      'SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1',
      [documentId],
    )
    expect(rows).toEqual([{ landscape_id: landscapeId, version_id: v2 }])
    // And the admission announced, so any share-policy deny pinned before the
    // row existed is re-evaluated.
    expect(announced).toContain(`${landscapeId}/${v2}`)

    // A cold index — any restart, any failover — resolves it the ordinary way.
    const cold = new WorkspaceDocIndex(repo, db.pool)
    expect(await cold.resolveDocWorkspace(documentId)).toEqual({ landscapeId, versionId: v2 })
  })

  it('offline through a repoint: no row at mint time; the claim appears only at first presentation', async () => {
    const { landscapeId, v1, v2 } = await seedRepointLandscape('off')

    const minting = new Repo({ idFactory: async () => mintDocumentIdBytes({ landscapeId, versionId: v1 }) })
    const documentId = String((await minting.create2({ made: 'offline' })).documentId)

    // Minting writes NOTHING durable — the id is only bytes until first
    // verified sight (a pooled id may never be used at all).
    const { rows: atMint } = await db.pool.query(
      'SELECT 1 FROM automerge_document_workspace WHERE document_id = $1', [documentId])
    expect(atMint).toEqual([])

    // The repoint happens while the client is away; still no row.
    await db.pool.query('UPDATE landscapes SET default_version_id = $1 WHERE id = $2', [v2, landscapeId])
    const { rows: afterRepoint } = await db.pool.query(
      'SELECT 1 FROM automerge_document_workspace WHERE document_id = $1', [documentId])
    expect(afterRepoint).toEqual([])

    // First presentation is what seeds first-owner-wins, on the presenting route.
    const route = await resolveWorkspaceRoute(db.pool, { landscapeId, versionId: 'current' })
    const index = new WorkspaceDocIndex(repo, db.pool)
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => route! }, true)
    expect(await gate('peer', documentId)).toBe(true)

    const { rows } = await db.pool.query(
      'SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1',
      [documentId],
    )
    expect(rows).toEqual([{ landscape_id: landscapeId, version_id: v2 }])
  })

  // Rotation and repoint TOGETHER. The unit suite proves each loop of the
  // scan separately; this drives both through the production gate, the real
  // env-key path and real SQL. The mutant it exists for: a gate (or scan) that
  // pins the CURRENT key while scanning versions — e.g. passing an explicit
  // secret through, which silently drops AUTH_SECRET_PREVIOUS — passes the
  // unit rotation test (env path, direct call) and the repoint test above
  // (current key), and fails only here.
  it('rotation DURING repoint: an id under the retired key for V1 is admitted on V2', async () => {
    const OLD = 'rotation-repoint-retired-secret'
    const NEW = 'rotation-repoint-current-secret'
    const savedCurrent = process.env.AUTH_SECRET
    const savedPrevious = process.env.AUTH_SECRET_PREVIOUS
    try {
      const { landscapeId, v1, v2 } = await seedRepointLandscape('rot')

      process.env.AUTH_SECRET = OLD
      delete process.env.AUTH_SECRET_PREVIOUS
      const minting = new Repo({ idFactory: async () => mintDocumentIdBytes({ landscapeId, versionId: v1 }) })
      const documentId = String((await minting.create2({ made: 'before rotation and repoint' })).documentId)

      // Both events land while the client is offline: the secret rotates with
      // the overlap window declared, and the default version moves.
      process.env.AUTH_SECRET = NEW
      process.env.AUTH_SECRET_PREVIOUS = OLD
      await db.pool.query('UPDATE landscapes SET default_version_id = $1 WHERE id = $2', [v2, landscapeId])

      const route = await resolveWorkspaceRoute(db.pool, { landscapeId, versionId: 'current' })
      expect(route).toEqual({ landscapeId, versionId: v2 })
      const index = new WorkspaceDocIndex(repo, db.pool)
      const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => route! }, true)

      expect(await gate('peer', documentId)).toBe(true)
      const { rows } = await db.pool.query(
        'SELECT landscape_id, version_id FROM automerge_document_workspace WHERE document_id = $1',
        [documentId],
      )
      expect(rows).toEqual([{ landscape_id: landscapeId, version_id: v2 }])
    } finally {
      if (savedCurrent === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = savedCurrent
      if (savedPrevious === undefined) delete process.env.AUTH_SECRET_PREVIOUS
      else process.env.AUTH_SECRET_PREVIOUS = savedPrevious
    }
  })

  // The two Postgres guarantees the batched flush RESTS ON,
  // pinned empirically against a real server rather than trusted from
  // documentation. This is the exact statement shape `flushLeafClaims` sends.
  it('ON CONFLICT DO NOTHING RETURNING returns only inserted rows, and intra-array duplicates do not raise 21000', async () => {
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ('doc-2c-foreign', 'L2', 'V2') ON CONFLICT DO NOTHING`,
    )
    // Two fresh ids, one durably foreign id, and an intra-array DUPLICATE.
    const batch = ['doc-2c-a', 'doc-2c-b', 'doc-2c-foreign', 'doc-2c-a']
    const inserted = await db.pool.query<{ document_id: string }>(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       SELECT u.document_id, v.landscape_id, v.id
       FROM unnest($1::text[]) AS u(document_id)
       JOIN versions v ON v.id = $3 AND v.landscape_id = $2
       ON CONFLICT (document_id) DO NOTHING
       RETURNING document_id`,
      [batch, 'L1', 'V1'],
    )
    // Guarantee 1: RETURNING excludes the conflicted row — the loser detection
    // by set difference is sound. Guarantee 2: the duplicate did not raise
    // 21000 (the second occurrence sees the first's speculative tuple and is
    // skipped; DO UPDATE would throw "cannot affect row a second time", which
    // is one reason this statement must never migrate to DO UPDATE) — and the
    // duplicate id is returned ONCE, not twice.
    expect(inserted.rows.map((r) => r.document_id).sort()).toEqual(['doc-2c-a', 'doc-2c-b'])
    const { rows: winners } = await db.pool.query(
      `SELECT document_id, landscape_id, version_id FROM automerge_document_workspace
        WHERE document_id = ANY($1::text[])`,
      [['doc-2c-foreign']],
    )
    expect(winners).toEqual([{ document_id: 'doc-2c-foreign', landscape_id: 'L2', version_id: 'V2' }])
    // A version that does not exist inserts nothing and wins nothing — the
    // deleted-workspace shape, same as claimDocument's derive-from-versions.
    const ghost = await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       SELECT u.document_id, v.landscape_id, v.id
       FROM unnest($1::text[]) AS u(document_id)
       JOIN versions v ON v.id = $3 AND v.landscape_id = $2
       ON CONFLICT (document_id) DO NOTHING
       RETURNING document_id`,
      [['doc-2c-ghost'], 'L1', 'V-deleted'],
    )
    expect(ghost.rows).toEqual([])
  })

  // ======================================================================
  // The displaced scan's ORDER BY, pinned against the REAL SQL. The unit
  // suites inject their own LandscapeVersionsSource, so only this test can
  // catch a removed `ORDER BY created_at DESC, id` — yet the candidate ceiling
  // (DISPLACED_SCAN_MAX_CANDIDATES) rests on this order: newest-first
  // is what keeps the true match inside the cap on a landscape big enough to
  // truncate at all.
  // ======================================================================

  it('lists version ids newest-first with id as the deterministic tiebreak — against real Postgres', async () => {
    await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('L-order', 'ordered')")
    // Insertion order is DELIBERATELY oldest-first with the tie's ids
    // reversed: on a small heap Postgres returns insertion order without an
    // ORDER BY, so both mutants (whole clause removed; `, id` tiebreak
    // removed) produce a concretely different array here.
    await db.pool.query(`
      INSERT INTO versions (id, landscape_id, label, root_url, created_at) VALUES
        ('V-old',   'L-order', 'v', 'automerge:x', TIMESTAMPTZ '2026-01-01T00:00:00Z'),
        ('V-mid',   'L-order', 'v', 'automerge:x', TIMESTAMPTZ '2026-01-02T00:00:00Z'),
        ('V-new',   'L-order', 'v', 'automerge:x', TIMESTAMPTZ '2026-01-03T00:00:00Z'),
        ('V-tie-b', 'L-order', 'v', 'automerge:x', TIMESTAMPTZ '2026-01-04T00:00:00Z'),
        ('V-tie-a', 'L-order', 'v', 'automerge:x', TIMESTAMPTZ '2026-01-04T00:00:00Z')
    `)
    const index = new WorkspaceDocIndex(repo, db.pool)
    await expect(index.listLandscapeVersionIds('L-order')).resolves.toEqual([
      'V-tie-a', 'V-tie-b', 'V-new', 'V-mid', 'V-old',
    ])
  })

  // The SELECT itself is capped at cap+1 rows: the scan
  // never reads past DISPLACED_SCAN_MAX_CANDIDATES, and the single extra row
  // is what keeps the truncation detectable (`length > cap`). Mutant killed:
  // LIMIT removed → the row count below reads cap+10.
  it('caps the version-list SELECT at DISPLACED_SCAN_MAX_CANDIDATES + 1 rows, keeping the newest', async () => {
    await db.pool.query("INSERT INTO landscapes (id, name) VALUES ('L-cap', 'capped')")
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, created_at)
       SELECT 'V-cap-' || lpad(i::text, 4, '0'), 'L-cap', 'v', 'automerge:x',
              TIMESTAMPTZ '2026-01-01T00:00:00Z' + make_interval(secs => i)
       FROM generate_series(1, $1::int) AS i`,
      [DISPLACED_SCAN_MAX_CANDIDATES + 10],
    )
    const index = new WorkspaceDocIndex(repo, db.pool)
    const ids = await index.listLandscapeVersionIds('L-cap')
    expect(ids).toHaveLength(DISPLACED_SCAN_MAX_CANDIDATES + 1)
    // The preference order held ACROSS the limit: the newest row leads and
    // the cut dropped the OLDEST tail — a LIMIT without the ORDER BY would
    // keep an arbitrary cap+1.
    expect(ids[0]).toBe(`V-cap-${String(DISPLACED_SCAN_MAX_CANDIDATES + 10).padStart(4, '0')}`)
    expect(ids).not.toContain('V-cap-0001')
    expect(ids).toContain(`V-cap-${String(10).padStart(4, '0')}`)
  })
})
