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

import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { Repo } from '@automerge/automerge-repo'
import { AuthenticatedWebSocketClientAdapter } from '../qa/authenticatedWebSocketAdapter.mjs'
import { appendOverlayBatchId, loadObjectIds, objectMap, percentile, resolveLoadHandle } from '../qa/loadUsersCore.mjs'
import { makeObject } from '../qa/lib.mjs'
import { assertLoadUserEvidence, parseClosedLoadOutput } from '../qa/loadUserEvidence.mjs'
import { assertTopologyBuild, assertTopologyTargetReceipt, qualifyRuntimeTopology, revalidateTopologyTargets } from './sync-bench-posture.mjs'
import { RehearsalObservations, RehearsalSampler, closeRehearsalSeeder, freshnessIdentityValid, isFreshWitness, measureTakeover, publishRehearsalBases, rehearsalDurableAcknowledged } from './sync-cell-rehearsal.mjs'
import { readCalibrationReceipt } from './sync-cell-calibration.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const composeFile = resolve(here, '../../infra/compose/sync-cell-failover.yml')
const loadUsersScript = resolve(here, '../qa/load-users.mjs')
const activeLoadProcesses = new Set()
/** The run lock of the run in progress, so an ABANDONED run can still
 *  give it back: `main()`'s `finally` never runs when `run()` never settles. */
let activeRunLock = null
/** Where `run()` is, for the failure line of a run that never produced a
 *  verdict. Nothing else reads it. */
let currentPhase = 'not started'

function setPhase(label) {
  currentPhase = label
}

export function currentGatePhase() {
  return currentPhase
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

/** `promise`, or a rejection after `ms` — with the timer cleared either way, so
 *  a fast resolution does not leave a handle behind. */
function withDeadline(promise, ms, label) {
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/**
 * A repo shutdown that cannot hang the gate. An unbounded `repo.shutdown()` in
 * a `finally` is a candidate for a promise that never settles once every
 * socket is closed; this bound removes it from the list of things that can.
 */
export async function shutdownRepo(repo, boundMs = 10_000) {
  await withDeadline(repo.shutdown(), boundMs, 'repo shutdown').catch(() => undefined)
}

/**
 * THE VERDICT GUARD.
 *
 * If `run()` never settles and the event loop drains, Node exits with the
 * default code 0 and `main().catch(...)` has nothing to catch — read by `&&` or
 * a CI, that is a GREEN with no verdict printed. Three properties prevent it,
 * each on its own:
 *
 *  1. The exit code is PESSIMISTIC: `arm()` sets it to 1 and only `settle()`
 *     with a verdict whose `outcome` is `"passed"` sets it to 0. Any path that
 *     ends the process without going through `settle()` — a drained loop, an
 *     uncaught throw, a killed run — is red by construction, not by remembering
 *     to set it.
 *  2. A drained loop is PRINTED, not silent: `beforeExit` fires exactly when
 *     Node is about to exit for lack of work, and the listener names the phase
 *     `run()` was in and hands the stack back (unpause, kill the load children,
 *     release the run lock) before the process goes. A promise with no handle
 *     behind it is by definition LOST — every await in `run()` is backed by a
 *     socket, a timer or a child — so this fires promptly, not at the ceiling.
 *  3. A CEILING on the whole run, derived from its own bounded waits
 *     (`defaultRunDeadlineMs`), for the run that is HUNG with live handles (a
 *     socket that never answers, a child that never exits). The timer is
 *     UNREFERENCED on purpose: referenced, it would itself hold the loop and
 *     property 2 could never fire (a drained loop would be reported seconds
 *     later by the ceiling instead of at once by `beforeExit`). When it fires
 *     the process is ended with 1 after the same cleanup — `process.exit`,
 *     because nothing else will.
 *
 * `proc`, `setTimer` and `clearTimer` are injectable for the unit arms; the
 * arms that matter run the real thing in a child process
 * (`verify-sync-cell-load-soak.test.mjs`) wired like the entry block below —
 * a deadline armed AND a loop that drains — because "beforeExit fires" and
 * "an unref'd timer does not hold the loop" are properties of Node, not of a
 * fake.
 */
export function createVerdictGuard({
  deadlineMs = null,
  phase = () => 'unknown',
  onAbandon = () => undefined,
  log = console.log,
  error = console.error,
  proc = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let settled = false
  let timer = null
  const abandon = (reason) => {
    if (settled) return false
    settled = true
    error(`load gate failed: ${reason}; phase="${phase()}"; no verdict was produced, so the exit code is 1`)
    try {
      onAbandon()
    } catch (cleanupError) {
      error(`load gate cleanup after abandonment also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    }
    proc.exitCode = 1
    return true
  }
  const onBeforeExit = () => {
    abandon('the event loop drained before run() settled')
  }
  const disarm = () => {
    proc.removeListener('beforeExit', onBeforeExit)
    if (timer) {
      clearTimer(timer)
      timer = null
    }
  }
  const exitAfterFlush = () => {
    // The write callback is a belt-and-braces flush before `process.exit`.
    // A pipe delivers stderr intact even with a synchronous exit (measured on
    // win32 / Node 22.14 up to 4 MiB); a Windows TTY is asynchronous in Node
    // and needs it. It costs one empty write.
    if (proc.stderr && typeof proc.stderr.write === 'function') proc.stderr.write('', () => proc.exit(1))
    else proc.exit(1)
  }
  return {
    arm() {
      proc.exitCode = 1
      proc.on('beforeExit', onBeforeExit)
      if (deadlineMs != null) {
        timer = setTimer(() => {
          timer = null
          if (abandon(`run deadline of ${deadlineMs} ms exceeded`)) exitAfterFlush()
        }, deadlineMs)
        // UNREFERENCED, or the ceiling itself keeps the loop alive and the
        // drain listener above can never fire (see the docblock, property 3).
        // The fakes of the unit arms have no `unref`; the real timer does.
        timer.unref?.()
      }
    },
    settle(verdict) {
      if (settled) return
      settled = true
      disarm()
      log(JSON.stringify(verdict))
      if (verdict?.outcome === 'passed') {
        proc.exitCode = 0
        return
      }
      error(`load gate failed: verdict outcome is ${JSON.stringify(verdict?.outcome ?? null)}, not "passed"`)
      proc.exitCode = 1
    },
    fail(reason) {
      if (settled) return
      settled = true
      disarm()
      error(reason instanceof Error ? reason.message : String(reason))
      proc.exitCode = 1
    },
    settled() {
      return settled
    },
  }
}

function boundedInteger(raw, fallback, minimum, maximum, label) {
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

/**
 * The two load PROFILES.
 *
 * `contention`: every connected user writes every shared object every round,
 * so 100 users is 100 WRITERS on the SAME five objects — each change re-fanned
 * to 99 peers. That is a maximal contention stress, not a collaboration
 * profile (on a development host its knee sits between 25 and 50 users).
 * `fleet` is the shape the product actually claims — many connected, a few
 * writing, on distinct objects — and it is measured separately rather than
 * read off the contention number.
 *
 * A preset fills the DEFAULTS; every `SYNC_LOAD_*` knob still overrides it.
 */
export const LOAD_PROFILES = {
  contention: {
    usersPerWorkspace: 25,
    writersPerWorkspace: null, // every user writes
    objects: 5,
    objectAssignment: 'shared',
    clientsPerProcess: 10,
  },
  fleet: {
    usersPerWorkspace: 100,
    writersPerWorkspace: 10,
    objects: 10,
    objectAssignment: 'per-writer',
    clientsPerProcess: 25,
  },
}

export function parseLoadSoakConfig(env = process.env, argv = process.argv.slice(2)) {
  const mode = argv.find((arg) => arg.startsWith('--mode='))?.slice(7)
    || env.SYNC_LOAD_MODE?.trim()
    || 'smoke'
  if (!['smoke', 'soak', 'endurance'].includes(mode)) {
    throw new Error('SYNC_LOAD_MODE/--mode must be smoke, soak, or endurance')
  }
  const profile = argv.find((arg) => arg.startsWith('--profile='))?.slice(10)
    || env.SYNC_LOAD_PROFILE?.trim()
    || 'contention'
  if (!Object.hasOwn(LOAD_PROFILES, profile)) {
    throw new Error(`SYNC_LOAD_PROFILE/--profile must be one of ${Object.keys(LOAD_PROFILES).join(', ')}`)
  }
  const preset = LOAD_PROFILES[profile]
  const minimumDuration = mode === 'soak' ? 2 * 60 * 60_000 : mode === 'endurance' ? 8 * 60 * 60_000 : 0
  const soakDurationMs = boundedInteger(
    env.SYNC_LOAD_SOAK_DURATION_MS,
    minimumDuration,
    0,
    12 * 60 * 60_000,
    'SYNC_LOAD_SOAK_DURATION_MS',
  )
  if (soakDurationMs < minimumDuration) {
    throw new Error(`${mode} mode requires at least ${minimumDuration} ms of sustained cycles`)
  }
  const usersPerWorkspace = boundedInteger(env.SYNC_LOAD_USERS_PER_WORKSPACE, preset.usersPerWorkspace, 2, 500, 'SYNC_LOAD_USERS_PER_WORKSPACE')
  if (mode !== 'smoke' && usersPerWorkspace < 25) {
    throw new Error(`${mode} mode requires at least 25 users per hot workspace`)
  }
  // WRITERS are counted per hot workspace and taken from the FRONT of the user
  // index, across cohorts: user i writes iff i < writersPerWorkspace. Every
  // connected user — writer or reader — must converge; only the writers'
  // fields are expected.
  const writersPerWorkspace = boundedInteger(
    env.SYNC_LOAD_WRITERS_PER_WORKSPACE,
    preset.writersPerWorkspace ?? usersPerWorkspace,
    1,
    500,
    'SYNC_LOAD_WRITERS_PER_WORKSPACE',
  )
  if (writersPerWorkspace > usersPerWorkspace) {
    throw new Error('SYNC_LOAD_WRITERS_PER_WORKSPACE cannot exceed SYNC_LOAD_USERS_PER_WORKSPACE')
  }
  const objectAssignment = env.SYNC_LOAD_OBJECT_ASSIGNMENT?.trim() || preset.objectAssignment
  if (!['shared', 'per-writer'].includes(objectAssignment)) {
    throw new Error('SYNC_LOAD_OBJECT_ASSIGNMENT must be shared or per-writer')
  }
  const freshWorkspaces = env.SYNC_LOAD_FRESH_WORKSPACES == null
    ? Boolean(env.SYNC_BENCH_POSTURE && mode === 'soak')
    : env.SYNC_LOAD_FRESH_WORKSPACES === 'on'
  const segmentedWorkspaces = env.SYNC_LOAD_SEGMENTED_WORKSPACES === 'on'
  const workspaceSelectors = (env.SYNC_LOAD_WORKSPACES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':')
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error('SYNC_LOAD_WORKSPACES entries must use landscapeId:versionId')
      }
      return { landscapeId: entry.slice(0, separator), versionId: entry.slice(separator + 1) }
    })
  if (freshWorkspaces && segmentedWorkspaces) {
    throw new Error('segmented load requires pre-seeded performance workspaces, not fresh monolithic workspaces')
  }
  if (workspaceSelectors.length > 0 && workspaceSelectors.length !== 2) {
    throw new Error('SYNC_LOAD_WORKSPACES must contain exactly two workspaces')
  }
  if (freshWorkspaces && workspaceSelectors.length > 0) {
    throw new Error('explicit load workspaces cannot be combined with fresh workspaces')
  }
  const config = {
    mode,
    profile,
    benchPosture: env.SYNC_BENCH_POSTURE?.trim() || null,
    calibrationBinding: { path: env.SYNC_G47_CALIBRATION_PATH, sha256: env.SYNC_G47_CALIBRATION_SHA256, nonce: env.SYNC_G47_CALIBRATION_NONCE },
    partitionCount: boundedInteger(env.SYNC_FAILOVER_PARTITION_COUNT, 2, 1, 1024, 'SYNC_FAILOVER_PARTITION_COUNT'),
    topologyGeneration: env.SYNC_FAILOVER_TOPOLOGY_GENERATION?.trim() || null,
    writersPerWorkspace,
    objectAssignment,
    // Where the router and the cells are reachable, for a two-host run: the
    // gate and its load clients run on one machine, the compose stack on
    // another. Loopback stays the default. `docker compose
    // pause` still goes wherever DOCKER_HOST points, which is how the pause
    // reaches the other machine.
    host: benchHost(env.SYNC_FAILOVER_HOST),
    project: env.SYNC_FAILOVER_PROJECT?.trim() || 'maplespire-sync-load-soak',
    routerPort: boundedInteger(env.SYNC_FAILOVER_ROUTER_PORT, 3330, 1, 65_535, 'SYNC_FAILOVER_ROUTER_PORT'),
    cellPorts: [
      boundedInteger(env.SYNC_FAILOVER_CELL_A_PORT, 3331, 1, 65_535, 'SYNC_FAILOVER_CELL_A_PORT'),
      boundedInteger(env.SYNC_FAILOVER_CELL_B_PORT, 3332, 1, 65_535, 'SYNC_FAILOVER_CELL_B_PORT'),
      boundedInteger(env.SYNC_FAILOVER_CELL_C_PORT, 3333, 1, 65_535, 'SYNC_FAILOVER_CELL_C_PORT'),
    ],
    loginEmail: env.SYNC_FAILOVER_LOGIN_EMAIL?.trim() || 'failover-admin@maplespire.local',
    freshWorkspaces,
    segmentedWorkspaces,
    workspaceSelectors,
    usersPerWorkspace,
    clientsPerProcess: boundedInteger(
      env.SYNC_LOAD_CLIENTS_PER_PROCESS,
      preset.clientsPerProcess,
      2,
      100,
      'SYNC_LOAD_CLIENTS_PER_PROCESS',
    ),
    rounds: boundedInteger(env.SYNC_LOAD_ROUNDS, 4, 1, 100, 'SYNC_LOAD_ROUNDS'),
    objects: boundedInteger(env.SYNC_LOAD_OBJECTS, preset.objects, 1, 100, 'SYNC_LOAD_OBJECTS'),
    seedObjectCount: boundedInteger(env.SYNC_LOAD_SEED_OBJECT_COUNT, env.SYNC_BENCH_POSTURE && mode === 'soak' ? 12_000 : 0, 0, 12_000, 'SYNC_LOAD_SEED_OBJECT_COUNT'),
    settleMs: boundedInteger(env.SYNC_LOAD_SETTLE_MS, 45_000, 5_000, 5 * 60_000, 'SYNC_LOAD_SETTLE_MS'),
    staggerMs: boundedInteger(env.SYNC_LOAD_STAGGER_MS, 40, 0, 5_000, 'SYNC_LOAD_STAGGER_MS'),
    normalConvergenceBudgetMs: boundedInteger(env.SYNC_LOAD_NORMAL_CONVERGENCE_MS, 3_000, 500, 60_000, 'SYNC_LOAD_NORMAL_CONVERGENCE_MS'),
    failoverConvergenceBudgetMs: boundedInteger(env.SYNC_LOAD_FAILOVER_CONVERGENCE_MS, 3_000, 500, 5 * 60_000, 'SYNC_LOAD_FAILOVER_CONVERGENCE_MS'),
    takeoverBudgetMs: boundedInteger(env.SYNC_LOAD_TAKEOVER_MS, 2_000, 500, 60_000, 'SYNC_LOAD_TAKEOVER_MS'),
    maxExpectedStaleFenceRejections: boundedInteger(
      env.SYNC_LOAD_MAX_EXPECTED_STALE_FENCE_REJECTIONS,
      // A paused owner can resume with one read-model projection save and the
      // two Automerge storage chunks for the hot document already in flight.
      // Fencing must reject all three. More than that indicates an unbounded
      // retry/save storm and remains a hard qualification failure.
      3,
      0,
      1_000,
      'SYNC_LOAD_MAX_EXPECTED_STALE_FENCE_REJECTIONS',
    ),
    maxExpectedCoalescedStaleFenceRejections: boundedInteger(
      env.SYNC_LOAD_MAX_EXPECTED_COALESCED_STALE_FENCE_REJECTIONS,
      // The reproduced failover produced one exact duplicate after the two
      // distinct in-flight chunks. Anything beyond that is a retry storm.
      1,
      0,
      1_000,
      'SYNC_LOAD_MAX_EXPECTED_COALESCED_STALE_FENCE_REJECTIONS',
    ),
    maxCoalescedStaleFenceRejectionsPerMutation: boundedInteger(
      env.SYNC_LOAD_MAX_COALESCED_STALE_FENCE_REJECTIONS_PER_MUTATION,
      1,
      0,
      100,
      'SYNC_LOAD_MAX_COALESCED_STALE_FENCE_REJECTIONS_PER_MUTATION',
    ),
    maxEventLoopP99Ms: boundedInteger(env.SYNC_LOAD_MAX_EVENT_LOOP_P99_MS, 100, 10, 5_000, 'SYNC_LOAD_MAX_EVENT_LOOP_P99_MS'),
    // Selective sync is allowed to bind a client to a small working set, but
    // never to every document already resident on the cell. Three bindings
    // per hot-workspace user covers root/meta/write-head access while still
    // catching the seven-doc-per-peer fanout regression seen under load.
    maxSynchronizerPeerBindings: boundedInteger(
      env.SYNC_LOAD_MAX_SYNCHRONIZER_PEER_BINDINGS,
      usersPerWorkspace * 3,
      usersPerWorkspace,
      usersPerWorkspace * 20,
      'SYNC_LOAD_MAX_SYNCHRONIZER_PEER_BINDINGS',
    ),
    failureArmMs: boundedInteger(env.SYNC_LOAD_FAILURE_ARM_MS, 5_000, 2_000, 60_000, 'SYNC_LOAD_FAILURE_ARM_MS'),
    soakDurationMs,
    sampleMs: boundedInteger(env.SYNC_LOAD_SAMPLE_MS, 500, 100, 5_000, 'SYNC_LOAD_SAMPLE_MS'),
    // How long one diagnostics read of a cell under load may take before the
    // sample counts as failed.
    diagnosticTimeoutMs: boundedInteger(env.SYNC_LOAD_DIAGNOSTIC_TIMEOUT_MS, 1_500, 500, 30_000, 'SYNC_LOAD_DIAGNOSTIC_TIMEOUT_MS'),
  }
  // The whole-run ceiling. Derived from the run's own bounded waits so
  // that a run past it IS hung, not slow — see `defaultRunDeadlineMs`.
  config.runDeadlineMs = boundedInteger(
    env.SYNC_LOAD_RUN_DEADLINE_MS,
    defaultRunDeadlineMs(config),
    60_000,
    14 * 60 * 60_000,
    'SYNC_LOAD_RUN_DEADLINE_MS',
  )
  if (config.benchPosture !== null) assertPostureQualificationConfig(config)
  return config
}

/** The posture qualification is the declared fleet experiment. Refuse an
 * ambient override rather than silently relabel a smaller load or a wider
 * budget as that experiment. */
export function assertPostureQualificationConfig(config) {
  if (!['bench', 'shipped'].includes(config.benchPosture)) {
    throw new Error('SYNC_BENCH_POSTURE must be bench or shipped')
  }
  const expected = {
    ...(config.mode === 'soak' ? { freshWorkspaces: true, segmentedWorkspaces: false, seedObjectCount: 12_000 } : { seedObjectCount: 0 }),
    partitionCount: 2,
    mode: config.mode === 'soak' ? 'soak' : 'smoke', profile: 'fleet', usersPerWorkspace: 100, writersPerWorkspace: 10,
    objects: 10, objectAssignment: 'per-writer', clientsPerProcess: 25, rounds: 4,
    staggerMs: 40, settleMs: 45_000, sampleMs: 500, diagnosticTimeoutMs: 1_500, failureArmMs: 5_000,
    soakDurationMs: config.mode === 'soak' ? 7_200_000 : 0, normalConvergenceBudgetMs: 3_000,
    failoverConvergenceBudgetMs: 3_000, takeoverBudgetMs: 2_000,
    maxEventLoopP99Ms: 100, maxSynchronizerPeerBindings: 300,
    maxExpectedStaleFenceRejections: 3, maxExpectedCoalescedStaleFenceRejections: 1,
    maxCoalescedStaleFenceRejectionsPerMutation: 1,
  }
  const differences = Object.entries(expected)
    .filter(([key, value]) => config[key] !== value)
    .map(([key, value]) => `${key}=${JSON.stringify(config[key])} (requires ${JSON.stringify(value)})`)
  if (differences.length) throw new Error(`T-POST qualification configuration refused: ${differences.join('; ')}`)
}

/** Resolve before application I/O. The source factory supplies the expectation;
 * all four compiled services must match it, even for a direct CLI invocation. */
export function resolveLoadTopology(config, qualify = qualifyRuntimeTopology) {
  assertPostureQualificationConfig(config)
  if (typeof config.topologyGeneration !== 'string' || !config.topologyGeneration.trim()) {
    throw new Error('baseline expected configured topology generation is missing')
  }
  const record = qualify(config.project, {
    SYNC_CELL_TOPOLOGY_GENERATION: config.topologyGeneration,
    SYNC_CELL_PARTITION_COUNT: String(config.partitionCount),
    SYNC_CELL_MULTI_PARTITION: 'on',
  }, undefined, loadTopologyTargets(config))
  assertTopologyBuild(record, loadTopologyTargets(config), config.project)
  if (record.expectedTopology.partitionCount !== config.partitionCount
    || record.expectedTopology.configuredGeneration !== config.topologyGeneration.trim().toLowerCase()) {
    throw new Error('baseline source topology differs from the requested configuration')
  }
  return record
}

function loadTopologyTargets(config) {
  return { host: config.host, cellPorts: config.cellPorts, routerPort: config.routerPort }
}

export function revalidateLoadTopology(config, revalidate = revalidateTopologyTargets) {
  return revalidate(config.topologyBuild, loadTopologyTargets(config), config.project)
}

/**
 * The `waitFor` timeouts and `settleMs` windows of `run()` at their NOMINAL
 * multiplicity (two workspaces, two targets, one failover, one soak cycle past
 * the soak duration, one cleanup), plus slack — so the ceiling bounds the HANG,
 * not the work. It is NOT the sum of every bounded wait: it leaves out
 * `resolveLoadHandle`'s own retry budget (50 × 10 s per handle, 3 × 10 s per
 * user in `load-users.mjs`), the clients' seed-settle window, read-model paging
 * in cleanup, and more than two fresh landscapes. A gate that legitimately
 * needs longer has to say so with `SYNC_LOAD_RUN_DEADLINE_MS`.
 *
 * On the smoke defaults this is about 27 minutes for a run that takes a few
 * minutes; on a two-hour soak it is the soak plus the same margin.
 */
export function defaultRunDeadlineMs(config) {
  const settle = config.settleMs
  const setup = 120_000 + 15_000 + 120_000 // cell health, login, two owners + one spare
  const selection = 2 * 90_000 + 60_000 // one owner-route probe per hot workspace, landscape creation
  // Per target: document resolution, then rotated-head / seed convergence /
  // read-model presence / batch acknowledgement, each bounded by `settleMs`.
  const targets = 2 * (30_000 + 4 * settle)
  const connect = config.usersPerWorkspace * config.staggerMs
  const loadPhase = (startDelay) => startDelay + connect + config.rounds * 400 + settle + 30_000
  const baseline = loadPhase(1_000)
  // Segmented mode rotates the write heads once after baseline and once per
  // soak cycle; both rotations resolve two targets again.
  const rotation = config.segmentedWorkspaces ? targets : 0
  const failover = loadPhase(config.failureArmMs) + 30_000 + 30_000 // takeover, former owner back as standby
  const soak = config.soakDurationMs + loadPhase(1_000) + rotation
  const cleanup = 2 * (30_000 + 3 * settle) + 2 * 30_000
  return setup + selection + targets + baseline + rotation + failover + soak + cleanup
}

/** A bare host name or address — no scheme, port, path or credentials, which
 *  the URLs below add themselves. */
export function benchHost(raw) {
  const host = raw?.trim() || '127.0.0.1'
  if (!/^[A-Za-z0-9._-]+$/.test(host) && !/^\[[0-9A-Fa-f:.]+\]$/.test(host)) {
    throw new Error('SYNC_FAILOVER_HOST must be a bare host name or IP address (no scheme, port or path)')
  }
  return host
}

function routerHttp(config) {
  return `http://${config.host ?? '127.0.0.1'}:${config.routerPort}`
}

function routerWs(config, workspace) {
  return `ws://${config.host ?? '127.0.0.1'}:${config.routerPort}/automerge?${workspaceQuery(workspace)}`
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function acquireQualificationRunLock(project, options = {}) {
  const safeProject = String(project).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96)
  const lockPath = options.lockPath ?? join(tmpdir(), `maplespire-sync-gate-${safeProject}.lock`)
  const pid = options.pid ?? process.pid
  const isAlive = options.isProcessAlive ?? processIsAlive
  const token = `${pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor
    try {
      descriptor = openSync(lockPath, 'wx')
      writeFileSync(descriptor, token, 'utf8')
      closeSync(descriptor)
      let released = false
      return {
        lockPath,
        release() {
          if (released) return
          released = true
          try {
            if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath)
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor) } catch { /* descriptor may already be closed */ }
      }
      if (error?.code !== 'EEXIST') throw error
      let ownerPid = null
      try { ownerPid = Number(readFileSync(lockPath, 'utf8').split(':', 1)[0]) } catch { /* retry stale/incomplete lock */ }
      if (isAlive(ownerPid)) {
        throw new Error(`qualification gate already running for ${project} (pid ${ownerPid})`)
      }
      try { unlinkSync(lockPath) } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError
      }
    }
  }
  throw new Error(`could not acquire qualification gate lock for ${project}`)
}

export function terminateActiveLoadProcesses(signal = 'SIGTERM') {
  for (const child of activeLoadProcesses) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
}

export function createLoadOutputTracker(onResult = () => {}) {
  let buffered = ''
  let readyForFailure = false
  return {
    push(chunk) {
      buffered += String(chunk)
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('QARESULT ')) {
          let result
          try { result = JSON.parse(line.slice('QARESULT '.length)) } catch { continue }
          onResult(result)
          continue
        }
        if (!line.startsWith('QAPHASE ')) continue
        try {
          const event = JSON.parse(line.slice('QAPHASE '.length))
          if (event?.phase === 'ready-for-failure') readyForFailure = true
        } catch { /* malformed child diagnostics must not arm failure injection */ }
      }
    },
    readyForFailure() {
      return readyForFailure
    },
  }
}

export function loadProcessesReadyForFailure(processes, snapshots, telemetryGuard) {
  if (processes.length === 0 || !processes.every((process) => process.readyForFailure())) return false
  return telemetryGuard ? telemetryGuard(snapshots) : true
}

function compose(config, ...args) {
  return execFileSync(
    'docker',
    ['compose', '-p', config.project, '-f', composeFile, ...args],
    // Bounded, because this also runs from the abandonment path (before
    // `process.exit`): a hung docker CLI — or a slow `DOCKER_HOST=ssh://` on a
    // two-host run — must not be what keeps a hung gate alive. The
    // only commands this gate issues are pause / unpause / ps.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  )
}

async function composeAsync(config, ...args) {
  return promisify(execFile)('docker', ['compose', '-p', config.project, '-f', composeFile, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
  })
}

async function rehearsalInventory(config, workspace) {
  for (const id of [workspace.landscapeId, workspace.versionId]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('invalid rehearsal workspace id')
  }
  const scope = `landscape_id = '${workspace.landscapeId}' AND version_id = '${workspace.versionId}'`
  // psql receives SQL as one argv value, never as shell text. The named Compose
  // project's own database is queried read-only; no ambient DATABASE_URL.
  const sql = `BEGIN READ ONLY;
    SET LOCAL statement_timeout = '5000ms'; SET LOCAL lock_timeout = '1000ms';
    SET LOCAL idle_in_transaction_session_timeout = '5000ms';
    SET LOCAL application_name = 'maplespire-g47-inventory';
    SELECT json_build_object(
    'database', current_database(),
    'objects', (SELECT count(*)::int FROM ro_objects WHERE ${scope}),
    'staticWorkspaces', (SELECT count(*)::int FROM read_model_static_workspaces WHERE ${scope}),
    'projectorInstanceId', (SELECT projector_instance_id FROM read_model_projection_state WHERE ${scope})
  ); COMMIT;`
  const { stdout: output } = await composeAsync(config, 'exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'maplespire', '-d', 'maplespire', '-c', sql)
  return { observedAt: Date.now(), workspace, ...JSON.parse(output.trim()) }
}

async function seedRehearsalWorkspace(config, selection, targetUrl, cookie, totalObjects) {
  const beganAt = Date.now()
  const adapter = new AuthenticatedWebSocketClientAdapter(routerWs(config, selection.workspace), cookie, 500)
  const repo = new Repo({ network: [adapter] })
  let result, primaryError
  try {
    const root = (await resolveLoadHandle(repo, selection.rootUrl)).handle.doc()
    const metaHandle = (await resolveLoadHandle(repo, root.modelMetaUrl)).handle
    if (metaHandle.doc()?.registrySummaryOnly === true) throw new Error('rehearsal requires an ordinary workspace')
    const target = (await resolveLoadHandle(repo, targetUrl)).handle
    const initialIds = Object.keys(objectMap(target.doc()))
    if (initialIds.length !== config.objects || totalObjects < config.objects) throw new Error('unexpected initial seed object count')
    const background = Array.from({ length: totalObjects - config.objects }, (_, index) => `${config.runId}-background-${index}`)
    const publication = await publishRehearsalBases({ repo, metaHandle, head: target, workspace: selection.workspace, backgroundIds: background,
      createObject: id => makeObject(id, { name: `QA G4-7 ${id}` }),
      mint: count => json(`${routerHttp(config)}/api/automerge/mint-document-ids`, {
        cookie, method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...selection.workspace, count }), timeoutMs: 10_000,
      }),
      waitDurable: documents => waitFor('rehearsal seed durable frontier', async () => {
        const body = await json(`${routerHttp(config)}/api/automerge/durable-heads?${workspaceQuery(selection.workspace)}`, {
          cookie, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documents }), timeoutMs: 10_000,
        })
        return rehearsalDurableAcknowledged(documents, body) ? body : null
      }, 120_000),
      onDurable: receipt => console.log('G47_SEED ' + JSON.stringify({ workspace: selection.workspace, ...receipt })),
    })
    const witnessIds = [initialIds[0], background.at(-1) ?? initialIds.at(-1)]
    const expectedObjects = Object.fromEntries(witnessIds.map(id => [id, {
      name: objectMap(target.doc())[id]?.name ?? `QA G4-7 ${id}`,
    }]))
    const inventory = await waitFor('ordinary seed fully projected at scale', async () => {
      const response = await request(`${cells(config)[selection.ownerIndex].baseUrl}/api/model/durability-witness?${workspaceQuery(selection.workspace)}`, {
        cookie, method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objects: witnessIds }), timeoutMs: 3_000,
      })
      if (!isFreshWitness(response, selection.workspace, expectedObjects)) return null
      const inventory = await rehearsalInventory(config, selection.workspace)
      if (inventory.staticWorkspaces !== 0) throw new Error('rehearsal workspace acquired a static read model')
      return inventory.objects === totalObjects && inventory.projectorInstanceId ? inventory : null
    }, 120_000)
    if (publication.totalObjects !== totalObjects) throw new Error('seed local object count changed')
    result = { beganAt, completedAt: Date.now(), targetUrl, totalObjects, workspace: selection.workspace,
      shape: 'native ordinary workspace: base shards of at most 512 objects followed by the original writer head',
      publication, inventory, expectedObjects }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      const closure = await closeRehearsalSeeder(repo, adapter)
      if (result) result.seederClosure = closure
      console.log('G47_SEED_CLOSED ' + JSON.stringify({ workspace: selection.workspace, ...closure }))
    } catch (error) {
      if (primaryError) throw new AggregateError([primaryError, error], 'rehearsal seed and closure both failed')
      throw error
    }
  }
  return result
}

