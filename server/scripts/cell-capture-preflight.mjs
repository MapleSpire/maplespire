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
 * PREFLIGHT for the G4 stall capture, against a RUNNING `--cpu-profile=on`
 * stack (run it from a second shell during a short smoke, before committing a
 * PC to a two-hour soak):
 *
 *   node scripts/cell-capture-preflight.mjs --capture-dir=<dir>
 *        [--project=maplespire-bench-load-soak] [--seconds=15]
 *
 * 1. SCHEDULING CHANNEL. In each cell container, the main thread's
 *    `/proc/1/task/1/schedstat` (the node process is PID 1 there) is read
 *    twice, `--seconds` apart: on-CPU time must grow (the file is live), and
 *    run-queue wait (`run_delay`) should grow under load — if it never moves,
 *    the kernel is not accounting it and the analysis's "waiting for a CPU"
 *    column will read 0 for a reason that is not the workload.
 * 2. CAPTURE HEALTH. For the latest capture run of each cell: chunks written,
 *    age of the last one, schedstat files, GC lines, the main-thread cost of
 *    rolls (p50 / p99 / max, steady-state = without the first, boot-time roll)
 *    and the share of sampler gaps in the latest chunk.
 *
 * Exit 1 when the channel is missing or dead, or a cell has no capture; the
 * soft findings (run_delay flat, roll p99 ≥ 20 ms, gaps) are printed as WARN.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const CELLS = ['sync-cell-a', 'sync-cell-b', 'sync-cell-c']

/** `on-CPU ns, run-queue wait ns, timeslices` → numbers, or null. */
export function parseSchedstat(text) {
  const fields = String(text ?? '').trim().split(/\s+/).map(Number)
  return fields.length >= 3 && fields.slice(0, 3).every(Number.isFinite) ? { runNs: fields[0], waitNs: fields[1], slices: fields[2] } : null
}

