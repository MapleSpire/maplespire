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
 * THE FENCE OVER A DOCUMENT THAT HAS NO DURABLE ROW YET.
 *
 * `withFencedMutation` derives the workspace to check a lease against from
 * `automerge_document_workspace`. A freshly created document has no row yet,
 * so without another source nobody could be checked and the mutation — even a
 * `removeRange` deleting every chunk — would be admitted unconditionally. The
 * route gate names the placement it admitted on the MAC before its unawaited
 * claim writes it down, and the fence uses that when the durable row is absent.
 *
 * WHAT THIS FILE HAS TO PROVE, and why each half alone is worthless:
 *
 *   - a leaseless cell is REFUSED (the fix has teeth), AND
 *   - a leased cell still writes (the fix did not close the import path it
 *     exists to serve), AND
 *   - a document nobody placed still writes (server-created documents — fork
 *     roots, projector documents — reach their first save with no gate having
 *     ever seen them), AND
 *   - a durable row is never OVERRIDDEN by a provisional one.
 *
 * The first without the second loses the documents it guards; the second
 * without the first is an unfenced write. Every test here is conjunctive.
 *
 * TWO WORKSPACES, NOT ONE, and that is the file's most load-bearing fixture
 * decision: with one workspace, dropping `ownership.landscape_id = $5 AND
 * ownership.version_id = $6` from the fence would go unnoticed. Fencing
 * tokens are PER-WORKSPACE Redis sequences, so
 * sibling versions routinely hold the same small integer; with one workspace in
 * the fixture, "does this cell hold THIS workspace's lease" and "does anybody
 * hold a lease numbered 7" are the same question.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import type { StorageKey } from '@automerge/automerge-repo'
import { PostgresStorageAdapter, StaleSyncCellWriteError } from './automergeStorage.js'
import { ensureSyncCellOwnershipSchema } from './syncCells/ownership.js'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from './testing/isolatedSchema.js'
import { WorkspaceDocIndex, type WorkspaceKey } from './rbac/docScope.js'
import { installProvisionalPlacementSource } from './rbac/provisionalPlacementSource.js'
import { queryOnlyPool } from './testing/queryOnlyPool.js'
import {
  bootstrapPlacementFor,
  noteBootstrapPlacement,
  noteServerCreationPlacement,
  purgeServerCreationPlacement,
  resetServerCreationPlacementForTest,
} from './rbac/serverCreationPlacement.js'
import { claimWorkspaceDocuments } from './rbac/documentClaims.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

/**
 * GENERATED, never hand-written, and that is not tidiness.
 *
 * `withFencedMutation` opens with `if (!documentId || !ownership) return
 * executeUnfencedMutation(...)`, and `documentIdFromKey` answers null for a key
 * whose first element is not a decodable document id. So a made-up id sends the
 * WHOLE mutation down the unfenced path — no lease check, no counters, and the
 * write still succeeds — a test would be green on every fence question
 * because the fence was never reached.
 *
 * Same family as `NEVER_READY_URL` in `docScope.gateLiveness.test.ts`, which
 * carries the same warning for `isValidAutomergeUrl`.
 */
async function freshDocumentId(): Promise<string> {
  return String((await new Repo({}).create2({})).documentId)
}

/** MAPPED — has an `automerge_document_workspace` row from the start. */
const MAPPED_DOCUMENT = await freshDocumentId()
/** UNMAPPED — the shape under test: admitted on the mint, row still in flight. */
const UNMAPPED_DOCUMENT = await freshDocumentId()
/** UNMAPPED and unplaced — nothing ever named a workspace for it. */
const ORPHAN_DOCUMENT = await freshDocumentId()
/** UNMAPPED, used only by the cross-workspace case. */
const SIBLING_DOCUMENT = await freshDocumentId()
/** UNMAPPED, used only by the seam test that drives the real doc index. */
const SEAM_DOCUMENT = await freshDocumentId()
/** UNMAPPED, minted by a BOOTSTRAP scope under the forker's lease. */
const BOOTSTRAP_DOCUMENT = await freshDocumentId()

const WORKSPACE: WorkspaceKey = { landscapeId: 'landscape-prov', versionId: 'version-prov' }
/** A SIBLING version of the same landscape — the shape whose fencing token can
 * legitimately equal WORKSPACE's, because the sequences are per-workspace. */
const SIBLING_WORKSPACE: WorkspaceKey = { landscapeId: 'landscape-prov', versionId: 'version-sibling' }

const keyOf = (w: WorkspaceKey): string => `${w.landscapeId}/${w.versionId}`

