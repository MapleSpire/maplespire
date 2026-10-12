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

import { createHash } from 'node:crypto'
import type { ColdApiOutcome, ColdApiSelection } from './drillReport.js'
import type { Queryable } from './backupRestore.js'

/**
 * Does a *server* work against the restored database?
 *
 * Everything else in the drill compares the restore to the backup: chunk
 * fingerprints, table hashes, cold-loaded document heads. All of it can pass
 * over a database the application cannot actually serve — the read model is
 * derived state, the projector has to re-attach from scratch, and a restored
 * `ro_*` table that is byte-identical to the source is still no evidence that a
 * fresh process can project into it and answer a query.
 *
 * So this boots a real server against the isolated restore and asks it the
 * questions the three read-model pages ask: Model Objects, Model Connections,
 * Dependencies, plus the diagram list behind the canvas. A restored database
 * that returns 200 and the expected row counts on those four is one the product
 * runs on.
 *
 * **503 is retried, not failed.** `ensureWorkspace` answers 503 while the
 * workspace's projector is still attaching, which on a cold process is the
 * normal first few seconds. Treating that as a failure would make the check
 * measure boot latency; treating it as success would make it measure nothing.
 */

export type ColdApiWorkspace = {
  landscapeId: string
  versionId: string
  /** The physical projection read by this HTTP identity (a sparse draft can
   * read another version's baseline). This is not the version sent to HTTP. */
  queryVersionId: string
  objects: number
  connections: number
  diagrams: number
  /** An object with at least one outgoing connection, so the Dependencies page
   * is asked something with a non-empty answer. Null when the workspace has no
   * connections at all. */
  dependencyFocusId: string | null
  /** A `/assets/technologies/<sha256>.<ext>` path the restored database names.
   * Null on an installation with no uploaded icons. */
  assetPath: string | null
}

export type ColdApiExpectation = {
  workspace: ColdApiWorkspace | null
  selection: ColdApiSelection
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  status: number
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}>

/**
 * Pick the busiest active workspace in the restored database and describe what
 * a server should say about it. Projection rows alone do not establish that a
 * workspace still exists: projection rows of a deleted workspace can survive
 * and would otherwise be selected for every drill.
 *
 * Busiest rather than first: a workspace with zero objects would let every
 * check below pass on an empty answer, which is the exact false PASS this whole
 * exercise exists to avoid.
 */
