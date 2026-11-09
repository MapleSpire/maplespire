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

/**
 * WHO STOPPED: the main thread alone, the whole process, or the whole VM?
 * A read-only second pass over an existing `--cpu-profile=on` capture, for
 * stalls where the main thread was neither on CPU nor runnable and the V8
 * sampler went silent (run-01, sync-cell-a, 100.27 ms).
 *
 *   node scripts/analyze-cell-stalls-deep.mjs --capture-dir=<dir>
 *        [--bench-log=<file>, default <dir>/gate.log] [--threshold-ms=70]
 *        [--controls=10] [--gap-ms=50] [--out=<dir>]
 *
 * Writes `stall-deep.md` and `stall-deep.json` (default: into the capture dir).
 *
 * THE WITNESSES, all already in the capture:
 *   - the MAIN thread's sampler: gaps between consecutive V8 profile samples
 *     (`timeDeltas`; 1 ms nominal);
 *   - the capture WORKER thread: its schedstat readings are taken on a 10 ms
 *     timer in that worker, so the spacing of their `hrUs` stamps is the
 *     worker's own liveness — a hole there means the worker did not run;
 *   - the OTHER cells' main samplers and workers over the same wall interval
 *     (one VM kernel, one monotonic clock);
 *   - VM steal from `/proc/stat` over the whole run.
 * Reading: a gap in the main sampler only ⇒ the main thread alone (D-state,
 * one vCPU not dispatched); in the worker too ⇒ the whole process; in other
 * cells too ⇒ VM-wide (host preemption). Steal that never moves in a whole
 * run means the counter is blind on that host, not that there was none.
 *
 * PLUS, over EVERY task of the run (not only stall windows): time the sampler
 * did not cover inside `forwardRetiredHead` tasks (duration − sampled), by
 * band after the last rotation on any cell (0–2 s / 9–12 s / elsewhere), with
 * all tasks ≥ 20 ms as the control population.
 *
 * Memory stays bounded: logs streamed, one profile chunk decoded at a time.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  candidateWindows, containerEventsFromFiles, hrToWall, isIdle, loadCaptureDir, readBenchLog, samplesBetween,
  schedulingBetween, taskRoot, wallToHr, windowsFromFacts,
} from './analyze-cell-stalls.mjs'

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
const iso = (ms) => new Date(ms).toISOString()

/** The longest hole between consecutive samples (or readings) that overlaps
 * [fromHr, toHr]. `times` is sorted hrUs. Returns { fromHr, toHr, ms } or null. */
export function longestGapOverlapping(times, fromHr, toHr) {
  let best = null
  for (let index = 1; index < times.length; index++) {
    const a = times[index - 1]
    const b = times[index]
    if (b < fromHr || a > toHr) continue
    if (!best || b - a > best.toHr - best.fromHr) best = { fromHr: a, toHr: b }
  }
  return best ? { ...best, ms: round((best.toHr - best.fromHr) / 1000) } : null
}

/** Worker reading stamps (hrUs) between two instants, from the run's columns. */
export function workerStamps(run, fromHr, toHr) {
  const rows = run.sched?.rows
  if (!rows?.count) return []
  const first = Math.max(0, rows.floor(fromHr))
  const stamps = []
  for (let index = first; index < rows.count; index++) {
    const at = rows.at(index, 0)
    stamps.push(at)
    if (at > toHr) break
  }
  return stamps
}

/** Main-sampler stamps between two instants (one chunk at a time). */
const samplerStamps = (run, fromHr, toHr) => samplesBetween(run, fromHr, toHr).samples.map((sample) => sample.hrUs)

/** The run of a cell that was alive at a wall instant (its chunks cover it). */
function runAt(runs, cellId, wallMs) {
  return runs.find((run) => run.manifest.cellId === cellId && run.chunks.length
    && hrToWall(run, run.chunks[0].startTime) <= wallMs && hrToWall(run, run.chunks.at(-1).endTime) >= wallMs) ?? null
}

