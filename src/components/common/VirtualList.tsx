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
 * VirtualList.tsx — shared virtualization helpers for vertical lists and tables.
 *
 * Wraps @tanstack/react-virtual v3 with sensible defaults for this project's
 * React 19 + TypeScript codebase. Provides:
 *   - `useVirtualRows` hook — low-level, works with any container/markup.
 *   - `VirtualRows` component — convenience wrapper for the common case where
 *     you own the scroll container and just want virtual items rendered.
 *
 * Both helpers enable variable-height row measurement via `measureElement`
 * (a ResizeObserver under the hood) so you don't need to know row heights
 * upfront. For fixed-height rows you can supply a constant `estimateSize`
 * and skip measuring.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACCESSIBILITY GUIDANCE
 * ─────────────────────────────────────────────────────────────────────────────
 * When rendering a <table>:
 *   - Put `role="rowgroup"` on <tbody>.
 *   - Put `aria-rowcount={items.length}` on <table> (total logical rows).
 *   - Put `aria-rowindex={virtualItem.index + 1}` on each rendered <tr>
 *     (1-based per ARIA spec; virtualItem.index is 0-based).
 *
 * When rendering a flat div list:
 *   - Put `role="list"` on the scroll container (or an inner wrapper).
 *   - Put `role="listitem"` on each rendered item div.
 *   - Put `aria-setsize={items.length}` and `aria-posinset={virtualItem.index + 1}`
 *     on each item so screen readers know the total count.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE — table <tbody>
 * ─────────────────────────────────────────────────────────────────────────────
 * ```tsx
 * import { useRef } from 'react'
 * import { useVirtualRows } from '../common/VirtualList'
 *
 * function MyTable({ rows }: { rows: Row[] }) {
 *   const scrollRef = useRef<HTMLDivElement>(null)
 *   const { virtualItems, totalSize, measureElement } = useVirtualRows({
 *     scrollRef,
 *     count: rows.length,
 *     estimateSize: () => 40,   // px — just a hint; real size measured at runtime
 *   })
 *
 *   return (
 *     <div ref={scrollRef} style={{ height: 400, overflowY: 'auto' }}>
 *       <table aria-rowcount={rows.length} style={{ width: '100%' }}>
 *         <thead>…</thead>
 *         <tbody
 *           role="rowgroup"
 *           style={{ display: 'block', height: totalSize, position: 'relative' }}
 *         >
 *           {virtualItems.map((vRow) => (
 *             <tr
 *               key={vRow.key}
 *               data-index={vRow.index}
 *               ref={measureElement}
 *               aria-rowindex={vRow.index + 1}
 *               style={{
 *                 position: 'absolute',
 *                 top: 0,
 *                 transform: `translateY(${vRow.start}px)`,
 *                 width: '100%',
 *               }}
 *             >
 *               <td>{rows[vRow.index].name}</td>
 *             </tr>
 *           ))}
 *         </tbody>
 *       </table>
 *     </div>
 *   )
 * }
 * ```
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE — flat div list
 * ─────────────────────────────────────────────────────────────────────────────
 * ```tsx
 * import { useRef } from 'react'
 * import { useVirtualRows } from '../common/VirtualList'
 *
 * function MyList({ items }: { items: Item[] }) {
 *   const scrollRef = useRef<HTMLDivElement>(null)
 *   const { virtualItems, totalSize, measureElement } = useVirtualRows({
 *     scrollRef,
 *     count: items.length,
 *     estimateSize: () => 48,
 *   })
 *
 *   return (
 *     <div
 *       ref={scrollRef}
 *       role="list"
 *       style={{ height: 600, overflowY: 'auto' }}
 *     >
 *       <div style={{ height: totalSize, position: 'relative' }}>
 *         {virtualItems.map((vItem) => (
 *           <div
 *             key={vItem.key}
 *             data-index={vItem.index}
 *             ref={measureElement}
 *             role="listitem"
 *             aria-setsize={items.length}
 *             aria-posinset={vItem.index + 1}
 *             style={{
 *               position: 'absolute',
 *               top: 0,
 *               transform: `translateY(${vItem.start}px)`,
 *               width: '100%',
 *             }}
 *           >
 *             {items[vItem.index].label}
 *           </div>
 *         ))}
 *       </div>
 *     </div>
 *   )
 * }
 * ```
 */

