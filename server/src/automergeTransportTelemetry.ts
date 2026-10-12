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

import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'

export interface AutomergeTransportConfig {
  backpressureWarnBytes: number
  backpressureCloseBytes: number
  maxPayloadBytes: number
  telemetryIntervalMs: number
  maxTrackedDocuments: number
}

export interface TransportMessage {
  type: string
  senderId?: string
  targetId?: string
  documentId?: string
  data?: Uint8Array
}

export interface TransportSocket {
  bufferedAmount: number
  once(event: 'close', listener: (code?: number) => void): unknown
}

export type BackpressureAction = 'send' | 'warn' | 'close'

export interface AutomergeTransportSnapshot {
  generatedAt: string
  uptimeSeconds: number
  config: AutomergeTransportConfig
  connections: {
    active: number
    peak: number
    accepted: number
    closed: number
    rejectedUnauthorized: number
    rejectedStaleEpoch: number
    rejectedAuthError: number
    closedByCategory: Record<CloseCategory, number>
    averageClosedDurationMs: number
    maxClosedDurationMs: number
  }
  traffic: {
    inboundFrames: number
    inboundBytes: number
    maxInboundFrameBytes: number
    inboundSyncMessages: number
    outboundFrames: number
    outboundPayloadBytes: number
    outboundSyncMessages: number
    outboundToInboundSyncRatio: number
    outboundDroppedDisconnected: number
    outboundDroppedBackpressure: number
    presenceAccepted: number
    presenceDropped: number
    presenceRateLimited: number
  }
  backpressure: {
    slowConnections: number
    totalBufferedBytes: number
    currentMaxBufferedBytes: number
    lifetimeMaxBufferedBytes: number
    warningEpisodes: number
    disconnects: number
  }
  fanoutWindow: {
    documentsObserved: number
    overflowDocuments: number
    maxRecipientsPerDocument: number
    p95RecipientsPerDocument: number
    maxMessagesPerDocument: number
  }
  syncCpu: {
    receiveCount: number
    generateCount: number
    receiveTotalMs: number
    generateTotalMs: number
    receiveP95Ms: number
    receiveP99Ms: number
    generateP95Ms: number
    generateP99Ms: number
    maxReceiveMs: number
    maxGenerateMs: number
  }
  eventLoopDelayMs: { mean: number; p95: number; p99: number; max: number }
  /**
   * When the event-loop window currently being reported actually began, and how
   * it got there.
   *
   * Periodic diagnostics and explicit qualification reads have independent
   * histograms. The consumer and reset sequence let a sampler refuse a missing
   * window or an intervening explicit consumer, including after an HTTP timeout.
   */
  eventLoopWindow: { consumer: 'periodic' | 'qualification'; startedAt: string; resetCount: number; lastResetBy: 'boot' | 'consume' | 'periodic-log' }
  processMemoryBytes: { rss: number; heapUsed: number; external: number; arrayBuffers: number | null }
}

interface EventLoopDelayMonitor {
  readonly mean: number
  readonly max: number
  enable(): void
  disable(): void
  reset(): void
  percentile(percentile: number): number
}

export interface AutomergeSynchronizerPeerSnapshot {
  documentsObserved: number
  documentsWithPeers: number
  totalPeerBindings: number
  maxPeersPerDocument: number
  p95PeersPerDocument: number
}

export interface LightweightSynchronizerPeerSource {
  peers: readonly string[]
  docSynchronizers: Record<string, { hasPeer(peerId: string): boolean }>
}

