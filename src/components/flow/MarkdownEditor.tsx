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

import { useState, useRef, useMemo, useCallback } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Bold, Italic, Heading, List, Code, Eye, Edit3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  testId?: string
  disabled?: boolean
}

export function MarkdownEditor({ value, onChange, placeholder, testId, disabled = false }: MarkdownEditorProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const insert = useCallback(
    (before: string, after: string = '') => {
      const textarea = textareaRef.current
      if (!textarea) return
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const selected = value.slice(start, end)
      const newText = value.slice(0, start) + before + selected + after + value.slice(end)
      onChange(newText)
      requestAnimationFrame(() => {
        textarea.focus()
        const newCursor = start + before.length + selected.length
        textarea.setSelectionRange(newCursor, newCursor)
      })
    },
    [value, onChange]
  )

  const previewHtml = useMemo(() => {
    if (!value) return ''
    const raw = marked.parse(value, { async: false }) as string
    return DOMPurify.sanitize(raw)
  }, [value])

  const tools = [
    { icon: Bold, label: t('misc.markdownEditor.bold'), action: () => insert('**', '**') },
    { icon: Italic, label: t('misc.markdownEditor.italic'), action: () => insert('*', '*') },
    { icon: Heading, label: t('misc.markdownEditor.heading'), action: () => insert('## ', '') },
    { icon: List, label: t('misc.markdownEditor.list'), action: () => insert('- ', '') },
    { icon: Code, label: t('misc.markdownEditor.code'), action: () => insert('`', '`') },
  ]

  return (
    <div className="border border-line rounded-lg bg-surface-100 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-line bg-surface-50">
        <div className="flex items-center gap-0.5">
          {tools.map((tool) => (
            <button
              key={tool.label}
              type="button"
              onClick={tool.action}
              disabled={disabled}
              title={tool.label}
              className="p-1 rounded hover:bg-surface-300 text-fg-muted transition-colors"
            >
              <tool.icon className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMode('write')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
              mode === 'write' ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg-secondary'
            }`}
          >
            <Edit3 className="w-3 h-3" />
            {t('misc.markdownEditor.write')}
          </button>
          <button
            type="button"
            onClick={() => setMode('preview')}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${
              mode === 'preview' ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg-secondary'
            }`}
          >
            <Eye className="w-3 h-3" />
            {t('misc.markdownEditor.preview')}
          </button>
        </div>
      </div>

      {/* Content */}
      {mode === 'write' ? (
        <textarea
          ref={textareaRef}
          data-testid={testId}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={4}
          className="w-full text-[12px] text-fg-secondary px-3 py-2 resize-none focus:outline-none bg-surface-100"
        />
      ) : (
        <div
          className="px-3 py-2 text-[12px] text-fg-secondary min-h-[80px] max-h-[200px] overflow-y-auto prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{
            __html: previewHtml || `<span class="text-fg-subtle">${t('misc.markdownEditor.nothingToPreview')}</span>`,
          }}
        />
      )}
    </div>
  )
}
