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

import { useRef } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VirtualGrid } from './VirtualGrid'

vi.mock('./VirtualList', () => ({
  useVirtualRows: ({ count }: { count: number }) => ({
    virtualItems: Array.from({ length: Math.min(3, count) }, (_, index) => ({
      index,
      key: index,
      start: index * 232,
    })),
    totalSize: count * 232,
    measureElement: () => undefined,
  }),
}))

class WidthObserver {
  private readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe() {
    this.callback(
      [{ contentRect: { width: 1_000 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  disconnect() {}
}

describe('VirtualGrid rendering', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', WidthObserver))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps a 30k-card logical grid to the three virtual rows requested by the viewport', async () => {
    const diagrams = Array.from({ length: 30_000 }, (_, index) => `diagram-${index}`)
    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null)
      return (
        <div ref={scrollRef}>
          <VirtualGrid
            items={diagrams}
            scrollRef={scrollRef}
            minColumnWidth={232}
            estimateRowHeight={216}
            getItemKey={(diagram) => diagram}
            renderItem={(diagram) => <span data-testid="diagram-card">{diagram}</span>}
          />
        </div>
      )
    }

    render(<Harness />)
    await waitFor(() => expect(screen.getAllByTestId('diagram-card')).toHaveLength(12))
    expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe('7500')
  })
})