describe.skipIf(!TEST_DATABASE_URL)('storage fence — a document with no durable row', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'automerge_storage_provisional')
    await db.pool.query(`
      CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)
    `)
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    await db.pool.query('CREATE SEQUENCE automerge_arrival_seq')
    await db.pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      )
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [WORKSPACE.landscapeId, 'Prov'])
    for (const w of [WORKSPACE, SIBLING_WORKSPACE]) {
      await db.pool.query(
        `INSERT INTO versions (id, landscape_id, label, root_url)
         VALUES ($1, $2, 'Main', $3)`,
        [w.versionId, w.landscapeId, `automerge:${MAPPED_DOCUMENT}`],
      )
    }
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3)`,
      [MAPPED_DOCUMENT, WORKSPACE.landscapeId, WORKSPACE.versionId],
    )
  })

  afterAll(async () => { await db?.teardown() })

  beforeEach(async () => {
    // Every case starts from a clean chunk table so a survivor from a previous
    // case cannot stand in for the "the delete was refused" assertion.
    await db.pool.query('DELETE FROM automerge_storage')
    await db.pool.query('DELETE FROM sync_workspace_ownership')
  })

  async function setOwner(
    workspace: WorkspaceKey,
    token: string,
    options: { released?: boolean } = {},
  ): Promise<void> {
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 minute', $5)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         cell_id = EXCLUDED.cell_id,
         fencing_token = EXCLUDED.fencing_token,
         lease_observed_expires_at = EXCLUDED.lease_observed_expires_at,
         released_at = EXCLUDED.released_at`,
      [
        workspace.landscapeId, workspace.versionId, `cell-${token}`, token,
        options.released === true ? new Date() : null,
      ],
    )
  }

  /**
   * A cell whose leases are `tokens` (per workspace) and which has provisionally
   * placed `placed` documents in `placedIn`.
   *
   * `fencingToken` RESPECTS ITS ARGUMENT: the fence is about WHICH workspace's
   * lease is checked, and a fixture answering one token for every workspace
   * would be blind to that question.
   */
  function cell(
    tokens: Partial<Record<string, string | null>>,
    placed: string[] = [],
    placedIn: WorkspaceKey = WORKSPACE,
  ): PostgresStorageAdapter {
    const provisional = new Set(placed)
    return new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: (w) => tokens[keyOf(w)] ?? null },
      provisionalPlacement: (documentId) => (provisional.has(documentId) ? placedIn : null),
    })
  }

  const chunkOf = (documentId: string): StorageKey => [documentId, 'snapshot', 'chunk']
  const countChunks = async (documentId: string): Promise<string> => {
    const { rows } = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM automerge_storage WHERE key LIKE $1 || '/%'",
      [documentId],
    )
    return rows[0]?.n ?? '0'
  }

  it('REFUSES a leaseless cell, and the document that HAS a lease still writes', async () => {
    await setOwner(WORKSPACE, '10')

    // The takeover: this cell's token is one generation behind.
    const stale = cell({ [keyOf(WORKSPACE)]: '9' }, [UNMAPPED_DOCUMENT])
    await expect(stale.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(await stale.load(chunkOf(UNMAPPED_DOCUMENT))).toBeUndefined()

    // …and the conjunctive half, without which the assertion above is also
    // satisfied by a fence that refuses everything: the CURRENT owner writes
    // the same unmapped document.
    const current = cell({ [keyOf(WORKSPACE)]: '10' }, [UNMAPPED_DOCUMENT])
    await current.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([2]))
    expect(Array.from((await current.load(chunkOf(UNMAPPED_DOCUMENT))) ?? [])).toEqual([2])
    expect(current.snapshot()).toMatchObject({
      quarantinedMutationCount: 1,
      provisionallyFencedMutationCount: 1,
    })
  })

  it('a lease on a SIBLING version does not fence a document placed in this one', async () => {
    // Fencing tokens are per-workspace Redis sequences (`sequenceKey` in
    // syncCells/ownership.ts), so two versions of one landscape routinely hold
    // the SAME small integer. Without the `landscape_id`/`version_id` predicate
    // in `provisional_fence`, the fence would degrade to "does ANYBODY hold a
    // lease numbered 7" — a cross-workspace bypass on a leaseless cell.
    // The cell must carry a token FOR the placed workspace (a lease on the
    // sibling only would be refused at `ownership-unavailable` before any SQL
    // runs, testing nothing); what differs is which durable row that number
    // matches.
    await setOwner(WORKSPACE, '8')                  // the placed workspace has moved on
    await setOwner(SIBLING_WORKSPACE, '7')          // the sibling still sits on 7

    const holdingSevenForTheWrongRow = cell({ [keyOf(WORKSPACE)]: '7' }, [SIBLING_DOCUMENT], WORKSPACE)
    await expect(holdingSevenForTheWrongRow.save(chunkOf(SIBLING_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(await countChunks(SIBLING_DOCUMENT)).toBe('0')

    // Conjunctive: the cell that holds THIS workspace's CURRENT lease writes it.
    const right = cell({ [keyOf(WORKSPACE)]: '8' }, [SIBLING_DOCUMENT], WORKSPACE)
    await right.save(chunkOf(SIBLING_DOCUMENT), new Uint8Array([1]))
    expect(Array.from((await right.load(chunkOf(SIBLING_DOCUMENT))) ?? [])).toEqual([1])
  })

  it('names the LANDSCAPE too, which the ownership table does not constrain', async () => {
    // `sync_workspace_ownership.version_id` references `versions(id)`, but
    // `landscape_id` is a bare `TEXT NOT NULL` and the primary key is the pair.
    // So a row carrying this version id under ANOTHER landscape is not a test
    // artefact — the schema permits it, and that is exactly why the fence names
    // both halves. Without this row the landscape predicate is redundant
    // (`versions.id` is a global PK); with it, dropping it would degrade the
    // fence to "does any landscape hold a lease numbered 9 on this
    // version".
    await setOwner(WORKSPACE, '15')
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, 'cell-rogue', 9, NOW() + INTERVAL '1 minute', NULL)`,
      ['landscape-somewhere-else', WORKSPACE.versionId],
    )

    const holdingNine = cell({ [keyOf(WORKSPACE)]: '9' }, [SIBLING_DOCUMENT], WORKSPACE)
    await expect(holdingNine.save(chunkOf(SIBLING_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(await countChunks(SIBLING_DOCUMENT)).toBe('0')

    // Conjunctive: this workspace's own current token writes.
    const right = cell({ [keyOf(WORKSPACE)]: '15' }, [SIBLING_DOCUMENT], WORKSPACE)
    await right.save(chunkOf(SIBLING_DOCUMENT), new Uint8Array([1]))
    expect(await countChunks(SIBLING_DOCUMENT)).toBe('1')
  })

  it('a RELEASED lease does not fence — a clean handoff is a handoff', async () => {
    // `markReleased` sets `released_at` on every ordinary shutdown, so this is
    // the normal path, not a corner. Fixtures elsewhere hardcode NULL, so this
    // is what pins `AND ownership.released_at IS NULL` in the fence.
    await setOwner(WORKSPACE, '12', { released: true })
    const givenBack = cell({ [keyOf(WORKSPACE)]: '12' }, [UNMAPPED_DOCUMENT])
    await expect(givenBack.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    // Conjunctive: the same token on a live lease writes.
    await setOwner(WORKSPACE, '12')
    const live = cell({ [keyOf(WORKSPACE)]: '12' }, [UNMAPPED_DOCUMENT])
    await live.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1]))
    expect(Array.from((await live.load(chunkOf(UNMAPPED_DOCUMENT))) ?? [])).toEqual([1])
  })

  it('a token AHEAD of the durable row is refused, not just one behind', async () => {
    // Every other case here presents local <= durable (9 vs 10, 20 vs 21), so
    // so this pins the equality from the other side (`=` must not weaken to
    // `<=`). A cell whose in-memory token runs ahead of the row has not been
    // granted anything yet.
    await setOwner(WORKSPACE, '10')
    const ahead = cell({ [keyOf(WORKSPACE)]: '11' }, [UNMAPPED_DOCUMENT])
    await expect(ahead.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
  })

  it('REFUSES a leaseless cell DELETING an unmapped document, and the chunks survive', async () => {
    // The loss half. `removeRange` deletes every chunk under the document
    // prefix and reaches the same fence: a cell with no lease must not delete
    // a freshly created document.
    await setOwner(WORKSPACE, '20')
    const owner = cell({ [keyOf(WORKSPACE)]: '20' }, [UNMAPPED_DOCUMENT])
    await owner.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([7]))

    await setOwner(WORKSPACE, '21')
    const stale = cell({ [keyOf(WORKSPACE)]: '20' }, [UNMAPPED_DOCUMENT])
    await expect(stale.removeRange([UNMAPPED_DOCUMENT]))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(await countChunks(UNMAPPED_DOCUMENT)).toBe('1')

    // Conjunctive: the CURRENT owner can still delete it. A fence that refuses
    // every delete would pass the assertion above and break document deletion.
    const current = cell({ [keyOf(WORKSPACE)]: '21' }, [UNMAPPED_DOCUMENT])
    await current.removeRange([UNMAPPED_DOCUMENT])
    expect(await countChunks(UNMAPPED_DOCUMENT)).toBe('0')
  })

  it('still admits a document NOBODY placed — the server-created path', async () => {
    // Fork roots and projector documents are created by `repo.create` and reach
    // their first save without any gate having seen them, so no provisional
    // entry exists. Refusing those would break workspace creation outright.
    // This keeps the provisional fence a NARROWING of the admitted set rather
    // than a new refusal.
    await setOwner(WORKSPACE, '30')
    const anyCell = cell({ [keyOf(WORKSPACE)]: '30' }, [])   // holds a lease, placed nothing
    await anyCell.save(chunkOf(ORPHAN_DOCUMENT), new Uint8Array([3]))
    expect(Array.from((await anyCell.load(chunkOf(ORPHAN_DOCUMENT))) ?? [])).toEqual([3])

    // And a cell with NO lease at all writes it too — stated rather than left
    // implied, because this is the residual hole: a document nobody can name
    // has no owner to check.
    const leaseless = cell({}, [])
    await leaseless.save(chunkOf(ORPHAN_DOCUMENT), new Uint8Array([4]))
    expect(Array.from((await leaseless.load(chunkOf(ORPHAN_DOCUMENT))) ?? [])).toEqual([4])
    expect(leaseless.snapshot()).toMatchObject({
      quarantinedMutationCount: 1,
      provisionallyFencedMutationCount: 0,
    })
  })

  it('refuses a placed document when the cell holds no lease at all', async () => {
    // `fencingToken` returns null while a cell is between leases. The mapped
    // path has always treated that as `ownership-unavailable`; the placed path
    // must agree, or "I lost the lease" would be a weaker state than "I hold an
    // old one".
    await setOwner(WORKSPACE, '40')
    const between = cell({}, [UNMAPPED_DOCUMENT])
    await expect(between.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([5])))
      .rejects.toMatchObject({ reason: 'ownership-unavailable' })
  })

  it('never lets a provisional placement OVERRIDE the durable row', async () => {
    // The security direction. A provisional entry may only fill a hole; if the
    // durable row exists it is the fence's operand, and a cell whose token is
    // stale must not be rescued by having placed the document itself.
    await setOwner(WORKSPACE, '50')
    const owner = cell({ [keyOf(WORKSPACE)]: '50' }, [MAPPED_DOCUMENT])
    await owner.save(chunkOf(MAPPED_DOCUMENT), new Uint8Array([6]))

    await setOwner(WORKSPACE, '51')
    const stale = cell({ [keyOf(WORKSPACE)]: '50' }, [MAPPED_DOCUMENT])   // still claims it
    await expect(stale.save(chunkOf(MAPPED_DOCUMENT), new Uint8Array([8])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(Array.from((await stale.load(chunkOf(MAPPED_DOCUMENT))) ?? [])).toEqual([6])
    // Counted as MAPPED, not provisionally fenced: the durable row answered.
    expect(owner.snapshot()).toMatchObject({
      mappedMutationCount: 1,
      provisionallyFencedMutationCount: 0,
    })
  })

  it('does not so much as ASK about a mapped document', async () => {
    // The guarantee lives in the line that forces the provisional placement to
    // null whenever a mapping exists (which makes the order of
    // `expectedWorkspace ?? provisionalWorkspace` irrelevant), so it is
    // asserted there: the durable row must be the only
    // operand, and the mapped hot path must not pay a lookup for a second
    // opinion it is forbidden to use.
    await setOwner(WORKSPACE, '70')
    const asked: string[] = []
    const adapter = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '70' },
      provisionalPlacement: (documentId) => { asked.push(documentId); return WORKSPACE },
    })

    await adapter.save(chunkOf(MAPPED_DOCUMENT), new Uint8Array([1]))
    expect(asked).toEqual([])

    // Conjunctive, or the assertion above is also satisfied by an adapter that
    // never consults anything: the unmapped document IS asked about.
    await adapter.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1]))
    expect(asked).toEqual([UNMAPPED_DOCUMENT])
  })

  it('resamples when the claim lands mid-statement, WITH a provisional placement', async () => {
    // The race the whole design turns on, with a provisional placement present
    // (the other resample test has none). When the claim commits between the JS lookup and the
    // atomic statement, `NOT EXISTS(document_mapping)` is false and
    // `valid_fence` sees $3/$4 NULL, so permission is empty — the write is
    // thrown away unless the one-shot resample runs — the import burst case.
    await setOwner(WORKSPACE, '80')
    const raced = await freshDocumentId()
    let insertedMapping = false
    // The row must land BETWEEN the JS lookup and the atomic statement;
    // inserting it between two `save` calls would give the second save a fresh
    // lookup — no race, no resample. Same pool wrapper as the other resample
    // case; the counter below is the test's real subject.
    const racingDb = {
      query: async (sql: string, params?: unknown[]) => {
        if (!insertedMapping
          && !sql.includes('WITH document_mapping')
          && sql.includes('FROM automerge_document_workspace')) {
          const result = await db.pool.query(sql, params)
          await db.pool.query(
            `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
             VALUES ($1, $2, $3)`,
            [raced, WORKSPACE.landscapeId, WORKSPACE.versionId],
          )
          insertedMapping = true
          return result
        }
        return db.pool.query(sql, params)
      },
    }
    const adapter = new PostgresStorageAdapter({
      // See the sibling case in `automergeStorage.fencing.integration.test.ts`:
      // the adapter borrows explicitly, so the double needs `connect()`. The
      // interceptor is unchanged.
      db: queryOnlyPool(racingDb.query as never) as unknown as IsolatedSchemaDb['pool'],
      ownership: { fencingToken: (w) => (keyOf(w) === keyOf(WORKSPACE) ? '80' : null) },
      provisionalPlacement: (documentId) => (documentId === raced ? WORKSPACE : null),
    })

    await adapter.save(chunkOf(raced), new Uint8Array([1]))

    expect(insertedMapping, 'the race never happened').toBe(true)
    expect(Array.from((await adapter.load(chunkOf(raced))) ?? [])).toEqual([1])
    expect(adapter.snapshot()).toMatchObject({
      mappingAdmissionRetryCount: 1,   // the resample RAN — without it the write is dropped
      mappedMutationCount: 1,
      rejectedMutationCount: 0,
    })
  })

  it('coalesces a repeated stale write on the PROVISIONAL path too', async () => {
    // Both refusal branches throw the same class with the same `reason`, so
    // `rejects.toBeInstanceOf` cannot tell them apart; the coalescing counter
    // can. Getting it wrong costs a
    // fresh `sync.cell.storage_fence_rejected` per retried chunk — an unbounded
    // log flood during a takeover of freshly created documents, which is
    // precisely when there are most of them.
    await setOwner(WORKSPACE, '90')
    const stale = cell({ [keyOf(WORKSPACE)]: '89' }, [UNMAPPED_DOCUMENT])
    const key = [UNMAPPED_DOCUMENT, 'incremental', 'repeat'] as StorageKey

    await expect(stale.save(key, new Uint8Array([1]))).rejects.toMatchObject({ reason: 'fence-mismatch' })
    await expect(stale.save(key, new Uint8Array([1]))).rejects.toMatchObject({ reason: 'fence-mismatch' })

    expect(stale.snapshot()).toMatchObject({
      rejectedMutationCount: 1,          // the SECOND one was coalesced, not counted again
      coalescedFenceMismatchCount: 1,
    })
  })

  it('drives the LEGACY locked path too — the seam that proves lock order', async () => {
    // `afterFenceLocked` selects `executeLegacyFencedMutation`, which is the
    // branch that holds the transaction open to demonstrate lock ordering. It
    // must fence the unmapped case like the production path does, or the seam
    // would assert the absence of the thing under test.
    await setOwner(WORKSPACE, '60')
    const legacy = (token: string): PostgresStorageAdapter => new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: (w) => (keyOf(w) === keyOf(WORKSPACE) ? token : null) },
      provisionalPlacement: (id) => (id === UNMAPPED_DOCUMENT ? WORKSPACE : null),
      afterFenceLocked: async () => {},
    })

    const stale = legacy('59')
    await expect(stale.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    // And a RELEASED lease, on this path too. The legacy branch checks
    // `owner.released_at` in JavaScript rather than in SQL, so it is a separate
    // predicate that needs its own case.
    await setOwner(WORKSPACE, '60', { released: true })
    const givenBack = legacy('60')
    await expect(givenBack.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    await setOwner(WORKSPACE, '60')
    const current = legacy('60')
    await current.save(chunkOf(UNMAPPED_DOCUMENT), new Uint8Array([1]))
    expect(Array.from((await current.load(chunkOf(UNMAPPED_DOCUMENT))) ?? [])).toEqual([1])
    // The counters are asserted HERE and not only on the production path: the
    // legacy branch has its own pair of increments.
    expect(current.snapshot()).toMatchObject({
      mappedMutationCount: 0,
      quarantinedMutationCount: 1,
      provisionallyFencedMutationCount: 1,
    })
  })
})

/**
 * THE THIRD SOURCE — a BOOTSTRAP document, fenced under the FORKER's lease
 * The document's own workspace has no `versions` row and no lease; what the
 * fence checks is the lease of the workspace that authorised the write, noted
 * by the scope in the frame that minted the document.
 *
 * Every arm is conjunctive for the reason the first describe gives. The
 * counters are asserted by name because a bootstrap save folded into
 * `provisionallyFencedMutationCount` would be counted as an "unplaced
 * creation" it is not.
 */
describe.skipIf(!TEST_DATABASE_URL)('storage fence — a BOOTSTRAP document under the forker\'s lease (B2-5d)', () => {
  let db: IsolatedSchemaDb

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'automerge_storage_bootstrap')
    await db.pool.query('CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)')
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    await db.pool.query('CREATE SEQUENCE automerge_arrival_seq')
    await db.pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      )
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [WORKSPACE.landscapeId, 'Boot'])
    // Only the FORKER has a row: the bootstrap document's own target never
    // does at the moment of the save, which is the whole reason the key is
    // the forker's.
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
      [WORKSPACE.versionId, WORKSPACE.landscapeId, `automerge:${MAPPED_DOCUMENT}`],
    )
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query(
      `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id)
       VALUES ($1, $2, $3)`,
      [MAPPED_DOCUMENT, WORKSPACE.landscapeId, WORKSPACE.versionId],
    )
  })

  afterAll(async () => { await db?.teardown() })

  beforeEach(async () => {
    await db.pool.query('DELETE FROM automerge_storage')
    await db.pool.query('DELETE FROM sync_workspace_ownership')
    resetServerCreationPlacementForTest()
  })

  async function setOwner(workspace: WorkspaceKey, token: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 minute', NULL)
       ON CONFLICT (landscape_id, version_id) DO UPDATE SET
         cell_id = EXCLUDED.cell_id, fencing_token = EXCLUDED.fencing_token,
         lease_observed_expires_at = EXCLUDED.lease_observed_expires_at, released_at = NULL`,
      [workspace.landscapeId, workspace.versionId, `cell-${token}`, token],
    )
  }

  /** A cell whose lease on WORKSPACE (the forker) is `token`, whose bootstrap
   *  source names `placed` documents as forked under it, and whose other two
   *  sources answer nothing. */
  function cell(token: string | null, placed: string[], options: { legacy?: boolean } = {}): PostgresStorageAdapter {
    const set = new Set(placed)
    return new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: (w) => (keyOf(w) === keyOf(WORKSPACE) ? token : null) },
      provisionalPlacement: () => null,
      bootstrapPlacement: (documentId) => (set.has(documentId) ? WORKSPACE : null),
      ...(options.legacy ? { afterFenceLocked: async () => {} } : {}),
    })
  }
  const chunkOf = (documentId: string, suffix = 'chunk'): StorageKey => [documentId, 'snapshot', suffix]
  const countChunks = async (documentId: string): Promise<string> => {
    const { rows } = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM automerge_storage WHERE key LIKE $1 || '/%'",
      [documentId],
    )
    return rows[0]?.n ?? '0'
  }

  it('KILLS the missing third source: a LEASE-LESS cell is refused, and the refusal is COUNTED as the bootstrap fence\'s', async () => {
    await setOwner(WORKSPACE, '10')
    const leaseless = cell(null, [BOOTSTRAP_DOCUMENT])
    await expect(leaseless.save(chunkOf(BOOTSTRAP_DOCUMENT), new Uint8Array([1])))
      .rejects.toMatchObject({ reason: 'ownership-unavailable' })
    expect(await countChunks(BOOTSTRAP_DOCUMENT)).toBe('0')
    expect(leaseless.snapshot()).toMatchObject({
      bootstrapFenceRejectionCount: 1,
      bootstrapFencedMutationCount: 0,
      provisionallyFencedMutationCount: 0,
    })

    // Conjunctive: the FORKER's current owner writes the same document, and
    // the admission is counted on the bootstrap counter — not the provisional
    // one, and not as a plain quarantined write.
    const owner = cell('10', [BOOTSTRAP_DOCUMENT])
    await owner.save(chunkOf(BOOTSTRAP_DOCUMENT), new Uint8Array([2]))
    expect(await countChunks(BOOTSTRAP_DOCUMENT)).toBe('1')
    expect(owner.snapshot()).toMatchObject({
      quarantinedMutationCount: 1,
      bootstrapFencedMutationCount: 1,
      provisionallyFencedMutationCount: 0,
      bootstrapFenceRejectionCount: 0,
    })
  })

  it('KILLS the token-blind fence: a cell whose token for the forker MOVED is refused by SQL, and counted', async () => {
    await setOwner(WORKSPACE, '11')
    const stale = cell('10', [BOOTSTRAP_DOCUMENT])
    await expect(stale.save(chunkOf(BOOTSTRAP_DOCUMENT), new Uint8Array([1])))
      .rejects.toMatchObject({ reason: 'fence-mismatch' })
    expect(await countChunks(BOOTSTRAP_DOCUMENT)).toBe('0')
    expect(stale.snapshot().bootstrapFenceRejectionCount).toBe(1)
    const current = cell('11', [BOOTSTRAP_DOCUMENT])
    await current.save(chunkOf(BOOTSTRAP_DOCUMENT), new Uint8Array([1]))
    expect(await countChunks(BOOTSTRAP_DOCUMENT)).toBe('1')
  })

  it('a document NOBODY forked is still admitted — the bootstrap source narrows, it does not refuse everything', async () => {
    await setOwner(WORKSPACE, '12')
    const leaseless = cell(null, [])
    await leaseless.save(chunkOf(ORPHAN_DOCUMENT), new Uint8Array([3]))
    expect(await countChunks(ORPHAN_DOCUMENT)).toBe('1')
    expect(leaseless.snapshot()).toMatchObject({ bootstrapFencedMutationCount: 0, bootstrapFenceRejectionCount: 0 })
  })

  it('never lets a bootstrap note OVERRIDE the durable row', async () => {
    await setOwner(WORKSPACE, '20')
    const stale = cell('19', [MAPPED_DOCUMENT])   // claims to have forked a document that has a row
    await expect(stale.save(chunkOf(MAPPED_DOCUMENT), new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)
    // Counted against the DURABLE row, not the bootstrap source.
    expect(stale.snapshot()).toMatchObject({ bootstrapFenceRejectionCount: 0, rejectedMutationCount: 1 })
  })

  it('THE DEFAULT WIRE: a note taken through `noteBootstrapPlacement` fences an adapter that was told nothing', async () => {
    // No `bootstrapPlacement` option — the adapter finds the forker tier
    // through its default, which is the join `startAutomergeSync` relies on.
    await setOwner(WORKSPACE, '30')
    const doc = await freshDocumentId()
    const stale = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: (w) => (keyOf(w) === keyOf(WORKSPACE) ? '29' : null) },
    })
    // Before the note: unplaceable, admitted (the conjunctive half).
    await stale.save(chunkOf(doc, 'before'), new Uint8Array([1]))
    noteBootstrapPlacement(doc, WORKSPACE)
    await expect(stale.save(chunkOf(doc, 'after'), new Uint8Array([2]))).rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(stale.snapshot().bootstrapFenceRejectionCount).toBe(1)
    // The purge is what lifts it — and it lifts it for THIS tier too.
    purgeServerCreationPlacement([doc])
    await stale.save(chunkOf(doc, 'after'), new Uint8Array([2]))
    expect(await countChunks(doc)).toBe('2')
  })

  it('KILLS the pre-COMMIT purge: a claim on a transaction that ROLLS BACK leaves the note in place and the save fenced', async () => {
    // `claimWorkspaceDocuments` runs on the tx client inside `applyMerge`; if
    // it purged, a rollback would leave the snapshot with neither a row nor a
    // note — admitted unconditionally on a lease-less cell. The purge belongs
    // after COMMIT, and this arm is what keeps it there.
    await setOwner(WORKSPACE, '40')
    const doc = await freshDocumentId()
    noteBootstrapPlacement(doc, WORKSPACE)
    const client = await db.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await claimWorkspaceDocuments(client, WORKSPACE, [doc])
      expect(result.claimed, 'the claim must have landed inside the transaction, or the arm proves nothing').toEqual([doc])
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect(bootstrapPlacementFor(doc), 'the note survived the rolled-back claim').toEqual(WORKSPACE)
    const leaseless = cell(null, [doc])
    await expect(leaseless.save(chunkOf(doc), new Uint8Array([1]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
  })

  it('KILLS the lost attribution across the resample: a claim landing mid-statement for a TARGET this cell does not own is refused on pass 2, and still counted as the bootstrap fence\'s', async () => {
    // The race the resample loop exists for, with a bootstrap placement present:
    // pass 1 fences under the FORKER (this cell owns it), the claim for the
    // TARGET lands between the JS lookup and the atomic statement, pass 2 reads
    // the durable row — the target, which no cell leases in the instant after
    // its claim — and refuses `ownership-unavailable`. Correct, and the refusal
    // must be attributed to the bootstrap source even though pass 2's operand
    // is the row: without the carried flag the bench under-counts exactly this
    // race.
    const TARGET: WorkspaceKey = { landscapeId: WORKSPACE.landscapeId, versionId: 'version-target' }
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Target', 'automerge:target-root')
       ON CONFLICT (id) DO NOTHING`,
      [TARGET.versionId, TARGET.landscapeId],
    )
    await setOwner(WORKSPACE, '60')
    const raced = await freshDocumentId()
    let insertedMapping = false
    const racingDb = {
      query: async (sql: string, params?: unknown[]) => {
        if (!insertedMapping && !sql.includes('WITH document_mapping') && sql.includes('FROM automerge_document_workspace')) {
          const result = await db.pool.query(sql, params)
          await db.pool.query(
            `INSERT INTO automerge_document_workspace (document_id, landscape_id, version_id) VALUES ($1, $2, $3)`,
            [raced, TARGET.landscapeId, TARGET.versionId],
          )
          insertedMapping = true
          return result
        }
        return db.pool.query(sql, params)
      },
    }
    const adapter = new PostgresStorageAdapter({
      db: queryOnlyPool(racingDb.query as never) as unknown as IsolatedSchemaDb['pool'],
      ownership: { fencingToken: (w) => (keyOf(w) === keyOf(WORKSPACE) ? '60' : null) },
      provisionalPlacement: () => null,
      bootstrapPlacement: (documentId) => (documentId === raced ? WORKSPACE : null),
    })
    try {
      await expect(adapter.save(chunkOf(raced), new Uint8Array([1]))).rejects.toMatchObject({ reason: 'ownership-unavailable' })
      expect(insertedMapping, 'the race never happened').toBe(true)
      expect(adapter.snapshot()).toMatchObject({
        mappingAdmissionRetryCount: 1,        // the resample RAN
        bootstrapFenceRejectionCount: 1,      // …and the refusal kept its attribution
        rejectedMutationCount: 1,
      })
      expect(await countChunks(raced)).toBe('0')
    } finally {
      await db.pool.query('DELETE FROM automerge_document_workspace WHERE document_id = $1', [raced])
    }
  })

  it('the LEGACY locked path counts the bootstrap source on its own counters too', async () => {
    await setOwner(WORKSPACE, '50')
    const stale = cell('49', [BOOTSTRAP_DOCUMENT], { legacy: true })
    await expect(stale.save(chunkOf(BOOTSTRAP_DOCUMENT), new Uint8Array([1]))).rejects.toBeInstanceOf(StaleSyncCellWriteError)
    expect(stale.snapshot().bootstrapFenceRejectionCount).toBe(1)
    const current = cell('50', [BOOTSTRAP_DOCUMENT], { legacy: true })
    await current.save(chunkOf(BOOTSTRAP_DOCUMENT), new Uint8Array([1]))
    expect(current.snapshot()).toMatchObject({
      quarantinedMutationCount: 1,
      bootstrapFencedMutationCount: 1,
      provisionallyFencedMutationCount: 0,
    })
  })
})

/**
 * THE WIRE — and it is its own describe because it is the half that breaks.
 *
 * The fence tests above INJECT `provisionalPlacement` and the gate tests call
 * `peekProvisionalPlacement` DIRECTLY, so neither covers the wiring that joins
 * the doc index to the storage adapter. That wiring is extracted into
 * `installProvisionalPlacementSource` so a test can drive it.
 *
 * This drives a REAL `WorkspaceDocIndex` into a REAL `PostgresStorageAdapter`
 * built with no `provisionalPlacement` option at all, exactly as
 * `startAutomergeSync` builds it.
 */
describe.skipIf(!TEST_DATABASE_URL)('storage fence — the wire from the doc index', () => {
  let db: IsolatedSchemaDb
  let uninstall: (() => void) | null = null

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'automerge_storage_prov_wire')
    await db.pool.query('CREATE TABLE landscapes (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_version_id TEXT)')
    await db.pool.query(`
      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        landscape_id TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        root_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    await db.pool.query('CREATE SEQUENCE automerge_arrival_seq')
    await db.pool.query(`
      CREATE TABLE automerge_storage (
        key TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        arrival_seq BIGINT DEFAULT nextval('automerge_arrival_seq')
      )
    `)
    await db.pool.query('INSERT INTO landscapes (id, name) VALUES ($1, $2)', [WORKSPACE.landscapeId, 'Wire'])
    await db.pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, 'Main', $3)`,
      [WORKSPACE.versionId, WORKSPACE.landscapeId, 'automerge:wire-root'],
    )
    await ensureSyncCellOwnershipSchema(db.pool)
    await db.pool.query(
      `INSERT INTO sync_workspace_ownership (
         landscape_id, version_id, cell_id, fencing_token, lease_observed_expires_at, released_at
       ) VALUES ($1, $2, 'cell-wire', 5, NOW() + INTERVAL '1 minute', NULL)`,
      [WORKSPACE.landscapeId, WORKSPACE.versionId],
    )
  })

  afterEach(() => { uninstall?.(); uninstall = null })
  afterAll(async () => { await db?.teardown() })

  /** Never resolves a document — the index's SQL paths are not what this
   * measures, and a real repo here would make the test about the walk. */
  const wedgedRepo = () => ({ find: () => new Promise(() => {}), handles: {} }) as never

  it('a placement noted on the INDEX fences a save on an adapter that was told nothing', async () => {
    const index = new WorkspaceDocIndex(wedgedRepo(), db.pool, { durable: true })
    uninstall = installProvisionalPlacementSource(index)

    // No `provisionalPlacement` option: the adapter must find the index through
    // the installed source, which is the join `startAutomergeSync` relies on.
    const stale = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '4' },   // one behind the durable 5
    })

    // Before the gate says anything, the document is unplaceable and is
    // admitted — the conjunctive half that proves the refusal
    // below comes from the placement and not from the adapter refusing
    // everything.
    await stale.save([SEAM_DOCUMENT, 'snapshot', 'before'], new Uint8Array([1]))

    // The route gate's admission, through the real index method.
    index.noteProvisionalPlacement(WORKSPACE, SEAM_DOCUMENT)

    await expect(stale.save([SEAM_DOCUMENT, 'snapshot', 'after'], new Uint8Array([2])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    // …and the current owner still writes it.
    const current = new PostgresStorageAdapter({
      db: db.pool,
      ownership: { fencingToken: () => '5' },
    })
    await current.save([SEAM_DOCUMENT, 'snapshot', 'after'], new Uint8Array([3]))
    expect(Array.from((await current.load([SEAM_DOCUMENT, 'snapshot', 'after'])) ?? [])).toEqual([3])
  })

  it('a SERVER-MINTED placement fences the same adapter, but only under `refuse` (B2-4)', async () => {
    // THE SECOND SOURCE'S WIRE. `automergeStorage.ts` chains
    // `provisionalPlacementFor(id) ?? placementForFence(id)`, and the seam
    // test calls `placementForFence()` DIRECTLY, so only an arm that sets
    // `SYNC_CELL_UNPLACED_CREATION` covers the chain.
    //
    // This drives the union through a REAL adapter built with no
    // `provisionalPlacement` option, exactly as `startAutomergeSync` builds it.
    const previous = process.env.SYNC_CELL_UNPLACED_CREATION
    const doc = await freshDocumentId()
    try {
      resetServerCreationPlacementForTest()
      noteServerCreationPlacement(doc, WORKSPACE)

      const stale = new PostgresStorageAdapter({
        db: db.pool,
        ownership: { fencingToken: () => '4' },   // one behind the durable 5
      })

      // UNDER THE DEFAULT the fence must not see it (the refusal is opt-in),
      // and this is conjunctive with the refusal below: without it, an adapter that refused
      // everything would satisfy the next assertion.
      delete process.env.SYNC_CELL_UNPLACED_CREATION
      await stale.save([doc, 'snapshot', 'observe'], new Uint8Array([1]))
      expect(Array.from((await stale.load([doc, 'snapshot', 'observe'])) ?? [])).toEqual([1])

      // ARMED, the same placement refuses — through the chained default, with
      // nothing injected.
      process.env.SYNC_CELL_UNPLACED_CREATION = 'refuse'
      await expect(stale.save([doc, 'snapshot', 'refuse'], new Uint8Array([2])))
        .rejects.toBeInstanceOf(StaleSyncCellWriteError)

      // …and the current owner still writes it, so the refusal came from the
      // placement and not from the adapter refusing every save.
      const current = new PostgresStorageAdapter({
        db: db.pool,
        ownership: { fencingToken: () => '5' },
      })
      await current.save([doc, 'snapshot', 'refuse'], new Uint8Array([3]))
      expect(Array.from((await current.load([doc, 'snapshot', 'refuse'])) ?? [])).toEqual([3])
    } finally {
      if (previous === undefined) delete process.env.SYNC_CELL_UNPLACED_CREATION
      else process.env.SYNC_CELL_UNPLACED_CREATION = previous
      resetServerCreationPlacementForTest()
    }
  })

  it('uninstalling stops the source answering — a dead index must not fence the next server', async () => {
    const index = new WorkspaceDocIndex(wedgedRepo(), db.pool, { durable: true })
    const stop = installProvisionalPlacementSource(index)
    const doc = await freshDocumentId()
    index.noteProvisionalPlacement(WORKSPACE, doc)

    const stale = new PostgresStorageAdapter({ db: db.pool, ownership: { fencingToken: () => '4' } })
    await expect(stale.save([doc, 'snapshot', 'x'], new Uint8Array([1])))
      .rejects.toBeInstanceOf(StaleSyncCellWriteError)

    stop()
    await stale.save([doc, 'snapshot', 'x'], new Uint8Array([1]))
    expect(Array.from((await stale.load([doc, 'snapshot', 'x'])) ?? [])).toEqual([1])
  })
})
