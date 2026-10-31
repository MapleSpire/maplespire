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

import { randomBytes } from 'node:crypto'
import type { Repo } from '@automerge/automerge-repo'
import { pool } from './db.js'
import { createEmptyRoot } from './automergeServer.js'
import { openBootstrapScope, type BootstrapAuthorityRequest } from './bootstrapScope.js'
import { assertForkableSourceRoot, forkRoot } from './forkRoot.js'
import { captureRootManifest } from './draft/manifest.js'
import { canCreateSparseDraft, createSparseDraftRoot } from './draft/sparse.js'
import { markStaticReadModelWorkspace } from './readModel/staticWorkspace.js'
import { ensureDefaultOrg } from './auth/schema.js'
import { upsertVersionScope, softDeleteScope } from './rbac/schema.js'
import {
  notifyWorkspaceCreated,
  notifyWorkspaceDocumentsCreated,
  invalidateAllowedWorkspaceKeysCache,
} from './rbac/docScope.js'
import { coverWorkspace } from './rbac/claimCoverage.js'
import { announceDefaultVersionRepoint } from './syncCells/defaultVersionRepoint.js'

/**
 * Multi-landscape registry.
 *
 * A LANDSCAPE has many editable VERSIONS; each version is its own Automerge root
 * (its own model + diagrams), so a user can work in any version independently.
 * `landscapes.default_version_id` points at the landscape's primary version;
 * "set default" just repoints it — it removes nothing. `versionId === 'current'`
 * is a sentinel meaning "this landscape's default version", so a client pinned to
 * 'current' follows whatever is default.
 *
 * The legacy single workspace (automerge_meta.root_url) is registered as the
 * 'default' landscape's 'Main' version with zero data movement.
 */

// Defined in a leaf module so the router's admission gate
// and `resolveAiToolCtx` derive one default without loading this module and
// the pool behind it; re-exported here for every existing importer.
export { DEFAULT_LANDSCAPE_ID } from './landscapeDefaults.js'
import { DEFAULT_LANDSCAPE_ID } from './landscapeDefaults.js'

/** Draft lifecycle states. UI labels: active=In-progress, discarded=Deleted. */
export type DraftStatus = 'active' | 'merged' | 'discarded' | 'archived'
const DRAFT_STATUSES = new Set<string>(['active', 'merged', 'discarded', 'archived'])

export interface VersionRow {
  id: string
  landscapeId: string
  label: string
  rootUrl: string
  parentVersionId: string | null
  /** 'version' for a real branch, 'draft' for an isolated draft fork. */
  kind: string
  /** Draft lifecycle (always 'active' for non-draft versions). */
  status: string
  createdAt: string
}

export interface LandscapeWithVersions {
  id: string
  name: string
  defaultVersionId: string | null
  createdAt: string
  versions: VersionRow[]
}

function newId(): string {
  return randomBytes(12).toString('base64url')
}

/**
 * RBAC scope wiring: after a landscape/version/draft's
 * root is persisted, upsert its RBAC scope row under the OWNING org (the
 * landscape's `org_id`; the Default Org only as a last-resort fallback for a
 * pre-backfill row) and prime the doc index for it (`notifyWorkspaceCreated`,
 * a no-op until `WorkspaceDocIndex` has registered itself — see
 * rbac/docScope.ts). Failure here must never break the create flow itself:
 * scope/index registration is best-effort at creation time and self-heals via
 * `ensureScopesForExistingWorkspaces`'s next boot pass / `WorkspaceDocIndex`'s
 * lazy resolve-miss walk either way.
 */
async function registerWorkspaceScope(
  orgId: string | null,
  landscapeId: string,
  versionId: string,
  rootUrl: string
): Promise<void> {
  try {
    const owner = orgId ?? (await ensureDefaultOrg(pool))
    await upsertVersionScope(pool, owner, landscapeId, versionId)
    // The creator's cached allowed-keys set predates this scope row — drop the
    // cache so they can enter the workspace they just created immediately
    // (their session keeps its pre-bump epoch, so the epoch-keyed cache entry
    // would otherwise serve stale reads for the full TTL and 403 them).
    invalidateAllowedWorkspaceKeysCache()
  } catch (err) {
    console.warn('[landscapes] failed to register RBAC scope for', landscapeId, versionId, err)
  }
  try {
    notifyWorkspaceCreated({ landscapeId, versionId, rootUrl })
  } catch (err) {
    console.warn('[landscapes] failed to notify doc index of new workspace', landscapeId, versionId, err)
  }
}

