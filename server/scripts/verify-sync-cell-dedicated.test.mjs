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
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { dedicatedOptions, runDedicatedGate } from './verify-sync-cell-dedicated.mjs'
import { createOrchestrationRuntime, fixtureCells } from './fixtures/dedicated-orchestration-runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, 'verify-sync-cell-failover.mjs')
const preload = pathToFileURL(join(here, 'fixtures/dedicated-orchestration-preload.mjs')).href
const workspace = { landscapeId: 'dedicated-land', versionId: 'dedicated-version' }
const cliEnvironment = {
  SYNC_FAILOVER_PROJECT: 'maplespire-dedicated-test',
  SYNC_FAILOVER_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:54321/fixture',
  SYNC_FAILOVER_CELL_A_PORT: '54322', SYNC_FAILOVER_CELL_B_PORT: '54323',
  SYNC_FAILOVER_CELL_C_PORT: '54324', SYNC_FAILOVER_ROUTER_PORT: '54325',
  SYNC_FAILOVER_LOGIN_EMAIL: 'fixture@maplespire.local',
}
const deferred = () => {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maplespire-dedicated-orchestration-'))
  t.after(() => {
    const absolute = resolve(directory)
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep))
    assert.ok(absolute.split(sep).at(-1).startsWith('maplespire-dedicated-orchestration-'))
    rmSync(absolute, { recursive: true, force: true })
  })
  const options = { out: join(directory, 'evidence'), workspace, project: 'maplespire-dedicated-test',
    generation: 'dedicated-test-generation', moves: 20, sampleMs: 1, moveTimeoutMs: 10000, ...overrides }
  const runtime = createOrchestrationRuntime(options)
  return { directory, options, runtime,
    run: () => runDedicatedGate(options, { createRuntime: async () => runtime }),
    report: () => JSON.parse(readFileSync(join(options.out, 'result.json'), 'utf8')) }
}
async function failedGate(f, expected) {
  await assert.rejects(f.run(), expected)
  const report = f.report()
  assert.equal(report.outcome, 'failed')
  assert.equal(report.resourcesClosed, true)
  assert.equal(f.runtime.trace.counts.close, 1)
  assert.ok(report.failure)
  return report
}
function replaceSample(runtime, change) {
  const original = runtime.readCells.bind(runtime)
  runtime.readCells = async () => {
    const sample = await original()
    change(sample, runtime.trace)
    return sample
  }
}

