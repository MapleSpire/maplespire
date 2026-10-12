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
 * THE ARCHITECTURAL INVARIANT OF THE SYNC AUTHORIZATION BOUNDARY
 *
 *   No authorization decision on the inbound sync path may await the resolution
 *   of an Automerge document. Every gate must reach a verdict from PostgreSQL
 *   and process-local memory alone, so that no verdict can ever depend on a
 *   message the gated peer has not yet been permitted to send.
 *
 * Why this is a hard invariant and not a preference: the gates run inside
 * per-socket FIFOs (`syncWriteGate.ts`, `diagramPresenceGate.ts`) and inside
 * automerge-repo's share-policy resolution (`DocSynchronizer.#resolveSharePolicy`,
 * awaited by `addPeer` while the peer's first message sits in `pendingMessages`).
 * A gate that awaits `repo.find()` for a document only the gated peer holds
 * therefore waits on a message it is itself blocking:
 *
 *     msg#1 (document D) -> decide() -> canWrite -> repo.find(D)
 *                                                       ^ needs a message from this socket
 *     msg#2 (the reply carrying D) -> queued behind msg#1 -> never delivered
 *
 * `repo.find()`/`whenReady()` install no timeout of their own, and
 * `DocSynchronizer.#updateAvailability` keeps a query `sourcePending` while any
 * peer is `sharePolicyState: 'loading'`, so the query cannot even fall through
 * to `unavailable`. The wedge is permanent, and because the walk promise is
 * memoized in `routeBackfills`/`entry.building` (both evicted only on
 * REJECTION, never on non-settlement), one stuck peer can take document
 * admission for a whole workspace down process-wide.
 *
 * This regression is easy to reintroduce — a gate that "just" resolves a
 * document looks harmless — so this test, not prose, holds the line.
 *
 * Adding a new gate? Add a row to the table below.
 */

import { describe, it, expect, vi } from 'vitest'
import type pg from 'pg'
import { Repo as RealRepo } from '@automerge/automerge-repo'
import type { Repo } from '@automerge/automerge-repo'
import {
  WorkspaceDocIndex,
  buildAccessCheck,
  buildWorkspaceRouteCheck,
  buildWriteCheck,
  buildBaselineWriteFence,
  type PeerIdentityLookup,
  type GateFaultReporter,
} from './docScope.js'
import { mintDocumentIdBytes } from './documentIdMint.js'
import type { SessionClaims } from '../auth/tokens.js'

const WORKSPACE = { landscapeId: 'L-live', versionId: 'V-live' }

/** Every document resolution hangs forever — the peer that could answer is the
 * one being gated, and it is blocked behind this very decision. */
function wedgedRepo(): Repo {
  return { find: () => new Promise(() => {}), handles: {} } as unknown as Repo
}

/** A STRUCTURALLY VALID url for a document that never becomes ready. It has to
 * be valid: `walkFrom`'s `find()` calls `isValidAutomergeUrl` first and returns
 * null on a made-up id, so a placeholder like `automerge:never-ready` makes the
 * walk exit before touching the repo — and the test then passes against the very
 * mutant it exists to kill. */
const NEVER_READY_URL = 'automerge:2vGjSCzEqJMBjesZ2r5Nxwkd3X7B'

/**
 * `find()` RESOLVES — with a handle that is not ready and whose `whenReady()`
 * never settles.
 *
 * This is not a hypothetical fixture. `DocHandle.whenReady()` returns a forever
 * promise, never a rejection, for any state but `ready`, and it runs AFTER
 * `find` has resolved — so it slips past a deadline on `find`, and past a
 * `catch`, which is the combination this file's header describes as taking
 * document admission down for a whole workspace process-wide.
 */
function notReadyRepo(): Repo {
  return {
    find: async () => ({
      documentId: '2vGjSCzEqJMBjesZ2r5Nxwkd3X7B',
      url: NEVER_READY_URL,
      state: 'deleted',
      doc: () => ({}),
      on: () => {},
      off: () => {},
      whenReady: () => new Promise(() => {}),
    }),
    handles: {},
  } as unknown as Repo
}

