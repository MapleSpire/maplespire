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
 * The cross-scale CONTROLS of the compaction-scale measurement
 * (`server/qa/m7-compaction-scale.mts`), as pure predicates.
 *
 * WHY THEY LIVE HERE AND NOT INSIDE THE HARNESS. The harness is deliberately
 * run by no gate — it is a long measurement, not a check — so nothing would
 * otherwise test that its controls can still fail. Each control is the sole
 * detector of one class of bogus result (e.g. a compactMs that DECREASES with
 * scale), and each could be disarmed invisibly.
 *
 * Plain `.mjs`, so `scripts/m7-controls.test.mjs` can pin it under
 * `test:ci-diagnostics` — which runs inside `ci:local` — without tsx. The harness
 * imports these same functions, so there is one definition and the gate guards
 * the thing that actually runs.
 */

/**
 * CONTROL 1 — `compactMs` must GROW between the smallest and the largest scale.
 * An instrument that returns the same number at 300 objects and at 200 000 is
 * measuring itself rather than the fold.
 *
 * `null` for either side means that scale produced no row (its child died), and
 * a missing measurement is a FAILED control, never a passed one — the harness
 * would otherwise skip a crashed scale and publish two figures under a header
 * promising three.
 */
export function growsWithScale(smallest, largest) {
  if (typeof smallest !== 'number' || typeof largest !== 'number') return false
  if (!Number.isFinite(smallest) || !Number.isFinite(largest)) return false
  return largest > smallest
}

/**
 * CONTROL 2 — the fold/empty-overlay RATIO must itself grow with scale.
 *
 * A fixed ratio threshold would have to be fitted to the observation it is
 * supposed to test. The hypothesis this control exists to exclude is "`compactMs` is a constant that does not depend
 * on the fold" — and against THAT hypothesis the ratio is flat whatever its
 * value, so growth in the ratio is the scale-free discriminator.
 *
 * The factor is 3 and it is a floor with room, not a fit. In the residency-on
 * variant the measured pair is of the order of 10 at 300 objects against of the
 * order of 100 at 12 000; in the warm-cache variant both ratios are far larger.
 * Orders of magnitude only: the denominator is a fraction of a millisecond, and
 * rounding alone moves either ratio by tens of percent, which is precisely why
 * the control is stated as growth rather than as a threshold.
 */
export const RATIO_GROWTH_FACTOR = 3

export function foldToEmptyRatioGrows(smallRatio, largeRatio) {
  if (typeof smallRatio !== 'number' || typeof largeRatio !== 'number') return false
  if (!Number.isFinite(smallRatio) || !Number.isFinite(largeRatio)) return false
  if (smallRatio <= 0) return false
  return largeRatio > RATIO_GROWTH_FACTOR * smallRatio
}

/**
 * The three timed segments must PARTITION the call they were measured inside.
 *
 * Catches e.g. a middle segment computed from `performance.now()` rather than
 * from the re-attach's start instant, which yields a detached window longer
 * than the whole call. One millisecond of slack for the arithmetic, not for a
 * second segment.
 */
export function segmentsPartitionTheCall(detachedWindowMs, totalCallMs) {
  if (typeof detachedWindowMs !== 'number' || typeof totalCallMs !== 'number') return false
  if (!Number.isFinite(detachedWindowMs) || !Number.isFinite(totalCallMs)) return false
  return detachedWindowMs <= totalCallMs + 1
}