test('twenty qualified outbound moves include nineteen returns and retain every gate witness', async t => {
  const f = fixture(t)
  const verdict = await f.run()
  const report = f.report()
  assert.equal(verdict.outcome, 'passed')
  assert.equal(verdict.moves, 20)
  assert.equal(report.outbound.length, 20)
  assert.equal(report.returns.length, 19)
  assert.deepEqual(f.runtime.trace.moves.map(({ from, to }) => [from, to]),
    Array.from({ length: 39 }, (_, i) => i % 2 === 0 ? [0, 1] : [1, 0]))
  assert.equal(f.runtime.trace.counts.census, 80, 'Initial, both sides of every move, and final census')
  assert.equal(f.runtime.trace.counts.placement, 78)
  assert.equal(f.runtime.trace.counts.readFence, 40)
  assert.equal(f.runtime.trace.counts.readCold, 22)
  assert.equal(f.runtime.trace.counts.fsck, 1)
  assert.equal(f.runtime.trace.counts.verifyIdentity, 2)
  assert.equal(f.runtime.trace.counts.close, 1)
  assert.deepEqual(f.runtime.trace.events.slice(0, 5), ['census', 'readCells', 'readFence', 'verifyIdentity', 'readCold'])
  assert.deepEqual(f.runtime.trace.events.slice(-3), ['readCells', 'verifyIdentity', 'close'])
  assert.equal(f.runtime.trace.events.at(-1), 'close')
  assert.equal(f.runtime.trace.coldReferences[0], undefined)
  for (const reference of f.runtime.trace.coldReferences.slice(1)) assert.deepEqual(reference, report.coldBefore)
  assert.equal(report.percentiles.samples, 20)
  assert.equal(report.percentiles.d52BudgetMs, 3000)
  assert.equal(report.final.readings.find(row => row.cellId === 'failover-cell-c').state.ownedWorkspaceCount, 1)
  for (const move of [...report.outbound, ...report.returns]) {
    assert.equal(move.complete, true)
    assert.equal(move.finalPlacement.partition, move.to)
    assert.equal(move.finalPlacement.topology_generation, f.options.generation)
    assert.equal(move.fence.cell_id, move.targetCellId)
    assert.equal(move.fence.released_at, null)
    assert.ok(move.samples.length >= 5)
    assert.equal(move.window.roundsWithThreeZeroResponses, 1)
    assert.deepEqual(move.window.commit, move.movement.commit)
    assert.ok(move.window.commitToLocalOwnerMs.lowerMs >= 0)
    assert.ok(move.window.commitToLocalOwnerMs.upperMs >= move.window.commitToLocalOwnerMs.lowerMs)
    for (const sample of move.samples) {
      assert.deepEqual(sample.readings.map(row => row.cellId).sort(), fixtureCells)
      assert.ok(sample.readings.every(row => row.startedAtMs <= row.completedAtMs))
    }
  }
  assert.equal(report.initialFence.token, '1')
  assert.equal(report.outbound.at(-1).fence.token, '40')
  assert.deepEqual(report.fsck.native,
    { fixtureOnly: true, pid: 1234, closed: true, cleanupConfirmed: true, code: 0, signal: null, timedOut: false })
  assert.equal(verdict.fsck, 'clean')
  assert.equal(report.resourcesClosed, true)
  assert.deepEqual(report.cleanup, { closed: true, operationsJoined: 0, rejectedOperations: 0 })
  assert.deepEqual(report.finalIdentity, { unchanged: true, fixtureOnly: true, cells: fixtureCells })
  assert.deepEqual(report.admissionIdentity, report.finalIdentity)
  assert.deepEqual(report.partitionBaseline, fixtureCells.map((cellId, i) => ({
    cellId, bootObservedAt: ['2026-09-09T00:00:01.000Z', '2026-09-09T00:00:02.000Z', '2026-09-09T00:00:03.000Z'][i],
    partitionIndex: [0, null, 1][i], partitionReady: i !== 1,
    partitionAcquisitionCount: i === 1 ? 0 : 1, partitionLossCount: 0,
  })))
})

test('a successful gate stays pending and publishes no report while resource close is suspended', async t => {
  const f = fixture(t), entered = deferred(), release = deferred()
  f.runtime.close = async () => { entered.resolve(); await release.promise }
  let settled = false
  const running = f.run().finally(() => { settled = true })
  try {
    await entered.promise
    await nextTurn()
    await nextTurn()
    assert.equal(settled, false)
    assert.equal(existsSync(join(f.options.out, 'result.json')), false)
  } finally { release.resolve() }
  assert.equal((await running).outcome, 'passed')
  assert.equal(f.report().resourcesClosed, true)
})

for (const [label, at] of [['initial', 1], ['before the first move', 2], ['after COMMIT', 3], ['final', 80]]) {
  test('multiple workspaces in the ' + label + ' unfiltered census cannot pass', async t => {
    const f = fixture(t), census = f.runtime.census.bind(f.runtime)
    f.runtime.census = async () => {
      const rows = await census()
      if (f.runtime.trace.counts.census === at) rows.push({ landscape_id: 'other', id: 'other' })
      return rows
    }
    await failedGate(f, /census must contain exactly one workspace/)
    assert.equal(f.runtime.trace.counts.census, at)
  })
}

for (const kind of ['no source owner', 'two source owners', 'missing third cell', 'missing source count']) {
  test(kind + ' fails before any SQL move', async t => {
    const f = fixture(t)
    replaceSample(f.runtime, sample => {
      if (kind === 'no source owner') sample.readings[0].state.ownedWorkspaceCount = 0
      if (kind === 'two source owners') sample.readings[2].state.ownedWorkspaceCount = 1
      if (kind === 'missing third cell') sample.readings.pop()
      if (kind === 'missing source count') delete sample.readings[0].state.ownedWorkspaceCount
    })
    await failedGate(f)
    assert.equal(f.runtime.trace.moves.length, 0)
  })
}

