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

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useModelStore } from '../../stores/modelStore'
import { canonicalTagId } from '../../lib/tags/canonicalIds'
import { resolveCatalogTags, type CatalogTag } from '../../lib/tags/api'
import type { TagSnapshot } from '../../types'
import { TagCatalogPicker } from './TagCatalogPicker'

interface TagFilterSelectorProps {
  orgId: string | null
  selectedIds: readonly string[]
  onToggle: (tagId: string) => void
}

/** Shared Model Objects facet: selected values remain grouped and visible while
 * the complete 50k catalog stays behind the paged TagCatalogPicker. */
export function TagFilterSelector({ orgId, selectedIds, onToggle }: TagFilterSelectorProps) {
  const { t } = useTranslation()
  const snapshots = useModelStore((state) => state.tags)
  const [open, setOpen] = useState(false)
  const [resolved, setResolved] = useState<Map<string, CatalogTag>>(new Map())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selectionKey = [...new Set(selectedIds)].join('\u0000')

  useEffect(() => {
    if (!orgId || selectedIds.length === 0) return
    const controller = new AbortController()
    void resolveCatalogTags(orgId, [...new Set(selectedIds)].slice(0, 100), controller.signal)
      .then((result) => {
        setResolved((current) => {
          const next = new Map(current)
          for (const entry of result.resolved) {
            next.set(entry.requestedId, entry.tag)
            next.set(entry.canonicalTagId, entry.tag)
          }
          return next
        })
      })
      .catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, selectionKey])

  const snapshotById = useMemo(() => new Map(snapshots.map((snapshot) => [snapshot.tagId, snapshot])), [snapshots])
  const grouped = useMemo(() => {
    const result = new Map<string, Array<{ selectedId: string; snapshot: TagSnapshot }>>()
    for (const selectedId of [...new Set(selectedIds)].slice(0, 100)) {
      const catalog = resolved.get(selectedId)
      const snapshot = catalog ? {
        tagId: catalog.canonicalTagId || catalog.id,
        value: catalog.value,
        color: catalog.color,
        groupId: catalog.groupId,
        groupName: catalog.groupName,
        catalogRevision: catalog.version,
      } : snapshotById.get(selectedId) ?? {
        tagId: selectedId,
        value: selectedId,
        color: '#8A847C',
        groupId: 'unresolved',
        groupName: t('misc.tagPicker.unresolvedGroup'),
        catalogRevision: 1,
      }
      const entries = result.get(snapshot.groupName) ?? []
      entries.push({ selectedId, snapshot })
      result.set(snapshot.groupName, entries)
    }
    return [...result.entries()]
  }, [resolved, selectedIds, snapshotById, t])

  return (
    <div data-testid="model-tag-filter" className="space-y-2">
      {grouped.map(([groupName, entries]) => (
        <div key={groupName} className="rounded-lg border border-line-soft bg-surface-50/60 p-2">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-fg-subtle">{groupName}</div>
          <div className="flex flex-wrap gap-1.5">
            {entries.map(({ selectedId, snapshot }) => (
              <button
                key={selectedId}
                type="button"
                data-testid={`model-tag-filter-${selectedId}`}
                onClick={() => onToggle(selectedId)}
                className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-accent/35 bg-accent-subtle px-2.5 text-[11px] font-medium text-accent"
                title={t('misc.tagPicker.removeFilter', { value: snapshot.value })}
              >
                <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: snapshot.color }} aria-hidden="true" />
                <span className="truncate">{snapshot.value}</span>
                <X className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      ))}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={!orgId}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-50 px-3 text-[11px] font-semibold text-fg-secondary transition-colors hover:bg-surface-200 disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        {t('misc.tagPicker.browseFilters')}
      </button>

      <TagCatalogPicker
        isOpen={open}
        assignedTagIds={selectedIds}
        allowAssignedSelection
        closeOnSelect={false}
        triggerRef={triggerRef}
        title={t('misc.tagPicker.filterTitle')}
        onClose={() => setOpen(false)}
        onSelect={(snapshot) => {
          const existingId = selectedIds.find((selectedId) => canonicalTagId(selectedId) === snapshot.tagId)
          onToggle(existingId ?? snapshot.tagId)
        }}
      />
    </div>
  )
}
