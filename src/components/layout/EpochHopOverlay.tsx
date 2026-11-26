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

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { inputBlocked, useEpochHopStore } from '../../stores/epochHopStore'

/** Events refused while the latch is held. Pointer input never reaches the
 * app because `#root` is `inert`; KEYS still would — a shortcut bound on
 * `window` (Delete, Ctrl+Z, paste) fires with focus on `<body>` — so they
 * are refused in the capture phase, before any app listener. */
const BLOCKED_EVENTS = ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste', 'cut', 'drop', 'compositionstart'] as const

function refuse(event: Event): void {
  if (!inputBlocked()) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

/**
 * Apply the latch to the page SYNCHRONOUSLY with the store (not after a React
 * commit, so no keystroke slips between the block and the guard): `#root`
 * inert, the key guard on `window` — installed only while latched (nothing
 * is listening when epochs are off) — and, when it lifts, the focus given
 * back to where it was.
 */
function applyLatch(latched: boolean, state: { focus: HTMLElement | null; guarded: boolean }): void {
  const root = document.getElementById('root')
  if (latched && !state.guarded) {
    const active = document.activeElement
    state.focus = active instanceof HTMLElement && active !== document.body ? active : null
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, refuse, { capture: true })
    state.guarded = true
    root?.setAttribute('inert', '')
  } else if (!latched && state.guarded) {
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, refuse, { capture: true })
    state.guarded = false
    root?.removeAttribute('inert')
    const focus = state.focus
    state.focus = null
    if (focus?.isConnected) focus.focus({ preventScroll: true })
  }
}

/**
 * THE LATCH'S FACE (G4-16f, the hop's swap step): while the epoch hop holds its
 * bounded latch (at most 2 s plus the swap), the app is read-only — a
 * "Updating the model…" veil over the canvas and the model pages, the app
 * root `inert` (no pointer, no focus), every key refused. No edit is made
 * during the latch, so none has to be replayed after the swap's `projectAll`.
 *
 * Rendered in a portal on `<body>`, OUTSIDE `#root`. The live region is
 * ALWAYS in the page (an `aria-live` region added with its text is not
 * announced) and only its text changes; the veil itself is `aria-busy`, not
 * a dialog — it has nothing to focus. Flag off the region is
 * not in the page at all (it appears with the first latch).
 */
/** How long the live region exists, empty, before the latch is announced. */
export const LIVE_REGION_SETTLE_MS = 150

export function EpochHopOverlay() {
  const { t } = useTranslation()
  const latched = useEpochHopStore((s) => s.latched)

  useEffect(() => {
    const state = { focus: null as HTMLElement | null, guarded: false }
    applyLatch(useEpochHopStore.getState().latched, state)
    const unsubscribe = useEpochHopStore.subscribe((s) => applyLatch(s.latched, state))
    return () => {
      unsubscribe()
      applyLatch(false, state)
    }
  }, [])

  // Flag off, no hop ever latches: the region is never mounted (nothing in
  // the page). It is mounted EMPTY at the first latch and its text set
  // LIVE_REGION_SETTLE_MS later, so the text CHANGES inside a live region that
  // already exists (a region added with its text is not announced), then it
  // stays. Not 0 ms: some screen readers
  // register a new region only a few hundred ms after it is created, and a
  // latch lasts up to 2 s.
  const armed = useEpochHopStore((s) => s.latchCount > 0)
  const [announced, setAnnounced] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(latched), latched ? LIVE_REGION_SETTLE_MS : 0)
    return () => clearTimeout(timer)
  }, [latched])

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      {armed && (
        <div data-testid="epoch-hop-live" role="status" aria-live="polite" className="sr-only">
          {latched && announced ? t('epochs.hop.updating') : ''}
        </div>
      )}
      {latched && (
        <div
          data-testid="epoch-hop-overlay"
          aria-busy="true"
          aria-hidden="true"
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30"
        >
          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-100 px-4 py-3 text-[13px] font-medium text-fg shadow-lg">
            <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden="true" />
            <span>{t('epochs.hop.updating')}</span>
          </div>
        </div>
      )}
    </>,
    document.body,
  )
}
