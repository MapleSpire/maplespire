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
 * THE WIRE. `runColdApiChecks` has unit cover through a fake `fetchImpl`,
 * `serverEntrypoint` has its own, and `drillRunner.test.ts` passes
 * `coldApi: false` — so this file is what boots a real server against a real
 * database and asks it the drill's four questions.
 *
 * What it pins is WHY a workspace is not servable. Without the `reason` field,
 * all six outcomes of `ProjectorFleet.ensure()` look like one
 * `{"error":"read model warming up","retryable":true}` with nothing logged,
 * and the drill's only possible verdict is "gave up after the deadline".
 *
 * The arm is a workspace that HAS `ro_objects` rows and NO resolvable root —
 * `ensure()` resolves false, for ever. The control is in the same run and the
 * same process: `/api/ready` answers 200 and `health` passes, which is
 * precisely the pair that makes such a failure read as a transient race. A
 * test that only asserted the failure could not tell "this workspace is
 * unservable" from "the cold server never came up".
 *
 * This file pins the failure classification. The healthy Automerge tree,
 * orphan selection and sparse static baseline have real-server coverage in
 * coldApi.selection.integration.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createTemporaryRestoreDatabase } from './backupRestore.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'
import { deriveColdApiExpectation, runColdApiChecks } from './coldApi.js'
import { startColdServer, type ColdServerHandle } from './coldServer.js'

const TEST_DATABASE_URL = process.env.BACKUP_RESTORE_TEST_DATABASE_URL
const SERVER_ROOT = process.cwd()

/** A workspace id that sorts before `default`, so the drill's own
 * `ORDER BY count(*) DESC, landscape_id` selection lands on it rather than on
 * whatever the boot registered. */
const LANDSCAPE = 'aaa-cold-api-unservable'
const VERSION = 'aaa-cold-api-unservable-main'

