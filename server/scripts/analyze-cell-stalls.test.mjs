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
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  AnalysisRefusal, analyze, category, jsonFieldFromPrefix, loadCaptureDir, longestBusyRun, longestTask, main, readBenchLog, readLines, parseBenchLog, parseContainerLines, parseIsoMs,
  renderMarkdown, windowsFromFacts,
} from './analyze-cell-stalls.mjs'

// ── A synthetic soak: two cells, one captured, 20 s, a 110 ms stall ─────────
//
// Cell clock T0 = 10:00:00Z, hrtime anchor H0. sync-cell-b is captured with
// 1 ms samples in two OVERLAPPING chunks (roll at ~9.99 s, 5.2 ms main-thread
// cost). Its normal load is a 3 ms stats task every 50 ms; at 4.100–4.210 s
// one task runs 110 ms: Automerge receive in wasm, a 15 ms major GC inside it,
// then 5 ms of Automerge JS. A rotation was logged on sync-cell-a 12 s before
// the stalled window. sync-cell-a also has a > 70 ms window but no capture run.
const T0 = Date.parse('2026-11-04T10:00:00.000Z')
const H0 = 5_000_000_000
const BOOT_B = '22222222-2222-4222-8222-222222222222'
const BOOT_A = '11111111-1111-4111-8111-111111111111'

const frame = (functionName, url = '', lineNumber = -1) => ({ functionName, scriptId: '0', url, lineNumber, columnNumber: -1 })
const NODES = [
  { id: 1, callFrame: frame('(root)'), children: [2, 3, 4, 5] },
  { id: 2, callFrame: frame('(idle)'), children: [] },
  { id: 3, callFrame: frame('(garbage collector)'), children: [] },
  { id: 4, callFrame: frame('processTicksAndRejections', 'node:internal/process/task_queues', 94), children: [6] },
  { id: 5, callFrame: frame('handleStats', 'file:///app/dist/index.js', 3770), children: [8] },
  { id: 6, callFrame: frame('receiveSyncMessage', 'file:///app/node_modules/@automerge/automerge/dist/mjs/implementation.js', 801), children: [7] },
  { id: 7, callFrame: frame('automerge_wasm::sync::receive', 'wasm://wasm/0012abcd', 0), children: [] },
  { id: 8, callFrame: frame('stringify'), children: [] },
]
function nodeAt(ms) {
  // A 115 ms block that ENDS 5 ms before the 6 s window starts: the gate
  // charges it to that window (reset order), whose own span is quiet.
  if (ms >= 5880 && ms < 5995) return 7
  if (ms >= 4100 && ms < 4210) return ms >= 4150 && ms < 4165 ? 3 : ms >= 4205 ? 6 : 7
  const phase = ms % 50
  return phase === 0 ? 5 : phase < 3 ? 8 : 2
}
function profile(fromMs, toMs, startUs) {
  const samples = []
  const timeDeltas = []
  let previous = startUs
  for (let ms = fromMs; ms < toMs; ms++) {
    const time = H0 + ms * 1000
    samples.push(nodeAt(ms))
    timeDeltas.push(time - previous)
    previous = time
  }
  return { nodes: NODES, startTime: startUs, endTime: previous + 700, samples, timeDeltas }
}

