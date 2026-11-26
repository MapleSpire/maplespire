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
 * T-SUM-0: "Paul's diagram" END TO END, on a stack of its own — a named
 * harness of `npm run ci:local` and of `ci.yml` (`npm run e2e:summary-visibility`).
 *
 * `e2e/boot/summary-workspace-diagram-visible.spec.ts` skips without
 * `E2E_SUMMARY_LANDSCAPE`, and until this harness nothing ever set it: the #41
 * fix (`staticDeltaProjector.ts`, the `registry-shard` branch →
 * `projectRegistryShard`) was guarded by no executed test. This script gives
 * the spec a stack, seeded summary workspaces and two users, runs it, and
 * REFUSES a run that skipped: each arm's Playwright JSON report must say
 * exactly the expected number of passed tests and zero skipped, flaky or
 * failed, or the harness exits non-zero (`judgeReport`).
 *
 *  1. A FRESH database `maplespire_summary_e2e` on the Postgres server named by
 *     `SUMMARY_E2E_ADMIN_DATABASE_URL` (default `TEST_DATABASE_URL`: the
 *     ci:local container, or the ci.yml service). No URL → exit 2, VOID.
 *  2. This checkout's sync server (`tsx src/index.ts`): AUTH=on with the dev
 *     login, READ_MODEL=on, AM_SELECTIVE_SYNC=on, ORG_SEED=on. Paul is the
 *     bootstrap platform admin (by `(issuer, subject)`, never by email); Marie
 *     is a second dev-login user made an admin of Paul's organisation, so her
 *     cold profile reads what that org reads and nothing else.
 *  3. ARMS of the visibility suite (`--arm=fixture|promoted|both`, default both):
 *     - `fixture`: `seed:performance --profile smoke` (1 000 objects, 40
 *       diagrams) into Paul's org, with the server DOWN as the seeder requires;
 *     - `promoted`: an ORDINARY org-demo landscape (`POST /api/orgs/:id/seed`:
 *       sharded, base shards, overlays, diagrams), opened once by a real
 *       browser, then promoted through `POST /api/platform/workspace/
 *       promote-summary` by the spec itself — the route an operator is told to
 *       use.
 *  4. The client BUILT with the production flags (`compose.maplespire.yml`:
 *     boot-from-server, sharding, server read model), `--mode development` so
 *     the DEV probes the specs read exist, and served by `vite preview` (no
 *     HMR, so no page reload a spec did not ask for — `e2e-epochs.mjs`).
 *  5. Per arm: Paul (cold profile) creates a diagram and finds its card; Marie
 *     (a SECOND cold profile, another user) finds the same card through the
 *     server-answered search and opens it. Then (T-SUM-0b) Paul renames an
 *     object and Marie must see the new name in the Model Objects page; the
 *     post-check judges the `ro_objects` row against the overlay heads read
 *     from storage (`judgeObjectFacts`).
 *
 * `--suite=offline` (NOT in CI, for its cost) runs
 * `summary-promotion-offline.spec.ts` instead, against TWO client builds —
 * production flags and a classic one (boot-from-server off) — with four fresh
 * ordinary workspaces each.
 *
 * Ports (overridable, none a dev stack's): server 3587, clients 5587 (+1).
 *
 * `--suite=replay` (NOT in CI either — T-SUM-2) runs
 * `summary-replay-after-crash.spec.ts` on the fixture arm, with the server
 * rotating its overlay heads after eight batches (`AM_OVERLAY_SEGMENT_SIZE=8`,
 * a 500 ms quiet window) so a crashed writer's batch leaves its sight. A
 * qualification: it is green without the T-SUM-2 fix too (the spec's header
 * says why).
 *
 * `--suite=resurrection` (NOT in CI — T-SUM-2b) runs
 * `replay-resurrection.spec.ts` on TWO workspaces: the summary fixture and an
 * ordinary org-demo landscape, the server restarted after the seed with that
 * landscape alone in `COMPACTION_WORKSPACE_ALLOWLIST` (the spec folds its
 * overlay through the operator route) and the same rotation settings as
 * `replay` for the summary plane.
 *
 * `--suite=switch-down` (NOT in CI — T-DIAGDEF-2)
 * runs `workspace-switch-server-down.spec.ts` on the summary fixture and an
 * ordinary org-demo landscape. The spec STOPS and RESTARTS this stack's server
 * (one SIGTERM to its process group, then the same command and environment —
 * the same `AUTH_SECRET`, so the browser's session survives the restart)
 * through a control endpoint only this suite opens, on 127.0.0.1
 * (`SUMMARY_E2E_CONTROL_PORT`, default 3589): `POST /server/stop`,
 * `POST /server/start`.
 *
 * Usage:
 *   node scripts/e2e-summary-visibility.mjs [--suite=visibility|offline|replay|resurrection|switch-down] [--arm=fixture|promoted|both] [--stack-only] [-- <playwright args>]
 *
 * Exit: 0 GREEN, 1 RED (a test failed, or a report is not what a full run
 * produces), 2 VOID (no database to run against, or bad arguments).
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_DIR = path.join(ROOT, 'server')
const PORTS = {
  server: process.env.SUMMARY_E2E_SERVER_PORT ?? '3587',
  vite: process.env.SUMMARY_E2E_VITE_PORT ?? '5587',
  control: process.env.SUMMARY_E2E_CONTROL_PORT ?? '3589',
}
const SUITES = ['visibility', 'offline', 'replay', 'resurrection', 'switch-down']
const DB_NAME = 'maplespire_summary_e2e'
const PAUL = 'paul@summary.e2e.test'
const MARIE = 'marie@summary.e2e.test'
const FIXTURE_NAME = 'Summary e2e fixture (smoke)'
const SERVER = `http://localhost:${PORTS.server}`
const OFFLINE_CELLS = 4

export const USAGE = `Usage:
  node scripts/e2e-summary-visibility.mjs [--suite=visibility|offline|replay|resurrection|switch-down] [--arm=fixture|promoted|both] [--client=bfs|classic|both] [--stack-only] [-- <playwright args>]`

export function parseArgs(argv) {
  const dash = argv.indexOf('--')
  const own = dash >= 0 ? argv.slice(0, dash) : argv
  const parsed = { suite: 'visibility', arm: 'both', client: 'both', stackOnly: false, help: false, playwright: dash >= 0 ? argv.slice(dash + 1) : [] }
  for (const arg of own) {
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--stack-only') parsed.stackOnly = true
    else if (arg.startsWith('--arm=')) {
      const value = arg.slice('--arm='.length)
      if (!['fixture', 'promoted', 'both'].includes(value)) return { error: `--arm must be fixture, promoted or both (got ${value})` }
      parsed.arm = value
    } else if (arg.startsWith('--client=')) {
      const value = arg.slice('--client='.length)
      if (!['bfs', 'classic', 'both'].includes(value)) return { error: `--client must be bfs, classic or both (got ${value})` }
      parsed.client = value
    } else if (arg.startsWith('--suite=')) {
      const value = arg.slice('--suite='.length)
      if (!SUITES.includes(value)) return { error: `--suite must be ${SUITES.slice(0, -1).join(', ')} or ${SUITES.at(-1)} (got ${value})` }
      parsed.suite = value
    } else return { error: `Unknown argument: ${arg}` }
  }
  return parsed
}

/**
 * The verdict on ONE run's Playwright JSON report. A run that skipped, ran
 * nothing, retried, or ran another number of tests than declared is never
 * GREEN — the point of this harness is that the spec can no longer skip into
 * a pass.
 */
export function judgeReport(report, expectedTests = 1, expectedSpec = null) {
  const stats = report?.stats
  if (!stats || typeof stats.expected !== 'number') return { ok: false, reason: 'the report has no stats: Playwright did not reach its reporter' }
  if (expectedSpec) {
    // The config takes its spec from the environment: a stray
    // E2E_SUMMARY_SPEC would otherwise run ANOTHER file and be judged here.
    const files = (report.suites ?? []).map((suite) => String(suite.file ?? '').split(/[\\/]/).pop())
    if (files.length === 0 || files.some((file) => file !== expectedSpec)) {
      return { ok: false, reason: `the report is for ${JSON.stringify(files)}, not ${expectedSpec}` }
    }
  }
  if (stats.skipped > 0) return { ok: false, reason: `${stats.skipped} test(s) SKIPPED — a skip is not a pass here` }
  if (stats.unexpected > 0) return { ok: false, reason: `${stats.unexpected} test(s) failed` }
  if (stats.flaky > 0) return { ok: false, reason: `${stats.flaky} test(s) flaky — retries are 0, so this cannot happen silently` }
  if (stats.expected !== expectedTests) return { ok: false, reason: `${stats.expected} test(s) passed, exactly ${expectedTests} expected` }
  return { ok: true, reason: `${stats.expected} passed, 0 skipped` }
}

/** Paul's organisation, once he has signed in (the post-check's `org_id`). */
let paulOrgId = null

/** Read one Automerge document straight from `automerge_storage` (snapshot
 * and incremental chunks; sync-state is protocol bookkeeping) — a witness the
 * projector does not write. Null when the document has no content row. */
export async function loadStoredDocument(db, automerge, documentId) {
  const { rows } = await db.query(
    `SELECT data FROM automerge_storage
      WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')
      ORDER BY split_part(key, '/', 2) DESC, key`,
    [documentId],
  )
  if (rows.length === 0) return null
  let doc = automerge.init()
  for (const row of rows) doc = automerge.loadIncremental(doc, row.data)
  return doc
}

/** Every fact `judgeServerFacts` needs, for one created diagram. */
export async function gatherServerFacts(db, automerge, target, diagramId) {
  const key = [target.landscapeId, target.versionId]
  const { rows: roRows } = await db.query(
    `SELECT org_id, data->>'docUrl' AS doc_url, data->>'name' AS name, data->>'type' AS type
       FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
    [...key, diagramId],
  )
  // The registry documents that CARRY the id, read from Automerge itself.
  const { rows: registryDocs } = await db.query(
    `SELECT document_id, kind FROM read_model_static_documents
      WHERE landscape_id = $1 AND version_id = $2 AND kind IN ('registry-shard', 'registry')`,
    key,
  )
  const carriers = []
  for (const { document_id: documentId, kind } of registryDocs) {
    const doc = await loadStoredDocument(db, automerge, documentId)
    const meta = doc?.diagrams?.[diagramId]
    if (meta) carriers.push({ documentId, kind, meta: { name: meta.name ?? null, type: meta.type ?? null, docUrl: meta.docUrl ?? null } })
  }
  let queue = null
  if (carriers.length === 1) {
    const { rows } = await db.query(
      `SELECT revision::int AS revision, projected_revision::int AS projected_revision, projected_at
         FROM read_model_static_document_queue WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [...key, carriers[0].documentId],
    )
    queue = rows[0] ?? null
  }
  const docUrl = roRows[0]?.doc_url ?? null
  const diagramDocumentId = docUrl ? docUrl.replace(/^automerge:/, '').split('?')[0] : null
  let diagramDoc = { stored: false, admittedAs: null }
  if (diagramDocumentId) {
    const stored = await loadStoredDocument(db, automerge, diagramDocumentId)
    const { rows } = await db.query(
      `SELECT kind, entity_id FROM read_model_static_documents
        WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [...key, diagramDocumentId],
    )
    diagramDoc = { stored: stored !== null, admittedAs: rows[0] ? { kind: rows[0].kind, entityId: rows[0].entity_id } : null }
  }
  return { rows: roRows, carriers, queue, diagramDoc }
}

/**
 * The server verdict, pure so its rules are unit-tested. Each rule closes a
 * mutation a weaker check let through: the row must exist
 * ONCE, belong to Paul's org, name the DiagramDoc the registry names (and
 * that document must exist and be admitted as this diagram), carry the name
 * and type of the gesture, and the queue row judged must be the CARRIER's,
 * projected after the creation started.
 */
export function judgeServerFacts(facts, created, expectedOrgId, { clockSlackMs = 5_000 } = {}) {
  const fail = (reason) => ({ ok: false, reason })
  if (facts.rows.length !== 1) return fail(`${facts.rows.length} ro_diagrams row(s) for ${created.diagramId}, exactly 1 expected`)
  const row = facts.rows[0]
  if (!expectedOrgId || row.org_id !== expectedOrgId) return fail(`ro_diagrams.org_id is ${JSON.stringify(row.org_id)}, not Paul's org`)
  if (facts.carriers.length !== 1) return fail(`${facts.carriers.length} registry document(s) carry ${created.diagramId} in Automerge, exactly 1 expected`)
  const carrier = facts.carriers[0]
  if (carrier.kind !== 'registry-shard') return fail(`the carrier is a ${carrier.kind}, not the registry write head`)
  if (!row.doc_url) return fail('ro_diagrams.data.docUrl is empty')
  if (row.doc_url !== carrier.meta.docUrl) return fail(`ro_diagrams docUrl ${row.doc_url} is not the registry's ${carrier.meta.docUrl}`)
  if (!facts.diagramDoc.stored) return fail(`the docUrl ${row.doc_url} resolves to no stored Automerge document`)
  if (facts.diagramDoc.admittedAs?.kind !== 'diagram' || facts.diagramDoc.admittedAs?.entityId !== created.diagramId) {
    return fail(`the DiagramDoc is admitted as ${JSON.stringify(facts.diagramDoc.admittedAs)}, not as diagram ${created.diagramId}`)
  }
  if (row.name !== created.name || carrier.meta.name !== created.name) {
    return fail(`name: row ${JSON.stringify(row.name)}, registry ${JSON.stringify(carrier.meta.name)}, gesture ${JSON.stringify(created.name)}`)
  }
  if (row.type !== created.type) return fail(`type: row ${JSON.stringify(row.type)}, gesture ${JSON.stringify(created.type)}`)
  const queue = facts.queue
  if (!queue) return fail(`the carrier ${carrier.documentId} has no projection queue row`)
  if (!(queue.revision > 0) || queue.projected_revision < queue.revision) {
    return fail(`the carrier's queue row is at ${queue.projected_revision}/${queue.revision}`)
  }
  const startedAt = Date.parse(created.creationStartedAt ?? '')
  const projectedAt = queue.projected_at ? new Date(queue.projected_at).getTime() : NaN
  if (!Number.isFinite(startedAt) || !Number.isFinite(projectedAt) || projectedAt < startedAt - clockSlackMs) {
    return fail(`the carrier was last projected at ${queue.projected_at}, before the creation started (${created.creationStartedAt})`)
  }
  return { ok: true, reason: `ro_diagrams row of ${created.diagramId} matches the registry write head ${carrier.documentId} `
    + `(org, docUrl → stored DiagramDoc, name, type); its queue row ${queue.projected_revision}/${queue.revision}, projected after the creation` }
}

/**
 * T-SUM-0b: every fact `judgeObjectFacts` needs about Paul's object rename.
 * The witnesses the projector does not write are the object-overlay
 * documents admitted for the workspace, read straight from
 * `automerge_storage`: the one that holds the new name is the head the
 * rename was written to, and its queue row is the one judged.
 */
export async function gatherObjectFacts(db, automerge, target, renamed) {
  const key = [target.landscapeId, target.versionId]
  const { rows } = await db.query(
    `SELECT org_id, name, data->>'name' AS data_name
       FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3`,
    [...key, renamed.id],
  )
  const { rows: overlays } = await db.query(
    `SELECT document_id FROM read_model_static_documents
      WHERE landscape_id = $1 AND version_id = $2 AND kind = 'object-overlay'`,
    key,
  )
  const carriers = []
  for (const { document_id: documentId } of overlays) {
    const doc = await loadStoredDocument(db, automerge, documentId)
    const object = doc?.objects?.[renamed.id]
    if (object) carriers.push({ documentId, name: object.name === undefined ? null : String(object.name) })
  }
  const holders = carriers.filter((carrier) => carrier.name === renamed.name)
  let queue = null
  if (holders.length === 1) {
    const { rows: queueRows } = await db.query(
      `SELECT revision::int AS revision, projected_revision::int AS projected_revision, projected_at
         FROM read_model_static_document_queue WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
      [...key, holders[0].documentId],
    )
    queue = queueRows[0] ?? null
  }
  const { rows: rotations } = await db.query(
    `SELECT old_document_id, new_document_id, status, published_at
       FROM read_model_overlay_rotations
      WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' ORDER BY created_at`,
    key,
  )
  return { rows, carriers, holders, queue, rotations }
}

/**
 * The server verdict on the rename, pure so its rules are unit-tested: ONE
 * `ro_objects` row, Paul's org, carrying the NEW name (column and JSON), the
 * new name durable in exactly one admitted overlay head (else the write never
 * reached the server, which is another defect), and that head's queue row
 * projected after the rename started — the row the T-SUM-0 stack left at
 * `projected_revision 0`.
 */
export function judgeObjectFacts(facts, renamed, expectedOrgId, { clockSlackMs = 5_000 } = {}) {
  const fail = (reason) => ({ ok: false, reason })
  if (!renamed?.id || !renamed?.name) return fail('the spec never wrote the renamed object')
  if (facts.rows.length !== 1) return fail(`${facts.rows.length} ro_objects row(s) for ${renamed.id}, exactly 1 expected`)
  const row = facts.rows[0]
  if (!expectedOrgId || row.org_id !== expectedOrgId) return fail(`ro_objects.org_id is ${JSON.stringify(row.org_id)}, not Paul's org`)
  if (facts.holders.length !== 1) {
    return fail(`${facts.holders.length} admitted object-overlay document(s) hold "${renamed.name}" in Automerge, exactly 1 expected `
      + `(carriers of ${renamed.id}: ${JSON.stringify(facts.carriers)})`)
  }
  const holder = facts.holders[0]
  if (row.name !== renamed.name || row.data_name !== renamed.name) {
    return fail(`ro_objects name is ${JSON.stringify(row.name)} (data ${JSON.stringify(row.data_name)}), but the head `
      + `${holder.documentId} holds "${renamed.name}" (was "${renamed.previousName}"): the rename was never projected`)
  }
  const queue = facts.queue
  if (!queue) return fail(`the head ${holder.documentId} has no projection queue row`)
  if (!(queue.revision > 0) || queue.projected_revision < queue.revision) {
    return fail(`the head ${holder.documentId}'s queue row is at ${queue.projected_revision}/${queue.revision}`)
  }
  const startedAt = Date.parse(renamed.renameStartedAt ?? '')
  const projectedAt = queue.projected_at ? new Date(queue.projected_at).getTime() : NaN
  if (!Number.isFinite(startedAt) || !Number.isFinite(projectedAt) || projectedAt < startedAt - clockSlackMs) {
    return fail(`the head ${holder.documentId} was last projected at ${queue.projected_at}, before the rename started (${renamed.renameStartedAt})`)
  }
  // The defect lived in the head a rotation published at the entry into the
  // static plane, so a rename written anywhere else exercises nothing: a run
  // where the head was not such a child cannot tell fixed from broken.
  const rotatedBefore = facts.rotations.some((rotation) => rotation.status === 'published'
    && rotation.new_document_id === holder.documentId
    && new Date(rotation.published_at).getTime() <= startedAt)
  if (!rotatedBefore) {
    return fail(`the head ${holder.documentId} holding the rename is not a head a rotation published before the rename `
      + `(rotations: ${JSON.stringify(facts.rotations)}): this run does not exercise the rotated write head`)
  }
  return { ok: true, reason: `ro_objects row of ${renamed.id} carries "${renamed.name}" (Paul's org) as the head ${holder.documentId} does; `
    + `its queue row ${queue.projected_revision}/${queue.revision}, projected after the rename; that head was published by a rotation before it` }
}

const children = new Set()

function startChild(name, command, args, { cwd, env, logDir }) {
  const log = createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' })
  // Its own process group, so teardown reaches tsx's children too.
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.on('exit', (code, signal) => log.write(`\n[${name}] exited code=${code} signal=${signal}\n`))
  children.add(child)
  return child
}

/** `spawnSync`'s `{ status }`, without blocking the event loop. In its own
 * process group and in `children` while it runs, so the signal teardown —
 * which can now run DURING the spec — stops Playwright and its browsers too. */
function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, detached: true })
    children.add(child)
    child.on('error', () => { children.delete(child); resolve({ status: null }) })
    child.on('exit', (code) => { children.delete(child); resolve({ status: code }) })
  })
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
}

