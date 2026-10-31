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
 * THE ROUTES at `AUTH=on`, on a real server (`startColdServer`, tsx, its own
 * temporary database), signed in through dev login.
 *
 * 1. THE SET-DEFAULT RACE, STAGED OVER HTTP. The three routes canonicalise
 *    `current`, check access on the canonical key, then read a root. At stage
 *    on the check reads the session's workspace key sets, which join `scopes`
 *    — a table neither the session validator nor the canonicalisation reads.
 *    So an ACCESS EXCLUSIVE lock on `scopes` parks the request INSIDE the
 *    access check, after the canonicalisation; `pg_stat_activity` says when it
 *    is parked there, the landscape's default moves to V2, and the lock is
 *    released. A route that read `current` again would answer about V2.
 * 2. THE NO-PARAMS FALLBACK, ENFORCED. A signed-in user with no access to the
 *    default landscape gets 403 from `/api/automerge/root` with no params; with
 *    the registry unreadable the route used to skip the check and hand them
 *    the primary root with a 200.
 * 3. A FAILED REGISTRY READ is the shared 503, not a 404 "unknown workspace".
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
/** How long a staged request may take to park inside the access check. */
const PARK_TIMEOUT_MS = 20_000
/** Above the park wait, so a request that never parks fails with ITS message
 * and the test's `finally` (lock released, default restored) runs inside it. */
const RACE_TIMEOUT_MS = 90_000

