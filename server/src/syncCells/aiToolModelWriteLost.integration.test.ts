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
 * A MODEL WRITE SENT TO A CELL THAT DOES NOT OWN THE WORKSPACE.
 *
 * If a write tool is not placed by `WORKSPACE_ROUTE_EXTRACTORS`, it runs
 * wherever the request landed: 200 with a `result`, no `proxied` header, an
 * `automerge.background_save_fenced` warn ~100 ms later, and the durable value
 * unchanged — a silently lost write. Each arm below asserts the routed
 * behaviour and notes what the unrouted one would look like.
 *
 * ## Why the failure is invisible without this fixture
 *
 * `update_model_object` calls `handle.change` on a document the workspace
 * already owns and returns. It never flushes. Automerge's debounced save fires
 * ~100 ms later, ON A CELL WITH NO LEASE, so `PostgresStorageAdapter` refuses
 * it (`StaleSyncCellWriteError`, reason `ownership-unavailable`) and
 * `observeAutomergeBackgroundSaveErrors` writes ONE `warn` line. The HTTP
 * caller was told 200 long before. The MCP stdio proxy — what Claude Code
 * drives — relays each tool call to this exact door.
 *
 * So the three things this fixture needs, none of which
 * `aiToolDoorRoute.integration.test.ts` has:
 *  - a REAL storage adapter per cell, since the refusal is the adapter's;
 *  - a DIFFERENT fencing token per cell, since that is what makes one of them
 *    a non-owner;
 *  - a DURABLE witness that is not either cell's memory. Both repos keep the
 *    change in RAM whatever storage says, so "was it written" is asked of a
 *    THIRD, cold repo that can only answer from Postgres.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import { Repo } from '@automerge/automerge-repo'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { PostgresStorageAdapter } from '../automergeStorage.js'
import { observeAutomergeBackgroundSaveErrors } from '../automergeBackgroundSave.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { parseWorkspaceHttpRoute } from './workspaceHttpRoute.js'
import { AI_TOOL_DOORS } from './workspaceRouteExtractors.js'
import type { SyncCellOwnership } from './ownership.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

type Cell = 'owner' | 'relay'

/** The debounced save is ~100 ms; this is that plus room for the round trip to
 *  Postgres and the refusal coming back. Every arm that reads the durable value
 *  waits it out first — a read before the window would say "not written yet"
 *  for the owner too, and prove nothing about either. */
const SAVE_WINDOW_MS = 700