async function waitFor(label, probe, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`${label}: the process exited (${child.exitCode}) before it was ready`)
    if (await probe().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} not ready after ${timeoutMs / 1000} s`)
}

const httpOk = (url) => async () => (await fetch(url)).ok

/** The tests `workspace-switch-server-down.spec.ts` declares (judged exactly). */
const SWITCH_DOWN_TESTS = 4
/** The switch-down suite's server control (`startServerControl`), closed at teardown. */
let control = null

/**
 * T-DIAGDEF-2: `POST /server/stop` and `POST /server/start` on 127.0.0.1 only,
 * one at a time (a request while another runs is refused with 409). Each
 * answers JSON: `{ ok, ms, ... }`, or `{ ok: false, error }` with 500.
 */
function startServerControl(port, actions) {
  let busy = false
  const server = http.createServer((request, response) => {
    const action = request.method === 'POST' ? { '/server/stop': actions.stop, '/server/start': actions.start }[request.url ?? ''] : undefined
    const answer = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (!action) return answer(404, { ok: false, error: 'POST /server/stop or /server/start' })
    if (busy) return answer(409, { ok: false, error: 'another control request is running' })
    busy = true
    action().then(
      (result) => answer(200, { ok: true, ...result }),
      (error) => answer(500, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    ).finally(() => { busy = false })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(port), '127.0.0.1', () => resolve(server))
  })
}

async function stopAndWait(child, label) {
  stopChild(child)
  await waitFor(`${label} stop`, async () => child.exitCode !== null || child.signalCode !== null, 30_000)
}

/** The admin URL with its database swapped for ours. */
function databaseUrl(adminUrl, name) {
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return url.toString()
}

async function freshDatabase(pg, adminUrl) {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
    await client.query(`CREATE DATABASE ${DB_NAME}`)
  } finally {
    await client.end()
  }
}

/** The ONE dev-login failure that is a boot race, not a defect: the LAST
 * `dev-login error` the server logged is the provisioning-repo refusal.
 * Any other 500 is reported as it is. */
export function isProvisioningBootRefusal(serverLogText) {
  const errors = serverLogText.split('\n').filter((line) => line.includes('POST /api/auth/dev-login error'))
  const last = errors.at(-1) ?? ''
  return last.includes('provisioning unavailable: Automerge repo not ready (booting)')
}

/** Sign in through the dev login and keep the session cookie. */
async function devLogin(email, serverLog) {
  let response = null
  // `/api/health` and even `/api/ready` can answer before the provisioning
  // repo is attached (`readiness.automerge` is set before
  // `setProvisioningRepo` in index.ts); a first login then fails with 500 and
  // the server logs `provisioning unavailable: Automerge repo not ready
  // (booting)` — measured twice in seven runs. Retry
  // THAT failure, bounded, and nothing else.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    response = await fetch(`${SERVER}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    if (response.ok) break
    // The 500 can reach us before its log line does (the server's stdout is
    // piped): give the line a moment before judging it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const bootRefusal = response.status === 500 && isProvisioningBootRefusal(serverLog ? readFileSync(serverLog, 'utf8') : '')
    if (!bootRefusal) break
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  if (!response.ok) throw new Error(`dev-login ${email}: ${response.status} ${await response.text()}`)
  const cookie = response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
  return { cookie, body: await response.json() }
}

