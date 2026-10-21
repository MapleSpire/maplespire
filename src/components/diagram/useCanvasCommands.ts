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

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { undoHistory } from '../../lib/history/undoHistory'
import { readClipboardPayload, type EncodedClipboard, CANVAS_CLIPBOARD_MIME } from '../../lib/clipboard/canvasClipboard'
import type { CanvasEngine } from '../../canvas/engine/CanvasEngine'
import { isEditableTarget, isMacPlatform, resolveCanvasShortcut, type CanvasCommand } from './canvasShortcuts'
import {
  copySelection,
  cutSelection,
  duplicateSelection,
  pastePayload,
  rememberedClipboard,
  removeSelectionFromDiagram,
  selectAllOnDiagram,
} from './canvasCommands'

/**
 * Keyboard and clipboard wiring for the canvas, mounted ONCE in CanvasView —
 * which hosts both the 2D canvas and the 3D board, so one hook serves both.
 *
 * Copy, cut and paste are handled on the native `copy`/`cut`/`paste` events,
 * not on keydown: those events hand over `clipboardData` synchronously and
 * without a permission prompt in every browser, and they also fire for the
 * browser's Edit menu. Everything else is a keydown.
 *
 * It also SEALS the undo history (closes the open entry) on pointerdown, on a
 * keydown outside a text field and on focusout — the gesture boundaries that
 * stop two separate edits from becoming one undo step — and tells it while a
 * pointer is held, which keeps a 3D drag's per-frame writes in one entry.
 */

interface Options {
  engineRef: RefObject<CanvasEngine | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** The diagram, the workspace, or editing itself is read-only. */
  isReadonly: boolean
  /** Commands are off entirely (a flow is playing). */
  disabled: boolean
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock'])

function hasTextSelection(): boolean {
  const selection = typeof window !== 'undefined' ? window.getSelection() : null
  return !!selection && !selection.isCollapsed && selection.toString().length > 0
}

/** Best effort for menu-driven copy/cut, which has no clipboard event. */
async function writeSystemClipboard(encoded: EncodedClipboard): Promise<void> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      await navigator.clipboard?.writeText?.(encoded.text)
      return
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([encoded.html], { type: 'text/html' }),
        'text/plain': new Blob([encoded.text], { type: 'text/plain' }),
      }),
    ])
  } catch {
    // Denied or unsupported: the in-tab copy (rememberedClipboard) still works.
  }
}

/** Menu-driven / Ctrl+Shift+V paste: the tab's own last copy first (no
 * permission needed), else the system clipboard if the browser allows it. */
async function readSystemClipboardPayload() {
  const remembered = rememberedClipboard()
  if (remembered) return remembered
  try {
    if (!navigator.clipboard?.read) return null
    for (const item of await navigator.clipboard.read()) {
      if (!item.types.includes('text/html')) continue
      const html = await (await item.getType('text/html')).text()
      const payload = readClipboardPayload((type) => (type === 'text/html' ? html : null))
      if (payload) return payload
    }
  } catch {
    // Permission denied: nothing to paste.
  }
  return null
}