async function readRehearsalFreshness(config, cookie, seed, takeover, replacement, before) {
  const requests = []
  const endpoint = `${replacement.baseUrl}/api/model/durability-witness?${workspaceQuery(seed.workspace)}`
  const firstRequestAt = Date.now()
  let fresh
  try {
    fresh = await waitFor('first fresh ordinary response on replacement', async () => {
      const requestedAt = Date.now()
      const response = await request(endpoint, { cookie, method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objects: Object.keys(seed.expectedObjects) }), timeoutMs: 3_000 })
      const receivedAt = Date.now()
      const freshAfterTakeoverMs = performance.now() - takeover.completedMonotonicMs
      const entry = { requestedAt, receivedAt, freshAfterTakeoverMs, ...response }
      requests.push(entry)
      return isFreshWitness(response, seed.workspace, seed.expectedObjects) ? entry : null
    }, 120_000)
  } catch (error) {
    // Preserve the refusing responses before cleanup retires the workspace.
    // request() returns only status/body/route: no session cookie or auth header.
    console.log(`G47_FRESHNESS_FAILURE ${JSON.stringify({ workspace: seed.workspace,
      expectedObjects: seed.expectedObjects, firstRequestAt, completedAt: takeover.completedAt,
      failedAt: Date.now(), reason: error.message, requests })}`)
    throw error
  }
  const after = await cellSnapshot(replacement, cookie, false)
  const inventory = await rehearsalInventory(config, seed.workspace)
  const valid = freshnessIdentityValid(before, after, replacement, config.topologyBuild?.expectedTopology)
    && before.fleet?.residentProjectors === 0 && before.fleet?.inFlightWorkspaces === 0
    && after.ownership?.ready === true && after.ownership?.partitionIndex === 0
    && after.fleet?.residentProjectors > 0 && after.fleet?.foreignResidentProjectors === 0
    && inventory.objects === seed.totalObjects && inventory.staticWorkspaces === 0
    && inventory.projectorInstanceId && inventory.projectorInstanceId !== seed.inventory.projectorInstanceId
  return { valid: Boolean(valid), seed, origin: 'replacement ready response completedAt', completedAt: takeover.completedAt,
    firstRequestAt, firstFreshResponseAt: fresh.receivedAt, freshAfterTakeoverMs: fresh.freshAfterTakeoverMs,
    requests, before, after, inventory,
    provisionalBudgetMs: 3_000, provisionalBudgetExceeded: fresh.freshAfterTakeoverMs > 3_000,
    remedyIfExceeded: 'operator summary promotion per landscape (D57)',
    scope: 'cold projector; WebSocket reconnects may already have loaded the head; no standby prewarming' }
}

async function calibrationDatabaseInventory(config) {
  const sql = `BEGIN READ ONLY;
    SET LOCAL statement_timeout = '5000ms'; SET LOCAL lock_timeout = '1000ms';
    SET LOCAL idle_in_transaction_session_timeout = '5000ms';
    SELECT json_build_object('database', current_database(),
      'objects', (SELECT count(*)::int FROM ro_objects),
      'staticWorkspaces', (SELECT count(*)::int FROM read_model_static_workspaces),
      'activeWorkspaces', (SELECT count(*)::int FROM versions WHERE status = 'active'));
    COMMIT;`
  const { stdout } = await composeAsync(config, 'exec', '-T', 'postgres', 'psql', '-X', '-qAt',
    '-v', 'ON_ERROR_STOP=1', '-U', 'maplespire', '-d', 'maplespire', '-c', sql)
  return { observedAt: Date.now(), ...JSON.parse(stdout.trim()) }
}

/** The runner gives this control its own fresh Compose project before starting
 * the fleet project. A separate workspace in the large project's database is
 * insufficient: the cold pass ANALYZEs shared tables. The SQL census runs
 * before the timer and can warm database pages. */
