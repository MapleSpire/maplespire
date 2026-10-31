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

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { coldBuildReadModel, syncDiagrams, type WorkspaceKey } from './projector.js'
import { roObjectSearchPage, roObjectTreeChildren } from './objectExplorer.js'
import type { DiagramInput, ObjectInput } from './types.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 2, connectionTimeoutMillis: 3000 }), 'objectScopeUsage')
  try {
    const c = await p.connect()
    c.release()
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[objectScopeUsage] no Postgres at ${URL} — skipping DB tests`)

const WS: WorkspaceKey = { landscapeId: 'ws-scope-usage', versionId: 'v1' }

// The same model as the client twin (src/lib/diagrams/objectScopeUsage.test.ts):
// shop ⊃ web, api ⊃ auth; bank ⊃ ledger; stripe external by default.
const o = (id: string, parentId?: string, scope: 'internal' | 'external' = 'internal'): ObjectInput =>
  ({ id, name: id, type: parentId ? 'app' : 'system', scope, ...(parentId ? { parentId } : {}) })
const MODEL: ObjectInput[] = [
  o('shop'), o('web', 'shop'), o('api', 'shop'), o('auth', 'api'),
  o('bank'), o('ledger', 'bank'), o('stripe', undefined, 'external'), { ...o('customer'), type: 'actor' },
]
const d = (id: string, objectIds: string[], over: Partial<DiagramInput> = {}): DiagramInput =>
  ({ id, name: id, type: 'landscape', objectIds, connectionIds: [], groupIds: [], ...over })
const LANDSCAPE = d('landscape', ['shop', 'bank', 'stripe', 'customer'])
const SHOP_CONTAINERS = d('shop-c', ['web', 'api', 'bank', 'stripe', 'customer'], { parentObjectId: 'shop' })
const API_COMPONENTS = d('api-c', ['auth', 'web', 'ledger'], { parentObjectId: 'api' })

suite('derived per-diagram scope usage (Postgres integration, txn-isolated)', () => {
  let client: pg.PoolClient
  afterAll(async () => { await pool!.end() })
  beforeEach(async () => {
    client = await pool!.connect()
    await client.query('BEGIN')
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
    client.release()
  })

  const usage = async () => {
    // Every object is a root or reached through search; a filter-only search
    // pages every object, with the metrics the table shows.
    const page = await roObjectSearchPage(client, WS, { filter: { types: ['system', 'app', 'actor'] }, limit: 50 })
    return new Map(page.items.map((row) => [row.id, { external: row.externalDiagramCount, total: row.diagramCount }]))
  }

  it('counts the C4 boundary rule, nested ancestry and an external default like the client resolver', async () => {
    await coldBuildReadModel(client, WS, null, MODEL, [], [], [LANDSCAPE, SHOP_CONTAINERS, API_COMPONENTS])
    const byId = await usage()
    expect(byId.get('bank')).toEqual({ external: 1, total: 2 })
    expect(byId.get('web')).toEqual({ external: 1, total: 2 })
    expect(byId.get('auth')).toEqual({ external: 0, total: 1 })
    expect(byId.get('ledger')).toEqual({ external: 1, total: 1 })
    expect(byId.get('stripe')).toEqual({ external: 2, total: 2 })
    expect(byId.get('shop')).toEqual({ external: 0, total: 1 })
    // An actor is exempt from the boundary: internal on shop's view too.
    expect(byId.get('customer')).toEqual({ external: 0, total: 2 })
  })

  it('the focus is inside its own drill-down, and a TWO-step ancestry outside the focus is external', async () => {
    await coldBuildReadModel(client, WS, null, MODEL, [], [], [
      d('shop-c', ['shop', 'web'], { parentObjectId: 'shop' }),
      // auth -> api -> shop -> (root): never passes bank, two steps to a root.
      d('bank-c', ['ledger', 'auth'], { parentObjectId: 'bank' }),
    ])
    const byId = await usage()
    expect(byId.get('shop')).toEqual({ external: 0, total: 1 })
    expect(byId.get('auth')).toEqual({ external: 1, total: 1 })
    expect(byId.get('ledger')).toEqual({ external: 0, total: 1 })
  })

  it('lets the registry-meta override win both ways, and follows it when it changes', async () => {
    await coldBuildReadModel(client, WS, null, MODEL, [], [], [
      { ...LANDSCAPE, objectScopes: { shop: 'external', stripe: 'internal' } },
      { ...SHOP_CONTAINERS, objectScopes: { bank: 'internal' } },
    ])
    let byId = await usage()
    expect(byId.get('shop')).toEqual({ external: 1, total: 1 })
    expect(byId.get('stripe')).toEqual({ external: 1, total: 2 })
    expect(byId.get('bank')).toEqual({ external: 0, total: 2 })

    // The live projector re-syncs every registry meta; a cleared override set
    // is an absent key and must stop counting.
    await syncDiagrams(client, WS, null, [LANDSCAPE, SHOP_CONTAINERS])
    byId = await usage()
    expect(byId.get('shop')).toEqual({ external: 0, total: 1 })
    expect(byId.get('bank')).toEqual({ external: 1, total: 2 })
  })

  it('ignores a malformed override and treats a missing ancestor or a cycle as outside (inside must be proven)', async () => {
    await coldBuildReadModel(client, WS, null, [
      ...MODEL,
      o('orphan', 'not-projected'),
      o('cyc-a', 'cyc-b'), o('cyc-b', 'cyc-a'),
      // An empty parentId is a root to the JS resolvers: provably outside.
      { ...o('blank'), parentId: '' },
    ], [], [], [
      d('shop-c', ['orphan', 'cyc-a', 'bank', 'blank'], { parentObjectId: 'shop', objectScopes: { bank: 'sideways' } as never }),
    ])
    const byId = await usage()
    expect(byId.get('blank')).toEqual({ external: 1, total: 1 })
    expect(byId.get('orphan')).toEqual({ external: 1, total: 1 })
    expect(byId.get('cyc-a')).toEqual({ external: 1, total: 1 })
    // 'sideways' is no override: bank falls through to the boundary rule.
    expect(byId.get('bank')).toEqual({ external: 1, total: 1 })
  })

  it('filters "external on some diagram" in both directions and never returns a group for true', async () => {
    await coldBuildReadModel(client, WS, null, MODEL, [], [{ id: 'g1', name: 'Group one', objectIds: ['bank'] }], [
      LANDSCAPE, SHOP_CONTAINERS, API_COMPONENTS,
    ])
    const external = await roObjectSearchPage(client, WS, { filter: { externalOnSomeDiagram: true }, limit: 50 })
    expect(external.items.map((row) => row.id).sort()).toEqual(['bank', 'ledger', 'stripe', 'web'])
    const never = await roObjectSearchPage(client, WS, { filter: { externalOnSomeDiagram: false }, limit: 50 })
    expect(never.items.map((row) => row.id).sort()).toEqual(['api', 'auth', 'customer', 'g1', 'shop'])
    // A group has no scope: its external count is always 0.
    expect(never.items.find((row) => row.id === 'g1')?.externalDiagramCount).toBe(0)
  })

  it('serves the same counts on tree pages', async () => {
    await coldBuildReadModel(client, WS, null, MODEL, [], [], [LANDSCAPE, SHOP_CONTAINERS])
    const roots = await roObjectTreeChildren(client, WS, { limit: 50 })
    const bank = roots.items.find((row) => row.id === 'bank')
    expect(bank).toMatchObject({ diagramCount: 2, externalDiagramCount: 1 })
  })
})
