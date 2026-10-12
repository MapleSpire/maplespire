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

import { useCallback, useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { Bold, Italic, Heading, List, Code, Quote, Link2, Eye, FileCode, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

type Mode = 'rendered' | 'markdown'

/**
 * The ADR content editor, shown only in edit mode (the read view renders the
 * content without any of these controls — see ADRDetail). Two tabs:
 *  - "Preview": a WYSIWYG contentEditable surface — edit the formatted output
 *    directly (headings/bold/lists), never seeing the raw `##`/`**` tags.
 *  - "Markdown": the raw source.
 *
 * The stored value is always markdown. In Preview we render markdown → HTML once,
 * let the browser edit it natively (so the caret never jumps), and serialize the DOM
 * back to markdown on input. The serializer covers the subset ADRs use; exotic markdown
 * degrades to plain paragraphs — switch to Markdown for full control.
 */
export function ADRRichEditor({
  value,
  onChange,
  authorLine,
  onExit,
}: {
  value: string
  onChange: (value: string) => void
  authorLine: string
  onExit?: () => void
}) {
  const [mode, setMode] = useState<Mode>('rendered')
  return mode === 'rendered' ? (
    <RenderedEditor value={value} onChange={onChange} authorLine={authorLine} mode={mode} setMode={setMode} onExit={onExit} />
  ) : (
    <MarkdownEditor value={value} onChange={onChange} mode={mode} setMode={setMode} onExit={onExit} />
  )
}

/* ----------------------------------------------------------------- shared edit-mode bar */

interface BarProps {
  mode: Mode
  setMode: (m: Mode) => void
  tools: { Icon: React.ElementType; label: string; action: () => void }[]
  onExit?: () => void
}

function EditorBar({ mode, setMode, tools, onExit }: BarProps) {
  const { t } = useTranslation()
  return (
    <div className="mb-5 flex items-center gap-3.5 border-b border-line pb-3.5">
      {/* Preview / Markdown tabs */}
      <div className="flex items-center bg-surface-200 rounded-[11px] p-0.5" style={{ gap: 3 }}>
        {([
          { id: 'rendered' as const, label: t('decisionRecords.editor.preview'), Icon: Eye },
          { id: 'markdown' as const, label: t('decisionRecords.editor.markdown'), Icon: FileCode },
        ]).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={cn(
              'flex h-[29px] items-center gap-1.5 rounded-lg px-3.5 text-[12px] font-semibold transition-colors',
              mode === id ? 'bg-surface-100 text-fg shadow-sm' : 'text-fg-subtle hover:text-fg-secondary'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      {/* Formatting toolbar */}
      <div className="flex items-center">
        {tools.map((tool, i) =>
          tool.label === '|' ? (
            <span key={`sep-${i}`} className="mx-1.5 h-[18px] w-px bg-line" />
          ) : (
            <button
              key={tool.label}
              type="button"
              onMouseDown={(e) => e.preventDefault()} // keep the editor selection
              onClick={tool.action}
              title={tool.label}
              className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-fg-secondary transition-colors hover:bg-surface-200"
            >
              <tool.Icon className="h-4 w-4" />
            </button>
          )
        )}
      </div>
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          className="ml-2 flex h-[30px] items-center gap-1.5 rounded-lg bg-inverse px-3 text-[12px] font-semibold text-on-inverse transition-colors hover:bg-inverse-hover"
        >
          <Check className="h-3.5 w-3.5" />
          {t('decisionRecords.editor.done')}
        </button>
      )}
    </div>
  )
}

/* A subtle content card — the surface both the read view and edit panes sit in. */
function ContentCard({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <div
      className={cn('rounded-xl border border-line shadow-sm', mono ? 'bg-surface-50' : 'bg-surface-100')}
      style={{ padding: '30px 34px' }}
    >
      {children}
    </div>
  )
}

/* ----------------------------------------------------------------- Preview (WYSIWYG) */

function RenderedEditor({
  value,
  onChange,
  authorLine,
  mode,
  setMode,
  onExit,
}: {
  value: string
  onChange: (v: string) => void
  authorLine: string
  mode: Mode
  setMode: (m: Mode) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  // The markdown this editor last emitted — so an external value change re-renders the DOM
  // but our own edits (which round-trip back through `value`) do NOT, keeping the caret put.
  const lastEmitted = useRef<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (value === lastEmitted.current) return // our own edit — don't stomp the caret
    el.innerHTML = value ? DOMPurify.sanitize(marked.parse(value, { async: false }) as string) : ''
    lastEmitted.current = value
  }, [value])

  const emit = useCallback(() => {
    const el = ref.current
    if (!el) return
    const md = serializeToMarkdown(el)
    lastEmitted.current = md
    onChange(md)
  }, [onChange])

  const exec = useCallback(
    (command: string, arg?: string) => {
      ref.current?.focus()
      try {
        document.execCommand('styleWithCSS', false, 'false')
        document.execCommand(command, false, arg)
      } catch {
        /* execCommand is best-effort across browsers */
      }
      emit()
    },
    [emit]
  )

  const wrapInline = useCallback(
    (open: string, close: string, placeholder: string) => {
      ref.current?.focus()
      const sel = window.getSelection()
      const text = sel?.toString() ?? ''
      const safe = (text || placeholder).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
      try {
        document.execCommand('insertHTML', false, open + safe + close)
      } catch {
        /* noop */
      }
      emit()
    },
    [emit]
  )

  const tools = [
    { Icon: Heading, label: t('decisionRecords.editor.tool.heading'), action: () => exec('formatBlock', 'H2') },
    { Icon: Bold, label: t('decisionRecords.editor.tool.bold'), action: () => exec('bold') },
    { Icon: Italic, label: t('decisionRecords.editor.tool.italic'), action: () => exec('italic') },
    { Icon: List, label: '|', action: () => {} },
    { Icon: List, label: t('decisionRecords.editor.tool.bulletedList'), action: () => exec('insertUnorderedList') },
    { Icon: Quote, label: t('decisionRecords.editor.tool.quote'), action: () => exec('formatBlock', 'BLOCKQUOTE') },
    { Icon: Link2, label: t('decisionRecords.editor.tool.link'), action: () => wrapInline('<a href="#">', '</a>', t('decisionRecords.editor.tool.linkPlaceholder')) },
    { Icon: Code, label: t('decisionRecords.editor.tool.code'), action: () => wrapInline('<code>', '</code>', t('decisionRecords.editor.tool.codePlaceholder')) },
  ]

  return (
    <div>
      <EditorBar mode={mode} setMode={setMode} tools={tools} onExit={onExit} />
      <ContentCard>
        <div className="mb-5 font-mono text-[12px] text-fg-subtle">{authorLine}</div>
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          data-testid="adr-rendered-editor"
          onInput={emit}
          onBlur={emit}
          spellCheck
          className="adr-markdown min-h-[360px] focus:outline-none"
        />
      </ContentCard>
    </div>
  )
}

/* ----------------------------------------------------------------- Markdown (raw source) */

function MarkdownEditor({
  value,
  onChange,
  mode,
  setMode,
  onExit,
}: {
  value: string
  onChange: (v: string) => void
  mode: Mode
  setMode: (m: Mode) => void
  onExit?: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = ta.scrollHeight + 'px'
  }, [value])

  const insert = useCallback(
    (before: string, after = '') => {
      const ta = ref.current
      if (!ta) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const selected = value.slice(start, end)
      onChange(value.slice(0, start) + before + selected + after + value.slice(end))
      requestAnimationFrame(() => {
        ta.focus()
        const caret = start + before.length + selected.length
        ta.setSelectionRange(caret, caret)
      })
    },
    [value, onChange]
  )

  const tools = [
    { Icon: Heading, label: t('decisionRecords.editor.tool.heading'), action: () => insert('## ', '') },
    { Icon: Bold, label: t('decisionRecords.editor.tool.bold'), action: () => insert('**', '**') },
    { Icon: Italic, label: t('decisionRecords.editor.tool.italic'), action: () => insert('*', '*') },
    { Icon: List, label: '|', action: () => {} },
    { Icon: List, label: t('decisionRecords.editor.tool.bulletedList'), action: () => insert('- ', '') },
    { Icon: Quote, label: t('decisionRecords.editor.tool.quote'), action: () => insert('> ', '') },
    { Icon: Link2, label: t('decisionRecords.editor.tool.link'), action: () => insert('[', '](url)') },
    { Icon: Code, label: t('decisionRecords.editor.tool.code'), action: () => insert('`', '`') },
  ]

  return (
    <div>
      <EditorBar mode={mode} setMode={setMode} tools={tools} onExit={onExit} />
      <ContentCard mono>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid="adr-markdown-editor"
          placeholder={t('decisionRecords.editor.markdownPlaceholder')}
          className="adr-textarea w-full min-h-[360px] resize-none border-none bg-transparent font-mono text-[13px] leading-[1.9] text-fg-strong placeholder:text-fg-subtle focus:outline-none focus:ring-0"
          spellCheck={false}
        />
      </ContentCard>
    </div>
  )
}

/* ----------------------------------------------------------------- DOM → markdown serializer */

// contentEditable inserts non-breaking spaces; normalise them to plain spaces.
const NBSP_RE = new RegExp(String.fromCharCode(0xA0), 'g')

function serializeToMarkdown(root: HTMLElement): string {
  const blocks: string[] = []
  root.childNodes.forEach((node) => {
    const md = serializeBlock(node)
    if (md !== null && md !== '') blocks.push(md)
  })
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

function serializeBlock(node: ChildNode): string | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? '').replace(NBSP_RE, ' ')
    return t.trim() ? t : null
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as HTMLElement
  switch (el.tagName.toLowerCase()) {
    case 'h1': return '# ' + serializeInline(el)
    case 'h2': return '## ' + serializeInline(el)
    case 'h3': return '### ' + serializeInline(el)
    case 'h4': return '#### ' + serializeInline(el)
    case 'ul': return serializeList(el, () => '- ')
    case 'ol': return serializeList(el, (i) => `${i + 1}. `)
    case 'pre': return '```\n' + (el.textContent ?? '').replace(NBSP_RE, ' ') + '\n```'
    case 'blockquote': return '> ' + serializeInline(el)
    case 'hr': return '---'
    case 'br': return null
    case 'div':
    case 'p': {
      const inner = serializeInline(el)
      return inner.trim() ? inner : null
    }
    default:
      return serializeInline(el) || null
  }
}

function serializeList(listEl: HTMLElement, marker: (index: number) => string): string {
  const items: string[] = []
  let i = 0
  listEl.childNodes.forEach((child) => {
    if (child.nodeType === Node.ELEMENT_NODE && (child as HTMLElement).tagName.toLowerCase() === 'li') {
      items.push(marker(i) + serializeInline(child as HTMLElement))
      i++
    }
  })
  return items.join('\n')
}

function serializeInline(el: HTMLElement): string {
  let out = ''
  el.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += (child.textContent ?? '').replace(NBSP_RE, ' ')
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const c = child as HTMLElement
    switch (c.tagName.toLowerCase()) {
      case 'br': out += '\n'; break
      case 'strong':
      case 'b': out += '**' + serializeInline(c) + '**'; break
      case 'em':
      case 'i': out += '*' + serializeInline(c) + '*'; break
      case 'code': out += '`' + (c.textContent ?? '').replace(NBSP_RE, ' ') + '`'; break
      case 'a': out += '[' + serializeInline(c) + '](' + (c.getAttribute('href') ?? '') + ')'; break
      default: out += serializeInline(c)
    }
  })
  return out
}
