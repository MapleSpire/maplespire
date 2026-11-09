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

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  CPU_PROFILE_FLAG, chunkTitle, cpuProfileCaptureConfig, startCpuProfileCapture,
  type CaptureDeps, type CpuProfileCaptureConfig,
} from './cpuProfileCapture.js'

const serverRoot = fileURLToPath(new URL('../..', import.meta.url))
const manifestSchedAvailable = (run: string): unknown => JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8')).sched?.available

/** Every dependency throws: a disabled capture must not reach any of them. */
const untouchable = (): CaptureDeps => {
  const boom = (name: string) => () => { throw new Error(`disabled capture touched ${name}`) }
  return {
    createWorker: boom('createWorker'), createGcObserver: boom('createGcObserver'), bootSession: boom('bootSession'),
    profile: boom('profile'), profileEnd: boom('profileEnd'), setInterval: boom('setInterval'),
    clearInterval: boom('clearInterval'), onSignal: boom('onSignal'), log: boom('log'),
  }
}

describe('SYNC_DIAG_CPU_PROFILE configuration', () => {
  it('is off unless the flag is exactly on', () => {
    for (const value of [undefined, '', ' ', 'off', 'ON', 'true', '1', 'yes']) {
      expect(cpuProfileCaptureConfig({ [CPU_PROFILE_FLAG]: value, SYNC_DIAG_CPU_PROFILE_DIR: '/diag' })).toEqual({ enabled: false, reason: 'flag-off' })
    }
  })
  it('refuses on without an absolute directory', () => {
    for (const directory of [undefined, '', 'relative/dir']) {
      expect(cpuProfileCaptureConfig({ [CPU_PROFILE_FLAG]: 'on', SYNC_DIAG_CPU_PROFILE_DIR: directory })).toEqual({ enabled: false, reason: 'directory-missing' })
    }
  })
  it('takes bounded defaults and overrides', () => {
    expect(cpuProfileCaptureConfig({ [CPU_PROFILE_FLAG]: ' on ', SYNC_DIAG_CPU_PROFILE_DIR: '/diag' }))
      .toEqual({ enabled: true, directory: '/diag', samplingIntervalUs: 1000, chunkSeconds: 10 })
    expect(cpuProfileCaptureConfig({ [CPU_PROFILE_FLAG]: 'on', SYNC_DIAG_CPU_PROFILE_DIR: '/diag',
      SYNC_DIAG_CPU_PROFILE_INTERVAL_US: '500', SYNC_DIAG_CPU_PROFILE_CHUNK_SECONDS: '10' }))
      .toEqual({ enabled: true, directory: '/diag', samplingIntervalUs: 500, chunkSeconds: 10 })
    // A blank or a zero is refused, never a 0 µs sampler or a 0 s roll.
    expect(cpuProfileCaptureConfig({ [CPU_PROFILE_FLAG]: 'on', SYNC_DIAG_CPU_PROFILE_DIR: '/diag',
      SYNC_DIAG_CPU_PROFILE_INTERVAL_US: '', SYNC_DIAG_CPU_PROFILE_CHUNK_SECONDS: '0' }))
      .toEqual({ enabled: true, directory: '/diag', samplingIntervalUs: 1000, chunkSeconds: 10 })
  })
})

describe('the capture is inert when the knob is off', () => {
  it('touches no inspector, worker, observer, timer or signal', () => {
    for (const config of [cpuProfileCaptureConfig({}), cpuProfileCaptureConfig({ [CPU_PROFILE_FLAG]: 'on' })]) {
      expect(startCpuProfileCapture(config, untouchable(), { bootId: 'b', cellId: 'c' })).toBeNull()
    }
  })
  it('a server process without the flag loads the install module and starts nothing', () => {
    const script = [
      "import inspector from 'node:inspector'",
      "import { getActiveResourcesInfo } from 'node:process'",
      'const before = getActiveResourcesInfo().length',
      "await import('./src/diagnostics/cpuProfile.install.ts')",
      'console.log(JSON.stringify({ inspectorUrl: inspector.url() ?? null, resourcesAdded: getActiveResourcesInfo().length - before }))',
    ].join('\n')
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: serverRoot, encoding: 'utf8', env: { ...process.env, [CPU_PROFILE_FLAG]: '', SYNC_DIAG_CPU_PROFILE_DIR: '/nowhere' },
    })
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ inspectorUrl: null, resourcesAdded: 0 })
  }, 60_000)
  it('is imported right after dotenv, before anything that evaluates Automerge', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const imports = source.split('\n').filter((line) => /^import\b/.test(line)).slice(0, 3)
    expect(imports[0]).toMatch(/^import '\.\/wasmMemoryGauge\.install\.js'/)
    expect(imports[1]).toMatch(/^import 'dotenv\/config'/)
    expect(imports[2]).toMatch(/^import '\.\/diagnostics\/cpuProfile\.install\.js'/)
  })
})

