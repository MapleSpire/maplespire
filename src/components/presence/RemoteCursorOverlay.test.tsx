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
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIAGRAM_PRESENCE_CHANNEL } from '../../lib/presence/protocol'
import { useDiagramPresenceStore } from '../../stores/diagramPresenceStore'
import { RemoteCursorOverlay } from './RemoteCursorOverlay'

describe('RemoteCursorOverlay', () => {
  const frames: FrameRequestCallback[] = []

  beforeEach(() => {
    frames.length = 0
    useDiagramPresenceStore.getState().reset()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders and reprojects a real server-sanitized remote cursor', () => {
    act(() => {
      useDiagramPresenceStore.getState().receive('peer-bob', {
        channel: DIAGRAM_PRESENCE_CHANNEL,
        version: 1,
        kind: 'cursor',
        sequence: 1,
        cursor: { x: 42, y: 84, view: '2d', visible: true },
        participant: { participantId: 'p_bbbbbbbbbbbbbbbb', firstName: 'Bob', initials: 'B' },
      })
    })
    const { container } = render(
      <RemoteCursorOverlay project={(cursor) => ({ x: cursor.x + 10, y: cursor.y + 20, visible: true })} />,
    )
    act(() => frames.shift()?.(0))
    const cursor = container.querySelector<HTMLElement>('[data-presence-cursor="p_bbbbbbbbbbbbbbbb"]')
    expect(cursor?.dataset.presenceName).toBe('Bob')
    expect(cursor?.style.transform).toBe('translate3d(52px, 104px, 0)')
  })
})
