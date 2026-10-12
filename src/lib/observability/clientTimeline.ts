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

export type ClientTimelineDetail = string | number | boolean | null

export interface ClientTimelineEntry {
  sequence: number
  name: string
  kind: 'mark' | 'measure'
  startTime: number
  durationMs?: number
  details: Record<string, ClientTimelineDetail>
}
export interface ClientTimelineAggregate {
  calls: number
  failures: number
  totalDurationMs: number
  averageDurationMs: number
  p95DurationMs: number
  maxDurationMs: number
}

export interface ClientTimelineSnapshot {
  maxEntries: number
  droppedEntries: number
  entries: ClientTimelineEntry[]
  measures: Record<string, ClientTimelineAggregate>
}

const MAX_ENTRIES = 500
let entries: ClientTimelineEntry[] = []
let sequence = 0
let droppedEntries = 0
let forcedEnabled: boolean | null = null
let clock = (): number => (
  typeof performance !== 'undefined' ? performance.now() : Date.now()
)

function enabled(): boolean {
  if (forcedEnabled !== null) return forcedEnabled
  return import.meta.env.DEV || import.meta.env.VITE_CLIENT_PERF_DIAGNOSTICS === 'true'
}

function normalizedDetails(
  details: Record<string, ClientTimelineDetail | undefined>,
): Record<string, ClientTimelineDetail> {
  return Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, ClientTimelineDetail] => entry[1] !== undefined),
  )
}

function append(entry: Omit<ClientTimelineEntry, 'sequence'>): void {
  if (!enabled()) return
  entries.push({ ...entry, sequence: ++sequence })
  if (entries.length <= MAX_ENTRIES) return
  const overflow = entries.length - MAX_ENTRIES
  entries.splice(0, overflow)
  droppedEntries += overflow
}

/** Add an instantaneous, privacy-minimal event to the bounded E2E timeline. */
export function markClientTimeline(
  name: string,
  details: Record<string, ClientTimelineDetail | undefined> = {},
): void {
  append({
    name,
    kind: 'mark',
    startTime: clock(),
    details: normalizedDetails(details),
  })
}

/**
 * Start a duration measurement. The returned callback is idempotent so error
 * paths can safely finish a span in both catch/finally blocks.
 */
export function startClientTimelineMeasure(
  name: string,
  details: Record<string, ClientTimelineDetail | undefined> = {},
): (endDetails?: Record<string, ClientTimelineDetail | undefined>) => void {
  if (!enabled()) return () => undefined
  const startTime = clock()
  let finished = false
  return (endDetails = {}) => {
    if (finished) return
    finished = true
    append({
      name,
      kind: 'measure',
      startTime,
      durationMs: Math.max(0, clock() - startTime),
      details: normalizedDetails({ ...details, ...endDetails }),
    })
  }
}

function percentile95(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

export function readClientTimeline(): ClientTimelineSnapshot {
  const byName = new Map<string, ClientTimelineEntry[]>()
  for (const entry of entries) {
    if (entry.kind !== 'measure') continue
    const current = byName.get(entry.name)
    if (current) current.push(entry)
    else byName.set(entry.name, [entry])
  }
  const measures = Object.fromEntries(
    [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, samples]) => {
      const durations = samples.map((sample) => sample.durationMs ?? 0)
      const totalDurationMs = durations.reduce((sum, duration) => sum + duration, 0)
      return [name, {
        calls: samples.length,
        failures: samples.filter((sample) => sample.details.failed === true).length,
        totalDurationMs: Math.round(totalDurationMs * 10) / 10,
        averageDurationMs: Math.round((totalDurationMs / samples.length) * 10) / 10,
        p95DurationMs: Math.round(percentile95(durations) * 10) / 10,
        maxDurationMs: Math.round(Math.max(...durations) * 10) / 10,
      } satisfies ClientTimelineAggregate]
    }),
  )
  return {
    maxEntries: MAX_ENTRIES,
    droppedEntries,
    entries: entries.map((entry) => ({ ...entry, details: { ...entry.details } })),
    measures,
  }
}

export function resetClientTimeline(): void {
  entries = []
  sequence = 0
  droppedEntries = 0
}

/** Test seams; production callers should use the default environment gate. */
export function __setClientTimelineEnabledForTest(value: boolean | null): void {
  forcedEnabled = value
}

export function __setClientTimelineClockForTest(value: (() => number) | null): void {
  clock = value ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
}
