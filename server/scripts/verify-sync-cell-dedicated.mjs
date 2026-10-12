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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertDedicatedCensus, assertDedicatedTopology, assertDedicatedOwner,
  classifyDedicatedOwnership, parseDedicatedFsck, dedicatedPartitionIdentity } from './sync-cell-dedicated-contract.mjs'
import { summarizeDedicatedWindow, dedicatedWindowPercentiles } from './sync-cell-dedicated-window.mjs'

const knownCells = ['failover-cell-a', 'failover-cell-b', 'failover-cell-c']
const safeError = error => ({ name: error?.name ?? 'Error', code: error?.code ?? null,
  message: error?.publicMessage ?? (error?.name === 'AssertionError' ? error.message : 'Dedicated gate operation failed'),
  ...(error?.evidence ? { evidence: error.evidence } : {}),
  ...(error instanceof AggregateError ? { errors: error.errors.map(safeError) } : {}) })
const statesOf = sample => sample.readings.map(row => row.state)
const timingSample = sample => ({ readings: sample.readings.map(row => ({
  cellId: row.cellId, startedAtMs: row.startedAtMs, completedAtMs: row.completedAtMs,
  ownedWorkspaceCount: row.state.ownedWorkspaceCount,
})) })

export function dedicatedOptions(args, env) {
  const flags = new Map()
  const valued = new Set(['--landscape-id', '--version-id', '--generation', '--dedicated-out', '--dedicated-moves', '--dedicated-sample-ms'])
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--dedicated') continue
    assert.ok(valued.has(flag), 'Unsupported dedicated gate option: ' + flag)
    assert.ok(!flags.has(flag), 'Duplicate dedicated gate option: ' + flag)
    const value = args[++i]
    assert.ok(typeof value === 'string' && value.trim() && !value.startsWith('--'), flag + ' requires a value')
    flags.set(flag, value)
  }
  const required = flag => { assert.ok(flags.has(flag), flag + ' is required for the dedicated gate'); return flags.get(flag) }
  const integer = (value, min, max, label) => {
    assert.ok(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), label + ' must be an explicit integer')
    const number = Number(value)
    assert.ok(Number.isSafeInteger(number) && number >= min && number <= max, label + ' is outside its supported range')
    return number
  }
  const project = env.SYNC_FAILOVER_PROJECT
  assert.ok(typeof project === 'string' && /^maplespire-[a-z0-9][a-z0-9-]+$/.test(project)
    && project !== 'maplespire-demo' && project !== 'maplespire', 'An explicit isolated SYNC_FAILOVER_PROJECT is required')
  assert.ok(env.SYNC_FAILOVER_DATABASE_URL, 'Explicit SYNC_FAILOVER_DATABASE_URL is required; server/.env is not a target selector')
  const database = new URL(env.SYNC_FAILOVER_DATABASE_URL)
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && ['localhost', '127.0.0.1'].includes(database.hostname)
    && database.port && database.pathname.length > 1, 'Dedicated database must use an explicit loopback port and database name')
  const workspace = { landscapeId: required('--landscape-id'), versionId: required('--version-id') }
  assert.ok(Object.values(workspace).every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value)), 'Invalid explicit workspace identity')
  const cells = knownCells.map((cellId, i) => ({ cellId, service: 'sync-cell-' + 'abc'[i],
    port: integer(env['SYNC_FAILOVER_CELL_' + 'ABC'[i] + '_PORT'], 1024, 65535, cellId + ' port') }))
  const routerPort = integer(env.SYNC_FAILOVER_ROUTER_PORT, 1024, 65535, 'router port')
  assert.equal(new Set([...cells.map(cell => cell.port), routerPort, Number(database.port)]).size, 5, 'Bench ports must be distinct')
  assert.ok(typeof env.SYNC_FAILOVER_LOGIN_EMAIL === 'string' && /^[^\s@]+@maplespire\.local$/.test(env.SYNC_FAILOVER_LOGIN_EMAIL),
    'Explicit bench login email is required')
  return { project, out: resolve(required('--dedicated-out')), workspace, generation: required('--generation'),
    databaseUrl: env.SYNC_FAILOVER_DATABASE_URL, cells, routerPort, loginEmail: env.SYNC_FAILOVER_LOGIN_EMAIL,
    moves: integer(flags.get('--dedicated-moves') ?? '20', 20, 100, 'dedicated moves'),
    sampleMs: integer(flags.get('--dedicated-sample-ms') ?? '25', 10, 1000, 'sample interval'), moveTimeoutMs: 30000 }
}

