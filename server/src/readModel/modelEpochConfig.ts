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
 * ModelMeta and base-shard EPOCHS (G4-16f) — the CONFIG.
 *
 * An epoch is a fresh ModelMeta (and, for a full epoch, fresh base shards)
 * built from the previous generation's state at recorded cut heads, with no
 * history. This module only parses the three knobs; nothing here rolls an
 * epoch.
 *
 * THE RETENTION FLOOR IS REFUSED, NOT CLAMPED. N is configurable
 * with a floor of 3 (never 0, 1 or 2). `envNumber` clamps and logs
 * (`envNumber.ts`), which would turn an operator's `1` into `3` silently —
 * the operator would believe one previous epoch is kept while three are. So
 * any value that is not a plain decimal integer ≥ 3 THROWS at boot, a dangling
 * `AM_MODEL_EPOCH_RETAIN=` included: `Number('')` is 0 (the trap named at
 * `gc.ts`, `configuredMinimumAgeMs`), and a blank is a value somebody wrote, not an
 * absence. Only a variable that is truly UNSET takes the default.
 *
 * `AM_MODEL_EPOCHS` is `off` (default) or `on`; missing and blank are `off`
 * (the same as every other off-by-default flag of the read model). `off`
 * means no roll runs. It does NOT mean that existing epoch rows are ignored:
 * forwarding and GC marking of rows a previous `on` created keep running
 * under every mode (the rule `ordinaryHeadForwarding.ts` applies to its own
 * rows), so this config's `enabled` must gate ROLLING only.
 */
export const MODEL_EPOCHS_FLAG = 'AM_MODEL_EPOCHS'
export const MODEL_EPOCH_RETAIN_ENV = 'AM_MODEL_EPOCH_RETAIN'
export const MODEL_EPOCH_PERIOD_DAYS_ENV = 'AM_MODEL_EPOCH_PERIOD_DAYS'

/** The retention floor: never 0, 1 or 2 previous epochs. */
export const MODEL_EPOCH_RETAIN_FLOOR = 3
export const DEFAULT_MODEL_EPOCH_RETAIN = 3
export const DEFAULT_MODEL_EPOCH_PERIOD_DAYS = 30
/** Upper bounds: refused above, not clamped. A retention of 1 000 epochs or a
 * period of 100 years is a typo, and both are far outside anything measured. */
export const MAX_MODEL_EPOCH_RETAIN = 120
export const MAX_MODEL_EPOCH_PERIOD_DAYS = 3_650

export interface ModelEpochConfig {
  /** Whether rolls run. Forwarding and GC marking do not depend on it. */
  readonly enabled: boolean
  /** Previous epochs kept readable (≥ {@link MODEL_EPOCH_RETAIN_FLOOR}). */
  readonly retain: number
  /** Minimum age of the current epoch before the next roll, in days. */
  readonly periodDays: number
}

export class ModelEpochConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelEpochConfigError'
  }
}

const DECIMAL_INTEGER = /^[0-9]+$/

/**
 * A decimal integer in `[minimum, maximum]`, or the fallback when the
 * variable is UNSET. Anything else throws: a blank, surrounding spaces, a
 * sign, an exponent, a fraction, a hex literal, a value out of range.
 */
function strictInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
  rule: string,
): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (!DECIMAL_INTEGER.test(raw)) {
    throw new ModelEpochConfigError(`${name}=${JSON.stringify(raw)} is not a decimal integer (${rule})`)
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ModelEpochConfigError(`${name}=${raw} is outside [${minimum}, ${maximum}] (${rule})`)
  }
  return value
}

/** Parse the three knobs. Throws {@link ModelEpochConfigError} on any value
 * the module header refuses; the caller lets it stop the boot. */
export function modelEpochConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelEpochConfig {
  const flag = env[MODEL_EPOCHS_FLAG]?.trim()
  if (flag !== undefined && flag !== '' && flag !== 'off' && flag !== 'on') {
    throw new ModelEpochConfigError(`${MODEL_EPOCHS_FLAG}=${JSON.stringify(flag)} is neither off nor on`)
  }
  // Both numbers are parsed whatever the flag, so a bad value is refused the
  // day it is written, not the day somebody turns epochs on.
  const retain = strictInteger(env, MODEL_EPOCH_RETAIN_ENV, MODEL_EPOCH_RETAIN_FLOOR, MAX_MODEL_EPOCH_RETAIN,
    DEFAULT_MODEL_EPOCH_RETAIN, `at least ${MODEL_EPOCH_RETAIN_FLOOR} previous epochs stay readable, never 0, 1 or 2`)
  const periodDays = strictInteger(env, MODEL_EPOCH_PERIOD_DAYS_ENV, 1, MAX_MODEL_EPOCH_PERIOD_DAYS,
    DEFAULT_MODEL_EPOCH_PERIOD_DAYS, 'days between two epochs')
  return { enabled: flag === 'on', retain, periodDays }
}
