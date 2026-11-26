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

import { useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEpochHopStore } from '../../stores/epochHopStore'
import { useAuthStore } from '../../stores/authStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { CURRENT_VERSION_ID } from '../../lib/automerge/workspace'
import { retiredExportText } from '../../lib/automerge/epochRetiredDiff'
import { cn } from '../../lib/utils'

/** The banner card's bottom edge (px), while it is up: the overrides drawer
 * starts below it (`EpochOverridesPanel`). */
export const RETIRED_BANNER_BOTTOM_VAR = '--epoch-retired-bottom'

/**
 * THE `epoch-retired` BANNER (G4-16f). The epoch this tab held
 * was past retention when it hopped, so what the tab wrote there and the
 * server had not forwarded is not in the model. The hop collected those
 * entities before it swapped; this offers them as a JSON export. Same shape
 * as the other banners it sits below them when they are up, but it is a
 * floating card with no in-flow spacer: the page is not shifted.
 */
export function EpochRetiredBanner() {
  const { t } = useTranslation()
  const retired = useEpochHopStore((s) => s.retired)
  const exported = useEpochHopStore((s) => s.retiredExported)
  const dismiss = useEpochHopStore((s) => s.dismissRetired)
  const markExported = useEpochHopStore((s) => s.markRetiredExported)
  const impersonating = useAuthStore((s) => !!s.impersonation)
  const contractStale = useAutomergeStatus((s) => s.workspaceContractStale)
  // The repoint banner's own visibility rule (WorkspaceRepointBanner), so
  // the two strips stack instead of overlapping.
  const repointShown = useAutomergeStatus((s) => s.workspaceRepointNotice)
  const ref = useWorkspaceStore((s) => s.ref)
  // "×" before "Export" lets the
  // only copy of these edits go (the export is persisted until then), so it
  // asks first, inline.
  const [confirming, setConfirming] = useState(false)
  // The question belongs to one export: another one shown drops it (state
  // adjusted while rendering, not in an effect).
  const [askedFor, setAskedFor] = useState(retired)
  if (askedFor !== retired) {
    setAskedFor(retired)
    setConfirming(false)
  }
  const repoint = !!repointShown && ref.landscapeId === repointShown.landscapeId && ref.versionId === CURRENT_VERSION_ID
  const offset = (impersonating ? 1 : 0) + (contractStale ? 1 : 0) + (repoint ? 1 : 0)
  // The card's bottom edge, published for the overrides drawer, which starts
  // below it (its text wraps on a narrow canvas: 2 lines at 1280×720).
  const cardRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const root = document.documentElement
    const publish = () => root.style.setProperty(RETIRED_BANNER_BOTTOM_VAR, `${Math.ceil(card.getBoundingClientRect().bottom)}px`)
    publish()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish)
    observer?.observe(card)
    window.addEventListener('resize', publish)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', publish)
      root.style.removeProperty(RETIRED_BANNER_BOTTOM_VAR)
    }
    // `offset` and `confirming` too: a strip above
    // appearing moves the card by 2.25 rem without resizing it, which
    // neither the observer nor `resize` sees.
  }, [retired, offset, confirming])
  if (!retired) return null
  const count = retired.differences.length
  const exportFile = () => {
    const blob = new Blob([retiredExportText(retired)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `maplespire-unsynced-edits-${retired.collectedAt.replace(/[:.]/g, '-')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    markExported()
  }
  const onDismiss = () => {
    if (exported || count === 0) dismiss()
    else setConfirming(true)
  }
  return (
    <>
      <div
        ref={cardRef}
        data-testid="epoch-retired-banner"
        role="status"
        aria-live="polite"
        // A floating card under the toolbar, not a strip: it takes no room in
        // the page (no spacer, nothing shifts) and covers no control. Centered
        // over the CANVAS, between the two 312 px floating columns (14 px
        // from the edges, 14 px gutter): at 1280×720 a card centered on the
        // window covered the list's "Flows" tab and the inspector's
        // "Properties" tab. Its text wraps rather than truncates.
        className={cn(
          'fixed inset-x-4 z-[9997] mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning-border bg-warning-bg px-4 py-2 text-warning-text shadow-lg lg:inset-x-[340px] lg:max-w-[calc(100vw-680px)]',
          offset === 0 ? 'top-[4.75rem]' : offset === 1 ? 'top-[7rem]' : offset === 2 ? 'top-[9.25rem]' : 'top-[11.5rem]',
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {/* At least ~13 rem of text: on a narrow canvas (1024) the buttons
            wrap below it instead of squeezing it to a 100 px column. */}
        <span className="min-w-[13rem] flex-1 text-[12.5px] font-medium">
          {confirming ? t('epochs.retired.confirmDismiss', { count }) : t('epochs.retired.message', { count })}
        </span>
        {confirming ? (
          <>
            <button
              data-testid="epoch-retired-dismiss-keep"
              autoFocus
              onClick={() => setConfirming(false)}
              className="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-warning-text/30 bg-warning-text/10 px-2.5 py-1 text-[11.5px] font-semibold text-warning-text transition-colors hover:bg-warning-text/20"
            >
              {t('epochs.retired.keep')}
            </button>
            <button
              data-testid="epoch-retired-dismiss-confirm"
              onClick={dismiss}
              className="inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-warning-text underline-offset-2 transition-colors hover:bg-warning-text/20 hover:underline"
            >
              {t('epochs.retired.confirmDiscard')}
            </button>
          </>
        ) : (
          <>
            <button
              data-testid="epoch-retired-export"
              onClick={exportFile}
              disabled={count === 0}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-warning-text/30 bg-warning-text/10 px-2.5 py-1 text-[11.5px] font-semibold text-warning-text transition-colors hover:bg-warning-text/20 disabled:opacity-50"
            >
              <Download className="h-3 w-3" aria-hidden="true" />
              {t('epochs.retired.export')}
            </button>
            <button
              data-testid="epoch-retired-dismiss"
              onClick={onDismiss}
              aria-label={t('epochs.retired.dismiss')}
              className="rounded-md p-1 text-warning-text transition-colors hover:bg-warning-text/20"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </>
  )
}
