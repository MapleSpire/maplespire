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
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureDedicatedNative } from './sync-cell-dedicated-native.mjs'
import { assertTopologyBuild } from './sync-bench-posture.mjs'
import { freshnessIdentityValid, isFreshWitness } from './sync-cell-rehearsal.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const empty = census => census && ['containers', 'volumes', 'networks'].every(key => Array.isArray(census[key]) && census[key].length === 0)
const assertImage = image => assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'calibration image missing')
export function calibrationHostHashes() {
  return Object.fromEntries(['sync-cell-bench.mjs', 'sync-cell-calibration.mjs', 'verify-sync-cell-calibration.mjs',
    'verify-sync-cell-load-soak.mjs', 'sync-cell-rehearsal.mjs', 'sync-bench-posture.mjs',
    '../qa/authenticatedWebSocketAdapter.mjs', '../qa/loadUsersCore.mjs', '../qa/loadBarrier.mjs',
    '../qa/load-users.mjs', '../qa/lib.mjs', '../qa/load-user-worker.mjs',
    '../qa/loadUserCohort.mjs', '../qa/loadUserSnapshots.mjs', '../qa/loadUserEvidence.mjs']
    .map(name => [name, sha256(readFileSync(resolve(here, name)))]))
}

/** Project labels, with full identities. No global prune and no teardown of a
 * pre-existing project. The runner's random project is owned only after this
 * census is empty and its own up has been attempted. */
export function calibrationProjectCensus(project, env, watchedVolumes = [], exec = execFileSync) {
  assert.match(project, /^[a-z0-9][a-z0-9_-]{0,62}$/)
  const invoke = args => String(exec('docker', args, { env, encoding: 'utf8', timeout: 15_000, windowsHide: true }))
    .trim().split(/\s+/).filter(Boolean).sort()
  const label = `label=com.docker.compose.project=${project}`
  const containers = invoke(['ps', '-aq', '--no-trunc', '--filter', label])
  const mountedVolumes = containers.flatMap(id => JSON.parse(exec('docker', ['inspect', id, '--format', '{{json .Mounts}}'],
    { env, encoding: 'utf8', timeout: 15_000, windowsHide: true })).filter(mount => mount.Type === 'volume').map(mount => mount.Name))
  const allVolumeNames = watchedVolumes.length ? new Set(invoke(['volume', 'ls', '-q'])) : new Set()
  return {
    containers, mountedVolumes: [...new Set(mountedVolumes)].sort(),
    volumes: [...new Set([...invoke(['volume', 'ls', '-q', '--filter', label]), ...watchedVolumes.filter(name => allVolumeNames.has(name))])].sort(),
    networks: invoke(['network', 'ls', '--format', '{{.Name}}', '--filter', label]),
  }
}

export function assertCalibrationMeasurement(measurement) {
  assert.equal(measurement?.emptyDatabase?.objects, 0, 'calibration database was not empty')
  assert.equal(measurement.emptyDatabase.staticWorkspaces, 0)
  assert.equal(measurement.seededDatabase?.objects, 5, 'calibration must have five objects globally')
  assert.equal(measurement.seededDatabase.staticWorkspaces, 0)
  assert.equal(measurement.before?.length, 3)
  assert.ok(measurement.before.every(row => row.stats?.transport?.connections?.active === 0), 'calibration has active clients')
  const { freshness, takeover } = measurement
  assert.equal(takeover?.verified, true)
  assert.ok(takeover.originalService !== takeover.replacementService)
  assert.ok(Number.isFinite(takeover.unpauseCompletedAt), 'calibration owner was not unpaused')
  assert.equal(freshness?.valid, true, 'invalid calibration freshness')
  assert.equal(freshness.origin, 'replacement ready response completedAt')
  assert.equal(freshness.completedAt, takeover.completedAt)
  assert.equal(freshness.seed?.totalObjects, 5)
  assert.equal(freshness.seed.inventory?.objects, 5)
  assert.equal(freshness.inventory?.objects, 5)
  assert.equal(freshness.inventory.staticWorkspaces, 0)
  assert.ok(freshness.inventory.projectorInstanceId && freshness.inventory.projectorInstanceId !== freshness.seed.inventory.projectorInstanceId)
  const closure = freshness.seed.seederClosure
  assert.ok(Number.isFinite(closure?.completedAt) && closure.completedAt >= closure.requestedAt
    && (closure.alreadyClosed === true || Number.isFinite(closure.closeObservedAt)), 'calibration seeder closure is missing')
  assert.equal(freshness.before?.fleet?.residentProjectors, 0)
  assert.equal(freshness.before?.fleet?.inFlightWorkspaces, 0)
  assert.ok(freshnessIdentityValid(freshness.before, freshness.after,
    { service: takeover.replacementService, state: takeover.replacementState }, measurement.topologyBuild?.expectedTopology))
  assert.ok(Number.isFinite(freshness.freshAfterTakeoverMs) && freshness.freshAfterTakeoverMs >= 0
    && freshness.freshAfterTakeoverMs < 500, 'five-object calibration did not finish below 500 ms')
  const firstFresh = freshness.requests?.find(row => isFreshWitness(row, freshness.seed.workspace, freshness.seed.expectedObjects))
  assert.ok(firstFresh, 'no fresh response in calibration requests')
  assert.equal(firstFresh.freshAfterTakeoverMs, freshness.freshAfterTakeoverMs)
  assert.equal(firstFresh.receivedAt, freshness.firstFreshResponseAt)
  assertTopologyBuild(measurement.topologyBuild)
  assert.equal(measurement.topologyBuild.project, measurement.project)
  return freshness
}