describe.skipIf(!TEST_DATABASE_URL)('workspace root routes on a real server, AUTH=on', () => {
  let target: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let assets: string
  let server: ColdServerHandle | undefined
  let pool: Pool
  let cookie = ''
  let landscapeId: string
  let v1: { id: string; rootUrl: string }
  let v2: { id: string; rootUrl: string }
  let diagramId: string
  let bumps = 0

  async function call(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(`${server!.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        cookie,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const json = (res.headers.get('content-type') ?? '').includes('json')
    const body = (json ? await res.json().catch(() => ({})) : {}) as Record<string, unknown>
    return { status: res.status, json, body, text: JSON.stringify(body) }
  }

  async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 120_000): Promise<T> {
    const deadline = Date.now() + ms
    for (;;) {
      const value = await probe().catch(() => undefined)
      if (value !== undefined) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((done) => setTimeout(done, 250))
    }
  }

  const ref = (versionId: string) => `landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`

  beforeAll(async () => {
    target = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    assets = await mkdtemp(join(tmpdir(), 'maplespire-root-routes-auth-'))
    server = await startColdServer({
      databaseUrl: target.url,
      serverRoot: process.cwd(),
      assetDirectory: assets,
      bootTimeoutMs: 180_000,
      env: {
        AUTH: 'on',
        AUTH_SECRET: 'root-routes-integration-secret',
        AUTH_DEV_LOGIN: 'on',
        READ_MODEL: 'off',
        // The staged request waits inside the key-set read for as long as the
        // lock is held; the default 5 s ceiling would turn a slow poll into a
        // rejection instead of a measurement.
        DOC_SCOPE_KEY_SETS_DEADLINE_MS: '60000',
      },
    })
    pool = guardIdleClientErrors(new Pool({ connectionString: target.url, max: 4 }), 'rootRoutesAuth')

    // Dev login provisions a personal org whose landscape has a starter
    // diagram: V1 lists a diagram, and the empty V2 created below does not.
    cookie = await until('dev login', async () => {
      const res = await fetch(`${server!.baseUrl}/api/auth/dev-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'root-routes@example.test' }),
      })
      if (res.status !== 200) return undefined
      return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    })
    const landscape = await until('the provisioned landscape', async () => {
      const res = await call('/api/landscapes')
      const list = (res.body.landscapes ?? []) as Array<{ id: string; defaultVersionId: string; versions: Array<{ id: string; rootUrl: string }> }>
      return res.status === 200 && list.length === 1 ? list[0] : undefined
    })
    landscapeId = landscape.id
    v1 = landscape.versions.find((v) => v.id === landscape.defaultVersionId)!
    // The automerge routes are registered by main(), after the auth routes.
    await until('the automerge routes', async () => {
      const res = await call(`/api/automerge/root?${ref('current')}`)
      return res.status === 200 && res.json ? true : undefined
    })
    const created = await call(`/api/landscapes/${encodeURIComponent(landscapeId)}/versions`, { method: 'POST', body: { label: 'two' } })
    expect(created.status).toBe(200)
    v2 = (created.body as { version: { id: string; rootUrl: string } }).version
    const listed = await call('/api/ai/tools/list_diagrams', { method: 'POST', body: { landscapeId, versionId: v1.id, input: {} } })
    expect(listed.status).toBe(200)
    const diagrams = (listed.body as { result: { diagrams: Array<{ id: string }> } }).result.diagrams
    expect(diagrams.length).toBeGreaterThan(0)
    diagramId = diagrams[0].id
  }, 300_000)

  afterAll(async () => {
    await server?.stop()
    await pool?.end()
    await target?.drop()
    if (assets) await rm(assets, { recursive: true, force: true })
  }, 120_000)

  async function setDefault(versionId: string) {
    await pool.query('UPDATE landscapes SET default_version_id = $2 WHERE id = $1', [landscapeId, versionId])
  }

  /**
   * Run `request` with it parked inside the access check, and `meanwhile`
   * while it is parked there. Creating a version first drops this process's
   * cached key sets (`notifyWorkspaceCreated`), so the check reads them anew —
   * from `scopes`, which is locked.
   */
  async function duringAccessCheck<T>(request: () => Promise<T>, meanwhile: () => Promise<void>): Promise<T> {
    bumps += 1
    const bump = await call(`/api/landscapes/${encodeURIComponent(landscapeId)}/versions`, { method: 'POST', body: { label: `bump-${bumps}` } })
    expect(bump.status).toBe(200)
    const lock = await pool.connect()
    let pending: Promise<T> | undefined
    try {
      await lock.query('BEGIN')
      await lock.query('LOCK TABLE scopes IN ACCESS EXCLUSIVE MODE')
      pending = request()
      pending.catch(() => {})
      await until('the request to park in the key-set read', async () => {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query LIKE '%JOIN scopes s ON s.kind = ''version''%'`,
        )
        return rows[0].n > 0 ? true : undefined
      }, PARK_TIMEOUT_MS)
      await meanwhile()
    } finally {
      // A client whose ROLLBACK failed may still hold the lock: discard it
      // rather than hand it back to the pool.
      const rolledBack = await lock.query('ROLLBACK').then(() => true, () => false)
      lock.release(!rolledBack)
    }
    return await pending!
  }

  async function withTableAway<T>(table: 'landscapes' | 'versions', run: () => Promise<T>): Promise<T> {
    await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_away`)
    try {
      return await run()
    } finally {
      await pool.query(`ALTER TABLE ${table}_away RENAME TO ${table}`)
    }
  }

  it('control: the two versions answer differently, so a route that read the wrong one shows it', async () => {
    expect(v2.rootUrl).not.toBe(v1.rootUrl)
    expect(await call(`/api/automerge/registry-diagram?${ref('current')}&id=${diagramId}`)).toMatchObject({ status: 200, body: { present: true } })
    expect(await call(`/api/automerge/registry-diagram?${ref(v2.id)}&id=${diagramId}`)).toMatchObject({ status: 200, body: { present: false } })
    expect((await call(`/api/automerge/doc-heads?${ref('current')}&id=${diagramId}`)).status).toBe(200)
    expect((await call(`/api/automerge/doc-heads?${ref(v2.id)}&id=${diagramId}`)).status).toBe(404)
  })

  it('a set-default while registry-diagram checks access: it answers for the checked version', async () => {
    try {
      const answer = await duringAccessCheck(
        () => call(`/api/automerge/registry-diagram?${ref('current')}&id=${diagramId}`),
        () => setDefault(v2.id),
      )
      // V2's registry does not list the diagram: `present: false` would be
      // the answer read from the version the default moved to.
      expect(answer).toMatchObject({ status: 200, body: { present: true } })
      // Control: the alias really moved while the request was parked.
      expect(await call(`/api/automerge/registry-diagram?${ref('current')}&id=${diagramId}`)).toMatchObject({ body: { present: false } })
    } finally {
      await setDefault(v1.id)
    }
  }, RACE_TIMEOUT_MS)

  it('a set-default while doc-heads checks access: it answers for the checked version', async () => {
    try {
      const answer = await duringAccessCheck(
        () => call(`/api/automerge/doc-heads?${ref('current')}&id=${diagramId}`),
        () => setDefault(v2.id),
      )
      expect(answer.status).toBe(200)
      expect(Array.isArray(answer.body.heads)).toBe(true)
    } finally {
      await setDefault(v1.id)
    }
  }, RACE_TIMEOUT_MS)

  it('a set-default while /root checks access: the checked version\'s root, beside its key', async () => {
    try {
      const answer = await duringAccessCheck(
        () => call(`/api/automerge/root?${ref('current')}`),
        () => setDefault(v2.id),
      )
      expect(answer).toMatchObject({ status: 200, body: { url: v1.rootUrl, landscapeId, versionId: v1.id } })
    } finally {
      await setDefault(v1.id)
    }
  }, RACE_TIMEOUT_MS)

  it('no params, no access to the default landscape: a 403 healthy, a 503 — never the primary root — when the registry cannot be read', async () => {
    const { rows } = await pool.query<{ root_url: string }>(
      `SELECT v.root_url FROM landscapes l JOIN versions v ON v.id = l.default_version_id WHERE l.id = 'default'`,
    )
    const primaryRoot = rows[0].root_url
    expect(primaryRoot).toMatch(/^automerge:/)
    expect((await call('/api/automerge/root')).status).toBe(403)
    const unreadable = await withTableAway('landscapes', () => call('/api/automerge/root'))
    // `/root`'s own answer to a failed resolution, not some other 503.
    expect(unreadable).toMatchObject({ status: 503, body: { error: 'workspace root is temporarily unavailable', retryable: true } })
    expect(unreadable.body).not.toHaveProperty('url')
    expect(unreadable.text).not.toContain(primaryRoot)
  })

  it('a failed registry read is the shared 503 on the probes, not "unknown workspace"', async () => {
    const [registry, heads] = await withTableAway('landscapes', async () => [
      await call(`/api/automerge/registry-diagram?${ref('current')}&id=${diagramId}`),
      await call(`/api/automerge/doc-heads?${ref('current')}&id=${diagramId}`),
    ])
    expect(registry).toMatchObject({ status: 503, body: { code: 'workspace-registry-unavailable' } })
    expect(heads).toMatchObject({ status: 503, body: { code: 'workspace-registry-unavailable' } })
  })
})
