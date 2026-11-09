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
 * What was the main thread doing during each event-loop stall of a G4 soak?
 *
 *   node scripts/analyze-cell-stalls.mjs --capture-dir=<dir> [--bench-log=<run.log>]
 *        [--container-log=<file>]... [--threshold-ms=70] [--baseline-windows=12]
 *        [--top=15] [--out=<dir>]
 *
 * INPUTS. The gate log (`<capture-dir>/gate.log`, which the bench tees itself,
 * or any log holding the gate's stdout): the gate's
 * `G47_EVENT {"kind":"sample",…}` lines carry, per cell and per ~500 ms
 * window, the qualification histogram's p99 (`eventLoopP99Ms`, the number the
 * gate fails on at ≥ 100) and the window's own start in the CELL's clock
 * (`eventLoopWindow.startedAt`); the window ends at the next consume, i.e. the
 * next window's `startedAt` (same process). The `{"task":…}` / `G47_PARTIAL`
 * line has `firstFailure`. The capture directory written by
 * `--cpu-profile=on` (`server/src/diagnostics/cpuProfileCapture.ts`): one
 * `<cellId>-<processBootId>/` per process, joined to the samples by
 * `processBootId`, plus `compose-logs/<service>.log` (docker-timestamped, the
 * cells' clock) for the rotation events. Extra `--container-log` files are
 * read the same way, and container lines in the bench log itself (the FAIL
 * tail) too.
 *
 * FOR EACH SAMPLE ABOVE THE THRESHOLD: the profile samples of that process in
 * the sample window and in a TIGHTER window — the longest run of consecutive
 * non-idle samples inside it (the blocking stretch: one task, or tasks
 * chained by setImmediate without the loop going idle) — aggregated
 * by self time and inclusive time per function, and by top-of-stack path
 * (leaf first); a category split (GC, wasm, Automerge JS, JSON, node
 * internals, app, deps); the GC entries overlapping the window; any capture
 * roll overlapping it (its main-thread cost is a candidate cause, so such a
 * window is flagged, not hidden); the main thread's scheduling over the
 * window and the busy run (schedstat: on CPU / waiting for a CPU / off CPU,
 * plus VM steal) — which separates "the stack was running" from "the thread
 * was not on a CPU" when samples are missing; the time since the last
 * `read_model.ordinary_head_rotated` on ANY cell; and the same aggregation
 * over baseline windows of the same process, of equal length, with p99 under
 * `--baseline-max-ms`, nearest in time (outside ±1.5 s), so a function is
 * reported by its EXCESS over normal.
 *
 * WHAT IT DOES NOT DO. It does not claim a cause: it lays out the stacks that
 * were on the CPU, measured, beside the baseline. Coverage, sampler gaps
 * ("lost" samples), clock-domain checks and unresolved frames are reported
 * per window, and a window with no profile is listed as uncovered — never
 * filled from another window.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

// ── Bench log ────────────────────────────────────────────────────────────────

/** The docker log line shapes: `svc-1  | <ISO>Z text` (compose) and `<ISO>Z text` (docker -t). */
const CONTAINER_LINE = /^(?:([A-Za-z0-9_.-]+?)(?:-\d+)?\s+\|\s+)?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s(.*)$/

/** ISO with up to nanoseconds → epoch ms with the sub-ms kept. */
export function parseIsoMs(text) {
  const match = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(text)
  if (!match) return Number.NaN
  const whole = Date.parse(`${match[1]}Z`)
  const fraction = match[2] ? Number(`0.${match[2]}`) * 1000 : 0
  return whole + fraction
}

function jsonAfter(line, marker) {
  const index = line.indexOf(marker)
  if (index < 0) return null
  try { return JSON.parse(line.slice(index + marker.length)) } catch { return null }
}

/**
 * BOUNDED MEMORY. Every log is read LINE BY LINE (`readLines`) and only what
 * the analysis needs is kept: sample facts, failures, the summary, and
 * container events reduced to { service, atMs, event, workspace }. A
 * two-hour gate log runs to gigabytes — more than one string can hold — so no
 * log is ever read whole (the test pins it).
 */
export async function readLines(file, onLine, { maxLineBytes = 16 << 20, keepPrefixBytes = 1 << 20 } = {}) {
  // Bytes, split on \n (never inside a UTF-8 sequence). A line over
  // `maxLineBytes` — the gate's final record can hold every episode — is
  // passed as its first `keepPrefixBytes`, flagged truncated: one line must
  // not be able to exceed what a string can hold either.
  const input = createReadStream(file, { highWaterMark: 1 << 20 })
  let pieces = []
  let size = 0
  let truncated = false
  const emit = () => {
    const bytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces)
    let line = bytes.toString('utf8')
    if (line.endsWith('\r')) line = line.slice(0, -1)
    onLine(line, truncated)
    pieces = []
    size = 0
    truncated = false
  }
  const add = (piece) => {
    if (truncated) return
    if (size + piece.length > maxLineBytes) {
      truncated = true
      const room = Math.max(0, keepPrefixBytes - size)
      if (room > 0) pieces.push(piece.subarray(0, room))
      pieces = [Buffer.concat(pieces).subarray(0, keepPrefixBytes)]
      return
    }
    pieces.push(piece)
    size += piece.length
  }
  try {
    for await (const chunk of input) {
      let start = 0
      for (let index = chunk.indexOf(10); index >= 0; index = chunk.indexOf(10, start)) {
        add(chunk.subarray(start, index))
        emit()
        start = index + 1
      }
      if (start < chunk.length) add(Buffer.from(chunk.subarray(start)))
    }
    if (size > 0 || truncated) emit()
  } finally {
    input.destroy()
  }
}

/** The JSON value of `"key":` inside a (possibly truncated) JSON text, by
 * bracket matching — for the summary line when it was too long to keep. */
export function jsonFieldFromPrefix(text, key) {
  const at = text.indexOf(`"${key}":`)
  if (at < 0) return undefined
  let index = at + key.length + 3
  while (text[index] === ' ') index += 1
  const open = text[index]
  if (open !== '{' && open !== '[') {
    const scalar = /^(?:"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)/.exec(text.slice(index, index + 4096))
    try { return scalar ? JSON.parse(scalar[0]) : undefined } catch { return undefined }
  }
  let depth = 0
  let inString = false
  for (let cursor = index; cursor < text.length; cursor++) {
    const char = text[cursor]
    if (inString) {
      if (char === '\\') cursor += 1
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) { try { return JSON.parse(text.slice(index, cursor + 1)) } catch { return undefined } }
    }
  }
  return undefined
}

/** G47 lines whose kind the analysis reads; the rest (episodes, receipts,
 * calibration) are skipped WITHOUT parsing — some are megabytes long. */
const KEPT_G47 = ['G47_EVENT {"kind":"sample"', 'G47_EVENT {"kind":"owner-drain-facts"', 'G47_EVENT {"kind":"criterion-failed"']

/**
 * Samples, failures, summary and container events from the bench log, one
 * line at a time. Each sample fact: { service, processBootId, cellId, p99,
 * windowStartMs, resetCount, excluded, phase, cycle, observedAt, kind }.
 */