/** The binding prevents accidental reuse of a previous result. It is local
 * provenance, not authentication against someone fabricating both the file
 * and its nonce. A new nonce is created by the runner, never inherited. */
export function assertCalibrationReceipt(record, { nonce, project, image, posture, topologyBuild, runningPosture }) {
  assert.match(nonce ?? '', /^[a-f0-9-]{36}$/)
  assert.equal(record?.nonce, nonce, 'calibration invocation differs')
  assert.equal(record.mainProject, project, 'calibration target project differs')
  assert.notEqual(record.project, project, 'calibration shared the load project')
  assertImage(image)
  assert.equal(record.image, image, 'calibration image differs')
  assert.equal(record.posture, posture, 'calibration posture differs')
  assert.equal(record.measurement?.project, record.project)
  assert.equal(record.measurement?.benchPosture, posture)
  assert.deepEqual(record.hostSources, calibrationHostHashes(), 'host calibration code changed')
  assert.deepEqual(record.measurement.hostSources, record.hostSources, 'calibration child host code differs')
  const native = record.native
  assert.ok(native?.closed && native.cleanupConfirmed && native.code === 0 && native.signal === null
    && !native.timedOut && !native.aborted && !native.spawnError && !native.captureError, 'calibration native child was not successful and joined')
  assert.ok(empty(record.cleanup?.remaining) && record.cleanup.downCompleted === true, 'calibration cleanup is incomplete')
  assert.ok(Number.isFinite(record.cleanup.completedAt) && record.cleanup.completedAt >= Date.parse(native.completedAt))
  const freshness = assertCalibrationMeasurement(record.measurement)
  const calibrationTopology = record.measurement.topologyBuild
  assert.ok(calibrationTopology.running.every(cell => cell.image === image))
  if (topologyBuild) {
    assertTopologyBuild(topologyBuild)
    assert.equal(topologyBuild.project, project)
    assert.deepEqual(calibrationTopology.targets, topologyBuild.targets)
    assert.equal(calibrationTopology.engineEndpoint, topologyBuild.engineEndpoint)
    assert.deepEqual(calibrationTopology.expectedTopology, topologyBuild.expectedTopology)
    assert.deepEqual(calibrationTopology.sources, topologyBuild.sources)
    assert.deepEqual(calibrationTopology.running[0].modules, topologyBuild.running[0].modules)
    const oldIds = new Set([...calibrationTopology.running, calibrationTopology.edge].map(cell => cell.id))
    assert.ok([...topologyBuild.running, topologyBuild.edge].every(cell => !oldIds.has(cell.id)
      && Date.parse(cell.startedAt) >= record.cleanup.completedAt), 'load stack must start after calibration cleanup')
    assert.ok(topologyBuild.running.every(cell => cell.image === image))
  }
  if (runningPosture) {
    const values = rows => rows.map(({ service, image: id, values }) => ({ service, image: id, values })).sort((a, b) => a.service.localeCompare(b.service))
    assert.deepEqual(values(record.runningPosture), values(runningPosture), 'running calibration posture differs')
  }
  return { ...freshness, takeover: record.measurement.takeover, dedicatedStage: record }
}

export function readCalibrationReceipt(binding, expected) {
  assert.ok(binding?.path && binding.sha256 && binding.nonce, 'G4 soak requires this invocation\'s dedicated calibration receipt')
  const bytes = readFileSync(binding.path)
  assert.equal(sha256(bytes), binding.sha256, 'calibration receipt bytes changed')
  return assertCalibrationReceipt(JSON.parse(bytes), { ...expected, nonce: binding.nonce })
}

/** Callbacks use the bench's already resolved Compose file and posture. Tests
 * drive this same lifetime, including failed up/child/log/down/census paths.
 * Every child is joined before teardown; logs can never skip teardown. */
