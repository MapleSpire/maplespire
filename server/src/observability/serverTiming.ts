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

import { performance } from 'node:perf_hooks'

export interface ServerTimingHeaderSink {
  setHeader(name: string, value: string): unknown
}

/** Parse the privacy-minimal metrics emitted by ServerTimingTrace. Used by
 * local capacity gates; malformed or non-duration entries are ignored. */
export function parseServerTimingHeader(value: string | null | undefined): Record<string, number> {
  if (!value) return {}
  const metrics: Record<string, number> = {}
  for (const entry of value.split(',')) {
    const [rawName, ...parameters] = entry.trim().split(';')
    if (!rawName) continue
    const durationParameter = parameters.find((parameter) => parameter.trim().startsWith('dur='))
    if (!durationParameter) continue
    const parsed = Number(durationParameter.trim().slice('dur='.length))
    if (Number.isFinite(parsed) && parsed >= 0) metrics[rawName] = parsed
  }
  return metrics
}
interface ServerTimingMetric {
  name: string
  durationMs: number
}

function metricName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return normalized || 'metric'
}

function duration(value: number): string {
  return (Math.round(Math.max(0, value) * 10) / 10).toFixed(1)
}

/** Request-local Server-Timing collector with no workspace or user identifiers. */
export class ServerTimingTrace {
  private readonly startedAt: number
  private readonly metrics: ServerTimingMetric[] = []

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.startedAt = this.clock()
  }

  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = this.clock()
    try {
      return await operation()
    } finally {
      this.metrics.push({ name: metricName(name), durationMs: this.clock() - startedAt })
    }
  }

  measureSync<T>(name: string, operation: () => T): T {
    const startedAt = this.clock()
    try {
      return operation()
    } finally {
      this.metrics.push({ name: metricName(name), durationMs: this.clock() - startedAt })
    }
  }

  headerValue(): string {
    const total = { name: 'total', durationMs: this.clock() - this.startedAt }
    return [...this.metrics, total]
      .map((metric) => `${metric.name};dur=${duration(metric.durationMs)}`)
      .join(', ')
  }

  write(target: ServerTimingHeaderSink): void {
    target.setHeader('Server-Timing', this.headerValue())
  }
}
