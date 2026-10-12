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
 * THE PLACEMENT AGREEMENT TABLE — do the three gates decide the same thing?
 *
 * `docScope.gateLiveness.test.ts` holds that every gate REACHES a verdict.
 * This file holds the other half: that they reach the SAME one, for every
 * shape a document can present at the sync boundary.
 *
 * There is exactly one rule, and `resolveDocumentPlacement` states it:
 *
 *     THE INDEX ANSWER WINS; THE MINT ONLY FILLS A HOLE.
 *
 * The access and write gates call it. The route gate is a separate copy (the
 * "fourth copy" in the divergence notes below): it decides placement inline,
 * from the mint first, and consults the index — process memory only — only
 * afterwards. So the gates CAN disagree, and a test that fixes one axis and
 * varies the other cannot show a disagreement.
 *
 * Two axes, enumerated rather than chosen:
 *
 *   the ID, relative to the peer's route      the DURABLE ROW
 *   ------------------------------------      ---------------------------
 *   bound      MAC verifies for this route    mine      row = this route
 *   displaced  MAC verifies for a SIBLING     sibling   row = another workspace
 *              version of the same landscape  absent    no row at all
 *   alien      MAC verifies for ANOTHER
 *              landscape
 *   unminted   no MAC (legacy / random id)
 *
 * 4 x 3 = 12 cells x 3 gates = 36 verdicts. Every cell is declared below with
 * the verdict each gate is expected to produce, and a cell whose three gates
 * DISAGREE must say so in `divergence` — a structural assertion enforces that,
 * so a disagreement can never be written into this table silently.
 *
 * WHY A TABLE AND NOT MORE CASES. A hand-written case reaches the cells its
 * author already suspects; cells like "a cold process" or "a first
 * presentation" are easy to miss. Enumerating the cross product leaves none
 * out.
 *
 * RBAC IS DELIBERATELY NEUTRALISED. The session below is granted read+write on
 * every workspace in the fixture, so a deny can only come from PLACEMENT. One
 * ungranted row at the end keeps the grant check itself live in this file.
 */

import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { Repo as RealRepo } from '@automerge/automerge-repo'
import type { Repo } from '@automerge/automerge-repo'
import {
  WorkspaceDocIndex,
  buildAccessCheck,
  buildWorkspaceRouteCheck,
  buildWriteCheck,
  docScopeMetricSamples,
  provisionalPlacementOverflowsTotal,
  type PeerIdentityLookup,
} from './docScope.js'
import { createDocumentAccessCheck } from './documentAccess.js'
import { mintDocumentIdBytes } from './documentIdMint.js'
import type { SessionClaims } from '../auth/tokens.js'

// ---------------------------------------------------------------------------
// The world: one landscape with two versions, plus a second landscape.
// ---------------------------------------------------------------------------

const L = 'L-agree'
const V1 = 'V-routed'      // the workspace this peer's socket is canonicalised to
const V2 = 'V-sibling'     // same landscape, another version — the repoint shape
const L_ALIEN = 'L-alien'
const V_ALIEN = 'V-alien'

const ROUTE = { landscapeId: L, versionId: V1 }
const SIBLING = { landscapeId: L, versionId: V2 }
const ALIEN = { landscapeId: L_ALIEN, versionId: V_ALIEN }

/** Structurally valid, and distinct from every document id under test so that
 * `isServerManagedRoot`'s canonical-root comparison is false for all of them —
 * this table is about placement, not about the server-managed-root refusal,
 * which has its own coverage. */
const ROOT_URLS: Record<string, string> = {
  [`${L}/${V1}`]: 'automerge:2vGjSCzEqJMBjesZ2r5Nxwkd3X7B',
  [`${L}/${V2}`]: 'automerge:3wHkTDaFrKNCkftA3s6Oyxle4Y8C',
  [`${L_ALIEN}/${V_ALIEN}`]: 'automerge:4xJmUEbGsLODlguB4t7Pzymf5Z9D',
}

// ---------------------------------------------------------------------------
// The fixture database. Not a mock of `query` per test — a tiny in-memory
// implementation of the four tables the gates actually read, so that a cell's
// setup is DATA (which row exists) rather than a hand-written response per
// statement. A per-statement mock would have to encode the expected call
// sequence, which is exactly how a table ends up asserting its own fixture.
// ---------------------------------------------------------------------------

