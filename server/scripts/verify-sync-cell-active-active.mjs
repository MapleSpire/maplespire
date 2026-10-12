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

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const composeFile = resolve(here, '../../infra/compose/sync-cell-failover.yml')
const project = process.env.SYNC_FAILOVER_PROJECT || 'maplespire-sync-active-active'
const cellAPort = process.env.SYNC_FAILOVER_CELL_A_PORT || '3311'
const cellBPort = process.env.SYNC_FAILOVER_CELL_B_PORT || '3312'
const loginEmail = process.env.SYNC_FAILOVER_LOGIN_EMAIL || 'failover-admin@maplespire.local'
const cells = [
  { service: 'sync-cell-a', baseUrl: `http://127.0.0.1:${cellAPort}` },
  { service: 'sync-cell-b', baseUrl: `http://127.0.0.1:${cellBPort}` },
]

function compose(...args) {
  return execFileSync(
    'docker',
    ['compose', '-p', project, '-f', composeFile, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitFor(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function request(url, { cookie, timeoutMs, ...options } = {}) {
  const headers = { ...(options.headers || {}) }
  if (cookie) headers.Cookie = cookie
  const response = await fetch(url, {
    ...options,
    headers,
    // 5 s by default, and OVERRIDABLE. The write families this gate
    // exercises are proxied with a 45 s header deadline
    // (`ROUTED_WRITE_HEADER_DEADLINE_MS`), so a client bound of 5 s would make
    // the gate's own timeout the thing under test — and an abort here drives
    // the proxy's `aborted` path rather than its answer.
    signal: AbortSignal.timeout(timeoutMs ?? 5_000),
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return {
    status: response.status,
    route: response.headers.get('x-maplespire-sync-route'),
    body,
  }
}

async function json(url, options = {}) {
  const result = await request(url, options)
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${url} returned HTTP ${result.status}: ${JSON.stringify(result.body)}`)
  }
  return result.body
}

async function login() {
  const response = await fetch(`${cells[0].baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: loginEmail }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json()
  const setCookie = response.headers.get('set-cookie') || ''
  const cookie = setCookie.match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return the HttpOnly session cookie')
  if (!body.user?.isPlatformAdmin || !body.orgId) throw new Error('active/active login lacks bootstrap admin/org')
  return { cookie, userId: body.user.id, orgId: body.orgId }
}

function workspaceOf(landscape) {
  if (!landscape?.id || !landscape.defaultVersionId) return null
  return { landscapeId: landscape.id, versionId: landscape.defaultVersionId }
}

function workspaceQuery(workspace) {
  return new URLSearchParams(workspace).toString()
}

async function probeRoot(workspace, cookie) {
  const query = workspaceQuery(workspace)
  const results = await Promise.all(cells.map((cell) => request(
    `${cell.baseUrl}/api/automerge/root?${query}`,
    { cookie },
  )))
  if (!results.every((result) => result.status === 200)) return null
  const ownerIndex = results.findIndex((result) => result.route === 'owner')
  const proxiedIndex = results.findIndex((result) => result.route === 'proxied')
  if (ownerIndex < 0 || proxiedIndex < 0 || ownerIndex === proxiedIndex) return null
  const roots = results.map((result) => result.body?.url)
  if (!roots[0] || roots[0] !== roots[1]) {
    throw new Error(`root response diverged across cells: ${JSON.stringify(results)}`)
  }
  return { ownerIndex, proxiedIndex, rootUrl: roots[0], results }
}

async function waitForReadModel(workspace, cookie, expectedOwnerIndex) {
  const query = workspaceQuery(workspace)
  return waitFor(`owner-affine read model for ${workspace.landscapeId}`, async () => {
    const results = await Promise.all(cells.map((cell) => request(
      `${cell.baseUrl}/api/model/cache/estimate?${query}`,
      { cookie },
    )))
    if (!results.every((result) => result.status === 200)) return null
    if (results[expectedOwnerIndex].route !== 'owner') return null
    if (results[1 - expectedOwnerIndex].route !== 'proxied') return null
    return results
  }, 90_000)
}

function openWorkspaceSocket(cell, workspace, cookie) {
  const socketUrl = new URL('/automerge', cell.baseUrl.replace(/^http/, 'ws'))
  socketUrl.search = workspaceQuery(workspace)
  const socket = new WebSocket(socketUrl, { headers: { Cookie: cookie } })
  return new Promise((resolveSocket, reject) => {
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error(`${cell.service} workspace WebSocket timed out`))
    }, 10_000)
    socket.once('open', () => {
      socket.close(1000, 'active-active gate complete')
    })
    socket.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 1000) {
        reject(new Error(`${cell.service} workspace WebSocket closed with ${code}`))
        return
      }
      resolveSocket()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

const session = await login()
const states = await waitFor('two distinct ready partition owners', async () => {
  const snapshots = await Promise.all(cells.map((cell) => json(
    `${cell.baseUrl}/api/platform/sync-cell`,
    { cookie: session.cookie },
  )))
  const partitions = snapshots.map((snapshot) => snapshot.partitionIndex)
  return snapshots.every((snapshot) => snapshot.ready && snapshot.partitionCount === 2)
    && new Set(partitions).size === 2
    && partitions.every((partition) => partition === 0 || partition === 1)
    ? snapshots
    : null
})

const landscapes = await json(`${cells[0].baseUrl}/api/landscapes`, { cookie: session.cookie })
const candidates = (landscapes.landscapes || []).map(workspaceOf).filter(Boolean)
const selectedByPartition = new Map()

for (let attempt = 0; attempt < 20 && selectedByPartition.size < 2; attempt += 1) {
  if (attempt >= candidates.length) {
    const created = await json(`${cells[0].baseUrl}/api/landscapes`, {
      cookie: session.cookie,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Active-active gate ${attempt + 1}` }),
    })
    const workspace = workspaceOf(created.landscape)
    if (!workspace) throw new Error(`create landscape returned no workspace: ${JSON.stringify(created)}`)
    candidates.push(workspace)
  }
  const workspace = candidates[attempt]
  const root = await waitFor(`workspace route for ${workspace.landscapeId}`, () => probeRoot(workspace, session.cookie))
  const partition = states[root.ownerIndex].partitionIndex
  selectedByPartition.set(partition, { workspace, root, ownerIndex: root.ownerIndex })
}

if (selectedByPartition.size !== 2) {
  throw new Error(`could not obtain a workspace in both partitions after ${candidates.length} candidates`)
}

const readModels = []
for (const partition of [0, 1]) {
  const selection = selectedByPartition.get(partition)
  const results = await waitForReadModel(selection.workspace, session.cookie, selection.ownerIndex)
  await Promise.all(cells.map((cell) => openWorkspaceSocket(cell, selection.workspace, session.cookie)))
  readModels.push({
    partition,
    owner: cells[selection.ownerIndex].service,
    proxiedBy: cells[1 - selection.ownerIndex].service,
    workspace: selection.workspace,
    rootUrl: selection.root.rootUrl,
    estimatesEqual: JSON.stringify(results[0].body) === JSON.stringify(results[1].body),
    websocketThroughBothCells: true,
  })
}

const projectorFleets = await Promise.all(cells.map(async (cell) => {
  const fleet = await request(`${cell.baseUrl}/api/platform/read-model/projector-fleet`, { cookie: session.cookie })
  // These counters describe this process. A routing server would otherwise
  // let another cell's fleet stand in for the one this gate is checking.
  if (fleet.status !== 200 || fleet.route !== null) {
    throw new Error(`${cell.service} projector fleet is not a local diagnostic: HTTP ${fleet.status}, route ${String(fleet.route)}`)
  }
  return fleet.body
}))
for (let index = 0; index < projectorFleets.length; index += 1) {
  const fleet = projectorFleets[index]
  if (fleet.foreignResidentProjectors !== 0) {
    throw new Error(`${cells[index].service} retained ${fleet.foreignResidentProjectors} foreign projector(s)`)
  }
  if (fleet.residentProjectors < 1) {
    throw new Error(`${cells[index].service} did not retain its locally-owned workspace projector`)
  }
}

// Global mark-and-sweep cannot derive a complete reachable set from one of
// several partition-local Repos. Until a separately fenced global worker
// exists, both ingress cells must owner-route then reject it deterministically.
const gcResults = await Promise.all(cells.map((cell) => request(
  `${cell.baseUrl}/api/automerge/gc`,
  { cookie: session.cookie, method: 'POST' },
)))
if (!gcResults.every((result) => (
  result.status === 409
  && result.body?.reason === 'global_repo_requires_single_partition'
  && result.body?.retryable === false
))) {
  throw new Error(`multi-partition global GC did not fail closed: ${JSON.stringify(gcResults)}`)
}
if (new Set(gcResults.map((result) => result.route)).size !== 2
  || !gcResults.some((result) => result.route === 'owner')
  || !gcResults.some((result) => result.route === 'proxied')) {
  throw new Error(`global GC was not routed to exactly one owner: ${JSON.stringify(gcResults)}`)
}

const gcSuffix = Date.now().toString(36)
const oldOrphan = `gc_gate_old_${gcSuffix}`
const youngOrphan = `gc_gate_young_${gcSuffix}`
compose(
  'exec', '-T', 'postgres',
  'psql', '-U', 'maplespire', '-d', 'maplespire', '-v', 'ON_ERROR_STOP=1', '-c',
  `INSERT INTO automerge_storage (key, data, created_at, updated_at) VALUES
   ('${oldOrphan}/snapshot/gate', decode('00', 'hex'), NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
   ('${youngOrphan}/snapshot/gate', decode('00', 'hex'), NOW(), NOW())`,
)
const workerOutput = compose('--profile', 'maintenance', 'run', '--rm', 'global-gc-worker')
const workerEventLine = workerOutput.split(/\r?\n/).find((line) => (
  line.includes('"event":"maintenance.global_gc_worker"')
))
if (!workerEventLine) throw new Error(`global GC worker emitted no result: ${workerOutput}`)
const workerEvent = JSON.parse(workerEventLine.slice(workerEventLine.indexOf('{')))
if (workerEvent.outcome !== 'completed' || workerEvent.result?.aborted !== false) {
  throw new Error(`global GC worker did not complete: ${JSON.stringify(workerEvent)}`)
}
const orphanCounts = compose(
  'exec', '-T', 'postgres',
  'psql', '-U', 'maplespire', '-d', 'maplespire', '-Atc',
  `SELECT COUNT(*) FILTER (WHERE split_part(key, '/', 1) = '${oldOrphan}') || '|' ||
          COUNT(*) FILTER (WHERE split_part(key, '/', 1) = '${youngOrphan}')
   FROM automerge_storage`,
).trim()
if (orphanCounts !== '0|1') {
  throw new Error(`global GC grace/fence gate expected old=0 young=1, got ${orphanCounts}`)
}

// ── A BODY-BEARING WRITE, ROUTED, WITH THE BODY PROVEN TO ARRIVE ──
//
// Every other leg above is a GET or a BODYLESS post. If the admission gate and
// the proxy's body decision normalise the pathname differently, an admitted
// body-bearing POST is forwarded with its `content-type` and `content-length`
// DELETED. A STATUS assertion stays green through that — the owner answers
// 400, a perfectly good HTTP response — so this leg asserts what the OWNER
// PARSED.
//
// THE SPELLING IS DELIBERATELY NON-CANONICAL: the canonical path cannot reveal
// a normalisation disagreement.
// `/API/platform/reference-integrity/repair/` — upper case and a trailing slash
// — is served by Express (measured: it defaults `case sensitive routing` and
// `strict routing` to false and `index.ts` sets neither) and is exactly the
// disagreement.
//
// WHY THIS ROUTE. On an EMPTY workspace `repairReferenceIntegrity` returns
// before it asks for the lifecycle apply lock — `if (!options.apply ||
// actionable.length === 0)` — so an apply writes nothing, takes no key, and is
// repeatable. The leg creates its OWN landscape rather than reusing the ones
// selected above, because nothing establishes that those are empty; on a
// non-empty workspace this same call writes Automerge documents directly.
const b25Landscape = await json(`${cells[0].baseUrl}/api/landscapes`, {
  cookie: session.cookie,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `B2-5 routed write ${Date.now().toString(36)}` }),
})
const b25Workspace = workspaceOf(b25Landscape.landscape)
if (!b25Workspace) throw new Error(`B2-5 leg: create landscape returned no workspace: ${JSON.stringify(b25Landscape)}`)
const b25Root = await waitFor(
  `B2-5 workspace route for ${b25Workspace.landscapeId}`,
  () => probeRoot(b25Workspace, session.cookie),
)
const b25Owner = cells[b25Root.ownerIndex]
const b25NonOwner = cells[1 - b25Root.ownerIndex]
// WAIT FOR THE READ MODEL FIRST, and this is not defensive padding: posting
// the repair straight after creating the landscape gets HTTP 500 "read model
// query failed" from the OWNER — `repairReferenceIntegrity` scans `ro_*` rows,
// and a workspace created a moment ago has none until its projector is
// resident. (500 and 400 and 200 all arrive through a working proxy, which is
// why a status-only assertion is worthless here.)
await waitForReadModel(b25Workspace, session.cookie, b25Root.ownerIndex)

const applyBody = JSON.stringify({ ...b25Workspace, apply: true })
const postRepair = (baseUrl, pathname, body) => request(`${baseUrl}${pathname}`, {
  cookie: session.cookie,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
  timeoutMs: 60_000,
})

// A CEILING, because the client bound here is 60 s. Nothing else asserts
// elapsed time, so without this a regression that made a routed write take
// 40 s — just under `ROUTED_WRITE_HEADER_DEADLINE_MS` — would be invisible.
// 20 s is far above the few milliseconds this call normally takes and far
// below the deadline, so it fails
// on a change of KIND rather than on bench noise.
const b25Started = Date.now()
const b25Proxied = await postRepair(b25NonOwner.baseUrl, '/API/platform/reference-integrity/repair/', applyBody)
const b25ElapsedMs = Date.now() - b25Started
if (b25ElapsedMs > 20_000) {
  throw new Error(`B2-5: a routed no-op apply took ${b25ElapsedMs} ms — the 45 s deadline is not a latency budget`)
}
if (b25Proxied.status !== 200 || b25Proxied.route !== 'proxied') {
  throw new Error(
    'B2-5: a body-bearing write on a non-owner was not proxied with a 200: '
    + JSON.stringify(b25Proxied),
  )
}
// THE ASSERTION A STATUS CANNOT MAKE. The result echoes the ids back, so this
// is direct proof the owner parsed the body rather than a proxy for it. Under
// the normalisation defect the forward is bodyless and `index.ts` answers 400
// "landscapeId and versionId are required".
if (b25Proxied.body?.landscapeId !== b25Workspace.landscapeId
  || b25Proxied.body?.versionId !== b25Workspace.versionId) {
  throw new Error(`B2-5: the owner did not receive the body: ${JSON.stringify(b25Proxied)}`)
}
// …and it ran the APPLY branch, not a silently downgraded dry run.
if (b25Proxied.body?.reportOnly !== false) {
  throw new Error(`B2-5: the apply was downgraded to a report: ${JSON.stringify(b25Proxied.body)}`)
}
// …and wrote nothing, which is what makes the leg repeatable. `applyIntegrity`
// is present EXACTLY when the lock was taken and the writes ran, so its absence
// is the checkable form of "this leg is not mutating the bench". It goes red the
// day someone starts seeding content here — which is the day it would start
// mutating a real workspace.
if (!Array.isArray(b25Proxied.body?.plans)
  || b25Proxied.body.plans.length !== 0
  || b25Proxied.body.applied !== 0
  || b25Proxied.body.applyIntegrity !== undefined) {
  throw new Error(`B2-5: the routed apply was not a no-op on a fresh workspace: ${JSON.stringify(b25Proxied.body)}`)
}

// THE POSITIVE CONTROL, on the canonical spelling against the OWNER. Without it
// a gate that answered `proxied` for everything — or a cell that had stopped
// owning anything — would satisfy the assertion above.
const b25Owned = await postRepair(b25Owner.baseUrl, '/api/platform/reference-integrity/repair', applyBody)
if (b25Owned.status !== 200 || b25Owned.route !== 'owner') {
  throw new Error(`B2-5: the owner did not serve its own workspace locally: ${JSON.stringify(b25Owned)}`)
}

// THE REPORT IS NOT ROUTED, deliberately: `index.ts` calls the dry run "the
// report an operator reads precisely when a promotion looks stuck", so routing
// it would answer 503 during exactly the outage the routing exists for.
//
// `route === null` rather than `!== 'proxied'`, and the difference matters: a
// request the router never CLAIMS sets no `x-maplespire-sync-route` header at
// all, so `!== 'proxied'` is satisfied equally by "the dry run is deliberately
// ungated" and by "the extractor table is empty and the gate claims nothing".
// The apply leg above is what discriminates those today; asserting `null` here
// means this leg does not depend on that ordering.
const b25Report = await postRepair(
  b25NonOwner.baseUrl,
  '/api/platform/reference-integrity/repair',
  JSON.stringify(b25Workspace),
)
if (b25Report.status !== 200 || b25Report.route !== null || b25Report.body?.reportOnly !== true) {
  throw new Error(`B2-5: the dry run was routed or refused: ${JSON.stringify(b25Report)}`)
}

// ── THE DRAFT MERGE, THE ONLY FAMILY WITH A DATABASE LOOKUP IN ITS PLACEMENT ──
//
// The four administrative families name their workspace in their body. The
// merge names a DRAFT, and the workspace it writes is that draft's PARENT — a
// `SELECT` the router performs before it can place anything
// (`resolveMergeParentWorkspace`). It is also the only family that carries
// `requireWriteAuthority`, and unrouted it can commit durably on a cell
// holding neither the partition nor the lease.
//
// So an active/active gate that exercised only `reference-integrity/repair`
// would pass with merge routing completely broken. This leg is that gap.
const b25Draft = await json(`${b25Owner.baseUrl}/api/landscapes/${b25Workspace.landscapeId}/drafts`, {
  cookie: session.cookie,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'B2-5 routed merge' }),
  timeoutMs: 60_000,
})
const b25DraftId = b25Draft.draft?.id
if (!b25DraftId) throw new Error(`B2-5: create draft returned no id: ${JSON.stringify(b25Draft)}`)
// The draft's parent is the landscape's default version — `createDraft` sets it
// from `landscapes.default_version_id` — which is `b25Workspace.versionId`,
// whose owner `probeRoot` already named. So the merge must land on `b25Owner`
// even though it is POSTed to `b25NonOwner`, and the ONLY way the router can
// know that is the parent lookup.
const b25Merge = await request(
  `${b25NonOwner.baseUrl}/api/landscapes/${b25Workspace.landscapeId}/drafts/${b25DraftId}/merge`,
  {
    cookie: session.cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutions: {} }),
    timeoutMs: 60_000,
  },
)
if (b25Merge.status !== 200 || b25Merge.route !== 'proxied') {
  throw new Error(`B2-5: the draft merge was not proxied to the parent's owner: ${JSON.stringify(b25Merge)}`)
}
// A NON-EMPTY `versionId` is the proof the merge actually ran on the owner.
// `applyMerge` answers 200 with an EMPTY `versionId` for a draft that was
// already merged, so accepting any 200 would accept a no-op (there is no
// idempotency key).
if (typeof b25Merge.body?.versionId !== 'string' || b25Merge.body.versionId === '') {
  throw new Error(`B2-5: the proxied merge produced no version: ${JSON.stringify(b25Merge)}`)
}
// AND THE FIRST MERGE COMMITTED DURABLY, proved by REPLAYING it.
//
// `applyMerge` answers 200 with an EMPTY `versionId` for a draft already
// `merged` — so a second POST that comes back empty is the database's word that
// the first one flipped `versions.status` on the OWNER, not the merge's own
// report of itself. A merge that had mutated in memory and failed at flush
// would answer 200 with a fresh non-empty id again.
//
// It also makes a known gap executable: without an idempotency key, a caller
// whose proxied write timed out cannot tell this answer from a no-op.
//
// NOT asserted by resolving the new version through `/api/automerge/root`: that
// answers 403 for a few seconds, because
// `workspaceKeySets` caches the RBAC key set and a version minted moments ago is
// not in it yet. A real behaviour, unrelated to placement, and not this leg's
// subject.
const b25Replay = await request(
  `${b25NonOwner.baseUrl}/api/landscapes/${b25Workspace.landscapeId}/drafts/${b25DraftId}/merge`,
  {
    cookie: session.cookie,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolutions: {} }),
    timeoutMs: 60_000,
  },
)
if (b25Replay.status !== 200 || b25Replay.route !== 'proxied' || b25Replay.body?.versionId !== '') {
  throw new Error(
    `B2-5: replaying the merge did not report an already-merged draft: ${JSON.stringify(b25Replay)}`,
  )
}

// ── THE TWO CREATION DOORS, ROUTED TO THE DEFAULT VERSION'S OWNER ──
//
// `POST /drafts` and `POST /versions` fork the landscape under its DEFAULT
// version's lease — the storage fence keys the whole bootstrap family on it —
// so a request landing on the cell that does not hold that lease is proxied to
// the one that does, never refused. Unrouted and unfenced, these doors would
// commit documents on a cell that owns nothing.
//
// The assertion a status cannot make: the twin's documents are CLAIMED for the
// returned version — six rows in `automerge_document_workspace` — which is the
// bench's own witness (`claimedDocumentsForReturnedVersion`) read here through
// the leg's `psql`. A proxied 200 whose fork was refused on the owner and
// silently answered by the landing cell would show zero.
const claimedRowsFor = (workspace) => Number(compose(
  'exec', '-T', 'postgres',
  'psql', '-U', 'maplespire', '-d', 'maplespire', '-Atc',
  `SELECT count(*) FROM automerge_document_workspace WHERE landscape_id = '${workspace.landscapeId}' AND version_id = '${workspace.versionId}'`,
).trim())
const b25dDraft = await request(`${b25NonOwner.baseUrl}/api/landscapes/${b25Workspace.landscapeId}/drafts`, {
  cookie: session.cookie,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'B2-5d routed draft' }),
  timeoutMs: 60_000,
})
if (b25dDraft.status !== 200 || b25dDraft.route !== 'proxied' || !b25dDraft.body?.draft?.id) {
  throw new Error(`B2-5d: the draft creation was not proxied to the default version's owner: ${JSON.stringify(b25dDraft)}`)
}
const b25dDraftRows = claimedRowsFor({ landscapeId: b25Workspace.landscapeId, versionId: b25dDraft.body.draft.id })
if (b25dDraftRows !== 6) {
  throw new Error(`B2-5d: the routed draft claimed ${b25dDraftRows} document(s), expected the six of an empty landscape's graph`)
}
// `forkFromVersionId` names the default here; the point of the leg is the
// placement, and the DB-gated arms cover a non-active source.
const b25dVersion = await request(`${b25NonOwner.baseUrl}/api/landscapes/${b25Workspace.landscapeId}/versions`, {
  cookie: session.cookie,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'B2-5d routed fork', forkFromVersionId: b25Workspace.versionId }),
  timeoutMs: 60_000,
})
if (b25dVersion.status !== 200 || b25dVersion.route !== 'proxied' || !b25dVersion.body?.version?.id) {
  throw new Error(`B2-5d: the version fork was not proxied to the default version's owner: ${JSON.stringify(b25dVersion)}`)
}
const b25dVersionRows = claimedRowsFor({ landscapeId: b25Workspace.landscapeId, versionId: b25dVersion.body.version.id })
if (b25dVersionRows !== 6) {
  throw new Error(`B2-5d: the routed fork claimed ${b25dVersionRows} document(s), expected six`)
}
// THE POSITIVE CONTROL: the same door on the OWNER is served locally.
const b25dOwned = await request(`${b25Owner.baseUrl}/api/landscapes/${b25Workspace.landscapeId}/drafts`, {
  cookie: session.cookie,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: 'B2-5d owned draft' }),
  timeoutMs: 60_000,
})
if (b25dOwned.status !== 200 || b25dOwned.route !== 'owner') {
  throw new Error(`B2-5d: the owner did not serve its own draft creation locally: ${JSON.stringify(b25dOwned)}`)
}

