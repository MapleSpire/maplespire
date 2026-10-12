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
 * Projector residency — WHAT DOES ONE RESIDENT PROJECTOR COST IN MEMORY?
 *
 * After a failover the new owner's projector becomes resident only when a READ
 * asks for it, so a workspace that is only being WRITTEN goes un-projected and
 * un-acknowledged until then (measured: 170 of 301 batches for ~50 s). The
 * alternative — "residency follows write" — makes every written workspace
 * resident on its owner. Its cost is the memory of a resident projector; this
 * instrument reads it.
 *
 * Method, on a bench left up by `sync-cell-bench.mjs --leg=load-soak --keep`:
 *   1. sample every cell's process memory (`/api/automerge/stats`,
 *      `transport.processMemoryBytes`) — the memory BASELINE;
 *   2. create N fresh landscapes (`POST /api/landscapes`), find each one's
 *      owner through the router (`/api/automerge/root`, route header `owner`);
 *   3. NEGATIVE CONTROL — with the landscapes created but never read, sample
 *      again: the resident count must not have moved (creation alone does not
 *      make a projector resident);
 *   4. make them resident ONE AT A TIME with a read through the router
 *      (`/api/model/objects/search`, which answers 503 retryable while the cold build
 *      warms and 200 once the projector is resident), sampling after each;
 *   5. delete the landscapes (the gate's own cleanup path) and sample once more.
 *
 * Output: per-step samples with `residentProjectors` and `rssBytes`/`heapUsedBytes`
 * per cell, plus a per-projector delta computed on the OWNING cell — the slope
 * from baseline to N residents, and the step increments. READ-MOSTLY: the only
 * writes are the N landscape creations and their deletions, on the bench.
 *
 *   node scripts/sync-cell-residency-memory.mjs --landscapes=8 --out=…/residency.json
 *
 * Caveats the record must carry: a fresh landscape is EMPTY (one root, one meta,
 * two write heads) — the cost measured is the FLOOR of a resident projector, not
 * the cost of a populated workspace; RSS includes every other activity on the
 * cell; the fleet cap (`READ_MODEL_MAX_PROJECTORS`, default 8) evicts the least
 * recently used projector beyond it, so `--landscapes` above the cap measures
 * churn, not accumulation.
 */

import { writeFileSync } from 'node:fs'
import pg from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { AuthenticatedWebSocketClientAdapter } from '../qa/authenticatedWebSocketAdapter.mjs'
import { appendOverlayBatchId, resolveLoadHandle } from '../qa/loadUsersCore.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.find((entry) => entry.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : fallback
}
const positiveInteger = (name, fallback, maximum) => {
  const raw = arg(name, null)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}, got ${JSON.stringify(raw)}`)
  }
  return value
}

const project = arg('--project', 'maplespire-bench-load-soak')
const routerPort = positiveInteger('--router-port', 3440, 65_535)
const cellPorts = arg('--cell-ports', '3441,3442,3443').split(',').map((raw, index) => {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`--cell-ports entry ${index} must be a TCP port, got ${JSON.stringify(raw)}`)
  }
  return value
})
const loginEmail = arg('--email', 'failover-admin@maplespire.local')
const landscapeCount = positiveInteger('--landscapes', 8, 64)
/** Objects seeded into each landscape's write head BEFORE it is made resident.
 *  0 measures the floor (an empty landscape); the decision needs the populated
 *  cost, because a resident projector keeps one `snap` Map of every object and
 *  connection of every shard it watches. */
const objectsPerLandscape = arg('--objects', null) === null ? 0 : positiveInteger('--objects', 0, 50_000)
const settleMs = positiveInteger('--settle-ms', 3_000, 60_000)
const databaseUrl = arg('--pg', 'postgres://maplespire:maplespire@127.0.0.1:55603/maplespire')
const outPath = arg('--out', null)

// The same refusal every bench instrument in this repository carries.
if (/demo/i.test(project) || /demo/i.test(databaseUrl)) {
  throw new Error(`refusing to probe ${project} / ${databaseUrl}: a name containing "demo" is not a bench`)
}

/** The read model's own word on residency — `read_model_projection_state`, one
 *  row per workspace, `projector_attached` + the instance that holds it. The
 *  fleet counter (`residentProjectors`) is per process; this is per workspace,
 *  and it is what the compaction gate reads before clearing an overlay. */
async function projectionState(db, workspace) {
  const { rows } = await db.query(
    `SELECT projector_attached, projector_instance_id, observed_generation, projected_generation, last_projection_kind
     FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
    [workspace.landscapeId, workspace.versionId],
  )
  return rows[0] ?? null
}