/** Every witness for one wall interval of one run. */
export function witnesses(runs, run, fromWall, toWall) {
  const fromHr = wallToHr(run, fromWall)
  const toHr = wallToHr(run, toWall)
  const pad = 200_000
  const sampler = longestGapOverlapping(samplerStamps(run, fromHr - pad, toHr + pad), fromHr, toHr)
  // The worker over the SAMPLER's hole when there is one, else over the window.
  const [holeFrom, holeTo] = sampler && sampler.ms > 20 ? [sampler.fromHr, sampler.toHr] : [fromHr, toHr]
  const worker = longestGapOverlapping(workerStamps(run, holeFrom - pad, holeTo + pad), holeFrom, holeTo)
  const workerInWindow = longestGapOverlapping(workerStamps(run, fromHr - pad, toHr + pad), fromHr, toHr)
  const mainDuringHole = sampler && sampler.ms > 20 ? schedulingBetween(run, sampler.fromHr, sampler.toHr) : null
  const holeWall = [hrToWall(run, holeFrom), hrToWall(run, holeTo)]
  const others = []
  for (const cellId of [...new Set(runs.map((entry) => entry.manifest.cellId))].filter((id) => id !== run.manifest.cellId)) {
    const other = runAt(runs, cellId, holeWall[0])
    if (!other) { others.push({ cellId, run: null }); continue }
    const oFrom = wallToHr(other, holeWall[0])
    const oTo = wallToHr(other, holeWall[1])
    const oSampler = longestGapOverlapping(samplerStamps(other, oFrom - pad, oTo + pad), oFrom, oTo)
    const oWorker = longestGapOverlapping(workerStamps(other, oFrom - pad, oTo + pad), oFrom, oTo)
    others.push({ cellId, run: other.name, samplerGapMs: oSampler?.ms ?? null, workerGapMs: oWorker?.ms ?? null,
      samplerGapAt: oSampler ? iso(hrToWall(other, oSampler.fromHr)) : null })
  }
  const holeMs = sampler?.ms ?? 0
  const share = (ms) => (ms ?? 0) / Math.max(holeMs, 1)
  // Stopped = a hole of at least half the main sampler's, and clearly above
  // that witness's own cadence (worker 10 ms with ~15 ms jitter; sampler ~1 ms).
  const live = others.filter((entry) => entry.run)
  const workerOut = (ms) => share(ms) >= 0.5 && (ms ?? 0) >= 25
  const samplerOut = (ms) => share(ms) >= 0.5 && (ms ?? 0) >= 10
  const workerStopped = workerOut(worker?.ms)
  const othersStopped = live.filter((entry) => samplerOut(entry.samplerGapMs) || workerOut(entry.workerGapMs)).length
  const reading = holeMs <= 20 ? 'no sampler hole'
    : workerStopped && live.length > 0 && othersStopped === live.length ? 'VM-wide: main, worker and every other cell stopped'
      : workerStopped && othersStopped > 0 ? 'process-wide, and some other cells stopped'
        : workerStopped ? 'process-wide (main + worker); other cells ran'
          : othersStopped > 0 ? 'main thread only here (worker ran), other cells also had a hole'
            : 'main thread only (worker kept its cadence, other cells ran)'
  return {
    samplerGap: sampler ? { ms: sampler.ms, from: iso(hrToWall(run, sampler.fromHr)), to: iso(hrToWall(run, sampler.toHr)) } : null,
    workerGapOverHoleMs: worker?.ms ?? null, workerGapInWindowMs: workerInWindow?.ms ?? null,
    workerReadings: run.sched?.rows?.count ?? 0, mainThreadDuringHole: mainDuringHole, otherCells: others, reading,
  }
}

/** Whole-run VM steal per run: exactly 0 ticks ⇒ the counter is blind there. */
export function stealTotals(run) {
  const steal = run.sched?.steal
  if (!steal?.count) return { readings: 0 }
  const last = steal.count - 1
  const ticks = steal.at(last, 1) - steal.at(0, 1)
  const total = steal.at(last, 2) - steal.at(0, 2)
  return { readings: steal.count, stealTicks: ticks, totalTicks: total, share: total > 0 ? round(ticks / total, 6) : null,
    blind: ticks === 0 }
}

