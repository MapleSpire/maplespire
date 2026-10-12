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

import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react'
import { FolderTree, Loader2, Plus, SlidersHorizontal, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../stores/authStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { canonicalTagId } from '../../lib/tags/canonicalIds'
import {
  createCatalogTag,
  listTagGroupPage,
  listTagPage,
  tagSnapshotFromCatalog,
  type CatalogTag,
  type CatalogTagGroup,
} from '../../lib/tags/api'
import type { TagSnapshot } from '../../types'
import { CatalogBrowser } from '../catalog/CatalogBrowser'
import { CatalogRowCheckbox } from '../catalog/CatalogRowCheckbox'
import { CatalogSelectionTray } from '../catalog/CatalogSelectionTray'
import { FloatingPicker } from '../ui/floating-picker'

interface TagCatalogPickerProps {
  isOpen: boolean
  assignedTagIds: readonly string[]
  onClose: () => void
  onSelect: (snapshot: TagSnapshot, tag: CatalogTag) => void
  triggerRef?: RefObject<HTMLElement | null>
  title?: string
  allowAssignedSelection?: boolean
  closeOnSelect?: boolean
  initialGroupId?: string | null
  allowCreate?: boolean
  /**
   * Stage several tags across several searches and commit them in one go.
   * Opt-in: the admin reconcile/merge flows and the perspective bar pick
   * exactly one tag. Requires `onSelectMany`; when set it supersedes
   * `closeOnSelect`, since the tray's commit button owns closing.
   */
  multiple?: boolean
  onSelectMany?: (snapshots: TagSnapshot[], tags: CatalogTag[]) => void
}

function mergeUnique<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) merged.set(item.id, item)
  return [...merged.values()]
}

