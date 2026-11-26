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
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CONTROL_MIN_MS, PROMOTED_TAKEOVER_FLAG, PROMOTED_THRESHOLD_MS,
  assertPromotedTakeoverConfig, expectedStaticWorkspaces, judgePromotedTakeover, parsePromotedTakeover,
  probePromotedFreshness, promotedEditPlan, promotedFreshnessValidity, promotionVerdict, sinceCompleted,
} from './sync-cell-promoted-takeover.mjs'
import { parseLoadSoakConfig } from './verify-sync-cell-load-soak.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const benchPath = join(here, 'sync-cell-bench.mjs')

const workspace = { landscapeId: 'l0', versionId: 'v0' }
const seed = {
  totalObjects: 12_000,
  expectedObjects: { 'head-0': { name: 'QA G4-7 head-0' }, 'bg-11989': { name: 'QA G4-7 bg-11989' } },
  inventory: { projectorInstanceId: 'ordinary-seed' },
}
const plan = promotedEditPlan(seed, 'run-1')
const shippedSoak = { benchPosture: 'shipped', mode: 'soak', seedObjectCount: 12_000, freshWorkspaces: true, partitionCount: 2, promotedTakeover: 'on' }

test('G4-16h the setting parses to on or nothing, and refuses anything else', () => {
  assert.equal(parsePromotedTakeover(undefined), null)
  assert.equal(parsePromotedTakeover(''), null)
  assert.equal(parsePromotedTakeover('off'), null)
  assert.equal(parsePromotedTakeover(' on '), 'on')
  assert.throws(() => parsePromotedTakeover('yes'), /must be on or off/)
  assert.equal(PROMOTED_TAKEOVER_FLAG, 'SYNC_LOAD_PROMOTED_TAKEOVER')
})

test('G4-16h the arm runs only inside the 12 000-object posture soak rehearsal', () => {
  assert.doesNotThrow(() => assertPromotedTakeoverConfig(shippedSoak))
  assert.doesNotThrow(() => assertPromotedTakeoverConfig({ mode: 'smoke' }), 'absent: nothing to refuse')
  assert.throws(() => assertPromotedTakeoverConfig({ ...shippedSoak, benchPosture: null }), /SYNC_BENCH_POSTURE/)
  assert.throws(() => assertPromotedTakeoverConfig({ ...shippedSoak, mode: 'smoke' }), /--mode=soak/)
  assert.throws(() => assertPromotedTakeoverConfig({ ...shippedSoak, seedObjectCount: 11_999 }), /12000/)
  assert.throws(() => assertPromotedTakeoverConfig({ ...shippedSoak, freshWorkspaces: false }), /fresh workspaces/)
  assert.throws(() => assertPromotedTakeoverConfig({ ...shippedSoak, partitionCount: 1 }), /two-partition/)
})

test('G4-16h the gate config carries the setting only when asked, and refuses it outside the rehearsal', () => {
  const base = { SYNC_LOAD_PROFILE: 'fleet' }
  assert.equal(Object.hasOwn(parseLoadSoakConfig(base, ['--mode=smoke']), 'promotedTakeover'), false)
  assert.equal(Object.hasOwn(parseLoadSoakConfig({ ...base, SYNC_LOAD_PROMOTED_TAKEOVER: 'off' }, ['--mode=smoke']), 'promotedTakeover'), false)
  assert.throws(() => parseLoadSoakConfig({ ...base, SYNC_LOAD_PROMOTED_TAKEOVER: 'on' }, ['--mode=smoke']), /SYNC_LOAD_PROMOTED_TAKEOVER=on refused/)
})

test('G4-16h the staticWorkspaces rule is relaxed for the promoted arm only', () => {
  assert.equal(expectedStaticWorkspaces('ordinary', {}), 0)
  assert.equal(expectedStaticWorkspaces('ordinary', { promotedTakeover: 'on' }), 0, 'the control keeps the rule with the setting on')
  assert.equal(expectedStaticWorkspaces('promoted', { promotedTakeover: 'on' }), 1)
  assert.throws(() => expectedStaticWorkspaces('promoted', {}), /needs SYNC_LOAD_PROMOTED_TAKEOVER=on/)
  assert.throws(() => expectedStaticWorkspaces('other', { promotedTakeover: 'on' }), /unknown rehearsal arm/)
})

