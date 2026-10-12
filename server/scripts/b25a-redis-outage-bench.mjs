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

// Redis-outage bench: what a Redis outage does to the write-route families
// (draft merge and friends, plus the bootstrap doors that mint documents).
//
// For every request it records durable state before and after, the server's own
// Redis and convergence witnesses, and the storage-fence counters, so a refusal
// can be attributed to the mechanism that produced it. Design rules:
//
//  - `orphanDocuments()` is anchored to NO workspace (a full-table anti-join).
//    A half-finished merge leaves durable documents with neither a mapping row
//    nor a `versions` row, and any probe anchored to a workspace cannot see them.
//  - Storage is resolved by document id, not through
//    `automerge_document_workspace`: that join hides a document the request
//    under measurement has just created.
//  - A merge claims its documents under the version it CREATES, so
//    `claimedDocumentCount` reads the returned version id.
//  - Every request carries its measured wall-clock offset from the outage
//    witness flip; no offset is derived from a constant.
//  - Both arms are gated on convergence (`/api/ready` `syncCellConverged`,
//    which degrades as leases fail to renew) and it is sampled per request.
//  - The matrix repeats each family, and `draft-merge` is swept across the
//    outage. `fencingToken()` requires `owns()`, governed by the PARTITION
//    lease (`SYNC_CELL_PARTITION_LEASE_TTL_MS`, sub-second), not the 15 s
//    workspace lease — so the sweep bins samples on the cell's own reported
//    lease state, and an empty regime is reported VOID.
//
// Run from the repo root with the bench already up:
//   node server/scripts/b25a-redis-outage-bench.mjs

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CELL = process.env.B25A_CELL_URL ?? 'http://127.0.0.1:3321'
const LOGIN_EMAIL = process.env.B25A_LOGIN_EMAIL ?? 'failover-admin@maplespire.local'
const REDIS = process.env.B25A_REDIS_CONTAINER ?? 'maplespire-sync-active-active-redis-1'
const PG = process.env.B25A_PG_CONTAINER ?? 'maplespire-sync-active-active-postgres-1'
/**
 * `??` does not catch a BLANK: `B25A_OUT=` would throw the whole record away at
 * the end of a long run. Same hazard as the numeric knobs, on a string.
 */
function requiredPath(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (raw.trim() === '') throw new Error(`${name} is set but blank; refusing to run a measurement with nowhere to write it`)
  return raw.trim()
}
/**
 * RESOLVED FROM THIS FILE, not from the working directory: a relative default
 * lets a run started from `server/` measure everything and then die on `ENOENT`
 * with nothing written.
 */
const OUT = requiredPath(
  'B25A_OUT',
  fileURLToPath(new URL('../../reports/B2-5a-pass4.json', import.meta.url)),
)

/**
 * Every numeric knob goes through here. `Number('')` is 0 — finite, and it
 * passes any `>= 0` check — so a dangling `B25A_X=` would silently disable
 * whatever the value guards (the hazard `local/no-bare-env-number` exists for).
 */
function boundedEnvNumber(name, fallback, minimum) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name}='${raw}' is unusable: it must be a number >= ${minimum}`)
  }
  return parsed
}

/** Repetitions per family per arm in the matrix. */
const MATRIX_N = boundedEnvNumber('B25A_MATRIX_N', 3, 1)
/** Repetitions per sweep point for `draft-merge`. */
const SWEEP_N = boundedEnvNumber('B25A_SWEEP_N', 5, 1)
/**
 * Seconds after the outage witness flips, as SCHEDULING targets — not as the
 * axis the result is read on. Each sample costs a few seconds of probing, so a
 * group of five nominally at t=5 actually lands across roughly t=5..25. That is
 * why every sample carries its own measured `startedAfterOutage` and why the
 * summary bins on that and not on this array: the honest reading of the sweep is
 * a scatter over measured time, and these values only guarantee the scatter
 * reaches far enough past the 15 s lease to cover both regimes.
 */
const SWEEP_POINTS = [5, 25, 50]
/** How long after the last sweep point the five-family matrix arm runs. */
const MATRIX_AT_SECONDS = boundedEnvNumber('B25A_MATRIX_AT_SECONDS', 75, 20)

/**
 * THE FAMILIES THIS RUN MEASURES.
 *
 * The first five are the default. `draft-create` and `version-fork` are the
 * other doors of the bootstrap family — the one that mints documents BEFORE a
 * `versions` row exists. The merge is routed and guarded by
 * `requireWriteAuthority`, so during an outage it answers 503; these two doors
 * carry no such authority and reach `forkRoot` directly, which makes them the
 * instrument for the storage fence: the fence is the ONLY thing between them
 * and a durable write on a lease-less cell.
 *
 * `B25A_FAMILIES` is validated against this list: a typo would otherwise be a
 * family that silently measures nothing.
 */
const KNOWN_FAMILIES = [
  'repair-summary-flag', 'demote-summary', 'promote-summary', 'reference-integrity', 'draft-merge',
  'draft-create', 'version-fork',
  // THE AI TOOL DOOR — `POST /api/ai/tools/:name` executes one tool. These
  // doors are routed in production, and a router refusal says nothing about
  // the fence. To reach `forkRoot` / `applyMerge` directly, `aiTool` sends
  // `x-maplespire-sync-bench-unrouted`, which a cell honours only under
  // `SYNC_CELL_BENCH_UNROUTED=on` (the bench manifest sets it; no shipped
  // manifest may, asserted by `routerDeployment.test.ts`) and only on this
  // door. A cell without it answers 400 and `aiTool` THROWS — a mis-armed run
  // dies rather than measuring routing and calling it the fence.
  'ai-draft-create', 'ai-version-fork', 'ai-draft-merge', 'ai-draft-merge-content',
]
const FAMILIES = (() => {
  const raw = process.env.B25A_FAMILIES
  if (raw === undefined || raw.trim() === '') return KNOWN_FAMILIES.slice(0, 5)
  const wanted = raw.split(',').map((f) => f.trim()).filter(Boolean)
  const unknown = wanted.filter((f) => !KNOWN_FAMILIES.includes(f))
  if (unknown.length > 0) throw new Error(`B25A_FAMILIES names families this bench does not know: ${unknown.join(', ')}`)
  if (wanted.length === 0) throw new Error('B25A_FAMILIES is set but names no family')
  return wanted
})()
/** The families whose preparation needs a PROJECTED workspace — the five
 *  originals go through `project()` because their doors read `ro_*` rows; the
 *  two bootstrap doors fork the root and read no read model. */
const FAMILIES_NEEDING_PROJECTION = new Set(KNOWN_FAMILIES.slice(0, 5))
/**
 * The bootstrap doors, in the TWO populations the verdict has to tell apart.
 * The routed HTTP doors are refused by the ROUTER on a lease-less cell (owner
 * unavailable) — a correct answer that says nothing about the fence. The AI
 * doors are refused by the bootstrap mechanism itself — the scope's authority
 * before the first mint, or the storage fence on a save — and only for those
 * does the verdict demand that the refusal be attributable to it.
 */
const ROUTED_BOOTSTRAP_FAMILIES = new Set(['draft-create', 'version-fork'])
const AI_BOOTSTRAP_FAMILIES = new Set(['ai-draft-create', 'ai-version-fork', 'ai-draft-merge', 'ai-draft-merge-content'])
const BOOTSTRAP_FAMILIES = new Set([...ROUTED_BOOTSTRAP_FAMILIES, ...AI_BOOTSTRAP_FAMILIES])
/**
 * How many components the seeded draft carries: one more than the overlay
 * segment size (`overlaySegments.ts`, `DEFAULT_SEGMENT_SIZE`, 32 by default),
 * so merging it makes `writeOverlayEntities` ROTATE a segment on the parent —
 * the fourth creation site of `applyMerge`, which an empty draft never reaches.
 * Overridable for a bench whose cell runs with `AM_OVERLAY_SEGMENT_SIZE` raised.
 */
const SEEDED_COMPONENTS = boundedEnvNumber('B25A_SEEDED_COMPONENTS', 33, 2)
/**
 * The sweep is `draft-merge`'s: fifteen extra merges across the outage. A run
 * that is not about the merge's timing has no use for them, and they cost
 * fifteen prepared workspaces and a minute of Redis-down time each.
 * `B25A_SKIP_SWEEP=1` drops the sweep; the sweep is also skipped when
 * `draft-merge` is not among the families, because it measures nothing else.
 */
const SWEEP_ENABLED = process.env.B25A_SKIP_SWEEP !== '1' && FAMILIES.includes('draft-merge')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...p) => console.log(...p)
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const CELL_CONTAINER = process.env.B25A_CELL_CONTAINER ?? 'maplespire-sync-active-active-sync-cell-a-1'

/**
 * Read a knob from the CELL ITSELF rather than restating the compose default
 * here. The lease TTL is the boundary this whole sweep is built around, so a
 * copy of it in this file is a second place for one fact to live — and a bench
 * started with an override would then be described by a number it does not use.
 */
function cellEnv(name) {
  const raw = docker('inspect', CELL_CONTAINER, '--format', `{{range .Config.Env}}{{println .}}{{end}}`)
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`))
  return line === undefined ? null : line.slice(name.length + 1).trim()
}