/** Every task of a sample sequence (busy samples split by task root). */
export function tasksOf(samples, intervalUs) {
  const tasks = []
  let start = -1
  let root = null
  let sampledUs = 0
  let forward = false
  const close = (end) => {
    if (start < 0) return
    const first = samples[start]
    const last = samples[end - 1]
    tasks.push({ fromHr: first.hrUs, durationUs: last.hrUs + Math.min(last.nextUs, 5 * intervalUs) - first.hrUs, sampledUs, root, forward,
      samples: end - start })
    start = -1; root = null; sampledUs = 0; forward = false
  }
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]
    if (isIdle(sample)) { close(index); continue }
    const key = taskRoot(sample)
    if (start >= 0 && key !== null && root !== null && key !== root) close(index)
    if (start < 0) start = index
    if (root === null) root = key
    sampledUs += Math.min(Math.max(sample.nextUs, 0), 5 * intervalUs)
    if (!forward && sample.stack.some((frame) => frame.functionName === 'forwardRetiredHead')) forward = true
  }
  close(samples.length)
  return tasks
}

export const bandOf = (sinceRotationMs) => sinceRotationMs === null || sinceRotationMs < 0 ? 'elsewhere'
  : sinceRotationMs < 2000 ? '0–2 s' : sinceRotationMs >= 9000 && sinceRotationMs < 12_000 ? '9–12 s' : 'elsewhere'

function distribution(values) {
  if (!values.length) return { count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
  return { count: sorted.length, sumMs: round(sorted.reduce((a, b) => a + b, 0)), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: round(sorted.at(-1)) }
}

/**
 * The gate PAUSES the partition owner (`docker compose pause`) for the
 * takeover: that cell has no sample window for those seconds, then one
 * excluded drain window. A hole or task there is the harness, not a stall.
 */
export function gatePauses(windows) {
  const byBoot = new Map()
  for (const window of windows) {
    if (!byBoot.has(window.processBootId)) byBoot.set(window.processBootId, [])
    byBoot.get(window.processBootId).push(window)
  }
  const pauses = new Map()
  for (const [boot, list] of byBoot) {
    list.sort((a, b) => a.windowStartMs - b.windowStartMs)
    const spans = []
    for (const window of list) if (window.excluded) spans.push([window.windowStartMs, window.windowEndMs])
    for (let index = 1; index < list.length; index++) {
      if (list[index].windowStartMs - list[index - 1].windowEndMs > 1000) spans.push([list[index - 1].windowEndMs, list[index].windowStartMs])
    }
    pauses.set(boot, spans)
  }
  return (bootId, fromMs, toMs) => (pauses.get(bootId) ?? []).some(([from, to]) => fromMs < to && toMs > from)
}

/** Walk every chunk of every run once; bounded by one chunk. */
export function taskCensus(runs, rotationsMs, gapMs, paused = () => false) {
  const bands = ['0–2 s', '9–12 s', 'elsewhere']
  const forward = Object.fromEntries(bands.map((band) => [band, { unsampled: [], share: [], duration: [] }]))
  const control = Object.fromEntries(bands.map((band) => [band, { unsampled: [], share: [], duration: [] }]))
  const samplerHoles = []
  const sinceRotation = (wallMs) => {
    let lo = 0
    let hi = rotationsMs.length - 1
    let found = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rotationsMs[mid] <= wallMs) { found = mid; lo = mid + 1 } else hi = mid - 1 }
    return found < 0 ? null : wallMs - rotationsMs[found]
  }
  for (const run of runs) {
    const intervalUs = run.manifest.samplingIntervalUs
    for (let index = 0; index < run.chunks.length; index++) {
      const chunk = run.chunks[index]
      const next = run.chunks[index + 1]
      const { samples } = samplesBetween(run, chunk.startTime, next ? next.startTime : chunk.endTime + 1)
      for (let i = 1; i < samples.length; i++) {
        const delta = samples[i].hrUs - samples[i - 1].hrUs
        if (delta >= gapMs * 1000) {
          const fromWall = hrToWall(run, samples[i - 1].hrUs)
          samplerHoles.push({ run: run.name, cellId: run.manifest.cellId, fromHr: samples[i - 1].hrUs, ms: round(delta / 1000),
            busyBefore: !isIdle(samples[i - 1]), busyAfter: !isIdle(samples[i]), gatePause: paused(run.manifest.bootId, fromWall, fromWall + delta / 1000) })
        }
      }
      for (const task of tasksOf(samples, intervalUs)) {
        const durationMs = task.durationUs / 1000
        if (!task.forward && durationMs < 20) continue
        const wall = hrToWall(run, task.fromHr)
        if (paused(run.manifest.bootId, wall, wall + durationMs)) continue
        const band = bandOf(sinceRotation(wall))
        const unsampledMs = Math.max(0, (task.durationUs - task.sampledUs) / 1000)
        for (const [target, include] of [[forward, task.forward], [control, durationMs >= 20]]) {
          if (!include) continue
          target[band].unsampled.push(unsampledMs)
          target[band].share.push(durationMs > 0 ? unsampledMs / durationMs : 0)
          target[band].duration.push(durationMs)
        }
      }
      run.cache.clear()
    }
  }
  const summarize = (table) => Object.fromEntries(Object.entries(table).map(([band, values]) => [band, {
    tasks: values.unsampled.length, unsampledMs: distribution(values.unsampled), durationMs: distribution(values.duration),
    unsampledShareMean: values.share.length ? round(values.share.reduce((a, b) => a + b, 0) / values.share.length, 3) : null,
  }]))
  return { forwardRetiredHead: summarize(forward), allTasksOver20ms: summarize(control), samplerHoles }
}