export async function runFreshnessCalibration(baseConfig) {
  const config = { ...baseConfig, runId: `cal-${randomUUID()}` }
  config.topologyBuild = resolveLoadTopology(config)
  const lock = acquireQualificationRunLock(config.project)
  activeRunLock = lock
  const allCells = cells(config)
  try {
    setPhase('G4-7 dedicated five-object calibration')
    await waitFor('calibration HTTP processes', async () => {
      const health = await Promise.all(allCells.map(cell => request(`${cell.baseUrl}/api/health`).catch(() => null)))
      return health.every(row => row?.status === 200)
    }, 120_000)
    const session = await login(config, allCells[0])
    const states = await waitFor('calibration owners and reserve', async () => {
      const rows = await Promise.all(allCells.map(cell => json(`${cell.baseUrl}/api/platform/sync-cell`, { cookie: session.cookie })))
      const owners = rows.filter(row => row.ready && row.partitionReady)
      return owners.length === 2 && new Set(owners.map(row => row.partitionIndex)).size === 2
        && rows.some(row => !row.ready && row.partitionIndex === null) ? rows : null
    }, 120_000)
    const emptyDatabase = await calibrationDatabaseInventory(config)
    if (emptyDatabase.objects !== 0 || emptyDatabase.staticWorkspaces !== 0) throw new Error('calibration requires an empty read model')
    const smallConfig = { ...config, objects: 5 }
    const selections = await selectPartitionWorkspaces(smallConfig, allCells, states, session.cookie)
    const selection = selections.get(0)
    const target = await resolveLoadTarget(smallConfig, selection, session.cookie)
    const seed = await seedRehearsalWorkspace(smallConfig, selection, target, session.cookie, 5)
    const seededDatabase = await calibrationDatabaseInventory(config)
    if (seededDatabase.objects !== 5 || seededDatabase.staticWorkspaces !== 0) throw new Error('calibration database must contain exactly five ordinary objects')
    const before = await waitFor('calibration seed connections closed', async () => {
      const rows = await Promise.all(allCells.map(cell => cellSnapshot(cell, session.cookie, false)))
      return rows.every(row => row.stats?.transport?.connections?.active === 0) ? rows : null
    }, 15_000)
    const owner = before.findIndex(row => row.ownership?.ready && row.ownership?.partitionReady && row.ownership.partitionIndex === 0)
    const spare = before.findIndex(row => row.ownership?.ready === false && row.ownership.partitionIndex === null)
    if (owner < 0 || spare < 0 || before[spare].fleet?.residentProjectors !== 0 || before[spare].fleet?.inFlightWorkspaces !== 0) {
      throw new Error('calibration requires an owner and a cold reserve')
    }
    const measured = await measureTakeover({
      originalService: allCells[owner].service,
      pause: () => composeAsync(config, 'pause', allCells[owner].service),
      replacement: () => waitFor('calibration reserve ready', async () => {
        const state = await json(`${allCells[spare].baseUrl}/api/platform/sync-cell`, { cookie: session.cookie })
        return state.ready && state.partitionReady && state.partitionIndex === 0 ? { ...allCells[spare], state } : null
      }, 30_000),
      unpause: async () => {
        try { await composeAsync(config, 'unpause', allCells[owner].service) } catch (error) {
          if (!isAlreadyUnpausedError(error)) throw error
        }
      },
      fresh: (takeover, replacement) => readRehearsalFreshness(config, session.cookie, seed, takeover, replacement, before[spare]),
    })
    return { ...measured, emptyDatabase, seededDatabase, before,
      topologyBuild: config.topologyBuild, benchPosture: config.benchPosture, project: config.project }
  } finally {
    unpauseAnyPausedCell(config)
    lock.release()
    if (activeRunLock === lock) activeRunLock = null
  }
}

async function request(url, { cookie, timeoutMs = 3_000, ...options } = {}) {
  const headers = { ...(options.headers || {}) }
  if (cookie) headers.Cookie = cookie
  const response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
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
    throw new Error(`${url} returned HTTP ${result.status}`)
  }
  return result.body
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

function cells(config) {
  return config.cellPorts.map((port, index) => ({
    service: `sync-cell-${String.fromCharCode(97 + index)}`,
    baseUrl: `http://${config.host ?? '127.0.0.1'}:${port}`,
  }))
}

async function login(config, cell) {
  const response = await fetch(`${cell.baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.loginEmail }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}`)
  const body = await response.json()
  const cookie = (response.headers.get('set-cookie') || '').match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return the HttpOnly session cookie')
  if (!body.user?.isPlatformAdmin || !body.orgId) throw new Error('load-gate login lacks bootstrap platform admin/org')
  return { cookie }
}

function workspaceOf(landscape) {
  return landscape?.id && landscape?.defaultVersionId
    ? { landscapeId: landscape.id, versionId: landscape.defaultVersionId }
    : null
}

function workspaceQuery(workspace) {
  return new URLSearchParams(workspace).toString()
}

export function isAlreadyUnpausedError(error) {
  const detail = String(error?.stderr ?? error?.message ?? error)
  return /is not paused/i.test(detail)
}

function unpauseCell(config, service) {
  try {
    compose(config, 'unpause', service)
  } catch (error) {
    // Docker can report the container as paused to one compose query after an
    // earlier cleanup has already resumed it. Unpause is semantically
    // idempotent; preserve every other failure as qualification evidence.
    if (!isAlreadyUnpausedError(error)) throw error
  }
}

export function qualificationObjectPrefix(runId, targetUrl) {
  const documentId = targetUrl.replace(/^automerge:/, '').split('?')[0]
  return `${runId}-${documentId.slice(0, 10)}`
}

export function isQualificationObjectId(objectId) {
  return /^qa-[a-z0-9]+-\d+-[A-Za-z0-9_-]{1,10}-\d+$/.test(objectId)
}

export function appendQualificationObjectTombstones(meta, discoveredIds) {
  // Create, then re-read: the VALUE of `(meta.deletedObjectIds = [])` is the
  // detached literal, so on an Automerge draft its pushes were lost.
  if (!Array.isArray(meta.deletedObjectIds)) meta.deletedObjectIds = []
  const tombstones = meta.deletedObjectIds
  const known = new Set(tombstones)
  const appended = []
  for (const id of discoveredIds) {
    if (!isQualificationObjectId(id) || known.has(id)) continue
    tombstones.push(id)
    known.add(id)
    appended.push(id)
  }
  return appended
}

/**
 * The batch-ACKNOWLEDGEMENT witness — valid on EVERY write head.
 *
 * `POST /api/model/overlay-batches/status` reads `read_model_overlay_batch_acks`
 * and nothing else. Both the static delta projector and the ordinary
 * per-workspace projector acknowledge in the same transaction as the rows they
 * vouch for, so this is the STRONGER witness — it names the batch, not just
 * the objects. It runs after `waitForSeedReadModel`, which is what makes an
 * ordinary workspace's projector resident in the first place.
 */
async function waitForSeedProjection(config, selection, cookie, batchId) {
  const endpoint = `${routerHttp(config)}/api/model/overlay-batches/status?${workspaceQuery(selection.workspace)}`
  return waitFor('load object seed acknowledgement', async () => {
    const result = await request(endpoint, {
      cookie,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchIds: [batchId] }),
      timeoutMs: 3_000,
    })
    if (result.status !== 200) return null
    const status = result.body?.batches?.find((batch) => batch.batchId === batchId)?.status
    if (status === 'conflict') throw new Error(`load object seed ${batchId} projected with a conflict`)
    return status === 'projected' || status === 'forwarded' ? status : null
  }, config.settleMs)
}

/**
 * The READ-MODEL witness — valid on every workspace: the seeded objects are
 * visible through `/api/model/lookup`, which means the OWNER's projector has
 * projected the write head. For an ordinary workspace this is the only
 * projection there is, and asking for it is also what makes it happen: a fresh
 * ordinary workspace has NO resident projector until a read-model route asks for
 * one (`index.ts`, the `readModelFleet.ensure` behind the 503 "read model
 * warming up"), and the status endpoint above asks for nothing.
 *
 * Without a read-model request the cold build never starts. `waitFor` treats
 * the warming-up 503 as "not yet" and the route's own retry hint is 2 s, so
 * the poll cadence here is the gate's, not the route's.
 */
async function waitForSeedReadModel(config, selection, cookie, ids) {
  const query = workspaceQuery(selection.workspace)
  const endpoint = `${routerHttp(config)}/api/model/lookup?${query}&ids=${encodeURIComponent(ids.join(','))}`
  return waitFor('load object seed read-model presence', async () => {
    const result = await request(endpoint, { cookie, timeoutMs: 3_000 })
    if (result.status !== 200 || !Array.isArray(result.body?.entities)) return null
    // `entities` is the lookup map serialized as `[id, entity]` pairs.
    const present = new Set(result.body.entities.map((entry) => (Array.isArray(entry) ? entry[0] : null)))
    return ids.every((id) => present.has(id)) ? ids.length : null
  }, config.settleMs)
}

async function probeRoot(allCells, workspace, cookie) {
  const query = workspaceQuery(workspace)
  const results = await Promise.all(allCells.map((cell) => request(
    `${cell.baseUrl}/api/automerge/root?${query}`,
    { cookie },
  )))
  if (!results.every((result) => result.status === 200)) return null
  const owners = results.map((result, index) => ({ result, index })).filter(({ result }) => result.route === 'owner')
  const proxied = results.filter((result) => result.route === 'proxied')
  const roots = new Set(results.map((result) => result.body?.url).filter(Boolean))
  if (owners.length !== 1 || proxied.length !== allCells.length - 1 || roots.size !== 1) return null
  return { ownerIndex: owners[0].index, rootUrl: results[0].body.url }
}

async function workspaceHasSegmentedOverlay(config, selection, cookie) {
  const wsUrl = routerWs(config, selection.workspace)
  const repo = new Repo({ network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)] })
  try {
    const rootHandle = (await resolveLoadHandle(repo, selection.rootUrl)).handle
    await rootHandle.whenReady()
    const root = rootHandle.doc()
    if (!root?.modelMetaUrl) return false
    const metaHandle = (await resolveLoadHandle(repo, root.modelMetaUrl)).handle
    await metaHandle.whenReady()
    const meta = metaHandle.doc()
    return Boolean(meta?.editsObjectShardUrl || meta?.editsObjectShardUrls?.at(-1))
  } finally {
    await shutdownRepo(repo)
  }
}

async function selectPartitionWorkspaces(config, allCells, states, cookie, createdLandscapeIds = []) {
  const response = await json(`${allCells[0].baseUrl}/api/landscapes`, { cookie })
  const available = (response.landscapes || []).map(workspaceOf).filter(Boolean)
  // Performance baselines are normally seeded after ordinary workspaces. Scan
  // newest-first in segmented mode so a gate does not cold-open every legacy
  // monolithic root before reaching the intended bounded overlays.
  const explicit = config.workspaceSelectors?.length > 0
    ? config.workspaceSelectors.map((wanted) => available.find((candidate) => (
        candidate.landscapeId === wanted.landscapeId && candidate.versionId === wanted.versionId
      )))
    : null
  if (explicit?.some((workspace) => !workspace)) {
    throw new Error('an explicit SYNC_LOAD_WORKSPACES entry is not an accessible active workspace')
  }
  const candidates = config.freshWorkspaces
    ? []
    : explicit ?? (config.segmentedWorkspaces ? available.reverse() : available)
  const selected = new Map()
  for (let attempt = 0; attempt < 30 && selected.size < 2; attempt += 1) {
    if (attempt >= candidates.length) {
      if (config.segmentedWorkspaces) break
      const created = await json(`${allCells[0].baseUrl}/api/landscapes`, {
        cookie,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Load gate ${attempt + 1}` }),
      })
      const workspace = workspaceOf(created.landscape)
      if (!workspace) throw new Error('created landscape has no active workspace')
      createdLandscapeIds.push(workspace.landscapeId)
      candidates.push(workspace)
    }
    const workspace = candidates[attempt]
    const root = await waitFor('workspace owner route', () => probeRoot(allCells, workspace, cookie), 90_000)
    if (config.segmentedWorkspaces
      && !(await workspaceHasSegmentedOverlay(config, { workspace, ...root }, cookie))) continue
    const partition = states[root.ownerIndex].partitionIndex
    if (partition === 0 || partition === 1) selected.set(partition, { workspace, ...root })
  }
  if (selected.size !== 2) throw new Error('could not select one workspace in each partition')
  return selected
}

async function resolveLoadTarget(config, selection, cookie, previousTargetUrl = null) {
  const wsUrl = routerWs(config, selection.workspace)
  const repo = new Repo({ network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)] })
  try {
    const rootHandle = (await resolveLoadHandle(repo, selection.rootUrl)).handle
    await rootHandle.whenReady()
    const root = rootHandle.doc()
    if (!root) throw new Error('workspace root is unavailable')
    let targetUrl = root.modelUrl
    if (root.modelMetaUrl) {
      const metaHandle = (await resolveLoadHandle(repo, root.modelMetaUrl)).handle
      await metaHandle.whenReady()
      targetUrl = await waitFor('rotated overlay write head', () => {
        const meta = metaHandle.doc()
        const candidate = meta?.editsObjectShardUrl
          || meta?.editsObjectShardUrls?.at(-1)
          || meta?.objectShardUrls?.at(-1)
        return candidate && candidate !== previousTargetUrl ? candidate : null
      }, config.settleMs)
    }
    if (!targetUrl) throw new Error('workspace has no object write target')
    if (previousTargetUrl && targetUrl === previousTargetUrl) {
      throw new Error('load phase would reuse a retired overlay write head')
    }
    const target = (await resolveLoadHandle(repo, targetUrl)).handle
    await target.whenReady()
    const objects = objectMap(target.doc())
    if (!objects) throw new Error('workspace object write target has no object map')
    const objectPrefix = qualificationObjectPrefix(config.runId, targetUrl)
    const ids = loadObjectIds(config.objects, objectPrefix)
    const missing = ids.filter((id) => !objects[id])
    if (missing.length > 0) {
      const seedBatchId = `${objectPrefix}-seed`
      let batchAppended = false
      target.change((document) => {
        const writableObjects = objectMap(document)
        if (!writableObjects) throw new Error('workspace object write target lost its object map')
        for (const id of missing) writableObjects[id] = makeObject(id, { name: `QA load ${id}` })
        batchAppended = appendOverlayBatchId(document, seedBatchId)
      })
      // The helper creates the `writeBatchIds` list the way the client does
      // (a head from `createEmptyRoot` has none until the first write);
      // `false` means the document is not an overlay head at all, and a seed
      // whose batch id has no home is not a seed this gate can witness.
      if (!batchAppended) {
        throw new Error(`load target ${targetUrl} is not an overlay write head; the seed batch id has nowhere to go`)
      }
      const verifier = new Repo({
        network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)],
      })
      try {
        const verifierHandle = (await resolveLoadHandle(verifier, targetUrl)).handle
        await verifierHandle.whenReady()
        await waitFor('load object seed convergence', () => {
          const verifiedObjects = objectMap(verifierHandle.doc())
          return verifiedObjects && ids.every((id) => verifiedObjects[id])
        }, config.settleMs)
        // Two witnesses, read from two places, in this order: the objects
        // through the read model — the route that makes the owner's projector
        // resident on an ordinary workspace — THEN the batch acknowledgement,
        // which names the batch, not just the objects. (Segmented mode still fails
        // loudly on an ordinary workspace one phase later, when the head it
        // expects to rotate never does.)
        await waitForSeedReadModel(config, selection, cookie, ids)
        await waitForSeedProjection(config, selection, cookie, seedBatchId)
      } finally {
        await shutdownRepo(verifier)
      }
    }
    return targetUrl
  } finally {
    await shutdownRepo(repo)
  }
}

function startLoadProcess(config, selection, targetUrl, cookie, phase, startDelay, partition, cohort, barrierId = null, onResult = () => {}) {
  const args = [
    loadUsersScript,
    '--root', targetUrl,
    '--users', String(cohort.users),
    '--userOffset', String(cohort.offset),
    '--totalUsers', String(config.usersPerWorkspace),
    '--rounds', String(config.rounds),
    '--objects', String(config.objects),
    '--settle', String(config.settleMs),
    '--stagger', String(config.staggerMs),
    '--startDelay', String(startDelay),
    // The profile: how many of `totalUsers` write, and whether they
    // all write every shared object or each its own. Readers still converge.
    '--writers', String(config.writersPerWorkspace),
    '--objectAssignment', config.objectAssignment,
  ]
  const child = spawn(process.execPath, args, {
    cwd: resolve(here, '..'),
    env: {
      ...process.env,
      QA_API: routerHttp(config),
      QA_WS: `ws://${config.host}:${config.routerPort}/automerge`,
      QA_LANDSCAPE_ID: selection.workspace.landscapeId,
      QA_VERSION_ID: selection.workspace.versionId,
      QA_SESSION_COOKIE: cookie,
      QA_LOAD_OBJECT_PREFIX: qualificationObjectPrefix(config.runId, targetUrl),
      QA_LOAD_BASELINE_BARRIER_ID: barrierId || '',
      QA_LOAD_EPISODE_ID: barrierId || '',
    },
    shell: false,
    windowsHide: true,
    stdio: barrierId ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  })
  const barrier = { ready: null, error: null, released: false }
  const onBarrierMessage = (message) => {
    if (message?.type !== 'load-baseline-ready') return
    if (message.barrierId !== barrierId || message.users !== cohort.users
      || message.userOffset !== cohort.offset || message.totalUsers !== config.usersPerWorkspace
      || barrier.ready) {
      barrier.error = new Error('load baseline readiness has an invalid episode or cohort')
      return
    }
    barrier.ready = message
  }
  const onBarrierDisconnect = () => {
    if (!barrier.released) barrier.error = new Error('load baseline child disconnected before admission')
  }
  const removeBarrierListeners = () => {
    child.removeListener('message', onBarrierMessage)
    child.removeListener('disconnect', onBarrierDisconnect)
  }
  if (barrierId) {
    child.on('message', onBarrierMessage)
    child.once('disconnect', onBarrierDisconnect)
    child.once('close', removeBarrierListeners)
  }
  let stdout = ''
  let stderr = ''
  let outputError = null
  const outputTracker = createLoadOutputTracker(result => onResult({
    ...result, partition, cohort: cohort.index, receivedAt: Date.now(),
  }))
  const append = (current, chunk) => `${current}${chunk}`.slice(-2 * 1024 * 1024)
  child.stdout.on('data', (chunk) => {
    const value = chunk.toString()
    stdout = append(stdout, value)
    try { outputTracker.push(value) } catch (error) {
      // EventEmitter exceptions do not reject the child promise themselves.
      // Route observer failures through close and the joined parent cleanup.
      outputError = error
      child.kill()
    }
  })
  activeLoadProcesses.add(child)
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk.toString()) })
  const promise = new Promise((resolveResult, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      activeLoadProcesses.delete(child)
      let result
      try { result = parseClosedLoadOutput(stdout) } catch (error) {
        reject(new Error(`${phase} load emitted incomplete or invalid result/closure: ${error.message}; ${stderr.slice(-10_000)}`))
        return
      }
      const loadResult = {
        ...result, partition, cohort: cohort.index,
        childProcess: { pid: child.pid, exitCode: code, signal: signal ?? null },
      }
      try {
        assertLoadUserEvidence(loadResult, { pid: child.pid, episodeId: barrierId || null,
          ids: loadObjectIds(config.objects, qualificationObjectPrefix(config.runId, targetUrl)) })
      } catch (error) { outputError ??= error }
      if (outputError) {
        outputError.loadResult = loadResult
        reject(outputError)
        return
      }
      if (code !== 0 || signal != null) {
        const error = new Error(`${phase} load failed: result=${JSON.stringify(result)}; stderr=${stderr.slice(-10_000)}`)
        error.loadResult = loadResult
        reject(error)
        return
      }
      resolveResult(loadResult)
    })
  })
  return {
    child, promise, partition, cohort: cohort.index, barrier,
    readyForFailure: () => outputTracker.readyForFailure(),
    releaseBaseline: (releaseNonce) => new Promise((resolveRelease, reject) => {
      if (!barrier.ready || barrier.error || !child.connected) {
        reject(barrier.error || new Error('load baseline child is not ready on IPC'))
        return
      }
      barrier.released = true
      try {
        child.send({ type: 'load-baseline-release', barrierId, releaseNonce }, (error) => {
          removeBarrierListeners()
          if (error) reject(error)
          else resolveRelease()
        })
      } catch (error) { removeBarrierListeners(); reject(error) }
    }),
  }
}

