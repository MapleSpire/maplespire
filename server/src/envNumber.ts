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

// The one bounded parse for a numeric environment knob.
//
// Why it is needed (Node 22):
//
//   Number('')                          -> 0        (a dangling `VAR=`)
//   Number('abc')                       -> NaN
//   AbortSignal.timeout(0)              -> aborts on the next tick
//   AbortSignal.timeout(NaN)            -> throws RangeError SYNCHRONOUSLY
//   setInterval(fn, NaN)                -> does NOT throw; fires as fast as 0
//   Math.max(10_000, NaN)               -> NaN
//
// The last line matters most: `Math.max(FLOOR, Number(process.env.X ?? DEFAULT))`
// looks like a floor but PROPAGATES NaN rather than guarding against it.
//
// Concretely: a dangling `DOC_SCOPE_FIND_TIMEOUT_MS=` in a compose file or
// `server/.env` makes every
// `find()` in `walkFrom` abort immediately, `controlDocsComplete` stays false,
// **no control-document listener is ever attached**, and every document not
// already in `automerge_document_workspace` is quarantined for the life of the
// process — silently. A blank `AM_DENY_RECONCILE_MS=` gives `setInterval(…, 0)`
// and a global `shareConfigChanged()` fan-out four times a second.
//
// Why the obvious guard is wrong: garbage falls
// back safely under `Number.isFinite(value) && value >= 0` while a BLANK does
// not, because `Number('') === 0` and 0 is finite. So the failure mode is not
// "someone typed nonsense" — it is "someone left the key with no value", which
// is what a commented-out compose line and a stripped `.env` both produce.
//
// One shared parse rather than per-file copies: a config-level problem needs a
// config-level remedy. The `local/no-bare-env-number` ESLint rule
// (`scripts/env-knobs.mjs`) makes a NEW bare site fail `npm run lint`; declared
// exceptions live in `scripts/env-knob-declarations.mjs`, and
// `eslint.config.js` is the authority on what the rule follows.

/** Bounds for one knob. `minimum` is a REJECTION floor and `maximum` is a
 * CLAMP ceiling — deliberately asymmetric.
 *
 * A value under the floor is the catastrophic direction (a zero deadline aborts
 * every operation, a zero interval spins), so it is refused and the default
 * stands. A value over the ceiling is clamped and the process still runs.
 *
 * `envNumber` logs every rejected or clamped value (`env.knob_rejected`) so a
 * typo such as `GC_MINIMUM_AGE_MS=1h` is visible at boot. It does not throw:
 * refusing to boot over a bad knob is a per-knob decision, not this module's. */
export interface EnvNumberBounds {
  /** Used when the variable is unset, blank, unparseable, or below `minimum`. */
  fallback: number
  /** Rejection floor. Almost always ≥ 1: `0` is the value a dangling `VAR=`
   * produces, and for every knob in this codebase 0 means "disabled". */
  minimum: number
  /** Clamp ceiling. */
  maximum: number
  /** Require a safe integer as well as a finite number. Counts and sizes want
   * this; millisecond durations do not care. */
  integer?: boolean
}

/**
 * Parse one numeric environment value, or fall back.
 *
 * Falls back — never throws, never returns NaN, never returns a value below
 * `minimum` — for: `undefined`, a blank or whitespace-only string, anything
 * `Number` cannot turn into a finite number, and anything under the floor.
 */
export function boundedEnvNumber(
  raw: string | undefined,
  bounds: EnvNumberBounds,
  /** Called when a value was SUPPLIED and was not used AS GIVEN. Never called
   * for an unset variable — that is the ordinary case and warning about it would
   * make the diagnostic noise, which is how a warning stops being read.
   *
   * `above-maximum` is in this list because the ceiling CLAMPS rather than
   * falling back, so without it the one path that silently rewrites a
   * deliberate number would be the one path with no diagnostic. It matters:
   * for a rate-limit INTERVAL
   * (`AM_DENY_RECONCILE_MS`, `DOC_SCOPE_REPAIR_MIN_INTERVAL_MS`) clamping down
   * *increases* the fan-out the knob exists to suppress, and for a DEADLINE it
   * makes the operation give up sooner. */
  onRejected?: (reason: 'blank' | 'unparseable' | 'below-minimum' | 'above-maximum') => void,
): number {
  if (raw === undefined) return bounds.fallback
  // A blank is UNSET, not zero. This line is the whole point of the module — and
  // it IS a supplied value, so unlike a truly unset variable it is reported.
  if (raw.trim() === '') {
    onRejected?.('blank')
    return bounds.fallback
  }
  const value = Number(raw)
  const wellFormed = bounds.integer === true ? Number.isSafeInteger(value) : Number.isFinite(value)
  if (!wellFormed) {
    onRejected?.('unparseable')
    return bounds.fallback
  }
  if (value < bounds.minimum) {
    onRejected?.('below-minimum')
    return bounds.fallback
  }
  if (value > bounds.maximum) {
    onRejected?.('above-maximum')
    return bounds.maximum
  }
  return value
}

/** The same parse, reading `process.env` by name.
 *
 * `env` is injectable so a test drives it without mutating the process — which
 * matters more than it looks: these knobs are read at MODULE LOAD in every
 * consumer, so a test that sets `process.env` after the import measures
 * nothing. */
export function envNumber(
  name: string,
  bounds: EnvNumberBounds,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return boundedEnvNumber(env[name], bounds, (reason) => {
    // ONE line, on the path where somebody set something that did not take. The
    // knobs here are read at module load, so this lands during boot beside the
    // other startup diagnostics — which is the only place it is any use.
    //
    // `JSON.stringify` to match `automergeServer.ts` / `automergeResidency.ts`,
    // and the RAW VALUE is included because "blank" and "1h" are different
    // mistakes and the operator cannot tell which one they made from the
    // fallback alone.
    console.warn(JSON.stringify({
      event: 'env.knob_rejected',
      knob: name,
      reason,
      supplied: env[name],
      // The ceiling CLAMPS and everything else FALLS BACK, so the value in force
      // differs by reason. Printing `fallback` unconditionally would report a
      // number the process is not using.
      using: reason === 'above-maximum' ? bounds.maximum : bounds.fallback,
      bounds: { minimum: bounds.minimum, maximum: bounds.maximum, integer: bounds.integer === true },
    }))
  })
}