/** The sampler belongs to this invocation. It is joined even if the SQL move
 * fails, and a sampling failure remains a failure after a successful COMMIT.
 */
export async function measureDedicatedMove(runtime, options, { from, to, sourceCellId, targetCellId, partitionBaseline }, record) {
  const topology = { generation: options.generation }
  assertDedicatedCensus(await runtime.census(), options.workspace)
  const initialPlacement = await runtime.placement()
  assert.equal(initialPlacement.partition, from, 'Placement is not at the expected source partition')
  assert.equal(initialPlacement.topology_generation, options.generation)
  Object.assign(record, { from, to, sourceCellId, targetCellId, initialPlacement, samples: [], complete: false })
  const observe = async () => {
    const sample = await runtime.readCells()
    record.samples.push(sample)
    assert.deepEqual(sample.readings.map(row => row.cellId).sort(), knownCells)
    for (const row of sample.readings) assert.equal(row.cellId, row.state.cellId, 'A cell endpoint changed identity')
    assert.deepEqual(dedicatedPartitionIdentity(statesOf(sample)), partitionBaseline, 'Warm partition identity changed during the campaign')
    try { sample.owner = classifyDedicatedOwnership(statesOf(sample), topology) }
    catch (error) {
      if (error.code !== 'DEDICATED_MULTIPLE_OWNERS') throw error
      sample.owner = 'mixed-http-responses'
    }
    return sample
  }
  for (let i = 0; i < 2; i++) {
    assertDedicatedOwner(statesOf(await observe()), topology, sourceCellId)
    if (i === 0) await delay(options.sampleMs)
  }
  let stop = false, sampleError = null, moveError = null, movement = null
  const started = runtime.now()
  const loop = (async () => {
    let consecutive = 0
    while (!stop) {
      assert.ok(runtime.now() - started <= options.moveTimeoutMs, 'Dedicated movement observation timed out')
      const sample = await observe()
      if (movement && sample.readings.every(row => row.startedAtMs >= movement.commit.completedAtMs)) {
        const states = statesOf(sample)
        const settled = states.every(state => state.ownedWorkspaceCount === (state.cellId === targetCellId ? 1 : 0)
          && state.expectedWorkspaceCount === (state.cellId === targetCellId ? 1 : 0))
          && states.some(state => state.cellId === targetCellId && state.ready && state.partitionReady)
        consecutive = settled ? consecutive + 1 : 0
        if (consecutive === 2) { assertDedicatedOwner(states, topology, targetCellId); return }
      }
      await delay(options.sampleMs)
    }
  })().catch(error => { sampleError = error })
  try {
    movement = await runtime.move(from, to)
    record.movement = movement
    await loop
  } catch (error) { moveError = error }
  finally { stop = true; await loop }
  if (moveError || sampleError) {
    record.failure = { move: moveError ? safeError(moveError) : null, sample: sampleError ? safeError(sampleError) : null }
    throw new AggregateError([moveError, sampleError].filter(Boolean), 'Dedicated move did not qualify')
  }
  assert.ok(movement, 'COMMIT receipt is missing')
  assertDedicatedCensus(await runtime.census(), options.workspace)
  record.finalPlacement = await runtime.placement()
  assert.equal(record.finalPlacement.partition, to)
  assert.equal(record.finalPlacement.topology_generation, options.generation)
  record.fence = await runtime.readFence()
  assert.equal(record.fence.cell_id, targetCellId)
  assert.equal(record.fence.released_at, null)
  assert.match(record.fence.token, /^[1-9][0-9]*$/)
  record.window = summarizeDedicatedWindow({ samples: record.samples.map(timingSample), commit: movement.commit,
    sourceCellId, targetCellId })
  record.complete = true
  return record
}

