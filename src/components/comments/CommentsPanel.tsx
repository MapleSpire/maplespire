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

import { useMemo } from 'react'
import { HelpCircle, AlertTriangle, Lightbulb, CheckSquare, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import i18n from '../../lib/i18n'
import { cn } from '../../lib/utils'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { Comment } from '../../types'

function typeConfigFor(t: TFunction) {
  return {
    question: { icon: HelpCircle, color: 'var(--color-warning-text)', bg: 'var(--color-warning-bg)', label: t('comments.type.question') },
    inaccuracy: { icon: AlertTriangle, color: 'var(--color-error-text)', bg: 'var(--color-error-bg)', label: t('comments.type.inaccuracy') },
    idea: { icon: Lightbulb, color: 'var(--color-violet-text)', bg: 'var(--color-violet-bg)', label: t('comments.type.idea') },
  }
}

function formatDate(dateStr: string, t: TFunction) {
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return t('comments.panel.justNow')
  if (diffMins < 60) return t('comments.panel.minutesAgo', { count: diffMins })
  if (diffHours < 24) return t('comments.panel.hoursAgo', { count: diffHours })
  if (diffDays < 7) return t('comments.panel.daysAgo', { count: diffDays })
  return d.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
}

export function CommentsPanel() {
  const { t } = useTranslation()
  const comments = useModelStore((s) => s.comments)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const toggleResolved = useModelStore((s) => s.toggleResolved)
  const filter = useUIStore((s) => s.commentsFilter)
  const setFilter = useUIStore((s) => s.setCommentsFilter)
  const setOpenCommentId = useUIStore((s) => s.setOpenCommentId)

  const diagramComments = useMemo(
    () => comments.filter((c) => c.diagramId === currentDiagramId),
    [comments, currentDiagramId]
  )

  const filtered = useMemo(() => {
    return diagramComments.filter((c) => {
      if (filter === 'unresolved') return !c.resolved
      if (filter === 'resolved') return c.resolved
      return true
    })
  }, [diagramComments, filter])

  const handleSelectComment = (comment: Comment) => {
    const engine = (window as unknown as {
      __canvasEngine?: {
        panToWorld: (x: number, y: number) => void
        getCommentPosition?: (id: string) => { x: number; y: number } | null
      }
    }).__canvasEngine
    if (engine) {
      // Where the pin is DRAWN: an open inline expansion may have displaced it.
      const pin = engine.getCommentPosition?.(comment.id) ?? comment.position
      engine.panToWorld(pin.x, pin.y)
    }
    setOpenCommentId(comment.id)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter tabs */}
      <div className="flex border-b border-line">
        {(['all', 'unresolved', 'resolved'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'flex-1 py-2.5 text-[12px] font-medium border-b-2 transition-colors',
              filter === f
                ? 'text-fg border-accent'
                : 'text-fg-subtle border-transparent hover:text-fg-muted'
            )}
          >
            {f === 'all' ? t('comments.panel.filterAll') : f === 'unresolved' ? t('comments.panel.filterUnresolved') : t('comments.panel.filterResolved')}
            <span className="ml-1 text-fg-subtle">
              {f === 'all'
                ? diagramComments.length
                : f === 'unresolved'
                  ? diagramComments.filter((c) => !c.resolved).length
                  : diagramComments.filter((c) => c.resolved).length}
            </span>
          </button>
        ))}
      </div>

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-fg-subtle">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-[13px]">
              {filter === 'all'
                ? t('comments.panel.emptyAll')
                : filter === 'unresolved'
                  ? t('comments.panel.emptyUnresolved')
                  : t('comments.panel.emptyResolved')}
            </p>
          </div>
        ) : (
          filtered.map((comment) => {
            const typeConfig = typeConfigFor(t)
            const config = typeConfig[comment.type]
            const Icon = config.icon
            return (
              <div
                key={comment.id}
                data-testid="comment-row"
                data-comment-id={comment.id}
                className="px-4 py-3 border-b border-line hover:bg-surface-50 cursor-pointer group"
                onClick={() => handleSelectComment(comment)}
              >
                <div className="flex items-start gap-2">
                  {/* Type icon */}
                  {/* h-4 wrapper = first text-line box: centers the badge on the
                      label line instead of the old mt-0.5 optical nudge. */}
                  <div className="flex h-5 items-center shrink-0">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center"
                      style={{ backgroundColor: config.bg }}
                    >
                      <Icon className="w-3.5 h-3.5" style={{ color: config.color }} />
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Header */}
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wide"
                        style={{ color: config.color }}
                      >
                        {config.label}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-fg-subtle">{formatDate(comment.createdAt, t)}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleResolved(comment.id)
                          }}
                          className={cn(
                            'p-1 rounded hover:bg-surface-200 opacity-0 group-hover:opacity-100 transition-opacity',
                            comment.resolved ? 'text-success-text' : 'text-fg-subtle'
                          )}
                          title={comment.resolved ? t('comments.detail.unresolve') : t('comments.detail.resolve')}
                        >
                          <CheckSquare className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Text */}
                    <p className="text-[13px] text-fg mt-1 leading-snug line-clamp-2">
                      {comment.text}
                    </p>

                    {/* Footer */}
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[11px] text-fg-subtle">{comment.author}</span>
                      {comment.replies.length > 0 && (
                        <span className="flex items-center gap-0.5 text-[11px] text-fg-muted">
                          <MessageSquare className="w-3 h-3" />
                          {comment.replies.length}
                        </span>
                      )}
                      {comment.pinned && (
                        <span className="text-[10px] text-accent font-medium bg-accent-subtle px-1.5 py-0.5 rounded">
                          {t('comments.panel.pinned')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