// A visible separator: invisible control bytes would work while being
// corrupted consistently on both sides.
const SEP = '|~|'
function sql(query) {
  const raw = docker('exec', PG, 'psql', '-U', 'maplespire', '-d', 'maplespire', '-A', '-F', SEP, '-t', '-c', query)
  return raw.split('\n').filter((l) => l.trim() !== '').map((l) => l.split(SEP))
}

// `t0` is set the moment the outage witness first reports false. Every request
// stamps its real offset from it; nothing derives an offset from a constant.
let outageStartedAtMs = null
const secondsAfterOutage = () => (outageStartedAtMs === null
  ? null
  : Number(((Date.now() - outageStartedAtMs) / 1_000).toFixed(2)))

async function req(url, { cookie, method = 'GET', body, timeoutMs = 90_000, headers: extraHeaders } = {}) {
  const headers = { ...extraHeaders }
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const startedAt = Date.now()
  const startedAfterOutage = secondsAfterOutage()
  let response
  try {
    response = await fetch(url, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      status: 0, route: null, retryAfter: null, body: `FETCH-FAILED: ${error.message}`,
      elapsedMs: Date.now() - startedAt, startedAfterOutage, finishedAfterOutage: secondsAfterOutage(),
    }
  }
  const text = await response.text()
  let parsed = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* keep the text */ }
  return {
    status: response.status,
    route: response.headers.get('x-maplespire-sync-route'),
    retryAfter: response.headers.get('retry-after'),
    body: parsed,
    elapsedMs: Date.now() - startedAt,
    startedAfterOutage,
    finishedAfterOutage: secondsAfterOutage(),
  }
}

