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
import { History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { overriddenFields, useEpochOverridesStore } from '../../stores/epochOverridesStore'
import { displayValue, fieldLabel, fullValue } from './epochOverrideValue'

/**
 * The view-only HIGHLIGHT LAYER of the G4-16f override review, outside the
 * canvas: a marker on a Model Objects / Model Connections row whose entity carries a pending
 * override, and, in the inspector, one marker per overridden field showing
 * both values ("current" — the other user's — and "yours"). Driven by the
 * override rows alone; it changes no document.
 */
function useFields(entityId: string) {
  const rows = useEpochOverridesStore((s) => s.rows)
  return useMemo(() => overriddenFields(rows).get(entityId) ?? [], [rows, entityId])
}

export function OverrideRowMarker({ entityId, testIdPrefix }: { entityId: string; testIdPrefix: string }) {
  const { t } = useTranslation()
  const fields = useFields(entityId)
  if (fields.length === 0) return null
  return (
    // In the row's flow next to the name: the name keeps
    // the truncation priority, the badge never overlaps it; where the column
    // is narrow the badge folds to its icon (the label stays its name).
    <span
      data-testid={`${testIdPrefix}-${entityId}`}
      title={t('epochs.overrides.marker')}
      aria-label={t('epochs.overrides.marker')}
      className="ml-1.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-1.5 py-0.5 text-[10.5px] font-semibold text-warning-text"
    >
      <History className="h-3 w-3" aria-hidden="true" />
      <span className="max-[1440px]:hidden" aria-hidden="true">{t('epochs.overrides.markerShort')}</span>
    </span>
  )
}

export function OverrideFieldMarkers({ entityId, collection }: { entityId: string; collection: 'objects' | 'connections' | 'groups' }) {
  const { t } = useTranslation()
  const highlight = useEpochOverridesStore((s) => s.highlight)
  const fields = useFields(entityId)
  if (!highlight || fields.length === 0) return null
  return (
    // Aligned on the inspector's own grid: no inset of its
    // own, the header's padding is the left edge.
    <div data-testid="override-markers" className="mt-3 space-y-2 rounded-md border border-warning-border bg-warning-bg px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning-text">
        <History className="h-3 w-3" aria-hidden="true" />
        {t('epochs.overrides.marker')}
      </p>
      {fields.map((f) => (
        <div key={f.rowId} data-testid={`override-marker-${f.field}`} className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
          <span className="col-span-2 font-medium text-fg-strong">{fieldLabel(f.field, collection, t)}</span>
          <span className="text-fg-muted">{t('epochs.overrides.current')}</span>
          <span className="truncate text-fg-secondary" title={fullValue(f.current)}>{displayValue(f.current)}</span>
          <span className="text-fg-muted">{t('epochs.overrides.yours')}</span>
          <span className="truncate rounded bg-accent-subtle px-1 font-medium text-fg" title={fullValue(f.yours)}>{displayValue(f.yours)}</span>
        </div>
      ))}
    </div>
  )
}
