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

import type { Pool } from 'pg'
import type { WorkspaceKey } from '../rbac/docScope.js'

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,160}$/

export type ParsedWorkspaceRoute =
  | { kind: 'not-automerge' }
  | { kind: 'legacy' }
  | { kind: 'invalid' }
  | { kind: 'workspace'; workspace: WorkspaceKey }

/** Parse, but never trust, the workspace declared on the WebSocket URL. */
export function parseWorkspaceRoute(requestUrl: string | undefined): ParsedWorkspaceRoute {
  if (!requestUrl) return { kind: 'not-automerge' }
  let url: URL
  try {
    url = new URL(requestUrl, 'http://sync.invalid')
  } catch {
    return { kind: 'not-automerge' }
  }
  if (url.pathname !== '/automerge') return { kind: 'not-automerge' }

  const landscapes = url.searchParams.getAll('landscapeId')
  const versions = url.searchParams.getAll('versionId')
  if (landscapes.length === 0 && versions.length === 0) return { kind: 'legacy' }
  if (landscapes.length !== 1 || versions.length !== 1) return { kind: 'invalid' }
  const landscapeId = landscapes[0]
  const versionId = versions[0]
  if (!WORKSPACE_ID.test(landscapeId) || !WORKSPACE_ID.test(versionId)) return { kind: 'invalid' }
  return { kind: 'workspace', workspace: { landscapeId, versionId } }
}

/** Resolve the moving `current` alias and verify the concrete version is still
 * active. This database result, never the query string, is bound to the socket. */
export async function resolveWorkspaceRoute(
  db: Pool,
  requested: WorkspaceKey,
): Promise<WorkspaceKey | null> {
  const { rows } = requested.versionId === 'current'
    ? await db.query<{ landscape_id: string; version_id: string }>(
        `SELECT l.id AS landscape_id, v.id AS version_id
         FROM landscapes l
         JOIN versions v ON v.id = l.default_version_id AND v.landscape_id = l.id
         WHERE l.id = $1 AND v.status = 'active'`,
        [requested.landscapeId],
      )
    : await db.query<{ landscape_id: string; version_id: string }>(
        `SELECT landscape_id, id AS version_id
         FROM versions
         WHERE landscape_id = $1 AND id = $2 AND status = 'active'`,
        [requested.landscapeId, requested.versionId],
      )
  const row = rows[0]
  return row ? { landscapeId: row.landscape_id, versionId: row.version_id } : null
}

/**
 * THE WORKSPACE A DRAFT MERGE WRITES: the draft's PARENT, which is a database
 * read.
 *
 * `POST /api/landscapes/:landscapeId/drafts/:draftId/merge` names a DRAFT, and
 * `applyMerge` writes that draft's parent version. So the router cannot place
 * this request from the URL alone — `workspaceRouteExtractors.ts` answers
 * `needs-lookup` for it and this is the lookup.
 *
 * ## The handler's predicate, but READ rather than filtered on
 *
 * `index.ts`'s merge handler runs `WHERE id = $1 AND landscape_id = $2 AND
 * kind = 'draft'` to decide which version's write grant to check. Placement and
 * authorization have to agree about what a draft is, so `kind` is the same
 * column — but it is SELECTED here, because a router that filtered it could not
 * distinguish "no such version" from "that version is not a draft", and only
 * the first of those is safe to hand back to Express. See `MergeParentPlacement`.
 *
 * ## No filter on the DRAFT's status, and that is load-bearing
 *
 * A draft that is already `merged` is a legitimate retry: `applyMerge` answers
 * `{ ok: true, versionId: '' }` for it, which the route turns into HTTP 200. A
 * `status = 'active'` filter would return null here, the router would hand the
 * request back to Express, and the retry would execute on the LANDING cell —
 * an unrouted write manufactured by the code that exists to remove unrouted
 * writes.
 *
 * The PARENT's status needs no filter either: every `UPDATE versions` that
 * touches `status` is scoped `WHERE kind = 'draft'` (`draft/applyMerge.ts`,
 * `landscapes.ts`), and `createDraft` sets
 * `parent_version_id` to the landscape's
 * `default_version_id`, which is never a draft. So the parent this returns is
 * always `active`, and `resolveWorkspaceRoute` — which DOES filter on
 * `status = 'active'` — resolves it.
 *
 * ## It throws rather than returning null on a database failure
 *
 * `null` is an answer with a consequence: the router hands the request back to
 * Express, so the merge runs locally. A `catch` that folded a connection error
 * into `null` would convert every database blip into a silent unrouted write.
 * The caller's own `try` answers 503 instead, which is the honest shape.
 * `mergeParentRoute.integration.test.ts` exercises this statement against a
 * real Postgres, because the injected seam the unit tests use would otherwise
 * leave the SQL itself with no coverage.
 */