import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { cn } from '../../lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UseVirtualRowsOptions {
  /** Ref to the element that has `overflow-y: auto/scroll`. */
  scrollRef: RefObject<HTMLElement | null>
  /** Total number of items in the logical list (before virtualization). */
  count: number
  /**
   * Called for each index to get an estimated row height in pixels.
   * For fixed-height rows pass `() => ROW_HEIGHT`.
   * For variable-height rows pass your best guess — the virtualizer will
   * correct it after measuring the real element via `measureElement`.
   */
  estimateSize: (index: number) => number
  /**
   * Extra rows rendered above and below the visible window.
   * Defaults to 5. Increase for fast-scrolling lists.
   */
  overscan?: number
  /**
   * Optional key extractor. Defaults to the numeric index.
   * Supply this when your items can be reordered (e.g. sorted tables) to
   * prevent the virtualizer from recycling DOM nodes incorrectly.
   */
  getItemKey?: (index: number) => string | number
}

export interface UseVirtualRowsResult {
  /** The subset of items that should be rendered right now. */
  virtualItems: VirtualItem[]
  /**
   * The total height (px) of the full logical list.
   * Set this as `height` on the inner spacer element so the scrollbar
   * accurately reflects the true list length.
   */
  totalSize: number
  /**
   * Ref callback — attach to every rendered row element via `ref={measureElement}`.
   * The element must also carry `data-index={virtualItem.index}` so the
   * virtualizer can map the measured size back to the correct item.
   *
   * If all your rows are exactly `estimateSize()` pixels tall you can skip
   * this and omit `data-index` attributes.
   */
  measureElement: (node: Element | null) => void
  /**
   * Programmatically scroll to a given index.
   * Pass `{ align: 'start' | 'center' | 'end' | 'auto' }` to control alignment.
   */
  scrollToIndex: (index: number, options?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * `useVirtualRows` — the primary API for consumers.
 *
 * Wraps `useVirtualizer` from @tanstack/react-virtual with the scroll-element
 * wiring already handled. Supports variable-height rows via ResizeObserver
 * measurement.
 *
 * @example
 * ```tsx
 * const scrollRef = useRef<HTMLDivElement>(null)
 * const { virtualItems, totalSize, measureElement } = useVirtualRows({
 *   scrollRef,
 *   count: rows.length,
 *   estimateSize: () => 40,
 * })
 * ```
 */
// This virtualization hook is intentionally co-located with the VirtualList component it pairs
// with; the only cost is a full HMR reload of this file in dev (not a correctness issue).
// eslint-disable-next-line react-refresh/only-export-components
export function useVirtualRows({
  scrollRef,
  count,
  estimateSize,
  overscan = 5,
  getItemKey,
}: UseVirtualRowsOptions): UseVirtualRowsResult {
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan,
    ...(getItemKey ? { getItemKey } : {}),
    // Enable ResizeObserver-based measurement so variable-height rows are
    // sized correctly after they are painted.
    measureElement: (el) => el.getBoundingClientRect().height,
  })

  // Stable ref callback that reads `data-index` from the DOM node and
  // forwards it to the virtualizer's internal measureElement.
  const measureElement = useCallback(
    (node: Element | null) => {
      if (node) virtualizer.measureElement(node)
    },
    [virtualizer],
  )

