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
 * T-SUM-2 exit (2) — the measurement instrument, NOT a CI gate.
 *
 * Against ONE running server (the stack `scripts/e2e-summary-visibility.mjs
 * --stack-only` stands up), as the bootstrap platform admin:
 *
 *  1. create a landscape and seed it to OBJECTS objects with the rehearsal
 *     seeder (`publishRehearsalBases`, the G4-7 / G4-16h shape: base shards
 *     of 512 behind the original writer head), and wait until the ORDINARY
 *     projector answers the durability witness fresh with every object;
 *  2. promote it through `POST /api/platform/workspace/promote-summary`
 *     (reports until no blocker, then ONE apply);
 *  3. wait up to 120 s for the static plane's first fresh answer;
 *  4. rename a witness object in the CURRENT object overlay write head, the
 *     way a client writes it (a batch id), and poll the witness every 100 ms
 *     until it answers `absenceProvable` AND shows the rename, sampling the
 *     head's queue row at every poll to count the projection passes;
 *  5. the NEGATIVE probe: one genuine Automerge change of that head written
 *     straight into `automerge_storage` — no repo, no queue row, so nothing
 *     projects it — then 20 s of polls, then a client edit of ANOTHER
 *     document (the connection write head) that makes the static plane
 *     publish, then 20 s more. `absenceProvable` must stay false throughout.
 *
 * Every poll is one JSON line in OUT. The summary line is `T_SUM_2_RESULT`.
 *
 *   cd server && SERVER=http://localhost:56002 DATABASE_URL=… \
 *     npx tsx scripts/t-sum-2-absence-measure.mjs
 */

import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import * as A from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import pg from 'pg'
import { AuthenticatedWebSocketClientAdapter } from '../qa/authenticatedWebSocketAdapter.mjs'
import { appendOverlayBatchId, objectMap, resolveLoadHandle } from '../qa/loadUsersCore.mjs'
import { makeObject } from '../qa/lib.mjs'
import { envNumber } from '../src/envNumber.ts'
import { readMetaUrl, readMetaUrls } from '../src/modelMetaUrls.ts'
import { closeRehearsalSeeder, publishRehearsalBases, rehearsalDurableAcknowledged, rehearsalSeedFrontier } from './sync-cell-rehearsal.mjs'

const SERVER = process.env.SERVER ?? 'http://localhost:56002'
const DATABASE_URL = process.env.DATABASE_URL
const EMAIL = process.env.EMAIL ?? 'paul@summary.e2e.test'
const OBJECTS = envNumber('OBJECTS', { fallback: 12_000, minimum: 100, maximum: 200_000, integer: true })
const HEAD_OBJECTS = 10
const OUT = process.env.OUT ?? null
const RUN = process.env.RUN_ID ?? `tsum2-${Date.now()}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function record(event) {
  const line = JSON.stringify({ run: RUN, at: new Date().toISOString(), ...event })
  if (OUT) appendFileSync(OUT, `${line}\n`)
  return line
}

async function login() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${SERVER}/api/auth/dev-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL }),
    })
    if (response.ok) return response.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    await sleep(1_000)
  }
  throw new Error('dev-login failed')
}

async function call(cookie, path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${SERVER}${path}`, {
    method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  let parsed = null
  try { parsed = await response.json() } catch { /* not JSON */ }
  return { status: response.status, body: parsed }
}

async function waitFor(label, probe, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`${label}: not reached within ${timeoutMs} ms`)
}

const query = (workspace) => new URLSearchParams(workspace).toString()
const wsUrl = (workspace) => `${SERVER.replace(/^http/, 'ws')}/automerge?${query(workspace)}`