export type MergeParentPlacement =
  /** The draft names a parent, and that parent is the workspace to route to. */
  | { kind: 'workspace'; workspace: WorkspaceKey }
  /** NO ROW AT ALL. The router hands the request back to Express, and that is
   *  safe because `resolveRootUrl`
   *  (`landscapes.ts`) answers null for an unknown version, so `index.ts`'s
   *  `if (candidate)` is false and NOTHING is written before `applyMerge`'s own
   *  404. This is the only one of the three misses where a pass-through is
   *  safe. */
  | { kind: 'no-such-draft' }
  /**
   * THE ROW EXISTS AND CANNOT BE MERGED — router 404, not a pass-through.
   *
   * Two ways in, and the distinction from `no-such-draft` is the whole reason
   * this type has three members instead of two: here `resolveRootUrl` DOES
   * resolve, because it has no `kind` filter of its own, so a pass-through
   * reaches `ensureCanonicalWorkspaceRoot(key, …)` — which can publish a fresh
   * root and compare-and-swap `versions.root_url` on a cell whose ownership of
   * that workspace the router never checked.
   *
   *   `not-a-draft`: `POST /api/landscapes/L/drafts/V-live/merge` where
   *   `V-live` is an ordinary version. The handler's own lookup is
   *   `kind = 'draft'`, so it finds no parent and rotates the ORDINARY
   *   version's root on the way to a 404. Filtering `kind` in SQL would make
   *   this case indistinguishable from "no such row".
   *
   *   `no-parent`: a draft row whose `parent_version_id` is NULL. `createDraft`
   *   always sets one, so this is a legacy or imported row rather than
   *   something the product makes.
   *
   * 404 is the same answer `applyMerge` reaches — it cannot merge without a
   * parent — arrived at before any document is touched.
   */
  | { kind: 'unplaceable'; reason: 'not-a-draft' | 'no-parent' }

export async function resolveMergeParentWorkspace(
  db: Pool,
  landscapeId: string,
  draftId: string,
): Promise<MergeParentPlacement> {
  // `kind` is SELECTED, not filtered on. Filtering would fold "this version is
  // not a draft" into "there is no such version", and those two need different
  // answers — see `unplaceable`.
  const { rows } = await db.query<{ landscape_id: string; parent_version_id: string | null; kind: string }>(
    `SELECT landscape_id, parent_version_id, kind
     FROM versions
     WHERE id = $1 AND landscape_id = $2`,
    [draftId, landscapeId],
  )
  const row = rows[0]
  if (!row) return { kind: 'no-such-draft' }
  if (row.kind !== 'draft') return { kind: 'unplaceable', reason: 'not-a-draft' }
  if (!row.parent_version_id) return { kind: 'unplaceable', reason: 'no-parent' }
  return { kind: 'workspace', workspace: { landscapeId: row.landscape_id, versionId: row.parent_version_id } }
}

/** The seam the router places the merge through. Defaulted to the statement
 *  above; overridable only so a middleware arm can drive the `needs-lookup`
 *  branch without a database. The statement itself is covered by
 *  `mergeParentRoute.integration.test.ts`, NOT by whatever a fake injects. */
export type MergeParentResolver = typeof resolveMergeParentWorkspace

/**
 * THE LANDSCAPE DEFAULT READ — where `POST /drafts` and `POST /versions` are
 * placed.
 *
 * Two answers, not three: a landscape with no row, or with a NULL default, is
 * `unresolved`, and the router hands the request back to Express. That is safe
 * because `createDraft` returns
 * null before creating anything on either miss (`landscapes.ts`), `createVersion`
 * returns null on a missing landscape and opens an UNFENCED scope on a null
 * default (a legacy shape with no lease-able key), and both handlers answer
 * 404 — neither calls `ensureCanonicalWorkspaceRoot`, so there is no
 * `unplaceable` case here as there is for the merge.
 *
 * Like `resolveMergeParentWorkspace`, this throws on a database failure rather
 * than folding it into `unresolved`: a `catch` here would convert every
 * connection blip into a silent unrouted creation on the landing cell.
 */
export type LandscapeDefaultPlacement =
  | { kind: 'workspace'; workspace: WorkspaceKey }
  | { kind: 'unresolved' }

