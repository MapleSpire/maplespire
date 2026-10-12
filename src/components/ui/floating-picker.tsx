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

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

interface FloatingPickerProps {
  isOpen: boolean
  title: string
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  children: ReactNode
  headerLeading?: ReactNode
  className?: string
  testId?: string
}

interface Point {
  left: number
  top: number
}

const VIEWPORT_MARGIN = 16
const TRIGGER_GAP = 8

/** Shared anchored and draggable shell for catalog pickers. */
export function FloatingPicker({
  isOpen,
  title,
  onClose,
  triggerRef,
  children,
  headerLeading,
  className,
  testId,
}: FloatingPickerProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef({ x: 0, y: 0, left: 0, top: 0 })
  const initialFocusDoneRef = useRef(false)
  const [position, setPosition] = useState<Point | null>(null)
  const [dragging, setDragging] = useState(false)

  const anchor = useCallback(() => {
    const trigger = triggerRef?.current
    const rect = trigger?.getBoundingClientRect()
    const panel = panelRef.current
    const width = panel?.offsetWidth || Math.min(680, window.innerWidth - VIEWPORT_MARGIN * 2)
    const height = panel?.offsetHeight || Math.min(680, window.innerHeight * 0.8)

    if (!rect) {
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, (window.innerWidth - width) / 2),
        top: Math.max(VIEWPORT_MARGIN, (window.innerHeight - height) / 2),
      })
      return
    }

    const preferredLeft = rect.left - width - TRIGGER_GAP
    const alternateLeft = rect.right + TRIGGER_GAP
    const left = preferredLeft >= VIEWPORT_MARGIN
      ? preferredLeft
      : Math.min(alternateLeft, window.innerWidth - width - VIEWPORT_MARGIN)
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.top),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    )
    setPosition({ left: Math.max(VIEWPORT_MARGIN, left), top })
  }, [triggerRef])

  useEffect(() => {
    if (!isOpen) return
    // Reset every opening so a previously dragged panel never contaminates a
    // click from another trigger. The second frame uses the measured panel.
    anchor()
    const frame = window.requestAnimationFrame(anchor)
    window.addEventListener('resize', anchor)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', anchor)
    }
  }, [anchor, isOpen])

  // React resolves `autoFocus` during the mount commit — which happens while
  // this panel is still `invisible`, because `position` is only measured in the
  // effect above. A `visibility: hidden` subtree cannot take focus, the browser
  // refuses silently, and nothing ever retries, leaving every picker's search
  // box unfocused. Own the initial focus here
  // instead, on the first render where the panel is actually visible.
  useEffect(() => {
    if (!isOpen) {
      initialFocusDoneRef.current = false
      return
    }
    const panel = panelRef.current
    if (!position || !panel || initialFocusDoneRef.current) return
    initialFocusDoneRef.current = true
    // Never steal focus the content placed deliberately, and never re-focus on
    // a later re-anchor (window resize re-runs `anchor`, not the opening).
    if (panel.contains(document.activeElement)) return
    const target =
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled])',
      )
    target?.focus()
  }, [isOpen, position])

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target) || triggerRef?.current?.contains(target)) return
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    const timer = window.setTimeout(() => window.addEventListener('mousedown', handleOutsideClick), 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('mousedown', handleOutsideClick)
    }
  }, [isOpen, onClose, triggerRef])

  useEffect(() => {
    if (!dragging) return
    const move = (event: MouseEvent) => {
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      setPosition({
        left: Math.min(
          Math.max(VIEWPORT_MARGIN, dragStartRef.current.left + event.clientX - dragStartRef.current.x),
          Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
        ),
        top: Math.min(
          Math.max(VIEWPORT_MARGIN, dragStartRef.current.top + event.clientY - dragStartRef.current.y),
          Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
        ),
      })
    }
    const stop = () => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
    }
  }, [dragging])

  if (!isOpen) return null

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      data-testid={testId}
      className={cn(
        'fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-line bg-surface-100 shadow-xl',
        className,
        !position && 'invisible',
      )}
      style={position ?? undefined}
    >
      <div
        data-testid={testId ? `${testId}-drag-handle` : undefined}
        className="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-line px-4 py-3"
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          event.preventDefault()
          const current = position ?? { left: 0, top: 0 }
          dragStartRef.current = {
            x: event.clientX,
            y: event.clientY,
            left: current.left,
            top: current.top,
          }
          setDragging(true)
        }}
      >
        {headerLeading}
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fg">{title}</span>
        {!headerLeading && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-200 hover:text-fg"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {children}
    </div>,
    document.body,
  )
}