test('persistent double ownership after COMMIT times out instead of choosing the first owner', async t => {
  const f = fixture(t, { moveTimeoutMs: 100 })
  replaceSample(f.runtime, (sample, trace) => {
    if (trace.moves.length) {
      sample.readings[0].state.ownedWorkspaceCount = 1
      sample.readings[2].state.ownedWorkspaceCount = 1
    }
  })
  const report = await failedGate(f, /move did not qualify/)
  assert.equal(report.outbound.length, 1)
  assert.equal(report.outbound[0].complete, false)
  assert.ok(report.outbound[0].samples.some(sample => sample.owner === 'mixed-http-responses'))
})

test('a destination missing the expected count cannot settle after COMMIT', async t => {
  const f = fixture(t)
  replaceSample(f.runtime, (sample, trace) => {
    if (trace.moves.length) delete sample.readings[1].state.expectedWorkspaceCount
  })
  const report = await failedGate(f, /move did not qualify/)
  assert.equal(report.outbound[0].complete, false)
  assert.equal(f.runtime.trace.counts.fsck, undefined)
})

const partitionChanges = [
  ['cell restart', state => { state.bootObservedAt = '2026-09-09T00:01:00.000Z' }],
  ['partition loss', state => { state.partitionLossCount++ }],
  ['partition reacquisition', state => { state.partitionAcquisitionCount++ }],
  ['partition index change', state => { state.partitionIndex = null; state.partitionReady = false }],
  ['partition readiness loss', state => { state.partitionReady = false }],
]
for (const moveNumber of [2, 9]) {
  for (const [label, change] of partitionChanges) {
    test(label + ' in ' + (moveNumber === 2 ? 'a return' : 'the fifth outbound move') + ' invalidates the warm-pool experiment', async t => {
      const f = fixture(t)
      let changed = false
      replaceSample(f.runtime, (sample, trace) => {
        // Change one interior observation only. A final-only comparison must
        // not pass because the endpoint looks healthy again at campaign end.
        if (!changed && trace.moves.length === moveNumber
          && sample.readings.every(row => row.startedAtMs >= trace.moves.at(-1).commit.completedAtMs)) {
          change(sample.readings[2].state)
          changed = true
        }
      })
      const report = await failedGate(f, /move did not qualify/)
      assert.equal(changed, true)
      assert.equal(f.runtime.trace.moves.length, moveNumber)
      const move = moveNumber % 2 === 0 ? report.returns.at(-1) : report.outbound.at(-1)
      assert.equal(move.complete, false)
      assert.ok(move.failure.sample)
      assert.equal(move.failure.move, null)
      assert.ok(move.samples.some(sample => {
        const state = sample.readings[2].state
        return state.bootObservedAt !== report.partitionBaseline[2].bootObservedAt
          || state.partitionLossCount !== 0 || state.partitionAcquisitionCount !== 1
          || state.partitionIndex !== 1 || state.partitionReady !== true
      }), 'The rejected observation must remain in the report')
      assert.equal(f.runtime.trace.counts.fsck, undefined)
      assert.equal(f.runtime.trace.counts.verifyIdentity, 1)
    })
  }
}

test('the return compares its warm partitions with the original campaign baseline', async t => {
  const f = fixture(t)
  replaceSample(f.runtime, (sample, trace) => {
    if (trace.counts.readCold >= 2) sample.readings[0].state.bootObservedAt = '2026-09-09T00:02:00.000Z'
  })
  const report = await failedGate(f, /Warm partition identity changed during the campaign/)
  assert.equal(f.runtime.trace.moves.length, 1, 'The changed return preflight cannot issue a second SQL move')
  assert.equal(report.outbound[0].complete, true)
  assert.equal(report.returns[0].complete, false)
  assert.equal(report.returns[0].samples.length, 1)
})

