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
import { Sprout } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useModelStore } from '../../stores/modelStore'
import { DECOR_PACKS } from '../../canvas3d/decor/registry'
import { BACKGROUNDS_3D, BOARD_STYLES_3D } from '../../canvas3d/decor/decorSpec'
import type { SceneDecor3D } from '../../canvas3d/decor/decorSpec'

/**
 * "Decorate scene" — the 3D chrome popover choosing the diagram's decoration
 * pack + density, plus the tray (board style) and background
 * as independent free choices. Writes the SHARED `Diagram.sceneDecor` through
 * the dedicated store action, so the whole team (and share viewers) see the
 * same dressed board live. 'default' tray/background means the theme's own
 * look and is persisted by OMITTING the key (never an explicit value).
 */
export function DecorPopover({ diagramId }: { diagramId: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneDecor = useModelStore(
    (s) => s.diagrams.find((d) => d.id === diagramId)?.sceneDecor,
  ) as SceneDecor3D | undefined
  const setDiagramSceneDecor = useModelStore((s) => s.setDiagramSceneDecor)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const density = sceneDecor?.density ?? 'normal'
  // A decor doc must carry at least one of the three free choices — an empty
  // husk is cleared to null so the doc field disappears entirely.
  const commit = (next: SceneDecor3D) => {
    const meaningful =
      next.packId !== undefined || next.boardStyle !== undefined || next.background !== undefined
    setDiagramSceneDecor(diagramId, meaningful ? next : null)
  }
  const pick = (packId: string | null) => {
    // picking a pack closes the popover — the board is the feedback; density
    // and shuffle keep it open for quick tuning
    setOpen(false)
    if (!packId) {
      // 'None' removes ONLY the pack — tray/background choices survive
      const next: SceneDecor3D = { ...(sceneDecor ?? {}) }
      delete next.packId
      commit(next)
      return
    }
    setDiagramSceneDecor(diagramId, { ...(sceneDecor ?? {}), packId, density })
  }
  const pickBoard = (style: (typeof BOARD_STYLES_3D)[number]) => {
    const next: SceneDecor3D = { ...(sceneDecor ?? {}) }
    if (style === 'default') delete next.boardStyle
    else next.boardStyle = style
    commit(next)
  }
  const pickBackground = (bg: (typeof BACKGROUNDS_3D)[number]) => {
    const next: SceneDecor3D = { ...(sceneDecor ?? {}) }
    if (bg === 'default') delete next.background
    else next.background = bg
    commit(next)
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        data-testid="decor-open"
        onClick={() => setOpen((v) => !v)}
        title={t('view3d.decor.button')}
        aria-pressed={open}
        className={cn(
          'ml-0.5 flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold',
          sceneDecor ? 'text-accent' : 'text-fg-secondary',
          'hover:bg-surface-50',
        )}
      >
        <Sprout className="h-3.5 w-3.5" />
        {t('view3d.decor.button')}
      </button>
      {open && (
        <div
          data-testid="decor-popover"
          className="absolute bottom-10 right-0 w-72 rounded-xl border border-line bg-surface-100 p-3 shadow-lg"
        >
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('view3d.decor.title')}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              data-testid="decor-pack-none"
              onClick={() => pick(null)}
              className={cn(
                'rounded-lg border px-2.5 py-2 text-left text-[12px] transition-all',
                !sceneDecor?.packId
                  ? 'border-accent bg-accent-subtle ring-1 ring-accent'
                  : 'border-line bg-surface-100 hover:bg-surface-50',
              )}
            >
              {t('view3d.decor.pack.none')}
            </button>
            {DECOR_PACKS.map((pack) => (
              <button
                key={pack.id}
                data-testid={`decor-pack-${pack.id}`}
                onClick={() => pick(pack.id)}
                className={cn(
                  'rounded-lg border px-2.5 py-2 text-left text-[12px] transition-all',
                  sceneDecor?.packId === pack.id
                    ? 'border-accent bg-accent-subtle ring-1 ring-accent'
                    : 'border-line bg-surface-100 hover:bg-surface-50',
                )}
              >
                {t(pack.nameKey)}
              </button>
            ))}
          </div>
          <div className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('view3d.decor.boardLabel')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {BOARD_STYLES_3D.map((style) => (
              <button
                key={style}
                data-testid={`decor-board-${style}`}
                onClick={() => pickBoard(style)}
                className={cn(
                  'rounded-lg border px-2 py-1 text-[12px] transition-all',
                  (sceneDecor?.boardStyle ?? 'default') === style
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-line bg-surface-100 text-fg-secondary hover:bg-surface-50',
                )}
              >
                {t(`view3d.decor.board.${style}`)}
              </button>
            ))}
          </div>
          <div className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {t('view3d.decor.bgLabel')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {BACKGROUNDS_3D.map((bg) => (
              <button
                key={bg}
                data-testid={`decor-bg-${bg}`}
                onClick={() => pickBackground(bg)}
                className={cn(
                  'rounded-lg border px-2 py-1 text-[12px] transition-all',
                  (sceneDecor?.background ?? 'default') === bg
                    ? 'border-accent bg-accent-subtle text-accent'
                    : 'border-line bg-surface-100 text-fg-secondary hover:bg-surface-50',
                )}
              >
                {t(`view3d.decor.bg.${bg}`)}
              </button>
            ))}
          </div>
          {sceneDecor?.packId && (
            <>
              <div className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                {t('view3d.decor.densityLabel')}
              </div>
              <div className="flex overflow-hidden rounded-lg border border-line">
                {(['sparse', 'normal', 'rich'] as const).map((d, i) => (
                  <button
                    key={d}
                    data-testid={`decor-density-${d}`}
                    onClick={() => setDiagramSceneDecor(diagramId, { ...sceneDecor, density: d })}
                    className={cn(
                      'flex-1 px-2 py-1.5 text-[12px] transition-colors',
                      i > 0 && 'border-l border-line',
                      density === d
                        ? 'bg-accent-subtle font-medium text-accent'
                        : 'bg-surface-100 text-fg-muted hover:text-fg-secondary',
                    )}
                  >
                    {t(`view3d.decor.density.${d}`)}
                  </button>
                ))}
              </div>
              <button
                data-testid="decor-shuffle"
                onClick={() =>
                  setDiagramSceneDecor(diagramId, {
                    ...sceneDecor,
                    seed: Math.floor(Math.random() * 0xffffffff) >>> 0,
                  })
                }
                className="mt-2 w-full rounded-lg border border-line bg-surface-100 px-2.5 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
              >
                {t('view3d.decor.shuffle')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
