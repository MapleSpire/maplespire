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

import { useState, useRef, useEffect, useMemo } from 'react'
import { Clock, CheckCircle2, XCircle, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import type { ADRStatus } from '../../types'

interface ADRStatusBadgeProps {
  status: ADRStatus
  editable?: boolean
  onChange?: (status: ADRStatus) => void
}

function statusConfig(t: TFunction): Record<ADRStatus, { label: string; icon: React.ElementType; color: string; bg: string; border: string }> {
  return {
    'in-progress': {
      label: t('decisionRecords.status.inProgress'),
      icon: Clock,
      color: 'text-warning-text',
      bg: 'bg-warning-bg',
      border: 'border-warning',
    },
    approved: {
      label: t('decisionRecords.status.approved'),
      icon: CheckCircle2,
      color: 'text-success-text',
      bg: 'bg-success-bg',
      border: 'border-success',
    },
    rejected: {
      label: t('decisionRecords.status.rejected'),
      icon: XCircle,
      color: 'text-error-text',
      bg: 'bg-error-bg',
      border: 'border-error',
    },
  }
}

export function ADRStatusBadge({ status, editable = false, onChange }: ADRStatusBadgeProps) {
  const { t } = useTranslation()
  const STATUS_CONFIG = useMemo(() => statusConfig(t), [t])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const config = STATUS_CONFIG[status]
  const Icon = config.icon

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => editable && setOpen(!open)}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1 rounded-full text-[12px] font-medium border transition-colors',
          config.bg,
          config.color,
          config.border,
          editable && 'cursor-pointer hover:opacity-80'
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{config.label}</span>
        {editable && <ChevronDown className="h-3 w-3 shrink-0" />}
      </button>

      {open && editable && (
        <div className="absolute top-full left-0 mt-1 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[140px] z-50">
          {(Object.keys(STATUS_CONFIG) as ADRStatus[]).map((s) => {
            const c = STATUS_CONFIG[s]
            const SIcon = c.icon
            return (
              <button
                key={s}
                onClick={() => {
                  onChange?.(s)
                  setOpen(false)
                }}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-1.5 text-[12px] hover:bg-surface-50 text-left',
                  s === status ? 'text-fg font-medium' : 'text-fg-secondary'
                )}
              >
                <SIcon className={cn('w-3.5 h-3.5', c.color)} />
                {c.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