/** Sampler holes ≥ gapMs on one cell: did the worker, and the other cells, stop too? */
function holeCensus(runs, holes, top = 40) {
  const sorted = holes.filter((hole) => !hole.gatePause).sort((a, b) => b.ms - a.ms).slice(0, top)
  return sorted.map((hole) => {
    const run = runs.find((entry) => entry.name === hole.run)
    const fromWall = hrToWall(run, hole.fromHr)
    const w = witnesses(runs, run, fromWall, fromWall + hole.ms)
    return { cellId: hole.cellId, at: iso(fromWall), samplerGapMs: hole.ms, busyBefore: hole.busyBefore, busyAfter: hole.busyAfter,
      workerGapMs: w.workerGapOverHoleMs, mainOnCpuMs: w.mainThreadDuringHole?.onCpuMs ?? null, mainOffCpuMs: w.mainThreadDuringHole?.offCpuMs ?? null,
      otherCells: w.otherCells.map((other) => ({ cellId: other.cellId, samplerGapMs: other.samplerGapMs, workerGapMs: other.workerGapMs })), reading: w.reading }
  })
}

function spreadQuiet(windows, run, count) {
  const quiet = windows.filter((window) => window.processBootId === run.manifest.bootId && window.kind === 'sample' && !window.excluded && window.p99 < 30)
  if (quiet.length <= count) return quiet
  return Array.from({ length: count }, (_, index) => quiet[Math.floor((index + 0.5) * quiet.length / count)])
}

