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
 * The claim-coverage marker, end to end against fakes with REAL CAS
 * semantics.
 *
 * The core criterion lives in the first test: attaching a covered workspace
 * runs ZERO walks and schedules ZERO backfills — the walk is a repair path a
 * constat (a route-gate miss) triggers, never an attach cost. Every other test
 * pins one transition of the marker's lifecycle: who may
 * pose it (the CALLER of a complete pass, never the pass itself), who
 * de-covers (the route-gate constat), and why the CAS on
 * `invalidations` exists (an invalidation racing the repair must win).
 *
 * The coverage fake dispatches on what the STATEMENT says — a cover whose SQL
 * lost its `WHERE workspace_claim_coverage.invalidations` runs UNCONDITIONALLY
 * here, exactly as it would in Postgres, so the CAS mutant is observable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import {
  WorkspaceDocIndex,
  buildWorkspaceRouteCheck,
  notifyWorkspaceCreated,
  notifyWorkspaceDocumentsCreated,
  docScopeWalkStats,
  type WorkspaceKey,
} from './docScope.js'
import {
  coverWorkspace,
  invalidateWorkspaceCoverage,
  _resetWorkspaceClaimCoverageForTests,
} from './claimCoverage.js'
import { CLAIM_PROTOCOL_VERSION } from './documentClaims.js'

interface CoverageRow {
  covered: boolean
  protocol: number
  invalidations: number
  reason: string | null
}

/**
 * In-memory versions + claims + coverage tables. Coverage emulates Postgres
 * semantics FROM THE SQL TEXT: the cover honours its CAS
 * predicate only if the statement still carries it, the invalidation bumps by
 * whatever the DO UPDATE clause says and seeds whatever literal the VALUES
 * tuple carries, and the claim INSERT derives from the versions row — so the
 * named mutants (unconditional cover, forgotten bump, mutated seed, literal
 * VALUES) behave here as they would live. The DB-gated twin
 * (`claimCoverage.integration.test.ts`) pins the same shapes on real Postgres.
 */
