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

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { placementProposerConfig } from '../src/syncCells/placementProposerConfig.ts'
import { guardIdleClientErrors } from '../src/db/poolErrorGuard.ts'
import { readPlacementProposerSnapshot } from '../src/syncCells/placementProposerSnapshot.ts'
import { auditPlacementProposerRole } from '../src/syncCells/placementProposerRole.ts'
import { proposerSchemaName } from '../src/syncCells/placementProposerSchema.ts'
import { captureDedicatedNative } from '../scripts/sync-cell-dedicated-native.mjs'
import { readProposerJournal } from './placement-proposer-journal.mjs'
import { creditProposerPasses } from './placement-proposer-qualification.mjs'
import { PROPOSER_AUTHORITY_TABLES, evaluateProposerCampaign } from './placement-proposer-campaign.mjs'
import { copyProposerSources, loadProposerCampaign, proposerArtifactPath, proposerSha256,
  proposerSourcePins, writeProposerArtifact } from './placement-proposer-artifacts.mjs'

const TARGET_CREDIT_US = 22_500_000_000n // 6 h 15, separate from the fixed six-hour minimum oracle.
const root = resolve(import.meta.dirname, '../..')
const successful = result => result.receipt.closed && result.receipt.rootExited && result.receipt.cleanupConfirmed
  && result.receipt.code === 0 && !result.receipt.timedOut && !result.receipt.aborted
  && !result.receipt.spawnError && !result.receipt.captureError && !result.receipt.captureDetached
  && !result.receipt.signal && result.receipt.cleanupIssues.length === 0

/** A dedicated synthetic DB must have been inventoried and created by the
 * operator first. This runner creates one unpredictable, new fixture schema;
 * it preserves it after successful preparation for independent verification.
 * The existing fixture attempts cleanup on preparation failure, before native
 * measurement. Later cleanup is separately admitted, never a finally deletion. */
