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

import { describe, expect, it, vi } from 'vitest'
import {
  AutomergeTransportTelemetry,
  automergeTransportConfig,
  backpressureAction,
  lightweightSynchronizerPeerSnapshot,
  lightweightProcessMemoryBytes,
  synchronizerPeerSnapshot,
  type TransportSocket,
} from './automergeTransportTelemetry.js'

function fakeSocket(bufferedAmount = 0): TransportSocket & { close: (code?: number) => void } {
  let listener: ((code?: number) => void) | undefined
  return {
    bufferedAmount,
    once: (_event, callback) => { listener = callback },
    close: (code) => listener?.(code),
  }
}

describe('automerge transport configuration', () => {
  it('samples process memory without the page-walking process.memoryUsage path', () => {
    const rss = vi.fn(() => 321)
    const heapStatistics = vi.fn(() => ({
      used_heap_size: 123,
      external_memory: 45,
    }))

    expect(lightweightProcessMemoryBytes(rss, heapStatistics as never)).toEqual({
      rss: 321,
      heapUsed: 123,
      external: 45,
      arrayBuffers: null,
    })
    expect(rss).toHaveBeenCalledOnce()
    expect(heapStatistics).toHaveBeenCalledOnce()
  })

  it('reports only aggregate current synchronizer peer cardinalities', () => {
    expect(synchronizerPeerSnapshot({
      privateDocumentOne: { peers: ['peer-a', 'peer-b'] },
      privateDocumentTwo: { peers: [] },
      privateDocumentThree: { peers: ['peer-c'] },
    })).toEqual({
      documentsObserved: 3,
      documentsWithPeers: 2,
      totalPeerBindings: 3,
      maxPeersPerDocument: 2,
      p95PeersPerDocument: 2,
    })
  })

  it('samples live peer bindings without invoking expensive document metrics', () => {
    const metrics = vi.fn(() => { throw new Error('must not materialize Automerge stats') })
    const first = { hasPeer: (peerId: string) => peerId !== 'peer-c', metrics }
    const second = { hasPeer: (peerId: string) => peerId === 'peer-c', metrics }

    expect(lightweightSynchronizerPeerSnapshot({
      peers: ['peer-a', 'peer-b', 'peer-c'],
      docSynchronizers: { first, second },
    })).toEqual({
      documentsObserved: 2,
      documentsWithPeers: 2,
      totalPeerBindings: 3,
      maxPeersPerDocument: 2,
      p95PeersPerDocument: 2,
    })
    expect(metrics).not.toHaveBeenCalled()
  })

  it('keeps bounded aggregate CPU evidence for receive and generate operations', () => {
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({ AM_WS_TELEMETRY_INTERVAL_MS: '0' }))
    telemetry.recordSyncOperation('receive-sync-message', 12.345)
    telemetry.recordSyncOperation('receive-sync-message', 25)
    telemetry.recordSyncOperation('generate-sync-message', 4.5)

    expect(telemetry.snapshot().syncCpu).toEqual({
      receiveCount: 2,
      generateCount: 1,
      receiveTotalMs: 37.35,
      generateTotalMs: 4.5,
      receiveP95Ms: 25,
      receiveP99Ms: 25,
      generateP95Ms: 4.5,
      generateP99Ms: 4.5,
      maxReceiveMs: 25,
      maxGenerateMs: 4.5,
    })
    telemetry.stop()
  })

  it('uses bounded enterprise defaults', () => {
    expect(automergeTransportConfig({})).toMatchObject({
      backpressureWarnBytes: 1024 * 1024,
      backpressureCloseBytes: 16 * 1024 * 1024,
      maxPayloadBytes: 16 * 1024 * 1024,
      telemetryIntervalMs: 60_000,
      maxTrackedDocuments: 2_048,
    })
  })

  it('rejects inverted thresholds and payloads larger than the close budget', () => {
    expect(() => automergeTransportConfig({
      AM_WS_BACKPRESSURE_WARN_BYTES: '200000',
      AM_WS_BACKPRESSURE_CLOSE_BYTES: '150000',
    })).toThrow(/must be greater/)
    expect(() => automergeTransportConfig({
      AM_WS_BACKPRESSURE_CLOSE_BYTES: String(8 * 1024 * 1024),
      AM_WS_MAX_PAYLOAD_BYTES: String(16 * 1024 * 1024),
    })).toThrow(/must not exceed/)
  })

  it('classifies normal, warning and disconnect queue pressure', () => {
    const config = { backpressureWarnBytes: 100, backpressureCloseBytes: 200 }
    expect(backpressureAction(99, config)).toBe('send')
    expect(backpressureAction(100, config)).toBe('warn')
    expect(backpressureAction(200, config)).toBe('close')
  })
})