/** Postgres answers instantly for the durable registry (a real deployment's
 * gate lookups are bounded) but the workspace catalog — the entry point of
 * every graph walk — hangs. Any gate that reaches a walk therefore hangs, and
 * any gate that respects the invariant answers from the registry alone.
 * (Deliberately NOT extended to the static-baseline tables: `resolveDurable`'s
 * `static_allowed` filter reads them as part of the bounded registry lookup
 * this fixture promises answers for — hanging them here wedges every OTHER
 * gate by fixture, not by defect. The fence's own hang mode gets its own
 * pool, `staticWedgedPool` below.) */
function wedgedPool(): pg.Pool {
  return {
    query: async (sql: string) => {
      if (/FROM versions/.test(sql)) return new Promise(() => {})
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.Pool
}

/** The baseline write fence's own statements — and ONLY those — hang. Its two
 * SQL reads are the only gate SQL touching the static tables by themselves,
 * so this drives its injected deadline without wedging the other gates'
 * bounded registry lookups. */
function staticWedgedPool(): pg.Pool {
  return {
    query: async (sql: string) => {
      if (/read_model_static/.test(sql)) return new Promise(() => {})
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.Pool
}

/** Postgres is reachable but every statement fails — pool exhaustion, a failover
 * window, a statement timeout. A gate that lets that rejection escape is WORSE
 * than one that denies: automerge-repo pins the verdict per (document, peer) at
 * `#activatePeer`, and `stageAwareAccessCheck` awaits the raw check, so a
 * rejection also escapes the "stage dual never enforces" contract. The gate must
 * produce a verdict and pair it with a re-evaluation request, as
 * `syncWriteGate.ts` does per message. */
function faultyPool(): pg.Pool {
  return {
    query: async () => { throw new Error('remaining connection slots are reserved') },
  } as unknown as pg.Pool
}

const claims = (overrides: Partial<SessionClaims> = {}): SessionClaims => ({
  userId: 'u1',
  email: 'u1@example.test',
  orgId: 'org1',
  isPlatformAdmin: false,
  ...overrides,
} as SessionClaims)

function registry(peerClaims: SessionClaims | null | undefined, routed = true): PeerIdentityLookup {
  return {
    identityForPeer: () => peerClaims,
    workspaceForPeer: () => (routed ? WORKSPACE : null),
  }
}

const VERDICT_BUDGET_MS = 250

/** Resolve to the gate's verdict, or to the sentinel if it did not reach one.
 * The sentinel failing an assertion IS the deadlock report. */
async function verdictWithin<T>(promise: Promise<T>): Promise<T | 'NO_VERDICT_DEADLOCKED'> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<'NO_VERDICT_DEADLOCKED'>((resolve) => {
    timer = setTimeout(() => resolve('NO_VERDICT_DEADLOCKED'), VERDICT_BUDGET_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

interface GateCase {
  name: string
  durable: boolean
  build: (index: WorkspaceDocIndex, pool: pg.Pool) => (peerId: string, documentId: string) => Promise<boolean>
  /** Defaults to an unminted protocol id. The displaced row supplies a MINTED
   * sibling-version id instead, which is the only input that reaches that
   * branch's SQL. */
  documentId?: () => Promise<string>
}

/** A well-formed minted id for a SIBLING VERSION of the routed workspace —
 * the input that forces the gate through the displaced branch (version-list
 * SQL + durable claim). Minted from the environment: `vitest.setup.ts`
 * guarantees AUTH_SECRET, and its canary fails by name if that ever stops
 * being true. */
async function displacedDocumentId(): Promise<string> {
  const repo = new RealRepo({
    idFactory: async () => mintDocumentIdBytes({ landscapeId: WORKSPACE.landscapeId, versionId: 'V-elsewhere' }),
  })
  return String((await repo.create2({ displaced: true })).documentId)
}

/** A well-formed minted id for the ROUTED workspace itself — the input that
 * makes placement SUCCEED without the index, and therefore the only input that
 * carries the RBAC gates past `if (!workspace) return false` and into the grant
 * lookup. Every other row in this table uses an unindexed id, which
 * short-circuits before any of that. */
async function mintedDocumentId(): Promise<string> {
  const repo = new RealRepo({ idFactory: async () => mintDocumentIdBytes(WORKSPACE) })
  return String((await repo.create2({ minted: true })).documentId)
}

const GATES: GateCase[] = [
  {
    name: 'route check (routed socket, unindexed document)',
    durable: true,
    build: (index) => buildWorkspaceRouteCheck(index, registry(claims()), true),
  },
  // The displaced branch is the one place a route verdict
  // legitimately touches SQL (the sibling-version list, then the durable
  // claim), so it is the one place a wedged or refusing pool could take the
  // verdict down with it. Both shared fault modes below hit it: `wedgedPool`
  // HANGS the version-list statement (the deadline must convert that into a
  // fault verdict) and `faultyPool` REJECTS it (gateFault must convert that
  // into a fault verdict). Either way: a boolean, never a hang, never an
  // escaped exception.
  {
    name: 'route check (displaced branch: minted sibling-version id)',
    durable: true,
    build: (index) => buildWorkspaceRouteCheck(index, registry(claims()), true, { displacedScanDeadlineMs: 50 }),
    documentId: displacedDocumentId,
  },
  {
    name: 'access check (org member)',
    durable: true,
    build: (index, pool) => buildAccessCheck(pool, index, registry(claims())),
  },
  {
    name: 'access check (platform admin on a routed socket)',
    durable: true,
    build: (index, pool) => buildAccessCheck(pool, index, registry(claims({ isPlatformAdmin: true }))),
  },
  {
    name: 'write check (org member)',
    durable: true,
    build: (index, pool) => buildWriteCheck(pool, index, registry(claims())),
  },
  // The mint's placement branch, on a NON-ADMIN session — and the two rows
  // that matter most in this table, because they are the only ones that reach
  // the grant lookup at all.
  //
  // A platform-admin row would return at `claims.isPlatformAdmin && …` before
  // any SQL and pass while proving nothing. An unindexed-document row returns
  // at `if (!workspace) return false`, one line earlier. Only these rows reach
  // the gate's LAST await — `computeWorkspaceKeySets`, whose `FROM versions`
  // read `wedgedPool` hangs, bounded by `keySetsDeadlineMs`. A brand-new
  // document walks this whole chain, in a burst, during a bulk import.
  {
    name: 'access check (org member, MINTED document: placement succeeds, grants are read)',
    durable: true,
    build: (index, pool) => buildAccessCheck(pool, index, registry(claims()), { keySetsDeadlineMs: 50 }),
    documentId: mintedDocumentId,
  },
  {
    name: 'write check (org member, MINTED document: placement succeeds, grants are read)',
    durable: true,
    build: (index, pool) => buildWriteCheck(pool, index, registry(claims()), { keySetsDeadlineMs: 50 }),
    documentId: mintedDocumentId,
  },
  // Baseline write fence: hang / reject. The fence's verdict comes from the static-baseline tables and process memory
  // ONLY: it takes no repo and no doc index, so a mutant that reads the root
  // document to learn `registrySummaryOnly` cannot even be plumbed without
  // tripping these rows (wedgedRepo's find never settles). `faultyPool`
  // REJECTS its SQL (the catch must convert that into a bounded fail-closed
  // verdict); the HANG mode — its own statements never settling — is driven
  // by `staticWedgedPool` in the dedicated fault test below, because the
  // shared `wedgedPool` deliberately answers the static tables (see its doc).
  {
    name: 'baseline write fence (static baseline lookup)',
    durable: true,
    build: (_index, pool) => buildBaselineWriteFence(pool, { lookupDeadlineMs: 50 }),
  },
  // The DB-free mode is not just a test affordance: it is the branch that falls
  // through to the full workspace-catalog walk, so it must obey the invariant too.
  {
    name: 'route check (durable registry disabled)',
    durable: false,
    build: (index) => buildWorkspaceRouteCheck(index, registry(claims()), true),
  },
  {
    name: 'access check (durable registry disabled)',
    durable: false,
    build: (index, pool) => buildAccessCheck(pool, index, registry(claims())),
  },
  {
    name: 'write check (durable registry disabled)',
    durable: false,
    build: (index, pool) => buildWriteCheck(pool, index, registry(claims())),
  },
]

describe('sync authorization boundary — liveness invariant', () => {
  for (const gate of GATES) {
    it(`reaches a verdict without resolving a document: ${gate.name}`, async () => {
      const pool = wedgedPool()
      const index = new WorkspaceDocIndex(wedgedRepo(), pool, { durable: gate.durable })
      const check = gate.build(index, pool)

      const documentId = gate.documentId ? await gate.documentId() : 'a-document-nobody-has-indexed'
      const verdict = await verdictWithin(check('peer-1', documentId))

      // Denying is fine. Allowing is fine. Never answering is a deadlock: the
      // caller is a per-socket FIFO or automerge-repo's share-policy
      // resolution, and neither can make progress until this settles.
      expect(verdict).not.toBe('NO_VERDICT_DEADLOCKED')
      expect(typeof verdict).toBe('boolean')
    })
  }

  // Same table, second fault mode. A hang and a rejection are the two ways a
  // gate fails to produce a verdict.
  for (const gate of GATES) {
    it(`produces a verdict when every DB statement rejects: ${gate.name}`, async () => {
      const pool = faultyPool()
      const index = new WorkspaceDocIndex(wedgedRepo(), pool, { durable: gate.durable })
      const check = gate.build(index, pool)

      const documentId = gate.documentId ? await gate.documentId() : 'a-document-nobody-has-indexed'
      const verdict = await verdictWithin(check('peer-1', documentId))

      expect(verdict).not.toBe('NO_VERDICT_DEADLOCKED')
      expect(typeof verdict).toBe('boolean')
    })
  }

  it('the walk itself settles when a handle resolves but never becomes ready', async () => {
    // Third fault mode, and the one a deadline on `find` does NOT cover.
    // `backfillWorkspaceRoute` is the repair every fail-closed deny depends on:
    // if the walk inside it never settles, the `routeBackfills` memo — evicted
    // only on REJECTION — pins a permanent no-op onto the workspace that most
    // needs repairing, and every subsequent deny for it becomes final.
    // A HEALTHY Postgres: the version row resolves and every document claim
    // succeeds, so the walk actually reaches `repo.find`. A pool that refuses
    // the claim makes `find()` return null before the handle is ever fetched,
    // and the test then passes without exercising anything.
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (/SELECT root_url FROM versions/.test(sql)) {
          return { rows: [{ root_url: NEVER_READY_URL }], rowCount: 1 }
        }
        if (/INSERT INTO automerge_document_workspace/.test(sql)) {
          return { rows: [{ document_id: String(params[0]) }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(notReadyRepo(), pool)

    const settled = await Promise.race([
      index.backfillWorkspaceRoute(WORKSPACE).then(() => 'RESOLVED', () => 'REJECTED'),
      new Promise((done) => setTimeout(() => done('NO_VERDICT_DEADLOCKED'), 3_000)),
    ])

    // Rejecting is the useful outcome — it is what evicts the memo — but the
    // assertion is liveness: anything but never answering.
    expect(settled).not.toBe('NO_VERDICT_DEADLOCKED')
  }, 15_000)

  it('a gate that fails closed on a DB fault requests a share-policy re-evaluation', async () => {
    // Fail-closed alone is not enough: automerge-repo pins the deny, so without
    // this the transient fault becomes a permanent "document unavailable" for
    // that (document, peer) — strictly worse than the error it came from.
    const pool = faultyPool()
    const index = new WorkspaceDocIndex(wedgedRepo(), pool)
    const asked: string[] = []
    index.onWorkspaceIndexRepaired = (key) => { asked.push(`${key.landscapeId}/${key.versionId}`) }

    expect(await verdictWithin(buildAccessCheck(pool, index, registry(claims()))('peer-1', 'doc-1'))).toBe(false)

    expect(asked).toContain(`${WORKSPACE.landscapeId}/${WORKSPACE.versionId}`)
  })

  it('tells the caller it FAILED rather than refused, on every cached gate', async () => {
    // A gate failing closed is indistinguishable downstream from a real
    // refusal — and on an indexed document the composed check classifies it as
    // a permanent RBAC denial, so it would never be re-evaluated. The fault
    // report is what lets fail-closed and deny pairing coexist.
    //
    // Asserted here, over the real gate builders, because `denyPairing.test.ts`
    // can only simulate the channel: its fake `authCheck` calls the reporter
    // itself, which proves the ledger rule but not that anything invokes it.
    const pool = faultyPool()
    const index = new WorkspaceDocIndex(wedgedRepo(), pool)
    const gates: Array<[string, (onFault: GateFaultReporter) => (p: string, d: string) => Promise<boolean>]> = [
      ['route', (onFault) => buildWorkspaceRouteCheck(index, registry(claims()), true, { onFault })],
      ['access', (onFault) => buildAccessCheck(pool, index, registry(claims()), { onFault })],
      ['write', (onFault) => buildWriteCheck(pool, index, registry(claims()), { onFault })],
    ]

    for (const [name, build] of gates) {
      const reported: Array<[string, string, unknown]> = []
      const check = build((peerId, documentId, workspace) => {
        reported.push([peerId, documentId, workspace])
      })

      expect(await verdictWithin(check('peer-1', 'doc-1'))).toBe(false)

      // The workspace is not decoration: the ledger stores it to drive
      // `scheduleRepair`, so dropping it disarms gate-fault repair entirely.
      expect(reported, `${name} gate did not report its fault`)
        .toEqual([['peer-1', 'doc-1', WORKSPACE]])
    }
  })

  it('a displaced-branch fault is REPORTED, in both fault modes', async () => {
    // The two displaced liveness rows prove verdict-boolean-never-hang, but
    // not that the fault reached the ledger — a mutant that loses the
    // deny<->ledger pairing on exactly this branch would pass them.
    for (const [mode, makePool] of [['rejects', faultyPool], ['hangs', wedgedPool]] as const) {
      const pool = makePool()
      const index = new WorkspaceDocIndex(wedgedRepo(), pool)
      const onFault = vi.fn()
      const check = buildWorkspaceRouteCheck(index, registry(claims()), true, {
        displacedScanDeadlineMs: 50,
        onFault,
      })
      const documentId = await displacedDocumentId()
      expect(await verdictWithin(check('peer-1', documentId))).toBe(false)
      expect(onFault, `displaced fault not reported when the pool ${mode}`).toHaveBeenCalled()
    }
  })

  it('a baseline-fence fault is REPORTED and fails closed, in both fault modes', async () => {
    // Same shape as the displaced-branch row above: the liveness rows prove
    // verdict-boolean-never-hang, but not that the fault reached the
    // reporter — a mutant that swallows the failure into a silent allow or a
    // silent deny with no fault report would pass them. The 'hangs' half is
    // ALSO the fence's hang row:
    // `staticWedgedPool` wedges exactly the fence's own statements, so only
    // the injected deadline can produce the bounded fail-closed verdict
    // asserted here. The fence knows no workspace, so it reports null.
    for (const [mode, makePool] of [['rejects', faultyPool], ['hangs', staticWedgedPool]] as const) {
      const pool = makePool()
      const onFault = vi.fn()
      const check = buildBaselineWriteFence(pool, { lookupDeadlineMs: 50, onFault })
      expect(await verdictWithin(check('peer-1', 'a-base-shard-doc'))).toBe(false)
      expect(onFault, `baseline-fence fault not reported when the pool ${mode}`)
        .toHaveBeenCalledWith('peer-1', 'a-base-shard-doc', null)
    }
  })

  it('an unknown peer is rejected without touching the index at all', async () => {
    const pool = wedgedPool()
    const index = new WorkspaceDocIndex(wedgedRepo(), pool)
    const check = buildAccessCheck(pool, index, registry(undefined))
    expect(await verdictWithin(check('ghost', 'anything'))).toBe(false)
  })

  // ======================================================================
  // Coverage invalidation: the miss branch DE-COVERS the workspace, and
  // that write touches statements the shared fault pools above never reach:
  // `wedgedPool` hangs only the versions catalog and `faultyPool`'s rejection
  // is soaked up by resolveDurable before the miss branch runs. These two
  // rows drive the COVERAGE statements themselves through both fault modes.
  // Each uses its own workspace key: the local gap-mark is process-wide state,
  // and a key another test already gapped would skip the durable write and
  // let both mutants survive.
  // ======================================================================

  it('workspace-route+coverage-invalidation / wedgedPool: the invalidation write never enters the verdict', async () => {
    // Every coverage statement HANGS while the rest of the registry answers,
    // so the miss branch runs and its invalidation write can never settle.
    // Mutant killed: awaiting that write in the verdict — the frozen pool
    // freezes the per-socket FIFO and the sentinel below reports the deadlock.
    const pool = {
      query: (sql: string) => {
        if (/workspace_claim_coverage/.test(sql)) return new Promise(() => {})
        return Promise.resolve({ rows: [], rowCount: 0 })
      },
    } as unknown as pg.Pool
    const index = new WorkspaceDocIndex(wedgedRepo(), pool)
    const route = { landscapeId: 'L-cov-wedged', versionId: 'V-cov-wedged' }
    const check = buildWorkspaceRouteCheck(index, {
      identityForPeer: () => claims(),
      workspaceForPeer: () => route,
    }, true)

    const verdict = await verdictWithin(check('peer-1', 'a-document-nobody-has-indexed'))

    expect(verdict).not.toBe('NO_VERDICT_DEADLOCKED')
    expect(verdict).toBe(false)
  })

  it('workspace-route+coverage-invalidation / faultyPool: a rejected invalidation write is caught and the repair stays scheduled', async () => {
    // The coverage statements REJECT while everything else answers. The write
    // is fire-and-forget, so its rejection must be caught inside the index —
    // an escaped one becomes an unhandledRejection long after the verdict —
    // and the deny must still be liftable: the backfill was scheduled anyway.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const pool = {
        query: async (sql: string) => {
          if (/workspace_claim_coverage/.test(sql)) throw new Error('remaining connection slots are reserved')
          return { rows: [], rowCount: 0 }
        },
      } as unknown as pg.Pool
      const index = new WorkspaceDocIndex(wedgedRepo(), pool)
      const scheduled = vi.spyOn(index, 'scheduleWorkspaceRouteBackfill')
      const route = { landscapeId: 'L-cov-faulty', versionId: 'V-cov-faulty' }
      const check = buildWorkspaceRouteCheck(index, {
        identityForPeer: () => claims(),
        workspaceForPeer: () => route,
      }, true)

      const verdict = await verdictWithin(check('peer-1', 'a-document-nobody-has-indexed'))

      expect(verdict).toBe(false)
      expect(scheduled).toHaveBeenCalledWith(route)
      // Give the rejected fire-and-forget time to surface if it escaped.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
