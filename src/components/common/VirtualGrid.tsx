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

import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useVirtualRows } from './VirtualList'
import {
  virtualGridColumnCount,
  virtualGridRowCount,
  virtualGridRowItems,
} from './virtualGridLayout'

export function VirtualGrid<T>({
  items,
  scrollRef,
  minColumnWidth,
  estimateRowHeight,
  columnGap = 16,
  rowGap = 16,
  overscan = 3,
  getItemKey,
  renderItem,
}: {
  items: T[]
  scrollRef: RefObject<HTMLElement | null>
  minColumnWidth: number
  estimateRowHeight: number
  columnGap?: number
  rowGap?: number
  overscan?: number
  getItemKey: (item: T) => string
  renderItem: (item: T) => ReactNode
}) {
  const widthRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = widthRef.current
    if (!element) return
    const update = (nextWidth?: number) => {
      const measured = nextWidth ?? element.getBoundingClientRect().width
      setWidth((current) => current === measured ? current : measured)
    }
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width))
      observer.observe(element)
      return () => observer.disconnect()
    }
    const frame = window.requestAnimationFrame(() => update())
    const onResize = () => update()
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const columns = virtualGridColumnCount(width, minColumnWidth, columnGap)
  const rowCount = virtualGridRowCount(items.length, columns)
  const { virtualItems, totalSize, measureElement } = useVirtualRows({
    scrollRef,
    count: rowCount,
    estimateSize: () => estimateRowHeight + rowGap,
    overscan,
    getItemKey: (rowIndex) => getItemKey(items[rowIndex * columns]),
  })

  return (
    <div
      ref={widthRef}
      role="grid"
      aria-rowcount={rowCount}
      style={{ height: totalSize, position: 'relative', width: '100%' }}
    >
      {virtualItems.map((virtualRow) => (
        <div
          key={virtualRow.key}
          data-index={virtualRow.index}
          ref={measureElement}
          role="row"
          style={{
            display: 'grid',
            gap: columnGap,
            gridTemplateColumns: `repeat(${columns}, minmax(${minColumnWidth}px, 1fr))`,
            left: 0,
            paddingBottom: rowGap,
            position: 'absolute',
            top: 0,
            transform: `translateY(${virtualRow.start}px)`,
            width: '100%',
          }}
        >
          {virtualGridRowItems(items, columns, virtualRow.index).map((item) => (
            <div key={getItemKey(item)} role="gridcell">
              {renderItem(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