export class BenchLogReader {
  constructor() {
    this.facts = []
    this.failures = []
    this.summary = null
    this.containerEvents = []
    this.lines = 0
  }

  line(line, truncated = false) {
    this.lines += 1
    if (truncated) {
      // Only the summary records are ever this long; read what the prefix holds.
      const isTask = line.trimStart().startsWith('{"task"')
      if (isTask || line.includes('G47_PARTIAL ')) {
        this.summary = { source: isTask ? 'task' : 'G47_PARTIAL', truncatedLine: true, task: jsonFieldFromPrefix(line, 'task') ?? null,
          status: jsonFieldFromPrefix(line, 'status') ?? null, firstFailure: jsonFieldFromPrefix(line, 'firstFailure') ?? null,
          actualSoakMs: jsonFieldFromPrefix(line, 'actualSoakMs') ?? null, durationCompleted: jsonFieldFromPrefix(line, 'durationCompleted') ?? null }
      }
      return
    }
    const { facts, failures } = this
    if (line.includes('G47_EVENT ')) {
      if (!KEPT_G47.some((marker) => line.includes(marker))) return
      const event = jsonAfter(line, 'G47_EVENT ')
      if (!event) return
      if (event.kind === 'sample' || event.kind === 'owner-drain-facts') {
        for (const cell of event.cells ?? []) {
          if (cell.intentionallyUnavailable) continue
          facts.push({
            kind: event.kind, service: cell.service, processBootId: cell.processBootId, cellId: cell.cellId,
            p99: Number(cell.eventLoopP99Ms), windowStartMs: parseIsoMs(String(cell.eventLoopWindow?.startedAt ?? '')),
            resetCount: cell.eventLoopWindow?.resetCount ?? null, excluded: cell.eventLoopExcluded === true || event.kind !== 'sample',
            phase: event.phase ?? null, cycle: event.cycle ?? null, observedAt: event.observedAt ?? null,
          })
        }
      } else if (event.kind === 'criterion-failed') {
        failures.push({ criterion: event.criterion, value: typeof event.value === 'number' ? event.value : String(event.value).slice(0, 200),
          service: event.service ?? null, phase: event.phase ?? null, cycle: event.cycle ?? null, observedAt: event.observedAt ?? null })
      }
      return
    }
    if (line.includes('G47_PARTIAL ')) {
      const partial = jsonAfter(line, 'G47_PARTIAL ')
      if (partial) this.summary = { source: 'G47_PARTIAL', status: partial.status, firstFailure: partial.firstFailure ?? null, reason: partial.reason ?? null }
      return
    }
    if (line.startsWith('{"task"') || line.trimStart().startsWith('{"task"')) {
      try {
        const task = JSON.parse(line.trim())
        this.summary = { source: 'task', task: task.task, status: task.status, firstFailure: task.firstFailure ?? null,
          actualSoakMs: task.actualSoakMs ?? null, durationCompleted: task.durationCompleted ?? null }
      } catch { /* not the summary */ }
      return
    }
    const entry = containerEvent(line)
    if (entry) this.containerEvents.push(entry)
  }

  result() {
    return { facts: this.facts, failures: this.failures, summary: this.summary, containerEvents: this.containerEvents, lines: this.lines }
  }
}

/** The same reader over an in-memory string (tests, small logs). */
export function parseBenchLog(text) {
  const reader = new BenchLogReader()
  for (const line of String(text).split(/\r?\n/)) reader.line(line)
  return reader.result()
}

export async function readBenchLog(file) {
  const reader = new BenchLogReader()
  await readLines(file, (line, truncated) => reader.line(line, truncated))
  return reader.result()
}

/**
 * Close each window: it ends where the same process's next window starts.
 * The last window of a process gets the median length and `endEstimated`.
 */
export function windowsFromFacts(facts) {
  const byBoot = new Map()
  for (const fact of facts) {
    if (!fact.processBootId || !Number.isFinite(fact.windowStartMs)) continue
    if (!byBoot.has(fact.processBootId)) byBoot.set(fact.processBootId, [])
    byBoot.get(fact.processBootId).push(fact)
  }
  const windows = []
  for (const list of byBoot.values()) {
    list.sort((a, b) => (a.resetCount ?? 0) - (b.resetCount ?? 0) || a.windowStartMs - b.windowStartMs)
    const lengths = []
    for (let index = 0; index + 1 < list.length; index++) {
      if (list[index + 1].resetCount === list[index].resetCount + 1) lengths.push(list[index + 1].windowStartMs - list[index].windowStartMs)
    }
    const median = lengths.length ? [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)] : 500
    for (let index = 0; index < list.length; index++) {
      const next = list[index + 1]
      const contiguous = next && next.resetCount === list[index].resetCount + 1
      windows.push({ ...list[index], windowEndMs: contiguous ? next.windowStartMs : list[index].windowStartMs + median, endEstimated: !contiguous })
    }
  }
  return windows.sort((a, b) => a.windowStartMs - b.windowStartMs)
}

// ── Container logs ───────────────────────────────────────────────────────────

/** One docker-timestamped container line → { service, atMs, event,
 * workspace }, or null. Only JSON lines with an `event` are kept, reduced to
 * those four fields. `service` falls back to the file name. */
export function containerEvent(line, fallbackService = null) {
  if (!line.includes('"event":"')) return null
  const match = CONTAINER_LINE.exec(line)
  if (!match) return null
  const body = match[3]
  const brace = body.indexOf('{')
  if (brace < 0) return null
  let payload
  try { payload = JSON.parse(body.slice(brace)) } catch { return null }
  if (typeof payload?.event !== 'string') return null
  return { service: match[1] ?? fallbackService, atMs: parseIsoMs(match[2]), event: payload.event,
    workspace: typeof payload.workspace === 'string' ? payload.workspace : null }
}

export function parseContainerLines(lines, fallbackService = null) {
  return lines.map((line) => containerEvent(line, fallbackService)).filter(Boolean)
}