/** One ORDINARY org-demo landscape (sharded, base shards, overlays), as Paul. */
async function seedOrdinaryLandscape(db, paul) {
  const response = await fetch(`${SERVER}/api/orgs/${encodeURIComponent(paul.body.orgId)}/seed`, {
    method: 'POST', headers: { cookie: paul.cookie, 'content-type': 'application/json' }, body: '{}',
  })
  if (response.status !== 201) throw new Error(`org seed: ${response.status} ${await response.text()}`)
  const { result } = await response.json()
  const { rows } = await db.query('SELECT default_version_id FROM landscapes WHERE id = $1', [result.landscapeId])
  if (!rows[0]) throw new Error(`org seed answered ${result.landscapeId}, which has no landscapes row`)
  return { landscapeId: result.landscapeId, versionId: rows[0].default_version_id }
}

function buildClient(name, flags, logDir, viteBin) {
  const outDir = path.join(logDir, `client-${name}`)
  return new Promise((resolve) => {
    const build = spawn(process.execPath, [viteBin, 'build', '--mode', 'development', '--outDir', outDir, '--emptyOutDir'], {
      cwd: ROOT, env: { ...process.env, ...flags, NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(build)
    const log = createWriteStream(path.join(logDir, `vite-build-${name}.log`))
    build.stdout.pipe(log)
    build.stderr.pipe(log)
    build.on('close', (code) => resolve({ code, outDir, flags }))
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(`${args.error}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const adminUrl = process.env.SUMMARY_E2E_ADMIN_DATABASE_URL ?? process.env.TEST_DATABASE_URL
  if (!adminUrl) {
    console.error('[summary-e2e] VOID: neither SUMMARY_E2E_ADMIN_DATABASE_URL nor TEST_DATABASE_URL is set — '
      + 'this harness needs a Postgres server it may create a database on. It never skips.')
    return 2
  }
  const started = Date.now()
  const timings = {}
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const logDir = path.join(ROOT, 'reports', 'e2e-summary-visibility', runId)
  mkdirSync(logDir, { recursive: true })
  const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'))
  const pg = serverRequire('pg')
  const DATABASE_URL = databaseUrl(adminUrl, DB_NAME)
  const tsx = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

  const teardown = () => {
    control?.close()
    control = null
    for (const child of children) stopChild(child)
  }
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => { teardown(); process.exit(code) })
  }
  try {
    let phase = Date.now()
    await freshDatabase(pg, adminUrl)
    const serverEnv = {
      PORT: PORTS.server,
      DATABASE_URL,
      NODE_ENV: 'development',
      APP_URL: `http://localhost:${PORTS.vite}`,
      AUTH: 'on',
      AUTH_DEV_LOGIN: 'on',
      // This run's own secret, never printed.
      AUTH_SECRET: randomBytes(32).toString('hex'),
      AUTH_COOKIE_NAME: `maplespire_session_${PORTS.server}`,
      PLATFORM_ADMIN_BOOTSTRAP_ISSUER: 'dev',
      PLATFORM_ADMIN_BOOTSTRAP_SUBJECT: PAUL,
      EMAIL_PROVIDER: 'local',
      READ_MODEL: 'on',
      AM_SELECTIVE_SYNC: 'on',
      ORG_SEED: 'on',
      // The replay suite needs a head the server ROTATES within the run.
      ...(args.suite === 'replay' || args.suite === 'resurrection'
        ? { AM_OVERLAY_SEGMENT_SIZE: '8', AM_OVERLAY_ROTATION_QUIET_MS: '500' }
        : {}),
    }
    const startServer = () => startChild('server', process.execPath, [tsx, 'src/index.ts'], { cwd: SERVER_DIR, logDir, env: serverEnv })

    // The client builds run WHILE the server creates its schema: neither
    // depends on the other, and a build is the longest single step.
    const common = {
      VITE_SYNC_API_URL: SERVER,
      VITE_AUTOMERGE_URL: `ws://localhost:${PORTS.server}/automerge`,
      VITE_MODEL_SHARDING: 'true',
    }
    const production = { ...common, VITE_BOOT_FROM_SERVER: 'true', VITE_SERVER_READ_MODEL: 'true' }
    const classic = { ...common, VITE_BOOT_FROM_SERVER: 'false', VITE_SERVER_READ_MODEL: 'false' }
    const clientSpecs = args.suite === 'offline'
      ? [['bfs', production, PORTS.vite], ['classic', classic, String(Number(PORTS.vite) + 1)]]
        .filter(([name]) => args.client === 'both' || args.client === name)
      : [['bfs', production, PORTS.vite]]
    const builds = Promise.all(clientSpecs.map(([name, flags, port]) =>
      buildClient(name, { ...flags, VITE_DEV_PORT: port }, logDir, viteBin).then((built) => ({ ...built, name, port }))))

    let server = startServer()
    // `/api/ready`, not `/api/health`: liveness answers while the Automerge
    // repo and the read model are still warming. Still not sufficient for the
    // dev login (see `devLogin`).
    await waitFor('server', httpOk(`${SERVER}/api/ready`), 180_000, server)
    timings.schemaMs = Date.now() - phase
    phase = Date.now()

    const serverLog = path.join(logDir, 'server.log')
    const paul = await devLogin(PAUL, serverLog)
    if (!paul.body.user?.isPlatformAdmin) throw new Error(`${PAUL} is not the bootstrap platform admin`)
    const marie = await devLogin(MARIE, serverLog)
    const db = new pg.Client({ connectionString: DATABASE_URL })
    await db.connect()
    let fixture = null
    let ordinary = null
    const offlineWorkspaces = {}
    paulOrgId = paul.body.orgId
    try {
      const paulOrg = paul.body.orgId
      // Marie joins Paul's organisation as an admin and lands there on her
      // next login. An org MEMBER without team grants reads nothing
      // (`rbac/access.ts`), so a member would test the grant matrix, not the
      // projection.
      await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`, [paulOrg, marie.body.user.id])
      await db.query('UPDATE users SET last_org_id = $1 WHERE id = $2', [paulOrg, marie.body.user.id])

      if ((args.suite === 'visibility' && args.arm !== 'promoted') || args.suite === 'replay' || args.suite === 'resurrection' || args.suite === 'switch-down') {
        // The seeder refuses a live server (storage-fence races), so it runs
        // between two boots.
        await stopAndWait(server, 'server')
        const seed = spawnSync(process.execPath, [tsx, 'scripts/seed-performance.ts', '--profile', 'smoke', '--org-id', paulOrg, '--name', FIXTURE_NAME], {
          cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL, PERFORMANCE_SEED: 'on' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        })
        writeFileSync(path.join(logDir, 'seed-performance.log'), `${seed.stdout}\n${seed.stderr}`)
        if (seed.status !== 0) throw new Error(`seed:performance failed (see ${path.relative(ROOT, logDir)}/seed-performance.log)`)
        const { rows } = await db.query('SELECT id, default_version_id FROM landscapes WHERE name = $1', [FIXTURE_NAME])
        if (rows.length !== 1) throw new Error(`expected one landscape named ${FIXTURE_NAME}, found ${rows.length}`)
        fixture = { landscapeId: rows[0].id, versionId: rows[0].default_version_id }
        server = startServer()
        await waitFor('server (after seed)', httpOk(`${SERVER}/api/ready`), 180_000, server)
      }
      if ((args.suite === 'visibility' && args.arm !== 'fixture') || args.suite === 'switch-down') ordinary = await seedOrdinaryLandscape(db, paul)
      if (args.suite === 'resurrection') {
        ordinary = await seedOrdinaryLandscape(db, paul)
        // The compaction allow-list is read at boot: restart with this
        // landscape named, so the spec can fold its overlay
        // (`POST /api/model/compact`) and a crashed writer's batch leaves the
        // head a new session loads on the ordinary plane too.
        await stopAndWait(server, 'server')
        Object.assign(serverEnv, { COMPACTION_WORKSPACE_ALLOWLIST: `${ordinary.landscapeId}/${ordinary.versionId}` })
        server = startServer()
        await waitFor('server (compaction allow-list)', httpOk(`${SERVER}/api/ready`), 180_000, server)
      }
      if (args.suite === 'offline') {
        for (const [name] of clientSpecs) {
          offlineWorkspaces[name] = []
          for (let cell = 0; cell < OFFLINE_CELLS; cell += 1) offlineWorkspaces[name].push(await seedOrdinaryLandscape(db, paul))
        }
      }
    } finally {
      await db.end()
    }
    timings.seedMs = Date.now() - phase
    phase = Date.now()

    const clients = await builds
    for (const built of clients) {
      if (built.code !== 0) throw new Error(`vite build (${built.name}) failed (see ${path.relative(ROOT, logDir)}/vite-build-${built.name}.log)`)
      startChild(`vite-${built.name}`, process.execPath, [viteBin, 'preview', '--outDir', built.outDir, '--port', built.port, '--strictPort'], {
        cwd: ROOT, logDir, env: { ...built.flags, NODE_ENV: 'development' },
      })
      await waitFor(`vite preview (${built.name})`, httpOk(`http://localhost:${built.port}/`), 120_000)
    }
    timings.clientMs = Date.now() - phase
    console.log(`[summary-e2e] stack up; logs in ${path.relative(ROOT, logDir)}/`)

    // T-DIAGDEF-2: the switch-down suite stops and restarts THIS server.
    let controlUrl = null
    if (args.suite === 'switch-down') {
      const running = () => server.exitCode === null && server.signalCode === null
      control = await startServerControl(PORTS.control, {
        // Idempotent both ways: a stop of a stopped server, or a start of a
        // running one, changes nothing (a second server would die on the port
        // and leave this handle naming a dead process).
        stop: async () => {
          if (!running()) return { ms: 0, alreadyStopped: true }
          const at = Date.now()
          await stopAndWait(server, 'server')
          return { ms: Date.now() - at, code: server.exitCode, signal: server.signalCode }
        },
        start: async () => {
          if (running()) return { ms: 0, alreadyRunning: true }
          const at = Date.now()
          server = startServer()
          await waitFor('server (restart)', httpOk(`${SERVER}/api/ready`), 180_000, server)
          return { ms: Date.now() - at }
        },
      })
      controlUrl = `http://127.0.0.1:${PORTS.control}`
    }

    const baseEnv = {
      E2E_BOOT_API: SERVER,
      E2E_DEV_EMAIL: PAUL,
      E2E_COLD_EMAIL: MARIE,
      E2E_SUMMARY_REQUIRED: '1',
    }
    if (args.stackOnly) {
      for (const [key, value] of Object.entries({
        ...baseEnv, DATABASE_URL, clients: clients.map((c) => `${c.name}=http://localhost:${c.port}`).join(' '),
        fixture: JSON.stringify(fixture), ordinary: JSON.stringify(ordinary), offline: JSON.stringify(offlineWorkspaces),
        ...(controlUrl ? { E2E_SERVER_CONTROL: controlUrl } : {}),
      })) console.log(`  ${key}=${value}`)
      console.log('[summary-e2e] --stack-only: Ctrl+C to tear down.')
      await new Promise(() => {})
    }

    const playwright = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js')
    const VISIBILITY_SPEC = 'summary-workspace-diagram-visible.spec.ts'
    // ASYNC, not `spawnSync` (T-SUM-2c): a synchronous child blocks this
    // process's event loop for the whole spec, so the server's and vite's
    // output pipes are not drained into their logs while it runs — measured,
    // `server.log` of a resurrection run held only the boot lines, nothing the
    // server said during the spec.
    const runSpec = async (label, extra, expectedTests) => {
      const spec = extra.E2E_SUMMARY_SPEC ?? VISIBILITY_SPEC
      const reportFile = path.join(logDir, `playwright-${label}.json`)
      const armStarted = Date.now()
      const result = await spawnAndWait(process.execPath, [playwright, 'test', '-c', 'playwright.summary-visibility.config.ts', ...args.playwright], {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          ...baseEnv,
          ...extra,
          E2E_SUMMARY_SPEC: spec,
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
          E2E_SUMMARY_OUTPUT_DIR: path.join(logDir, `results-${label}`),
        },
      })
      timings[`${label}SpecMs`] = Date.now() - armStarted
      let report = null
      try { report = JSON.parse(readFileSync(reportFile, 'utf8')) } catch { /* judged below */ }
      const verdict = judgeReport(report, expectedTests, spec)
      const ok = verdict.ok && result.status === 0
      console.log(`[summary-e2e] ${label}: ${ok ? 'GREEN' : 'RED'} — ${verdict.reason}; playwright exit ${result.status}`)
      return ok
    }

    /**
     * The SERVER half of the verdict, which no browser assertion can give
     * (with the projection neutralised and the list on its local window,
     * both arms stayed green). The ROW's CONTENT is
     * judged against witnesses the projector does not write — the Automerge
     * registry document read straight from storage, and the DiagramDoc's own
     * storage rows — and the queue row judged is the one of the registry
     * document that CARRIES the id (`judgeServerFacts`; an existence-only
     * check let an empty `docUrl` and a NULL `org_id` through).
     */
    const automerge = serverRequire('@automerge/automerge')
    /** True once a rotation of `target`'s object overlay is published. */
    const waitForObjectRotation = async (target, timeoutMs) => {
      const check = new pg.Client({ connectionString: DATABASE_URL })
      await check.connect()
      try {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const { rows } = await check.query(
            `SELECT 1 FROM read_model_overlay_rotations
              WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND status = 'published'
              LIMIT 1`,
            [target.landscapeId, target.versionId],
          )
          if (rows.length > 0) return true
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        return false
      } finally {
        await check.end()
      }
    }
    const postCheck = async (label, target, createdFile) => {
      let created = null
      try { created = JSON.parse(readFileSync(createdFile, 'utf8')) } catch { /* judged below */ }
      if (!created?.diagramId) {
        console.log(`[summary-e2e] ${label} post-check: RED — the spec never wrote the created id`)
        return false
      }
      const check = new pg.Client({ connectionString: DATABASE_URL })
      await check.connect()
      try {
        let verdict = null
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const facts = await gatherServerFacts(check, automerge, target, created.diagramId)
          verdict = judgeServerFacts(facts, created, paulOrgId)
          if (verdict.ok) break
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        console.log(`[summary-e2e] ${label} post-check: ${verdict.ok ? 'GREEN' : 'RED'} — ${verdict.reason}`)
        // T-SUM-0b: the object rename, judged on its own, whatever the
        // diagram's verdict was.
        let objectVerdict = { ok: false, reason: 'the spec never wrote the renamed object' }
        for (let attempt = 0; created.object && attempt < 30; attempt += 1) {
          const facts = await gatherObjectFacts(check, automerge, target, created.object)
          objectVerdict = judgeObjectFacts(facts, created.object, paulOrgId)
          if (objectVerdict.ok) break
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        console.log(`[summary-e2e] ${label} object post-check: ${objectVerdict.ok ? 'GREEN' : 'RED'} — ${objectVerdict.reason}`)
        return verdict.ok && objectVerdict.ok
      } finally {
        await check.end()
      }
    }

    const verdicts = []
    const bfsUrl = `http://localhost:${PORTS.vite}`
    if (args.suite === 'visibility') {
      const arm = (label, target, extra = {}) => ({
        E2E_BOOT_URL: bfsUrl, E2E_SUMMARY_LANDSCAPE: target.landscapeId, E2E_SUMMARY_VERSION: target.versionId,
        E2E_SUMMARY_CREATED_FILE: path.join(logDir, `created-${label}.json`), ...extra,
      })
      const both = async (label, target, extra) => {
        const env = arm(label, target, extra)
        const browserOk = await runSpec(label, env, 1)
        const serverOk = await postCheck(label, target, env.E2E_SUMMARY_CREATED_FILE)
        return browserOk && serverOk
      }
      if (fixture) {
        // The object post-check requires the rename to land in a head that a
        // rotation published BEFORE it (the head the static plane enters
        // with). The server publishes that rotation on its own once the
        // seeded, over-full object overlay has been quiet for
        // AM_OVERLAY_ROTATION_QUIET_MS after boot; nothing ordered it before
        // the spec, so the run only passed while the client build outlasted
        // that window (18 s builds green, 1 s builds red every time). Wait
        // for the fact instead of the build.
        const rotated = await waitForObjectRotation(fixture, 90_000)
        if (!rotated) {
          console.log('[summary-e2e] fixture: RED — no object overlay rotation was published within 90 s of boot; '
            + 'the object post-check could not exercise the rotated write head')
          verdicts.push(false)
        } else {
          verdicts.push(await both('fixture', fixture))
        }
      }
      // The spec opens the ordinary workspace in a real browser first, then
      // promotes it through the route with Paul's session (it fails loudly).
      if (ordinary) verdicts.push(await both('promoted', ordinary, { E2E_SUMMARY_PROMOTE: '1' }))
    } else if (args.suite === 'replay') {
      verdicts.push(await runSpec('replay', {
        E2E_BOOT_URL: bfsUrl,
        E2E_SUMMARY_SPEC: 'summary-replay-after-crash.spec.ts',
        E2E_SUMMARY_LANDSCAPE: fixture.landscapeId,
        E2E_SUMMARY_VERSION: fixture.versionId,
        DATABASE_URL,
        E2E_REPLAY_OBSERVATIONS: path.join(logDir, 'replay-observations.jsonl'),
      }, 1))
    } else if (args.suite === 'switch-down') {
      verdicts.push(await runSpec('switch-down', {
        E2E_BOOT_URL: bfsUrl,
        E2E_SUMMARY_SPEC: 'workspace-switch-server-down.spec.ts',
        E2E_SWITCH_DOWN_WORKSPACES: JSON.stringify({ ordinary, summary: fixture }),
        E2E_SERVER_CONTROL: controlUrl,
        DATABASE_URL,
        E2E_SWITCH_DOWN_OBSERVATIONS: path.join(logDir, 'switch-down-observations.jsonl'),
      }, SWITCH_DOWN_TESTS))
    } else if (args.suite === 'resurrection') {
      verdicts.push(await runSpec('resurrection', {
        E2E_BOOT_URL: bfsUrl,
        E2E_SUMMARY_SPEC: 'replay-resurrection.spec.ts',
        E2E_REPLAY_WORKSPACES: JSON.stringify([
          { plane: 'ordinary', ...ordinary },
          { plane: 'summary', ...fixture },
        ]),
        DATABASE_URL,
        E2E_REPLAY_OBSERVATIONS: path.join(logDir, 'resurrection-observations.jsonl'),
      }, 11))
    } else {
      for (const built of clients) {
        verdicts.push(await runSpec(`offline-${built.name}`, {
          E2E_BOOT_URL: `http://localhost:${built.port}`,
          E2E_SUMMARY_SPEC: 'summary-promotion-offline.spec.ts',
          E2E_OFFLINE_CLIENT: built.name,
          E2E_OFFLINE_WORKSPACES: JSON.stringify(offlineWorkspaces[built.name]),
          E2E_OFFLINE_OBSERVATIONS: path.join(logDir, 'offline-observations.jsonl'),
        }, OFFLINE_CELLS))
      }
    }
    const green = verdicts.length > 0 && verdicts.every(Boolean)
    timings.totalMs = Date.now() - started
    writeFileSync(path.join(logDir, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`)
    console.log(`[summary-e2e] ${green ? 'GREEN' : 'RED'}; cost ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, `${Math.round(v / 1000)} s`])))}`)
    return green ? 0 : 1
  } finally {
    teardown()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((status) => process.exit(status), (error) => {
    console.error(`[summary-e2e] ${error instanceof Error ? error.message : String(error)}`)
    for (const child of children) stopChild(child)
    process.exit(1)
  })
}