describe('recent sync duration windows', () => {
  const normalized = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0
  const rounded = (value: number) => Math.round(value * 100) / 100
  function reference(values: number[]) {
    const all = values.map(normalized)
    const window = all.slice(-4096).sort((a, b) => a - b)
    return {
      count: all.length,
      total: rounded(all.reduce((sum, value) => sum + value, 0)),
      max: rounded(Math.max(0, ...all)),
      p95: rounded(window[Math.ceil(window.length * 0.95) - 1] ?? 0),
      p99: rounded(window[Math.ceil(window.length * 0.99) - 1] ?? 0),
    }
  }

  it('preserves exact recent quantiles and lifetime aggregates through multiple wraps and reads', () => {
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({ AM_WS_TELEMETRY_INTERVAL_MS: '0' }))
    const receive: number[] = []
    const generate: number[] = []
    const checkpoints = new Set([0, 1, 99, 100, 4094, 4095, 4096, 4097, 8191, 8192, 8193, 12499])
    function check() {
      const r = reference(receive)
      const g = reference(generate)
      expect(telemetry.snapshot().syncCpu).toEqual({
        receiveCount: r.count, generateCount: g.count,
        receiveTotalMs: r.total, generateTotalMs: g.total,
        receiveP95Ms: r.p95, receiveP99Ms: r.p99,
        generateP95Ms: g.p95, generateP99Ms: g.p99,
        maxReceiveMs: r.max, maxGenerateMs: g.max,
      })
    }
    try {
      check()
      for (let i = 0; i < 12500; i += 1) {
        // Different populations, including duplicate/fractional values and a
        // maximum that leaves the recent window but remains in lifetime data.
        const r = i === 0 ? 100000 : i / 7
        const g = i === 0 ? 200000 : (12500 - i) % 153 / 11
        receive.push(r)
        telemetry.recordSyncOperation('receive-sync-message', r)
        if (checkpoints.has(i)) check() // one type changed; the other did not
        generate.push(g)
        telemetry.recordSyncOperation('generate-sync-message', g)
        if (checkpoints.has(i) || i % 503 === 0) {
          check()
          check() // a read must not change future eviction or aggregates
        }
      }
    } finally { telemetry.stop() }
  })

  it('normalizes invalid durations and isolates returned snapshots from future reads', () => {
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({ AM_WS_TELEMETRY_INTERVAL_MS: '0' }))
    try {
      const values = [12.345, NaN, Infinity, -Infinity, -12, -0, 0, 12.345, 0.004]
      for (const duration of values) telemetry.recordSyncOperation('receive-sync-message', duration)
      const first = telemetry.snapshot()
      const expected = { ...first.syncCpu }
      expect(expected).toMatchObject({ receiveCount: 9, receiveTotalMs: 24.69, receiveP95Ms: 12.35, receiveP99Ms: 12.35, maxReceiveMs: 12.35 })
      first.syncCpu.receiveP95Ms = -999
      first.syncCpu.receiveTotalMs = -999
      expect(telemetry.snapshot().syncCpu).toEqual(expected)
      for (let i = 0; i < 4096; i += 1) telemetry.recordSyncOperation('receive-sync-message', NaN)
      expect(telemetry.snapshot().syncCpu).toMatchObject({ receiveCount: 4105, receiveTotalMs: 24.69, receiveP95Ms: 0, receiveP99Ms: 0, maxReceiveMs: 12.35 })
      expect(first.syncCpu.receiveP95Ms).toBe(-999)
    } finally { telemetry.stop() }
  })

  it('reuses only the unchanged duration quantiles and still reads live socket state', () => {
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({ AM_WS_TELEMETRY_INTERVAL_MS: '0' }))
    const socket = fakeSocket(12)
    telemetry.bindSocket(socket)
    for (let i = 0; i < 101; i += 1) telemetry.recordSyncOperation('receive-sync-message', i)
    for (let i = 0; i < 203; i += 1) telemetry.recordSyncOperation('generate-sync-message', i)
    const sorts = vi.spyOn(Array.prototype, 'sort')
    const durationSorts = (size: number) => sorts.mock.contexts.filter(array => array.length === size).length
    try {
      const first = telemetry.snapshot()
      expect(durationSorts(101)).toBe(1)
      expect(durationSorts(203)).toBe(1)
      socket.bufferedAmount = 45
      const second = telemetry.snapshot()
      expect(second.syncCpu).toEqual(first.syncCpu)
      expect(second.backpressure.currentMaxBufferedBytes).toBe(45)
      expect(first.backpressure.currentMaxBufferedBytes).toBe(12)
      expect(durationSorts(101)).toBe(1)
      expect(durationSorts(203)).toBe(1)
      telemetry.recordSyncOperation('receive-sync-message', 1000)
      expect(telemetry.snapshot().syncCpu.receiveCount).toBe(102)
      expect(durationSorts(102)).toBe(1)
      expect(durationSorts(203)).toBe(1)
    } finally {
      sorts.mockRestore()
      telemetry.stop()
    }
  })

  it('keeps duration windows and lifetime data across both kinds of histogram reset', () => {
    vi.useFakeTimers()
    const monitor = () => ({ mean: 0, max: 0, enable() {}, disable() {}, reset: vi.fn(), percentile: () => 0 })
    const periodic = monitor()
    const qualification = monitor()
    const telemetry = new AutomergeTransportTelemetry({ ...automergeTransportConfig({}), telemetryIntervalMs: 100 }, periodic, qualification)
    const lines: Record<string, unknown>[] = []
    try {
      for (let i = 0; i < 4200; i += 1) telemetry.recordSyncOperation('generate-sync-message', i / 3)
      const expected = telemetry.snapshot().syncCpu
      telemetry.startStructuredLogging(line => lines.push(JSON.parse(line)))
      expect(telemetry.snapshotAndResetEventLoopDelay().syncCpu).toEqual(expected)
      expect(qualification.reset).toHaveBeenCalledTimes(1)
      expect(periodic.reset).not.toHaveBeenCalled()
      vi.advanceTimersByTime(200)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatchObject(expected)
      expect(lines[1]).toMatchObject(expected)
      expect(periodic.reset).toHaveBeenCalledTimes(2)
      expect(qualification.reset).toHaveBeenCalledTimes(1)
      expect(telemetry.snapshot().syncCpu).toEqual(expected)
      telemetry.recordSyncOperation('generate-sync-message', 5000)
      expect(telemetry.snapshotAndResetEventLoopDelay().syncCpu.generateCount).toBe(4201)
      expect(qualification.reset).toHaveBeenCalledTimes(2)
    } finally {
      telemetry.stop()
      vi.useRealTimers()
    }
  })
})