async function seed(cookie, workspace, rootUrl) {
  const adapter = new AuthenticatedWebSocketClientAdapter(wsUrl(workspace), cookie, 500)
  const repo = new Repo({ network: [adapter] })
  try {
    const root = (await resolveLoadHandle(repo, rootUrl)).handle.doc()
    const meta = (await resolveLoadHandle(repo, root.modelMetaUrl)).handle
    const headUrl = readMetaUrls(meta.doc(), 'objectShardUrls')?.[0]
    if (!headUrl) throw new Error('the new landscape has no object head')
    const head = (await resolveLoadHandle(repo, headUrl)).handle
    const headIds = Array.from({ length: HEAD_OBJECTS }, (_, index) => `${RUN}-head-${index}`)
    head.change((document) => {
      for (const id of headIds) objectMap(document)[id] = makeObject(id, { name: `T-SUM-2 ${id}` })
      appendOverlayBatchId(document, `${RUN}-seed`)
    })
    const background = Array.from({ length: OBJECTS - HEAD_OBJECTS }, (_, index) => `${RUN}-bg-${index}`)
    const publication = await publishRehearsalBases({
      repo, metaHandle: meta, head, workspace, backgroundIds: background,
      createObject: (id) => makeObject(id, { name: `T-SUM-2 ${id}` }),
      mint: async (count) => (await call(cookie, '/api/automerge/mint-document-ids', { ...workspace, count })).body,
      waitDurable: (documents) => waitFor('seed durable', async () => {
        const answer = (await call(cookie, `/api/automerge/durable-heads?${query(workspace)}`, { documents })).body
        return rehearsalDurableAcknowledged(documents, answer) ? answer : null
      }, 120_000),
    })
    const witnesses = { [headIds[0]]: { name: `T-SUM-2 ${headIds[0]}` }, [background.at(-1)]: { name: `T-SUM-2 ${background.at(-1)}` } }
    return { publication: { totalObjects: publication.totalObjects, baseShards: publication.baseShards.length }, witnesses, headFrontier: rehearsalSeedFrontier(head) }
  } finally {
    await closeRehearsalSeeder(repo, adapter)
  }
}

async function witness(cookie, workspace, ids) {
  const started = performance.now()
  const answer = await call(cookie, `/api/model/durability-witness?${query(workspace)}`, { objects: ids, connections: [] })
  return { ...answer, ms: performance.now() - started }
}

function fresh(answer, expected) {
  return answer.status === 200 && answer.body?.absenceProvable === true
    && Object.entries(expected).every(([id, fields]) => Object.entries(fields)
      .every(([field, value]) => answer.body.objects?.[id]?.[field] === value))
}

/** Per admitted document, which clause refuses it (diagnosis only). */
async function refusals(db, workspace) {
  const { rows } = await db.query(
    `SELECT dw.document_id, sd.kind, wm.projected_watermark::text AS wm, newest.max_seq::text AS max_seq,
            (newest.newest_at < p.last_projected_at) AS ts_covered
       FROM automerge_document_workspace dw
       LEFT JOIN read_model_projection_state p ON p.landscape_id = dw.landscape_id AND p.version_id = dw.version_id
       LEFT JOIN read_model_static_documents sd ON sd.landscape_id = dw.landscape_id AND sd.version_id = dw.version_id AND sd.document_id = dw.document_id
       LEFT JOIN LATERAL (SELECT max(s.updated_at) AS newest_at, max(s.arrival_seq) AS max_seq FROM automerge_storage s
         WHERE split_part(s.key, '/', 1) = dw.document_id AND split_part(s.key, '/', 2) <> 'sync-state') newest ON true
       LEFT JOIN read_model_document_watermarks wm ON wm.landscape_id = dw.landscape_id AND wm.version_id = dw.version_id AND wm.document_id = dw.document_id
      WHERE dw.landscape_id = $1 AND dw.version_id = $2
        AND NOT CASE WHEN wm.projected_watermark = 0 THEN false
                     WHEN newest.max_seq IS NOT NULL AND wm.projected_watermark IS NOT NULL THEN wm.projected_watermark >= newest.max_seq
                     ELSE COALESCE(newest.newest_at IS NULL OR newest.newest_at < p.last_projected_at, false) END`,
    [workspace.landscapeId, workspace.versionId],
  )
  return rows.map((row) => ({ id: row.document_id.slice(0, 8), kind: row.kind, wm: row.wm, maxSeq: row.max_seq, tsCovered: row.ts_covered }))
}

