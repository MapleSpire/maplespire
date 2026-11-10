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
 * BENCH-ONLY DIAGNOSTIC: a CPU profile of the main thread and a log of its GC
 * pauses, from boot, in rolling chunks a host can read while the process runs.
 * It exists to explain the 100–108 ms event-loop stalls of the G4 fleet soak
 * (`server/scripts/analyze-cell-stalls.mjs` reads what it writes). Off unless
 * `SYNC_DIAG_CPU_PROFILE=on`; with the flag off nothing below runs — no
 * inspector session, no worker, no observer, no timer.
 *
 * WHY THIS MECHANISM, AND NOT `node --cpu-prof`.
 *
 * `--cpu-prof` writes one file when the process EXITS. The cells do exit
 * cleanly on the bench's teardown (`index.ts` handles SIGTERM and ends in
 * `process.exit(0)`, which still writes the profile), but the soak's evidence
 * would then depend on three things it cannot afford: (1) a two-hour profile
 * held in V8's memory and serialised in one block during the 35 s
 * `stop_grace_period` — longer than that and Docker SIGKILLs the cell and the
 * whole run's stacks are gone; (2) any path that kills a cell (an OOM, a
 * harness abandon) leaves nothing; (3) it travels in `NODE_OPTIONS` or the
 * image `CMD`, and `NODE_OPTIONS` also reaches every `node -e` healthcheck and
 * `docker exec node` probe, each writing its own profile. Nor can a host read
 * it before the end of the run.
 *
 * So: an in-process inspector profile, rolled into chunks. The costly part of
 * a roll is that ending a profile SERIALISES IT ON THE MAIN THREAD — exactly
 * the kind of stall being diagnosed — so the design keeps everything else off
 * that thread and records the rest:
 *
 *   - A WORKER hosts the inspector session (`connectToMainThread`), receives
 *     each finished profile, gzips and writes it. The main thread never parses
 *     or stringifies a profile, and does no file I/O for this module.
 *   - Chunks are `console.profile(title)` / `console.profileEnd(title)` and
 *     OVERLAP: the next chunk starts before the previous one ends. That keeps
 *     the V8 CpuProfiler alive across rolls — a stop-then-start disposes it,
 *     and the next start re-logs every code object in the heap (measured 7–16
 *     ms on a toy heap, more on a cell's) — and leaves no unsampled gap.
 *   - Each roll's main-thread cost is measured where it is paid (hrtime around
 *     the two calls) and logged with its wall/hrtime anchors, so the analysis
 *     can exclude any stall window that overlaps a roll. Chunk length bounds
 *     that cost; see `CHUNK_SECONDS_BOUNDS`.
 *   - BOOT: the first chunk is a frontend `Profiler.start` on a short-lived
 *     in-thread session, started synchronously at import — before Automerge is
 *     evaluated (this module is imported right after the wasm gauge, see
 *     `index.ts`). When the worker is ready, chunk 1 starts and the boot chunk
 *     is stopped (a one-off main-thread cost, logged like a roll) and handed to
 *     the worker; the boot session then disconnects.
 *
 * TIMESTAMPS. V8 profile times are microseconds on the same monotonic clock as
 * `process.hrtime` (checked at every chunk start: the `start` record carries
 * the hrtime bracket around the `console.profile` call, and the analysis
 * verifies `profile.startTime` falls inside it). Every roll record pairs
 * `Date.now()` with hrtime, so any profile sample or GC entry converts to the
 * cell's wall clock — the clock its `eventLoopWindow.startedAt` is written in.
 *
 * GC. A `PerformanceObserver('gc')` on the main thread from boot: every entry
 * (kind, flags, start, duration — main isolate only), batched to the worker
 * once a second. The V8 profile also attributes samples taken during a pause
 * to `(garbage collector)`; the two are independent witnesses.
 *
 * SCHEDULING (Linux). The worker also reads the main thread's
 * `/proc/self/task/<pid>/schedstat` (on-CPU ns, run-queue wait ns) every 10 ms
 * and `/proc/stat` steal every 100 ms, so a stall can be split into "the main
 * thread ran", "it waited for a CPU" and "it was off CPU" — the three readings
 * a profile alone cannot tell apart when samples go missing.
 *
 * Files (`<dir>/<cellId>-<processBootId>/`): `manifest.json`, `events.ndjson`
 * (one record per chunk start, roll and written chunk), `cpu-NNNNNN.cpuprofile.gz`
 * (a DevTools-loadable profile, gzipped), `gc.ndjson`, `sched-NNNNNN.json.gz`.
 */