describe('event-loop qualification windows', () => {
  it('returns the current distribution before resetting the monitor', () => {
    const calls: string[] = []
    const eventLoopDelay = {
      mean: 12_500_000,
      max: 48_250_000,
      enable: () => calls.push('enable'),
      disable: () => calls.push('disable'),
      reset: () => calls.push('reset'),
      percentile: (value: number) => value === 99 ? 31_750_000 : 20_500_000,
    }
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({}), undefined, eventLoopDelay)

    const snapshot = telemetry.snapshotAndResetEventLoopDelay()

    expect(snapshot.eventLoopDelayMs).toEqual({
      mean: 12.5,
      p95: 20.5,
      p99: 31.75,
      max: 48.25,
    })
    expect(calls).toEqual(['enable', 'reset'])
    telemetry.stop()
    expect(calls).toEqual(['enable', 'reset', 'disable'])
  })

  it('publishes the qualification window start and reset sequence independently', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T10:00:00.000Z'))
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({}))

    // A snapshot describes the window its own delay figures cover, so the
    // consume that OPENS a measurement still reports the window it is closing.
    const opened = telemetry.snapshotAndResetEventLoopDelay()
    expect(opened.eventLoopWindow).toEqual({
      consumer: 'qualification',
      startedAt: '2026-08-17T10:00:00.000Z',
      resetCount: 0,
      lastResetBy: 'boot',
    })

    vi.advanceTimersByTime(30_000)
    const closed = telemetry.snapshotAndResetEventLoopDelay()
    expect(closed.eventLoopWindow).toEqual({
      consumer: 'qualification',
      startedAt: '2026-08-17T10:00:00.000Z',
      resetCount: 1,
      lastResetBy: 'consume',
    })

    telemetry.stop()
    vi.useRealTimers()
  })

  it('keeps both distributions when the other consumer resets its monitor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T10:00:00.000Z'))
    const monitor = (value: number) => ({
      mean: value, max: value,
      enable: vi.fn(), disable: vi.fn(),
      percentile() { return this.max },
      reset() { this.mean = 0; this.max = 0 },
    })
    const periodic = monitor(90_000_000)
    const qualification = monitor(0)
    const telemetry = new AutomergeTransportTelemetry({
      ...automergeTransportConfig({}),
      telemetryIntervalMs: 10_000,
    }, periodic, qualification)
    telemetry.snapshotAndResetEventLoopDelay()
    expect(telemetry.snapshot().eventLoopDelayMs.p99).toBe(90)
    qualification.max = 150_000_000
    const logged: Record<string, unknown>[] = []
    telemetry.startStructuredLogging(line => logged.push(JSON.parse(line)))

    vi.advanceTimersByTime(10_000)

    const closed = telemetry.snapshot()
    expect(closed.eventLoopWindow.startedAt).toBe('2026-08-17T10:00:10.000Z')
    expect(closed.eventLoopWindow.resetCount).toBe(1)
    expect(closed.eventLoopWindow.lastResetBy).toBe('periodic-log')
    expect(closed.eventLoopWindow.consumer).toBe('periodic')
    expect(logged[0].eventLoopP99Ms).toBe(90)
    const consumed = telemetry.snapshotAndResetEventLoopDelay()
    expect(consumed.eventLoopDelayMs.p99).toBe(150)
    expect(consumed.eventLoopWindow).toEqual({ consumer: 'qualification',
      startedAt: '2026-08-17T10:00:00.000Z', resetCount: 1, lastResetBy: 'consume' })
    expect(qualification.max).toBe(0)
    periodic.max = 80_000_000
    telemetry.snapshotAndResetEventLoopDelay()
    expect(telemetry.snapshot().eventLoopDelayMs.p99).toBe(80)

    telemetry.stop()
    expect(periodic.enable).toHaveBeenCalledTimes(1)
    expect(qualification.enable).toHaveBeenCalledTimes(1)
    expect(periodic.disable).toHaveBeenCalledTimes(1)
    expect(qualification.disable).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})

