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
import { useAuthStore } from '../../stores/authStore'
import { useModelStore } from '../../stores/modelStore'
import { resolveCatalogTags, tagSnapshotFromCatalog } from '../../lib/tags/api'
import type { TagSnapshot } from '../../types'
import { TagCatalogPicker } from './TagCatalogPicker'

interface TagPickerProps {
  /** Stable canonical Tag ids currently assigned to the object/group. */
  assigned: string[]
  /** Routes to addTagToObject / addTagToGroup with its offline render fallback. */
  onAdd: (snapshot: TagSnapshot) => void
  /** Routes to removeTagFromObject / removeTagFromGroup. */
  onRemove: (tagId: string) => void
  /**
   * Commit a staged basket in ONE call. Replaying `onAdd` per tag is only safe
   * for a handler that mutates a live draft; a handler that PLANS a write from
   * the entities it captured reads the same pre-update state on every replay in
   * the tick, and each write clobbers the last. Supply this whenever `onAdd`
   * plans rather than mutates.
   */
  onAddMany?: (snapshots: TagSnapshot[]) => void
  disabled?: boolean
  /**
   * Multi-selection only: how many of `total` selected shapes carry each tag.
   *
   * Every chip then states its coverage — "5/5" as well as "1/5" — rather than
   * letting the ABSENCE of a badge carry the meaning "on all of them", which
   * nothing on screen would explain. Showing only the tags common to every shape
   * was the alternative, and it hides a partial tag from the remove button as
   * well as from the eye.
   *
   * Counts, not pre-formatted strings: the picker needs the numbers to name what
   * the remove button will actually do, and to work out which tags the catalog
   * may still offer.
   */
  coverage?: { total: number; countByTagId: ReadonlyMap<string, number> }
}

/** Assignment is idempotent per tag (see `assignTag`), so a staged basket
 * commits by replaying `onAdd` — no batch store action is needed. Technologies
 * are different: those must fold, because each write replaces the whole map. */

/**
 * Compact assignment chips backed by the shared, server-paged catalog picker.
 * The workspace registry is used only to render already-assigned snapshots;
 * selectable results never come from a full Automerge catalog scan.
 */
export function TagPicker({ assigned = [], onAdd, onAddMany, onRemove, disabled, coverage }: TagPickerProps) {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const registry = useModelStore((state) => state.tags)
  const rememberTagSnapshots = useModelStore((state) => state.rememberTagSnapshots)
  const [open, setOpen] = useState(false)
  const [resolvedById, setResolvedById] = useState<Map<string, TagSnapshot>>(new Map())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const snapshotById = useMemo(
    () => new Map(registry.map((snapshot) => [snapshot.tagId, snapshot])),
    [registry],
  )
  const missingIds = useMemo(
    () => [...new Set(assigned)].filter((tagId) => !snapshotById.has(tagId)).slice(0, 100),
    [assigned, snapshotById],
  )
  const missingKey = missingIds.join('\u0000')

  // A selective Automerge projection can expose an assignment before its small
  // offline snapshot collection arrives. Resolve only the assigned identities
  // (never scan the catalog), render the authoritative label, and repair the
  // workspace fallback for the next offline/session render when edits are allowed.
  useEffect(() => {
    if (!orgId || missingIds.length === 0) return
    const controller = new AbortController()
    void resolveCatalogTags(orgId, missingIds, controller.signal)
      .then((result) => {
        const recovered = result.resolved.map((entry) => ({
          ...tagSnapshotFromCatalog(entry.tag),
          // Existing assignments may intentionally retain a redirected stable id.
          // Keep the fallback keyed by that exact identity for offline rendering.
          tagId: entry.requestedId,
        }))
        if (recovered.length === 0) return
        setResolvedById((current) => {
          const next = new Map(current)
          for (const snapshot of recovered) next.set(snapshot.tagId, snapshot)
          return next
        })
        if (!disabled) rememberTagSnapshots(recovered)
      })
      .catch(() => {
        // Offline with no snapshot: keep an explicit unavailable state. Never
        // expose an internal stable id as if it were the user-facing Tag value.
      })
    return () => controller.abort()
    // missingKey is the stable dependency for the bounded identity set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, missingKey, orgId, rememberTagSnapshots])

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {assigned.length === 0 && !open && (
        <span className="text-[11px] text-fg-subtle">{t('misc.tagPicker.noTags')}</span>
      )}
      {assigned.map((tagId) => {
        const snapshot = snapshotById.get(tagId) ?? resolvedById.get(tagId)
        const unavailable = t('misc.tagPicker.unavailableTag')
        const name = snapshot?.value ?? unavailable
        const count = coverage?.countByTagId.get(tagId)
        const partial = coverage !== undefined && count !== undefined && count < coverage.total
        const label = snapshot ? `${snapshot.groupName} · ${snapshot.value}` : unavailable
        // The X writes one shape on a "1/5" chip and five on a "5/5" chip, and
        // this app has no undo — so the control names its own scope rather than
        // saying "Remove tag" for both.
        const removeLabel = count === undefined
          ? t('misc.tagPicker.removeTag')
          : t('misc.tagPicker.removeTagFrom', { tag: name, count })
        return (
          <span
            key={tagId}
            data-testid="tag-chip"
            data-partial={partial ? 'true' : undefined}
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-50 px-2 text-[11px] font-medium text-fg-secondary"
            title={count === undefined
              ? label
              : `${label} — ${t('misc.tagPicker.onShapes', { count, total: coverage!.total })}`}
          >
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-[2px]"
              style={{ backgroundColor: snapshot?.color ?? 'var(--color-fg-subtle)' }}
              aria-hidden="true"
            />
            <span className="truncate">{name}</span>
            {count !== undefined && (
              <span
                className={`shrink-0 rounded-sm px-1 tabular-nums text-[10px] font-semibold ${
                  partial ? 'bg-accent-subtle text-accent' : 'bg-surface-200 text-fg-subtle'
                }`}
              >
                {count}/{coverage!.total}
              </span>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => onRemove(tagId)}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text"
                title={removeLabel}
                aria-label={removeLabel}
              >
                <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            )}
          </span>
        )
      })}

      {!disabled && (
        <button
          ref={triggerRef}
          type="button"
          data-testid="tag-add"
          onClick={() => setOpen((current) => !current)}
          className="flex h-7 items-center gap-1 rounded-md bg-accent-subtle px-2 text-[11px] font-semibold text-accent transition-colors hover:bg-accent-subtle/70"
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('misc.tagPicker.addTag')}
        </button>
      )}

      {/* `assignedTagIds` is what the catalog GREYS OUT, so only the tags on
          EVERY selected shape may go in. Passing the union would disable a
          "1/5" tag — making the one action its badge invites, filling in the
          other four, impossible. */}
      <TagCatalogPicker
        isOpen={open}
        assignedTagIds={coverage
          ? assigned.filter((tagId) => coverage.countByTagId.get(tagId) === coverage.total)
          : assigned}
        triggerRef={triggerRef}
        onClose={() => setOpen(false)}
        onSelect={(snapshot) => onAdd(snapshot)}
        multiple
        onSelectMany={(snapshots) => (onAddMany ? onAddMany(snapshots) : snapshots.forEach(onAdd))}
        allowCreate={!disabled}
      />
    </div>
  )
}
