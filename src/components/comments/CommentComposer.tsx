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
import { Send, X, HelpCircle, AlertTriangle, Lightbulb, AtSign } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { CommentType } from '../../types'

function commentTypeConfigFor(
  t: TFunction
): Record<CommentType, { label: string; icon: React.ElementType; color: string; bg: string; buttonText: string }> {
  return {
    question: {
      label: t('comments.type.question'),
      icon: HelpCircle,
      color: 'var(--color-warning-text)',
      bg: 'var(--color-warning-bg)',
      buttonText: t('comments.composer.askQuestion'),
    },
    inaccuracy: {
      label: t('comments.type.inaccuracy'),
      icon: AlertTriangle,
      color: 'var(--color-error-text)',
      bg: 'var(--color-error-bg)',
      buttonText: t('comments.composer.markAsInaccurate'),
    },
    idea: {
      label: t('comments.type.idea'),
      icon: Lightbulb,
      color: 'var(--color-violet-text)',
      bg: 'var(--color-violet-bg)',
      buttonText: t('comments.composer.addIdea'),
    },
  }
}

export function CommentComposer({
  x,
  y,
  onSubmit,
  onCancel,
}: {
  x: number
  y: number
  onSubmit: (type: CommentType, text: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = useState<CommentType>('question')
  const [text, setText] = useState('')
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false)
  const commentTypeConfig = commentTypeConfigFor(t)
  const config = commentTypeConfig[type]
  const Icon = config.icon

  const handleSubmit = () => {
    if (!text.trim()) return
    onSubmit(type, text.trim())
  }

  return (
    <div
      className="fixed z-30 bg-surface-100 border border-line rounded-lg shadow-xl w-[320px] overflow-hidden"
      style={{ left: x, top: y }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <div className="relative">
          <button
            onClick={() => setTypeDropdownOpen(!typeDropdownOpen)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
            style={{ backgroundColor: config.bg, color: config.color }}
          >
            <Icon className="w-3.5 h-3.5" />
            {config.label}
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {typeDropdownOpen && (
            <div className="absolute top-full left-0 mt-1 bg-surface-100 border border-line rounded-lg shadow-lg z-40 py-1 min-w-[140px]">
              {(Object.keys(commentTypeConfig) as CommentType[]).map((ct) => {
                const c = commentTypeConfig[ct]
                return (
                  <button
                    key={ct}
                    onClick={() => {
                      setType(ct)
                      setTypeDropdownOpen(false)
                    }}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
                  >
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: c.color }} />
                    {c.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onCancel} className="p-1 text-fg-subtle hover:text-fg-secondary">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        <textarea
          autoFocus
          data-testid="comment-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('comments.composer.placeholder')}
          rows={3}
          className="w-full text-[13px] text-fg bg-transparent border-0 p-0 focus:outline-none resize-none placeholder:text-fg-subtle"
        />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-line">
        <button className="p-1 text-fg-subtle hover:text-fg-secondary">
          <AtSign className="w-4 h-4" />
        </button>
        <button
          data-testid="comment-submit"
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-on-inverse bg-inverse rounded-md hover:bg-inverse-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Send className="w-3 h-3" />
          {config.buttonText}
        </button>
      </div>
    </div>
  )
}