const MIB = 1024 * 1024

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function automergeTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutomergeTransportConfig {
  const config = {
    backpressureWarnBytes: boundedInteger(
      env.AM_WS_BACKPRESSURE_WARN_BYTES,
      1 * MIB,
      64 * 1024,
      512 * MIB,
      'AM_WS_BACKPRESSURE_WARN_BYTES',
    ),
    backpressureCloseBytes: boundedInteger(
      env.AM_WS_BACKPRESSURE_CLOSE_BYTES,
      16 * MIB,
      128 * 1024,
      1024 * MIB,
      'AM_WS_BACKPRESSURE_CLOSE_BYTES',
    ),
    maxPayloadBytes: boundedInteger(
      env.AM_WS_MAX_PAYLOAD_BYTES,
      16 * MIB,
      1 * MIB,
      1024 * MIB,
      'AM_WS_MAX_PAYLOAD_BYTES',
    ),
    telemetryIntervalMs: boundedInteger(
      env.AM_WS_TELEMETRY_INTERVAL_MS,
      60_000,
      0,
      3_600_000,
      'AM_WS_TELEMETRY_INTERVAL_MS',
    ),
    maxTrackedDocuments: boundedInteger(
      env.AM_WS_TELEMETRY_MAX_DOCUMENTS,
      2_048,
      64,
      65_536,
      'AM_WS_TELEMETRY_MAX_DOCUMENTS',
    ),
  }
  if (config.backpressureCloseBytes <= config.backpressureWarnBytes) {
    throw new Error('AM_WS_BACKPRESSURE_CLOSE_BYTES must be greater than AM_WS_BACKPRESSURE_WARN_BYTES')
  }
  if (config.maxPayloadBytes > config.backpressureCloseBytes) {
    throw new Error('AM_WS_MAX_PAYLOAD_BYTES must not exceed AM_WS_BACKPRESSURE_CLOSE_BYTES')
  }
  return config
}

export function backpressureAction(
  bufferedAmount: number,
  config: Pick<AutomergeTransportConfig, 'backpressureWarnBytes' | 'backpressureCloseBytes'>,
): BackpressureAction {
  if (bufferedAmount >= config.backpressureCloseBytes) return 'close'
  if (bufferedAmount >= config.backpressureWarnBytes) return 'warn'
  return 'send'
}

interface DocumentWindow {
  recipients: Set<string>
  messages: number
  payloadBytes: number
}

interface Counters {
  acceptedConnections: number
  closedConnections: number
  rejectedUnauthorized: number
  rejectedStaleEpoch: number
  rejectedAuthError: number
  inboundFrames: number
  inboundBytes: number
  inboundSyncMessages: number
  outboundFrames: number
  outboundPayloadBytes: number
  outboundSyncMessages: number
  outboundDroppedDisconnected: number
  outboundDroppedBackpressure: number
  presenceAccepted: number
  presenceDropped: number
  presenceRateLimited: number
  backpressureWarningEpisodes: number
  backpressureDisconnects: number
}

const emptyCounters = (): Counters => ({
  acceptedConnections: 0,
  closedConnections: 0,
  rejectedUnauthorized: 0,
  rejectedStaleEpoch: 0,
  rejectedAuthError: 0,
  inboundFrames: 0,
  inboundBytes: 0,
  inboundSyncMessages: 0,
  outboundFrames: 0,
  outboundPayloadBytes: 0,
  outboundSyncMessages: 0,
  outboundDroppedDisconnected: 0,
  outboundDroppedBackpressure: 0,
  presenceAccepted: 0,
  presenceDropped: 0,
  presenceRateLimited: 0,
  backpressureWarningEpisodes: 0,
  backpressureDisconnects: 0,
})

type CloseCategory = 'normal' | 'restart' | 'backpressure' | 'revoked' | 'abnormal'

function closeCategory(code: number | undefined): CloseCategory {
  if (code === 1000) return 'normal'
  if (code === 1012) return 'restart'
  if (code === 1013) return 'backpressure'
  if (code === 4001) return 'revoked'
  return 'abnormal'
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

/** Exact quantiles of the most recent 4,096 normalized sync durations. */
class RecentSyncDurations {
  private readonly samples: number[] = []
  private nextIndex = 0
  private cached: { p95: number; p99: number } | null = { p95: 0, p99: 0 }

  record(duration: number): void {
    // Once full, overwrite the oldest slot without shifting the other samples.
    this.samples[this.nextIndex] = duration
    this.nextIndex = (this.nextIndex + 1) % 4_096
    this.cached = null
  }

  quantiles(): { p95: number; p99: number } {
    if (this.cached === null) {
      // Sort a copy: sorting the ring would change which value is evicted next.
      const sorted = [...this.samples].sort((a, b) => a - b)
      this.cached = { p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) }
    }
    return this.cached
  }
}

/**
 * Privacy-minimized view of Repo synchronizer residency. Peer and document
 * identifiers never leave the process; only cardinalities are exposed. Unlike
 * the transport fan-out window, this describes the peers retained *right now*.
 */