for (const cell of cells) {
  const logs = compose('logs', '--no-color', cell.service)
  if (!logs.includes('sync.cell.http_route_proxy')) {
    throw new Error(`${cell.service} did not log an HTTP owner proxy`)
  }
  if (!logs.includes('sync.cell.route_proxy')) {
    throw new Error(`${cell.service} did not log a WebSocket owner proxy`)
  }
}

console.log(JSON.stringify({
  outcome: 'passed',
  scenario: 'multi-partition-http-active-active',
  authenticatedUserId: session.userId,
  authenticatedOrgId: session.orgId,
  cells: states.map((state, index) => ({
    service: cells[index].service,
    cellId: state.cellId,
    partition: state.partitionIndex,
    ready: state.ready,
  })),
  workspaces: readModels,
  projectorFleets: projectorFleets.map((fleet, index) => ({
    service: cells[index].service,
    residentProjectors: fleet.residentProjectors,
    foreignResidentProjectors: fleet.foreignResidentProjectors,
    ownershipRejectedStarts: fleet.ownershipRejectedStarts,
    ownershipEvictions: fleet.ownershipEvictions,
  })),
  globalGc: gcResults.map((result, index) => ({
    service: cells[index].service,
    status: result.status,
    route: result.route,
    reason: result.body?.reason,
  })),
  globalGcWorker: {
    outcome: workerEvent.outcome,
    deleted: workerEvent.result.deleted,
    deferredYoung: workerEvent.result.deferredYoung,
    oldOrphanDeleted: true,
    youngOrphanDeferred: true,
  },
  routedWrite: {
    workspace: b25Workspace,
    owner: b25Owner.service,
    proxiedBy: b25NonOwner.service,
    spelling: '/API/platform/reference-integrity/repair/',
    ownerParsedTheBody: true,
    apply: { reportOnly: b25Proxied.body.reportOnly, applied: b25Proxied.body.applied, wroteNothing: true },
    elapsedMs: b25ElapsedMs,
    ownerServedLocally: b25Owned.route,
    reportRanWhereItLanded: b25Report.route,
  },
  routedCreations: {
    draft: { id: b25dDraft.body.draft.id, route: b25dDraft.route, claimedDocuments: b25dDraftRows },
    version: { id: b25dVersion.body.version.id, route: b25dVersion.route, claimedDocuments: b25dVersionRows },
    ownerServedLocally: b25dOwned.route,
  },
  routedMerge: {
    draftId: b25DraftId,
    parent: b25Workspace,
    owner: b25Owner.service,
    proxiedBy: b25NonOwner.service,
    route: b25Merge.route,
    versionId: b25Merge.body.versionId,
    replayReportedAlreadyMerged: b25Replay.body.versionId === '',
  },
}))
