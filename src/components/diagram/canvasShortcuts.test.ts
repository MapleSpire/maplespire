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

import { describe, expect, it } from 'vitest'
import { isEditableTarget, resolveCanvasShortcut, shortcutLabel, type ShortcutKeyEvent } from './canvasShortcuts'

const key = (k: string, mods: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  key: k,
  code: mods.code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('resolveCanvasShortcut — Windows/Linux', () => {
  const win = (e: ShortcutKeyEvent) => resolveCanvasShortcut(e, false)

  it.each([
    [key('z', { ctrlKey: true }), 'undo'],
    [key('Z', { ctrlKey: true, shiftKey: true }), 'redo'],
    [key('y', { ctrlKey: true }), 'redo'],
    [key('c', { ctrlKey: true }), 'copy'],
    [key('x', { ctrlKey: true }), 'cut'],
    [key('v', { ctrlKey: true }), 'paste'],
    [key('V', { ctrlKey: true, shiftKey: true }), 'pasteAsCopy'],
    [key('d', { ctrlKey: true }), 'duplicate'],
    [key('a', { ctrlKey: true }), 'selectAll'],
    [key('Delete'), 'remove'],
    [key('Backspace'), 'remove'],
  ])('%o → %s', (event, command) => {
    expect(win(event)).toBe(command)
  })

  it('ignores the Mac modifier, Alt chords and unmodified letters', () => {
    expect(win(key('z', { metaKey: true }))).toBeNull()
    expect(win(key('z', { ctrlKey: true, altKey: true }))).toBeNull() // AltGr on European layouts
    expect(win(key('z'))).toBeNull()
    expect(win(key('Delete', { ctrlKey: true }))).toBeNull()
    expect(win(key('Delete', { shiftKey: true }))).toBeNull()
    expect(win(key('x', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('reads the letter the layout produces (AZERTY Ctrl+Z is the key labelled Z)', () => {
    // On AZERTY the Z key sits where QWERTY has W.
    expect(win(key('z', { ctrlKey: true, code: 'KeyW' }))).toBe('undo')
    expect(win(key('w', { ctrlKey: true, code: 'KeyZ' }))).toBeNull()
  })

  it('falls back to the physical key when the layout produces no Latin letter', () => {
    expect(win(key('я', { ctrlKey: true, code: 'KeyZ' }))).toBe('undo')
    expect(win(key('с', { ctrlKey: true, code: 'KeyC' }))).toBe('copy')
  })
})

describe('resolveCanvasShortcut — Mac', () => {
  const mac = (e: ShortcutKeyEvent) => resolveCanvasShortcut(e, true)

  it('uses ⌘, never Ctrl', () => {
    expect(mac(key('z', { metaKey: true }))).toBe('undo')
    expect(mac(key('z', { metaKey: true, shiftKey: true }))).toBe('redo')
    expect(mac(key('z', { ctrlKey: true }))).toBeNull()
    expect(mac(key('z', { ctrlKey: true, metaKey: true }))).toBeNull()
  })

  it('does not take ⌘Y (History in Safari)', () => {
    expect(mac(key('y', { metaKey: true }))).toBeNull()
  })
})

describe('isEditableTarget — keys typed into a field belong to the field', () => {
  // Duck-typed targets: jsdom does not implement `isContentEditable`, so a real
  // element could not tell whether that branch works.
  const el = (tagName: string, extra: Record<string, unknown> = {}) =>
    ({ tagName, isContentEditable: false, closest: () => null, ...extra }) as unknown as EventTarget

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('%s is editable', (tag) => {
    expect(isEditableTarget(el(tag))).toBe(true)
  })

  it('a contenteditable element is editable', () => {
    expect(isEditableTarget(el('DIV', { isContentEditable: true }))).toBe(true)
  })

  it('anything inside an open dialog is left alone', () => {
    const inDialog = el('BUTTON', { closest: (selector: string) => (selector.includes('role="dialog"') ? {} : null) })
    const inModal = el('BUTTON', { closest: (selector: string) => (selector.includes('aria-modal="true"') ? {} : null) })
    expect(isEditableTarget(inDialog)).toBe(true)
    expect(isEditableTarget(inModal)).toBe(true)
  })

  it('the canvas, the page and no target at all are not editable', () => {
    expect(isEditableTarget(el('CANVAS'))).toBe(false)
    expect(isEditableTarget(el('BODY'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget({} as EventTarget)).toBe(false) // window: no tagName
  })
})

describe('shortcutLabel', () => {
  it('names the platform modifier', () => {
    expect(shortcutLabel('undo', false)).toBe('Ctrl+Z')
    expect(shortcutLabel('redo', false)).toBe('Ctrl+Shift+Z')
    expect(shortcutLabel('undo', true)).toBe('⌘Z')
    expect(shortcutLabel('redo', true)).toBe('⌘⇧Z')
    expect(shortcutLabel('pasteAsCopy', false)).toBe('Ctrl+Shift+V')
  })
})