export async function resolveLandscapeDefaultWorkspace(
  db: Pool,
  landscapeId: string,
): Promise<LandscapeDefaultPlacement> {
  const { rows } = await db.query<{ default_version_id: string | null }>(
    'SELECT default_version_id FROM landscapes WHERE id = $1',
    [landscapeId],
  )
  const row = rows[0]
  if (!row || !row.default_version_id) return { kind: 'unresolved' }
  return { kind: 'workspace', workspace: { landscapeId, versionId: row.default_version_id } }
}

export type LandscapeDefaultResolver = typeof resolveLandscapeDefaultWorkspace

export type WorkspaceRouteResolver = typeof resolveWorkspaceRoute

/**
 * A routed request reaches its target with a concrete version id. When the
 * local fenced ownership catalog already proves that exact workspace is
 * active and owned, repeating the catalog SQL query only queues reconnects
 * behind CRDT persistence. Moving `current` aliases and non-owned routes must
 * still use the database resolver.
 */
export function resolveWorkspaceRouteForUpgrade(
  db: Pool,
  requested: WorkspaceKey,
  owns: (workspace: WorkspaceKey) => boolean,
  resolve: WorkspaceRouteResolver = resolveWorkspaceRoute,
): Promise<WorkspaceKey | null> {
  if (requested.versionId !== 'current' && owns(requested)) {
    return Promise.resolve(requested)
  }
  return resolve(db, requested)
}

export interface WorkspaceRouteResolverOptions {
  cacheTtlMs?: number
  concreteCacheTtlMs?: number
  maxEntries?: number
  now?: () => number
}

const DEFAULT_ROUTE_BURST_CACHE_TTL_MS = 500
/**
 * The hard ceiling on how long ANY process in this deployment may keep a
 * `current` alias warm. Exported because a repoint has to outlast the caches it
 * cannot reach: `syncCells/routerMain.ts` runs its own resolver in its own
 * process, so `invalidate()` below is local by construction, and the only bound
 * that holds across the process line is this number. See
 * `REPOINT_RESIDUAL_DRAIN_DELAY_MS` (`defaultVersionRepoint.ts`), which is
 * derived from it rather than restating it.
 */
export const MAX_ROUTE_BURST_CACHE_TTL_MS = 5_000
const DEFAULT_CONCRETE_ROUTE_CACHE_TTL_MS = 30_000
const MAX_CONCRETE_ROUTE_CACHE_TTL_MS = 60_000
const DEFAULT_ROUTE_BURST_CACHE_ENTRIES = 5_000

export type InvalidatableWorkspaceRouteResolver = WorkspaceRouteResolver & {
  /**
   * Forget every cached and in-flight answer for one landscape, so the next
   * upgrade re-reads the database. Returns how many CACHED entries were
   * dropped — a witness, because "invalidated" and "there was nothing to
   * invalidate" are different facts and a drain that follows a zero is
   * draining sockets for nothing.
   */
  invalidate(landscapeId: string): number
  /** Drop all cached and in-flight answers after a whole-table invalidation
   * or a listener gap. Returns the number of cached answers removed. */
  invalidateAll(): number
}

/**
 * Coalesce concurrent resolutions and retain successful answers just long
 * enough to absorb the staggered waves in a reconnect storm. Null answers are
 * never cached. The small TTL bounds how long a moving `current` alias or newly
 * inactive version can retain its previous route, while ownership fencing still
 * prevents a stale cell from accepting writes.
 */