export async function runProposerSoak(input) {
  assert.ok(['smoke', 'long'].includes(input.mode), 'invalid-soak-mode')
  const url = new URL(input.adminUrl)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && /^\/maplespire_t14f_[a-z0-9_]+$/.test(url.pathname) && url.search + url.hash === '', 'dedicated-local-bank-required')
  const npmCli = input.npmCli ?? process.env.npm_execpath
  assert.ok(npmCli, 'npm-cli-required-for-pre-hook')
  const output = resolve(input.output)
  mkdirSync(output) // A new output directory; no existing campaign is reused.
  const origin = process.hrtime.bigint(), monoUs = () => ((process.hrtime.bigint() - origin) / 1000n).toString()
  const manifest = { artifactProtocol: 1, facts: { protocol: 1, mode: input.mode,
    complete: false, parentPoolsClosed: false, role: null, schema: null, roleAudit: null, denials: [],
    preparation: { history: 'seven-hours-seeded-not-elapsed', population: 'six-synthetic-active-versions-four-landscapes-two-partitions',
      resource: input.resource ?? null }, failure: null }, snapshots: [], segments: [] }
  let fixture = null, completed = false, failure = null
  const abort = new AbortController(), stop = () => { failure ??= 'supervisor-aborted'; abort.abort() }
  const put = (name, value) => writeProposerArtifact(output, name, value)
  const descriptor = name => {
    const bytes = readFileSync(proposerArtifactPath(output, name, { existing: true }))
    return { path: name, bytes: bytes.length, sha256: proposerSha256(bytes) }
  }
  const beforePins = proposerSourcePins(root)
  manifest.sourceBefore = put('sources-before.json', beforePins)
  manifest.sourceCopies = copyProposerSources(root, output, beforePins)
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const hook = await captureDedicatedNative(process.execPath, [resolve(npmCli), 'run', 'preplacement:propose'],
      { cwd: resolve(root, 'server'), env: process.env, signal: abort.signal, timeoutMs: 60_000 })
    manifest.preHook = put('pre-hook.json', hook)
    assert.ok(successful(hook), 'pre-hook-failed')
    const name = 't14f_' + randomBytes(8).toString('hex')
    const loader = pathToFileURL(resolve(root, 'server/node_modules/tsx/dist/loader.mjs')).href
    manifest.facts.preparation.schemaRequested = 'test_' + name
    manifest.facts.preparation.failureCleanup = 'Shared fixture attempts DROP OWNED/ROLE/SCHEMA only if preparation fails; no native campaign has started then.'
    put('preparation.json', manifest.facts.preparation)
    const setupInput = put('private/setup.json', { name, adminUrl: input.adminUrl, output })
    const setup = await captureDedicatedNative(process.execPath,
      ['--import', loader, resolve(root, 'server/qa/placement-proposer-soak-setup.mjs'), resolve(output, setupInput.path)],
      { cwd: resolve(root, 'server'), env: process.env, signal: abort.signal, timeoutMs: 60_000 })
    manifest.setup = put('setup-native.json', setup)
    assert.ok(successful(setup), 'fixture-preparation-failed')
    const prepared = JSON.parse(readFileSync(resolve(output, 'private/fixture.json'), 'utf8'))
    const config = placementProposerConfig(prepared.env)
    assert.ok(config && config.schema === 'test_' + name && config.role === prepared.role, 'prepared-fixture-disagrees')
    const readerUrl = new URL(prepared.env.SYNC_CELL_PLACEMENT_PROPOSER_DATABASE_URL)
    assert.deepEqual([readerUrl.hostname, readerUrl.port || '5432', readerUrl.pathname],
      [url.hostname, url.port || '5432', url.pathname], 'prepared-bank-disagrees')
    fixture = { env: prepared.env, config, reader: null, db: { schema: config.schema, pool: null } }
    fixture.reader = guardIdleClientErrors(new pg.Pool({ ...config.pool, query_timeout: 6000 }), 't14f-supervisor-reader', stop)
    fixture.reader.on('error', stop)
    fixture.db.pool = openProposerSoakOwnerPool(input.adminUrl, fixture.config, stop)
    manifest.facts.role = fixture.config.role; manifest.facts.schema = fixture.db.schema
    assert.ok(!abort.signal.aborted, 'supervisor-aborted-before-sql')
    manifest.facts.roleAudit = await auditPlacementProposerRole(fixture.reader, fixture.db.schema, fixture.config.role)
    assert.ok(!abort.signal.aborted, 'supervisor-aborted-after-audit')
    manifest.facts.denials = await verifyDenials(fixture)
    assert.ok(!abort.signal.aborted, 'supervisor-aborted-after-denials')
    manifest.snapshots.push(put('sql-before.json', await snapshot(fixture, monoUs)))
    async function runSegment(phase, requiredCreditUs = '0') {
      assert.ok(!abort.signal.aborted, 'supervisor-aborted-before-segment')
      const directory = resolve(output, phase)
      mkdirSync(directory)
      const workerInput = put('private/' + phase + '.json', { phase, output: directory,
        adminUrl: input.adminUrl, env: fixture.env, schema: fixture.db.schema, requiredCreditUs })
      const run = await captureDedicatedNative(process.execPath,
        ['--import', loader, resolve(root, 'server/qa/placement-proposer-soak-worker.mjs'), resolve(output, workerInput.path)],
        { cwd: resolve(root, 'server'), env: process.env, signal: abort.signal,
          timeoutMs: phase === 'smoke' ? 60_000 : phase === 'initial' ? 90 * 60_000 : 8 * 60 * 60_000 })
      const segment = { phase, native: put(phase + '/native.json', run),
        worker: null, journal: phase + '/events.jsonl' }
      manifest.segments.push(segment)
      assert.ok(successful(run), 'native-worker-failed')
      segment.worker = descriptor(phase + '/worker-result.json')
      const worker = JSON.parse(readFileSync(resolve(output, segment.worker.path), 'utf8'))
      assert.ok(worker.complete, 'worker-report-incomplete')
      const records = readProposerJournal(resolve(output, segment.journal), worker.journal)
      const credit = creditProposerPasses(records)
      assert.ok(credit.pass, 'worker-credit-invalid')
      assert.equal(credit.creditedUs, worker.creditedUs, 'worker-credit-disagrees')
      return credit
    }
    const first = await runSegment(input.mode === 'long' ? 'initial' : 'smoke')
    assert.ok(!abort.signal.aborted, 'supervisor-aborted-after-first-segment')
    manifest.snapshots.push(put('sql-after-first.json', await snapshot(fixture, monoUs)))
    if (input.mode === 'long') {
      const remaining = TARGET_CREDIT_US - BigInt(first.creditedUs)
      assert.ok(remaining > 0n, 'initial-segment-exceeded-target')
      await runSegment('continued', remaining.toString())
      assert.ok(!abort.signal.aborted, 'supervisor-aborted-after-restart')
      manifest.snapshots.push(put('sql-after-restart.json', await snapshot(fixture, monoUs)))
    }
    completed = true
  } catch {
    failure ??= 'campaign-preparation-or-execution-failed'
  } finally {
    if (fixture) {
      // Owned parent pools only. Even an unconfirmed child must not trigger
      // DROP ROLE/SCHEMA or removal of the bank that could explain its state.
      let readerClosed = false, ownerClosed = false
      try { await fixture.reader?.end(); readerClosed = true }
      catch { failure ??= 'parent-reader-close-failed' }
      try { await fixture.db.pool?.end(); ownerClosed = true }
      catch { failure ??= 'parent-owner-close-failed' }
      manifest.facts.parentPoolsClosed = readerClosed && ownerClosed
    }
    try {
      const afterPins = proposerSourcePins(root)
      manifest.sourceAfter = put('sources-after.json', afterPins)
      assert.deepEqual(afterPins, beforePins)
    } catch { failure ??= 'candidate-changed-or-source-archive-failed' }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
    manifest.facts.failure = failure
    manifest.facts.complete = completed && !failure && manifest.facts.parentPoolsClosed
    manifest.facts.completedAt = new Date().toISOString()
  }
  const publicManifest = put('campaign.json', manifest)
  let qualification = null
  if (manifest.facts.complete && input.mode === 'long') {
    const loaded = loadProposerCampaign(output, publicManifest.sha256)
    qualification = evaluateProposerCampaign(loaded.campaign)
    put('qualification.json', { ...qualification, manifestSha256: loaded.manifestSha256, sourceFileCount: loaded.sourceFileCount })
  }
  return { complete: manifest.facts.complete, mode: input.mode, manifestSha256: publicManifest.sha256,
    qualification, scope: input.mode === 'smoke' ? 'native three-pass smoke only; no six-hour qualification' : 'native campaign', failure }
}