export function TagCatalogPicker({
  isOpen,
  assignedTagIds,
  onClose,
  onSelect,
  triggerRef,
  title,
  allowAssignedSelection = false,
  closeOnSelect = true,
  initialGroupId = null,
  allowCreate = false,
  multiple = false,
  onSelectMany,
}: TagCatalogPickerProps) {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const workspace = useWorkspaceStore((state) => state.ref)
  const [staged, setStaged] = useState<CatalogTag[]>([])
  const [openedWith, setOpenedWith] = useState(isOpen)
  const [query, setQuery] = useState('')
  const [groupId, setGroupId] = useState('')
  const [groups, setGroups] = useState<CatalogTagGroup[]>([])
  const [tags, setTags] = useState<CatalogTag[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [offline, setOffline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createColor, setCreateColor] = useState('#D97706')
  const [creating, setCreating] = useState(false)
  const assigned = useMemo(
    () => new Set(assignedTagIds.map(canonicalTagId)),
    [assignedTagIds],
  )
  const multiSelect = multiple && Boolean(onSelectMany)
  const stagedIds = useMemo(
    () => new Set(staged.map((tag) => canonicalTagId(tag.canonicalTagId || tag.id))),
    [staged],
  )

  // The basket is discarded during render, not from the effect below: an
  // effect runs after commit, so reopening the picker on another object would
  // paint one frame still offering to commit the previous object's chips.
  if (openedWith !== isOpen) {
    setOpenedWith(isOpen)
    if (staged.length > 0) setStaged([])
  }

  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setGroupId(initialGroupId ?? '')
  }, [initialGroupId, isOpen])

  useEffect(() => {
    if (!isOpen || !orgId) return
    const controller = new AbortController()
    void listTagGroupPage(orgId, { status: 'active', limit: 100 }, controller.signal)
      .then((page) => setGroups(page.items))
      .catch(() => {
        if (!controller.signal.aborted) setGroups([])
      })
    return () => controller.abort()
  }, [isOpen, orgId])

  useEffect(() => {
    if (!isOpen || !orgId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setTags([])
      setNextCursor(null)
      setLoading(true)
      setError(null)
      void listTagPage(orgId, {
        query,
        groupIds: groupId ? [groupId] : undefined,
        status: 'active',
      }, controller.signal)
        .then((page) => {
          setTags(page.items)
          setNextCursor(page.nextCursor)
          setOffline(page.source === 'cache')
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setTags([])
            setOffline(false)
            setError(cause instanceof Error ? cause.message : t('misc.tagPicker.catalogUnavailable'))
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [groupId, isOpen, orgId, query, t])

  const loadMore = useCallback(() => {
    if (!orgId || !nextCursor || loading || loadingMore) return
    setLoadingMore(true)
    void listTagPage(orgId, {
      query,
      groupIds: groupId ? [groupId] : undefined,
      status: 'active',
      after: nextCursor,
    })
      .then((page) => {
        setTags((current) => mergeUnique(current, page.items))
        setNextCursor(page.nextCursor)
        setOffline(page.source === 'cache')
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('misc.tagPicker.catalogUnavailable')))
      .finally(() => setLoadingMore(false))
  }, [groupId, loading, loadingMore, nextCursor, orgId, query, t])

  if (!isOpen) return null

  const displayError = !orgId ? t('misc.tagPicker.orgRequired') : error
  const selectedGroup = groups.find((group) => group.id === groupId) ?? null
  const createValue = query.trim()
  /**
   * Offer to create the typed value unless it already exists.
   *
   * Rendered outside the list's `emptyState` (which `VirtualList` shows only
   * when `items.length === 0`): searching "Prod" in a catalog holding
   * "Production-EU" returns a row, and the user must still be able to create
   * "Prod".
   *
   * The exact-match test is what keeps it from being noise — it hides only when
   * the thing the user typed genuinely exists.
   */
  const exactMatchExists = tags.some(
    (tag) => tag.value.trim().toLowerCase() === createValue.toLowerCase(),
  )
  const canOfferCreate = allowCreate && createValue.length > 0 && !exactMatchExists
  const createFromSearch = async () => {
    if (!orgId || !selectedGroup || !createValue || creating) return
    setCreating(true)
    setError(null)
    try {
      const tag = await createCatalogTag(orgId, {
        groupId: selectedGroup.id,
        value: createValue,
        color: createColor.toUpperCase(),
        workspace,
      })
      setTags((current) => mergeUnique(current, [tag]))
      // A tag created mid-basket joins the basket. Committing it on its own
      // would close the picker and silently drop everything already staged.
      if (multiSelect) {
        setStaged((current) => (
          current.some((entry) => entry.id === tag.id) ? current : [...current, tag]
        ))
        return
      }
      onSelect(tagSnapshotFromCatalog(tag), tag)
      if (closeOnSelect) onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('misc.tagPicker.createFailed'))
    } finally {
      setCreating(false)
    }
  }
  const controls = (
    <div className="border-t border-line px-4 pb-3 pt-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        {t('misc.tagPicker.filters')}
        {groupId && (
          <button
            type="button"
            onClick={() => setGroupId('')}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] normal-case tracking-normal text-fg-secondary hover:bg-surface-200"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            {t('misc.tagPicker.clearFilters')}
          </button>
        )}
      </div>
      <label className="relative block">
        <FolderTree className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <span className="sr-only">{t('misc.tagPicker.groupFilter')}</span>
        <select
          data-testid="tag-group-filter"
          aria-label={t('misc.tagPicker.groupFilter')}
          value={groupId}
          onChange={(event) => setGroupId(event.target.value)}
          className="h-8 w-full appearance-none rounded-lg border border-line bg-surface-50 pl-8 pr-8 text-[11px] font-medium text-fg-secondary outline-none transition-colors hover:bg-surface-100 focus:border-accent focus:ring-1 focus:ring-accent"
        >
          <option value="">{t('misc.tagPicker.allGroups')}</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </label>
      {offline && <p className="mt-2 text-[10px] text-warning-text">{t('misc.tagPicker.offlineCache')}</p>}
    </div>
  )

  return (
    <FloatingPicker
      isOpen={isOpen}
      title={title ?? t('misc.tagPicker.chooseTag')}
      onClose={onClose}
      triggerRef={triggerRef}
      testId="tag-catalog-picker"
      className="h-[min(68vh,620px)] min-h-[400px] w-[min(560px,calc(100vw-32px))]"
    >
      {displayError ? (
        <p className="m-4 rounded-lg border border-error-border bg-error-bg p-4 text-[12px] text-error-text">{displayError}</p>
      ) : (
        <>
        <CatalogBrowser
          items={tags}
          query={query}
          onQueryChange={setQuery}
          searchTestId="tag-catalog-search"
          searchLabel={t('misc.tagPicker.search')}
          searchPlaceholder={t('misc.tagPicker.searchCatalog')}
          controls={controls}
          loading={loading}
          loadingMore={loadingMore}
          onEndReached={loadMore}
          estimateSize={48}
          getKey={(tag) => tag.id}
          emptyState={(
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-10 text-center text-[12px] text-fg-subtle">
              <span>{t('misc.tagPicker.noCatalogTags')}</span>
            </div>
          )}
          renderRow={(tag) => {
            const canonicalId = canonicalTagId(tag.canonicalTagId || tag.id)
            const alreadyAssigned = assigned.has(canonicalId)
            const isStaged = stagedIds.has(canonicalId)
            return (
              <button
                type="button"
                data-testid={`tag-option-${tag.id}`}
                disabled={alreadyAssigned && !allowAssignedSelection}
                {...(multiSelect ? { 'aria-pressed': isStaged } : {})}
                onClick={() => {
                  if (multiSelect) {
                    setStaged((current) => (
                      current.some((entry) => canonicalTagId(entry.canonicalTagId || entry.id) === canonicalId)
                        ? current.filter((entry) => canonicalTagId(entry.canonicalTagId || entry.id) !== canonicalId)
                        : [...current, tag]
                    ))
                    return
                  }
                  onSelect(tagSnapshotFromCatalog(tag), tag)
                  if (closeOnSelect) onClose()
                }}
                className="flex h-12 w-full items-center gap-3 border-b border-line px-4 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
              >
                {multiSelect && <CatalogRowCheckbox checked={isStaged} />}
                <span
                  className="h-3 w-3 shrink-0 rounded-[3px] border border-black/10 shadow-xs"
                  style={{ backgroundColor: tag.color }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-fg">{tag.value}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-fg-subtle">{tag.groupName}</span>
                </span>
                {alreadyAssigned && <span className="text-[10px] font-semibold text-fg-subtle">{t('misc.tagPicker.assigned')}</span>}
              </button>
            )
          }}
        />
        {/* Always reachable, not only when the list came back empty. */}
        {canOfferCreate && !selectedGroup && (
          <div className="border-t border-line px-4 py-2 text-[11px] text-fg-secondary">
            {t('misc.tagPicker.selectGroupToCreate')}
          </div>
        )}
        {canOfferCreate && selectedGroup && (
          <div className="flex items-center gap-2 border-t border-line bg-accent-subtle px-3 py-2 text-left">
            <input
              type="color"
              value={createColor}
              onChange={(event) => setCreateColor(event.target.value)}
              aria-label={t('misc.tagPicker.newTagColor')}
              className="h-8 w-8 shrink-0 rounded-md border border-line bg-transparent p-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-semibold text-fg">{createValue}</span>
              <span className="block truncate text-[10px] text-fg-subtle">{selectedGroup.name}</span>
            </span>
            <button
              type="button"
              data-testid="create-tag-from-search"
              onClick={() => void createFromSearch()}
              disabled={creating}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-accent-text disabled:opacity-45"
            >
              {creating ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
              {t('misc.tagPicker.createTag')}
            </button>
          </div>
        )}
        {multiSelect && (
          <CatalogSelectionTray
            testId="tag-selection-tray"
            items={staged.map((tag) => ({
              id: tag.id,
              label: tag.value,
              mark: (
                <span
                  className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
                  style={{ backgroundColor: tag.color }}
                  aria-hidden="true"
                />
              ),
            }))}
            onRemove={(id) => setStaged((current) => current.filter((entry) => entry.id !== id))}
            onClear={() => setStaged([])}
            onCommit={() => {
              if (staged.length === 0) return
              onSelectMany?.(staged.map(tagSnapshotFromCatalog), staged)
              setStaged([])
              onClose()
            }}
            onCancel={onClose}
            commitLabel={t('misc.tagPicker.addSelectedTags', {
              count: staged.length,
              defaultValue_zero: 'Add tags',
              defaultValue_one: 'Add tag',
              defaultValue_other: 'Add {{count}} tags',
            })}
            emptyHint={t('misc.tagPicker.stageHint', {
              defaultValue: 'Pick as many tags as you need, then add them all at once.',
            })}
          />
        )}
        </>
      )}
    </FloatingPicker>
  )
}