interface FakeDb {
  /** (landscapeId, versionId) -> root_url */
  versions: Map<string, string>
  /** documentId -> workspace key */
  documents: Map<string, { landscapeId: string; versionId: string }>
  /** userId -> workspace keys this session may read / write */
  grants: Map<string, { read: Set<string>; write: Set<string> }>
  statements: string[]
}

function key(w: { landscapeId: string; versionId: string }): string {
  return `${w.landscapeId}/${w.versionId}`
}

function freshDb(): FakeDb {
  return {
    versions: new Map([
      [key(ROUTE), ROOT_URLS[key(ROUTE)]!],
      [key(SIBLING), ROOT_URLS[key(SIBLING)]!],
      [key(ALIEN), ROOT_URLS[key(ALIEN)]!],
    ]),
    documents: new Map(),
    grants: new Map(),
    statements: [],
  }
}

function fakePool(db: FakeDb): pg.Pool {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      db.statements.push(sql)

      // ORDER MATTERS: `resolveDurable`'s statement mentions
      // read_model_static_documents AND read_model_static_workspaces, and the
      // INSERT mentions automerge_document_workspace, so the most specific
      // patterns have to be tested first. Getting this order wrong makes a
      // statement answer as a different one and the table then measures the
      // fixture. Each branch names the caller it stands for.
      if (/INSERT INTO automerge_document_workspace/.test(sql)) {
        // claimDocument — immutable first-owner-wins, derived from the versions
        // row so a caller cannot bind a version to a foreign landscape.
        const [documentId, landscapeId, versionId] = params as [string, string, string]
        if (!db.versions.has(`${landscapeId}/${versionId}`)) return { rows: [], rowCount: 0 }
        if (db.documents.has(documentId)) return { rows: [], rowCount: 0 } // ON CONFLICT DO NOTHING
        db.documents.set(documentId, { landscapeId, versionId })
        return { rows: [{ document_id: documentId }], rowCount: 1 }
      }

      if (/FROM automerge_document_workspace d/.test(sql)) {
        // resolveDurable
        const documentId = params[0] as string
        const row = db.documents.get(documentId)
        if (!row) return { rows: [], rowCount: 0 }
        return {
          rows: [{
            landscape_id: row.landscapeId,
            version_id: row.versionId,
            root_url: db.versions.get(key(row)) ?? '',
            static_source: null,
            static_allowed: false,
          }],
          rowCount: 1,
        }
      }

      if (/FROM automerge_document_workspace\b/.test(sql)) {
        // claimDocument's loser branch: who actually holds the row?
        const documentId = params[0] as string
        const row = db.documents.get(documentId)
        if (!row) return { rows: [], rowCount: 0 }
        return { rows: [{ landscape_id: row.landscapeId, version_id: row.versionId }], rowCount: 1 }
      }

      if (/SELECT root_url FROM versions/.test(sql)) {
        // runVerifiedClaim
        const [landscapeId, versionId] = params as [string, string]
        const rootUrl = db.versions.get(`${landscapeId}/${versionId}`)
        return rootUrl ? { rows: [{ root_url: rootUrl }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }

      if (/SELECT id FROM versions WHERE landscape_id/.test(sql)) {
        // listLandscapeVersionIds — the displaced scan's candidate list.
        const landscapeId = params[0] as string
        const ids = [...db.versions.keys()]
          .filter((k) => k.startsWith(`${landscapeId}/`))
          .map((k) => k.slice(landscapeId.length + 1))
        return { rows: ids.map((id) => ({ id })), rowCount: ids.length }
      }

      if (/bool_or\(coalesce\(a\.can_read/.test(sql)) {
        // computeWorkspaceKeySets, non-admin branch.
        const userId = params[0] as string
        const grant = db.grants.get(userId) ?? { read: new Set<string>(), write: new Set<string>() }
        const rows = [...db.versions.keys()].map((k) => {
          const slash = k.indexOf('/')
          return {
            landscape_id: k.slice(0, slash),
            id: k.slice(slash + 1),
            can_read: grant.read.has(k),
            can_write: grant.write.has(k),
          }
        })
        return { rows, rowCount: rows.length }
      }

      if (/FROM read_model_static_workspaces/.test(sql)) {
        // isServerManagedRoot — nothing in this fixture is a static workspace.
        return { rows: [{ managed: false }], rowCount: 1 }
      }

      // workspace_claim_coverage writes and anything else: accepted, empty.
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.Pool
}

/** Every document resolution hangs — same fixture as the liveness table, and
 * for the same reason: a gate that reaches one has already failed, and here it
 * would also make the verdict depend on a walk rather than on placement. */
function wedgedRepo(): Repo {
  return { find: () => new Promise(() => {}), handles: {} } as unknown as Repo
}

// ---------------------------------------------------------------------------
// The four id shapes. Minted from the environment — `vitest.setup.ts`
// guarantees AUTH_SECRET for every suite, and the canary below fails by name
// if that ever stops being true.
// ---------------------------------------------------------------------------

async function mintedId(workspace: { landscapeId: string; versionId: string }): Promise<string> {
  const repo = new RealRepo({ idFactory: async () => mintDocumentIdBytes(workspace) })
  return String((await repo.create2({ minted: key(workspace) })).documentId)
}

async function randomId(): Promise<string> {
  const repo = new RealRepo({})
  return String((await repo.create2({ unminted: true })).documentId)
}

type IdShape = 'bound' | 'displaced' | 'alien' | 'unminted'
type DurableRow = 'mine' | 'sibling' | 'absent'
type GateName = 'route' | 'access' | 'write'

const ID_SHAPES: Record<IdShape, () => Promise<string>> = {
  bound: () => mintedId(ROUTE),
  displaced: () => mintedId(SIBLING),
  alien: () => mintedId(ALIEN),
  unminted: randomId,
}

const DURABLE_ROW: Record<DurableRow, { landscapeId: string; versionId: string } | null> = {
  mine: ROUTE,
  sibling: SIBLING,
  absent: null,
}

// ---------------------------------------------------------------------------
// THE TABLE
// ---------------------------------------------------------------------------

interface Cell {
  id: IdShape
  durable: DurableRow
  route: boolean
  access: boolean
  write: boolean
  /**
   * The route gate's verdict on a WARM index — one that has already placed
   * this document in process memory.
   *
   * Defaults to `route`, and is declared only where warmth changes the answer.
   * This axis exists because the whole table would otherwise run cold:
   * cache-only reads answer `null` on a cold process for every input, so a
   * cold-only table cannot tell "the gate consulted the index and agreed" from
   * "the gate never consulted it".
   */
  routeWarm?: boolean
  /**
   * The verdict of `createDocumentAccessCheck` — route THEN access — which is
   * the one automerge-repo caches per (document, peer).
   *
   * Defaults to `route && access` and is declared explicitly only where it is
   * NOT that: the route gate's displaced branch AWAITS its claim, so it writes
   * the durable row before returning, and the access gate that runs next is no
   * longer looking at the same world. A composed verdict
   * is therefore a MEASUREMENT, not an arithmetic consequence of the two
   * columns beside it.
   */
  composed?: boolean
  /**
   * Required when the three gates do NOT agree, and the assertion below
   * enforces that. A divergence is allowed to exist — two of the three here
   * are named limits with a stated compensating mechanism — but it may never
   * be written into this table without a sentence saying why, because a
   * disagreement that reads as ordinary is a disagreement nobody re-examines.
   */
  divergence?: string
}

const TABLE: Cell[] = [
  // ---- bound: the MAC says this document is ours -------------------------
  {
    id: 'bound', durable: 'mine',
    route: true, access: true, write: true,
  },
  {
    id: 'bound', durable: 'sibling',
    route: true, access: false, write: false,
    // Warmth CLOSES this one: once the process has placed the document, the
    // peek sees the sibling row and the route gate agrees with the other two.
    // That is what makes the divergence below a limit of the CACHE rather than
    // of the rule — and it is the contrast that gives `alien x mine` its
    // weight, since warmth does nothing there.
    routeWarm: false,
    divergence:
      'NAMED LIMIT of peekDocWorkspace. The route gate reads process memory only ' +
      '(invariant A forbids awaiting, and consulting resolveDocWorkspace would ' +
      'schedule a parasitic repair per newly created document), so on a COLD ' +
      'process it cannot see a durable row nobody has read yet and admits the ' +
      'first presentation. Compensated: the composed check runs access after ' +
      'route, and access resolves durable-first. What is left uncovered is the ' +
      'standalone callers — the ownership gate, and stages off/dual.',
  },
  {
    id: 'bound', durable: 'absent',
    route: true, access: true, write: true,
    // THE IMPORT CELL. Every gate must allow, or a freshly created document
    // loses its changes — this is the row the whole minted-id design exists
    // for.
  },

  // ---- displaced: minted for a SIBLING version of the same landscape -----
  {
    id: 'displaced', durable: 'mine',
    route: true, access: true, write: true,
  },
  {
    id: 'displaced', durable: 'sibling',
    route: false, access: false, write: false,
  },
  {
    id: 'displaced', durable: 'absent',
    route: true, access: false, write: false,
    // MEASURED, and it is the reason `composed` exists as a column: the route
    // gate's displaced branch AWAITS `claimVerifiedDocument`, so by the time
    // the access gate runs inside the same composed call the durable row is
    // already there and it allows. The cold `access: false` above is the
    // verdict this gate gives when asked FIRST, which is what the write path
    // does.
    composed: true,
    divergence:
      'ORDER, not disagreement. The route gate SEEDS the durable row here — ' +
      'claimVerifiedDocument is first-owner-wins and admits for this socket ' +
      'route — so access and write answer false only while no row exists yet. ' +
      'They agree the moment the claim lands, and the claim announces, which ' +
      'lifts the pinned deny. The residual risk is real and belongs to the ' +
      'WRITE gate: it runs before the repo (per-message), so a change-bearing ' +
      'frame arriving before the opening sync frame would be dropped.',
  },

  // ---- alien: minted for ANOTHER landscape -------------------------------
  {
    id: 'alien', durable: 'mine',
    route: false, access: true, write: true,
    divergence:
      'THE FOURTH COPY. resolveDocumentPlacement says the index answer wins and ' +
      'the mint only fills a hole; the route gate\'s `foreign` branch answers ' +
      'from the mint and never falls through to the index, so it refuses a ' +
      'document the durable row places in the peer\'s OWN workspace. Unlike the ' +
      'two divergences above it is the route gate that is MORE restrictive, so ' +
      'the composition does not cover it — and `foreign` owes no lift by ' +
      'design, which makes the deny permanent for the life of the id. Note the ' +
      'contrast with `bound x sibling`: WARMING the index closes that one and ' +
      'does nothing here, because this branch never asks the index at all.',
  },
  {
    id: 'alien', durable: 'sibling',
    route: false, access: false, write: false,
  },
  {
    id: 'alien', durable: 'absent',
    route: false, access: false, write: false,
  },

  // ---- unminted: a legacy / random id, no MAC ----------------------------
  {
    id: 'unminted', durable: 'mine',
    route: true, access: true, write: true,
  },
  {
    id: 'unminted', durable: 'sibling',
    route: false, access: false, write: false,
  },
  {
    id: 'unminted', durable: 'absent',
    route: false, access: false, write: false,
    // The default-deny quarantine for an unplaceable document; it must stay
    // exactly this.
  },
]

// ---------------------------------------------------------------------------

function claims(userId: string): SessionClaims {
  return { userId, email: `${userId}@example.test`, orgId: 'org1', isPlatformAdmin: false } as SessionClaims
}

function registry(peerClaims: SessionClaims): PeerIdentityLookup {
  return { identityForPeer: () => peerClaims, workspaceForPeer: () => ROUTE }
}

/** A world in the state a cell describes, with a session granted everywhere so
 * that only placement can deny. `userId` is unique per call: the key-set cache
 * is keyed by (userId, epoch) and lives at module scope, so a shared id would
 * let one cell's grant lookup answer another's — and a cell whose SQL never ran
 * asserts nothing. */
function world(cell: Cell, gate: GateName, documentId: string, granted = true): {
  index: WorkspaceDocIndex
  pool: pg.Pool
  db: FakeDb
  session: SessionClaims
} {
  const db = freshDb()
  const target = DURABLE_ROW[cell.durable]
  if (target) db.documents.set(documentId, target)

  const session = claims(`u-${cell.id}-${cell.durable}-${gate}-${granted ? 'granted' : 'bare'}`)
  const all = new Set(db.versions.keys())
  db.grants.set(session.userId, granted
    ? { read: all, write: new Set(all) }
    : { read: new Set<string>(), write: new Set<string>() })

  const pool = fakePool(db)
  return { index: new WorkspaceDocIndex(wedgedRepo(), pool, { durable: true }), pool, db, session }
}

function buildGate(
  gate: GateName,
  index: WorkspaceDocIndex,
  pool: pg.Pool,
  session: SessionClaims,
): (peerId: string, documentId: string) => Promise<boolean> {
  switch (gate) {
    case 'route': return buildWorkspaceRouteCheck(index, registry(session), true)
    case 'access': return buildAccessCheck(pool, index, registry(session))
    case 'write': return buildWriteCheck(pool, index, registry(session))
  }
}

describe('placement agreement — the three gates on every (id shape, durable row)', () => {
  it('the harness can mint at all', async () => {
    // The canary gateLiveness relies on, stated here too: without AUTH_SECRET
    // every minted id degrades to `unminted` and two thirds of this table
    // silently measures the same cell three times.
    expect(process.env.AUTH_SECRET).toBeTruthy()
    const bound = await mintedId(ROUTE)
    const alien = await mintedId(ALIEN)
    expect(bound).not.toEqual(alien)
  })

  it('the table declares a reason for every disagreement it contains', async () => {
    // A lint on the TABLE, not on the code. Without it, a future edit could
    // make two gates disagree by changing an expectation, and the suite would
    // stay green while the artefact stopped meaning anything.
    for (const cell of TABLE) {
      const agree = cell.route === cell.access && cell.access === cell.write
      const named = cell.divergence !== undefined
      expect(agree, `${cell.id} x ${cell.durable}: declares a divergence but the three verdicts are equal`)
        .toBe(!named)
    }
    // And every cell exists exactly once.
    const seen = TABLE.map((c) => `${c.id}x${c.durable}`)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toHaveLength(4 * 3)
  })

  for (const cell of TABLE) {
    for (const gate of ['route', 'access', 'write'] as const) {
      it(`${cell.id} id x durable row ${cell.durable} -> ${gate} gate ${cell[gate] ? 'ALLOWS' : 'DENIES'}`, async () => {
        const documentId = await ID_SHAPES[cell.id]()
        const { index, pool, session } = world(cell, gate, documentId)
        const check = buildGate(gate, index, pool, session)

        expect(await check('peer-1', documentId)).toBe(cell[gate])
      })
    }
  }

  for (const cell of TABLE) {
    const expected = cell.routeWarm ?? cell.route
    it(`${cell.id} id x durable row ${cell.durable} -> route gate on a WARM index ${expected ? 'ALLOWS' : 'DENIES'}`, async () => {
      const documentId = await ID_SHAPES[cell.id]()
      const { index, pool, session } = world(cell, 'route', documentId)

      // Warm it the way production does — the access gate, or any earlier
      // message for this document, resolves it and the placement lands in
      // `byDoc`. Asserting the warming WORKED is not ceremony: if it silently
      // did nothing, every row below would re-measure the cold table and the
      // one cell that changes would go unnoticed.
      const placed = await index.resolveDocWorkspace(documentId)
      expect(placed === null, 'warming did not populate the index')
        .toBe(DURABLE_ROW[cell.durable] === null)

      const check = buildGate('route', index, pool, session)
      expect(await check('peer-1', documentId)).toBe(expected)
    })
  }

  it('a session with no grant is refused wherever placement would have allowed', async () => {
    // Keeps the grant check live in this file. Every row above grants
    // everywhere on purpose, so without this one a mutant deleting the
    // membership test would pass the whole table.
    const cell: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
    const documentId = await ID_SHAPES.bound()
    for (const gate of ['access', 'write'] as const) {
      const { index, pool, session } = world(cell, gate, documentId, false)
      expect(await buildGate(gate, index, pool, session)('peer-1', documentId), `${gate} gate`).toBe(false)
    }
  })

  // =====================================================================
  // The placement the route gate hands to the STORAGE FENCE.
  //
  // `withFencedMutation` derives the workspace whose lease it checks from
  // `automerge_document_workspace`. With no row there is nobody to check, so
  // the mutation — `removeRange` included, which deletes every chunk of a
  // document — would be admitted unconditionally. A document with no row is
  // exactly a freshly created one, so the route gate publishes a provisional
  // placement for the fence to use.
  //
  // The fence half is measured against a real Postgres in
  // `automergeStorage.provisionalFence.integration.test.ts`. That file INJECTS
  // the placement, so it cannot see whether anything publishes one: this block
  // tests that wire.
  // =====================================================================
  describe('provisional placement — what the route gate tells the storage fence', () => {
    it('a BOUND admission publishes it; a displaced one does not, because it awaits its claim', async () => {
      const boundId = await ID_SHAPES.bound()
      const cellBound: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
      const bound = world(cellBound, 'route', boundId)
      expect(await buildGate('route', bound.index, bound.pool, bound.session)('peer-1', boundId)).toBe(true)
      expect(bound.index.peekProvisionalPlacement(boundId)).toEqual(ROUTE)

      // The displaced branch returns `claimVerifiedDocument`, so the durable row
      // exists before it answers and the fence has its own operand. Publishing
      // there would be a second, weaker copy of an answer already written down.
      const displacedId = await ID_SHAPES.displaced()
      const cellDisp: Cell = { id: 'displaced', durable: 'absent', route: true, access: false, write: false, composed: true, divergence: 'see the table' }
      const disp = world(cellDisp, 'route', displacedId)
      expect(await buildGate('route', disp.index, disp.pool, disp.session)('peer-1', displacedId)).toBe(true)
      expect(disp.index.peekProvisionalPlacement(displacedId)).toBeNull()
    })

    it('a REFUSED document is never published — the fence must not fence what was denied', async () => {
      // An unminted, unindexed id: the default-deny quarantine. If a deny still
      // published a placement, a later mutation for it would be fenced against
      // a workspace this peer was refused, which reads in the metrics as a
      // legitimate provisional write.
      const id = await ID_SHAPES.unminted()
      const cell: Cell = { id: 'unminted', durable: 'absent', route: false, access: false, write: false }
      const w = world(cell, 'route', id)
      expect(await buildGate('route', w.index, w.pool, w.session)('peer-1', id)).toBe(false)
      expect(w.index.peekProvisionalPlacement(id)).toBeNull()
    })

    it('the CLAIM drops the entry — the read does not, and must not', async () => {
      // The eviction lives on the claim, so the claim is what this drives.
      // Setting `db.documents` by hand and calling `resolveDocWorkspace` would
      // assert the fixture: the peek would answer null whether or not the
      // eviction line existed.
      const id = await ID_SHAPES.bound()
      const cell: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
      const w = world(cell, 'route', id)
      w.index.noteProvisionalPlacement(ROUTE, id)
      expect(w.index.peekProvisionalPlacement(id)).toEqual(ROUTE)

      expect(await w.index.claimVerifiedDocument(ROUTE, id)).toBe(true)
      expect(w.db.documents.get(id)).toEqual(ROUTE)          // a durable row exists…
      expect(w.index.peekProvisionalPlacement(id)).toBeNull() // …and only then is it dropped
    })

    it('a document byDoc knows WITHOUT a durable row keeps its placement', async () => {
      // `byDoc` does NOT imply a durable row: `walkFrom`'s tail loop writes
      // byDoc for ids `claimDocument` DECLINED. A peek that consulted `byDoc`
      // and deleted on a hit would permanently silence exactly the documents
      // that have no row and most need a fence.
      const id = await ID_SHAPES.bound()
      const db = freshDb()
      // DB-free mode, which is the same shape and an actual production path:
      // `claimDocument`'s `!this.durable` branch sets `byDoc` and returns true
      // without ever writing a row.
      const index = new WorkspaceDocIndex(wedgedRepo(), fakePool(db), { durable: false })
      index.noteProvisionalPlacement(ROUTE, id)
      expect(await index.claimVerifiedDocument(ROUTE, id)).toBe(true)
      expect(db.documents.has(id)).toBe(false)          // byDoc knows; the table does not

      expect(index.peekProvisionalPlacement(id)).toEqual(ROUTE)
      // …and repeatedly, because a read that mutates cannot be retried and the
      // fence calls this inside `withDbRetry`'s retryable closure.
      expect(index.peekProvisionalPlacement(id)).toEqual(ROUTE)
    })

    it('re-presenting a document does not re-enter it — a burst must not evict its own oldest', async () => {
      const id = await ID_SHAPES.bound()
      const cell: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
      const w = world(cell, 'route', id)

      // Asserted on the method, not through the gate: driving the gate 50
      // times ALSO lets the unawaited `claimVerifiedDocument` resolve between
      // iterations, so the peek legitimately falls silent for a reason that
      // has nothing to do with the FIFO.
      const before = provisionalPlacementOverflowsTotal()
      const older = 'doc-older'
      w.index.noteProvisionalPlacement(ROUTE, older)
      for (let i = 0; i < 50; i += 1) w.index.noteProvisionalPlacement(ROUTE, id)

      expect(w.index.peekProvisionalPlacement(id)).toEqual(ROUTE)
      expect(w.index.peekProvisionalPlacement(older)).toEqual(ROUTE)
      expect(provisionalPlacementOverflowsTotal() - before).toBe(0)
    })

    it('re-presenting into a FULL map evicts nothing — the case the guard exists for', async () => {
      // The test above does NOT cover the guard: `Map.set` on an existing key
      // leaves its insertion rank alone,
      // so deleting the guard changed nothing while the map had room. The
      // difference only appears at the ceiling, where the size check runs
      // first — without the guard a re-presentation evicts the oldest entry and
      // then re-sets a key that was already there, paying a lost placement for
      // no new one. A sync burst re-presents on every frame, so this is the
      // ordinary case, not a corner.
      const cell: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
      const w = world(cell, 'route', await ID_SHAPES.bound())

      const before = provisionalPlacementOverflowsTotal()
      const oldest = 'doc-oldest'
      w.index.noteProvisionalPlacement(ROUTE, oldest)
      for (let i = 1; i < 4_096; i += 1) w.index.noteProvisionalPlacement(ROUTE, `doc-${i}`)
      expect(provisionalPlacementOverflowsTotal() - before).toBe(0)   // exactly full

      // Re-present one that is ALREADY there, many times.
      for (let i = 0; i < 20; i += 1) w.index.noteProvisionalPlacement(ROUTE, 'doc-2000')

      expect(provisionalPlacementOverflowsTotal() - before).toBe(0)
      expect(w.index.peekProvisionalPlacement(oldest)).toEqual(ROUTE)
    })

    it('a MAPPED document is never even asked about — the durable row is the only operand', async () => {
      // Inverting `expectedWorkspace ?? provisionalWorkspace` in the fence is
      // an EQUIVALENT mutant,
      // because the line above already forces `provisionalWorkspace` to null
      // whenever a mapping exists. The guarantee lives in that line, so assert
      // it there — the fence must not so much as CONSULT the provisional map
      // for a document the durable index has placed, which also keeps the
      // mapped hot path free of the lookup.
      const id = await ID_SHAPES.bound()
      const cell: Cell = { id: 'bound', durable: 'mine', route: true, access: true, write: true }
      const w = world(cell, 'route', id)
      w.index.noteProvisionalPlacement(ROUTE, id)

      // The gate presents it; the claim reads the existing row and the purge
      // fires from THERE. `resolveDocWorkspace` alone would not do it, and must
      // not: the peek no longer consults `byDoc` at all.
      expect(await w.index.claimVerifiedDocument(ROUTE, id)).toBe(true)
      expect(w.index.peekProvisionalPlacement(id)).toBeNull()
    })

    it('the gate-driven path hands over cleanly: the claim lands, THEN the peek falls silent', async () => {
      // The handover this design depends on: the purge runs inside
      // `claimDocument`, at the two points it learns a durable row, so the
      // entry survives until the row exists. (This does NOT mean the fence
      // always has an operand — `walkFrom`'s tail loop makes an id resolvable
      // without a row, see the byDoc test above. What holds is narrower: the
      // purge never runs BEFORE the row exists.)
      const id = await ID_SHAPES.bound()
      const cell: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
      const w = world(cell, 'route', id)
      const gate = buildGate('route', w.index, w.pool, w.session)

      expect(await gate('peer-1', id)).toBe(true)
      // Let the unawaited claim settle.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(w.db.documents.get(id)).toEqual(ROUTE)          // durable row landed…
      expect(w.index.peekProvisionalPlacement(id)).toBeNull() // …and only then

      // And it must STAY gone. A sync burst re-presents the same document on
      // every frame; without the `byDoc` guard on publication, each of those
      // re-creates an entry that no purge site can remove — the claim has
      // already happened, so `claimVerifiedDocument` returns from cache without
      // reaching `claimDocument` — and the map would saturate.
      expect(await gate('peer-2', id)).toBe(true)
      expect(w.index.peekProvisionalPlacement(id)).toBeNull()
    })

    it('the ceiling drops the OLDEST and says so — it fails open, and visibly', async () => {
      // Overflow returns a document to unfenced admission rather
      // than refusing writes for a document whose only crime is a busy process.
      // That is a choice, and a silent choice here would be indistinguishable
      // from the bug: the counter is what makes it a decision instead.
      const id = await ID_SHAPES.bound()
      const cell: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
      const w = world(cell, 'route', id)

      // DELTA, never an absolute. The counter is module-scoped (that is how
      // `docScopeMetricSamples` can reach it) and nothing resets it, so
      // `toBe(1)` would pass or fail on test ORDER.
      const before = provisionalPlacementOverflowsTotal()
      const first = 'doc-0000'
      w.index.noteProvisionalPlacement(ROUTE, first)
      for (let i = 1; i <= 4_096; i += 1) w.index.noteProvisionalPlacement(ROUTE, `doc-${i}`)

      expect(provisionalPlacementOverflowsTotal() - before).toBe(1)
      expect(w.index.peekProvisionalPlacement(first)).toBeNull()   // the oldest went
      expect(w.index.peekProvisionalPlacement('doc-4096')).toEqual(ROUTE) // the newest stayed
    })

    it('the overflow is EXPORTED — the fail-open has a witness outside the tests', async () => {
      // The counter's whole justification is that it makes the fail-open
      // observable, so assert it is actually exported as a metric.
      const cell: Cell = { id: 'bound', durable: 'absent', route: true, access: true, write: true }
      const w = world(cell, 'route', await ID_SHAPES.bound())
      const sample = docScopeMetricSamples()
        .find((s) => s.name === 'maplespire_docscope_provisional_placement_overflows_total')
      expect(sample, 'the overflow counter is not exported as a metric').toBeDefined()

      const before = Number(sample?.values[0]?.value)
      for (let i = 0; i <= 4_096; i += 1) w.index.noteProvisionalPlacement(ROUTE, `exp-${i}`)
      const after = docScopeMetricSamples()
        .find((s) => s.name === 'maplespire_docscope_provisional_placement_overflows_total')
      expect(Number(after?.values[0]?.value) - before).toBe(1)
    })
  })

  it('the COMPOSED check lands on the safe side of every divergence', async () => {
    // The share policy automerge-repo caches is `createDocumentAccessCheck`,
    // which runs route THEN access. For the two cells where the route gate is
    // more permissive than the index, the composition is what makes the pair
    // safe — asserting it here is what lets those divergences stay named
    // limits rather than open defects.
    for (const cell of TABLE) {
      const documentId = await ID_SHAPES[cell.id]()
      const { index, pool, session } = world(cell, 'access', documentId)
      const composed = createDocumentAccessCheck({
        routeCheck: buildWorkspaceRouteCheck(index, registry(session), true),
        authCheck: buildAccessCheck(pool, index, registry(session)),
        workspaceForPeer: () => ROUTE,
        resolveDocWorkspace: (id) => index.resolveDocWorkspace(id),
        ledger: { recordDeny: () => {}, clear: () => {} },
      })

      const expected = cell.composed ?? (cell.route && cell.access)
      expect(await composed('peer-1', documentId), `${cell.id} x ${cell.durable}`).toBe(expected)
    }
  })
})