const appliedReport = (over = {}) => ({ status: 200, body: { mode: 'apply', workspace, blockers: [], overridden: [], exclusionProven: true,
  applied: { writeHeadUrl: 'automerge:head', staticSource: 'promoted', allowListSize: 40, fenceWaitMs: 2_000, diagramCount: 1 }, ...over } })

test('G4-16h a promotion counts only when the route applied it, unblocked and unoverridden', () => {
  assert.deepEqual(promotionVerdict(appliedReport(), workspace).accepted, true)
  const blocked = promotionVerdict({ status: 409, body: { ...appliedReport().body, applied: null, blockers: [{ code: 'ordinary-head-retirements', detail: 'x' }] } }, workspace)
  assert.equal(blocked.accepted, false)
  assert.deepEqual(blocked.blockers, ['ordinary-head-retirements'])
  assert.match(blocked.reasons.join(';'), /HTTP 409/)
  assert.equal(promotionVerdict(appliedReport({ applied: null }), workspace).accepted, false, 'a 200 with nothing applied')
  const blockedButApplied = promotionVerdict(appliedReport({ blockers: [{ code: 'witness-moved' }] }), workspace)
  assert.equal(blockedButApplied.accepted, false, 'a blocker refuses even beside an applied block')
  assert.match(blockedButApplied.reasons.join(';'), /blocked: witness-moved/)
  assert.equal(promotionVerdict(appliedReport({ overridden: [{ code: 'peers-connected' }] }), workspace).accepted, false)
  assert.equal(promotionVerdict(appliedReport({ mode: 'report' }), workspace).accepted, false)
  assert.equal(promotionVerdict(appliedReport({ workspace: { landscapeId: 'l1', versionId: 'v0' } }), workspace).accepted, false)
  assert.equal(promotionVerdict(appliedReport({ applied: { ...appliedReport().body.applied, staticSource: 'performance' } }), workspace).accepted, false)
  assert.equal(promotionVerdict(appliedReport({ exclusionProven: false }), workspace).accepted, false)
  assert.equal(promotionVerdict(appliedReport({ blockers: undefined }), workspace).accepted, false)
  assert.equal(promotionVerdict({ status: 500, body: 'boom' }, workspace).accepted, false)
  assert.equal(promotionVerdict(null, workspace).accepted, false)
})

test('G4-16h the origin is completedAt on the monotonic clock, never the pause or the start', () => {
  const takeover = { pauseRequestedAt: 1, startedAt: 2, completedAt: 3, completedMonotonicMs: 10_000 }
  assert.equal(sinceCompleted(takeover, 10_750), 750)
  assert.throws(() => sinceCompleted({ completedAt: 3 }, 10_750), /completedMonotonicMs/)
  assert.throws(() => sinceCompleted(takeover, Number.NaN), /monotonic/)
})

test('G4-16h the edit targets a base witness and keeps the other witness unedited', () => {
  assert.equal(plan.objectId, 'bg-11989')
  assert.deepEqual(plan.expectedObjects, { 'head-0': { name: 'QA G4-7 head-0' }, 'bg-11989': { name: 'G4-16h takeover edit run-1' } })
  assert.notEqual(plan.name, seed.expectedObjects['bg-11989'].name)
  assert.throws(() => promotedEditPlan({ expectedObjects: { a: {} } }, 'r'), /exactly two/)
  // The warm edit before the pause and the takeover edit after it never share a value.
  const warm = promotedEditPlan(seed, 'run-1', 'warm')
  const afterWarm = promotedEditPlan({ ...seed, expectedObjects: warm.expectedObjects }, 'run-1')
  assert.notEqual(warm.name, afterWarm.name)
  assert.notEqual(warm.batchId, afterWarm.batchId)
  assert.equal(afterWarm.objectId, warm.objectId)
  assert.throws(() => promotedEditPlan(seed, 'run-1', 'Warm edit'), /one lowercase word/)
})

/** A clock the fakes advance, so every time the probe reports is known. */
function fakeClock(start = 10_000) {
  let now = start
  return { now: () => now, advance: (ms) => { now += ms } }
}

