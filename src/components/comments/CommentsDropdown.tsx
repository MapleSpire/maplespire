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

import { useState } from 'react'
import { HelpCircle, AlertTriangle, Lightbulb, X, CheckSquare, MessageCircle, ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useAuthStore } from '../../stores/authStore'
import { commentAuthorLabel, isOwnCommentEntry } from '../../lib/comments/authorship'
import type { Comment } from '../../types'

const typeConfig = {
  question: { icon: HelpCircle, color: 'var(--color-warning-text)', bg: 'var(--color-warning-bg)' },
  inaccuracy: { icon: AlertTriangle, color: 'var(--color-error-text)', bg: 'var(--color-error-bg)' },
  idea: { icon: Lightbulb, color: 'var(--color-violet-text)', bg: 'var(--color-violet-bg)' },
}

type CommentTab = 'yours' | 'mentions' | 'all'

export function CommentsDropdown({
  onClose,
  onSelectComment,
}: {
  onClose: () => void
  onSelectComment: (comment: Comment) => void
}) {
  const { t } = useTranslation()
  const comments = useModelStore((s) => s.comments)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const toggleResolved = useModelStore((s) => s.toggleResolved)
  const viewer = useAuthStore((s) => s.user)
  const setRightSidebarTab = useUIStore((s) => s.setRightSidebarTab)
  const setRightSidebarOpen = useUIStore((s) => s.setRightSidebarOpen)
  const [activeTab, setActiveTab] = useState<CommentTab>('all')
  const [showResolved, setShowResolved] = useState(false)

  const diagramComments = comments.filter((c) => c.diagramId === currentDiagramId)

  const filtered = diagramComments.filter((c) => {
    if (activeTab === 'yours') return isOwnCommentEntry(c, viewer)
    if (activeTab === 'mentions') return false // No mention system yet
    return true
  })

  const openComments = filtered.filter((c) => !c.resolved)
  const resolvedComments = filtered.filter((c) => c.resolved)

  return (
    <div className="absolute top-full right-0 mt-2 bg-surface-100 border border-line rounded-lg shadow-xl z-50 w-[380px] max-h-[500px] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <h3 className="text-[13px] font-semibold text-fg">{t('comments.dropdown.title')}</h3>
        <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-secondary">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs (segmented pill — same control as the sidebars) */}
      <div className="px-3 py-2.5 border-b border-line">
        <SegmentedTabs
          size="sm"
          tabs={[
            { id: 'yours', label: t('comments.dropdown.tabYours') },
            { id: 'mentions', label: t('comments.dropdown.tabMentions') },
            { id: 'all', label: t('comments.dropdown.tabAll') },
          ] as { id: CommentTab; label: string }[]}
          value={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2">
        {openComments.length === 0 && resolvedComments.length === 0 && (
          <div className="text-center py-8 text-[12px] text-fg-subtle">{t('comments.dropdown.empty')}</div>
        )}

        {openComments.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            onClick={() => onSelectComment(comment)}
            onToggleResolved={() => toggleResolved(comment.id)}
          />
        ))}

        {resolvedComments.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setShowResolved(!showResolved)}
              className="flex items-center gap-1 w-full px-2 py-1.5 text-[11px] text-fg-subtle hover:text-fg-secondary"
            >
              <CheckSquare className="w-3 h-3" />
              {t('comments.dropdown.resolvedComments', { count: resolvedComments.length })}
            </button>
            {showResolved &&
              resolvedComments.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  onClick={() => onSelectComment(comment)}
                  onToggleResolved={() => toggleResolved(comment.id)}
                  resolved
                />
              ))}
          </div>
        )}
      </div>

      {/* View all comments */}
      <div className="px-3 py-2.5 border-t border-line shrink-0">
        <button
          onClick={() => {
            onClose()
            setRightSidebarTab('comments')
            setRightSidebarOpen(true)
          }}
          className="w-full flex items-center justify-center gap-1.5 text-[12px] text-accent hover:text-accent-hover font-medium py-1 transition-colors"
        >
          {t('comments.dropdown.viewAll')}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

function CommentRow({
  comment,
  onClick,
  onToggleResolved,
  resolved,
}: {
  comment: Comment
  onClick: () => void
  onToggleResolved: () => void
  resolved?: boolean
}) {
  const { t } = useTranslation()
  const viewer = useAuthStore((s) => s.user)
  const config = typeConfig[comment.type]
  const Icon = config.icon

  return (
    <div
      data-testid="comment-row"
      data-comment-id={comment.id}
      className={cn(
        'flex items-start gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors',
        resolved ? 'opacity-60' : 'hover:bg-surface-50'
      )}
      onClick={onClick}
    >
      <span className="flex h-4 items-center shrink-0">
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-full"
          style={{ backgroundColor: config.bg }}
        >
          <Icon className="w-3 h-3" style={{ color: config.color }} />
        </span>
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-fg truncate">{comment.text || t('comments.dropdown.noText')}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-fg-subtle" data-testid="comment-row-author">{commentAuthorLabel(comment, viewer, t)}</span>
          {comment.replies.length > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-fg-subtle">
              <MessageCircle className="w-3 h-3" />
              {comment.replies.length}
            </span>
          )}
        </div>
      </div>
      {!resolved && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggleResolved()
          }}
          className="p-1 text-fg-subtle hover:text-success shrink-0"
        >
          <CheckSquare className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}
