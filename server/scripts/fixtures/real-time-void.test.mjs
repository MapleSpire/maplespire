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
import { onlyHostStarvation, untilAdmitted } from './real-time-void.mjs'

// The exact strings the instruments emit, so a reworded issue in either module
// turns this red instead of silently ceasing to be void.
const starvation = [
  'a: no recent completed clock request within two sampling periods',
  'engine: need at least two completed clock samples before injection',
  'b: sample 3: wall clock differs from monotonic clock',
  'current wall clock differs from monotonic clock',
  'admission-stale', 'admission-insufficient-replies', 'wall-monotonic-disagreement',
]

test('only a non-empty list made entirely of host-starvation issues is void', () => {
  assert.equal(onlyHostStarvation(starvation), true)
  for (const issue of starvation) assert.equal(onlyHostStarvation([issue]), true, issue)
  assert.equal(onlyHostStarvation([]), false)
  assert.equal(onlyHostStarvation(null), false)
  assert.equal(onlyHostStarvation(undefined), false)
  for (const other of ['response-framing-invalid', 'Redis witness admission failed',
    'engine: Engine version is outside the audited log timestamp model',
    'cell and Engine clocks are incompatible with shared local realtime',
    'a: clock offset intervals have no common intersection',
    'x: no recent completed clock request within two sampling periods',
    'admission-stale and more']) {
    assert.equal(onlyHostStarvation([other]), false, other)
    assert.equal(onlyHostStarvation(['admission-stale', other]), false, `mixed with ${other}`)
  }
})

test('the halt cascade is void only when the preempted clock pair that causes it is present', () => {
  // The exact sequence the gate child reported under load.
  assert.equal(onlyHostStarvation(['wall-monotonic-disagreement', 'clock-unusable', 'admission-not-active', 'admission-stale']), true)
  // The same consequences from any other cause are failures.
  for (const issues of [
    ['clock-unusable'], ['admission-not-active'], ['clock-unusable', 'admission-not-active'],
    ['admission-stale', 'clock-unusable'], ['admission-stale', 'admission-not-active'],
    ['clock-read-failed', 'clock-unusable', 'admission-not-active'],
    ['clock-order-invalid', 'clock-unusable'],
    ['socket-error', 'admission-not-active', 'admission-stale'],
    ['wall-monotonic-disagreement', 'clock-unusable', 'unexpected-socket-close'],
  ]) assert.equal(onlyHostStarvation(issues), false, JSON.stringify(issues))
})

function recorder() {
  const lines = []
  return { lines, t: { diagnostic: line => lines.push(line) } }
}

test('a void attempt is disclosed and re-run; the first non-void attempt is returned', async () => {
  const { lines, t } = recorder()
  const outcomes = [{ void: ['admission-stale'] }, { void: null, value: 'admitted' }]
  let calls = 0
  assert.equal(await untilAdmitted(t, 'arm', async index => { calls += 1; assert.equal(index, calls); return outcomes[index - 1] }), 'admitted')
  assert.equal(calls, 2)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^arm: attempt 1 VOID, .*admission-stale$/)
})

test('a refusal with any other issue FAILS at once instead of returning past the arm', async () => {
  for (const issues of [['admission-stale', 'response-framing-invalid'], ['a: sample 0: invalid timestamp, request interval or error'], []]) {
    const { lines, t } = recorder()
    let calls = 0
    await assert.rejects(untilAdmitted(t, 'arm', async () => {
      calls += 1
      return { void: issues, value: 'refused' }
    }), /arm: admission refused for a reason other than host starvation/)
    assert.equal(calls, 1, JSON.stringify(issues))
    assert.deepEqual(lines, [])
  }
})

test('consecutive voids exhaust the attempts and FAIL rather than pass', async () => {
  const { lines, t } = recorder()
  let calls = 0
  await assert.rejects(untilAdmitted(t, 'arm', async () => { calls += 1; return { void: ['admission-stale'] } }),
    /arm: 5 consecutive VOID attempts/)
  assert.equal(calls, 5)
  assert.equal(lines.length, 5)
  calls = 0
  await assert.rejects(untilAdmitted(t, 'arm', async () => { calls += 1; return { void: ['admission-stale'] } }, { attempts: 1 }),
    /1 consecutive VOID/)
  assert.equal(calls, 1)
})
