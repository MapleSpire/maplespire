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
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface StagedCatalogItem {
  /** Stable identity of the staged catalog entry, used as the removal key. */
  id: string
  label: string
  /** Rendered as a small leading swatch/mark when supplied (tag colour, tech icon). */
  mark?: ReactNode
}

/**
 * Footer tray for a picker in multi-select mode: what you have staged so far,
 * and the single commit that applies all of it.
 *
 * It stays mounted with an empty basket on purpose. The commit button is the
 * only thing that tells the user this picker no longer closes on the first
 * click, so hiding the tray until something is staged would hide exactly the
 * affordance that explains the mode.
 */
export function CatalogSelectionTray({
  items,
  onRemove,
  onClear,
  onCommit,
  onCancel,
  commitLabel,
  emptyHint,
  testId = 'catalog-selection-tray',
}: {
  items: readonly StagedCatalogItem[]
  onRemove: (id: string) => void
  onClear: () => void
  onCommit: () => void
  onCancel: () => void
  /** Commit verb for this catalog, already pluralised by the caller. */
  commitLabel: string
  emptyHint: string
  testId?: string
}) {
  const { t } = useTranslation()
  const count = items.length

  return (
    <div
      data-testid={testId}
      // surface-200 rather than the panel's own surface-100: a persistent
      // commit bar is an inset, and a 1px hairline was the only thing telling
      // it apart from the rows above.
      className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface-200 px-4 py-3"
    >
      {count > 0 ? (
        // min-h-7 matches the empty hint's height below, so landing the first
        // chip does not grow the tray upward and shrink the virtualized list
        // out from under the pointer mid-selection.
        <div className="flex max-h-24 min-h-7 flex-wrap items-center gap-1.5 overflow-y-auto">
          {items.map((item) => (
            <span
              key={item.id}
              data-testid={`staged-${item.id}`}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-50 px-2 text-[11px] font-medium text-fg-secondary"
            >
              {item.mark}
              <span className="truncate">{item.label}</span>
              <button
                type="button"
                onClick={() => onRemove(item.id)}
                aria-label={t('misc.catalogTray.remove', { value: item.label })}
                title={t('misc.catalogTray.remove', { value: item.label })}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-error-bg hover:text-error-text"
              >
                <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="flex h-7 items-center text-[11px] text-fg-subtle">{emptyHint}</p>
      )}

      <div className="flex items-center gap-2">
        {/* Mono is for the figure only — "IDs and counts render in JetBrains
            Mono" is a rule about numerals, not about the sentence carrying
            them. aria-live because toggling a row changes this total and the
            commit label with nothing else announcing it. */}
        <span
          data-testid="staged-count"
          aria-live="polite"
          className="text-[11px] text-fg-subtle"
        >
          <span className="font-mono tabular-nums">{count}</span>{' '}
          {t('misc.catalogTray.selectedLabel', { count })}
        </span>
        {count > 0 && (
          <button
            type="button"
            data-testid="clear-staged"
            onClick={onClear}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-fg-secondary transition-colors hover:bg-surface-200"
          >
            {t('misc.catalogTray.clear')}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto inline-flex h-8 items-center rounded-lg px-3 text-[11px] font-semibold text-fg-secondary transition-colors hover:bg-surface-hover"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          data-testid="commit-staged"
          onClick={onCommit}
          disabled={count === 0}
          // Not `disabled:opacity-45` (the house convention elsewhere): this
          // control ships disabled on every open rather than transiently, and
          // fading the whole element takes the accent fill and its white label
          // down together — 1.6:1, with the ghost Cancel beside it at 7.8:1,
          // so the modal's loudest control became "cancel". Recolour instead.
          className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[11px] font-semibold text-accent-text transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-surface-300 disabled:text-fg-secondary"
        >
          {commitLabel}
        </button>
      </div>
    </div>
  )
}