export function synchronizerPeerSnapshot(
  documents: Record<string, { peers?: unknown[] }>,
): AutomergeSynchronizerPeerSnapshot {
  const peerCounts = Object.values(documents)
    .map((document) => Array.isArray(document?.peers) ? document.peers.length : 0)
    .sort((left, right) => left - right)
  return {
    documentsObserved: peerCounts.length,
    documentsWithPeers: peerCounts.filter((count) => count > 0).length,
    totalPeerBindings: peerCounts.reduce((sum, count) => sum + count, 0),
    maxPeersPerDocument: Math.max(0, ...peerCounts),
    p95PeersPerDocument: percentile(peerCounts, 0.95),
  }
}

/**
 * Read live peer cardinalities without calling Repo.metrics(). The upstream
 * metrics path runs Automerge.stats() over every resident document, which is
 * intentionally useful for an explicit runtime diagnostic but catastrophic in
 * a 500 ms health sampler: timed-out requests keep executing and can build an
 * unbounded synchronous backlog on a hot enterprise document.
 */
export function lightweightSynchronizerPeerSnapshot(
  synchronizer: LightweightSynchronizerPeerSource,
): AutomergeSynchronizerPeerSnapshot {
  const peerCounts = Object.values(synchronizer.docSynchronizers)
    .map((document) => synchronizer.peers.reduce(
      (count, peerId) => count + Number(document.hasPeer(peerId)),
      0,
    ))
    .sort((left, right) => left - right)
  return {
    documentsObserved: peerCounts.length,
    documentsWithPeers: peerCounts.filter((count) => count > 0).length,
    totalPeerBindings: peerCounts.reduce((sum, count) => sum + count, 0),
    maxPeersPerDocument: Math.max(0, ...peerCounts),
    p95PeersPerDocument: percentile(peerCounts, 0.95),
  }
}

function milliseconds(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds)) return 0
  return Math.round((nanoseconds / 1_000_000) * 100) / 100
}

/**
 * Avoid process.memoryUsage() on the 500 ms transport health path. That API
 * walks process pages and can itself block a large sync cell long enough to
 * violate the event-loop SLO. RSS and V8 heap statistics are constant-cost;
 * ArrayBuffer attribution is deliberately unavailable instead of fabricated.
 */
export function lightweightProcessMemoryBytes(
  rss: () => number = process.memoryUsage.rss,
  heapStatistics: () => ReturnType<typeof getHeapStatistics> = getHeapStatistics,
): AutomergeTransportSnapshot['processMemoryBytes'] {
  const heap = heapStatistics()
  return {
    rss: rss(),
    heapUsed: heap.used_heap_size,
    external: heap.external_memory,
    arrayBuffers: null,
  }
}

/**
 * Process-local, privacy-minimized telemetry for the Automerge WebSocket
 * adapter. Document and peer identifiers are used only as bounded in-memory
 * aggregation keys and never appear in snapshots or logs.
 */
export class AutomergeTransportTelemetry {
  private readonly startedAt = Date.now()
  private readonly activeSockets = new Set<TransportSocket>()
  private readonly acceptedAt = new WeakMap<object, number>()
  private readonly documents = new Map<string, DocumentWindow>()
  private readonly receiveDurationsMs = new RecentSyncDurations()
  private readonly generateDurationsMs = new RecentSyncDurations()
  private readonly counters = emptyCounters()
  private lastLoggedCounters = emptyCounters()
  private readonly closedByCategory: Record<CloseCategory, number> = {
    normal: 0,
    restart: 0,
    backpressure: 0,
    revoked: 0,
    abnormal: 0,
  }
  private peakConnections = 0
  private maxBufferedBytes = 0
  private maxInboundFrameBytes = 0
  private documentOverflow = 0
  private receiveCount = 0
  private generateCount = 0
  private receiveTotalMs = 0
  private generateTotalMs = 0
  private maxReceiveMs = 0
  private maxGenerateMs = 0
  private closedDurationTotalMs = 0
  private closedDurationMaxMs = 0
  private logTimer: NodeJS.Timeout | null = null
  // The periodic logger must never consume the qualification histogram.
  private eventLoopWindowStartedAt = Date.now()
  private eventLoopWindowResets = 0
  private eventLoopWindowLastResetBy: 'boot' | 'consume' | 'periodic-log' = 'boot'
  private readonly eventLoopDelay: EventLoopDelayMonitor
  private readonly qualificationEventLoopDelay: EventLoopDelayMonitor
  private qualificationWindowStartedAt = Date.now()
  private qualificationWindowResets = 0
  private readonly gcObserver: PerformanceObserver

