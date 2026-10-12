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

import { useMemo } from 'react'
import { Clock, CheckCircle2, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import i18n from '../../lib/i18n'
import { cn } from '../../lib/utils'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { ADRStatus, ADRStatusEvent, DecisionRecord } from '../../types'

function statusConfig(t: TFunction): Record<ADRStatus, { icon: React.ElementType; color: string; bg: string; label: string }> {
  return {
    'in-progress': { icon: Clock, color: 'text-warning-text', bg: 'bg-warning-bg', label: t('decisionRecords.status.inProgress') },
    approved: { icon: CheckCircle2, color: 'text-success-text', bg: 'bg-success-bg', label: t('decisionRecords.status.approved') },
    rejected: { icon: XCircle, color: 'text-error-text', bg: 'bg-error-bg', label: t('decisionRecords.status.rejected') },
  }
}

/** English ordinal suffix (1st/2nd/3rd/4th…). French dates don't use this system —
 * only the 1st of the month takes a suffix ("1er"), every other day is bare. */
function getOrdinalSuffix(n: number): string {
  if (i18n.language === 'fr') return n === 1 ? 'er' : ''
  if (n > 3 && n < 21) return 'th'
  switch (n % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

function formatDateWithOrdinal(dateStr: string): string {
  const d = new Date(dateStr)
  return `${d.getDate()}${getOrdinalSuffix(d.getDate())} ${d.toLocaleDateString(i18n.language, { month: 'short' })}, ${d.getFullYear()}`
}

/** The selected record's status history, newest first. Records created before the
 *  `history` field derive a minimal one: created → current status. */
function timelineEvents(record: DecisionRecord): ADRStatusEvent[] {
  const events =
    record.history && record.history.length > 0
      ? [...record.history]
      : record.status === 'in-progress'
        ? [{ status: record.status, date: record.createdAt }]
        : [
            { status: 'in-progress' as ADRStatus, date: record.createdAt },
            { status: record.status, date: record.updatedAt || record.createdAt },
          ]
  // Newest first (stable for equal dates so derived order is preserved).
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => new Date(b.e.date).getTime() - new Date(a.e.date).getTime() || b.i - a.i)
    .map(({ e }) => e)
}

/**
 * The selected decision record's status timeline — rendered inside the shell's
 * details panel (the panel owns width/scroll/section header). One node per
 * status transition of THAT record (not a list of all records).
 */
export function ADRTimeline() {
  const { t } = useTranslation()
  const STATUS_CONFIG = useMemo(() => statusConfig(t), [t])
  const decisionRecords = useModelStore((s) => s.decisionRecords)
  const selectedADRId = useUIStore((s) => s.selectedADRId)
  const record = useMemo(
    () => decisionRecords.find((r) => r.id === selectedADRId),
    [decisionRecords, selectedADRId]
  )
  const events = useMemo(() => (record ? timelineEvents(record) : []), [record])

  return (
    <div className="mt-2">
      {events.length === 0 ? (
        <div className="text-[11px] text-fg-subtle">{t('decisionRecords.timeline.noHistory')}</div>
      ) : (
        <div>
          {events.map((event, i) => {
            const config = STATUS_CONFIG[event.status]
            const Icon = config.icon
            const last = i === events.length - 1
            return (
              <div key={`${event.status}-${event.date}-${i}`} className="flex gap-3">
                <div className="flex shrink-0 flex-col items-center">
                  <span className={cn('flex h-[22px] w-[22px] items-center justify-center rounded-full', config.bg)}>
                    <Icon className={cn('h-3 w-3', config.color)} />
                  </span>
                  {!last && <span className="my-1 w-[2px] flex-1 bg-line-strong" />}
                </div>
                <div style={{ paddingBottom: last ? 0 : 22 }}>
                  <div className="text-[12.5px] font-semibold text-fg">{config.label}</div>
                  <div className="mt-0.5 text-[11px] text-fg-subtle">{formatDateWithOrdinal(event.date)}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
