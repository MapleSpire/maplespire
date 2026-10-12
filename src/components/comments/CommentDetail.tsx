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

import { useRef, useState } from 'react'
import {
  HelpCircle,
  AlertTriangle,
  Lightbulb,
  X,
  Pin,
  CheckSquare,
  Pencil,
  Trash2,
  Send,
  MoreHorizontal,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import { useModelStore } from '../../stores/modelStore'
import type { Comment } from '../../types'

function typeConfigFor(t: TFunction) {
  return {
    question: { icon: HelpCircle, color: 'var(--color-warning-text)', bg: 'var(--color-warning-bg)', label: t('comments.type.question') },
    inaccuracy: { icon: AlertTriangle, color: 'var(--color-error-text)', bg: 'var(--color-error-bg)', label: t('comments.type.inaccuracy') },
    idea: { icon: Lightbulb, color: 'var(--color-violet-text)', bg: 'var(--color-violet-bg)', label: t('comments.type.idea') },
  }
}

export function CommentDetail({
  comment,
  screenX,
  screenY,
  onMove,
  onClose,
  readonly = false,
}: {
  comment: Comment
  screenX: number
  screenY: number
  onMove?: (x: number, y: number) => void
  onClose: () => void
  readonly?: boolean
}) {
  const { t, i18n } = useTranslation()
  const [replyText, setReplyText] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editText, setEditText] = useState(comment.text)
  const [menuOpen, setMenuOpen] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)

  // Drag the box by its header. Captured at pointerdown: the box origin plus the
  // raw pointer delta, so the math is immune to re-renders and viewport changes.
  const handleHeaderPointerDown = (e: React.PointerEvent) => {
    if (!onMove) return
    // Let header buttons (pin/resolve/menu/close) keep working — only the empty
    // header area starts a drag.
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: screenX, originY: screenY }
    const onPointerMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      onMove(d.originX + (ev.clientX - d.startX), d.originY + (ev.clientY - d.startY))
    }
    const onPointerUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const addReply = useModelStore((s) => s.addReply)
  const updateComment = useModelStore((s) => s.updateComment)
  const deleteComment = useModelStore((s) => s.deleteComment)
  const toggleResolved = useModelStore((s) => s.toggleResolved)
  const togglePinned = useModelStore((s) => s.togglePinned)
  const deleteReply = useModelStore((s) => s.deleteReply)

  const typeConfig = typeConfigFor(t)
  const config = typeConfig[comment.type]
  const Icon = config.icon

  const handleAddReply = () => {
    if (readonly || !replyText.trim()) return
    addReply(comment.id, replyText.trim())
    setReplyText('')
  }

  const handleSaveEdit = () => {
    if (readonly) return
    updateComment(comment.id, { text: editText })
    setIsEditing(false)
  }

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr)
    return d.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div
      className="absolute z-30 bg-surface-100 border border-line rounded-lg shadow-xl w-[340px] overflow-hidden"
      style={{ left: screenX, top: screenY }}
    >
      {/* Header — drag handle */}
      <div
        onPointerDown={handleHeaderPointerDown}
        className={cn(
          'flex items-center justify-between px-3 py-2 border-b border-line select-none',
          onMove && 'cursor-move'
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium"
            style={{ backgroundColor: config.bg, color: config.color }}
          >
            <Icon className="w-3 h-3" />
            {config.label}
          </span>
          <span className="text-[11px] text-fg-subtle">{comment.author}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            disabled={readonly}
            onClick={() => togglePinned(comment.id)}
            className={cn('p-1 rounded hover:bg-surface-50', comment.pinned ? 'text-accent' : 'text-fg-subtle')}
            title={comment.pinned ? t('comments.detail.unpin') : t('comments.detail.pin')}
          >
            <Pin className="w-3.5 h-3.5" />
          </button>
          <button
            data-testid="comment-resolve"
            disabled={readonly}
            onClick={() => toggleResolved(comment.id)}
            className={cn('p-1 rounded hover:bg-surface-50', comment.resolved ? 'text-success-text' : 'text-fg-subtle')}
            title={comment.resolved ? t('comments.detail.unresolve') : t('comments.detail.resolve')}
          >
            <CheckSquare className="w-3.5 h-3.5" />
          </button>
          <div className="relative">
            <button
              disabled={readonly}
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1 text-fg-subtle hover:text-fg-secondary rounded hover:bg-surface-50"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-surface-100 border border-line rounded-lg shadow-lg z-40 py-1 min-w-[140px]">
                <button
                  disabled={readonly}
                  onClick={() => {
                    setIsEditing(true)
                    setMenuOpen(false)
                  }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
                >
                  <Pencil className="w-3 h-3" />
                  {t('comments.detail.edit')}
                </button>
                <button
                  data-testid="comment-delete"
                  disabled={readonly}
                  onClick={() => {
                    deleteComment(comment.id)
                    onClose()
                  }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-error-text hover:bg-error-bg"
                >
                  <Trash2 className="w-3 h-3" />
                  {t('comments.detail.delete')}
                </button>
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1 text-fg-subtle hover:text-fg-secondary">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5">
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={3}
              className="w-full text-[13px] text-fg bg-surface-50 border border-line rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent resize-none"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setIsEditing(false)
                  setEditText(comment.text)
                }}
                className="px-2 py-1 text-[11px] text-fg-secondary hover:bg-surface-50 rounded"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={readonly}
                className="px-2 py-1 text-[11px] text-on-inverse bg-inverse hover:bg-inverse-hover rounded"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-fg leading-relaxed whitespace-pre-wrap">{comment.text}</p>
        )}
        <div className="mt-1 text-[10px] text-fg-subtle">{formatDate(comment.createdAt)}</div>
      </div>

      {/* Replies */}
      {comment.replies.length > 0 && (
        <div className="px-3 py-2 border-t border-line space-y-2">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="flex items-start gap-2">
              <div className="w-5 h-5 rounded-full bg-surface-300 flex items-center justify-center text-[10px] font-bold text-fg-secondary shrink-0">
                {reply.author.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-medium text-fg">{reply.author}</span>
                  <span className="text-[10px] text-fg-subtle">{formatDate(reply.createdAt)}</span>
                </div>
                <p className="text-[12px] text-fg-secondary leading-relaxed">{reply.text}</p>
              </div>
              <button
                onClick={() => deleteReply(comment.id, reply.id)}
                disabled={readonly}
                className="p-0.5 text-fg-subtle hover:text-error-text shrink-0"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Reply input */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-line">
        <input
          data-testid="comment-reply-input"
          disabled={readonly}
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleAddReply()
            }
          }}
          placeholder={t('comments.detail.replyPlaceholder')}
          className="flex-1 min-w-0 text-[12px] bg-surface-50 border border-line rounded-md px-2.5 py-1.5 text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          data-testid="comment-reply-submit"
          onClick={handleAddReply}
          disabled={readonly || !replyText.trim()}
          className="p-1.5 text-on-inverse bg-inverse rounded-md hover:bg-inverse-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