export async function cellSnapshot(cell, cookie, consumeEventLoop = true, read = request, timeoutMs = 1_500) {
  const sampleStartedMonotonicMs = performance.now()
  const [stats, fleet, ownership, ready] = await Promise.allSettled([
    // Consume a disjoint event-loop window. The default stats endpoint remains
    // non-destructive for operators, but a qualification run must not inherit
    // the deliberately injected pause from an earlier failover cycle.
    read(`${cell.baseUrl}/api/automerge/stats${consumeEventLoop ? '?eventLoopWindow=consume' : ''}`, { cookie, timeoutMs }),
    read(`${cell.baseUrl}/api/platform/read-model/projector-fleet`, { cookie, timeoutMs }),
    read(`${cell.baseUrl}/api/platform/sync-cell`, { cookie, timeoutMs }),
    read(`${cell.baseUrl}/api/ready`, { timeoutMs }),
  ])
  const value = (result) => result.status === 'fulfilled' && result.value.status === 200 ? result.value.body : null
  const status = (result) => result.status === 'fulfilled'
    ? result.value.status
    : result.reason?.name || 'rejected'
  return {
    service: cell.service,
    sampleStartedMonotonicMs,
    stats: value(stats),
    // This aggregate belongs to the process contacted. A successful routed
    // response must not impersonate the reserve's local fleet.
    fleet: fleet.status === 'fulfilled' && fleet.value.route === null ? value(fleet) : null,
    ownership: value(ownership),
    readyStatus: ready.status === 'fulfilled' ? ready.value.status : null,
    diagnosticRoutes: { fleet: fleet.status === 'fulfilled' ? fleet.value.route : null },
    diagnosticStatus: {
      stats: status(stats),
      fleet: status(fleet),
      ownership: status(ownership),
      ready: status(ready),
    },
  }
}

/** Ownership itself has no boot identity. The two stats reads bracket its
 * response in one process; a restart at either edge is unqualified evidence. */
export async function collectBaselineOwnership(allCells, cookie, read = request) {
  return Promise.all(allCells.map(async (cell) => {
    const entry = { service: cell.service, processBootIdBefore: null, processBootIdAfter: null, ownership: null }
    try {
      const before = await read(`${cell.baseUrl}/api/automerge/stats`, { cookie, timeoutMs: 1_500 })
      const ownership = await read(`${cell.baseUrl}/api/platform/sync-cell`, { cookie, timeoutMs: 1_500 })
      const after = await read(`${cell.baseUrl}/api/automerge/stats`, { cookie, timeoutMs: 1_500 })
      entry.processBootIdBefore = before.status === 200 ? before.body?.processBootId ?? null : null
      entry.processBootIdAfter = after.status === 200 ? after.body?.processBootId ?? null : null
      entry.ownership = ownership.status === 200 ? ownership.body : null
      entry.httpStatuses = { before: before.status, ownership: ownership.status, after: after.status }
    } catch (error) {
      entry.readError = error instanceof Error ? error.message : String(error)
    }
    return entry
  }))
}

async function waitForQualificationReadModelRemoval(config, selection, cookie, removableIds) {
  const chunks = []
  for (let offset = 0; offset < removableIds.length; offset += 50) {
    chunks.push(removableIds.slice(offset, offset + 50))
  }
  const query = workspaceQuery(selection.workspace)
  await waitFor('qualification read-model cleanup', async () => {
    for (const ids of chunks) {
      const lookup = await request(
        `${routerHttp(config)}/api/model/lookup?${query}&ids=${encodeURIComponent(ids.join(','))}`,
        { cookie, timeoutMs: 3_000 },
      )
      if (lookup.status !== 200 || !Array.isArray(lookup.body?.entities)) return null
      if (lookup.body.entities.length > 0) return null
    }
    return true
  }, config.settleMs)
}

async function qualificationReadModelObjectIds(config, selection, cookie) {
  const ids = new Set()
  let after = null
  for (let page = 0; page < 1_000; page += 1) {
    const params = new URLSearchParams({
      ...selection.workspace,
      q: 'QA load',
      limit: '50',
    })
    if (after) params.set('after', after)
    const result = await request(
      `${routerHttp(config)}/api/model/objects/search?${params}`,
      { cookie, timeoutMs: 3_000 },
    )
    if (result.status !== 200 || !Array.isArray(result.body?.items)) {
      throw new Error(`qualification read-model enumeration returned HTTP ${result.status}`)
    }
    for (const item of result.body.items) {
      if (isQualificationObjectId(item?.id)) ids.add(item.id)
    }
    after = typeof result.body.nextCursor === 'string' && result.body.nextCursor
      ? result.body.nextCursor
      : null
    if (!after) return [...ids]
  }
  throw new Error('qualification read-model enumeration exceeded 1000 pages')
}

export async function cleanupSegmentedQualificationObjects(config, selections, targets, cookie) {
  if (!config.segmentedWorkspaces || !selections || targets.size === 0) return
  for (const partition of [0, 1]) {
    const selection = selections.get(partition)
    const targetUrl = targets.get(partition)
    if (!selection || !targetUrl) continue
    const wsUrl = routerWs(config, selection.workspace)
    const repo = new Repo({ network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)] })
    let cleanupBatchId = null
    let removableIds = []
    try {
      const rootHandle = (await resolveLoadHandle(repo, selection.rootUrl)).handle
      await rootHandle.whenReady()
      const modelMetaUrl = rootHandle.doc()?.modelMetaUrl
      if (!modelMetaUrl) throw new Error('qualification cleanup workspace lost its model metadata document')
      const metaHandle = (await resolveLoadHandle(repo, modelMetaUrl)).handle
      await metaHandle.whenReady()
      const readModelIds = await qualificationReadModelObjectIds(config, selection, cookie)
      const currentTargetUrl = metaHandle.doc()?.editsObjectShardUrl
        || metaHandle.doc()?.editsObjectShardUrls?.at(-1)
        || targetUrl
      const targetHandle = (await resolveLoadHandle(repo, currentTargetUrl)).handle
      await targetHandle.whenReady()
      const targetObjects = objectMap(targetHandle.doc())
      if (!targetObjects) throw new Error('qualification cleanup target lost its object map')
      removableIds = [...new Set([
        ...readModelIds,
        ...Object.keys(targetObjects).filter(isQualificationObjectId),
      ])]
      if (removableIds.length === 0) continue
      const documentId = currentTargetUrl.replace(/^automerge:/, '').split('?')[0]
      cleanupBatchId = `${config.runId}-${documentId.slice(0, 10)}-cleanup`
      let cleanupBatchAppended = false
      targetHandle.change((document) => {
        for (const field of ['writeBatchIds', 'forwardedBatchIds']) {
          if (!Array.isArray(document[field])) continue
          const retained = document[field].filter((batchId) => !String(batchId).startsWith('qa-'))
          document[field].splice(0, document[field].length, ...retained)
        }
        cleanupBatchAppended = appendOverlayBatchId(document, cleanupBatchId)
      })
      // Same rule as the seed: a batch id this path cannot place is a
      // cleanup the acknowledgement below could never witness.
      if (!cleanupBatchAppended) {
        throw new Error(`cleanup target ${currentTargetUrl} is not an overlay write head; the cleanup batch id has nowhere to go`)
      }
      metaHandle.change((meta) => {
        appendQualificationObjectTombstones(meta, removableIds)
      })
      await repo.flush([targetHandle.documentId, metaHandle.documentId])
      const verifier = new Repo({
        network: [new AuthenticatedWebSocketClientAdapter(wsUrl, cookie, 500)],
      })
      try {
        const verifierTarget = (await resolveLoadHandle(verifier, currentTargetUrl)).handle
        await verifierTarget.whenReady()
        const verifierMeta = (await resolveLoadHandle(verifier, modelMetaUrl)).handle
        await verifierMeta.whenReady()
        await waitFor('qualification removal server convergence', () => {
          const verifiedTombstones = new Set(verifierMeta.doc()?.deletedObjectIds ?? [])
          return removableIds.every((id) => verifiedTombstones.has(id))
            && Array.isArray(verifierTarget.doc()?.writeBatchIds)
            && verifierTarget.doc().writeBatchIds.includes(cleanupBatchId)
            ? true
            : null
        }, config.settleMs)
      } finally {
        await shutdownRepo(verifier)
      }
    } finally {
      await shutdownRepo(repo)
    }
    if (!cleanupBatchId) continue
    await waitForSeedProjection(config, selection, cookie, cleanupBatchId)
    await waitForQualificationReadModelRemoval(config, selection, cookie, removableIds)
  }
}

export async function refreshRotatedLoadTargets(selections, previousTargets, resolveTarget) {
  const refreshed = new Map()
  for (const partition of [0, 1]) {
    const previous = previousTargets.get(partition)
    const target = await resolveTarget(selections.get(partition), previous, partition)
    if (!target || target === previous) {
      throw new Error(`partition ${partition} did not publish a fresh overlay write head`)
    }
    refreshed.set(partition, target)
  }
  return refreshed
}

function storageFenceMetric(storageFence, canonicalKey, legacyKey = null) {
  if (storageFence?.[canonicalKey] != null) return Number(storageFence[canonicalKey])
  return legacyKey ? Number(storageFence?.[legacyKey] ?? 0) : 0
}

export class MetricsAccumulator {
  constructor(baseline) {
    this.baseline = baseline
    this.maxEventLoopP99Ms = 0
    this.maxEventLoopP99MsByService = Object.fromEntries(
      baseline.map((snapshot) => [snapshot.service, 0]),
    )
    this.eventLoopOutliers = []
    this.maxRssBytes = 0
    this.peakActiveConnections = 0
    this.maxSynchronizerPeerBindings = 0
    this.maxPeersPerDocument = 0
    this.maxReceiveSyncP99Ms = 0
    this.maxGenerateSyncP99Ms = 0
    this.maxReceiveSyncMs = 0
    this.maxGenerateSyncMs = 0
    this.maxInboundFrameBytes = 0
    this.maxForeignResidentProjectors = 0
    this.maxStaleFenceCoalescingCacheSize = Math.max(0, ...baseline.map((snapshot) => (
      storageFenceMetric(
        snapshot.ownership?.storageFence,
        'coalescedStaleFenceRetryCacheSize',
        'coalescedOwnershipUnavailableCacheSize',
      )
    )))
    this.maxRetiredDocuments = Math.max(0, ...baseline.map((snapshot) => (
      Number(snapshot.stats?.synchronizer?.retiredDocuments?.count ?? 0)
    )))
    this.retiredDocumentLimitExceeded = baseline.some((snapshot) => (
      snapshot.stats?.synchronizer?.retiredDocuments?.overLimit === true
    ))
    this.unexpectedSampleFailures = 0
    this.sampleFailuresByService = new Map()
    this.excludedEventLoopServices = new Set()
    this.samples = 0
    this.partialSamples = 0
  }

  excludeEventLoopService(service) {
    this.excludedEventLoopServices.add(service)
  }

  includeEventLoopService(service) {
    this.excludedEventLoopServices.delete(service)
  }

  record(snapshots, allowedUnavailableService = null, partial = false) {
    if (partial) this.partialSamples += 1
    else this.samples += 1
    let active = 0
    for (const snapshot of snapshots) {
      if (!snapshot.stats || !snapshot.fleet || !snapshot.ownership) {
        if (snapshot.service !== allowedUnavailableService) {
          this.unexpectedSampleFailures += 1
          const previous = this.sampleFailuresByService.get(snapshot.service) || { count: 0, last: null }
          this.sampleFailuresByService.set(snapshot.service, {
            count: previous.count + 1,
            last: snapshot.diagnosticStatus ?? null,
          })
        }
        continue
      }
      active += Number(snapshot.stats.transport?.connections?.active ?? 0)
      this.maxSynchronizerPeerBindings = Math.max(
        this.maxSynchronizerPeerBindings,
        Number(snapshot.stats.synchronizer?.totalPeerBindings ?? 0),
      )
      this.maxPeersPerDocument = Math.max(
        this.maxPeersPerDocument,
        Number(snapshot.stats.synchronizer?.maxPeersPerDocument ?? 0),
      )
      this.maxReceiveSyncP99Ms = Math.max(
        this.maxReceiveSyncP99Ms,
        Number(snapshot.stats.transport?.syncCpu?.receiveP99Ms ?? 0),
      )
      this.maxGenerateSyncP99Ms = Math.max(
        this.maxGenerateSyncP99Ms,
        Number(snapshot.stats.transport?.syncCpu?.generateP99Ms ?? 0),
      )
      this.maxReceiveSyncMs = Math.max(
        this.maxReceiveSyncMs,
        Number(snapshot.stats.transport?.syncCpu?.maxReceiveMs ?? 0),
      )
      this.maxGenerateSyncMs = Math.max(
        this.maxGenerateSyncMs,
        Number(snapshot.stats.transport?.syncCpu?.maxGenerateMs ?? 0),
      )
      this.maxInboundFrameBytes = Math.max(
        this.maxInboundFrameBytes,
        Number(snapshot.stats.transport?.traffic?.maxInboundFrameBytes ?? 0),
      )
      if (!this.excludedEventLoopServices.has(snapshot.service)) {
        const eventLoopP99Ms = Number(snapshot.stats.transport?.eventLoopDelayMs?.p99 ?? 0)
        this.maxEventLoopP99Ms = Math.max(
          this.maxEventLoopP99Ms,
          eventLoopP99Ms,
        )
        this.maxEventLoopP99MsByService[snapshot.service] = Math.max(
          this.maxEventLoopP99MsByService[snapshot.service] ?? 0,
          eventLoopP99Ms,
        )
        if (eventLoopP99Ms > 50) {
          this.eventLoopOutliers.push({
            observedAt: Date.now(),
            service: snapshot.service,
            eventLoopP99Ms,
            activeConnections: Number(snapshot.stats.transport?.connections?.active ?? 0),
            receiveSyncP99Ms: Number(snapshot.stats.transport?.syncCpu?.receiveP99Ms ?? 0),
            generateSyncP99Ms: Number(snapshot.stats.transport?.syncCpu?.generateP99Ms ?? 0),
            maxReceiveSyncMs: Number(snapshot.stats.transport?.syncCpu?.maxReceiveMs ?? 0),
            maxGenerateSyncMs: Number(snapshot.stats.transport?.syncCpu?.maxGenerateMs ?? 0),
            maxInboundFrameBytes: Number(snapshot.stats.transport?.traffic?.maxInboundFrameBytes ?? 0),
          })
          this.eventLoopOutliers.sort((left, right) => right.eventLoopP99Ms - left.eventLoopP99Ms)
          this.eventLoopOutliers.length = Math.min(this.eventLoopOutliers.length, 12)
        }
      }
      this.maxRssBytes = Math.max(this.maxRssBytes, Number(snapshot.stats.transport?.processMemoryBytes?.rss ?? 0))
      this.maxForeignResidentProjectors = Math.max(
        this.maxForeignResidentProjectors,
        Number(snapshot.fleet.foreignResidentProjectors ?? 0),
      )
      this.maxStaleFenceCoalescingCacheSize = Math.max(
        this.maxStaleFenceCoalescingCacheSize,
        storageFenceMetric(
          snapshot.ownership?.storageFence,
          'coalescedStaleFenceRetryCacheSize',
          'coalescedOwnershipUnavailableCacheSize',
        ),
      )
      this.maxRetiredDocuments = Math.max(
        this.maxRetiredDocuments,
        Number(snapshot.stats.synchronizer?.retiredDocuments?.count ?? 0),
      )
      if (snapshot.stats.synchronizer?.retiredDocuments?.overLimit === true) {
        this.retiredDocumentLimitExceeded = true
      }
    }
    if (!partial) this.peakActiveConnections = Math.max(this.peakActiveConnections, active)
  }