export function useCanvasCommands({ engineRef, canvasRef, isReadonly, disabled }: Options) {
  const mac = useMemo(() => isMacPlatform(), [])
  const flags = useRef({ isReadonly, disabled })
  useEffect(() => {
    flags.current = { isReadonly, disabled }
  }, [isReadonly, disabled])

  const active = useCallback((): boolean => {
    if (flags.current.disabled) return false
    if (useUIStore.getState().currentView !== 'diagram') return false
    // A modal owns the keyboard.
    return typeof document === 'undefined' || document.querySelector('[aria-modal="true"]') === null
  }, [])

  /** The world rectangle the 2D canvas shows (the 3D board has no such rect). */
  const visibleRect = useCallback(() => {
    const engine = engineRef.current
    const canvas = canvasRef.current
    if (!engine || !canvas || useUIStore.getState().canvasViewMode !== '2d') return undefined
    const a = engine.screenToWorld(0, 0)
    const b = engine.screenToWorld(canvas.clientWidth, canvas.clientHeight)
    return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }
  }, [engineRef, canvasRef])

  const gestureInProgress = useCallback(
    () => undoHistory.pointerHeld || (engineRef.current?.activePlacementGesture() ?? null) !== null,
    [engineRef],
  )

  /** Run a command from a menu, a button or a key. `anchor` = paste here. */
  const run = useCallback(async (command: CanvasCommand, anchor?: { x: number; y: number }): Promise<boolean> => {
    if (!active()) return false
    if (flags.current.isReadonly && command !== 'copy' && command !== 'selectAll') return false
    switch (command) {
      case 'undo': return undoHistory.undo()
      case 'redo': return undoHistory.redo()
      case 'copy': {
        const encoded = copySelection()
        if (encoded) await writeSystemClipboard(encoded)
        return encoded !== null
      }
      case 'cut': {
        const encoded = cutSelection()
        if (encoded) await writeSystemClipboard(encoded)
        return encoded !== null
      }
      case 'paste':
      case 'pasteAsCopy': {
        const payload = await readSystemClipboardPayload()
        if (!payload) return false
        const plan = await pastePayload(payload, { forceCopy: command === 'pasteAsCopy', anchor, visibleRect: visibleRect() })
        return plan !== null
      }
      case 'duplicate': return (await duplicateSelection()) !== null
      case 'selectAll': selectAllOnDiagram(); return true
      case 'remove': return removeSelectionFromDiagram()
    }
  }, [active, visibleRect])

  useEffect(() => {
    /** A Ctrl+C/X/V whose clipboard event has not arrived yet. */
    let pendingClipboardKey: CanvasCommand | null = null
    undoHistory.editingField = () => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const onPointerDown = (): void => {
      undoHistory.seal()
      undoHistory.pointerHeld = true
    }
    const onPointerUp = (): void => {
      undoHistory.pointerHeld = false
    }
    const onFocusOut = (): void => undoHistory.seal()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return
      if (isEditableTarget(e.target)) return
      if (!MODIFIER_KEYS.has(e.key)) undoHistory.seal()
      if (!active()) return
      const command = resolveCanvasShortcut(e, mac)
      if (!command) return
      if (command === 'copy' || command === 'cut' || command === 'paste') {
        // Served by the clipboard events below, which the browser dispatches
        // synchronously as the keydown's default action. Where it does not
        // (a synthesized key, an embedding that maps the shortcut elsewhere),
        // run the command directly once the keydown task is over.
        if (command !== 'copy' && flags.current.isReadonly) return
        if (gestureInProgress()) return
        pendingClipboardKey = command
        setTimeout(() => {
          if (pendingClipboardKey !== command) return
          pendingClipboardKey = null
          void run(command)
        }, 0)
        return
      }
      if (flags.current.isReadonly && command !== 'selectAll') return
      e.preventDefault()
      // Undo in the middle of a drag would rewrite what the pointer is holding.
      if (gestureInProgress()) return
      void run(command)
    }

    // Chromium enables its Copy/Cut command only when there is a DOM selection
    // OR a `beforecopy`/`beforecut` listener cancels the event; the canvas
    // selection is not a DOM selection, so without this no copy event fires.
    const onBeforeCopy = (e: Event): void => {
      if (isEditableTarget(e.target) || hasTextSelection() || !active()) return
      if (useModelStore.getState().selectedItems.length > 0) e.preventDefault()
    }

    const onCopy = (e: ClipboardEvent, cut: boolean): void => {
      // The browser did dispatch the event: the keydown fallback stands down,
      // whether or not the canvas takes this copy.
      pendingClipboardKey = null
      if (isEditableTarget(e.target) || hasTextSelection() || !active() || !e.clipboardData) return
      if (cut && flags.current.isReadonly) return
      if (gestureInProgress()) return
      const encoded = cut ? cutSelection() : copySelection()
      if (!encoded) return
      e.clipboardData.setData(CANVAS_CLIPBOARD_MIME, encoded.json)
      e.clipboardData.setData('text/html', encoded.html)
      e.clipboardData.setData('text/plain', encoded.text)
      e.preventDefault()
    }
    const onCopyEvent = (e: ClipboardEvent): void => onCopy(e, false)
    const onCutEvent = (e: ClipboardEvent): void => onCopy(e, true)

    const onPaste = (e: ClipboardEvent): void => {
      pendingClipboardKey = null
      if (isEditableTarget(e.target) || !active() || flags.current.isReadonly || !e.clipboardData) return
      const data = e.clipboardData
      const payload = readClipboardPayload((type) => data.getData(type))
      if (!payload) return // someone else's content: not ours to interpret
      e.preventDefault()
      void pastePayload(payload, { visibleRect: visibleRect() })
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    window.addEventListener('blur', onPointerUp)
    document.addEventListener('focusout', onFocusOut, true)
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('beforecopy', onBeforeCopy)
    document.addEventListener('beforecut', onBeforeCopy)
    document.addEventListener('copy', onCopyEvent)
    document.addEventListener('cut', onCutEvent)
    document.addEventListener('paste', onPaste)
    return () => {
      pendingClipboardKey = null
      document.removeEventListener('beforecopy', onBeforeCopy)
      document.removeEventListener('beforecut', onBeforeCopy)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      window.removeEventListener('blur', onPointerUp)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('copy', onCopyEvent)
      document.removeEventListener('cut', onCutEvent)
      document.removeEventListener('paste', onPaste)
      undoHistory.pointerHeld = false
      undoHistory.editingField = () => false
    }
  }, [active, gestureInProgress, mac, run, visibleRect])

  return { run, mac }
}
