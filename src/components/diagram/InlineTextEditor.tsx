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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectInlineEditRect } from './inlineEditGeometry'
import {
  groupInlineEditSeed,
  planGroupInlineTextEdit,
  type GroupInlineEditWrite,
  type InlineEditSubject,
} from './groupInlineTextEdit'
import { INLINE_EDIT_MAX_LEN, inlineEditSeed, planInlineTextEdit } from './inlineTextEdit'
import type { CanvasEngine, ObjectTextBand } from '../../canvas/engine/CanvasEngine'

export type { InlineEditSubject }

/** Where a committed edit goes. The caller owns the store dispatch. */
export type InlineEditWrite = GroupInlineEditWrite

/**
 * A textarea laid exactly over a shape's or group's painted title/description.
 *
 * Two things it does that the older connection-label editor does not, both of
 * which are visible defects there rather than preferences:
 *
 *  - it FOLLOWS the viewport. The other overlay projects once when it opens, so
 *    it detaches from its target on any pan or zoom — and a wheel zoom moves no
 *    focus, so nothing closes it to hide the drift. Tracking runs on rAF and
 *    writes straight to the node's style, so a pan costs no React render.
 *  - it holds a DRAFT and commits on Enter or blur. See `inlineTextEdit.ts` for
 *    why per-keystroke writes are unsafe; the short version is that the
 *    local-edit overlay protecting them exists only on the boot-from-server
 *    path, so elsewhere a projection mid-typing reverts the edit.
 */
export function InlineTextEditor({
  subject,
  band,
  engineRef,
  onCommit,
  onClose,
}: {
  subject: InlineEditSubject
  band: ObjectTextBand
  engineRef: { current: CanvasEngine | null }
  onCommit: (write: InlineEditWrite) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = subject.kind === 'object' ? subject.object.id : subject.group.id
  // Grow to fit the content. Without this a wrapped description clips its last
  // line, and at small sizes the caret itself lands outside the visible box.
  const autoGrow = (node: HTMLTextAreaElement) => {
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }
  const [draft, setDraft] = useState(() =>
    subject.kind === 'object'
      ? inlineEditSeed(subject.object, band)
      : groupInlineEditSeed(subject.group, subject.parentObject, band),
  )
  // Commit must not run twice when Enter is followed by the blur it causes.
  const settled = useRef(false)

  const settle = (commit: boolean) => {
    if (settled.current) return
    settled.current = true
    if (commit) {
      const write = subject.kind === 'object'
        ? (() => {
            const update = planInlineTextEdit(subject.object, band, draft)
            return update ? ({ target: 'object', id: subject.object.id, update } as const) : null
          })()
        : planGroupInlineTextEdit(subject.group, subject.parentObject, band, draft)
      if (write) onCommit(write)
    }
    onClose()
  }

  // Suppress the painted run so the stale text is not drawn under the editor.
  useEffect(() => {
    const engine = engineRef.current
    engine?.setInlineEditTarget({ kind: subject.kind, id, band })
    return () => engine?.setInlineEditTarget(null)
  }, [engineRef, subject.kind, id, band])

  // Select the existing text rather than parking the caret at the end: an edit
  // that appends to the old title is the wrong default for a rename.
  useLayoutEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // Track the viewport. Reading it as one object avoids straddling a wheel
  // event between a position read and a scale read.
  useEffect(() => {
    let frame = 0
    let last = ''
    const tick = () => {
      const node = ref.current
      const engine = engineRef.current
      const bounds = subject.kind === 'object'
        ? engine?.getObjectTextBounds(id)
        : engine?.getGroupTextBounds(id)
      const rect = bounds && (band === 'title' ? bounds.title : bounds.description)
      if (node && rect && engine) {
        const screen = projectInlineEditRect(rect, engine.getViewport())
        const key = `${screen.left}|${screen.top}|${screen.width}|${screen.fontSize}`
        if (key !== last) {
          last = key
          node.style.left = `${screen.left}px`
          node.style.top = `${screen.top}px`
          node.style.width = `${screen.width}px`
          node.style.minHeight = `${screen.height}px`
          // Font BEFORE the grow: `autoGrow` reads `scrollHeight`, so measuring
          // first sizes the box for whatever font the node still had — which on
          // the opening frame is the inherited one, not the projected one. That
          // reserved a second line for a title that fits on one, and the guard
          // below (`key` unchanged) meant no later frame corrected it.
          node.style.fontSize = `${screen.fontSize}px`
          node.style.lineHeight = `${screen.lineHeight}px`
          autoGrow(node)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [engineRef, subject.kind, id, band])

  return (
    <textarea
      ref={ref}
      data-testid={`canvas-inline-edit-${subject.kind}-${band}`}
      aria-label={t(`canvasViewChrome.inlineEdit.${subject.kind}.${band}`)}
      // A textarea defaults to rows=2, and `autoGrow` sets `height: auto` before
      // reading `scrollHeight` — which then reports those two rows as the
      // minimum. Every editor opened one line taller than its content, whatever
      // the content was. One row is the floor; `autoGrow` adds the rest.
      rows={1}
      value={draft}
      maxLength={INLINE_EDIT_MAX_LEN}
      onChange={(e) => {
        setDraft(e.target.value)
        autoGrow(e.currentTarget)
      }}
      onBlur={() => settle(true)}
      onKeyDown={(e) => {
        // The canvas listens on `window`; without this, Escape here would also
        // clear copy mode and exit flow play.
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          settle(false)
        }
        if (e.key === 'Enter') {
          // Newlines are invisible on the canvas — the renderer collapses
          // whitespace when it wraps — so Enter commits rather than inserting
          // one the user could never see.
          e.preventDefault()
          settle(true)
        }
      }}
      className="absolute z-40 resize-none overflow-hidden rounded-md border border-accent/40 bg-surface-100 px-1.5 py-0.5 text-center text-fg caret-accent shadow-sm outline-none ring-1 ring-accent/20"
      style={{ position: 'absolute' }}
    />
  )
}