/**
 * The bootstrap publisher's claim + coverage marker, shared by every
 * family-A site (createLandscape / createVersion / createDraft here,
 * provisioning.ts and orgSeed/seed.ts elsewhere).
 *
 * The ORDER is the whole design: Automerge flush (already done inside the
 * creator) → INSERT versions (the caller — the claims table derives
 * landscape/version from that row, by FK and anti-spoof rule, so no claim can
 * precede it) → batch claims → marker LAST. The marker is the commit record:
 * a crash at any earlier point leaves the workspace merely uncovered, which
 * falls back to the lazy walk at first attach.
 *
 * Claim failures PROPAGATE — `foreign` on freshly minted ids is corruption
 * and the create must fail loudly, not half-publish. The marker write alone
 * is best-effort: covered-later costs one walk, a lying marker costs
 * correctness. And when no doc index is registered (DB-free tests; every
 * server boot registers one since 2026-10-16, AUTH=off included) the batch
 * hook returns false — no claims recorded, so no marker either; the workspace
 * stays on the legacy lazy path, in exact parity with the walk that does not
 * run in that mode.
 */
export async function claimAndCoverNewWorkspace(
  landscapeId: string,
  versionId: string,
  rootUrl: string,
  documentIds: string[],
): Promise<void> {
  const claimed = await notifyWorkspaceDocumentsCreated({ landscapeId, versionId, rootUrl, documentIds })
  if (!claimed) return
  try {
    await coverWorkspace(pool, { landscapeId, versionId }, '0')
  } catch (err) {
    console.warn('[landscapes] failed to write the claim-coverage marker for', landscapeId, versionId, err)
  }
}

/** The org a landscape belongs to (null = pre-backfill row or no such landscape). */
export async function landscapeOrgId(landscapeId: string): Promise<string | null> {
  const { rows } = await pool.query<{ org_id: string | null }>(
    'SELECT org_id FROM landscapes WHERE id = $1',
    [landscapeId]
  )
  return rows[0]?.org_id ?? null
}

/**
 * Boot-time backfill (multi-org phase): every pre-org landscape row gets
 * `org_id = <Default Org>`, and the Default Org's `default_landscape_id`
 * points at its oldest landscape when unset. Idempotent; call after
 * `ensureDefaultOrg` in main().
 */
export async function backfillLandscapeOrgs(): Promise<void> {
  const orgId = await ensureDefaultOrg(pool)
  await pool.query('UPDATE landscapes SET org_id = $1 WHERE org_id IS NULL', [orgId])
  await pool.query(
    `UPDATE orgs SET default_landscape_id = (
       SELECT id FROM landscapes WHERE org_id = $1 ORDER BY created_at LIMIT 1
     )
     WHERE id = $1 AND default_landscape_id IS NULL
       AND EXISTS (SELECT 1 FROM landscapes WHERE org_id = $1)`,
    [orgId]
  )
}

function mapVersion(r: Record<string, unknown>): VersionRow {
  return {
    id: r.id as string,
    landscapeId: r.landscape_id as string,
    label: r.label as string,
    rootUrl: r.root_url as string,
    parentVersionId: (r.parent_version_id as string | null) ?? null,
    kind: (r.kind as string | undefined) ?? 'version',
    status: (r.status as string | undefined) ?? 'active',
    createdAt: String(r.created_at),
  }
}

/** Pure: resolve the 'current' sentinel to the landscape's default version id. */
export function effectiveVersionId(
  versionId: string | undefined | null,
  defaultVersionId: string | null
): string | null {
  return !versionId || versionId === 'current' ? defaultVersionId : versionId
}

/**
 * Register the legacy primary root as the 'default' landscape's 'Main' version,
 * once. Idempotent: a no-op if any landscape already exists.
 */
