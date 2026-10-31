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
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { Repo, documentIdToBinary } from '@automerge/automerge-repo'
import { WebSocketServer } from 'ws'
import {
  acquireQualificationRunLock,
  appendQualificationObjectTombstones,
  attachSampledMetrics,
  benchHost,
  baselineBarrierAdmission,
  createLoadOutputTracker,
  createVerdictGuard,
  cellSnapshot,
  cleanupFreshLandscapes,
  completeQualificationCleanup,
  collectBaselineOwnership,
  convergedResult,
  defaultRunDeadlineMs,
  loadProcessesReadyForFailure,
  LOAD_PROFILES,
  MetricsAccumulator,
  isAlreadyUnpausedError,
  isQualificationObjectId,
  evaluateLoadSoakEvidence,
  evaluatePostureBaseline,
  evaluatePostureEpisode,
  main,
  parseLoadSoakConfig,
  resolveLoadTopology,
  revalidateLoadTopology,
  qualificationObjectPrefix,
  refreshRotatedLoadTargets,
  releaseBaselineIfAdmitted,
  releaseCohortsIfReady,
  runPostureBaseline,
  shutdownRepo,
  summarizeLoadNetworkDiagnostics,
  summarizeCycleConvergence,
} from './verify-sync-cell-load-soak.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const gateUrl = pathToFileURL(resolve(here, 'verify-sync-cell-load-soak.mjs')).href
const benchPath = resolve(here, 'sync-cell-bench.mjs')
import { AuthenticatedWebSocketClientAdapter, qaReconnectDelayMs } from '../qa/authenticatedWebSocketAdapter.mjs'
import { RehearsalObservations, RehearsalSampler, closeRehearsalSeeder, freshnessIdentityValid, isFreshWitness, measureTakeover, publishRehearsalBases } from './sync-cell-rehearsal.mjs'
import { readRuntimeTopology, inspectRunningTopology, qualifyRuntimeTopology, assertTopologyBuild, revalidateTopologyTargets } from './sync-bench-posture.mjs'
import { assertCalibrationMeasurement, assertCalibrationReceipt, calibrationHostHashes, calibrationProjectCensus,
  readCalibrationReceipt, runIsolatedCalibrationStage } from './sync-cell-calibration.mjs'
import { captureDedicatedNative } from './sync-cell-dedicated-native.mjs'
import { assertLoadUserEvidence, parseClosedLoadOutput } from '../qa/loadUserEvidence.mjs'

const config = {
  mode: 'smoke',
  usersPerWorkspace: 10,
  clientsPerProcess: 10,
  normalConvergenceBudgetMs: 3_000,
  failoverConvergenceBudgetMs: 30_000,
  takeoverBudgetMs: 2_000,
  maxExpectedStaleFenceRejections: 3,
  maxExpectedCoalescedStaleFenceRejections: 1,
  maxCoalescedStaleFenceRejectionsPerMutation: 1,
  maxEventLoopP99Ms: 200,
  maxSynchronizerPeerBindings: 30,
}

function result(convergenceMs, partition = 0, cohort = 0, editCompletedAt = 1_000) {
  return {
    partition,
    cohort,
    editCompletedAt,
    convergedAt: editCompletedAt + convergenceMs,
    convergenceMs,
    fullyConverged: true,
    missingFields: 0,
    staleFields: 0,
    hotDiverged: 0,
    clientsConverged: 10,
    clientsTotal: 10,
    hotValues: ['winner'],
    // Every client's OWN field, read back from its OWN document after the
    // edit round — the shape `load-users.mjs` actually emits. All present means
    // no write was refused, and `rejectedClientEdits: 0` is DERIVED from this.
    //
    // The fixture carries it because the evaluator refuses to publish a number
    // it does not have: a result without this field yields `null`, not `0`, and
    // the certificate then rejects the report for a missing counter. An older
    // evidence file must not certify clean by omission.
    localOwnFieldsAfterEdit: [
      { user: 0, values: ['r1', 'r1'] },
      { user: 1, values: ['r1', 'r1'] },
    ],
  }
}

/** The same result with `refused` of its own edits missing from its own document
 *  — the state that means a client write was refused or rolled back under it. */
function resultWithRejectedEdits(refused, convergenceMs = 700, partition = 0) {
  const base = result(convergenceMs, partition)
  const values = ['r1', 'r1', 'r1', 'r1']
  for (let index = 0; index < refused; index += 1) values[index] = null
  return { ...base, localOwnFieldsAfterEdit: [{ user: 0, values }] }
}

function evidence(overrides = {}) {
  return {
    baselineResults: [result(700, 0), result(900, 1)],
    failoverResults: [result(8_000, 0), result(1_100, 1)],
    soakResults: [result(800, 0), result(950, 1)],
    takeover: { verified: true, originalService: 'sync-cell-a', replacementService: 'sync-cell-c', takeoverMs: 1_500 },
    soakMs: 12_000,
    metrics: {
      peakActiveConnections: 20,
      maxSynchronizerPeerBindings: 20,
      maxPeersPerDocument: 10,
      maxEventLoopP99Ms: 32,
      maxRssBytes: 500_000_000,
      maxForeignResidentProjectors: 0,
      maxStaleFenceCoalescingCacheSize: 0,
      maxRetiredDocuments: 12,
      retiredDocumentLimitExceeded: false,
      unexpectedSampleFailures: 0,
      backpressureDisconnectsDelta: 0,
      droppedBackpressureFramesDelta: 0,
      rejectedStorageMutationsDelta: 0,
      expectedStaleFenceRejections: 0,
      unexpectedStorageFenceRejections: 0,
      unexpectedStaleFenceKinds: 0,
      repeatedStaleFenceRejections: 0,
      expectedCoalescedStaleFenceRejections: 0,
      unexpectedCoalescedStaleFenceRejections: 0,
      staleFenceCoalescingEvictions: 0,
      maxCoalescedStaleFenceRejectionsPerMutation: 0,
    },
    finalOwnership: [
      { ready: false, partitionIndex: null },
      { ready: true, partitionIndex: 1 },
      { ready: true, partitionIndex: 0 },
    ],
    ...overrides,
  }
}

function postureOwnership() {
  return ['sync-cell-a', 'sync-cell-b', 'sync-cell-c'].map((service, index) => ({
    service,
    processBootIdBefore: `00000000-0000-4000-8000-00000000000${index}`,
    processBootIdAfter: `00000000-0000-4000-8000-00000000000${index}`,
    ownership: {
      cellId: service, topologyGeneration: 'test-posture.ce1461953e2b8ac2', partitionCount: 2,
      configuredGeneration: 'test-posture', effectiveGeneration: 'test-posture.ce1461953e2b8ac2',
      ready: index < 2, partitionReady: index < 2, partitionIndex: index < 2 ? index : null,
      partitionLossCount: 0,
    },
  }))
}

function postureConfig(overrides = {}) {
  return {
    ...parseLoadSoakConfig({
      SYNC_BENCH_POSTURE: 'shipped', SYNC_LOAD_PROFILE: 'fleet',
      SYNC_FAILOVER_TOPOLOGY_GENERATION: 'test-posture',
    }, []),
    topologyBuild: topologyBuildFixture(),
    ...overrides,
  }
}

const AP1_TOPOLOGY = {
  partitionCount: 2,
  configuredGeneration: 'test-posture',
  effectiveGeneration: 'test-posture.ce1461953e2b8ac2',
  topologyGeneration: 'test-posture.ce1461953e2b8ac2',
  mappingFingerprint: 'ce1461953e2b8ac2',
}

function topologyBuildFixture() {
  const targets = { host: '127.0.0.1', cellPorts: [3331, 3332, 3333], routerPort: 3330 }
  const identity = (service, index) => ({
    service, id: String(index + 1).repeat(64), image: 'sha256:' + 'c'.repeat(64),
    startedAt: '2026-09-07T00:00:00Z', restartCount: 0, project: 'maplespire-sync-load-soak', running: true,
    ports: service === 'router' ? { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '3330' }] }
      : index < 3 ? { '3001/tcp': [{ HostIp: '127.0.0.1', HostPort: String(3331 + index) }] } : {},
    target: service === 'router' ? { url: 'http://127.0.0.1:3330', containerPort: '8080/tcp', hostPort: 3330 }
      : index < 3 ? { url: `http://127.0.0.1:${3331 + index}`, containerPort: '3001/tcp', hostPort: 3331 + index } : null,
  })
  return {
    project: 'maplespire-sync-load-soak', targets, engineEndpoint: 'unix:///var/run/docker.sock',
    expectedTopology: { ...AP1_TOPOLOGY },
    sources: { 'server/src/syncCells/assignment.ts': 'a'.repeat(64), 'server/src/syncCells/topologyContract.ts': 'b'.repeat(64) },
    running: ['sync-cell-a', 'sync-cell-b', 'sync-cell-c', 'sync-ws-router'].map((service, index) => ({
      ...identity(service, index), topology: { ...AP1_TOPOLOGY },
      modules: { 'dist/syncCells/assignment.js': 'd'.repeat(64), 'dist/syncCells/topologyContract.js': 'e'.repeat(64) },
    })),
    edge: identity('router', 4),
  }
}

function topologyReceiptFixture(build = topologyBuildFixture()) {
  return { beganAt: 302, endedAt: 309, engineEndpoint: build.engineEndpoint,
    containers: [...build.running, build.edge].map(({ topology: _topology, modules: _modules, ...identity }) => identity) }
}

function calibrationFixture(project = 'qa-calibration') {
  const topologyBuild = topologyBuildFixture()
  topologyBuild.project = project
  for (const cell of [...topologyBuild.running, topologyBuild.edge]) cell.project = project
  const state = { ...AP1_TOPOLOGY, cellId: 'sync-cell-c', ready: true, partitionReady: true, partitionIndex: 0 }
  const before = { service: 'sync-cell-c', ownership: { ...state, ready: false, partitionReady: false, partitionIndex: null },
    stats: { processBootId: '00000000-0000-4000-8000-000000000002', transport: { connections: { active: 0 } } },
    fleet: { residentProjectors: 0, inFlightWorkspaces: 0 } }
  const workspace = { landscapeId: 'cal-landscape', versionId: 'cal-version' }
  const expectedObjects = { one: { name: 'one' } }
  const fresh = { status: 200, route: 'owner', receivedAt: 280, freshAfterTakeoverMs: 280,
    body: { ...workspace, absenceProvable: true, objects: expectedObjects } }
  return {
    project, benchPosture: 'shipped', hostSources: calibrationHostHashes(), topologyBuild,
    emptyDatabase: { objects: 0, staticWorkspaces: 0 }, seededDatabase: { objects: 5, staticWorkspaces: 0 },
    before: ['sync-cell-a', 'sync-cell-b', 'sync-cell-c'].map(service => ({ ...before, service })),
    takeover: { verified: true, originalService: 'sync-cell-a', replacementService: 'sync-cell-c', replacementState: state,
      completedAt: 0, unpauseCompletedAt: 10 },
    freshness: { valid: true, origin: 'replacement ready response completedAt', completedAt: 0,
      freshAfterTakeoverMs: 280, firstFreshResponseAt: 280, requests: [fresh], before,
      after: { ...before, ownership: state, fleet: { residentProjectors: 1, foreignResidentProjectors: 0 } },
      seed: { totalObjects: 5, workspace, expectedObjects, inventory: { objects: 5, projectorInstanceId: 'old' },
        seederClosure: { requestedAt: -20, completedAt: -10, alreadyClosed: false, closeObservedAt: -10 } },
      inventory: { objects: 5, staticWorkspaces: 0, projectorInstanceId: 'new' } },
  }
}

test('G4 dedicated calibration keeps the literal 500 ms ceiling and observed witness', () => {
  assert.doesNotThrow(() => assertCalibrationMeasurement(calibrationFixture()))
  for (const change of [
    row => { row.seededDatabase.objects = 12_005 },
    row => { row.emptyDatabase.objects = 5 },
    row => { row.freshness.freshAfterTakeoverMs = 500 },
    row => { row.freshness.freshAfterTakeoverMs = NaN },
    row => { row.freshness.requests[0].route = 'proxy' },
    row => { row.freshness.requests[0].body.objects = {} },
    row => { row.before[0].stats.transport.connections.active = 1 },
    row => { row.freshness.seed.seederClosure = null },
    row => { row.freshness.before.fleet.residentProjectors = 1 },
    row => { row.takeover.unpauseCompletedAt = undefined },
  ]) {
    const row = calibrationFixture(); change(row)
    assert.throws(() => assertCalibrationMeasurement(row))
  }
})

test('G4 main refuses an absent calibration before Docker or application I/O', async () => {
  await assert.rejects(main(postureConfig({ mode: 'soak', calibrationBinding: null })), /dedicated calibration receipt/)
})

async function calibrationStageFixture(change = {}) {
  const calls = []
  let captured, published, childDirectory, measurement
  const stage = await runIsolatedCalibrationStage({
    env: { ...process.env, SYNC_FAILOVER_PROJECT: 'qa-main' }, image: 'sha256:' + 'c'.repeat(64), posture: 'shipped',
    services: ['postgres', 'redis', 'redis-render-cache', 'sync-cell-a', 'sync-cell-b', 'sync-cell-c', 'sync-ws-router', 'router'],
    census: (project, env, watched) => {
      calls.push(['census', project, watched])
      if (change.collision && calls.length === 1) return { containers: ['foreign'], volumes: [], networks: [] }
      if (change.census && calls.filter(call => call[0] === 'census').length === 3) throw new Error('census failed')
      return { containers: [], volumes: change.residue ? ['residue'] : [], networks: [], mountedVolumes: ['anonymous-volume'] }
    },
    compose: (env, args) => {
      calls.push([args.includes('down') ? 'down' : args[0], env.SYNC_FAILOVER_PROJECT])
      if (change[args[0]] || (change.down && args.includes('down'))) throw new Error('injected ' + args.join(' '))
      return 'native logs'
    },
    inspectPosture: project => {
      calls.push(['posture', project])
      measurement = calibrationFixture(project)
      return measurement.topologyBuild.running.map(({ service, image }) => ({ service, image, values: { ttl: 1500 } }))
    },
    capture: async (file, args, options) => {
      calls.push(['child', options.env.SYNC_FAILOVER_PROJECT])
      assert.equal(file, process.execPath)
      assert.equal(args[0], resolve(here, 'verify-sync-cell-calibration.mjs'))
      childDirectory = dirname(args[1])
      if (change.measurement) change.measurement(measurement)
      const child = await captureDedicatedNative(process.execPath, ['-e',
        'require("node:fs").writeFileSync(process.argv[1], process.argv[2]); console.log("calibration child closed")',
        args[1], JSON.stringify(measurement)], { timeoutMs: 5_000 })
      if (change.native) change.native(child.receipt)
      captured = child.receipt
      calls.push(['child-closed', captured.closed])
      return child
    },
    publish: record => { published = record; if (change.publish) throw new Error('publish failed') },
  }).catch(error => ({ error }))
  return { stage, calls, captured, published, childDirectory }
}

test('G4 dedicated stage joins the real child, cleans up, then seals a current receipt', async () => {
  const result = await calibrationStageFixture()
  const { stage, calls, captured, published } = result
  assert.equal(stage.error, undefined, stage.error?.stack)
  try {
    assert.equal(captured.closed, true)
    assert.ok(calls.findIndex(call => call[0] === 'child-closed') < calls.findIndex(call => call[0] === 'down'))
    assert.equal(calls.filter(call => call[0] === 'child').length, 1)
    assert.deepEqual(calls.at(-1)[2], ['anonymous-volume'])
    const expected = { project: 'qa-main', image: 'sha256:' + 'c'.repeat(64), posture: 'shipped' }
    assert.equal(readCalibrationReceipt(stage.binding, expected).freshAfterTakeoverMs, 280)
    assert.deepEqual(Object.keys(published.hostSources).sort(), [
      'sync-cell-bench.mjs', 'sync-cell-calibration.mjs', 'verify-sync-cell-calibration.mjs',
      'verify-sync-cell-load-soak.mjs', 'sync-cell-rehearsal.mjs', 'sync-bench-posture.mjs',
      '../qa/authenticatedWebSocketAdapter.mjs', '../qa/loadUsersCore.mjs', '../qa/loadBarrier.mjs',
      '../qa/load-users.mjs', '../qa/lib.mjs', '../qa/load-user-worker.mjs',
      '../qa/loadUserCohort.mjs', '../qa/loadUserSnapshots.mjs', '../qa/loadUserEvidence.mjs',
    ].sort(), 'the calibration binds every required host instrument, including the IPC receipt producers')
    for (const hash of Object.values(published.hostSources)) assert.match(hash, /^[a-f0-9]{64}$/)
    const main = topologyBuildFixture()
    main.project = 'qa-main'
    for (const [index, cell] of [...main.running, main.edge].entries()) {
      cell.project = 'qa-main'; cell.id = (index + 6).toString(16).repeat(64)
      cell.startedAt = new Date(published.cleanup.completedAt + 100).toISOString()
    }
    assert.doesNotThrow(() => assertCalibrationReceipt(published, { ...expected, nonce: stage.binding.nonce, topologyBuild: main }))
    for (const delta of [{ nonce: randomBytes(18).toString('hex') }, { project: 'other-main' },
      { image: 'sha256:' + 'd'.repeat(64) }, { posture: 'bench' }]) {
      assert.throws(() => assertCalibrationReceipt(published, { ...expected, nonce: stage.binding.nonce, ...delta }))
    }
    for (const producer of ['verify-sync-cell-load-soak.mjs', '../qa/loadBarrier.mjs', '../qa/load-users.mjs',
      '../qa/load-user-worker.mjs', '../qa/loadUserCohort.mjs', '../qa/loadUserSnapshots.mjs', '../qa/loadUserEvidence.mjs']) {
      const old = structuredClone(published)
      old.hostSources[producer] = '0'.repeat(64)
      assert.throws(() => assertCalibrationReceipt(old, { ...expected, nonce: stage.binding.nonce }), /host calibration code changed/)
      const childChanged = structuredClone(published)
      childChanged.measurement.hostSources[producer] = '0'.repeat(64)
      assert.throws(() => assertCalibrationReceipt(childChanged, { ...expected, nonce: stage.binding.nonce }), /calibration child host code differs/)
      const absent = structuredClone(published)
      delete absent.hostSources[producer]
      assert.throws(() => assertCalibrationReceipt(absent, { ...expected, nonce: stage.binding.nonce }), /host calibration code changed/)
    }
    writeFileSync(stage.binding.path, '{}')
    assert.throws(() => readCalibrationReceipt(stage.binding, expected), /bytes changed/)
  } finally { stage.dispose() }
})

test('G4 failed lifecycle paths remain red and still attempt cleanup; collisions are never removed', async () => {
  for (const change of [{ collision: true }, { up: true }, { logs: true }, { down: true }, { census: true },
    { measurement: row => { row.freshness.freshAfterTakeoverMs = 500 } },
    { unjoined: true, native: receipt => { receipt.cleanupConfirmed = false } },
    { unjoined: true, native: receipt => { receipt.closed = false; receipt.captureDetached = true } },
    { native: receipt => { receipt.code = 1 } }, { publish: true }]) {
    const { stage, calls, published, childDirectory, captured } = await calibrationStageFixture(change)
    assert.ok(stage.error, JSON.stringify(change))
    assert.equal(calls.some(call => call[0] === 'down'), !change.collision && !change.unjoined)
    if (change.collision || change.up) assert.equal(calls.some(call => call[0] === 'child'), false)
    assert.ok(published.errors.length > 0)
    if (change.unjoined) {
      assert.equal(published.cleanup.retainedDirectory, childDirectory)
      assert.equal(JSON.parse(readFileSync(resolve(childDirectory, 'receipt.json'))).cleanup.downCompleted, false)
      assert.equal(JSON.parse(readFileSync(resolve(childDirectory, 'measurement.json'))).project, published.project)
      // The fixture joined its REAL child before injecting the invalid receipt.
      assert.equal(captured.rootExited, true)
      assert.equal(dirname(childDirectory), resolve(tmpdir()))
      assert.ok(childDirectory.startsWith(resolve(tmpdir(), 'maplespire-g47-cal-')))
      rmSync(childDirectory, { recursive: true })
    }
  }
})

test('G4 project census also sees a leftover anonymous volume after containers disappeared', () => {
  const calls = []
  const exec = (file, args) => {
    calls.push(args)
    assert.equal(file, 'docker')
    if (args[0] === 'volume' && args.length === 3) return 'anonymous-volume\nforeign-demo-volume\n'
    return ''
  }
  const census = calibrationProjectCensus('qa-calibration', {}, ['anonymous-volume'], exec)
  assert.deepEqual(census.volumes, ['anonymous-volume'])
  assert.deepEqual(census.containers, [])
  assert.ok(calls.some(args => args[0] === 'network' && args.includes('{{.Name}}')))
  assert.equal(calls.some(args => args.includes('rm') || args.includes('prune')), false)
})

test('B3d2 qualifies AP1 against an independent build identity, not the configured generation', () => {
  const baseline = postureEvidence()
  for (const entries of [baseline.baselineOwnership.before, baseline.baselineOwnership.after, baseline.baselineAdmission.cells]) {
    for (const entry of entries) Object.assign(entry.ownership, AP1_TOPOLOGY)
  }
  const record = evaluatePostureBaseline(baseline, postureConfig({ topologyBuild: topologyBuildFixture() }))
  assert.equal(record.status, 'PASS', JSON.stringify(record))
  assert.deepEqual(record.topologyBuild, topologyBuildFixture())
})

test('B3d2 refuses collectively wrong, legacy and incomplete snapshot generations', () => {
  for (const change of [
    state => { state.topologyGeneration = state.effectiveGeneration = 'test-posture.aaaaaaaaaaaaaaaa' },
    state => { state.topologyGeneration = state.effectiveGeneration = 'test-posture' },
    state => { state.configuredGeneration = 'another' },
    state => { delete state.effectiveGeneration },
    state => { delete state.configuredGeneration },
  ]) {
    const baseline = postureEvidence()
    for (const entries of [baseline.baselineOwnership.before, baseline.baselineOwnership.after, baseline.baselineAdmission.cells]) {
      for (const entry of entries) change(entry.ownership)
    }
    const record = evaluatePostureBaseline(baseline, postureConfig())
    assert.equal(record.status, 'VOID', JSON.stringify(record))
    assert.equal(record.criteria.partitionLossCountZero, null)
  }
})

