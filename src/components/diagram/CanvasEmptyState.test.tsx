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
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasEmptyState } from './CanvasEmptyState'

afterEach(cleanup)

describe('CanvasEmptyState', () => {
  it('stays below and click-through to the editor chrome while keeping its action usable', () => {
    const onCreate = vi.fn()

    render(
      <CanvasEmptyState
        title="No diagrams yet"
        body="Create one to begin."
        action="Create a context diagram"
        onCreate={onCreate}
      />,
    )

    const layer = screen.getByTestId('no-diagrams')
    expect(layer.className).toContain('z-10')
    expect(layer.className).toContain('pointer-events-none')

    const button = screen.getByRole('button', { name: 'Create a context diagram' })
    expect(button.closest('div')?.className).toContain('pointer-events-auto')
    fireEvent.click(button)
    expect(onCreate).toHaveBeenCalledTimes(1)
  })
})
