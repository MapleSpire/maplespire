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

import { create } from 'zustand'
import type { RetiredExport } from '../lib/automerge/epochRetiredDiff'
import { removeRetiredExportLines } from '../lib/automerge/epochRetiredExportStore'

/**
 * The epoch hop's FACE (G4-16f): what the bridge's hop ports tell the
 * UI. `latched` is the bounded latch — the "Updating the model…" overlay is
 * up and input is blocked (`EpochHopOverlay`); `retired` is the
 * `epoch-retired` banner's export (`EpochRetiredBanner`).
 *
 * `inputBlocked()` is read SYNCHRONOUSLY by the overlay's capture-phase key
 * guard, so a keystroke in the same task as the block is refused.
 */
interface EpochHopStore {
  latched: boolean
  /** How many latches this session has held (an e2e probe: "one latch"). */
  latchCount: number
  /** The longest latch held this session, in ms (an e2e probe: "bounded"). */
  maxLatchMs: number
  latchedAt: number | null
  retired: RetiredExport | null
  /** The shown export was downloaded by the user: "×" no longer asks. Its
   * persisted copy stays until "×". */
  retiredExported: boolean
  setLatched(latched: boolean): void
  /** Show `exported` (the bridge persisted it first, merged:
   * `epochRetiredExportStore.ts`). */
  showRetired(exported: RetiredExport): void
  /** "Export" clicked: the banner stays, the persisted copy too. */
  markRetiredExported(): void
  /** "×" (confirmed when not exported): the banner and its lines in the
   * persisted copy go. */
  dismissRetired(): void
  reset(): void
}

export const useEpochHopStore = create<EpochHopStore>((set, get) => ({
  latched: false,
  latchCount: 0,
  maxLatchMs: 0,
  latchedAt: null,
  retired: null,
  retiredExported: false,
  setLatched: (latched) => set((s) => {
    if (latched === s.latched) return {}
    if (latched) return { latched, latchCount: s.latchCount + 1, latchedAt: Date.now() }
    const held = s.latchedAt === null ? 0 : Date.now() - s.latchedAt
    return { latched, latchedAt: null, maxLatchMs: Math.max(s.maxLatchMs, held) }
  }),
  showRetired: (retired) => set({ retired, retiredExported: false }),
  // "Export" clears NOTHING. A
  // download cannot say whether the file was saved (a cancelled "Save as",
  // a blocked download): the persisted copy stays until "×", which then no
  // longer asks. "×" removes only the lines this banner showed.
  markRetiredExported: () => set({ retiredExported: true }),
  dismissRetired: () => {
    const shown = get().retired
    set({ retired: null, retiredExported: false })
    if (shown) void removeRetiredExportLines(shown)
  },
  // The session ends (stopBridge): the persisted copy STAYS for the next boot.
  reset: () => set({ latched: false, latchedAt: null, retired: null, retiredExported: false }),
}))

export const inputBlocked = (): boolean => useEpochHopStore.getState().latched