test('B3d2 refuses absent or mismatched build provenance even with healthy snapshots', () => {
  for (const change of [
    config => { delete config.topologyBuild },
    config => { delete config.topologyBuild.sources['server/src/syncCells/assignment.ts'] },
    config => { config.topologyBuild.running.pop() },
    config => { config.topologyBuild.running[1].id = config.topologyBuild.running[0].id },
    config => { config.topologyBuild.running[3].image = 'sha256:' + 'f'.repeat(64) },
    config => { config.topologyBuild.running[3].topology.effectiveGeneration = 'test-posture.aaaaaaaaaaaaaaaa' },
    config => { config.topologyGeneration = 'another' },
  ]) {
    const config = postureConfig()
    change(config)
    assert.equal(evaluatePostureBaseline(postureEvidence(), config).status, 'VOID')
  }
})

test('B3d2 resolves the source/build expectation without accepting an injected record', () => {
  const config = postureConfig({ topologyGeneration: ' Test-Posture ', topologyBuild: { nominated: true } })
  const calls = []
  const result = resolveLoadTopology(config, (project, environment, exec, targets) => {
    calls.push({ project, environment, exec, targets })
    return topologyBuildFixture()
  })
  assert.deepEqual(calls, [{ project: config.project, exec: undefined,
    targets: { host: config.host, cellPorts: config.cellPorts, routerPort: config.routerPort }, environment: {
    SYNC_CELL_TOPOLOGY_GENERATION: ' Test-Posture ', SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on',
  } }])
  assert.deepEqual(result, topologyBuildFixture())
  assert.throws(() => resolveLoadTopology(config, () => { throw new Error('compiled probe unavailable') }), /compiled probe unavailable/)
})

test('B3d2 direct main refuses missing topology before acquiring the run lock or application I/O', async () => {
  await assert.rejects(main(postureConfig({ topologyGeneration: '' })), /expected configured topology generation is missing/)
})

const postureReleaseNonce = '58e74e0c-6ae2-4488-bd61-dbc3b0c0c501'

// Synthetic records for the evaluator only; real Worker/Repo execution lives
// in the CLI integration suite. Keep raw observation dates beside the totals.
function withWorkerEvidence(row) {
  const episodeId = row.episodeId ?? null
  row.episodeId = episodeId
  row.writesCompleted ??= []
  const pid = 100 + row.partition * 4 + row.cohort
  row.childProcess.pid = pid
  const cohortId = `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`
  const objectIds = Array.from({ length: 10 }, (_, i) => `object-${i}`)
  const clients = Array.from({ length: 25 }, (_, i) => ({ user: row.userOffset + i,
    threadId: i + 1, peerId: `peer-${pid}-${i}`, actorId: `actor-${pid}-${i}`,
    pid, cohortId, episodeId, documentReady: true }))
  const finalSnapshots = clients.map(client => ({ user: client.user, episodeId, pollId: 1,
    startedAt: row.convergedAt, sampledAt: row.convergedAt,
    objects: Object.fromEntries(objectIds.map((id, writer) => [id, {
      [`u${writer}`]: episodeId ? `${episodeId}:r3` : 'r3', hot: row.hotValues[writer],
    }])) }))
  if (row.missingFields === 1) delete finalSnapshots[0].objects['object-0'].u0
  row.clientIsolation = { kind: 'worker-per-user', cohortId, pid, objectIds, clients,
    writeScheduling: 'sequential-rpc-with-yields', finalSnapshots,
    snapshotWindows: [{ pollId: 1, startedAt: row.convergedAt, completedAt: row.convergedAt,
      receivedAt: row.convergedAt + 1, clients: 25, freshEpisode: episodeId !== null,
      fullyConverged: row.fullyConverged }] }
  row.workerClosure = { cohortId, episodeId, pid, clean: true,
    startedAt: row.convergedAt + 2, completedAt: row.convergedAt + 10,
    workers: clients.map(({ user, threadId }) => ({ user, threadId, exited: true, exitCode: 0,
      forced: false, error: null, shutdown: { closed: true, repoCreated: true,
        socketClosed: true, retryScheduled: false } })) }
  return row
}

function postureResults() {
  return [0, 1].flatMap((partition) => [0, 1, 2, 3].map((cohort) => withWorkerEvidence({
    ...result(900, partition, cohort),
    test: 'load-users', users: 25, userOffset: cohort * 25, totalUsers: 100,
    writers: 10, cohortWriters: cohort === 0 ? 10 : 0,
    objectAssignment: 'per-writer', objectsTested: 10, rounds: 4,
    editStartedAt: 500, clientsConverged: 25, clientsTotal: 25,
    lastWriteCompletedAt: cohort === 0 ? 1_000 : null,
    hotValues: Array.from({ length: 10 }, (_, index) => `u${index}-r3`),
    localOwnFieldsAfterEdit: cohort === 0
      ? Array.from({ length: 10 }, (_, user) => ({ user, values: ['r3'] }))
      : [],
    childProcess: { exitCode: 0, signal: null },
    baselineBarrier: { barrierId: '905876c1-25ef-4114-b79c-41c407b85b73', releaseNonce: postureReleaseNonce, releasedAt: 350 },
  })))
}

function postureAdmission() {
  return {
    topologyTargets: topologyReceiptFixture(),
    barrierId: '905876c1-25ef-4114-b79c-41c407b85b73',
    releaseNonce: postureReleaseNonce,
    observedAt: 300, releaseStartedAt: 310, releaseCompletedAt: 320,
    totalActiveConnections: 200,
    cells: postureOwnership().map((entry, index) => ({
      service: entry.service, processBootId: entry.processBootIdBefore,
      ownership: entry.ownership, activeConnections: index < 2 ? 100 : 0,
    })),
    cohorts: [0, 1].flatMap((partition) => [0, 1, 2, 3].map((cohort) => ({
      partition, cohort, type: 'load-baseline-ready',
      barrierId: '905876c1-25ef-4114-b79c-41c407b85b73',
      users: 25, userOffset: cohort * 25, totalUsers: 100,
    }))),
  }
}

test('Worker receipts refuse missing closure, reused identities, stale polls and shifted measurement clocks', () => {
  const valid = rehearsalEpisode().evidence.baselineResults[0]
  assert.doesNotThrow(() => assertLoadUserEvidence(valid))
  for (const mutate of [
    row => { delete row.workerClosure },
    row => { row.workerClosure.workers.pop() },
    row => { row.workerClosure.workers[0].forced = true },
    row => { row.workerClosure.workers[0].error = 'late duplicate' },
    row => { row.workerClosure.workers[0].shutdown.socketClosed = false },
    row => { row.workerClosure.workers[0].shutdown.retryScheduled = true },
    row => { row.clientIsolation.clients[1].threadId = row.clientIsolation.clients[0].threadId },
    row => { row.clientIsolation.clients[1].peerId = row.clientIsolation.clients[0].peerId },
    row => { row.clientIsolation.clients[1].actorId = row.clientIsolation.clients[0].actorId },
    row => { row.clientIsolation.clients[0].documentReady = false },
    row => { row.clientIsolation.finalSnapshots[24].pollId = 0 },
    row => { row.clientIsolation.finalSnapshots[24].episodeId = 'old-episode' },
    row => { row.clientIsolation.finalSnapshots[24].objects['object-9'].u9 = 'old-value' },
    row => { row.clientIsolation.finalSnapshots[24].objects['object-9'].hot = 'other-winner' },
    row => { row.clientIsolation.snapshotWindows[0].completedAt++ },
    row => { row.convergedAt = row.clientIsolation.snapshotWindows[0].receivedAt },
    row => { row.writesCompleted[0].startedAt = row.writesCompleted[0].completedAt + 1 },
    row => { row.childProcess.pid++ },
  ]) {
    const changed = structuredClone(valid)
    mutate(changed)
    assert.throws(() => assertLoadUserEvidence(changed))
    const evidence = rehearsalEpisode().evidence
    evidence.baselineResults[0] = changed
    assert.equal(evaluatePostureEpisode(evidence, rehearsalConfig(), 'soak').status, 'VOID')
  }
  const normalized = convergedResult(valid)
  assert.deepEqual(normalized.workerClosure, valid.workerClosure)
  assert.deepEqual(normalized.clientIsolation, valid.clientIsolation)
})

test('load stdout requires exactly one result then one close receipt', () => {
  const row = postureResults()[0]
  const result = 'QARESULT ' + JSON.stringify(row) + '\n'
  const close = 'QACLOSE ' + JSON.stringify(row.workerClosure) + '\n'
  assert.deepEqual(parseClosedLoadOutput('QAPHASE {}\n' + result + close), row)
  for (const stdout of [result, close, close + result, result + result + close,
    result + close + close, 'QARESULT broken\n' + close]) {
    assert.throws(() => parseClosedLoadOutput(stdout))
  }
})

function postureEvidence() {
  return {
    baselineResults: postureResults(),
    baselineOwnership: { before: postureOwnership(), after: postureOwnership() },
    baselineAdmission: postureAdmission(),
  }
}

test('T-POST rejects a measured baseline partition loss before voluntary failover', () => {
  const baseline = postureEvidence()
  baseline.baselineOwnership.after[0].ownership.partitionLossCount = 1
  const record = evaluatePostureBaseline(baseline, postureConfig())
  assert.equal(record.status, 'RED')
  assert.equal(record.criteria.partitionLossCountZero, false)
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    ...baseline,
  }), postureConfig()), /baseline.*partition loss/)
})

test('T-POST qualifies the complete fleet baseline and retains raw evidence', () => {
  const baseline = postureEvidence()
  const record = evaluatePostureBaseline(baseline, postureConfig())
  assert.equal(record.status, 'PASS')
  assert.deepEqual(record.reasons, [])
  assert.deepEqual(record.criteria, { partitionLossCountZero: true, convergenceP99Below3000: true })
  assert.equal(record.convergence.p99Ms, 900)
  assert.equal(record.convergence.sampleCount, 2)
  assert.deepEqual(record.baselineResults, baseline.baselineResults)
  assert.deepEqual(record.baselineOwnership, baseline.baselineOwnership)
})

function rehearsalConfig() {
  return { ...postureConfig(), ...parseLoadSoakConfig({ SYNC_LOAD_PROFILE: 'fleet', SYNC_BENCH_POSTURE: 'shipped',
    SYNC_FAILOVER_TOPOLOGY_GENERATION: 'test-posture' }, ['--mode=soak']), topologyBuild: topologyBuildFixture() }
}

function rehearsalEpisode(number = 1, phase = 'soak') {
  const evidence = postureEvidence()
  const id = `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
  evidence.baselineAdmission.barrierId = id
  for (const cohort of evidence.baselineAdmission.cohorts) cohort.barrierId = id
  for (const row of evidence.baselineResults) {
    row.episodeId = row.baselineBarrier.barrierId = id
    row.hotValues = row.hotValues.map((_, writer) => `u${writer}-${id}:r3`)
    for (const own of row.localOwnFieldsAfterEdit) own.values = [`${id}:r3`]
    row.writesCompleted = row.cohort === 0 ? Array.from({ length: 40 }, (_, index) => ({
      user: index % 10, round: Math.floor(index / 10), startedAt: 990, completedAt: 1_000,
    })) : []
    withWorkerEvidence(row)
  }
  const takeover = { verified: true, originalService: 'sync-cell-a', replacementService: 'sync-cell-c', startedAt: 900, completedAt: 1_100 }
  if (phase === 'failover') {
    Object.assign(evidence.baselineOwnership.after[0].ownership, { partitionIndex: null, ready: false, partitionReady: false, partitionLossCount: 1 })
    Object.assign(evidence.baselineOwnership.after[2].ownership, { partitionIndex: 0, ready: true, partitionReady: true })
  }
  return { evidence, takeover, record: evaluatePostureEpisode(evidence, rehearsalConfig(), phase, takeover) }
}

function rehearsalSnapshots(p99 = 20, resetCount = 1) {
  return postureOwnership().map((row, index) => ({
    service: row.service, ownership: { ...row.ownership, storageFence: { rejectedMutationCount: 0 } },
    stats: { processBootId: row.processBootIdBefore, transport: {
      eventLoopDelayMs: { p99 }, connections: { active: index < 2 ? 100 : 0 },
      eventLoopWindow: { consumer: 'qualification', resetCount,
        startedAt: new Date(1_000 + resetCount * 500).toISOString(), lastResetBy: resetCount === 0 ? 'boot' : 'consume' },
      backpressure: { disconnects: 0 }, traffic: { outboundDroppedBackpressure: 0 },
    } }, fleet: { foreignResidentProjectors: 0 },
  }))
}

test('G4-7 real seed frontier is accepted by the actual durability API parser', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { Repo } from '@automerge/automerge-repo'
    import { getHeads } from '@automerge/automerge'
    import { rehearsalSeedFrontier } from './scripts/sync-cell-rehearsal.mjs'
    import { parseDurableHeadRequests } from './src/durableHeads.ts'
    const repo = new Repo({ network: [] })
    try {
      const handle = repo.create({ objects: { a: { name: 'seed' } } })
      handle.change(doc => { doc.objects.a.name = 'seed-current' })
      assert.equal(parseDurableHeadRequests([{ documentId: handle.documentId, heads: handle.heads() }]), null)
      const frontier = rehearsalSeedFrontier(handle)
      assert.deepEqual(frontier.heads, getHeads(handle.doc()))
      assert.deepEqual(parseDurableHeadRequests([frontier]), [frontier])
    } finally { await repo.shutdown() }
  `], { cwd: resolve(here, '..'), encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(child.error, undefined)
  assert.equal(child.signal, null)
  assert.equal(child.status, 0, child.stdout + child.stderr)
  assert.match(gateSource, /const publication = await publishRehearsalBases\(/)
  assert.match(gateSource, /return rehearsalDurableAcknowledged\(documents, body\) \? body : null/)
})

async function rehearsalSeedFixture(run, { headObjects = 10, backgroundObjects = 3 } = {}) {
  const repo = new Repo({ network: [] })
  try {
    const head = repo.create({ objects: Object.fromEntries(Array.from({ length: headObjects }, (_, index) => [`writer-${index}`, { name: `Writer ${index}` }])) })
    const metaHandle = repo.create({ objectShardUrls: [head.url], editsObjectShardUrl: head.url,
      connectionShardUrls: ['preserved-connection'], unrelated: { preserved: true } })
    const options = { repo, head, metaHandle, workspace: { landscapeId: 'seed-landscape', versionId: 'seed-version' },
      backgroundIds: Array.from({ length: backgroundObjects }, (_, index) => `background-${index}`),
      createObject: id => ({ name: `Background ${id}` }),
      // Wire-shaped IDs only: this unit fixture makes no network/MAC claim.
      mint: async count => ({ landscapeId: 'seed-landscape', versionId: 'seed-version',
        ids: Array.from({ length: count }, () => Buffer.concat([Buffer.from([1]), randomBytes(23)]).toString('base64')) }),
      waitDurable: async documents => ({ documents: documents.map(document => ({ documentId: document.documentId, durable: true })) }),
    }
    await run(options)
  } finally { await repo.shutdown() }
}

test('G4-7 imports bounded named bases, awaits every frontier, then publishes metadata with the writer head last', async () => {
  await rehearsalSeedFixture(async options => {
    const { repo, head, metaHandle } = options
    const originalHead = JSON.parse(JSON.stringify(head.doc()))
    const originalMeta = JSON.parse(JSON.stringify(metaHandle.doc()))
    const events = []
    const waitDurable = options.waitDurable
    options.waitDurable = async documents => {
      const id = documents[0].documentId
      const role = id === head.documentId ? 'head' : id === metaHandle.documentId ? 'meta' : 'base'
      assert.equal(documents[0].heads.length, 1)
      assert.match(documents[0].heads[0], /^[a-f0-9]{64}$/)
      events.push(role)
      await new Promise(resolve => setImmediate(resolve))
      if (role === 'base') {
        assert.deepEqual(JSON.parse(JSON.stringify(metaHandle.doc())), originalMeta, 'no base URL before all acknowledgements')
        assert.equal(Object.keys(repo.handles).length, 2 + events.filter(event => event === 'base').length, 'later base not imported before this ACK')
        const handle = await repo.find(`automerge:${id}`)
        assert.ok(Object.keys(handle.doc().objects).length <= 512)
        assert.equal(documentIdToBinary(id).length, 24)
      }
      return waitDurable(documents)
    }
    const publication = await publishRehearsalBases(options)
    assert.deepEqual(events, ['head', 'base', 'base', 'meta'])
    assert.deepEqual(publication.baseShards.map(shard => shard.objects), [512, 1])
    assert.equal(publication.totalObjects, 523)
    assert.deepEqual(JSON.parse(JSON.stringify(head.doc())), originalHead)
    const publishedMeta = JSON.parse(JSON.stringify(metaHandle.doc()))
    assert.deepEqual(publishedMeta.objectShardUrls, [...publication.baseShards.map(shard => shard.url), head.url])
    assert.deepEqual({ ...publishedMeta, objectShardUrls: [head.url] }, originalMeta, 'edit pointers and other metadata preserved')
  }, { backgroundObjects: 513 })
})

test('G4-7 an absent, false, foreign or failed base acknowledgement prevents graph publication', async () => {
  for (const fault of ['absent', 'false', 'foreign', 'throw']) await rehearsalSeedFixture(async options => {
    const original = JSON.parse(JSON.stringify(options.metaHandle.doc()))
    const waitDurable = options.waitDurable
    options.waitDurable = async documents => {
      if (documents[0].documentId === options.head.documentId) return waitDurable(documents)
      if (fault === 'throw') throw new Error('durability unavailable')
      if (fault === 'absent') return { documents: [] }
      return { documents: [{ documentId: fault === 'foreign' ? 'another-document' : documents[0].documentId, durable: fault !== 'false' }] }
    }
    await assert.rejects(publishRehearsalBases(options), /acknowledgement|durability unavailable/)
    assert.deepEqual(JSON.parse(JSON.stringify(options.metaHandle.doc())), original)
  })
})

test('G4-7 requires metadata durability and refuses concurrent metadata changes', async () => {
  for (const fault of ['undurable-meta', 'concurrent-meta']) await rehearsalSeedFixture(async options => {
    const waitDurable = options.waitDurable
    options.waitDurable = async documents => {
      if (documents[0].documentId === options.metaHandle.documentId) return { documents: [] }
      if (fault === 'concurrent-meta' && documents[0].documentId !== options.head.documentId) {
        options.metaHandle.change(meta => { meta.unrelated.preserved = false })
      }
      return waitDurable(documents)
    }
    await assert.rejects(publishRehearsalBases(options), /acknowledgement|metadata changed/)
    if (fault === 'concurrent-meta') assert.deepEqual([...options.metaHandle.doc().objectShardUrls], [options.head.url])
  })
})

test('G4-7 rejects foreign, duplicated, malformed and already cached minted names before import', async () => {
  for (const fault of ['landscape', 'version', 'count', 'duplicate', 'invalid-bytes', 'cached']) {
    await rehearsalSeedFixture(async options => {
      const mint = options.mint
      const original = JSON.parse(JSON.stringify(options.metaHandle.doc()))
      options.mint = async count => {
        const response = await mint(count)
        if (fault === 'landscape') response.landscapeId = 'foreign'
        if (fault === 'version') response.versionId = 'foreign'
        if (fault === 'count') response.ids.pop()
        if (fault === 'duplicate') response.ids.fill(response.ids[0])
        if (fault === 'invalid-bytes') response.ids[0] = Buffer.alloc(24).toString('base64')
        if (fault === 'cached') {
          const { from, save } = await import('@automerge/automerge')
          const { interpretAsDocumentId } = await import('@automerge/automerge-repo')
          options.repo.import(save(from({ preserved: true })), { docId: interpretAsDocumentId(new Uint8Array(Buffer.from(response.ids[0], 'base64'))) })
        }
        return response
      }
      await assert.rejects(publishRehearsalBases(options), /minted/)
      assert.deepEqual(JSON.parse(JSON.stringify(options.metaHandle.doc())), original)
      assert.equal(Object.keys(options.repo.handles).length, fault === 'cached' ? 3 : 2)
    }, { backgroundObjects: 513 })
  }
})

test('G4-7 five-object calibration preserves its native head and mints no background document', async () => {
  await rehearsalSeedFixture(async options => {
    options.mint = async () => { throw new Error('calibration must not mint bases') }
    const original = JSON.parse(JSON.stringify(options.metaHandle.doc()))
    const publication = await publishRehearsalBases(options)
    assert.equal(publication.totalObjects, 5)
    assert.deepEqual(publication.baseShards, [])
    assert.deepEqual(publication.durability.map(row => row.role), ['writer-head', 'model-meta'])
    assert.deepEqual(JSON.parse(JSON.stringify(options.metaHandle.doc())), original)
  }, { headObjects: 5, backgroundObjects: 0 })
})

test('G4-7 seeder closure waits for the actual WebSocket close with the real Repo and adapter', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const connected = once(server, 'connection')
  const adapter = new AuthenticatedWebSocketClientAdapter(`ws://127.0.0.1:${server.address().port}`, '', 500)
  const repo = new Repo({ network: [adapter] })
  try {
    const [remote] = await connected
    const socket = adapter.socket
    if (socket.readyState !== 1) await once(socket, 'open')
    const remoteClosed = once(remote, 'close')
    const closure = await closeRehearsalSeeder(repo, adapter)
    await remoteClosed
    assert.equal(socket.readyState, 3)
    assert.equal(closure.alreadyClosed, false)
    assert.ok(closure.closeObservedAt >= closure.requestedAt)
    assert.ok(closure.completedAt >= closure.closeObservedAt)
    assert.equal(adapter.intentionalClose, true)
    assert.equal(adapter.retryTimer, undefined)
  } finally {
    adapter.disconnect()
    for (const client of server.clients) client.terminate()
    await repo.shutdown()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  assert.match(gateSource, /const closure = await closeRehearsalSeeder\(repo, adapter\)/)
})