  summarize(finalSnapshots, intentionallyPausedService = null) {
    const sumDelta = (reader) => finalSnapshots.reduce((sum, snapshot, index) => (
      sum + Math.max(0, reader(snapshot) - reader(this.baseline[index]))
    ), 0)
    const mapDelta = (snapshot, baseline, key) => Object.fromEntries(
      [...new Set([
        ...Object.keys(snapshot.ownership?.storageFence?.[key] ?? {}),
        ...Object.keys(baseline.ownership?.storageFence?.[key] ?? {}),
      ])].map((entry) => [
        entry,
        Math.max(
          0,
          Number(snapshot.ownership?.storageFence?.[key]?.[entry] ?? 0)
            - Number(baseline.ownership?.storageFence?.[key]?.[entry] ?? 0),
        ),
      ]),
    )
    const rejectedStorageMutationsByService = finalSnapshots.map((snapshot, index) => ({
      service: snapshot.service,
      count: Math.max(
        0,
        Number(snapshot.ownership?.storageFence?.rejectedMutationCount ?? 0)
          - Number(this.baseline[index].ownership?.storageFence?.rejectedMutationCount ?? 0),
      ),
      distinctDocuments: Math.max(
        0,
        Number(snapshot.ownership?.storageFence?.rejectedDocumentCount ?? 0)
          - Number(this.baseline[index].ownership?.storageFence?.rejectedDocumentCount ?? 0),
      ),
      distinctMutationIdentities: Math.max(
        0,
        Number(snapshot.ownership?.storageFence?.rejectedMutationIdentityCount ?? 0)
          - Number(this.baseline[index].ownership?.storageFence?.rejectedMutationIdentityCount ?? 0),
      ),
      repeated: Math.max(
        0,
        Number(snapshot.ownership?.storageFence?.repeatedRejectedMutationCount ?? 0)
          - Number(this.baseline[index].ownership?.storageFence?.repeatedRejectedMutationCount ?? 0),
      ),
      coalescedStaleFenceRetries: Math.max(
        0,
        storageFenceMetric(
          snapshot.ownership?.storageFence,
          'coalescedStaleFenceRetryCount',
          'coalescedOwnershipUnavailableCount',
        ) - storageFenceMetric(
          this.baseline[index].ownership?.storageFence,
          'coalescedStaleFenceRetryCount',
          'coalescedOwnershipUnavailableCount',
        ),
      ),
      coalescedOwnershipUnavailable: Math.max(
        0,
        Number(snapshot.ownership?.storageFence?.coalescedOwnershipUnavailableCount ?? 0)
          - Number(this.baseline[index].ownership?.storageFence?.coalescedOwnershipUnavailableCount ?? 0),
      ),
      coalescedFenceMismatch: Math.max(
        0,
        Number(snapshot.ownership?.storageFence?.coalescedFenceMismatchCount ?? 0)
          - Number(this.baseline[index].ownership?.storageFence?.coalescedFenceMismatchCount ?? 0),
      ),
      coalescingCacheSize: storageFenceMetric(
        snapshot.ownership?.storageFence,
        'coalescedStaleFenceRetryCacheSize',
        'coalescedOwnershipUnavailableCacheSize',
      ),
      coalescingEvictions: Math.max(
        0,
        storageFenceMetric(
          snapshot.ownership?.storageFence,
          'coalescedStaleFenceRetryEvictions',
          'coalescedOwnershipUnavailableEvictions',
        ) - storageFenceMetric(
          this.baseline[index].ownership?.storageFence,
          'coalescedStaleFenceRetryEvictions',
          'coalescedOwnershipUnavailableEvictions',
        ),
      ),
      maxCoalescedPerMutation: storageFenceMetric(
        snapshot.ownership?.storageFence,
        'maxCoalescedStaleFenceRetriesPerMutation',
        'maxCoalescedOwnershipUnavailablePerMutation',
      ),
      byKind: mapDelta(snapshot, this.baseline[index], 'rejectedMutationsByKind'),
      byReason: mapDelta(snapshot, this.baseline[index], 'rejectedMutationsByReason'),
    }))
    const expectedStaleFenceRejections = rejectedStorageMutationsByService
      .filter(({ service }) => service === intentionallyPausedService)
      .reduce((sum, { count }) => sum + count, 0)
    const unexpectedStorageFenceRejections = rejectedStorageMutationsByService
      .filter(({ service }) => service !== intentionallyPausedService)
      .reduce((sum, { count }) => sum + count, 0)
    const expectedStaleOwnerRejections = rejectedStorageMutationsByService
      .filter(({ service }) => service === intentionallyPausedService)
    const unexpectedStaleFenceKinds = expectedStaleOwnerRejections.reduce((sum, rejection) => (
      sum
        + Number(rejection.byKind?.['sync-state'] ?? 0)
        + Number(rejection.byKind?.['document-range'] ?? 0)
        + Number(rejection.byKind?.other ?? 0)
    ), 0)
    const repeatedStaleFenceRejections = expectedStaleOwnerRejections
      .reduce((sum, rejection) => sum + rejection.repeated, 0)
    const expectedCoalescedStaleFenceRejections = expectedStaleOwnerRejections
      .reduce((sum, rejection) => sum + rejection.coalescedStaleFenceRetries, 0)
    const unexpectedCoalescedStaleFenceRejections = rejectedStorageMutationsByService
      .filter(({ service }) => service !== intentionallyPausedService)
      .reduce((sum, rejection) => sum + rejection.coalescedStaleFenceRetries, 0)
    const staleFenceCoalescingEvictions = rejectedStorageMutationsByService
      .reduce((sum, rejection) => sum + rejection.coalescingEvictions, 0)
    const maxCoalescedStaleFenceRejectionsPerMutation = rejectedStorageMutationsByService
      .reduce((maximum, rejection) => Math.max(maximum, rejection.maxCoalescedPerMutation), 0)
    return {
      samples: this.samples,
      peakActiveConnections: this.peakActiveConnections,
      maxSynchronizerPeerBindings: this.maxSynchronizerPeerBindings,
      maxPeersPerDocument: this.maxPeersPerDocument,
      maxReceiveSyncP99Ms: this.maxReceiveSyncP99Ms,
      maxGenerateSyncP99Ms: this.maxGenerateSyncP99Ms,
      maxReceiveSyncMs: this.maxReceiveSyncMs,
      maxGenerateSyncMs: this.maxGenerateSyncMs,
      maxInboundFrameBytes: this.maxInboundFrameBytes,
      maxEventLoopP99Ms: this.maxEventLoopP99Ms,
      maxEventLoopP99MsByService: this.maxEventLoopP99MsByService,
      eventLoopOutliers: this.eventLoopOutliers,
      maxRssBytes: this.maxRssBytes,
      maxForeignResidentProjectors: this.maxForeignResidentProjectors,
      maxStaleFenceCoalescingCacheSize: this.maxStaleFenceCoalescingCacheSize,
      maxRetiredDocuments: this.maxRetiredDocuments,
      retiredDocumentLimitExceeded: this.retiredDocumentLimitExceeded,
      unexpectedSampleFailures: this.unexpectedSampleFailures,
      sampleFailuresByService: [...this.sampleFailuresByService].map(([service, value]) => ({
        service,
        ...value,
      })),
      excludedEventLoopServices: [...this.excludedEventLoopServices],
      backpressureDisconnectsDelta: sumDelta((snapshot) => Number(snapshot.stats?.transport?.backpressure?.disconnects ?? 0)),
      droppedBackpressureFramesDelta: sumDelta((snapshot) => Number(snapshot.stats?.transport?.traffic?.outboundDroppedBackpressure ?? 0)),
      rejectedStorageMutationsDelta: expectedStaleFenceRejections + unexpectedStorageFenceRejections,
      expectedStaleFenceRejections,
      unexpectedStorageFenceRejections,
      unexpectedStaleFenceKinds,
      repeatedStaleFenceRejections,
      expectedCoalescedStaleFenceRejections,
      unexpectedCoalescedStaleFenceRejections,
      staleFenceCoalescingEvictions,
      maxCoalescedStaleFenceRejectionsPerMutation,
      rejectedStorageMutationsByService,
    }
  }
}

/** All clients are holding their sockets at this point. The reads are not an
 * atomic cross-process sample, but nobody can edit or intentionally disconnect
 * before the shared release. 199 is never rounded to a fleet of 200. */
export function baselineBarrierAdmission(barrierId, processes, snapshots, observedAt = Date.now()) {
  if (processes.length !== 8 || processes.some((entry) => !entry.barrier.ready || entry.barrier.error)) return null
  const cohortIds = new Set()
  for (const entry of processes) {
    const ready = entry.barrier.ready
    const key = `${entry.partition}:${entry.cohort}`
    if (![0, 1].includes(entry.partition) || ![0, 1, 2, 3].includes(entry.cohort) || cohortIds.has(key)
      || ready.barrierId !== barrierId || ready.users !== 25 || ready.userOffset !== entry.cohort * 25
      || ready.totalUsers !== 100) return null
    cohortIds.add(key)
  }
  if (snapshots.length !== 3 || new Set(snapshots.map((entry) => entry.service)).size !== 3) return null
  const owners = snapshots.filter((entry) => entry.ownership?.ready && entry.ownership.partitionReady
    && [0, 1].includes(entry.ownership.partitionIndex))
  if (owners.length !== 2 || new Set(owners.map((entry) => entry.ownership.partitionIndex)).size !== 2) return null
  const cells = snapshots.map((entry) => ({
    service: entry.service,
    processBootId: entry.stats?.processBootId ?? null,
    activeConnections: entry.stats?.transport?.connections?.active,
    ownership: entry.ownership,
  }))
  if (cells.some((entry) => !Number.isSafeInteger(entry.activeConnections) || entry.activeConnections < 0)) return null
  if (owners.some((owner) => owner.stats?.transport?.connections?.active !== 100)) return null
  const totalActiveConnections = cells.reduce((sum, entry) => sum + entry.activeConnections, 0)
  if (totalActiveConnections !== 200) return null
  return {
    barrierId, observedAt, totalActiveConnections, cells,
    cohorts: processes.map((entry) => ({ partition: entry.partition, cohort: entry.cohort, ...entry.barrier.ready })),
  }
}

export async function releaseBaselineIfAdmitted(barrierId, processes, snapshots, qualifyTargets = null, createReleaseNonce = randomUUID) {
  const admission = baselineBarrierAdmission(barrierId, processes, snapshots)
  if (!admission) return null
  // Owners and clients may have spent minutes waiting since main's preflight.
  // Bind the HTTP ports to those same image/container identities again before
  // any child is told to edit. A failed observation leaves the barrier closed.
  if (qualifyTargets) admission.topologyTargets = await qualifyTargets()
  // Mint after admission and target revalidation, never in the child's startup
  // environment. Its receipt proves release even when two process wall clocks
  // differ by a millisecond.
  admission.releaseNonce = createReleaseNonce()
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(admission.releaseNonce)
    || admission.releaseNonce === barrierId) throw new Error('load baseline release requires a separate UUID nonce')
  admission.releaseStartedAt = Date.now()
  await withDeadline(Promise.all(processes.map((entry) => entry.releaseBaseline(admission.releaseNonce))), 5_000, 'load baseline IPC release')
  admission.releaseCompletedAt = Date.now()
  return admission
}

/** The start barrier outside a posture qualification: every cohort is holding
 * its connected clients, so all of them are released together. The fleet-size
 * and topology admission stays the posture qualification's own. */
export async function releaseCohortsIfReady(barrierId, processes, createReleaseNonce = randomUUID) {
  if (processes.length === 0 || processes.some((entry) => !entry.barrier.ready || entry.barrier.error)) return null
  const admission = {
    barrierId, observedAt: Date.now(),
    cohorts: processes.map((entry) => ({ partition: entry.partition, cohort: entry.cohort, ...entry.barrier.ready })),
    releaseNonce: createReleaseNonce(),
  }
  if (admission.releaseNonce === barrierId) throw new Error('load cohort release requires a separate nonce')
  admission.releaseStartedAt = Date.now()
  await withDeadline(Promise.all(processes.map((entry) => entry.releaseBaseline(admission.releaseNonce))), 5_000, 'load cohort IPC release')
  admission.releaseCompletedAt = Date.now()
  return admission
}

async function runLoadPair(config, selections, targets, cookie, accumulator, options = {}) {
  // EVERY pair is its own episode behind a start barrier, not only a posture
  // qualification. Without the episode, a later phase's convergence is met by
  // the previous phase's final round, which is still in the document. Without
  // the barrier, cohorts start editing whenever their own Workers finish
  // connecting: on a two-vCPU runner the five-user cohort started ~20 s before
  // the ten-user ones, finished alone, and reported values the others then
  // overwrote (run 38190063700).
  const barrierId = randomUUID()
  const receivedResults = []
  const barrierDeadline = Date.now() + 90_000
  let baselineReleased = false
  const cohorts = []
  for (let offset = 0, index = 0; offset < config.usersPerWorkspace; index += 1) {
    const users = Math.min(config.clientsPerProcess, config.usersPerWorkspace - offset)
    cohorts.push({ index, offset, users })
    offset += users
  }
  const processes = [0, 1].flatMap((partition) => cohorts.map((cohort) => startLoadProcess(
    config,
    selections.get(partition),
    targets.get(partition),
    cookie,
    `${options.phase || 'load'} partition ${partition} cohort ${cohort.index}`,
    options.startDelay ?? 1_000,
    partition,
    cohort,
    barrierId,
    row => { receivedResults.push(row); options.onResult?.(row) },
  )))
  let settled = false
  let result = null
  let failure = null
  let lastSnapshots = null
  let injectionPromise = null
  let injectionSettled = true
  let injectionError = null
  const completed = config.benchPosture
    ? Promise.allSettled(processes.map(({ promise }) => promise)).then((settlements) => {
      const values = settlements.map((entry) => entry.status === 'fulfilled' ? entry.value : entry.reason?.loadResult ?? null)
      const rejected = settlements.filter((entry) => entry.status === 'rejected')
      if (rejected.length) {
        const error = new Error(rejected.map((entry) => entry.reason?.message ?? String(entry.reason)).join('; '))
        error.baselineResults = values
        throw error
      }
      return values
    })
    : Promise.all(processes.map(({ promise }) => promise))
  completed
    .then((value) => { result = value })
    .catch((error) => { failure = error })
    .finally(() => { settled = true })

  try {
    let injected = false
    while (!settled || !injectionSettled) {
      const consume = (snapshots, context) => {
        lastSnapshots = snapshots
        accumulator.record(snapshots, context.unavailableService)
        options.onSample?.(snapshots, context)
      }
      const { snapshots } = options.collectSample ? await options.collectSample(consume) : await (async () => {
        const context = { unavailableService: options.unavailableService?.() }
        const snapshots = await Promise.all(cells(config).map((cell) => cellSnapshot(cell, cookie, true, request, config.diagnosticTimeoutMs)))
        consume(snapshots, context)
        return { snapshots }
      })()
      if (barrierId && !baselineReleased) {
        const broken = processes.find((entry) => entry.barrier.error || entry.child.exitCode !== null || entry.child.signalCode !== null)
        if (broken) throw broken.barrier.error || new Error('load baseline child exited before admission')
        if (Date.now() >= barrierDeadline) throw new Error('load baseline admission exceeded 90000 ms')
        const admission = config.benchPosture
          ? await releaseBaselineIfAdmitted(barrierId, processes, snapshots, () => revalidateLoadTopology(config))
          : await releaseCohortsIfReady(barrierId, processes)
        if (admission) {
          baselineReleased = true
          options.onBaselineAdmission?.(admission)
        }
      }
      if (options.inject && !injected && (!barrierId || baselineReleased)
        && loadProcessesReadyForFailure(processes, snapshots, options.injectWhen)) {
        injected = true
        injectionSettled = false
        injectionPromise = Promise.resolve().then(options.inject)
          .catch(error => { injectionError = error })
          .finally(() => { injectionSettled = true })
      }
      await delay(config.sampleMs)
    }
    if (injectionError) {
      injectionError.baselineResults = result ?? failure?.baselineResults ?? receivedResults
      throw attachSampledMetrics(injectionError, accumulator, lastSnapshots, options.unavailableService?.())
    }
    if (failure) throw attachSampledMetrics(failure, accumulator, lastSnapshots, options.unavailableService?.())
    return result
  } catch (error) {
    error.baselineResults ??= result ?? failure?.baselineResults ?? receivedResults
    throw error
  } finally {
    // A failed diagnostics/takeover assertion must not strand load generators
    // that keep sockets and documents resident in the next qualification run.
    for (const process of processes) {
      if (process.child.exitCode === null && process.child.signalCode === null) {
        process.child.kill()
      }
    }
    const cleanup = await Promise.allSettled([
      withDeadline(Promise.allSettled(processes.map((entry) => entry.promise)), 5_000, 'load child cleanup'),
      ...(injectionPromise ? [withDeadline(injectionPromise, 240_000, 'injected failure cleanup')] : []),
    ])
    const errors = cleanup.filter(entry => entry.status === 'rejected').map(entry => entry.reason)
    if (errors.length) {
      const error = new AggregateError(errors, 'load cleanup could not be confirmed')
      error.baselineResults = result ?? failure?.baselineResults ?? receivedResults
      throw error
    }
  }
}

/**
 * The per-cell samples the gate took DURING a load phase, attached to the
 * failure that ends the phase.
 *
 * The accumulator samples every cell's own `/api/automerge/stats` every
 * 500 ms — the owner's event-loop p99 included. A cohort's non-zero exit
 * throws out of `runLoadPair` before `summarize()` runs, so without this the
 * samples covering the failing episode would be discarded.
 *
 * Only the subset an operator reads first is attached; the full summary stays
 * in the pass object of a run that passes.
 */
export function attachSampledMetrics(failure, accumulator, snapshots, unavailableService = null) {
  if (!(failure instanceof Error)) return failure
  if (!Array.isArray(snapshots)) {
    // SAID, not silent: a failure before the first sample, or a dead wire
    // (`lastSnapshots` never written), reads as "no sample" rather than
    // leaving the message untouched, which would read as "nothing to report".
    failure.message += '\nsampledMetrics=none (no sample taken before the failure)'
    return failure
  }
  let summary
  try {
    summary = accumulator.summarize(snapshots, unavailableService)
  } catch (error) {
    failure.message += `\nsampledMetrics=unavailable (${error instanceof Error ? error.message : String(error)})`
    return failure
  }
  const picked = {
    samples: summary.samples,
    peakActiveConnections: summary.peakActiveConnections,
    maxEventLoopP99Ms: summary.maxEventLoopP99Ms,
    maxEventLoopP99MsByService: summary.maxEventLoopP99MsByService,
    eventLoopOutliers: summary.eventLoopOutliers.slice(0, 6),
    maxReceiveSyncMs: summary.maxReceiveSyncMs,
    maxGenerateSyncMs: summary.maxGenerateSyncMs,
    maxInboundFrameBytes: summary.maxInboundFrameBytes,
    backpressureDisconnectsDelta: summary.backpressureDisconnectsDelta,
    droppedBackpressureFramesDelta: summary.droppedBackpressureFramesDelta,
    unexpectedSampleFailures: summary.unexpectedSampleFailures,
    sampleFailuresByService: summary.sampleFailuresByService,
  }
  failure.message += `\nsampledMetrics=${JSON.stringify(picked)}`
  return failure
}

export async function cleanupFreshLandscapes(
  config,
  allCells,
  cookie,
  landscapeIds,
  deleteRequest = request,
) {
  if (!config.freshWorkspaces || landscapeIds.length === 0) return
  const targets = [
    { baseUrl: routerHttp(config) },
    ...allCells,
  ]
  for (const landscapeId of [...new Set(landscapeIds)]) {
    await waitFor(`cleanup of load landscape ${landscapeId}`, async () => {
      for (const target of targets) {
        const result = await deleteRequest(
          `${target.baseUrl}/api/landscapes/${encodeURIComponent(landscapeId)}`,
          { cookie, method: 'DELETE' },
        ).catch(() => null)
        if (result?.status === 200 || result?.status === 404) return true
      }
      return null
    }, 30_000)
  }
}

