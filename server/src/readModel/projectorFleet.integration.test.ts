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

import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { ensureReadModelSchema } from './schema.js'
import { ProjectorFleet, DEFAULT_WORKSPACE_KEY, type RootResolver } from './projectorService.js'
import { roObject } from './queries.js'
import type { WorkspaceKey } from './projector.js'
import { guardIdleClientErrors } from '../db/poolErrorGuard.js'

/**
 * `ProjectorFleet`: LRU-capped multi-workspace supervisor. Isolated schema; skips when no DB is
 * reachable. Uses a small in-process Automerge repo per workspace + a fake
 * `RootResolver` (keyed by landscapeId) so this stays fast and independent of
 * the real `landscapes`/`versions` tables.
 */
const URL = process.env.DATABASE_URL ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'

async function probePool(): Promise<pg.Pool | null> {
  const p = guardIdleClientErrors(new pg.Pool({ connectionString: URL, max: 4, connectionTimeoutMillis: 4000, options: '-c search_path=projectorfleet_test,public' }), 'projectorFleet')
  try {
    const c = await p.connect()
    try {
      await c.query('CREATE SCHEMA IF NOT EXISTS projectorfleet_test')
      await ensureReadModelSchema({ query: (text, params) => c.query(text, params) } as never)
    } finally {
      c.release()
    }
    return p
  } catch {
    await p.end().catch(() => {})
    return null
  }
}

const pool = await probePool()
const suite = pool ? describe : describe.skip
if (!pool) console.warn(`[projector fleet] no Postgres at ${URL} — skipping`)

/** Build a tiny sharded workspace (one object) in a shared repo and return its
 * root URL. Repos are shared across workspaces within a test (mirrors one
 * Automerge server process hosting many roots). */
function makeWorkspaceRoot(repo: Repo, objectName: string): string {
  const meta = repo.create({ objectShardUrls: [repo.create({ objects: { o1: { id: 'o1', name: objectName } } }).url], connectionShardUrls: [], groups: {} })
  const root = repo.create({ modelMetaUrl: meta.url, modelUrl: '', shardUrls: [] })
  return root.url
}

