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

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Info, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { IconDefinition, ShapeType } from '../../lib/techIcons'
import { getIconPage, getIconPacks } from '../../lib/icons/api'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { cn } from '../../lib/utils'
import { useThemeStore } from '../../stores/themeStore'
import { CatalogBrowser } from '../catalog/CatalogBrowser'

interface IconCatalogBrowserProps {
  currentIcon?: string
  shapeType?: ShapeType
  initialSearch?: string
  onSelect: (icon: IconDefinition) => void
  isIconDisabled?: (icon: IconDefinition) => boolean
  className?: string
}

const PAGE_SIZE = 50

function compatibilityWarning(icon: IconDefinition, shapeType: ShapeType): string | null {
  if (icon.compatibleWith.includes('all') || icon.compatibleWith.includes(shapeType)) return null
  return `Recommended for: ${icon.compatibleWith.join(', ')}`
}

/** Shared server-paginated + virtualized browser used by shapes and technologies. */
export function IconCatalogBrowser({
  currentIcon,
  shapeType,
  initialSearch = '',
  onSelect,
  isIconDisabled,
  className,
}: IconCatalogBrowserProps) {
  const { t } = useTranslation()
  const [search, setSearch] = useState(initialSearch)
  const [activePack, setActivePack] = useState('All')
  const [packs, setPacks] = useState<Array<{ name: string; iconCount: number }>>([])
  const [icons, setIcons] = useState<IconDefinition[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const requestGeneration = useRef(0)
  const debouncedSearch = useDebouncedValue(search)

  useEffect(() => {
    const controller = new AbortController()
    getIconPacks(controller.signal)
      .then(setPacks)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Icon packs unavailable')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    getIconPage({
      q: debouncedSearch || undefined,
      pack: activePack,
      limit: PAGE_SIZE,
      signal: controller.signal,
    }).then((page) => {
      if (generation !== requestGeneration.current) return
      setIcons(page.icons)
      setNextCursor(page.nextCursor)
    }).catch((cause) => {
      if (!controller.signal.aborted && generation === requestGeneration.current) {
        setIcons([])
        setNextCursor(null)
        setError(cause instanceof Error ? cause.message : 'Icon catalog unavailable')
      }
    }).finally(() => {
      if (generation === requestGeneration.current) setLoading(false)
    })
    return () => controller.abort()
  }, [activePack, debouncedSearch, retryToken])

  const loadMore = useCallback(() => {
    if (!nextCursor || loading || loadingMore) return
    const generation = requestGeneration.current
    setLoadingMore(true)
    getIconPage({
      q: debouncedSearch || undefined,
      pack: activePack,
      after: nextCursor,
      limit: PAGE_SIZE,
    }).then((page) => {
      if (generation !== requestGeneration.current) return
      setIcons((current) => {
        const known = new Set(current.map((icon) => icon.name))
        return [...current, ...page.icons.filter((icon) => !known.has(icon.name))]
      })
      setNextCursor(page.nextCursor)
    }).catch((cause) => {
      if (generation === requestGeneration.current) {
        setError(cause instanceof Error ? cause.message : 'Icon catalog unavailable')
      }
    }).finally(() => {
      if (generation === requestGeneration.current) setLoadingMore(false)
    })
  }, [activePack, debouncedSearch, loading, loadingMore, nextCursor])

  return (
    <CatalogBrowser
      className={className}
      items={icons}
      query={search}
      onQueryChange={setSearch}
      searchTestId="icon-search"
      searchLabel={t('misc.iconPicker.search')}
      searchPlaceholder={t('misc.iconPicker.search')}
      estimateSize={45}
      loading={loading}
      loadingMore={loadingMore}
      onEndReached={nextCursor ? loadMore : undefined}
      getKey={(icon) => icon.name}
      emptyState={(
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-[13px] text-fg-subtle">
          <span>{error || t('misc.iconPicker.noIconsFound')}</span>
          {error && (
            <button
              type="button"
              onClick={() => setRetryToken((value) => value + 1)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-100 px-3 py-1.5 text-[11px] font-medium text-fg-secondary hover:bg-surface-200"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {t('common.retry', { defaultValue: 'Retry' })}
            </button>
          )}
        </div>
      )}
      controls={(
        <div className="flex gap-1 overflow-x-auto border-t border-line px-4 py-2" aria-label={t('misc.iconPicker.packs', { defaultValue: 'Icon packs' })}>
          {[{ name: 'All', iconCount: 0 }, ...packs].map((pack) => (
            <button
              key={pack.name}
              type="button"
              aria-pressed={activePack === pack.name}
              onClick={() => setActivePack(pack.name)}
              className={cn(
                'whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-medium transition-colors',
                activePack === pack.name
                  ? 'bg-inverse text-on-inverse'
                  : 'bg-surface-200 text-fg-secondary hover:bg-surface-300',
              )}
            >
              {pack.name}
            </button>
          ))}
        </div>
      )}
      renderRow={(icon) => {
        const isSelected = currentIcon === icon.name
        const warning = shapeType ? compatibilityWarning(icon, shapeType) : null
        const disabled = isIconDisabled?.(icon) ?? false
        return (
          <button
            type="button"
            data-testid="icon-option"
            disabled={disabled}
            aria-label={icon.name}
            aria-pressed={isSelected}
            onClick={() => onSelect(icon)}
            className={cn(
              'flex w-full items-center gap-2 border-b border-line px-4 py-2.5 text-left transition-colors',
              isSelected ? 'bg-accent-subtle' : 'hover:bg-surface-50',
              disabled && 'cursor-not-allowed opacity-45',
            )}
          >
            <CatalogIconArtwork icon={icon} />
            <span data-testid="icon-name" className="min-w-0 flex-1 truncate text-[13px] text-fg">{icon.name}</span>
            {warning && (
              <span title={warning} aria-label={warning} className="shrink-0 cursor-help text-warning-text">
                <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              </span>
            )}
            {icon.info && (
              <span title={icon.info} aria-label={icon.info} className="shrink-0 cursor-help text-fg-subtle">
                <Info className="h-4 w-4" aria-hidden="true" />
              </span>
            )}
          </button>
        )
      }}
    />
  )
}

function CatalogIconArtwork({ icon }: { icon: IconDefinition }) {
  const theme = useThemeStore((state) => state.resolved)
  const path = theme === 'dark'
    ? icon.iconDark ?? icon.iconLight
    : icon.iconLight ?? icon.iconDark
  if (path) return <img src={path} alt="" loading="lazy" className="h-5 w-5 rounded object-contain" />
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-surface-300 text-[8px] font-bold text-fg-secondary">
      {icon.abbr}
    </span>
  )
}
