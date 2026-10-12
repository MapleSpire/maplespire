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

import { timingSafeEqual } from 'node:crypto'

/**
 * Prometheus exposition for server health signals (e.g. a read-model workspace
 * that is `degraded` or `stale`, a residency lease watched by nobody), so they
 * can be alerted on rather than discovered in an admin dialog or a log search.
 * A detector nothing scrapes is a detector nobody acts on.
 *
 * Hand-rolled rather than pulling in a client library: the text format is a
 * dozen lines, and every metric here is sampled at scrape time from state that
 * already exists.
 */

export interface MetricSample {
  name: string
  help: string
  type: 'gauge' | 'counter'
  values: Array<{ labels?: Record<string, string>; value: number }>
}

/** Prometheus label values escape backslash, newline and double quote — nothing else. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

export function renderPrometheus(metrics: readonly MetricSample[]): string {
  const lines: string[] = []
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help.replace(/\n/g, ' ')}`)
    lines.push(`# TYPE ${metric.name} ${metric.type}`)
    for (const sample of metric.values) {
      const labels = Object.entries(sample.labels ?? {})
        .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
        .join(',')
      // A non-finite value is not "0" — it is a broken sample, and emitting it as
      // zero would show a healthy flat line for a collector that is failing.
      const value = Number.isFinite(sample.value) ? String(sample.value) : 'NaN'
      lines.push(labels ? `${metric.name}{${labels}} ${value}` : `${metric.name} ${value}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Constant-time bearer check.
 *
 * `METRICS_TOKEN` unset means the endpoint does not exist — 404, not 401, and
 * not an open endpoint. Failing open here would publish workspace counts and
 * process memory to anything that can reach the port, and a scrape endpoint is
 * exactly the sort of thing that gets exposed through an ingress by accident.
 */
export function metricsTokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false
  const prefix = 'Bearer '
  if (!header || !header.startsWith(prefix)) return false
  const provided = Buffer.from(header.slice(prefix.length))
  const target = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, so a mismatched length is
  // rejected here.
  if (provided.length !== target.length) {
    // Still do a comparison of equal-length buffers so the failure costs about
    // the same as a same-length mismatch.
    timingSafeEqual(target, target)
    return false
  }
  return timingSafeEqual(provided, target)
}
