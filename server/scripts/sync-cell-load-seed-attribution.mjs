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
 * Seed attribution — READS THE TWO HALVES OF "the seed batch was never projected"
 * SEPARATELY, on a load-soak bench left up after `verify:sync-load-soak`
 * failed on `load object seed projection timed out`.
 *
 * The gate seeds `SYNC_LOAD_OBJECTS` objects into each hot workspace's overlay
 * write head, appends a batch id to the head's `writeBatchIds`, waits for the
 * objects to converge, then polls `POST /api/model/overlay-batches/status` for
 * the batch. "Never projected" conflates two facts that this instrument keeps
 * apart, because they are read from two different places:
 *
 *   half 1 — DID THE BATCH REACH THE DOCUMENT? Read from the Automerge write
 *            head itself, through the public router, exactly as the gate wrote
 *            it: `writeBatchIds` and the `qa-*` object ids.
 *   half 2 — DID THE OWNER'S PROJECTOR SEE IT? Read from the read model:
 *            `ro_objects` (the ordinary projector's output — the objects the
 *            batch carried), `read_model_overlay_batch_acks` (the ONLY table
 *            the status endpoint reads; written by every projector), and the three
 *            tables that decide whether the static delta projector is even
 *            looking at this workspace.
 *
 * The output names the missing half per seeded workspace. It is READ-ONLY:
 * every SQL statement is a SELECT, every HTTP call a GET or the status POST.
 *
 *   node scripts/sync-cell-load-seed-attribution.mjs --out seed-attribution.json
 *
 * Defaults are the bench's `load-soak` leg (`sync-cell-bench.mjs`): router
 * 3440, cells 3441-3443, Postgres 55603. The compose project is used for
 * nothing but the refusal below.
 */

import { writeFileSync } from 'node:fs'
import pg from 'pg'
import * as A from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { AuthenticatedWebSocketClientAdapter } from '../qa/authenticatedWebSocketAdapter.mjs'
import { objectMap, resolveLoadHandle } from '../qa/loadUsersCore.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.find((entry) => entry.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : fallback
}
const portArg = (name, fallback) => {
  const raw = arg(name, null)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port, got ${JSON.stringify(raw)}`)
  }
  return value
}

const project = arg('--project', 'maplespire-bench-load-soak')
const routerPort = portArg('--router-port', 3440)
const cellPorts = arg('--cell-ports', '3441,3442,3443').split(',').map((raw, index) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`--cell-ports entry ${index} must be a TCP port, got ${JSON.stringify(raw)}`)
  }
  return value
})
const databaseUrl = arg('--pg', 'postgres://maplespire:maplespire@127.0.0.1:55603/maplespire')
const loginEmail = arg('--email', 'failover-admin@maplespire.local')
const outPath = arg('--out', null)
const qaPattern = /^qa-/

// The same refusal every bench instrument in this repository carries: a live
// stack whose project name says `demo` is never a bench.
if (/demo/i.test(project) || /demo/i.test(databaseUrl)) {
  throw new Error(`refusing to probe ${project} / ${databaseUrl}: a name containing "demo" is not a bench`)
}

const cells = cellPorts.map((port, index) => ({
  service: `sync-cell-${String.fromCharCode(97 + index)}`,
  baseUrl: `http://127.0.0.1:${port}`,
}))

async function request(url, { cookie, timeoutMs = 5_000, ...options } = {}) {
  const headers = { ...(options.headers || {}) }
  if (cookie) headers.Cookie = cookie
  const response = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: response.status, route: response.headers.get('x-maplespire-sync-route'), body }
}

async function login() {
  const response = await fetch(`${cells[0].baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: loginEmail }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}`)
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return the session cookie')
  return cookie
}

function workspaceQuery(workspace) {
  return new URLSearchParams(workspace).toString()
}

/** Owner + root, the way the gate's `probeRoot` reads them: one `owner`, the
 *  rest `proxied`, one root url. */