export async function runIsolatedCalibrationStage({ env, image, posture, services, compose, inspectPosture,
  census = calibrationProjectCensus, capture = captureDedicatedNative, publish = record => console.log(`G47_CALIBRATION_STAGE ${JSON.stringify(record)}`) }) {
  assertImage(image)
  const nonce = randomUUID()
  const project = `${env.SYNC_FAILOVER_PROJECT.slice(0, 45)}-cal-${nonce.slice(0, 8)}`
  const childEnv = { ...env, SYNC_FAILOVER_PROJECT: project }
  const record = { nonce, project, mainProject: env.SYNC_FAILOVER_PROJECT, image, posture,
    hostSources: calibrationHostHashes(), startedAt: Date.now(), errors: [] }
  const directory = mkdtempSync(join(tmpdir(), 'maplespire-g47-cal-'))
  const measurementPath = join(directory, 'measurement.json')
  const receiptPath = join(directory, 'receipt.json')
  let owned = false
  let captureStarted = false
  let childJoined = false
  const dispose = () => {
    // Only our two known files; unexpected entries are retained and reported.
    for (const name of ['measurement.json', 'receipt.json']) {
      if (readdirSync(directory).includes(name)) unlinkSync(join(directory, name))
    }
    rmdirSync(directory)
  }
  try {
    record.initial = census(project, childEnv)
    assert.ok(empty(record.initial), 'refusing a pre-existing calibration project')
    owned = true
    compose(childEnv, ['up', '-d', '--wait', '--no-build', ...services])
    record.runningPosture = inspectPosture(project, childEnv)
    assert.ok(record.runningPosture.length === 4 && record.runningPosture.every(cell => cell.image === image), 'calibration did not start the built image')
    captureStarted = true
    const child = await capture(process.execPath, [resolve(here, 'verify-sync-cell-calibration.mjs'), measurementPath],
      { cwd: resolve(here, '..'), env: childEnv, timeoutMs: 360_000 })
    record.native = child.receipt
    childJoined = child.receipt.closed === true && child.receipt.cleanupConfirmed === true && !child.receipt.captureDetached
    record.stdout = child.stdout
    record.stderr = child.stderr
    // Keep a valid measurement even when the child or its threshold was red.
    try { record.measurement = JSON.parse(readFileSync(measurementPath, 'utf8')) }
    catch (error) { record.errors.push(`measurement: ${error.message}`) }
  } catch (error) {
    record.errors.push(error.message)
  } finally {
    if (owned && (!captureStarted || childJoined)) {
      try { record.beforeCleanup = census(project, childEnv) }
      catch (error) { record.errors.push(`before cleanup census: ${error.message}`) }
      try { record.logs = compose(childEnv, ['logs', '--no-color', '--tail', '200']) }
      catch (error) { record.errors.push(`logs: ${error.message}`) }
      record.cleanup = { downCompleted: false, remaining: null }
      try { compose(childEnv, ['--profile', '*', 'down', '-v', '--remove-orphans']); record.cleanup.downCompleted = true }
      catch (error) { record.errors.push(`down: ${error.message}`) }
      try { record.cleanup.remaining = census(project, childEnv, record.beforeCleanup?.mountedVolumes ?? []) }
      catch (error) { record.errors.push(`census: ${error.message}`) }
      record.cleanup.completedAt = Date.now()
    } else if (owned) {
      record.cleanup = { downCompleted: false, remaining: null, completedAt: Date.now(),
        retainedDirectory: directory,
        outstanding: 'Native child closure unconfirmed; do not race teardown against its possible commands. No load stage may start.' }
      record.errors.push('calibration native child closure unconfirmed; project retained for cleanup after reconciliation')
    }
  }
  try {
    assert.equal(record.errors.length, 0, `calibration stage errors: ${record.errors.join('; ')}`)
    assertCalibrationReceipt(record, { nonce, project: record.mainProject, image, posture })
    const bytes = Buffer.from(JSON.stringify(record))
    writeFileSync(receiptPath, bytes, { flag: 'wx', mode: 0o600 })
    publish(record)
    return { binding: { path: receiptPath, sha256: sha256(bytes), nonce }, record, dispose }
  } catch (error) {
    record.errors.push(error.message)
    if (captureStarted && !childJoined) {
      // The still-possible writer owns measurement.json until joined. Keep its
      // directory too; the failed receipt is a separate parent-owned file.
      try { writeFileSync(receiptPath, JSON.stringify(record), { flag: 'wx', mode: 0o600 }) }
      catch (failure) { record.errors.push(`failed receipt preservation: ${failure.message}`) }
      publish(record)
    } else {
      try { publish(record) } finally { dispose() }
    }
    throw error
  }
}