export async function runDedicatedGate(options, { createRuntime } = {}) {
  assert.equal(existsSync(options.out), false, 'Preserve previous dedicated gate evidence')
  mkdirSync(options.out, { recursive: true })
  const report = { schema: 'maplespire-dedicated-gate/v1', outcome: 'failed', scenario: 'dedicated',
    startedAt: new Date().toISOString(), workspace: options.workspace, project: options.project,
    generation: options.generation, outbound: [], returns: [], failure: null, resourcesClosed: false }
  let runtime, failure
  try {
    const factory = createRuntime ?? (await import('./sync-cell-dedicated-runtime.mjs')).createDedicatedRuntime
    runtime = await factory(options)
    report.identity = runtime.identity
    report.fixture = runtime.fixture
    assertDedicatedCensus(await runtime.census(), options.workspace)
    const initial = await runtime.readCells()
    const states = statesOf(initial)
    assertDedicatedTopology(states, { generation: options.generation })
    const pool = states.filter(state => state.partitionIndex === 0)
    assert.equal(pool.length, 1, 'Exactly one pool cell must hold partition 0')
    const source = pool[0].cellId
    assert.notEqual(source, 'failover-cell-c')
    assertDedicatedOwner(states, { generation: options.generation }, source)
    const reserved = states.find(state => state.cellId === 'failover-cell-c')
    assert.ok(reserved.partitionIndex === 1 && reserved.partitionReady, 'Reserved cell must be warm before the move')
    report.initial = initial
    const partitionBaseline = dedicatedPartitionIdentity(states)
    report.partitionBaseline = partitionBaseline
    report.initialFence = await runtime.readFence()
    assert.equal(report.initialFence.cell_id, source)
    assert.equal(report.initialFence.released_at, null, 'Initial workspace fence is already released')
    assert.match(report.initialFence.token, /^[1-9][0-9]*$/)
    let previousToken = BigInt(report.initialFence.token)
    report.admissionIdentity = await runtime.verifyIdentity()
    report.coldBefore = await runtime.readCold()
    for (let i = 0; i < options.moves; i++) {
      if (i > 0) {
        const returned = { index: i }
        report.returns.push(returned)
        await measureDedicatedMove(runtime, options, { from: 1, to: 0, sourceCellId: 'failover-cell-c', targetCellId: source, partitionBaseline }, returned)
        assert.ok(BigInt(returned.fence.token) > previousToken, 'Fencing token did not advance on return')
        previousToken = BigInt(returned.fence.token)
      }
      const outbound = { index: i }
      report.outbound.push(outbound)
      await measureDedicatedMove(runtime, options, { from: 0, to: 1, sourceCellId: source, targetCellId: 'failover-cell-c', partitionBaseline }, outbound)
      assert.ok(BigInt(outbound.fence.token) > previousToken, 'Fencing token did not advance on dedicated move')
      previousToken = BigInt(outbound.fence.token)
      outbound.cold = await runtime.readCold(report.coldBefore)
    }
    report.percentiles = dedicatedWindowPercentiles(report.outbound.map(move => move.window))
    report.coldAfter = await runtime.readCold(report.coldBefore)
    report.fsck = await runtime.fsck()
    assert.ok(report.fsck.native.closed === true && report.fsck.native.cleanupConfirmed === true
      && [0, 1].includes(report.fsck.native.code)
      && report.fsck.native.signal === null && !report.fsck.native.timedOut && !report.fsck.native.aborted
      && !report.fsck.native.spawnError && !report.fsck.native.captureError && !report.fsck.native.killError,
      'Fsck native process did not close normally')
    // An ordinary nonzero status may concern a different shared root. It is
    // retained verbatim, while the exact target report supplies this verdict.
    report.fsck.target = parseDedicatedFsck(report.fsck.stdout, options.workspace)
    assertDedicatedCensus(await runtime.census(), options.workspace)
    report.final = await runtime.readCells()
    assertDedicatedOwner(statesOf(report.final), { generation: options.generation }, 'failover-cell-c')
    assert.deepEqual(dedicatedPartitionIdentity(statesOf(report.final)), partitionBaseline, 'Warm partition identity changed at campaign end')
    report.finalIdentity = await runtime.verifyIdentity()
  } catch (error) { failure = error; report.failure = safeError(error) }
  finally {
    if (runtime) {
      try { report.cleanup = await runtime.close(); report.resourcesClosed = true }
      catch (error) { failure = new AggregateError([failure, error].filter(Boolean), 'Dedicated gate resource closure failed'); report.failure = safeError(failure) }
    }
    report.endedAt = new Date().toISOString()
    if (!failure && report.resourcesClosed) report.outcome = 'passed'
    writeFileSync(resolve(options.out, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  if (failure) throw failure
  assert.equal(report.outcome, 'passed')
  return { outcome: report.outcome, scenario: report.scenario, workspace: report.workspace,
    dedicatedCell: 'failover-cell-c', moves: report.outbound.length, percentiles: report.percentiles,
    fsck: report.fsck.target.reports[0].status, resourcesClosed: report.resourcesClosed,
    evidence: resolve(options.out, 'result.json') }
}