describe('AutomergeTransportTelemetry', () => {
  it('tracks connections, fixed close categories and memory pressure without identities', () => {
    vi.useFakeTimers()
    const telemetry = new AutomergeTransportTelemetry({
      ...automergeTransportConfig({}),
      backpressureWarnBytes: 100,
      backpressureCloseBytes: 200,
      maxPayloadBytes: 150,
    })
    const healthy = fakeSocket(10)
    const slow = fakeSocket(125)
    telemetry.bindSocket(healthy)
    telemetry.bindSocket(slow)
    vi.advanceTimersByTime(1_250)
    healthy.close(1000)

    const snapshot = telemetry.snapshot()
    expect(snapshot.connections).toMatchObject({ active: 1, peak: 2, accepted: 2, closed: 1 })
    expect(snapshot.connections.closedByCategory.normal).toBe(1)
    expect(snapshot.connections.averageClosedDurationMs).toBe(1_250)
    expect(snapshot.backpressure).toMatchObject({ slowConnections: 1, currentMaxBufferedBytes: 125 })
    expect(JSON.stringify(snapshot)).not.toContain('peer-')
    telemetry.stop()
    vi.useRealTimers()
  })

  it('reports bounded recipient fan-out without exposing document or peer ids', () => {
    const telemetry = new AutomergeTransportTelemetry({
      ...automergeTransportConfig({}),
      maxTrackedDocuments: 64,
    })
    telemetry.recordInboundFrame(120)
    telemetry.recordInboundFrame(80)
    telemetry.recordInboundMessage({ type: 'sync', documentId: 'secret-doc', senderId: 'secret-peer-a' })
    telemetry.recordOutbound({ type: 'sync', documentId: 'secret-doc', targetId: 'secret-peer-a' }, 80, 0)
    telemetry.recordOutbound({ type: 'sync', documentId: 'secret-doc', targetId: 'secret-peer-b' }, 90, 0)

    const snapshot = telemetry.snapshot()
    expect(snapshot.traffic).toMatchObject({
      inboundFrames: 2,
      inboundBytes: 200,
      maxInboundFrameBytes: 120,
      outboundSyncMessages: 2,
      outboundToInboundSyncRatio: 2,
    })
    expect(snapshot.fanoutWindow).toMatchObject({
      documentsObserved: 1,
      maxRecipientsPerDocument: 2,
      p95RecipientsPerDocument: 2,
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-(doc|peer)/)
    telemetry.stop()
  })

  it('counts warning episodes, disconnects and dropped sends separately', () => {
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({}))
    telemetry.recordBackpressureWarning(2 * 1024 * 1024)
    telemetry.recordBackpressureDisconnect(20 * 1024 * 1024)
    telemetry.recordBackpressureDrop()
    telemetry.recordDisconnectedDrop()
    const snapshot = telemetry.snapshot()
    expect(snapshot.backpressure).toMatchObject({ warningEpisodes: 1, disconnects: 1 })
    expect(snapshot.traffic).toMatchObject({
      outboundDroppedBackpressure: 2,
      outboundDroppedDisconnected: 1,
    })
    telemetry.stop()
  })

  it('attributes stale authorization epochs separately from missing and failed authentication', () => {
    const telemetry = new AutomergeTransportTelemetry(automergeTransportConfig({}))
    telemetry.recordRejectedUpgrade('unauthorized')
    telemetry.recordRejectedUpgrade('stale-epoch')
    telemetry.recordRejectedUpgrade('auth-error')
    expect(telemetry.snapshot().connections).toMatchObject({
      rejectedUnauthorized: 1,
      rejectedStaleEpoch: 1,
      rejectedAuthError: 1,
      accepted: 0,
    })
    telemetry.stop()
  })

  it('emits aggregate deltas and clears the bounded fan-out window without leaking ids', () => {
    vi.useFakeTimers()
    const telemetry = new AutomergeTransportTelemetry({
      ...automergeTransportConfig({}),
      telemetryIntervalMs: 100,
    })
    const logger = vi.fn()
    telemetry.recordInboundFrame(128)
    telemetry.recordInboundMessage({ type: 'sync', documentId: 'private-document', senderId: 'private-peer-a' })
    telemetry.recordOutbound({
      type: 'sync',
      documentId: 'private-document',
      targetId: 'private-peer-b',
    }, 64, 0)
    telemetry.startStructuredLogging(logger)

    vi.advanceTimersByTime(100)
    const first = JSON.parse(logger.mock.calls[0][0])
    expect(first).toMatchObject({
      event: 'automerge.transport',
      documentsObserved: 1,
      maxRecipientsPerDocument: 1,
      inboundFramesDelta: 1,
      outboundFramesDelta: 1,
    })
    expect(JSON.stringify(first)).not.toMatch(/private-(document|peer)/)

    vi.advanceTimersByTime(100)
    const second = JSON.parse(logger.mock.calls[1][0])
    expect(second).toMatchObject({
      documentsObserved: 0,
      inboundFramesDelta: 0,
      outboundFramesDelta: 0,
    })
    telemetry.stop()
    vi.useRealTimers()
  })
})
