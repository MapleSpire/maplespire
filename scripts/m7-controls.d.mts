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
 * Types for `m7-controls.mjs`, which is plain ESM so `node --test` can pin it
 * under `test:ci-diagnostics` without tsx while `server/qa/m7-compaction-scale.mts`
 * imports the same definitions.
 *
 * A hand-written declaration can drift from its implementation, so note: the
 * parameters are deliberately `number | null | undefined` — the SAME width the
 * implementation guards, since
 * every predicate returns false for a non-finite input and a missing scale must
 * read as a failed control. Narrowing this to `number` would let the harness pass
 * a `null` the compiler had approved, which is the one drift that would matter.
 */
export declare function growsWithScale(
  smallest: number | null | undefined,
  largest: number | null | undefined,
): boolean

export declare function foldToEmptyRatioGrows(
  smallRatio: number | null | undefined,
  largeRatio: number | null | undefined,
): boolean

export declare function segmentsPartitionTheCall(
  detachedWindowMs: number | null | undefined,
  totalCallMs: number | null | undefined,
): boolean

export declare const RATIO_GROWTH_FACTOR: number
