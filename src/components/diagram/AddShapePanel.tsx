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

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualRows } from '../common/VirtualList'
import {
  Search,
  Filter,
  ChevronRight,
  ChevronDown,
  User,
  Monitor,
  Box,
  Database,
  Puzzle,
  Shapes,
  MoreHorizontal,
  Copy,
  Trash2,
  Settings,
  GitBranch,
  Lightbulb,
  LoaderCircle,
  AlertCircle,
  WifiOff,
} from 'lucide-react'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { useAuthStore } from '../../stores/authStore'
import { cn } from '../../lib/utils'
import { getModelQuery } from '../../lib/modelQuery'
import { tombstoneObjectOffWindow } from '../../lib/automerge/bridge'
import { useModelIndexVersion } from '../../lib/modelQuery/indexSync'
import type { C4Type } from '../../types'
import { TechIconBadge } from '../shared/TechIconBadge'
import { TechnologyFilterSelector } from '../technologies/TechnologyFilterSelector'
import { useObjectExplorer, type ExplorerVisualRow } from './useObjectExplorer'

const typeIcons: Record<string, React.ElementType> = {
  actor: User,
  system: Monitor,
  app: Box,
  store: Database,
  component: Puzzle,
  group: Shapes,
}

// Theme-aware C4 type accents — resolve against the active theme's CSS vars.
const typeColors: Record<string, string> = {
  actor: 'var(--color-c4-actor)',
  system: 'var(--color-c4-system)',
  app: 'var(--color-c4-app)',
  store: 'var(--color-c4-store)',
  component: 'var(--color-c4-component)',
  group: 'var(--color-fg-subtle)',
}

interface AddShapePanelProps {
  onDragStart?: (item: { type: 'existing' | 'new'; id?: string; c4Type?: C4Type | 'group' }) => void
}

const EMPTY_TECHNOLOGY_FILTER = new Set<string>()

