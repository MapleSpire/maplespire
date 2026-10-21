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

// @vitest-environment jsdom

/**
 * The DOM wiring of the canvas commands: which key and clipboard events the
 * canvas takes, and which it must leave to a text field, a read-only canvas or
 * another page.
 */

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasCommands } from './useCanvasCommands'
import { copySelection, resetCanvasClipboard } from './canvasCommands'
import { undoHistory } from '../../lib/history/undoHistory'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { C4Object, Diagram } from '../../types'

const object = (id: string, x: number): C4Object => ({
  id, type: 'app', name: id, position: { x, y: 0 }, size: { width: 100, height: 50 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
}) as C4Object

let field: HTMLInputElement

beforeEach(() => {
  resetCanvasClipboard()
  useUIStore.setState({ canvasViewMode: '2d', currentView: 'diagram' })
  useModelStore.setState({
    objects: [object('A', 0)],
    connections: [],
    groups: [],
    tags: [],
    diagrams: [{ id: 'd1', name: 'one', type: 'context', objectIds: ['A'], connectionIds: [], groupIds: [], layouts: {} } as unknown as Diagram],
    currentDiagramId: 'd1',
    selectedItems: [{ id: 'A', type: 'object' }],
    workspaceReadOnly: false,
  })
  undoHistory.clear()
  field = document.createElement('input')
  document.body.appendChild(field)
})

afterEach(() => {
  cleanup()
  field.remove()
  vi.restoreAllMocks()
})

function mount(over: { isReadonly?: boolean; disabled?: boolean } = {}) {
  return renderHook(() => useCanvasCommands({
    engineRef: { current: null },
    canvasRef: { current: null },
    isReadonly: over.isReadonly ?? false,
    disabled: over.disabled ?? false,
  }))
}

function pressUndo(target: EventTarget, mac: boolean): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('keyboard', () => {
  it('Ctrl/⌘+Z on the page undoes; the same keys typed in a text field are the field\'s own', () => {
    const undo = vi.spyOn(undoHistory, 'undo').mockReturnValue(true)
    const { result } = mount()

    const inField = pressUndo(field, result.current.mac)
    expect(undo).not.toHaveBeenCalled()
    expect(inField.defaultPrevented).toBe(false)

    const onPage = pressUndo(document.body, result.current.mac)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(onPage.defaultPrevented).toBe(true)
  })

  it('does nothing on a read-only canvas or outside the diagram view', () => {
    const undo = vi.spyOn(undoHistory, 'undo').mockReturnValue(true)
    const readonly = mount({ isReadonly: true })
    pressUndo(document.body, readonly.result.current.mac)
    readonly.unmount()
    expect(undo).not.toHaveBeenCalled()

    useUIStore.setState({ currentView: 'model-objects' })
    const elsewhere = mount()
    pressUndo(document.body, elsewhere.result.current.mac)
    expect(undo).not.toHaveBeenCalled()
  })
})

describe('clipboard events', () => {
  function pasteEvent(target: EventTarget, data: Record<string, string>): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '' } })
    target.dispatchEvent(event)
    return event
  }

  it('a paste into a text field is the field\'s, even when the clipboard holds canvas shapes', async () => {
    const encoded = copySelection()!
    mount()
    const data = { 'text/html': encoded.html, 'text/plain': encoded.text }

    const inField = pasteEvent(field, data)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inField.defaultPrevented).toBe(false)
    expect(useModelStore.getState().objects).toHaveLength(1)

    // Control: the same event on the page pastes a copy.
    const onPage = pasteEvent(document.body, data)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onPage.defaultPrevented).toBe(true)
    expect(useModelStore.getState().objects).toHaveLength(2)
  })
})

describe('gesture boundaries', () => {
  it('pointerdown seals the open entry and marks the pointer held until pointerup', () => {
    const seal = vi.spyOn(undoHistory, 'seal')
    mount()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(seal).toHaveBeenCalled()
    expect(undoHistory.pointerHeld).toBe(true)
    window.dispatchEvent(new Event('pointerup'))
    expect(undoHistory.pointerHeld).toBe(false)
  })
})
