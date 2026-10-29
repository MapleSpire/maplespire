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

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  ChevronRight,
  ChevronDown,
  User,
  Monitor,
  Box,
  Database,
  Puzzle,
  Shapes,
  MoreHorizontal,
  Trash2,
  Copy,
  Plus,
  Move,
  LoaderCircle,
  AlertCircle,
  WifiOff,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { cn } from '../../lib/utils'
import { getModelQuery, residentModelQuery } from '../../lib/modelQuery'
import { seedObjectForEdit, tombstoneObjectOffWindow } from '../../lib/automerge/bridge'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import type { ModelObjectRow } from '../../lib/modelQuery/types'
import { TechIconBadge } from '../shared/TechIconBadge'
import { useVirtualRows } from '../common/VirtualList'
import { canReparentObject } from '../../lib/modelHierarchy'
import { useObjectExplorer, type ExplorerVisualRow } from '../diagram/useObjectExplorer'
import { defaultShapeSize } from '../../lib/shapeDefaults'

const typeIcons: Record<string, React.ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  component: Puzzle,
  group: Shapes,
}

// Per-C4-type icon hue so a row's kind reads from its leading icon color.
// Tokens resolve per appearance (light/dark) in src/index.css.
const typeIconColors: Record<string, string> = {
  system: 'var(--color-c4-system)',
  app: 'var(--color-c4-app)',
  store: 'var(--color-c4-store)',
  component: 'var(--color-c4-component)',
  actor: 'var(--color-c4-actor)',
  group: 'var(--color-fg-muted)',
}

// Row shape lives on the ModelQuery seam; the table reads the visible tree
// (root + expanded subtrees) windowed through getModelQuery().modelObjectRows so it
// does not rebuild per-model count maps on every expand/keystroke.
type RowData = ModelObjectRow & {
  loadMoreTreeKey?: string
  loadedChildCount?: number
  childCoverage?: 'working-set' | 'full'
}

function inlineAddRow(parent: ExplorerVisualRow): RowData | null {
  const addTypes = parent.type === 'system'
    ? ['app', 'store'] as const
    : parent.type === 'app' || parent.type === 'store'
      ? ['component'] as const
      : []
  if (!addTypes.length) return null
  return {
    id: `inline-add-${parent.id}`, name: '', type: addTypes[0], level: parent.level + 1,
    childCount: 0, isExpandable: false, appCount: 0, storeCount: 0, componentCount: 0,
    connectionCount: 0, diagramCount: 0, isGroup: false, isInlineAdd: true,
    parentId: parent.id, addTypes: [...addTypes],
  }
}

function explorerRowsToTableRows(explorerRows: ExplorerVisualRow[], searchMode: boolean): RowData[] {
  const output: RowData[] = []
  const expandedStack: ExplorerVisualRow[] = []
  const closeThrough = (level: number) => {
    while (expandedStack.length && expandedStack.at(-1)!.level >= level) {
      const add = inlineAddRow(expandedStack.pop()!)
      if (add) output.push(add)
    }
  }
  for (const row of explorerRows) {
    if (!searchMode) closeThrough(row.level)
    output.push({
      id: row.id,
      name: row.name,
      type: row.type,
      scope: row.scope,
      status: row.status,
      description: row.name,
      level: row.level,
      childCount: row.childCount,
      // A disclosure represents actual descendants, never merely the ability to
      // accept a new child. Creation remains an explicit inline action.
      isExpandable: !searchMode && row.hasChildren,
      appCount: row.appCount,
      storeCount: row.storeCount,
      componentCount: row.componentCount,
      connectionCount: row.connectionCount,
      diagramCount: row.diagramCount,
      domainId: row.domainId,
      isGroup: row.kind === 'group',
      parentId: row.parentId ?? undefined,
      icon: row.icon,
      iconAssignment: row.iconAssignment,
      loadMoreTreeKey: row.loadMoreTreeKey,
      loadedChildCount: row.loadedChildCount,
      childCoverage: row.childCoverage,
    })
    if (!searchMode && row.expanded && row.canAcceptChildren) expandedStack.push(row)
  }
  if (!searchMode) closeThrough(-1)
  return output
}