import { hostname } from 'node:os'
import { isAbsolute } from 'node:path'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import { Worker } from 'node:worker_threads'
import { envNumber } from '../envNumber.js'
import { currentProcessBootId } from '../processIdentity.js'

/** The activation flag. `on` arms the capture; missing, blank, `off` or any
 * other value leaves the process exactly as it is without this module. */
export const CPU_PROFILE_FLAG = 'SYNC_DIAG_CPU_PROFILE'
/** Absolute directory INSIDE the process's filesystem (the bench bind-mounts a
 * host directory there). Required when the flag is on. */
export const CPU_PROFILE_DIR_ENV = 'SYNC_DIAG_CPU_PROFILE_DIR'
export const CPU_PROFILE_INTERVAL_ENV = 'SYNC_DIAG_CPU_PROFILE_INTERVAL_US'
export const CPU_PROFILE_CHUNK_ENV = 'SYNC_DIAG_CPU_PROFILE_CHUNK_SECONDS'

/** V8's own default (1 ms): a 100 ms stall is ~100 samples. MEASURED
 * (2026-11-04, macOS host, node 22): on an Automerge sync fan-out load, CPU
 * +4 % mean over four paired runs (range −2 % … +12 %, run-to-run noise ~±3 %),
 * event-loop p99 unchanged (3.3–4.2 ms vs 3.3–3.6 ms); 500 µs measured the
 * same within noise. In the Docker Desktop fleet soak: +1–3 CPU points on the
 * hot cells (≈ 20 % of a core) and +3–4 on the near-idle spare (the sampler's
 * fixed cost). In Linux containers the sampler DROPS samples during busy
 * stretches (~4 % of busy samples are followed by a > 5 ms gap, vs 0.1 % on
 * macOS): the analysis reports them per window as lost samples. */
export const SAMPLING_INTERVAL_US_BOUNDS = { fallback: 1000, minimum: 100, maximum: 100_000, integer: true }
/** A roll serialises one chunk on the main thread, in proportion to its
 * samples and nodes. Measured on the hot cells of a local fleet soak (Docker
 * Desktop, 1 ms sampling): 30 s chunks cost 9–27 ms per roll, over the 20 ms
 * budget; 10 s chunks keep it well under (see the `roll` records of
 * `events.ndjson`, which the analysis reports as p50/p99/max). */
export const CHUNK_SECONDS_BOUNDS = { fallback: 10, minimum: 5, maximum: 600, integer: true }

export type CpuProfileCaptureConfig =
  | { enabled: false; reason: 'flag-off' | 'directory-missing' }
  | { enabled: true; directory: string; samplingIntervalUs: number; chunkSeconds: number }

export function cpuProfileCaptureConfig(env: Readonly<Record<string, string | undefined>> = process.env): CpuProfileCaptureConfig {
  if (env[CPU_PROFILE_FLAG]?.trim() !== 'on') return { enabled: false, reason: 'flag-off' }
  const directory = env[CPU_PROFILE_DIR_ENV]?.trim() ?? ''
  if (!directory || !isAbsolute(directory)) return { enabled: false, reason: 'directory-missing' }
  return {
    enabled: true,
    directory,
    samplingIntervalUs: envNumber(CPU_PROFILE_INTERVAL_ENV, SAMPLING_INTERVAL_US_BOUNDS, env),
    chunkSeconds: envNumber(CPU_PROFILE_CHUNK_ENV, CHUNK_SECONDS_BOUNDS, env),
  }
}

/** Microseconds on the hrtime clock, the clock V8 stamps profiles with. */
export const hrUs = (): number => Number(process.hrtime.bigint() / 1000n)

export const chunkTitle = (seq: number): string => `maplespire-cpu-${String(seq).padStart(6, '0')}`

/** What the main thread needs from its environment — injectable so the test
 * drives every branch without a real inspector or worker. */
export interface CaptureDeps {
  createWorker: (url: URL, workerData: unknown) => WorkerLike
  createGcObserver: (onEntries: (entries: GcEntryLike[]) => void) => { observe(): void; disconnect(): void }
  bootSession: () => BootSessionLike
  profile: (title: string) => void
  profileEnd: (title: string) => void
  setInterval: (fn: () => void, ms: number) => { unref?(): void }
  clearInterval: (handle: unknown) => void
  onSignal: (signal: 'SIGTERM' | 'SIGINT' | 'SIGUSR2', fn: () => void) => void
  log: (line: string) => void
}

export interface WorkerLike {
  postMessage(message: unknown): void
  on(event: 'message' | 'error' | 'exit', listener: (value: unknown) => void): void
  unref?(): void
}
export interface BootSessionLike {
  /** Synchronous on an in-thread session. */
  post(method: string, params: Record<string, unknown>, callback: (error: Error | null, result?: { profile?: unknown }) => void): void
  disconnect(): void
}
export interface GcEntryLike { startTime: number; duration: number; detail?: { kind?: number; flags?: number } | unknown }