test('G4-7 closing cannot silently pass on shutdown failure, missing close or a stuck shutdown', async () => {
  for (const fault of ['shutdown-failed', 'missing-close', 'shutdown-stuck']) {
    const socket = new EventTarget()
    Object.assign(socket, { readyState: 1, forced: 0, terminate() { this.forced++; this.readyState = 3 } })
    const adapter = { socket, stopped: false, disconnect() {
      this.stopped = true
      this.socket = undefined
      if (fault !== 'missing-close') { socket.readyState = 3; socket.dispatchEvent(new Event('close')) }
    } }
    const repo = { shutdown() {
      assert.equal(adapter.stopped, true, 'stop retries before any shutdown await')
      if (fault === 'shutdown-failed') return Promise.reject(new Error('flush failed'))
      return fault === 'shutdown-stuck' ? new Promise(() => {}) : Promise.resolve()
    } }
    await assert.rejects(closeRehearsalSeeder(repo, adapter, 25), /closure could not be confirmed/)
    assert.equal(socket.forced, 1)
    assert.equal(adapter.stopped, true)
  }
})

test('G4-7 admits the unchanged long fleet and keeps seed scale separate from writer objects', () => {
  const config = rehearsalConfig()
  assert.equal(config.mode, 'soak')
  assert.equal(config.soakDurationMs, 7_200_000)
  assert.equal(config.seedObjectCount, 12_000)
  assert.equal(config.objects, 10)
  assert.equal(config.usersPerWorkspace, 100)
  assert.equal(config.freshWorkspaces, true)
  for (const change of [
    { SYNC_LOAD_SOAK_DURATION_MS: '7199999' }, { SYNC_LOAD_SOAK_DURATION_MS: '7200001' },
    { SYNC_LOAD_SEED_OBJECT_COUNT: '11999' }, { SYNC_LOAD_OBJECTS: '12000' },
    { SYNC_LOAD_FRESH_WORKSPACES: 'off' }, { SYNC_LOAD_USERS_PER_WORKSPACE: '99' },
  ]) assert.throws(() => parseLoadSoakConfig({ SYNC_LOAD_PROFILE: 'fleet', SYNC_BENCH_POSTURE: 'shipped', ...change }, ['--mode=soak']))
})

test('G4-7 qualifies every episode and refuses missing, duplicated or older cohort facts', () => {
  assert.equal(rehearsalEpisode().record.status, 'PASS')
  for (const mutate of [
    e => { e.baselineResults.pop() },
    e => { e.baselineResults[7] = e.baselineResults[6] },
    e => { delete e.baselineResults[0].lastWriteCompletedAt },
    e => { e.baselineResults[0].episodeId = 'another-episode' },
    e => { e.baselineResults[0].hotValues.fill('u0-old-episode:r3') },
    e => { e.baselineResults[0].localOwnFieldsAfterEdit[0].values = ['old-episode:r3'] },
    e => { delete e.baselineResults[0].writesCompleted },
    e => { Object.assign(e.baselineResults[0], { lastWriteCompletedAt: 1_400, editCompletedAt: 1_400, convergedAt: 4_100 }) },
    e => { e.baselineAdmission.totalActiveConnections = 199 },
    e => { e.baselineOwnership.after[0].processBootIdAfter = 'another-process' },
  ]) {
    const { evidence } = rehearsalEpisode()
    mutate(evidence)
    assert.equal(evaluatePostureEpisode(evidence, rehearsalConfig(), 'soak').status, 'VOID')
  }
  const { evidence } = rehearsalEpisode()
  for (const edge of ['before', 'after']) evidence.baselineOwnership[edge][0].ownership.partitionLossCount = 2
  evidence.baselineAdmission.cells[0].ownership.partitionLossCount = 2
  assert.equal(evaluatePostureEpisode(evidence, rehearsalConfig(), 'soak').status, 'PASS', 'a previous loss is history, not a new loss')
  evidence.baselineOwnership.after[0].ownership.partitionLossCount = 3
  assert.equal(evaluatePostureEpisode(evidence, rehearsalConfig(), 'soak').status, 'RED')
})

test('G4-7 preserves last actual writer time through normalization and all episode summaries', () => {
  const { evidence } = rehearsalEpisode()
  for (const row of evidence.baselineResults) { row.editCompletedAt = 4_000; row.convergedAt = 4_100 }
  const values = evidence.baselineResults.map(convergedResult)
  assert.equal(values[0].lastWriteCompletedAt, 1_000)
  assert.equal(values[1].lastWriteCompletedAt, null)
  assert.equal(summarizeCycleConvergence(values)[0].convergenceMs, 3_100)
  delete values[1].lastWriteCompletedAt
  assert.equal(summarizeCycleConvergence(values)[0].convergenceMs, Infinity)
})

test('G4-7 failover requires an actual writer inside the acknowledged pause interval', () => {
  const { evidence, takeover } = rehearsalEpisode(2, 'failover')
  assert.equal(evaluatePostureEpisode(evidence, rehearsalConfig(), 'failover', takeover).status, 'PASS')
  takeover.startedAt = 1_001
  assert.equal(evaluatePostureEpisode(evidence, rehearsalConfig(), 'failover', takeover).status, 'VOID')
})

test('G4-7 receives convergence before child close and a slow freshness result', () => {
  let time = 1_000
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {}, wall: () => time, monotonic: () => time })
  const rows = rehearsalEpisode().evidence.baselineResults
  rows[7].convergedAt = 4_000
  const tracker = createLoadOutputTracker(row => recorder.received({ ...row, receivedAt: time }, 'soak', 1))
  time = 4_010
  for (const row of rows) {
    const raw = { ...row }; delete raw.childProcess
    const line = `QARESULT ${JSON.stringify(raw)}\n`
    tracker.push(line.slice(0, 17)); tracker.push(line.slice(17))
  }
  assert.equal(recorder.firstFailure.criterion, 'convergence')
  assert.equal(recorder.firstFailure.value, 3_000)
  assert.equal(recorder.firstFailure.convergedAt, 4_000)
  assert.equal(recorder.firstFailure.observedAt, 4_010)
  time = 5_000
  recorder.sample(rehearsalSnapshots(150), { phase: 'soak', cycle: 1 })
  assert.equal(recorder.firstFailure.criterion, 'convergence', 'later diagnostics cannot overtake an already received result')
  assert.equal(recorder.episodes.length, 0, 'stdout reception does not qualify natural exit or an episode')
})

test('G4-7 an established partition failure does not wait for the other partition', () => {
  let time = 1_000
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {}, wall: () => time, monotonic: () => time })
  const rows = rehearsalEpisode().evidence.baselineResults
  rows[0].convergedAt = 4_100
  time = 5_000
  recorder.received(rows[0], 'soak', 1)
  assert.equal(recorder.firstFailure.criterion, 'convergence')
  assert.equal(recorder.firstFailure.partition, 0)
  time = 10_000
  recorder.sample(rehearsalSnapshots(101), { phase: 'soak', cycle: 1 })
  time = 20_000
  for (const row of rows.slice(1)) recorder.received(row, 'soak', 1)
  assert.equal(recorder.firstFailure.observedAt, 5_000)
  assert.equal(recorder.failures.filter(event => event.criterion === 'convergence').length, 1)
})

test('G4-7 malformed early JSON becomes VOID evidence without throwing from stdout', () => {
  for (const malformed of [null, {}, { values: null }, { values: 7 }]) {
    const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
    const rows = rehearsalEpisode().evidence.baselineResults
    rows[0].localOwnFieldsAfterEdit = [malformed]
    const tracker = createLoadOutputTracker(row => recorder.received(row, 'baseline', 0))
    assert.doesNotThrow(() => {
      for (const row of rows) tracker.push(`QARESULT ${JSON.stringify(row)}\n`)
    })
    assert.ok(recorder.invalid.some(event => /malformed early/.test(event.reason)))
  }
})

test('G4-7 sampler serializes pause and exactly one drain before counting the former owner again', async () => {
  const cells = rehearsalSnapshots().map(row => ({ service: row.service }))
  const reads = []
  let unblock
  let first = true
  const sampler = new RehearsalSampler(cells, async cell => {
    reads.push(cell.service)
    if (first && cell.service === cells[0].service) {
      first = false
      await new Promise(resolve => { unblock = resolve })
    }
    return rehearsalSnapshots()[cells.findIndex(row => row.service === cell.service)]
  })
  const events = []
  const firstSample = sampler.collect((rows, context) => events.push({ rows, context }))
  await Promise.resolve()
  const held = sampler.hold(cells[0].service)
  assert.equal(sampler.unavailableService, null)
  unblock()
  await firstSample; await held
  assert.equal(events[0].context.unavailableService, null)
  await sampler.collect((rows, context) => events.push({ rows, context }))
  assert.equal(reads.filter(service => service === cells[0].service).length, 1, 'no request can consume a paused owner window')
  assert.equal(events[1].rows[0].intentionallyUnavailable, true)
  await sampler.resume(cells[0].service)
  assert.equal(reads.filter(service => service === cells[0].service).length, 2, 'one drain only')
  assert.equal(events[1].context.unavailableService, cells[0].service, 'resume cannot reclassify a previous collection')
  await sampler.collect((rows, context) => events.push({ rows, context }))
  assert.equal(reads.filter(service => service === cells[0].service).length, 3)
  assert.deepEqual(events[2].context.excludedEventLoopServices, [])
})

test('D57 calibration cannot equate two absent process identities or ignore the replacement generation', () => {
  const before = rehearsalSnapshots()[2]
  const after = structuredClone(before)
  const replacement = { service: before.service, state: structuredClone(before.ownership) }
  const expected = rehearsalConfig().topologyBuild.expectedTopology
  assert.equal(freshnessIdentityValid(before, after, replacement, expected), true)
  for (const mutation of [
    (b, a) => { delete b.stats.processBootId; delete a.stats.processBootId },
    (b, a, r) => { b.ownership.cellId = a.ownership.cellId = r.state.cellId = '' },
    (b, a, r) => { r.state.effectiveGeneration = 'another-generation' },
    (b, a) => { a.service = 'sync-cell-a' },
  ]) {
    const b = structuredClone(before), a = structuredClone(after), r = structuredClone(replacement)
    mutation(b, a, r)
    assert.equal(freshnessIdentityValid(b, a, r, expected), false)
  }
})

test('G4-7 first crossing survives later larger peaks and equality is a crossing', () => {
  let time = 1_000
  const journal = []
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish: event => journal.push(event), wall: () => time, monotonic: () => time })
  recorder.sample(rehearsalSnapshots(99.999), { phase: 'baseline', cycle: 0 })
  assert.equal(recorder.firstFailure, null)
  time = 1_500
  recorder.sample(rehearsalSnapshots(100, 2), { phase: 'baseline', cycle: 0 })
  time = 2_000
  for (let i = 0; i < 13; i++) recorder.sample(rehearsalSnapshots(150 + i, 3 + i), { phase: 'soak', cycle: i + 1 })
  assert.equal(recorder.firstFailure.criterion, 'event-loop')
  assert.equal(recorder.firstFailure.value, 100)
  assert.equal(recorder.firstFailure.observedAt, 1_500)
  assert.equal(recorder.firstFailure.elapsedMs, 500)
  assert.equal(journal[2].kind, 'criterion-failed', 'the first crossing is published immediately after the opening and first sample')
  assert.equal(recorder.maxEventLoopP99MsByService['sync-cell-a'], 162)
})

test('G4-7 a later unexcluded sample of the former owner counts again', () => {
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
  const snapshots = rehearsalSnapshots(20)
  snapshots[0].stats.transport.eventLoopDelayMs.p99 = 5_000
  recorder.sample([snapshots[0]], { phase: 'failover', cycle: 0, drainService: 'sync-cell-a', excludedEventLoopServices: ['sync-cell-a'] })
  assert.equal(recorder.firstFailure, null)
  snapshots[0].stats.transport.eventLoopDelayMs.p99 = 150
  snapshots[0].stats.transport.eventLoopWindow.resetCount = 2
  recorder.sample(snapshots, { phase: 'soak', cycle: 1 })
  assert.equal(recorder.firstFailure.service, 'sync-cell-a')
  assert.equal(recorder.firstFailure.value, 150)
})

test('G4-7 incomplete samples and resets are VOID instead of zero', () => {
  for (const [mutate, expectedReason] of [
    [rows => { rows.pop() }, 'incomplete sample cell census'],
    [rows => { delete rows[0].stats.processBootId }, 'missing or invalid sample facts'],
    [rows => { rows[0].stats.transport.eventLoopDelayMs.p99 = NaN }, 'missing or invalid sample facts'],
    [rows => { rows[0].ownership.partitionLossCount = 0 }, 'counter reset during rehearsal'],
    [rows => { delete rows[0].ownership.storageFence.rejectedMutationCount }, 'missing or invalid sample facts'],
  ]) {
    const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
    const rows = rehearsalSnapshots()
    rows[0].ownership.partitionLossCount = 1
    recorder.sample(rows, { phase: 'baseline', cycle: 0 })
    assert.equal(recorder.invalid.length, 0)
    rows.forEach(row => { row.stats.transport.eventLoopWindow = rehearsalSnapshots(20, 2)[0].stats.transport.eventLoopWindow })
    mutate(rows)
    recorder.sample(rows, { phase: 'soak', cycle: 1 })
    assert.ok(recorder.invalid.some(event => event.reason === expectedReason),
      `expected ${expectedReason}; received ${JSON.stringify(recorder.invalid)}`)
  }
})

test('G4-7 records opening windows and refuses missing, replayed or stolen consumes', () => {
  for (const mutate of [
    rows => { delete rows[0].stats.transport.eventLoopWindow },
    rows => { rows[0].stats.transport.eventLoopWindow.consumer = 'periodic' },
    rows => { rows[0].stats.transport.eventLoopWindow.resetCount = 0 },
    rows => { rows[0].stats.transport.eventLoopWindow.resetCount = 2 },
    rows => { rows[0].stats.transport.eventLoopWindow.lastResetBy = 'periodic-log' },
    rows => { rows[0].stats.transport.eventLoopWindow.startedAt = 'invalid' },
    rows => { rows[0].stats.transport.eventLoopWindow.startedAt = new Date(0).toISOString() },
    rows => { rows[0].stats.processBootId = '99999999-9999-4999-8999-999999999999' },
  ]) {
    const journal = []
    const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish: event => journal.push(event) })
    assert.equal(recorder.invalid.length, 0)
    assert.equal(journal[0].kind, 'event-loop-opening')
    assert.equal(journal[0].windows.length, 3)
    const rows = rehearsalSnapshots()
    mutate(rows)
    recorder.sample(rows, { phase: 'baseline', cycle: 0 })
    assert.ok(recorder.invalid.some(event => event.reason === 'missing or discontinuous event-loop window'))
  }
})

test('G4-7 requires opening consumes and counts the excluded owner drain in its sequence', () => {
  for (const initialSnapshots of [undefined, [], rehearsalSnapshots().slice(1)]) {
    const recorder = new RehearsalObservations({ initialSnapshots, publish() {} })
    assert.ok(recorder.invalid.some(event => event.reason === 'missing opening event-loop window census'))
  }
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
  recorder.sample([rehearsalSnapshots(5_000, 2)[0]], {
    phase: 'failover', cycle: 0, drainService: 'sync-cell-a', excludedEventLoopServices: ['sync-cell-a'],
  })
  assert.equal(recorder.firstFailure, null, 'the deliberate owner pause is not a loop failure')
  assert.ok(recorder.invalid.some(event => event.reason === 'missing or discontinuous event-loop window'), 'a stolen owner window still invalidates the campaign')
})

test('G4-7 refuses a well-formed replay after an accepted consume', () => {
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
  recorder.sample(rehearsalSnapshots(20, 1), { phase: 'baseline', cycle: 0 })
  assert.deepEqual(recorder.invalid, [])
  const next = rehearsalSnapshots(20, 2)
  next[0].stats.transport.eventLoopWindow = rehearsalSnapshots(20, 1)[0].stats.transport.eventLoopWindow
  recorder.sample(next, { phase: 'soak', cycle: 1 })
  assert.deepEqual(recorder.invalid.map(({ reason, service }) => ({ reason, service })), [
    { reason: 'missing or discontinuous event-loop window', service: 'sync-cell-a' },
  ])
})

test('G4-7 cellSnapshot consumes qualification windows by default and leaves diagnostics non-destructive', async () => {
  const fixtures = rehearsalSnapshots(20, 0)
  const nextCount = new Map(fixtures.map(row => [row.service, 0]))
  const read = async url => {
    const { hostname, pathname, searchParams } = new URL(url)
    const row = structuredClone(fixtures.find(entry => entry.service === hostname))
    let body = {}
    if (pathname === '/api/automerge/stats') {
      const consume = searchParams.get('eventLoopWindow') === 'consume'
      const counter = consume ? nextCount.get(hostname) : 0
      row.stats.transport.eventLoopWindow = rehearsalSnapshots(20, counter)[0].stats.transport.eventLoopWindow
      if (consume) nextCount.set(hostname, counter + 1)
      else row.stats.transport.eventLoopWindow.consumer = 'periodic'
      body = row.stats
    } else if (pathname.endsWith('/projector-fleet')) body = row.fleet
    else if (pathname.endsWith('/sync-cell')) body = row.ownership
    return { status: 200, route: null, body }
  }
  const capture = consume => Promise.all(fixtures.map(({ service }) => cellSnapshot(
    { service, baseUrl: `http://${service}` }, 'fixture-cookie', consume, read)))
  const opening = await capture(undefined)
  const recorder = new RehearsalObservations({ initialSnapshots: opening, publish() {} })
  assert.deepEqual(recorder.invalid, [])
  const diagnostics = await capture(false)
  assert.ok(diagnostics.every(row => row.stats.transport.eventLoopWindow.consumer === 'periodic'))
  recorder.sample(await capture(undefined), { phase: 'baseline', cycle: 0 })
  assert.deepEqual(recorder.invalid, [])
  assert.deepEqual([...nextCount.values()], [2, 2, 2])
})

test('G4-7 cannot exempt a live cell from the loop budget using unavailableService', () => {
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
  recorder.sample(rehearsalSnapshots(150), { phase: 'soak', cycle: 1,
    unavailableService: 'sync-cell-a', excludedEventLoopServices: ['sync-cell-a'] })
  assert.ok(recorder.invalid.some(event => event.reason === 'incomplete sample cell census'))
})

test('G4-7 sampler and recorder preserve contiguous windows across hold, drain and resume', async () => {
  const initial = rehearsalSnapshots(20, 0)
  const counts = new Map(initial.map(row => [row.service, 1]))
  const recorder = new RehearsalObservations({ initialSnapshots: initial, publish() {} })
  const sampler = new RehearsalSampler(initial.map(({ service }) => ({ service })), async ({ service }) => {
    const count = counts.get(service)
    counts.set(service, count + 1)
    return rehearsalSnapshots(20, count).find(row => row.service === service)
  })
  const observe = (rows, context) => recorder.sample(rows, { phase: 'failover', cycle: 0, ...context })
  await sampler.collect(observe)
  await sampler.hold('sync-cell-a')
  await sampler.collect(observe)
  await sampler.collect(observe)
  const drained = await sampler.resume('sync-cell-a')
  observe([drained], { drainService: 'sync-cell-a', excludedEventLoopServices: ['sync-cell-a'] })
  await sampler.collect(observe)
  assert.deepEqual(recorder.invalid, [])
  assert.equal(recorder.firstFailure, null)
  assert.deepEqual(recorder.loopWindowCounts, { 'sync-cell-a': 4, 'sync-cell-b': 5, 'sync-cell-c': 5 })
})

test('G4-7 owner drain excludes only loop p99 and preserves transient guard failures', () => {
  const snapshots = rehearsalSnapshots()
  const metrics = new MetricsAccumulator(snapshots)
  metrics.excludeEventLoopService('sync-cell-a')
  const drained = structuredClone(snapshots[0])
  drained.stats.transport.eventLoopDelayMs.p99 = 5_000
  drained.fleet.foreignResidentProjectors = 1
  drained.stats.synchronizer = { retiredDocuments: { overLimit: true, count: 2_000 } }
  metrics.record([drained], null, true)
  assert.equal(metrics.maxForeignResidentProjectors, 1)
  assert.equal(metrics.retiredDocumentLimitExceeded, true)
  assert.equal(metrics.maxRetiredDocuments, 2_000)
  assert.equal(metrics.samples, 0)
  assert.equal(metrics.partialSamples, 1)
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
  recorder.sample([drained], { phase: 'failover', cycle: 0, drainService: 'sync-cell-a', excludedEventLoopServices: ['sync-cell-a'] })
  assert.equal(recorder.invalid.length, 0)
  assert.equal(recorder.firstFailure.criterion, 'qualification')
  assert.equal(recorder.maxEventLoopP99MsByService['sync-cell-a'], 0)
  assert.equal(recorder.peakActiveConnections, 0, 'a single-cell diagnostic is not a simultaneous fleet census')
})

test('G4-7 requires actual duration for PASS and a complete cycle even for an early FAIL', () => {
  const final = { freshness: { valid: true, freshAfterTakeoverMs: 1_200 }, calibration: { valid: true, freshAfterTakeoverMs: 200 } }
  for (const [actualSoakMs, fail, addCycle, expected] of [
    [7_200_000, false, true, 'PASS'], [7_199_999, false, true, 'VOID'],
    [10_000, true, true, 'FAIL'], [10_000, true, false, 'VOID'], [NaN, true, true, 'VOID'],
  ]) {
    const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
    recorder.sample(rehearsalSnapshots(), { phase: 'baseline', cycle: 0 })
    recorder.episode(rehearsalEpisode(100, 'baseline').record, 'baseline', 0)
    recorder.episode(rehearsalEpisode(101, 'failover').record, 'failover', 0)
    if (addCycle) recorder.episode(rehearsalEpisode().record, 'soak', 1)
    if (fail) recorder.fail('takeover', 2_000, { phase: 'failover', cycle: 0 })
    const result = recorder.finish({ ...final, actualSoakMs })
    assert.equal(result.status, expected)
    assert.equal(result.durationCompleted, actualSoakMs >= 7_200_000)
  }
})

