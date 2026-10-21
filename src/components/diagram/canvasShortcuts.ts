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

/**
 * Canvas keyboard shortcuts, as a pure function of the key event — the same
 * table for the 2D canvas and the 3D board.
 *
 *   Undo          Ctrl+Z            ⌘Z
 *   Redo          Ctrl+Shift+Z      ⌘⇧Z
 *                 Ctrl+Y            (not on a Mac: ⌘Y opens History in Safari)
 *   Copy          Ctrl+C            ⌘C
 *   Cut           Ctrl+X            ⌘X
 *   Paste         Ctrl+V            ⌘V
 *   Paste as copy Ctrl+Shift+V      ⌘⇧V
 *   Duplicate     Ctrl+D            ⌘D
 *   Select all    Ctrl+A            ⌘A
 *   Remove        Delete/Backspace  (from this diagram; the model keeps it)
 *
 * The modifier is ⌘ on a Mac and Ctrl elsewhere, never both: Ctrl+Z on a Mac
 * is not an undo there and must not become one here. The letter is read from
 * `key` (so AZERTY/QWERTZ users press the key that SAYS Z), falling back to the
 * physical `code` when the layout produces no Latin letter (Cyrillic, Greek…).
 */

export type CanvasCommand =
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'pasteAsCopy'
  | 'duplicate'
  | 'selectAll'
  | 'remove'

export interface ShortcutKeyEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = uaData?.platform || navigator.platform || navigator.userAgent
  return /mac|iphone|ipad|ipod/i.test(platform)
}

function letterOf(e: ShortcutKeyEvent): string | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : ''
  if (/^[a-z]$/.test(key)) return key
  const match = /^Key([A-Z])$/.exec(e.code ?? '')
  return match ? match[1].toLowerCase() : null
}

export function resolveCanvasShortcut(e: ShortcutKeyEvent, mac: boolean): CanvasCommand | null {
  if (e.altKey) return null
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) return 'remove'
    return null
  }
  switch (letterOf(e)) {
    case 'z': return e.shiftKey ? 'redo' : 'undo'
    case 'y': return !mac && !e.shiftKey ? 'redo' : null
    case 'c': return e.shiftKey ? null : 'copy'
    case 'x': return e.shiftKey ? null : 'cut'
    case 'v': return e.shiftKey ? 'pasteAsCopy' : 'paste'
    case 'd': return e.shiftKey ? null : 'duplicate'
    case 'a': return e.shiftKey ? null : 'selectAll'
    default: return null
  }
}

/** Human label for a tooltip: "Ctrl+Shift+Z" / "⌘⇧Z". */
export function shortcutLabel(command: 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'pasteAsCopy' | 'duplicate', mac: boolean): string {
  const letter = { undo: 'Z', redo: 'Z', copy: 'C', cut: 'X', paste: 'V', pasteAsCopy: 'V', duplicate: 'D' }[command]
  const shift = command === 'redo' || command === 'pasteAsCopy'
  return mac ? `⌘${shift ? '⇧' : ''}${letter}` : `Ctrl+${shift ? 'Shift+' : ''}${letter}`
}

/**
 * Keys typed into a field belong to the field — its own undo, copy and paste
 * included. Same guard as CanvasView's and CreateShapePalette's handlers, plus
 * selects and anything inside an open dialog.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false
  const el = target as HTMLElement
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true
  // Widgets that own their keys (Backspace in a picker, arrows in a list).
  return typeof el.closest === 'function'
    && el.closest('[role="dialog"],[aria-modal="true"],[role="listbox"],[role="combobox"],[role="textbox"],[role="grid"],[role="menu"]') !== null
}
