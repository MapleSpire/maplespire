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

import { useState, useEffect, useRef } from 'react'
import { Search, X, Box, User, Monitor, Database, Puzzle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { getModelQuery } from '../../lib/modelQuery'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import { SEARCH_MIN_CHARS } from '../../lib/modelQuery/search'
import type { SearchHit } from '../../lib/modelQuery/types'
import { orderedTechnologyUsages } from '../../lib/technologyUsage'

const typeIcons: Record<string, React.ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  component: Puzzle,
}

export function SearchModal() {
  const { t } = useTranslation()
  const open = useUIStore((s) => s.searchOpen)
  const setSearchOpen = useUIStore((s) => s.setSearchOpen)
  const selectObjects = useModelStore((s) => s.selectObjects)
  const selectConnection = useModelStore((s) => s.selectConnection)
  // Re-query when the paged index (re)builds; a no-op bump in resident mode.
  const indexVersion = useModelIndexVersion((s) => s.version)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the search box each time the modal opens
      setQuery('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(!open)
      }
      if (e.key === 'Escape' && open) {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, setSearchOpen])

  // Search through the ModelQuery seam — resident scans the store; paged serves
  // it from the trigram index (so it works without the whole model in memory).
  // Async, with stale-result cancellation.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    getModelQuery()
      .search(query)
      .then((r) => { if (!cancelled) setResults(r) })
      .catch((err) => { if (!cancelled) console.warn('search failed:', err) })
    return () => { cancelled = true }
  }, [query, indexVersion, open])

  if (!open) return null

  const tooShort = query.trim().length > 0 && query.trim().length < SEARCH_MIN_CHARS

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setSearchOpen(false)}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-modal-backdrop" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg bg-surface-100 rounded-xl shadow-xl border border-line overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <Search className="w-4 h-4 text-fg-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder={t('modalsCore.search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 text-[14px] text-fg placeholder:text-fg-subtle bg-transparent outline-none"
          />
          <button
            onClick={() => setSearchOpen(false)}
            className="flex items-center gap-1 text-[11px] text-fg-subtle hover:text-fg-secondary"
          >
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono bg-surface-200 rounded border border-line">
              {t('modalsCore.search.esc')}
            </kbd>
            <X className="w-4 h-4 sm:hidden" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {tooShort && (
            <div className="px-4 py-8 text-center">
              <p className="text-[13px] text-fg-subtle">{t('modalsCore.search.tooShort', { count: SEARCH_MIN_CHARS })}</p>
            </div>
          )}
          {results.length === 0 && query.trim() && !tooShort && (
            <div className="px-4 py-8 text-center">
              <p className="text-[13px] text-fg-subtle">{t('modalsCore.search.noResults', { query })}</p>
            </div>
          )}
          {results.length === 0 && !query.trim() && (
            <div className="px-4 py-6 text-[12px] text-fg-subtle">
              <p className="mb-2 font-medium text-fg-secondary">{t('modalsCore.search.tryLabel')}</p>
              <div className="flex flex-wrap gap-1.5">
                {(t('modalsCore.search.trySuggestions', { returnObjects: true }) as string[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setQuery(s)}
                    className="px-2 py-1 text-[11px] bg-surface-50 border border-line rounded-md hover:bg-surface-200 hover:border-line-strong transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {results.map((result, idx) => {
            if (result.type === 'object') {
              const obj = result.object
              const Icon = typeIcons[obj.type] || Box
              return (
                <button
                  key={obj.id + idx}
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-surface-50 transition-colors"
                  onClick={() => {
                    selectObjects([obj.id])
                    selectConnection(null)
                    setSearchOpen(false)
                  }}
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-surface-200">
                    <Icon className="w-4 h-4 text-fg-secondary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg">{obj.name}</p>
                    <p className="text-[11px] text-fg-subtle truncate">
                      {obj.type}{orderedTechnologyUsages(obj.technologyUsages, obj.technologyUsageOrder)[0]?.snapshot.name
                        ? ` · ${orderedTechnologyUsages(obj.technologyUsages, obj.technologyUsageOrder)[0].snapshot.name}`
                        : ''}
                    </p>
                  </div>
                </button>
              )
            } else {
              const conn = result.connection
              return (
                <button
                  key={conn.id + idx}
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-surface-50 transition-colors"
                  onClick={() => {
                    selectConnection(conn.id)
                    selectObjects([])
                    setSearchOpen(false)
                  }}
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent-subtle">
                    <span className="text-[10px] font-bold text-accent">→</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-fg">{conn.label || t('modalsCore.search.connectionFallbackLabel')}</p>
                    <p className="text-[11px] text-fg-subtle truncate">
                      {result.fromName} → {result.toName}
                    </p>
                  </div>
                </button>
              )
            }
          })}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div className="px-4 py-2 border-t border-line text-[11px] text-fg-subtle">
            {t('modalsCore.search.resultCount', { count: results.length, plural: results.length !== 1 ? 's' : '' })}
          </div>
        )}
      </div>
    </div>
  )
}