test('G4-7 duplicate episode and invalid 5/12000 calibration cannot qualify', () => {
  const recorder = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
  recorder.sample(rehearsalSnapshots(), { phase: 'baseline', cycle: 0 })
  recorder.episode(rehearsalEpisode().record, 'soak', 1)
  recorder.episode(rehearsalEpisode().record, 'soak', 2)
  assert.ok(recorder.invalid.some(event => /reused/.test(event.reason)))
  for (const [small, large] of [[500, 1_000], [499, 999]]) {
    const candidate = new RehearsalObservations({ initialSnapshots: rehearsalSnapshots(20, 0), publish() {} })
    candidate.sample(rehearsalSnapshots(), { phase: 'baseline', cycle: 0 })
    candidate.episode(rehearsalEpisode().record, 'soak', 1)
    assert.equal(candidate.finish({ actualSoakMs: 7_200_000,
      calibration: { valid: true, freshAfterTakeoverMs: small }, freshness: { valid: true, freshAfterTakeoverMs: large } }).status, 'VOID')
  }
})

test('D57 dates readiness before slow unpause and starts freshness without waiting for it', async () => {
  let time = 1_000
  const order = []
  const result = await measureTakeover({ originalService: 'sync-cell-a', wall: () => time, monotonic: () => time,
    pause: async () => { order.push('pause'); time = 1_100 },
    replacement: async () => { order.push('ready'); time = 2_100; return { service: 'sync-cell-c', state: { ready: true, partitionReady: true, partitionIndex: 0 } } },
    fresh: async takeover => { order.push('fresh'); assert.equal(takeover.completedAt, 2_100); return { at: time } },
    unpause: async () => { order.push('unpause'); time = 9_000 },
  })
  assert.deepEqual(order, ['pause', 'ready', 'fresh', 'unpause'])
  assert.equal(result.takeover.takeoverMs, 1_000)
  assert.equal(result.takeover.completedAt, 2_100)
  assert.equal(result.freshness.at, 2_100)
  assert.equal(result.takeover.unpauseCompletedAt, 9_000)
})

test('D57 attempts unpause even when the pause command performed work then failed', async () => {
  let resumed = 0
  await assert.rejects(measureTakeover({ originalService: 'sync-cell-a',
    pause: async () => { throw new Error('pause command lost its response') },
    unpause: async () => { resumed++ },
  }), /lost its response/)
  assert.equal(resumed, 1)
})

test('D57 HTTP200 must prove the exact workspace, direct owner and fresh marker', () => {
  const workspace = { landscapeId: 'L', versionId: 'V' }
  const response = { status: 200, route: 'owner', body: { ...workspace, absenceProvable: true, objects: { a: { name: 'this-seed' } } } }
  const expected = { a: { name: 'this-seed' } }
  assert.equal(isFreshWitness(response, workspace, expected), true)
  for (const mutate of [
    row => { row.route = 'proxied' }, row => { row.body.versionId = 'old' },
    row => { row.body.absenceProvable = false }, row => { row.body.objects.a.name = 'old-seed' },
    row => { delete row.body.objects.a }, row => { row.status = 503 },
  ]) { const changed = structuredClone(response); mutate(changed); assert.equal(isFreshWitness(changed, workspace, expected), false) }
  assert.equal(isFreshWitness(response, workspace, {}), false)
})

test('T-POST keeps a measured loss RED when the spare takes over its partition', () => {
  const baseline = postureEvidence()
  Object.assign(baseline.baselineOwnership.after[0].ownership, {
    partitionLossCount: 1, partitionIndex: null, ready: false, partitionReady: false,
  })
  Object.assign(baseline.baselineOwnership.after[2].ownership, {
    partitionIndex: 0, ready: true, partitionReady: true,
  })
  const record = evaluatePostureBaseline(baseline, postureConfig())
  assert.equal(record.status, 'RED', JSON.stringify(record.reasons))
  assert.equal(record.criteria.partitionLossCountZero, false)
})

test('T-POST refuses an unexplained transfer even when another partition has a measured loss', () => {
  for (const unrelatedLoss of [false, true]) {
    const baseline = postureEvidence()
    if (unrelatedLoss) baseline.baselineOwnership.after[0].ownership.partitionLossCount = 1
    Object.assign(baseline.baselineOwnership.after[1].ownership, {
      partitionIndex: null, ready: false, partitionReady: false,
    })
    Object.assign(baseline.baselineOwnership.after[2].ownership, {
      partitionIndex: 1, ready: true, partitionReady: true,
    })
    const record = evaluatePostureBaseline(baseline, postureConfig())
    assert.equal(record.status, 'VOID')
    assert.ok(record.reasons.some((reason) => reason.includes('authority changed without a measured partition loss')))
  }
})

test('T-POST reader-only cohorts cannot move the origin past the last writer', () => {
  const baseline = postureEvidence()
  const lateReader = baseline.baselineResults.find((entry) => entry.partition === 0 && entry.cohort === 3)
  lateReader.editCompletedAt = 4_500
  lateReader.convergedAt = 4_700
  withWorkerEvidence(lateReader)
  // The historical formula would publish 200 ms. The writer really finished
  // at 1000, so the last reader required 3700 ms; only the new baseline claims it.
  assert.equal(summarizeCycleConvergence(baseline.baselineResults)[0].convergenceMs, 3_700)
  const record = evaluatePostureBaseline(baseline, postureConfig())
  assert.equal(record.status, 'RED')
  assert.equal(record.convergence.p99Ms, 3_700)
  assert.equal(record.convergence.partitions[0].editCompletedAt, 1_000)
})

test('T-POST baseline threshold is strictly less than 3000 ms', () => {
  for (const [duration, expected] of [[2_999, 'PASS'], [3_000, 'RED'], [3_001, 'RED']]) {
    const baseline = postureEvidence()
    baseline.baselineResults[0].convergedAt = 1_000 + duration
    withWorkerEvidence(baseline.baselineResults[0])
    assert.equal(evaluatePostureBaseline(baseline, postureConfig()).status, expected)
  }
})

test('T-POST starts convergence at the actual last write before the final round delay', () => {
  const baseline = postureEvidence()
  baseline.baselineResults[0].editCompletedAt = 1_400
  baseline.baselineResults[0].convergedAt = 4_100
  withWorkerEvidence(baseline.baselineResults[0])
  assert.equal(summarizeCycleConvergence(baseline.baselineResults)[0].convergenceMs, 3_100)
  const record = evaluatePostureBaseline(baseline, postureConfig())
  assert.equal(record.status, 'RED')
  assert.equal(record.convergence.p99Ms, 3_100)
})

test('T-POST refuses profile, load-shape and budget deviations instead of overwriting them', () => {
  const env = { SYNC_BENCH_POSTURE: 'shipped', SYNC_LOAD_PROFILE: 'fleet' }
  assert.equal(parseLoadSoakConfig(env, []).benchPosture, 'shipped')
  assert.equal(parseLoadSoakConfig({ ...env, SYNC_BENCH_POSTURE: 'bench' }, []).benchPosture, 'bench')
  assert.throws(() => parseLoadSoakConfig({ ...env, SYNC_BENCH_POSTURE: 'demo' }, []), /must be bench or shipped/)
  for (const override of [
    { SYNC_FAILOVER_PARTITION_COUNT: '1' },
    { SYNC_LOAD_PROFILE: 'contention' }, { SYNC_LOAD_USERS_PER_WORKSPACE: '50' },
    { SYNC_LOAD_WRITERS_PER_WORKSPACE: '5' }, { SYNC_LOAD_OBJECTS: '5' },
    { SYNC_LOAD_OBJECT_ASSIGNMENT: 'shared' }, { SYNC_LOAD_CLIENTS_PER_PROCESS: '20' },
    { SYNC_LOAD_NORMAL_CONVERGENCE_MS: '3001' }, { SYNC_LOAD_FAILOVER_CONVERGENCE_MS: '3001' },
    { SYNC_LOAD_TAKEOVER_MS: '2001' }, { SYNC_LOAD_MAX_EVENT_LOOP_P99_MS: '101' },
    { SYNC_LOAD_ROUNDS: '1' }, { SYNC_LOAD_SAMPLE_MS: '1000' },
    { SYNC_LOAD_MAX_SYNCHRONIZER_PEER_BINDINGS: '301' },
  ]) assert.throws(() => parseLoadSoakConfig({ ...env, ...override }, []), /T-POST qualification configuration refused/)
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_PROFILE: 'fleet', SYNC_LOAD_USERS_PER_WORKSPACE: '50' }, []).usersPerWorkspace, 50)
})

test('T-POST treats admission losses, counter resets and broken process identity as VOID', () => {
  const mutations = [
    (value) => { value.baselineOwnership.before[0].ownership.partitionLossCount = 1; value.baselineOwnership.after[0].ownership.partitionLossCount = 1 },
    (value) => { value.baselineOwnership.before[2].ownership.partitionLossCount = 1 },
    (value) => { value.baselineOwnership.after[0].ownership.partitionLossCount = Number.NaN },
    (value) => { delete value.baselineOwnership.after[0].ownership.partitionLossCount },
    (value) => { value.baselineOwnership.after[0].processBootIdBefore = '00000000-0000-4000-8000-000000000099'; value.baselineOwnership.after[0].processBootIdAfter = value.baselineOwnership.after[0].processBootIdBefore },
    (value) => { value.baselineOwnership.after[0].processBootIdAfter = '00000000-0000-4000-8000-000000000099' },
    (value) => { value.baselineOwnership.before[0].processBootIdBefore = '' },
    (value) => { value.baselineOwnership.after.pop() },
    (value) => { value.baselineOwnership.after[1] = value.baselineOwnership.after[0] },
    (value) => { value.baselineOwnership.after[0].ownership.topologyGeneration = 'other' },
    (value) => { value.baselineOwnership.after[0].ownership.cellId = 'another-cell' },
    (value) => { value.baselineOwnership.before[0].ownership.ready = false },
  ]
  for (const mutate of mutations) {
    const baseline = postureEvidence()
    mutate(baseline)
    const record = evaluatePostureBaseline(baseline, postureConfig())
    assert.equal(record.status, 'VOID', JSON.stringify(record))
    assert.equal(record.criteria.partitionLossCountZero, null)
  }
})

test('T-POST cannot qualify partial cohorts, changed profile, timestamps or signalled children', () => {
  for (const mutate of [
    (value) => { value.baselineResults.pop() },
    (value) => { value.baselineResults[1] = value.baselineResults[0] },
    (value) => { value.baselineResults[0].users = 2 },
    (value) => { value.baselineResults[0].writers = 1 },
    (value) => { value.baselineResults[0].cohortWriters = 0 },
    (value) => { value.baselineResults[0].editCompletedAt = Number.NaN },
    (value) => { delete value.baselineResults[0].lastWriteCompletedAt },
    (value) => { value.baselineResults[0].lastWriteCompletedAt = 1_001 },
    (value) => { value.baselineResults[1].lastWriteCompletedAt = 1_000 },
    (value) => { value.baselineResults[0].convergedAt = 499 },
    (value) => { value.baselineResults[0].childProcess = { exitCode: null, signal: 'SIGTERM' } },
    (value) => { value.baselineResults[0].childProcess = { exitCode: 1, signal: 'SIGTERM' } },
    (value) => { delete value.baselineResults[0].childProcess },
    (value) => { value.baselineResults[0].childProcess.exitCode = 1 },
  ]) {
    const baseline = postureEvidence()
    mutate(baseline)
    assert.equal(evaluatePostureBaseline(baseline, postureConfig()).status, 'VOID')
  }
})

test('T-POST natural client failure preserves a measured loss as RED, not a cleanup error', async () => {
  const baseline = postureEvidence()
  baseline.baselineOwnership.after[0].ownership.partitionLossCount = 1
  Object.assign(baseline.baselineResults[0], {
    childProcess: { exitCode: 1, signal: null }, fullyConverged: false,
    missingFields: 1, clientsConverged: 24, convergedAt: 46_000,
  })
  withWorkerEvidence(baseline.baselineResults[0])
  const failure = new Error('a natural load child reported non-convergence')
  failure.baselineResults = baseline.baselineResults
  const published = []
  await assert.rejects(runPostureBaseline(postureConfig(), {
    before: baseline.baselineOwnership.before,
    load: async () => { throw failure },
    collectAfter: async () => baseline.baselineOwnership.after,
    collectAdmission: () => baseline.baselineAdmission,
    publish: (record) => published.push(record),
  }), /T-POST baseline RED/)
  assert.equal(published.length, 1)
  assert.equal(published[0].criteria.partitionLossCountZero, false)
  assert.equal(published[0].baselineError, failure.message)
})

test('T-POST collects the final baseline and publishes before any subsequent operation', async () => {
  const baseline = postureEvidence()
  const order = []
  const record = await runPostureBaseline(postureConfig(), {
    before: baseline.baselineOwnership.before,
    load: async () => { order.push('load'); return baseline.baselineResults },
    collectAfter: async () => { order.push('after'); return baseline.baselineOwnership.after },
    collectAdmission: () => baseline.baselineAdmission,
    publish: () => order.push('publish'),
  })
  order.push('failover')
  assert.deepEqual(order, ['load', 'after', 'publish', 'failover'])
  assert.equal(record.status, 'PASS')
  await assert.rejects(completeQualificationCleanup(async () => { throw new Error('cleanup failed') }, null), /cleanup failed/)
  assert.equal(record.status, 'PASS', 'later cleanup does not rewrite the measured baseline')
})

test('T-POST read failure and child spawn failure publish VOID, never RED', async () => {
  for (const broken of ['read', 'child']) {
    const baseline = postureEvidence()
    const records = []
    await assert.rejects(runPostureBaseline(postureConfig(), {
      before: baseline.baselineOwnership.before,
      load: async () => { if (broken === 'child') throw new Error('spawn error'); return baseline.baselineResults },
      collectAfter: async () => { if (broken === 'read') throw new Error('read error'); return baseline.baselineOwnership.after },
      collectAdmission: () => baseline.baselineAdmission,
      publish: (record) => records.push(record),
    }), /T-POST baseline VOID/)
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'VOID')
    assert.equal(records[0].criteria.partitionLossCountZero, null)
  }
})

test('T-POST brackets ownership with process identity reads in the actual call order', async () => {
  const calls = []
  const [expected] = postureOwnership()
  const records = await collectBaselineOwnership([{ service: expected.service, baseUrl: 'http://fixture' }], 'cookie', async (url) => {
    calls.push(url)
    return { status: 200, body: url.endsWith('/sync-cell') ? expected.ownership : { processBootId: expected.processBootIdBefore } }
  })
  assert.deepEqual(calls.map((url) => url.split('/').at(-1)), ['stats', 'sync-cell', 'stats'])
  assert.equal(records[0].processBootIdBefore, expected.processBootIdBefore)
  assert.equal(records[0].processBootIdAfter, expected.processBootIdAfter)
  assert.deepEqual(records[0].ownership, expected.ownership)
  const failed = await collectBaselineOwnership([{ service: expected.service, baseUrl: 'http://fixture' }], 'cookie', async () => { throw new Error('offline') })
  assert.equal(failed[0].readError, 'offline')
  assert.equal(failed[0].ownership, null)
})

test('G4-7 refuses a routed fleet response while retaining local stats and routing provenance', async () => {
  const localFleet = { residentProjectors: 0, inFlightWorkspaces: 0, foreignResidentProjectors: 0 }
  for (const route of [null, 'owner', 'proxied', undefined]) {
    const calls = []
    const snapshot = await cellSnapshot({ service: 'sync-cell-c', baseUrl: 'http://reserve' }, 'cookie', false, async url => {
      calls.push(url)
      if (url.endsWith('/projector-fleet')) return { status: 200, route, body: localFleet }
      return { status: 200, route: null, body: { local: true } }
    })
    assert.deepEqual(snapshot.stats, { local: true })
    assert.deepEqual(snapshot.ownership, { local: true })
    assert.equal(snapshot.fleet, route === null ? localFleet : null)
    assert.equal(snapshot.diagnosticRoutes.fleet, route)
    assert.equal(calls.length, 4)
    assert.ok(calls.every(url => url.startsWith('http://reserve/')))
    assert.ok(calls.every(url => !url.includes('eventLoopWindow=consume')))
  }
})

test('T-POST barrier requires all eight ready cohorts and 100 connections on each owner before admission', async () => {
  const admission = postureAdmission()
  const processes = admission.cohorts.map((entry) => ({ partition: entry.partition, cohort: entry.cohort, barrier: { ready: entry, error: null } }))
  let releases = 0
  const releasable = (entries) => entries.map((entry) => ({ ...entry, releaseBaseline: async () => { releases += 1 } }))
  const snapshots = admission.cells.map((entry) => ({
    service: entry.service, ownership: entry.ownership,
    stats: { processBootId: entry.processBootId, transport: { connections: { active: entry.activeConnections } } },
  }))
  assert.ok(baselineBarrierAdmission(admission.barrierId, processes, snapshots))
  const unready = structuredClone(processes)
  unready[7].barrier.ready = null
  assert.equal(baselineBarrierAdmission(admission.barrierId, unready, snapshots), null)
  assert.equal(await releaseBaselineIfAdmitted(admission.barrierId, releasable(unready), snapshots), null)
  assert.equal(releases, 0)
  snapshots[1].stats.transport.connections.active = 99
  assert.equal(baselineBarrierAdmission(admission.barrierId, processes, snapshots), null, '199 is not an admitted fleet')
  assert.equal(await releaseBaselineIfAdmitted(admission.barrierId, releasable(processes), snapshots), null)
  assert.equal(releases, 0)
  snapshots[1].stats.transport.connections.active = 100
  assert.ok(await releaseBaselineIfAdmitted(admission.barrierId, releasable(processes), snapshots))
  assert.equal(releases, 8, 'the production release helper releases every held cohort only after admission')
  snapshots[0].stats.transport.connections.active = 101
  assert.equal(baselineBarrierAdmission(admission.barrierId, processes, snapshots), null, 'a stray connection is not silently included')
})

test('T-POST requires admission facts and the same barrier before every cohort edit', () => {
  for (const mutate of [
    (value) => { delete value.baselineAdmission },
    (value) => { value.baselineAdmission.cells[0].activeConnections = 99 },
    (value) => { value.baselineAdmission.cohorts.pop() },
    (value) => { value.baselineAdmission.cells[0].processBootId = 'other-process' },
    (value) => { value.baselineAdmission.releaseCompletedAt = null },
    (value) => { value.baselineResults[0].baselineBarrier.barrierId = 'another-episode' },
    (value) => { value.baselineResults[0].baselineBarrier.releasedAt = 600 },
  ]) {
    const baseline = postureEvidence()
    mutate(baseline)
    assert.equal(evaluatePostureBaseline(baseline, postureConfig()).status, 'VOID')
  }
})

test('T-G4 mints a fresh release nonce only after complete admission and target revalidation', async () => {
  const fixture = postureAdmission()
  const order = []
  const received = []
  const processes = fixture.cohorts.map(entry => ({
    partition: entry.partition, cohort: entry.cohort, barrier: { ready: entry, error: null },
    releaseBaseline: async nonce => { order.push('release'); received.push(nonce) },
  }))
  const snapshots = fixture.cells.map(entry => ({
    service: entry.service, ownership: entry.ownership,
    stats: { processBootId: entry.processBootId, transport: { connections: { active: entry.activeConnections } } },
  }))
  const mint = () => { order.push('mint'); return postureReleaseNonce }
  snapshots[0].stats.transport.connections.active = 99
  assert.equal(await releaseBaselineIfAdmitted(fixture.barrierId, processes, snapshots, async () => { order.push('qualify') }, mint), null)
  assert.deepEqual(order, [], 'an incomplete fleet cannot even mint a release nonce')
  snapshots[0].stats.transport.connections.active = 100
  await assert.rejects(releaseBaselineIfAdmitted(fixture.barrierId, processes, snapshots,
    async () => { order.push('qualify-failed'); throw new Error('target changed') }, mint), /target changed/)
  assert.deepEqual(order, ['qualify-failed'], 'failed revalidation cannot mint or send a nonce')
  order.length = 0
  const admission = await releaseBaselineIfAdmitted(fixture.barrierId, processes, snapshots,
    async () => { order.push('qualify'); return fixture.topologyTargets }, mint)
  assert.deepEqual(order, ['qualify', 'mint', ...Array(8).fill('release')])
  assert.deepEqual(received, Array(8).fill(admission.releaseNonce))
  assert.equal(admission.releaseNonce, postureReleaseNonce)
  for (const invalid of [undefined, 'not-a-uuid', fixture.barrierId]) {
    await assert.rejects(releaseBaselineIfAdmitted(fixture.barrierId, processes, snapshots, null, () => invalid), /separate UUID nonce/)
  }
  assert.equal(received.length, 8, 'malformed release nonces never reach the children')
  const first = await releaseBaselineIfAdmitted(fixture.barrierId, processes, snapshots)
  const second = await releaseBaselineIfAdmitted(fixture.barrierId, processes, snapshots)
  assert.notEqual(first.releaseNonce, second.releaseNonce, 'the real producer cannot reuse a prior admission nonce')
  assert.notEqual(first.releaseNonce, fixture.barrierId)
})

test('T-G4 requires the current causal receipt even when parent and child wall clocks differ', () => {
  const healthy = postureEvidence()
  // A real -1 ms shape: the child's releasedAt/editStartedAt one millisecond
  // before the parent's releaseStartedAt. The receipt, not the clocks, proves
  // release; a record without the receipt stays VOID.
  healthy.baselineResults[0].baselineBarrier.releasedAt = healthy.baselineAdmission.releaseStartedAt - 1
  healthy.baselineResults[0].editStartedAt = healthy.baselineResults[0].baselineBarrier.releasedAt
  assert.equal(evaluatePostureBaseline(healthy, postureConfig()).status, 'PASS')
  const oldNonce = 'ed9c2e6e-7544-4c64-95ef-bb6bf8a205c6'
  for (const mutate of [
    row => { delete row.baselineAdmission.releaseNonce },
    row => { row.baselineAdmission.releaseNonce = row.baselineAdmission.barrierId },
    row => { delete row.baselineResults[0].baselineBarrier.releaseNonce },
    row => { row.baselineResults[0].baselineBarrier.releaseNonce = 'not-a-uuid' },
    row => { row.baselineResults[0].baselineBarrier.releaseNonce = oldNonce },
    row => { row.baselineResults[0].baselineBarrier.barrierId = oldNonce },
    row => { row.baselineResults[0].editStartedAt = row.baselineResults[0].baselineBarrier.releasedAt - 1 },
  ]) {
    const changed = structuredClone(healthy)
    mutate(changed)
    const record = evaluatePostureBaseline(changed, postureConfig())
    assert.equal(record.status, 'VOID')
    assert.ok(record.invalid.some(reason => /admitted 200-client fleet|acknowledge this barrier release/.test(reason)), JSON.stringify(record.invalid))
    assert.equal(record.failures.length, 0, 'the mutant changes only the barrier evidence')
  }
})

