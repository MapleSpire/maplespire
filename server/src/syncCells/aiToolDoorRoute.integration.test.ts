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
 * THE THREE AI TOOL DOORS, END TO END THROUGH TWO CELLS AND A REAL POSTGRES.
 *
 * ## What this proves that the unit arms cannot
 *
 * `workspaceHttpRoute.test.ts` proves the router PLACES the three doors and
 * forwards their body; `landscapes.claimAtCreate.integration.test.ts` proves
 * the publishers REFUSE on a lease-less cell. Neither proves the end-to-end
 * goal: that a `create_draft`, `create_version` or `merge_draft` sent to the
 * cell that does NOT hold the lease comes back 200 with a version whose whole
 * graph is CLAIMED — by the owner, through the real AI handler, the real
 * lookups (`resolveLandscapeDefaultWorkspace`, `resolveMergeParentWorkspace`),
 * the real canonicaliser and the real publishers.
 *
 * ## Two cells in one process, and how each knows which it is
 *
 * The bootstrap scope reads ownership through ONE installed getter
 * (`installBootstrapOwnership`), process-wide. Two Express apps in one process
 * therefore need the getter to answer per REQUEST, not per process: an
 * `AsyncLocalStorage` middleware stamps every request with its cell, and the
 * getter reads the stamp. The propagation is Node's own (through `express.json`'s
 * stream read, the router's `void (async …)()`, and the handler's awaits), so a
 * request proxied relay → owner opens its scope AS THE OWNER, and the same
 * request served locally on the relay opens it as the relay — which is the
 * 503 pinned in the last arm.
 *
 * Same discipline as `mergeParentRoute.integration.test.ts`: per-suite isolated
 * schema, `db.js` mocked to it before every dynamic import, so the whole module
 * graph shares one registry.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import { Repo } from '@automerge/automerge-repo'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { collectReferencedUrls, documentIdOf } from '../maintenance/workspaceFsck.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import type { SyncCellOwnership } from './ownership.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

type Cell = 'owner' | 'relay'
type PlainDoc = Record<string, unknown> | undefined

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

