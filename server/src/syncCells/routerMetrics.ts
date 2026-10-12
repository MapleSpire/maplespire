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

import type { MetricSample } from '../runtime/metrics.js'

export type RouterAdmissionOutcome = 'connected' | 'rejected' | 'failed'
export type RouterMetricsSnapshot = {
  admissions: Record<RouterAdmissionOutcome, number>
  ownerRefreshAgeSeconds: number
}

/** Local counters only. The clock is monotone and the epoch is the END of a
 * successful raw owner read, including a confirmed absence. A cache hit, an
 * in-flight or failed read, and a placement refresh are not owner refreshes. */
export function createRouterMetrics(now: () => number = () => performance.now()) {
  const admissions: Record<RouterAdmissionOutcome, number> = { connected: 0, rejected: 0, failed: 0 }
  let lastOwnerReadAt: number | null = null
  return {
    admission(outcome: RouterAdmissionOutcome): void { admissions[outcome] += 1 },
    ownerReadSucceeded(): void { lastOwnerReadAt = now() },
    snapshot(): RouterMetricsSnapshot {
      return {
        admissions: { ...admissions },
        ownerRefreshAgeSeconds: lastOwnerReadAt === null ? Number.NaN : Math.max(0, now() - lastOwnerReadAt) / 1_000,
      }
    },
  }
}

/** Synchronous exposition: no lookup, refresh or readiness probe. */
export function syncRouterMetricSamples(
  topology: 'pending' | 'confirmed' | 'mismatch',
  snapshot?: RouterMetricsSnapshot,
): MetricSample[] {
  return [
    {
      name: 'maplespire_sync_router_topology_state',
      help: 'Router boot topology: 0 pending, 1 confirmed once, 2 fatal mismatch (may disappear before a scrape).',
      type: 'gauge',
      values: [{ value: topology === 'mismatch' ? 2 : topology === 'confirmed' ? 1 : 0 }],
    },
    {
      name: 'maplespire_sync_router_admissions_total',
      help: 'Completed WebSocket upgrade attempts: connected proxy, local rejection, or lookup/proxy failure; not active tunnels.',
      type: 'counter',
      values: [
        { labels: { outcome: 'connected' }, value: snapshot?.admissions.connected ?? 0 },
        { labels: { outcome: 'rejected' }, value: snapshot?.admissions.rejected ?? 0 },
        { labels: { outcome: 'failed' }, value: snapshot?.admissions.failed ?? 0 },
      ],
    },
    {
      name: 'maplespire_sync_router_owner_refresh_age_seconds',
      help: 'Monotonic seconds since completion of the last successful raw owner read (including absence); NaN before any success, may age while idle.',
      type: 'gauge',
      values: [{ value: snapshot?.ownerRefreshAgeSeconds ?? Number.NaN }],
    },
  ]
}