test('starts distributed convergence after the final cohort has finished writing', () => {
  const results = [
    result(3_200, 0, 0, 1_000),
    result(2_500, 0, 1, 1_700),
    result(2_900, 1, 0, 1_200),
    result(2_400, 1, 1, 1_700),
  ]
  assert.deepEqual(summarizeCycleConvergence(results), [
    { partition: 0, editCompletedAt: 1_700, convergedAt: 4_200, convergenceMs: 2_500 },
    { partition: 1, editCompletedAt: 1_700, convergedAt: 4_100, convergenceMs: 2_400 },
  ])
})

test('serializes qualification runs and replaces only stale lock owners', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maplespire-sync-gate-test-'))
  const lockPath = join(directory, 'gate.lock')
  try {
    const first = acquireQualificationRunLock('test', {
      lockPath,
      pid: 101,
      isProcessAlive: (pid) => pid === 101,
    })
    assert.throws(() => acquireQualificationRunLock('test', {
      lockPath,
      pid: 202,
      isProcessAlive: (pid) => pid === 101,
    }), /already running.*pid 101/)
    first.release()

    writeFileSync(lockPath, '303:stale-token', 'utf8')
    const replacement = acquireQualificationRunLock('test', {
      lockPath,
      pid: 404,
      isProcessAlive: () => false,
    })
    replacement.release()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('treats only Docker already-unpaused responses as idempotent cleanup', () => {
  assert.equal(isAlreadyUnpausedError({ stderr: 'Error response: Container abc is not paused' }), true)
  assert.equal(isAlreadyUnpausedError(new Error('permission denied')), false)
})

test('uses a run-scoped object prefix so repeated qualifications cannot edit stale CRDT branches', () => {
  assert.equal(
    qualificationObjectPrefix('qa-m0-test-42', 'automerge:4JxY6tF7Qm9zNcV3?overlay=true'),
    'qa-m0-test-42-4JxY6tF7Qm',
  )
})

test('recognizes only run-scoped qualification object ids for cleanup', () => {
  assert.equal(isQualificationObjectId('qa-mes7z1-123-AbCd_12345-4'), true)
  assert.equal(isQualificationObjectId('perf-ob-000004'), false)
  assert.equal(isQualificationObjectId('qa-manual-business-object'), false)
  assert.equal(isQualificationObjectId('qa-mes7z1-123-AbCd_12345'), false)
})

test('tombstones qualification objects from every phase without touching business ids', () => {
  const meta = { deletedObjectIds: ['previous-model-delete'] }
  const original = meta.deletedObjectIds
  const discovered = [
    'qa-mes7z1-123-baseline01-0',
    'qa-mes7z1-123-failover01-0',
    'qa-mes7z1-123-current001-0',
    'business-object',
  ]
  assert.deepEqual(appendQualificationObjectTombstones(meta, discovered), [
    'qa-mes7z1-123-baseline01-0',
    'qa-mes7z1-123-failover01-0',
    'qa-mes7z1-123-current001-0',
  ])
  assert.equal(meta.deletedObjectIds, original)
  assert.deepEqual(meta.deletedObjectIds, [
    'previous-model-delete',
    'qa-mes7z1-123-baseline01-0',
    'qa-mes7z1-123-failover01-0',
    'qa-mes7z1-123-current001-0',
  ])
  assert.deepEqual(appendQualificationObjectTombstones(meta, discovered), [])
})

test('tombstones persist on an Automerge ModelMeta that has NO deletedObjectIds list', async () => {
  // The caller runs inside `metaHandle.change`. `(meta.deletedObjectIds = [])`
  // as a value is the detached literal there, so the pushes used to vanish
  // while the function still returned the ids as appended.
  const A = await import('@automerge/automerge')
  let appended
  const after = A.change(A.from({ marker: 1 }), (meta) => {
    appended = appendQualificationObjectTombstones(meta, ['qa-mes7z1-123-baseline01-0', 'business-object'])
  })
  assert.deepEqual(appended, ['qa-mes7z1-123-baseline01-0'])
  assert.deepEqual([...after.deletedObjectIds], ['qa-mes7z1-123-baseline01-0'])
})

test('summarizes reconnect timing without copying per-peer diagnostic payloads', () => {
  assert.deepEqual(summarizeLoadNetworkDiagnostics([
    {
      connectionHistory: ['owner-a', 'owner-c'],
      connectionTimeline: [{ at: 100, peerId: 'owner-a' }, { at: 500, peerId: 'owner-c' }],
      openTimeline: [{ at: 90 }, { at: 450 }],
      attemptTimeline: [{ at: 80 }, { at: 400 }],
      closeCodes: [1012],
      closeTimeline: [{ at: 300, code: 1012 }],
      sendWhileDisconnected: 2,
    },
    {
      connectionHistory: ['owner-a'],
      connectionTimeline: [{ at: 120, peerId: 'owner-a' }],
      openTimeline: [{ at: 110 }],
      attemptTimeline: [{ at: 105 }],
      closeCodes: [],
      closeTimeline: [],
      sendWhileDisconnected: 0,
    },
  ]), {
    peers: 2,
    connections: 3,
    reconnects: 1,
    closeCodes: { 1012: 1 },
    sendWhileDisconnected: 2,
    firstConnectedAt: 100,
    lastConnectedAt: 500,
    lastOpenedAt: 450,
    lastAttemptedAt: 400,
    lastClosedAt: 300,
  })
})

test('accepts convergent normal, failover and soak phases but does not certify capacity', () => {
  const output = evaluateLoadSoakEvidence(evidence(), config)
  assert.equal(output.outcome, 'passed')
  assert.equal(output.capacityCertified, false)
  assert.equal(output.normalConvergenceP95Ms, 950)
  assert.equal(output.normalConvergenceP99Ms, 950)
  assert.equal(output.failoverConvergenceP95Ms, 8_000)
  assert.equal(output.failoverConvergenceP99Ms, 8_000)
  assert.equal(output.soakCycles, 1)
  assert.equal(output.maxSynchronizerPeerBindings, 20)
  assert.equal(output.maxPeersPerDocument, 10)
})

test('fails on divergence, backpressure, fencing or a foreign projector', () => {
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    failoverResults: [{ ...result(8_000), hotDiverged: 1 }],
  }), config), /diverged/)
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: { ...evidence().metrics, backpressureDisconnectsDelta: 1 },
  }), config), /backpressure/)
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: { ...evidence().metrics, rejectedStorageMutationsDelta: 1, unexpectedStorageFenceRejections: 1 },
  }), config), /fencing/)
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: { ...evidence().metrics, maxForeignResidentProjectors: 1 },
  }), config), /foreign projector/)
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: { ...evidence().metrics, maxRetiredDocuments: 100_001, retiredDocumentLimitExceeded: true },
  }), config), /retired-document tombstones/)
})

test('fails when selective sync binds peers to an amplified resident document set', () => {
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: { ...evidence().metrics, maxSynchronizerPeerBindings: 31 },
  }), config), /selective-sync peer bindings exceeded budget/)
})

test('turns a sampled retired-document threshold crossing into qualification evidence', () => {
  const snapshot = (count, overLimit) => ({
    service: 'sync-cell-a',
    stats: {
      synchronizer: { retiredDocuments: { count, limit: 100, overLimit } },
      transport: {},
    },
    fleet: { foreignResidentProjectors: 0 },
    ownership: { storageFence: {} },
  })
  const accumulator = new MetricsAccumulator([snapshot(99, false)])
  accumulator.record([snapshot(101, true)])
  const metrics = accumulator.summarize([snapshot(101, true)])
  assert.equal(metrics.maxRetiredDocuments, 101)
  assert.equal(metrics.retiredDocumentLimitExceeded, true)
})

test('reports distinct fenced chunks separately from their shared document', () => {
  const snapshot = (storageFence) => ({
    service: 'sync-cell-a',
    stats: { synchronizer: {}, transport: {} },
    fleet: { foreignResidentProjectors: 0 },
    ownership: { storageFence },
  })
  const baseline = snapshot({
    rejectedMutationCount: 0,
    rejectedDocumentCount: 0,
    rejectedMutationIdentityCount: 0,
    repeatedRejectedMutationCount: 0,
    coalescedStaleFenceRetryCount: 0,
    coalescedFenceMismatchCount: 0,
    coalescedStaleFenceRetryCacheSize: 0,
    coalescedStaleFenceRetryEvictions: 0,
    maxCoalescedStaleFenceRetriesPerMutation: 0,
    coalescedOwnershipUnavailableCount: 0,
    coalescedOwnershipUnavailableCacheSize: 0,
    coalescedOwnershipUnavailableEvictions: 0,
    maxCoalescedOwnershipUnavailablePerMutation: 0,
  })
  const final = snapshot({
    rejectedMutationCount: 3,
    rejectedDocumentCount: 1,
    rejectedMutationIdentityCount: 3,
    repeatedRejectedMutationCount: 0,
    coalescedStaleFenceRetryCount: 2,
    coalescedFenceMismatchCount: 1,
    coalescedStaleFenceRetryCacheSize: 1,
    coalescedStaleFenceRetryEvictions: 0,
    maxCoalescedStaleFenceRetriesPerMutation: 1,
    coalescedOwnershipUnavailableCount: 1,
    coalescedOwnershipUnavailableCacheSize: 1,
    coalescedOwnershipUnavailableEvictions: 0,
    maxCoalescedOwnershipUnavailablePerMutation: 1,
    rejectedMutationsByKind: { incremental: 3 },
    rejectedMutationsByReason: { 'fence-mismatch': 3 },
  })
  const accumulator = new MetricsAccumulator([baseline])
  const metrics = accumulator.summarize([final], 'sync-cell-a')

  assert.deepEqual(metrics.rejectedStorageMutationsByService[0], {
    service: 'sync-cell-a',
    count: 3,
    distinctDocuments: 1,
    distinctMutationIdentities: 3,
    repeated: 0,
    coalescedStaleFenceRetries: 2,
    coalescedOwnershipUnavailable: 1,
    coalescedFenceMismatch: 1,
    coalescingCacheSize: 1,
    coalescingEvictions: 0,
    maxCoalescedPerMutation: 1,
    byKind: { incremental: 3 },
    byReason: { 'fence-mismatch': 3 },
  })
})

test('reports convergence and runtime evidence when a budget fails', () => {
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    soakResults: [result(3_500), result(900, 1)],
    takeover: { verified: true, originalService: 'sync-cell-a', replacementService: 'sync-cell-c', takeoverMs: 6_500 },
  }), config), (error) => {
    assert.match(error.message, /normal-load convergence exceeded budget/)
    assert.match(error.message, /"normalP99Ms":3500/)
    assert.match(error.message, /"takeoverMs":6500/)
    assert.match(error.message, /"maxEventLoopP99Ms":32/)
    return true
  })
})

test('fails when takeover exceeds the enterprise objective', () => {
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    takeover: { verified: true, originalService: 'sync-cell-a', replacementService: 'sync-cell-c', takeoverMs: 2_001 },
  }), config), /takeover exceeded budget/)
})

test('accepts the bounded stale-owner in-flight pipeline but rejects an excessive burst', () => {
  const accepted = evaluateLoadSoakEvidence(evidence({
    metrics: {
      ...evidence().metrics,
      rejectedStorageMutationsDelta: 3,
      expectedStaleFenceRejections: 3,
      expectedCoalescedStaleFenceRejections: 1,
      maxCoalescedStaleFenceRejectionsPerMutation: 1,
    },
  }), config)
  assert.equal(accepted.expectedStaleFenceRejections, 3)
  assert.equal(accepted.expectedCoalescedStaleFenceRejections, 1)
  // RE-DERIVED, not re-asserted: the fixture carries every client's own field
  // present, so the zero is the SUM of six results reporting no refusal.
  assert.equal(accepted.rejectedClientEdits, 0)
  // And the divergence totals the certificate reads are measured zeros rather
  // than absent fields — see the arm below for why absence is the dangerous one.
  assert.deepEqual(
    { missingFields: accepted.missingFields, staleFields: accepted.staleFields, hotDiverged: accepted.hotDiverged },
    { missingFields: 0, staleFields: 0, hotDiverged: 0 },
  )

  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: {
      ...evidence().metrics,
      rejectedStorageMutationsDelta: 4,
      expectedStaleFenceRejections: 4,
    },
  }), config), /bounded failover allowance/)
})

test('G4-3: one refused client write is SUMMED, and the gate still passes so the certificate is the thing that refuses', () => {
  // THE ARM THE LITERAL MADE IMPOSSIBLE. `rejectedClientEdits` was `0` in the
  // pass object, so no evidence file could ever produce a non-zero and the
  // certificate's `load.rejectedClientEdits !== 0` check was unreachable.
  //
  // `load-users.mjs` records each user's OWN field, read back from that user's
  // OWN document after the edit round. A `null` there is not convergence lag: a
  // client made an edit and its own copy does not have it.
  //
  // The evaluator does NOT fail on it, deliberately — a refused write is a
  // correctness fact for the CERTIFICATE to judge, and the load gate's own
  // budget assertions are about latency and transport. That split is why this
  // arm asserts a pass carrying `1` rather than a throw.
  const withOneRefusal = evaluateLoadSoakEvidence(evidence({
    baselineResults: [resultWithRejectedEdits(1, 700, 0), result(900, 1)],
  }), config)
  assert.equal(withOneRefusal.outcome, 'passed')
  assert.equal(withOneRefusal.rejectedClientEdits, 1)

  // MUTANT: replace the summation with the literal `0` and this line is the
  // only thing that goes red — which is exactly the state before this task,
  // except that then no line went red at all.
  assert.equal(
    evaluateLoadSoakEvidence(evidence({
      baselineResults: [resultWithRejectedEdits(2, 700, 0), resultWithRejectedEdits(3, 900, 1)],
    }), config).rejectedClientEdits,
    5,
  )
})

test('G4-3: the lost-edit totals are in the FAILURE payload, which is the only place they can be non-zero', () => {
  // WHY THIS ARM EXISTS AT ALL. The divergence loop throws on any non-zero
  // `missingFields`/`staleFields`/`hotDiverged`, so on the PASS path those
  // totals are necessarily zero, and a literal `0` in the pass object would be
  // indistinguishable from the sum.
  //
  // The failure payload is where they CAN differ, and it is also where an
  // operator actually wants them: the run that lost edits is the run somebody
  // reads. Computing them once and using them on both exits is what makes the
  // sum falsifiable and keeps the two exits from answering differently about
  // one run.
  assert.throws(
    () => evaluateLoadSoakEvidence(evidence({
      baselineResults: [{ ...result(700, 0), missingFields: 2, staleFields: 1 }, result(900, 1)],
    }), config),
    (error) => {
      assert.match(error.message, /a normal-load workspace diverged/)
      const payload = JSON.parse(error.message.slice(error.message.indexOf('evidence=') + 'evidence='.length))
      // MUTANT: hardcode any of these to 0 in `lostEdits` and this fails.
      assert.deepEqual(payload.lostEdits, {
        rejectedClientEdits: 0, missingFields: 2, staleFields: 1, hotDiverged: 0,
      })
      return true
    },
  )

  // The refusal total travels on the failure path too, so a run that both
  // diverged and had writes refused reports both rather than only the first
  // thing that threw.
  assert.throws(
    () => evaluateLoadSoakEvidence(evidence({
      baselineResults: [{ ...resultWithRejectedEdits(3, 700, 0), hotDiverged: 1 }, result(900, 1)],
    }), config),
    (error) => {
      const payload = JSON.parse(error.message.slice(error.message.indexOf('evidence=') + 'evidence='.length))
      assert.equal(payload.lostEdits.rejectedClientEdits, 3)
      assert.equal(payload.lostEdits.hotDiverged, 1)
      return true
    },
  )
})

test('G4-3: a result that does not REPORT its own edits yields null, never a clean zero', () => {
  // THE FALSE PASS THIS COUNTER EXISTS TO PREVENT, one level up. An evidence
  // file produced before the client emitted `localOwnFieldsAfterEdit` — or one
  // hand-edited — has no refusal data at all. Reading that absence as zero
  // would certify a run nobody measured, which is the same shape as the literal
  // it replaces.
  const unmeasured = evaluateLoadSoakEvidence(evidence({
    baselineResults: [{ ...result(700, 0), localOwnFieldsAfterEdit: undefined }, result(900, 1)],
  }), config)
  assert.equal(unmeasured.outcome, 'passed')
  assert.equal(unmeasured.rejectedClientEdits, null)

  // A malformed entry is not zero either: the shape has to be the one the
  // client emits, or the answer is "not measured".
  const malformed = evaluateLoadSoakEvidence(evidence({
    baselineResults: [{ ...result(700, 0), localOwnFieldsAfterEdit: [{ user: 0 }] }, result(900, 1)],
  }), config)
  assert.equal(malformed.rejectedClientEdits, null)
})

test('G4-3, the half that never met the other: the shape run() ACTUALLY evaluates — results normalised by convergedResult — still yields a number', () => {
  // Every arm above hands RAW results to the evaluator. `run()` never does: it
  // evaluates `baselineRaw.map(convergedResult)`, so `convergedResult` must
  // carry `localOwnFieldsAfterEdit` through or a real run publishes
  // `rejectedClientEdits: null` while raw-fixture unit tests stay green.
  const normalise = (results) => results.map(convergedResult)
  const clean = evaluateLoadSoakEvidence(evidence({
    baselineResults: normalise([result(700, 0), result(900, 1)]),
    failoverResults: normalise([result(8_000, 0), result(1_100, 1)]),
    soakResults: normalise([result(800, 0), result(950, 1)]),
  }), config)
  assert.equal(clean.outcome, 'passed')
  // MUTANT: drop the carried field from `convergedResult` and this reads null.
  assert.equal(clean.rejectedClientEdits, 0)

  const refused = evaluateLoadSoakEvidence(evidence({
    baselineResults: normalise([resultWithRejectedEdits(2, 700, 0), result(900, 1)]),
  }), config)
  assert.equal(refused.rejectedClientEdits, 2)

  // And a raw result that never reported is still "not measured" after
  // normalisation — the carry-through must not invent a clean shape.
  const unmeasured = evaluateLoadSoakEvidence(evidence({
    baselineResults: normalise([{ ...result(700, 0), localOwnFieldsAfterEdit: undefined }, result(900, 1)]),
  }), config)
  assert.equal(unmeasured.rejectedClientEdits, null)
})

test('rejects misleadingly small fencing counts with an unsafe mutation kind or exact mutation retry', () => {
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: {
      ...evidence().metrics,
      rejectedStorageMutationsDelta: 1,
      expectedStaleFenceRejections: 1,
      unexpectedStaleFenceKinds: 1,
    },
  }), config), /unexpected storage mutation kind/)

  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: {
      ...evidence().metrics,
      rejectedStorageMutationsDelta: 2,
      expectedStaleFenceRejections: 2,
      repeatedStaleFenceRejections: 1,
    },
  }), config), /repeatedly rejected the same storage mutation/)

  const coalescingStorm = {
    ...evidence().metrics,
    expectedCoalescedStaleFenceRejections: 4,
    maxCoalescedStaleFenceRejectionsPerMutation: 3,
  }
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: coalescingStorm,
  }), config), /coalescing exceeded the bounded failover allowance/)

  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    metrics: {
      ...evidence().metrics,
      staleFenceCoalescingEvictions: 1,
    },
  }), config), /coalescing cache evicted an entry/)
})

test('enforces honest minimums for soak and endurance modes', () => {
  assert.throws(() => parseLoadSoakConfig({
    SYNC_LOAD_MODE: 'soak',
    SYNC_LOAD_SOAK_DURATION_MS: '60000',
    SYNC_LOAD_USERS_PER_WORKSPACE: '25',
  }), /requires at least/)
  assert.throws(() => parseLoadSoakConfig({
    SYNC_LOAD_MODE: 'endurance',
    SYNC_LOAD_USERS_PER_WORKSPACE: '10',
  }), /at least 25 users/)
  const soak = parseLoadSoakConfig({ SYNC_LOAD_MODE: 'soak', SYNC_LOAD_USERS_PER_WORKSPACE: '25' })
  assert.equal(soak.soakDurationMs, 2 * 60 * 60_000)
})

test('makes disposable fresh-workspace qualification explicit', () => {
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_FRESH_WORKSPACES: 'on' }, []).freshWorkspaces, true)
  assert.equal(parseLoadSoakConfig({}, []).freshWorkspaces, false)
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_CLIENTS_PER_PROCESS: '8' }, []).clientsPerProcess, 8)
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_USERS_PER_WORKSPACE: '25' }, []).maxSynchronizerPeerBindings, 75)
  assert.equal(parseLoadSoakConfig({
    SYNC_LOAD_USERS_PER_WORKSPACE: '25',
    SYNC_LOAD_MAX_SYNCHRONIZER_PEER_BINDINGS: '50',
  }, []).maxSynchronizerPeerBindings, 50)
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_SEGMENTED_WORKSPACES: 'on' }, []).segmentedWorkspaces, true)
  assert.deepEqual(parseLoadSoakConfig({
    SYNC_LOAD_WORKSPACES: 'land-a:version-a,land-b:version-b',
  }, []).workspaceSelectors, [
    { landscapeId: 'land-a', versionId: 'version-a' },
    { landscapeId: 'land-b', versionId: 'version-b' },
  ])
  assert.throws(() => parseLoadSoakConfig({
    SYNC_LOAD_WORKSPACES: 'land-a:version-a',
  }, []), /exactly two/)
  assert.throws(() => parseLoadSoakConfig({
    SYNC_LOAD_FRESH_WORKSPACES: 'on',
    SYNC_LOAD_WORKSPACES: 'land-a:version-a,land-b:version-b',
  }, []), /cannot be combined/)
  assert.throws(() => parseLoadSoakConfig({
    SYNC_LOAD_FRESH_WORKSPACES: 'on',
    SYNC_LOAD_SEGMENTED_WORKSPACES: 'on',
  }, []), /pre-seeded performance workspaces/)
})