async function verifyDenials(fixture) {
  const client = await fixture.reader.connect(), s = proposerSchemaName(fixture.db.schema)
  let destroy = false
  const outcomes = []
  try {
    for (const [operation, sql] of [
      ['placement-update', 'UPDATE ' + s + '.workspace_placement SET partition=partition WHERE false'],
      ['ownership-update', 'UPDATE ' + s + '.sync_workspace_ownership SET cell_id=cell_id WHERE false'],
      ['proposal-truncate', 'TRUNCATE ' + s + '.sync_placement_proposals'],
    ]) {
      let code = 'accepted'
      await client.query('BEGIN')
      try { await client.query(sql) }
      catch (error) { code = error?.code === '42501' ? '42501' : 'unexpected-rejection' }
      finally {
        try { await client.query('ROLLBACK') }
        catch { destroy = true; throw new Error('denial-rollback-failed') }
      }
      outcomes.push({ operation, code })
      assert.equal(code, '42501', 'restricted-login-write-not-denied')
    }
  } finally { client.release(destroy) }
  return outcomes
}

export function openProposerSoakOwnerPool(adminUrl, config, stop) {
  // pg_get_triggerdef renders function names through search_path. Read-only
  // anchors use the LOGIN context; fixture DDL keeps its own migration context.
  const pool = guardIdleClientErrors(new pg.Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 6000, idle_in_transaction_session_timeout: 5000,
    options: config.pool.options }), 't14f-supervisor-owner', stop)
  pool.on('error', stop)
  return pool
}

export async function snapshot(fixture, monoUs) {
  const client = await fixture.db.pool.connect(), s = proposerSchemaName(fixture.db.schema)
  let transaction = false, destroy = false
  try {
    transaction = true
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const authority = {}, counts = {}
    for (const table of PROPOSER_AUTHORITY_TABLES) {
      const order = table === 'workspace_claim_coverage' ? 't.landscape_id,t.version_id' : 'to_jsonb(t)::text'
      authority[table] = (await client.query('SELECT to_jsonb(t) AS row FROM ' + s + '.' + table + ' t ORDER BY ' + order)).rows.map(row => row.row)
      counts[table] = (await client.query('SELECT count(*)::text AS n FROM ' + s + '.' + table)).rows[0].n
    }
    const proposals = (await client.query('SELECT proposal_id::text,landscape_id,'
      + '(extract(epoch FROM proposed_at)*1000000)::bigint::text AS at_us,payload FROM '
      + s + '.sync_placement_proposals ORDER BY proposed_at,proposal_id')).rows
    counts.sync_placement_proposals = (await client.query('SELECT count(*)::text AS n FROM ' + s + '.sync_placement_proposals')).rows[0].n
    const observation = await readPlacementProposerSnapshot(client, fixture.db.schema)
    for (const name of ['proposalCoverage', 'movementCoverage']) {
      const coverage = observation.history[name]
      assert.ok(coverage && typeof coverage.origin === 'string' && coverage.origin.length > 0
        && typeof coverage.fromBeginning === 'boolean', 'snapshot-history-coverage-missing:' + name)
      assert.ok(coverage.throughUs === observation.atUs && coverage.fromUs >= 0n
        && coverage.fromUs <= observation.atUs - 21_600_000_000n, 'snapshot-history-coverage-too-short:' + name)
    }
    const atUs = (await client.query('SELECT (extract(epoch FROM clock_timestamp())*1000000)::bigint::text AS at_us')).rows[0].at_us
    await client.query('COMMIT'); transaction = false
    return { atUs, parentMonoUs: monoUs(), authority, counts, proposals,
      movements: authority.sync_workspace_placement_moves, observation }
  } finally {
    try { if (transaction) await client.query('ROLLBACK') }
    catch { destroy = true; throw new Error('snapshot-rollback-failed') }
    finally { client.release(destroy) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 3, 'one-private-input-file-required')
    const result = await runProposerSoak(JSON.parse(readFileSync(process.argv[2], 'utf8')))
    const qualification = result.qualification ? { pass: result.qualification.pass,
      status: result.qualification.status, reasons: result.qualification.reasons,
      creditedUs: result.qualification.creditedUs, proposalCount: result.qualification.temporal?.proposalCount } : null
    process.stdout.write(JSON.stringify({ ...result, qualification }) + '\n')
    if (!result.complete || (result.mode === 'long' && !result.qualification?.pass)) process.exitCode = 1
  } catch {
    process.stderr.write('placement-proposer-soak: execution or artifact verification failed\n')
    process.exitCode = 1
  }
}