describe.skipIf(!TEST_DATABASE_URL)('cold API against a real server', () => {
  let target: Awaited<ReturnType<typeof createTemporaryRestoreDatabase>>
  let assets: string

  beforeAll(async () => {
    target = await createTemporaryRestoreDatabase(TEST_DATABASE_URL!)
    assets = await mkdtemp(join(tmpdir(), 'maplespire-cold-api-'))
    // Booting is what runs the migrations, exactly as it does for the drill's
    // freshly restored database. Stopped again immediately: the arm below has
    // to be set up while nothing holds a projector.
    const schema = await startColdServer({
      databaseUrl: target.url,
      serverRoot: SERVER_ROOT,
      assetDirectory: assets,
      bootTimeoutMs: 180_000,
    })
    await schema.stop()

    const pool = guardIdleClientErrors(new Pool({ connectionString: target.url, max: 1 }), 'coldApi:setup')
    try {
      await pool.query(
        `INSERT INTO landscapes (id, name, default_version_id) VALUES ($1, $2, $3)`,
        [LANDSCAPE, 'Unservable', VERSION],
      )
      // The whole arm is this empty string: `resolveRootUrl` returns it for an
      // EXPLICIT reference, `ProjectorFleet.start` sees a falsy root and
      // returns false, and `ensure()` therefore RESOLVES rather than throwing —
      // which is why nothing was ever logged.
      await pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $3, '')`,
        [VERSION, LANDSCAPE, 'Main'],
      )
      // Rows the drill's expectation reads. They are what makes this workspace
      // look like the busiest one in a restore, and no projector ever wrote
      // them — which is the situation a restored database is always in.
      await pool.query(
        `INSERT INTO ro_objects (landscape_id, version_id, id, type, name, data)
         SELECT $1, $2, 'obj-' || g, 'system', 'Object ' || g, '{}'::jsonb
         FROM generate_series(1, 3) AS g`,
        [LANDSCAPE, VERSION],
      )
      // A connection whose `from_id` is one of those objects, so
      // `deriveColdApiExpectation` yields a `dependencyFocusId` and the
      // Dependencies page is actually REQUESTED. Without it that check short-
      // circuits to `ok: true, 'no connected object in the restore'` and the
      // arm silently covers three endpoints instead of four — the demo's
      // report had all four failing, so a fixture that cannot reach the fourth
      // is not the fixture for it.
      await pool.query(
        `INSERT INTO ro_connections (landscape_id, version_id, id, from_id, to_id, data)
         VALUES ($1, $2, 'conn-1', 'obj-1', 'obj-2', '{}'::jsonb)`,
        [LANDSCAPE, VERSION],
      )
    } finally {
      await pool.end()
    }
  }, 240_000)

  afterAll(async () => {
    await target?.drop()
    if (assets) await rm(assets, { recursive: true, force: true })
  }, 120_000)

  it('names WHY the workspace is not servable instead of implying it is still warming', async () => {
    const pool = guardIdleClientErrors(new Pool({ connectionString: target.url, max: 2 }), 'coldApi:expectation')
    let expectation
    try {
      expectation = await deriveColdApiExpectation(pool)
    } finally {
      await pool.end()
    }
    // The selection has to have landed on the unservable workspace, or every
    // assertion below is about something else and passes vacuously.
    // `dependencyFocusId` is asserted too: it is what decides whether the
    // Dependencies check issues a request at all.
    expect(expectation?.workspace).toMatchObject({
      landscapeId: LANDSCAPE,
      versionId: VERSION,
      objects: 3,
      connections: 1,
      dependencyFocusId: 'obj-1',
    })

    let server: ColdServerHandle | undefined
    try {
      server = await startColdServer({
        databaseUrl: target.url,
        serverRoot: SERVER_ROOT,
        assetDirectory: assets,
        bootTimeoutMs: 180_000,
      })
      // A LITERAL, not a fraction of the production ceiling: a bound derived
      // from the constant under test agrees with any value that constant is
      // given. This workspace can never become resident, so the only thing the
      // number buys is how long the give-up takes.
      const outcome = await runColdApiChecks({
        baseUrl: server.baseUrl,
        expectation,
        deadlineMs: 8_000,
      })
      const byName = new Map(outcome.checks.map((check) => [check.name, check]))

      // CONTROL, in the same process and the same run: the server is up and
      // its readiness gate is satisfied. `readiness.readModel` is set after the
      // DEFAULT workspace's cold build, so it says nothing about this one —
      // and that pairing is exactly what made the demo report read as a race.
      expect(byName.get('health')?.ok).toBe(true)
      expect(byName.get('ready')?.ok).toBe(true)

      // ...and the four read-model pages fail, each NAMING the cause.
      expect(outcome.outcome).toBe('failed')
      for (const name of ['model-objects', 'model-connections', 'dependencies', 'diagram-list']) {
        const check = byName.get(name)
        expect(check, `${name} was not attempted`).toBeDefined()
        expect(check!.ok, `${name} unexpectedly passed`).toBe(false)
        expect(check!.detail).toContain('503')
        // The FIELD NAME, not just the value: a bare value match would still
        // pass if the field were renamed, so it could not tell a contract from
        // a coincidence.
        expect(check!.detail).toContain('"reason":"workspace_root_unresolved"')
      }

      // The server log has to carry it too — the report is signed and archived,
      // but an operator reads the container log first.
      //
      // ONCE, counted, not merely present. `runColdApiChecks` polls this path
      // once a second for the whole deadline, so "the line exists" is satisfied
      // by a regression that logs it on every request — which is the exact
      // spam the four expected outcomes are silenced to avoid. (The phrase
      // carries the workspace, the verb and the reason in order, so a renamed
      // field cannot satisfy it either.)
      const line = `${LANDSCAPE}/${VERSION} is not resident: workspace_root_unresolved`
      expect(server.output().split(line).length - 1).toBe(1)
    } finally {
      await server?.stop()
    }
  }, 240_000)
})