const LANDSCAPE = 'lost-write-landscape'
const VERSION = 'lost-write-version'
const OBJECT_ID = 'obj-under-test'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe.skipIf(!TEST_DATABASE_URL)('B2-10d — a model write sent to a NON-OWNER reaches the owner and is durable (live Postgres, two cells)', () => {
  let db: IsolatedSchemaDb
  const cells = new AsyncLocalStorage<Cell>()
  const servers: Server[] = []
  const ports: Record<Cell, number> = { owner: 0, relay: 0 }
  /** Requests each cell's OWN tool handler served — i.e. that its router let
   *  through rather than proxied. */
  const local: Record<Cell, number> = { owner: 0, relay: 0 }
  /** Every `warn` line the relay's background-save observer emitted. */
  const relayWarnings: string[] = []
  let repos: Record<Cell, Repo>
  let rootUrl: string
  /** The write tools the registry serves, read FROM the registry rather than
   *  copied — a tool added to `writeTools.ts` joins this census by existing.
   *  Filled after `db.js` is mocked, like every other app import here. */
  let writeToolNames: string[] = []
  let uninstall: (() => void) | null = null
  let unobserve: (() => void) | null = null

  const storageFor = (cell: Cell): PostgresStorageAdapter => new PostgresStorageAdapter({
    db: db.pool,
    // THE ONE DIFFERENCE BETWEEN THE TWO CELLS. The owner holds the lease whose
    // token the `sync_workspace_ownership` row carries; the relay holds none,
    // which is what `requireWriteAuthority` calls `not-owner` and what the
    // adapter turns into `ownership-unavailable`.
    ownership: { fencingToken: () => (cell === 'owner' ? '7' : null) },
  })

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'ai_tool_model_write_lost')
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
    // The chunk table the adapter reads and writes. Same shape as
    // `automergeStorage.fencing.integration.test.ts` seeds — the production
    // migration is not importable from here, and the adapter only needs these
    // columns plus the arrival sequence.
    await db.pool.query('CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq')
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS automerge_storage (
        key         TEXT PRIMARY KEY,
        data        BYTEA NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      )
    `)
    const ownership = await import('./ownership.js')
    await ownership.ensureSyncCellOwnershipSchema(db.pool)
    const readModelSchema = await import('../readModel/schema.js')
    await readModelSchema.ensureReadModelSchema(db.pool)
    const orgId = await authSchema.ensureDefaultOrg(db.pool)

    const docScope = await import('../rbac/docScope.js')
    const bootstrapScope = await import('../bootstrapScope.js')
    const { registerAiHttpRoutes } = await import('../ai/adapters/httpRoutes.js')
    const { createWorkspaceHttpRouting } = await import('./workspaceHttpRoute.js')
    const { listAiTools } = await import('../ai/core/toolRegistry.js')
    writeToolNames = listAiTools().filter((t) => t.mode === 'write').map((t) => t.name)

    repos = {
      owner: new Repo({ storage: storageFor('owner') }),
      relay: new Repo({ storage: storageFor('relay') }),
    }
    new docScope.WorkspaceDocIndex(repos.owner, db.pool)
    unobserve = observeAutomergeBackgroundSaveErrors(repos.relay, {
      warn: (message: string) => { relayWarnings.push(message) },
      error: (message: string, error: unknown) => { relayWarnings.push(`${message} ${String(error)}`) },
    })

    // ── The workspace, seeded BY HAND as the owner ────────────────────────
    // A monolith root rather than `createLandscape`: this suite is about what
    // an UPDATE does to an already-claimed document, so the cheapest graph that
    // `ModelSession` accepts is the honest one. The publishers have their own
    // suites (`aiToolDoorRoute.integration.test.ts`).
    const model = repos.owner.create<Record<string, unknown>>({
      objects: {
        [OBJECT_ID]: {
          id: OBJECT_ID, type: 'system', name: 'Before any write',
          tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live',
          properties: {}, position: { x: 0, y: 0 }, size: { width: 160, height: 100 },
        },
      },
      connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
    })
    await model.whenReady()
    const shard = repos.owner.create<Record<string, unknown>>({ diagrams: {} })
    await shard.whenReady()
    const root = repos.owner.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
    await root.whenReady()
    rootUrl = root.url

    await db.pool.query('INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $2, $3, $4)',
      [LANDSCAPE, 'Lost write', VERSION, orgId])
    await db.pool.query(
      'INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $3, $4)',
      [VERSION, LANDSCAPE, 'Main', rootUrl])
    // CLAIMED, which is what makes the fence apply at all: an unclaimed
    // document is quarantined local provisioning and is allowed on any cell.
    for (const handle of [root, model, shard]) {
      await db.pool.query(
        `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
         VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
        [handle.documentId, LANDSCAPE, VERSION])
    }
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, 'cell-owner', '7', NOW() + INTERVAL '1 hour', NULL)`,
      [LANDSCAPE, VERSION])
    // The seeding writes above ran before the claim rows existed, so they were
    // quarantined rather than fenced; flush them now, as the owner, so the
    // durable chunks the cold witness reads are really there.
    await repos.owner.flush()

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

    const cellApp = (cell: Cell): express.Express => {
      const app = express()
      app.use((_request, _response, next) => cells.run(cell, next))
      app.use(express.json())
      app.use(createWorkspaceHttpRouting({
        db: db.pool, ownership: () => routerOwnership(cell), ownershipRequired: () => true,
      }))
      app.use('/api/ai/tools', (_request, _response, next) => { local[cell] += 1; next() })
      registerAiHttpRoutes(app, { repo: repos[cell], rootUrl })
      return app
    }

    const owner = createServer(cellApp('owner'))
    servers.push(owner)
    ports.owner = await listen(owner)
    const relay = createServer(cellApp('relay'))
    servers.push(relay)
    ports.relay = await listen(relay)
  }, 120_000)

  afterAll(async () => {
    while (servers.length) {
      const server = servers.pop()!
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    unobserve?.()
    uninstall?.()
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.resetModules()
  })

  async function tool(cell: Cell, name: string, input: Record<string, unknown>): Promise<{
    status: number
    route: string | null
    body: Record<string, unknown>
  }> {
    const response = await fetch(`http://127.0.0.1:${ports[cell]}/api/ai/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ landscapeId: LANDSCAPE, versionId: VERSION, input }),
    })
    return {
      status: response.status,
      route: response.headers.get('x-maplespire-sync-route'),
      body: (await response.json()) as Record<string, unknown>,
    }
  }

  /**
   * THE DURABLE WITNESS, AND WHY IT IS A THIRD REPO.
   *
   * Asking either cell's repo would ask its MEMORY: both keep a change whose
   * save was refused, so both answer "written" for a write that is gone. A
   * fresh `Repo` shares nothing but the Postgres schema, so the only place its
   * answer can come from is the durable chunks.
   */
  async function durableObjectName(): Promise<unknown> {
    const cold = new Repo({ storage: storageFor('owner') })
    const root = (await findReadyDocument<Record<string, unknown>>(cold, rootUrl)).doc()
    const model = (await findReadyDocument<Record<string, unknown>>(cold, String(root?.modelUrl))).doc()
    const objects = model?.objects as Record<string, { name?: unknown }> | undefined
    return objects?.[OBJECT_ID]?.name
  }

  it('the witness can see a write at all — the OWNER updates the object and it lands durably', async () => {
    // THE CONTROL, and it runs first on purpose: an instrument that reports
    // "not written" for everything would make the next arm's finding vacuous.
    const before = await durableObjectName()
    expect(before).toBe('Before any write')

    const answer = await tool('owner', 'update_model_object', { id: OBJECT_ID, name: 'Written by the owner' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.route, 'the owner served it locally').not.toBe('proxied')
    expect(local.owner).toBeGreaterThan(0)

    await sleep(SAVE_WINDOW_MS)
    expect(await durableObjectName()).toBe('Written by the owner')
    expect(relayWarnings, 'the owner refused nothing').toEqual([])
  }, 30_000)

  it('THE FIX — the same call on the RELAY is proxied, the OWNER applies it, and the write is durable', async () => {
    const before = await durableObjectName()
    expect(before, 'the control arm must have run first').toBe('Written by the owner')
    const relayLocalBefore = local.relay
    const ownerLocalBefore = local.owner
    relayWarnings.length = 0

    const answer = await tool('relay', 'update_model_object', { id: OBJECT_ID, name: 'Written by the relay' })

    // (1) Still 200 — the caller's contract does not change.
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.result).toBeDefined()
    // (2) Proxied to the owner. Without the generic extractor entry this would
    //     be served locally (`relay 1 / owner 0`).
    expect(answer.route, 'the generic extractor entry places this tool').toBe('proxied')
    expect(local.relay - relayLocalBefore, 'the relay served it instead of routing it').toBe(0)
    expect(local.owner - ownerLocalBefore, 'the owner applied it').toBe(1)

    // (3) Nothing is refused: the write happens on the cell that holds
    //     the lease, so the storage fence has nothing to reject.
    await sleep(SAVE_WINDOW_MS)
    const fenced = relayWarnings.filter((line) => line.includes('automerge.background_save_fenced'))
    expect(fenced, `a save was still refused: ${JSON.stringify(relayWarnings)}`).toEqual([])

    // (4) And the write EXISTS durably. Without the routing, the durable value
    //     would still be `'Written by the owner'`.
    expect(
      await durableObjectName(),
      'the relay’s write did not reach durable storage — the generic entry is not doing its job',
    ).toBe('Written by the relay')
  }, 30_000)

  it('and it is the WHOLE population, not one tool — every write tool the registry serves is placed', () => {
    // WHY A MECHANISM ARM RATHER THAN ONE HTTP CALL PER TOOL: the failure is
    // not a property of `update_model_object`. It is a property of the door
    // being unplaced for a name outside `AI_TOOL_DOORS`, and of the model
    // family writing through `handle.change` on a claimed document. The first
    // half is asserted here, name by name, against the router itself; the
    // second half is what the arm above drives end to end for one of them.
    const body = { landscapeId: LANDSCAPE, versionId: VERSION, input: { id: OBJECT_ID } }
    const unplaced: string[] = []
    for (const name of writeToolNames) {
      if (AI_TOOL_DOORS.has(name)) continue
      const parsed = parseWorkspaceHttpRoute(`/api/ai/tools/${name}`, 'POST', body)
      if (parsed.kind === 'not-workspace' || parsed.kind === 'invalid') unplaced.push(name)
    }
    // The lower bound is a vacuity guard: the registry must actually have been
    // read.
    expect(writeToolNames.length, 'the registry was read at all').toBeGreaterThanOrEqual(23)
    expect(
      unplaced,
      'these write tools still run where they land — a 200 over a write the storage fence will refuse',
    ).toEqual([])
  })

  it('an UNKNOWN tool name is relayed and answered by the owner — the same 404 the landing cell would have given', async () => {
    // THE COST OF A GENERIC ENTRY, asserted rather than assumed: it claims
    // names the registry has never heard of, so a typo now costs a round trip
    // before its 404. What must not change is the ANSWER — same status, same
    // body, byte for byte — or a client would be able to tell which cell it
    // reached, which is the property the whole placement layer is for.
    const relayed = await tool('relay', 'no_such_tool', { id: OBJECT_ID })
    const local404 = await tool('owner', 'no_such_tool', { id: OBJECT_ID })
    expect(relayed.route, 'the generic entry claims an unknown name too').toBe('proxied')
    expect(relayed.status).toBe(404)
    expect(local404.status).toBe(404)
    expect(relayed.body).toEqual(local404.body)
    expect(relayed.body.error).toContain('no_such_tool')
  }, 30_000)

  it('the LOUD population is fixed too — a tool that MINTS a document no longer 500s on the relay', async () => {
    // THE OTHER POPULATION, with its own arm because it fails differently.
    // `create_diagram` goes through `createClaimedDocument` and `repo.flush`,
    // and a flush REJECTS its caller where a debounced save only warns: on a
    // non-owner it would answer 500 `{ error: 'AI request failed' }`.
    const answer = await tool('relay', 'create_diagram', { name: 'Minted on the relay', type: 'context' })
    expect(answer.status, `create_diagram answered ${JSON.stringify(answer.body)}`).toBe(200)
    expect(answer.route, 'it reached the owner').toBe('proxied')
    expect((answer.body.result as { created?: { id?: string } } | undefined)?.created?.id).toBeTruthy()
  }, 30_000)
})
