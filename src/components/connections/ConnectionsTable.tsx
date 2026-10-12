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

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import {
  ArrowRight,
  MoreHorizontal,
  Trash2,
  ArrowUpDown,
  Monitor,
  Box,
  Database,
  Puzzle,
  User,
  Boxes,
  LoaderCircle,
  AlertCircle,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { cn } from '../../lib/utils'
import type { Connection, C4Type } from '../../types'
import { getModelQuery, residentModelQuery } from '../../lib/modelQuery'
import { tombstoneConnectionOffWindow } from '../../lib/automerge/bridge'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import type { ConnectionRow } from '../../lib/modelQuery/types'
import { useVirtualRows } from '../common/VirtualList'
import { useCursorRows, useDebouncedValue } from '../common/useCursorRows'

// Sender/receiver endpoints render as a per-C4-type tinted tile (design: app keys
// off the brand orange, system reads blue-grey, others stay calm warm-grey). The
// tile is always present so the column stays aligned even when a type is unknown.
const ENDPOINT_TILE: Record<C4Type, { Icon: LucideIcon; token: string }> = {
  actor: { Icon: User, token: '--color-c4-actor' },
  system: { Icon: Monitor, token: '--color-c4-system' },
  app: { Icon: Box, token: '--color-c4-app' },
  store: { Icon: Database, token: '--color-c4-store' },
  component: { Icon: Puzzle, token: '--color-c4-component' },
}

function EndpointTile({ type }: { type?: C4Type }) {
  const cfg = type ? ENDPOINT_TILE[type] : undefined
  const Icon = cfg?.Icon ?? Boxes
  const token = cfg?.token ?? '--color-fg-muted'
  return (
    <span
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md"
      style={{
        backgroundColor: `color-mix(in srgb, var(${token}) 16%, transparent)`,
        color: `var(${token})`,
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  )
}

export function ConnectionsTable({
  onTotals,
}: {
  /** Whole-model total for the shell footer. */
  onTotals?: (totals: { total: number }) => void
}) {
  const { t } = useTranslation()
  // Subscribe to the store ARRAY REFS as a change signal only — the rows
  // themselves come windowed from getModelQuery().connectionRows, so the view
  // never builds a row object per connection (it built 30k+ before).
  const resident = getModelQuery() === residentModelQuery
  const connectionsRef = useModelStore((s) => resident ? s.connections : null)
  const objectsRef = useModelStore((s) => resident ? s.objects : null)
  const diagramsRef = useModelStore((s) => resident ? s.diagrams : null)
  const flowsRef = useModelStore((s) => resident ? s.flows : null)
  const selectedItems = useModelStore((s) => s.selectedItems)
  const selectConnection = useModelStore((s) => s.selectConnection)
  const deleteConnection = useModelStore((s) => s.deleteConnection)

  const searchQuery = useUIStore((s) => s.connectionsSearchQuery)
  const domainId = useUIStore((s) => s.connectionsDomainId)
  const sortBy = useUIStore((s) => s.connectionsSortBy)
  const sortAsc = useUIStore((s) => s.connectionsSortAsc)
  const setSortBy = useUIStore((s) => s.setConnectionsSortBy)
  const setSortAsc = useUIStore((s) => s.setConnectionsSortAsc)
  // Re-fetch when the persisted index changes (background cold-build completes /
  // incremental update) so a windowed store refreshes to the whole model.
  const indexVersion = useModelIndexVersion((s) => s.version)

  const debouncedSearch = useDebouncedValue(searchQuery.trim(), 200)
  const fetchPage = useCallback(
    async (cursor: string | null, signal: AbortSignal) => {
      const page = await getModelQuery().connectionPage({
        search: debouncedSearch, domainId, sortBy, sortAsc, cursor, limit: 50,
      }, signal)
      return { ...page, revision: page.projectionGeneration }
    },
    [debouncedSearch, domainId, sortAsc, sortBy],
  )
  const queryKey = `${debouncedSearch}\u0000${domainId ?? ''}\u0000${sortBy}\u0000${sortAsc}`
  const refreshKey = useMemo(
    () => ({ indexVersion, connectionsRef, objectsRef, diagramsRef, flowsRef }),
    [connectionsRef, diagramsRef, flowsRef, indexVersion, objectsRef],
  )
  const cursorRows = useCursorRows<ConnectionRow>({
    queryKey,
    refreshKey,
    fetchPage,
    keyOf: useCallback((row) => row.connection.id, []),
  })
  const { items: rows, total } = cursorRows

  // Lift the whole-model total into the shell footer.
  useEffect(() => {
    onTotals?.({ total })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onTotals is a state setter
  }, [total])

  const handleSort = useCallback(
    (by: 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows') => {
      if (sortBy === by) {
        setSortAsc(!sortAsc)
      } else {
        setSortBy(by)
        setSortAsc(true)
      }
    },
    [sortBy, sortAsc, setSortBy, setSortAsc]
  )

  const scrollRef = useRef<HTMLDivElement>(null)

  const { virtualItems, totalSize, measureElement } = useVirtualRows({
    scrollRef,
    count: rows.length,
    estimateSize: () => 40,
    getItemKey: (i) => rows[i]?.connection.id ?? `idx-${i}`,
  })

  // Continue the signed keyset cursor when the end of the virtual window appears.
  useEffect(() => {
    const last = virtualItems.at(-1)?.index ?? -1
    if (last >= rows.length - 2 && cursorRows.nextCursor && !cursorRows.loading) {
      cursorRows.loadMore()
    }
  }, [cursorRows, rows.length, virtualItems])

  // Virtualization via leading/trailing spacer rows keeps the table a single
  // native <table>, so header and body columns always share the same layout.
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0

  const isSelected = (conn: Connection) =>
    selectedItems.some((s) => s.id === conn.id && s.type === 'connection')

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        ref={scrollRef}
        data-testid="connections-table-scroll"
        data-loaded-row-count={rows.length}
        data-rendered-row-count={virtualItems.length}
        data-refreshing={cursorRows.refreshing ? 'true' : 'false'}
        className="flex-1 overflow-auto"
      >
        {cursorRows.coverage === 'working-set' && (
          <div className="sticky top-1 z-20 mx-auto flex w-fit items-center gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-[11px] text-warning-text">
            <WifiOff className="h-3.5 w-3.5" />{t('diagramChrome.addShape.partialOffline')}
          </div>
        )}
        {cursorRows.loading && rows.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-surface-50/80 text-[12px] text-fg-subtle">
            <LoaderCircle className="h-4 w-4 animate-spin" />{t('diagramChrome.addShape.loading')}
          </div>
        )}
        {cursorRows.error && rows.length === 0 && (
          <div className="absolute inset-x-0 top-16 z-20 mx-auto w-fit rounded-lg border border-error-border bg-error-bg px-4 py-3 text-[12px] text-error-text" role="alert">
            <div className="flex items-center gap-2"><AlertCircle className="h-4 w-4" />{t('diagramChrome.addShape.loadError')}</div>
            <button type="button" onClick={cursorRows.retry} className="mt-2 rounded-md border border-error-border px-2 py-1 font-medium">{t('diagramChrome.addShape.retry')}</button>
          </div>
        )}
        {/* Full-bleed base-plane table (kit `pg-thead`/`pg-crow`): first/last
            columns pad by --pad-l/--pad-r so content clears the floating
            sidebars and reflows when they collapse. */}
        <table aria-rowcount={total} className="w-full text-left border-collapse table-fixed">
          <thead className="sticky top-0 bg-surface-50 z-10">
            <tr className="border-b border-line h-10">
              {/* First/last column widths INCLUDE the --pad-l/--pad-r reserve
                  (border-box), so full-bleed rows clear the floating sidebars
                  at any width; low-priority count columns drop out narrow,
                  matching the kit's responsive rules. */}
              <th style={{ width: 'calc(var(--pad-l) + 150px)', paddingLeft: 'var(--pad-l)' }} className="pr-4">
                <SortHeader label={t('dataViewsA.connectionsTable.columnName')} sortKey="name" current={sortBy} onSort={handleSort} />
              </th>
              <th className="px-3">
                <SortHeader label={t('dataViewsA.connectionsTable.columnSender')} sortKey="sender" current={sortBy} onSort={handleSort} />
              </th>
              {/* Arrow column — no header label, like the kit's connection grid. */}
              <th className="w-9" />

              <th className="px-3">
                <SortHeader label={t('dataViewsA.connectionsTable.columnReceiver')} sortKey="receiver" current={sortBy} onSort={handleSort} />
              </th>
              <th className="px-4 text-center w-24 max-[1360px]:hidden">
                <SortHeader label={t('dataViewsA.connectionsTable.columnDiagrams')} sortKey="diagrams" current={sortBy} onSort={handleSort} />
              </th>
              <th className="px-4 text-center w-20 max-[1360px]:hidden">
                <SortHeader label={t('dataViewsA.connectionsTable.columnFlows')} sortKey="flows" current={sortBy} onSort={handleSort} />
              </th>
              <th style={{ width: 'calc(var(--pad-r) + 44px)', paddingRight: 'var(--pad-r)' }} className="pl-2 text-center" />
            </tr>
          </thead>
          <tbody role="rowgroup">
            {paddingTop > 0 && (
              // Height-only spacer: NO colSpan — with table-fixed, a colSpan
              // wider than the visible column count (columns hide responsively)
              // would create phantom columns and steal width.
              <tr aria-hidden="true">
                <td style={{ height: paddingTop, padding: 0, border: 0 }} />
              </tr>
            )}
            {virtualItems.map((vRow) => {
              const row = rows[vRow.index]
              if (!row) {
                // Window not loaded yet — a placeholder keeps the row height stable.
                return (
                  <tr key={vRow.key} data-index={vRow.index} ref={measureElement} aria-rowindex={vRow.index + 1}>
                    {/* colSpan stays ≤ the minimum visible column count. */}
                    <td colSpan={4} style={{ paddingLeft: 'var(--pad-l)' }} className="py-2.5 text-[13px] text-fg-subtle">…</td>
                  </tr>
                )
              }
              const selected = isSelected(row.connection)
              return (
                <tr
                  key={vRow.key}
                  data-testid={`connection-row-${row.connection.id}`}
                  data-index={vRow.index}
                  ref={measureElement}
                  aria-rowindex={vRow.index + 1}
                  onClick={() => selectConnection(row.connection.id)}
                  className={cn(
                    'cursor-pointer transition-colors group',
                    selected ? 'bg-accent-subtle' : 'hover:bg-surface-50'
                  )}
                >
                  <td style={{ paddingLeft: 'var(--pad-l)' }} className="relative pr-4 py-2.5">
                    {/* Selected rows carry the design's 3px accent bar at the row's left edge. */}
                    {selected && <div className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
                    <span
                      className={cn(
                        'block truncate text-[13px]',
                        selected ? 'text-accent font-medium' : 'text-fg'
                      )}
                    >
                      {row.connection.label || t('dataViewsA.connectionsTable.unnamedConnection')}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <EndpointTile type={row.fromType} />
                      <span className="truncate text-[13px] text-fg">{row.fromName}</span>
                    </div>
                  </td>
                  <td className="py-2.5 text-center">
                    <ArrowRight className="w-4 h-4 text-fg-subtle mx-auto" />
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <EndpointTile type={row.toType} />
                      <span className="truncate text-[13px] text-fg">{row.toName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-center max-[1360px]:hidden">
                    <CountCell value={row.diagramCount} />
                  </td>
                  <td className="px-4 py-2.5 text-center max-[1360px]:hidden">
                    <CountCell value={row.flowCount} />
                  </td>
                  <td style={{ paddingRight: 'var(--pad-r)' }} className="pl-2 py-2.5 text-center">
                    <RowActions
                      id={row.connection.id}
                      onDelete={() => {
                        // Off-window connection (the common case on this whole-model page):
                        // deleteConnection only splices the resident store, so tombstone explicitly
                        // so the delete persists (→ index + server read model drop it).
                        deleteConnection(row.connection.id)
                        tombstoneConnectionOffWindow(row.connection.id)
                      }}
                    />
                  </td>
                </tr>
              )
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: paddingBottom, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  current,
  onSort,
}: {
  label: string
  sortKey: 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows'
  current: string
  onSort: (key: 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows') => void
}) {
  const active = current === sortKey
  return (
    <button
      onClick={() => onSort(sortKey)}
      className="flex items-center gap-1 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide hover:text-fg transition-colors"
    >
      {label}
      <ArrowUpDown className={cn('w-3 h-3', active ? 'text-fg' : 'text-fg-subtle')} />
    </button>
  )
}

/** A right-aligned numeric count: monospace + tabular figures so digits line up
 * across rows, and zero is de-emphasized so non-zero counts stand out. */
function CountCell({ value }: { value: number }) {
  return (
    <span
      className={cn(
        'text-[13px] font-mono tabular-nums',
        value === 0 ? 'text-fg-subtle opacity-50' : 'text-fg-subtle'
      )}
    >
      {value}
    </span>
  )
}

function RowActions({ id, onDelete }: { id: string; onDelete: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Deleting a connection is a model write the sync gate drops for a view-only
  // session — don't render the row menu.
  const canManage = !useModelStore((s) => s.workspaceReadOnly)
  if (!canManage) return null

  return (
    <div className="relative">
      <button
        data-testid={`connection-row-menu-${id}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="p-1 rounded hover:bg-surface-200 text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-40 bg-surface-100 border border-line rounded-lg shadow-xl z-30 py-1">
            <button
              data-testid={`connection-row-delete-${id}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
                setOpen(false)
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-error-text hover:bg-surface-200"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('common.delete')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