const cells = cellPorts.map((port, index) => ({
  service: `sync-cell-${String.fromCharCode(97 + index)}`,
  baseUrl: `http://127.0.0.1:${port}`,
}))
const routerBase = `http://127.0.0.1:${routerPort}`

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

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

const workspaceQuery = (workspace) => new URLSearchParams(workspace).toString()

/** One memory + residency sample per cell. Memory comes from
 *  `/api/automerge/stats` (`transport.processMemoryBytes`, the same field the
 *  load gate reads) WITHOUT `eventLoopWindow=consume`: this instrument must not
 *  eat the event-loop window a qualification run may be measuring.
 *
 *  The projector-fleet handler reads process-local counters and is not
 *  workspace-routed. Read the service found by probeOwner directly and retain
 *  its identity beside the fleet, so a response from an older, routing server
 *  cannot be paired with another RSS. */
async function sampleCells(cookie, label, owner = null) {
  const perCell = await Promise.all(cells.map(async (cell) => {
    const [state, stats] = await Promise.all([
      request(`${cell.baseUrl}/api/platform/sync-cell`, { cookie }),
      request(`${cell.baseUrl}/api/automerge/stats`, { cookie }),
    ])
    const memory = stats.body?.transport?.processMemoryBytes ?? null
    return {
      service: cell.service,
      partitionIndex: state.body?.partitionIndex ?? null,
      processBootId: stats.body?.processBootId ?? null,
      rssBytes: memory?.rss ?? null,
      heapUsedBytes: memory?.heapUsed ?? null,
      externalBytes: memory?.external ?? null,
      handles: stats.body?.handles ?? stats.body?.byState ?? null,
    }
  }))
  let ownerFleet = null
  if (owner) {
    const cell = cells.find((entry) => entry.service === owner.service)
    if (!cell) throw new Error(`cannot attribute projector fleet: owner service ${owner.service ?? 'missing'} is not a sampled cell`)
    const fleet = await request(`${cell.baseUrl}/api/platform/read-model/projector-fleet`, { cookie })
    if (fleet.status !== 200 || fleet.route !== null) {
      throw new Error(`${cell.service} projector fleet is not a local diagnostic: HTTP ${fleet.status}, route ${String(fleet.route)}`)
    }
    ownerFleet = {
      service: cell.service,
      route: fleet.route,
      residentProjectors: fleet.body?.residentProjectors ?? null,
      // Resident on a cell that does NOT own the workspace — the fleet's own
      // detector for a projector that should not be there.
      foreignResidentProjectors: fleet.body?.foreignResidentProjectors ?? null,
      inFlightWorkspaces: fleet.body?.inFlightWorkspaces ?? null,
      ownershipRejectedStarts: fleet.body?.ownershipRejectedStarts ?? null,
      writeFenceAborts: fleet.body?.writeFenceAborts ?? null,
      maxProjectors: fleet.body?.maxProjectors ?? null,
      // How often the SYNC path made a projector resident on this owner.
      liveResidency: fleet.body?.liveResidency ?? null,
    }
  }
  return { label, at: new Date().toISOString(), cells: perCell, ownerFleet }
}

/** The gate's `probeRoot` criteria (one `owner` route, the others `proxied`,
 *  one root), polled: a fresh landscape's placement is not answered by every
 *  cell on the first request after creation (measured: `owner: null` on the
 *  first probe, 6 s after creation). */
async function probeOwner(workspace, cookie, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = { ownerIndex: -1, rootUrl: null, routes: [] }
  while (Date.now() < deadline) {
    const results = await Promise.all(cells.map((cell) => request(`${cell.baseUrl}/api/automerge/root?${workspaceQuery(workspace)}`, { cookie }).catch(() => ({ status: 0, route: null, body: null }))))
    const owners = results.map((result, index) => ({ result, index })).filter(({ result }) => result.route === 'owner')
    const roots = new Set(results.map((result) => result.body?.url).filter(Boolean))
    last = { ownerIndex: owners[0]?.index ?? -1, rootUrl: [...roots][0] ?? null, routes: results.map((result) => `${result.status}:${result.route ?? '-'}`) }
    if (owners.length === 1 && results.every((result) => result.status === 200) && roots.size === 1) return last
    await delay(500)
  }
  return last
}