export async function deep({ benchLog, captureDir, thresholdMs = 70, controls = 10, gapMs = 50 }) {
  const bench = await readBenchLog(benchLog)
  const windows = windowsFromFacts(bench.facts)
  const runs = await loadCaptureDir(captureDir)
  const stalls = candidateWindows(bench, thresholdMs)
  const events = await containerEventsFromFiles(captureDir, [], [])
  const rotationsMs = [...new Set(events.filter((entry) => entry.event === 'read_model.ordinary_head_rotated').map((entry) => entry.atMs))].sort((a, b) => a - b)
  const runByBoot = new Map(runs.map((run) => [run.manifest.bootId, run]))
  const examine = (window, role) => {
    const run = runByBoot.get(window.processBootId)
    if (!run) return { role, service: window.service, windowStart: iso(window.windowStartMs), p99Ms: window.p99, coverage: 'no-capture-run' }
    const extension = Math.max(150, window.p99)
    return { role, service: window.service, cellId: run.manifest.cellId, run: run.name, windowStart: iso(window.windowStartMs), p99Ms: window.p99,
      ...witnesses(runs, run, window.windowStartMs - extension, window.windowEndMs) }
  }
  const stallRows = stalls.map((window) => examine(window, 'stall'))
  const controlRows = []
  for (const run of runs.filter((entry) => stalls.some((window) => window.processBootId === entry.manifest.bootId))) {
    for (const window of spreadQuiet(windows, run, controls)) controlRows.push(examine(window, 'control'))
  }
  // The whole-run census covers the processes this gate log observed (a
  // reused capture dir also holds other runs' processes, with no windows here
  // to place a gate pause).
  const logged = new Set(windows.map((window) => window.processBootId))
  const censusRuns = runs.filter((run) => logged.has(run.manifest.bootId))
  const census = taskCensus(censusRuns, rotationsMs, gapMs, gatePauses(windows))
  return {
    schema: 'maplespire.cell-stalls-deep.v1', thresholdMs, gapMs, rotations: rotationsMs.length,
    censusRuns: censusRuns.map((run) => run.name), runsNotInGateLog: runs.filter((run) => !logged.has(run.manifest.bootId)).map((run) => run.name),
    steal: runs.map((run) => ({ run: run.name, cellId: run.manifest.cellId, ...stealTotals(run) })),
    workerCadence: runs.map((run) => {
      const rows = run.sched?.rows
      const gaps = []
      for (let index = 1; index < (rows?.count ?? 0); index++) gaps.push((rows.at(index, 0) - rows.at(index - 1, 0)) / 1000)
      return { run: run.name, readings: rows?.count ?? 0, gaps: distribution(gaps), over50ms: gaps.filter((gap) => gap >= 50).length }
    }),
    stalls: stallRows, controls: controlRows,
    samplerHoles: { total: census.samplerHoles.filter((hole) => !hole.gatePause).length, duringGatePause: census.samplerHoles.filter((hole) => hole.gatePause).length,
      byCell: census.samplerHoles.filter((hole) => !hole.gatePause).reduce((acc, hole) => ({ ...acc, [hole.cellId]: (acc[hole.cellId] ?? 0) + 1 }), {}),
      largest: holeCensus(runs, census.samplerHoles) },
    tasks: { forwardRetiredHead: census.forwardRetiredHead, allTasksOver20ms: census.allTasksOver20ms },
  }
}

const table = (rows, columns) => [`| ${columns.map(([title]) => title).join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`,
  ...rows.map((row) => `| ${columns.map(([, get]) => String(get(row) ?? '—').replace(/\|/g, '\\|')).join(' | ')} |`)]

