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

export interface ModelQueryOperationMetric {
  calls: number
  failures: number
  rowsRead: number
  resultRows: number
  fullScans: number
  totalDurationMs: number
  maxDurationMs: number
}
export interface ModelQueryDiagnosticsSnapshot {
  operations: Record<string, ModelQueryOperationMetric>
  prohibitedFullScanCount: number
}

const metrics = new Map<string, ModelQueryOperationMetric>()

export function recordModelQueryOperation(input: {
  operation: string
  durationMs?: number
  rowsRead?: number
  resultRows?: number
  fullScan?: boolean
  failed?: boolean
}): void {
  const current = metrics.get(input.operation) ?? {
    calls: 0,
    failures: 0,
    rowsRead: 0,
    resultRows: 0,
    fullScans: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  }
  const duration = Math.max(0, input.durationMs ?? 0)
  current.calls += 1
  current.failures += input.failed ? 1 : 0
  current.rowsRead += Math.max(0, input.rowsRead ?? 0)
  current.resultRows += Math.max(0, input.resultRows ?? 0)
  current.fullScans += input.fullScan ? 1 : 0
  current.totalDurationMs += duration
  current.maxDurationMs = Math.max(current.maxDurationMs, duration)
  metrics.set(input.operation, current)
}

export function readModelQueryDiagnostics(): ModelQueryDiagnosticsSnapshot {
  const operations = Object.fromEntries(
    [...metrics.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, metric]) => [name, { ...metric }])
  )
  return {
    operations,
    prohibitedFullScanCount: Object.values(operations).reduce((sum, metric) => sum + metric.fullScans, 0),
  }
}

export function resetModelQueryDiagnostics(): void {
  metrics.clear()
}