async function createLandscape(cookie, index) {
  const created = await request(`${cells[0].baseUrl}/api/landscapes`, {
    cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Residency probe ${index + 1}` }),
  })
  const landscape = created.body?.landscape
  if (!landscape?.id || !landscape?.defaultVersionId) {
    throw new Error(`landscape creation returned HTTP ${created.status} without an active workspace`)
  }
  return { landscapeId: landscape.id, versionId: landscape.defaultVersionId }
}

/** A read that goes through `ensureWorkspace`: `objects/search` answers 503
 *  `retryable` while the owner's cold build warms and 200 once the projector is
 *  resident. (`lookup` with an unusable `ids` list answers 200 without warming
 *  anything: `residentProjectors` never moves.) */
async function makeResident(workspace, cookie) {
  const startedAt = Date.now()
  const deadline = startedAt + 90_000
  let last = null
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    const params = new URLSearchParams({ ...workspace, q: 'residency', limit: '1' })
    last = await request(`${routerBase}/api/model/objects/search?${params}`, { cookie })
    if (last.status === 200) return { residentAfterMs: Date.now() - startedAt, attempts }
    await delay(250)
  }
  throw new Error(`objects/search never answered 200 for ${workspace.landscapeId}: last HTTP ${last?.status}`)
}

/** Seed `count` objects into the landscape's CURRENT object write head, the
 *  way the load gate does it (one change: the objects and a batch id), through
 *  the router's WebSocket as a client. Returns once the SERVER shows the first
 *  and last ids through `/api/model/lookup` — which also makes the projector
 *  resident, so the seed's residency sample is taken right after. */
async function seedObjects(workspace, rootUrl, cookie, count, index) {
  if (!count) return { seeded: 0 }
  const wsUrl = `ws://127.0.0.1:${routerPort}/automerge?${workspaceQuery(workspace)}`
  const repo = new Repo({ network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)] })
  try {
    const rootHandle = (await resolveLoadHandle(repo, rootUrl, { tries: 20 })).handle
    await rootHandle.whenReady()
    const root = rootHandle.doc()
    if (!root?.modelMetaUrl) throw new Error(`root of ${workspace.landscapeId} has no modelMetaUrl`)
    const metaHandle = (await resolveLoadHandle(repo, root.modelMetaUrl, { tries: 20 })).handle
    await metaHandle.whenReady()
    const meta = metaHandle.doc()
    const headUrl = meta?.editsObjectShardUrl || meta?.editsObjectShardUrls?.at(-1)
    if (!headUrl) throw new Error(`meta of ${workspace.landscapeId} has no object write head`)
    const headHandle = (await resolveLoadHandle(repo, headUrl, { tries: 20 })).handle
    await headHandle.whenReady()
    const ids = Array.from({ length: count }, (_, i) => `qa-residency-${index}-${i}`)
    headHandle.change((doc) => {
      if (!doc.objects) doc.objects = {}
      for (const id of ids) {
        doc.objects[id] = { id, type: 'app', name: `Residency ${index} ${id.slice(-6)}`, description: 'residency probe object, sixty-four bytes of padding follow ....' }
      }
      appendOverlayBatchId(doc, `qa-residency-${index}-seed`)
    })
    // The server holds the head; wait until it SHOWS the seed before the
    // client-side repo goes away (an unacknowledged change dies with it).
    const startedAt = Date.now()
    const deadline = startedAt + 120_000
    const probeIds = [ids[0], ids[ids.length - 1]]
    let last = null
    while (Date.now() < deadline) {
      last = await request(`${routerBase}/api/model/lookup?${workspaceQuery(workspace)}&ids=${encodeURIComponent(probeIds.join(','))}`, { cookie, timeoutMs: 10_000 })
      const entities = Array.isArray(last.body?.entities) ? last.body.entities : []
      if (last.status === 200 && entities.length === probeIds.length) {
        return { seeded: count, visibleAfterMs: Date.now() - startedAt, headUrl }
      }
      await delay(250)
    }
    throw new Error(`seed of ${workspace.landscapeId} never became visible: last HTTP ${last?.status}`)
  } finally {
    await repo.shutdown().catch(() => undefined)
  }
}

async function deleteLandscape(landscapeId, cookie) {
  for (const target of [{ baseUrl: routerBase }, ...cells]) {
    const result = await request(`${target.baseUrl}/api/landscapes/${encodeURIComponent(landscapeId)}`, { cookie, method: 'DELETE' }).catch(() => null)
    if (result?.status === 200 || result?.status === 404) return true
  }
  return false
}