export async function completeQualificationCleanup(cleanup, primaryError, logger = console) {
  try {
    await cleanup()
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError
    logger.error(`qualification cleanup also failed: ${cleanupError instanceof Error
      ? cleanupError.message
      : String(cleanupError)}`)
  }
}

export function summarizeLoadNetworkDiagnostics(diagnostics = []) {
  const connectionEvents = diagnostics.flatMap((entry) => Array.isArray(entry?.connectionTimeline)
    ? entry.connectionTimeline
    : [])
  const closeEvents = diagnostics.flatMap((entry) => Array.isArray(entry?.closeTimeline)
    ? entry.closeTimeline
    : [])
  const openEvents = diagnostics.flatMap((entry) => Array.isArray(entry?.openTimeline)
    ? entry.openTimeline
    : [])
  const attemptEvents = diagnostics.flatMap((entry) => Array.isArray(entry?.attemptTimeline)
    ? entry.attemptTimeline
    : [])
  const closeCodes = {}
  for (const entry of diagnostics) {
    for (const code of Array.isArray(entry?.closeCodes) ? entry.closeCodes : []) {
      closeCodes[code] = (closeCodes[code] ?? 0) + 1
    }
  }
  return {
    peers: diagnostics.length,
    connections: diagnostics.reduce((sum, entry) => sum
      + (Array.isArray(entry?.connectionHistory) ? entry.connectionHistory.length : 0), 0),
    reconnects: diagnostics.reduce((sum, entry) => sum
      + Math.max(0, (Array.isArray(entry?.connectionHistory) ? entry.connectionHistory.length : 0) - 1), 0),
    closeCodes,
    sendWhileDisconnected: diagnostics.reduce((sum, entry) => sum
      + Number(entry?.sendWhileDisconnected ?? 0), 0),
    firstConnectedAt: connectionEvents.length > 0
      ? Math.min(...connectionEvents.map((entry) => Number(entry.at)))
      : null,
    lastConnectedAt: connectionEvents.length > 0
      ? Math.max(...connectionEvents.map((entry) => Number(entry.at)))
      : null,
    lastOpenedAt: openEvents.length > 0
      ? Math.max(...openEvents.map((entry) => Number(entry.at)))
      : null,
    lastAttemptedAt: attemptEvents.length > 0
      ? Math.max(...attemptEvents.map((entry) => Number(entry.at)))
      : null,
    lastClosedAt: closeEvents.length > 0
      ? Math.max(...closeEvents.map((entry) => Number(entry.at)))
      : null,
  }
}

export function convergedResult(result) {
  return {
    ...(result.clientIsolation ? { clientIsolation: result.clientIsolation,
      workerClosure: result.workerClosure, childProcess: result.childProcess,
      writesCompleted: result.writesCompleted } : {}),
    ...(Object.hasOwn(result, 'lastWriteCompletedAt') ? {
      lastWriteCompletedAt: result.lastWriteCompletedAt,
      cohortWriters: result.cohortWriters,
      episodeId: result.episodeId,
    } : {}),
    partition: Number(result.partition),
    cohort: Number(result.cohort),
    connectMs: Number(result.connectMs),
    editMs: Number(result.editMs),
    editStartedAt: Number(result.editStartedAt),
    editCompletedAt: Number(result.editCompletedAt),
    convergedAt: Number(result.convergedAt),
    convergenceMs: Number(result.convergenceMs),
    fullyConverged: result.fullyConverged === true,
    missingFields: Number(result.missingFields),
    staleFields: Number(result.staleFields ?? 0),
    hotDiverged: Number(result.hotDiverged),
    clientsConverged: Number(result.clientsConverged),
    clientsTotal: Number(result.clientsTotal),
    hotValues: Array.isArray(result.hotValues) ? result.hotValues : [],
    // THE CLIENT'S OWN EDIT, READ BACK FROM THE CLIENT'S OWN DOCUMENT.
    //
    // `load-users.mjs` records, per user, the value of the field only THAT user
    // writes, read from that user's local handle immediately after the edit
    // round. A `null` there is not convergence lag and not another peer's
    // problem: the client made the edit and its own copy does not have it, which
    // is a write that was refused or rolled back under it.
    rejectedClientEdits: countRejectedClientEdits(result.localOwnFieldsAfterEdit),
    // CARRIED THROUGH, because the evaluator derives its total from this raw
    // field and `run()` hands the evaluator THESE normalised results, not the
    // raw ones; dropping it would publish `rejectedClientEdits: null` ("not
    // measured") on a run that measured it. A stored report keeps the raw facts
    // as well as the per-process count, and either can be re-derived from the
    // other.
    localOwnFieldsAfterEdit: Array.isArray(result.localOwnFieldsAfterEdit)
      ? result.localOwnFieldsAfterEdit.map((entry) => ({
          user: entry?.user,
          values: Array.isArray(entry?.values) ? [...entry.values] : null,
        }))
      : null,
    network: summarizeLoadNetworkDiagnostics(result.networkDiagnostics),
  }
}

/**
 * How many of a process's own edits are missing from its own document.
 *
 * A MALFORMED SHAPE IS NOT ZERO. An absent or non-array `localOwnFieldsAfterEdit`
 * means the client did not report the fact at all, and reading that as "no
 * refusals" is a false PASS — an evidence file from an older client would
 * silently certify clean. `null` says "not measured",
 * and the pass object refuses to publish a number it does not have.
 */
function countRejectedClientEdits(localOwnFieldsAfterEdit) {
  if (!Array.isArray(localOwnFieldsAfterEdit)) return null
  let rejected = 0
  for (const entry of localOwnFieldsAfterEdit) {
    if (!Array.isArray(entry?.values)) return null
    for (const value of entry.values) {
      // `=== null` ALONE: `load-users.mjs` writes `… ?? null`, and
      // `JSON.stringify` turns an `undefined` array element into `null`, so no
      // producer and no stored report can deliver `undefined`.
      if (value === null) rejected += 1
    }
  }
  return rejected
}

/** Sum a field over every result, propagating "not measured" rather than
 *  swallowing it into a total that reads as clean. */
function sumOverResults(results, field) {
  let total = 0
  for (const result of results) {
    const value = result[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    total += value
  }
  return total
}

/**
 * The refusal total, derived from the raw per-user facts.
 *
 * `run()` evaluates results that `convergedResult` has ALREADY normalised, so
 * the raw field is only here because `convergedResult` carries it through (see
 * the comment there). `null` means "not measured" — a result that carries
 * neither the raw facts nor a count.
 */
function sumRejectedClientEdits(results) {
  let total = 0
  for (const result of results) {
    const rejected = countRejectedClientEdits(result.localOwnFieldsAfterEdit)
    if (rejected === null) return null
    total += rejected
  }
  return total
}

function cohortHotValuesConverged(results) {
  for (const partition of [0, 1]) {
    const values = results
      .filter((result) => result.partition === partition)
      .map((result) => JSON.stringify(result.hotValues))
    if (values.length === 0 || new Set(values).size !== 1) return false
  }
  return true
}

/**
 * A distributed phase is still producing work until its last cohort finishes
 * editing. Starting each cohort's SLO clock at its own completion incorrectly
 * charges early cohorts for future writes they cannot possibly have observed.
 * Measure each partition from the final producer completion to the final
 * consumer convergence instead.
 */
export function summarizeCycleConvergence(results) {
  return [0, 1].map((partition) => {
    const partitionResults = results.filter((result) => result.partition === partition)
    if (partitionResults.length === 0) {
      return { partition, editCompletedAt: 0, convergedAt: 0, convergenceMs: Number.POSITIVE_INFINITY }
    }
    const actualWritesMeasured = partitionResults.some(result => Object.hasOwn(result, 'lastWriteCompletedAt'))
    const writers = partitionResults.filter(result => result.cohortWriters > 0)
    const editCompletedAt = actualWritesMeasured
      ? (partitionResults.every(result => Object.hasOwn(result, 'lastWriteCompletedAt')) && writers.length
        ? Math.max(...writers.map(result => result.lastWriteCompletedAt ?? Number.NaN)) : Number.NaN)
      : Math.max(...partitionResults.map((result) => Number(result.editCompletedAt)))
    const convergedAt = Math.max(...partitionResults.map((result) => Number(result.convergedAt)))
    return {
      partition,
      editCompletedAt,
      convergedAt,
      convergenceMs: Number.isFinite(editCompletedAt) && convergedAt >= editCompletedAt
        ? convergedAt - editCompletedAt : Number.POSITIVE_INFINITY,
    }
  })
}

/** The baseline is independent of the later intentional pause and cleanup.
 * Missing facts make it VOID; they cannot become a product failure.
 * Historical load records do not acquire this qualification retroactively. */
export function evaluatePostureBaseline(evidence, config) {
  return evaluatePostureEpisode(evidence, config, 'baseline')
}

/** Same admission and raw facts in every qualified episode. Only the named
 * voluntary loss is expected; prior loss counters remain cumulative facts. */
export function evaluatePostureEpisode(evidence, config, phase, takeover = null) {
  const invalid = []
  const failures = []
  if (!['baseline', 'failover', 'soak'].includes(phase)) invalid.push('invalid episode phase')
  if (phase !== 'baseline' && config.mode !== 'soak') invalid.push('extended qualification requires soak mode')
  try { assertPostureQualificationConfig(config) } catch (error) { invalid.push(error.message) }
  if (typeof config.topologyGeneration !== 'string' || !config.topologyGeneration.trim()) {
    invalid.push('baseline expected topology generation is missing')
  }
  let expectedTopology = null
  try {
    assertTopologyBuild(config.topologyBuild, loadTopologyTargets(config), config.project)
    expectedTopology = config.topologyBuild.expectedTopology
    if (expectedTopology.partitionCount !== config.partitionCount
      || expectedTopology.configuredGeneration !== config.topologyGeneration?.trim().toLowerCase()) {
      invalid.push('baseline topology build does not match the requested configuration')
    }
  } catch {
    invalid.push('baseline topology build provenance is absent, invalid or mismatched')
  }
  const before = evidence.baselineOwnership?.before
  const after = evidence.baselineOwnership?.after
  const services = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c']
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0
  const reads = new Map()
  for (const [edge, entries] of [['before', before], ['after', after]]) {
    const byService = new Map()
    if (!Array.isArray(entries) || entries.length !== services.length) {
      invalid.push(`baseline ${edge} requires all three ownership readings`)
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!services.includes(entry?.service) || byService.has(entry.service)) {
        invalid.push(`baseline ${edge} contains an unexpected or duplicate cell`)
        continue
      }
      byService.set(entry.service, entry)
      if (!uuid.test(entry.processBootIdBefore) || entry.processBootIdBefore !== entry.processBootIdAfter) {
        invalid.push(`baseline ${edge} ${entry.service} process identity is missing or changed around ownership`)
      }
      const state = entry.ownership
      if (!state || !validCount(state.partitionLossCount)
        || typeof state.cellId !== 'string' || !state.cellId.trim()
        || typeof state.topologyGeneration !== 'string' || !state.topologyGeneration.trim()
        || state.partitionCount !== 2 || typeof state.ready !== 'boolean'
        || typeof state.partitionReady !== 'boolean'
        || ![null, 0, 1].includes(state.partitionIndex)) {
        invalid.push(`baseline ${edge} ${entry.service} ownership is absent or malformed`)
      }
      if (expectedTopology && (state?.topologyGeneration !== expectedTopology.effectiveGeneration
        || state?.effectiveGeneration !== expectedTopology.effectiveGeneration
        || state?.configuredGeneration !== expectedTopology.configuredGeneration)) {
        invalid.push(`baseline ${edge} ${entry.service} belongs to another topology generation`)
      }
    }
    if (byService.size !== services.length) invalid.push(`baseline ${edge} cell census is incomplete`)
    reads.set(edge, byService)
  }
  const initial = Array.isArray(before) ? before.map((entry) => entry?.ownership) : []
  const initialOwners = initial.filter((state) => state?.ready && state.partitionReady && [0, 1].includes(state.partitionIndex))
  const initialSpares = initial.filter((state) => state?.ready === false && state.partitionReady === false && state.partitionIndex === null)
  if (initialOwners.length !== 2 || initialSpares.length !== 1
    || new Set(initialOwners.map((state) => state.partitionIndex)).size !== 2) {
    invalid.push('baseline admission requires one ready owner per partition and one spare')
  }
  if (phase === 'baseline' && initialOwners.some((state) => validCount(state.partitionLossCount) && state.partitionLossCount !== 0)) {
    invalid.push('baseline admission owner already has partition losses; attribution to this load is unavailable')
  }
  if (new Set(initial.map((state) => state?.cellId)).size !== 3
    || new Set((Array.isArray(before) ? before : []).map((entry) => entry?.processBootIdBefore)).size !== 3) {
    invalid.push('baseline cell and process identities must be distinct')
  }
  let lossObserved = false
  // A spare acquires a lost partition without incrementing its own loss
  // counter. Attribute that acquisition to the initial owner's measured
  // loss; a transfer of another partition still lacks an explanation.
  const lostInitialPartitions = new Set(services.flatMap((service) => {
    const oldState = reads.get('before').get(service)?.ownership
    const newState = reads.get('after').get(service)?.ownership
    return [0, 1].includes(oldState?.partitionIndex)
      && validCount(oldState?.partitionLossCount) && validCount(newState?.partitionLossCount)
      && newState.partitionLossCount > oldState.partitionLossCount
      ? [oldState.partitionIndex] : []
  }))
  for (const service of services) {
    const left = reads.get('before').get(service)
    const right = reads.get('after').get(service)
    if (!left || !right) continue
    const oldState = left.ownership
    const newState = right.ownership
    if (left.processBootIdBefore !== right.processBootIdBefore) {
      invalid.push(`baseline ${service} restarted across the load window`)
    }
    if (oldState?.cellId !== newState?.cellId || oldState?.topologyGeneration !== newState?.topologyGeneration) {
      invalid.push(`baseline ${service} cell or topology identity changed`)
    }
    if (validCount(oldState?.partitionLossCount) && validCount(newState?.partitionLossCount)) {
      if (newState.partitionLossCount < oldState.partitionLossCount) invalid.push(`baseline ${service} partition loss counter reset`)
      const expectedVoluntaryLoss = phase === 'failover' && takeover?.verified === true
        && takeover.originalService === service && takeover.replacementService !== service
        && oldState.partitionIndex === 0 && newState.partitionLossCount === oldState.partitionLossCount + 1
      if (newState.partitionLossCount > oldState.partitionLossCount && !expectedVoluntaryLoss) lossObserved = true
      const recoveredBySpare = oldState.partitionIndex === null && !oldState.ready && !oldState.partitionReady
        && newState.ready && newState.partitionReady && lostInitialPartitions.has(newState.partitionIndex)
      if (newState.partitionLossCount === oldState.partitionLossCount
        && (newState.partitionIndex !== oldState.partitionIndex || newState.partitionReady !== oldState.partitionReady
          || newState.ready !== oldState.ready) && !recoveredBySpare) {
        invalid.push(`baseline ${service} authority changed without a measured partition loss`)
      }
    }
  }
  if (lossObserved) failures.push('baseline measured partition loss before voluntary failover')

  const admission = evidence.baselineAdmission
  try {
    assertTopologyTargetReceipt(config.topologyBuild, admission?.topologyTargets)
    if (admission.topologyTargets.beganAt < admission.observedAt
      || admission.topologyTargets.endedAt > admission.releaseStartedAt) {
      invalid.push('baseline topology targets were not revalidated at admission')
    }
  } catch {
    invalid.push('baseline topology target admission provenance is absent or changed')
  }
  const admittedCells = admission?.cells
  const admittedProcesses = (Array.isArray(admission?.cohorts) ? admission.cohorts : []).map((entry) => ({
    partition: entry?.partition, cohort: entry?.cohort, barrier: { ready: entry, error: null },
  }))
  const admittedSnapshots = (Array.isArray(admittedCells) ? admittedCells : []).map((entry) => ({
    service: entry?.service, ownership: entry?.ownership,
    stats: { processBootId: entry?.processBootId, transport: { connections: { active: entry?.activeConnections } } },
  }))
  if (!uuid.test(admission?.barrierId) || !baselineBarrierAdmission(admission.barrierId, admittedProcesses, admittedSnapshots, admission.observedAt)
    || !uuid.test(admission?.releaseNonce) || admission.releaseNonce === admission.barrierId
    || admission.totalActiveConnections !== 200
    || ![admission.observedAt, admission.releaseStartedAt, admission.releaseCompletedAt].every((value) => Number.isSafeInteger(value) && value > 0)
    || admission.releaseStartedAt < admission.observedAt || admission.releaseCompletedAt < admission.releaseStartedAt) {
    invalid.push('baseline requires an admitted 200-client fleet and complete IPC barrier release')
  }
  for (const cell of Array.isArray(admittedCells) ? admittedCells : []) {
    const previous = reads.get('before').get(cell?.service)
    if (!previous || cell?.processBootId !== previous.processBootIdBefore
      || cell.ownership?.cellId !== previous.ownership?.cellId
      || cell.ownership?.partitionIndex !== previous.ownership?.partitionIndex
      || cell.ownership?.configuredGeneration !== previous.ownership?.configuredGeneration
      || cell.ownership?.effectiveGeneration !== previous.ownership?.effectiveGeneration
      || cell.ownership?.topologyGeneration !== previous.ownership?.topologyGeneration) {
      invalid.push('baseline admission no longer describes the original owners and processes')
    }
  }

  const raw = evidence.baselineResults
  const partitions = []
  const seen = new Set()
  if (!Array.isArray(raw) || raw.length !== 8) invalid.push('baseline requires eight complete fleet cohort results')
  for (const result of Array.isArray(raw) ? raw : []) {
    if (!result || ![0, 1].includes(result.partition) || !Number.isInteger(result.cohort)
      || result.cohort < 0 || result.cohort > 3 || seen.has(`${result.partition}:${result.cohort}`)) {
      invalid.push('baseline cohort identity is missing or duplicated')
      continue
    }
    seen.add(`${result.partition}:${result.cohort}`)
    try { assertLoadUserEvidence(result, { episodeId: config.mode === 'soak' ? admission?.barrierId : result.episodeId }) }
    catch (error) { invalid.push(`load Worker evidence invalid: ${error.message}`) }
    if (config.mode === 'soak' && result.episodeId !== admission?.barrierId) {
      invalid.push('load result did not measure this episode')
    }
    if (config.mode === 'soak') {
      const expected = `${admission?.barrierId}:r3`
      // A producer and its convergence predicate could share the same stale
      // marker bug. Compare raw values against the parent's independent UUID.
      const wrongHot = result.hotValues?.some((value, index) => value !== `u${index}-${expected}`)
      const wrongOwn = result.localOwnFieldsAfterEdit?.some(entry => entry.values?.some(value => value !== expected))
      if ((wrongHot || wrongOwn) && result.fullyConverged === true) invalid.push('converged raw values do not carry the current episode marker')
      const writes = result.writesCompleted
      if (!Array.isArray(writes) || writes.some(entry => !Number.isInteger(entry.user) || entry.user < 0 || entry.user > 9
        || !Number.isInteger(entry.round) || entry.round < 0 || entry.round > 3
        || !Number.isSafeInteger(entry.completedAt) || entry.completedAt < result.editStartedAt || entry.completedAt > result.editCompletedAt)
        || new Set(writes?.map(entry => `${entry.user}:${entry.round}`)).size !== writes?.length
        || (result.fullyConverged === true && writes.length !== (result.cohort === 0 ? 40 : 0))) {
        invalid.push('actual write timeline is incomplete or malformed')
      }
      if (Array.isArray(writes) && (writes.length
        ? result.lastWriteCompletedAt !== Math.max(...writes.map(entry => entry.completedAt))
        : result.lastWriteCompletedAt !== null)) {
        invalid.push('last actual write does not match the write timeline')
      }
    }
    const expectedWriters = result.cohort === 0 ? 10 : 0
    if (result.test !== 'load-users' || result.users !== 25 || result.userOffset !== result.cohort * 25
      || result.totalUsers !== 100 || result.writers !== 10 || result.cohortWriters !== expectedWriters
      || result.objectAssignment !== 'per-writer' || result.objectsTested !== 10 || result.rounds !== 4
      || result.clientsTotal !== 25 || !validCount(result.clientsConverged) || result.clientsConverged > 25
      || typeof result.fullyConverged !== 'boolean'
      || !['missingFields', 'staleFields', 'hotDiverged'].every((field) => validCount(result[field]))
      || !Array.isArray(result.hotValues) || result.hotValues.length !== 10
      || !Array.isArray(result.localOwnFieldsAfterEdit) || result.localOwnFieldsAfterEdit.length !== expectedWriters
      || result.localOwnFieldsAfterEdit.some((entry, index) => entry?.user !== index
        || !Array.isArray(entry.values) || entry.values.length !== 1)
      || ![0, 1].includes(result.childProcess?.exitCode) || result.childProcess?.signal !== null) {
      invalid.push(`baseline partition ${result.partition} cohort ${result.cohort} load shape or natural process status is invalid`)
    }
    // The parent nonce proves admission happened before the child received the
    // release. releasedAt and editStartedAt share the child's clock; comparing
    // releasedAt with the parent's Date.now() can produce a spurious 1 ms
    // inversion. Both process timestamps remain diagnostic facts.
    if (result.baselineBarrier?.barrierId !== admission?.barrierId
      || !uuid.test(result.baselineBarrier?.releaseNonce)
      || result.baselineBarrier.releaseNonce !== admission?.releaseNonce
      || !Number.isSafeInteger(result.baselineBarrier?.releasedAt)
      || result.baselineBarrier.releasedAt <= 0
      || result.editStartedAt < result.baselineBarrier?.releasedAt) {
      invalid.push(`baseline partition ${result.partition} cohort ${result.cohort} did not acknowledge this barrier release before editing`)
    }
    if (![result.editStartedAt, result.editCompletedAt, result.convergedAt].every((value) => Number.isSafeInteger(value) && value > 0)
      || result.editCompletedAt < result.editStartedAt || result.convergedAt < result.editCompletedAt) {
      invalid.push(`baseline partition ${result.partition} cohort ${result.cohort} timestamps are invalid`)
    }
    if (expectedWriters > 0
      ? !Number.isSafeInteger(result.lastWriteCompletedAt) || result.lastWriteCompletedAt < result.editStartedAt
        || result.lastWriteCompletedAt > result.editCompletedAt
      : result.lastWriteCompletedAt !== null) {
      invalid.push(`baseline partition ${result.partition} cohort ${result.cohort} last actual write timestamp is invalid`)
    }
    if (result.fullyConverged !== true || result.clientsConverged !== 25
      || result.missingFields !== 0 || result.staleFields !== 0 || result.hotDiverged !== 0
      || countRejectedClientEdits(result.localOwnFieldsAfterEdit) !== 0) {
      failures.push('baseline fleet clients did not preserve and converge all expected edits')
    }
    if (result.childProcess?.exitCode === 1 && result.fullyConverged === true
      && result.missingFields === 0 && result.staleFields === 0 && result.hotDiverged === 0) {
      invalid.push('baseline client exited 1 without a measured convergence failure')
    }
  }
  if (seen.size !== 8) invalid.push('baseline fleet cohort coverage is incomplete')
  if (phase === 'failover' && !(Array.isArray(raw) && raw.some(row => row?.partition === 0
    && row.writesCompleted?.some(write => write.completedAt >= takeover?.startedAt && write.completedAt <= takeover?.completedAt)))) {
    invalid.push('no actual partition-zero write overlaps the acknowledged pause and takeover interval')
  }
  if (evidence.baselineError && Array.isArray(raw) && raw.every((entry) => entry?.childProcess?.exitCode === 0)) {
    invalid.push('baseline error has no corresponding natural client failure')
  }
  for (const partition of [0, 1]) {
    const values = (Array.isArray(raw) ? raw : []).filter((entry) => entry?.partition === partition)
    const writers = values.filter((entry) => entry.cohortWriters > 0)
    if (!values.length || !writers.length) continue
    const editCompletedAt = Math.max(...writers.map((entry) => entry.lastWriteCompletedAt))
    const convergedAt = Math.max(...values.map((entry) => entry.convergedAt))
    const convergenceMs = convergedAt - editCompletedAt
    if (!Number.isFinite(convergenceMs) || convergenceMs < 0) {
      invalid.push(`baseline partition ${partition} convergence duration is invalid`)
    } else partitions.push({ partition, editCompletedAt, convergedAt, convergenceMs })
  }
  if (partitions.length !== 2) invalid.push('baseline convergence requires both partition samples')
  const p99Ms = partitions.length === 2 ? percentile(partitions.map((entry) => entry.convergenceMs), 0.99) : null
  if (p99Ms !== null && p99Ms >= 3_000) failures.push('baseline convergence p99 must be strictly below 3000 ms')
  if (Array.isArray(raw) && !cohortHotValuesConverged(raw.filter(Boolean))) failures.push('baseline cohorts disagree on final values')
  const complete = invalid.length === 0
  return {
    schemaVersion: 1, runId: config.runId ?? null, project: config.project ?? null, phase,
    invalid: [...new Set(invalid)], failures: [...new Set(failures)],
    posture: config.benchPosture, status: complete ? failures.length ? 'RED' : 'PASS' : 'VOID',
    reasons: [...new Set([...invalid, ...failures])],
    criteria: {
      partitionLossCountZero: complete ? !lossObserved : null,
      convergenceP99Below3000: complete ? p99Ms < 3_000 : null,
    },
    baselineOwnership: evidence.baselineOwnership ?? null,
    topologyBuild: config.topologyBuild ?? null,
    baselineAdmission: admission ?? null,
    baselineResults: raw ?? null,
    baselineError: evidence.baselineError ?? null,
    convergence: { p99Ms, partitions, sampleCount: partitions.length },
  }
}

