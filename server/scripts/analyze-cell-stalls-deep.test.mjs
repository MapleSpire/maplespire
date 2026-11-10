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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { bandOf, longestGapOverlapping, main, tasksOf } from './analyze-cell-stalls-deep.mjs'

// Two cells on one clock, 20 s, 1 ms sampling, worker readings every 10 ms.
//  - 4.000–4.100 s: cell a's MAIN sampler stops; its worker keeps reading and
//    cell b runs → "main thread only".
//  - 8.000–8.100 s: everything stops (a's sampler and worker, b's sampler and
//    worker) → "VM-wide".
//  - forwardRetiredHead tasks: at 0.5 s after a rotation (fully sampled) and
//    at 10.2 s after it (with a 20 ms sampler hole inside).
const T0 = Date.parse('2026-11-05T10:00:00.000Z')
const H0 = 9_000_000_000
const BOOT = { a: '1aaaaaaa-1111-4111-8111-111111111111', b: '2bbbbbbb-2222-4222-8222-222222222222' }
const frame = (functionName, url = '', lineNumber = -1) => ({ functionName, scriptId: '0', url, lineNumber, columnNumber: -1 })
const NODES = [
  { id: 1, callFrame: frame('(root)'), children: [2, 3] },
  { id: 2, callFrame: frame('(idle)'), children: [] },
  { id: 3, callFrame: frame('processTicksAndRejections', 'node:internal/process/task_queues', 94), children: [4] },
  { id: 4, callFrame: frame('forwardRetiredHead', 'file:///app/dist/readModel/ordinaryHeadForwarding.js', 253), children: [5] },
  { id: 5, callFrame: frame('automerge_wasm::diff', 'wasm://wasm/x', 0), children: [] },
]
// Rotation at 1.0 s: tasks at 1.5 s (band 0–2 s) and 11.2 s (band 9–12 s).
const FORWARDS = [[1500, 1530, null], [11_200, 11_260, [11_220, 11_240]]]

function sampleTimes(cell) {
  const times = []
  for (let ms = 0; ms < 20_000; ms++) {
    if (ms > 8000 && ms < 8100) continue
    if (cell === 'a' && ms > 4000 && ms < 4100) continue
    if (cell === 'a' && FORWARDS.some(([, , hole]) => hole && ms > hole[0] && ms < hole[1])) continue
    times.push(ms)
  }
  return times
}
const nodeAt = (cell, ms) => cell === 'a' && FORWARDS.some(([from, to]) => ms >= from && ms < to) ? 5 : 2

