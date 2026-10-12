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
 * The STALL budget — "how long may a boot document wait while the server is
 * demonstrably still serving this client?"
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 * A FIXED allowance per boot-critical document (3 attempts of 3/6/12 s,
 * 22 000 ms of schedule inside a 24 000 ms wall) started when the document is
 * REQUESTED can die while nothing is wrong:
 *
 *  1. `resolveInBatches` issues registry shards THREE AT A TIME, and on a
 *     large landscape one batch can be several MB.
 *  2. The sync server generates sync messages for ONE document at a time, so
 *     those three are served serially — while all three clocks run.
 *  3. Other joiners' boots share the same serial server.
 *
 * So a document's allowance is spent on OTHER documents' transfers: on a
 * throttled link a boot can abandon a document while the server is pushing
 * hundreds of kilobytes down the same socket. Raising the constant cannot fix
 * this: the allowance a document needs is proportional to (boot set ×
 * concurrent joiners) / server throughput.
 *
 * ── The approach ─────────────────────────────────────────────────────────────
 * The wall is measured from the LAST OBSERVED TRANSPORT PROGRESS instead of
 * from the request. A ceiling that fired while the socket delivered real bytes
 * is not evidence about the document — it means "not my turn yet" — so it
 * neither charges `tries` nor consumes the wall. A ceiling that fired with
 * nothing arriving is exactly what the wall is for, and it still ends the call
 * in `budgetMs`.
 *
 * ── Why the witness is BYTES ON THE SOCKET, and what it cannot say ───────────
 * It cannot say the bytes belonged to THIS document: `DocumentQuery.peek()`
 * carries `{state, sources}` in automerge-repo 2.6.0-alpha.2 and no byte
 * counter, so per-document progress cannot be written against this version.
 * The claim the witness DOES support is the one the decision needs: *the
 * server is alive and serving this client*, therefore giving up on its queue
 * is premature. That is why `MIN_PROGRESS_BYTES` exists below and why the
 * absolute wall is not optional.
 *
 * ── Two numbers, two jobs ────────────────────────────────────────────────────
 *  - `budgetMs`: the wall since the last progress. A silent server still
 *    fails in 24 s.
 *  - `BOOT_RESOLVE_MAX_MS`: the absolute wall from the request, whatever the
 *    transport claims. Without it, a peer that dribbles bytes forever is an
 *    unbounded wait on a boot path — the thing `handleRetry` exists to forbid.
 *
 * ── DO NOT make either adapt to what it measures ─────────────────────────────
 * Same prohibition, and for the same reason, as `waiverBudget.ts`: a bound
 * that tracks the quantity it bounds absorbs a degrading environment in
 * silence and destroys its own early warning. `hardCapped > 0` in
 * `progressTelemetry.ts` is the reading that says this file's default is not
 * big enough; it must be a person who moves it.
 */

/**
 * The FLOOR on one observation: bytes that must have arrived since the wall
 * last moved, before it may move again.
 *
 * A presence/heartbeat frame on this transport is ~100–650 bytes; sync payload
 * chunks during a boot are typically 250–525 kB. 8 kB sits well clear of both,
 * so a single stray frame can never move the wall and a real transfer can
 * never fail to.
 *
 * The floor is not sufficient ON ITS OWN — see MIN_PROGRESS_BYTES_PER_SECOND.
 * The comparison here is CUMULATIVE, not per-window, on purpose: a 3 s window
 * is too short to judge a server shared by several clients, which routinely
 * leaves one socket idle for several windows while it demonstrably works.
 */
export const MIN_PROGRESS_BYTES = 8 * 1024

/**
 * …and the RATE the same delivery has to represent, since the wall last moved.
 *
 * The absolute floor alone is not enough: the comparison is CUMULATIVE, so a
 * trickle of 500 B/s clears 8 kB every ~16 s and would hold a 24 s wall open
 * forever. A rate cannot be gamed that way: 8 kB/s is ~20× under the ~169 kB/s
 * an ordinary boot averages, and far above any keep-alive this transport
 * sends.
 *
 * Same prohibition as everything else in this file: it is a POLICY, never a
 * function of the rate it observes.
 */
export const MIN_PROGRESS_BYTES_PER_SECOND = 8 * 1024

/**
 * The absolute wall, from the request, for ONE boot-critical document — the
 * safety net under the stall budget, never the operative bound.
 *
 * 120 000 ms. The longest boot measured is ~67 s (a 6.7 MB workspace at
 * 180 kB/s, a poor mobile link); 120 000 is ~1.8× it. Past that the reading is
 * not "wait longer" but "this deployment cannot serve this workspace", and
 * `hardCapped` in the telemetry says so.
 */
export const BOOT_RESOLVE_MAX_DEFAULT_MS = 120_000

/** The most any override may buy. Ten minutes of hourglass is not a setting
 * anyone should be able to reach by editing a config file. */
export const BOOT_RESOLVE_MAX_LIMIT_MS = 600_000

const LS_KEY = 'maplespire:bootResolveMaxMs'
const ENV_KEY = 'VITE_BOOT_RESOLVE_MAX_MS'

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
 * The configured absolute wall, clamped and — when clamped or malformed — SAID
 * OUT LOUD, for the same reason `waiverBudget` says it: a setting silently
 * ignored is worse than no setting.
 */
export function resolveBootResolveMaxMs(): number {
  const override = readOverride()
  if (!override) return BOOT_RESOLVE_MAX_DEFAULT_MS
  const parsed = Number(override.raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[progressBudget] ${override.source}=${JSON.stringify(override.raw)} is not a positive number;`
      + ` using the default ${BOOT_RESOLVE_MAX_DEFAULT_MS}ms`,
    )
    return BOOT_RESOLVE_MAX_DEFAULT_MS
  }
  if (parsed > BOOT_RESOLVE_MAX_LIMIT_MS) {
    console.warn(
      `[progressBudget] ${override.source}=${parsed}ms exceeds the maximum ${BOOT_RESOLVE_MAX_LIMIT_MS}ms and`
      + ` was CLAMPED. This is the wall a boot hits while the server is still sending; if a real deployment`
      + ` needs longer than ${BOOT_RESOLVE_MAX_LIMIT_MS}ms to serve one workspace, that is a server finding,`
      + ` not a client setting.`,
    )
    return BOOT_RESOLVE_MAX_LIMIT_MS
  }
  return parsed
}

/**
 * Read ONCE at module init, like every other `import.meta.env` flag here
 * (they are read at Vite start). `BOOT_DOCUMENT_RESOLUTION` captures it at
 * import time.
 */
export const BOOT_RESOLVE_MAX_MS = resolveBootResolveMaxMs()

/** Set the runtime override and reload, mirroring `setBootWaiverMs`. */
export function setBootResolveMaxMs(ms: number | null): void {
  try {
    if (ms === null) localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, String(ms))
  } catch {
    /* ignore */
  }
  if (typeof location !== 'undefined') location.reload()
}