  return {
    virtualItems: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    measureElement,
    scrollToIndex: (index, options) => virtualizer.scrollToIndex(index, options),
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface VirtualRowsProps<T> {
  /** The full array of items (all items, not just visible ones). */
  items: T[]
  /**
   * Estimated height (px) per row, or a function `(index) => number`.
   * For uniform-height rows a constant number is fine.
   */
  estimateSize: number | ((index: number) => number)
  /**
   * Ref to the scroll container element.
   * The scroll container must have a fixed height and `overflow-y: auto/scroll`.
   */
  scrollRef: RefObject<HTMLElement | null>
  /**
   * Render prop — receives one virtual item at a time.
   * The rendered element MUST:
   *   1. Have `data-index={vItem.index}` for measurement to work.
   *   2. Have `ref={measureElement}` if you want variable-height support.
   *   3. Be positioned with `position: absolute; top: 0; transform: translateY(${vItem.start}px)`.
   */
  children: (params: {
    vItem: VirtualItem
    item: T
    measureElement: (node: Element | null) => void
  }) => React.ReactNode
  /**
   * Optional key extractor. Defaults to the numeric index.
   */
  getItemKey?: (index: number, item: T) => string | number
  /** Extra rows rendered outside the viewport. Defaults to 5. */
  overscan?: number
}

/**
 * `<VirtualRows>` — convenience component for flat virtual lists.
 *
 * Renders an absolutely-positioned spacer `<div>` at `totalSize` height and
 * calls `children` for each visible virtual item. You are responsible for
 * providing the outer scroll container (via `scrollRef`).
 *
 * @example
 * ```tsx
 * <div ref={scrollRef} style={{ height: 400, overflowY: 'auto', position: 'relative' }}>
 *   <VirtualRows items={rows} estimateSize={40} scrollRef={scrollRef}>
 *     {({ vItem, item, measureElement }) => (
 *       <div
 *         key={vItem.key}
 *         data-index={vItem.index}
 *         ref={measureElement}
 *         style={{ position: 'absolute', top: 0, transform: `translateY(${vItem.start}px)`, width: '100%' }}
 *       >
 *         {item.label}
 *       </div>
 *     )}
 *   </VirtualRows>
 * </div>
 * ```
 */
export function VirtualRows<T>({
  items,
  estimateSize,
  scrollRef,
  children,
  getItemKey,
  overscan = 5,
}: VirtualRowsProps<T>): React.ReactNode {
  const estimateFn = typeof estimateSize === 'number' ? () => estimateSize : estimateSize
  const { virtualItems, totalSize, measureElement } = useVirtualRows({
    scrollRef,
    count: items.length,
    estimateSize: estimateFn,
    overscan,
    ...(getItemKey ? { getItemKey: (i) => getItemKey(i, items[i]) } : {}),
  })

  return (
    <div style={{ height: totalSize, position: 'relative' }}>
      {virtualItems.map((vItem) =>
        children({ vItem, item: items[vItem.index], measureElement }),
      )}
    </div>
  )
}

// ─── All-in-one component ───────────────────────────────────────────────────────

export interface VirtualListProps<T> {
  items: T[]
  /** Estimated row height in px (rows are then measured for variable heights). */
  estimateSize: number
  getKey: (item: T, index: number) => string
  renderRow: (item: T, index: number) => React.ReactNode
  /** Extra rows rendered above/below the viewport. Defaults to 8. */
  overscan?: number
  /** Rendered instead of the list when there are no items. */
  emptyState?: React.ReactNode
  /** Bounds the scroll container height. Omit when a parent flex rule sizes it. */
  maxHeight?: number | string
  className?: string
  /** Called as the virtual window approaches the logical end of the list. */
  onEndReached?: () => void
  endReachedThreshold?: number
  /** Non-virtualized status content rendered after the logical list. */
  footer?: ReactNode
}

/**
 * `<VirtualList>` — the most ergonomic surface: it OWNS the scroll container and
 * does the spacer + absolute positioning for you. Use this for simple flat lists
 * (e.g. a tag list); reach for `useVirtualRows`/`VirtualRows` when you need to own
 * the container markup (e.g. a <table> tbody). All three share one virtualizer impl.
 */
export function VirtualList<T>({
  items,
  estimateSize,
  getKey,
  renderRow,
  overscan = 8,
  emptyState,
  maxHeight,
  className,
  onEndReached,
  endReachedThreshold = 6,
  footer,
}: VirtualListProps<T>): React.ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { virtualItems, totalSize, measureElement } = useVirtualRows({
    scrollRef,
    count: items.length,
    estimateSize: () => estimateSize,
    overscan,
    getItemKey: (i) => getKey(items[i], i),
  })

  const lastVirtualIndex = virtualItems.at(-1)?.index ?? -1
  useEffect(() => {
    if (!onEndReached || items.length === 0) return
    if (lastVirtualIndex >= items.length - 1 - endReachedThreshold) onEndReached()
  }, [endReachedThreshold, items.length, lastVirtualIndex, onEndReached])

  if (items.length === 0 && emptyState !== undefined) {
    return <>{emptyState}</>
  }

  return (
    <div ref={scrollRef} className={cn('overflow-y-auto min-h-0', className)} style={{ maxHeight }}>
      <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
        {virtualItems.map((vi) => (
          <div
            key={getKey(items[vi.index], vi.index)}
            data-index={vi.index}
            ref={measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vi.start}px)`,
            }}
          >
            {renderRow(items[vi.index], vi.index)}
          </div>
        ))}
      </div>
      {footer}
    </div>
  )
}
