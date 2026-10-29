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
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { untilAdmitted } from './fixtures/real-time-void.mjs'

const gate = fileURLToPath(new URL('./verify-sync-cell-failover.mjs', import.meta.url))
const preload = new URL('./fixtures/sync-cell-redis-pause-gate-preload.mjs', import.meta.url).href
// An arm that must reach the pause is VOID when the host starved the gate's
// real-time admissions (fixtures/real-time-void.mjs); measured alone, these
// children took 2.3-4.7 s, so the 15 s ceiling below is not what flakes.
async function admitted(t, mode) {
  return untilAdmitted(t, mode, async () => {
    const outcome = await run(mode)
    const { baseline, pauseAdmission } = outcome.observation.summary
    if (baseline?.valid === false) return { void: baseline.issues, value: outcome }
    const admissionExpected = mode.startsWith('witness-') && mode !== 'witness-refused'
    return { void: admissionExpected && pauseAdmission?.valid === false ? pauseAdmission.issues : null, value: outcome }
  })
}
async function run(mode) {
  const directory = await mkdtemp(join(tmpdir(), 'maplespire-gate-baseline-'))
  const reportPath = join(directory, 'fixture.json')
  const observationPath = join(directory, 'observation.json')
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  try {
    const child = spawn(process.execPath, ['--import', preload, gate, '--redis-outage',
      '--observe-out', observationPath, '--observe-sample-ms', '50',
      '--observe-engine-host', 'unix:///qa-no-docker.sock', '--observe-clock-calibration',
      ...(mode.startsWith('witness-') ? ['--observe-redis-witness-network', 'qa-gate-network'] : []),
      '--qa-fixture-mode', mode, '--qa-fixture-report', reportPath,
    ], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 15_000)
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    }).finally(() => clearTimeout(timer))
    assert.equal(timedOut, false, `gate fixture timed out: ${stderr}`)
    assert.equal(exit.signal, null, stderr)
    assert.equal(exit.code, 1, stderr)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    const observation = JSON.parse(await readFile(observationPath, 'utf8').catch(error => {
      assert.fail(`missing observation: ${error.message}; gate error: ${report.error}`)
    }))
    assert.equal(report.serversClosed, true)
    assert.equal(report.socketCount, 0, report.error)
    assert.equal(report.paused, false)
    assert.ok(report.requests.some(request => request.source === 'websocket' && request.authenticated === false))
    assert.ok(report.requests.some(request => request.source === 'websocket' && request.authenticated === true))
    assert.ok(observation.samples.length >= 10, 'must exercise a real baseline, not fail before sampling')
    assert.doesNotMatch(stdout, /"outcome":"passed"/)
    assert.doesNotMatch(JSON.stringify(observation), /synthetic-do-not-publish/)
    return { report, observation, stdout, stderr }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('real gate refuses a clock step during baseline before ANY Redis pause or cleanup unpause', async () => {
  const { report, observation } = await run('clock-step')
  assert.match(report.error, /baseline refused before Redis pause/)
  assert.ok(observation.summary.baseline, 'gate must execute and retain the baseline admission')
  assert.equal(observation.summary.baseline.valid, false)
  assert.equal(observation.summary.measurementValid, false)
  assert.ok(observation.summary.baseline.issues.some(issue => /wall clock differs from monotonic/.test(issue)))
  assert.deepEqual(report.commands.filter(command => command.method === 'POST'), [])
  assert.deepEqual(report.commands.filter(command => ['pause', 'unpause'].includes(command.args?.[0])), [])
})

test('same real gate reaches pause on a healthy baseline and releases an uncertain acquired pause by pinned ID', async t => {
  const { report, observation } = await admitted(t, 'healthy')
  assert.ok(observation.summary.baseline, 'gate must execute and retain the baseline admission')
  assert.equal(observation.summary.baseline.valid, true)
  assert.doesNotMatch(report.error, /baseline refused/)
  assert.match(report.error, /returned HTTP 500, expected 204/)
  const post = report.commands.filter(command => command.method === 'POST')
  assert.deepEqual(post.map(command => command.path), [
    `/v1.40/containers/${'c'.repeat(64)}/pause`,
    `/v1.40/containers/${'c'.repeat(64)}/unpause`,
  ])
  assert.ok(report.commands.some(command => command.args?.[2] === '{{.State.Paused}}' && command.args.at(-1) === 'c'.repeat(64)))
})

