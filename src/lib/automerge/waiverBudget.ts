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
 * How long a document resolution may WAIT for a handshake that has not landed
 * yet — the waiver's own wall.
 *
 * ── Why a wall at all ────────────────────────────────────────────────────────
 * A `find()` rejection that arrives while this workspace's socket is still
 * shaking hands is not a verdict about the document, so it is not charged.
 * Without this wall the only bound on that wait is `budgetMs` (24 s), and the
 * state that arms it is far commoner than "offline" suggests: `peerExpected()`
 * is `navigator.onLine !== false` AND a handshake in flight, and a handshake
 * is "in flight" for the WHOLE of a transport's first connection attempt —
 * an unbounded quantity. A SYN dropped by a firewall, a dead VPN, a captive
 * portal: the browser reports itself ONLINE and the socket sits in CONNECTING
 * for tens of seconds. Without this wall that boot pays 10 s of HTTP plus the
 * whole budget, instead of failing over to offline in ~1.4 s.
 *
 * ── Where the default comes from, and what to re-measure ─────────────────────
 * 2 000 ms. The quantity this is meant to MAJORIZE is the delay between a
 * document `find()` and its peer handshake landing. On a local dev stack (eight
 * concurrent clients booting a 3 000-diagram landscape) late handshakes spread
 * from 1 ms to 683 ms; the default is ~3× that worst case.
 *
 * That is one stack, not a distribution, and a cloud deployment may
 * legitimately be slower. To re-take the measurement: run the joiner rush
 * against the heaviest workspace
 * (`E2E_RUSH_LANDSCAPE=<id> npx playwright test --project=boot-load`) and read
 * `handshakeMs` out of `readWaiverTelemetry()` — p50/p95/max, never a mean.
 * The number to compare against this default is the **max**, and the health
 * indicator is `clippedRatio` (see waiverTelemetry.ts) — a ratio, because it
 * is the one reading that does not move with the environment: absolute
 * latencies rise on a slower deployment, but a well-sized cap keeps the ratio
 * at zero anyway.
 *
 * ── The override, and why it is bounded ──────────────────────────────────────
 * `VITE_BOOT_WAIVER_MS` at build time, `localStorage['maplespire:bootWaiverMs']`
 * at runtime — the pattern every other client flag in this repo uses
 * (`modelQuery/flag.ts`). The
 * runtime override reloads, because `BOOT_DOCUMENT_RESOLUTION` derives its
 * `budgetMs` from this value at module init.
 *
 * The override is CLAMPED at WAIVER_BUDGET_MAX_MS and the clamp is LOUD. A cap
 * settable to 30 s would reintroduce exactly the long hang this wall removes,
 * hidden in a configuration file. 5 000 ms is ~7× the worst delay measured;
 * past that the server, not the client's patience, is what needs fixing.
 *
 * ── DO NOT make this adaptive ────────────────────────────────────────────────
 * It is tempting to widen the cap automatically when observed handshakes creep
 * up. Do not. A cap that tracks the latency it is supposed to bound absorbs a
 * degrading environment in silence and DESTROYS the very signal this file
 * exists to produce: `clipped > 0` while boots still succeed is the early
 * warning, and an adaptive cap guarantees it stays 0 until users are already
 * failing — it turns a detector into a mirror. The cap is a POLICY a person
 * sets and a measurement argues with; it is not a function of the measurement.
 */

/** The measured default: ~3× the worst handshake delay ever observed (683 ms). */
export const WAIVER_BUDGET_DEFAULT_MS = 2_000

/** The most any override may buy. Past this the instant offline boot is gone;
 * 5 000 is already ~7× the worst handshake delay measured. */
export const WAIVER_BUDGET_MAX_MS = 5_000

const LS_KEY = 'maplespire:bootWaiverMs'
const ENV_KEY = 'VITE_BOOT_WAIVER_MS'