export async function deriveColdApiExpectation(db: Queryable): Promise<ColdApiExpectation | null> {
  const { rows: present } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.ro_objects') IS NOT NULL AS present`,
  )
  if (present[0]?.present !== true) return null
  // One population supplies both selection and exclusions. Do not filter by
  // root validity or by probe success: a broken ACTIVE workspace must remain
  // eligible and fail the checks. `active` is the current ownership contract.
  // Static routing matches staticReadModelQueryWorkspaceIfPresent: one hop,
  // empty base means self, and no status check on the physical baseline.
  const { rows: staticTable } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.read_model_static_workspaces') IS NOT NULL AS present`,
  )
  const hasStatic = staticTable[0]?.present === true
  const { rows } = await db.query<{
    landscape_id: string; version_id: string; objects: string
    landscape_exists: boolean; version_exists: boolean; status: string | null
    targets: Array<{ landscapeId: string; versionId: string }>
  }>(
    `WITH projections AS (
       SELECT landscape_id, version_id, count(*)::text AS objects
       FROM ro_objects GROUP BY landscape_id, version_id
     ), targets AS (
       SELECT v.landscape_id, v.id AS version_id,
         ${hasStatic ? "COALESCE(NULLIF(s.base_version_id, ''), v.id)" : 'v.id'} AS query_version_id
       FROM versions v JOIN landscapes l ON l.id = v.landscape_id
       ${hasStatic ? 'LEFT JOIN read_model_static_workspaces s ON s.landscape_id = v.landscape_id AND s.version_id = v.id' : ''}
       WHERE v.status = 'active'
     )
     SELECT p.*, l.id IS NOT NULL AS landscape_exists,
       v.id IS NOT NULL AS version_exists, v.status,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'landscapeId', t.landscape_id, 'versionId', t.version_id) ORDER BY t.version_id)
         FROM targets t WHERE t.landscape_id = p.landscape_id
           AND t.query_version_id = p.version_id), '[]'::jsonb) AS targets
     FROM projections p LEFT JOIN landscapes l ON l.id = p.landscape_id
       LEFT JOIN versions v ON v.landscape_id = p.landscape_id AND v.id = p.version_id
     ORDER BY p.objects::bigint DESC, p.landscape_id, p.version_id`,
  )
  const selection: ColdApiSelection = {
    projectionGroups: rows.length,
    projectionObjects: 0,
    eligibleProjectionGroups: 0,
    eligibleProjectionObjects: 0,
    candidateWorkspaces: 0,
    excludedProjectionGroups: 0,
    excludedProjectionObjects: 0,
    excluded: [],
    exclusionsTruncated: false,
    selected: null,
  }
  let workspace: { landscapeId: string; versionId: string; queryVersionId: string; objects: number } | null = null
  for (const row of rows) {
    const objects = Number(row.objects)
    selection.projectionObjects += objects
    if (row.targets.length) {
      selection.eligibleProjectionGroups += 1
      selection.eligibleProjectionObjects += objects
      selection.candidateWorkspaces += row.targets.length
      // The SQL sorts physical groups by size and key, then identities by key.
      // Shared baselines count once even when several active drafts read them.
      workspace ??= { ...row.targets[0]!, queryVersionId: row.version_id, objects }
      continue
    }
    selection.excludedProjectionGroups += 1
    selection.excludedProjectionObjects += objects
    if (selection.excluded.length < 25) {
      selection.excluded.push({
        landscapeId: row.landscape_id, versionId: row.version_id, objects,
        status: row.status,
        reason: !row.landscape_exists ? 'missing_landscape'
          : !row.version_exists ? 'missing_version'
            : row.status !== 'active' ? 'inactive_version' : 'redirected_projection',
      })
    } else selection.exclusionsTruncated = true
  }
  selection.selected = workspace
  if (!workspace) return { workspace: null, selection }
  const parameters = [workspace.landscapeId, workspace.queryVersionId]
  const { rows: connections } = await db.query<{ connections: string }>(
    `SELECT count(*)::text AS connections FROM ro_connections
     WHERE landscape_id = $1 AND version_id = $2`,
    parameters,
  )
  const { rows: diagrams } = await db.query<{ diagrams: string }>(
    `SELECT count(*)::text AS diagrams FROM ro_diagrams
     WHERE landscape_id = $1 AND version_id = $2`,
    parameters,
  )
  // The focus must be an object the read model knows: a connection endpoint can
  // name a group, and the Dependencies page keys on objects.
  const { rows: focus } = await db.query<{ from_id: string }>(
    `SELECT c.from_id FROM ro_connections c
     WHERE c.landscape_id = $1 AND c.version_id = $2
       AND EXISTS (
         SELECT 1 FROM ro_objects o
         WHERE o.landscape_id = c.landscape_id AND o.version_id = c.version_id
           AND o.id = c.from_id
       )
     GROUP BY c.from_id ORDER BY count(*) DESC, c.from_id LIMIT 1`,
    parameters,
  )
  // Prefer a blob a catalog revision renders — that is one a user would notice
  // missing — and fall back to any uploaded asset.
  const { rows: assetTable } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('public.technology_assets') IS NOT NULL AS present`,
  )
  let assetPath: string | null = null
  if (assetTable[0]?.present === true) {
    const { rows: assets } = await db.query<{ path: string }>(
      `SELECT path FROM technology_assets
       ORDER BY reference_count DESC, path LIMIT 1`,
    )
    assetPath = assets[0]?.path ?? null
  }
  return { selection, workspace: {
    ...workspace,
    connections: Number(connections[0]?.connections ?? 0),
    diagrams: Number(diagrams[0]?.diagrams ?? 0),
    dependencyFocusId: focus[0]?.from_id ?? null,
    assetPath,
  } }
}

function countOf(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return Array.isArray(value) ? value.length : null
}

export async function runColdApiChecks(options: {
  baseUrl: string
  expectation: ColdApiExpectation | null
  /** Wall clock for the whole run, retries included. */
  deadlineMs?: number
  fetchImpl?: FetchLike
  now?: () => number
}): Promise<ColdApiOutcome> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const now = options.now ?? Date.now
  const deadline = now() + (options.deadlineMs ?? 120_000)
  const base = options.baseUrl.replace(/\/+$/, '')
  const checks: ColdApiOutcome['checks'] = []

  const attempt = async (
    name: string,
    path: string,
    assertion: (payload: unknown) => string | null,
  ): Promise<void> => {
    // Undefined rather than a placeholder string: a placeholder would be dead on
    // every path (each branch assigns before the report site reads it).
    let detail: string | undefined
    while (true) {
      try {
        const response = await fetchImpl(`${base}${path}`, {
          signal: AbortSignal.timeout(30_000),
        })
        const body = await response.text()
        if (response.status === 200) {
          let payload: unknown
          try {
            payload = JSON.parse(body)
          } catch {
            checks.push({ name, ok: false, detail: `200 with a non-JSON body: ${body.slice(0, 200)}` })
            return
          }
          const failure = assertion(payload)
          checks.push({
            name,
            ok: failure === null,
            detail: failure ?? `200 ${path}`,
          })
          return
        }
        detail = `HTTP ${response.status}: ${body.slice(0, 200)}`
        // Only a warming projector is worth waiting for. A 4xx is an answer.
        if (response.status !== 503) {
          checks.push({ name, ok: false, detail })
          return
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error)
      }
      if (now() >= deadline) {
        checks.push({ name, ok: false, detail: `gave up after the deadline — last: ${detail ?? 'no attempt completed'}` })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  await attempt('health', '/api/health', (payload) =>
    (payload as { status?: string }).status === 'ok' ? null : 'status is not ok')
  await attempt('ready', '/api/ready', (payload) => {
    // `/api/ready` nests its per-subsystem verdicts under `checks`. Reading them
    // from the top level yields `undefined`, which fails closed — noisy, but the
    // right direction, and it is how this path was found.
    const checks = (payload as { checks?: { readModel?: boolean; database?: boolean } }).checks
    if (checks?.database !== true) return 'the restored database is not reachable from the server'
    if (checks.readModel !== true) return 'the read-model projector never became ready'
    return null
  })

  const selection = options.expectation?.selection ?? null
  if (!options.expectation?.workspace) {
    checks.push({
      name: 'workspace',
      ok: false,
      // Not "skipped": a restore with nothing to serve is exactly the outcome
      // this check exists to catch, and calling it a skip would hide it.
      detail: 'the restored database has no active projected workspace to exercise',
    })
    return { outcome: 'failed', checks, selection }
  }

  const expectation = options.expectation.workspace
  const scope = `landscapeId=${encodeURIComponent(expectation.landscapeId)}`
    + `&versionId=${encodeURIComponent(expectation.versionId)}`

  await attempt('model-objects', `/api/model/page-objects?${scope}&limit=25`, (payload) => {
    const count = countOf(payload, 'objects')
    if (count === null) return 'the response carries no objects array'
    return count > 0 ? null : `the workspace has ${expectation.objects} objects, the page returned 0`
  })

  await attempt('model-connections', `/api/model/connections/page?${scope}&limit=25`, (payload) => {
    const count = countOf(payload, 'items')
    if (count === null) return 'the response carries no items array'
    if (expectation.connections === 0) return null
    return count > 0 ? null : `the workspace has ${expectation.connections} connections, the page returned 0`
  })

  if (expectation.dependencyFocusId) {
    const focus = encodeURIComponent(expectation.dependencyFocusId)
    await attempt('dependencies', `/api/model/dependencies/page?${scope}&focus=${focus}&limit=10`, (payload) => {
      const count = countOf(payload, 'items')
      if (count === null) return 'the response carries no items array'
      return count > 0
        ? null
        : `${expectation.dependencyFocusId} has outgoing connections, the dependency page returned 0 peers`
    })
  } else {
    checks.push({
      name: 'dependencies',
      ok: true,
      detail: 'no connected object in the restore — nothing to focus',
    })
  }

  await attempt('diagram-list', `/api/model/diagrams/page?${scope}&limit=25`, (payload) => {
    const total = (payload as { total?: unknown }).total
    if (typeof total !== 'number') return 'the response carries no total'
    if (expectation.diagrams === 0) return null
    return total > 0 ? null : `the workspace has ${expectation.diagrams} diagrams, the list reported 0`
  })

  // The end of the asset story: not "the blobs were written to a directory" but
  // "a server booted on the restore serves them". Everything upstream — the
  // archive, the manifest fingerprint, the restore — is inference until this
  // returns the bytes, and the bytes have to hash to the name in the URL,
  // because a 200 carrying the wrong image is the failure that looks fine.
  if (expectation.assetPath) {
    const filename = expectation.assetPath.split('/').pop() ?? ''
    const expectedHash = filename.slice(0, 64)
    let detail: string | undefined
    let ok = false
    try {
      const response = await fetchImpl(`${base}${expectation.assetPath}`, {
        signal: AbortSignal.timeout(30_000),
      })
      if (response.status !== 200) {
        detail = `HTTP ${response.status} for ${expectation.assetPath}`
      } else {
        const body = Buffer.from(await response.arrayBuffer())
        const actual = createHash('sha256').update(body).digest('hex')
        ok = actual === expectedHash
        detail = ok
          ? `200 ${expectation.assetPath} (${body.byteLength} bytes, hash matches)`
          : `served content hashes to ${actual}, the URL claims ${expectedHash}`
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    checks.push({ name: 'technology-asset', ok, detail: detail ?? 'no attempt completed' })
  } else {
    checks.push({
      name: 'technology-asset',
      ok: true,
      detail: 'no uploaded technology icon in the restore',
    })
  }

  return {
    outcome: checks.every((check) => check.ok) ? 'passed' : 'failed',
    checks,
    selection,
  }
}