function dedupeEvents(events) {
  const seen = new Set()
  return events.filter((entry) => {
    const key = `${entry.service}|${entry.atMs}|${entry.event}|${entry.workspace}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.atMs - b.atMs)
}

// ── Capture directory ────────────────────────────────────────────────────────

async function ndjson(file, keep = (entry) => entry) {
  const out = []
  if (!existsSync(file)) return out
  await readLines(file, (line) => {
    if (!line) return
    try { const entry = keep(JSON.parse(line)); if (entry) out.push(entry) } catch { /* a torn line */ }
  })
  return out
}

/** Growable columns of float64 (schedstat readings: compact, no per-row object). */
class Columns {
  constructor(width) { this.width = width; this.count = 0; this.data = new Float64Array(width * 1024) }
  push(row) {
    if ((this.count + 1) * this.width > this.data.length) {
      const grown = new Float64Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    for (let index = 0; index < this.width; index++) this.data[this.count * this.width + index] = row[index] ?? 0
    this.count += 1
  }
  at(row, column) { return this.data[row * this.width + column] }
  /** Last row with column 0 <= value, or -1. */
  floor(value) {
    let lo = 0
    let hi = this.count - 1
    let found = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.at(mid, 0) <= value) { found = mid; lo = mid + 1 } else hi = mid - 1 }
    return found
  }
  /** First row with column 0 >= value, or -1. */
  ceil(value) {
    let lo = 0
    let hi = this.count - 1
    let found = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.at(mid, 0) >= value) { found = mid; hi = mid - 1 } else lo = mid + 1 }
    return found
  }
}

/** One capture run (one process): manifest, chunk index, anchors, rolls, GC. */
export async function loadCaptureRun(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const events = await ndjson(join(directory, 'events.ndjson'))
  const chunks = events.filter((entry) => entry.type === 'chunk' && existsSync(join(directory, entry.file)))
    .sort((a, b) => a.startTime - b.startTime)
  const rolls = events.filter((entry) => entry.type === 'roll')
  // Wall↔hrtime pairs: the install anchor and one per roll.
  const anchors = [{ hrUs: manifest.anchor.hrUs, wallMs: manifest.anchor.wallMs },
    ...rolls.map((roll) => ({ hrUs: roll.hrUsBefore, wallMs: roll.wallMsBefore }))].sort((a, b) => a.hrUs - b.hrUs)
  // Clock domain: every chunk must have started inside the hrtime bracket of
  // the call that started it; otherwise the hr→wall mapping is not trusted.
  const clockChecks = []
  for (const chunk of chunks) {
    const bracket = chunk.seq === 0 ? manifest.bootChunk : rolls.find((roll) => roll.startedSeq === chunk.seq)
    if (!bracket) continue
    const before = bracket.hrUsBefore
    const after = chunk.seq === 0 ? bracket.hrUsAfter : bracket.hrUsAfterStart
    clockChecks.push({ seq: chunk.seq, ok: chunk.startTime >= before - 1000 && chunk.startTime <= after + 1000, offsetUs: chunk.startTime - before })
  }
  const gc = await ndjson(join(directory, 'gc.ndjson'), (entry) => ({ hrUs: entry.hrUs, durUs: entry.durUs, kind: entry.kind, flags: entry.flags }))
  // Scheduling readings (Linux): cumulative; one gz file decoded at a time,
  // in time order of its first reading, into float64 columns.
  const files = []
  for (const file of readdirSync(directory).filter((name) => /^sched-\d+\.json\.gz$/.test(name))) {
    try {
      const body = JSON.parse(gunzipSync(readFileSync(join(directory, file))).toString('utf8'))
      files.push({ file, first: body.rows[0]?.[0] ?? Infinity })
    } catch { /* a torn file is a gap */ }
  }
  files.sort((a, b) => a.first - b.first)
  const sched = { rows: new Columns(4), steal: new Columns(3) }
  for (const { file } of files) {
    const body = JSON.parse(gunzipSync(readFileSync(join(directory, file))).toString('utf8'))
    for (const row of body.rows) if (!sched.rows.count || row[0] >= sched.rows.at(sched.rows.count - 1, 0)) sched.rows.push(row)
    for (const row of body.steal?.rows ?? []) if (!sched.steal.count || row[0] >= sched.steal.at(sched.steal.count - 1, 0)) sched.steal.push(row)
  }
  // WALL-CLOCK STEPS: between consecutive anchors the wall clock must advance
  // as hrtime does. A difference > 5 ms is a step (an NTP or WSL2 resync):
  // wall↔hr conversions across it are off by that much.
  const clockSteps = []
  for (let index = 1; index < anchors.length; index++) {
    const stepMs = (anchors[index].wallMs - anchors[index - 1].wallMs) - (anchors[index].hrUs - anchors[index - 1].hrUs) / 1000
    if (Math.abs(stepMs) > 5) clockSteps.push({ at: new Date(anchors[index].wallMs).toISOString(), stepMs: Math.round(stepMs * 100) / 100 })
  }
  return { directory, name: basename(directory), manifest, chunks, rolls, anchors, gc, clockChecks, sched, clockSteps,
    stop: events.find((entry) => entry.type === 'stop') ?? null, cache: new Map() }
}

export async function loadCaptureDir(directory) {
  if (!existsSync(directory)) return []
  const runs = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(directory, entry.name, 'manifest.json'))) runs.push(await loadCaptureRun(join(directory, entry.name)))
  }
  return runs
}

function nearestAnchor(anchors, key, value) {
  let best = anchors[0]
  for (const anchor of anchors) if (Math.abs(anchor[key] - value) < Math.abs(best[key] - value)) best = anchor
  return best
}
export const hrToWall = (run, hrUs) => { const anchor = nearestAnchor(run.anchors, 'hrUs', hrUs); return anchor.wallMs + (hrUs - anchor.hrUs) / 1000 }
export const wallToHr = (run, wallMs) => { const anchor = nearestAnchor(run.anchors, 'wallMs', wallMs); return anchor.hrUs + (wallMs - anchor.wallMs) * 1000 }

/** A parsed chunk: per-sample time and node, per-node stack. Small LRU. */
function chunkData(run, chunk) {
  if (run.cache.has(chunk.seq)) return run.cache.get(chunk.seq)
  const profile = JSON.parse(gunzipSync(readFileSync(join(run.directory, chunk.file))).toString('utf8'))
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const times = new Float64Array(profile.samples.length)
  let t = profile.startTime
  for (let index = 0; index < profile.samples.length; index++) { t += profile.timeDeltas[index]; times[index] = t }
  const stacks = new Map()
  const stackOf = (id) => {
    if (stacks.has(id)) return stacks.get(id)
    const frames = []
    for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const frame = nodes.get(cursor)?.callFrame
      if (frame && frame.functionName !== '(root)') frames.push(frame)
    }
    stacks.set(id, frames) // leaf first
    return frames
  }
  const data = { profile, times, stackOf }
  run.cache.set(chunk.seq, data)
  if (run.cache.size > 4) run.cache.delete(run.cache.keys().next().value)
  return data
}

/** Samples of `run` with hr time in [fromHr, toHr). Chunks overlap by a few
 * ms at each roll; each instant is taken from ONE chunk (the earlier chunk up
 * to the next one's start). Returns samples and coverage. */
export function samplesBetween(run, fromHr, toHr) {
  const samples = []
  let coveredUs = 0
  for (let index = 0; index < run.chunks.length; index++) {
    const chunk = run.chunks[index]
    const next = run.chunks[index + 1]
    const chunkFrom = chunk.startTime
    const chunkTo = next ? Math.min(chunk.endTime, next.startTime) : chunk.endTime
    const from = Math.max(fromHr, chunkFrom)
    const to = Math.min(toHr, chunkTo)
    if (to <= from) continue
    coveredUs += to - from
    const data = chunkData(run, chunk)
    for (let i = 0; i < data.times.length; i++) {
      const time = data.times[i]
      if (time < from || time >= to) continue
      samples.push({ hrUs: time, nodeId: data.profile.samples[i], stack: data.stackOf(data.profile.samples[i]),
        nextUs: (i + 1 < data.times.length ? data.times[i + 1] : chunk.endTime) - time })
    }
  }
  samples.sort((a, b) => a.hrUs - b.hrUs)
  return { samples, coveredUs, spanUs: Math.max(0, toHr - fromHr) }
}

/**
 * What the main thread's scheduler saw between two hrtime instants, from the
 * readings that bracket them: on CPU, waiting for a CPU (run queue), and the
 * rest (off CPU: idle in epoll, blocked in a syscall, or descheduled by the
 * hypervisor — `steal` is the VM-wide witness of the last one). Null when the
 * host had no schedstat or the readings do not bracket the interval.
 */
export function schedulingBetween(run, fromHr, toHr) {
  const rows = run.sched?.rows
  if (!rows?.count) return null
  // 50 µs of slack: wall→hr conversion is floating point.
  const row = (columns, index) => index < 0 ? null : Array.from({ length: columns.width }, (_, column) => columns.at(index, column))
  const before = row(rows, rows.floor(fromHr + 50))
  const after = row(rows, rows.ceil(toHr - 50))
  if (!before || !after) return null
  const spanMs = (after[0] - before[0]) / 1000
  const onCpuMs = (after[1] - before[1]) / 1e6
  const runQueueMs = (after[2] - before[2]) / 1e6
  const steal = run.sched.steal
  const stealBefore = row(steal, steal.floor(fromHr + 50))
  const stealAfter = row(steal, steal.ceil(toHr - 50))
  const dTotal = stealBefore && stealAfter ? stealAfter[2] - stealBefore[2] : 0
  return { spanMs: round(spanMs), onCpuMs: round(onCpuMs), runQueueMs: round(runQueueMs),
    offCpuMs: round(spanMs - onCpuMs - runQueueMs), timeslices: after[3] - before[3],
    readingGapMs: round(Math.max((fromHr - before[0]) / 1000, (after[0] - toHr) / 1000)),
    vmStealShare: dTotal > 0 ? round((stealAfter[1] - stealBefore[1]) / dTotal, 4) : null }
}

// ── Aggregation ──────────────────────────────────────────────────────────────

const shortUrl = (url) => {
  if (!url) return ''
  const text = String(url).replace(/^file:\/\//, '')
  const modules = text.lastIndexOf('node_modules/')
  if (modules >= 0) return text.slice(modules + 'node_modules/'.length)
  return text.replace(/^\/app\//, '')
}
export const frameKey = (frame) => {
  const name = frame.functionName || '(anonymous)'
  const url = shortUrl(frame.url)
  return url ? `${name} ${url}:${frame.lineNumber + 1}` : name
}
const IDLE = '(idle)'
export const isIdle = (sample) => sample.stack[0]?.functionName === IDLE

export function category(stack) {
  const leaf = stack[0]
  if (!leaf) return 'unknown'
  const name = leaf.functionName
  if (name === '(garbage collector)') return 'gc'
  if (name === IDLE) return 'idle'
  if (name === '(program)') return 'program'
  const url = String(leaf.url ?? '')
  if (/wasm/i.test(url) || /^wasm-function/.test(name) || /^\$?[a-z_]+::/.test(name)) return 'wasm'
  if (name === 'parse' && !url) return 'json'
  if (name === 'stringify' && !url) return 'json'
  if (/JSON\.(parse|stringify)/.test(name)) return 'json'
  if (url.includes('@automerge/')) return 'automerge-js'
  if (url.startsWith('node:') || (!url && name)) return 'node/native'
  if (url.includes('node_modules/')) return 'deps'
  if (url) return 'app'
  return 'unknown'
}

/** Weight of a sample in µs: the time to the next sample, capped so one
 * sampler stall cannot dominate (gaps are reported separately). */
const weightUs = (sample, intervalUs) => Math.min(Math.max(sample.nextUs, 0), 5 * intervalUs)

export function aggregate(samples, intervalUs, top = 15) {
  const self = new Map()
  const inclusive = new Map()
  const paths = new Map()
  const categories = new Map()
  let totalUs = 0
  let busyUs = 0
  let unresolved = 0
  for (const sample of samples) {
    const weight = weightUs(sample, intervalUs)
    totalUs += weight
    if (!isIdle(sample)) busyUs += weight
    const leaf = sample.stack[0]
    if (!leaf) continue
    if (!leaf.url && !leaf.functionName) unresolved += 1
    const leafKey = frameKey(leaf)
    self.set(leafKey, (self.get(leafKey) ?? 0) + weight)
    for (const key of new Set(sample.stack.map(frameKey))) inclusive.set(key, (inclusive.get(key) ?? 0) + weight)
    const path = sample.stack.slice(0, 8).map(frameKey).join(' < ')
    paths.set(path, (paths.get(path) ?? 0) + weight)
    const kind = category(sample.stack)
    categories.set(kind, (categories.get(kind) ?? 0) + weight)
  }
  const ranked = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, us]) => ({ key, ms: round(us / 1000), share: totalUs ? round(us / totalUs, 4) : 0 }))
  return { samples: samples.length, totalMs: round(totalUs / 1000), busyMs: round(busyUs / 1000), unresolvedFrames: unresolved,
    self: ranked(self), inclusive: ranked(inclusive), paths: ranked(paths),
    categories: Object.fromEntries([...categories].sort((a, b) => b[1] - a[1]).map(([key, us]) => [key, round(us / 1000)])),
    maps: { self, inclusive, paths } }
}

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

/** The blocking task: the longest run of consecutive non-idle samples. */
export function longestBusyRun(samples, intervalUs) {
  let best = null
  let start = -1
  for (let index = 0; index <= samples.length; index++) {
    const busy = index < samples.length && !isIdle(samples[index])
    if (busy && start < 0) start = index
    if (!busy && start >= 0) {
      const first = samples[start]
      const last = samples[index - 1]
      const durationUs = last.hrUs + Math.min(last.nextUs, 5 * intervalUs) - first.hrUs
      if (!best || durationUs > best.durationUs) best = { from: start, to: index, durationUs }
      start = -1
    }
  }
  return best ? { ...best, samples: samples.slice(best.from, best.to) } : null
}

/** The task a sample belongs to: its bottom-most frame (the callback the
 * event loop entered — `processImmediate`, `processTicksAndRejections`,
 * `listOnTimeout`, a socket `onread`…). GC and `(program)` samples carry no
 * JS root and stay with the task around them. */
const NEUTRAL_ROOTS = new Set(['(garbage collector)', '(program)'])
export const taskRoot = (sample) => {
  const bottom = sample.stack.at(-1)
  return !bottom || NEUTRAL_ROOTS.has(bottom.functionName) ? null : frameKey(bottom)
}

/** The longest SINGLE task: the busy run split wherever the root changes. */
export function longestTask(samples, intervalUs) {
  let best = null
  let start = -1
  let root = null
  const close = (end) => {
    if (start < 0) return
    const first = samples[start]
    const last = samples[end - 1]
    const durationUs = last.hrUs + Math.min(last.nextUs, 5 * intervalUs) - first.hrUs
    if (!best || durationUs > best.durationUs) best = { from: start, to: end, durationUs, root }
    start = -1
    root = null
  }
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]
    if (isIdle(sample)) { close(index); continue }
    const key = taskRoot(sample)
    if (start >= 0 && key !== null && root !== null && key !== root) close(index)
    if (start < 0) start = index
    if (root === null) root = key
  }
  close(samples.length)
  return best ? { ...best, samples: samples.slice(best.from, best.to) } : null
}

/** Sampler health in the window: gaps far above the interval are samples the
 * profiler did not take (a starved sampler thread, a paused container). */
export function samplerGaps(samples, fromHr, intervalUs) {
  let maxGapUs = 0
  let lostSamples = 0
  let previous = fromHr
  for (const sample of samples) {
    const gap = sample.hrUs - previous
    if (gap > maxGapUs) maxGapUs = gap
    if (gap > 2 * intervalUs) lostSamples += Math.floor(gap / intervalUs) - 1
    previous = sample.hrUs
  }
  return { maxGapMs: round(maxGapUs / 1000), lostSamplesEstimate: lostSamples }
}

function compare(stall, baseline, baselineCount, top) {
  const rows = []
  for (const [kind, label] of [['self', 'self'], ['inclusive', 'inclusive']]) {
    const keys = new Set([...stall.maps[kind].keys()])
    const list = [...keys].map((key) => {
      const stallMs = (stall.maps[kind].get(key) ?? 0) / 1000
      const baselineMs = baselineCount ? (baseline.maps[kind].get(key) ?? 0) / 1000 / baselineCount : 0
      return { key, stallMs: round(stallMs), baselineMeanMs: round(baselineMs), excessMs: round(stallMs - baselineMs) }
    }).sort((a, b) => b.excessMs - a.excessMs).slice(0, top)
    rows.push([label, list])
  }
  return Object.fromEntries(rows)
}

const strip = (aggregation) => { const { maps, ...rest } = aggregation; return rest }

// ── The analysis ─────────────────────────────────────────────────────────────

/** Refusals: an analysis over nothing must not read as "no stall". */
export class AnalysisRefusal extends Error {}

/** In-memory entry (tests, small logs): `analyzeParsed` over a parsed string. */
export function analyze({ benchLogText, ...rest }) {
  return analyzeParsed({ bench: parseBenchLog(benchLogText), ...rest })
}

/** The windows over the threshold, as the streaming container-log reader
 * needs them (to keep only events near a stall). */
export function candidateWindows(bench, thresholdMs) {
  return windowsFromFacts(bench.facts).filter((window) => window.kind === 'sample' && !window.excluded && window.p99 > thresholdMs)
}

export function analyzeParsed({ bench, runs, containerEvents = [], thresholdMs = 70, baselineWindows = 12, baselineMaxMs = 30, top = 15 }) {
  const windows = windowsFromFacts(bench.facts)
  const sampleWindows = windows.filter((window) => window.kind === 'sample')
  if (sampleWindows.length === 0) {
    throw new AnalysisRefusal('the bench log has no G47_EVENT sample window: wrong file, or a run that never reached the soak (pass the gate log, <capture-dir>/gate.log)')
  }
  const bootIds = new Set(runs.map((run) => run.manifest.bootId))
  if (!sampleWindows.some((window) => bootIds.has(window.processBootId))) {
    throw new AnalysisRefusal(`none of the ${sampleWindows.length} sample windows belongs to a capture run in this directory (${runs.length} runs): the log and the capture are from different runs`)
  }
  const events = dedupeEvents([...containerEvents, ...bench.containerEvents])
  const rotations = events.filter((entry) => entry.event === 'read_model.ordinary_head_rotated')
  const runByBoot = new Map(runs.map((run) => [run.manifest.bootId, run]))
  const candidates = windows.filter((window) => window.kind === 'sample' && !window.excluded && window.p99 > thresholdMs)
  const stalls = []
  for (const window of candidates) {
    const run = runByBoot.get(window.processBootId)
    const lastRotation = [...rotations].reverse().find((entry) => entry.atMs <= window.windowEndMs) ?? null
    const base = {
      service: window.service, cellId: window.cellId, processBootId: window.processBootId, p99Ms: window.p99,
      gateFailing: window.p99 >= 100, phase: window.phase, cycle: window.cycle,
      windowStart: new Date(window.windowStartMs).toISOString(), windowMs: round(window.windowEndMs - window.windowStartMs),
      windowEndEstimated: window.endEstimated, hostObservedAt: window.observedAt ? new Date(window.observedAt).toISOString() : null,
      lastRotation: lastRotation ? { service: lastRotation.service, at: new Date(lastRotation.atMs).toISOString(),
        msBeforeWindowStart: round(window.windowStartMs - lastRotation.atMs), sameCell: lastRotation.service === window.service,
        workspace: lastRotation.workspace ?? null } : null,
      nearbyEvents: summarizeNearby(events, window),
    }
    if (!run) { stalls.push({ ...base, coverage: 'no-capture-run' }); continue }
    const intervalUs = run.manifest.samplingIntervalUs
    // EXTENDED BACKWARDS. The consume that closes a window resets the
    // histogram in the poll phase, BEFORE the event-loop timer records a gap
    // that ended there: a block can be charged to the window after it. So the
    // span starts max(150 ms, p99) before the window.
    const extensionMs = Math.max(150, window.p99)
    const fromHr = wallToHr(run, window.windowStartMs - extensionMs)
    const windowStartHr = wallToHr(run, window.windowStartMs)
    const toHr = wallToHr(run, window.windowEndMs)
    const { samples, coveredUs, spanUs } = samplesBetween(run, fromHr, toHr)
    const tight = longestBusyRun(samples, intervalUs)
    const task = longestTask(samples, intervalUs)
    const attribution = (run_) => {
      if (!run_) return null
      const startHr = samples[run_.from].hrUs
      const endHr = startHr + run_.durationUs
      if (endHr <= windowStartHr + 20_000) return 'previous window (ends within 20 ms of this window start: charged here by the reset order)'
      return startHr < windowStartHr ? 'straddles this window start' : 'this window'
    }
    const overlapping = (fromUs, toUs) => (entry) => entry.hrUs < toUs && entry.hrUs + entry.durUs > fromUs
    const gc = run.gc.filter(overlapping(fromHr, toHr)).map((entry) => ({ at: new Date(hrToWall(run, entry.hrUs)).toISOString(),
      durationMs: round(entry.durUs / 1000), kind: entry.kind, flags: entry.flags,
      inTightRun: tight ? entry.hrUs < samples[tight.to - 1].hrUs + 1 && entry.hrUs + entry.durUs > samples[tight.from].hrUs : false }))
    const rolls = run.rolls.filter((roll) => roll.hrUsBefore < toHr && roll.hrUsAfterEnd > fromHr)
      .map((roll) => ({ at: new Date(roll.wallMsBefore).toISOString(), mainThreadMs: round((roll.hrUsAfterEnd - roll.hrUsBefore) / 1000), reason: roll.reason }))
    // Baselines: same process, quiet, no roll overlap, NEAREST in time (same
    // load regime, and the same chunks), but not the 1.5 s around the stall.
    // Each baseline covers the SAME extended span, so the quiet and no-roll
    // filters apply to every window that span touches, not only to its own.
    const spanMs = window.windowEndMs - window.windowStartMs + extensionMs
    const sameBoot = windows.filter((other) => other.processBootId === window.processBootId)
    const spanIsQuiet = (startMs) => {
      const endMs = startMs + spanMs
      const touched = sameBoot.filter((other) => other.windowStartMs < endMs && other.windowEndMs > startMs)
      return touched.length > 0 && touched.every((other) => other.kind === 'sample' && !other.excluded && other.p99 < baselineMaxMs)
        && !run.rolls.some((roll) => roll.wallMsBefore < endMs && roll.wallMsAfter > startMs)
    }
    const quiet = sameBoot.filter((other) => other.kind === 'sample' && other !== window
      && Math.abs(other.windowStartMs - window.windowStartMs) > 1500 + extensionMs && spanIsQuiet(other.windowStartMs - extensionMs))
    const chosen = quiet.sort((a, b) => Math.abs(a.windowStartMs - window.windowStartMs) - Math.abs(b.windowStartMs - window.windowStartMs))
      .slice(0, baselineWindows).sort((a, b) => a.windowStartMs - b.windowStartMs)
    const baselineSamples = []
    const baselineRunSamples = []
    const baselineRunMs = []
    let baselineCovered = 0
    const windowUs = toHr - fromHr
    for (const other of chosen) {
      // Equal length: the stall's extended span, ending at each quiet window's start + its length.
      const start = wallToHr(run, other.windowStartMs - extensionMs)
      const got = samplesBetween(run, start, start + windowUs)
      baselineCovered += got.coveredUs
      baselineSamples.push(...got.samples)
      // And that window's longest task, the baseline of the busy run.
      const longest = longestBusyRun(got.samples, intervalUs)
      if (longest) { baselineRunSamples.push(...longest.samples); baselineRunMs.push(longest.durationUs / 1000) }
    }
    const full = aggregate(samples, intervalUs, top)
    const tightAggregate = tight ? aggregate(tight.samples, intervalUs, top) : null
    const baseline = aggregate(baselineSamples, intervalUs, top)
    const baselineRuns = aggregate(baselineRunSamples, intervalUs, top)
    const usedBaselines = chosen.length
    stalls.push({
      ...base,
      run: run.name,
      coverage: round(spanUs ? coveredUs / spanUs : 0, 3),
      sampler: { intervalUs, ...samplerGaps(samples, fromHr, intervalUs), samples: samples.length,
        expectedSamples: Math.round(spanUs / intervalUs) },
      clockDomainOk: run.clockChecks.every((check) => check.ok),
      extensionMs: round(extensionMs),
      clockStepsInRun: run.clockSteps.length,
      // The merged busy run (no idle sample) and the longest single task in it.
      // Per-function ms are SAMPLED time: each sample weighs the time to the
      // next one, capped at 5 intervals, so sampler-gap time is excluded —
      // compare `sampledMs` with `durationMs`.
      tightRun: tight ? { start: new Date(hrToWall(run, samples[tight.from].hrUs)).toISOString(), durationMs: round(tight.durationUs / 1000),
        sampledMs: tightAggregate.totalMs, samples: tight.samples.length, attributedFrom: attribution(tight), aggregate: strip(tightAggregate) } : null,
      longestTask: task ? { start: new Date(hrToWall(run, samples[task.from].hrUs)).toISOString(), durationMs: round(task.durationUs / 1000),
        root: task.root, samples: task.samples.length, attributedFrom: attribution(task), aggregate: strip(aggregate(task.samples, intervalUs, 5)) } : null,
      window: strip(full),
      scheduling: {
        window: schedulingBetween(run, fromHr, toHr),
        busyRun: tight ? schedulingBetween(run, samples[tight.from].hrUs, samples[tight.from].hrUs + tight.durationUs) : null,
      },
      gc, gcMsInWindow: round(gc.reduce((sum, entry) => sum + entry.durationMs, 0)),
      gcMsInTightRun: round(gc.filter((entry) => entry.inTightRun).reduce((sum, entry) => sum + entry.durationMs, 0)),
      rollsOverlapping: rolls,
      baseline: { windows: usedBaselines, coveredMs: round(baselineCovered / 1000), aggregate: strip(baseline),
        longestTaskMs: baselineRunMs.length ? { mean: round(baselineRunMs.reduce((a, b) => a + b, 0) / baselineRunMs.length), max: round(Math.max(...baselineRunMs)) } : null,
        // The whole window against quiet windows of equal length…
        excessWindow: compare(full, baseline, usedBaselines, top),
        // …and the busy run against those windows' own longest tasks.
        excessBusyRun: tightAggregate ? compare(tightAggregate, baselineRuns, baselineRunMs.length, top) : null },
    })
  }
  const byService = {}
  for (const window of windows.filter((entry) => entry.kind === 'sample' && !entry.excluded)) {
    if (!byService[window.service]) byService[window.service] = { windows: 0, over70: 0, over100: 0, maxP99Ms: 0 }
    const row = byService[window.service]
    row.windows += 1
    if (window.p99 > 70) row.over70 += 1
    if (window.p99 >= 100) row.over100 += 1
    row.maxP99Ms = Math.max(row.maxP99Ms, window.p99)
  }
  return {
    schema: 'maplespire.cell-stalls.v1',
    thresholdMs, baselineMaxMs,
    summary: bench.summary, gateFailures: bench.failures.length,
    windows: { total: windows.length, byService },
    capture: runs.map((run) => ({ run: run.name, cellId: run.manifest.cellId, bootId: run.manifest.bootId,
      samplingIntervalUs: run.manifest.samplingIntervalUs, chunkSeconds: run.manifest.chunkSeconds, chunks: run.chunks.length,
      clockDomainOk: run.clockChecks.every((check) => check.ok), clockChecks: run.clockChecks.length,
      schedReadings: run.sched.rows.count, wallClockSteps: run.clockSteps,
      rollMainThreadMs: rollStats(run.rolls), gcEntries: run.gc.length, stoppedCleanly: run.stop?.finalChunkWritten ?? null,
      unprofiledGapsMs: chunkGaps(run) })),
    rotations: rotations.map((entry) => ({ service: entry.service, at: new Date(entry.atMs).toISOString(), workspace: entry.workspace ?? null })),
    stalls,
  }
}

function summarizeNearby(events, window) {
  const near = events.filter((entry) => entry.event && entry.atMs >= window.windowStartMs - 1000 && entry.atMs <= window.windowEndMs + 1000)
  const counts = {}
  for (const entry of near) counts[`${entry.service}:${entry.event}`] = (counts[`${entry.service}:${entry.event}`] ?? 0) + 1
  return counts
}

/** Steady-state roll cost: rolls that ENDED a chunk. The first roll ends
 * none — it starts the worker's profiler, which re-logs the heap's code once
 * at boot — and is reported apart as `firstRollMs`. */
function rollStats(rolls) {
  const costs = rolls.filter((roll) => roll.ended).map((roll) => (roll.hrUsAfterEnd - roll.hrUsBefore) / 1000).sort((a, b) => a - b)
  const first = rolls.find((roll) => !roll.ended && roll.reason !== 'shutdown')
  if (!costs.length) return first ? { count: 0, firstRollMs: round((first.hrUsAfterEnd - first.hrUsBefore) / 1000) } : null
  const at = (q) => round(costs[Math.min(costs.length - 1, Math.floor(q * costs.length))])
  return { count: costs.length, p50: at(0.5), p99: at(0.99), max: round(costs.at(-1)),
    firstRollMs: first ? round((first.hrUsAfterEnd - first.hrUsBefore) / 1000) : null }
}

/** Time between consecutive chunks that NO chunk covers (should be zero:
 * chunks overlap by design). */
function chunkGaps(run) {
  let total = 0
  let max = 0
  for (let index = 1; index < run.chunks.length; index++) {
    const gap = run.chunks[index].startTime - run.chunks[index - 1].endTime
    if (gap > 0) { total += gap; max = Math.max(max, gap) }
  }
  return { totalMs: round(total / 1000), maxMs: round(max / 1000) }
}

// ── Markdown ─────────────────────────────────────────────────────────────────

const cell = (value) => String(value ?? '—').replace(/\|/g, '\\|')

export function renderMarkdown(report) {
  const lines = []
  lines.push('# Event-loop stalls: what the main thread was doing', '')
  lines.push(`Threshold: p99 > ${report.thresholdMs} ms (the gate fails at ≥ 100). Baselines: same process, p99 < ${report.baselineMaxMs} ms, no capture roll, equal length, nearest in time outside ±1.5 s.`, '')
  if (report.summary) lines.push(`Run: ${report.summary.source} status ${report.summary.status ?? '—'}; firstFailure: ${report.summary.firstFailure ? `${report.summary.firstFailure.criterion} ${report.summary.firstFailure.value} on ${report.summary.firstFailure.service} (${report.summary.firstFailure.phase} ${report.summary.firstFailure.cycle})` : 'none'}.`, '')
  lines.push('## Windows per cell', '', '| cell | windows | > 70 ms | ≥ 100 ms | max p99 |', '|---|---|---|---|---|')
  for (const [service, row] of Object.entries(report.windows.byService)) lines.push(`| ${service} | ${row.windows} | ${row.over70} | ${row.over100} | ${row.maxP99Ms} |`)
  lines.push('', '## Capture', '', '| run | chunks | clock ok | wall steps > 5 ms | steady roll main-thread ms p50 / p99 / max | unprofiled gaps ms | GC entries | sched readings | final chunk |', '|---|---|---|---|---|---|---|---|---|')
  for (const run of report.capture) {
    const rolls = run.rollMainThreadMs?.count ? `${run.rollMainThreadMs.p50} / ${run.rollMainThreadMs.p99} / ${run.rollMainThreadMs.max} (boot roll ${run.rollMainThreadMs.firstRollMs ?? '—'})` : '—'
    const steps = run.wallClockSteps.length ? run.wallClockSteps.map((step) => `${step.stepMs} ms at ${step.at}`).join('; ') : 'none'
    lines.push(`| ${run.run} | ${run.chunks} | ${run.clockDomainOk} | ${steps} | ${rolls} | ${run.unprofiledGapsMs.totalMs} | ${run.gcEntries} | ${run.schedReadings} | ${run.stoppedCleanly} |`)
  }
  lines.push('', `Rotations seen (any cell): ${report.rotations.length}.`, '')
  lines.push('## Stalls', '')
  if (!report.stalls.length) lines.push('No sample above the threshold.', '')
  lines.push('| # | cell | window start (cell clock) | p99 | phase | coverage | busy run ms | top self (busy run) | GC ms in run | roll overlap | since rotation (cell) |', '|---|---|---|---|---|---|---|---|---|---|---|')
  report.stalls.forEach((stall, index) => {
    const topSelf = stall.tightRun?.aggregate.self[0] ?? stall.window?.self[0]
    lines.push(`| ${index + 1} | ${stall.service} | ${stall.windowStart} | ${stall.p99Ms} | ${cell(stall.phase)} ${cell(stall.cycle)} | ${cell(stall.coverage)} | ${cell(stall.tightRun?.durationMs)} | ${cell(topSelf ? `${topSelf.key} (${topSelf.ms})` : null)} | ${cell(stall.gcMsInTightRun)} | ${stall.rollsOverlapping?.length ? stall.rollsOverlapping.map((roll) => roll.mainThreadMs).join(', ') : 'no'} | ${stall.lastRotation ? `${round(stall.lastRotation.msBeforeWindowStart / 1000, 1)} s (${stall.lastRotation.service}${stall.lastRotation.sameCell ? ', same' : ', other'})` : '—'} |`)
  })
  report.stalls.forEach((stall, index) => {
    lines.push('', `### ${index + 1}. ${stall.service} at ${stall.windowStart} — p99 ${stall.p99Ms} ms`, '')
    if (stall.coverage === 'no-capture-run') { lines.push('No capture run for this process (processBootId not found): UNCOVERED.'); return }
    lines.push(`Window ${stall.windowMs} ms${stall.windowEndEstimated ? ' (end estimated)' : ''}, analysed from ${stall.extensionMs} ms before its start (a block can be charged to the window after it), coverage ${stall.coverage}, samples ${stall.sampler.samples}/${stall.sampler.expectedSamples} expected, max sampler gap ${stall.sampler.maxGapMs} ms, lost ≈ ${stall.sampler.lostSamplesEstimate}, clock domain ${stall.clockDomainOk ? 'ok' : 'NOT VERIFIED'}.`)
    if (stall.clockStepsInRun) lines.push(`WARNING: this run's wall clock stepped ${stall.clockStepsInRun} time(s) by > 5 ms (see Capture): wall↔hrtime mapping near a step is off by that much.`)
    lines.push(`Longest single task: ${stall.longestTask ? `${stall.longestTask.durationMs} ms from ${stall.longestTask.start}, root ${stall.longestTask.root ?? '(none)'}, attributed from ${stall.longestTask.attributedFrom}; top self ${stall.longestTask.aggregate.self.slice(0, 3).map((row) => `${row.key} (${row.ms})`).join(', ')}` : 'none'}.`)
    lines.push(`Busy run (merged, no idle sample; may chain several tasks): ${stall.tightRun ? `${stall.tightRun.durationMs} ms from ${stall.tightRun.start} (${stall.tightRun.samples} samples, ${stall.tightRun.sampledMs} ms sampled), attributed from ${stall.tightRun.attributedFrom}` : 'none'}. GC in window ${stall.gcMsInWindow} ms, in busy run ${stall.gcMsInTightRun} ms. Rolls overlapping: ${stall.rollsOverlapping.length ? JSON.stringify(stall.rollsOverlapping) : 'none'}.`)
    const sched = stall.scheduling?.window
    const schedRun = stall.scheduling?.busyRun
    lines.push(sched
      ? `Main thread (schedstat), window: on CPU ${sched.onCpuMs} ms, run-queue wait ${sched.runQueueMs} ms, off CPU ${sched.offCpuMs} ms of ${sched.spanMs} ms (${sched.timeslices} slices, VM steal share ${sched.vmStealShare ?? '—'})${schedRun ? `; busy run: on CPU ${schedRun.onCpuMs}, wait ${schedRun.runQueueMs}, off ${schedRun.offCpuMs} of ${schedRun.spanMs} ms` : ''}.`
      : 'Main thread scheduling: no schedstat readings bracket this window.')
    if (stall.lastRotation) lines.push(`Last rotation: ${stall.lastRotation.service} at ${stall.lastRotation.at}, ${round(stall.lastRotation.msBeforeWindowStart / 1000, 2)} s before.`)
    if (Object.keys(stall.nearbyEvents).length) lines.push(`Log events within ±1 s: ${Object.entries(stall.nearbyEvents).map(([key, count]) => `${key} ×${count}`).join(', ')}.`)
    const agg = stall.tightRun?.aggregate ?? stall.window
    lines.push('', `Categories (busy run, ms): ${Object.entries(agg.categories).map(([key, ms]) => `${key} ${ms}`).join(', ')}; whole window: ${Object.entries(stall.window.categories).map(([key, ms]) => `${key} ${ms}`).join(', ')}; baseline (${stall.baseline.windows} windows, total): ${Object.entries(stall.baseline.aggregate.categories).map(([key, ms]) => `${key} ${ms}`).join(', ')}.`)
    const excess = stall.baseline.excessBusyRun ?? stall.baseline.excessWindow
    const against = stall.baseline.excessBusyRun
      ? `busy run vs the baseline windows' longest tasks (mean ${stall.baseline.longestTaskMs?.mean} ms, max ${stall.baseline.longestTaskMs?.max} ms)`
      : 'window vs baseline windows of equal length'
    lines.push('', `Excess over baseline — ${against}. Per-function ms are sampled time (each sample weighs the time to the next, capped at 5 intervals): sampler-gap time is excluded.`)
    lines.push('', '| self | stall ms | baseline mean ms | excess ms |', '|---|---|---|---|')
    for (const row of excess.self.slice(0, 10)) lines.push(`| ${cell(row.key)} | ${row.stallMs} | ${row.baselineMeanMs} | ${row.excessMs} |`)
    lines.push('', '| inclusive | stall ms | baseline mean ms | excess ms |', '|---|---|---|---|')
    for (const row of excess.inclusive.slice(0, 10)) lines.push(`| ${cell(row.key)} | ${row.stallMs} | ${row.baselineMeanMs} | ${row.excessMs} |`)
    lines.push('', 'Whole window vs baseline windows of equal length (self):', '', '| self | stall ms | baseline mean ms | excess ms |', '|---|---|---|---|')
    for (const row of stall.baseline.excessWindow.self.slice(0, 6)) lines.push(`| ${cell(row.key)} | ${row.stallMs} | ${row.baselineMeanMs} | ${row.excessMs} |`)
    lines.push('', '| top-of-stack path (leaf < callers), busy run | ms |', '|---|---|')
    for (const row of agg.paths.slice(0, 8)) lines.push(`| ${cell(row.key)} | ${row.ms} |`)
    if (stall.gc.length) {
      lines.push('', '| GC at | ms | kind | flags | in busy run |', '|---|---|---|---|---|')
      for (const entry of stall.gc) lines.push(`| ${entry.at} | ${entry.durationMs} | ${entry.kind} | ${entry.flags} | ${entry.inTightRun} |`)
    }
  })
  lines.push('')
  return lines.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const values = (flag) => argv.filter((arg) => arg.startsWith(`${flag}=`)).map((arg) => arg.slice(flag.length + 1))
  const one = (flag) => values(flag).at(-1)
  const number = (flag, fallback) => { const raw = one(flag); const value = raw === undefined ? fallback : Number(raw); if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`); return value }
  const captureDir = one('--capture-dir')
  if (!captureDir) throw new Error('usage: analyze-cell-stalls.mjs --capture-dir=<dir> [--bench-log=<file>, default <dir>/gate.log] [--container-log=<file>]... [--threshold-ms=70] [--baseline-windows=12] [--baseline-max-ms=30] [--top=15] [--out=<dir>]')
  // The bench tees the gate's output there itself (`--cpu-profile=on`).
  const benchLog = one('--bench-log') ?? join(captureDir, 'gate.log')
  const options = { benchLog: resolve(benchLog), captureDir: resolve(captureDir), containerLogs: values('--container-log').map((file) => resolve(file)),
    thresholdMs: number('--threshold-ms', 70), baselineWindows: number('--baseline-windows', 12), baselineMaxMs: number('--baseline-max-ms', 30),
    top: number('--top', 15), out: resolve(one('--out') ?? captureDir) }
  if (!existsSync(options.benchLog)) throw new Error(`no gate log at ${options.benchLog}: pass --bench-log=<the run's log>`)
  return options
}

/**
 * Container events from `compose-logs/*.log` and extra files, streamed. Kept:
 * every rotation (any cell), and any other event within ±1 s of a candidate
 * window — the only ones the report shows — so memory stays bounded.
 */
export async function containerEventsFromFiles(captureDir, extra = [], windows = []) {
  const files = []
  const logs = join(captureDir, 'compose-logs')
  if (existsSync(logs)) files.push(...readdirSync(logs).filter((name) => name.endsWith('.log')).map((name) => join(logs, name)))
  files.push(...extra)
  const ranges = windows.map((window) => [window.windowStartMs - 1000, window.windowEndMs + 1000]).sort((a, b) => a[0] - b[0])
  const near = (atMs) => ranges.some(([from, to]) => atMs >= from && atMs <= to)
  const events = []
  for (const file of files) {
    const service = basename(file).replace(/\.log$/, '')
    await readLines(file, (line) => {
      const entry = containerEvent(line, service)
      if (entry && (entry.event === 'read_model.ordinary_head_rotated' || near(entry.atMs))) events.push(entry)
    })
  }
  return events
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const began = Date.now()
  const bench = await readBenchLog(options.benchLog)
  const runs = await loadCaptureDir(options.captureDir)
  const containerEvents = await containerEventsFromFiles(options.captureDir, options.containerLogs, candidateWindows(bench, options.thresholdMs))
  // The bench log's own container lines are filtered by the same rule.
  const windows = candidateWindows(bench, options.thresholdMs)
  bench.containerEvents = bench.containerEvents.filter((entry) => entry.event === 'read_model.ordinary_head_rotated'
    || windows.some((window) => entry.atMs >= window.windowStartMs - 1000 && entry.atMs <= window.windowEndMs + 1000))
  const report = analyzeParsed({ bench, runs, containerEvents, thresholdMs: options.thresholdMs,
    baselineWindows: options.baselineWindows, baselineMaxMs: options.baselineMaxMs, top: options.top })
  report.input = { benchLog: options.benchLog, benchLogLines: bench.lines, analysisMs: Date.now() - began }
  mkdirSync(options.out, { recursive: true })
  writeFileSync(join(options.out, 'stall-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(options.out, 'stall-report.md'), renderMarkdown(report))
  process.stdout.write(`${JSON.stringify({ stalls: report.stalls.length, uncovered: report.stalls.filter((stall) => stall.coverage === 'no-capture-run').length,
    runs: report.capture.length, rotations: report.rotations.length, out: options.out })}\n`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
