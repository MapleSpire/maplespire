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
 * Turn a LIVE Automerge list into `target` IN PLACE. ONE greedy forward pass:
 * each element of `list` that equals the next not-yet-matched element of
 * `target` is kept where it is, so what is kept is a subsequence of `list`
 * equal to a PREFIX of `target`; everything else in `list` is spliced out
 * (from the end, so the kept indices do not move), and the rest of `target`
 * is pushed.
 *
 * NOT a longest-common-subsequence: a target that reorders the list (an
 * element moved earlier) can cost more deletions and pushes than an LCS
 * would. CORRECTNESS DOES NOT DEPEND ON THAT OPTIMALITY — the result always
 * equals `target` (kept prefix + pushed rest); only the operation count does,
 * and the callers' usual case (target = list + an append, or list minus some
 * elements) is already minimal.
 *
 * WHY (G4-16f, the aged bench): assigning a fresh array to a ModelMeta field
 * (`meta.x = [...]`) re-creates EVERY element in the document's history — and
 * each string element of the list is itself a text object, one operation per
 * character. Done once per rotation on a list that grows by one per rotation,
 * that is quadratic history: 7.7 M operations in ModelMeta at three years for
 * 4 007 changes (~1 900 ops per change), ~120 bytes of wasm per operation
 * after every cold attach. In place, the usual call (target = list + one url)
 * costs one push.
 *
 * Also what keeps a CONCURRENT writer's edit: a push by another writer into
 * the same list survives the merge (a replaced list drops it; the fold
 * writer's header says the same of `objectShardUrls`).
 *
 * Synchronous; call it inside the document's `change`. Elements compared with
 * `===` (strings here).
 */
export function rewriteListInPlace<T>(list: T[], target: readonly T[]): void {
  let next = 0
  const drop: number[] = []
  for (let index = 0; index < list.length; index += 1) {
    if (next < target.length && list[index] === target[next]) next += 1
    else drop.push(index)
  }
  for (let at = drop.length - 1; at >= 0; at -= 1) list.splice(drop[at]!, 1)
  for (; next < target.length; next += 1) list.push(target[next]!)
}