async function probeRoot(workspace, cookie) {
  const query = workspaceQuery(workspace)
  const results = await Promise.all(cells.map((cell) => request(`${cell.baseUrl}/api/automerge/root?${query}`, { cookie })))
  const routes = results.map((result) => ({ status: result.status, route: result.route }))
  const ownerIndex = results.findIndex((result) => result.route === 'owner')
  const roots = [...new Set(results.map((result) => result.body?.url).filter(Boolean))]
  return { ownerIndex, routes, rootUrl: roots[0] ?? null, distinctRoots: roots.length }
}

/** Half 1 — the document, through the router, as the gate wrote it. */
async function readWriteHead(workspace, rootUrl, cookie) {
  const wsUrl = `ws://127.0.0.1:${routerPort}/automerge?${workspaceQuery(workspace)}`
  const repo = new Repo({ network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)] })
  try {
    const rootHandle = (await resolveLoadHandle(repo, rootUrl, { tries: 20 })).handle
    await rootHandle.whenReady()
    const root = rootHandle.doc()
    const out = {
      rootHasModelMetaUrl: Boolean(root?.modelMetaUrl),
      modelUrl: root?.modelUrl ?? null,
      writeHeadUrl: null,
      writeHeadDocumentId: null,
      editsObjectShardUrls: null,
      writeHeadVersion: null,
      writeBatchIds: [],
      qaBatchIds: [],
      forwardedBatchIds: [],
      objectCount: null,
      qaObjectIds: [],
    }
    if (!root?.modelMetaUrl) return out
    const metaHandle = (await resolveLoadHandle(repo, root.modelMetaUrl, { tries: 20 })).handle
    await metaHandle.whenReady()
    const meta = metaHandle.doc()
    out.editsObjectShardUrls = meta?.editsObjectShardUrls ?? null
    const writeHeadUrl = meta?.editsObjectShardUrl || meta?.editsObjectShardUrls?.at(-1) || null
    out.writeHeadUrl = writeHeadUrl
    if (!writeHeadUrl) return out
    out.writeHeadDocumentId = writeHeadUrl.replace(/^automerge:/, '').split('?')[0]
    const headHandle = (await resolveLoadHandle(repo, writeHeadUrl, { tries: 20 })).handle
    await headHandle.whenReady()
    const head = headHandle.doc()
    const objects = objectMap(head) ?? {}
    out.writeHeadVersion = head?.writeHeadVersion ?? null
    out.writeBatchIds = Array.isArray(head?.writeBatchIds) ? [...head.writeBatchIds] : []
    out.qaBatchIds = out.writeBatchIds.filter((id) => qaPattern.test(String(id)))
    out.forwardedBatchIds = Array.isArray(head?.forwardedBatchIds) ? [...head.forwardedBatchIds] : []
    out.objectCount = Object.keys(objects).length
    out.qaObjectIds = Object.keys(objects).filter((id) => qaPattern.test(id))
    // Per seeded object: which user fields the WINNING value carries, and how
    // many concurrent values compete for the key. Two writers seeding the same
    // object id concurrently leave one value visible and the other — with every
    // field written into it — hidden in a conflict branch, which reads as
    // "my own write is missing from my own document".
    //
    // And, from the document's own history: how many times the key was PUT (a
    // `makeMap` op keyed by the object id), by how many actors. A key put twice
    // in SEQUENCE leaves no conflict at all — the second value simply replaces
    // the first — and every field written into the first value by a peer that
    // had not yet seen the second put is discarded without a trace.
    const puts = new Map()
    try {
      for (const change of A.getAllChanges(head)) {
        const decoded = A.decodeChange(change)
        for (const op of decoded.ops ?? []) {
          if (op.action !== 'makeMap' || typeof op.key !== 'string' || !qaPattern.test(op.key)) continue
          const entry = puts.get(op.key) ?? { count: 0, actors: new Set(), times: [] }
          entry.count += 1
          entry.actors.add(String(decoded.actor).slice(0, 8))
          entry.times.push(decoded.time)
          puts.set(op.key, entry)
        }
      }
    } catch (error) {
      out.historyError = error instanceof Error ? error.message : String(error)
    }
    out.qaObjects = out.qaObjectIds.map((id) => {
      let conflictValues = null
      try { conflictValues = Object.keys(A.getConflicts(head.objects, id) ?? {}).length } catch { conflictValues = null }
      const value = objects[id] ?? {}
      const put = puts.get(id)
      return {
        id,
        conflictValues,
        puts: put ? { count: put.count, actors: [...put.actors], times: put.times } : null,
        userFields: Object.keys(value).filter((field) => /^u\d+$/.test(field)).length,
        hot: value.hot ?? null,
      }
    })
    out.selfSeedBatchIds = out.writeBatchIds.filter((id) => /^qa-load-.*-seed$/.test(String(id)))
    return out
  } finally {
    await repo.shutdown().catch(() => undefined)
  }
}