export async function ensureDefaultLandscape(primaryRootUrl: string): Promise<void> {
  // One transaction + ON CONFLICT so two server instances booting against the same
  // DB can't half-insert (a landscape without its version): the loser's landscape
  // INSERT affects 0 rows and we skip the version insert.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT 1 FROM landscapes LIMIT 1')
    if (rows.length === 0) {
      const versionId = newId()
      const ins = await client.query(
        `INSERT INTO landscapes (id, name, default_version_id) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [DEFAULT_LANDSCAPE_ID, 'Default', versionId]
      )
      if ((ins.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $3, $4)`,
          [versionId, DEFAULT_LANDSCAPE_ID, 'Main', primaryRootUrl]
        )
        console.log('Registered legacy workspace as landscape "default" / version "Main"')
      }
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** A ref is EXPLICIT when it carries either half. With neither it is the legacy
 * no-params call — the default landscape's default version — and only that call
 * resolves with a bootable fallback. */
export function isExplicitWorkspaceRef(ref: { landscapeId?: string; versionId?: string }): boolean {
  return ref.landscapeId !== undefined || ref.versionId !== undefined
}

/**
 * Resolve a (landscapeId, versionId) ref to its Automerge root URL.
 *
 * For the LEGACY callers (no params — the default workspace / the projector) this
 * always returns something bootable, falling back to the primary root. But for an
 * EXPLICIT ref (params provided) a lookup miss returns null so the API can 404:
 * silently serving the default landscape's root for another landscape's ref is
 * exactly the "my duplicate/draft shows the default landscape" failure mode — a
 * dangling explicit ref must fail LOUD (the client's bridge already has a
 * fallback-to-default path WITH a user-visible warning for that).
 *
 * For the same reason a database error THROWS for an explicit ref: the fallback
 * is the DEFAULT landscape's primary root, and every explicit caller acts on the
 * workspace it named — discloses it, projects it, compacts it, or writes to it.
 */
export async function resolveRootUrl(
  landscapeId: string | undefined,
  versionId: string | undefined,
  fallbackRootUrl: string
): Promise<string | null> {
  const explicit = isExplicitWorkspaceRef({ landscapeId, versionId })
  const miss = explicit ? null : fallbackRootUrl
  try {
    // `??`, not `||`: the landscape id is read as `canonicalWorkspaceKey`
    // reads it, so `?landscapeId=` names the landscape '' on both — never a
    // check on one landscape and a root of the default one.
    const lid = landscapeId ?? DEFAULT_LANDSCAPE_ID
    const { rows: lrows } = await pool.query<{ default_version_id: string | null }>(
      'SELECT default_version_id FROM landscapes WHERE id = $1',
      [lid]
    )
    if (lrows.length === 0) return miss
    const vid = effectiveVersionId(versionId, lrows[0].default_version_id)
    if (!vid) return miss
    const { rows: vrows } = await pool.query<{ root_url: string }>(
      'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2',
      [vid, lid]
    )
    return vrows[0]?.root_url ?? miss
  } catch (err) {
    if (explicit) throw err
    // A DB error (not a miss) on the legacy call still returns something
    // bootable — the default workspace's boot must never break on an
    // infrastructure hiccup.
    console.error('resolveRootUrl error:', err)
    return fallbackRootUrl
  }
}

/** The root url of one CONCRETE version, or null when there is no such row.
 * Throws on a database error: unlike `resolveRootUrl`, it has no bootable
 * fallback, because its caller reports the key beside the url. */
export async function rootUrlOfVersion(key: { landscapeId: string; versionId: string }): Promise<string | null> {
  const { rows } = await pool.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2',
    [key.versionId, key.landscapeId],
  )
  return rows[0]?.root_url ?? null
}

type CanonicalKey = { landscapeId: string; versionId: string }

export type WorkspaceRootAnswer =
  | { kind: 'forbidden' }
  | {
      kind: 'root'
      url: string | null
      /** The canonical key the url was resolved FROM, or null when it was not. */
      key: CanonicalKey | null
    }

/**
 * Everything `/api/automerge/root` decides before it discloses a root url: the
 * canonical key, the access check on it, the url, and the key it may report
 * beside the url. A client records that pair as the workspace its documents
 * belong to (the durability witness asks the server about exactly that
 * version), so the key is reported ONLY beside a url resolved FROM it.
 *
 * Resolving the ref a second time would read `default_version_id` again: a
 * set-default landing between the access check and that read pairs V1's key
 * with V2's root.
 *
 * Every ref is answered only from the canonical key its access was checked
 * on — a missing version row is a miss (404), a failed read throws (the
 * route's retryable 503) — with ONE exception, the bootable fallback: the
 * no-params legacy call while access is not enforced (`accessEnforced`, see
 * `workspaceAccessEnforced`). There a failed canonicalisation, a missing
 * version row or a failed root read falls back to the legacy resolution,
 * beside no key. No check ran on that root, which is why it is served only
 * where no check could have refused it.
 */
export async function resolveWorkspaceRoot(
  ref: { landscapeId?: string; versionId?: string },
  fallbackRootUrl: string,
  deps: {
    canonicalize: (ref: CanonicalKey) => Promise<CanonicalKey | null>
    mayRead: (key: CanonicalKey) => Promise<boolean>
    accessEnforced: boolean
    urlOfVersion?: (key: CanonicalKey) => Promise<string | null>
    legacy?: () => Promise<string | null>
  },
): Promise<WorkspaceRootAnswer> {
  const urlOfVersion = deps.urlOfVersion ?? rootUrlOfVersion
  const legacy = deps.legacy ?? (() => resolveRootUrl(undefined, undefined, fallbackRootUrl))
  const bootable = !isExplicitWorkspaceRef(ref) && !deps.accessEnforced
  let canonical: CanonicalKey | null
  try {
    canonical = await deps.canonicalize({
      landscapeId: ref.landscapeId ?? DEFAULT_LANDSCAPE_ID,
      versionId: ref.versionId ?? 'current',
    })
  } catch (err) {
    if (!bootable) throw err
    console.error('resolveWorkspaceRoot: canonicalisation failed; serving the bootable fallback', err)
    return { kind: 'root', url: await legacy(), key: null }
  }
  if (canonical && !(await deps.mayRead(canonical))) return { kind: 'forbidden' }
  if (canonical) {
    const key = { landscapeId: canonical.landscapeId, versionId: canonical.versionId }
    try {
      const url = await urlOfVersion(key)
      if (url) return { kind: 'root', url, key }
    } catch (err) {
      if (!bootable) throw err
      console.error('resolveWorkspaceRoot: version root lookup failed; resolving without a key', err)
    }
  }
  return { kind: 'root', url: bootable ? await legacy() : null, key: null }
}

