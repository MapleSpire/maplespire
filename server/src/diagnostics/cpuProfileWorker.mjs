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
 * The off-main-thread half of `cpuProfileCapture.ts`: an inspector session on
 * the MAIN thread's isolate (`connectToMainThread`), which receives every
 * finished `console.profile` chunk as a `Profiler.consoleProfileFinished`
 * notification, and the only code in the capture that touches the disk.
 * Parsing, stringifying, gzip and writes all block this thread, never the
 * event loop being measured.
 *
 * Writes are synchronous ON PURPOSE: this thread has nothing else to do, and a
 * synchronous write is finished when the next message is read, which is what
 * lets the shutdown chunk land before the server's `process.exit`.
 *
 * Static imports only. A worker whose event loop has no handle exits silently
 * — the keep-alive timer below is created before the first await for that
 * reason — and the inspector callback must not depend on a dynamic import.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session } from 'node:inspector'
import { parentPort, workerData } from 'node:worker_threads'
import { gzipSync } from 'node:zlib'

if (!parentPort) throw new Error('cpu profile worker requires a parent port')
const port = parentPort
const data = workerData
const runDirectory = join(data.directory, data.runDirectoryName)
const hrUs = () => Number(process.hrtime.bigint() / 1000n)
/** `perf_hooks.constants.NODE_PERFORMANCE_GC_*`. */
const GC_KINDS = { 1: 'minor', 4: 'major', 8: 'incremental', 16: 'weakcb' }

/** Pending GC lines, flushed once a second by the keep-alive timer. */
let gcLines = []
const flushGc = () => {
  if (gcLines.length === 0) return
  const text = gcLines.join('')
  gcLines = []
  appendFileSync(join(runDirectory, 'gc.ndjson'), text)
}
setInterval(() => {
  try { flushGc() } catch (error) { report('gc-write', error) }
}, 1000)

function report(stage, error) {
  port.postMessage({ type: 'error', stage, error: error instanceof Error ? error.message : String(error) })
}

const event = (record) => appendFileSync(join(runDirectory, 'events.ndjson'), `${JSON.stringify({ ...record, workerWallMs: Date.now(), workerHrUs: hrUs() })}\n`)

/** Parse `maplespire-cpu-000123` back to 123; null for a title not ours. */
const seqOf = (title) => {
  const match = /^maplespire-cpu-(\d{6})$/.exec(String(title ?? ''))
  return match ? Number(match[1]) : null
}

/**
 * SCHEDULING CHANNEL (Linux only; absent elsewhere and recorded as such).
 * The main thread's TID is the process PID. `schedstat` = on-CPU ns, run-queue
 * wait ns, timeslices — cumulative, so any window's share is a difference.
 * `/proc/stat` steal (VM-level, USER_HZ ticks) shows hypervisor descheduling,
 * which the guest's own schedstat cannot see. Read here, on this thread: the
 * main thread pays nothing for it.
 */
const SCHEDSTAT = `/proc/self/task/${process.pid}/schedstat`
const readSched = () => readFileSync(SCHEDSTAT, 'utf8').trim().split(/\s+/).map(Number)
const readSteal = () => {
  const fields = readFileSync('/proc/stat', 'utf8').split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number)
  return [fields[7] ?? 0, fields.reduce((sum, value) => sum + value, 0)]
}
let schedAvailable = false
try { schedAvailable = readSched().length >= 3 && readSteal().length === 2 } catch { schedAvailable = false }
let schedRows = []
let stealRows = []
if (schedAvailable) {
  let tick = 0
  setInterval(() => {
    try {
      // Stamped BEFORE the read: the stamp is when this worker ran, which the
      // deep analysis uses as the worker's own liveness.
      const at = hrUs()
      const [run, wait, slices] = readSched()
      schedRows.push([at, run, wait, slices])
      if (tick++ % 10 === 0) stealRows.push([hrUs(), ...readSteal()])
    } catch { /* a transient read failure leaves a gap, visible as such */ }
  }, 10)
}
/** The readings since the last write, beside the chunk they accompany. */
function writeSched(seq) {
  if (!schedAvailable || schedRows.length === 0) return
  const file = `sched-${String(seq).padStart(6, '0')}.json.gz`
  const body = { columns: ['hrUs', 'runNs', 'waitNs', 'slices'], rows: schedRows, steal: { columns: ['hrUs', 'stealTicks', 'totalTicks'], rows: stealRows } }
  schedRows = []
  stealRows = []
  const temporary = join(runDirectory, `.${file}.tmp`)
  writeFileSync(temporary, gzipSync(JSON.stringify(body), { level: 6 }))
  renameSync(temporary, join(runDirectory, file))
}