export async function runPostureBaseline(config, { before, load, collectAfter, collectAdmission = () => null, publish }) {
  let baselineResults = []
  let baselineError = null
  try { baselineResults = await load() } catch (error) {
    baselineResults = error.baselineResults ?? []
    baselineError = error instanceof Error ? error.message : String(error)
  }
  let after = null
  try { after = await collectAfter() } catch (error) {
    baselineError = [baselineError, error instanceof Error ? error.message : String(error)].filter(Boolean).join('; ')
  }
  const record = evaluatePostureBaseline({ baselineOwnership: { before, after }, baselineResults,
    baselineAdmission: collectAdmission(), baselineError }, config)
  publish(record)
  if (record.status !== 'PASS') {
    const error = new Error(`T-POST baseline ${record.status}: ${record.reasons.join('; ')}`)
    error.baseline = record
    throw error
  }
  return record
}

export function evaluateLoadSoakEvidence(evidence, config) {
  const baseline = config.benchPosture ? evaluatePostureBaseline({
    ...evidence, baselineResults: evidence.baselineRawResults ?? evidence.baselineResults,
  }, config) : null
  if (baseline && baseline.status !== 'PASS') {
    throw new Error(`T-POST baseline ${baseline.status}: ${baseline.reasons.join('; ')}`)
  }
  const failures = []
  const normal = [...evidence.baselineResults, ...evidence.soakResults]
  const failover = evidence.failoverResults
  const processesPerCycle = 2 * Math.ceil(config.usersPerWorkspace / config.clientsPerProcess)
  const normalCycles = [evidence.baselineResults]
  for (let offset = 0; offset < evidence.soakResults.length; offset += processesPerCycle) {
    normalCycles.push(evidence.soakResults.slice(offset, offset + processesPerCycle))
  }
  const normalCycleConvergence = normalCycles.flatMap(summarizeCycleConvergence)
  const failoverCycleConvergence = summarizeCycleConvergence(failover)
  const normalConvergence = normalCycleConvergence.map((result) => result.convergenceMs)
  const failoverConvergence = failoverCycleConvergence.map((result) => result.convergenceMs)
  for (const result of normal) {
    if (!result.fullyConverged || result.missingFields || result.staleFields || result.hotDiverged) failures.push('a normal-load workspace diverged')
  }
  for (const result of failover) {
    if (!result.fullyConverged || result.missingFields || result.staleFields || result.hotDiverged) failures.push('a failover workspace diverged')
  }
  if (normalCycleConvergence.some((result) => result.convergenceMs > config.normalConvergenceBudgetMs)) {
    failures.push('normal-load convergence exceeded budget')
  }
  if (failoverCycleConvergence.some((result) => result.convergenceMs > config.failoverConvergenceBudgetMs)) {
    failures.push('failover convergence exceeded budget')
  }
  if (!cohortHotValuesConverged(evidence.baselineResults)) {
    failures.push('normal-load cohorts disagree on contended values')
  }
  for (let offset = 0; offset < evidence.soakResults.length; offset += processesPerCycle) {
    if (!cohortHotValuesConverged(evidence.soakResults.slice(offset, offset + processesPerCycle))) {
      failures.push('normal-load cohorts disagree on contended values')
    }
  }
  if (!cohortHotValuesConverged(failover)) failures.push('failover cohorts disagree on contended values')
  if (!evidence.takeover?.verified || evidence.takeover.replacementService === evidence.takeover.originalService) {
    failures.push('spare-cell takeover was not verified')
  } else if (evidence.takeover.takeoverMs > config.takeoverBudgetMs) {
    failures.push('spare-cell takeover exceeded budget')
  }
  const owners = evidence.finalOwnership.filter((state) => state?.ready && (state.partitionIndex === 0 || state.partitionIndex === 1))
  if (owners.length !== 2 || new Set(owners.map((state) => state.partitionIndex)).size !== 2) {
    failures.push('final topology does not have exactly one ready owner per partition')
  }
  if (evidence.metrics.maxForeignResidentProjectors > 0) failures.push('a cell retained a foreign projector')
  if (evidence.metrics.retiredDocumentLimitExceeded === true) {
    failures.push('retired-document tombstones exceeded the configured operational limit')
  }
  if (evidence.metrics.backpressureDisconnectsDelta > 0) failures.push('backpressure disconnected a client')
  if (evidence.metrics.droppedBackpressureFramesDelta > 0) failures.push('backpressure dropped an outbound frame')
  if (evidence.metrics.unexpectedStorageFenceRejections > 0) {
    failures.push('storage fencing rejected a mutation outside the intentionally paused stale owner')
  }
  if (evidence.metrics.expectedStaleFenceRejections > config.maxExpectedStaleFenceRejections) {
    failures.push('stale-owner storage rejections exceeded the bounded failover allowance')
  }
  if (Number(evidence.metrics.unexpectedStaleFenceKinds ?? 0) > 0) {
    failures.push('stale-owner fencing rejected an unexpected storage mutation kind')
  }
  if (Number(evidence.metrics.repeatedStaleFenceRejections ?? 0) > 0) {
    failures.push('stale-owner fencing repeatedly rejected the same storage mutation')
  }
  if (Number(evidence.metrics.unexpectedCoalescedStaleFenceRejections ?? 0) > 0) {
    failures.push('a non-paused cell coalesced a stale-fence storage mutation')
  }
  if (
    Number(evidence.metrics.expectedCoalescedStaleFenceRejections ?? 0)
    > config.maxExpectedCoalescedStaleFenceRejections
  ) {
    failures.push('stale-owner exact-mutation coalescing exceeded the bounded failover allowance')
  }
  if (
    Number(evidence.metrics.expectedCoalescedStaleFenceRejections ?? 0) > 0
    &&
    Number(evidence.metrics.maxCoalescedStaleFenceRejectionsPerMutation ?? 0)
    > config.maxCoalescedStaleFenceRejectionsPerMutation
  ) {
    failures.push('one stale-owner mutation exceeded the per-mutation coalescing allowance')
  }
  if (Number(evidence.metrics.staleFenceCoalescingEvictions ?? 0) > 0) {
    failures.push('stale-owner exact-mutation coalescing cache evicted an entry')
  }
  if (evidence.metrics.maxEventLoopP99Ms > config.maxEventLoopP99Ms) failures.push('event-loop p99 exceeded budget')
  if (evidence.metrics.maxSynchronizerPeerBindings > config.maxSynchronizerPeerBindings) {
    failures.push('selective-sync peer bindings exceeded budget')
  }
  if (evidence.metrics.unexpectedSampleFailures > 0) failures.push('a non-injected cell diagnostics sample failed')
  const convergence = {
    normalP95Ms: percentile(normalConvergence, 0.95),
    normalP99Ms: percentile(normalConvergence, 0.99),
    failoverP95Ms: percentile(failoverConvergence, 0.95),
    failoverP99Ms: percentile(failoverConvergence, 0.99),
  }
  // THE LOST-EDIT TOTALS, computed ONCE and used on BOTH exits.
  //
  // The divergence loop above THROWS on any non-zero, so on the pass path
  // these are necessarily zero and a literal `0` would be indistinguishable
  // from a sum. Putting the same values in the FAILURE payload gives them a
  // non-zero case a test can pin — and the failure is when somebody wants the
  // number.
  const lostEdits = {
    rejectedClientEdits: sumRejectedClientEdits([...normal, ...failover]),
    missingFields: sumOverResults([...normal, ...failover], 'missingFields'),
    staleFields: sumOverResults([...normal, ...failover], 'staleFields'),
    hotDiverged: sumOverResults([...normal, ...failover], 'hotDiverged'),
  }
  if (failures.length > 0) {
    throw new Error(
      `multi-cell load/soak gate failed: ${[...new Set(failures)].join('; ')}; evidence=${JSON.stringify({
        convergence,
        normalCycleConvergence,
        failoverCycleConvergence,
        lostEdits,
        normalResults: normal,
        failoverResults: failover,
        takeover: evidence.takeover,
        metrics: evidence.metrics,
      })}`,
    )
  }

  return {
    outcome: 'passed',
    ...(baseline ? { baseline } : {}),
    mode: config.mode,
    // The profile the numbers below were taken under. A pass that
    // did not say whether 100 users were 100 writers or 10 would be read as
    // the stronger claim.
    profile: config.profile,
    writersPerWorkspace: config.writersPerWorkspace,
    objectAssignment: config.objectAssignment,
    capacityCertified: false,
    cells: 3,
    partitions: 2,
    hotWorkspaces: 2,
    usersPerWorkspace: config.usersPerWorkspace,
    peakActiveConnections: evidence.metrics.peakActiveConnections,
    normalConvergenceP95Ms: convergence.normalP95Ms,
    normalConvergenceP99Ms: convergence.normalP99Ms,
    failoverConvergenceP95Ms: convergence.failoverP95Ms,
    failoverConvergenceP99Ms: convergence.failoverP99Ms,
    takeoverMs: evidence.takeover.takeoverMs,
    soakMs: evidence.soakMs,
    clientProcesses: 2 * Math.ceil(config.usersPerWorkspace / config.clientsPerProcess),
    soakCycles: evidence.soakResults.length / (2 * Math.ceil(config.usersPerWorkspace / config.clientsPerProcess)),
    maxEventLoopP99Ms: evidence.metrics.maxEventLoopP99Ms,
    // Per cell, because the owner of the loaded partition is the number that
    // matters and the maximum alone does not say which cell it was.
    maxEventLoopP99MsByService: evidence.metrics.maxEventLoopP99MsByService,
    maxSynchronizerPeerBindings: evidence.metrics.maxSynchronizerPeerBindings,
    maxPeersPerDocument: evidence.metrics.maxPeersPerDocument,
    maxRssBytes: evidence.metrics.maxRssBytes,
    maxStaleFenceCoalescingCacheSize:
      evidence.metrics.maxStaleFenceCoalescingCacheSize,
    backpressureDisconnectsDelta: 0,
    droppedBackpressureFramesDelta: 0,
    // MEASURED, not a literal: the certificate's
    // `load.rejectedClientEdits !== 0` check must be able to fire.
    // THE SAME FOUR NUMBERS the failure payload above carries, so the pass and
    // the failure cannot drift apart into two answers about one run. On this
    // path the three divergence totals are necessarily zero — the loop above
    // throws otherwise — and they are published anyway because an ABSENT field
    // and a measured zero are different facts, and `certify-provider-capacity.mjs`
    // reads fields by name.
    ...lostEdits,
    expectedStaleFenceRejections: evidence.metrics.expectedStaleFenceRejections,
    unexpectedStaleFenceKinds: 0,
    repeatedStaleFenceRejections: 0,
    expectedCoalescedStaleFenceRejections:
      evidence.metrics.expectedCoalescedStaleFenceRejections,
    unexpectedCoalescedStaleFenceRejections: 0,
    staleFenceCoalescingEvictions: 0,
    maxCoalescedStaleFenceRejectionsPerMutation:
      evidence.metrics.maxCoalescedStaleFenceRejectionsPerMutation,
    unexpectedStorageFenceRejections: 0,
    maxForeignResidentProjectors: 0,
    maxRetiredDocuments: Number(evidence.metrics.maxRetiredDocuments ?? 0),
    retiredDocumentLimitExceeded: false,
    note: 'Capacity remains uncertified until the same tier passes on production-shaped infrastructure with provider CPU and memory evidence.',
  }
}