/** An in-thread session answers synchronously; anything else is a failure. */
function syncCall(session: BootSessionLike, method: string, params: Record<string, unknown> = {}): { profile?: unknown } | undefined {
  let answered = false
  let failure: Error | null = null
  let value: { profile?: unknown } | undefined
  session.post(method, params, (error, result) => { answered = true; failure = error; value = result })
  if (failure) throw failure
  if (!answered) throw new Error(`${method} did not answer synchronously`)
  return value
}

const realDeps = (): CaptureDeps => ({
  // `execArgv: []`: the worker is plain .mjs on node builtins and must not
  // inherit the parent's flags (`--input-type`, a loader, a `--cpu-prof`).
  createWorker: (url, workerData) => new Worker(url, { workerData, execArgv: [] }) as unknown as WorkerLike,
  createGcObserver: (onEntries) => {
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries() as unknown as GcEntryLike[]))
    return { observe: () => observer.observe({ entryTypes: ['gc'] }), disconnect: () => observer.disconnect() }
  },
  bootSession: () => {
    const session = new Session()
    session.connect()
    return session as unknown as BootSessionLike
  },
  // Node's global console forwards these to the V8 inspector console, which
  // starts/ends a titled profile in every session that has Profiler enabled.
  profile: (title) => console.profile(title),
  profileEnd: (title) => console.profileEnd(title),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  // SIGUSR2 recurs (a flush per request); the shutdown signals fire once.
  onSignal: (signal, fn) => { if (signal === 'SIGUSR2') process.on(signal, fn); else process.once(signal, fn) },
  log: (line) => console.log(line),
})

export interface CpuProfileCaptureHandle {
  readonly runDirectoryName: string
  /** End the current chunk without starting another, flush GC, stop timers. */
  stop(reason: string): void
}

/**
 * Start the capture, or do nothing at all. Returns null when the config is not
 * enabled; in that case no dependency is touched (the test asserts it).
 */