test('a successful COMMIT cannot swallow a later sampler rejection', async t => {
  const f = fixture(t), read = f.runtime.readCells.bind(f.runtime)
  const evidence = { allRequestsJoined: true, readings: [{ cellId: 'failover-cell-b',
    failure: 'Cell request failed', receipt: { status: 503, closed: true, startedAtMs: 50, completedAtMs: 51 } }] }
  f.runtime.readCells = async () => {
    if (f.runtime.trace.moves.length) {
      const error = new Error('Injected sampling failure after COMMIT')
      error.evidence = evidence
      throw error
    }
    return read()
  }
  const report = await failedGate(f, error => error instanceof AggregateError
    && error.errors.some(nested => nested.message === 'Injected sampling failure after COMMIT'))
  assert.equal(report.outbound[0].movement.to, 1)
  assert.equal(report.outbound[0].complete, false)
  assert.equal(f.runtime.trace.counts.fsck, undefined)
  assert.deepEqual(report.outbound[0].failure.sample.evidence, evidence)
  assert.equal(report.outbound[0].failure.move, null)
  assert.deepEqual(report.failure.errors[0].evidence, evidence)
})

test('a move rejection after the write is reported cannot be turned into PASS', async t => {
  const f = fixture(t), move = f.runtime.move.bind(f.runtime)
  let evidence
  f.runtime.move = async (from, to) => {
    const movement = await move(from, to)
    evidence = { commit: { startedAtMs: movement.commit.startedAtMs, completedAtMs: null },
      rollbackConfirmed: false, connectionFailed: true }
    const error = new Error('Injected connection loss after COMMIT')
    error.code = 'ECONNRESET'
    error.evidence = evidence
    throw error
  }
  const report = await failedGate(f, error => error instanceof AggregateError
    && error.errors.some(nested => nested.message === 'Injected connection loss after COMMIT'))
  assert.equal(f.runtime.trace.moves.length, 1)
  assert.equal(report.outbound[0].complete, false)
  assert.equal(f.runtime.trace.counts.fsck, undefined)
  assert.deepEqual(report.outbound[0].failure.move.evidence, evidence)
  assert.equal(report.outbound[0].failure.move.code, 'ECONNRESET')
  assert.equal(report.outbound[0].failure.sample, null)
  assert.deepEqual(report.failure.errors[0].evidence, evidence)
  assert.equal(report.failure.errors[0].code, 'ECONNRESET')
})

test('a failed move joins its pending sampler before closing and publishing failure', async t => {
  const f = fixture(t), sampleEntered = deferred(), sampleRelease = deferred()
  const read = f.runtime.readCells.bind(f.runtime)
  let readCalls = 0, sampleSettled = false, closeCalls = 0, gateSettled = false
  f.runtime.readCells = async () => {
    if (++readCalls === 4) {
      sampleEntered.resolve()
      await sampleRelease.promise
      sampleSettled = true
    }
    return read()
  }
  f.runtime.move = async () => { await sampleEntered.promise; throw new Error('Injected move rejection') }
  f.runtime.close = async () => { closeCalls++; assert.equal(sampleSettled, true) }
  const running = f.run().then(() => ({ passed: true }), error => ({ error })).finally(() => { gateSettled = true })
  try {
    await sampleEntered.promise
    await nextTurn()
    await nextTurn()
    assert.equal(gateSettled, false)
    assert.equal(closeCalls, 0)
    assert.equal(existsSync(join(f.options.out, 'result.json')), false)
  } finally { sampleRelease.resolve() }
  const result = await running
  assert.ok(result.error instanceof AggregateError)
  assert.equal(result.error.errors[0].message, 'Injected move rejection')
  assert.equal(closeCalls, 1)
  assert.equal(f.report().outcome, 'failed')
  const readsAtClose = readCalls
  await nextTurn()
  assert.equal(readCalls, readsAtClose, 'The sampler cannot outlive gate completion')
})

for (const [label, change] of [
  ['wrong destination', fence => { fence.cell_id = 'failover-cell-b' }],
  ['released destination', fence => { fence.released_at = '2026-09-09T00:00:00Z' }],
  ['non-advancing token', fence => { fence.token = '1' }],
]) {
  test('the movement cannot pass with a ' + label + ' fence', async t => {
    const f = fixture(t), read = f.runtime.readFence.bind(f.runtime)
    f.runtime.readFence = async () => {
      const fence = await read()
      if (f.runtime.trace.moves.length) change(fence)
      return fence
    }
    await failedGate(f)
    assert.equal(f.runtime.trace.moves.length, 1)
  })
}