suite('ProjectorFleet (R6 per-workspace supervisor)', () => {
  afterAll(async () => {
    const c = await pool!.connect()
    try {
      await c.query('DROP SCHEMA IF EXISTS projectorfleet_test CASCADE')
    } finally {
      c.release()
      await pool!.end()
    }
  })
  beforeEach(async () => {
    await ensureReadModelSchema(pool!)
    await pool!.query(`TRUNCATE ro_objects, ro_connections, ro_groups, ro_diagrams`)
  })

  it('ensure() cold-builds a not-yet-resident workspace and is a no-op hit thereafter', async () => {
    const repo = new Repo({})
    const rootA = makeWorkspaceRoot(repo, 'Alpha')
    const roots: Record<string, string> = { a: rootA }
    const resolveRoot: RootResolver = async (landscapeId) => (landscapeId ? roots[landscapeId] ?? null : null)
    const fleet = new ProjectorFleet(repo, resolveRoot, { fallbackRootUrl: rootA, db: pool!, maxProjectors: 8 })

    const keyA: WorkspaceKey = { landscapeId: 'a', versionId: 'v1' }
    expect(fleet.isResident(keyA)).toBe(false)
    expect(await fleet.ensure(keyA)).toBe(true)
    expect(fleet.isResident(keyA)).toBe(true)
    expect((await roObject(pool!, keyA, 'o1'))?.name).toBe('Alpha')

    // Second ensure() of the same key is a resident hit — no error re-cold-building.
    expect(await fleet.ensure(keyA)).toBe(true)
    expect(fleet.size()).toBe(1)
    fleet.stopAll()
  })

  it('ensure() returns false (caller 404s) for a workspace that does not resolve', async () => {
    const repo = new Repo({})
    const resolveRoot: RootResolver = async () => null
    const fleet = new ProjectorFleet(repo, resolveRoot, { fallbackRootUrl: 'irrelevant', db: pool!, maxProjectors: 8 })
    expect(await fleet.ensure({ landscapeId: 'missing', versionId: 'v1' })).toBe(false)
    expect(fleet.size()).toBe(0)
  })

  it('concurrent ensure() calls for the same not-yet-resident key share one in-flight cold build', async () => {
    const repo = new Repo({})
    const rootA = makeWorkspaceRoot(repo, 'Alpha')
    const resolveRoot: RootResolver = async () => rootA
    const fleet = new ProjectorFleet(repo, resolveRoot, { fallbackRootUrl: rootA, db: pool!, maxProjectors: 8 })
    const key: WorkspaceKey = { landscapeId: 'a', versionId: 'v1' }

    const [r1, r2, r3] = await Promise.all([fleet.ensure(key), fleet.ensure(key), fleet.ensure(key)])
    expect([r1, r2, r3]).toEqual([true, true, true])
    expect(fleet.size()).toBe(1) // one projector, not three
    fleet.stopAll()
  })

  it('LRU cap 2: ensuring a 3rd workspace evicts the least-recently-used, detaching its listeners but keeping its rows', async () => {
    const repo = new Repo({})
    const roots: Record<string, string> = {
      a: makeWorkspaceRoot(repo, 'Alpha'),
      b: makeWorkspaceRoot(repo, 'Beta'),
      c: makeWorkspaceRoot(repo, 'Gamma'),
    }
    const resolveRoot: RootResolver = async (landscapeId) => (landscapeId ? roots[landscapeId] ?? null : null)
    const fleet = new ProjectorFleet(repo, resolveRoot, { fallbackRootUrl: roots.a, db: pool!, maxProjectors: 2 })
    const keyA: WorkspaceKey = { landscapeId: 'a', versionId: 'v1' }
    const keyB: WorkspaceKey = { landscapeId: 'b', versionId: 'v1' }
    const keyC: WorkspaceKey = { landscapeId: 'c', versionId: 'v1' }

    await fleet.ensure(keyA)
    await fleet.ensure(keyB)
    expect(fleet.size()).toBe(2)
    expect(fleet.isResident(keyA)).toBe(true)
    expect(fleet.isResident(keyB)).toBe(true)

    // A is now the LRU (B was ensured after A, and neither re-ensured since) —
    // ensuring C must evict A, not B.
    await fleet.ensure(keyC)
    expect(fleet.size()).toBe(2)
    expect(fleet.isResident(keyA)).toBe(false) // evicted
    expect(fleet.isResident(keyB)).toBe(true)
    expect(fleet.isResident(keyC)).toBe(true)

    // A's rows are KEPT despite eviction (cache semantics, not a delete).
    expect((await roObject(pool!, keyA, 'o1'))?.name).toBe('Alpha')

    // Re-ensuring the evicted workspace re-walks it (idempotent upsert) and
    // makes it resident again — this time evicting B (now the LRU).
    expect(await fleet.ensure(keyA)).toBe(true)
    expect(fleet.isResident(keyA)).toBe(true)
    expect(fleet.isResident(keyB)).toBe(false)
    expect((await roObject(pool!, keyA, 'o1'))?.name).toBe('Alpha') // re-walk reproduced the same row
    fleet.stopAll()
  })

  it('recency: re-ensuring a resident workspace protects it from eviction (true LRU, not insertion order)', async () => {
    const repo = new Repo({})
    const roots: Record<string, string> = {
      a: makeWorkspaceRoot(repo, 'Alpha'),
      b: makeWorkspaceRoot(repo, 'Beta'),
      c: makeWorkspaceRoot(repo, 'Gamma'),
    }
    const resolveRoot: RootResolver = async (landscapeId) => (landscapeId ? roots[landscapeId] ?? null : null)
    const fleet = new ProjectorFleet(repo, resolveRoot, { fallbackRootUrl: roots.a, db: pool!, maxProjectors: 2 })
    const keyA: WorkspaceKey = { landscapeId: 'a', versionId: 'v1' }
    const keyB: WorkspaceKey = { landscapeId: 'b', versionId: 'v1' }
    const keyC: WorkspaceKey = { landscapeId: 'c', versionId: 'v1' }

    await fleet.ensure(keyA)
    await fleet.ensure(keyB)
    await fleet.ensure(keyA) // touch A again — B is now the LRU, not A

    await fleet.ensure(keyC)
    expect(fleet.isResident(keyA)).toBe(true) // protected by the touch
    expect(fleet.isResident(keyB)).toBe(false) // evicted instead
    expect(fleet.isResident(keyC)).toBe(true)
    fleet.stopAll()
  })

  it('default-workspace compat: workspaceFromReq-style no-params resolves to DEFAULT_WORKSPACE_KEY via the (undefined,undefined)+fallback path', async () => {
    const repo = new Repo({})
    const defaultRoot = makeWorkspaceRoot(repo, 'DefaultLandscape')
    // Mirrors resolveRootUrl's real contract: undefined/undefined -> the
    // fallback root (never a miss) for the implicit default workspace.
    const resolveRoot: RootResolver = async (landscapeId, versionId, fallback) =>
      landscapeId === undefined && versionId === undefined ? fallback : null
    const fleet = new ProjectorFleet(repo, resolveRoot, { fallbackRootUrl: defaultRoot, db: pool!, maxProjectors: 8 })

    expect(await fleet.ensure(DEFAULT_WORKSPACE_KEY)).toBe(true)
    expect((await roObject(pool!, DEFAULT_WORKSPACE_KEY, 'o1'))?.name).toBe('DefaultLandscape')
    fleet.stopAll()
  })

  it('pin keeps the default workspace out of the LRU eviction candidates', async () => {
    const repo = new Repo({})
    const roots: Record<string, string> = { b: makeWorkspaceRoot(repo, 'Beta'), c: makeWorkspaceRoot(repo, 'Gamma') }
    const defaultRoot = makeWorkspaceRoot(repo, 'Default')
    const resolveRoot: RootResolver = async (landscapeId, versionId, fallback) => {
      if (landscapeId === undefined && versionId === undefined) return fallback
      return landscapeId ? roots[landscapeId] ?? null : null
    }
    const fleet = new ProjectorFleet(repo, resolveRoot, { fallbackRootUrl: defaultRoot, db: pool!, maxProjectors: 1 })

    await fleet.ensure(DEFAULT_WORKSPACE_KEY)
    fleet.pin(DEFAULT_WORKSPACE_KEY)
    expect(fleet.isResident(DEFAULT_WORKSPACE_KEY)).toBe(true)

    // Cap is 1 and the default is pinned+already counted — ensuring ANY other
    // workspace must evict nothing else resident (nothing else is), and must
    // NOT touch the pinned default even though it's technically "over cap".
    await fleet.ensure({ landscapeId: 'b', versionId: 'v1' })
    expect(fleet.isResident(DEFAULT_WORKSPACE_KEY)).toBe(true)
    // WHAT A PIN ACTUALLY COSTS. It does not RESERVE a slot — it makes the cap
    // be EXCEEDED: with `maxProjectors: 1`, two projectors are resident. Pinned
    // entries are simply skipped as eviction candidates, so the fleet's real
    // ceiling is `cap + pins`.
    expect(fleet.isResident({ landscapeId: 'b', versionId: 'v1' })).toBe(true)
    expect(fleet.snapshot().residentProjectors).toBe(2)
    fleet.stopAll()
  })

  it('T-MB — a cell that does not own the default workspace loses nothing to the pin', async () => {
    // Boot pins the default workspace on every cell. This arm checks that the
    // pin does not spend an LRU place on a cell that does not own it: the cell
    // pins the default workspace anyway — exactly what boot does — and then
    // fills its cap with workspaces it DOES own.
    const repo = new Repo({})
    const roots: Record<string, string> = { b: makeWorkspaceRoot(repo, 'Beta'), c: makeWorkspaceRoot(repo, 'Gamma') }
    const defaultRoot = makeWorkspaceRoot(repo, 'Default')
    const resolveRoot: RootResolver = async (landscapeId, versionId, fallback) => {
      if (landscapeId === undefined && versionId === undefined) return fallback
      return landscapeId ? roots[landscapeId] ?? null : null
    }
    const fleet = new ProjectorFleet(repo, resolveRoot, {
      fallbackRootUrl: defaultRoot,
      db: pool!,
      maxProjectors: 2,
      // A cell dedicated to a group that does NOT contain the default workspace
      // — which is `{ landscapeId: 'default', versionId: 'current' }`, so the
      // predicate has to name it rather than test for an absent landscape.
      ownsWorkspace: (key) => key.landscapeId !== DEFAULT_WORKSPACE_KEY.landscapeId,
    })

    // Boot's unconditional pin, on a cell that does not own the subject.
    fleet.pin(DEFAULT_WORKSPACE_KEY)
    await expect(fleet.ensure(DEFAULT_WORKSPACE_KEY)).rejects.toThrow()
    expect(fleet.isResident(DEFAULT_WORKSPACE_KEY)).toBe(false)

    // BOTH owned workspaces fit. If the pin cost a place, one of these would
    // have evicted the other.
    expect(await fleet.ensure({ landscapeId: 'b', versionId: 'v1' })).toBe(true)
    expect(await fleet.ensure({ landscapeId: 'c', versionId: 'v1' })).toBe(true)
    expect(fleet.isResident({ landscapeId: 'b', versionId: 'v1' })).toBe(true)
    expect(fleet.isResident({ landscapeId: 'c', versionId: 'v1' })).toBe(true)
    expect(fleet.snapshot().residentProjectors).toBe(2)
    fleet.stopAll()
  })

  it('T-MB — a pin stops protecting a workspace this cell no longer owns', async () => {
    // Pinning is conditioned on ownership. A pin is a standing instruction
    // taken at boot; if `evictIfOverCap` honoured it without re-asking whether
    // this cell still speaks for the workspace, ownership moving away from a
    // RESIDENT pinned workspace would leave an entry the LRU could never
    // reclaim (the fleet snapshot counts these as `foreignResidentProjectors`).
    //
    // Guards `entry.pinned && this.ownsWorkspace(entry.key)`: with `entry.pinned`
    // alone, the pinned-but-foreign workspace survives and `b` is refused a place.
    const repo = new Repo({})
    const roots: Record<string, string> = { b: makeWorkspaceRoot(repo, 'Beta') }
    const defaultRoot = makeWorkspaceRoot(repo, 'Default')
    const resolveRoot: RootResolver = async (landscapeId, versionId, fallback) => {
      if (landscapeId === undefined && versionId === undefined) return fallback
      if (landscapeId === DEFAULT_WORKSPACE_KEY.landscapeId) return defaultRoot
      return landscapeId ? roots[landscapeId] ?? null : null
    }
    let ownsDefault = true
    const fleet = new ProjectorFleet(repo, resolveRoot, {
      fallbackRootUrl: defaultRoot,
      db: pool!,
      maxProjectors: 1,
      ownsWorkspace: (key) =>
        (key.landscapeId === DEFAULT_WORKSPACE_KEY.landscapeId ? ownsDefault : true),
    })

    // Owned, resident and pinned — the ordinary state on the cell that serves it.
    await fleet.ensure(DEFAULT_WORKSPACE_KEY)
    fleet.pin(DEFAULT_WORKSPACE_KEY)
    expect(fleet.isResident(DEFAULT_WORKSPACE_KEY)).toBe(true)
    expect(fleet.snapshot().foreignResidentProjectors).toBe(0)

    // Ownership moves. The entry is still resident and still pinned — this is
    // the window, and the fleet counts it.
    ownsDefault = false
    expect(fleet.snapshot().foreignResidentProjectors).toBe(1)

    // The cap is 1 and the pinned entry is now FOREIGN, so it must not be
    // protected: `b` takes the place.
    expect(await fleet.ensure({ landscapeId: 'b', versionId: 'v1' })).toBe(true)
    expect(fleet.isResident({ landscapeId: 'b', versionId: 'v1' })).toBe(true)
    expect(fleet.isResident(DEFAULT_WORKSPACE_KEY)).toBe(false)
    expect(fleet.snapshot().residentProjectors).toBe(1)
    fleet.stopAll()
  })
})