/** Half 2 — the read model, from the bench database. Every statement is a SELECT. */
async function readProjection(db, workspace, writeHeadDocumentId) {
  const params = [workspace.landscapeId, workspace.versionId]
  const one = async (sql, extra = []) => (await db.query(sql, [...params, ...extra])).rows
  const [staticWorkspace, staticDocuments, queue, acks, qaObjects, allObjects, projectionState] = await Promise.all([
    one('SELECT source, created_at FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2'),
    one('SELECT document_id, kind FROM read_model_static_documents WHERE landscape_id = $1 AND version_id = $2'),
    one('SELECT document_id, revision, projected_revision, enqueued_at FROM read_model_static_document_queue WHERE landscape_id = $1 AND version_id = $2'),
    one('SELECT batch_id, status, document_id, updated_at FROM read_model_overlay_batch_acks WHERE landscape_id = $1 AND version_id = $2'),
    one(`SELECT id, name FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id LIKE 'qa-%' ORDER BY id`),
    one('SELECT count(*)::int AS count FROM ro_objects WHERE landscape_id = $1 AND version_id = $2'),
    one(`SELECT observed_generation, projected_generation, projector_attached, projector_instance_id,
                last_projected_at, last_error_code, consecutive_failures, last_projection_kind
         FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`),
  ])
  return {
    workspaceIsStatic: staticWorkspace.length > 0,
    staticWorkspace: staticWorkspace[0] ?? null,
    staticDocumentCount: staticDocuments.length,
    writeHeadInStaticAllowList: writeHeadDocumentId
      ? staticDocuments.some((row) => row.document_id === writeHeadDocumentId)
      : false,
    staticQueueRows: queue,
    writeHeadInStaticQueue: writeHeadDocumentId
      ? queue.some((row) => row.document_id === writeHeadDocumentId)
      : false,
    ackRows: acks,
    qaObjectsInReadModel: qaObjects.map((row) => row.id),
    objectsInReadModel: allObjects[0]?.count ?? 0,
    projectionState: projectionState[0] ?? null,
  }
}

async function statusOf(workspace, cookie, batchIds) {
  if (!batchIds.length) return { status: null, body: null }
  const result = await request(
    `http://127.0.0.1:${routerPort}/api/model/overlay-batches/status?${workspaceQuery(workspace)}`,
    { cookie, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batchIds }) },
  )
  return { status: result.status, body: result.body }
}

async function searchQa(workspace, cookie) {
  const params = new URLSearchParams({ ...workspace, q: 'QA load', limit: '50' })
  const result = await request(`http://127.0.0.1:${routerPort}/api/model/objects/search?${params}`, { cookie })
  return {
    status: result.status,
    qaIds: Array.isArray(result.body?.items) ? result.body.items.map((item) => item?.id).filter((id) => qaPattern.test(String(id))) : null,
  }
}

/**
 * Which half is missing, in words the record can quote. Only a workspace the
 * gate actually seeded (a `qa-*` batch id in its head) gets a verdict; the rest
 * are listed as untouched so the reader can see the gate did not seed them.
 */
