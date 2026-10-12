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

import { readOriginStorageDiagnostics } from '../offline/storageBudget'
import { enforceDerivedCacheBudget } from '../offline/cacheRetention'
import { getModelReadCacheWorker } from '../modelQuery/workerClient'
import {
  readClientPerformanceSnapshot,
  resetClientPerformanceDiagnostics,
  startClientPerformanceDiagnostics,
  stopClientPerformanceDiagnostics,
} from './clientPerformance'
import { readModelQueryDiagnostics, resetModelQueryDiagnostics } from './modelQueryDiagnostics'
import { readClientTimeline, resetClientTimeline } from './clientTimeline'
import { readWaiverTelemetry, resetWaiverTelemetry } from '../automerge/waiverTelemetry'
import { WAIVER_BUDGET_MS } from '../automerge/waiverBudget'
import { readProgressTelemetry, resetProgressTelemetry } from '../automerge/progressTelemetry'
import { BOOT_RESOLVE_MAX_MS } from '../automerge/progressBudget'

const DIAGNOSTICS_SNAPSHOT_ID = 'maplespire-client-diagnostics'
let diagnosticsMirrorTimer: ReturnType<typeof setInterval> | null = null

export function stopClientDiagnosticsMirror(): void {
  if (diagnosticsMirrorTimer) clearInterval(diagnosticsMirrorTimer)
  diagnosticsMirrorTimer = null
}

export function publishClientDiagnosticsSnapshot(): void {
  if (typeof document === 'undefined') return
  let snapshot = document.getElementById(DIAGNOSTICS_SNAPSHOT_ID)
  if (!snapshot) {
    snapshot = document.createElement('script')
    snapshot.id = DIAGNOSTICS_SNAPSHOT_ID
    snapshot.setAttribute('type', 'application/json')
    snapshot.setAttribute('aria-hidden', 'true')
    document.head.appendChild(snapshot)
  }
  snapshot.textContent = JSON.stringify({
    performance: readClientPerformanceSnapshot(),
    timeline: readClientTimeline(),
    modelQueries: readModelQueryDiagnostics(),
    // The boot waiver's MARGIN, not its failures. `clipped > 0` on a
    // run where every boot succeeded is the early warning that the cap is
    // being consumed; `handshakeMs` is the distribution the cap has to
    // majorize, and `waiverBudgetMs` is the cap actually in force after any
    // override was clamped. Mirrored into the DOM snapshot so a bench or e2e
    // run can read it without evaluating in the page.
    waiver: { budgetMs: WAIVER_BUDGET_MS, ...readWaiverTelemetry() },
    // The stall budget's MARGIN. `maxExtendedMs` against
    // `maxBudgetMs` is the reading that moves before any boot fails;
    // `hardCapped > 0` is the one that means the deployment, not the
    // client, has to change.
    progress: { maxBudgetMs: BOOT_RESOLVE_MAX_MS, ...readProgressTelemetry() },
  })
}

/**
 * The boot-health counters, ALWAYS available — including in a production
 * build.
 *
 * ── Why this exists separately from the surface below ───────────────────────
 * `installClientDiagnostics` is gated on DEV or `VITE_CLIENT_PERF_DIAGNOSTICS`
 * because it STARTS things: a performance observer and a 1 s DOM-mirror
 * interval. Those costs have no place in a production tab. The two boot walls
 * have the opposite problem — their early warnings (`clipped` for the waiver,
 * `hardCapped` and `maxExtendedMs` for the stall budget) are worth nothing if
 * they can only be read on a machine that already has the flag set, which is
 * never the machine where a user's boot is failing.
 *
 * So this is a pure READ: no timers, no observers, no subscriptions, nothing
 * started, and nothing retained. It returns aggregate numbers only — no
 * document ids, no urls, no workspace, no content — so it carries the same
 * privacy posture as the server's own `synchronizerPeerSnapshot`.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────────
 * It is not supervision. There is NO client→server telemetry channel: nothing
 * beacons, nothing reports. This only makes the counters reachable from a
 * support session or a user's own devtools; fleet-wide visibility would need
 * service latency measured on the SERVER.
 */
export function readBootHealth(): {
  waiver: { budgetMs: number } & ReturnType<typeof readWaiverTelemetry>
  progress: { maxBudgetMs: number } & ReturnType<typeof readProgressTelemetry>
} {
  return {
    waiver: { budgetMs: WAIVER_BUDGET_MS, ...readWaiverTelemetry() },
    progress: { maxBudgetMs: BOOT_RESOLVE_MAX_MS, ...readProgressTelemetry() },
  }
}

/** Publish `readBootHealth` on `window`, unconditionally. Called from
 * `main.tsx` next to `installClientDiagnostics`, and deliberately NOT inside
 * it: the gate there is about what that function STARTS, and this starts
 * nothing. */
export function exposeBootHealth(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__maplespireBootHealth = readBootHealth
}

/** Install a privacy-minimal diagnostic surface for browser/E2E performance gates. */
export function installClientDiagnostics(): void {
  const enabled = import.meta.env.DEV || import.meta.env.VITE_CLIENT_PERF_DIAGNOSTICS === 'true'
  if (!enabled || typeof window === 'undefined') return
  startClientPerformanceDiagnostics()
  ;(window as unknown as Record<string, unknown>).__maplespireDiagnostics = {
    performance: readClientPerformanceSnapshot,
    resetPerformance: resetClientPerformanceDiagnostics,
    storage: readOriginStorageDiagnostics,
    derivedCache: () => getModelReadCacheWorker().storageStatus(),
    enforceDerivedCacheBudget,
    modelQueries: readModelQueryDiagnostics,
    resetModelQueries: resetModelQueryDiagnostics,
    timeline: readClientTimeline,
    resetTimeline: resetClientTimeline,
    waiver: () => ({ budgetMs: WAIVER_BUDGET_MS, ...readWaiverTelemetry() }),
    resetWaiver: resetWaiverTelemetry,
    progress: () => ({ maxBudgetMs: BOOT_RESOLVE_MAX_MS, ...readProgressTelemetry() }),
    resetProgress: resetProgressTelemetry,
    stop: stopClientPerformanceDiagnostics,
  }
  publishClientDiagnosticsSnapshot()
  if (!diagnosticsMirrorTimer) {
    diagnosticsMirrorTimer = setInterval(publishClientDiagnosticsSnapshot, 1_000)
  }
}
