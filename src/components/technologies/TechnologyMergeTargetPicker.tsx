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

import { useEffect, useId, useRef, useState } from 'react'
import { Check, Loader2, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { OrgTechnology } from '../../lib/orgAdmin/api'
import { cn } from '../../lib/utils'
import { TechIconBadge } from '../shared/TechIconBadge'

interface TechnologyMergeTargetPickerProps {
  sourceTechnologyId: string
  value: OrgTechnology | null
  onChange: (technology: OrgTechnology | null) => void
  search: (query: string) => Promise<{ matches: OrgTechnology[] }>
  disabled?: boolean
  targetFilter?: (technology: OrgTechnology) => boolean
  label?: string
  placeholder?: string
  testId?: string
}

/**
 * Server-backed target autocomplete used by every identity/content merge.
 * It intentionally never materializes the catalog: each keystroke requests a
 * bounded, indexed name/alias result page and stale responses are discarded.
 */
export function TechnologyMergeTargetPicker({
  sourceTechnologyId,
  value,
  onChange,
  search,
  disabled = false,
  targetFilter,
  label,
  placeholder,
  testId = 'technology-merge-target-search',
}: TechnologyMergeTargetPickerProps) {
  const { t } = useTranslation()
  const listboxId = useId()
  const requestIdRef = useRef(0)
  const [query, setQuery] = useState(value?.revision.name ?? '')
  const [matches, setMatches] = useState<OrgTechnology[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    const normalized = query.trim()
    if (value || normalized.length < 2) return
    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(false)
      void search(normalized)
        .then((result) => {
          if (requestId !== requestIdRef.current) return
          setMatches(result.matches.filter((technology) => (
            technology.id !== sourceTechnologyId
            && technology.lifecycleStatus !== 'merged'
            && (!targetFilter || targetFilter(technology))
          )))
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return
          setMatches([])
          setError(true)
        })
        .finally(() => {
          if (requestId === requestIdRef.current) setLoading(false)
        })
    }, 180)
    return () => {
      window.clearTimeout(timer)
      requestIdRef.current += 1
    }
  }, [query, search, sourceTechnologyId, targetFilter, value])

  const inputLabel = label ?? t('admin.technologies.mergeTargetLabel', { defaultValue: 'Merge into' })
  const inputPlaceholder = placeholder ?? t('admin.technologies.mergeTargetPlaceholder', {
    defaultValue: 'Search by technology name or alias',
  })
  const showResults = !value && query.trim().length >= 2 && !loading && !error

  return (
    <div className="relative">
      <label className="mb-1.5 block text-[11px] font-semibold text-fg-secondary" htmlFor={`${listboxId}-input`}>
        {inputLabel}
      </label>
      <div className={cn(
        'flex min-h-9 items-center gap-2 rounded-lg border bg-surface-50 px-2.5 transition-colors',
        value ? 'border-accent/40' : 'border-line focus-within:border-accent focus-within:ring-1 focus-within:ring-accent',
        disabled && 'opacity-50',
      )}>
        {value ? (
          <TechIconBadge
            name={value.revision.name}
            iconLightPath={value.revision.iconLightPath ?? undefined}
            iconDarkPath={value.revision.iconDarkPath ?? undefined}
            size="sm"
          />
        ) : loading ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-subtle" aria-hidden="true" />
        ) : (
          <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
        )}
        <input
          id={`${listboxId}-input`}
          data-testid={testId}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={showResults && matches.length > 0}
          disabled={disabled || Boolean(value)}
          value={value?.revision.name ?? query}
          onChange={(event) => {
            setQuery(event.target.value)
            setMatches([])
            setLoading(false)
            setError(false)
          }}
          placeholder={inputPlaceholder}
          className="h-8 min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-subtle disabled:opacity-100"
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setQuery('')
              setMatches([])
              setLoading(false)
              setError(false)
            }}
            aria-label={t('admin.technologies.clearMergeTarget', { defaultValue: 'Clear merge target' })}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-200 hover:text-fg"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {error && (
        <p className="mt-1.5 text-[10.5px] text-error-text">
          {t('admin.technologies.mergeSearchFailed', { defaultValue: 'Technology search failed.' })}
        </p>
      )}
      {showResults && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface-100 p-1.5 shadow-xl"
        >
          {matches.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-fg-subtle">
              {t('admin.technologies.noMergeTargets', { defaultValue: 'No matching technology found.' })}
            </div>
          ) : matches.map((technology) => (
            <button
              key={technology.id}
              type="button"
              role="option"
              aria-selected="false"
              data-testid={`technology-merge-target-${technology.id}`}
              onClick={() => onChange(technology)}
              className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-50">
                <TechIconBadge
                  name={technology.revision.name}
                  iconLightPath={technology.revision.iconLightPath ?? undefined}
                  iconDarkPath={technology.revision.iconDarkPath ?? undefined}
                  size="sm"
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[12px] font-semibold text-fg">{technology.revision.name}</span>
                  <span className="shrink-0 rounded-full bg-surface-200 px-1.5 py-0.5 text-[9px] font-semibold text-fg-subtle">
                    {technology.scope === 'public'
                      ? t('admin.technologies.public')
                      : t('admin.technologies.private')}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-fg-subtle">
                  {technology.revision.aliases.length > 0
                    ? technology.revision.aliases.join(', ')
                    : technology.revision.category || technology.id}
                </span>
              </span>
              <Check className="h-3.5 w-3.5 shrink-0 text-accent opacity-0 group-hover:opacity-100" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