export function judgeSchedstat(before, after, seconds) {
  if (!before || !after) return { status: 'FAIL', reason: 'schedstat unreadable' }
  const onCpuMs = (after.runNs - before.runNs) / 1e6
  const runDelayMs = (after.waitNs - before.waitNs) / 1e6
  const result = { onCpuMs: Math.round(onCpuMs * 10) / 10, runDelayMs: Math.round(runDelayMs * 10) / 10,
    onCpuShare: Math.round((onCpuMs / (seconds * 1000)) * 1000) / 1000, slices: after.slices - before.slices }
  if (onCpuMs <= 0) return { status: 'FAIL', reason: 'on-CPU time did not grow: the file is not live', ...result }
  if (runDelayMs <= 0) return { status: 'WARN', reason: 'run_delay did not grow: no contention, or the kernel does not account it', ...result }
  return { status: 'PASS', ...result }
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
const round = (value) => Math.round(value * 100) / 100

/** Main-thread cost of the rolls in `events` (records of `events.ndjson`). */
export function rollSummary(events) {
  const rolls = events.filter((entry) => entry.type === 'roll' && entry.ended)
  const costs = (list) => list.map((roll) => (roll.hrUsAfterEnd - roll.hrUsBefore) / 1000).sort((a, b) => a - b)
  const stats = (sorted) => sorted.length ? { count: sorted.length, p50: round(quantile(sorted, 0.5)), p99: round(quantile(sorted, 0.99)), max: round(sorted.at(-1)) } : null
  const all = events.filter((entry) => entry.type === 'roll')
  return {
    all: stats(costs(all)),
    // Steady state: every roll that ENDED a chunk (the first, which starts the
    // worker's profiler and re-logs the heap's code, ends none).
    steady: stats(costs(rolls)),
  }
}

/** Share of the chunk's time spent in clear sampler gaps (> 5 intervals). */
export function samplerGapShare(profile, intervalUs) {
  let gapUs = 0
  for (const delta of profile.timeDeltas.slice(1)) if (delta > 5 * intervalUs) gapUs += delta - intervalUs
  const spanUs = profile.endTime - profile.startTime
  return spanUs > 0 ? Math.round((gapUs / spanUs) * 1000) / 1000 : null
}

export function captureHealth(captureDir, nowMs = Date.now()) {
  const runs = existsSync(captureDir) ? readdirSync(captureDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()
    && existsSync(join(captureDir, entry.name, 'manifest.json'))) : []
  const latest = new Map()
  for (const entry of runs) {
    const directory = join(captureDir, entry.name)
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    const previous = latest.get(manifest.cellId)
    if (!previous || manifest.anchor.wallMs > previous.manifest.anchor.wallMs) latest.set(manifest.cellId, { directory, run: entry.name, manifest })
  }
  return [...latest.values()].map(({ directory, run, manifest }) => {
    const files = readdirSync(directory)
    const events = existsSync(join(directory, 'events.ndjson'))
      ? readFileSync(join(directory, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
    const chunks = files.filter((file) => /^cpu-\d+\.cpuprofile\.gz$/.test(file)).sort()
    const last = chunks.at(-1)
    let gapShare = null
    if (last) {
      try { gapShare = samplerGapShare(JSON.parse(gunzipSync(readFileSync(join(directory, last))).toString('utf8')), manifest.samplingIntervalUs) } catch { gapShare = null }
    }
    const gcPath = join(directory, 'gc.ndjson')
    return { cellId: manifest.cellId, run, chunks: chunks.length, schedAvailable: manifest.sched?.available ?? false,
      schedFiles: files.filter((file) => file.startsWith('sched-')).length,
      gcLines: existsSync(gcPath) ? readFileSync(gcPath, 'utf8').split('\n').filter(Boolean).length : 0,
      lastChunkAgeS: last ? Math.round((nowMs - statSync(join(directory, last)).mtimeMs) / 100) / 10 : null,
      rolls: rollSummary(events), latestChunkGapShare: gapShare, chunkSeconds: manifest.chunkSeconds }
  })
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, windowsHide: true })
}

function readCellSchedstat(project, service) {
  const id = docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', `label=com.docker.compose.service=${service}`]).trim().split(/\s+/)[0]
  if (!id) return { id: null, schedstat: null, comm: null }
  let schedstat = null
  let comm = null
  try { schedstat = parseSchedstat(docker(['exec', id, 'cat', '/proc/1/task/1/schedstat'])) } catch { schedstat = null }
  try { comm = docker(['exec', id, 'cat', '/proc/1/comm']).trim() } catch { comm = null }
  return { id, schedstat, comm }
}

export async function main(argv = process.argv.slice(2)) {
  const value = (flag) => argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
  const captureDir = value('--capture-dir')
  if (!captureDir) throw new Error('usage: cell-capture-preflight.mjs --capture-dir=<dir> [--project=maplespire-bench-load-soak] [--seconds=15]')
  const project = value('--project') ?? 'maplespire-bench-load-soak'
  const seconds = Number(value('--seconds') ?? 15)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) throw new Error('--seconds must be from 1 to 600')
  const before = Object.fromEntries(CELLS.map((service) => [service, readCellSchedstat(project, service)]))
  await new Promise((r) => setTimeout(r, seconds * 1000))
  const after = Object.fromEntries(CELLS.map((service) => [service, readCellSchedstat(project, service)]))
  const sched = CELLS.map((service) => ({ service, container: before[service].id, pid1: before[service].comm,
    ...(before[service].id && before[service].id === after[service].id
      ? judgeSchedstat(before[service].schedstat, after[service].schedstat, seconds)
      : { status: 'FAIL', reason: before[service].id ? 'container changed during the preflight' : 'no running container' }) }))
  const capture = captureHealth(resolve(captureDir))
  const problems = []
  const warnings = []
  for (const row of sched) {
    if (row.status === 'FAIL') problems.push(`${row.service}: ${row.reason}`)
    if (row.status === 'WARN') warnings.push(`${row.service}: ${row.reason}`)
    if (row.pid1 && row.pid1 !== 'node') warnings.push(`${row.service}: PID 1 is ${row.pid1}, not node — the capture reads the node process's own task`)
  }
  for (const service of CELLS) {
    const cellId = service.replace('sync-cell-', 'failover-cell-')
    const row = capture.find((entry) => entry.cellId === cellId)
    if (!row) { problems.push(`${cellId}: no capture run in ${captureDir}`); continue }
    if (!row.schedAvailable) problems.push(`${cellId}: the capture found no schedstat (manifest sched.available=false)`)
    if (row.chunks < 2) warnings.push(`${cellId}: only ${row.chunks} chunk(s) so far`)
    if (row.lastChunkAgeS !== null && row.lastChunkAgeS > 3 * row.chunkSeconds) problems.push(`${cellId}: last chunk is ${row.lastChunkAgeS} s old (chunks every ${row.chunkSeconds} s)`)
    if (row.rolls.steady && row.rolls.steady.p99 >= 20) warnings.push(`${cellId}: steady roll p99 ${row.rolls.steady.p99} ms ≥ 20 ms`)
    if (row.latestChunkGapShare !== null && row.latestChunkGapShare > 0.05) warnings.push(`${cellId}: ${Math.round(row.latestChunkGapShare * 100)} % of the latest chunk is sampler gaps > 5 intervals`)
  }
  const verdict = problems.length ? 'FAIL' : warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS'
  process.stdout.write(`${JSON.stringify({ preflight: 'g4-cell-capture', verdict, project, seconds, sched, capture, problems, warnings }, null, 2)}\n`)
  for (const row of sched) process.stderr.write(`[preflight] ${row.service} schedstat ${row.status}: on CPU ${row.onCpuMs ?? '—'} ms, run_delay +${row.runDelayMs ?? '—'} ms over ${seconds} s${row.reason ? ` (${row.reason})` : ''}\n`)
  for (const row of capture) process.stderr.write(`[preflight] ${row.cellId} rolls steady p50/p99/max ${row.rolls.steady ? `${row.rolls.steady.p50}/${row.rolls.steady.p99}/${row.rolls.steady.max}` : '—'} ms (all incl. boot: max ${row.rolls.all?.max ?? '—'}), chunks ${row.chunks}, last ${row.lastChunkAgeS} s ago, gaps ${row.latestChunkGapShare}\n`)
  process.stderr.write(`[preflight] ${verdict}${problems.length ? `: ${problems.join('; ')}` : ''}\n`)
  process.exitCode = problems.length ? 1 : 0
  return { verdict, sched, capture, problems, warnings }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