function writeChunk(seq, profile, source) {
  const began = hrUs()
  try { writeSched(seq) } catch (error) { report('sched-write', error) }
  const file = `cpu-${String(seq).padStart(6, '0')}.cpuprofile.gz`
  const json = JSON.stringify(profile)
  const gz = gzipSync(json, { level: 6 })
  const temporary = join(runDirectory, `.${file}.tmp`)
  writeFileSync(temporary, gz)
  renameSync(temporary, join(runDirectory, file))
  event({ type: 'chunk', seq, title: seq === 0 ? 'boot' : `maplespire-cpu-${String(seq).padStart(6, '0')}`, source, file,
    startTime: profile?.startTime ?? null, endTime: profile?.endTime ?? null,
    samples: profile?.samples?.length ?? 0, nodes: profile?.nodes?.length ?? 0,
    jsonBytes: json.length, gzBytes: gz.length, writeMs: (hrUs() - began) / 1000 })
}

mkdirSync(runDirectory, { recursive: true })
writeFileSync(join(runDirectory, 'manifest.json'), `${JSON.stringify({
  schema: 'maplespire.cpu-profile-capture.v1',
  bootId: data.bootId, cellId: data.cellId, hostname: data.hostname, pid: data.pid, nodeVersion: data.nodeVersion,
  samplingIntervalUs: data.samplingIntervalUs, chunkSeconds: data.chunkSeconds,
  // `anchor` pairs Date.now(), performance.now() and hrtime (µs) at install;
  // `timeOrigin` is performance's own wall origin. Profile and GC times are
  // hrtime µs; every `roll` record in events.ndjson carries a fresh pair.
  anchor: data.anchor, timeOrigin: data.timeOrigin, bootChunk: data.bootChunk,
  clock: 'profile startTime/endTime/timeDeltas and gc start are microseconds on the process.hrtime clock',
  files: { events: 'events.ndjson', gc: 'gc.ndjson (one entry per main-isolate GC: hrUs start, durUs, kind, flags)', chunks: 'cpu-NNNNNN.cpuprofile.gz',
    sched: schedAvailable ? 'sched-NNNNNN.json.gz (main-thread schedstat every 10 ms, /proc/stat steal every 100 ms; cumulative)' : 'unavailable on this host' },
  sched: { available: schedAvailable, path: SCHEDSTAT, periodMs: 10, stealPeriodMs: 100 },
}, null, 2)}\n`)

const session = new Session()
session.connectToMainThread()
const post = (method, params) => new Promise((resolve, reject) => {
  session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result)))
})

/** SHUTDOWN ORDER. The final chunk's notification (session) and the `stop`
 * message (port) travel on two channels, in either order. Disconnect only
 * once the chunk the shutdown roll ended is written — or after 3 s — so an
 * exiting process is not left "waiting for the debugger to disconnect". */
const written = new Set()
let finalTitle = null
let stopReason = null
let finished = false
const finishIfDone = (force = false) => {
  if (finished || stopReason === null || (!force && finalTitle !== null && !written.has(finalTitle))) return
  finished = true
  try {
    flushGc()
    writeSched(999999)
    event({ type: 'stop', reason: stopReason, finalChunkWritten: finalTitle === null || written.has(finalTitle) })
  } catch (error) { report('stop', error) }
  session.disconnect()
}

session.on('Profiler.consoleProfileFinished', (message) => {
  const seq = seqOf(message?.params?.title)
  if (seq === null) return
  try { writeChunk(seq, message.params.profile, 'console') } catch (error) { report('chunk-write', error) }
  written.add(message.params.title)
  finishIfDone()
})

port.on('message', (message) => {
  try {
    if (message?.type === 'gc') {
      const anchorWall = data.anchor.wallMs
      const anchorHr = data.anchor.hrUs
      for (const [startHrUs, durUs, kind, flags] of message.entries) {
        gcLines.push(`${JSON.stringify({ hrUs: startHrUs, durUs, kind: GC_KINDS[kind] ?? `kind-${kind}`, kindCode: kind, flags,
          wallMs: anchorWall + (startHrUs - anchorHr) / 1000 })}\n`)
      }
    } else if (message?.type === 'roll') {
      if (message.reason === 'shutdown') finalTitle = message.ended
      event(message)
    } else if (message?.type === 'boot-profile') {
      const { profile, ...timing } = message
      event({ ...timing, type: 'boot-stop' })
      if (profile) writeChunk(0, profile, 'boot')
    } else if (message?.type === 'stop') {
      stopReason = String(message.reason ?? 'stop')
      setTimeout(() => finishIfDone(true), 3000).unref()
      finishIfDone()
    }
  } catch (error) {
    report(`message-${message?.type}`, error)
  }
})

void (async () => {
  try {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: data.samplingIntervalUs })
    event({ type: 'worker-ready' })
    port.postMessage({ type: 'ready' })
  } catch (error) {
    report('session', error)
  }
})()