/** Per-owner-cell slope: bytes per landscape made resident on that cell, from
 *  the baseline sample to the last "resident" sample, and the step increments.
 *  Memory is per cell (unrouted `/api/automerge/stats`); the resident count is
 *  the OWNER's fleet, read directly from the same service without routing. */
function summarize(samples, owners) {
  const baseline = samples.find((sample) => sample.label === 'baseline')
  const resident = samples.filter((sample) => sample.label.startsWith('resident:'))
  const byService = new Map()
  for (const service of new Set(owners.map((owner) => owner.service))) {
    const base = baseline.cells.find((cell) => cell.service === service)
    const own = resident.filter((sample) => sample.madeResident?.owner === service)
    const steps = own.map((sample) => ({
      ...sample.cells.find((cell) => cell.service === service),
      residentProjectors: sample.ownerFleet?.residentProjectors ?? null,
    }))
    const increments = steps.map((step, index) => {
      const previous = index === 0 ? base : steps[index - 1]
      return {
        residentProjectors: step.residentProjectors,
        rssDeltaBytes: step.rssBytes - previous.rssBytes,
        heapUsedDeltaBytes: step.heapUsedBytes - previous.heapUsedBytes,
        externalDeltaBytes: (step.externalBytes ?? 0) - (previous.externalBytes ?? 0),
      }
    })
    const last = steps.at(-1)
    const added = own.length
    byService.set(service, {
      baseline: { rssBytes: base.rssBytes, heapUsedBytes: base.heapUsedBytes, externalBytes: base.externalBytes },
      final: last ? { residentProjectors: last.residentProjectors, rssBytes: last.rssBytes, heapUsedBytes: last.heapUsedBytes, externalBytes: last.externalBytes } : null,
      landscapesMadeResident: added,
      rssBytesPerLandscape: added > 0 ? Math.round((last.rssBytes - base.rssBytes) / added) : null,
      heapUsedBytesPerLandscape: added > 0 ? Math.round((last.heapUsedBytes - base.heapUsedBytes) / added) : null,
      increments,
    })
  }
  return Object.fromEntries(byService)
}

async function main() {
  const startedAt = new Date().toISOString()
  const cookie = await login()
  const db = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  const samples = []
  const created = []
  const owners = []
  try {
    samples.push(await sampleCells(cookie, 'baseline'))
    for (let index = 0; index < landscapeCount; index += 1) {
      const workspace = await createLandscape(cookie, index)
      created.push(workspace)
      const owner = await probeOwner(workspace, cookie)
      owners.push({ workspace, service: owner.ownerIndex >= 0 ? cells[owner.ownerIndex].service : null, rootUrl: owner.rootUrl, routes: owner.routes })
    }
    await delay(settleMs)
    // NEGATIVE CONTROL: created, never read — the first landscape's owner has
    // not gained a projector (compare with `resident:1`, same owner, +1).
    samples.push(await sampleCells(cookie, 'created-not-read', owners[0] ?? null))
    for (const [index, owner] of owners.entries()) {
      // With `--objects`, the seed's own visibility wait is the read that makes
      // the projector resident; `makeResident` then answers on the first try.
      const seed = await seedObjects(owner.workspace, owner.rootUrl, cookie, objectsPerLandscape, index + 1)
      const residency = await makeResident(owner.workspace, cookie)
      await delay(settleMs)
      const sample = await sampleCells(cookie, `resident:${index + 1}`, owner)
      sample.madeResident = { ...owner.workspace, owner: owner.service, ...residency, seed, projectionState: await projectionState(db, owner.workspace) }
      samples.push(sample)
    }
  } finally {
    const deleted = []
    for (const workspace of created) deleted.push({ ...workspace, deleted: await deleteLandscape(workspace.landscapeId, cookie) })
    await delay(settleMs)
    samples.push({ ...(await sampleCells(cookie, 'after-delete')), deleted })
    await db.end()
  }
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    project,
    routerPort,
    landscapeCount,
    objectsPerLandscape,
    settleMs,
    owners: owners.map((owner) => ({ ...owner.workspace, owner: owner.service })),
    control: {
      what: 'created-not-read vs resident:1, same owner: creation alone leaves the owner\'s resident count where it is; the first read adds exactly one',
      ownerFleetAfterCreation: samples[1]?.ownerFleet ?? null,
      ownerFleetAfterFirstResidency: samples.find((sample) => sample.label === 'resident:1')?.ownerFleet ?? null,
    },
    perOwnerCell: summarize(samples, owners.filter((owner) => owner.service)),
    samples,
  }
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, samples: undefined }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
