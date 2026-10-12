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
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { runPlacementProposer } from '../src/syncCells/placementProposerMain.ts'
import { placementProposerConfig } from '../src/syncCells/placementProposerConfig.ts'
import { proposerSchemaName } from '../src/syncCells/placementProposerSchema.ts'
import { PlacementProposerHealth } from '../src/syncCells/placementProposerHealth.ts'
import { ActivityWitness } from '../src/syncCells/activityWitness.ts'
import { createProposerJournal } from './placement-proposer-journal.mjs'
import { qualificationMicros } from './placement-proposer-qualification.mjs'

const LOSS_US = 310_000_000n, RESTART_AFTER_ADMISSION_US = 3_600_000_000n
const MAX_CREDIT_INTERVAL_US = 10_000_000n

/** Executes the real entry under its restricted pool. The separate owner pool
 * changes only synthetic claim coverage for the declared signal intervention.
 * The observation hooks forward unchanged arguments/results; they journal the
 * actual supplied frame and visible activity verdict, not fabricated samples. */
export async function runProposerSoakWorker(input) {
  assert.ok(['initial', 'continued', 'smoke'].includes(input.phase))
  const output = resolve(input.output), config = placementProposerConfig(input.env)
  assert.ok(config); assert.equal(input.schema, config.schema)
  const adminUrl = new URL(input.adminUrl)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname), 'local-bank-required')
  const readerUrl = new URL(input.env.SYNC_CELL_PLACEMENT_PROPOSER_DATABASE_URL)
  assert.equal(adminUrl.hostname, readerUrl.hostname, 'bank-host-mismatch')
  assert.equal(adminUrl.port || '5432', readerUrl.port || '5432', 'bank-port-mismatch')
  assert.equal(adminUrl.pathname, readerUrl.pathname, 'bank-database-mismatch')
  assert.equal(adminUrl.search + adminUrl.hash, '', 'bank-url-options-forbidden')
  const requiredCreditUs = input.phase === 'continued' ? qualificationMicros(input.requiredCreditUs) : 0n
  if (input.phase === 'continued') assert.ok(requiredCreditUs > 0n && requiredCreditUs <= 22_500_000_000n)
  const s = proposerSchemaName(config.schema), abort = new AbortController()
  const journal = createProposerJournal(join(output, 'events.jsonl'))
  let admin = null, timer = null, control = Promise.resolve(), controlBusy = false
  let failure = null, finalHealth = null, knownPasses = 0, firstAdmissionUs = null
  let signalState = 'known', lossAtUs = null, returnAtUs = null
  let passCount = 0, previousPassUs = null, creditedUs = 0n, activityCalls = 0
  let entryStarted = false, entryJoined = false, adminClosed = false, stoppedFor = null
  const originalSample = ActivityWitness.prototype.sample
  const originalObserve = PlacementProposerHealth.prototype.observe
  const fail = code => { failure ??= code; abort.abort() }
  const record = (kind, value) => {
    try { return journal.append(kind, value) }
    catch (error) { fail('journal-failed'); throw error }
  }
  const nowUs = () => BigInt(journal.monotonicUs())
  const claims = async () => (await admin.query(
    'SELECT to_jsonb(c) AS row FROM ' + s + '.workspace_claim_coverage c ORDER BY landscape_id,version_id')).rows.map(row => row.row)
  async function changeSignal(covered) {
    signalState = covered ? 'restoring' : 'losing'
    record('control-start', { kind: covered ? 'signal-return' : 'signal-loss' })
    const before = await claims()
    assert.equal(before.length, 6)
    const changed = await admin.query('UPDATE ' + s + '.workspace_claim_coverage SET covered=$1 RETURNING landscape_id,version_id,covered', [covered])
    assert.equal(changed.rowCount, 6)
    const after = await claims()
    const stamp = await admin.query("SELECT (extract(epoch FROM clock_timestamp()) * 1000000)::bigint::text AS at_us")
    const event = record('control-committed', { kind: covered ? 'signal-return' : 'signal-loss',
      before, after, changed: changed.rows, atUs: stamp.rows[0].at_us })
    signalState = covered ? 'restored' : 'lost'
    if (covered) returnAtUs = BigInt(event.monoUs)
    else lossAtUs = BigInt(event.monoUs)
  }
  const requestControl = covered => {
    if (controlBusy || abort.signal.aborted) return
    controlBusy = true
    control = changeSignal(covered).catch(() => fail('signal-control-failed'))
      .finally(() => { controlBusy = false })
  }
  const stop = reason => { stoppedFor ??= reason; abort.abort() }
  const signalStop = () => stop('external-signal')
  process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop)
  try {
    record('worker-start', { phase: input.phase, pid: process.pid, role: config.role, schema: config.schema,
      source: 'server/src/syncCells/placementProposerMain.ts', clock: 'native',
      lossDurationUs: LOSS_US.toString(), restartAfterAdmissionUs: RESTART_AFTER_ADMISSION_US.toString(),
      requiredCreditUs: requiredCreditUs.toString() })
    admin = new pg.Pool({ connectionString: input.adminUrl, max: 1,
      connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 })
    admin.on('error', () => fail('owner-pool-idle-error'))
    ActivityWitness.prototype.sample = async function (...args) {
      const call = ++activityCalls
      record('activity-start', { call, workspace: args[0] })
      try {
        const verdict = await Reflect.apply(originalSample, this, args)
        record('activity-result', { call, verdict })
        return verdict
      } catch (error) {
        record('activity-error', { call, code: 'sample-rejected' })
        throw error
      }
    }
    PlacementProposerHealth.prototype.observe = function (...args) {
      const result = Reflect.apply(originalObserve, this, args)
      record('observation', { frame: args[0], history: args[1],
        capturedMonoMs: args[2], queryAgeMs: args[3], frameCount: args[4] })
      return result
    }
    timer = setInterval(() => {
      try {
        if (abort.signal.aborted) return
        if (input.phase === 'initial' && signalState === 'lost' && nowUs() - lossAtUs >= LOSS_US) requestControl(true)
      } catch { fail('control-timer-failed') }
    }, 250)
    entryStarted = true
    await runPlacementProposer(input.env, abort.signal, value => {
      const event = record('entry', value)
      const at = BigInt(event.monoUs)
      if (value?.kind === 'proposer-health') {
        finalHealth = value
        if (value.state === 'proposing' && firstAdmissionUs === null) {
          firstAdmissionUs = at
          if (input.phase === 'initial' && signalState !== 'restored') fail('admission-before-signal-control')
        }
      }
      if (['observed', 'unknown'].includes(value?.kind)) {
        const unframed = value.atUs === undefined && value.censusCount === undefined
          && value.frames === undefined && Array.isArray(value.outcomes) && value.outcomes.length === 1
        if (unframed) previousPassUs = null
        else {
          passCount++
          if (previousPassUs !== null) {
            const gap = at - previousPassUs
            creditedUs += gap < MAX_CREDIT_INTERVAL_US ? gap : MAX_CREDIT_INTERVAL_US
          }
          previousPassUs = at
        }
        if (value.kind === 'observed' && value.atUs !== undefined) knownPasses++
        if (input.phase === 'initial' && knownPasses >= 3 && signalState === 'known') requestControl(false)
        if (input.phase === 'initial' && firstAdmissionUs !== null
          && at - firstAdmissionUs >= RESTART_AFTER_ADMISSION_US) stop('scheduled-restart')
        if (input.phase === 'smoke' && knownPasses >= 3) stop('smoke-complete')
        if (input.phase === 'continued' && creditedUs >= requiredCreditUs) stop('credit-target-reached')
      }
    })
    entryJoined = entryStarted
  } catch {
    // The main entry joins its own resources before its returned promise
    // rejects. Keep rejection as failure; do not publish raw PG/DSN errors.
    entryJoined = entryStarted
    fail('entry-or-instrument-failed')
  } finally {
    clearInterval(timer)
    abort.abort()
    try { await control }
    catch { fail('control-join-failed') }
    ActivityWitness.prototype.sample = originalSample
    PlacementProposerHealth.prototype.observe = originalObserve
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop)
    try { await admin?.end(); adminClosed = true }
    catch { fail('owner-pool-close-failed') }
  }
  let journalReceipt = null
  try {
    record('worker-finished', { phase: input.phase, pid: process.pid, entryStarted, entryJoined, adminClosed,
      finalState: finalHealth?.state ?? null, failure, stoppedFor })
  } catch {
    failure ??= 'journal-finalization-failed'
  }
  // Close exactly once, even after an append failure. A close/read failure
  // leaves no integrity receipt; never manufacture one from recoverable bytes.
  try { journalReceipt = journal.close() }
  catch { failure ??= 'journal-close-failed' }
  const expectedStop = { initial: 'scheduled-restart', continued: 'credit-target-reached', smoke: 'smoke-complete' }[input.phase]
  const complete = !failure && entryStarted && entryJoined && adminClosed && journalReceipt?.complete && journalReceipt.closed
    && finalHealth?.state === 'stopped' && stoppedFor === expectedStop
    && (input.phase !== 'initial' || (signalState === 'restored' && firstAdmissionUs !== null))
  const result = { complete: Boolean(complete), phase: input.phase, pid: process.pid, entryStarted, entryJoined, adminClosed, failure, stoppedFor,
    knownPasses, passCount, activityCalls, creditedUs: creditedUs.toString(),
    firstAdmissionUs: firstAdmissionUs?.toString() ?? null, lossAtUs: lossAtUs?.toString() ?? null,
    returnAtUs: returnAtUs?.toString() ?? null, finalHealth, journal: journalReceipt,
    instrumentation: 'Forwarding ActivityWitness.sample and Health.observe hooks record real arguments and results. Activity-result is the visible verdict, not an assertion that raw SQL finished at that instant.',
    clock: 'Native hrtime per child; no time or policy substitution. No credit between children.' }
  writeFileSync(join(output, 'worker-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 3, 'worker-input-required')
    const result = await runProposerSoakWorker(JSON.parse(readFileSync(process.argv[2], 'utf8')))
    process.stdout.write(JSON.stringify({ complete: result.complete, phase: result.phase,
      passCount: result.passCount, creditedUs: result.creditedUs, failure: result.failure }) + '\n')
    if (!result.complete) process.exitCode = 1
  } catch {
    process.stderr.write('placement-proposer-soak-worker: execution failed\n')
    process.exitCode = 1
  }
}