/** A workspace a request may read. Access was checked on `key`, the CANONICAL
 * key (`current` resolved), and `rootUrl` resolves that same key — never the
 * request's ref a second time, which a set-default in between would move to
 * another version, and never the primary root on a failed read (it throws). */
export type ReadableWorkspace =
  | { kind: 'readable'; key: CanonicalKey; rootUrl: () => Promise<string | null> }
  | { kind: 'forbidden' }
  | { kind: 'unknown' }

/** Canonicalise `ref`, check read access on the canonical key, and bind the
 * root lookup to it. `unknown` is a ref that canonicalises to nothing, and no
 * access check runs on it; a canonicalisation that could not READ the registry
 * throws (`canonicalWorkspaceKey`), so it never lands here. */
export async function readableWorkspace(
  ref: { landscapeId: string; versionId: string },
  deps: {
    canonicalize: (ref: { landscapeId: string; versionId: string }) => Promise<{ landscapeId: string; versionId: string } | null>
    mayRead: (key: { landscapeId: string; versionId: string }) => Promise<boolean>
    urlOfVersion?: (key: { landscapeId: string; versionId: string }) => Promise<string | null>
  },
): Promise<ReadableWorkspace> {
  const canonical = await deps.canonicalize(ref)
  if (!canonical) return { kind: 'unknown' }
  if (!(await deps.mayRead(canonical))) return { kind: 'forbidden' }
  const key = { landscapeId: canonical.landscapeId, versionId: canonical.versionId }
  const urlOfVersion = deps.urlOfVersion ?? rootUrlOfVersion
  return { kind: 'readable', key, rootUrl: () => urlOfVersion(key) }
}

/** List landscapes — ALL of them for legacy/AUTH=off callers, or one org's
 * registry when `orgId` is given (the org-scoped `GET /api/landscapes`). */
export async function listLandscapes(orgId?: string): Promise<LandscapeWithVersions[]> {
  const { rows: ls } = orgId
    ? await pool.query(
        'SELECT id, name, default_version_id, created_at FROM landscapes WHERE org_id = $1 ORDER BY created_at',
        [orgId]
      )
    : await pool.query('SELECT id, name, default_version_id, created_at FROM landscapes ORDER BY created_at')
  // Real branches only — drafts (kind='draft') are listed separately via listDrafts
  // and must not clutter the version switcher. `IS DISTINCT FROM` keeps legacy NULL rows.
  const { rows: vs } = await pool.query(
    `SELECT id, landscape_id, label, root_url, parent_version_id, kind, status, created_at
     FROM versions WHERE kind IS DISTINCT FROM 'draft' ORDER BY created_at`
  )
  const versions = vs.map(mapVersion)
  return ls.map((l) => ({
    id: l.id as string,
    name: l.name as string,
    defaultVersionId: (l.default_version_id as string | null) ?? null,
    createdAt: String(l.created_at),
    versions: versions.filter((v) => v.landscapeId === l.id),
  }))
}

export async function getLandscape(id: string): Promise<LandscapeWithVersions | null> {
  return (await listLandscapes()).find((l) => l.id === id) ?? null
}

/** Create a new landscape with a fresh, empty 'Main' version (its own root),
 * owned by `orgId` (callers resolve it from the session; null only on legacy
 * AUTH=off paths, where it backfills to the Default Org on next boot). */
