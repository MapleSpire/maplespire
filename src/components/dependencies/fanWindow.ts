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
 * The dependency fan as a WINDOW onto the peer list rather than the list itself.
 *
 * The fan cannot scroll — its cards are absolutely positioned around a centre
 * point — so it makes the same bargain `VirtualList` makes for a scrolling list,
 * by other means: it draws a fixed number of cards whatever the total, and the
 * wheel moves which slice of the peers those cards show. A focus object with two
 * thousand dependencies costs the DOM the same six cards as one with seven.
 *
 * The arithmetic lives here, apart from the component, because the component
 * can only be exercised by mounting the whole page. What
 * matters about a window is its edges — the clamp at zero, the clamp at the end,
 * and the point at which it has to ask for another page — and each of those is
 * one call here.
 */

/** Cards drawn per side. Extra peers collapse into a "+N more" slot that opens
 * the full virtualized list. Keeps the fan legible, like the kit. */
export const CAP_PER_SIDE = 6

export interface FanWindow<T> {
  /** Exactly what the fan renders: at most `CAP_PER_SIDE` cards. */
  cards: T[]
  /** Peers past the window's end, for the "+N more" slot. */
  more: number
  /** Cards plus the "+N more" slot, if there is one — the fan's row count. */
  slots: number
  /** Index of the first card, after clamping. */
  start: number
}

/**
 * The slice of `peers` the fan shows at `offset`.
 *
 * `totalPeers` is the seam's count for the whole filtered set, which is normally
 * larger than `peers.length` — only the pages scrolled to are loaded. So `more`
 * counts against the total, not against what happens to be in memory: the slot
 * has to say "+1994 more", not "+0 more" because the first page ran out.
 *
 * The offset is clamped the same way `nextFanOffset` clamps it, so a filter that
 * shrinks the set under a window the user had scrolled out to falls back to a
 * FULL window at the end rather than to the one last card that clamping to
 * `totalPeers - 1` would leave stranded mid-band.
 */
export function fanWindow<T>(peers: readonly T[], totalPeers: number, offset: number): FanWindow<T> {
  const start = Math.min(Math.max(0, offset), Math.max(0, totalPeers - CAP_PER_SIDE))
  const cards = peers.slice(start, start + CAP_PER_SIDE)
  const more = Math.max(0, totalPeers - start - cards.length)
  return { cards, more, slots: cards.length + (more > 0 ? 1 : 0), start }
}

/**
 * Where one wheel notch moves the window.
 *
 * Clamped so the last window sits flush with the end rather than scrolling into
 * empty space: past `totalPeers - CAP_PER_SIDE` there is nothing left to reveal,
 * and a window that kept going would show a shrinking handful of cards drifting
 * off the bottom of the band.
 */
export function nextFanOffset(offset: number, step: number, totalPeers: number): number {
  return Math.min(Math.max(0, totalPeers - CAP_PER_SIDE), Math.max(0, offset + step))
}

/**
 * Whether moving to `offset` should pull the next page.
 *
 * Fires when the window would reach the end of what is LOADED — not the end of
 * what exists — so the fetch overlaps the scrolling instead of following it. The
 * caller's `useCursorRows` drops the call while a fetch is in flight, so a fast
 * scroll asks once rather than once per notch.
 */
export function shouldLoadMore(offset: number, loadedCount: number, hasMore: boolean): boolean {
  return hasMore && offset + CAP_PER_SIDE >= loadedCount
}
