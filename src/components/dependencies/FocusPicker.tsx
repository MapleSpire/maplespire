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

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { ChevronsUpDown, Search, Layers } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { cn } from '../../lib/utils'
import { getModelQuery, residentModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import type { PickerEntry } from '../../lib/modelQuery/types'
import { TechIconBadge } from '../shared/TechIconBadge'
import { useVirtualRows } from '../common/VirtualList'
import { useCursorRows, useDebouncedValue } from '../common/useCursorRows'
import { typeIcons, typeTint, typeColorVar } from './helpers'

/**
 * The centre "Object of focus" selector. Opens a searchable dropdown listing
 * objects then groups; choosing one sets the focus. The list is read windowed
 * through getModelQuery().pickerEntries so it never builds an entry per object
 * (it did, for tens of thousands), and only fetches while the dropdown is open.
 */
export function FocusPicker({ focusId }: { focusId: string | null }) {
  const { t } = useTranslation()
  // Store array refs are a change signal only — entries come windowed from the seam.
  const resident = getModelQuery() === residentModelQuery
  const objectsRef = useModelStore((s) => resident ? s.objects : null)
  const groupsRef = useModelStore((s) => resident ? s.groups : null)
  // Re-resolve the label + re-fetch the list when the persisted index changes (the
  // background build makes it the WHOLE model) so the picker isn't stuck on the
  // windowed store and can focus any object — not just the active diagram's.
  const indexVersion = useModelIndexVersion((s) => s.version)
  const setFocusId = useUIStore((s) => s.setDependenciesFocusId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  // Resolve the current focus for the button label via the seam (no full scan).
  const [focus, setFocus] = useState<PickerEntry | null>(null)
  useEffect(() => {
    if (!focusId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFocus(null)
      return
    }
    let cancelled = false
    void getModelQuery().lookupMany([focusId]).then((m) => {
      if (cancelled) return
      const e = m.get(focusId)
      setFocus(
        e
          ? { id: focusId, name: e.name, icon: e.icon, iconAssignment: e.iconAssignment, kind: 'objectIds' in e ? 'group' : 'object', type: 'type' in e ? (e as { type?: string }).type : undefined }
          : null
      )
    })
    return () => {
      cancelled = true
    }
  }, [focusId, objectsRef, groupsRef, indexVersion])

  const debouncedQuery = useDebouncedValue(query.trim(), 200)
  const effectiveQuery = debouncedQuery.length >= 2 ? debouncedQuery : ''
  const fetchPage = useCallback(async (cursor: string | null, signal: AbortSignal) => {
    if (!open) return { items: [] as PickerEntry[], total: 0, nextCursor: null }
    const page = await getModelQuery().objectSearchPage({
      query: effectiveQuery,
      // Empty input is an explicit bounded browse contract. Do not express the
      // complete type universe as a filter: that would bypass the local Worker
      // fallback and make this picker empty during a server outage.
      cursor,
      limit: 50,
    }, signal)
    return {
      items: page.items.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        type: item.kind === 'object' ? item.type : undefined,
        icon: item.icon,
        iconAssignment: item.iconAssignment,
        domainId: item.domainId,
      })),
      total: page.total ?? page.items.length,
      nextCursor: page.nextCursor,
      coverage: page.coverage,
      revision: page.projectionGeneration,
    }
  }, [effectiveQuery, open])
  const refreshKey = useMemo(
    () => ({ indexVersion, objectsRef, groupsRef }),
    [groupsRef, indexVersion, objectsRef],
  )
  const cursorRows = useCursorRows<PickerEntry>({
    enabled: open,
    queryKey: `${open}\u0000${effectiveQuery}`,
    refreshKey,
    fetchPage,
    keyOf: useCallback((entry) => entry.id, []),
  })
  const { items: rows, total } = cursorRows

  const scrollRef = useRef<HTMLDivElement>(null)
  const { virtualItems, totalSize, measureElement } = useVirtualRows({
    scrollRef,
    count: rows.length,
    estimateSize: () => 32,
    getItemKey: (i) => rows[i]?.id ?? `idx-${i}`,
  })
  useEffect(() => {
    const last = virtualItems.at(-1)?.index ?? -1
    if (last >= rows.length - 2 && cursorRows.nextCursor && !cursorRows.loading) cursorRows.loadMore()
  }, [cursorRows, rows.length, virtualItems])

  const FocusIcon = focus?.kind === 'object' ? typeIcons[focus.type as string] ?? Layers : Layers
  const focusType = focus?.kind === 'object' ? (focus.type as string | undefined) : undefined

  return (
    <div className="relative">
      {/* Compact kit trigger (pg-focusbtn): tinted tile + name + up/down chevron. */}
      <button
        data-testid="focus-picker-trigger"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-[10px] border border-line bg-surface-100 py-1.5 pl-1.5 pr-2 shadow-sm transition-colors hover:bg-surface-50"
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px]"
          style={{ background: typeTint(focusType), color: focusType ? `var(${typeColorVar[focusType]})` : 'var(--color-fg-muted)' }}
        >
          {focus?.icon ? (
            <TechIconBadge
              name={focus.icon}
              iconLightPath={focus.iconAssignment?.iconLightPath}
              iconDarkPath={focus.iconAssignment?.iconDarkPath}
              size="sm"
            />
          ) : (
            <FocusIcon className="h-3.5 w-3.5" strokeWidth={1.7} />
          )}
        </span>
        <span className="flex-1 truncate text-left text-[13px] font-semibold text-fg">{focus ? focus.name : t('dataViewsA.focusPicker.selectObject')}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 right-0 mt-1.5 bg-surface-100 border border-line rounded-lg shadow-xl z-30 overflow-hidden">
            <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
              {t('dataViewsA.focusPicker.objectOfFocus')}
            </div>
            <div className="px-2 pb-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-subtle" />
                <input
                  type="text"
                  autoFocus
                  data-testid="focus-picker-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('dataViewsA.focusPicker.searchPlaceholder')}
                  className="w-full pl-8 pr-3 py-1.5 text-[12px] bg-surface-50 border border-line rounded-md text-fg focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-fg-subtle"
                />
              </div>
            </div>
            {/* Windowed through the seam → bounded + instant even at tens of thousands. */}
            <div ref={scrollRef} className="overflow-auto py-1" style={{ maxHeight: 280 }}>
              {total === 0 ? (
                <div className="px-3 py-2 text-[12px] text-fg-subtle">{t('dataViewsA.focusPicker.noMatches')}</div>
              ) : (
                <div style={{ height: totalSize, position: 'relative' }}>
                  {virtualItems.map((v) => {
                    const r = rows[v.index]
                    const Icon = r && r.kind === 'object' ? typeIcons[r.type as string] ?? Layers : Layers
                    return (
                      <div
                        key={v.key}
                        data-index={v.index}
                        ref={measureElement}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                      >
                        {r ? (
                          <button
                            data-testid={`focus-picker-option-${r.id}`}
                            onClick={() => {
                              setFocusId(r.id)
                              setOpen(false)
                              setQuery('')
                            }}
                            className={cn(
                              // Kit .pg-focusopt: 12.5px, rounded, selected = accent wash.
                              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                              r.id === focusId ? 'bg-accent-subtle text-accent font-medium' : 'text-fg-secondary hover:bg-surface-50'
                            )}
                          >
                            {r.icon ? (
                              <TechIconBadge
                                name={r.icon}
                                iconLightPath={r.iconAssignment?.iconLightPath}
                                iconDarkPath={r.iconAssignment?.iconDarkPath}
                                size="sm"
                              />
                            ) : (
                              <Icon className="w-4 h-4 text-fg-subtle shrink-0" />
                            )}
                            <span className="flex-1 truncate">{r.name}</span>
                            <span className="text-[10px] text-fg-subtle capitalize">{r.kind === 'group' ? t('dataViewsA.focusPicker.group') : r.type}</span>
                          </button>
                        ) : (
                          <div className="px-3 py-1.5 text-[12px] text-fg-subtle">…</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
