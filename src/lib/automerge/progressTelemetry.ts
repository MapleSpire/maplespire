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

/**
 * "How will we know the stall budget stopped being enough?" — the instrument
 * that answers it for `progressBudget.ts`, in the same shape
 * `waiverTelemetry.ts` answers it for the waiver.
 *
 * ── The three readings, and why they are three ───────────────────────────────
 *  - `extended`      a ceiling fired while the socket was delivering real
 *                    bytes, so the window was not charged. This is the
 *                    mechanism working: the number of boots this saved.
 *  - `stallEnded`    the wall since the last progress ran out. The server went
 *                    quiet — which is what the wall is FOR. Not an alarm.
 *  - `hardCapped`    the ABSOLUTE wall ended a resolution that was still
 *                    making progress. **THE early warning**, and the only one:
 *                    it means the deployment needs longer to serve a workspace
 *                    than any client should wait, and no client setting fixes
 *                    that. It should be 0 on a healthy deployment.
 *
 * They are kept apart because folding them would fire on a server outage
 * (`stallEnded`) exactly as loudly as on the condition that actually needs a
 * human (`hardCapped`) — the same mistake `waiverTelemetry` avoids by keeping
 * `clipped` apart from `budget-exhausted`.
 *
 * ── `maxExtendedMs` is the margin, and the margin is the point ───────────────
 * A count of failed boots moves only after users have seen the defect. What
 * moves first is how much extension the worst boot needed: when
 * `maxExtendedMs` approaches `BOOT_RESOLVE_MAX_MS`, the next slower day is a
 * failure. Read it the way `handshakeMs` is read for the waiver — as a
 * maximum, never a mean.
 *
 * ── Where it can be read ─────────────────────────────────────────────────────
 * Same as the waiver's counters: there is NO client→server telemetry channel.
 * `installClientDiagnostics` exposes `window.__maplespireDiagnostics` under
 * DEV or `VITE_CLIENT_PERF_DIAGNOSTICS=true`, and nothing beacons — so these
 * are read from a bench or e2e run, which is weaker than supervision and must
 * not be mistaken for it.
 */

export interface ProgressTelemetry {
  /** Windows not charged because the transport was delivering. */
  extended: number
  /** Bytes observed during those windows — the evidence, not a proxy. */
  extendedBytes: number
  /** Resolutions ended by the stall wall (the server went quiet). */
  stallEnded: number
  /** Resolutions ended by the ABSOLUTE wall while progress continued. */
  hardCapped: number
  /** The largest total extension any single resolution needed, ms. Compare
   * against `BOOT_RESOLVE_MAX_MS`: this is the margin. */
  maxExtendedMs: number
}

let extended = 0
let extendedBytes = 0
let stallEnded = 0
let hardCapped = 0
let maxExtendedMs = 0

/** A ceiling fired, real bytes had arrived: the window is not charged.
 *
 * It takes the BYTES and not the window length on purpose. The window is a
 * property of the schedule and is already known from `maxExtendedMs`; the
 * bytes are the evidence — the quantity that says the server was working,
 * and the one a reader of an incident has no other way to recover. */
export function recordProgressExtension(bytes: number): void {
  extended += 1
  extendedBytes += Math.max(0, bytes)
}

/** One resolution ended. `extendedMs` is how much wall it bought from
 * progress; `reason` says which wall stopped it, or `null` if neither did
 * (it resolved, or `tries` ended it on the rejection path). */
export function recordResolutionEnd(
  extendedMs: number,
  reason: 'stall' | 'hard-cap' | null,
): void {
  if (extendedMs > maxExtendedMs) maxExtendedMs = extendedMs
  if (reason === 'stall') stallEnded += 1
  if (reason === 'hard-cap') {
    hardCapped += 1
    // Loud, and only on the transition that matters. This is the sentence an
    // operator should be able to find before users report failed boots.
    console.warn(
      `[progressBudget] a boot document hit the ABSOLUTE wall after ${Math.round(extendedMs)}ms of`
      + ` transport progress (${hardCapped} so far). The server was still sending when the client gave up:`
      + ` this deployment needs longer to serve a workspace than the wall allows, and no client setting`
      + ` fixes that. Re-measure with the boot-load rush.`,
    )
  }
}

export function readProgressTelemetry(): ProgressTelemetry {
  return { extended, extendedBytes, stallEnded, hardCapped, maxExtendedMs }
}

export function resetProgressTelemetry(): void {
  extended = 0
  extendedBytes = 0
  stallEnded = 0
  hardCapped = 0
  maxExtendedMs = 0
}