const response = ({ status = 200, route = 'owner', absenceProvable = true, names = {}, body = {} } = {}) => ({
  status, route,
  body: { landscapeId: 'l0', versionId: 'v0', absenceProvable, caughtUp: absenceProvable, status: absenceProvable ? 'healthy' : 'catching_up',
    projectionGeneration: 4,
    objects: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { id, name }])), ...body },
})
const kept = { 'head-0': 'QA G4-7 head-0', 'bg-11989': 'QA G4-7 bg-11989' }
const edited = { 'head-0': 'QA G4-7 head-0', 'bg-11989': 'G4-16h takeover edit run-1' }

test('G4-16h the promoted measurement is the first FRESH response that shows the edit, from completedAt', async () => {
  const clock = fakeClock()
  const takeover = { completedAt: 1, completedMonotonicMs: clock.now() }
  // In order: the served (kept rows) read, then the edited reads.
  const answers = [
    response({ names: kept }), // served: kept rows look fresh — recorded, never the measurement
    response({ status: 503, body: { error: 'warming' } }),
    response({ names: kept }), // fresh, but without the edit
    response({ absenceProvable: false, names: edited }), // the edit, not provable
    response({ route: 'proxied', names: edited }), // the edit, from the wrong cell
    response({ names: edited }), // the measurement
    response({ names: edited }),
  ]
  const probe = async () => { clock.advance(40); return answers.shift() }
  const measured = await probePromotedFreshness({ takeover, workspace, seed, plan,
    edit: { apply: async () => { clock.advance(5); return { appliedMonotonicMs: clock.now(), rootSummaryOnly: true } } },
    probe, monotonic: clock.now, sleep: async (ms) => clock.advance(ms), intervalMs: 250 })
  assert.equal(measured.served.keptRowsFresh, true)
  assert.equal(measured.requests.length, 5)
  assert.deepEqual(measured.requests.map((row) => row.editVisible), [false, false, true, true, true])
  assert.equal(measured.freshAfterTakeoverMs, measured.firstFresh.receivedAfterMs)
  // First owner 200 showing the edit (the not-provable one), before the fresh one; the proxied one does not count.
  assert.equal(measured.editVisibleAfterMs, measured.requests[2].receivedAfterMs)
  assert.ok(measured.editVisibleAfterMs < measured.freshAfterTakeoverMs)
  // 5 (edit) + 40 (served) + four reads of 40 + four sleeps of 250 + the fifth read's 40.
  assert.equal(measured.freshAfterTakeoverMs, 5 + 40 + 4 * (40 + 250) + 40)
  // The edit runs beside the first reads; its time is taken on the same clock.
  assert.ok(measured.edit.appliedAfterMs > 0 && measured.edit.appliedAfterMs < measured.freshAfterTakeoverMs)
})

test('G4-16h the edit counts as visible only in an owner answer', async () => {
  const clock = fakeClock()
  const takeover = { completedAt: 1, completedMonotonicMs: clock.now() }
  const answers = [response({ names: kept }), response({ route: 'proxied', absenceProvable: false, names: edited }),
    response({ absenceProvable: false, names: edited }), response({ names: edited })]
  const measured = await probePromotedFreshness({ takeover, workspace, seed, plan,
    edit: { apply: async () => ({ appliedMonotonicMs: clock.now(), rootSummaryOnly: true }) },
    probe: async () => { clock.advance(10); return answers.shift() }, monotonic: clock.now, sleep: async (ms) => clock.advance(ms) })
  assert.equal(measured.editVisibleAfterMs, measured.requests[1].receivedAfterMs, 'the proxied answer is not the visibility time')
})

test('G4-16h a failed edit ends the probe at once, and a missing edit times it out with the requests kept', async () => {
  const clock = fakeClock()
  const takeover = { completedAt: 1, completedMonotonicMs: clock.now() }
  let reads = 0
  await assert.rejects(probePromotedFreshness({ takeover, workspace, seed, plan,
    edit: { apply: async () => { throw new Error('socket refused') } },
    probe: async () => { reads += 1; clock.advance(10); return response({ names: kept }) },
    monotonic: clock.now, sleep: async (ms) => clock.advance(ms) }), /overlay edit failed: socket refused/)
  assert.ok(reads <= 3, `the probe kept polling after the edit failed (${reads} reads)`)
  const late = probePromotedFreshness({ takeover, workspace, seed, plan,
    edit: { apply: async () => ({ appliedMonotonicMs: clock.now(), rootSummaryOnly: true }) },
    probe: async () => { clock.advance(10); return response({ names: kept }) },
    monotonic: clock.now, sleep: async (ms) => clock.advance(ms), timeoutMs: 2_000 })
  const censored = await late
  assert.equal(censored.censored, true, 'no fresh answer is a censored observation, not a number')
  assert.equal(censored.freshAfterTakeoverMs, null)
  assert.ok(censored.censoredAfterMs >= 2_000, `censored after ${censored.censoredAfterMs} ms`)
  assert.ok(censored.requests.length > 3)
  assert.equal(censored.served.keptRowsFresh, true)
  // An edit that never reports applied is not a censored miss: it throws.
  await assert.rejects(probePromotedFreshness({ takeover, workspace, seed, plan,
    edit: { apply: () => new Promise(() => {}) },
    probe: async () => { clock.advance(10); return response({ names: kept }) },
    monotonic: clock.now, sleep: async (ms) => clock.advance(ms), timeoutMs: 2_000 }), /never reported applied/)
})

