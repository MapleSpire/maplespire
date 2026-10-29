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

import type { Notification, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { ensureSyncCellOwnershipSchema } from './ownership.js'
import { PlacementInvalidationListener } from './placementInvalidation.js'
import { readWorkspacePlacement, StoredPlacementResolver, WORKSPACE_PLACEMENT_CHANNEL } from './workspacePlacement.js'
import { workspacePartition } from './assignment.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('transactional placement invalidation with PostgreSQL', () => {
  let db: IsolatedSchemaDb
  let listener: PlacementInvalidationListener | undefined
  let audit: PoolClient | undefined
  const workspace = { landscapeId: 'placement-notify-land', versionId: 'placement-notify-version' }
  const h = workspacePartition(workspace, 2), k = 1 - h
  const resolver = new StoredPlacementResolver('placed')
  const notifications: Notification[] = []
  const failures: unknown[] = []
  let refresh = Promise.resolve()
  let refreshCount = 0

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(process.env.TEST_DATABASE_URL!, 'placement_notify')
    await db.pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, default_version_id TEXT);
      CREATE TABLE versions (id TEXT PRIMARY KEY, landscape_id TEXT NOT NULL REFERENCES landscapes(id), status TEXT NOT NULL DEFAULT 'active');
    `)
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query('INSERT INTO landscapes(id) VALUES ($1)', [workspace.landscapeId])
    await db.pool.query('INSERT INTO versions(id, landscape_id) VALUES ($1,$2)', [workspace.versionId, workspace.landscapeId])
    audit = await db.pool.connect()
    audit.on('error', error => failures.push(error))
    audit.on('notification', message => {
      // pg_notify channels are database-global. The production trigger names
      // its schema so this assertion cannot consume another CI suite's event.
      if (message.channel === WORKSPACE_PLACEMENT_CHANNEL && message.payload === db.schema) notifications.push(message)
    })
    await audit.query(`LISTEN ${WORKSPACE_PLACEMENT_CHANNEL}`)
    listener = new PlacementInvalidationListener(db.pool, () => {
      refresh = refresh.then(async () => {
        resolver.publish(await readWorkspacePlacement(db.pool, 'notification-generation', 2))
        refreshCount++
      }).catch(error => { failures.push(error) })
    }, error => failures.push(error))
    await listener.connect()
    await refresh
    expect(resolver.loaded).toBe(true)
    expect(resolver.partitionOf(workspace, 2)).toBe(h)
  })

  afterAll(async () => {
    await listener?.stop()
    await refresh
    audit?.release(true)
    await db?.teardown()
  })

  // The probe that established the 2026-10-22 flake: NOTIFY is database-wide,
  // so another suite's (or another tenant schema's) placement change reached
  // this schema's cells. Foreign events must not wake them; their own must.
  it('ignores placement notifications from another schema of the same database', async () => {
    const before = refreshCount
    for (let index = 0; index < 20; index += 1) {
      await db.pool.query(`SELECT pg_notify($1, $2)`, [WORKSPACE_PLACEMENT_CHANNEL, `${db.schema}_foreign`])
    }
    await new Promise(resolve => setTimeout(resolve, 150))
    await refresh
    expect(refreshCount).toBe(before)
    // ... while a notification naming this schema still refreshes it.
    await db.pool.query(`SELECT pg_notify($1, $2)`, [WORKSPACE_PLACEMENT_CHANNEL, db.schema])
    await vi.waitFor(() => expect(refreshCount).toBeGreaterThan(before), { timeout: 5000, interval: 20 })
    expect(failures).toEqual([])
    // Leave the shared audit log as the next test expects it: empty.
    await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(0), { timeout: 5000, interval: 20 })
    notifications.length = 0
  })

  it('wakes for committed insert/update/delete and cascades, never for rollback, then stops', async () => {
    const transaction = await db.pool.connect()
    try {
      await transaction.query('BEGIN')
      await transaction.query(
        'INSERT INTO workspace_placement(landscape_id,version_id,partition,topology_generation) VALUES ($1,$2,$3,$4)',
        [workspace.landscapeId, workspace.versionId, k, 'notification-generation'],
      )
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(notifications).toHaveLength(0)
      expect(resolver.partitionOf(workspace, 2)).toBe(h)
      await transaction.query('ROLLBACK')
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(notifications).toHaveLength(0)
    } finally {
      transaction.release(true)
    }
    const expectCommit = async (run: () => Promise<unknown>, partition: number) => {
      const before = notifications.length
      await run()
      await vi.waitFor(() => {
        expect(notifications.length).toBeGreaterThan(before)
        expect(resolver.partitionOf(workspace, 2)).toBe(partition)
      }, { timeout: 5000, interval: 20 })
      expect(failures).toEqual([])
    }
    const insert = () => db.pool.query(
      'INSERT INTO workspace_placement(landscape_id,version_id,partition,topology_generation) VALUES ($1,$2,$3,$4)',
      [workspace.landscapeId, workspace.versionId, k, 'notification-generation'],
    )
    await expectCommit(insert, k)
    await expectCommit(() => db.pool.query('UPDATE workspace_placement SET partition=$1', [h]), h)
    await expectCommit(() => db.pool.query('DELETE FROM workspace_placement'), h)
    await expectCommit(insert, k)
    await expectCommit(() => db.pool.query('DELETE FROM versions WHERE id=$1', [workspace.versionId]), h)
    expect((await db.pool.query('SELECT * FROM workspace_placement')).rows).toEqual([])

    await listener!.stop()
    await refresh
    const stoppedAt = refreshCount, before = notifications.length
    await db.pool.query('INSERT INTO versions(id,landscape_id) VALUES ($1,$2)', [workspace.versionId, workspace.landscapeId])
    await insert()
    await vi.waitFor(() => expect(notifications.length).toBeGreaterThan(before), { timeout: 5000, interval: 20 })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(refreshCount).toBe(stoppedAt)
    expect(resolver.partitionOf(workspace, 2)).toBe(h)
    expect(failures).toEqual([])
  })
})