describe.skipIf(!TEST_DATABASE_URL)('B2-10a — the three AI tool doors reach the owner from the relay (live Postgres, two cells)', () => {
  let db: IsolatedSchemaDb
  let repo: Repo
  let orgId: string
  const cells = new AsyncLocalStorage<Cell>()
  const servers: Server[] = []
  const ports: Record<Cell | 'bare', number> = { owner: 0, relay: 0, bare: 0 }
  /** Requests that reached each app's OWN `/api/ai/tools` handler — i.e. that
   *  the router let through rather than proxied. */
  const local: Record<Cell | 'bare', number> = { owner: 0, relay: 0, bare: 0 }
  let uninstall: (() => void) | null = null

  let landscapes: typeof import('../landscapes.js')
  let bootstrapScope: typeof import('../bootstrapScope.js')
  let placement: typeof import('../rbac/serverCreationPlacement.js')

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'ai_tool_door_route')
    vi.doMock('../db.js', () => ({ pool: db.pool }))
    vi.resetModules()

    const authSchema = await import('../auth/schema.js')
    const rbacSchema = await import('../rbac/schema.js')
    await authSchema.ensureAuthSchema(db.pool)
    await rbacSchema.ensureRbacSchema(db.pool)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        default_version_id TEXT,
        org_id             TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id                TEXT PRIMARY KEY,
        landscape_id      TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        root_url          TEXT NOT NULL,
        parent_version_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'version',
        status            TEXT NOT NULL DEFAULT 'active',
        base_manifest     JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    const ownership = await import('./ownership.js')
    await ownership.ensureSyncCellOwnershipSchema(db.pool)
    const readModelSchema = await import('../readModel/schema.js')
    await readModelSchema.ensureReadModelSchema(db.pool)

    landscapes = await import('../landscapes.js')
    bootstrapScope = await import('../bootstrapScope.js')
    placement = await import('../rbac/serverCreationPlacement.js')
    const docScope = await import('../rbac/docScope.js')
    const { registerAiHttpRoutes } = await import('../ai/adapters/httpRoutes.js')
    const { createWorkspaceHttpRouting } = await import('./workspaceHttpRoute.js')

    orgId = await authSchema.ensureDefaultOrg(db.pool)
    repo = new Repo({})
    // The module-level documents hook the publishers claim through.
    new docScope.WorkspaceDocIndex(repo, db.pool)

    // THE GETTER ANSWERS PER REQUEST. Outside any request it answers null,
    // which with `required` is `warming-up` — so a seeding call that forgot
    // `asOwner` refuses loudly instead of minting unfenced.
    uninstall = bootstrapScope.installBootstrapOwnership({
      required: () => true,
      current: () => {
        const cell = cells.getStore()
        if (!cell) return null
        const owns = cell === 'owner'
        return { enabled: true, owns: () => owns, fencingToken: () => (owns ? '7' : null) }
      },
    })

    const routerOwnership = (cell: Cell): SyncCellOwnership => ({
      enabled: true,
      partitionFor: () => 1,
      ownsPartition: () => cell === 'owner',
      owns: () => cell === 'owner',
      fencingToken: () => (cell === 'owner' ? '7' : null),
      resolveOwner: async () => ({ cellId: 'owner', token: '7', partition: 1, advertiseUrl: `http://127.0.0.1:${ports.owner}` }),
      onOwnershipLost: () => () => undefined,
      snapshot: () => ({ cellId: cell, partitionIndex: cell === 'owner' ? 1 : 0 } as never),
      readSnapshot: () => ({ cellId: cell, partitionIndex: cell === 'owner' ? 1 : 0 } as never),
    })

    const cellApp = (cell: Cell, options: { routed: boolean }): express.Express => {
      const app = express()
      app.use((_request, _response, next) => cells.run(cell, next))
      // Same order as `index.ts`: the body is parsed BEFORE the router runs.
      app.use(express.json())
      if (options.routed) {
        app.use(createWorkspaceHttpRouting({ db: db.pool, ownership: () => routerOwnership(cell), ownershipRequired: () => true }))
      }
      app.use('/api/ai/tools', (_request, _response, next) => {
        local[options.routed ? cell : 'bare'] += 1
        next()
      })
      registerAiHttpRoutes(app, { repo, rootUrl: 'automerge:unused-fallback-root' })
      return app
    }

    // The owner first: the relay's `resolveOwner` needs its port.
    const owner = createServer(cellApp('owner', { routed: true }))
    servers.push(owner)
    ports.owner = await listen(owner)
    const relay = createServer(cellApp('relay', { routed: true }))
    servers.push(relay)
    ports.relay = await listen(relay)
    // A relay cell WITHOUT the router: the shape a missing extractor entry
    // produces.
    const bare = createServer(cellApp('relay', { routed: false }))
    servers.push(bare)
    ports.bare = await listen(bare)
  }, 120_000)

  afterAll(async () => {
    while (servers.length) {
      const server = servers.pop()!
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    uninstall?.()
    placement?.resetServerCreationPlacementForTest()
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.resetModules()
  })

  /** Run a publisher directly, as the owner cell would. */
  const asOwner = <T,>(fn: () => Promise<T>): Promise<T> => cells.run('owner', fn)

  async function tool(cell: Cell | 'bare', name: string, body: Record<string, unknown>): Promise<{
    status: number
    route: string | null
    body: Record<string, unknown>
  }> {
    const response = await fetch(`http://127.0.0.1:${ports[cell]}/api/ai/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      route: response.headers.get('x-maplespire-sync-route'),
      body: (await response.json()) as Record<string, unknown>,
    }
  }

  async function resolvePlain(url: unknown): Promise<PlainDoc> {
    if (typeof url !== 'string' || url.length === 0) return undefined
    return (await findReadyDocument<Record<string, unknown>>(repo, url)).doc()
  }

  /** The reachable id set of a version's root graph, gathered the way fsck
   *  gathers it — the invariant every publisher leaves is claimed == reachable. */
  async function reachableIds(rootUrl: string): Promise<Set<string>> {
    const root = await resolvePlain(rootUrl)
    const meta = await resolvePlain(root?.modelMetaUrl)
    const registries: PlainDoc[] = []
    for (const shardUrl of (root?.shardUrls as string[] | undefined) ?? []) registries.push(await resolvePlain(shardUrl))
    const referenced = collectReferencedUrls(root, meta, registries)
    return new Set([documentIdOf(rootUrl), ...referenced.map(documentIdOf)])
  }

  async function claimedIds(landscapeId: string, versionId: string): Promise<Set<string>> {
    const { rows } = await db.pool.query<{ document_id: string }>(
      'SELECT document_id FROM automerge_document_workspace WHERE landscape_id = $1 AND version_id = $2',
      [landscapeId, versionId],
    )
    return new Set(rows.map((row) => row.document_id))
  }

  async function rootUrlOf(landscapeId: string, versionId: string): Promise<string> {
    const { rows } = await db.pool.query<{ root_url: string }>(
      'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2', [versionId, landscapeId],
    )
    expect(rows, `no versions row for ${versionId}`).toHaveLength(1)
    return rows[0]!.root_url
  }

  /** The returned version's WHOLE graph is claimed — the SIX documents of an
   *  empty landscape's twin (root, legacy monolith, ModelMeta, registry shard,
   *  both overlay shards), the same six the active-active leg reads through
   *  `psql` (docs/ci.md). */
  async function expectWholeGraphClaimed(landscapeId: string, versionId: string): Promise<void> {
    const claimed = await claimedIds(landscapeId, versionId)
    expect(claimed).toEqual(await reachableIds(await rootUrlOf(landscapeId, versionId)))
    expect(claimed.size).toBe(6)
  }

  it('create_draft sent to the RELAY answers 200 `route: proxied`, and the draft is wholly claimed by the owner', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'relayed draft home', orgId))
    const before = bootstrapScope.bootstrapScopeSnapshot()
    const relayLocalBefore = local.relay
    const ownerLocalBefore = local.owner

    const answer = await tool('relay', 'create_draft', { landscapeId: landscape.id, input: { label: 'via the relay' } })

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.route).toBe('proxied')
    const draft = (answer.body.result as { draft: { id: string; parentVersionId: string; status: string } }).draft
    expect(draft.parentVersionId).toBe(landscape.defaultVersionId)
    expect(draft.status).toBe('active')
    await expectWholeGraphClaimed(landscape.id, draft.id)
    // The relay's OWN handler never ran, the OWNER's did (asserting only the
    // former would pass for a proxy to nowhere that answered 200), and the
    // scope counter never moved on the relay: nothing was refused, nothing was
    // opened there.
    expect(local.relay - relayLocalBefore, 'the relay served the creation locally').toBe(0)
    expect(local.owner - ownerLocalBefore, 'the owner’s handler did not run it').toBe(1)
    const after = bootstrapScope.bootstrapScopeSnapshot()
    expect(after.refusedAtOpen - before.refusedAtOpen).toBe(0)
    expect(after.opened - before.opened, 'the owner opened the draft’s scope').toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('create_version sent to the RELAY is placed on the landscape DEFAULT whatever the source — a merged draft included', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'relayed version home', orgId))
    // A merged draft as the fork source: not lease-able by any cell, so a
    // router keyed on the source would send this nowhere.
    const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'to be merged'))
    const { applyMerge } = await import('../draft/applyMerge.js')
    const merged = await asOwner(() => applyMerge(repo, landscape.id, draft!.id))
    expect(merged).toMatchObject({ ok: true })
    const before = bootstrapScope.bootstrapScopeSnapshot()
    const relayLocalBefore = local.relay
    const ownerLocalBefore = local.owner

    const answer = await tool('relay', 'create_version', {
      landscapeId: landscape.id, versionId: draft!.id, input: { label: 'twin of a merged draft', forkFromVersionId: draft!.id },
    })

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.route).toBe('proxied')
    const version = (answer.body.result as { version: { id: string } }).version
    await expectWholeGraphClaimed(landscape.id, version.id)
    expect(local.relay - relayLocalBefore).toBe(0)
    expect(local.owner - ownerLocalBefore).toBe(1)
    expect(bootstrapScope.bootstrapScopeSnapshot().refusedAtOpen - before.refusedAtOpen).toBe(0)
  }, 30_000)

  it('merge_draft sent to the RELAY is placed on the draft’s PARENT: the snapshot version is claimed, the draft marked merged', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'relayed merge home', orgId))
    const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'relayed draft'))
    expect(draft).not.toBeNull()
    const before = bootstrapScope.bootstrapScopeSnapshot()
    const relayLocalBefore = local.relay
    const ownerLocalBefore = local.owner

    const answer = await tool('relay', 'merge_draft', { landscapeId: landscape.id, input: { draftId: draft!.id } })

    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.route).toBe('proxied')
    const result = answer.body.result as { merged: boolean; snapshotVersionId: string }
    expect(result.merged).toBe(true)
    expect(result.snapshotVersionId).not.toBe('')
    await expectWholeGraphClaimed(landscape.id, result.snapshotVersionId)
    const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM versions WHERE id = $1', [draft!.id])
    expect(rows[0]!.status).toBe('merged')
    expect(local.relay - relayLocalBefore).toBe(0)
    expect(local.owner - ownerLocalBefore).toBe(1)
    expect(bootstrapScope.bootstrapScopeSnapshot().refusedAtOpen - before.refusedAtOpen).toBe(0)
  }, 30_000)

  it('the HANDLER reads the landscape from the top level, never from input — the decoy the two lenses asked for, driven end to end on both cells', async () => {
    // The router places on `body.landscapeId`; a handler that read
    // `input.landscapeId` first would fork the DECOY landscape on the cell the
    // router chose for the other one — a confident wrong-owner write. This
    // arm pins the handler's side, against the real handler, on the owner and
    // through the relay.
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'decoy home', orgId))
    const decoy = await asOwner(() => landscapes.createLandscape(repo, 'decoy target', orgId))
    for (const cell of ['owner', 'relay'] as const) {
      const answer = await tool(cell, 'create_draft', {
        landscapeId: landscape.id, input: { landscapeId: decoy.id, label: `decoy via ${cell}` },
      })
      expect(answer.status, `${cell}: ${JSON.stringify(answer.body)}`).toBe(200)
      expect(answer.route).toBe(cell === 'owner' ? 'owner' : 'proxied')
      const draft = (answer.body.result as { draft: { id: string; parentVersionId: string } }).draft
      expect(draft.parentVersionId, `${cell}: the handler forked the decoy`).toBe(landscape.defaultVersionId)
      const { rows } = await db.pool.query<{ landscape_id: string }>('SELECT landscape_id FROM versions WHERE id = $1', [draft.id])
      expect(rows[0]!.landscape_id).toBe(landscape.id)
    }
    const { rows: decoyDrafts } = await db.pool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1 AND kind = $2', [decoy.id, 'draft'])
    expect(decoyDrafts[0]!.n, 'a draft was forked in the decoy landscape').toBe(0)
  }, 30_000)

  it('CONTROL — the same three doors on the OWNER answer `route: owner` and run locally', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'owner home', orgId))
    const ownerLocalBefore = local.owner

    const created = await tool('owner', 'create_draft', { landscapeId: landscape.id, input: { label: 'owner draft' } })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    expect(created.route).toBe('owner')
    const draft = (created.body.result as { draft: { id: string } }).draft
    await expectWholeGraphClaimed(landscape.id, draft.id)

    const forked = await tool('owner', 'create_version', { landscapeId: landscape.id, input: { label: 'owner fork' } })
    expect(forked.status, JSON.stringify(forked.body)).toBe(200)
    expect(forked.route).toBe('owner')

    const merged = await tool('owner', 'merge_draft', { landscapeId: landscape.id, input: { draftId: draft.id } })
    expect(merged.status, JSON.stringify(merged.body)).toBe(200)
    expect(merged.route).toBe('owner')
    expect((merged.body.result as { merged: boolean }).merged).toBe(true)

    expect(local.owner - ownerLocalBefore, 'each ran on the owner’s own handler').toBe(3)
  }, 30_000)

  it('a merge_draft naming a draft that does not exist is handed back to the relay’s own handler, which answers 404 having written nothing', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'unknown draft home', orgId))
    const versionsBefore = (await db.pool.query('SELECT count(*)::int AS n FROM versions')).rows[0]!.n
    const relayLocalBefore = local.relay
    const ownerLocalBefore = local.owner

    const answer = await tool('relay', 'merge_draft', { landscapeId: landscape.id, input: { draftId: 'nope' } })

    expect(answer.status).toBe(404)
    expect(answer.route, 'a pass-through wears no route header').toBeNull()
    expect(local.relay - relayLocalBefore).toBe(1)
    expect(local.owner - ownerLocalBefore, 'nothing was proxied').toBe(0)
    expect((await db.pool.query('SELECT count(*)::int AS n FROM versions')).rows[0]!.n).toBe(versionsBefore)
  }, 30_000)

  it('an ORDINARY tool is placed too since B2-10d1 — a read sent to the relay is answered by the OWNER', async () => {
    // The generic entry places every tool name on the workspace its body
    // names, not just the three bootstrap doors. For a READ that is a hop rather than
    // a correctness fix — reads need no lease — and the reason it is placed
    // anyway is that filtering by `mode` inside `syncCells/` would import the
    // AI registry and close a dependency cycle. The hop that DOES matter is
    // the write one, which `aiToolModelWriteLost.integration.test.ts` drives.
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'read home', orgId))
    const relayLocalBefore = local.relay
    const ownerLocalBefore = local.owner
    const answer = await tool('relay', 'list_drafts', { landscapeId: landscape.id, input: {} })
    expect(answer.status).toBe(200)
    expect(answer.route).toBe('proxied')
    expect(answer.body.result).toEqual({ drafts: [] })
    expect(local.relay - relayLocalBefore, 'the relay served it instead of routing it').toBe(0)
    expect(local.owner - ownerLocalBefore, 'the owner answered it').toBe(1)
  }, 30_000)

  it('THE SHAPE THE MUTANT REPRODUCES — the same door on a relay cell WITHOUT the router is refused 503 `sync-cell-not-owner`, nothing minted', async () => {
    // What a missing extractor entry produces: the request reaches the
    // handler on a cell that holds no lease, and the scope refuses at open.
    // Pinned here so that failure shape lives beside the arms it would turn red.
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'bare relay home', orgId))
    const before = bootstrapScope.bootstrapScopeSnapshot()
    const versionsBefore = (await db.pool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n

    const answer = await tool('bare', 'create_draft', { landscapeId: landscape.id, input: { label: 'refused' } })

    expect(answer.status).toBe(503)
    expect(answer.route).toBeNull()
    expect(answer.body).toMatchObject({ code: 'sync-cell-not-owner', reason: 'not-owner', retryable: true, wrote: 'nothing' })
    const after = bootstrapScope.bootstrapScopeSnapshot()
    expect(after.refusedAtOpen - before.refusedAtOpen).toBe(1)
    expect(after.refusedAtOpenByReason['not-owner'] - before.refusedAtOpenByReason['not-owner']).toBe(1)
    expect((await db.pool.query('SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1', [landscape.id])).rows[0]!.n).toBe(versionsBefore)
    expect(local.bare).toBe(1)
  }, 30_000)
})