test('moves every sustained phase to the newly published overlay write head', async () => {
  const selections = new Map([[0, { workspace: 'zero' }], [1, { workspace: 'one' }]])
  const previous = new Map([[0, 'old-zero'], [1, 'old-one']])
  const calls = []
  const refreshed = await refreshRotatedLoadTargets(
    selections,
    previous,
    async (selection, target, partition) => {
      calls.push({ selection, target, partition })
      return `new-${partition}`
    },
  )
  assert.deepEqual(calls, [
    { selection: selections.get(0), target: 'old-zero', partition: 0 },
    { selection: selections.get(1), target: 'old-one', partition: 1 },
  ])
  assert.deepEqual([...refreshed], [[0, 'new-0'], [1, 'new-1']])
  await assert.rejects(refreshRotatedLoadTargets(
    selections,
    previous,
    async (_selection, target) => target,
  ), /did not publish a fresh overlay write head/)
})

test('cleans disposable workspaces through another route when one owner route is stale', async () => {
  const calls = []
  const responses = [503, 503, 200]
  await cleanupFreshLandscapes(
    { freshWorkspaces: true, routerPort: 3330 },
    [{ baseUrl: 'http://127.0.0.1:3331' }, { baseUrl: 'http://127.0.0.1:3332' }],
    'session=qa',
    ['landscape-a'],
    async (url) => {
      calls.push(url)
      return { status: responses.shift() }
    },
  )
  assert.deepEqual(calls, [
    'http://127.0.0.1:3330/api/landscapes/landscape-a',
    'http://127.0.0.1:3331/api/landscapes/landscape-a',
    'http://127.0.0.1:3332/api/landscapes/landscape-a',
  ])
})

test('does not let cleanup hide the primary qualification failure', async () => {
  const primary = new Error('exact convergence failed')
  const logger = { error: () => undefined }
  await assert.doesNotReject(completeQualificationCleanup(
    async () => { throw new Error('cleanup failed') },
    primary,
    logger,
  ))
  await assert.rejects(completeQualificationCleanup(
    async () => { throw new Error('cleanup failed') },
    null,
    logger,
  ), /cleanup failed/)
})

test('fails when independently hosted cohorts disagree on a contended value', () => {
  const multiProcessConfig = { ...config, usersPerWorkspace: 10, clientsPerProcess: 5 }
  assert.throws(() => evaluateLoadSoakEvidence(evidence({
    baselineResults: [
      result(700, 0, 0),
      { ...result(710, 0, 1), hotValues: ['other-winner'] },
      result(800, 1, 0),
      result(810, 1, 1),
    ],
    failoverResults: [
      result(700, 0, 0), result(710, 0, 1), result(800, 1, 0), result(810, 1, 1),
    ],
    soakResults: [
      result(700, 0, 0), result(710, 0, 1), result(800, 1, 0), result(810, 1, 1),
    ],
  }), multiProcessConfig), /cohorts disagree/)
})

test('arms failover only after the load cohort reports document readiness', () => {
  const tracker = createLoadOutputTracker()
  tracker.push('QARESULT {"fullyConverged":true}\n')
  assert.equal(tracker.readyForFailure(), false)

  tracker.push('QAPHASE {"phase":"ready-')
  assert.equal(tracker.readyForFailure(), false)
  tracker.push('for-failure","users":25}\n')
  assert.equal(tracker.readyForFailure(), true)
})

test('does not make failover injection depend on a responsive metrics endpoint', () => {
  const ready = { readyForFailure: () => true }
  const waiting = { readyForFailure: () => false }
  const unavailableDiagnostics = [{ stats: null }]

  assert.equal(loadProcessesReadyForFailure([ready, ready], unavailableDiagnostics), true)
  assert.equal(loadProcessesReadyForFailure([ready, waiting], unavailableDiagnostics), false)
  assert.equal(
    loadProcessesReadyForFailure([ready], unavailableDiagnostics, (snapshots) => Boolean(snapshots[0].stats)),
    false,
  )
})

test('uses fast jittered ownership-drain reconnects and bounded outage backoff', () => {
  assert.equal(qaReconnectDelayMs(1012, 0, 500, () => 0), 50)
  assert.equal(qaReconnectDelayMs(1012, 0, 500, () => 1), 200)
  assert.equal(qaReconnectDelayMs(1013, 0, 500, () => 0.5), 250)
  assert.equal(qaReconnectDelayMs(1006, 0, 500, () => 0.5), 500)
  assert.equal(qaReconnectDelayMs(1006, 20, 500, () => 0.5), 5_000)
})

// ---------------------------------------------------------------------------
// The two load profiles.
// ---------------------------------------------------------------------------

test('profiles: the default is the historical contention shape, and fleet is many connected / few writing / distinct objects', () => {
  const contention = parseLoadSoakConfig({}, [])
  assert.equal(contention.profile, 'contention')
  assert.equal(contention.usersPerWorkspace, 25)
  assert.equal(contention.writersPerWorkspace, 25)
  // MUTANT: default writers to the literal 25 and this still reads 25 at 40 users.
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_USERS_PER_WORKSPACE: '40' }, []).writersPerWorkspace, 40)
  assert.equal(contention.objects, 5)
  assert.equal(contention.objectAssignment, 'shared')
  assert.equal(contention.clientsPerProcess, 10)

  const fleet = parseLoadSoakConfig({ SYNC_LOAD_PROFILE: 'fleet' }, [])
  assert.equal(fleet.profile, 'fleet')
  assert.equal(fleet.usersPerWorkspace, 100)
  assert.equal(fleet.writersPerWorkspace, 10)
  assert.equal(fleet.objects, 10)
  assert.equal(fleet.objectAssignment, 'per-writer')
  assert.equal(fleet.clientsPerProcess, 25)
  assert.deepEqual(parseLoadSoakConfig({}, ['--profile=fleet']).profile, 'fleet')
  assert.deepEqual(Object.keys(LOAD_PROFILES), ['contention', 'fleet'])
})

test('profiles: every knob still overrides its preset, and an impossible combination is refused', () => {
  const overridden = parseLoadSoakConfig({
    SYNC_LOAD_PROFILE: 'fleet',
    SYNC_LOAD_USERS_PER_WORKSPACE: '40',
    SYNC_LOAD_OBJECT_ASSIGNMENT: 'shared',
  }, [])
  assert.equal(overridden.usersPerWorkspace, 40)
  assert.equal(overridden.writersPerWorkspace, 10)
  assert.equal(overridden.objectAssignment, 'shared')
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_WRITERS_PER_WORKSPACE: '3' }, []).writersPerWorkspace, 3)
  assert.throws(() => parseLoadSoakConfig({ SYNC_LOAD_USERS_PER_WORKSPACE: '10', SYNC_LOAD_WRITERS_PER_WORKSPACE: '11' }, []), /cannot exceed/)
  assert.throws(() => parseLoadSoakConfig({ SYNC_LOAD_OBJECT_ASSIGNMENT: 'round-robin' }, []), /shared or per-writer/)
  assert.throws(() => parseLoadSoakConfig({ SYNC_LOAD_PROFILE: 'stress' }, []), /must be one of contention, fleet/)
})

test('profiles: the pass object names the profile the numbers were taken under', () => {
  const output = evaluateLoadSoakEvidence(evidence(), {
    ...config,
    profile: 'fleet',
    writersPerWorkspace: 10,
    objectAssignment: 'per-writer',
  })
  assert.equal(output.profile, 'fleet')
  assert.equal(output.writersPerWorkspace, 10)
  assert.equal(output.objectAssignment, 'per-writer')
  // Per cell, not only the maximum: the loaded partition's owner is the number.
  assert.deepEqual(output.maxEventLoopP99MsByService, undefined)
  const withServices = evaluateLoadSoakEvidence(evidence({
    metrics: { ...evidence().metrics, maxEventLoopP99MsByService: { 'sync-cell-a': 32, 'sync-cell-b': 7, 'sync-cell-c': 1 } },
  }), config)
  assert.deepEqual(withServices.maxEventLoopP99MsByService, { 'sync-cell-a': 32, 'sync-cell-b': 7, 'sync-cell-c': 1 })
})