  constructor(
    readonly config: AutomergeTransportConfig = automergeTransportConfig(),
    eventLoopDelay: EventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 }),
    qualificationEventLoopDelay: EventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 20 }),
  ) {
    if (eventLoopDelay === qualificationEventLoopDelay) throw new Error('Event-loop consumers require independent monitors')
    this.eventLoopDelay = eventLoopDelay
    this.qualificationEventLoopDelay = qualificationEventLoopDelay
    this.eventLoopDelay.enable()
    this.qualificationEventLoopDelay.enable()
    this.gcObserver = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        if (entry.duration < 50) continue
        console.warn(JSON.stringify({
          event: 'runtime.gc_pause_slow',
          durationMs: Math.round(entry.duration * 100) / 100,
          detail: 'detail' in entry ? entry.detail : undefined,
        }))
      }
    })
    this.gcObserver.observe({ entryTypes: ['gc'] })
  }

  bindSocket(socket: TransportSocket): void {
    if (this.activeSockets.has(socket)) return
    this.activeSockets.add(socket)
    this.acceptedAt.set(socket, Date.now())
    this.counters.acceptedConnections += 1
    this.peakConnections = Math.max(this.peakConnections, this.activeSockets.size)
    socket.once('close', (code) => this.dropSocket(socket, code))
  }

  recordRejectedUpgrade(reason: 'unauthorized' | 'stale-epoch' | 'auth-error'): void {
    if (reason === 'unauthorized') this.counters.rejectedUnauthorized += 1
    else if (reason === 'stale-epoch') this.counters.rejectedStaleEpoch += 1
    else this.counters.rejectedAuthError += 1
  }

  recordInboundFrame(bytes: number): void {
    const safeBytes = Math.max(0, bytes)
    this.counters.inboundFrames += 1
    this.counters.inboundBytes += safeBytes
    this.maxInboundFrameBytes = Math.max(this.maxInboundFrameBytes, safeBytes)
  }

  recordInboundMessage(message: TransportMessage): void {
    if (message.type === 'sync' || message.type === 'request') this.counters.inboundSyncMessages += 1
  }

  recordPresenceAccepted(): void {
    this.counters.presenceAccepted += 1
  }

  recordPresenceDropped(rateLimited = false): void {
    this.counters.presenceDropped += 1
    if (rateLimited) this.counters.presenceRateLimited += 1
  }

  recordOutbound(message: TransportMessage, payloadBytes: number, bufferedBytes: number): void {
    this.counters.outboundFrames += 1
    this.counters.outboundPayloadBytes += Math.max(0, payloadBytes)
    this.observeBuffered(bufferedBytes)
    if (message.type !== 'sync' && message.type !== 'request') return
    this.counters.outboundSyncMessages += 1
    if (!message.documentId || !message.targetId) return

    let entry = this.documents.get(message.documentId)
    if (!entry) {
      if (this.documents.size >= this.config.maxTrackedDocuments) {
        this.documentOverflow += 1
        return
      }
      entry = { recipients: new Set(), messages: 0, payloadBytes: 0 }
      this.documents.set(message.documentId, entry)
    }
    entry.recipients.add(message.targetId)
    entry.messages += 1
    entry.payloadBytes += Math.max(0, payloadBytes)
  }

  recordSyncOperation(type: 'receive-sync-message' | 'generate-sync-message', durationMs: number): void {
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    const samples = type === 'receive-sync-message' ? this.receiveDurationsMs : this.generateDurationsMs
    samples.record(duration)
    if (type === 'receive-sync-message') {
      this.receiveCount += 1
      this.receiveTotalMs += duration
      this.maxReceiveMs = Math.max(this.maxReceiveMs, duration)
    } else {
      this.generateCount += 1
      this.generateTotalMs += duration
      this.maxGenerateMs = Math.max(this.maxGenerateMs, duration)
    }
  }

  recordDisconnectedDrop(): void {
    this.counters.outboundDroppedDisconnected += 1
  }

  recordBackpressureWarning(bufferedBytes: number): void {
    this.counters.backpressureWarningEpisodes += 1
    this.observeBuffered(bufferedBytes)
  }

  recordBackpressureDisconnect(bufferedBytes: number): void {
    this.counters.backpressureDisconnects += 1
    this.counters.outboundDroppedBackpressure += 1
    this.observeBuffered(bufferedBytes)
  }

  recordBackpressureDrop(): void {
    this.counters.outboundDroppedBackpressure += 1
  }

  observeBuffered(bufferedBytes: number): void {
    this.maxBufferedBytes = Math.max(this.maxBufferedBytes, Math.max(0, bufferedBytes))
  }

  startStructuredLogging(logger: (line: string) => void = console.log): void {
    if (this.logTimer || this.config.telemetryIntervalMs === 0) return
    this.logTimer = setInterval(() => logger(JSON.stringify(this.structuredLogSnapshot())), this.config.telemetryIntervalMs)
    this.logTimer.unref()
  }

  snapshot(): AutomergeTransportSnapshot {
    const buffers = [...this.activeSockets].map((socket) => Math.max(0, socket.bufferedAmount || 0))
    const memory = lightweightProcessMemoryBytes()
    const recipients = [...this.documents.values()].map((entry) => entry.recipients.size).sort((a, b) => a - b)
    const messages = [...this.documents.values()].map((entry) => entry.messages).sort((a, b) => a - b)
    const receiveDurations = this.receiveDurationsMs.quantiles()
    const generateDurations = this.generateDurationsMs.quantiles()
    const fanoutRatio = this.counters.inboundSyncMessages === 0
      ? 0
      : this.counters.outboundSyncMessages / this.counters.inboundSyncMessages
    return {
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      config: { ...this.config },
      connections: {
        active: this.activeSockets.size,
        peak: this.peakConnections,
        accepted: this.counters.acceptedConnections,
        closed: this.counters.closedConnections,
        rejectedUnauthorized: this.counters.rejectedUnauthorized,
        rejectedStaleEpoch: this.counters.rejectedStaleEpoch,
        rejectedAuthError: this.counters.rejectedAuthError,
        closedByCategory: { ...this.closedByCategory },
        averageClosedDurationMs: this.counters.closedConnections === 0
          ? 0
          : Math.round(this.closedDurationTotalMs / this.counters.closedConnections),
        maxClosedDurationMs: this.closedDurationMaxMs,
      },
      traffic: {
        inboundFrames: this.counters.inboundFrames,
        inboundBytes: this.counters.inboundBytes,
        maxInboundFrameBytes: this.maxInboundFrameBytes,
        inboundSyncMessages: this.counters.inboundSyncMessages,
        outboundFrames: this.counters.outboundFrames,
        outboundPayloadBytes: this.counters.outboundPayloadBytes,
        outboundSyncMessages: this.counters.outboundSyncMessages,
        outboundToInboundSyncRatio: Math.round(fanoutRatio * 100) / 100,
        outboundDroppedDisconnected: this.counters.outboundDroppedDisconnected,
        outboundDroppedBackpressure: this.counters.outboundDroppedBackpressure,
        presenceAccepted: this.counters.presenceAccepted,
        presenceDropped: this.counters.presenceDropped,
        presenceRateLimited: this.counters.presenceRateLimited,
      },
      backpressure: {
        slowConnections: buffers.filter((value) => value >= this.config.backpressureWarnBytes).length,
        totalBufferedBytes: buffers.reduce((sum, value) => sum + value, 0),
        currentMaxBufferedBytes: Math.max(0, ...buffers),
        lifetimeMaxBufferedBytes: this.maxBufferedBytes,
        warningEpisodes: this.counters.backpressureWarningEpisodes,
        disconnects: this.counters.backpressureDisconnects,
      },
      fanoutWindow: {
        documentsObserved: this.documents.size,
        overflowDocuments: this.documentOverflow,
        maxRecipientsPerDocument: Math.max(0, ...recipients),
        p95RecipientsPerDocument: percentile(recipients, 0.95),
        maxMessagesPerDocument: Math.max(0, ...messages),
      },
      syncCpu: {
        receiveCount: this.receiveCount,
        generateCount: this.generateCount,
        receiveTotalMs: Math.round(this.receiveTotalMs * 100) / 100,
        generateTotalMs: Math.round(this.generateTotalMs * 100) / 100,
        receiveP95Ms: Math.round(receiveDurations.p95 * 100) / 100,
        receiveP99Ms: Math.round(receiveDurations.p99 * 100) / 100,
        generateP95Ms: Math.round(generateDurations.p95 * 100) / 100,
        generateP99Ms: Math.round(generateDurations.p99 * 100) / 100,
        maxReceiveMs: Math.round(this.maxReceiveMs * 100) / 100,
        maxGenerateMs: Math.round(this.maxGenerateMs * 100) / 100,
      },
      eventLoopDelayMs: {
        mean: milliseconds(this.eventLoopDelay.mean),
        p95: milliseconds(this.eventLoopDelay.percentile(95)),
        p99: milliseconds(this.eventLoopDelay.percentile(99)),
        max: milliseconds(this.eventLoopDelay.max),
      },
      eventLoopWindow: {
        consumer: 'periodic',
        startedAt: new Date(this.eventLoopWindowStartedAt).toISOString(),
        resetCount: this.eventLoopWindowResets,
        lastResetBy: this.eventLoopWindowLastResetBy,
      },
      processMemoryBytes: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
    }
  }

  /**
   * Return the event-loop distribution observed since the previous reset, then
   * start a fresh window. This is intentionally separate from snapshot():
   * ordinary diagnostics remain non-destructive, while qualification samplers
   * can compare disjoint intervals and never carry an injected pause into the
   * following run.
   */
  snapshotAndResetEventLoopDelay(): AutomergeTransportSnapshot {
    const snapshot = this.snapshot()
    const monitor = this.qualificationEventLoopDelay
    snapshot.eventLoopDelayMs = {
      mean: milliseconds(monitor.mean), p95: milliseconds(monitor.percentile(95)),
      p99: milliseconds(monitor.percentile(99)), max: milliseconds(monitor.max),
    }
    snapshot.eventLoopWindow = {
      consumer: 'qualification',
      startedAt: new Date(this.qualificationWindowStartedAt).toISOString(),
      resetCount: this.qualificationWindowResets,
      lastResetBy: this.qualificationWindowResets === 0 ? 'boot' : 'consume',
    }
    monitor.reset()
    this.qualificationWindowStartedAt = Date.now()
    this.qualificationWindowResets += 1
    return snapshot
  }

  /**
   * The logger owns only the periodic histogram and its reset metadata.
   */
  private markEventLoopWindowReset(by: 'periodic-log'): void {
    this.eventLoopDelay.reset()
    this.eventLoopWindowStartedAt = Date.now()
    this.eventLoopWindowResets += 1
    this.eventLoopWindowLastResetBy = by
  }

  stop(): void {
    if (this.logTimer) clearInterval(this.logTimer)
    this.logTimer = null
    this.eventLoopDelay.disable()
    this.qualificationEventLoopDelay.disable()
    this.gcObserver.disconnect()
  }

  private structuredLogSnapshot(): Record<string, unknown> {
    const snapshot = this.snapshot()
    const deltas = Object.fromEntries(
      (Object.keys(this.counters) as Array<keyof Counters>).map((key) => [
        `${key}Delta`,
        this.counters[key] - this.lastLoggedCounters[key],
      ]),
    )
    this.lastLoggedCounters = { ...this.counters }
    this.documents.clear()
    this.documentOverflow = 0
    this.markEventLoopWindowReset('periodic-log')
    return {
      event: 'automerge.transport',
      ...snapshot.connections,
      ...snapshot.traffic,
      ...snapshot.backpressure,
      ...snapshot.fanoutWindow,
      ...snapshot.syncCpu,
      eventLoopMeanMs: snapshot.eventLoopDelayMs.mean,
      eventLoopP95Ms: snapshot.eventLoopDelayMs.p95,
      eventLoopP99Ms: snapshot.eventLoopDelayMs.p99,
      eventLoopMaxMs: snapshot.eventLoopDelayMs.max,
      rssBytes: snapshot.processMemoryBytes.rss,
      heapUsedBytes: snapshot.processMemoryBytes.heapUsed,
      externalBytes: snapshot.processMemoryBytes.external,
      arrayBufferBytes: snapshot.processMemoryBytes.arrayBuffers,
      ...deltas,
    }
  }

  private dropSocket(socket: TransportSocket, code: number | undefined): void {
    if (!this.activeSockets.delete(socket)) return
    this.counters.closedConnections += 1
    this.closedByCategory[closeCategory(code)] += 1
    const acceptedAt = this.acceptedAt.get(socket)
    if (acceptedAt != null) {
      const duration = Math.max(0, Date.now() - acceptedAt)
      this.closedDurationTotalMs += duration
      this.closedDurationMaxMs = Math.max(this.closedDurationMaxMs, duration)
    }
    this.acceptedAt.delete(socket)
  }
}
