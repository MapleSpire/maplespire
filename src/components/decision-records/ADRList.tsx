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

import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import i18n from '../../lib/i18n'
import { cn } from '../../lib/utils'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { ADRStatus, DecisionRecord } from '../../types'
import { useVirtualRows } from '../common/VirtualList'
import { filterDecisionRecords, sortDecisionRecordsNewestFirst } from './adrFiltering'

// Status → the kit's list-rail dot hue (dr2-item__dot) + label.
function statusMeta(t: TFunction): Record<ADRStatus, { dot: string; label: string }> {
  return {
    'in-progress': { dot: 'var(--color-warning)', label: t('decisionRecords.status.inProgress') },
    approved: { dot: 'var(--color-success)', label: t('decisionRecords.status.approved') },
    rejected: { dot: 'var(--color-error)', label: t('decisionRecords.status.rejected') },
  }
}

type FlatItem =
  | { kind: 'header'; dateKey: string }
  | { kind: 'record'; record: DecisionRecord }

function buildFlatList(records: DecisionRecord[]): FlatItem[] {
  const groups = new Map<string, DecisionRecord[]>()
  for (const record of records) {
    const date = new Date(record.createdAt)
    const key = date.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' })
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(record)
  }

  const flat: FlatItem[] = []
  for (const [dateKey, recs] of groups.entries()) {
    flat.push({ kind: 'header', dateKey })
    for (const r of recs) flat.push({ kind: 'record', record: r })
  }
  return flat
}

// Estimated heights used as hints for the virtualizer.
// measureElement corrects them after the first paint.
const HEADER_HEIGHT = 32
const RECORD_HEIGHT = 52

/** The dr2 list rail: a date-grouped column ON the base plane (border-right,
 * no floating chrome — the shell owns nav/search/create now). */
export function ADRList({
  hasMore = false,
  loading = false,
  onLoadMore,
  serverFiltered = false,
  statusFilter = null,
  windowLimited = false,
}: {
  hasMore?: boolean
  loading?: boolean
  onLoadMore?: () => void
  serverFiltered?: boolean
  statusFilter?: ADRStatus | null
  windowLimited?: boolean
}) {
  const { t } = useTranslation()
  const decisionRecords = useModelStore((s) => s.decisionRecords)
  const selectedADRId = useUIStore((s) => s.selectedADRId)
  const setSelectedADRId = useUIStore((s) => s.setSelectedADRId)
  const adrSearchQuery = useUIStore((s) => s.adrSearchQuery)

  // Server-tier pages are authoritatively filtered across all ADRs. The ordinary
  // Automerge fallback route does not understand q/status yet, so preserve its
  // bounded local behavior instead of silently displaying unfiltered results.
  const visibleRecords = useMemo(() => sortDecisionRecordsNewestFirst(filterDecisionRecords(
    decisionRecords, adrSearchQuery, statusFilter, serverFiltered,
  )), [adrSearchQuery, decisionRecords, serverFiltered, statusFilter])
  const flatItems = useMemo(() => buildFlatList(visibleRecords), [visibleRecords])
  const meta = useMemo(() => statusMeta(t), [t])

  const scrollRef = useRef<HTMLDivElement>(null)

  const { virtualItems, totalSize, measureElement } = useVirtualRows({
    scrollRef,
    count: flatItems.length,
    estimateSize: (i) => (flatItems[i]?.kind === 'header' ? HEADER_HEIGHT : RECORD_HEIGHT),
    getItemKey: (i) => {
      const item = flatItems[i]
      return item.kind === 'header' ? `h:${item.dateKey}` : `r:${item.record.id}`
    },
  })

  return (
    <div
      data-testid="adr-list-rail"
      className="flex h-full w-[calc(var(--pad-l)+264px)] shrink-0 flex-col border-r border-line max-[1360px]:w-[calc(var(--pad-l)+216px)]"
    >
      {visibleRecords.length === 0 ? (
        <div className="flex-1 py-8 pr-4 text-center" style={{ paddingLeft: 'calc(var(--pad-l) + 16px)' }}>
          <p className="text-[12px] text-fg-subtle">{t('decisionRecords.list.empty')}</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto py-3"
          role="list"
          aria-label={t('decisionRecords.list.ariaLabel')}
          onScroll={(event) => {
            const el = event.currentTarget
            if (hasMore && !loading && el.scrollHeight - el.scrollTop - el.clientHeight < 320) onLoadMore?.()
          }}
        >
          <div style={{ height: totalSize, position: 'relative' }}>
            {virtualItems.map((vItem) => {
              const flatItem = flatItems[vItem.index]

              if (flatItem.kind === 'header') {
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    ref={measureElement}
                    role="presentation"
                    style={{
                      position: 'absolute',
                      top: 0,
                      transform: `translateY(${vItem.start}px)`,
                      width: '100%',
                    }}
                  >
                    {/* Date header (dr2-date) */}
                    <div
                      className="flex items-center gap-2 pb-1.5 pr-3.5 pt-2.5"
                      style={{ paddingLeft: 'calc(var(--pad-l) + 14px)' }}
                    >
                      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-surface-400" />
                      <span className="text-[11px] text-fg-subtle">{flatItem.dateKey}</span>
                    </div>
                  </div>
                )
              }

              // kind === 'record'
              const record = flatItem.record
              const statusInfo = meta[record.status]
              const isSelected = record.id === selectedADRId

              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={measureElement}
                  role="listitem"
                  aria-setsize={flatItems.length}
                  aria-posinset={vItem.index + 1}
                  style={{
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${vItem.start}px)`,
                    width: '100%',
                  }}
                >
                  <button
                    onClick={() => setSelectedADRId(record.id)}
                    data-testid={`adr-list-row-${record.id}`}
                    className={cn(
                      'flex w-full items-center gap-2.5 py-2 pr-3.5 text-left transition-colors',
                      isSelected
                        ? 'bg-accent-subtle shadow-[inset_3px_0_0_var(--color-accent)]'
                        : 'hover:bg-surface-50'
                    )}
                    style={{ paddingLeft: 'calc(var(--pad-l) + 14px)' }}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusInfo.dot }} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span
                        className={cn(
                          'truncate text-[12.5px] font-medium',
                          isSelected ? 'text-accent' : 'text-fg'
                        )}
                      >
                        {record.title}
                      </span>
                      <span className="text-[11px] text-fg-subtle">
                        ADR-{record.number} · {statusInfo.label}
                      </span>
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {windowLimited && (
        <p
          className="border-t border-line py-2 pr-3 text-[10px] text-fg-subtle"
          style={{ paddingLeft: 'calc(var(--pad-l) + 12px)' }}
        >
          {t('decisionRecords.list.windowLimit')}
        </p>
      )}
    </div>
  )
}