const topology = { effectiveGeneration: 'g1', configuredGeneration: 'g1' }
const ownership = { cellId: 'cell-c', effectiveGeneration: 'g1', topologyGeneration: 'g1', configuredGeneration: 'g1' }
const bootId = '0b9d2a52-4f7e-4b7a-9c3e-1f2a3b4c5d6e'
const valid = () => ({
  before: { service: 'sync-cell-c', stats: { processBootId: bootId }, ownership: { ...ownership, ready: false, partitionIndex: null },
    fleet: { residentProjectors: 0, inFlightWorkspaces: 0 } },
  after: { service: 'sync-cell-c', stats: { processBootId: bootId }, ownership: { ...ownership, ready: true, partitionIndex: 0 },
    fleet: { residentProjectors: 1, foreignResidentProjectors: 0 } },
  replacement: { service: 'sync-cell-c', state: { ...ownership, ready: true, partitionReady: true, partitionIndex: 0 } },
  expectedTopology: topology,
  inventory: { objects: 12_000, staticWorkspaces: 1, projectorInstanceId: 'replacement-static' },
  seed,
  preTakeover: { inventory: { projectorInstanceId: 'former-owner-static' } },
  config: { promotedTakeover: 'on' },
  measured: { freshAfterTakeoverMs: 4_200, edit: { appliedAfterMs: 180, rootSummaryOnly: true } },
})

test('G4-16h a promoted answer is valid only if the replacement produced it', () => {
  assert.deepEqual(promotedFreshnessValidity(valid()), { valid: true, reasons: [] })
  const broken = (mutate, pattern) => {
    const input = valid()
    mutate(input)
    const verdict = promotedFreshnessValidity(input)
    assert.equal(verdict.valid, false, `expected invalid for ${pattern}`)
    assert.match(verdict.reasons.join('; '), pattern)
  }
  broken((input) => { input.inventory.staticWorkspaces = 0 }, /staticWorkspaces is 0/)
  broken((input) => { input.inventory.projectorInstanceId = 'former-owner-static' }, /former owner/)
  broken((input) => { input.inventory.projectorInstanceId = null }, /no projector instance/)
  broken((input) => { input.preTakeover = null }, /pre-takeover/)
  broken((input) => { input.after.fleet.foreignResidentProjectors = 1 }, /foreign projector/)
  broken((input) => { input.before.fleet.residentProjectors = 1 }, /not cold/)
  broken((input) => { input.after.ownership.partitionIndex = 1 }, /partition zero/)
  broken((input) => { input.inventory.objects = 11_999 }, /ro_objects holds 11999/)
  broken((input) => { input.after.stats.processBootId = '1b9d2a52-4f7e-4b7a-9c3e-1f2a3b4c5d6e' }, /identity/)
  broken((input) => { input.measured.edit.appliedAfterMs = -1 }, /not applied after completedAt/)
  broken((input) => { input.measured.freshAfterTakeoverMs = 100 }, /before it was applied/)
  broken((input) => { input.measured.edit.rootSummaryOnly = false }, /summary world/)
  broken((input) => { input.config = {} }, /needs SYNC_LOAD_PROMOTED_TAKEOVER=on/)
  // A censored wait is valid only if it is real and the replacement answered.
  const censored = (over) => ({ ...valid(), measured: { freshAfterTakeoverMs: null, censored: true, censoredAfterMs: 120_400,
    requests: [{ status: 200, route: 'owner' }], edit: { appliedAfterMs: 180, rootSummaryOnly: true }, ...over } })
  assert.deepEqual(promotedFreshnessValidity(censored({})), { valid: true, reasons: [] })
  assert.match(promotedFreshnessValidity(censored({ censoredAfterMs: 500 })).reasons.join(';'), /shorter than the threshold/)
  assert.match(promotedFreshnessValidity(censored({ requests: [{ status: 503, route: 'owner' }] })).reasons.join(';'), /never answered/)
  assert.match(promotedFreshnessValidity(censored({ censored: false })).reasons.join(';'), /no measured freshness/)
})