test('a return to the pool must advance its fence before a second dedicated move', async t => {
  const f = fixture(t), read = f.runtime.readFence.bind(f.runtime)
  f.runtime.readFence = async () => {
    const fence = await read()
    if (f.runtime.trace.moves.length === 2) fence.token = '2'
    return fence
  }
  const report = await failedGate(f, /Fencing token did not advance on return/)
  assert.equal(f.runtime.trace.moves.length, 2)
  assert.equal(report.outbound.length, 1)
  assert.equal(report.returns.length, 1)
})

test('post-COMMIT placement is checked before a move is qualified', async t => {
  const f = fixture(t), read = f.runtime.placement.bind(f.runtime)
  f.runtime.placement = async () => {
    const placement = await read()
    if (f.runtime.trace.moves.length) placement.partition = 0
    return placement
  }
  const report = await failedGate(f)
  assert.equal(report.outbound[0].complete, false)
})

test('a released initial fence cannot authorize the first move', async t => {
  const f = fixture(t), read = f.runtime.readFence.bind(f.runtime)
  f.runtime.readFence = async () => ({ ...await read(), released_at: '2026-09-09T00:00:00Z' })
  await failedGate(f)
  assert.equal(f.runtime.trace.moves.length, 0)
})

test('invalid HTTP clock brackets cannot become measured percentiles', async t => {
  const f = fixture(t)
  replaceSample(f.runtime, (sample, trace) => {
    if (trace.moves.length) sample.readings[0].completedAtMs = sample.readings[0].startedAtMs - 1
  })
  const report = await failedGate(f, /Invalid HTTP request interval/)
  assert.equal(report.outbound[0].complete, false)
  assert.equal(report.percentiles, undefined)
})

test('a cold-read rejection after movement is a gate failure', async t => {
  const f = fixture(t), read = f.runtime.readCold.bind(f.runtime)
  f.runtime.readCold = async reference => {
    if (reference !== undefined) throw new Error('Injected cold graph mismatch')
    return read(reference)
  }
  const report = await failedGate(f, /Injected cold graph mismatch/)
  assert.equal(report.outbound.length, 1)
  assert.equal(report.outbound[0].complete, true)
  assert.equal(f.runtime.trace.counts.fsck, undefined)
})

for (const [label, change] of [
  ['no report', result => { result.stdout = JSON.stringify({ reports: [], sharedRoots: [] }) }],
  ['incomplete JSON', result => { result.stdout = '{"reports":[' }],
  ['two reports', result => { const body = JSON.parse(result.stdout); body.reports.push(body.reports[0]); result.stdout = JSON.stringify(body) }],
  ['wrong workspace', result => { const body = JSON.parse(result.stdout); body.reports[0].workspace.versionId = 'other'; result.stdout = JSON.stringify(body) }],
  ['unclosed process', result => { result.native.closed = false }],
  ['unconfirmed native cleanup', result => { result.native.cleanupConfirmed = false }],
  ['missing native cleanup receipt', result => { delete result.native.cleanupConfirmed }],
  ['native signal', result => { result.native.signal = 'SIGTERM' }],
  ['native timeout', result => { result.native.timedOut = true }],
  ['missing native exit status', result => { delete result.native.code }],
  ['null native exit status', result => { result.native.code = null }],
  ['unexpected native exit status 2', result => { result.native.code = 2 }],
  ['aborted native command', result => { result.native.aborted = true }],
  ['native spawn error', result => { result.native.spawnError = 'ENOENT' }],
  ['native capture error', result => { result.native.captureError = 'output-limit' }],
  ['native tree kill error', result => { result.native.killError = true }],
]) {
  test('fsck with ' + label + ' cannot pass after twenty healthy moves', async t => {
    const f = fixture(t), fsck = f.runtime.fsck.bind(f.runtime)
    f.runtime.fsck = async () => { const result = await fsck(); change(result); return result }
    const report = await failedGate(f)
    assert.equal(report.outbound.length, 20)
    assert.ok(report.outbound.every(move => move.complete))
    assert.equal(f.runtime.trace.counts.fsck, 1)
    assert.ok(report.fsck)
  })
}

