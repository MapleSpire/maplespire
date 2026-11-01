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
 * THE ROUTES, on a real server. `index.ts` cannot be imported by a test, but
 * `startColdServer` boots it (tsx, its own temporary database), so the three
 * routes that disclose or read a workspace root are asked over HTTP while a
 * registry table is renamed away under them — a real failed read.
 *
 * Both defects this pins answered 200 on the unpatched source, measured with
 * this harness: an explicit `/api/automerge/root` for landscape X handed back
 * the DEFAULT landscape's primary root (which the client then caches as X's
 * root), and `/registry-diagram` + `/doc-heads` answered from that same
 * primary root. The set-default race between the access check and the root
 * read cannot be staged over HTTP; `landscapes.repoint.integration.test.ts`
 * drives that composition, and `workspaceRootRouteWiring.test.ts` pins the
 * call sites this run cannot tell apart (READ_MODEL off, AUTH off).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createTemporaryRestoreDatabase } from './backup/backupRestore.js'
import { startColdServer, type ColdServerHandle } from './backup/coldServer.js'
import { guardIdleClientErrors } from './db/poolErrorGuard.js'

const TEST_DATABASE_URL = process.env.BACKUP_RESTORE_TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('workspace root routes on a real server', () => {
  let target: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let assets: string
  let server: ColdServerHandle | undefined
  let pool: Pool
  let primaryRoot: string
  let x: { landscapeId: string; versionId: string; rootUrl: string }

  beforeAll(async () => {
    target = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    assets = await mkdtemp(join(tmpdir(), 'maplespire-root-routes-'))
    // READ_MODEL off: doc-heads takes its registry branch, the one that reads a root.
    server = await startColdServer({
      databaseUrl: target.url,
      serverRoot: process.cwd(),
      assetDirectory: assets,
      bootTimeoutMs: 180_000,
      env: { READ_MODEL: 'off' },
    })
    pool = guardIdleClientErrors(new Pool({ connectionString: target.url, max: 2 }), 'rootRoutes')
    // `/api/health` answers before `main()` registers the automerge routes
    // (the SPA fallback answers HTML until then), so wait on the route itself.
    const deadline = Date.now() + 120_000
    for (;;) {
      const res = await fetch(`${server.baseUrl}/api/automerge/root`)
      if (res.status === 200 && (res.headers.get('content-type') ?? '').includes('json')) {
        primaryRoot = ((await res.json()) as { url: string }).url
        break
      }
      if (Date.now() > deadline) throw new Error(`the root route never came up: ${res.status}`)
      await new Promise((done) => setTimeout(done, 250))
    }
    const created = await fetch(`${server.baseUrl}/api/landscapes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Landscape X' }),
    })
    expect(created.status).toBe(200)
    const { landscape } = (await created.json()) as {
      landscape: { id: string; defaultVersionId: string; versions: Array<{ id: string; rootUrl: string }> }
    }
    const main = landscape.versions.find((v) => v.id === landscape.defaultVersionId)!
    x = { landscapeId: landscape.id, versionId: main.id, rootUrl: main.rootUrl }
  }, 300_000)

  afterAll(async () => {
    await server?.stop()
    await pool?.end()
    await target?.drop()
    if (assets) await rm(assets, { recursive: true, force: true })
  }, 120_000)

  async function get(path: string): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
    const res = await fetch(`${server!.baseUrl}${path}`)
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body }
  }

  /** A real failed read: the table the lookup needs is not there. */
  async function withTableAway<T>(table: 'landscapes' | 'versions', run: () => Promise<T>): Promise<T> {
    await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_away`)
    try {
      return await run()
    } finally {
      await pool.query(`ALTER TABLE ${table}_away RENAME TO ${table}`)
    }
  }

  const xCurrent = () => `landscapeId=${encodeURIComponent(x.landscapeId)}&versionId=current`

  it('control: each ref answers its own root, beside its own key', async () => {
    expect(primaryRoot).toMatch(/^automerge:/)
    expect(x.rootUrl).not.toBe(primaryRoot)
    expect(await get(`/api/automerge/root?${xCurrent()}`)).toMatchObject({
      status: 200,
      body: { url: x.rootUrl, landscapeId: x.landscapeId, versionId: x.versionId },
    })
    expect(await get('/api/automerge/root')).toMatchObject({ status: 200, body: { url: primaryRoot, landscapeId: 'default' } })
    expect((await get('/api/automerge/root?landscapeId=L_nope&versionId=current')).status).toBe(404)
    // `?landscapeId=` names the landscape '' on both reads: a miss, not a 503.
    expect((await get('/api/automerge/root?landscapeId=')).status).toBe(404)
    expect(await get(`/api/automerge/registry-diagram?${xCurrent()}&id=no-such-diagram`))
      .toMatchObject({ status: 200, body: { present: false } })
  })

  it('a read failing AFTER the canonicalisation: X gets a retryable 503, never the default root', async () => {
    const [explicit, noParams] = await withTableAway('versions', async () => [
      await get(`/api/automerge/root?${xCurrent()}`),
      await get('/api/automerge/root'),
    ])
    expect(explicit).toMatchObject({ status: 503, retryAfter: '1', body: { retryable: true } })
    expect(JSON.stringify(explicit.body)).not.toContain(primaryRoot)
    // The no-params call keeps its bootable fallback, and reports no key beside it.
    expect(noParams).toMatchObject({ status: 200, body: { url: primaryRoot, landscapeId: null, versionId: null } })
  })

  it('a read failing DURING the canonicalisation: still a 503 for X, still the fallback for no params', async () => {
    const [explicit, noParams] = await withTableAway('landscapes', async () => [
      await get(`/api/automerge/root?${xCurrent()}`),
      await get('/api/automerge/root'),
    ])
    expect(explicit).toMatchObject({ status: 503, body: { retryable: true } })
    expect(noParams).toMatchObject({ status: 200, body: { url: primaryRoot, landscapeId: null, versionId: null } })
  })

  it('a registry that cannot be read is the shared 503 — never a 404 "unknown workspace"', async () => {
    const [registry, heads, model] = await withTableAway('landscapes', async () => [
      await get(`/api/automerge/registry-diagram?${xCurrent()}&id=no-such-diagram`),
      await get(`/api/automerge/doc-heads?${xCurrent()}&id=no-such-diagram`),
      // A `route()`-wrapped model route, registered whatever READ_MODEL says,
      // that canonicalises first.
      await get(`/api/model/decision-records/page?${xCurrent()}`),
    ])
    for (const answer of [registry, heads, model]) {
      expect(answer).toMatchObject({ status: 503, retryAfter: '1', body: { code: 'workspace-registry-unavailable' } })
    }
  })

  it('registry-diagram and doc-heads do not answer for X from the default root', async () => {
    const [registry, heads] = await withTableAway('versions', async () => [
      await get(`/api/automerge/registry-diagram?${xCurrent()}&id=no-such-diagram`),
      await get(`/api/automerge/doc-heads?${xCurrent()}&id=no-such-diagram`),
    ])
    // A failure, not an answer: 200 `present:false` and 404 "diagram not found"
    // were both read from the primary root.
    expect(registry.status).toBe(500)
    expect(heads.status).toBe(500)
  })
})