export async function createLandscape(repo: Repo, name: string, orgId?: string | null): Promise<LandscapeWithVersions> {
  // `createEmptyRoot` always builds the sharded skeleton. Under boot-from-server
  // the edit overlay shards are the ONLY durable home for objects and
  // connections: a root created without them yields `editsObjectShardUrl: null`,
  // `ensureOverlayHandles` throws, and every object write is dropped — the
  // landscape looks right until reload, then comes back with its diagrams intact
  // but every shape gone.
  //
  // Ids BEFORE documents: the root graph is named for (landscapeId, versionId)
  // — `bootstrapMint.ts` — so a landscape whose rows below never land leaves
  // documents the minted-orphan reaper can find, not GC fodder for two days.
  const landscapeId = newId()
  const versionId = newId()
  // UNFENCED, and said so: no landscape row exists yet, so no
  // lease could authorise these documents — the one declared population the
  // bootstrap fence does not cover, counted on
  // `maplespire_bootstrap_scopes_unfenced_total{reason="no-forker"}`.
  const scope = openBootstrapScope({ landscapeId, versionId }, { kind: 'unfenced', reason: 'no-forker' })
  const { rootUrl, documentIds } = await createEmptyRoot(repo, scope)
  await pool.query(
    `INSERT INTO landscapes (id, name, default_version_id, org_id) VALUES ($1, $2, $3, $4)`,
    [landscapeId, name.trim() || 'Untitled landscape', versionId, orgId ?? null]
  )
  await pool.query(
    `INSERT INTO versions (id, landscape_id, label, root_url) VALUES ($1, $2, $3, $4)`,
    [versionId, landscapeId, 'Main', rootUrl]
  )
  // Ordering: versions row above → claims → marker → notify (inside
  // registerWorkspaceScope), whose registration then skips the priming walk.
  await claimAndCoverNewWorkspace(landscapeId, versionId, rootUrl, documentIds)
  await registerWorkspaceScope(orgId ?? null, landscapeId, versionId, rootUrl)
  return (await getLandscape(landscapeId))!
}

/**
 * Add a new version to a landscape. By default it's EMPTY (a fresh root); pass
 * `forkFromVersionId` (a version of the same landscape) to DUPLICATE it instead —
 * the new version starts as a deep, independent copy of that version's docs.
 * Returns null if the landscape (or the fork source) doesn't exist.
 */