test('ordinary nonzero fsck status for another shared root is retained alongside the clean target', async t => {
  const f = fixture(t), fsck = f.runtime.fsck.bind(f.runtime)
  f.runtime.fsck = async () => {
    const result = await fsck(), body = JSON.parse(result.stdout)
    result.native.code = 1
    result.stderr = 'Fixture diagnostic for an unrelated shared root'
    body.sharedRoots.push({ rootUrl: 'other-root', workspaces: [
      { landscapeId: 'other-land', versionId: 'one' }, { landscapeId: 'other-land', versionId: 'two' },
    ] })
    result.stdout = JSON.stringify(body)
    return result
  }
  assert.equal((await f.run()).outcome, 'passed')
  assert.equal(f.report().fsck.native.code, 1)
  assert.equal(f.report().fsck.stderr, 'Fixture diagnostic for an unrelated shared root')
  assert.equal(f.report().fsck.target.reports.length, 1)
})

test('final all-cell ownership is checked again after fsck', async t => {
  const f = fixture(t)
  replaceSample(f.runtime, (sample, trace) => {
    if (trace.counts.fsck) sample.readings[0].state.ownedWorkspaceCount = 1
  })
  const report = await failedGate(f, /multiple cells report ownership/)
  assert.equal(report.outbound.length, 20)
  assert.equal(report.fsck.target.reports[0].status, 'clean')
})

test('final partition identity is checked again after fsck, even with correct workspace counts', async t => {
  const f = fixture(t)
  replaceSample(f.runtime, (sample, trace) => {
    if (trace.counts.fsck) sample.readings[1].state.bootObservedAt = '2026-09-09T00:03:00.000Z'
  })
  const report = await failedGate(f, /Warm partition identity changed at campaign end/)
  assert.equal(report.outbound.length, 20)
  assert.equal(report.fsck.target.reports[0].status, 'clean')
  assert.equal(f.runtime.trace.counts.verifyIdentity, 1)
})

test('a rejected runtime admission identity prevents cold reads and SQL moves', async t => {
  const f = fixture(t), evidence = { unchanged: false, changedContainer: 'fixture-cell-a' }
  f.runtime.verifyIdentity = async () => {
    const error = new Error('Injected admission container identity mismatch')
    error.evidence = evidence
    throw error
  }
  const report = await failedGate(f, /Injected admission container identity mismatch/)
  assert.equal(f.runtime.trace.counts.readCold, undefined)
  assert.equal(f.runtime.trace.moves.length, 0)
  assert.equal(report.outbound.length, 0)
  assert.equal(report.fsck, undefined)
  assert.deepEqual(report.failure.evidence, evidence)
})

test('a final runtime identity rejection cannot publish PASS after successful moves and fsck', async t => {
  const f = fixture(t), evidence = { unchanged: false, changedContainer: 'fixture-cell-c' }
  const verify = f.runtime.verifyIdentity.bind(f.runtime)
  let identityCalls = 0
  f.runtime.verifyIdentity = async () => {
    identityCalls++
    if (identityCalls === 1) return verify()
    const error = new Error('Injected final container identity mismatch')
    error.evidence = evidence
    throw error
  }
  const report = await failedGate(f, /Injected final container identity mismatch/)
  assert.equal(identityCalls, 2)
  assert.equal(report.outbound.length, 20)
  assert.equal(report.fsck.target.reports[0].status, 'clean')
  assert.deepEqual(report.failure.evidence, evidence)
})

test('close failure retains a failed report after otherwise healthy qualification', async t => {
  const f = fixture(t)
  f.runtime.close = async () => { throw new Error('Injected close rejection') }
  await assert.rejects(f.run(), /resource closure failed/)
  const report = f.report()
  assert.equal(report.outcome, 'failed')
  assert.equal(report.resourcesClosed, false)
  assert.equal(report.outbound.length, 20)
})

test('runtime construction rejection leaves a failure record without claiming resources closed', async t => {
  const f = fixture(t)
  const evidence = { identity: { project: f.options.project }, cleanup: { closed: true, operationsJoined: 3 },
    operation: { status: 403, closed: true } }
  await assert.rejects(runDedicatedGate(f.options, { createRuntime: async () => {
    const error = new Error('Injected construction failure')
    error.evidence = evidence
    throw error
  } }),
    /Injected construction failure/)
  assert.equal(f.report().outcome, 'failed')
  assert.equal(f.report().resourcesClosed, false)
  assert.deepEqual(f.report().failure.evidence, evidence)
})