test('the bench runner turns --mode/--load-profile/--users/--host into the gate\'s own argument and environment', () => {
  // The runner runs `main()` at import; `--help` makes that a usage print and a
  // return, so the export can be exercised without a leg or docker.
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { benchHostOverride, loadSoakOverrides } from ${JSON.stringify(pathToFileURL(benchPath).href)}
console.log('OVERRIDES ' + JSON.stringify(loadSoakOverrides(['--leg=load-soak', '--mode=soak', '--load-profile=fleet', '--users=100'])))
console.log('NONE ' + JSON.stringify(loadSoakOverrides(['--leg=load-soak'])))
console.log('HOST ' + JSON.stringify(benchHostOverride(['--leg=load-soak', '--host=bench-a.internal'])))
console.log('NOHOST ' + JSON.stringify(benchHostOverride(['--leg=load-soak'])))`,
    '--', 'ignored-argv1', '--help',
  ], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(probe.status, 0, `runner probe exited ${probe.status}: ${probe.stderr}`)
  const line = (prefix) => JSON.parse(probe.stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix)).slice(prefix.length))
  assert.deepEqual(line('OVERRIDES '), {
    args: ['--mode=soak'],
    env: { SYNC_LOAD_PROFILE: 'fleet', SYNC_LOAD_USERS_PER_WORKSPACE: '100' },
  })
  // Nothing given: the leg's own default argument stays in force (null, not []).
  assert.deepEqual(line('NONE '), { args: null, env: {} })
  // `--host` also publishes the stack's ports beyond loopback, or the two-host
  // run cannot reach them.
  assert.deepEqual(line('HOST '), { SYNC_FAILOVER_HOST: 'bench-a.internal', SYNC_FAILOVER_BIND: '0.0.0.0' })
  assert.deepEqual(line('NOHOST '), {})
})

test('the gate reaches the router and the cells at SYNC_FAILOVER_HOST, loopback by default, and no loopback literal survives in a URL', () => {
  assert.equal(parseLoadSoakConfig({}, []).host, '127.0.0.1')
  assert.equal(parseLoadSoakConfig({ SYNC_FAILOVER_HOST: 'bench-a.internal' }, []).host, 'bench-a.internal')
  assert.equal(parseLoadSoakConfig({ SYNC_FAILOVER_HOST: '10.0.0.7' }, []).host, '10.0.0.7')
  assert.equal(benchHost('[fd00::7]'), '[fd00::7]')
  for (const bad of ['http://bench-a', 'bench-a:3440', 'bench-a/api', 'user@bench-a']) {
    assert.throws(() => benchHost(bad), /bare host name or IP address/, bad)
  }
  // MUTANT: put `127.0.0.1` back in any of the eleven URLs and this fails.
  assert.equal(/(https?|wss?):\/\/127\.0\.0\.1[:/]/.test(gateSource), false, 'a URL in the gate still hard-codes loopback')
  // The runner's own readiness probe follows the same variable.
  const benchSource = readFileSync(benchPath, 'utf8')
  assert.match(benchSource, /fetch\(`http:\/\/\$\{env\.SYNC_FAILOVER_HOST \|\| '127\.0\.0\.1'\}:\$\{ports\[name\]\}\/api\/ready`/)
})

// ---------------------------------------------------------------------------
// The verdict guard — the gate never exits 0 without a verdict.
// ---------------------------------------------------------------------------

test('B5.17: the run deadline is derived from the run\'s own bounded waits and follows the soak duration', () => {
  const smoke = parseLoadSoakConfig({}, [])
  const soak = parseLoadSoakConfig({ SYNC_LOAD_MODE: 'soak', SYNC_LOAD_USERS_PER_WORKSPACE: '25' }, [])
  assert.equal(smoke.runDeadlineMs, defaultRunDeadlineMs(smoke))
  // A soak of two hours moves the ceiling by exactly two hours: nothing else
  // in the two configurations differs.
  assert.equal(soak.runDeadlineMs - smoke.runDeadlineMs, 2 * 60 * 60_000)
  // It bounds the hang, not the work: a smoke run takes minutes, its ceiling is
  // under an hour — and it is not a literal, since a longer settle raises it.
  assert.ok(smoke.runDeadlineMs > 10 * 60_000 && smoke.runDeadlineMs < 60 * 60_000, `smoke ceiling ${smoke.runDeadlineMs} ms`)
  const patient = parseLoadSoakConfig({ SYNC_LOAD_SETTLE_MS: '90000' }, [])
  assert.ok(patient.runDeadlineMs > smoke.runDeadlineMs)
  assert.equal(parseLoadSoakConfig({ SYNC_LOAD_RUN_DEADLINE_MS: '120000' }, []).runDeadlineMs, 120_000)
  assert.throws(() => parseLoadSoakConfig({ SYNC_LOAD_RUN_DEADLINE_MS: '1000' }, []), /SYNC_LOAD_RUN_DEADLINE_MS/)
})

function fakeProcess() {
  const listeners = new Map()
  return {
    exitCode: undefined,
    exited: [],
    on(event, listener) { listeners.set(event, listener) },
    removeListener(event, listener) { if (listeners.get(event) === listener) listeners.delete(event) },
    emit(event) { listeners.get(event)?.() },
    has(event) { return listeners.has(event) },
    exit(code) { this.exited.push(code) },
  }
}

function guardHarness(overrides = {}) {
  const proc = fakeProcess()
  const logs = []
  const errors = []
  const abandoned = []
  const timers = []
  const guard = createVerdictGuard({
    phase: () => 'the phase under test',
    onAbandon: () => abandoned.push(true),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    proc,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unrefd: false, unref() { timer.unrefd = true } }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { timer.cleared = true },
    ...overrides,
  })
  return { guard, proc, logs, errors, abandoned, timers }
}

test('B5.17: the exit code is pessimistic — armed at 1, and ONLY a passed verdict makes it 0', () => {
  const passed = guardHarness()
  passed.guard.arm()
  // MUTANT: drop `proc.exitCode = 1` from arm() and this reads undefined.
  assert.equal(passed.proc.exitCode, 1)
  passed.guard.settle({ outcome: 'passed', usersPerWorkspace: 25 })
  assert.equal(passed.proc.exitCode, 0)
  assert.deepEqual(passed.logs, ['{"outcome":"passed","usersPerWorkspace":25}'])
  assert.deepEqual(passed.errors, [])
  assert.equal(passed.proc.has('beforeExit'), false, 'the drain listener is removed once a verdict is out')

  // A verdict object that is not a pass is printed AND red: the line is the
  // evidence, the code is the answer, and they must agree.
  const notPassed = guardHarness()
  notPassed.guard.arm()
  notPassed.guard.settle({ outcome: 'failed' })
  assert.equal(notPassed.proc.exitCode, 1)
  assert.deepEqual(notPassed.logs, ['{"outcome":"failed"}'])
  assert.match(notPassed.errors[0], /verdict outcome is "failed", not "passed"/)

  const rejected = guardHarness()
  rejected.guard.arm()
  rejected.guard.fail(new Error('multi-cell load/soak gate failed: something'))
  assert.equal(rejected.proc.exitCode, 1)
  assert.deepEqual(rejected.errors, ['multi-cell load/soak gate failed: something'])
  assert.deepEqual(rejected.logs, [])
})

test('B5.17: a drained event loop is printed with the phase, hands the stack back, and stays red', () => {
  const h = guardHarness()
  h.guard.arm()
  h.proc.emit('beforeExit')
  assert.equal(h.proc.exitCode, 1)
  assert.equal(h.abandoned.length, 1, 'onAbandon runs exactly once')
  assert.match(h.errors[0], /load gate failed: the event loop drained before run\(\) settled/)
  assert.match(h.errors[0], /phase="the phase under test"/)
  // A second drain notification, or a late verdict, changes nothing.
  h.proc.emit('beforeExit')
  h.guard.settle({ outcome: 'passed' })
  assert.equal(h.proc.exitCode, 1)
  assert.equal(h.abandoned.length, 1)
  assert.deepEqual(h.logs, [], 'no verdict line after an abandonment')
})

test('B5.17: the ceiling fires as a printed failure with cleanup and an explicit exit, and is cleared by a verdict', () => {
  const hung = guardHarness({ deadlineMs: 5_000 })
  hung.guard.arm()
  assert.equal(hung.timers.length, 1)
  assert.equal(hung.timers[0].ms, 5_000)
  // UNREFERENCED: referenced, the ceiling itself holds the loop and the drain
  // listener can never fire (a drain would be reported seconds later by the
  // ceiling instead of at once by beforeExit). The real-process drain arm
  // below observes the consequence; this pins the call.
  assert.equal(hung.timers[0].unrefd, true, 'the ceiling timer must be unref()d')
  hung.timers[0].fn()
  assert.match(hung.errors[0], /run deadline of 5000 ms exceeded/)
  assert.match(hung.errors[0], /phase="the phase under test"/)
  assert.equal(hung.abandoned.length, 1)
  // The fake process has no stderr stream, so the exit is immediate.
  assert.deepEqual(hung.proc.exited, [1])
  assert.equal(hung.proc.exitCode, 1)

  const prompt = guardHarness({ deadlineMs: 5_000 })
  prompt.guard.arm()
  prompt.guard.settle({ outcome: 'passed' })
  // MUTANT: forget `clearTimer` in disarm() and a passed run is killed later.
  assert.equal(prompt.timers[0].cleared, true)
  prompt.timers[0].fn()
  assert.deepEqual(prompt.proc.exited, [])
  assert.equal(prompt.proc.exitCode, 0)

  // A cleanup that itself throws does not hide the abandonment or the exit code.
  const brittle = guardHarness({ deadlineMs: 1, onAbandon: () => { throw new Error('docker gone') } })
  brittle.guard.arm()
  brittle.timers[0].fn()
  assert.equal(brittle.proc.exitCode, 1)
  assert.match(brittle.errors[1], /cleanup after abandonment also failed: docker gone/)
  assert.deepEqual(brittle.proc.exited, [1])
})

/**
 * THE REAL THING, in a child process. "beforeExit fires when the loop drains",
 * "an unref'd timer does not hold the loop" and "a referenced handle does" are
 * properties of Node that the fakes above assume; these arms observe them. The
 * fixture wires the guard exactly as the gate's entry block does — a deadline
 * ARMED in every mode (the gate never runs without one, and a referenced
 * ceiling would kill the drain path) and `run().then(settle, fail)` with NO
 * top-level await, because a top-level await that never settles makes Node
 * exit 13 on its own, while the failure this guards against exits 0.
 */
function runGuardFixture(mode, { timeoutMs = 60_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maplespire-verdict-guard-'))
  const fixture = join(directory, 'guard-fixture.mjs')
  writeFileSync(fixture, [
    `import { createVerdictGuard } from ${JSON.stringify(gateUrl)}`,
    'const mode = process.argv[2]',
    'const guard = createVerdictGuard({',
    "  deadlineMs: mode === 'hung' ? 300 : 60_000,",
    "  phase: () => 'fixture phase',",
    "  onAbandon: () => console.error('abandon called'),",
    '  log: console.log,',
    '  error: console.error,',
    '})',
    'guard.arm()',
    '// hung: a handle the run left behind still holds the loop, so beforeExit can',
    "// never fire and only the ceiling's process.exit can end the process.",
    "if (mode === 'hung') setInterval(() => undefined, 1_000)",
    'const run = () => new Promise((resolve, reject) => {',
    "  if (mode === 'passed') resolve({ outcome: 'passed', fixture: true })",
    "  else if (mode === 'failed-verdict') resolve({ outcome: 'failed' })",
    "  else if (mode === 'rejected') reject(new Error('fixture run rejected'))",
    '  // drain and deadline: never settles',
    '})',
    'run().then((verdict) => guard.settle(verdict), (error) => guard.fail(error))',
    '',
  ].join('\n'), 'utf8')
  try {
    const startedAt = Date.now()
    const child = spawnSync(process.execPath, [fixture, mode], { encoding: 'utf8', timeout: timeoutMs })
    assert.equal(child.error, undefined, `fixture ${mode} did not finish: ${child.error?.message}`)
    return { status: child.status, stdout: child.stdout, stderr: child.stderr, elapsedMs: Date.now() - startedAt }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('B5.17 (real process): a run whose promise never settles and whose loop drains exits 1 PROMPTLY with the reason printed — the M5 pass-3 shape, under an armed 60 s ceiling', () => {
  const child = runGuardFixture('drain', { timeoutMs: 30_000 })
  // MUTANT: remove `proc.exitCode = 1` from arm() AND the beforeExit listener,
  // and this is the void pass: status 0, empty stderr.
  assert.equal(child.status, 1, `stdout=${child.stdout} stderr=${child.stderr}`)
  assert.match(child.stderr, /load gate failed: the event loop drained before run\(\) settled; phase="fixture phase"/)
  assert.match(child.stderr, /abandon called/)
  assert.doesNotMatch(child.stderr, /run deadline/, 'a drained loop is reported by the listener, not by the ceiling')
  assert.equal(child.stdout.trim(), '', 'no verdict line')
  // MUTANT: reference the ceiling timer (drop `timer.unref?.()`) and the loop
  // cannot drain — the child sits until the 60 s deadline and the harness
  // timeout kills it first.
  assert.ok(child.elapsedMs < 10_000, `the drain was reported after ${child.elapsedMs} ms, not at the ceiling`)
})

test('B5.17 (real process): a HUNG run — a handle still holds the loop — is ended by the ceiling\'s explicit exit, not by a drain', () => {
  // A run that is hung has, by definition, something still holding the loop;
  // here a referenced interval stands in for it. (Without it the loop would
  // drain and end the process with the armed exit code whether or not
  // `exitAfterFlush` called `process.exit`.) Only `process.exit(1)` can end
  // this child: without it, spawnSync's timeout kills the fixture and
  // `child.error` is set.
  const child = runGuardFixture('hung', { timeoutMs: 15_000 })
  assert.equal(child.status, 1, `stdout=${child.stdout} stderr=${child.stderr}`)
  assert.match(child.stderr, /run deadline of 300 ms exceeded; phase="fixture phase"/)
  assert.match(child.stderr, /abandon called/)
  assert.doesNotMatch(child.stderr, /event loop drained/, 'a hung run is not a drained one')
  assert.equal(child.stdout.trim(), '')
  assert.ok(child.elapsedMs < 10_000, 'the ceiling ended the process, not the harness timeout')
})

test('B5.17 (real process): the verdict line decides the exit code — passed is 0, anything else is 1', () => {
  const passed = runGuardFixture('passed')
  assert.equal(passed.status, 0, `stderr=${passed.stderr}`)
  assert.equal(passed.stdout.trim(), '{"outcome":"passed","fixture":true}')
  assert.equal(passed.stderr.trim(), '')

  const failedVerdict = runGuardFixture('failed-verdict')
  assert.equal(failedVerdict.status, 1)
  assert.equal(failedVerdict.stdout.trim(), '{"outcome":"failed"}')
  assert.match(failedVerdict.stderr, /verdict outcome is "failed"/)

  const rejected = runGuardFixture('rejected')
  assert.equal(rejected.status, 1)
  assert.equal(rejected.stdout.trim(), '')
  assert.match(rejected.stderr, /fixture run rejected/)
})

/**
 * WIRING PINS. The guard, the attached samples and the profile arguments are
 * each exercised above in isolation; whether `run()`, `runLoadPair()`,
 * `startLoadProcess()` and the entry block actually USE them cannot be run
 * without the three-cell stack, so the wiring is pinned the only way available
 * here: by the source text, on lines that carry no escape.
 */
// Line endings normalised: a Windows working tree can hold these files CRLF
// (the repository's blobs are LF), and a multi-line anchor must not depend on it.
const gateSource = readFileSync(fileURLToPath(gateUrl), 'utf8').replace(/\r\n/g, '\n')
const loadUsersSource = readFileSync(resolve(here, '../qa/load-users.mjs'), 'utf8').replace(/\r\n/g, '\n')

test('B5.17 wiring: the entry block arms the guard with the run deadline, the live phase and the abandonment cleanup, BEFORE main()', () => {
  const entry = gateSource.slice(gateSource.indexOf('if (import.meta.url === pathToFileURL(process.argv[1]).href)'))
  assert.match(entry, /deadlineMs: config\.runDeadlineMs,/)
  assert.match(entry, /phase: currentGatePhase,/)
  assert.match(entry, /onAbandon: \(\) => abandonRun\(config\),/)
  const armAt = entry.indexOf('guard.arm()')
  const mainAt = entry.indexOf('main(config).then((verdict) => guard.settle(verdict), (error) => guard.fail(error))')
  assert.ok(armAt > 0 && mainAt > armAt, 'guard.arm() must precede main(config).then(settle, fail)')
  // The old shape — print the verdict and set the exit code inside main(), and a
  // `main().catch(...)` with nothing to catch when the loop drains — is gone
  // from the ENTRY BLOCK (the guard's own comment still names it as history).
  assert.equal(entry.includes('console.log(JSON.stringify(result))'), false)
  assert.equal(entry.includes('main().catch('), false)
  assert.equal(gateSource.includes('process.exitCode = 1\n  })\n}'), false, 'the catch-and-set-exit-code tail must not come back')
})

test('B5.17 wiring: every load-phase failure goes through attachSampledMetrics, and every repo shutdown is bounded', () => {
  assert.match(gateSource, /if \(failure\) throw attachSampledMetrics\(failure, accumulator, lastSnapshots, options\.unavailableService\?\.\(\)\)/)
  // The samples the failure carries are the ones the loop TOOK: `lastSnapshots`
  // is written on the line after each sample; without that assignment every
  // load-phase failure would lose its sampledMetrics.
  assert.match(gateSource, /const consume = \(snapshots, context\) => \{\n        lastSnapshots = snapshots\n        accumulator\.record\(snapshots, context\.unavailableService\)/)
  const bare = gateSource.match(/await (repo|verifier)\.shutdown\(\)/g) ?? []
  assert.deepEqual(bare, [], 'a bare repo.shutdown() can hang the gate — use shutdownRepo()')
  assert.ok((gateSource.match(/await shutdownRepo\((repo|verifier)\)/g) ?? []).length >= 5)
})

test('profiles wiring: the gate hands --writers and --objectAssignment to every load process, and load-users derives everything from planWriters', () => {
  assert.match(gateSource, /'--writers', String\(config\.writersPerWorkspace\),/)
  assert.match(gateSource, /'--objectAssignment', config\.objectAssignment,/)
  assert.match(loadUsersSource, /const plan = planWriters\(\{ totalUsers, writers, objectAssignment: o\.objectAssignment, ids \}\)/)
  // The edit loop iterates the WRITERS of this cohort, never every user.
  assert.match(loadUsersSource, /for \(const u of cohortWriters\) \{/)
  assert.equal(loadUsersSource.includes('for (const u of users) {\n    const missingHere'), false)
  // Convergence behavior is exercised in loadUsersCore.test.mjs, including a
  // previous-episode control; its former source-loop spelling is no contract.
  // Only writers report an own field, so a reader is never read as a refusal.
  assert.match(loadUsersSource, /const localOwnFieldsAfterEdit = cohortWriters\.map\(/)
  // ...and a writer reads back only the objects it WROTE. With `ids` here, a
  // per-writer writer reports (objects - 1) nulls, and countRejectedClientEdits
  // counts every null as a refused edit — 90 on a clean fleet run, the number
  // the certificate reads by name.
  const workerSource = readFileSync(resolve(here, '../qa/load-user-worker.mjs'), 'utf8')
  assert.match(workerSource, /values: plan\.writesTo\(user\)\.map\(id => objectMap\(document\)\?\.\[id\]\?\.\[`u\$\{user\}`\] \?\? null\)/)
  // Without --writers, EVERY user of the whole run writes (totalUsers, not the
  // cohort): cohorts planning from their own size would disagree on who writes.
  assert.match(loadUsersSource, /const writers = o\.writers \?\? totalUsers\n/)
})

test('T-M5b wiring: --host publishes the router and cell ports on every interface of the stack host, and nothing else', () => {
  // With every published port bound to 127.0.0.1 in the compose file,
  // `--host` could not reach a stack on another machine.
  const compose = readFileSync(resolve(here, '../../infra/compose/sync-cell-failover.yml'), 'utf8').replace(/\r\n/g, '\n')
  for (const port of ['ROUTER', 'CELL_A', 'CELL_B', 'CELL_C']) {
    assert.match(compose, new RegExp(`"\\$\\{SYNC_FAILOVER_BIND:-127\\.0\\.0\\.1\\}:\\$\\{SYNC_FAILOVER_${port}_PORT:-\\d+\\}:\\d+"`), `${port} must bind to SYNC_FAILOVER_BIND`)
  }
  // PostgreSQL and the frontend stay on loopback whatever the bind.
  assert.match(compose, /"127\.0\.0\.1:\$\{SYNC_FAILOVER_POSTGRES_PORT:-\d+\}:5432"/)
  assert.match(compose, /"127\.0\.0\.1:\$\{SYNC_FAILOVER_FRONTEND_PORT:-\d+\}:80"/)
  assert.equal((compose.match(/SYNC_FAILOVER_BIND/g) ?? []).length, 5, 'four bindings and one comment mention the variable')
})

test('T-M5b wiring: the router sets its event model EXPLICITLY and above a 100-user pass, the runner reads THAT file, and the per-pass identity line is exact and EXECUTED', () => {
  // An empty `events {}` leaves nginx on its compiled-in worker_connections
  // 512, silently. The floor: two hot workspaces x the largest profile x two
  // sockets per proxied WebSocket (downstream + upstream to sync-ws-router),
  // DOUBLED AS A MARGIN for the failover reconnect overlap, which is assumed,
  // not measured (a 5 s sampler saw at most 410 sockets at 200 clients).
  const confPath = resolve(here, '../../infra/compose/sync-cell-router.nginx.conf')
  const compose = readFileSync(resolve(here, '../../infra/compose/sync-cell-failover.yml'), 'utf8').replace(/\r\n/g, '\n')
  // The runner runs main() at import; --help makes that a usage print and a
  // return. Every function below is EXECUTED here — through a fake exec where
  // docker or a controlled git answer is needed, through the real git once.
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { API_IMAGE, IMAGE_INSPECT_FORMAT, IMAGE_REVISION_LABEL, describeRun, gitIdentity, imageIdentity, routerConfFile, routerEventsSummary, routerSummaryForRun } from ${JSON.stringify(pathToFileURL(benchPath).href)}
import { execFileSync } from 'node:child_process'
const out = (label, value) => console.log(label + ' ' + JSON.stringify(value === undefined ? null : value))
out('CONF', routerConfFile)
out('ROUTER', routerSummaryForRun())
out('COMMENTED', routerEventsSummary('# worker_connections 9;\\nevents {}\\n'))
out('AUTO', routerEventsSummary('worker_processes auto;\\nevents {\\n  worker_connections 1024;\\n}\\n'))
out('IMAGE', API_IMAGE)
out('LABEL', IMAGE_REVISION_LABEL)
out('FORMAT', IMAGE_INSPECT_FORMAT)
out('LINE', describeRun({ image: 'X', commit: 'Y-dirty', router: { workerProcesses: '1', workerConnections: '4096', workerRlimitNofile: '8192' }, host: 'h', bind: '0.0.0.0' }))
out('LINE_UNSET', describeRun({ image: null, commit: null, router: { workerProcesses: null, workerConnections: null, workerRlimitNofile: null }, host: '127.0.0.1', bind: '127.0.0.1' }))
const fake = (answers) => (file, args) => { const key = file + ' ' + args.join(' '); if (!(key in answers)) throw new Error('unexpected ' + key); const a = answers[key]; if (a instanceof Error) throw a; return a }
const REV = 'git rev-parse HEAD', TRACKED = 'git status --porcelain --untracked-files=no', INPUTS = 'git status --porcelain --untracked-files=all -- server infra'
out('CLEAN', gitIdentity(fake({ [REV]: 'abc\\n', [TRACKED]: '', [INPUTS]: '' })))
out('DIRTY_TRACKED', gitIdentity(fake({ [REV]: 'abc\\n', [TRACKED]: ' M docs/x.md\\n', [INPUTS]: '' })))
out('DIRTY_INPUT', gitIdentity(fake({ [REV]: 'abc\\n', [TRACKED]: '', [INPUTS]: '?? server/src/new.ts\\n' })))
out('UNVERIFIED', gitIdentity(fake({ [REV]: 'abc\\n', [TRACKED]: new Error('boom') })))
out('NOREPO', gitIdentity(fake({ [REV]: new Error('fatal: not a git repository') })))
let expected = null
try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim()
  const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', cwd: root })
    + execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'server', 'infra'], { encoding: 'utf8', cwd: root })
  expected = sha + (porcelain.trim() ? '-dirty' : '')
} catch { expected = null }
out('REAL', { real: gitIdentity(), expected })
const inspect = 'docker image inspect ' + API_IMAGE + ' --format ' + IMAGE_INSPECT_FORMAT
out('IMG', imageIdentity({}, fake({ [inspect]: '2026-09-05T02:44:46Z sha256:ac77 abc-dirty\\n' })))
out('IMG_UNLABELLED', imageIdentity({}, fake({ [inspect]: '2026-09-05T02:44:46Z sha256:ac77 \\n' })))
out('IMG_FAIL', imageIdentity({}, fake({ [inspect]: new Error('No such image') })))`,
    '--', 'ignored-argv1', '--help',
  ], { encoding: 'utf8', timeout: 60_000, cwd: here })
  assert.equal(probe.status, 0, `runner probe exited ${probe.status}: ${probe.stderr}`)
  const line = (prefix) => JSON.parse(probe.stdout.split(/\r?\n/).find((entry) => entry.startsWith(prefix)).slice(prefix.length))

  // (1) The runner reads the conf this test reads, and the compose file mounts
  // THAT conf over nginx's own — remove the mount and nginx runs its image's
  // 1024/auto while the runner prints 4096.
  assert.equal(resolve(line('CONF ')).toLowerCase(), confPath.toLowerCase(), 'the runner must read the mounted conf')
  assert.ok(compose.includes('- ./sync-cell-router.nginx.conf:/etc/nginx/nginx.conf:ro'), 'the compose file must mount the conf over /etc/nginx/nginx.conf')

  // (2) The values, through the runner's reader.
  const router = line('ROUTER ')
  const hotWorkspaces = 2 // the gate's pass object says so (`hotWorkspaces: 2`)
  const largestProfile = Math.max(...Object.values(LOAD_PROFILES).map((profile) => profile.usersPerWorkspace))
  const floor = hotWorkspaces * largestProfile * 2 * 2
  assert.equal(largestProfile, 100)
  assert.equal(router.workerProcesses, '1', 'one worker, so worker_connections IS the router\'s ceiling')
  assert.ok(Number(router.workerConnections) >= floor, `worker_connections ${router.workerConnections} is below the floor ${floor}`)
  assert.ok(Number(router.workerRlimitNofile) >= Number(router.workerConnections), 'the fd limit must admit every connection')
  // The parser reads settings, not comments, and returns nginx's own spelling.
  assert.deepEqual(line('COMMENTED '), { workerProcesses: null, workerRlimitNofile: null, workerConnections: null })
  assert.deepEqual(line('AUTO '), { workerProcesses: 'auto', workerRlimitNofile: null, workerConnections: '1024' })

  // (3) The image the runner inspects is the one the compose file builds, and
  // BOTH build blocks (one tag) stamp it with the tree revision the runner
  // hands them; the inspect format reads that stamp back.
  const label = line('LABEL ')
  assert.equal(label, 'org.opencontainers.image.revision')
  assert.ok(compose.includes(`image: ${line('IMAGE ')}`), 'API_IMAGE must be the compose file\'s image: line')
  const stamp = `${label}: "${'$'}{SYNC_FAILOVER_IMAGE_REVISION:-unlabelled}"`
  assert.equal(compose.split(stamp).length - 1, 2, 'both build blocks must stamp the same label')
  assert.equal(line('FORMAT '), `{{.Created}} {{.Id}} {{index .Config.Labels "${label}"}}`)
  const benchSource = readFileSync(benchPath, 'utf8')
  assert.match(benchSource, /if \(build\) env\.SYNC_FAILOVER_IMAGE_REVISION = identity\.commit \?\? 'unknown'/)

  // (4) The per-pass line, EXACT — a label/value swap cannot survive (m15).
  assert.equal(line('LINE '), '[bench] image X · commit Y-dirty · router worker_processes=1 worker_connections=4096 worker_rlimit_nofile=8192 · host h bind 0.0.0.0')
  assert.equal(line('LINE_UNSET '), '[bench] image (not inspected) · commit (git unavailable or not a checkout) · router worker_processes=unset worker_connections=unset worker_rlimit_nofile=unset · host 127.0.0.1 bind 127.0.0.1')

  // (5) Identity, EXECUTED: every branch through the fake, then the real git
  // of this checkout against git's own answer (a status failure must not fall
  // through to the bare SHA — "could not check" collapsing into "clean").
  assert.equal(line('CLEAN '), 'abc')
  assert.equal(line('DIRTY_TRACKED '), 'abc-dirty')
  assert.equal(line('DIRTY_INPUT '), 'abc-dirty')
  assert.equal(line('UNVERIFIED '), 'abc-unverified')
  assert.equal(line('NOREPO '), null)
  const real = line('REAL ')
  assert.equal(real.real, real.expected, 'gitIdentity must agree with git run from the repo root')
  assert.equal(line('IMG '), '2026-09-05T02:44:46Z sha256:ac77 revision=abc-dirty')
  assert.equal(line('IMG_UNLABELLED '), '2026-09-05T02:44:46Z sha256:ac77 revision=unlabelled')
  assert.equal(line('IMG_FAIL '), null)

  // (6) Wiring: main() prints the line once the cells serve and again-or-first
  // in finally, and the verdict JSON carries every field the line does.
  assert.match(benchSource, /identity\.image = imageIdentity\(env\)[\s\S]*?\n\s+describe\(\)/)
  assert.match(benchSource, /\} finally \{\n\s+describe\(\)/)
  for (const field of ['host,', 'bind,', 'image: identity.image,', 'commit: identity.commit,', 'router,']) {
    assert.ok(benchSource.includes(`      ${field}\n`), `the verdict JSON must carry ${field}`)
  }
})

test('B5.17 companion: a load-phase failure carries the per-cell samples the gate took during the phase', () => {
  const snapshot = (service, p99) => ({
    service,
    stats: { synchronizer: {}, transport: { eventLoopDelayMs: { p99 }, connections: { active: 50 }, syncCpu: { maxGenerateMs: 26.35 } } },
    fleet: { foreignResidentProjectors: 0 },
    ownership: { storageFence: {} },
  })
  const baseline = [snapshot('sync-cell-a', 1), snapshot('sync-cell-b', 1), snapshot('sync-cell-c', 1)]
  const accumulator = new MetricsAccumulator(baseline)
  accumulator.record([snapshot('sync-cell-a', 12), snapshot('sync-cell-b', 9), snapshot('sync-cell-c', 3400)])
  const latest = [snapshot('sync-cell-a', 4), snapshot('sync-cell-b', 2), snapshot('sync-cell-c', 60)]
  const failure = attachSampledMetrics(new Error('baseline partition 0 cohort 1 load failed: result={}'), accumulator, latest)
  assert.match(failure.message, /^baseline partition 0 cohort 1 load failed: result=\{\}\nsampledMetrics=/)
  const payload = JSON.parse(failure.message.slice(failure.message.indexOf('sampledMetrics=') + 'sampledMetrics='.length))
  // MUTANT: attach `maxEventLoopP99Ms` alone and the owner is anonymous again.
  assert.deepEqual(payload.maxEventLoopP99MsByService, { 'sync-cell-a': 12, 'sync-cell-b': 9, 'sync-cell-c': 3400 })
  assert.equal(payload.maxEventLoopP99Ms, 3400)
  // One `record()` call; the baseline handed to the constructor is not a sample.
  assert.equal(payload.samples, 1)
  assert.equal(payload.eventLoopOutliers[0].service, 'sync-cell-c')
  assert.equal(payload.maxGenerateSyncMs, 26.35)

  // Nothing sampled yet (a failure before the first sample, or a dead
  // `lastSnapshots` wire): SAID, not silent — an untouched message reads as
  // "nothing to report". A non-Error is returned as it came.
  const early = new Error('early')
  assert.equal(attachSampledMetrics(early, accumulator, null), early)
  assert.equal(early.message, 'early\nsampledMetrics=none (no sample taken before the failure)')
  assert.equal(attachSampledMetrics('not an error', accumulator, latest), 'not an error')
})

test('B5.17: shutdownRepo is BOUNDED — a shutdown that never settles is abandoned at the bound, a finite one is awaited, a rejecting one is swallowed', async () => {
  // The wiring pin says the five sites CALL shutdownRepo; this arm says what
  // shutdownRepo does — it neither waits forever (`withDeadline` must reject)
  // nor abandons every shutdown before it starts (a bound of 0 ms).
  const never = { shutdown: () => new Promise(() => undefined) }
  let waiting
  const raced = await Promise.race([
    shutdownRepo(never, 50).then(() => 'bounded'),
    new Promise((resolveLater) => { waiting = setTimeout(() => resolveLater('still waiting'), 3_000) }),
  ])
  clearTimeout(waiting)
  assert.equal(raced, 'bounded', 'a shutdown that never settles must be abandoned at the bound')

  let completed = false
  const slow = { shutdown: () => new Promise((resolveLater) => setTimeout(() => { completed = true; resolveLater() }, 50)) }
  await shutdownRepo(slow) // the DEFAULT bound: a finite shutdown is awaited, not abandoned
  assert.equal(completed, true, 'a shutdown that completes within the bound must be awaited to completion')

  const failing = { shutdown: () => Promise.reject(new Error('socket already closed')) }
  await shutdownRepo(failing, 50) // swallowed: a finally-site cleanup must not mask the primary error
})

test('T-MA wiring: the bench frontend addresses the WebSocket router and the HTTP router at the ports THOSE services listen on, derived from their own blocks', () => {
  // A wrong port here (e.g. the image default 3001, which is a cell's port)
  // makes nginx answer every `/automerge` upgrade with 502, and the app reports
  // « Document … is unavailable » — easily misread as a data problem. Every
  // verify:* leg drives the API and the router directly; only a browser needs
  // this service. This arm derives each port from the service that LISTENS on
  // it, so a restated number cannot pass.
  const compose = readFileSync(resolve(here, '../../infra/compose/sync-cell-failover.yml'), 'utf8').replace(/\r\n/g, '\n')
  const routerConf = readFileSync(resolve(here, '../../infra/compose/sync-cell-router.nginx.conf'), 'utf8').replace(/\r\n/g, '\n')
  const serviceBlock = (name) => {
    const match = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:[ \\t]*$|^[A-Za-z]+:[ \\t]*$)`, 'm'))
    assert.ok(match, `service ${name} must exist in the bench compose file`)
    return match[1]
  }
  const envOf = (block, key) => {
    const match = block.match(new RegExp(`^\\s+${key}:\\s*"?([^"\\n]+)"?[ \\t]*$`, 'm'))
    assert.ok(match, `${key} must be set`)
    return match[1]
  }
  const frontend = serviceBlock('frontend')

  // WebSocket side: the owner-aware router, at the port it is told to listen on.
  const wsHost = envOf(frontend, 'SYNC_WS_HOST')
  const wsPort = envOf(frontend, 'SYNC_WS_PORT')
  assert.equal(wsHost, 'sync-ws-router', 'the /automerge upgrade must reach the OWNER-AWARE router, not a cell or the plain HTTP router')
  const wsRouter = serviceBlock(wsHost)
  assert.equal(wsPort, envOf(wsRouter, 'PORT'), `the frontend addresses ${wsHost} on ${wsPort}, but that service listens on PORT ${envOf(wsRouter, 'PORT')}`)
  assert.match(wsRouter, new RegExp(`127\\.0\\.0\\.1:${wsPort}/api/ready`), 'the ws-router healthcheck probes the same port')
  assert.match(routerConf, new RegExp(`^\\s+server ${wsHost}:${wsPort}\\b`, 'm'), 'the HTTP router tunnels upgrades to the same host:port')
  // The image default that survived the 09-04 fix is a CELL's container port —
  // read from the cell's own published mapping, not restated.
  const cellPort = serviceBlock('sync-cell-a').match(/:\$\{SYNC_FAILOVER_CELL_A_PORT:-\d+\}:(\d+)"/)?.[1]
  assert.ok(cellPort, 'cell A publishes a container port')
  assert.notEqual(wsPort, cellPort, 'the WebSocket port must not be a cell port')

  // HTTP side: the plain router, at the container port its published mapping and its nginx `listen` agree on.
  const httpHost = envOf(frontend, 'BACKEND_HOST')
  const httpPort = envOf(frontend, 'BACKEND_PORT')
  assert.equal(httpHost, 'router')
  const router = serviceBlock(httpHost)
  assert.match(router, new RegExp(`:\\$\\{SYNC_FAILOVER_ROUTER_PORT:-\\d+\\}:${httpPort}"`), `router publishes container port ${httpPort}`)
  assert.match(routerConf, new RegExp(`^\\s+listen ${httpPort};`, 'm'), `router nginx listens on ${httpPort}`)
})