export function startCpuProfileCapture(
  config: CpuProfileCaptureConfig,
  deps: CaptureDeps = realDeps(),
  identity: { bootId: string; cellId: string } = { bootId: currentProcessBootId(), cellId: process.env.SYNC_CELL_ID?.trim() || hostname() },
): CpuProfileCaptureHandle | null {
  if (!config.enabled) return null
  const safeCell = identity.cellId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'cell'
  const runDirectoryName = `${safeCell}-${identity.bootId}`
  const anchor = { wallMs: Date.now(), perfMs: performance.now(), hrUs: hrUs() }
  const fail = (stage: string, error: unknown) => deps.log(JSON.stringify({ event: 'diagnostics.cpu_profile_failed', stage,
    error: error instanceof Error ? error.message : String(error) }))

  // BOOT CHUNK, synchronously, before anything else is evaluated.
  let boot: BootSessionLike | null = null
  const bootStart = { wallMs: Date.now(), hrUsBefore: hrUs(), hrUsAfter: 0 }
  try {
    boot = deps.bootSession()
    syncCall(boot, 'Profiler.enable')
    syncCall(boot, 'Profiler.setSamplingInterval', { interval: config.samplingIntervalUs })
    syncCall(boot, 'Profiler.start')
  } catch (error) {
    fail('boot-session', error)
    try { boot?.disconnect() } catch { /* already gone */ }
    boot = null
  }
  bootStart.hrUsAfter = hrUs()

  // GC from boot. Converted to hrtime here (perf_hooks and hrtime share a
  // monotonic base) so every record downstream is in one clock domain.
  let gcBuffer: number[][] = []
  const gc = deps.createGcObserver((entries) => {
    for (const entry of entries) {
      const detail = (entry.detail ?? {}) as { kind?: number; flags?: number }
      const startHrUs = anchor.hrUs + Math.round((entry.startTime - anchor.perfMs) * 1000)
      gcBuffer.push([startHrUs, Math.round(entry.duration * 1000), detail.kind ?? -1, detail.flags ?? -1])
    }
  })
  gc.observe()

  const worker = deps.createWorker(new URL('./cpuProfileWorker.mjs', import.meta.url), {
    directory: config.directory, runDirectoryName, bootId: identity.bootId, cellId: identity.cellId,
    samplingIntervalUs: config.samplingIntervalUs, chunkSeconds: config.chunkSeconds, anchor,
    timeOrigin: performance.timeOrigin, pid: process.pid, hostname: hostname(), nodeVersion: process.version,
    bootChunk: boot ? { seq: 0, title: chunkTitle(0), ...bootStart } : null,
  })
  worker.unref?.()

  let seq = 0
  let current: string | null = null
  let rollTimer: unknown = null
  let stopped = false
  const flushGc = () => {
    if (gcBuffer.length === 0) return
    const entries = gcBuffer
    gcBuffer = []
    worker.postMessage({ type: 'gc', entries })
  }
  const gcTimer = deps.setInterval(flushGc, 1000)
  gcTimer.unref?.()

  /** One roll: start `next` (unless stopping), then end `current`. The hrtime
   * bracket IS the main-thread cost the analysis must exclude. */
  const roll = (reason: 'roll' | 'flush' | 'shutdown') => {
    const previous = current
    const wallMsBefore = Date.now()
    const hrUsBefore = hrUs()
    let next: string | null = null
    if (reason !== 'shutdown') {
      seq += 1
      next = chunkTitle(seq)
      deps.profile(next)
    }
    const hrUsAfterStart = hrUs()
    if (previous) deps.profileEnd(previous)
    const hrUsAfterEnd = hrUs()
    current = next
    worker.postMessage({ type: 'roll', reason, ended: previous, started: next, startedSeq: next ? seq : null,
      wallMsBefore, hrUsBefore, hrUsAfterStart, hrUsAfterEnd, wallMsAfter: Date.now(),
      startMs: (hrUsAfterStart - hrUsBefore) / 1000, endMs: (hrUsAfterEnd - hrUsAfterStart) / 1000 })
  }

  const stop = (reason: string) => {
    if (stopped) return
    stopped = true
    if (rollTimer !== null) deps.clearInterval(rollTimer)
    deps.clearInterval(gcTimer)
    try { roll('shutdown') } catch (error) { fail('final-roll', error) }
    flushGc()
    gc.disconnect()
    worker.postMessage({ type: 'stop', reason })
  }

  worker.on('message', (value) => {
    const message = value as { type?: string; stage?: string; error?: string } | null
    if (message?.type === 'error') {
      fail(`worker-${message.stage}`, message.error)
      return
    }
    if (message?.type !== 'ready' || stopped || rollTimer !== null) return
    try {
      roll('roll')
      if (boot) {
        // The boot chunk ends after chunk 1 started: no gap. Stopping it is a
        // one-off main-thread serialisation, logged with the same bracket.
        const hrUsBefore = hrUs()
        const wallMsBefore = Date.now()
        const profile = syncCall(boot, 'Profiler.stop')?.profile ?? null
        const hrUsAfterStop = hrUs()
        // Disconnecting discards the boot session's copy of chunk 1 unserialised.
        boot.disconnect()
        boot = null
        worker.postMessage({ type: 'boot-profile', profile, wallMsBefore, hrUsBefore, hrUsAfterStop,
          hrUsAfterDisconnect: hrUs(), stopMs: (hrUsAfterStop - hrUsBefore) / 1000 })
      }
      rollTimer = deps.setInterval(() => {
        try { roll('roll') } catch (error) { fail('roll', error) }
      }, config.chunkSeconds * 1000)
      ;(rollTimer as { unref?(): void }).unref?.()
      deps.log(JSON.stringify({ event: 'diagnostics.cpu_profile_started', directory: config.directory, run: runDirectoryName,
        samplingIntervalUs: config.samplingIntervalUs, chunkSeconds: config.chunkSeconds }))
    } catch (error) {
      fail('first-roll', error)
    }
  })
  worker.on('error', (error) => {
    fail('worker', error)
    stopped = true
    if (rollTimer !== null) deps.clearInterval(rollTimer)
    deps.clearInterval(gcTimer)
    gc.disconnect()
    try { boot?.disconnect() } catch { /* already gone */ }
  })

  // The final chunk is written by the worker before index.ts's graceful drain
  // reaches `process.exit` (best effort: a SIGKILL loses at most one chunk).
  deps.onSignal('SIGTERM', () => stop('SIGTERM'))
  deps.onSignal('SIGINT', () => stop('SIGINT'))
  // FLUSH ON REQUEST. The stall that fails a gate is, by construction, in the
  // last chunk (the gate stops at its first failure), and `docker compose
  // down` can exit a cell before its shutdown chunk is written. The bench
  // sends SIGUSR2 before saving logs and tearing down: an ordinary roll, now.
  // Registered only when the capture runs; without it SIGUSR2 would kill.
  deps.onSignal('SIGUSR2', () => {
    if (stopped || rollTimer === null) return
    try { roll('flush') } catch (error) { fail('flush', error) }
  })
  return { runDirectoryName, stop }
}