function writeFixture(root, { breakClock = false, wallStep = 0 } = {}) {
  const run = join(root, `failover-cell-b-${BOOT_B}`)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'manifest.json'), JSON.stringify({ bootId: BOOT_B, cellId: 'failover-cell-b', samplingIntervalUs: 1000, chunkSeconds: 10,
    anchor: { wallMs: T0 - 50, perfMs: 0, hrUs: H0 - 50_000 }, bootChunk: null }))
  const chunk1 = profile(0, 9995, breakClock ? H0 + 2_000_000 : H0 - 500)
  const chunk2 = profile(9990, 20_000, H0 + 9_989_650)
  writeFileSync(join(run, 'cpu-000001.cpuprofile.gz'), gzipSync(JSON.stringify(chunk1)))
  writeFileSync(join(run, 'cpu-000002.cpuprofile.gz'), gzipSync(JSON.stringify(chunk2)))
  const events = [
    { type: 'roll', reason: 'roll', ended: null, started: 'maplespire-cpu-000001', startedSeq: 1, wallMsBefore: T0 - 0.6, hrUsBefore: H0 - 600,
      hrUsAfterStart: H0 - 400, hrUsAfterEnd: H0 - 390, wallMsAfter: T0 - 0.39 },
    { type: 'chunk', seq: 1, file: 'cpu-000001.cpuprofile.gz', startTime: chunk1.startTime, endTime: chunk1.endTime, samples: chunk1.samples.length },
    { type: 'roll', reason: 'roll', ended: 'maplespire-cpu-000001', started: 'maplespire-cpu-000002', startedSeq: 2, wallMsBefore: T0 + 9989.6 + wallStep,
      hrUsBefore: H0 + 9_989_600, hrUsAfterStart: H0 + 9_989_700, hrUsAfterEnd: H0 + 9_994_800, wallMsAfter: T0 + 9994.8 },
    { type: 'chunk', seq: 2, file: 'cpu-000002.cpuprofile.gz', startTime: chunk2.startTime, endTime: chunk2.endTime, samples: chunk2.samples.length },
    { type: 'stop', reason: 'SIGTERM', finalChunkWritten: true },
  ]
  writeFileSync(join(run, 'events.ndjson'), events.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  // schedstat every 10 ms: idle 3/50 of the time; during the stall the main
  // thread is on CPU for 80 ms and waits 30 ms for a CPU. Steal 25 % then.
  const rows = []
  const steal = []
  let runNs = 0
  let waitNs = 0
  let stealTicks = 0
  let totalTicks = 0
  for (let ms = 0; ms <= 20_000; ms += 10) {
    rows.push([H0 + ms * 1000, runNs, waitNs, ms / 10])
    if (ms % 100 === 0) steal.push([H0 + ms * 1000, stealTicks, totalTicks])
    const stalled = ms >= 4100 && ms < 4210
    runNs += stalled ? (ms < 4180 ? 10e6 : 0) : 0.6e6
    waitNs += stalled && ms >= 4180 ? 10e6 : 0
    if (ms % 100 === 0) { totalTicks += 60; stealTicks += ms >= 4100 && ms < 4200 ? 15 : 0 }
  }
  writeFileSync(join(run, 'sched-000002.json.gz'), gzipSync(JSON.stringify({ columns: ['hrUs', 'runNs', 'waitNs', 'slices'], rows,
    steal: { columns: ['hrUs', 'stealTicks', 'totalTicks'], rows: steal } })))
  writeFileSync(join(run, 'gc.ndjson'), [
    { hrUs: H0 + 1_000_000, durUs: 800, kind: 'minor', kindCode: 1, flags: 0 },
    { hrUs: H0 + 4_150_000, durUs: 15_000, kind: 'major', kindCode: 4, flags: 0 },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  mkdirSync(join(root, 'compose-logs'), { recursive: true })
  writeFileSync(join(root, 'compose-logs', 'sync-cell-a.log'), [
    `sync-cell-a-1  | ${new Date(T0 - 8000).toISOString().replace('Z', '000000Z')} {"event":"read_model.ordinary_head_rotated","workspace":"l1/v1"}`,
    `sync-cell-a-1  | ${new Date(T0 + 4300).toISOString()} plain text line`,
  ].join('\n'))
}

function benchLog() {
  const lines = ['[bench] image x · commit y']
  for (let index = 0; index < 40; index++) {
    const start = T0 + index * 500
    const p99 = (service) => service === 'sync-cell-b' ? (index === 8 ? 104.5 : index === 19 ? 75 : index === 12 ? 90 : 20.3) : (index === 4 ? 80 : 20.1)
    const cell = (service, boot) => ({ service, processBootId: boot, cellId: service.replace('sync-', 'failover-'), eventLoopP99Ms: p99(service),
      eventLoopExcluded: false, eventLoopWindow: { startedAt: new Date(start).toISOString(), resetCount: index + 1, lastResetBy: 'consume' } })
    lines.push(`G47_EVENT ${JSON.stringify({ kind: 'sample', observedAt: start + 503, elapsedMs: index * 500, phase: 'soak', cycle: 1,
      cells: [cell('sync-cell-a', BOOT_A), cell('sync-cell-b', BOOT_B)] })}`)
  }
  lines.push(`G47_EVENT ${JSON.stringify({ kind: 'criterion-failed', criterion: 'event-loop', value: 104.5, service: 'sync-cell-b' })}`)
  lines.push(JSON.stringify({ task: 'G4-7', status: 'FAIL', firstFailure: { criterion: 'event-loop', value: 104.5, service: 'sync-cell-b', phase: 'soak', cycle: 1 } }))
  return lines.join('\n')
}

test('parsing: ISO with nanoseconds, bench samples, window closure, container lines', () => {
  assert.equal(parseIsoMs('2026-11-04T10:00:00.123456789Z'), T0 + 123.456789)
  const bench = parseBenchLog(benchLog())
  assert.equal(bench.facts.length, 80)
  assert.equal(bench.summary.firstFailure.value, 104.5)
  assert.equal(bench.failures.length, 1)
  const windows = windowsFromFacts(bench.facts)
  const stalled = windows.find((window) => window.service === 'sync-cell-b' && window.p99 === 104.5)
  assert.deepEqual([stalled.windowStartMs - T0, stalled.windowEndMs - T0, stalled.endEstimated], [4000, 4500, false])
  assert.equal(windows.filter((window) => window.endEstimated).length, 2, 'only the last window of each process is estimated')
  const events = parseContainerLines([`sync-cell-c-1  | 2026-11-04T10:00:01.5Z {"event":"x","a":1}`, '2026-11-04T10:00:02Z hello', 'noise'], 'fallback')
  // Only JSON lines with an event are kept; plain text is dropped.
  assert.deepEqual(events.map((entry) => [entry.service, entry.atMs - T0, entry.event]), [['sync-cell-c', 1500, 'x']])
})

test('categories and the busy run', () => {
  assert.equal(category([frame('(garbage collector)')]), 'gc')
  assert.equal(category([frame('automerge_wasm::sync::receive', 'wasm://wasm/1')]), 'wasm')
  assert.equal(category([frame('receiveSyncMessage', 'file:///app/node_modules/@automerge/automerge/x.js')]), 'automerge-js')
  assert.equal(category([frame('stringify')]), 'json')
  assert.equal(category([frame('emit', 'node:events')]), 'node/native')
  assert.equal(category([frame('route', 'file:///app/dist/index.js')]), 'app')
  const idle = { stack: [frame('(idle)')], nextUs: 1000 }
  const busy = (hrUs) => ({ hrUs, stack: [frame('work', 'file:///app/dist/a.js')], nextUs: 1000 })
  const run = longestBusyRun([{ ...idle, hrUs: 0 }, busy(1000), { ...idle, hrUs: 2000 }, busy(3000), busy(4000), busy(5000), { ...idle, hrUs: 6000 }], 1000)
  assert.deepEqual([run.from, run.to, run.durationUs], [3, 6, 3000])
  // Tasks split where the root changes; GC samples stay with their task.
  const rooted = (hrUs, root) => ({ hrUs, stack: [frame('work', 'file:///app/dist/a.js'), frame(root, 'node:internal/timers')], nextUs: 1000 })
  const gc = (hrUs) => ({ hrUs, stack: [frame('(garbage collector)')], nextUs: 1000 })
  const chained = [rooted(0, 'processImmediate'), gc(1000), rooted(2000, 'processImmediate'), rooted(3000, 'listOnTimeout'), rooted(4000, 'listOnTimeout')]
  assert.equal(longestBusyRun(chained, 1000).durationUs, 5000)
  const task = longestTask(chained, 1000)
  assert.deepEqual([task.from, task.to, task.durationUs, task.root], [0, 3, 3000, 'processImmediate node:internal/timers:0'])
})

test('a synthetic soak: the stall is found, explained against baseline, and its context reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cell-stalls-'))
  try {
    writeFixture(root)
    const benchFile = join(root, 'bench.log')
    writeFileSync(benchFile, benchLog())
    const report = await main([`--bench-log=${benchFile}`, `--capture-dir=${root}`, '--threshold-ms=70'])
    // The default input is the gate log the bench tees into the capture dir.
    writeFileSync(join(root, 'gate.log'), benchLog())
    assert.equal((await main([`--capture-dir=${root}`, `--out=${join(root, 'again')}`])).stalls.length, 4)
    assert.equal(report.stalls.length, 4)
    assert.deepEqual(report.windows.byService['sync-cell-b'], { windows: 40, over70: 3, over100: 1, maxP99Ms: 104.5 })
    assert.deepEqual(report.capture[0].wallClockSteps, [])
    assert.equal(report.capture.length, 1)
    assert.equal(report.capture[0].clockDomainOk, true)
    assert.deepEqual(report.capture[0].unprofiledGapsMs, { totalMs: 0, maxMs: 0 }, 'overlapping chunks leave no gap')
    assert.deepEqual(report.capture[0].rollMainThreadMs, { count: 1, p50: 5.2, p99: 5.2, max: 5.2, firstRollMs: 0.21 })

    const stall = report.stalls.find((entry) => entry.p99Ms === 104.5)
    assert.equal(stall.service, 'sync-cell-b')
    assert.equal(stall.gateFailing, true)
    assert.equal(stall.coverage, 1)
    assert.equal(stall.clockDomainOk, true)
    // Analysed from 150 ms before the window start.
    assert.equal(stall.extensionMs, 150)
    assert.deepEqual([stall.sampler.samples, stall.sampler.lostSamplesEstimate], [650, 0])
    assert.equal(stall.tightRun.durationMs, 110)
    assert.equal(stall.tightRun.sampledMs, 110)
    assert.equal(stall.tightRun.attributedFrom, 'this window')
    assert.deepEqual([stall.longestTask.durationMs, stall.longestTask.root], [110, 'processTicksAndRejections node:internal/process/task_queues:95'])
    assert.equal(stall.tightRun.start, new Date(T0 + 4100).toISOString())
    assert.deepEqual(stall.tightRun.aggregate.categories, { wasm: 90, gc: 15, 'automerge-js': 5 })
    assert.equal(stall.tightRun.aggregate.self[0].key, 'automerge_wasm::sync::receive wasm://wasm/0012abcd:1')
    const inclusive = Object.fromEntries(stall.tightRun.aggregate.inclusive.map((row) => [row.key, row.ms]))
    assert.equal(inclusive['processTicksAndRejections node:internal/process/task_queues:95'], 95)
    assert.equal(inclusive['receiveSyncMessage @automerge/automerge/dist/mjs/implementation.js:802'], 95)
    assert.deepEqual(stall.gc.map((entry) => [entry.kind, entry.durationMs, entry.inTightRun]), [['major', 15, true]])
    assert.equal(stall.gcMsInTightRun, 15)
    assert.deepEqual(stall.rollsOverlapping, [])
    // The scheduler's account of the busy run: 80 ms on CPU, 30 ms waiting.
    assert.deepEqual(stall.scheduling.busyRun, { spanMs: 110, onCpuMs: 80, runQueueMs: 30, offCpuMs: 0, timeslices: 11, readingGapMs: 0, vmStealShare: 0.125 })
    assert.equal(stall.scheduling.window.spanMs, 650)
    assert.equal(stall.scheduling.window.runQueueMs, 30)
    assert.deepEqual(stall.lastRotation, { service: 'sync-cell-a', at: '2026-11-04T09:59:52.000Z', msBeforeWindowStart: 12000, sameCell: false, workspace: 'l1/v1' })
    // Baseline: 12 quiet windows of cell b, none overlapping a roll; their
    // longest task is the 3 ms stats task, so the stall's EXCESS is the wasm.
    assert.equal(stall.baseline.windows, 12)
    assert.deepEqual(stall.baseline.longestTaskMs, { mean: 3, max: 3 })
    assert.equal(stall.baseline.excessBusyRun.self[0].key, 'automerge_wasm::sync::receive wasm://wasm/0012abcd:1')
    assert.equal(stall.baseline.excessBusyRun.self[0].excessMs, 90)
    assert.ok(stall.baseline.excessBusyRun.self.some((row) => row.key === '(garbage collector)' && row.excessMs === 15))
    assert.equal(stall.baseline.excessWindow.self[0].key, 'automerge_wasm::sync::receive wasm://wasm/0012abcd:1')

    // The window across the roll is flagged, and its samples are taken once.
    const acrossRoll = report.stalls.find((entry) => entry.p99Ms === 75)
    assert.deepEqual(acrossRoll.rollsOverlapping.map((roll) => roll.mainThreadMs), [5.2])
    assert.equal(acrossRoll.sampler.samples, 650, 'the 5 ms both chunks sampled are counted once')

    // A block that ended just before the window it was charged to.
    const charged = report.stalls.find((entry) => entry.p99Ms === 90)
    assert.equal(charged.tightRun.durationMs, 115)
    assert.match(charged.tightRun.attributedFrom, /^previous window/)
    // Its baselines exclude every span touching the stalled 6 s window.
    assert.ok(stall.baseline.windows === 12)
    assert.equal(acrossRoll.coverage, 1)

    // A process with no capture is UNCOVERED, never filled in.
    const uncovered = report.stalls.find((entry) => entry.service === 'sync-cell-a')
    assert.equal(uncovered.coverage, 'no-capture-run')

    const markdown = readFileSync(join(root, 'stall-report.md'), 'utf8')
    assert.match(markdown, /### 1\. sync-cell-a/)
    assert.match(markdown, /automerge_wasm::sync::receive/)
    assert.match(markdown, /UNCOVERED/)
    assert.match(markdown, /busy run: on CPU 80, wait 30, off 0 of 110 ms/)
    assert.match(markdown, /attributed from previous window/)
    assert.match(markdown, /sampler-gap time is excluded/)
    assert.match(markdown, /12 s \(sync-cell-a, other\)/)
    assert.equal(JSON.parse(readFileSync(join(root, 'stall-report.json'), 'utf8')).stalls.length, 4)
    assert.equal(renderMarkdown(report), markdown)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a chunk that did not start inside its hrtime bracket marks the clock domain unverified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cell-stalls-clock-'))
  try {
    writeFixture(root, { breakClock: true, wallStep: 8 })
    const runs = await loadCaptureDir(root)
    assert.equal(runs[0].clockChecks.find((check) => check.seq === 1).ok, false)
    const report = analyze({ benchLogText: benchLog(), runs, thresholdMs: 100 })
    assert.equal(report.stalls.length, 1)
    assert.equal(report.stalls[0].clockDomainOk, false)
    assert.match(renderMarkdown(report), /clock domain NOT VERIFIED/)
    // A wall-clock step between anchors is detected and flagged.
    assert.deepEqual(report.capture[0].wallClockSteps.map((step) => step.stepMs), [8])
    assert.match(renderMarkdown(report), /wall clock stepped 1 time/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the CLI refuses missing inputs, an empty log and a log from another run', async () => {
  await assert.rejects(main(['--bench-log=x']), /usage: analyze-cell-stalls\.mjs/)
  await assert.rejects(main(['--capture-dir=/nonexistent-capture']), /no gate log at/)
  assert.throws(() => analyze({ benchLogText: 'nothing here', runs: [] }), (error) => error instanceof AnalysisRefusal && /no G47_EVENT sample window/.test(error.message))
  assert.throws(() => analyze({ benchLogText: benchLog(), runs: [] }), /none of the 80 sample windows belongs to a capture run/)
  await assert.rejects(main(['--bench-log=x', '--capture-dir=y', '--threshold-ms=-1']), /positive number/)
})

// ── Bounded memory ───────────────────────────────────────────────────────────

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'analyze-cell-stalls.mjs')

test('no log is ever read whole: readFileSync only on the manifest and on gz chunks, one at a time', () => {
  const source = readFileSync(scriptPath, 'utf8')
  const reads = [...source.matchAll(/readFileSync\(([^)]*)\)/g)].map((match) => match[1])
  assert.ok(reads.length > 0)
  for (const argument of reads) {
    assert.match(argument, /manifest\.json'|chunk\.file$|^join\(directory, file$/, `readFileSync(${argument}) must not read a log`)
  }
})

test('a 160 MB gate log is analysed under a 48 MB heap (a whole-file read dies there)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cell-stalls-big-'))
  try {
    writeFixture(root)
    // Junk lines the gate does print (load-client chatter, big G47 records)
    // around the real sample lines, ~160 MB in all.
    const junk = Buffer.from(`${`G47_EVENT {"kind":"episode","record":"${'x'.repeat(150)}"}\n`}${'load-user noise '.repeat(4)}\n`.repeat(4000))
    const file = join(root, 'gate.log')
    const fd = openSync(file, 'w')
    const lines = benchLog().split('\n')
    const step = Math.ceil(lines.length / 160)
    for (let index = 0; index < 160; index++) {
      writeSync(fd, junk)
      writeSync(fd, `${lines.slice(index * step, (index + 1) * step).join('\n')}\n`)
    }
    closeSync(fd)
    assert.ok(statSync(file).size > 150_000_000)
    const began = Date.now()
    const child = spawnSync(process.execPath, ['--max-old-space-size=48', scriptPath, `--capture-dir=${root}`], { encoding: 'utf8', timeout: 120_000 })
    assert.equal(child.status, 0, child.stderr)
    const out = JSON.parse(child.stdout.trim().split('\n').at(-1))
    assert.equal(out.stalls, 4)
    const report = JSON.parse(readFileSync(join(root, 'stall-report.json'), 'utf8'))
    assert.ok(report.input.benchLogLines > 600_000)
    process.stdout.write(`# analysed ${Math.round(statSync(file).size / 1e6)} MB in ${Date.now() - began} ms\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lines: CRLF, a missing final newline, and a line too long to hold — kept as a flagged prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cell-stalls-lines-'))
  try {
    const file = join(root, 'lines.log')
    const huge = `{"task":"G4-7","status":"FAIL","firstFailure":{"criterion":"event-loop","value":100.27,"service":"sync-cell-a","note":"a } in \\"text\\""},"episodes":[${'1,'.repeat(10_000_000)}1]}`
    writeFileSync(file, `one\r\ntwo\n${huge}\nlast`)
    const seen = []
    await readLines(file, (line, truncated) => seen.push([line.length > 100 ? `${line.slice(0, 15)}…` : line, truncated]))
    assert.deepEqual(seen, [['one', false], ['two', false], ['{"task":"G4-7",…', true], ['last', false]])
    // The summary survives the truncation.
    writeFileSync(file, `${benchLog()}\n${huge}\n`)
    const bench = await readBenchLog(file)
    assert.equal(bench.facts.length, 80)
    assert.deepEqual(bench.summary, { source: 'task', truncatedLine: true, task: 'G4-7', status: 'FAIL',
      firstFailure: { criterion: 'event-loop', value: 100.27, service: 'sync-cell-a', note: 'a } in "text"' }, actualSoakMs: null, durationCompleted: null })
    assert.equal(jsonFieldFromPrefix('{"a":{"b":[1,{"c":"]"}]},"d":2', 'a').b[1].c, ']')
    assert.equal(jsonFieldFromPrefix('{"a":{"b":', 'a'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