test('T-G1b4 wiring: every /api/ready healthcheck on the bench waits at least twice the Redis command timeout, and so do the instruments that read it', () => {
  // `/api/ready` ASKS Redis with a PING bounded by REDIS_COMMAND_TIMEOUT_MS.
  // A healthcheck (or an instrument) whose own timeout is shorter than that
  // bound would record a SLOW 503 as a fetch failure — the same answer as a
  // hung process — so the bound must fit inside every reader's patience with
  // room for the database probe that runs beside it. Derived from the compose
  // values, not restated.
  const compose = readFileSync(resolve(here, '../../infra/compose/sync-cell-failover.yml'), 'utf8').replace(/\r\n/g, '\n')
  const criticalTimeoutMs = Number(compose.match(/^\s+REDIS_COMMAND_TIMEOUT_MS:\s*"(?:\$\{[^}]+:-)?(\d+)(?:\})?"/m)?.[1])
  assert.ok(Number.isInteger(criticalTimeoutMs) && criticalTimeoutMs > 0, 'the bench sets REDIS_COMMAND_TIMEOUT_MS')
  // The render-cache runtime is probed too (informational, but it costs the
  // door its own bound): its override if the bench sets one, else redis.ts's
  // default. The door's latency is the LARGER of the two.
  const redisSource = readFileSync(resolve(here, '../src/runtime/redis.ts'), 'utf8').replace(/\r\n/g, '\n')
  const defaultTimeoutMs = Number(redisSource.match(/commandTimeoutMs: boundedInteger\(variable\('COMMAND_TIMEOUT_MS'\), (\d[\d_]*),/)?.[1]?.replace(/_/g, ''))
  assert.ok(Number.isInteger(defaultTimeoutMs) && defaultTimeoutMs > 0, 'redis.ts declares the default command timeout')
  const renderCacheTimeoutMs = Number(compose.match(/^\s+REDIS_RENDER_CACHE_COMMAND_TIMEOUT_MS:\s*"(?:\$\{[^}]+:-)?(\d+)(?:\})?"/m)?.[1] ?? defaultTimeoutMs)
  const commandTimeoutMs = Math.max(criticalTimeoutMs, renderCacheTimeoutMs)
  const healthchecks = [...compose.matchAll(/healthcheck:\n((?:\s{6,}.*\n)+)/g)].map((m) => m[1])
    .filter((block) => /\/api\/ready/.test(block))
  assert.ok(healthchecks.length >= 2, `expected the cell and ws-router /api/ready healthchecks, found ${healthchecks.length}`)
  for (const block of healthchecks) {
    const timeoutS = Number(block.match(/^\s+timeout:\s*(?:"\$\{[^}]+:-)?(\d+)s/m)?.[1])
    assert.ok(Number.isInteger(timeoutS), 'each /api/ready healthcheck declares a timeout in seconds')
    assert.ok(timeoutS * 1_000 >= 2 * commandTimeoutMs, `healthcheck timeout ${timeoutS}s must be >= 2 x REDIS_COMMAND_TIMEOUT_MS (${commandTimeoutMs} ms)`)
  }
  // The Redis pause observer and the failover gate read /api/ready too.
  const observer = readFileSync(resolve(here, 'sync-cell-redis-pause-observe.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const observerTimeoutMs = Number(observer.match(/\/api\/ready`, \{ signal: AbortSignal\.timeout\((\d[\d_]*)\)/)?.[1]?.replace(/_/g, ''))
  assert.ok(observerTimeoutMs >= commandTimeoutMs + 200, `the observer's /api/ready fetch timeout (${observerTimeoutMs} ms) must cover the PING bound plus one sample period`)
  const gate = readFileSync(resolve(here, 'verify-sync-cell-failover.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const gateTimeouts = [...gate.matchAll(/AbortSignal\.timeout\((\d[\d_]*)\)/g)].map((m) => Number(m[1].replace(/_/g, '')))
  assert.ok(gateTimeouts.length > 0 && Math.min(...gateTimeouts) >= commandTimeoutMs + 200, `the failover gate's shortest fetch timeout (${Math.min(...gateTimeouts)} ms) must cover the PING bound`)
})

const topologyExpected = {
  partitionCount: 2, configuredGeneration: 'test-posture',
  effectiveGeneration: 'test-posture.ce1461953e2b8ac2',
  topologyGeneration: 'test-posture.ce1461953e2b8ac2', mappingFingerprint: 'ce1461953e2b8ac2',
}
const topologyEnvironment = {
  SYNC_CELL_TOPOLOGY_GENERATION: ' Test-Posture ', SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: 'on',
}

test('B3d2 reads the real TS source factory through the existing MJS/tsx launch', () => {
  const secret = 'synthetic-not-for-child-arguments'
  const calls = []
  const result = readRuntimeTopology({ ...topologyEnvironment, AUTH_SECRET: secret, MAPPING_FINGERPRINT: 'a'.repeat(16) }, (file, args, options) => {
    calls.push({ file, args, options })
    return execFileSync(file, args, options)
  })
  assert.deepEqual(result.expectedTopology, topologyExpected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, process.execPath)
  assert.deepEqual(calls[0].args.slice(0, 2), ['--import', 'tsx'])
  assert.equal(JSON.stringify(calls).includes(secret), false)
  assert.equal(Object.hasOwn(calls[0].options.env, 'NODE_OPTIONS'), false)
  assert.equal(Object.hasOwn(calls[0].options.env, 'DATABASE_URL'), false)
  assert.equal(calls[0].args.at(-2).includes("from './dist/"), false)
  assert.deepEqual(Object.keys(result.sources).sort(), ['server/src/syncCells/assignment.ts', 'server/src/syncCells/topologyContract.ts'])
  for (const value of Object.values(result.sources)) assert.match(value, /^[a-f0-9]{64}$/)
})

function topologyRunningFixture(change = () => {}, nativeProbe = null) {
  const services = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c', 'sync-ws-router', 'router']
  const ids = services.map((_, index) => String(index + 1).repeat(64))
  const inspections = new Map()
  const calls = []
  const exec = (file, args, options) => {
    calls.push({ file, args })
    if (file === process.execPath) return execFileSync(file, args, options)
    assert.equal(file, 'docker')
    if (args[0] === 'context') {
      const output = { value: 'unix:///var/run/docker.sock' }
      change('context', null, output)
      return JSON.stringify(output.value)
    }
    if (args[0] === 'ps') {
      const service = args.find(value => value.startsWith('label=com.docker.compose.service=')).split('=').at(-1)
      const output = { value: ids[services.indexOf(service)] }
      change('ps', service, output)
      return output.value
    }
    const id = ids.find(value => args.includes(value))
    assert.ok(id, 'probe must target an inventoried container ID')
    const service = services[ids.indexOf(id)]
    if (args[0] === 'inspect') {
      assert.equal(args.at(-1).includes('Config.Env'), false)
      const count = (inspections.get(id) ?? 0) + 1
      inspections.set(id, count)
      const index = services.indexOf(service)
      const ports = service === 'router' ? { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '3330' }] }
        : index < 3 ? { '3001/tcp': [{ HostIp: '127.0.0.1', HostPort: String(3331 + index) }] } : {}
      const output = { id, image: 'sha256:' + 'a'.repeat(64), startedAt: '2026-09-07T00:00:00Z',
        restartCount: 0, running: true, project: 'qa-topology', service, ports }
      change(count === 1 ? 'before' : 'after', service, output)
      return JSON.stringify(output)
    }
    assert.equal(args[0], 'exec')
    assert.ok(args.includes('NODE_OPTIONS='))
    assert.ok(args.includes('NODE_PATH='))
    const output = nativeProbe ? JSON.parse(nativeProbe(args)) : {
      topology: { ...topologyExpected },
      modules: { 'dist/syncCells/assignment.js': 'b'.repeat(64), 'dist/syncCells/topologyContract.js': 'c'.repeat(64) },
    }
    change('probe', service, output)
    return JSON.stringify(output)
  }
  return { exec, calls }
}

test('B3d2 inspects every compiled cell and router before qualifying the topology', () => {
  const fixture = topologyRunningFixture()
  const record = qualifyRuntimeTopology('qa-topology', topologyEnvironment, fixture.exec, targetBinding)
  assert.deepEqual(record.expectedTopology, topologyExpected)
  assert.deepEqual(record.running.map(cell => cell.service), ['sync-cell-a', 'sync-cell-b', 'sync-cell-c', 'sync-ws-router'])
  assert.equal(fixture.calls.filter(call => call.args[0] === 'exec').length, 4)
  assert.equal(fixture.calls.filter(call => call.args[0] === 'inspect').length, 9)
  assert.doesNotThrow(() => assertTopologyBuild(record))
})

test('B3d2 compiled probe is executable Node code and reads its own module bytes', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'maplespire-topology-probe-'))
  try {
    mkdirSync(resolve(directory, 'dist/syncCells'), { recursive: true })
    writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(resolve(directory, 'dist/syncCells/assignment.js'),
      'export const MAPPING_FINGERPRINT = "ce1461953e2b8ac2";\n'
      + 'export function syncCellPartitionConfig(env) { const configuredGeneration = env.SYNC_CELL_TOPOLOGY_GENERATION.trim().toLowerCase(); '
      + 'const effectiveGeneration = configuredGeneration + "." + MAPPING_FINGERPRINT; '
      + 'return { configuredGeneration, effectiveGeneration, topologyGeneration: effectiveGeneration, partitionCount: Number(env.SYNC_CELL_PARTITION_COUNT) }; }\n')
    writeFileSync(resolve(directory, 'dist/syncCells/topologyContract.js'), 'export const fixture = true;\n')
    const fixture = topologyRunningFixture(() => {}, args => execFileSync(process.execPath, args.slice(args.indexOf('node') + 1), {
      cwd: directory, env: topologyEnvironment, encoding: 'utf8', timeout: 5_000,
    }))
    const observed = inspectRunningTopology('qa-topology', topologyExpected, fixture.exec, targetBinding)
    assert.equal(observed.running.length, 4)
    for (const cell of observed.running) {
      assert.deepEqual(cell.topology, topologyExpected)
      assert.notEqual(cell.modules['dist/syncCells/assignment.js'], cell.modules['dist/syncCells/topologyContract.js'])
    }
  } finally {
    assert.equal(dirname(directory), resolve(tmpdir()))
    assert.ok(directory.startsWith(resolve(tmpdir(), 'maplespire-topology-probe-')))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B3d2 refuses a foreign compiled fingerprint, legacy factory, or missing compiled module hash', () => {
  for (const mutation of [
    (stage, service, output) => { if (stage === 'probe' && service === 'sync-cell-b') output.topology = { ...topologyExpected, mappingFingerprint: 'a'.repeat(16), effectiveGeneration: 'test-posture.' + 'a'.repeat(16), topologyGeneration: 'test-posture.' + 'a'.repeat(16) } },
    (stage, service, output) => { if (stage === 'probe' && service === 'sync-ws-router') delete output.topology.configuredGeneration },
    (stage, service, output) => { if (stage === 'probe' && service === 'sync-cell-c') delete output.modules['dist/syncCells/topologyContract.js'] },
  ]) {
    const fixture = topologyRunningFixture(mutation)
    assert.throws(() => inspectRunningTopology('qa-topology', topologyExpected, fixture.exec, targetBinding))
  }
})

test('B3d2 refuses ambiguous inventory, foreign labels and restart during the compiled probe', () => {
  for (const mutation of [
    (stage, service, output) => { if (stage === 'ps' && service === 'sync-cell-a') output.value = '' },
    (stage, service, output) => { if (stage === 'ps' && service === 'sync-cell-a') output.value += '\n' + 'f'.repeat(64) },
    (stage, service, output) => { if (stage === 'before' && service === 'sync-cell-a') output.project = 'another-project' },
    (stage, service, output) => { if (stage === 'before' && service === 'sync-cell-a') output.service = 'another-service' },
    (stage, service, output) => { if (stage === 'after' && service === 'sync-cell-a') output.restartCount = 1 },
    (stage, service, output) => { if (stage === 'after' && service === 'sync-cell-a') output.running = false },
  ]) {
    const fixture = topologyRunningFixture(mutation)
    assert.throws(() => inspectRunningTopology('qa-topology', topologyExpected, fixture.exec, targetBinding))
  }
})

test('B3d2 source and native command failures cannot produce a topology certificate', () => {
  assert.throws(() => readRuntimeTopology(topologyEnvironment, () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }), /timed out/)
  assert.throws(() => readRuntimeTopology(topologyEnvironment, () => '{}'))
  assert.throws(() => inspectRunningTopology('qa-topology', topologyExpected, () => { throw new Error('docker unavailable') }, targetBinding), /docker unavailable/)
  assert.throws(() => inspectRunningTopology('qa-topology', topologyExpected, () => 'not json', targetBinding))
})

const targetBinding = { host: '127.0.0.1', cellPorts: [3331, 3332, 3333], routerPort: 3330 }
test('B3d2 target binding rejects another project ports despite the same generation', () => {
  const fixture = topologyRunningFixture()
  assert.throws(() => inspectRunningTopology('qa-topology', topologyExpected, fixture.exec,
    { ...targetBinding, cellPorts: [4441, 4442, 4443], routerPort: 4440 }), /published port/)
})

test('B3d2 target binding keeps the matching project control healthy', () => {
  const fixture = topologyRunningFixture()
  const observed = inspectRunningTopology('qa-topology', topologyExpected, fixture.exec, targetBinding)
  assert.equal(observed.running.length, 4)
  assert.equal(observed.edge.target.url, 'http://127.0.0.1:3330')
})

test('B3d2 target binding checks the entry router port and rejects nonlocal targets', () => {
  for (const targets of [
    { ...targetBinding, routerPort: 4440 },
    { ...targetBinding, host: '192.0.2.5' },
    { ...targetBinding, host: 'localhost' },
    { ...targetBinding, cellPorts: [3331, 3332] },
    { ...targetBinding, cellPorts: [3331, 3332, 3330] },
  ]) {
    assert.throws(() => inspectRunningTopology('qa-topology', topologyExpected, topologyRunningFixture().exec, targets))
  }
  const fixture = topologyRunningFixture((stage, _service, output) => {
    if (stage === 'context') output.value = 'ssh://remote-engine'
  })
  assert.throws(() => inspectRunningTopology('qa-topology', topologyExpected, fixture.exec, targetBinding), /local Docker socket/)
  assert.equal(fixture.calls.filter(call => call.args[0] === 'exec').length, 0)
})

test('B3d2 revalidates the same HTTP bindings and five container identities at admission', () => {
  const fixture = topologyRunningFixture()
  const record = qualifyRuntimeTopology('qa-topology', topologyEnvironment, fixture.exec, targetBinding)
  const preflightCalls = fixture.calls.length
  const receipt = revalidateTopologyTargets(record, targetBinding, 'qa-topology', fixture.exec)
  assert.equal(receipt.containers.length, 5)
  assert.equal(receipt.containers[0].id, record.running[0].id)
  assert.ok(receipt.endedAt >= receipt.beganAt)
  const calls = fixture.calls.slice(preflightCalls)
  assert.equal(calls.filter(call => call.args[0] === 'inspect').length, 5)
  assert.equal(calls.filter(call => call.args[0] === 'exec').length, 0)
})

test('B3d2 refuses changed topology identities or bindings after the preflight wait', () => {
  for (const change of [
    (service, cell) => { if (service === 'sync-cell-a') cell.restartCount += 1 },
    (service, cell) => { if (service === 'sync-cell-b') cell.project = 'another-project' },
    (service, cell) => { if (service === 'sync-ws-router') cell.id = 'f'.repeat(64) },
    (service, cell) => { if (service === 'router') cell.ports['8080/tcp'][0].HostPort = '4440' },
  ]) {
    let afterWait = false
    const fixture = topologyRunningFixture((stage, service, output) => {
      if (afterWait && stage === 'after') change(service, output)
    })
    const record = qualifyRuntimeTopology('qa-topology', topologyEnvironment, fixture.exec, targetBinding)
    afterWait = true
    assert.throws(() => revalidateTopologyTargets(record, targetBinding, 'qa-topology', fixture.exec))
  }
})

test('B3d2 load revalidation uses the actual requested project and HTTP targets', () => {
  const config = postureConfig()
  const calls = []
  const receipt = topologyReceiptFixture()
  assert.equal(revalidateLoadTopology(config, (...args) => { calls.push(args); return receipt }), receipt)
  assert.deepEqual(calls, [[config.topologyBuild, { host: config.host, cellPorts: config.cellPorts, routerPort: config.routerPort }, config.project]])
})

test('B3d2 keeps all edit barriers closed when the HTTP binding changes during admission wait', async () => {
  let switched = false
  const fixture = topologyRunningFixture((stage, service, output) => {
    if (switched && stage === 'after' && service === 'sync-cell-a') output.ports['3001/tcp'][0].HostPort = '4441'
  })
  const build = qualifyRuntimeTopology('qa-topology', topologyEnvironment, fixture.exec, targetBinding)
  const config = postureConfig({ project: 'qa-topology', topologyBuild: build })
  const baseline = postureAdmission()
  const order = []
  const processes = baseline.cohorts.map(entry => ({
    partition: entry.partition, cohort: entry.cohort, barrier: { ready: entry, error: null },
    releaseBaseline: async () => { order.push('release') },
  }))
  const snapshots = baseline.cells.map(entry => ({
    service: entry.service, ownership: entry.ownership,
    stats: { processBootId: entry.processBootId, transport: { connections: { active: entry.activeConnections } } },
  }))
  const qualify = () => {
    order.push('revalidate')
    return revalidateLoadTopology(config, (record, targets, project) => revalidateTopologyTargets(record, targets, project, fixture.exec))
  }
  assert.ok(baselineBarrierAdmission(baseline.barrierId, processes, snapshots), 'client readiness alone is healthy')
  switched = true
  await assert.rejects(releaseBaselineIfAdmitted(baseline.barrierId, processes, snapshots, qualify), /published port/)
  assert.deepEqual(order, ['revalidate'], 'no edit instruction was sent')
  switched = false
  order.length = 0
  const admission = await releaseBaselineIfAdmitted(baseline.barrierId, processes, snapshots, qualify)
  assert.deepEqual(order, ['revalidate', ...Array(8).fill('release')])
  assert.ok(admission.topologyTargets.beganAt >= admission.observedAt)
  assert.ok(admission.topologyTargets.endedAt <= admission.releaseStartedAt)
  assert.equal(admission.topologyTargets.containers[0].id, build.running[0].id)
})

test('B3d2 evaluator refuses a target switch or a missing/stale admission receipt', () => {
  for (const change of [
    (config) => { config.cellPorts = [4441, 4442, 4443] },
    (config) => { config.routerPort = 4440 },
    (config) => { config.project = 'another-project' },
    (_config, evidence) => { delete evidence.baselineAdmission.topologyTargets },
    (_config, evidence) => { evidence.baselineAdmission.topologyTargets.beganAt = 299 },
    (_config, evidence) => { evidence.baselineAdmission.topologyTargets.endedAt = 311 },
    (_config, evidence) => { evidence.baselineAdmission.topologyTargets.containers[0].restartCount += 1 },
  ]) {
    const config = postureConfig(), evidence = postureEvidence()
    change(config, evidence)
    const record = evaluatePostureBaseline(evidence, config)
    assert.equal(record.status, 'VOID', JSON.stringify(record))
    assert.equal(record.criteria.partitionLossCountZero, null)
  }
})

test('outside a posture qualification, cohorts are released together and only once all are holding', async () => {
  const barrierId = '11111111-1111-4111-8111-111111111111'
  const nonce = '22222222-2222-4222-8222-222222222222'
  const released = []
  const entry = (partition, cohort, ready) => ({ partition, cohort,
    barrier: { ready: ready ? { barrierId, users: 5, userOffset: cohort * 5, totalUsers: 10 } : null, error: null },
    releaseBaseline: async (value) => { released.push([partition, cohort, value]) } })
  const waiting = [entry(0, 0, true), entry(0, 1, false), entry(1, 0, true), entry(1, 1, true)]
  assert.equal(await releaseCohortsIfReady(barrierId, waiting, () => nonce), null)
  assert.deepEqual(released, [], 'a cohort still connecting holds every other cohort back')
  assert.equal(await releaseCohortsIfReady(barrierId, [], () => nonce), null)
  const ready = waiting.map((item) => entry(item.partition, item.cohort, true))
  const admission = await releaseCohortsIfReady(barrierId, ready, () => nonce)
  assert.equal(admission.releaseNonce, nonce)
  assert.equal(admission.cohorts.length, 4)
  assert.deepEqual(released, ready.map((item) => [item.partition, item.cohort, nonce]))
  await assert.rejects(releaseCohortsIfReady(barrierId, ready, () => barrierId), /separate nonce/)
})
