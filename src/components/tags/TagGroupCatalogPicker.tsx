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

import { useCallback, useEffect, useState, type RefObject } from 'react'
import { FolderTree } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import { listTagGroupPage, type CatalogTagGroup } from '../../lib/tags/api'
import { CatalogBrowser } from '../catalog/CatalogBrowser'
import { FloatingPicker } from '../ui/floating-picker'

interface TagGroupCatalogPickerProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (group: CatalogTagGroup) => void
  triggerRef?: RefObject<HTMLElement | null>
  title: string
}

function mergeUnique(current: readonly CatalogTagGroup[], incoming: readonly CatalogTagGroup[]): CatalogTagGroup[] {
  const merged = new Map(current.map((group) => [group.id, group]))
  for (const group of incoming) merged.set(group.id, group)
  return [...merged.values()]
}

/** Server-paged, virtualized Tag Group selector used by governed reconciliation. */
export function TagGroupCatalogPicker({
  isOpen,
  onClose,
  onSelect,
  triggerRef,
  title,
}: TagGroupCatalogPickerProps) {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<CatalogTagGroup[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !orgId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      setGroups([])
      setNextCursor(null)
      void listTagGroupPage(orgId, { query, status: 'active' }, controller.signal)
        .then((page) => {
          setGroups(page.items)
          setNextCursor(page.nextCursor)
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('admin.tags.loadFailed'))
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [isOpen, orgId, query, t])

  const loadMore = useCallback(() => {
    if (!orgId || !nextCursor || loading || loadingMore) return
    setLoadingMore(true)
    void listTagGroupPage(orgId, { query, status: 'active', after: nextCursor })
      .then((page) => {
        setGroups((current) => mergeUnique(current, page.items))
        setNextCursor(page.nextCursor)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('admin.tags.loadFailed')))
      .finally(() => setLoadingMore(false))
  }, [loading, loadingMore, nextCursor, orgId, query, t])

  if (!isOpen) return null

  return (
    <FloatingPicker
      isOpen={isOpen}
      title={title}
      onClose={onClose}
      triggerRef={triggerRef}
      testId="tag-group-catalog-picker"
      className="h-[min(62vh,540px)] min-h-[340px] w-[min(500px,calc(100vw-32px))]"
    >
      {!orgId || error ? (
        <p className="m-4 rounded-lg border border-error-border bg-error-bg p-4 text-[12px] text-error-text">
          {error ?? t('misc.tagPicker.orgRequired')}
        </p>
      ) : (
        <CatalogBrowser
          items={groups}
          query={query}
          onQueryChange={setQuery}
          searchTestId="tag-group-catalog-search"
          searchLabel={t('admin.tags.outbox.searchGroups')}
          searchPlaceholder={t('admin.tags.outbox.searchGroups')}
          loading={loading}
          loadingMore={loadingMore}
          onEndReached={loadMore}
          estimateSize={52}
          getKey={(group) => group.id}
          emptyState={(
            <div className="flex flex-1 items-center justify-center px-5 py-10 text-center text-[12px] text-fg-subtle">
              {t('admin.tags.outbox.noMatchingGroups')}
            </div>
          )}
          renderRow={(group) => (
            <button
              type="button"
              data-testid={`tag-group-option-${group.id}`}
              onClick={() => {
                onSelect(group)
                onClose()
              }}
              className="flex h-[52px] w-full items-center gap-3 border-b border-line px-4 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-200 text-fg-secondary">
                <FolderTree className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold text-fg">{group.name}</span>
                <span className="mt-0.5 block truncate text-[10px] text-fg-subtle">
                  {group.description || t('admin.tags.outbox.tagCount', { count: group.tagCount ?? 0 })}
                </span>
              </span>
            </button>
          )}
        />
      )}
    </FloatingPicker>
  )
}