function writeCell(root, cell) {
  const boot = BOOT[cell]
  const run = join(root, `failover-cell-${cell}-${boot}`)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'manifest.json'), JSON.stringify({ bootId: boot, cellId: `failover-cell-${cell}`, samplingIntervalUs: 1000, chunkSeconds: 20,
    anchor: { wallMs: T0, perfMs: 0, hrUs: H0 }, bootChunk: null, sched: { available: true } }))
  const times = sampleTimes(cell)
  const samples = times.map((ms) => nodeAt(cell, ms))
  const timeDeltas = times.map((ms, index) => (index === 0 ? 500 : (ms - times[index - 1]) * 1000))
  const profile = { nodes: NODES, startTime: H0 - 500, endTime: H0 + 20_000_000, samples, timeDeltas }
  writeFileSync(join(run, 'cpu-000001.cpuprofile.gz'), gzipSync(JSON.stringify(profile)))
  writeFileSync(join(run, 'events.ndjson'), [
    { type: 'roll', reason: 'roll', ended: null, startedSeq: 1, wallMsBefore: T0 - 0.6, hrUsBefore: H0 - 600, hrUsAfterStart: H0 - 400, hrUsAfterEnd: H0 - 390, wallMsAfter: T0 },
    { type: 'chunk', seq: 1, file: 'cpu-000001.cpuprofile.gz', startTime: profile.startTime, endTime: profile.endTime },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  const rows = []
  const steal = []
  for (let ms = 0; ms <= 20_000; ms += 10) {
    if (ms > 8000 && ms < 8100) continue
    rows.push([H0 + ms * 1000, ms * 1e5, 0, ms])
    if (ms % 100 === 0) steal.push([H0 + ms * 1000, 0, ms])
  }
  writeFileSync(join(run, 'sched-000001.json.gz'), gzipSync(JSON.stringify({ rows, steal: { rows: steal } })))
}

function gateLog() {
  const lines = []
  for (let index = 0; index < 40; index++) {
    const start = T0 + index * 500
    const p99 = (cell) => cell === 'a' && index === 8 ? 100.27 : cell === 'a' && index === 16 ? 101 : 20.2
    const fact = (cell) => ({ service: `sync-cell-${cell}`, processBootId: BOOT[cell], cellId: `failover-cell-${cell}`, eventLoopP99Ms: p99(cell),
      eventLoopExcluded: false, eventLoopWindow: { startedAt: new Date(start).toISOString(), resetCount: index + 1 } })
    lines.push(`G47_EVENT ${JSON.stringify({ kind: 'sample', observedAt: start + 500, phase: 'soak', cycle: 1, cells: [fact('a'), fact('b')] })}`)
  }
  return `${lines.join('\n')}\n`
}

test('gaps, tasks and bands', () => {
  assert.deepEqual(longestGapOverlapping([0, 10, 120, 130], 50, 60), { fromHr: 10, toHr: 120, ms: 0.11 })
  assert.equal(longestGapOverlapping([0, 10], 50, 60), null)
  assert.deepEqual([bandOf(null), bandOf(500), bandOf(10_000), bandOf(5000), bandOf(-1)], ['elsewhere', '0–2 s', '9–12 s', 'elsewhere', 'elsewhere'])
  const idle = (hrUs) => ({ hrUs, nextUs: 1000, stack: [frame('(idle)')] })
  const busy = (hrUs, nextUs = 1000) => ({ hrUs, nextUs, stack: [frame('w', 'file:///app/a.js'), frame('forwardRetiredHead', 'file:///app/f.js'), frame('processTicksAndRejections', 'node:x')] })
  const [task] = tasksOf([idle(0), busy(1000), busy(2000, 20_000), busy(22_000), idle(23_000)], 1000)
  assert.deepEqual({ ...task, root: undefined }, { fromHr: 1000, durationUs: 22_000, sampledUs: 7000, root: undefined, forward: true, samples: 3 })
})

test('who stopped: main only vs VM-wide, steal blind, unsampled time by band', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cell-stalls-deep-'))
  try {
    writeCell(root, 'a')
    writeCell(root, 'b')
    writeFileSync(join(root, 'gate.log'), gateLog())
    mkdirSync(join(root, 'compose-logs'))
    writeFileSync(join(root, 'compose-logs', 'sync-cell-b.log'),
      `sync-cell-b-1  | ${new Date(T0 + 1000).toISOString()} {"event":"read_model.ordinary_head_rotated","workspace":"l/v"}\n`)
    const report = await main([`--capture-dir=${root}`, '--controls=3'])
    assert.equal(report.stalls.length, 2)
    const [mainOnly, vmWide] = report.stalls
    assert.equal(mainOnly.samplerGap.ms, 100)
    assert.equal(mainOnly.workerGapOverHoleMs, 10, 'the worker kept its 10 ms cadence')
    assert.equal(mainOnly.reading, 'main thread only (worker kept its cadence, other cells ran)')
    assert.deepEqual(mainOnly.otherCells.map((other) => [other.cellId, other.samplerGapMs, other.workerGapMs]), [['failover-cell-b', 1, 10]])
    assert.equal(vmWide.samplerGap.ms, 100)
    assert.equal(vmWide.workerGapOverHoleMs, 100)
    assert.equal(vmWide.reading, 'VM-wide: main, worker and every other cell stopped')
    assert.equal(report.controls.length, 3, 'controls come from the runs that had a stall')
    assert.ok(report.controls.filter((row) => row.cellId === 'failover-cell-a').every((row) => row.reading === 'no sampler hole'))
    assert.deepEqual(report.steal.map((row) => [row.cellId, row.stealTicks, row.blind]), [['failover-cell-a', 0, true], ['failover-cell-b', 0, true]])
    const forward = report.tasks.forwardRetiredHead
    assert.equal(forward['0–2 s'].tasks, 1)
    assert.equal(forward['0–2 s'].unsampledMs.max, 0)
    assert.equal(forward['9–12 s'].tasks, 1)
    assert.equal(forward['9–12 s'].unsampledMs.max, 15, '20 ms hole, 5 ms of it credited to the sample before')
    assert.equal(report.samplerHoles.total, 3)
    const markdown = readFileSync(join(root, 'stall-deep.md'), 'utf8')
    assert.match(markdown, /VM-wide/)
    assert.match(markdown, /forwardRetiredHead tasks/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
