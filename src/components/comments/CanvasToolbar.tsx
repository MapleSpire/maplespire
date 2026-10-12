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

import { Plus, MessageSquare, Sparkles, Move, Wand2, History } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useAutoLayout } from '../../hooks/useAutoLayout'

/**
 * Floating left vertical tool stack (design: a rounded card of AI / Move /
 * Auto-layout / Comments / History, plus a separate Add card below). Vertically
 * centered, sitting just right of the floating left panel.
 */
export function CanvasToolbar({
  leftSidebarOpen,
}: {
  leftSidebarOpen: boolean
}) {
  const { t } = useTranslation()
  const commentMode = useUIStore((s) => s.commentMode)
  const toggleCommentMode = useUIStore((s) => s.toggleCommentMode)
  const aiAssistOpen = useUIStore((s) => s.aiAssistOpen)
  const aiAssistWidth = useUIStore((s) => s.aiAssistWidth)
  const toggleAIAssist = useUIStore((s) => s.toggleAIAssist)
  const createPaletteOpen = useUIStore((s) => s.createPaletteOpen)
  const toggleCreatePalette = useUIStore((s) => s.toggleCreatePalette)
  const toolMode = useUIStore((s) => s.toolMode)
  const setToolMode = useUIStore((s) => s.setToolMode)
  const setHistoryOpen = useUIStore((s) => s.setHistoryOpen)
  const { autoLaying, autoLayout } = useAutoLayout()

  const comments = useModelStore((s) => s.comments)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const unresolved = comments.filter((c) => c.diagramId === currentDiagramId && !c.resolved).length

  const btn = 'flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors'
  const ghost = 'text-fg-secondary hover:bg-surface-hover'

  // The AI Assist panel (when open) sits on top of the Shapes panel in the same
  // slot at its own resizable width; the Shapes panel alone is a fixed 312px —
  // in both cases the toolbar clears the panel's right edge by a 12px gap.
  const leftOffset = aiAssistOpen ? aiAssistWidth + 26 : leftSidebarOpen ? 338 : 12

  return (
    <div
      className="absolute top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-2.5 transition-[left] duration-300 ease-out"
      style={{ left: leftOffset }}
    >
      <div className="flex flex-col items-center gap-1 rounded-xl border border-line bg-surface-100 p-1.5 shadow-xl">
        <button
          data-testid="ai-assist-toggle"
          onClick={toggleAIAssist}
          title={t('comments.toolbar.aiAssist')}
          className={cn(btn, aiAssistOpen ? 'bg-accent-subtle text-accent' : 'text-accent hover:bg-surface-hover')}
        >
          <Sparkles className="h-[19px] w-[19px]" />
        </button>

        <span className="my-0.5 h-px w-5 bg-line" />

        <button
          onClick={() => setToolMode(toolMode === 'pan' ? 'select' : 'pan')}
          title={t('comments.toolbar.movePan')}
          className={cn(btn, toolMode === 'pan' ? 'bg-surface-200 text-fg' : ghost)}
        >
          <Move className="h-[18px] w-[18px]" />
        </button>
        <button
          onClick={() => void autoLayout()}
          disabled={autoLaying}
          data-testid="auto-layout"
          title={t('comments.toolbar.autoLayout')}
          className={cn(btn, ghost, autoLaying && 'animate-pulse')}
        >
          <Wand2 className="h-[18px] w-[18px]" />
        </button>
        <button
          data-testid="comment-mode-toggle"
          onClick={toggleCommentMode}
          title={commentMode ? t('comments.toolbar.clickToAddComment') : t('comments.toolbar.addComment')}
          className={cn(btn, 'relative', commentMode ? 'bg-inverse text-on-inverse' : ghost)}
        >
          <MessageSquare className="h-[18px] w-[18px]" />
          {unresolved > 0 && !commentMode && (
            <span className="absolute right-2 top-1.5 h-[7px] w-[7px] rounded-full border-[1.5px] border-surface-100 bg-accent" />
          )}
        </button>
        <button
          data-testid="open-history"
          onClick={() => setHistoryOpen(true)}
          title={t('comments.toolbar.diagramHistory')}
          className={cn(btn, ghost)}
        >
          <History className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="flex rounded-[12px] border border-line bg-surface-100 p-1.5 shadow-xl">
        <button
          data-testid="add-shape"
          onClick={toggleCreatePalette}
          aria-pressed={createPaletteOpen}
          title={t('comments.toolbar.addShapes')}
          className={cn(btn, createPaletteOpen ? 'bg-accent-subtle text-accent' : ghost)}
        >
          <Plus className="h-[19px] w-[19px]" />
        </button>
      </div>
    </div>
  )
}