function world(opts: {
  coverageReadFails?: () => boolean
  /** Hold the durable invalidation open until the returned promise
   * resolves, so the witness-read/commit race is arrangeable. */
  invalidationGate?: () => Promise<void>
} = {}) {
  const versions = new Map<string, string>() // 'landscape/version' -> rootUrl
  const owned = new Map<string, { landscape: string; version: string }>()
  const coverage = new Map<string, CoverageRow>()
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('workspace_claim_coverage')) {
        const k = `${String(params?.[0])}/${String(params?.[1])}`
        if (sql.trim().startsWith('SELECT')) {
          if (opts.coverageReadFails?.()) throw new Error('coverage read refused')
          const row = coverage.get(k)
          return row
            ? { rows: [{ covered: row.covered, protocol: row.protocol, invalidations: String(row.invalidations) }], rowCount: 1 }
            : { rows: [], rowCount: 0 }
        }
        if (sql.includes('invalidated_reason')) {
          if (opts.invalidationGate) await opts.invalidationGate()
          const bump = /invalidations\s*=\s*workspace_claim_coverage\.invalidations\s*\+\s*(\d+)/.exec(sql)
          const seed = /,\s*(\d+),\s*now\(\)/.exec(sql)
          const row = coverage.get(k)
          if (row) {
            row.covered = false
            row.invalidations += bump ? Number(bump[1]) : 0
            row.reason = String(params?.[3])
          } else {
            coverage.set(k, {
              covered: false,
              protocol: Number(params?.[2]),
              invalidations: seed ? Number(seed[1]) : 0,
              reason: String(params?.[3]),
            })
          }
          return { rows: [], rowCount: 1 }
        }
        if (sql.trim().startsWith('UPDATE')) {
          // The non-'0'-witness cover: UPDATE only, CAS in the WHERE — a row
          // that vanished (or a counter that moved) matches nothing.
          const cas = /invalidations\s*=\s*\$4/.test(sql)
          const row = coverage.get(k)
          if (!row || (cas && row.invalidations !== Number(params?.[3]))) return { rows: [], rowCount: 0 }
          row.covered = true
          row.protocol = Number(params?.[2])
          return { rows: [{ covered: true }], rowCount: 1 }
        }
        // The first-cover upsert ('0' witness): the INSERT seeds the literal
        // the statement carries; ON CONFLICT re-covers only under its CAS.
        const cas = /WHERE workspace_claim_coverage\.invalidations\s*=\s*(\d+)/.exec(sql)
        const seed = /,\s*(\d+),\s*now\(\)/.exec(sql)
        const row = coverage.get(k)
        if (!row) {
          coverage.set(k, {
            covered: true,
            protocol: Number(params?.[2]),
            invalidations: seed ? Number(seed[1]) : 0,
            reason: null,
          })
          return { rows: [{ covered: true }], rowCount: 1 }
        }
        if (cas && row.invalidations !== Number(cas[1])) return { rows: [], rowCount: 0 }
        row.covered = true
        row.protocol = Number(params?.[2])
        return { rows: [{ covered: true }], rowCount: 1 }
      }
      if (sql.includes('AS managed')) {
        // isServerManagedRoot's EXISTS probe: every workspace here is
        // server-managed, so a repointed entry.rootUrl is OBSERVABLE.
        return { rows: [{ managed: true }], rowCount: 1 }
      }
      if (sql.includes('SELECT root_url FROM versions')) {
        const k = `${String(params?.[0])}/${String(params?.[1])}`
        const rootUrl = versions.get(k)
        return rootUrl ? { rows: [{ root_url: rootUrl }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('SELECT true AS present')) {
        // claimWorkspaceDocuments' missing-version probe. Matched on its exact
        // projection, NOT on 'FROM versions' — claimDocument's single INSERT
        // also derives FROM versions and must fall through to the claims
        // branch below.
        const k = `${String(params?.[0])}/${String(params?.[1])}`
        return versions.has(k) ? { rows: [{ present: true }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (!sql.includes('automerge_document_workspace')) return { rows: [], rowCount: 0 }
      const isInsert = sql.trim().startsWith('INSERT')
      if (isInsert) {
        const first = params?.[0]
        const ids = Array.isArray(first) ? first as string[] : [String(first)]
        const landscape = String(params?.[1])
        const version = String(params?.[2])
        // Like Postgres: the claim INSERT derives landscape/version from the
        // versions row (JOIN/FROM versions) — no row, ZERO inserts, whatever
        // the caller passed as literals. This is what lets the plural hook's
        // missingVersion path be REAL here.
        if (/(JOIN|FROM)\s+versions/i.test(sql) && !versions.has(`${landscape}/${version}`)) {
          return { rows: [], rowCount: 0 }
        }
        const rows: { document_id: string }[] = []
        for (const id of ids) {
          if (!owned.has(id)) {
            owned.set(id, { landscape, version })
            rows.push({ document_id: id })
          }
        }
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('root_url')) {
        // resolveDurable
        const hit = owned.get(String(params?.[0]))
        return hit
          ? {
              rows: [{
                landscape_id: hit.landscape,
                version_id: hit.version,
                root_url: versions.get(`${hit.landscape}/${hit.version}`) ?? 'automerge:unknown',
                static_source: null,
                static_allowed: false,
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 }
      }
      const target = params?.[0]
      if (Array.isArray(target)) {
        const rows = target.filter((id) => owned.has(String(id))).map((id) => ({
          document_id: String(id),
          landscape_id: owned.get(String(id))!.landscape,
          version_id: owned.get(String(id))!.version,
        }))
        return { rows, rowCount: rows.length }
      }
      const winner = owned.get(String(target))
      return {
        rows: winner ? [{ landscape_id: winner.landscape, version_id: winner.version }] : [],
        rowCount: winner ? 1 : 0,
      }
    },
  } as unknown as pg.Pool
  return { pool, versions, owned, coverage }
}

/** A root whose walk COMPLETES (no meta, no shards): the cheapest workspace
 * whose backfill reaches `controlDocsComplete === true`. */
async function healthyRoot(repo: Repo): Promise<string> {
  const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
  await root.whenReady()
  return root.url
}

/** Wrap a repo so every `find` waits on a gate the test releases, and the
 * FIRST find is observable — how the racing tests order themselves around
 * "the walk has started but not finished". */
function gatedRepo(repo: Repo) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let sawFind!: () => void
  const firstFind = new Promise<void>((resolve) => { sawFind = resolve })
  let active = false
  const proxied = new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'find') {
        return async (url: string, options?: unknown) => {
          if (active) {
            sawFind()
            await gate
          }
          return (target as unknown as { find: (u: string, o?: unknown) => unknown }).find(url, options)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  return { repo: proxied as unknown as Repo, release, firstFind, activate: () => { active = true } }
}

const walkTotal = () => docScopeWalkStats().total

describe('É4-F — the claim-coverage marker', () => {
  beforeEach(() => {
    _resetWorkspaceClaimCoverageForTests()
  })

  it('attach of a covered workspace runs zero walks and schedules zero backfills', async () => {
    // The core criterion. The repo refuses every resolution so a single
    // find would fail loudly, and the schedule spy pins that not even a
    // memoized no-op backfill was asked for.
    const key: WorkspaceKey = { landscapeId: 'L-cov', versionId: 'V-cov' }
    const { pool, coverage } = world()
    coverage.set('L-cov/V-cov', { covered: true, protocol: CLAIM_PROTOCOL_VERSION, invalidations: 0, reason: null })
    const find = vi.fn(async () => { throw new Error('a covered attach must not resolve documents') })
    const index = new WorkspaceDocIndex({ find, handles: {} } as unknown as Repo, pool)
    const schedule = vi.spyOn(index, 'scheduleWorkspaceRouteBackfill')

    const before = walkTotal()
    index.preWarmWorkspaceRoute(key)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(walkTotal()).toBe(before)
    expect(find).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
  })

  it('attach of an uncovered workspace pre-warms exactly as before, and the walk CALLER poses the marker', async () => {
    // The migration path for existing workspaces: no marker → the pre-warm walks
    // once, and the `.then` of the backfill — the caller, after the complete
    // pass — covers, so the NEXT attach (and every process after) walks zero.
    const key: WorkspaceKey = { landscapeId: 'L-legacy', versionId: 'V-legacy' }
    const repo = new Repo({})
    const rootUrl = await healthyRoot(repo)
    const { pool, versions, coverage } = world()
    versions.set('L-legacy/V-legacy', rootUrl)
    const index = new WorkspaceDocIndex(repo, pool)

    const before = walkTotal()
    index.preWarmWorkspaceRoute(key)
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 5_000 })
    await vi.waitFor(() => {
      expect(coverage.get('L-legacy/V-legacy')?.covered).toBe(true)
    }, { timeout: 5_000 })
    expect(coverage.get('L-legacy/V-legacy')?.protocol).toBe(CLAIM_PROTOCOL_VERSION)

    // Second attach in the same process: the cover wrote through the local
    // cache, so not even the durable read is repeated — and no walk runs.
    const covered = walkTotal()
    index.preWarmWorkspaceRoute(key)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(walkTotal()).toBe(covered)
  })

  it('a coverage read failure falls back to the walk, never to a silent skip', async () => {
    // The dangerous direction is skipping: a covered-looking failure would
    // leave a workspace whose documents are NOT all claimed with no repair
    // path. Failure must read as "uncovered" and is never cached.
    const key: WorkspaceKey = { landscapeId: 'L-fail', versionId: 'V-fail' }
    const repo = new Repo({})
    const rootUrl = await healthyRoot(repo)
    const { pool, versions } = world({ coverageReadFails: () => true })
    versions.set('L-fail/V-fail', rootUrl)
    const index = new WorkspaceDocIndex(repo, pool)

    const before = walkTotal()
    index.preWarmWorkspaceRoute(key)
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 5_000 })
  })

  it('notifyWorkspaceCreated skips the priming walk when bootstrap covered the workspace', async () => {
    const repo = new Repo({})
    const rootUrl = await healthyRoot(repo)
    const { pool, versions } = world()
    versions.set('L-boot/V-boot', rootUrl)
    versions.set('L-plain/V-plain', rootUrl)
    new WorkspaceDocIndex(repo, pool)

    // The bootstrap publisher's shape: claims done, marker posed LAST (its
    // write-through is what the registration consults), notify after.
    await coverWorkspace(pool, { landscapeId: 'L-boot', versionId: 'V-boot' }, '0')
    const before = walkTotal()
    notifyWorkspaceCreated({ landscapeId: 'L-boot', versionId: 'V-boot', rootUrl })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(walkTotal()).toBe(before)

    // Control: the same notification without a marker still primes — the
    // mutant that skips unconditionally dies here.
    notifyWorkspaceCreated({ landscapeId: 'L-plain', versionId: 'V-plain', rootUrl })
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 5_000 })
  })

  it('a route-gate miss durably invalidates coverage and triggers exactly ONE repair', async () => {
    const key: WorkspaceKey = { landscapeId: 'L-miss', versionId: 'V-miss' }
    const real = new Repo({})
    const rootUrl = await healthyRoot(real)
    const { pool, versions, coverage } = world()
    versions.set('L-miss/V-miss', rootUrl)
    const gated = gatedRepo(real)
    const index = new WorkspaceDocIndex(gated.repo, pool)
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => key }, true)

    // A covered workspace with a MEMOIZED earlier walk — the exact state in
    // which a forgotten `routeBackfills.delete` turns the repair into a no-op.
    await index.backfillWorkspaceRoute(key)
    await coverWorkspace(pool, key, '0')
    const before = walkTotal()
    gated.activate()

    // Two misses back to back. Both deny; the FIRST is the constat.
    expect(await gate('peer', 'doc-nobody-claimed-1')).toBe(false)
    expect(await gate('peer', 'doc-nobody-claimed-2')).toBe(false)

    // Durable invalidation landed before any repair could finish (the walk is
    // held at the gate): covered=false, counter bumped ONCE, reason recorded.
    const row = () => coverage.get('L-miss/V-miss')
    await vi.waitFor(() => {
      expect(row()?.covered).toBe(false)
      expect(row()?.invalidations).toBe(1)
      expect(row()?.reason).toContain('route-gate miss')
    }, { timeout: 5_000 })

    // Exactly ONE repair walk — the purge made it schedulable, the memo and
    // cooldown deduped the second miss.
    gated.release()
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(walkTotal()).toBe(before + 1)

    // And the lifecycle closes: the repair's CALLER re-covered by CAS against
    // the counter it observed AFTER the constat.
    await vi.waitFor(() => { expect(row()?.covered).toBe(true) }, { timeout: 5_000 })
    expect(row()?.invalidations).toBe(1)
  })

  it('re-cover happens only from the repair caller and only when controlDocsComplete', async () => {
    // A workspace whose registry shard cannot be read: the walk runs but is
    // INCOMPLETE, the backfill rejects, and nothing may cover. The mutant
    // that poses the marker from inside `walkFrom` — or poses it despite
    // `controlDocsComplete === false` — leaves a covered-with-holes row here.
    const key: WorkspaceKey = { landscapeId: 'L-holes', versionId: 'V-holes' }
    const repo = new Repo({})
    const missingShard = 'automerge:2vGjSCzEqJMBjesZ2r5Nxwkd3X7B'
    const root = repo.create({ modelUrl: '', shardUrls: [missingShard] })
    await root.whenReady()
    const { pool, versions, coverage } = world()
    versions.set('L-holes/V-holes', root.url)
    const index = new WorkspaceDocIndex(repo, pool)

    const before = walkTotal()
    index.preWarmWorkspaceRoute(key)
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(coverage.get('L-holes/V-holes')?.covered ?? false).toBe(false)
  })

  it('an invalidation racing the repair wins: the CAS refuses to re-cover', async () => {
    const key: WorkspaceKey = { landscapeId: 'L-race', versionId: 'V-race' }
    const real = new Repo({})
    const rootUrl = await healthyRoot(real)
    const { pool, versions, coverage } = world()
    versions.set('L-race/V-race', rootUrl)
    const gated = gatedRepo(real)
    gated.activate()
    const index = new WorkspaceDocIndex(gated.repo, pool)

    // Uncovered attach: the pre-warm reads the CAS witness ('0') and starts
    // the walk, which the gate now holds mid-flight.
    index.preWarmWorkspaceRoute(key)
    await gated.firstFind

    // The constat lands while the walk is running.
    await invalidateWorkspaceCoverage(pool, key, 'raced the repair')
    expect(coverage.get('L-race/V-race')?.invalidations).toBe(1)

    gated.release()
    await vi.waitFor(() => {
      expect(coverage.get('L-race/V-race')).toBeDefined()
    }, { timeout: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 150))

    // The walk completed AFTER the invalidation: its cover CAS (expected 0,
    // found 1) must refuse — covered stays false until the walk the
    // invalidation itself scheduled completes with a fresh witness.
    expect(coverage.get('L-race/V-race')?.covered).toBe(false)
    expect(coverage.get('L-race/V-race')?.invalidations).toBe(1)
  })

  it('a coverage row with an older protocol reads as uncovered', async () => {
    // The free mass invalidation: bumping CLAIM_PROTOCOL_VERSION makes every
    // stored marker stale without touching a row. A mutant that drops the
    // comparison treats the old marker as live and skips the walk.
    const key: WorkspaceKey = { landscapeId: 'L-proto', versionId: 'V-proto' }
    const repo = new Repo({})
    const rootUrl = await healthyRoot(repo)
    const { pool, versions, coverage } = world()
    versions.set('L-proto/V-proto', rootUrl)
    coverage.set('L-proto/V-proto', {
      covered: true, protocol: CLAIM_PROTOCOL_VERSION - 1, invalidations: 0, reason: null,
    })
    const index = new WorkspaceDocIndex(repo, pool)

    const before = walkTotal()
    index.preWarmWorkspaceRoute(key)
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 5_000 })
  })

  it('a re-presented document never re-triggers invalidation: the constat licence is per document (M2)', async () => {
    // A stuck client can re-present the SAME unminted document on every
    // denyLedger reconcile (~30 s) — just past the workspace gap TTL. Were the
    // licence per workspace only, each pass would buy a fresh invalidation +
    // memo purge + FULL repair walk (~33 s at 10k documents), forever. The
    // licence is per (workspace, document): seen once, a document re-triggers
    // nothing; a NEW document (a real hole) still does.
    let now = 1_000_000
    const clock = () => now
    const key: WorkspaceKey = { landscapeId: 'L-perdoc', versionId: 'V-perdoc' }
    const repo = new Repo({})
    const rootUrl = await healthyRoot(repo)
    const { pool, versions, coverage } = world()
    versions.set('L-perdoc/V-perdoc', rootUrl)
    const index = new WorkspaceDocIndex(repo, pool, { clock })
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => key }, true)
    const row = () => coverage.get('L-perdoc/V-perdoc')

    await index.backfillWorkspaceRoute(key)
    await coverWorkspace(pool, key, '0')
    const base = walkTotal()

    // First sight of the stuck document: the constat fires ONCE and the
    // lifecycle closes (repair + CAS re-cover against the bumped counter).
    expect(await gate('peer', 'doc-stuck-forever')).toBe(false)
    await vi.waitFor(() => { expect(row()?.invalidations).toBe(1) }, { timeout: 5_000 })
    await vi.waitFor(() => { expect(row()?.covered).toBe(true) }, { timeout: 10_000 })
    expect(walkTotal()).toBe(base + 1)

    // Re-presentations past the TTL window: NO new invalidation, NO de-cover,
    // NO new walk — the mutant that drops the per-document half re-fires on
    // every iteration (the workspace gap has expired each time).
    for (let i = 0; i < 3; i++) {
      now += 31_000
      expect(await gate('peer', 'doc-stuck-forever')).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(row()?.invalidations).toBe(1)
      expect(row()?.covered).toBe(true)
      expect(walkTotal()).toBe(base + 1)
    }

    // A NEW unplaceable document is a NEW hole: it must still constat.
    now += 31_000
    expect(await gate('peer', 'doc-another-hole')).toBe(false)
    await vi.waitFor(() => { expect(row()?.invalidations).toBe(2) }, { timeout: 5_000 })
    await vi.waitFor(() => { expect(walkTotal()).toBe(base + 2) }, { timeout: 10_000 })
  })

  it('the repair sequences behind the constat’s durable invalidation before reading the CAS witness (m4)', async () => {
    // The witness-read/invalidation-commit race: the constat’s durable write
    // is held in flight. The repair must WAIT for it — a walk that reads the
    // witness early observes the stale counter, its re-cover CAS refuses, and
    // the workspace stays de-covered until the next attach.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let gateArmed = false
    const key: WorkspaceKey = { landscapeId: 'L-seq', versionId: 'V-seq' }
    const repo = new Repo({})
    const rootUrl = await healthyRoot(repo)
    const { pool, versions, coverage } = world({
      invalidationGate: () => (gateArmed ? held : Promise.resolve()),
    })
    versions.set('L-seq/V-seq', rootUrl)
    const index = new WorkspaceDocIndex(repo, pool)
    const gate = buildWorkspaceRouteCheck(index, { workspaceForPeer: () => key }, true)
    const row = () => coverage.get('L-seq/V-seq')

    await index.backfillWorkspaceRoute(key)
    await coverWorkspace(pool, key, '0')
    const before = walkTotal()
    gateArmed = true

    // The verdict itself never waits on the write (docScope.gateLiveness.test.ts), but
    // the repair does: no walk may run while the invalidation is in flight.
    expect(await gate('peer', 'doc-unplaceable')).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(walkTotal()).toBe(before)

    release()
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 10_000 })
    // The witness observed the bump, so the caller re-covered by CAS 1.
    await vi.waitFor(() => {
      expect(row()?.covered).toBe(true)
      expect(row()?.invalidations).toBe(1)
    }, { timeout: 5_000 })
  })

  it('the plural hook names a missing versions row for what it is (U5)', async () => {
    // The structured result splits missingVersion from foreign so the message
    // sends the reader to the bootstrap ORDER (claims follow INSERT versions),
    // never hunting a collision that did not happen.
    const { pool } = world()
    new WorkspaceDocIndex({ find: vi.fn() } as unknown as Repo, pool)
    await expect(notifyWorkspaceDocumentsCreated({
      landscapeId: 'L-nov', versionId: 'V-nov', rootUrl: 'automerge:zzz', documentIds: ['doc-a', 'doc-b'],
    })).rejects.toThrow(/no versions row exists — the claim must FOLLOW the INSERT INTO versions/)
  })

  it('the plural hook names a foreign winner as already assigned — with the winner (U5)', async () => {
    const { pool, versions, owned } = world()
    versions.set('L-for/V-for', 'automerge:root-for')
    owned.set('doc-stolen', { landscape: 'L2', version: 'V2' })
    new WorkspaceDocIndex({ find: vi.fn() } as unknown as Repo, pool)
    await expect(notifyWorkspaceDocumentsCreated({
      landscapeId: 'L-for', versionId: 'V-for', rootUrl: 'automerge:root-for', documentIds: ['doc-stolen'],
    })).rejects.toThrow(/already assigned to another workspace \(first: doc-stolen -> L2\/V2\)/)
  })

  it('a root rotation repoints entry.rootUrl even when the local marker says covered (U6)', async () => {
    // The covered branch of the registration SKIPS the priming walk — but it
    // must still run ensureEntry: a rotation funnels through the same hook,
    // and without the repoint the retired root stays protected while writes
    // land on the new canonical control document unguarded.
    const key: WorkspaceKey = { landscapeId: 'L-rot', versionId: 'V-rot' }
    const repo = new Repo({})
    const oldRoot = await healthyRoot(repo)
    const newRoot = await healthyRoot(repo)
    const { pool, versions } = world()
    versions.set('L-rot/V-rot', oldRoot)
    const index = new WorkspaceDocIndex(repo, pool)

    // Prime the entry on the OLD root through the ordinary (uncovered) hook.
    const before = walkTotal()
    notifyWorkspaceCreated({ landscapeId: 'L-rot', versionId: 'V-rot', rootUrl: oldRoot })
    await vi.waitFor(() => { expect(walkTotal()).toBe(before + 1) }, { timeout: 5_000 })
    expect(await index.isServerManagedRoot(oldRoot.replace('automerge:', ''), key)).toBe(true)

    // Covered NOW (bootstrap write-through), then the ROTATION funnels
    // through the same hook: the covered branch must still repoint.
    await coverWorkspace(pool, key, '0')
    versions.set('L-rot/V-rot', newRoot)
    const covered = walkTotal()
    notifyWorkspaceCreated({ landscapeId: 'L-rot', versionId: 'V-rot', rootUrl: newRoot })

    expect(await index.isServerManagedRoot(newRoot.replace('automerge:', ''), key)).toBe(true)
    expect(await index.isServerManagedRoot(oldRoot.replace('automerge:', ''), key)).toBe(false)
    // …and the covered branch scheduled no walk while doing it.
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(walkTotal()).toBe(covered)
  })
})