describe('roll order on the main thread', () => {
  const enabled: CpuProfileCaptureConfig = { enabled: true, directory: '/diag', samplingIntervalUs: 1000, chunkSeconds: 30 }
  function harness() {
    const calls: string[] = []
    const posted: Array<Record<string, unknown>> = []
    const listeners = new Map<string, (value: unknown) => void>()
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    const signals = new Map<string, () => void>()
    const deps: CaptureDeps = {
      createWorker: (url) => {
        calls.push(`worker ${url.pathname.split('/').pop()}`)
        return { postMessage: (message) => posted.push(message as Record<string, unknown>),
          on: (event, listener) => { listeners.set(event, listener) }, unref: () => calls.push('worker unref') }
      },
      createGcObserver: (onEntries) => ({ observe: () => { calls.push('gc observe'); onEntries([{ startTime: 1, duration: 2.5, detail: { kind: 4, flags: 0 } }]) },
        disconnect: () => calls.push('gc disconnect') }),
      bootSession: () => ({
        post: (method, _params, callback) => { calls.push(`boot ${method}`); callback(null, method === 'Profiler.stop' ? { profile: { nodes: [] } } : {}) },
        disconnect: () => calls.push('boot disconnect'),
      }),
      profile: (title) => calls.push(`profile ${title}`),
      profileEnd: (title) => calls.push(`profileEnd ${title}`),
      setInterval: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
      clearInterval: (handle) => { (handle as { cleared: boolean }).cleared = true },
      onSignal: (signal, fn) => { signals.set(signal, fn) },
      log: () => undefined,
    }
    return { calls, posted, listeners, timers, signals, deps }
  }

  it('boots synchronously, overlaps every roll, and ends without a new chunk', () => {
    const h = harness()
    const handle = startCpuProfileCapture(enabled, h.deps, { bootId: 'boot-1', cellId: 'failover-cell-a' })!
    expect(handle.runDirectoryName).toBe('failover-cell-a-boot-1')
    // Synchronous boot chunk BEFORE the worker exists.
    expect(h.calls.slice(0, 4)).toEqual(['boot Profiler.enable', 'boot Profiler.setSamplingInterval', 'boot Profiler.start', 'gc observe'])
    expect(h.calls).toContain('worker cpuProfileWorker.mjs')
    expect(h.calls).not.toContain(`profile ${chunkTitle(1)}`)

    h.listeners.get('message')!({ type: 'ready' })
    // Chunk 1 starts before the boot chunk stops; the boot session then leaves.
    const afterReady = h.calls.slice(h.calls.indexOf('worker unref') + 1)
    expect(afterReady).toEqual([`profile ${chunkTitle(1)}`, 'boot Profiler.stop', 'boot disconnect'])
    expect(h.posted.map((message) => message.type)).toEqual(['roll', 'boot-profile'])
    const rollTimer = h.timers.find((timer) => timer.ms === 30_000)!
    rollTimer.fn()
    expect(h.calls.slice(-2)).toEqual([`profile ${chunkTitle(2)}`, `profileEnd ${chunkTitle(1)}`])
    const roll = h.posted.at(-1)!
    expect(roll).toMatchObject({ type: 'roll', reason: 'roll', ended: chunkTitle(1), started: chunkTitle(2), startedSeq: 2 })
    expect(Number(roll.hrUsAfterEnd)).toBeGreaterThanOrEqual(Number(roll.hrUsBefore))

    // SIGUSR2: an immediate roll (the bench's flush before teardown).
    h.signals.get('SIGUSR2')!()
    expect(h.calls.slice(-2)).toEqual([`profile ${chunkTitle(3)}`, `profileEnd ${chunkTitle(2)}`])
    expect(h.posted.at(-1)).toMatchObject({ type: 'roll', reason: 'flush', ended: chunkTitle(2), started: chunkTitle(3) })
    h.signals.get('SIGTERM')!()
    expect(h.calls.slice(-2)).toEqual([`profileEnd ${chunkTitle(3)}`, 'gc disconnect'])
    expect(rollTimer.cleared).toBe(true)
    const types = h.posted.map((message) => message.type)
    expect(types.slice(-3)).toEqual(['roll', 'gc', 'stop'])
    expect(h.posted.at(-3)).toMatchObject({ reason: 'shutdown', ended: chunkTitle(3), started: null })
    // GC entries are [hrUs start, µs duration, kind, flags].
    expect((h.posted.at(-2)!.entries as number[][])[0].slice(1)).toEqual([2500, 4, 0])
    const posts = h.posted.length
    h.signals.get('SIGUSR2')!()
    expect(h.posted.length).toBe(posts)
    handle.stop('again')
    expect(h.posted.map((message) => message.type).slice(-1)).toEqual(['stop'])
    expect(h.posted.filter((message) => message.type === 'stop')).toHaveLength(1)
  })
})

