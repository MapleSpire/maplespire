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

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { getModelQuery } from '../../lib/modelQuery'
import type { C4Object } from '../../types'

export function DiagramTransition() {
  const { t } = useTranslation()
  const isTransitioning = useUIStore((s) => s.isTransitioning)
  const transitionDirection = useUIStore((s) => s.transitionDirection)
  const zoomedFromObjectId = useUIStore((s) => s.zoomedFromObjectId)

  // Resolve the zoomed-from object through the seam (it may be off the active-diagram
  // window when the store is windowed), rather than scanning the whole resident store.
  const [obj, setObj] = useState<C4Object | undefined>(undefined)
  useEffect(() => {
    if (!zoomedFromObjectId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setObj(undefined)
      return
    }
    let cancelled = false
    void getModelQuery().object(zoomedFromObjectId).then((o) => { if (!cancelled) setObj(o) })
    return () => { cancelled = true }
  }, [zoomedFromObjectId])

  if (!isTransitioning) return null

  const typeLabel: Record<string, string> = {
    context: 'Context',
    container: 'Container',
    component: 'Component',
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-100/90 backdrop-blur-sm"
      style={{
        animation: transitionDirection === 'in'
          ? 'fadeIn 300ms cubic-bezier(0.4, 0, 0.2, 1) forwards'
          : 'fadeOut 300ms cubic-bezier(0.4, 0, 0.2, 1) forwards',
      }}
    >
      <div
        className="flex flex-col items-center gap-4"
        style={{
          animation: transitionDirection === 'in'
            ? 'zoomIn 300ms cubic-bezier(0.4, 0, 0.2, 1) forwards'
            : 'zoomOut 300ms cubic-bezier(0.4, 0, 0.2, 1) forwards',
        }}
      >
        {/* Spinner */}
        <div className="w-10 h-10 border-2 border-line border-t-accent rounded-full animate-spin" />

        {/* Object name */}
        {obj && (
          <div className="flex flex-col items-center gap-1">
            <span className="text-[14px] font-semibold text-fg">{obj.name}</span>
            <span className="text-[11px] text-fg-subtle">
              {t('diagramChrome.transition.diagramOfType', { type: typeLabel[obj.type] || obj.type })}
            </span>
          </div>
        )}
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes zoomIn {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        @keyframes zoomOut {
          from { transform: scale(1); opacity: 1; }
          to { transform: scale(1.15); opacity: 0; }
        }
      `}</style>
    </div>
  )
}
