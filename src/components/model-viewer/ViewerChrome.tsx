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

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Home, Settings2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ModelViewerOptions } from '../../stores/uiStore'
import { levelKind, type ParentId, type ViewerModel } from '../../lib/modelViewer/levels'

/** Floating breadcrumb (bottom-left of the plane): Landscape ▸ … ▸ current,
 * with the current C4 level as a chip. Click a crumb to zoom back out. */
export function ViewerBreadcrumb({
  model,
  path,
  onGo,
}: {
  model: ViewerModel
  path: string[]
  onGo: (path: string[]) => void
}) {
  const { t } = useTranslation()
  const cur: ParentId = path.length ? path[path.length - 1] : null
  const items: { id: ParentId; name: string }[] = [
    { id: null, name: t('modelViewer.breadcrumb.root') },
    ...path.map((id) => ({ id: id as ParentId, name: model.objectById.get(id)?.name ?? id })),
  ]
  return (
    <div
      data-testid="mv-breadcrumb"
      className="absolute bottom-4 z-30 transition-[left] duration-300"
      style={{ left: 'var(--pad-l)' }}
    >
      <div className="flex max-w-[min(72vw,660px)] items-center gap-px rounded-xl border border-line bg-surface-100 py-1 pl-1.5 pr-1.5 shadow-lg">
        {items.map((item, idx) => {
          const last = idx === items.length - 1
          return (
            <span key={idx} className="flex min-w-0 items-center">
              {idx > 0 && <ChevronRight className="h-[13px] w-[13px] shrink-0 text-fg-subtle" />}
              <button
                data-testid={last ? 'mv-crumb-current' : 'mv-crumb'}
                title={item.name}
                disabled={last}
                onClick={() => onGo(path.slice(0, idx))}
                className={cn(
                  'max-w-[180px] truncate whitespace-nowrap rounded-lg px-2 py-1 text-[12.5px]',
                  last
                    ? 'font-semibold text-fg'
                    : 'cursor-pointer text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg'
                )}
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {idx === 0 && <Home className="h-[13px] w-[13px] shrink-0" />}
                  <span className="truncate">{item.name}</span>
                </span>
              </button>
            </span>
          )
        })}
        <span
          data-testid="mv-level"
          className="ml-1 shrink-0 rounded-md bg-accent-subtle px-2 py-1 font-mono text-[9.5px] font-semibold uppercase tracking-wide text-accent"
        >
          {t(`modelViewer.breadcrumb.level.${levelKind(model, cur)}`)}
        </span>
      </div>
    </div>
  )
}

function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-line" role="group">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            'px-2.5 py-1 text-[11.5px] font-medium transition-colors',
            value === v ? 'bg-accent-subtle text-accent' : 'bg-surface-100 text-fg-secondary hover:bg-surface-50'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function OptRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-[12.5px] text-fg-secondary">
      <span>{label}</span>
      {children}
    </div>
  )
}

function OptLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle first:pt-1">
      {children}
    </div>
  )
}

/** Bottom-right "View" options: routing / density / descriptions / empty
 * objects / zoom speed. Positioned by its host row (ViewerGrid renders it
 * beside the zoom cluster). */
export function ViewerBottomControls({
  opts,
  setOpts,
}: {
  opts: ModelViewerOptions
  setOpts: (patch: Partial<ModelViewerOptions>) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef}>
      <div className="relative flex items-center rounded-xl border border-line bg-surface-100 p-1 shadow-lg">
        <button
          data-testid="mv-view-options"
          onClick={() => setOpen(!open)}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors',
            open ? 'bg-accent-subtle text-accent' : 'text-fg-secondary hover:bg-surface-hover hover:text-fg'
          )}
        >
          <Settings2 className="h-[15px] w-[15px]" />
          {t('modelViewer.view.button')}
        </button>
        {open && (
          <div className="absolute bottom-full right-0 mb-2.5 w-[264px] rounded-lg border border-line bg-surface-100 p-2 shadow-xl">
            <OptLabel>{t('modelViewer.view.connections')}</OptLabel>
            <OptRow label={t('modelViewer.view.routing')}>
              <Seg
                value={opts.routing}
                onChange={(v) => setOpts({ routing: v })}
                options={[
                  ['curved', t('modelViewer.view.routingCurved')],
                  ['orthogonal', t('modelViewer.view.routingOrthogonal')],
                  ['straight', t('modelViewer.view.routingStraight')],
                ]}
              />
            </OptRow>
            <OptLabel>{t('modelViewer.view.layout')}</OptLabel>
            <OptRow label={t('modelViewer.view.density')}>
              <Seg
                value={opts.density}
                onChange={(v) => setOpts({ density: v })}
                options={[
                  ['comfortable', t('modelViewer.view.densityComfortable')],
                  ['compact', t('modelViewer.view.densityCompact')],
                ]}
              />
            </OptRow>
            <OptRow label={t('modelViewer.view.descriptions')}>
              <Seg
                value={opts.minimal ? 'off' : 'on'}
                onChange={(v) => setOpts({ minimal: v === 'off' })}
                options={[
                  ['on', t('modelViewer.view.on')],
                  ['off', t('modelViewer.view.off')],
                ]}
              />
            </OptRow>
            <OptRow label={t('modelViewer.view.emptyObjects')}>
              <Seg
                value={opts.showEmpty ? 'show' : 'hide'}
                onChange={(v) => setOpts({ showEmpty: v === 'show' })}
                options={[
                  ['show', t('modelViewer.view.show')],
                  ['hide', t('modelViewer.view.hide')],
                ]}
              />
            </OptRow>
            <OptLabel>{t('modelViewer.view.motion')}</OptLabel>
            <OptRow label={t('modelViewer.view.zoomSpeed')}>
              <span className="flex items-center gap-2">
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={opts.speed}
                  onChange={(e) => setOpts({ speed: parseFloat(e.target.value) })}
                  className="w-[104px] cursor-pointer accent-[var(--color-accent)]"
                />
                <span className="w-8 text-right font-mono text-[11px] text-fg-subtle">{opts.speed.toFixed(1)}×</span>
              </span>
            </OptRow>
          </div>
        )}
      </div>
    </div>
  )
}