const arms = (ordinaryMs, promotedMs, over = {}) => ({
  promotion: { accepted: true, reasons: [] },
  takeover: { verified: true, completedAt: 1_700_000_000_000, takeoverMs: 1_400 },
  ordinary: { valid: true, completedAt: 1_700_000_000_000, freshAfterTakeoverMs: ordinaryMs },
  promoted: { valid: true, reasons: [], completedAt: 1_700_000_000_000, freshAfterTakeoverMs: promotedMs },
  ...over,
})

test('G4-16h the verdict: threshold strict, control must discriminate, refusals VOID', () => {
  const met = judgePromotedTakeover(arms(3_950, 999))
  assert.equal(met.status, 'MEASURED')
  assert.equal(met.remedy, 'proven')
  assert.equal(met.outcome, 'passed')
  const missed = judgePromotedTakeover(arms(3_950, PROMOTED_THRESHOLD_MS))
  assert.equal(missed.status, 'MEASURED')
  assert.equal(missed.thresholdMet, false, '1 000 ms is not under 1 000 ms')
  assert.equal(missed.outcome, 'failed', 'a miss is a valid result, never a pass')
  const blind = judgePromotedTakeover(arms(CONTROL_MIN_MS - 1, 200))
  assert.equal(blind.status, 'INCONCLUSIVE')
  assert.equal(blind.remedy, null)
  assert.equal(judgePromotedTakeover(arms(CONTROL_MIN_MS, 200)).status, 'MEASURED', 'exactly 3 000 ms discriminates')
  const refused = judgePromotedTakeover(arms(3_950, 200, { promotion: { accepted: false, reasons: ['blocked: ordinary-head-retirements'] } }))
  assert.equal(refused.status, 'VOID')
  assert.match(refused.reasons.join(';'), /ordinary-head-retirements/)
  assert.equal(judgePromotedTakeover(arms(3_950, 200, { ordinary: { valid: false, completedAt: 1_700_000_000_000, freshAfterTakeoverMs: 3_950 } })).status, 'VOID')
  assert.equal(judgePromotedTakeover(arms(3_950, 200, { promoted: { valid: false, reasons: ['x'], completedAt: 1_700_000_000_000, freshAfterTakeoverMs: 200 } })).status, 'VOID')
  const twoOrigins = judgePromotedTakeover(arms(3_950, 200, { promoted: { valid: true, completedAt: 1_700_000_000_001, freshAfterTakeoverMs: 200 } }))
  assert.equal(twoOrigins.status, 'VOID')
  assert.match(twoOrigins.reasons.join(';'), /same completedAt/)
  assert.equal(judgePromotedTakeover(arms(3_950, 200, { takeover: { verified: false, completedAt: 1 } })).status, 'VOID')
  assert.equal(judgePromotedTakeover(arms(Number.NaN, 200)).status, 'VOID')
  // Censored: no fresh answer within the wait is a MEASURED miss, never a pass.
  const censoredArm = (over = {}) => ({ valid: true, censored: true, censoredAfterMs: 120_300, completedAt: 1_700_000_000_000,
    freshAfterTakeoverMs: null, edit: { appliedAfterMs: 200 }, preTakeover: { warm: { fresh: true } }, ...over })
  const late = judgePromotedTakeover(arms(3_950, null, { promoted: censoredArm() }))
  assert.equal(late.status, 'MEASURED')
  assert.equal(late.thresholdMet, false)
  assert.equal(late.remedy, 'not-proven')
  assert.equal(late.promotedFreshAfterTakeoverMs, null)
  assert.equal(late.promotedCensoredAfterMs, 120_300)
  const shortWait = judgePromotedTakeover(arms(3_950, null, { promoted: censoredArm({ censoredAfterMs: 10 }) }))
  assert.equal(shortWait.status, 'VOID', 'a censored wait under the threshold proves nothing')
  assert.deepEqual(shortWait.reasons, ['the promoted arm carries no usable censored wait'])
  assert.equal(judgePromotedTakeover(arms(2_000, null, { promoted: censoredArm() })).status, 'INCONCLUSIVE', 'the control still has to discriminate')
  // Lens BLOCKING-3: a censored arm whose owner never answered fresh before the pause is not a takeover miss.
  const neverFresh = judgePromotedTakeover(arms(3_950, null, { promoted: censoredArm({ preTakeover: { warm: { fresh: false } } }) }))
  assert.equal(neverFresh.status, 'VOID')
  assert.match(neverFresh.reasons.join(';'), /never provable on the owner before the pause/)
  assert.equal(judgePromotedTakeover(arms(3_950, null, { promoted: censoredArm({ preTakeover: undefined }) })).status, 'VOID')
  // Lens BLOCKING-2: an edit applied at or past the threshold makes it unreachable: VOID, never a miss.
  const floor = judgePromotedTakeover(arms(3_950, 1_700, { promoted: { valid: true, completedAt: 1_700_000_000_000,
    freshAfterTakeoverMs: 1_700, edit: { appliedAfterMs: PROMOTED_THRESHOLD_MS } } }))
  assert.equal(floor.status, 'VOID')
  assert.match(floor.reasons.join(';'), /unreachable by construction/)
  const underFloor = judgePromotedTakeover(arms(3_950, 900, { promoted: { valid: true, completedAt: 1_700_000_000_000,
    freshAfterTakeoverMs: 900, edit: { appliedAfterMs: 999 }, editVisibleAfterMs: 880 } }))
  assert.equal(underFloor.status, 'MEASURED')
  assert.equal(underFloor.promotedEditAppliedAfterMs, 999)
  assert.equal(underFloor.promotedEditVisibleAfterMs, 880)
})

