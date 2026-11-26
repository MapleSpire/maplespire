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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { epochMetaDocumentIds } from './epochHopTelemetry.js'
import { ensureReadModelSchema } from './schema.js'

/**
 * G4-16j: the meta lookup of a latch ask, on PostgreSQL. A wrong column or
 * cast would throw something other than 42P01 and every latch ask would be
 * a lookup failure — the stalled-hop gauge blind for ever, its unit tests
 * green (they run on a fake). Isolated schema, TEST_DATABASE_URL; skips
 * without a database.
 */
const connection = process.env.TEST_DATABASE_URL
const suite = describe.skipIf(!connection)
let db: IsolatedSchemaDb

suite('epochMetaDocumentIds on PostgreSQL', () => {
  beforeAll(async () => {
    db = await createIsolatedSchemaDb(connection!, 'epoch_hop_telemetry')
    await ensureReadModelSchema(db.pool)
    const rows: Array<[string, string, string, number, string, number | null]> = [
      ['meta-old', 'L', 'V', 0, 'meta', 1],
      ['meta-cur', 'L', 'V', 1, 'meta', null],
      ['base-1', 'L', 'V', 1, 'base', null],
      ['meta-other', 'L2', 'V', 0, 'meta', null],
    ]
    for (const [id, landscape, version, created, role, superseded] of rows) {
      await db.pool.query(
        `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, superseded_epoch)
         VALUES ($1, $2, $3, $4, $5, $6)`, [id, landscape, version, created, role, superseded])
    }
  })
  afterAll(async () => { await db?.teardown() })

  it('names the workspace\'s metas among the asked ids, superseded or not; never a base shard or another workspace\'s', async () => {
    expect(await epochMetaDocumentIds(db.pool, { landscapeId: 'L', versionId: 'V' },
      ['meta-old', 'meta-cur', 'base-1', 'meta-other', 'unknown'])).toEqual(new Set(['meta-old', 'meta-cur']))
  })

  it('a schema without the epoch tables reads as no meta', async () => {
    const bare = await createIsolatedSchemaDb(connection!, 'epoch_hop_telemetry_bare')
    try {
      expect(await epochMetaDocumentIds(bare.pool, { landscapeId: 'L', versionId: 'V' }, ['meta-old'])).toEqual(new Set())
    } finally {
      await bare.teardown()
    }
  })
})