function readOverride(): { raw: string; source: string } | null {
  const fromEnv = (import.meta.env as Record<string, string | undefined>)[ENV_KEY]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { raw: fromEnv, source: ENV_KEY }
  try {
    const fromStorage = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null
    if (fromStorage !== null && fromStorage.trim() !== '') return { raw: fromStorage, source: LS_KEY }
  } catch {
    /* a storage-less context (worker, SSR, private mode) simply has no override */
  }
  return null
}

/**
 * The configured waiver wall, clamped and — when clamped or malformed — SAID
 * OUT LOUD. A setting silently ignored is worse than no setting: the operator
 * believes a value that is not in force.
 */
export function resolveWaiverBudgetMs(): number {
  const override = readOverride()
  if (!override) return WAIVER_BUDGET_DEFAULT_MS
  const parsed = Number(override.raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[waiverBudget] ${override.source}=${JSON.stringify(override.raw)} is not a non-negative number;`
      + ` using the default ${WAIVER_BUDGET_DEFAULT_MS}ms`,
    )
    return WAIVER_BUDGET_DEFAULT_MS
  }
  if (parsed > WAIVER_BUDGET_MAX_MS) {
    console.warn(
      `[waiverBudget] ${override.source}=${parsed}ms exceeds the maximum ${WAIVER_BUDGET_MAX_MS}ms and was`
      + ` CLAMPED. A boot with an unreachable server waits this long before failing, so the cap is bounded`
      + ` on purpose; if handshakes here really are slower than ${WAIVER_BUDGET_MAX_MS}ms, that is a server`
      + ` finding, not a client setting.`,
    )
    return WAIVER_BUDGET_MAX_MS
  }
  return parsed
}

/**
 * Read ONCE at module init, exactly like every other `import.meta.env` flag in
 * this codebase (they are read at Vite start). It has to
 * be a constant for the run because `BOOT_DOCUMENT_RESOLUTION.budgetMs` is
 * derived from it at import time — a value that drifted mid-session would put
 * the budget and the retry schedule out of step.
 */
export const WAIVER_BUDGET_MS = resolveWaiverBudgetMs()

/**
 * A waiver allowance that can be SHARED.
 *
 * ── Why the allowance is not per-call ────────────────────────────────────────
 * The waiver can arm on a RECONNECTION, not only on a transport's first
 * connection attempt, and a reconnection is armed for the whole of an outage.
 * The boot makes one resolution call per document (root + registry shards +
 * ModelMeta, ~18 on a large landscape). Per call, that would be 18 × 2 000 =
 * 36 s on a boot whose server is unreachable while the browser reports itself
 * online. Shared per BOOT, the allowance is paid ONCE.
 *
 * ── Why it is an object a caller passes, not a module counter ────────────────
 * A module-level counter would make every unit test of the retry scheduler an
 * integration test against a global that other tests had already spent, and
 * ordering would decide outcomes. It is injected, defaults to a FRESH per-call
 * allowance when a caller passes none (the model/diagram sites, which pass no
 * `peers` anyway), and the one production site that shares it is
 * `BOOT_DOCUMENT_RESOLUTION` in `repo.ts`.
 */
export interface WaiverAllocation {
  /** What is left, never negative. */
  remainingMs(): number
  /** Charge a wait against the allowance. */
  spend(ms: number): void
}

/** A fresh allowance of `totalMs` (the configured cap by default). */
export function createWaiverAllocation(totalMs: number = WAIVER_BUDGET_MS): WaiverAllocation {
  const total = Math.max(0, totalMs)
  let spent = 0
  return {
    remainingMs: () => Math.max(0, total - spent),
    spend: (ms: number) => { spent += Math.max(0, ms) },
  }
}

/** Set the runtime override and reload, so the derived boot budget is rebuilt.
 * Mirrors `setModelPaging` / `setBootFromServer`. */
export function setBootWaiverMs(ms: number | null): void {
  try {
    if (ms === null) localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, String(ms))
  } catch {
    /* ignore */
  }
  if (typeof location !== 'undefined') location.reload()
}