test('G4-16h the bench owns the setting: blank by default, on only for the posture soak load-soak leg', () => {
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { promotedTakeoverEnvironment } from ${JSON.stringify(pathToFileURL(benchPath).href)}
const attempt = (fn) => { try { return { value: fn() } } catch (error) { return { error: error.message } } }
const soak = { legName: 'load-soak', posture: 'shipped', legArgs: ['--mode=soak'] }
const out = {
  none: attempt(() => promotedTakeoverEnvironment([], soak)),
  off: attempt(() => promotedTakeoverEnvironment(['--promoted-takeover=off'], soak)),
  on: attempt(() => promotedTakeoverEnvironment(['--promoted-takeover=on'], soak)),
  bad: attempt(() => promotedTakeoverEnvironment(['--promoted-takeover=yes'], soak)),
  otherLeg: attempt(() => promotedTakeoverEnvironment(['--promoted-takeover=on'], { ...soak, legName: 'failover' })),
  noPosture: attempt(() => promotedTakeoverEnvironment(['--promoted-takeover=on'], { ...soak, posture: null })),
  smoke: attempt(() => promotedTakeoverEnvironment(['--promoted-takeover=on'], { ...soak, legArgs: ['--mode=smoke'] })),
}
console.log('PROMOTED ' + JSON.stringify(out))`,
    '--', 'ignored-argv1', '--help',
  ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, SYNC_LOAD_PROMOTED_TAKEOVER: 'on' } })
  assert.equal(probe.status, 0, `runner probe exited ${probe.status}: ${probe.stderr}`)
  const out = JSON.parse(probe.stdout.split(/\r?\n/).find((line) => line.startsWith('PROMOTED ')).slice('PROMOTED '.length))
  assert.deepEqual(out.none, { value: { SYNC_LOAD_PROMOTED_TAKEOVER: '' } }, 'an inherited value is blanked')
  assert.deepEqual(out.off, { value: { SYNC_LOAD_PROMOTED_TAKEOVER: '' } })
  assert.deepEqual(out.on, { value: { SYNC_LOAD_PROMOTED_TAKEOVER: 'on' } })
  assert.match(out.bad.error, /must be on or off/)
  assert.match(out.otherLeg.error, /load-soak leg only/)
  assert.match(out.noPosture.error, /needs --posture/)
  assert.match(out.smoke.error, /needs --mode=soak/)
})
