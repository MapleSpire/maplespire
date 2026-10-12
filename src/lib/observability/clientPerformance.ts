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

export interface ClientLongTaskSample {
  startTime: number
  duration: number
}
export interface ClientPerformanceSnapshot {
  startedAt: number | null
  heartbeatCount: number
  maxHeartbeatGapMs: number
  longTaskCount: number
  totalLongTaskMs: number
  longestTasks: ClientLongTaskSample[]
}

const MAX_LONG_TASK_SAMPLES = 200
let startedAt: number | null = null
let heartbeatCount = 0
let maxHeartbeatGapMs = 0
let lastHeartbeat = 0
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let observer: PerformanceObserver | null = null
let longTasks: ClientLongTaskSample[] = []

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/**
 * A heartbeat measures actual main-thread stalls; the Long Tasks observer adds
 * attribution-friendly durations where supported. This intentionally does not use
 * a MutationObserver, which runs on the blocked thread and under-reports freezes.
 */
export function startClientPerformanceDiagnostics(heartbeatMs = 50): () => void {
  if (heartbeatTimer) return stopClientPerformanceDiagnostics
  if (typeof performance === 'undefined') return stopClientPerformanceDiagnostics

  startedAt = performance.now()
  lastHeartbeat = startedAt
  heartbeatTimer = setInterval(() => {
    const now = performance.now()
    if (visible()) {
      heartbeatCount += 1
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastHeartbeat)
    }
    lastHeartbeat = now
  }, Math.max(25, heartbeatMs))

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        if (!visible()) return
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
        if (longTasks.length > MAX_LONG_TASK_SAMPLES) {
          longTasks = longTasks.slice(longTasks.length - MAX_LONG_TASK_SAMPLES)
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      observer = null
    }
  }
  return stopClientPerformanceDiagnostics
}

export function stopClientPerformanceDiagnostics(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  observer?.disconnect()
  observer = null
}

export function resetClientPerformanceDiagnostics(): void {
  heartbeatCount = 0
  maxHeartbeatGapMs = 0
  longTasks = []
  if (typeof performance !== 'undefined') {
    startedAt = heartbeatTimer ? performance.now() : null
    lastHeartbeat = startedAt ?? 0
  } else {
    startedAt = null
    lastHeartbeat = 0
  }
}

export function readClientPerformanceSnapshot(): ClientPerformanceSnapshot {
  const sorted = [...longTasks].sort((a, b) => b.duration - a.duration)
  return {
    startedAt,
    heartbeatCount,
    maxHeartbeatGapMs: Math.round(maxHeartbeatGapMs),
    longTaskCount: longTasks.length,
    totalLongTaskMs: Math.round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
    longestTasks: sorted.slice(0, 10).map((task) => ({
      startTime: Math.round(task.startTime),
      duration: Math.round(task.duration),
    })),
  }
}