async function queueRow(db, workspace, documentId) {
  const { rows } = await db.query(
    `SELECT revision::int AS revision, projected_revision::int AS projected FROM read_model_static_document_queue
      WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`, [workspace.landscapeId, workspace.versionId, documentId])
  const { rows: state } = await db.query(
    `SELECT projected_generation::int AS generation FROM read_model_projection_state WHERE landscape_id = $1 AND version_id = $2`,
    [workspace.landscapeId, workspace.versionId])
  const { rows: mark } = await db.query(
    `SELECT projected_watermark::text AS wm FROM read_model_document_watermarks WHERE landscape_id = $1 AND version_id = $2 AND document_id = $3`,
    [workspace.landscapeId, workspace.versionId, documentId])
  return { queue: rows[0] ?? null, generation: state[0]?.generation ?? null, headWatermark: mark[0]?.wm ?? null }
}

/** Poll the witness until `done(answer)` or the deadline; one record per poll. */
async function poll(phase, { cookie, db, workspace, ids, headId, done, timeoutMs, intervalMs = 100, origin }) {
  const deadline = performance.now() + timeoutMs
  const passes = new Set()
  let polls = 0
  let first = null
  while (performance.now() < deadline) {
    const answer = await witness(cookie, workspace, ids)
    const sample = headId ? await queueRow(db, workspace, headId) : {}
    if (sample.queue) passes.add(sample.queue.projected)
    polls += 1
    const ok = done(answer)
    const row = { phase, sinceMs: Math.round(performance.now() - origin), status: answer.status,
      absenceProvable: answer.body?.absenceProvable ?? null, caughtUp: answer.body?.caughtUp ?? null,
      freshness: answer.body?.status ?? null, generation: sample.generation ?? null, queue: sample.queue ?? null,
      headWatermark: sample.headWatermark ?? null, ok }
    if (!ok && polls % 10 === 1) row.refusing = await refusals(db, workspace)
    record(row)
    if (ok) { first = row; break }
    await sleep(intervalMs)
  }
  return { first, polls, projectedRevisionsSeen: [...passes] }
}

async function editHead(cookie, workspace, rootUrl, field, mutate) {
  const adapter = new AuthenticatedWebSocketClientAdapter(wsUrl(workspace), cookie, 500)
  const repo = new Repo({ network: [adapter] })
  try {
    const root = (await resolveLoadHandle(repo, rootUrl)).handle.doc()
    const meta = (await resolveLoadHandle(repo, root.modelMetaUrl)).handle.doc()
    const headUrl = readMetaUrl(meta, field)
    if (!headUrl) throw new Error(`ModelMeta names no ${field}`)
    const head = (await resolveLoadHandle(repo, headUrl)).handle
    head.change(mutate)
    const appliedAt = performance.now()
    await repo.flush([head.documentId])
    // Hold the socket until the server has the change durably.
    const frontier = rehearsalSeedFrontier(head)
    await waitFor('edit durable', async () => {
      const answer = (await call(cookie, `/api/automerge/durable-heads?${query(workspace)}`, { documents: [frontier] })).body
      return rehearsalDurableAcknowledged([frontier], answer) ? answer : null
    }, 30_000, 100)
    return { appliedAt, durableAfterMs: Math.round(performance.now() - appliedAt), headId: head.documentId }
  } finally {
    await closeRehearsalSeeder(repo, adapter)
  }
}

/** The PASS counter: one row per transaction that moves a queue row's
 * `projected_revision` (a static publish or acknowledgement), written by a
 * trigger on the measurement database only — the server is not modified. */