describe('real capture in a child process', () => {
  it('writes a manifest, the boot chunk, chunk 1 on shutdown, GC lines and hrtime-consistent stamps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cpu-profile-test-'))
    try {
      const script = [
        "import { startCpuProfileCapture, cpuProfileCaptureConfig } from './src/diagnostics/cpuProfileCapture.ts'",
        'const handle = startCpuProfileCapture(cpuProfileCaptureConfig(), undefined, { bootId: "test-boot", cellId: "cell/x" })',
        'const junk = []',
        'const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) junk.push({ a: Math.random() }); junk.length = 0 }',
        'setTimeout(() => { spin(120); setTimeout(() => { handle.stop("test"); setTimeout(() => process.exit(0), 800) }, 200) }, 400)',
      ].join('\n')
      execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: serverRoot, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, [CPU_PROFILE_FLAG]: 'on', SYNC_DIAG_CPU_PROFILE_DIR: directory, SYNC_DIAG_CPU_PROFILE_CHUNK_SECONDS: '5' },
      })
      const run = join(directory, 'cell_x-test-boot')
      // `sched-*.json.gz` exists only where the kernel has schedstat (Linux).
      expect(readdirSync(run).filter((name) => !name.startsWith('sched-')).sort())
        .toEqual(['cpu-000000.cpuprofile.gz', 'cpu-000001.cpuprofile.gz', 'events.ndjson', 'gc.ndjson', 'manifest.json'])
      expect(typeof manifestSchedAvailable(run)).toBe('boolean')
      const manifest = JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({ bootId: 'test-boot', cellId: 'cell/x', samplingIntervalUs: 1000, chunkSeconds: 5 })
      const events = readFileSync(join(run, 'events.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      const first = events.find((entry) => entry.type === 'roll' && entry.startedSeq === 1)
      const chunk1 = events.find((entry) => entry.type === 'chunk' && entry.seq === 1)
      // The profile clock IS hrtime: chunk 1 started inside the bracket.
      expect(chunk1.startTime).toBeGreaterThanOrEqual(first.hrUsBefore)
      expect(chunk1.startTime).toBeLessThanOrEqual(first.hrUsAfterStart)
      expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'test', finalChunkWritten: true })
      const profile = JSON.parse(gunzipSync(readFileSync(join(run, 'cpu-000001.cpuprofile.gz'))).toString('utf8'))
      expect(profile.samples.length).toBe(profile.timeDeltas.length)
      expect(profile.samples.length).toBeGreaterThan(100)
      // The boot chunk overlaps chunk 1: no unsampled gap at hand-over.
      const boot = events.find((entry) => entry.type === 'chunk' && entry.seq === 0)
      expect(boot.endTime).toBeGreaterThanOrEqual(chunk1.startTime)
      const gc = readFileSync(join(run, 'gc.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(gc.length).toBeGreaterThan(0)
      expect(gc[0]).toEqual({ hrUs: expect.any(Number), durUs: expect.any(Number), kind: expect.any(String), kindCode: expect.any(Number),
        flags: expect.any(Number), wallMs: expect.any(Number) })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