export function AddShapePanel({ onDragStart }: AddShapePanelProps) {
  const { t } = useTranslation()
  const storeObjects = useModelStore((s) => s.objects)
  const storeGroups = useModelStore((s) => s.groups)
  const indexVersion = useModelIndexVersion((s) => s.version)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const deleteObject = useModelStore((s) => s.deleteObject)
  const deleteGroup = useModelStore((s) => s.deleteGroup)
  const orgId = useAuthStore((s) => s.orgId)

  const [searchQuery, setSearchQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [typeFilter, setTypeFilter] = useState<Set<C4Type | 'group'>>(new Set())
  const [scopeFilter, setScopeFilter] = useState<'internal' | 'external' | null>(null)
  const [technologySelection, setTechnologySelection] = useState<{ orgId: string | null; ids: Set<string> }>({
    orgId,
    ids: new Set(),
  })
  const technologyFilter = technologySelection.orgId === orgId
    ? technologySelection.ids
    : EMPTY_TECHNOLOGY_FILTER
  const filterRef = useRef<HTMLDivElement>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const treeRowRefs = useRef(new Map<string, HTMLDivElement>())
  const treeScrollTop = useRef(0)
  const restoreTreeScroll = useRef(false)
  const previousSearchMode = useRef(false)

  // Close filter dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
    }
    if (filterOpen) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [filterOpen])

  const explorerRefreshKey = useMemo(
    () => ({ indexVersion, storeObjects, storeGroups }),
    [indexVersion, storeGroups, storeObjects],
  )
  const explorerFilters = useMemo(() => ({
    ...(typeFilter.size ? { types: [...typeFilter] } : {}),
    ...(scopeFilter ? { scope: scopeFilter } : {}),
    ...(technologyFilter.size ? { technologyIds: [...technologyFilter] } : {}),
  }), [scopeFilter, technologyFilter, typeFilter])
  const {
    rows: treeNodes,
    searchMode,
    searchTooShort,
    treeRoot,
    searchPage,
    toggleExpanded: toggleTreeNode,
    loadMoreTree,
    loadMoreSearch,
    retry,
  } = useObjectExplorer({
    query: searchQuery,
    filters: explorerFilters,
    diagramId: currentDiagramId,
    refreshKey: explorerRefreshKey,
  })

  const { virtualItems: treeVirtualItems, totalSize: treeTotalSize, measureElement: treeMeasureElement } = useVirtualRows({
    scrollRef: treeScrollRef,
    count: treeNodes.length,
    // Each row is py-1.5 (12px) + ~20px icon/text + 2px gap = ~34px; use 34 as a hint,
    // measureElement will correct it per-row after first paint.
    estimateSize: () => 34,
    overscan: 8,
    getItemKey: (i) => treeNodes[i].id,
  })

  // Preserve the exact navigation position while the user temporarily searches.
  // Restoration waits until the tree rows have remounted so the browser does not
  // clamp the saved position against an empty list.
  useEffect(() => {
    const scroller = treeScrollRef.current
    if (!scroller) return
    if (searchMode && !previousSearchMode.current) {
      treeScrollTop.current = scroller.scrollTop
      scroller.scrollTop = 0
    } else if (!searchMode && previousSearchMode.current) {
      restoreTreeScroll.current = true
    }
    previousSearchMode.current = searchMode
  }, [searchMode])

  useEffect(() => {
    if (!restoreTreeScroll.current || searchMode || treeNodes.length === 0) return
    restoreTreeScroll.current = false
    const frame = window.requestAnimationFrame(() => {
      if (treeScrollRef.current) treeScrollRef.current.scrollTop = treeScrollTop.current
    })
    return () => window.cancelAnimationFrame(frame)
  }, [searchMode, treeNodes.length])

  // The virtual window is also the infinite-scroll sentinel. Only the page whose
  // final row is actually visible is continued; no hidden branch is prefetched.
  useEffect(() => {
    if (!treeVirtualItems.length) return
    if (searchMode) {
      const lastVisible = treeVirtualItems.at(-1)?.index ?? -1
      if (lastVisible >= treeNodes.length - 2 && searchPage.nextCursor && !searchPage.loading) loadMoreSearch()
      return
    }
    const keys = new Set(treeVirtualItems.map((item) => treeNodes[item.index]?.loadMoreTreeKey).filter(Boolean))
    for (const key of keys) loadMoreTree(key!)
  }, [loadMoreSearch, loadMoreTree, searchMode, searchPage.loading, searchPage.nextCursor, treeNodes, treeVirtualItems])

  const handleDragStart = useCallback(
    (e: React.DragEvent, item: { type: 'existing' | 'new'; id?: string; c4Type?: C4Type | 'group' }) => {
      e.dataTransfer.setData('application/json', JSON.stringify(item))
      e.dataTransfer.effectAllowed = 'copy'
      onDragStart?.(item)
    },
    [onDragStart]
  )

  const hasActiveFilters = typeFilter.size > 0 || scopeFilter !== null || technologyFilter.size > 0

  return (
    <div className="flex flex-col h-full">
      {/* Search (the org-band above now titles the panel — no "Model objects" header) */}
      <div className="px-4 pb-2.5">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-subtle" />
          <input
            type="text"
            data-testid="add-shape-search"
            placeholder={t('diagramChrome.addShape.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-8 py-2 text-[12.5px] bg-surface-50 border border-line rounded-[10px] text-fg placeholder:text-fg-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
          />
          <div className="relative" ref={filterRef}>
            <button
              data-testid="add-shape-filter-button"
              aria-label={t('diagramChrome.addShape.filter.open')}
              onClick={() => setFilterOpen(!filterOpen)}
              className={cn(
                'absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-surface-200 transition-colors',
                hasActiveFilters ? 'text-accent' : 'text-fg-subtle'
              )}
            >
              <Filter className="w-3.5 h-3.5" />
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full mt-1 w-64 max-h-[min(32rem,calc(100vh-6rem))] overflow-y-auto bg-surface-100 border border-line rounded-lg shadow-lg z-30 py-2">
                <div className="px-3 py-1 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
                  {t('diagramChrome.addShape.filter.type')}
                </div>
                <div className="px-2 pb-1">
                  {(['group', 'system', 'actor', 'app', 'store', 'component'] as const).map((ty) => (
                    <label key={ty} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-surface-50 rounded">
                      <input
                        type="checkbox"
                        checked={typeFilter.has(ty)}
                        onChange={() => {
                          setTypeFilter((prev) => {
                            const next = new Set(prev)
                            if (next.has(ty)) next.delete(ty)
                            else next.add(ty)
                            return next
                          })
                        }}
                        className="w-3.5 h-3.5 rounded border-line-strong text-accent focus:ring-accent"
                      />
                      <span className="text-[12px] text-fg-secondary capitalize">{t(`diagramChrome.addShape.type.${ty}`)}</span>
                    </label>
                  ))}
                </div>
                <div className="border-t border-line my-1" />
                <div className="px-3 py-1 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
                  {t('diagramChrome.addShape.filter.scope')}
                </div>
                <div className="px-2">
                  {(['internal', 'external'] as const).map((s) => (
                    <label key={s} className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-surface-50 rounded">
                      <input
                        type="radio"
                        name="scopeFilter"
                        checked={scopeFilter === s}
                        onChange={() => setScopeFilter(s)}
                        className="w-3.5 h-3.5 border-line-strong text-accent focus:ring-accent"
                      />
                      <span className="text-[12px] text-fg-secondary capitalize">{t(`diagramChrome.addShape.scope.${s}`)}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-surface-50 rounded">
                    <input
                      type="radio"
                      name="scopeFilter"
                      checked={scopeFilter === null}
                      onChange={() => setScopeFilter(null)}
                      className="w-3.5 h-3.5 border-line-strong text-accent focus:ring-accent"
                    />
                    <span className="text-[12px] text-fg-secondary">{t('diagramChrome.addShape.scope.any')}</span>
                  </label>
                </div>
                <div className="border-t border-line my-1" />
                <div className="px-3 py-1 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide">
                  {t('diagramChrome.addShape.filter.technology')}
                </div>
                <TechnologyFilterSelector
                  orgId={orgId}
                  selectedIds={[...technologyFilter]}
                  onToggle={(technologyId) => {
                    setTechnologySelection((previous) => {
                      const next = new Set(previous.orgId === orgId ? previous.ids : [])
                      if (next.has(technologyId)) next.delete(technologyId)
                      else next.add(technologyId)
                      return { orgId, ids: next }
                    })
                  }}
                  testIdPrefix="technology-filter"
                  className="px-2 pb-1"
                />
                {hasActiveFilters && (
                  <>
                    <div className="border-t border-line my-1" />
                    <button
                      onClick={() => {
                        setTypeFilter(new Set())
                        setScopeFilter(null)
                        setTechnologySelection({ orgId, ids: new Set() })
                      }}
                      className="w-full px-3 py-1.5 text-[12px] text-accent hover:bg-surface-50 text-left"
                    >
                      {t('diagramChrome.addShape.filter.clear')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tree */}
      <div ref={treeScrollRef} className="flex-1 overflow-y-auto px-2 pb-2" role="tree" aria-busy={searchMode ? searchPage.loading : treeRoot?.loading}>
        {searchTooShort && (
          <div className="mx-2 mb-2 rounded-md border border-line bg-surface-50 px-2.5 py-2 text-[11px] text-fg-subtle" aria-live="polite">
            {t('diagramChrome.addShape.searchHint')}
          </div>
        )}
        {(searchMode ? searchPage.coverage : treeRoot?.coverage) === 'working-set' && (
          <div className="mx-2 mb-2 flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-2.5 py-2 text-[11px] text-warning-text">
            <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('diagramChrome.addShape.partialOffline')}
          </div>
        )}
        {(searchMode ? searchPage.loading : treeRoot?.loading) && treeNodes.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-[12px] text-fg-subtle" aria-live="polite">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            {t('diagramChrome.addShape.loading')}
          </div>
        ) : (searchMode ? searchPage.error : treeRoot?.error) && treeNodes.length === 0 ? (
          <div className="mx-2 rounded-lg border border-error-border bg-error-bg px-3 py-3 text-[12px] text-error-text" role="alert">
            <div className="flex items-center gap-2"><AlertCircle className="h-4 w-4" />{t('diagramChrome.addShape.loadError')}</div>
            <button type="button" onClick={retry} className="mt-2 rounded-md border border-error-border px-2 py-1 font-medium hover:bg-surface-100">
              {t('diagramChrome.addShape.retry')}
            </button>
          </div>
        ) : treeNodes.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-fg-subtle text-center">
            {t('diagramChrome.addShape.noMatches')}
          </div>
        ) : (
          <div style={{ height: treeTotalSize, position: 'relative' }}>
            {treeVirtualItems.map((vItem) => {
              const node = treeNodes[vItem.index]
              const prev = treeNodes[vItem.index - 1]
              const next = treeNodes[vItem.index + 1]
              let parentNode: ExplorerVisualRow | undefined
              if (node.level > 0) {
                for (let index = vItem.index - 1; index >= 0; index -= 1) {
                  if (treeNodes[index].level === node.level - 1) { parentNode = treeNodes[index]; break }
                }
              }
              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={treeMeasureElement}
                  aria-setsize={treeNodes.length}
                  aria-posinset={vItem.index + 1}
                  style={{
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${vItem.start}px)`,
                    width: '100%',
                    // Preserve the space-y-0.5 gap (2px) that existed between rows
                    paddingBottom: 2,
                  }}
                >
                  <TreeNodeRow
                    node={node}
                    expanded={node.expanded}
                    inDiagram={node.inDiagram}
                    prevLevel={prev?.level}
                    nextLevel={next?.level}
                    onToggleExpand={() => toggleTreeNode(node)}
                    onFocusParent={() => parentNode && treeRowRefs.current.get(parentNode.id)?.focus()}
                    registerElement={(element) => {
                      if (element) treeRowRefs.current.set(node.id, element)
                      else treeRowRefs.current.delete(node.id)
                    }}
                    onDragStart={(e) =>
                      handleDragStart(e, {
                        type: 'existing',
                        id: node.id,
                        c4Type: node.type,
                      })
                    }
                    onDelete={() => {
                      if (node.kind === 'group') { deleteGroup(node.id); return }   // groups are fully resident
                      // The tree lists the WHOLE model, so node.id is usually OFF-WINDOW: deleteObject
                      // only splices the resident store (no-op) and the bridge's diff never sees a vanish.
                      // Tombstone explicitly so the delete persists (→ index + server read model drop it).
                      deleteObject(node.id)
                      tombstoneObjectOffWindow(node.id)
                    }}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function TreeNodeRow({
  node,
  expanded,
  inDiagram,
  prevLevel,
  nextLevel,
  onToggleExpand,
  onFocusParent,
  registerElement,
  onDragStart,
  onDelete,
}: {
  node: ExplorerVisualRow
  expanded: boolean
  inDiagram: boolean
  prevLevel?: number
  nextLevel?: number
  onToggleExpand: () => void
  onFocusParent: () => void
  registerElement: (element: HTMLDivElement | null) => void
  onDragStart: (e: React.DragEvent) => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const Icon = typeIcons[node.type] || Box
  const isGroup = node.kind === 'group'
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const addObjectToModel = useModelStore((s) => s.addObjectToModel)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [menuOpen])

  const handleMenuToggle = () => {
    if (!menuOpen && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      // Open downward by default, but flip ABOVE the button when the menu would overflow the
      // viewport bottom — otherwise the last item (Delete) renders off-screen and is unreachable
      // for rows low in the sidebar.
      const MENU_HEIGHT = 240 // ~5 items + divider
      const openDown = rect.bottom + 4 + MENU_HEIGHT <= window.innerHeight
      setMenuPos({
        top: openDown ? rect.bottom + 4 : Math.max(8, rect.top - MENU_HEIGHT - 4),
        right: window.innerWidth - rect.right,
      })
    }
    setMenuOpen((prev) => !prev)
  }

  const handleDuplicate = async () => {
    if (isGroup) return
    // Resolve via the seam (the node can be outside the windowed store).
    const original = await getModelQuery().object(node.id)
    if (!original) return
    addObjectToModel({
      ...original,
      name: t('diagramChrome.addShape.copySuffix', { name: original.name }),
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
      parentId: original.parentId,
    })
    setMenuOpen(false)
  }

  return (
    <div
      ref={registerElement}
      draggable
      role="treeitem"
      tabIndex={0}
      aria-level={node.level + 1}
      aria-expanded={node.hasChildren ? expanded : undefined}
      data-testid={`tree-node-${node.id}`}
      onDragStart={onDragStart}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' && node.hasChildren && !expanded) {
          event.preventDefault()
          onToggleExpand()
        } else if (event.key === 'ArrowLeft') {
          if (expanded) {
            event.preventDefault()
            onToggleExpand()
          } else if (node.level > 0) {
            event.preventDefault()
            onFocusParent()
          }
        }
      }}
      className={cn(
        'group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-grab active:cursor-grabbing hover:bg-surface-50 transition-colors relative'
      )}
      style={{ paddingLeft: 8 + node.level * 16 }}
      title={
        inDiagram
          ? t('diagramChrome.addShape.tooltip.alreadyInDiagram', { name: node.name })
          : t('diagramChrome.addShape.tooltip.dragToAdd', { name: node.name })
      }
    >
      {node.level > 0 &&
        Array.from({ length: node.level }, (_, L) => {
          const isFirst = prevLevel === undefined || prevLevel <= L
          const isLast = nextLevel === undefined || nextLevel <= L
          const style: React.CSSProperties = {}
          // Faded gradient rail (design: transparent → line → transparent). The
          // tree is a flat virtualized list, so each row draws its own segment;
          // fading the first segment in and the last segment out reproduces the
          // design's group-level fade.
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
              className={cn('absolute top-0 w-[1.5px]', !isLast ? '-bottom-0.5' : 'bottom-0')}
              style={{ left: 17 + L * 16, ...style }}
            />
          )
        })}
      {node.hasChildren ? (
        <button
          data-testid={`tree-node-expand-${node.id}`}
          aria-expanded={expanded}
          aria-label={expanded
            ? t('diagramChrome.addShape.collapse', { name: node.name })
            : t('diagramChrome.addShape.expand', { name: node.name })}
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          className="p-0.5 rounded hover:bg-surface-300 text-fg-subtle transition-colors shrink-0"
        >
          {node.childLoading
            ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
            : node.childError
              ? <AlertCircle className="w-3.5 h-3.5 text-error-text" />
              : expanded
                ? <ChevronDown className="w-3.5 h-3.5" />
                : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}

      {node.icon ? (
        <TechIconBadge
          name={node.icon}
          iconLightPath={node.iconAssignment?.iconLightPath}
          iconDarkPath={node.iconAssignment?.iconDarkPath}
          size="sm"
        />
      ) : (
        <Icon className="w-4 h-4 shrink-0" style={{ color: typeColors[node.type] }} />
      )}

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{node.name}</span>
        {node.breadcrumb.length > 0 && (
          <span className="block truncate text-[10px] text-fg-subtle">
            {node.breadcrumb.map((item) => item.name).join(' / ')}
          </span>
        )}
      </span>

      {/* Already in diagram indicator */}
      {inDiagram && (
        <span className="text-[10px] text-fg-subtle shrink-0">{t('diagramChrome.addShape.inDiagram')}</span>
      )}

      {/* Action menu */}
      <div className="relative shrink-0" ref={menuRef}>
        <button
          data-testid={`tree-node-menu-${node.id}`}
          onClick={(e) => {
            e.stopPropagation()
            handleMenuToggle()
          }}
          className="p-1 rounded hover:bg-surface-300 text-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
        {menuOpen && menuPos && (
          <div
            className="fixed w-48 bg-surface-100 border border-line rounded-lg shadow-lg z-50 py-1"
            style={{ top: menuPos.top, right: menuPos.right }}
          >
            <button
              onClick={() => {
                setMenuOpen(false)
                // Navigate to model objects view and select this item
                useUIStore.getState().setCurrentView('model-objects')
                if (isGroup) {
                  useModelStore.getState().selectGroup(node.id)
                } else {
                  useModelStore.getState().selectObjects([node.id])
                }
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-fg-secondary hover:bg-surface-50"
            >
              <Settings className="w-3.5 h-3.5" />
              {t('diagramChrome.addShape.menu.manage')}
            </button>
            <button
              onClick={() => {
                setMenuOpen(false)
                // TODO: view dependencies - could open a modal or panel
                console.log('View dependencies for', node.id)
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-fg-secondary hover:bg-surface-50"
            >
              <GitBranch className="w-3.5 h-3.5" />
              {t('diagramChrome.addShape.menu.viewDependencies')}
            </button>
            {!isGroup && (
              <button
                onClick={handleDuplicate}
                className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-fg-secondary hover:bg-surface-50"
              >
                <Copy className="w-3.5 h-3.5" />
                {t('diagramChrome.addShape.menu.duplicate')}
              </button>
            )}
            <button
              onClick={() => {
                setMenuOpen(false)
                console.log('Get insights for', node.id)
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-fg-secondary hover:bg-surface-50"
            >
              <Lightbulb className="w-3.5 h-3.5" />
              {t('diagramChrome.addShape.menu.getInsights')}
            </button>
            <div className="border-t border-line my-1" />
            <button
              data-testid={`tree-node-delete-${node.id}`}
              onClick={() => {
                onDelete()
                setMenuOpen(false)
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-error-text hover:bg-error-bg"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('common.delete')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