function verdictFor(head, projection) {
  if (!head.qaBatchIds.length && !head.qaObjectIds.length) return { seededByGate: false }
  const objectsArrived = head.qaObjectIds.length > 0
    && head.qaObjectIds.every((id) => projection.qaObjectsInReadModel.includes(id))
  const ackForQa = projection.ackRows.filter((row) => head.qaBatchIds.includes(row.batch_id))
  const missing = []
  if (!head.qaBatchIds.length) missing.push('half 1: the batch id is NOT in the write head')
  if (!objectsArrived) missing.push('half 2a: the seeded objects are NOT in ro_objects — the owner projector did not project the head')
  if (!ackForQa.length) missing.push('half 2b: no read_model_overlay_batch_acks row for the batch — the status endpoint has nothing to answer')
  return {
    seededByGate: true,
    batchReachedDocument: head.qaBatchIds.length > 0,
    ownerProjectorProjectedTheObjects: objectsArrived,
    ackRowForBatch: ackForQa.length > 0,
    workspaceIsStatic: projection.workspaceIsStatic,
    writeHeadInStaticAllowList: projection.writeHeadInStaticAllowList,
    writeHeadInStaticQueue: projection.writeHeadInStaticQueue,
    missing,
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const cookie = await login()
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const states = await Promise.all(cells.map(async (cell) => {
      const result = await request(`${cell.baseUrl}/api/platform/sync-cell`, { cookie })
      return { service: cell.service, status: result.status, partitionIndex: result.body?.partitionIndex ?? null, ready: result.body?.ready ?? null, partitionCount: result.body?.partitionCount ?? null }
    }))
    const landscapes = (await request(`${cells[0].baseUrl}/api/landscapes`, { cookie })).body?.landscapes ?? []
    const globals = {
      ackRowsInDatabase: (await db.query('SELECT count(*)::int AS count FROM read_model_overlay_batch_acks')).rows[0].count,
      staticWorkspacesInDatabase: (await db.query('SELECT count(*)::int AS count FROM read_model_static_workspaces')).rows[0].count,
      staticQueueRowsInDatabase: (await db.query('SELECT count(*)::int AS count FROM read_model_static_document_queue')).rows[0].count,
      landscapes: landscapes.length,
    }
    const workspaces = []
    for (const landscape of landscapes) {
      if (!landscape?.id || !landscape?.defaultVersionId) continue
      const workspace = { landscapeId: landscape.id, versionId: landscape.defaultVersionId }
      const root = await probeRoot(workspace, cookie)
      const entry = { name: landscape.name, workspace, owner: root.ownerIndex >= 0 ? { service: cells[root.ownerIndex].service, partitionIndex: states[root.ownerIndex]?.partitionIndex ?? null } : null, routes: root.routes, rootUrl: root.rootUrl, distinctRoots: root.distinctRoots }
      if (!root.rootUrl) { workspaces.push({ ...entry, error: 'no root url from any cell' }); continue }
      const head = await readWriteHead(workspace, root.rootUrl, cookie)
      const projection = await readProjection(db, workspace, head.writeHeadDocumentId)
      let fleet = null
      if (entry.owner) {
        const response = await request(`${cells[root.ownerIndex].baseUrl}/api/platform/read-model/projector-fleet`, { cookie })
        if (response.status !== 200 || response.route !== null) {
          throw new Error(`${entry.owner.service} projector fleet is not a local diagnostic: HTTP ${response.status}, route ${String(response.route)}`)
        }
        fleet = response.body
      }
      const status = await statusOf(workspace, cookie, head.qaBatchIds)
      const search = head.qaObjectIds.length ? await searchQa(workspace, cookie) : null
      workspaces.push({ ...entry, head, projection, ownerProjectorFleet: fleet, statusEndpoint: status, objectsSearch: search, verdict: verdictFor(head, projection) })
    }
    const seeded = workspaces.filter((entry) => entry.verdict?.seededByGate)
    const summary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      project,
      routerPort,
      cells: states,
      globals,
      seededWorkspaces: seeded.length,
      verdicts: seeded.map((entry) => ({ name: entry.name, owner: entry.owner, ...entry.verdict })),
    }
    const report = { summary, workspaces }
    if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
