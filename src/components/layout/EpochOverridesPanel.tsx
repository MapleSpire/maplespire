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

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, History, Loader2, LocateFixed, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEpochOverridesStore } from '../../stores/epochOverridesStore'
import { useEpochHopStore } from '../../stores/epochHopStore'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { groupByEntity, overrideTarget, type OverrideRow, type RowStatus } from '../../lib/automerge/epochOverrides'
import {
  closeReview, dismissAll, entityLabel, entityName, expandReview, openDiagramForReapply, openReview, reapplyChecked, recomputeStatuses,
  setAllChecked, setRowChecked, showInDiagram, undoDiscard,
} from '../../lib/automerge/epochOverridesController'
import { cn } from '../../lib/utils'
import { displayValue, fieldLabel, fullValue, relativeTime } from './epochOverrideValue'
import { RETIRED_BANNER_BOTTOM_VAR } from './EpochRetiredBanner'
import { narrowEditor } from './epochOverrideLayout'

/** How long "Discard my edits" can be undone from its toast. */
const DISCARD_UNDO_MS = 10_000

/**
 * WHERE THE REVIEW SITS. The editor floats two 312 px rounded columns 14 px
 * from the edges — the object list and the
 * inspector (with Share) — over one base plane, plus the tool pill at the top
 * and, at the bottom, the perspective bar and the zoom cluster (docked 338 px
 * from the right, against the inspector). The review is a DRAWER of the
 * inspector's column: the same width, radius and 14 px gutter, docked against
 * the inspector on the canvas side, between the tool pill's row and the zoom
 * cluster's. It takes canvas only: the list, the inspector (where the
 * Now/Yours markers show while reviewing), Share, the status/perspective bar
 * and the zoom stay uncovered at 1440×900 and 1280×720 (measured, 0 %).
 * Replacing the inspector in its column (the AI panel's way on the left)
 * would hide the inspector and Share — the two things the review must keep visible.
 * With the inspector closed, the drawer takes its column. The notice, the
 * pill and the Discard toast use the same slot's bottom corner, above the
 * zoom cluster. Under `lg` the columns no longer leave a canvas between
 * them: the drawer falls back to the right edge.
 */
const DRAWER_RIGHT = { beside: 'right-3.5 lg:right-[340px]', alone: 'right-3.5' } as const

/** The window's width, followed only while `active` (nothing listens flag off). */
function useViewportWidth(active: boolean): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    const update = () => setWidth(window.innerWidth)
    update()
    window.addEventListener('resize', update, { passive: true })
    return () => window.removeEventListener('resize', update)
  }, [active])
  return width
}

function rowField(row: OverrideRow): string {
  const target = overrideTarget(row)
  return !target || target.field.length === 0 ? '*' : target.field.map(String).join('.')
}

function StatusNote({ status, row }: { status: RowStatus | undefined; row: OverrideRow }) {
  const { t } = useTranslation()
  if (!status) return null
  if (status.kind === 'changed-since') {
    return <span data-testid={`override-changed-${row.id}`} className="block text-[11px] font-medium text-warning-text">{t('epochs.overrides.changedSince', { value: displayValue(status.now) })}</span>
  }
  if (status.kind === 'endpoint-deleted') return <span className="block text-[11px] font-medium text-error-text">{t('epochs.overrides.endpointDeleted')}</span>
  if (status.kind === 'needs') {
    return <span className="block text-[11px] text-fg-muted">{t('epochs.overrides.needs', { object: status.entityIds.map(entityName).join(', ') })}</span>
  }
  if (status.kind === 'unsupported') return <span className="block text-[11px] text-fg-muted">{t('epochs.overrides.unsupported')}</span>
  return null
}