async function installPassLog(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS t_sum_2_pass_log (
    document_id text, from_revision bigint, to_revision bigint, revision bigint, tx bigint, at timestamptz DEFAULT clock_timestamp())`)
  await db.query(`CREATE OR REPLACE FUNCTION t_sum_2_pass_log_row() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.projected_revision IS DISTINCT FROM OLD.projected_revision THEN
        INSERT INTO t_sum_2_pass_log (document_id, from_revision, to_revision, revision, tx)
        VALUES (NEW.document_id, OLD.projected_revision, NEW.projected_revision, NEW.revision, txid_current());
      END IF;
      RETURN NEW;
    END $$`)
  await db.query('DROP TRIGGER IF EXISTS t_sum_2_pass_log ON read_model_static_document_queue')
  await db.query(`CREATE TRIGGER t_sum_2_pass_log AFTER UPDATE ON read_model_static_document_queue
    FOR EACH ROW EXECUTE FUNCTION t_sum_2_pass_log_row()`)
}

async function passesBetween(db, documentId, since, until) {
  const { rows } = await db.query(
    `SELECT from_revision::int AS "from", to_revision::int AS "to", revision::int AS revision, at
       FROM t_sum_2_pass_log WHERE document_id = $1 AND at > $2 AND at <= $3 ORDER BY at`, [documentId, since, until])
  return rows
}

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required')
  const db = new pg.Client({ connectionString: DATABASE_URL })
  await db.connect()
  await installPassLog(db)
  const result = { run: RUN, objects: OBJECTS }
  try {
    const cookie = await login()
    const created = await call(cookie, '/api/landscapes', { name: `T-SUM-2 ${RUN}` })
    const landscape = created.body?.landscape
    if (!landscape?.id || !landscape.defaultVersionId) throw new Error(`landscape creation: ${created.status} ${JSON.stringify(created.body)}`)
    const workspace = { landscapeId: landscape.id, versionId: landscape.defaultVersionId }
    result.workspace = workspace
    const rootUrl = (await waitFor('root', async () => (await call(cookie, `/api/automerge/root?${query(workspace)}`)).body?.url ?? null, 60_000))
    let started = performance.now()
    const seeded = await seed(cookie, workspace, rootUrl)
    result.seed = { ...seeded.publication, ms: Math.round(performance.now() - started) }
    started = performance.now()
    await waitFor('ordinary projection fresh at scale', async () => {
      const answer = await witness(cookie, workspace, Object.keys(seeded.witnesses))
      if (!fresh(answer, seeded.witnesses)) return null
      const { rows } = await db.query('SELECT count(*)::int AS n FROM ro_objects WHERE landscape_id = $1 AND version_id = $2', [workspace.landscapeId, workspace.versionId])
      return rows[0].n === OBJECTS ? rows[0].n : null
    }, 180_000, 500)
    result.ordinaryFreshMs = Math.round(performance.now() - started)

    started = performance.now()
    const reports = []
    await waitFor('promotion preconditions', async () => {
      const report = await call(cookie, '/api/platform/workspace/promote-summary', { ...workspace, apply: false })
      const blockers = (report.body?.blockers ?? []).map((blocker) => blocker.code)
      reports.push({ status: report.status, blockers })
      return report.status === 200 && blockers.length === 0 ? true : null
    }, 120_000, 1_000).catch(() => null)
    const applied = await call(cookie, '/api/platform/workspace/promote-summary', { ...workspace, apply: true })
    result.promotion = { status: applied.status, applied: Boolean(applied.body?.applied), blockers: applied.body?.blockers?.map((b) => b.code) ?? null,
      allowListSize: applied.body?.applied?.allowListSize ?? null, reports: reports.slice(-3), ms: Math.round(performance.now() - started) }
    if (!applied.body?.applied) throw new Error(`promotion not applied: ${applied.status} ${JSON.stringify(applied.body?.blockers ?? applied.body)}`)
    const { rows: staticRows } = await db.query('SELECT source FROM read_model_static_workspaces WHERE landscape_id = $1 AND version_id = $2', [workspace.landscapeId, workspace.versionId])
    result.staticSource = staticRows[0]?.source ?? null

    const promotedAt = performance.now()
    const afterPromotion = await poll('after-promotion', { cookie, db, workspace, ids: Object.keys(seeded.witnesses), done: (answer) => fresh(answer, seeded.witnesses),
      timeoutMs: 120_000, intervalMs: 250, origin: promotedAt })
    result.afterPromotion = { freshAfterMs: afterPromotion.first?.sinceMs ?? null, polls: afterPromotion.polls }

    // The overlay edit, then the first fresh answer that shows it.
    const [witnessId] = Object.keys(seeded.witnesses)
    const renamed = `T-SUM-2 renamed ${RUN}`
    const expected = { ...seeded.witnesses, [witnessId]: { name: renamed } }
    const dbNow = async () => (await db.query('SELECT clock_timestamp() AS now')).rows[0].now
    const editStartedDb = await dbNow()
    const edit = await editHead(cookie, workspace, rootUrl, 'editsObjectShardUrl', (document) => {
      objectMap(document)[witnessId] = makeObject(witnessId, { name: renamed })
      appendOverlayBatchId(document, `${RUN}-rename`)
    })
    const beforeQueue = await queueRow(db, workspace, edit.headId)
    const afterEdit = await poll('after-edit', { cookie, db, workspace, ids: Object.keys(expected), headId: edit.headId,
      done: (answer) => fresh(answer, expected), timeoutMs: 120_000, intervalMs: 100, origin: edit.appliedAt })
    const freshDb = await dbNow()
    // Passes of the head = transactions that moved its queue row, from the
    // edit to the first fresh answer (the trigger's log; censored runs count
    // to the deadline).
    const headPasses = await passesBetween(db, edit.headId, editStartedDb, freshDb)
    result.edit = { durableAfterMs: edit.durableAfterMs, freshAfterMs: afterEdit.first?.sinceMs ?? null, polls: afterEdit.polls,
      queueBefore: beforeQueue.queue, queueAtFresh: afterEdit.first?.queue ?? null,
      headPasses: headPasses.length, headPassLog: headPasses,
      projectedRevisionsSeen: afterEdit.projectedRevisionsSeen, generationAtFresh: afterEdit.first?.generation ?? null,
      generationBefore: beforeQueue.generation }

    // THE NEGATIVE PROBE: an arrival nothing projects.
    const { rows: chunks } = await db.query(
      `SELECT data FROM automerge_storage WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')
        ORDER BY split_part(key, '/', 2) DESC, key`, [edit.headId])
    let stored = A.init()
    for (const row of chunks) stored = A.loadIncremental(stored, row.data)
    const before = A.getHeads(stored)
    const probed = A.change(stored, (document) => { document.objects[witnessId].name = `T-SUM-2 raw probe ${RUN}` })
    const bytes = A.saveSince(probed, before)
    const hash = createHash('sha256').update(bytes).digest('hex')
    await db.query('INSERT INTO automerge_storage (key, data) VALUES ($1, $2)', [`${edit.headId}/incremental/${hash}`, Buffer.from(bytes)])
    const probeAt = performance.now()
    const quiet = await poll('raw-probe', { cookie, db, workspace, ids: Object.keys(expected), headId: edit.headId,
      done: (answer) => answer.body?.absenceProvable === true, timeoutMs: 20_000, intervalMs: 250, origin: probeAt })
    // Something ELSE publishes: a connection on the connection write head.
    const connectionId = `${RUN}-probe-connection`
    const other = await editHead(cookie, workspace, rootUrl, 'editsConnectionShardUrl', (document) => {
      if (!document.connections) document.connections = {}
      document.connections[connectionId] = { id: connectionId, fromId: witnessId, toId: Object.keys(seeded.witnesses)[1], label: 'T-SUM-2 probe' }
      appendOverlayBatchId(document, `${RUN}-probe-connection`)
    })
    const generationAtOther = (await queueRow(db, workspace, edit.headId)).generation
    const afterOther = await poll('raw-probe-after-other-publish', { cookie, db, workspace, ids: Object.keys(expected), headId: edit.headId,
      done: (answer) => answer.body?.absenceProvable === true, timeoutMs: 20_000, intervalMs: 250, origin: other.appliedAt })
    const generationEnd = (await queueRow(db, workspace, edit.headId)).generation
    result.probe = {
      provenWhileUnprojectedMs: quiet.first?.sinceMs ?? null, polls: quiet.polls,
      provenAfterOtherPublishMs: afterOther.first?.sinceMs ?? null, pollsAfterOther: afterOther.polls,
      generationAtOther, generationEnd, otherPublished: generationEnd !== null && generationAtOther !== null && generationEnd > generationAtOther,
    }
    result.verdict = {
      freshAfterEdit: result.edit.freshAfterMs !== null,
      lessThanTwoPasses: result.edit.headPasses !== null && result.edit.headPasses < 2,
      probeHeld: result.probe.provenWhileUnprojectedMs === null && result.probe.provenAfterOtherPublishMs === null,
      probeDiscriminates: result.probe.otherPublished,
    }
  } finally {
    console.log(`T_SUM_2_RESULT ${record({ phase: 'result', ...result })}`)
    await db.end()
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(`[t-sum-2] ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