test('CLI defaults require twenty moves and at least ten milliseconds sampling', t => {
  const f = fixture(t)
  const args = ['--dedicated', '--landscape-id', workspace.landscapeId, '--version-id', workspace.versionId,
    '--generation', f.options.generation, '--dedicated-out', f.options.out]
  const options = dedicatedOptions(args, cliEnvironment)
  assert.equal(options.moves, 20)
  assert.equal(options.sampleMs, 25)
  assert.throws(() => dedicatedOptions([...args, '--dedicated-moves', '19'], cliEnvironment), /outside its supported range/)
  assert.throws(() => dedicatedOptions([...args, '--dedicated-sample-ms', '1'], cliEnvironment), /outside its supported range/)
})

async function runCli(args, extraEnv = {}) {
  const env = { ...process.env, ...cliEnvironment, ...extraEnv }
  delete env.NODE_OPTIONS
  delete env.TEST_DATABASE_URL
  delete env.TEST_REDIS_URL
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', preload, cli, ...args], { cwd: here, env,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', exited = false, timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 15000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', () => { exited = true })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolvePromise({ pid: child.pid, code, signal, closed: true, exited, timedOut, stdout, stderr })
    })
  })
}
function assertClosed(native) {
  assert.ok(Number.isInteger(native.pid) && native.pid > 0)
  assert.equal(native.closed, true)
  assert.equal(native.exited, true)
  assert.equal(native.signal, null)
  assert.equal(native.timedOut, false)
}

test('real failover CLI refuses mutually exclusive dedicated and Redis outage modes', async () => {
  const native = await runCli(['--dedicated', '--redis-outage'])
  assertClosed(native)
  assert.notEqual(native.code, 0)
  assert.match(native.stderr, /--dedicated and --redis-outage are mutually exclusive/)
  assert.doesNotMatch(native.stdout, /"outcome":"passed"/)
})

test('real failover CLI dispatches dedicated required-option validation', async () => {
  const native = await runCli(['--dedicated'])
  assertClosed(native)
  assert.notEqual(native.code, 0)
  assert.match(native.stderr, /--landscape-id is required for the dedicated gate/)
  assert.doesNotMatch(native.stderr, /Unexpected network|Unexpected native command/)
  assert.doesNotMatch(native.stdout, /"outcome":"passed"/)
})

for (const failClose of [false, true]) {
  test('real failover CLI dedicated dispatch ' + (failClose ? 'cannot print PASS when close fails' : 'runs and publishes the qualified gate'), async t => {
    const f = fixture(t)
    const native = await runCli(['--dedicated', '--landscape-id', workspace.landscapeId,
      '--version-id', workspace.versionId, '--generation', f.options.generation,
      '--dedicated-out', f.options.out, '--dedicated-sample-ms', '10'],
    { DEDICATED_TEST_CLOSE_FAILURE: failClose ? 'yes' : 'no' })
    assertClosed(native)
    assert.doesNotMatch(native.stderr, /Unexpected network|Unexpected native command/)
    if (failClose) {
      assert.notEqual(native.code, 0)
      assert.doesNotMatch(native.stdout, /"outcome":"passed"/)
      assert.equal(f.report().outcome, 'failed')
      assert.equal(f.report().resourcesClosed, false)
    } else {
      assert.equal(native.code, 0, native.stderr)
      const lines = native.stdout.trim().split(/\r?\n/)
      assert.equal(lines.length, 1)
      const verdict = JSON.parse(lines[0])
      assert.equal(verdict.outcome, 'passed')
      assert.equal(verdict.scenario, 'dedicated')
      assert.equal(verdict.moves, 20)
      assert.equal(verdict.dedicatedCell, 'failover-cell-c')
      assert.equal(verdict.resourcesClosed, true)
      assert.equal(f.report().outcome, 'passed')
      assert.equal(f.report().fixture.kind, 'orchestration-only')
      assert.equal(f.report().returns.length, 19)
    }
  })
}