function assertWitnessExecuted(report, observation) {
  assert.equal(report.redisConnections, 1, 'actual TCP witness must run; a lost CLI option cannot pass')
  assert.ok(report.redisRequests >= 2, 'healthy control needs real nonce exchanges')
  assert.equal(observation.summary.baseline.valid, true)
  assert.deepEqual(observation.summary.pauseAdmission, {
    valid: true, clockValid: true, witnessValid: true, issues: [],
  })
  assert.equal(observation.freezeWitness.target.ip, '127.0.0.77')
  assert.equal(observation.freezeWitness.target.port, 6379)
  assert.equal(observation.freezeWitness.target.networkName, 'qa-gate-network')
  assert.equal(observation.freezeWitness.cleanup.cleanupConfirmed, true)
  assert.equal(observation.freezeWitness.cleanup.pendingRequests, 0)
  assert.equal(observation.freezeWitness.cleanup.activeTimers, 0)
  const posts = report.commands.filter(command => command.method === 'POST')
  assert.deepEqual(posts.map(command => command.path), [
    `/v1.40/containers/${'c'.repeat(64)}/pause`,
    `/v1.40/containers/${'c'.repeat(64)}/unpause`,
  ])
  const cutoff = report.events.find(event => event.kind === 'seal-clock')
  const release = report.events.find(event => event.kind === 'unpause-post')
  assert.ok(cutoff && release && cutoff.ordinal < release.ordinal, 'cutoff must precede the real release request')
  assert.ok(observation.freezeWitness.marks.sealed, 'cutoff must also survive in the raw artifact')
  assert.equal(observation.summary.measurementValid, false, 'these targeted arms deliberately interrupt qualification')
}

test('real gate refuses only the RESP witness on a valid clock, without acquiring pause or cleanup', async t => {
  const { report, observation } = await admitted(t, 'witness-refused')
  assert.equal(report.redisConnections, 1)
  assert.ok(report.redisRequests >= 1, 'must actually deliver the malformed nonce echo')
  assert.match(report.error, /pause admission refused before Redis pause/)
  assert.equal(observation.summary.baseline.valid, true)
  assert.equal(observation.summary.pauseAdmission.clockValid, true)
  assert.equal(observation.summary.pauseAdmission.witnessValid, false)
  assert.equal(observation.summary.pauseAdmission.valid, false)
  assert.ok(observation.freezeWitness.transportIssues.includes('response-framing-invalid'))
  assert.equal(observation.freezeWitness.cleanup.cleanupConfirmed, true)
  for (const mark of ['pauseStartedAtMs', 'pausedAtMs', 'unpauseStartedAtMs', 'unpausedAtMs']) {
    assert.equal(observation.summary[mark], null, `${mark} must remain strictly null`)
  }
  assert.deepEqual(report.commands.filter(command => command.method === 'POST'), [])
  assert.deepEqual(report.commands.filter(command => ['pause', 'unpause'].includes(command.args?.[0])), [])
})

test('real gate seals an uncertain pause before release and actually receives but excludes its late echo', async t => {
  const { report, observation } = await admitted(t, 'witness-uncertain')
  assertWitnessExecuted(report, observation)
  assert.match(report.error, /returned HTTP 500, expected 204/)
  assert.equal(observation.freezeWitness.marks.pauseAcknowledged, null)
  assert.equal(observation.summary.unpauseStartedAtMs, null, 'uncertain ACK never enters the marker branch')
  const late = observation.freezeWitness.records.filter(record => record.outcome === 'matched'
    && record.responseAt.ordinal > observation.freezeWitness.marks.sealed.ordinal)
  assert.equal(late.length, 1, 'the late response must reach the real witness handler, not merely be sent')
  assert.equal(late[0].admittedBeforeSeal, false)
  assert.ok(!observation.summary.freezeWitness.qualifiedRecordIds.includes(late[0].id))
})

test('real gate with a successful ACK releases even when its unpause marker clock throws after cutoff', async t => {
  const { report, observation } = await admitted(t, 'witness-marker-error')
  assertWitnessExecuted(report, observation)
  assert.equal(report.markerThrew, true, 'must execute the ACK-dependent marker failure')
  assert.match(report.error, /qa-unpause-marker-clock-failed/)
  assert.ok(observation.freezeWitness.marks.pauseAcknowledged)
  assert.equal(observation.summary.unpauseStartedAtMs, null)
  const cutoff = report.events.find(event => event.kind === 'seal-clock')
  const marker = report.events.find(event => event.kind === 'unpause-marker-throws')
  const release = report.events.find(event => event.kind === 'unpause-post')
  assert.ok(cutoff.ordinal < marker.ordinal && marker.ordinal < release.ordinal)
})

test('real gate preserves a final pinned-ID inspection failure as witness INVALID after releasing its pause', async t => {
  const { report, observation } = await admitted(t, 'witness-identity-error')
  assertWitnessExecuted(report, observation)
  assert.ok(report.commands.some(command => command.method === 'GET'
    && command.path === `/v1.40/containers/${'c'.repeat(64)}/json`))
  assert.equal(observation.summary.freezeWitness.identity.valid, false)
  assert.equal(observation.summary.freezeWitness.verdict, 'INVALID')
  assert.ok(observation.summary.measurementIssues.some(issue => /final identity is unverified/.test(issue)))
})

test('real gate awaits the actual witness close event before final inspection, synchronous logs and report', async t => {
  const { report, observation } = await admitted(t, 'witness-close-held')
  assertWitnessExecuted(report, observation)
  const held = report.events.find(event => event.kind === 'witness-close-held')
  const closed = report.events.find(event => event.kind === 'witness-close-delivered')
  const identity = report.events.find(event => event.kind === 'identity-final')
  const logs = report.events.filter(event => event.kind === 'logs')
  assert.ok(held && closed && identity && logs.length === 2)
  assert.ok(held.ordinal < closed.ordinal && closed.ordinal < identity.ordinal)
  assert.ok(logs.every(event => event.ordinal > closed.ordinal), 'sync logs must not run while close is held')
})