/**
 * THE OVERRIDDEN-EDITS NOTICE AND REVIEW PANEL (G4-16f).
 *
 * The notice is non-modal: "N of your offline edits were overridden by newer
 * changes", with Review; collapsed, it stays reachable as a pill until every
 * row is resolved. The panel lists the rows GROUPED BY ENTITY, every row
 * checked by default and each uncheckable; "Show in diagram" opens the live
 * model (the other user's changes included), folds the panel into a strip so
 * the diagram stays visible, and turns the highlight layer on; Re-apply
 * writes the checked rows as one undoable edit.
 *
 * Keyboard: Review moves focus into the panel, Escape closes it and gives
 * focus back to the pill.
 */
export function EpochOverridesPanel() {
  const { t, i18n } = useTranslation()
  const rows = useEpochOverridesStore((s) => s.rows)
  const checked = useEpochOverridesStore((s) => s.checked)
  const statuses = useEpochOverridesStore((s) => s.statuses)
  const pulled = useEpochOverridesStore((s) => s.pulled)
  const panelOpen = useEpochOverridesStore((s) => s.panelOpen)
  const compact = useEpochOverridesStore((s) => s.compact)
  const collapsed = useEpochOverridesStore((s) => s.noticeCollapsed)
  const busy = useEpochOverridesStore((s) => s.busy)
  const error = useEpochOverridesStore((s) => s.error)
  const refusal = useEpochOverridesStore((s) => s.refusal)
  const lastDiscard = useEpochOverridesStore((s) => s.lastDiscard)
  const readOnly = useModelStore((s) => s.workspaceReadOnly)
  const objects = useModelStore((s) => s.objects)
  const connections = useModelStore((s) => s.connections)
  const modelGroups = useModelStore((s) => s.groups)
  const groups = useMemo(() => groupByEntity(rows), [rows])
  const besideInspector = useUIStore((s) => s.rightSidebarOpen)
  const listOpen = useUIStore((s) => s.leftSidebarOpen)
  const viewMode = useUIStore((s) => s.canvasViewMode)
  const retiredBannerUp = useEpochHopStore((s) => s.retired !== null)
  const viewportWidth = useViewportWidth(rows.length > 0 || lastDiscard !== null)
  const narrow = narrowEditor(viewportWidth, listOpen, besideInspector, viewMode)
  const right = narrow ? DRAWER_RIGHT.alone : besideInspector ? DRAWER_RIGHT.beside : DRAWER_RIGHT.alone
  // Narrow: the top of the canvas, under the tool pill or below the retired
  // banner (its measured edge), docked against the inspector.
  const topSlot = retiredBannerUp ? { top: `calc(var(${RETIRED_BANNER_BOTTOM_VAR}, 7.25rem) + 0.875rem)` } : undefined
  const corner = narrow
    // Left edge at 404 px at most: clear of the canvas's vertical tool rail
    // (340 + 48 + 16), which starts under the top stack.
    ? cn('right-[340px] max-w-[calc(100vw-744px)]', !retiredBannerUp && 'top-[4.75rem]')
    : cn('bottom-[4.75rem]', right)
  const panelRef = useRef<HTMLElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const dismissRef = useRef<HTMLButtonElement>(null)
  const returnFocusToPill = useRef(false)
  // "Keep them" unmounts the question and its focused button: the focus goes
  // back to "Discard my edits", enabled again, not to <body>.
  const returnFocusToDismiss = useRef(false)
  // "Discard my edits" asks first, inline (no browser dialog: a blocked or
  // auto-dismissed `window.confirm` would swallow the question silently).
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  // The question belongs to one open/compact state of the panel: closing,
  // folding or reopening drops it (state adjusted while rendering, not in an effect).
  const viewKey = `${panelOpen}-${compact}`
  const [lastViewKey, setLastViewKey] = useState(viewKey)
  if (lastViewKey !== viewKey) {
    setLastViewKey(viewKey)
    setConfirmingDiscard(false)
  }

  // The replica moves under the panel (another user's edit lands): the
  // "changed since" marks follow it while the panel is open.
  useEffect(() => { if (panelOpen) recomputeStatuses() }, [panelOpen, objects, connections, modelGroups])

  // Into the panel when it opens; back to the pill when Escape closed it.
  useEffect(() => {
    if (panelOpen && !compact) panelRef.current?.focus()
    if (!panelOpen && returnFocusToPill.current) {
      returnFocusToPill.current = false
      pillRef.current?.focus()
    }
  }, [panelOpen, compact])

  useEffect(() => {
    if (confirmingDiscard || !returnFocusToDismiss.current) return
    returnFocusToDismiss.current = false
    dismissRef.current?.focus()
  }, [confirmingDiscard])

  // Escape closes the full panel only: on the compact strip the
  // diagram has the keyboard, and Escape is its own (deselect, cancel).
  useEffect(() => {
    if (!panelOpen || compact) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      returnFocusToPill.current = true
      closeReview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, compact])

  // The Discard toast and its Undo go after a while.
  useEffect(() => {
    if (!lastDiscard) return
    const timer = setTimeout(() => {
      if (useEpochOverridesStore.getState().lastDiscard === lastDiscard) useEpochOverridesStore.setState({ lastDiscard: null })
    }, DISCARD_UNDO_MS)
    return () => clearTimeout(timer)
  }, [lastDiscard])

  const discardToast = lastDiscard ? (
    <div data-testid="epoch-overrides-discard-toast" className={cn('fixed z-[9990] flex items-center gap-3 rounded-lg border border-line bg-surface-100 px-3 py-2 shadow-lg', corner)}
      style={narrow ? topSlot : undefined}>
      <span role="status" className="text-[12.5px] text-fg">{t('epochs.overrides.discarded')}</span>
      <button data-testid="epoch-overrides-undo-discard" onClick={() => void undoDiscard()} className="text-[12.5px] font-semibold text-orange-text hover:underline">
        {t('epochs.overrides.undo')}
      </button>
    </div>
  ) : null

  if (rows.length === 0) return discardToast
  const checkedCount = rows.filter((r) => checked.has(r.id)).length

  if (!panelOpen) {
    return (
      <div data-testid="epoch-overrides-corner" className={cn('fixed z-[9990]', corner)} style={narrow ? topSlot : undefined}>
        {collapsed ? (
          <button
            ref={pillRef}
            data-testid="epoch-overrides-pill"
            onClick={openReview}
            className="inline-flex items-center gap-1.5 rounded-full border border-warning-border bg-warning-bg px-3 py-1.5 text-[12px] font-semibold text-warning-text shadow-md hover:bg-warning-text/10"
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            {t('epochs.overrides.pill', { count: rows.length })}
          </button>
        ) : (
          <div data-testid="epoch-overrides-notice" className="flex max-w-sm items-start gap-3 rounded-lg border border-line bg-surface-100 p-3 shadow-lg">
            <History className="mt-0.5 h-4 w-4 shrink-0 text-warning-text" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p role="status" aria-live="polite" className="text-[13px] font-medium text-fg">{t('epochs.overrides.notice', { count: rows.length })}</p>
              <div className="mt-2 flex gap-2">
                <button data-testid="epoch-overrides-review" onClick={openReview} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-accent-hover">
                  {t('epochs.overrides.review')}
                </button>
              </div>
            </div>
            <button aria-label={t('epochs.overrides.later')} onClick={() => useEpochOverridesStore.setState({ noticeCollapsed: true })} className="rounded p-0.5 text-fg-muted hover:bg-surface-200">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    )
  }

  if (compact) {
    // In the diagram: a strip, so the canvas and the inspector stay visible.
    // Above the bottom bar (status / perspectives) and the zoom controls,
    // centered over the canvas: it covers neither the object list, the
    // inspector nor the bar.
    return (
      <div
        data-testid="epoch-overrides-strip"
        className={cn(
          'fixed z-[9990] flex items-center gap-3 rounded-lg border border-line bg-surface-100 px-3 py-2 shadow-lg',
          narrow
            // Centered between the tool rail's clearance (404 px, as the
            // notice) and the inspector (centered from 340 px, wrapped, it
            // could start on the rail).
            ? cn('left-[404px] right-[340px] mx-auto w-fit max-w-[calc(100vw-744px)] flex-wrap justify-center', !retiredBannerUp && 'top-[4.75rem]')
            : 'bottom-[4.75rem] left-1/2 -translate-x-1/2',
        )}
        style={narrow ? topSlot : undefined}
      >
        <History className="h-4 w-4 shrink-0 text-warning-text" aria-hidden="true" />
        <span className="text-[12.5px] font-medium text-fg">{t('epochs.overrides.reviewing', { count: rows.length })}</span>
        <button data-testid="epoch-overrides-back" onClick={expandReview} className="text-[12.5px] font-semibold text-orange-text hover:underline">
          {t('epochs.overrides.backToReview')}
        </button>
        <button
          data-testid="epoch-overrides-reapply-strip"
          onClick={() => void reapplyChecked()}
          disabled={busy || readOnly || checkedCount === 0}
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {t('epochs.overrides.reapply', { count: checkedCount })}
        </button>
      </div>
    )
  }

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      data-testid="epoch-overrides-panel"
      aria-label={t('epochs.overrides.title')}
      className={cn(
        'fixed z-[9990] flex w-[312px] max-w-[calc(100vw-1.75rem)] flex-col overflow-hidden rounded-[20px] border border-line bg-surface-100 shadow-xl focus:outline-none',
        // Narrow: the inspector's column, below the tool row, to its
        // bottom — the banner is over the canvas, not over this column.
        narrow ? 'right-3.5 top-[4.75rem] bottom-3.5' : cn('bottom-[4.75rem]', right, !retiredBannerUp && 'top-[4.75rem]'),
      )}
      // Below the retired banner when it is up (they share the row under the
      // tool pill): its measured bottom edge, plus the 14 px gutter. Its text
      // wraps on a narrow canvas, so a fixed offset is not enough.
      style={retiredBannerUp && !narrow ? topSlot : undefined}
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <History className="h-4 w-4 text-warning-text" aria-hidden="true" />
        <h2 className="flex-1 text-[14px] font-semibold text-fg">{t('epochs.overrides.title')}</h2>
        <button data-testid="epoch-overrides-close" aria-label={t('epochs.overrides.close')} onClick={closeReview} className="rounded p-1 text-fg-muted hover:bg-surface-200">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>
      <div className="border-b border-line px-4 py-2 text-[12px] text-fg-secondary">
        <p>{t('epochs.overrides.explain')}</p>
        <div className="mt-1.5 flex gap-3">
          <button data-testid="epoch-overrides-all" onClick={() => setAllChecked(true)} className="font-medium text-orange-text hover:underline">{t('epochs.overrides.all')}</button>
          <button data-testid="epoch-overrides-none" onClick={() => setAllChecked(false)} className="font-medium text-orange-text hover:underline">{t('epochs.overrides.none')}</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <section key={group.key} data-testid={`override-group-${group.entityId ?? group.key}`} className="border-b border-line px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-surface-200 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-fg-muted">
                {t(`epochs.overrides.kind.${group.collection ?? 'other'}`)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{entityLabel(group)}</span>
              <button
                data-testid={`override-show-${group.entityId ?? group.key}`}
                onClick={() => showInDiagram(group)}
                className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-orange-text hover:underline"
              >
                <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" />
                {t('epochs.overrides.showInDiagram')}
              </button>
            </div>
            <ul className="space-y-2">
              {group.rows.map((row) => {
                const status = statuses.get(row.id)
                const disabled = readOnly || status?.kind === 'endpoint-deleted' || status?.kind === 'unsupported'
                const whole = overrideTarget(row)?.field.length === 0
                const isChecked = checked.has(row.id)
                return (
                  <li key={row.id} className={cn('rounded-md border border-line p-2', pulled.has(row.id) && 'border-warning-border bg-warning-bg/40')}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        data-testid={`override-check-${row.id}`}
                        data-entity={row.entityId ?? ''}
                        data-field={overrideTarget(row)?.field.map(String).join('.') ?? ''}
                        checked={isChecked}
                        disabled={disabled || busy}
                        onChange={(e) => setRowChecked(row.id, e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium text-fg-strong">
                          {whole ? t(`epochs.overrides.recreate.${group.collection ?? 'objects'}`) : fieldLabel(rowField(row), group.collection, t)}
                        </span>
                        {!whole && (
                          <span className="mt-1 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-0.5 text-[11.5px]">
                            <span className="text-fg-muted">{t('epochs.overrides.current')}</span>
                            <span
                              data-testid={`override-current-${row.id}`}
                              title={fullValue(row.currentValueAtForward)}
                              className={cn('truncate text-fg-secondary', isChecked && 'line-through decoration-fg-muted')}
                            >
                              {displayValue(row.currentValueAtForward)}
                            </span>
                            <span className="inline-flex items-center gap-1 text-fg-muted">
                              <ArrowRight className="h-3 w-3" aria-hidden="true" />
                              {t('epochs.overrides.yours')}
                            </span>
                            <span
                              data-testid={`override-yours-${row.id}`}
                              title={fullValue(row.lateValue)}
                              className="truncate rounded bg-accent-subtle px-1 font-medium text-fg"
                            >
                              {displayValue(row.lateValue)}
                            </span>
                          </span>
                        )}
                        <span className="mt-0.5 block text-[10.5px] text-fg-muted" title={new Date(row.createdAt).toLocaleString(i18n.language)}>
                          {t('epochs.overrides.when', { date: relativeTime(row.createdAt, i18n.language) })}
                        </span>
                        <StatusNote status={status} row={row} />
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      {refusal && (
        <div role="alert" className="flex items-center gap-2 border-t border-line bg-warning-bg px-4 py-2 text-[12px] text-warning-text">
          <span className="flex-1">{t(`epochs.overrides.refusal.${refusal}`)}</span>
          {refusal === 'needsDiagram' && (
            <button data-testid="epoch-overrides-open-diagram" onClick={openDiagramForReapply} className="font-semibold underline">
              {t('epochs.overrides.openDiagram')}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="border-t border-line bg-error-bg px-4 py-2 text-[12px] text-error-text">{error}</p>}
      {confirmingDiscard && (
        <div data-testid="epoch-overrides-discard-confirm" role="alert" className="border-t border-line bg-warning-bg px-4 py-2.5 text-[12px] text-warning-text">
          <p>{t('epochs.overrides.discardConfirm', { count: rows.length })}</p>
          <div className="mt-2 flex gap-2">
            <button
              data-testid="epoch-overrides-discard-yes"
              onClick={() => { setConfirmingDiscard(false); void dismissAll() }}
              disabled={busy || readOnly}
              className="rounded-md bg-error px-2.5 py-1 text-[12px] font-semibold text-on-inverse hover:opacity-90 disabled:opacity-50"
            >
              {t('epochs.overrides.discardConfirmYes')}
            </button>
            <button
              data-testid="epoch-overrides-discard-no"
              autoFocus
              onClick={() => { returnFocusToDismiss.current = true; setConfirmingDiscard(false) }}
              className="rounded-md border border-line bg-surface-100 px-2.5 py-1 text-[12px] font-medium text-fg-secondary hover:bg-surface-200"
            >
              {t('epochs.overrides.discardConfirmNo')}
            </button>
          </div>
        </div>
      )}
      <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
        <button
          ref={dismissRef}
          data-testid="epoch-overrides-dismiss-all"
          onClick={() => setConfirmingDiscard(true)}
          disabled={busy || readOnly || confirmingDiscard}
          className="rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-fg-secondary hover:bg-surface-200 disabled:opacity-50"
        >
          {t('epochs.overrides.dismissAll')}
        </button>
        <span className="flex-1" />
        <button
          data-testid="epoch-overrides-reapply"
          onClick={() => void reapplyChecked()}
          disabled={busy || readOnly || checkedCount === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {t('epochs.overrides.reapply', { count: checkedCount })}
        </button>
      </footer>
    </aside>
  )
}