export async function createVersion(
  repo: Repo,
  landscapeId: string,
  label: string,
  forkFromVersionId?: string
): Promise<VersionRow | null> {
  const { rows } = await pool.query<{ org_id: string | null; default_version_id: string | null }>(
    'SELECT org_id, default_version_id FROM landscapes WHERE id = $1',
    [landscapeId]
  )
  if (rows.length === 0) return null
  const orgId = rows[0].org_id

  // The new version's id BEFORE its documents exist — they are named for it.
  const versionId = newId()
  // FENCED UNDER THE LANDSCAPE DEFAULT'S LEASE, for both branches.
  // Not the source's: a source may be a merged or discarded draft, which
  // `createVersion` forks today and which NO cell can ever lease
  // (`OWNABLE_WORKSPACES_SQL` selects `active`), so keying on it would turn a
  // fork the server accepts into a permanent refusal. The default is the one
  // workspace of the landscape guaranteed active and ownable, and it is the key
  // the router places `POST /versions` on — the cell the request reaches is
  // the cell that can open this scope. A landscape with no default is a legacy
  // shape with no lease-able key; it stays unfenced and is counted as such.
  // What keying on the default costs: when `forkFromVersionId` names an ACTIVE
  // non-default version another cell owns, this cell reads that source through
  // storage (`forkRoot` → `readDoc`) — its DURABLE state, which may lag the
  // owner's in-memory state by one save debounce (100 ms) plus in-flight
  // saves. A fork is a point-in-time copy of what is durable, and no write
  // lands on the source.
  const authority: BootstrapAuthorityRequest = rows[0].default_version_id
    ? { kind: 'forker', workspace: { landscapeId, versionId: rows[0].default_version_id } }
    : { kind: 'unfenced', reason: 'no-forker' }
  const scope = openBootstrapScope({ landscapeId, versionId }, authority)
  let rootUrl: string
  let documentIds: string[]
  let parentVersionId: string | null = null
  try {
    if (forkFromVersionId) {
      const { rows: srcRows } = await pool.query<{ root_url: string }>(
        'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2',
        [forkFromVersionId, landscapeId]
      )
      if (srcRows.length === 0) return null
      // Refuse to fork a summary source BEFORE any document is created — the
      // twin would carry `registrySummaryOnly: true` with no static row, the
      // exact data-loss state fsck's summary-static-coherence check flags (no
      // cold client could list or open its diagrams). The route maps this typed
      // error to HTTP 409.
      await assertForkableSourceRoot(repo, srcRows[0].root_url)
      const fork = await forkRoot(repo, srcRows[0].root_url, scope)
      rootUrl = fork.rootUrl
      documentIds = fork.createdDocumentIds
      parentVersionId = forkFromVersionId
    } else {
      // Same reason as createLandscape: a version without the edit overlay shards
      // cannot durably hold an object. `forkRoot` inherits whatever the source had.
      const created = await createEmptyRoot(repo, scope)
      rootUrl = created.rootUrl
      documentIds = created.documentIds
    }
  } catch (error) {
    // `forkRoot` retires the scope itself; `createEmptyRoot` does not, and a
    // failure between its first mint and its last would leave live notes.
    // `retire()` is idempotent, so the fork branch pays nothing for this.
    scope.retire()
    throw error
  }

  try {
    const { rows: vrows } = await pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, parent_version_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, landscape_id, label, root_url, parent_version_id, kind, status, created_at`,
      [versionId, landscapeId, label.trim() || 'Untitled version', rootUrl, parentVersionId]
    )
    // The whole copied graph is claimed for the NEW version (the source's
    // rows stay the source's — first-owner-wins is untouched), then covered.
    await claimAndCoverNewWorkspace(landscapeId, versionId, rootUrl, documentIds)
    await registerWorkspaceScope(orgId, landscapeId, versionId, rootUrl)
    return mapVersion(vrows[0])
  } catch (error) {
    // The graph is durable and its publisher failed: residue for the reaper,
    // and the notes stay readable so any late save is still fenced.
    scope.retire()
    throw error
  }
}

/**
 * Create a DRAFT: a fork of the landscape's DEFAULT version, edited in isolation.
 * Captures the parent's per-doc heads as `base_manifest` (the 3-way-merge base)
 * BEFORE forking, so the diff/merge can reconstruct the fork-point state even after
 * the live version advances. Returns null if the landscape has no resolvable default.
 */
export async function createDraft(
  repo: Repo,
  landscapeId: string,
  label: string
): Promise<VersionRow | null> {
  const { rows: lrows } = await pool.query<{ default_version_id: string | null; org_id: string | null }>(
    'SELECT default_version_id, org_id FROM landscapes WHERE id = $1',
    [landscapeId]
  )
  if (lrows.length === 0) return null
  const orgId = lrows[0].org_id
  const parentVersionId = lrows[0].default_version_id
  if (!parentVersionId) return null
  const { rows: prows } = await pool.query<{ root_url: string }>(
    'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2',
    [parentVersionId, landscapeId]
  )
  if (prows.length === 0) return null
  const parentRootUrl = prows[0].root_url

  // Summary-only static workspaces use a bounded copy-on-write fork. Walking
  // their 30k DiagramDocs would turn a single UI action into multi-GB residency
  // and can take the sync cell offline. Ordinary workspaces retain the complete
  // eager fork and per-document heads manifest.
  // The draft's id BEFORE its documents exist — they are named for it.
  const draftId = newId()
  // FENCED UNDER THE PARENT'S LEASE: the parent is the landscape
  // default, the one workspace the router places `POST /drafts` on, and the
  // scope asks for its authority BEFORE the first document is minted — a
  // lease-less cell is refused here having written nothing.
  const scope = openBootstrapScope(
    { landscapeId, versionId: draftId },
    { kind: 'forker', workspace: { landscapeId, versionId: parentVersionId } },
  )
  let sparse: Awaited<ReturnType<typeof createSparseDraftRoot>> | null
  let baseManifest: Awaited<ReturnType<typeof captureRootManifest>> | Awaited<ReturnType<typeof createSparseDraftRoot>>['manifest']
  let fork: Awaited<ReturnType<typeof forkRoot>> | null
  try {
    sparse = await canCreateSparseDraft(repo, parentRootUrl)
      ? await createSparseDraftRoot(repo, parentRootUrl, parentVersionId, scope)
      : null
    // A HEALTHY summary parent (staticBaseline meta) took the sparse O(1)
    // branch above and is untouched by this guard. What is refused is the
    // remaining summary shape that would fall through to the DEEP fork — e.g. a
    // summary root whose meta lost `staticBaseline` — because that fork mints a
    // flag-without-static-row twin (fsck: data-loss) after walking the whole
    // graph. Runs BEFORE captureRootManifest, so nothing is created or walked.
    if (!sparse) await assertForkableSourceRoot(repo, parentRootUrl)
    baseManifest = sparse?.manifest ?? await captureRootManifest(repo, parentRootUrl)
    fork = sparse ? null : await forkRoot(repo, parentRootUrl, scope)
  } catch (error) {
    // The sparse clone does not retire the scope itself (`forkRoot` does): a
    // failure between its mints and the publisher below would leave live
    // notes. Idempotent, so the deep branch pays nothing.
    scope.retire()
    throw error
  }
  const rootUrl = sparse?.rootUrl ?? fork!.rootUrl
  const documentIds = sparse?.createdDocumentIds ?? fork!.createdDocumentIds

  try {
    const { rows } = await pool.query(
      `INSERT INTO versions (id, landscape_id, label, root_url, parent_version_id, kind, status, base_manifest)
       VALUES ($1, $2, $3, $4, $5, 'draft', 'active', $6)
       RETURNING id, landscape_id, label, root_url, parent_version_id, kind, status, created_at`,
      [draftId, landscapeId, label.trim() || 'Untitled draft', rootUrl, parentVersionId, JSON.stringify(baseManifest)]
    )
    if (sparse) {
      await markStaticReadModelWorkspace(
        pool,
        { landscapeId, versionId: draftId },
        'sparse-draft',
        sparse.allowedDocuments,
        parentVersionId,
      )
    }
    // Ordering for the draft family: versions row (+ the static-workspace
    // row for a sparse draft, which resolveDurable's static filter reads) →
    // claims → marker. The parent's documents keep the parent's rows.
    await claimAndCoverNewWorkspace(landscapeId, draftId, rootUrl, documentIds)
    await registerWorkspaceScope(orgId, landscapeId, draftId, rootUrl)
    return mapVersion(rows[0])
  } catch (error) {
    // The graph is durable and its publisher failed: residue for the reaper,
    // and the notes stay readable so any late save is still fenced.
    scope.retire()
    throw error
  }
}

/** List a landscape's drafts (newest first), excluding nothing — all statuses. */
export async function listDrafts(landscapeId: string): Promise<VersionRow[]> {
  const { rows } = await pool.query(
    `SELECT id, landscape_id, label, root_url, parent_version_id, kind, status, created_at
     FROM versions WHERE landscape_id = $1 AND kind = 'draft' ORDER BY created_at DESC`,
    [landscapeId]
  )
  return rows.map(mapVersion)
}

/** Set a draft's lifecycle status. Returns false on an unknown status or no such draft. */
export async function setDraftStatus(
  landscapeId: string,
  draftId: string,
  status: string
): Promise<boolean> {
  if (!DRAFT_STATUSES.has(status)) return false
  const { rowCount } = await pool.query(
    `UPDATE versions SET status = $3 WHERE id = $1 AND landscape_id = $2 AND kind = 'draft'`,
    [draftId, landscapeId, status]
  )
  return (rowCount ?? 0) > 0
}

/** Repoint a landscape's default version. Removes nothing; returns false if the
 * version doesn't belong to the landscape.
 *
 * ONE statement, for two reasons that both matter more than the round trip it
 * saves. A separate membership check would let a version deleted in between
 * be repointed to anyway. And the PREVIOUS default has to
 * be read in the same snapshot as the write: it names the version being LEFT,
 * and reading it in a separate statement leaves a window in which a concurrent
 * repoint makes the answer describe someone else's move.
 *
 * The CTE yields the value from before the update because the whole statement
 * runs under ONE snapshot — a documented Postgres property, not a planner
 * accident, and checked by `landscapes.repoint.integration.test.ts`. It is
 * NOT `MATERIALIZED`: that keyword changes nothing here, and its presence would
 * imply the correctness rests on it.
 */
export async function setDefaultVersion(landscapeId: string, versionId: string): Promise<boolean> {
  const { rows } = await pool.query<{ previous_version_id: string | null }>(
    `WITH previous AS (
       SELECT l.default_version_id FROM landscapes l WHERE l.id = $1
     )
     UPDATE landscapes SET default_version_id = $2
     WHERE id = $1 AND EXISTS (SELECT 1 FROM versions WHERE id = $2 AND landscape_id = $1)
     RETURNING (SELECT default_version_id FROM previous) AS previous_version_id`,
    [landscapeId, versionId]
  )
  if (rows.length === 0) return false
  // After the durable write, never before it, and never awaited: the repoint has
  // happened whatever the sync server does with this.
  announceDefaultVersionRepoint({
    landscapeId,
    previousVersionId: rows[0].previous_version_id,
    versionId,
  })
  return true
}

/**
 * Best-effort RBAC scope soft-delete companion to a landscape/version row
 * delete. Never throws and
 * never blocks the real delete — a scope row is a secondary index the RBAC
 * layer maintains alongside `landscapes`/`versions`, not the source of
 * truth, so a failure here (e.g. the scope was never registered for a
 * pre-RBAC resource) must not turn a successful landscape/version delete
 * into a 500.
 */
async function softDeleteScopesFor(kind: 'landscape' | 'version', landscapeId: string, versionId?: string): Promise<void> {
  try {
    // No org filter: landscape ids are globally unique, and by delete time the
    // landscape row (and its org_id) may already be gone — matching on the
    // landscape/version ids alone finds the scope rows under whichever org
    // owned them.
    if (kind === 'landscape') {
      // Soft-delete the landscape scope AND every version scope under it —
      // CASCADE on the landscapes/versions tables already removed the DB
      // rows, but their RBAC scope rows are independent and must be marked
      // deleted too so allowedWorkspaceKeys/explainAccess stop surfacing them.
      const { rows: landscapeScopeRows } = await pool.query<{ id: string }>(
        `SELECT id FROM scopes WHERE kind = 'landscape' AND landscape_id = $1 AND deleted_at IS NULL`,
        [landscapeId]
      )
      for (const r of landscapeScopeRows) await softDeleteScope(pool, r.id)

      const { rows: versionScopeRows } = await pool.query<{ id: string }>(
        `SELECT id FROM scopes WHERE kind = 'version' AND landscape_id = $1 AND deleted_at IS NULL`,
        [landscapeId]
      )
      for (const r of versionScopeRows) await softDeleteScope(pool, r.id)
    } else {
      const { rows: versionScopeRows } = await pool.query<{ id: string }>(
        `SELECT id FROM scopes WHERE kind = 'version' AND landscape_id = $1 AND version_id = $2 AND deleted_at IS NULL`,
        [landscapeId, versionId]
      )
      for (const r of versionScopeRows) await softDeleteScope(pool, r.id)
    }
  } catch (err) {
    console.warn('[landscapes] failed to soft-delete RBAC scope(s) for', kind, landscapeId, versionId, err)
  }
}

export type DeleteResult = { ok: true } | { ok: false; reason: string }

export async function renameLandscape(id: string, name: string): Promise<boolean> {
  const trimmed = name.trim().slice(0, 200)
  if (!trimmed) return false
  const { rowCount } = await pool.query('UPDATE landscapes SET name = $2 WHERE id = $1', [id, trimmed])
  return (rowCount ?? 0) > 0
}

export async function renameVersion(
  landscapeId: string,
  versionId: string,
  label: string
): Promise<boolean> {
  const trimmed = label.trim().slice(0, 200)
  if (!trimmed) return false
  const { rowCount } = await pool.query(
    'UPDATE versions SET label = $3 WHERE id = $1 AND landscape_id = $2',
    [versionId, landscapeId, trimmed]
  )
  return (rowCount ?? 0) > 0
}

/** Delete a landscape (CASCADE drops its versions). Refuses to delete the last
 * one IN ITS ORG — an org must always keep at least one landscape (for a
 * pre-backfill NULL-org row the guard falls back to the global count, which is
 * the legacy behavior). Repoints the org's `default_landscape_id` at its
 * oldest remaining landscape when the deleted one was the default. */
export async function deleteLandscape(id: string): Promise<DeleteResult> {
  const { rows: lrows } = await pool.query<{ org_id: string | null }>(
    'SELECT org_id FROM landscapes WHERE id = $1',
    [id]
  )
  if (lrows.length === 0) return { ok: false, reason: 'Landscape not found.' }
  const orgId = lrows[0].org_id

  const { rows } = orgId
    ? await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM landscapes WHERE org_id = $1', [orgId])
    : await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM landscapes')
  if ((rows[0]?.n ?? 0) <= 1) return { ok: false, reason: 'Cannot delete the only landscape.' }

  const { rowCount } = await pool.query('DELETE FROM landscapes WHERE id = $1', [id])
  if ((rowCount ?? 0) === 0) return { ok: false, reason: 'Landscape not found.' }

  if (orgId) {
    await pool.query(
      `UPDATE orgs SET default_landscape_id = (
         SELECT id FROM landscapes WHERE org_id = $1 ORDER BY created_at LIMIT 1
       )
       WHERE id = $1 AND default_landscape_id = $2`,
      [orgId, id]
    )
  }

  await softDeleteScopesFor('landscape', id)
  return { ok: true }
}

/** Delete a version. Refuses to delete the landscape's DEFAULT version (set
 * another default first) or the last remaining version. */
export async function deleteVersion(landscapeId: string, versionId: string): Promise<DeleteResult> {
  const { rows: lrows } = await pool.query<{ default_version_id: string | null }>(
    'SELECT default_version_id FROM landscapes WHERE id = $1',
    [landscapeId]
  )
  if (lrows.length === 0) return { ok: false, reason: 'Landscape not found.' }
  if (lrows[0].default_version_id === versionId) {
    return { ok: false, reason: 'Cannot delete the default version — set another version as default first.' }
  }
  const { rows: crows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM versions WHERE landscape_id = $1 AND kind IS DISTINCT FROM 'draft'",
    [landscapeId]
  )
  if ((crows[0]?.n ?? 0) <= 1) return { ok: false, reason: 'Cannot delete the only version.' }
  const { rowCount } = await pool.query(
    'DELETE FROM versions WHERE id = $1 AND landscape_id = $2',
    [versionId, landscapeId]
  )
  if ((rowCount ?? 0) === 0) return { ok: false, reason: 'Version not found.' }
  await softDeleteScopesFor('version', landscapeId, versionId)
  return { ok: true }
}