export function ModelObjectsTable({
  onTotals,
}: {
  /** Whole-model totals for the shell footer (the store may be windowed, so the
   * page can't derive them from the resident arrays). */
  onTotals?: (totals: { total: number }) => void
}) {
  const { t } = useTranslation()
  const resident = getModelQuery() === residentModelQuery
  const objects = useModelStore((s) => resident ? s.objects : null)
  const groups = useModelStore((s) => resident ? s.groups : null)
  const connections = useModelStore((s) => resident ? s.connections : null)
  const diagrams = useModelStore((s) => resident ? s.diagrams : null)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const selectedItems = useModelStore((s) => s.selectedItems)
  const selectObjects = useModelStore((s) => s.selectObjects)
  const selectGroup = useModelStore((s) => s.selectGroup)
  const deleteObject = useModelStore((s) => s.deleteObject)
  const deleteGroup = useModelStore((s) => s.deleteGroup)
  const addObjectToModel = useModelStore((s) => s.addObjectToModel)
  const updateObject = useModelStore((s) => s.updateObject)
  const updateGroup = useModelStore((s) => s.updateGroup)
  const domains = useModelStore((s) => s.domains)
  const expandedIds = useUIStore((s) => s.modelObjectsExpandedIds)
  const toggleExpanded = useUIStore((s) => s.toggleModelObjectsExpanded)
  const searchQuery = useUIStore((s) => s.modelObjectsSearchQuery)
  const filter = useUIStore((s) => s.modelObjectsFilter)
  const domainId = useUIStore((s) => s.modelObjectsDomainId)
  const getDefaultDomain = useModelStore((s) => s.getDefaultDomain)
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  // Re-query when the persisted index changes (e.g. the background cold-build
  // completes, or an incremental shard update lands) so a windowed store still
  // refreshes to the whole model once the index is ready.
  const indexVersion = useModelIndexVersion((s) => s.version)

  const explorerRefreshKey = useMemo(
    () => ({ objects, groups, connections, diagrams, indexVersion }),
    [connections, diagrams, groups, indexVersion, objects],
  )
  const explorerFilters = useMemo(() => ({ ...filter, domainId }), [domainId, filter])
  const explorer = useObjectExplorer({
    query: searchQuery,
    filters: explorerFilters,
    diagramId: currentDiagramId,
    refreshKey: explorerRefreshKey,
    controlledExpandedIds: expandedIds,
    onToggleExpanded: toggleExpanded,
  })
  const rows = useMemo(
    () => explorerRowsToTableRows(explorer.rows, explorer.searchMode),
    [explorer.rows, explorer.searchMode],
  )
  const explorerTotal = explorer.searchMode ? explorer.searchPage.total : explorer.treeRoot?.total
  const explorerRefreshing = rows.length > 0 && (
    explorer.searchMode
      ? explorer.searchPage.loading
      : Boolean(explorer.treeRoot?.loading)
  )
  useEffect(() => {
    if (explorerTotal !== undefined) onTotals?.({ total: explorerTotal })
  }, [explorerTotal, onTotals])

  const handleRowClick = useCallback((row: RowData) => {
    if (row.isInlineAdd) return
    if (row.isGroup) {
      selectGroup(row.id)
    } else {
      selectObjects([row.id])
    }
  }, [selectGroup, selectObjects])

  const handleToggleExpand = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    const row = explorer.rows.find((candidate) => candidate.id === id)
    if (row) explorer.toggleExpanded(row)
  }, [explorer])

  const [draggedRow, setDraggedRow] = useState<RowData | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number } | null>(null)
  const [rootDropActive, setRootDropActive] = useState(false)
  const dropClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const canDropOn = useCallback((source: RowData | null, target: RowData) => {
    if (!source || target.isInlineAdd || source.id === target.id) return false
    const sourceType = source.type
    const targetType = target.type
    if (sourceType === 'group' || targetType === 'group') return false
    return canReparentObject(sourceType, targetType)
  }, [])

  const finishDrag = useCallback(() => {
    if (dropClearTimer.current) clearTimeout(dropClearTimer.current)
    setDraggedRow(null)
    setDropTargetId(null)
    setDragPreview(null)
    setRootDropActive(false)
  }, [])

  useEffect(() => () => {
    if (dropClearTimer.current) clearTimeout(dropClearTimer.current)
  }, [])

  const handleDrop = useCallback(async (target: RowData) => {
    const source = draggedRow
    if (!canDropOn(source, target) || !source) {
      finishDrag()
      return
    }

    // This whole-model page may show index-backed, off-window objects. Seed
    // the dragged object before writing so the normal Automerge bridge keeps
    // the reparenting durable offline and syncs it on reconnection.
    if (!useModelStore.getState().objects.some((object) => object.id === source.id)) {
      const object = await getModelQuery().object(source.id)
      if (object) seedObjectForEdit(object)
    }
    updateObject(source.id, { parentId: target.id })
    if (!expandedIds.includes(target.id)) toggleExpanded(target.id)
    finishDrag()
  }, [canDropOn, draggedRow, expandedIds, finishDrag, toggleExpanded, updateObject])

  const handleDropAtRoot = useCallback(async () => {
    const source = draggedRow
    if (!source || source.isGroup) {
      finishDrag()
      return
    }
    if (!useModelStore.getState().objects.some((object) => object.id === source.id)) {
      const object = await getModelQuery().object(source.id)
      if (object) seedObjectForEdit(object)
    }
    // `parentId: undefined` means a top-level model object. updateObject
    // explicitly deletes that field, so this remains true after sync/reload.
    updateObject(source.id, { parentId: undefined })
    finishDrag()
  }, [draggedRow, finishDrag, updateObject])

  const isSelected = (row: RowData) => {
    if (row.isInlineAdd) return false
    return selectedItems.some((s) => s.id === row.id && (row.isGroup ? s.type === 'group' : s.type === 'object'))
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const { virtualItems, totalSize, measureElement } = useVirtualRows({
    scrollRef,
    count: rows.length,
    // Inline-add rows are ~36 px; regular rows are ~41 px.
    // measureElement corrects these after first paint.
    estimateSize: (index) => (rows[index]?.isInlineAdd ? 36 : 41),
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 5,
  })

  // Virtualization via leading/trailing spacer rows keeps the table a single
  // native <table>, so header and body columns always share the same layout.
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0

  useEffect(() => {
    if (!virtualItems.length) return
    if (explorer.searchMode) {
      const lastVisible = virtualItems.at(-1)?.index ?? -1
      if (lastVisible >= rows.length - 2 && explorer.searchPage.nextCursor && !explorer.searchPage.loading) {
        explorer.loadMoreSearch()
      }
      return
    }
    const keys = new Set(virtualItems
      .map((item) => rows[item.index]?.loadMoreTreeKey)
      .filter((key): key is string => Boolean(key)))
    for (const key of keys) explorer.loadMoreTree(key)
  }, [explorer, rows, virtualItems])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        ref={scrollRef}
        data-testid="mo-table-scroll"
        data-loaded-row-count={rows.length}
        data-rendered-row-count={virtualItems.length}
        data-search-mode={explorer.searchMode ? 'true' : 'false'}
        data-refreshing={explorerRefreshing ? 'true' : 'false'}
        className={cn(
          'relative flex-1 overflow-auto transition-colors',
          rootDropActive && 'bg-accent-subtle/40'
        )}
        onDragOver={(event) => {
          if (!draggedRow) return
          event.preventDefault()
          setDragPreview({ x: event.clientX, y: event.clientY })
          const rowTarget = (event.target as HTMLElement).closest('tr[data-testid^="mo-row-"]')
          if (!rowTarget) {
            if (dropClearTimer.current) clearTimeout(dropClearTimer.current)
            setDropTargetId(null)
            setRootDropActive(true)
          }
        }}
        onDrop={(event) => {
          const rowTarget = (event.target as HTMLElement).closest('tr[data-testid^="mo-row-"]')
          if (!rowTarget) {
            event.preventDefault()
            void handleDropAtRoot()
          }
        }}
        onDragEnd={finishDrag}
      >
        {(explorer.searchMode ? explorer.searchPage.coverage : explorer.treeRoot?.coverage) === 'working-set' && (
          <div className="sticky top-0 z-20 mx-auto mt-2 flex w-fit items-center gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-[11px] text-warning-text">
            <WifiOff className="h-3.5 w-3.5" />
            {t('diagramChrome.addShape.partialOffline')}
          </div>
        )}
        {(explorer.searchMode ? explorer.searchPage.loading : explorer.treeRoot?.loading) && rows.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-surface-50/80 text-[12px] text-fg-subtle">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t('diagramChrome.addShape.loading')}
          </div>
        )}
        {(explorer.searchMode ? explorer.searchPage.error : explorer.treeRoot?.error) && rows.length === 0 && (
          <div className="absolute inset-x-0 top-16 z-20 mx-auto w-fit rounded-lg border border-error-border bg-error-bg px-4 py-3 text-[12px] text-error-text" role="alert">
            <div className="flex items-center gap-2"><AlertCircle className="h-4 w-4" />{t('diagramChrome.addShape.loadError')}</div>
            <button type="button" onClick={explorer.retry} className="mt-2 rounded-md border border-error-border px-2 py-1 font-medium">
              {t('diagramChrome.addShape.retry')}
            </button>
          </div>
        )}
        {/* Full-bleed base-plane table (kit `mo-thead`/`mo-row`): the first and
            last columns pad by --pad-l/--pad-r so content clears the floating
            sidebars and reflows when they collapse. */}
        <table className="w-full text-left border-collapse table-fixed" aria-rowcount={explorerTotal ?? rows.length}>
          <thead className="sticky top-0 bg-surface-50 z-10">
            <tr className="border-b border-line h-10">
              <th style={{ paddingLeft: 'var(--pad-l)' }} className="pr-3 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide">
                {t('dataViewsB.table.headers.objectName')}
              </th>
              <th className="whitespace-nowrap px-3 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide text-center w-16">
                {t('dataViewsB.table.headers.apps')}
              </th>
              <th className="whitespace-nowrap px-3 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide text-center w-16">
                {t('dataViewsB.table.headers.stores')}
              </th>
              <th className="whitespace-nowrap px-3 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide text-center w-28 max-[1080px]:hidden">
                {t('dataViewsB.table.headers.components')}
              </th>
              <th className="whitespace-nowrap px-3 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide text-center w-28">
                {t('dataViewsB.table.headers.connections')}
              </th>
              <th className="whitespace-nowrap px-3 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide text-center w-28 max-[1360px]:hidden">
                {t('dataViewsB.table.headers.inDiagrams')}
              </th>
              <th className="px-3 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide text-left w-32 max-[1360px]:hidden">
                {t('dataViewsB.table.headers.domain')}
              </th>
              <th
                style={{ width: 'calc(var(--pad-r) + 44px)', paddingRight: 'var(--pad-r)' }}
                className="pl-2 text-[10px] font-semibold text-fg-subtle uppercase tracking-wide text-center"
              >
                {/* Actions */}
              </th>
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
              // Async rows can briefly lag the virtualizer's count during a refresh.
              if (!row) return null
              const Icon = typeIcons[row.type] || Box
              const selected = isSelected(row)
              const isDropTarget = dropTargetId === row.id
              const prev = rows[vRow.index - 1]
              const next = rows[vRow.index + 1]

              // Render one guide line per expanded ancestor level
              const guideLines = row.level > 0
                ? Array.from({ length: row.level }, (_, L) => {
                    const isFirst = !prev || prev.level <= L
                    const isLast = !next || next.level <= L
                    const style: React.CSSProperties = {}
                    // Faded gradient rail matching the design (transparent → line
                    // → transparent), fading the first segment in and the last out.
                    if (isFirst && isLast) {
                      style.background = 'linear-gradient(to bottom, transparent 0%, var(--color-line-strong) 50%, transparent 100%)'
                    } else if (isFirst) {
                      style.background = 'linear-gradient(to bottom, transparent 0%, var(--color-line-strong) 100%)'
                    } else if (isLast) {
                      style.background = 'linear-gradient(to bottom, var(--color-line-strong) 0%, transparent 100%)'
                    } else {
                      style.backgroundColor = 'var(--color-line-strong)'
                    }
                    return (
                      <div
                        key={L}
                        className="absolute top-0 -bottom-px w-[1.5px]"
                        style={{ left: `calc(var(--pad-l) + ${9 + L * 20}px)`, ...style }}
                      />
                    )
                  })
                : null

              if (row.isInlineAdd) {
                return (
                  <tr
                    key={vRow.key}
                    data-index={vRow.index}
                    ref={measureElement}
                    aria-rowindex={vRow.index + 1}
                  >
                    <td style={{ paddingLeft: 'var(--pad-l)' }} className="pr-3 py-2 relative">
                      {guideLines}
                      <div className="flex items-center gap-2" style={{ paddingLeft: row.level * 20 }}>
                        <span className="w-5" />
                        <div className="flex items-center gap-2">
                          {row.addTypes?.map((addType) => (
                            <button
                              key={addType}
                              data-testid={`mo-inline-add-${addType}-${row.parentId}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (row.parentId) {
                                  addObjectToModel({
                                    type: addType,
                                    name: `New ${addType}`,
                                    description: '',
                                    position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
                                    size: defaultShapeSize(),
                                    tagAssignments: {},
                                    tagOrder: [],
                                    links: [],
                                    scope: 'internal',
                                    status: 'draft',
                                    properties: {},
                                    parentId: row.parentId,
                                    domainId: domainId || getDefaultDomain()?.id,
                                  })
                                }
                              }}
                              className="flex items-center gap-1 px-2 py-1 text-[11px] text-fg-subtle bg-surface-50 border border-line rounded hover:bg-surface-200 hover:text-fg-secondary transition-colors"
                            >
                              <Plus className="w-3 h-3" />
                              {addType === 'app'
                                ? t('dataViewsB.table.inlineAdd.app')
                                : addType === 'store'
                                  ? t('dataViewsB.table.inlineAdd.store')
                                  : t('dataViewsB.table.inlineAdd.component')}
                            </button>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td />
                    <td />
                    <td className="max-[1080px]:hidden" />
                    <td />
                    <td className="max-[1360px]:hidden" />
                    <td className="max-[1360px]:hidden" />
                    <td />
                  </tr>
                )
              }

              return (
                <tr
                  key={vRow.key}
                  data-testid={`mo-row-${row.id}`}
                  data-index={vRow.index}
                  ref={measureElement}
                  aria-rowindex={vRow.index + 1}
                  draggable={!workspaceReadOnly && !row.isGroup && !row.isInlineAdd}
                  onDragStart={(event) => {
                    if (workspaceReadOnly || row.isGroup || row.isInlineAdd) return
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', row.id)
                    setDraggedRow(row)
                    setDragPreview({ x: event.clientX, y: event.clientY })
                  }}
                  onDragOver={(event) => {
                    if (!canDropOn(draggedRow, row)) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    if (dropClearTimer.current) clearTimeout(dropClearTimer.current)
                    setRootDropActive(false)
                    setDropTargetId(row.id)
                    setDragPreview({ x: event.clientX, y: event.clientY })
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node)) return
                    if (dropTargetId === row.id) {
                      // Native drag events fire a leave while crossing a cell's
                      // descendants. Delay clearing long enough for the next
                      // dragover to confirm whether the pointer truly left.
                      if (dropClearTimer.current) clearTimeout(dropClearTimer.current)
                      dropClearTimer.current = setTimeout(() => setDropTargetId(null), 90)
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void handleDrop(row)
                  }}
                  onClick={() => handleRowClick(row)}
                  className={cn(
                    'transition-colors group',
                    !workspaceReadOnly && !row.isGroup ? 'mo-object-row--draggable' : 'cursor-pointer',
                    draggedRow?.id === row.id && 'opacity-40',
                    isDropTarget
                      ? 'bg-accent-subtle outline outline-1 -outline-offset-1 outline-accent'
                      : selected
                      ? 'bg-accent-subtle hover:bg-accent-subtle'
                      : 'hover:bg-surface-50'
                  )}
                >
                  <td style={{ paddingLeft: 'var(--pad-l)' }} className="pr-3 py-2.5 relative">
                    {/* Selected rows carry the design's 3px accent bar at the row's left edge. */}
                    {selected && <div className="absolute inset-y-0 left-0 w-[3px] bg-accent" />}
                    {guideLines}
                    <div className="flex items-center gap-2" style={{ paddingLeft: row.level * 20 }}>
                      {row.isExpandable ? (
                        // A native disclosure button keeps keyboard, focus, and
                        // assistive-technology semantics aligned with the chevron.
                        <button
                          type="button"
                          aria-expanded={expandedIds.includes(row.id)}
                          aria-label={t(expandedIds.includes(row.id)
                            ? 'diagramChrome.addShape.collapse'
                            : 'diagramChrome.addShape.expand', { name: row.name })}
                          data-testid={`mo-expand-${row.id}`}
                          data-child-count={row.childCount}
                          data-loaded-child-count={row.loadedChildCount}
                          data-child-coverage={row.childCoverage ?? 'unknown'}
                          onClick={(e) => handleToggleExpand(e, row.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              toggleExpanded(row.id)
                            }
                          }}
                          className="p-0.5 rounded hover:bg-surface-200 text-fg-subtle transition-colors inline-flex"
                        >
                          {expandedIds.includes(row.id) ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </button>
                      ) : (
                        <span className="w-5" />
                      )}
                      {row.icon ? (
                        <TechIconBadge
                          name={row.icon}
                          iconLightPath={row.iconAssignment?.iconLightPath}
                          iconDarkPath={row.iconAssignment?.iconDarkPath}
                          size="sm"
                        />
                      ) : (
                        <Icon
                          className="w-4 h-4 shrink-0"
                          style={{ color: typeIconColors[row.type] ?? 'var(--color-fg-subtle)' }}
                        />
                      )}
                      <span className={cn('min-w-0 truncate text-[13px]', selected ? 'text-accent font-medium' : 'text-fg')}>{row.name}</span>
                      <span className="shrink-0 text-[10px] text-fg-muted bg-surface-200 px-1.5 py-0.5 rounded capitalize max-[1080px]:hidden">{row.type}</span>
                      {row.scope && (
                        <span className="shrink-0 text-[10px] text-fg-subtle max-[920px]:hidden">{row.scope}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-center text-[13px] text-fg-subtle font-mono tabular-nums">{row.appCount > 0 ? row.appCount : '-'}</td>
                  <td className="px-3 py-2.5 text-center text-[13px] text-fg-subtle font-mono tabular-nums">{row.storeCount > 0 ? row.storeCount : '-'}</td>
                  <td className="px-3 py-2.5 text-center text-[13px] text-fg-subtle font-mono tabular-nums max-[1080px]:hidden">{row.componentCount > 0 ? row.componentCount : '-'}</td>
                  <td className="px-3 py-2.5 text-center text-[13px] text-fg-subtle font-mono tabular-nums">{row.connectionCount > 0 ? row.connectionCount : '-'}</td>
                  <td className="px-3 py-2.5 text-center text-[13px] text-fg-subtle font-mono tabular-nums max-[1360px]:hidden">{row.diagramCount > 0 ? row.diagramCount : '-'}</td>
                  <td className="px-3 py-2.5 max-[1360px]:hidden">
                    <DomainCell
                      row={row}
                      domains={domains}
                      onChange={async (domainId) => {
                        if (row.isGroup) {
                          updateGroup(row.id, { domainId })
                          return
                        }
                        // An expanded row can be an off-window object (not resident under
                        // boot-from-server) — seed it from the seam first, else updateObject
                        // no-ops. Groups are always resident, so they skip this.
                        if (!useModelStore.getState().objects.some((o) => o.id === row.id)) {
                          const o = await getModelQuery().object(row.id)
                          if (o) seedObjectForEdit(o)
                        }
                        updateObject(row.id, { domainId })
                      }}
                    />
                  </td>
                  <td style={{ paddingRight: 'var(--pad-r)' }} className="pl-2 py-2.5 text-center">
                    <RowActions row={row} onDelete={() => {
                      if (row.isGroup) { deleteGroup(row.id); return }   // groups are fully resident
                      // Off-window object (the common case on this whole-model page): deleteObject
                      // only splices the resident store, so it's a no-op + the bridge's diff-based
                      // detectDeletes never sees a vanish. Tombstone explicitly so the delete persists.
                      deleteObject(row.id)
                      tombstoneObjectOffWindow(row.id)
                    }} />
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
        {draggedRow && dragPreview && (
          <div
            data-testid="mo-drag-preview"
            className="pointer-events-none fixed z-[70] flex items-center gap-2 rounded-lg border border-accent bg-surface-100 px-3 py-2 text-[12px] font-medium text-fg elevation-xl"
            style={{ left: dragPreview.x + 16, top: dragPreview.y + 16 }}
          >
            <Move className="h-3.5 w-3.5 text-accent" />
            <span>{draggedRow.name}</span>
            <span className="text-fg-subtle">{t('dataViewsB.table.dropHint')}</span>
          </div>
        )}
        {draggedRow && rootDropActive && (
          <div
            data-testid="mo-root-drop-target"
            className="pointer-events-none sticky bottom-3 mx-auto mb-3 flex w-fit items-center gap-2 rounded-lg border border-dashed border-accent bg-surface-100 px-3 py-2 text-[12px] font-medium text-accent elevation-xl"
          >
            <Move className="h-3.5 w-3.5" />
            {t('dataViewsB.table.rootDropHint')}
          </div>
        )}
      </div>
    </div>
  )
}

function RowActions({ row, onDelete }: { row: RowData; onDelete: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const addObjectToModel = useModelStore((s) => s.addObjectToModel)
  // Duplicate/delete are model writes the sync gate drops for a view-only
  // session — don't render the row menu at all.
  const canManage = !useModelStore((s) => s.workspaceReadOnly)
  if (!canManage) return null

  const handleDuplicate = () => {
    // Read on demand rather than subscribing per row: duplication is the only
    // consumer, and a subscription would scan the object window for every row.
    const original = useModelStore.getState().objects.find((o) => o.id === row.id)
    if (!original) return
    addObjectToModel({
      ...original,
      name: `${original.name} (copy)`,
      position: { x: original.position.x + 40, y: original.position.y + 40 },
      tagAssignments: { ...original.tagAssignments },
      tagOrder: [...original.tagOrder],
      links: original.links ? [...original.links] : [],
      technologyUsages: original.technologyUsages
        ? Object.fromEntries(Object.entries(original.technologyUsages).map(([id, usage]) => [
            id,
            { ...usage, snapshot: { ...usage.snapshot } },
          ]))
        : undefined,
      properties: { ...original.properties },
    })
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        data-testid={`mo-row-menu-${row.id}`}
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        className="p-1 rounded hover:bg-surface-200 text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-40 bg-surface-100 border border-line rounded-lg shadow-xl z-30 py-1">
            <button
              onClick={(e) => { e.stopPropagation(); handleDuplicate() }}
              className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-fg-secondary hover:bg-surface-200"
            >
              <Copy className="w-3.5 h-3.5" />
              {t('dataViewsB.table.rowMenu.duplicate')}
            </button>
            <button
              data-testid={`mo-row-delete-${row.id}`}
              onClick={(e) => { e.stopPropagation(); onDelete(); setOpen(false) }}
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

function DomainCell({
  row,
  domains,
  onChange,
}: {
  row: RowData
  domains: { id: string; name: string; color?: string }[]
  onChange: (domainId: string | undefined) => void
}) {
  const [editing, setEditing] = useState(false)
  const currentDomain = domains.find((d) => d.id === row.domainId)

  if (editing) {
    return (
      <select
        autoFocus
        value={row.domainId || ''}
        onChange={(e) => {
          const value = e.target.value
          onChange(value || undefined)
          setEditing(false)
        }}
        onBlur={() => setEditing(false)}
        onClick={(e) => e.stopPropagation()}
        className="text-[11px] bg-surface-100 border border-line rounded px-1.5 py-0.5 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent w-full"
      >
        <option value="">—</option>
        {domains.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    )
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      className="flex items-center gap-1.5 text-[11px] text-fg-subtle hover:text-fg-secondary transition-colors"
    >
      {currentDomain ? (
        <>
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: currentDomain.color || '#94A3B8' }}
          />
          <span className="truncate max-w-[80px]">{currentDomain.name}</span>
        </>
      ) : (
        <span className="text-fg-subtle">—</span>
      )}
    </button>
  )
}
