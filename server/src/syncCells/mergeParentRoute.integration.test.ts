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
 * THE PARENT READ, AGAINST A REAL POSTGRES.
 *
 * ## Why this file exists at all, and why it is DB-gated rather than faked
 *
 * Every middleware arm passes its own `resolveMergeParent`, so the real
 * statement is reachable by nothing else: wrong table, `$1`/`$2` swapped or
 * `kind = 'draft'` dropped would all go unnoticed.
 *
 * A fake pool cannot help. It can only check that the module sends the
 * string the test already expects, which is the same assertion written twice.
 * So this suite runs the statement against Postgres, with rows shaped like the
 * real schema (the `versions` table in `src/db.ts`), and those three mutations
 * are the arms below.
 *
 * Per-suite isolated schema: TEST_DATABASE_URL usually points at a
 * database shared with a live dev stack, and a suite that wrote `versions`
 * rows in `public` would be writing somebody's landscape.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveMergeParentWorkspace } from './workspaceRoute.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('the draft-merge parent read (live Postgres)', () => {
  let db: import('../testing/isolatedSchema.js').IsolatedSchemaDb

  beforeAll(async () => {
    const { createIsolatedSchemaDb } = await import('../testing/isolatedSchema.js')
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'merge_parent_route')

    // The columns the statement reads, in the shape `src/db.ts` builds them:
    // `parent_version_id` nullable, `kind` and `status` defaulted. The FK on
    // landscapes is kept because the "same draft id in another landscape" arm
    // needs two landscapes to exist for the rows to be insertable at all.
    await db.pool.query(`CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
    await db.pool.query(`
      CREATE TABLE versions (
        id                TEXT PRIMARY KEY,
        landscape_id      TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        root_url          TEXT NOT NULL,
        parent_version_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'version',
        status            TEXT NOT NULL DEFAULT 'active'
      )
    `)
  }, 60_000)

  afterAll(async () => {
    await db?.teardown()
  })

  beforeEach(async () => {
    await db.pool.query('DELETE FROM versions')
    await db.pool.query('DELETE FROM landscapes')
    await db.pool.query(`INSERT INTO landscapes (id, name) VALUES ('L-1', 'One'), ('L-2', 'Two')`)
    await db.pool.query(`
      INSERT INTO versions (id, landscape_id, label, root_url, parent_version_id, kind, status) VALUES
        ('V-parent', 'L-1', 'live',       'automerge:p', NULL,       'version', 'active'),
        ('D-1',      'L-1', 'draft one',  'automerge:d', 'V-parent', 'draft',   'active'),
        ('D-merged', 'L-1', 'done',       'automerge:m', 'V-parent', 'draft',   'merged'),
        ('D-orphan', 'L-1', 'no parent',  'automerge:o', NULL,       'draft',   'active'),
        ('V-plain',  'L-1', 'not a draft','automerge:v', 'V-parent', 'version', 'active'),
        -- versions.id is the PRIMARY KEY, so the twin in the OTHER landscape
        -- cannot reuse D-1. It carries its own id, and the landscape argument
        -- is what has to separate them — which is what the $1/$2 mutant attacks.
        ('D-2',      'L-2', 'other one',  'automerge:y', 'V-other',  'draft',   'active')
    `)
  })

  const parent = { kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-parent' } }

  it('resolves a draft to its PARENT version — the workspace the merge writes', async () => {
    // The baseline. Without it every "does not place" arm below is equally
    // satisfied by a statement that places nothing at all.
    await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'D-1')).resolves.toEqual(parent)
  })

  it('resolves a MERGED draft too — a retry must reach the same owner as the first attempt', async () => {
    // NOT filtered on the draft's status, deliberately. `applyMerge` answers
    // HTTP 200 with an empty `versionId` when the draft is already `merged`,
    // so a retry is a legitimate request that still has to run on the parent's
    // owner. A `status = 'active'` filter here would place nothing, the router
    // would hand the request back to Express, and the retry would execute on
    // the landing cell — an unrouted write produced by the code that exists to
    // remove unrouted writes.
    await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'D-merged')).resolves.toEqual(parent)
  })

  it('a version that is NOT a draft is unplaceable — and that is not the same as absent', async () => {
    // Filtering `kind = 'draft'` in SQL would answer `no-such-draft` here.
    // That answer is a PASS-THROUGH, and the pass-through is unsafe for
    // this row specifically: `resolveRootUrl` (`landscapes.ts`) has no `kind`
    // filter, so `V-plain` resolves to a real root, `index.ts`'s
    // `if (candidate)` is TRUE, and `ensureCanonicalWorkspaceRoot` can rotate
    // an ordinary version's root on a cell the router never checked — on its
    // way to a 404.
    await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'V-plain')).resolves.toEqual({
      kind: 'unplaceable', reason: 'not-a-draft',
    })
  })

  it('MUTANT — swapping $1 and $2 would resolve the landscape as the draft', async () => {
    // With the parameters transposed the statement asks for a version whose id
    // is `L-1` inside landscape `D-1`. The arm that kills the mutant is the
    // BASELINE above: on a swapped statement `('L-1', 'D-1')` finds nothing
    // and it goes red. These two pin the other direction — a draft id that
    // belongs to a DIFFERENT landscape must not resolve, in either order.
    await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'D-2')).resolves.toEqual({ kind: 'no-such-draft' })
    await expect(resolveMergeParentWorkspace(db.pool, 'L-2', 'D-1')).resolves.toEqual({ kind: 'no-such-draft' })
  })

  it('a draft with a NULL parent is unplaceable, never a half key', async () => {
    // `parent_version_id` is nullable. A key carrying an empty versionId would
    // be routed confidently to whatever partition the empty string hashes
    // into; `unplaceable` makes the router answer 404, which is where
    // `applyMerge` was going to end up anyway.
    await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'D-orphan')).resolves.toEqual({
      kind: 'unplaceable', reason: 'no-parent',
    })
  })

  it('an unknown draft is the ONE miss that is safe to hand back to Express', async () => {
    await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'nope')).resolves.toEqual({ kind: 'no-such-draft' })
  })

  it('a database failure REJECTS — it is never swallowed into a miss that reads as "no such draft"', async () => {
    // The "wrong table" mutation. Written as an assertion
    // about a return value it is unkillable — a statement against the wrong
    // table throws, and the two outcomes are only distinguishable if the
    // function is honest about the throw. So the arm asserts the property that
    // makes the mutant fatal instead of the mutant itself.
    //
    // This matters more than it looks. `no-such-draft` is the answer the router
    // handles by handing the request back to Express — i.e. by running the
    // merge on the LANDING cell. A `catch` returning it would convert every
    // database blip into a silent unrouted write.
    await db.pool.query('ALTER TABLE versions RENAME TO versions_hidden')
    try {
      await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'D-1')).rejects.toThrow(/versions/)
    } finally {
      await db.pool.query('ALTER TABLE versions_hidden RENAME TO versions')
    }
    // …and the table really is back, so a failure here cannot silently thin
    // every arm that runs after it.
    await expect(resolveMergeParentWorkspace(db.pool, 'L-1', 'D-1')).resolves.toEqual(parent)
  })
})
