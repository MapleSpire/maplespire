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

import type { ReactNode } from 'react'
import { Loader2, Search } from 'lucide-react'
import { cn } from '../../lib/utils'
import { VirtualList } from '../common/VirtualList'

interface CatalogBrowserProps<T> {
  items: T[]
  query: string
  onQueryChange: (query: string) => void
  searchLabel: string
  searchPlaceholder: string
  getKey: (item: T, index: number) => string
  renderRow: (item: T, index: number) => ReactNode
  emptyState: ReactNode
  controls?: ReactNode
  estimateSize?: number
  loading?: boolean
  loadingMore?: boolean
  onEndReached?: () => void
  className?: string
  searchTestId?: string
}

/**
 * Shared search + controls + virtual-list surface for large visual catalogs.
 * Icon and technology selection intentionally use the same interaction model;
 * only their row metadata and server-side filters differ.
 */
export function CatalogBrowser<T>({
  items,
  query,
  onQueryChange,
  searchLabel,
  searchPlaceholder,
  getKey,
  renderRow,
  emptyState,
  controls,
  estimateSize = 52,
  loading = false,
  loadingMore = false,
  onEndReached,
  className,
  searchTestId,
}: CatalogBrowserProps<T>) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="shrink-0 border-b border-line bg-surface-100">
        <div className="px-4 pb-3 pt-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden="true"
            />
            <input
              type="search"
              data-testid={searchTestId}
              aria-label={searchLabel}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              className="w-full rounded-lg border border-line bg-surface-50 py-2 pl-9 pr-3 text-[13px] text-fg outline-none transition-shadow focus:border-accent focus:ring-1 focus:ring-accent"
              // Two mechanisms, because this browser is mounted both ways.
              // `autoFocus` is what works when it is rendered inline; inside a
              // FloatingPicker it is a no-op (the panel is still `invisible` at
              // mount commit, so the browser refuses focus) and the shell picks
              // this input up by `data-autofocus` once it is visible.
              autoFocus
              data-autofocus
            />
          </div>
        </div>
        {controls}
      </div>

      {loading && items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-12 text-[12px] text-fg-subtle">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span role="status">Loading…</span>
        </div>
      ) : (
        <VirtualList
          items={items}
          estimateSize={estimateSize}
          className="flex-1"
          getKey={getKey}
          renderRow={renderRow}
          emptyState={emptyState}
          onEndReached={onEndReached}
          footer={loadingMore ? (
            <div className="flex items-center justify-center gap-2 border-t border-line py-3 text-[11px] text-fg-subtle" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading more…
            </div>
          ) : undefined}
        />
      )}
    </div>
  )
}