async function login() {
  const response = await fetch(`${CELL}/api/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL }), signal: AbortSignal.timeout(15_000),
  })
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error(`dev-login gave no cookie (HTTP ${response.status})`)
  return cookie
}

/** The server's own view of its Redis client, not the container's state. */
async function redisWitness(cookie) {
  const runtime = await req(`${CELL}/api/platform/distributed-runtime`, { cookie, timeoutMs: 15_000 })
  const ready = await req(`${CELL}/api/ready`, { timeoutMs: 15_000 })
  return {
    distributedRuntimeStatus: runtime.status,
    redis: runtime.body?.redis ?? null,
    readyStatus: ready.status,
    readyChecks: ready.body?.checks ?? null,
  }
}

/**
 * Convergence, as the cell states it. `syncCellConverged` on `/api/ready` is
 * `ownership.ready`; the counts behind it come from `/api/platform/sync-cell`
 * so a reader can see WHY it is false — a spare with no partition and a cell
 * that has lost leases both report false and mean different things.
 */
async function convergenceWitness(cookie) {
  const ready = await req(`${CELL}/api/ready`, { timeoutMs: 15_000 })
  const cell = await req(`${CELL}/api/platform/sync-cell`, { cookie, timeoutMs: 15_000 })
  const fence = cell.body?.storageFence ?? null
  const scope = cell.body?.bootstrapScope ?? null
  return {
    converged: ready.body?.checks?.syncCellConverged ?? null,
    /**
     * THE BOOTSTRAP SCOPE'S OWN COUNTERS: scopes opened, refused
     * at open (no lease for the forker), lost mid-scope, opened unfenced. A
     * refusal BEFORE the first mint is counted here and not by the storage
     * fence, so the verdict adds the two. `null` on a cell built before them.
     */
    bootstrapScope: scope === null ? null : {
      opened: scope.opened ?? null,
      refusedAtOpen: scope.refusedAtOpen ?? null,
      lostMidScope: scope.lostMidScope ?? null,
      unfenced: scope.unfenced ?? null,
    },
    canServe: ready.body?.checks?.syncCellOwnership ?? null,
    partitionIndex: cell.body?.partitionIndex ?? null,
    partitionReady: cell.body?.partitionReady ?? null,
    ownedWorkspaceCount: cell.body?.ownedWorkspaceCount ?? null,
    expectedWorkspaceCount: cell.body?.expectedWorkspaceCount ?? null,
    conflictCount: cell.body?.conflictCount ?? null,
    /**
     * THE FENCE'S OWN COUNTERS, in the artifact rather than in a container log.
     * A fence refusal and a pool timeout both render
     * `{"error":"read model query failed"}`; a delta on
     * `rejectedMutationsByReason` between two samples tells them apart.
     *
     * Movement of `quarantinedMutationCount` and
     * `provisionallyFencedMutationCount` says whether the bootstrap family is
     * being fenced at all.
     */
    storageFence: fence === null ? null : {
      rejectedMutationsByReason: fence.rejectedMutationsByReason ?? null,
      rejectedMutationCount: fence.rejectedMutationCount ?? null,
      quarantinedMutationCount: fence.quarantinedMutationCount ?? null,
      provisionallyFencedMutationCount: fence.provisionallyFencedMutationCount ?? null,
      /**
       * Saves the fence checked against a BOOTSTRAP authority (the forker's
       * lease) and admitted. `null` on a cell built without the counter, so
       * the verdict below can tell "the field is absent" (VOID) from "the
       * fence consulted nothing" (zero).
       */
      bootstrapFencedMutationCount: fence.bootstrapFencedMutationCount ?? null,
      /** Refusals whose operand came from a bootstrap entry — either reason.
       *  `rejectedMutationsByReason` pools the three placement sources, so a
       *  delta there says "some fence refused"; this one says WHICH. */
      bootstrapFenceRejectionCount: fence.bootstrapFenceRejectionCount ?? null,
      mappedMutationCount: fence.mappedMutationCount ?? null,
      coalescedOwnershipUnavailableCount: fence.coalescedOwnershipUnavailableCount ?? null,
    },
  }
}

/** Block until this cell is converged, or give up and say so rather than run anyway. */
async function awaitConvergence(cookie, label, timeoutSeconds = 90) {
  for (let attempt = 1; attempt <= timeoutSeconds; attempt += 1) {
    const witness = await convergenceWitness(cookie)
    if (witness.converged === true) {
      log(`  [${label}] converged after ${attempt} poll(s): owned=${witness.ownedWorkspaceCount}/${witness.expectedWorkspaceCount}`)
      return { ...witness, polls: attempt, timedOut: false }
    }
    await sleep(1_000)
  }
  const witness = await convergenceWitness(cookie)
  log(`  [${label}] !! NOT CONVERGED after ${timeoutSeconds}s: owned=${witness.ownedWorkspaceCount}/${witness.expectedWorkspaceCount}`)
  return { ...witness, polls: timeoutSeconds, timedOut: true }
}

/**
 * Does this cell still answer "owner" for this workspace? `x-maplespire-sync-route`
 * is the cell's own answer, which is the only ownership statement available over
 * HTTP.
 */
async function ownershipWitness(cookie, w) {
  const probe = await req(`${CELL}/api/automerge/root?${new URLSearchParams(w)}`, { cookie, timeoutMs: 20_000 })
  return {
    httpStatus: probe.status, route: probe.route, rootUrl: probe.body?.url ?? null,
    atSecondsAfterOutage: probe.startedAfterOutage,
  }
}

const documentIdOf = (rootUrl) => (rootUrl ?? '').replace(/^automerge:/, '')

/**
 * Storage for a set of document ids, resolved DIRECTLY and not through
 * `automerge_document_workspace`: the mapping join cannot see a document that
 * was created by the request under measurement, which is precisely what a
 * merge does.
 */
function storageByDocumentIds(ids) {
  const wanted = [...new Set(ids.filter((id) => id !== ''))]
  if (wanted.length === 0) return []
  const list = wanted.map((id) => `'${id}'`).join(',')
  const rows = sql(`SELECT split_part(key,'/',1) AS document_id, count(*), coalesce(sum(length(data)),0)
                    FROM automerge_storage
                    WHERE split_part(key,'/',1) IN (${list})
                    GROUP BY 1 ORDER BY 1`)
  const seen = new Map(rows.map(([documentId, chunks, bytes]) => [documentId, {
    documentId, chunks: Number(chunks), bytes: Number(bytes),
  }]))
  // Present-with-zero is a DIFFERENT fact from absent, and a root row naming a
  // document with no chunks is the dangling root this measurement asks about.
  return wanted.map((id) => seen.get(id) ?? { documentId: id, chunks: 0, bytes: 0 })
}

/**
 * DOCUMENTS REACHABLE FROM NOTHING — the plane this bench's question turns on.
 *
 * `stateOf` reads two document planes and BOTH are anchored to a workspace: the
 * roots a `versions` row names, and storage joined through
 * `automerge_document_workspace`. A half-finished merge produces documents with
 * NEITHER: `applyMerge` (and `forkRoot`) mint and flush first and claim
 * afterwards, inside the transaction that inserts the `versions` row. If the
 * request dies in between, the chunks are durable and nothing points at them.
 *
 * This probe is anchored to NOTHING on purpose — a full-table anti-join —
 * because that is the only way to see a write that belongs to no one.
 * `storage-adapter-id` is the adapter's own bookkeeping row, not a document,
 * and is the single deliberate exclusion.
 */
function orphanDocuments() {
  // GROUPED BY DOCUMENT, not by chunk: otherwise a two-chunk orphan is
  // reported as two orphans.
  const rows = sql(`SELECT min(s.created_at), split_part(s.key,'/',1),
                           count(*), coalesce(sum(length(s.data)),0)
                    FROM automerge_storage s
                    LEFT JOIN automerge_document_workspace m
                      ON m.document_id = split_part(s.key,'/',1)
                    LEFT JOIN versions v
                      ON replace(v.root_url,'automerge:','') = split_part(s.key,'/',1)
                    WHERE m.document_id IS NULL AND v.id IS NULL
                      AND split_part(s.key,'/',1) <> 'storage-adapter-id'
                    GROUP BY split_part(s.key,'/',1)
                    ORDER BY min(s.created_at)`)
  return rows.map(([createdAt, documentId, chunks, bytes]) => ({
    createdAt, documentId, chunks: Number(chunks), bytes: Number(bytes),
  }))
}

/**
 * How many documents does a version actually OWN? A merge claims six
 * (`forkRoot` copies the whole control graph), so a probe that verifies one
 * root has verified a sixth of the write. Keyed on the version id the merge
 * RETURNED — the one `stateOf` cannot use, because it is scoped to the version
 * under measurement and the merge's rows land under a different one.
 */
function claimedDocumentCount(landscapeId, versionId) {
  const rows = sql(`SELECT count(*) FROM automerge_document_workspace
                    WHERE landscape_id='${landscapeId}' AND version_id='${versionId}'`)
  return Number(rows[0]?.[0] ?? 0)
}

/**
 * Durable state across every plane a write on these routes can touch.
 *
 * `light` exists for the sweep and is a TIME-RESOLUTION decision, not a
 * shortcut. A full reading costs six `docker exec psql` round trips, about two
 * seconds; taken twice per request that smears five consecutive sweep samples
 * across thirty seconds of wall clock. The light reading keeps the two planes
 * that can answer the question for `draft-merge` (the version rows, and the
 * storage behind every root they name) and drops the four counters that a merge
 * does not touch. Which planes were read is recorded on every sample, so no
 * reader has to infer it.
 */
function stateOf(w, { light = false } = {}) {
  const versions = sql(`SELECT id, kind, status, coalesce(root_url,''), coalesce(parent_version_id,'')
                        FROM versions WHERE landscape_id = '${w.landscapeId}' ORDER BY id`)
  const versionRows = versions.map(([id, kind, status, rootUrl, parent]) => ({
    id, kind, status, rootUrl, parentVersionId: parent || null,
  }))
  const rootDocumentsLight = storageByDocumentIds(versionRows.map((row) => documentIdOf(row.rootUrl)))
  // ONE definition, used by both returns, so a regression cannot blind one
  // site while the other keeps firing.
  const danglingRoots = rootDocumentsLight.filter((d) => d.chunks === 0).map((d) => d.documentId)
  if (light) {
    return {
      planesRead: ['versions', 'rootDocuments'],
      versionRows,
      rootDocuments: rootDocumentsLight,
      danglingRoots,
    }
  }
  const statics = sql(`SELECT count(*) FROM read_model_static_workspaces
                       WHERE landscape_id='${w.landscapeId}' AND version_id='${w.versionId}'`)
  const audits = sql(`SELECT count(*) FROM audit_log
                      WHERE target_id='${w.landscapeId}/${w.versionId}'`)
  const mappings = sql(`SELECT count(*) FROM automerge_document_workspace
                        WHERE landscape_id='${w.landscapeId}' AND version_id='${w.versionId}'`)
  // Plane A: everything mapped to this workspace.
  const mapped = sql(`SELECT count(*), coalesce(sum(length(s.data)),0)
                      FROM automerge_storage s
                      JOIN automerge_document_workspace m
                        ON m.document_id = split_part(s.key,'/',1)
                      WHERE m.landscape_id='${w.landscapeId}' AND m.version_id='${w.versionId}'`)
  const perMappedDocument = sql(`SELECT m.document_id, count(s.key), coalesce(sum(length(s.data)),0)
                                 FROM automerge_document_workspace m
                                 LEFT JOIN automerge_storage s
                                   ON split_part(s.key,'/',1) = m.document_id
                                 WHERE m.landscape_id='${w.landscapeId}' AND m.version_id='${w.versionId}'
                                 GROUP BY m.document_id ORDER BY m.document_id`)
  // Plane B: every root this workspace's version rows NAME, mapped or not.
  const rootDocuments = rootDocumentsLight
  return {
    planesRead: ['versions', 'rootDocuments', 'readModelStatic', 'auditLog', 'documentMapping', 'mappedStorage'],
    versionRows,
    staticWorkspaceRows: Number(statics[0]?.[0] ?? 0),
    auditRows: Number(audits[0]?.[0] ?? 0),
    documentMappingRows: Number(mappings[0]?.[0] ?? 0),
    storagePlane: {
      chunks: Number(mapped[0]?.[0] ?? 0),
      bytes: Number(mapped[0]?.[1] ?? 0),
      perDocument: perMappedDocument.map(([documentId, chunks, bytes]) => ({
        documentId, chunks: Number(chunks), bytes: Number(bytes),
      })),
    },
    rootDocuments,
    /** A version row whose root has zero chunks: a durable pointer to nothing. */
    danglingRoots,
  }
}

const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b)
const rootsChanged = (a, b) => JSON.stringify(a.rootDocuments) !== JSON.stringify(b.rootDocuments)
/**
 * `null`, NOT `false`, when the plane was not read. A light sample does not
 * carry `storagePlane`, and `undefined !== undefined` is false — which would
 * report "the mapped storage plane did not move" for a plane nobody looked at.
 */
const storageChanged = (a, b) => (a.storagePlane === undefined || b.storagePlane === undefined
  ? null
  : JSON.stringify(a.storagePlane) !== JSON.stringify(b.storagePlane))

async function freshOwnedWorkspaces(cookie, wanted, tag) {
  const found = []
  for (let round = 1; round <= 10 && found.length < wanted; round += 1) {
    const made = []
    for (let i = 0; i < Math.max(4, (wanted - found.length) * 3); i += 1) {
      const created = await req(`${CELL}/api/landscapes`, {
        cookie, method: 'POST', body: { name: `B2-5a ${tag} r${round} n${i}` },
      })
      const l = created.body?.landscape
      if (l?.id && l?.defaultVersionId) made.push({ landscapeId: l.id, versionId: l.defaultVersionId })
    }
    for (const w of made) {
      if (found.length >= wanted) break
      const witness = await ownershipWitness(cookie, w)
      if (witness.httpStatus === 200 && witness.route === 'owner') found.push(w)
    }
    log(`  [${tag}] round ${round}: ${found.length}/${wanted} owned by this cell`)
  }
  if (found.length < wanted) throw new Error(`[${tag}] only ${found.length}/${wanted} workspaces owned by this cell`)
  return found
}

async function project(cookie, w, label) {
  const query = new URLSearchParams(w).toString()
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    await req(`${CELL}/api/model/cache/estimate?${query}`, { cookie })
    const report = await req(`${CELL}/api/platform/workspace/promote-summary`, {
      cookie, method: 'POST', body: { ...w, apply: false },
    })
    const codes = (report.body?.blockers ?? []).map((b) => b.code)
    if (report.status === 200 && codes.length === 0) return { projected: true, attempts: attempt }
    if (!codes.includes('read-model-not-caught-up') && !codes.includes('read-model-not-sealed')) {
      return { projected: false, attempts: attempt, blockers: codes }
    }
    await sleep(1_500)
  }
  throw new Error(`${label} never became promotable`)
}

/**
 * One AI tool, executed synchronously on `w` through the door — WITH THE BENCH
 * HEADER that skips placement.
 *
 * The body's top-level `landscapeId`/`versionId` select the tool's workspace
 * (`resolveAiToolCtx`); `input` is the tool's own payload.
 *
 * ## Why the header, and why its refusal is fatal here
 *
 * This door is routed, so on a lease-less cell a plain request stops at the
 * ROUTER, and a router refusal says nothing about the fence. The header lets
 * the request reach the bootstrap mechanism itself.
 *
 * `SYNC_CELL_BENCH_UNROUTED=on` in the bench manifest arms one header on this
 * one surface. A cell without it answers 400 rather than ignoring the header,
 * and the throw below turns that into a dead bench instead of one that quietly
 * measures routing and records it as the fence.
 */
const BENCH_UNROUTED_HEADER = 'x-maplespire-sync-bench-unrouted'

async function aiTool(cookie, w, name, input, timeoutMs) {
  const answer = await req(`${CELL}/api/ai/tools/${name}`, {
    cookie, method: 'POST', body: { landscapeId: w.landscapeId, versionId: w.versionId, input },
    headers: { [BENCH_UNROUTED_HEADER]: '1' },
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  if (answer.status === 400 && /bench routing bypass is not armed/.test(JSON.stringify(answer.body ?? ''))) {
    throw new Error(
      'the cell refused the bench routing bypass: this run would measure the ROUTER, not the bootstrap fence. '
      + 'Set SYNC_CELL_BENCH_UNROUTED=on in the bench manifest (infra/compose/sync-cell-failover.yml) and rebuild the cells.',
    )
  }
  return answer
}

/**
 * A draft whose lease THIS cell holds. `firstDraftId` is tried first; when a
 * draft lands on the other cell (`route: 'proxied'`) a new one is minted, up
 * to `rounds`. Each candidate is polled through the reconcile tick, so the
 * ownership wait is measured (`waitedMs`) rather than assumed.
 */
async function ownedDraft(cookie, w, label, firstDraftId) {
  const rounds = 8
  const startedAt = Date.now()
  let draftId = firstDraftId
  let minted = 0
  for (let round = 1; round <= rounds; round += 1) {
    const draft = { landscapeId: w.landscapeId, versionId: draftId }
    let route = null
    for (let poll = 0; poll < 16; poll += 1) {
      const witness = await ownershipWitness(cookie, draft)
      if (witness.httpStatus === 200) { route = witness.route; break }
      await sleep(1_000)
    }
    if (route === 'owner') {
      return { draftId, rounds: round, minted, waitedMs: Date.now() - startedAt }
    }
    log(`  [${label}] draft ${draftId} is ${route ?? 'unleased'} on this cell (round ${round}); minting another`)
    const created = await aiTool(cookie, w, 'create_draft', { label: `B2-5d ${label} r${round + 1}` }, 60_000)
    draftId = created.body?.result?.draft?.id ?? null
    minted += 1
    if (!draftId) throw new Error(`${label}: AI create_draft (round ${round + 1}) failed (HTTP ${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`)
  }
  throw new Error(`${label}: no draft owned by this cell after ${rounds} rounds`)
}

/** A draft seeded with one system, one container and `SEEDED_COMPONENTS`
 *  components — enough entities that merging it rotates an overlay segment on
 *  the parent. Seeded through the AI door ON THE DRAFT WORKSPACE, Redis alive. */
async function seedDraft(cookie, w, draftId, label) {
  const draft = { landscapeId: w.landscapeId, versionId: draftId }
  const components = Array.from({ length: SEEDED_COMPONENTS }, (_, i) => ({
    name: `Component ${i + 1} ${label}`, description: `seeded component ${i + 1}`,
  }))
  const seeded = await aiTool(cookie, draft, 'create_architecture', {
    systems: [{
      name: `System ${label}`, description: 'seeded system',
      containers: [{ kind: 'app', name: `App ${label}`, description: 'seeded app', components }],
    }],
  }, 60_000)
  if (seeded.status !== 200) throw new Error(`${label}: seeding the draft failed (HTTP ${seeded.status}): ${JSON.stringify(seeded.body).slice(0, 300)}`)
  return { seededComponents: SEEDED_COMPONENTS, seededDiagrams: seeded.body?.result?.diagrams?.length ?? null }
}

async function prepare(family, cookie, w, label) {
  // The bootstrap doors need nothing projected: `createDraft` and a forked
  // `createVersion` read the root through the repo and never touch `ro_*`.
  // Waiting for a projection there would only make the outage arm start later.
  const setup = FAMILIES_NEEDING_PROJECTION.has(family)
    ? { projection: await project(cookie, w, label) }
    : { projection: null, label }
  if (family === 'ai-draft-merge' || family === 'ai-draft-merge-content') {
    // The draft is created through the same door it will be merged through,
    // while Redis is alive; the merge is what the arm measures.
    const created = await aiTool(cookie, w, 'create_draft', { label: `B2-5d ${label}` }, 60_000)
    setup.draftId = created.body?.result?.draft?.id ?? null
    if (!setup.draftId) throw new Error(`${label}: AI create_draft failed (HTTP ${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`)
    if (family === 'ai-draft-merge-content') {
      // Seeding WRITES the draft, so the draft's own lease must be held by
      // THIS cell — the merge only needs the parent's. A fresh draft is
      // lease-able (`status = 'active'`) but acquired on the next reconcile
      // tick, and in active-active it may land on the other cell, whose AI
      // door this bench does not know. So: wait for the lease, and re-mint the
      // draft when it lands elsewhere. Seeding right after creation is
      // otherwise refused `ownership-unavailable` by the very fence under
      // test — correct behaviour, but not the arm's result.
      setup.draftOwnership = await ownedDraft(cookie, w, label, setup.draftId)
      setup.draftId = setup.draftOwnership.draftId
      setup.seed = await seedDraft(cookie, w, setup.draftId, label)
    }
  }
  if (family === 'draft-merge') {
    const created = await req(`${CELL}/api/landscapes/${w.landscapeId}/drafts`,
      { cookie, method: 'POST', body: { label: `B2-5a ${label}` } })
    setup.draftId = created.body?.draft?.id ?? null
    if (!setup.draftId) throw new Error(`${label}: draft creation failed (HTTP ${created.status})`)
  }
  if (family === 'demote-summary' || family === 'repair-summary-flag') {
    const promoted = await req(`${CELL}/api/platform/workspace/promote-summary`,
      { cookie, method: 'POST', body: { ...w, apply: true } })
    setup.promoteApplied = Boolean(promoted.body?.applied)
    setup.promoteBlockers = (promoted.body?.blockers ?? []).map((b) => b.code)
  }
  return setup
}

async function fire(family, cookie, w, setup) {
  if (family === 'draft-merge') {
    return req(`${CELL}/api/landscapes/${w.landscapeId}/drafts/${setup.draftId}/merge`,
      { cookie, method: 'POST', body: { resolutions: {} } })
  }
  // The bootstrap doors. Each forks the workspace's own version through
  // `forkRoot` — SIX documents on this bench's empty landscapes, the same six
  // the merge snapshot mints — and publishes a `versions` row for the twin.
  // Neither carries `requireWriteAuthority`, so what refuses them on a
  // lease-less cell is the storage fence, or nothing.
  if (family === 'draft-create') {
    return req(`${CELL}/api/landscapes/${w.landscapeId}/drafts`,
      { cookie, method: 'POST', body: { label: `B2-5d ${setup.label ?? 'draft'}` } })
  }
  if (family === 'version-fork') {
    return req(`${CELL}/api/landscapes/${w.landscapeId}/versions`,
      { cookie, method: 'POST', body: { label: `B2-5d ${setup.label ?? 'fork'}`, forkFromVersionId: w.versionId } })
  }
  // The AI doors: the same three bootstrap operations, with the bench header
  // removing the router and `placeMergeWrite` from in front of the family.
  if (family === 'ai-draft-create') {
    return aiTool(cookie, w, 'create_draft', { label: `B2-5d ${setup.label ?? 'draft'}` }, 60_000)
  }
  if (family === 'ai-version-fork') {
    return aiTool(cookie, w, 'create_version', { label: `B2-5d ${setup.label ?? 'fork'}`, forkFromVersionId: w.versionId }, 60_000)
  }
  if (family === 'ai-draft-merge' || family === 'ai-draft-merge-content') {
    return aiTool(cookie, w, 'merge_draft', { draftId: setup.draftId, resolutions: {} }, 60_000)
  }
  const path = family === 'reference-integrity'
    ? '/api/platform/reference-integrity/repair'
    : `/api/platform/workspace/${family}`
  return req(`${CELL}${path}`, { cookie, method: 'POST', body: { ...w, apply: true } })
}

/** One measured request: state before, the call, state after, and both witnesses. */
async function measure(family, cookie, unit, cookieLabel, { light = false } = {}) {
  const { workspace: w, setup } = unit
  const before = stateOf(w, { light })
  const orphansBefore = orphanDocuments()
  const convergenceBefore = await convergenceWitness(cookie)
  const ownershipBefore = await ownershipWitness(cookie, w)
  const response = await fire(family, cookie, w, setup)
  const ownershipAfter = await ownershipWitness(cookie, w)
  // ALWAYS taken, light or not: the fence counters ride on this call, and a
  // delta needs both ends.
  const convergenceAfter = await convergenceWitness(cookie)
  const after = stateOf(w, { light })
  const orphansAfter = orphanDocuments()
  // The write this request left behind that belongs to NO workspace. Taken as a
  // set difference so a concurrent leftover from an earlier request is not
  // re-attributed to this one.
  const seen = new Set(orphansBefore.map((o) => o.documentId))
  const orphansCreated = orphansAfter.filter((o) => !seen.has(o.documentId))
  // A merge returns the id of the version it created; its documents are claimed
  // under THAT id, which is why `stateOf` — scoped to the version being measured
  // — cannot count them. The two bootstrap doors return theirs under
  // `draft.id` and `version.id`; an EMPTY string is the merge's
  // "already merged" answer and names no version, so it stays null.
  const returnedVersionId = [
    response.body?.versionId, response.body?.draft?.id, response.body?.version?.id,
    // The AI door wraps its tool's answer in `result`.
    response.body?.result?.draft?.id, response.body?.result?.version?.id, response.body?.result?.snapshotVersionId,
  ].find((value) => typeof value === 'string' && value !== '') ?? null
  const result = {
    label: cookieLabel,
    planesRead: [...after.planesRead, 'orphanDocuments'],
    returnedVersionId,
    claimedDocumentsForReturnedVersion: returnedVersionId
      ? claimedDocumentCount(w.landscapeId, returnedVersionId)
      : null,
    orphanDocumentsCreated: orphansCreated,
    orphanDocumentCount: orphansCreated.length,
    orphanBytes: orphansCreated.reduce((total, o) => total + o.bytes, 0),
    workspace: w,
    http: response.status,
    route: response.route,
    retryAfter: response.retryAfter,
    elapsedMs: response.elapsedMs,
    startedAfterOutage: response.startedAfterOutage,
    finishedAfterOutage: response.finishedAfterOutage,
    body: response.body,
    convergenceBefore,
    convergenceAfter,
    ownershipBefore,
    ownershipAfter,
    stateBefore: before,
    stateAfter: after,
    durableStateChanged: changed(before, after),
    storagePlaneChanged: storageChanged(before, after),
    rootDocumentsChanged: rootsChanged(before, after),
    danglingRootsAfter: after.danglingRoots,
    // The bench's actual question: did this request leave durable bytes
    // behind that belong to no workspace?
    /**
     * TWO FIELDS, because gating on the status code narrows the question.
     * `leftOrphans` is "this request left a half-state";
     * `partialMutationOnFailure` is the sharper sub-case — it failed AND still
     * wrote. Reporting only the second would hide merges that returned 200
     * while leaking orphans.
     */
    leftOrphans: orphansCreated.length > 0,
    partialMutationOnFailure: response.status >= 400 && orphansCreated.length > 0,
    /**
     * Which mechanism produced this response, from the fence's own counters
     * rather than from a body that says the same thing for both. A non-zero
     * `ownership-unavailable` delta is a fence refusal; a zero delta on a
     * failure is something else, such as a pool acquisition timeout.
     */
    fenceRejectionDelta: (() => {
      const a = convergenceBefore.storageFence?.rejectedMutationsByReason
      const b = convergenceAfter.storageFence?.rejectedMutationsByReason
      if (!a || !b) return null
      return Object.fromEntries(Object.keys(b).map((reason) => [reason, (b[reason] ?? 0) - (a[reason] ?? 0)]))
    })(),
    quarantinedDelta: (convergenceAfter.storageFence?.quarantinedMutationCount ?? null) === null
      || (convergenceBefore.storageFence?.quarantinedMutationCount ?? null) === null
      ? null
      : convergenceAfter.storageFence.quarantinedMutationCount - convergenceBefore.storageFence.quarantinedMutationCount,
    /**
     * The fence's PRESENCE witness. On the control arm a fork of six documents
     * must move this by at least six: the fence looked up each save's
     * bootstrap authority, found the forker, and admitted under its lease. A
     * fence that never consulted the map would leave it at zero while the
     * request still answered 200, which is why the verdict needs this beside
     * the status code. `null` when either sample lacks the field.
     */
    bootstrapFencedDelta: (convergenceAfter.storageFence?.bootstrapFencedMutationCount ?? null) === null
      || (convergenceBefore.storageFence?.bootstrapFencedMutationCount ?? null) === null
      ? null
      : convergenceAfter.storageFence.bootstrapFencedMutationCount - convergenceBefore.storageFence.bootstrapFencedMutationCount,
    /** Refusals attributable to a bootstrap entry on a SAVE. */
    bootstrapFenceRejectionDelta: (convergenceAfter.storageFence?.bootstrapFenceRejectionCount ?? null) === null
      || (convergenceBefore.storageFence?.bootstrapFenceRejectionCount ?? null) === null
      ? null
      : convergenceAfter.storageFence.bootstrapFenceRejectionCount - convergenceBefore.storageFence.bootstrapFenceRejectionCount,
    /** Refusals BEFORE any mint — the scope asked for the forker's authority
     *  and was told no — plus scopes that lost it mid-way. */
    bootstrapAuthorityRefusalDelta: (() => {
      const a = convergenceBefore.bootstrapScope
      const b = convergenceAfter.bootstrapScope
      if (!a || !b || a.refusedAtOpen === null || b.refusedAtOpen === null) return null
      return (b.refusedAtOpen - a.refusedAtOpen) + ((b.lostMidScope ?? 0) - (a.lostMidScope ?? 0))
    })(),
  }
  log(`    ${cookieLabel.padEnd(30)} HTTP ${String(response.status).padEnd(4)}`
    + ` t=${String(response.startedAfterOutage ?? '-').padEnd(6)}`
    + ` own=${ownershipBefore.route ?? ownershipBefore.httpStatus}`
    + ` conv=${convergenceBefore.converged}`
    + ` dur=${result.durableStateChanged} roots=${result.rootDocumentsChanged}`
    + ` claimed=${result.claimedDocumentsForReturnedVersion ?? '-'}`
    + ` ORPHANS=${orphansCreated.length}/${result.orphanBytes}B`
    + ` partialOnFailure=${result.partialMutationOnFailure}`
    + ` fenceRefusals=${result.fenceRejectionDelta ? result.fenceRejectionDelta['ownership-unavailable'] : '-'}`
    + ` bootstrapFenced=${result.bootstrapFencedDelta ?? '-'}`
    + ` bootstrapRefused=${result.bootstrapAuthorityRefusalDelta ?? '-'}+${result.bootstrapFenceRejectionDelta ?? '-'}`
    + ` ${response.elapsedMs}ms`)
  return result
}

const main = async () => {
  const cookie = await login()

  // The boundary the sweep is read against, taken from the cell that will be
  // measured. `ownership.ts` clamps this value into [6000, 120000] with a
  // default of 15000, so an absent variable is reported as the default AND as
  // having come from the default — a reader must not have to guess which.
  const rawLeaseTtl = cellEnv('SYNC_CELL_LEASE_TTL_MS')
  const leaseTtlSource = rawLeaseTtl === null || rawLeaseTtl === ''
    ? `default in ownership.ts (SYNC_CELL_LEASE_TTL_MS unset on ${CELL_CONTAINER})`
    : `SYNC_CELL_LEASE_TTL_MS on ${CELL_CONTAINER}`
  const parsedLeaseTtl = Number(rawLeaseTtl)
  const leaseTtlMs = Number.isFinite(parsedLeaseTtl) && parsedLeaseTtl > 0
    ? Math.min(120_000, Math.max(6_000, Math.floor(parsedLeaseTtl)))
    : 15_000

  const record = {
    // From the environment, not a literal, so each archived run names itself.
    pass: boundedEnvNumber('B25A_PASS', 0, 0) || null,
    startedAt: new Date().toISOString(),
    config: {
      matrixN: MATRIX_N,
      sweepN: SWEEP_N,
      sweepPointsNominal: SWEEP_POINTS,
      matrixAtSeconds: MATRIX_AT_SECONDS,
      leaseTtlMs,
      leaseTtlSource,
      renewIntervalMs: cellEnv('SYNC_CELL_RENEW_INTERVAL_MS'),
      partitionCount: cellEnv('SYNC_CELL_PARTITION_COUNT'),
      topologyGeneration: cellEnv('SYNC_CELL_TOPOLOGY_GENERATION'),
      unplacedCreationMode: cellEnv('SYNC_CELL_UNPLACED_CREATION'),
      redisCommandTimeoutMs: cellEnv('REDIS_COMMAND_TIMEOUT_MS'),
      wsAuthTokenBurstCacheMs: cellEnv('WS_AUTH_TOKEN_BURST_CACHE_MS'),
    },
    familyOrder: FAMILIES,
    cellUrl: CELL,
    cellContainer: CELL_CONTAINER,
  }
  log(`lease TTL for the regime split: ${leaseTtlMs} ms (${leaseTtlSource})`)

  log('=== convergence gate BEFORE anything ===')
  record.convergenceAtStart = await awaitConvergence(cookie, 'start')

  // Every workspace this run will use, allocated and prepared while Redis is
  // alive. The sweep needs its own: a merge is not idempotent, so a sweep point
  // cannot reuse a workspace an earlier one already merged.
  const plan = { control: {}, outage: {}, sweep: {} }
  log('\n=== allocating workspaces owned by this cell ===')
  for (const family of FAMILIES) {
    plan.control[family] = (await freshOwnedWorkspaces(cookie, MATRIX_N, `p4-ctl-${family}`))
      .map((workspace) => ({ workspace }))
    plan.outage[family] = (await freshOwnedWorkspaces(cookie, MATRIX_N, `p4-out-${family}`))
      .map((workspace) => ({ workspace }))
  }
  for (const point of SWEEP_ENABLED ? SWEEP_POINTS : []) {
    plan.sweep[point] = (await freshOwnedWorkspaces(cookie, SWEEP_N, `p4-sweep-t${point}`))
      .map((workspace) => ({ workspace }))
  }

  log('\n=== SETUP (Redis ALIVE for all of it) ===')
  for (const family of FAMILIES) {
    for (const [arm, units] of [['control', plan.control[family]], ['outage', plan.outage[family]]]) {
      for (const [index, unit] of units.entries()) {
        unit.setup = await prepare(family, cookie, unit.workspace, `${family}/${arm}#${index}`)
      }
      log(`  prepared ${family}/${arm}: ${units.length}`)
    }
  }
  for (const point of SWEEP_ENABLED ? SWEEP_POINTS : []) {
    for (const [index, unit] of plan.sweep[point].entries()) {
      unit.setup = await prepare('draft-merge', cookie, unit.workspace, `sweep t${point}#${index}`)
    }
    log(`  prepared sweep t=${point}s: ${plan.sweep[point].length}`)
  }
  record.plan = Object.fromEntries(Object.entries(plan).map(([arm, byKey]) => [
    arm, Object.fromEntries(Object.entries(byKey).map(([key, units]) => [
      key, units.map((u) => ({ workspace: u.workspace, setup: u.setup })),
    ])),
  ]))

  // Preparation created ~100 landscapes; `expected.size` moved with them. Assert
  // the cell caught up BEFORE the control arm, so the control is taken on the
  // same convergence state the outage arm will be gated on.
  log('\n=== convergence gate BEFORE the control arm ===')
  record.convergenceBeforeControl = await awaitConvergence(cookie, 'pre-control')
  record.witnessBefore = await redisWitness(cookie)
  log(`witness before: redis.ready=${record.witnessBefore.redis?.ready}`)

  log('\n=== ARM 1: CONTROL (Redis ALIVE) ===')
  record.controlArm = {}
  for (const family of FAMILIES) {
    record.controlArm[family] = []
    for (const [index, unit] of plan.control[family].entries()) {
      record.controlArm[family].push(await measure(family, cookie, unit, `${family}/ctl#${index}`))
    }
  }
  // `draft-merge` under control, repeated, is the baseline the sweep is read
  // against: without it a sweep point that succeeds proves nothing about time.
  record.convergenceAfterControl = await convergenceWitness(cookie)

  log('\n=== convergence gate BEFORE the outage ===')
  record.convergenceBeforeOutage = await awaitConvergence(cookie, 'pre-outage')

  log('\n=== provoking the outage ===')
  docker('stop', REDIS)
  let flipPolls = null
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    await sleep(1_000)
    const witness = await redisWitness(cookie)
    if (witness.redis?.ready === false || witness.readyChecks?.redis === false) {
      // t0. Every offset in this record is measured from HERE; nothing
      // derives an offset from a constant.
      outageStartedAtMs = Date.now()
      // WALL CLOCK, not just the offset origin. Without this, correlating an
      // orphaned document's `created_at` with the request that produced it takes
      // an inference chain through a mapping row's `registered_at`; with it, it
      // is a subtraction.
      record.outageStartedAt = new Date(outageStartedAtMs).toISOString()
      record.witnessDuring = { ...witness, flippedAfterPolls: attempt, pollIntervalMs: 1_000 }
      flipPolls = attempt
      log(`  witness false by poll ${attempt} (1 s apart) — t0 set`)
      break
    }
  }
  if (flipPolls === null) {
    record.witnessDuring = { ...(await redisWitness(cookie)), flippedAfterPolls: null, pollIntervalMs: 1_000 }
    record.VOID = 'the outage witness never flipped — this run cannot tell "no effect" from "no outage"'
    log('  !! WITNESS NEVER FLIPPED — VOID')
    outageStartedAtMs = Date.now()
  }

  log(SWEEP_ENABLED ? '\n=== SWEEP: draft-merge across the outage ===' : '\n=== SWEEP skipped (B25A_SKIP_SWEEP, or draft-merge not measured) ===')
  record.sweep = {}
  record.sweepEnabled = SWEEP_ENABLED
  for (const point of SWEEP_ENABLED ? SWEEP_POINTS : []) {
    const waitMs = (point * 1_000) - (Date.now() - outageStartedAtMs)
    if (waitMs > 0) await sleep(waitMs)
    log(`  -- t≈${point}s (${SWEEP_N} independent workspaces) --`)
    record.sweep[point] = []
    for (const [index, unit] of plan.sweep[point].entries()) {
      record.sweep[point].push(await measure('draft-merge', cookie, unit, `sweep t${point}#${index}`, { light: true }))
    }
  }

  const matrixWaitMs = (MATRIX_AT_SECONDS * 1_000) - (Date.now() - outageStartedAtMs)
  if (matrixWaitMs > 0) await sleep(matrixWaitMs)
  record.witnessAfterSoak = await redisWitness(cookie)
  log(`\nstill down: redis.ready=${record.witnessAfterSoak.redis?.ready} errorCount=${record.witnessAfterSoak.redis?.errorCount}`)

  log('\n=== ARM 2: OUTAGE (Redis DOWN) ===')
  record.outageArm = {}
  for (const family of FAMILIES) {
    record.outageArm[family] = []
    for (const [index, unit] of plan.outage[family].entries()) {
      record.outageArm[family].push(await measure(family, cookie, unit, `${family}/out#${index}`))
    }
  }
  record.convergenceDuringOutage = await convergenceWitness(cookie)

  log('\n=== restoring Redis ===')
  docker('start', REDIS)
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    await sleep(1_000)
    const witness = await redisWitness(cookie)
    record.witnessAfter = { ...witness, recoveredAfterPolls: witness.redis?.ready === true ? attempt : null }
    if (witness.redis?.ready === true) { log(`  redis ready by poll ${attempt}`); break }
  }
  outageStartedAtMs = null
  record.convergenceAfterRecovery = await awaitConvergence(cookie, 'post-recovery', 180)

  // Did anything land LATE — after the request that was refused had returned?
  record.stateAfterRecovery = {}
  for (const family of FAMILIES) {
    record.stateAfterRecovery[family] = record.outageArm[family].map((entry) => {
      const now = stateOf(entry.workspace)
      return {
        label: entry.label,
        differsFromDuringOutage: changed(entry.stateAfter, now),
        danglingRoots: now.danglingRoots,
        state: now,
      }
    })
  }
  // LIKE FOR LIKE. A sweep sample's `stateAfter` is a LIGHT state (4 keys); a
  // full `stateOf` has 9. `changed()` is a JSON compare, so comparing the two
  // shapes could never return false — the re-read must be light too.
  record.sweepAfterRecovery = Object.fromEntries((SWEEP_ENABLED ? SWEEP_POINTS : []).map((point) => [point,
    record.sweep[point].map((entry) => {
      const now = stateOf(entry.workspace, { light: true })
      return {
        label: entry.label,
        comparedShape: 'light-vs-light',
        differsFromDuringOutage: changed(entry.stateAfter, now),
        danglingRoots: now.danglingRoots,
      }
    }),
  ]))

  // The VOID rule, stated BOTH ways: "a pass whose two columns are identical is
  // VOID", and the witness rule that directly measures what that wording is a
  // proxy for. Both are recorded.
  const summarise = (entries) => entries.map((e) => `${e.http}/${e.durableStateChanged}/${e.storagePlaneChanged}/${e.rootDocumentsChanged}`)
  record.voidCheck = Object.fromEntries(FAMILIES.map((family) => {
    const control = summarise(record.controlArm[family])
    const outage = summarise(record.outageArm[family])
    return [family, {
      controlSignatures: control,
      outageSignatures: outage,
      identicalColumns: JSON.stringify([...control].sort()) === JSON.stringify([...outage].sort()),
      outageDeterministic: new Set(outage).size === 1,
      controlDeterministic: new Set(control).size === 1,
    }]
  }))
  // THE HEADLINE, computed over every request in the run.
  const everyMeasurement = [
    ...FAMILIES.flatMap((f) => record.controlArm[f]),
    ...FAMILIES.flatMap((f) => record.outageArm[f]),
    ...(SWEEP_ENABLED ? SWEEP_POINTS : []).flatMap((point) => record.sweep[point]),
  ]
  const leaked = everyMeasurement.filter((e) => e.leftOrphans)
  const onFailure = everyMeasurement.filter((e) => e.partialMutationOnFailure)
  record.partialMutationSummary = {
    question: 'did any request leave durable bytes belonging to no workspace, and did a FAILING one?',
    measurements: everyMeasurement.length,
    withOrphans: leaked.length,
    withPartialMutationOnFailure: onFailure.length,
    orphanDocumentsTotal: leaked.reduce((n, e) => n + e.orphanDocumentCount, 0),
    orphanBytesTotal: leaked.reduce((n, e) => n + e.orphanBytes, 0),
    byLabel: leaked.map((e) => ({
      label: e.label, http: e.http, startedAfterOutage: e.startedAfterOutage,
      failed: e.http >= 400,
      orphanDocumentCount: e.orphanDocumentCount, orphanBytes: e.orphanBytes,
      documents: e.orphanDocumentsCreated,
    })),
    // The absolute census at the end, independent of any per-request
    // attribution: if this is non-empty while `withOrphans` is 0, the
    // attribution is what is broken, not the finding.
    orphansStillPresentAtEnd: orphanDocuments(),
  }

  record.convergenceHeldConstant = record.convergenceBeforeControl.converged === true
    && record.convergenceBeforeOutage.converged === true
    && record.convergenceBeforeControl.timedOut === false
    && record.convergenceBeforeOutage.timedOut === false

  log('\n=== SWEEP RESULT: draft-merge as a function of MEASURED outage age ===')
  const allSweep = (SWEEP_ENABLED ? SWEEP_POINTS : []).flatMap((point) => record.sweep[point])
    .filter((e) => e.startedAfterOutage !== null)
    .sort((a, b) => a.startedAfterOutage - b.startedAfterOutage)
  for (const entry of allSweep) {
    log(`  t=${String(entry.startedAfterOutage).padStart(6)}s  HTTP ${String(entry.http).padEnd(4)}`
      + ` own=${entry.ownershipBefore.route ?? entry.ownershipBefore.httpStatus}`
      + ` durable=${entry.durableStateChanged} roots=${entry.rootDocumentsChanged}`
      + ` dangling=${entry.danglingRootsAfter.length} ${entry.elapsedMs}ms`)
  }
  // BINNED ON THE OBSERVED LEASE STATE, NOT ON A TTL.
  //
  // `fencingToken()` consults `owns()`, which goes through `partitionIsLive()`
  // — governed by `SYNC_CELL_PARTITION_LEASE_TTL_MS` (750 ms on this bench),
  // not by the 15 s workspace TTL. The partition is gone within a second of the
  // outage, so a split on elapsed time against the workspace TTL mislabels
  // every sample. Each sample carries the cell's own answer; bin on that.
  const heldLease = (e) => (e.convergenceBefore.ownedWorkspaceCount ?? 0) > 0
    && e.convergenceBefore.partitionIndex !== null
  const inside = allSweep.filter(heldLease)
  const outside = allSweep.filter((e) => !heldLease(e))
  const codesOf = (xs) => [...new Set(xs.map((e) => e.http))].sort()
  record.sweepByLeaseRegime = {
    binnedOn: "the cell's OWN reported lease state at each request (ownedWorkspaceCount > 0 AND partitionIndex != null), not on an elapsed-time threshold",
    workspaceLeaseTtlMs: leaseTtlMs,
    workspaceLeaseTtlSource: leaseTtlSource,
    // The TTL that actually governs `owns()`, and therefore `fencingToken()`.
    partitionLeaseTtlMs: cellEnv('SYNC_CELL_PARTITION_LEASE_TTL_MS'),
    partitionRenewIntervalMs: cellEnv('SYNC_CELL_PARTITION_RENEW_INTERVAL_MS'),
    heldLease: { n: inside.length, codes: codesOf(inside), deterministic: codesOf(inside).length === 1,
      durableChanged: inside.filter((e) => e.durableStateChanged).length,
      rootsChanged: inside.filter((e) => e.rootDocumentsChanged).length,
      dangling: inside.filter((e) => e.danglingRootsAfter.length > 0).length },
    noLease: { n: outside.length, codes: codesOf(outside), deterministic: codesOf(outside).length === 1,
      durableChanged: outside.filter((e) => e.durableStateChanged).length,
      rootsChanged: outside.filter((e) => e.rootDocumentsChanged).length,
      dangling: outside.filter((e) => e.danglingRootsAfter.length > 0).length },
  }
  log(`\n  WITH a lease held (n=${inside.length}): codes=${JSON.stringify(codesOf(inside))}`
    + ` durable=${record.sweepByLeaseRegime.heldLease.durableChanged} dangling=${record.sweepByLeaseRegime.heldLease.dangling}`)
  log(`  with NO lease   (n=${outside.length}): codes=${JSON.stringify(codesOf(outside))}`
    + ` durable=${record.sweepByLeaseRegime.noLease.durableChanged} dangling=${record.sweepByLeaseRegime.noLease.dangling}`)
  if (!SWEEP_ENABLED) {
    record.sweepByLeaseRegime.VOID = 'the sweep was not run (B25A_SKIP_SWEEP, or draft-merge not among the families); this block compares nothing'
  } else if (inside.length === 0 || outside.length === 0) {
    const empty = inside.length === 0 ? 'held-lease' : 'no-lease'
    log(`  !! THE ${empty.toUpperCase()} REGIME IS EMPTY — this sweep compares nothing and cannot locate a step`)
    record.sweepByLeaseRegime.VOID = `the ${empty} regime has no samples; every request was taken in the other one, `
      + 'so this sweep says what happens in ONE regime and nothing about a boundary'
  }
  log('\n=== MATRIX (control | outage), one signature per repetition ===')
  for (const family of FAMILIES) {
    const v = record.voidCheck[family]
    log(`  ${family.padEnd(22)} ${JSON.stringify(v.controlSignatures)}  |  ${JSON.stringify(v.outageSignatures)}`
      + `  identical=${v.identicalColumns}`)
  }
  log(`\nconvergence held constant across both arms: ${record.convergenceHeldConstant}`)

  const pm = record.partialMutationSummary
  log('\n=== PARTIAL MUTATION (the question the task exists to settle) ===')
  log(`  requests measured: ${pm.measurements}`)
  log(`  requests that left orphans: ${pm.withOrphans} (of which FAILED and still wrote: ${pm.withPartialMutationOnFailure})`)
  log(`  orphaned documents: ${pm.orphanDocumentsTotal} (${pm.orphanBytesTotal} bytes)`)
  for (const e of pm.byLabel) {
    log(`    ${e.label.padEnd(28)} HTTP ${e.http} t=${e.startedAfterOutage} -> ${e.orphanDocumentCount} doc(s), ${e.orphanBytes} B`)
  }
  log(`  orphans still present at end of run: ${pm.orphansStillPresentAtEnd.length}`)

  // ── THE BOOTSTRAP FENCE VERDICT — a GATE, not a table ──
  //
  // The exit criterion, in the record's own vocabulary: on a cell the witness
  // reports as holding NOTHING (`ownedWorkspaceCount: 0`, `partitionIndex:
  // null`), a bootstrap door must NOT write durably — HTTP 503, no version
  // returned, zero orphans — and the refusal must be the FENCE's
  // (`ownership-unavailable` delta ≥ 1), not a pool timeout wearing a 503. And
  // the control arm must prove PRESENCE first: the same door on the same cell
  // with Redis alive answers 200 with six claimed documents AND moved
  // `bootstrapFencedMutationCount` by at least six — the fence consulted the
  // forker's authority on each save and admitted under the lease. A fence that
  // consulted nothing would pass the outage half by any other refusal and the
  // control half by any 200; requiring the counter is what separates "fenced"
  // from "unfenced and lucky".
  //
  // VOID, not FAIL, when the run cannot answer: convergence not held, the
  // outage witness never flipped, no bootstrap family measured, or the counter
  // absent from the cell (a build without it must read VOID-on-presence and
  // FAIL-on-outage, never PASS).
  //
  // `process.exitCode` rather than `process.exit()`: the record is written
  // below, after this, and an exit here would lose it.
  const bootstrapFamilies = FAMILIES.filter((f) => BOOTSTRAP_FAMILIES.has(f))
  if (bootstrapFamilies.length > 0) {
    const problems = []
    const voids = []
    if (record.VOID) voids.push(record.VOID)
    if (!record.convergenceHeldConstant) voids.push('convergence was not held constant across the arms')
    const outageSamples = bootstrapFamilies.flatMap((f) => record.outageArm[f].map((e) => ({ family: f, ...e })))
    const controlSamples = bootstrapFamilies.flatMap((f) => record.controlArm[f].map((e) => ({ family: f, ...e })))
    if (outageSamples.length === 0 || controlSamples.length === 0) voids.push('a bootstrap family has no samples in one arm')
    // TWO POPULATIONS, TWO EXPECTATIONS. A routed HTTP door on a lease-less
    // cell is refused by the ROUTER — owner unavailable — before any document
    // exists; that is the correct answer and it proves routing, not the fence.
    // An AI door's 503 must be the bootstrap mechanism's own: the scope's
    // authority before the first mint, or the storage fence on a save.
    // Requiring that sum to move is what separates "the fence refused" from
    // "something else answered 503" — a pool timeout, a read-model error —
    // which the status code alone cannot. The AI doors are routed in
    // production; the bench header (see KNOWN_FAMILIES) is what lets them
    // reach the mechanism here.
    for (const e of outageSamples) {
      const lease = (e.convergenceBefore.ownedWorkspaceCount ?? 0) > 0 || e.convergenceBefore.partitionIndex !== null
      if (lease) voids.push(`${e.label}: the cell still reported a lease at the request (owned=${e.convergenceBefore.ownedWorkspaceCount}, partition=${e.convergenceBefore.partitionIndex}) — not the regime the criterion names`)
      if (e.http !== 503) problems.push(`${e.label}: HTTP ${e.http} on a lease-less cell (expected 503)`)
      if (e.returnedVersionId !== null) problems.push(`${e.label}: a version was returned (${e.returnedVersionId}) with ${e.claimedDocumentsForReturnedVersion} claimed documents — the split-brain write`)
      if (e.orphanDocumentCount > 0) problems.push(`${e.label}: ${e.orphanDocumentCount} orphan document(s) written`)
      if (AI_BOOTSTRAP_FAMILIES.has(e.family)) {
        const byAuthority = e.bootstrapAuthorityRefusalDelta
        const byFence = e.bootstrapFenceRejectionDelta
        if (byAuthority === null && byFence === null) {
          voids.push(`${e.label}: neither bootstrap counter exists on this cell — the refusal cannot be attributed`)
        } else if ((byAuthority ?? 0) + (byFence ?? 0) < 1) {
          problems.push(`${e.label}: the bootstrap mechanism refused nothing (authority ${byAuthority ?? '-'}, fence ${byFence ?? '-'}) — whatever answered ${e.http} was not it`)
        }
      }
    }
    // The control arm proves PRESENCE: every fork claims at least the six
    // documents of an empty landscape's graph, and the fence must have
    // consulted a bootstrap entry on at least that many saves — one per
    // created document — or the 200 was admitted by a fence that never looked.
    // The seeded merge creates more (the diagram copies and the rotated overlay
    // segment on the parent, claimed under the PARENT and not under the
    // returned version), so its floor is `claimed + 2`.
    for (const e of controlSamples) {
      if (e.http !== 200) problems.push(`${e.label}: control HTTP ${e.http} (expected 200)`)
      const claimed = e.claimedDocumentsForReturnedVersion
      if (claimed === null || claimed < 6) problems.push(`${e.label}: control claimed ${claimed} documents (expected at least 6)`)
      if (e.orphanDocumentCount > 0) problems.push(`${e.label}: control wrote ${e.orphanDocumentCount} orphan document(s)`)
      const floor = e.family === 'ai-draft-merge-content' ? (claimed ?? 0) + 2 : (claimed ?? 6)
      if (e.bootstrapFencedDelta === null) voids.push(`${e.label}: bootstrapFencedMutationCount is absent on this cell — the fence's presence cannot be read`)
      else if (e.bootstrapFencedDelta < floor) problems.push(`${e.label}: the fence consulted a bootstrap entry on only ${e.bootstrapFencedDelta} save(s) where at least ${floor} were expected — an admitted write the fence did not check is not a fenced write`)
    }
    record.bootstrapFenceVerdict = {
      criterion: 'on a cell holding no lease every bootstrap door answers 503 and writes nothing, and for the AI doors the refusal is the bootstrap mechanism\'s own (authority before the mint, or the fence on a save); with Redis alive the same doors answer 200, claim at least six, and the fence consulted a bootstrap entry on every created document\'s save',
      families: bootstrapFamilies,
      routedFamilies: bootstrapFamilies.filter((f) => ROUTED_BOOTSTRAP_FAMILIES.has(f)),
      aiFamilies: bootstrapFamilies.filter((f) => AI_BOOTSTRAP_FAMILIES.has(f)),
      outageSamples: outageSamples.length,
      controlSamples: controlSamples.length,
      problems,
      voids,
      outcome: voids.length > 0 ? 'VOID' : problems.length > 0 ? 'FAIL' : 'PASS',
    }
    log('\n=== BOOTSTRAP FENCE VERDICT (task B2-5d) ===')
    log(`  outcome: ${record.bootstrapFenceVerdict.outcome}`)
    for (const v of voids) log(`  VOID: ${v}`)
    for (const p of problems) log(`  FAIL: ${p}`)
    if (record.bootstrapFenceVerdict.outcome !== 'PASS') process.exitCode = 1
  }

  // WRITTEN LAST, on purpose: every derived summary above lands in the file,
  // so the console never shows a conclusion the evidence file lacks.
  record.finishedAt = new Date().toISOString()
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`)
  log(`\nwrote ${OUT}`)
}

/**
 * `main().catch` alone does NOT cover Ctrl+C. Between `docker('stop', REDIS)`
 * and the restart there is a window of one to three minutes in which a signal
 * leaves the bench's Redis down and every later run measuring an outage it did
 * not provoke.
 */
let restoring = false
const restoreRedis = (why) => {
  if (restoring) return
  restoring = true
  try { docker('start', REDIS); console.error(`(${why}: Redis restarted)`) } catch { /* already up */ }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => { restoreRedis(signal); process.exit(130) })
}

main().catch((error) => {
  console.error('BENCH FAILED:', error)
  restoreRedis('failure')
  process.exit(1)
})
