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
 * Where the cold build's row writes spend their time (G4-16f C7): wall
 * milliseconds by phase, accumulated, logged as `rowWritesBreakdown` of
 * `read_model.cold_build_phases`. Observability only — no behaviour reads it,
 * and a phase that throws is still counted up to the throw.
 */
export type RowWriteTimings = Record<string, number>

/** Run `work`, adding its wall time to `timings[phase]` (nothing when no
 * sink is given). */
export async function timedPhase<T>(
  timings: RowWriteTimings | undefined,
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!timings) return work()
  const startedAt = performance.now()
  try {
    return await work()
  } finally {
    timings[phase] = (timings[phase] ?? 0) + (performance.now() - startedAt)
  }
}

/** The breakdown as logged: rounded to 0.1 ms, phases in insertion order. */
export function roundedRowWriteTimings(timings: RowWriteTimings): RowWriteTimings {
  return Object.fromEntries(Object.entries(timings).map(([phase, ms]) => [phase, Math.round(ms * 10) / 10]))
}