export function createSingleFlightWorkspaceRouteResolver(
  resolve: WorkspaceRouteResolver = resolveWorkspaceRoute,
  options: WorkspaceRouteResolverOptions = {},
): InvalidatableWorkspaceRouteResolver {
  const inFlight = new Map<string, Promise<WorkspaceKey | null>>()
  const cache = new Map<string, { workspace: WorkspaceKey; expiresAt: number }>()
  const configuredTtl = options.cacheTtlMs ?? Number(process.env.AM_WORKSPACE_ROUTE_BURST_CACHE_MS)
  const cacheTtlMs = Number.isFinite(configuredTtl)
    ? Math.min(MAX_ROUTE_BURST_CACHE_TTL_MS, Math.max(0, Math.floor(configuredTtl)))
    : DEFAULT_ROUTE_BURST_CACHE_TTL_MS
  const configuredConcreteTtl = options.concreteCacheTtlMs
    ?? Number(process.env.AM_CONCRETE_WORKSPACE_ROUTE_CACHE_MS)
  const concreteCacheTtlMs = Number.isFinite(configuredConcreteTtl)
    ? Math.min(MAX_CONCRETE_ROUTE_CACHE_TTL_MS, Math.max(0, Math.floor(configuredConcreteTtl)))
    : DEFAULT_CONCRETE_ROUTE_CACHE_TTL_MS
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_ROUTE_BURST_CACHE_ENTRIES))
  const now = options.now ?? Date.now
  // Bumped by `invalidate`. A resolution ISSUED before an invalidation must not
  // be allowed to write its answer into the cache afterwards: the whole point
  // of invalidating at a repoint is that the answer in flight is the stale one,
  // and its `.then` runs long after the caller has moved on. Dropping the entry
  // without this guard leaves a window one database round trip wide — the exact
  // window the repoint is racing.
  let generation = 0

  const resolver = ((db, requested) => {
    const key = `${requested.landscapeId}\u0000${requested.versionId}`
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.workspace)
    if (cached) cache.delete(key)

    const existing = inFlight.get(key)
    if (existing) return existing

    const issuedAt = generation
    const pending = resolve(db, requested)
    inFlight.set(key, pending)
    const clear = () => {
      if (inFlight.get(key) === pending) inFlight.delete(key)
    }
    void pending.then((workspace) => {
      clear()
      const ttlMs = requested.versionId === 'current' ? cacheTtlMs : concreteCacheTtlMs
      if (!workspace || ttlMs <= 0) return
      if (generation !== issuedAt) return
      while (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value as string | undefined
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      cache.set(key, { workspace, expiresAt: now() + ttlMs })
    }, clear)
    return pending
  }) as InvalidatableWorkspaceRouteResolver

  resolver.invalidate = (landscapeId) => {
    // ONE counter for the whole resolver rather than one per landscape: the
    // cost of also suppressing a concurrent landscape's cache write is a single
    // database round trip on its next upgrade, and a per-landscape map would be
    // another structure to bound and purge. Repoints are administrative.
    generation += 1
    // A key is `<landscapeId>` + NUL + `<versionId>`, and NUL cannot appear in
    // an id that passed `WORKSPACE_ID` — the same property `keyOf` leans on —
    // so this is an exact match on the landscape, never a partial one on a
    // longer id. The delimiter is TESTED here rather than rebuilt, so it cannot
    // drift into a second spelling of the one the key is built from.
    const matchesLandscape = (key: string): boolean =>
      key.startsWith(landscapeId) && key.charCodeAt(landscapeId.length) === 0
    let dropped = 0
    for (const key of [...cache.keys()]) {
      if (!matchesLandscape(key)) continue
      cache.delete(key)
      dropped += 1
    }
    // The landscape's CONCRETE entries go too, though a repoint moves only the
    // `current` alias. They are held 30 s, the caller that repoints is also the
    // caller that deactivates versions, and one extra query per distinct
    // version at the next upgrade is cheaper than every later reader having to
    // re-derive which keys a repoint can reach.
    for (const key of [...inFlight.keys()]) {
      if (matchesLandscape(key)) inFlight.delete(key)
    }
    return dropped
  }

  resolver.invalidateAll = () => {
    generation += 1
    const dropped = cache.size
    cache.clear()
    inFlight.clear()
    return dropped
  }

  return resolver
}

// HTTP and the in-cell WebSocket server must invalidate the same resolver.
// A pool identifies one database connection context; never reuse cached routes
// across pools (including isolated schemas in tests). Weak keys do not retain
// a stopped pool. This owns no timer or connection: expiry stays in the existing
// single-flight resolver, and the server owns its notification listener.
const sharedWorkspaceRouteResolvers = new WeakMap<Pool, InvalidatableWorkspaceRouteResolver>()

export function getSharedWorkspaceRouteResolver(pool: Pool): InvalidatableWorkspaceRouteResolver {
  let resolver = sharedWorkspaceRouteResolvers.get(pool)
  if (!resolver) {
    const singleFlight = createSingleFlightWorkspaceRouteResolver()
    resolver = ((db, requested) => {
      if (db !== pool) throw new Error('Workspace route resolver used with a different pool')
      return singleFlight(db, requested)
    }) as InvalidatableWorkspaceRouteResolver
    resolver.invalidate = (landscapeId) => singleFlight.invalidate(landscapeId)
    resolver.invalidateAll = () => singleFlight.invalidateAll()
    sharedWorkspaceRouteResolvers.set(pool, resolver)
  }
  return resolver
}