async function runLocalRehearsal(config, allCells, selections, targets, cookie) {
  const seed = await seedRehearsalWorkspace(config, selections.get(0), targets.get(0), cookie, config.seedObjectCount)
  const initial = await Promise.all(allCells.map(cell => cellSnapshot(cell, cookie)))
  const accumulator = new MetricsAccumulator(initial)
  const observations = new RehearsalObservations({ initialSnapshots: initial,
    publish: event => console.log(`G47_EVENT ${JSON.stringify(event)}`) })
  const sampler = new RehearsalSampler(allCells, cell => cellSnapshot(cell, cookie))
  let takeover = null
  let freshness = null
  const calibration = config.calibration
  let phase = 'baseline'
  let cycle = 0
  let actualSoakMs = 0
  const takeoverPreflights = []
  const observe = (snapshots, context = {}) => observations.sample(snapshots, { phase, cycle, ...context })
  const runEpisode = async (nextPhase, nextCycle, inject = null) => {
    phase = nextPhase
    cycle = nextCycle
    setPhase(`G4-7 ${phase} ${cycle}`)
    const before = await collectBaselineOwnership(allCells, cookie)
    let admission = null
    let raw = []
    let errorMessage = null
    try {
      raw = await runLoadPair(config, selections, targets, cookie, accumulator, {
        phase, startDelay: phase === 'failover' ? config.failureArmMs : 1_000,
        unavailableService: () => sampler.unavailableService,
        collectSample: consume => sampler.collect(consume),
        onResult: row => observations.received(row, nextPhase, nextCycle),
        onBaselineAdmission: value => { admission = value }, onSample: observe, inject,
      })
    } catch (error) {
      raw = error.baselineResults ?? []
      errorMessage = error.message
    }
    const after = await collectBaselineOwnership(allCells, cookie)
    const record = evaluatePostureEpisode({ baselineOwnership: { before, after }, baselineResults: raw,
      baselineAdmission: admission, baselineError: errorMessage }, config, phase, takeover)
    observations.episode(record, phase, cycle)
    if (record.status === 'VOID' || observations.invalid.length) throw new Error(`G4-7 ${phase} instrument is VOID`)
    return record
  }
  const takePartition = async (selectedSeed, countInLoad) => {
    const before = await Promise.all(allCells.map(cell => cellSnapshot(cell, cookie, false)))
    const owner = before.findIndex(row => row.ownership?.ready && row.ownership?.partitionReady && row.ownership.partitionIndex === 0)
    const spare = before.findIndex(row => row.ownership?.ready === false && row.ownership.partitionIndex === null)
    const preflight = { phase, cycle, countInLoad, workspace: selectedSeed.workspace, owner, spare, cells: before }
    takeoverPreflights.push(preflight)
    observations.emit('takeover-preflight', preflight)
    if (owner < 0 || spare < 0 || before[spare].fleet?.residentProjectors !== 0 || before[spare].fleet?.inFlightWorkspaces !== 0) {
      throw new Error('takeover requires a ready owner and a reserve with no projector or build in flight')
    }
    const original = allCells[owner]
    if (countInLoad) {
      await sampler.hold(original.service)
      accumulator.excludeEventLoopService(original.service)
    }
    const measured = await measureTakeover({
      originalService: original.service,
      pause: () => composeAsync(config, 'pause', original.service),
      replacement: () => waitFor('reserve ready on partition zero', async () => {
        const state = await json(`${allCells[spare].baseUrl}/api/platform/sync-cell`, { cookie })
        return state.ready && state.partitionReady && state.partitionIndex === 0
          ? { ...allCells[spare], state } : null
      }, 30_000),
      unpause: async () => {
        try { await composeAsync(config, 'unpause', original.service) } catch (error) {
          if (!isAlreadyUnpausedError(error)) throw error
        }
      },
      onReady: value => {
        if (countInLoad) {
          takeover = value
          observations.emit('takeover', { phase, cycle, ...value })
          if (value.takeoverMs >= 2_000) observations.fail('takeover', value.takeoverMs, { phase, cycle, ceilingExclusiveMs: 2_000 })
        }
      },
      onUnpaused: async () => {
        if (countInLoad) {
          const drained = await sampler.resume(original.service)
          accumulator.record([drained], null, true)
          observations.sample([drained], { phase, cycle, drainService: original.service,
            excludedEventLoopServices: [original.service] })
          observations.emit('event-loop-window-discarded', { phase, cycle, service: original.service,
            reason: 'single serialized consuming read after voluntary unpause', drained })
          accumulator.includeEventLoopService(original.service)
        }
      },
      fresh: (takeover, replacement) => readRehearsalFreshness(config, cookie, selectedSeed, takeover, replacement, before[spare]),
    })
    await waitFor('former owner standby', async () => {
      const state = await json(`${original.baseUrl}/api/platform/sync-cell`, { cookie })
      return state.ready === false && state.partitionIndex === null ? state : null
    }, 30_000)
    return measured
  }
  try {
    observations.emit('seed', seed)
    await runEpisode('baseline', 0)
    await runEpisode('failover', 0, async () => {
      const measured = await takePartition(seed, true)
      takeover = measured.takeover
      freshness = measured.freshness
      observations.emit('freshness', freshness)
    })
    if (!takeover) throw new Error('failover never ran after fleet admission')
    const soakStartedMono = performance.now()
    do {
      await runEpisode('soak', cycle + 1)
      actualSoakMs = performance.now() - soakStartedMono
      observations.emit('soak-progress', { actualSoakMs, cycles: cycle })
    } while (actualSoakMs < config.soakDurationMs && observations.firstFailure === null)
    const finalSnapshots = await Promise.all(allCells.map(cell => cellSnapshot(cell, cookie)))
    accumulator.record(finalSnapshots)
    observe(finalSnapshots)
    const metrics = accumulator.summarize(finalSnapshots, takeover.originalService)
    const episodes = observations.episodes
    const evidence = {
      baselineResults: episodes[0].record.baselineResults.map(convergedResult),
      failoverResults: episodes[1].record.baselineResults.map(convergedResult),
      soakResults: episodes.filter(entry => entry.phase === 'soak').flatMap(entry => entry.record.baselineResults.map(convergedResult)),
      takeover, soakMs: actualSoakMs, metrics, finalOwnership: finalSnapshots.map(row => row.ownership),
    }
    // The older evaluator retains its supplementary transport/fencing guards.
    // Cohort, posture, clocks and strict limits are qualified above.
    const extraFailures = []
    try { evaluateLoadSoakEvidence(evidence, { ...config, benchPosture: null }) } catch (error) { extraFailures.push(error.message) }
    observations.emit('calibration', calibration)
    const report = observations.finish({ actualSoakMs, freshness, calibration, extraFailures })
    return { ...report, posture: config.benchPosture, topologyBuild: config.topologyBuild, takeover, takeoverPreflights, metrics,
      note: 'A FAIL may stop after one complete soak cycle; durationCompleted alone confirms two hours. Local Docker Desktop, not provider capacity.' }
  } catch (error) {
    console.log(`G47_PARTIAL ${JSON.stringify({ status: 'VOID', reason: error.message, actualSoakMs,
      firstFailure: observations.firstFailure, invalid: observations.invalid, episodes: observations.episodes,
      maxEventLoopP99MsByService: observations.maxEventLoopP99MsByService, takeover, takeoverPreflights, freshness, calibration })}`)
    throw error
  }
}

async function run(config) {
  config = {
    ...config,
    runId: `qa-${Date.now().toString(36)}-${process.pid}`,
  }
  const allCells = cells(config)
  setPhase('waiting for three sync-cell HTTP processes')
  await waitFor('three sync-cell HTTP processes', async () => {
    const health = await Promise.all(allCells.map((cell) => request(`${cell.baseUrl}/api/health`).catch(() => null)))
    return health.every((entry) => entry?.status === 200)
  }, 120_000)
  setPhase('dev login')
  const session = await login(config, allCells[0])
  setPhase('waiting for two owners and one spare cell')
  const initialStates = await waitFor('two owners and one spare cell', async () => {
    const states = await Promise.all(allCells.map((cell) => json(`${cell.baseUrl}/api/platform/sync-cell`, { cookie: session.cookie })))
    const owners = states.filter((state) => state.ready && (state.partitionIndex === 0 || state.partitionIndex === 1))
    const standby = states.filter((state) => !state.ready && state.partitionIndex === null)
    return owners.length === 2 && standby.length === 1 && new Set(owners.map((state) => state.partitionIndex)).size === 2
      ? states
      : null
  }, 120_000)
  if (config.benchPosture) revalidateLoadTopology(config)
  const createdLandscapeIds = []
  let selections = null
  let targets = new Map()
  let primaryError = null
  try {
  setPhase('selecting one hot workspace per partition')
  selections = await selectPartitionWorkspaces(
    config,
    allCells,
    initialStates,
    session.cookie,
    createdLandscapeIds,
  )
  for (const partition of [0, 1]) {
    setPhase(`resolving the load target of partition ${partition}`)
    targets.set(partition, await resolveLoadTarget(config, selections.get(partition), session.cookie))
  }

  if (config.benchPosture && config.mode === 'soak') {
    return await runLocalRehearsal(config, allCells, selections, targets, session.cookie)
  }

  setPhase('baseline diagnostics snapshot')
  const baselineSnapshots = await Promise.all(allCells.map((cell) => cellSnapshot(cell, session.cookie)))
  if (baselineSnapshots.some((snapshot) => !snapshot.stats || !snapshot.fleet || !snapshot.ownership)) {
    throw new Error('all cell diagnostics must be available before load')
  }
  const accumulator = new MetricsAccumulator(baselineSnapshots)

  const baselineBefore = config.benchPosture
    ? await collectBaselineOwnership(allCells, session.cookie)
    : null
  let baselineRecord = null
  let baselineAdmission = null
  setPhase('baseline load')
  const loadBaseline = () => runLoadPair(config, selections, targets, session.cookie, accumulator, {
    phase: 'baseline',
    startDelay: 1_000,
    onBaselineAdmission: (admission) => { baselineAdmission = admission },
  })
  const baselineRaw = config.benchPosture
    ? (baselineRecord = await runPostureBaseline(config, {
      before: baselineBefore,
      load: loadBaseline,
      collectAfter: () => collectBaselineOwnership(allCells, session.cookie),
      collectAdmission: () => baselineAdmission,
      publish: (record) => console.log(`TPOST_BASELINE ${JSON.stringify(record)}`),
    })).baselineResults
    : await loadBaseline()
  if (config.segmentedWorkspaces) {
    setPhase('rotating the write heads after baseline')
    targets = await refreshRotatedLoadTargets(
      selections,
      targets,
      (selection, previous) => resolveLoadTarget(config, selection, session.cookie, previous),
    )
  }

  const failurePartition = 0
  const originalOwnerIndex = baselineRecord
    ? allCells.findIndex((cell) => baselineRecord.baselineOwnership.after.some((entry) => (
      entry.service === cell.service && entry.ownership.ready && entry.ownership.partitionIndex === failurePartition
    )))
    : selections.get(failurePartition).ownerIndex
  const originalOwner = allCells[originalOwnerIndex]
  let expectedUnavailableService = null
  let takeover = null
  setPhase('failover load, before the owner is paused')
  const failoverRaw = await runLoadPair(config, selections, targets, session.cookie, accumulator, {
    phase: 'failover',
    startDelay: config.failureArmMs,
    unavailableService: () => expectedUnavailableService,
    inject: async () => {
      expectedUnavailableService = originalOwner.service
      // monitorEventLoopDelay observes the deliberate docker pause as a giant
      // application stall. Keep all correctness/fencing checks for this cell,
      // but exclude that synthetic timing sample from the latency SLO.
      accumulator.excludeEventLoopService(originalOwner.service)
      setPhase(`failover: ${originalOwner.service} paused, waiting for the spare cell to take partition ${failurePartition}`)
      compose(config, 'pause', originalOwner.service)
      const startedAt = Date.now()
      let replacement
      try {
        replacement = await waitFor('spare-cell partition takeover under load', async () => {
          const snapshots = await Promise.all(allCells.map((cell) => (
            cell.service === originalOwner.service
              ? Promise.resolve(null)
              : json(`${cell.baseUrl}/api/platform/sync-cell`, { cookie: session.cookie }).catch(() => null)
          )))
          const index = snapshots.findIndex((state) => state?.ready && state.partitionIndex === failurePartition)
          return index >= 0 ? { index, state: snapshots[index] } : null
        }, 30_000)
      } finally {
        unpauseCell(config, originalOwner.service)
        expectedUnavailableService = null
      }
      takeover = {
        verified: true,
        originalService: originalOwner.service,
        replacementService: allCells[replacement.index].service,
        takeoverMs: Date.now() - startedAt,
        startedAt,
        completedAt: Date.now(),
      }
      setPhase(`failover: waiting for ${originalOwner.service} to return as standby`)
      await waitFor('former owner to return as standby', async () => {
        const state = await json(`${originalOwner.baseUrl}/api/platform/sync-cell`, { cookie: session.cookie })
        return state.partitionIndex === null && state.ready === false ? state : null
      }, 30_000)
      setPhase('failover load, after the takeover')
    },
  })
  if (!takeover) throw new Error('load never reached the connection threshold required for failure injection')

  const soakStartedAt = Date.now()
  const soakRaw = []
  let soakCycle = 0
  do {
    soakCycle += 1
    if (config.segmentedWorkspaces) {
      setPhase(`soak cycle ${soakCycle}: rotating the write heads`)
      targets = await refreshRotatedLoadTargets(
        selections,
        targets,
        (selection, previous) => resolveLoadTarget(config, selection, session.cookie, previous),
      )
    }
    setPhase(`soak cycle ${soakCycle}`)
    soakRaw.push(...await runLoadPair(config, selections, targets, session.cookie, accumulator, {
      phase: 'soak',
      startDelay: 1_000,
    }))
  } while (config.soakDurationMs > 0 && Date.now() - soakStartedAt < config.soakDurationMs)
  const soakMs = Date.now() - soakStartedAt

  setPhase('final diagnostics snapshot')
  const finalSnapshots = await Promise.all(allCells.map((cell) => cellSnapshot(cell, session.cookie)))
  accumulator.record(finalSnapshots)
  const metrics = accumulator.summarize(finalSnapshots, takeover.originalService)
  const evidence = {
    baselineResults: baselineRaw.map(convergedResult),
    ...(baselineRecord ? {
      baselineRawResults: baselineRaw,
      baselineOwnership: baselineRecord.baselineOwnership,
      baselineAdmission: baselineRecord.baselineAdmission,
    } : {}),
    failoverResults: failoverRaw.map(convergedResult),
    soakResults: soakRaw.map(convergedResult),
    takeover,
    soakMs,
    metrics,
    finalOwnership: finalSnapshots.map((snapshot) => snapshot.ownership),
  }
  setPhase('evaluating the evidence')
  return evaluateLoadSoakEvidence(evidence, config)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    setPhase(`cleanup (after: ${currentPhase})`)
    await completeQualificationCleanup(
      async () => {
        await cleanupSegmentedQualificationObjects(config, selections, targets, session.cookie)
        await cleanupFreshLandscapes(config, allCells, session.cookie, createdLandscapeIds)
      },
      primaryError,
    )
  }
}

/** A killed or abandoned verifier must not leave the dedicated local owner
 *  frozen. Synchronous on purpose: it also runs from `beforeExit`. */
function unpauseAnyPausedCell(config) {
  let paused = []
  try {
    const state = compose(config, 'ps', '--status', 'paused', '--services')
    const services = new Set(cells(config).map((cell) => cell.service))
    paused = state.split(/\r?\n/).map((line) => line.trim()).filter((service) => services.has(service))
  } catch { /* best effort */ }
  for (const service of paused) {
    try { unpauseCell(config, service) } catch { /* best effort */ }
  }
  return paused
}

/**
 * What the verdict guard does with a run that will never settle: the
 * three things `main()`'s `catch`/`finally` would have done, none of which run
 * when `run()` is hung or the loop has drained.
 */
export function abandonRun(config) {
  terminateActiveLoadProcesses()
  unpauseAnyPausedCell(config)
  activeRunLock?.release()
  activeRunLock = null
}

/** The run, WITHOUT printing or exit codes: those belong to the verdict guard,
 *  so that there is exactly one place a process exit is decided. Returns the
 *  verdict object; rejects with the run's error. */
export async function main(config) {
  if (config.benchPosture && config.mode === 'soak'
    && !(config.calibrationBinding?.path && config.calibrationBinding.sha256 && config.calibrationBinding.nonce)) {
    throw new Error('G4 soak requires this invocation\'s dedicated calibration receipt')
  }
  // Always replace any supplied record: CLI/env/snapshots cannot nominate their
  // own expected build. A setup refusal happens before login, writes or pause.
  if (config.benchPosture) config = { ...config, topologyBuild: resolveLoadTopology(config) }
  if (config.benchPosture && config.mode === 'soak') {
    config = { ...config, calibration: readCalibrationReceipt(config.calibrationBinding, {
      project: config.project, image: config.topologyBuild.running[0].image,
      posture: config.benchPosture, topologyBuild: config.topologyBuild,
    }) }
  }
  const runLock = acquireQualificationRunLock(config.project)
  activeRunLock = runLock
  try {
    return await run(config)
  } catch (error) {
    unpauseAnyPausedCell(config)
    throw error
  } finally {
    terminateActiveLoadProcesses()
    runLock.release()
    if (activeRunLock === runLock) activeRunLock = null
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config = null
  try {
    config = parseLoadSoakConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const forwardSignal = () => {
      // The same hand-back as an abandoned run: a cell paused by the failover
      // phase must not stay paused because the operator pressed Ctrl-C.
      if (config) abandonRun(config)
      else terminateActiveLoadProcesses(signal)
      process.removeListener(signal, forwardSignal)
      process.kill(process.pid, signal)
    }
    process.on(signal, forwardSignal)
  }
  if (config) {
    // Armed BEFORE `main()` starts, and the only thing that prints the verdict
    // or decides the exit code — see `createVerdictGuard`.
    const guard = createVerdictGuard({
      deadlineMs: config.runDeadlineMs,
      phase: currentGatePhase,
      onAbandon: () => abandonRun(config),
      log: console.log,
      error: console.error,
    })
    guard.arm()
    main(config).then((verdict) => guard.settle(verdict), (error) => guard.fail(error))
  }
}