export function renderDeep(report) {
  const lines = ['# Who stopped: main thread, process, or VM', '',
    'A main-sampler hole alone ⇒ main thread only; the worker\'s 10 ms readings stopping too ⇒ the whole process; the other cells too ⇒ VM-wide.', '']
  const windowRows = (rows) => table(rows, [
    ['cell', (row) => row.service], ['window start', (row) => row.windowStart], ['p99', (row) => row.p99Ms],
    ['sampler hole ms', (row) => row.samplerGap?.ms], ['hole from', (row) => row.samplerGap?.from],
    ['worker gap over hole ms', (row) => row.workerGapOverHoleMs], ['main on/wait/off during hole', (row) => row.mainThreadDuringHole ? `${row.mainThreadDuringHole.onCpuMs}/${row.mainThreadDuringHole.runQueueMs}/${row.mainThreadDuringHole.offCpuMs}` : null],
    ['other cells sampler / worker gap ms', (row) => (row.otherCells ?? []).map((other) => `${other.cellId.replace('failover-', '')} ${other.samplerGapMs ?? '—'}/${other.workerGapMs ?? '—'}`).join('; ')],
    ['reading', (row) => row.reading ?? row.coverage],
  ])
  lines.push('"main on/wait/off during hole" comes from the schedstat readings bracketing the hole (one 10 ms reading of slack on each side; captures before this script stamped readings after the read, so a frozen worker can skew it — small negatives are that).', '')
  lines.push('## Stall windows', '', ...windowRows(report.stalls), '', '## Control windows (p99 < 30 ms, spread over the same runs)', '', ...windowRows(report.controls), '')
  lines.push('## VM steal over the whole run', '', ...table(report.steal, [['run', (row) => row.run], ['readings', (row) => row.readings],
    ['steal ticks', (row) => row.stealTicks], ['total ticks', (row) => row.totalTicks], ['share', (row) => row.share], ['blind (exactly 0)', (row) => row.blind]]), '')
  lines.push('## Worker reading cadence (10 ms nominal)', '', ...table(report.workerCadence, [['run', (row) => row.run], ['readings', (row) => row.readings],
    ['p50 ms', (row) => row.gaps.p50], ['p99 ms', (row) => row.gaps.p99], ['max ms', (row) => row.gaps.max], ['gaps ≥ 50 ms', (row) => row.over50ms]]), '')
  if (report.runsNotInGateLog.length) lines.push(`Runs in the capture dir but not in this gate log (left out of the whole-run census): ${report.runsNotInGateLog.join(', ')}.`, '')
  lines.push(`## Main-sampler holes ≥ ${report.gapMs} ms over the whole run`, '', `Total ${report.samplerHoles.total} outside gate pauses (${report.samplerHoles.duringGatePause} more during the takeover pause, left out); by cell: ${JSON.stringify(report.samplerHoles.byCell)}. Largest:`, '',
    ...table(report.samplerHoles.largest, [['cell', (row) => row.cellId], ['at', (row) => row.at], ['hole ms', (row) => row.samplerGapMs],
      ['busy before/after', (row) => `${row.busyBefore}/${row.busyAfter}`], ['worker gap ms', (row) => row.workerGapMs],
      ['main on/off ms', (row) => `${row.mainOnCpuMs ?? '—'}/${row.mainOffCpuMs ?? '—'}`],
      ['other cells sampler/worker ms', (row) => row.otherCells.map((other) => `${other.cellId.replace('failover-', '')} ${other.samplerGapMs ?? '—'}/${other.workerGapMs ?? '—'}`).join('; ')],
      ['reading', (row) => row.reading]]), '')
  const taskTable = (title, data) => [`### ${title}`, '', ...table(Object.entries(data), [['band after last rotation', ([band]) => band], ['tasks', ([, row]) => row.tasks],
    ['unsampled ms p50 / p90 / p99 / max', ([, row]) => row.unsampledMs.count ? `${row.unsampledMs.p50} / ${row.unsampledMs.p90} / ${row.unsampledMs.p99} / ${row.unsampledMs.max}` : '—'],
    ['unsampled share mean', ([, row]) => row.unsampledShareMean], ['duration ms p50 / max', ([, row]) => row.durationMs.count ? `${row.durationMs.p50} / ${row.durationMs.max}` : '—']]), '']
  lines.push('## Unsampled time inside tasks (duration − sampled), every task of the run outside gate pauses', '',
    'Sampled time weighs each sample by the time to the next, capped at 5 intervals; the rest of a task\'s duration is time the sampler did not cover.', '',
    ...taskTable('forwardRetiredHead tasks', report.tasks.forwardRetiredHead), ...taskTable('Control: all tasks ≥ 20 ms', report.tasks.allTasksOver20ms))
  return lines.join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  const value = (flag) => argv.filter((arg) => arg.startsWith(`${flag}=`)).map((arg) => arg.slice(flag.length + 1)).at(-1)
  const captureDir = value('--capture-dir')
  if (!captureDir) throw new Error('usage: analyze-cell-stalls-deep.mjs --capture-dir=<dir> [--bench-log=<file>] [--threshold-ms=70] [--controls=10] [--gap-ms=50] [--out=<dir>]')
  const benchLog = resolve(value('--bench-log') ?? join(captureDir, 'gate.log'))
  if (!existsSync(benchLog)) throw new Error(`no gate log at ${benchLog}: pass --bench-log=<the run's log>`)
  const number = (flag, fallback) => { const raw = value(flag); const parsed = raw === undefined ? fallback : Number(raw); if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`); return parsed }
  const began = Date.now()
  const report = await deep({ benchLog, captureDir: resolve(captureDir), thresholdMs: number('--threshold-ms', 70), controls: number('--controls', 10), gapMs: number('--gap-ms', 50) })
  report.analysisMs = Date.now() - began
  const out = resolve(value('--out') ?? captureDir)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'stall-deep.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(out, 'stall-deep.md'), `${renderDeep(report)}\n`)
  process.stdout.write(`${JSON.stringify({ stalls: report.stalls.length, controls: report.controls.length, samplerHoles: report.samplerHoles.total, out, analysisMs: report.analysisMs })}\n`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
