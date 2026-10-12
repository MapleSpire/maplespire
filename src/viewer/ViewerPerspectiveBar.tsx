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
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Code,
  Crosshair,
  FolderTree,
  Layers3,
  MoreHorizontal,
  Tag as TagIcon,
  UsersRound,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type MutableRefObject, type WheelEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { CanvasEngine } from '../canvas/engine/CanvasEngine'
import { collectDiagramFacetValues, type ManagedPerspective } from '../canvas/facetPerspective'
import { resolveStatusColor, resolveTeamColor, resolveTechnologyColor } from '../canvas/bottomBarColors'
import type { Scene3D } from '../canvas3d'
import { referencedTagSnapshots } from '../lib/tags/assignments'
import { cn } from '../lib/utils'
import { useSkinStore } from '../stores/skinStore'
import { useThemeStore } from '../stores/themeStore'
import type { Tag } from '../types'
import type { ShareSnapshot } from '../lib/share/types'
import { resolvePerspectiveBarLayout } from '../components/tags/tagPerspectiveUtils'

type Perspective = 'tags' | ManagedPerspective

const PERSPECTIVES: Array<{ id: Perspective; icon: typeof TagIcon }> = [
  { id: 'tags', icon: TagIcon },
  { id: 'technology', icon: Code },
  { id: 'status', icon: Activity },
  { id: 'teams', icon: UsersRound },
]

interface PerspectiveValue {
  id: string
  label: string
  color: string
  groupName?: string
}

function scrollStripHorizontally(event: WheelEvent<HTMLDivElement>) {
  const element = event.currentTarget
  if (element.scrollWidth <= element.clientWidth) return
  event.preventDefault()
  event.stopPropagation()
  const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1
  const maxScrollLeft = element.scrollWidth - element.clientWidth
  element.scrollLeft = Math.max(0, Math.min(maxScrollLeft, element.scrollLeft + dominantDelta * multiplier))
}

interface ViewerPerspectiveBarProps {
  snapshot: ShareSnapshot
  diagramId: string
  engineRef: MutableRefObject<CanvasEngine | null>
  sceneRef: MutableRefObject<Scene3D | null>
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  rendererVersion?: number
}

/**
 * Snapshot-only perspective controls for public shares. The component never
 * loads an organization catalog and exposes no mutation affordance: every
 * value comes from the bounded share payload, while hover/focus only changes
 * the local renderer state.
 */
export function ViewerPerspectiveBar({
  snapshot,
  diagramId,
  engineRef,
  sceneRef,
  leftSidebarOpen,
  rightSidebarOpen,
  rendererVersion = 0,
}: ViewerPerspectiveBarProps) {
  const { t } = useTranslation()
  const [active, setActive] = useState<Perspective | null>(null)
  const [activeTagGroupId, setActiveTagGroupId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [mode, setMode] = useState<'full' | 'line' | 'fab'>('full')
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth)
  const appTheme = useThemeStore((state) => state.resolved)
  const diagram = snapshot.diagrams.find((candidate) => candidate.id === diagramId) ?? snapshot.diagrams[0]
  const skin = useSkinStore((state) => state.getResolvedSkin(diagram?.skinId, appTheme))

  const entities = useMemo(() => {
    if (!diagram) return { objects: [], connections: [], groups: [] }
    const objectIds = new Set(diagram.objectIds)
    const connectionIds = new Set(diagram.connectionIds)
    const groupIds = new Set(diagram.groupIds)
    return {
      objects: snapshot.model.objects.filter((object) => objectIds.has(object.id)),
      connections: snapshot.model.connections.filter((connection) => connectionIds.has(connection.id)),
      groups: snapshot.model.groups.filter((group) => groupIds.has(group.id)),
    }
  }, [diagram, snapshot.model.connections, snapshot.model.groups, snapshot.model.objects])

  const diagramTags = useMemo(
    () => referencedTagSnapshots(
      [...entities.objects, ...entities.connections, ...entities.groups],
      snapshot.model.tags,
    ),
    [entities, snapshot.model.tags],
  )
  const tagGroups = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; count: number }>()
    for (const tag of diagramTags) {
      const current = groups.get(tag.groupId)
      groups.set(tag.groupId, {
        id: tag.groupId,
        name: tag.groupName,
        count: (current?.count ?? 0) + 1,
      })
    }
    return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name))
  }, [diagramTags])

  const values = useMemo((): PerspectiveValue[] => {
    if (active === 'tags') {
      return diagramTags
        .filter((tag) => !activeTagGroupId || tag.groupId === activeTagGroupId)
        .map((tag: Tag) => ({
          id: tag.tagId,
          label: tag.value,
          groupName: tag.groupName,
          color: tag.color,
        }))
        .sort((left, right) => left.label.localeCompare(right.label))
    }
    if (!active) return []
    return collectDiagramFacetValues([...entities.objects, ...entities.connections], active).map((value) => ({
      ...value,
      label: active === 'status'
        ? t(`layoutChrome.bottomBar.status.values.${value.id}`, { defaultValue: value.label })
        : value.label,
      color: active === 'technology'
        ? resolveTechnologyColor(value.label, skin)
        : active === 'status'
          ? resolveStatusColor(value.id as 'live' | 'draft' | 'down' | 'unstable', skin)
          : resolveTeamColor(value.id),
    }))
  }, [active, activeTagGroupId, diagramTags, entities.connections, entities.objects, skin, t])

  const updateRenderers = useCallback((apply: (renderer: CanvasEngine | Scene3D) => void) => {
    if (engineRef.current) apply(engineRef.current)
    if (sceneRef.current) apply(sceneRef.current)
  }, [engineRef, sceneRef])

  useEffect(() => {
    updateRenderers((renderer) => renderer.setBottomTab(active))
    updateRenderers((renderer) => renderer.setActiveTagGroup(active === 'tags' ? activeTagGroupId : null))
    if (active === 'tags') {
      updateRenderers((renderer) => renderer.setTagInteractions(hoveredId, [], focusedId, []))
    } else if (active) {
      updateRenderers((renderer) => renderer.setManagedPerspectiveInteractions(active, hoveredId, [], focusedId, []))
    }
  }, [active, activeTagGroupId, focusedId, hoveredId, rendererVersion, updateRenderers])

  useEffect(() => () => {
    updateRenderers((renderer) => {
      renderer.setBottomTab(null)
      renderer.setActiveTagGroup(null)
      renderer.setTagInteractions(null, [], null, [])
      for (const kind of ['technology', 'status', 'teams'] as const) {
        renderer.setManagedPerspectiveInteractions(kind, null, [], null, [])
      }
    })
  }, [updateRenderers])

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', update, { passive: true })
    return () => window.removeEventListener('resize', update)
  }, [])

  const focus = (id: string) => setFocusedId((current) => current === id ? null : id)
  const itemTitle = (value: PerspectiveValue) => {
    const label = active === 'tags' && !activeTagGroupId && value.groupName
      ? `${value.label} (${value.groupName})`
      : value.label
    return t('layoutChrome.bottomBar.tags.focus', { value: label })
  }

  const valueButtons = (compact: boolean) => values.map((value) => (
    <button
      key={value.id}
      type="button"
      data-testid={`viewer-perspective-value-${value.id}`}
      aria-pressed={focusedId === value.id}
      title={itemTitle(value)}
      onMouseEnter={() => setHoveredId(value.id)}
      onMouseLeave={() => setHoveredId(null)}
      onClick={() => focus(value.id)}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition-colors',
        focusedId === value.id
          ? 'border-accent bg-accent-subtle text-accent'
          : 'border-line bg-surface-50 text-fg-secondary hover:bg-surface-200',
        compact ? 'w-full' : 'max-w-[190px]',
      )}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: value.color }} />
      <span className="min-w-0 truncate font-medium">
        {value.label}
        {active === 'tags' && !activeTagGroupId && value.groupName && (
          <span className="ml-1 text-fg-subtle">· {value.groupName}</span>
        )}
      </span>
      {focusedId === value.id && <Crosshair className="h-3 w-3 shrink-0" aria-hidden="true" />}
    </button>
  ))

  const barLayout = resolvePerspectiveBarLayout(
    viewportWidth,
    leftSidebarOpen,
    rightSidebarOpen,
    '2d',
  )
  const hasExpandedContent = mode === 'full' && active !== null
  const barWidth = hasExpandedContent
    ? Math.min(720, barLayout.availableWidth)
    : 'fit-content'

  if (mode === 'fab' || barLayout.forcedFab) {
    return (
      <button
        type="button"
        data-testid="viewer-perspective-fab"
        aria-label={t('layoutChrome.bottomBar.showPerspectives')}
        title={t('layoutChrome.bottomBar.showPerspectives')}
        onClick={() => setMode('full')}
        style={{ left: barLayout.left, bottom: barLayout.bottom }}
        className="absolute z-20 flex h-[46px] w-[46px] items-center justify-center rounded-[15px] border border-line bg-surface-100 text-fg-secondary elevation-xl transition-[left,background-color,color] hover:bg-surface-50 hover:text-fg"
      >
        <Layers3 className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
    )
  }

  return (
    <section
      data-testid="viewer-perspective-bar"
      aria-label={t('layoutChrome.bottomBar.perspectives')}
      style={{
        left: barLayout.left,
        bottom: barLayout.bottom,
        width: barWidth,
        maxWidth: barLayout.availableWidth,
      }}
      className="absolute z-20 flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-surface-100/95 p-2 pr-5 shadow-lg backdrop-blur-sm transition-[bottom,left,width,max-width] duration-300 ease-out"
    >
      <button
        type="button"
        data-testid="viewer-perspective-collapse-to-button"
        onClick={() => {
          setCatalogOpen(false)
          setMode('fab')
        }}
        aria-label={t('layoutChrome.bottomBar.collapseToButton')}
        title={t('layoutChrome.bottomBar.collapseToButton')}
        className="absolute bottom-0 right-0 top-0 flex w-4 items-center justify-center rounded-r-[13px] text-fg-subtle transition-colors hover:bg-accent-subtle hover:text-accent"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {catalogOpen && active && (
        <div
          data-testid="viewer-perspective-catalog"
          className="absolute bottom-full left-0 right-0 mb-2 max-h-[300px] overflow-y-auto rounded-[14px] border border-line bg-surface-100 p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-semibold text-fg">
              {t(`layoutChrome.bottomBar.tabs.${active}`)}
            </span>
            <button
              type="button"
              onClick={() => setCatalogOpen(false)}
              aria-label={t('common.close', { defaultValue: 'Close' })}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-200 hover:text-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">{valueButtons(true)}</div>
        </div>
      )}

      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {PERSPECTIVES.map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            data-testid={`viewer-bottom-tab-${id}`}
            aria-pressed={active === id}
            onClick={() => {
              const next = active === id ? null : id
              setActive(next)
              setActiveTagGroupId(null)
              setHoveredId(null)
              setFocusedId(null)
              setCatalogOpen(false)
            }}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg',
              active === id && 'bg-surface-200 text-fg',
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {t(`layoutChrome.bottomBar.tabs.${id}`)}
          </button>
        ))}
        <span className="min-w-2 flex-1" />
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          {t('viewer.readOnly')}
        </span>
        <button
          type="button"
          data-testid="viewer-perspective-toggle-line"
          onClick={() => {
            setCatalogOpen(false)
            setMode((current) => current === 'full' ? 'line' : 'full')
          }}
          aria-label={mode === 'full' ? t('layoutChrome.bottomBar.collapseLine') : t('layoutChrome.bottomBar.expand')}
          title={mode === 'full' ? t('layoutChrome.bottomBar.collapseLine') : t('layoutChrome.bottomBar.expand')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-200 hover:text-fg-secondary"
        >
          {mode === 'full' ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      {mode === 'full' && active === 'tags' && tagGroups.length > 0 && (
        <div
          data-testid="viewer-perspective-groups-strip"
          className="perspective-strip-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden border-t border-line-soft pt-2"
          onWheel={scrollStripHorizontally}
        >
          {tagGroups.map((group) => (
            <button
              key={group.id}
              type="button"
              data-testid={`viewer-tag-group-${group.id}`}
              aria-pressed={activeTagGroupId === group.id}
              onClick={() => {
                setActiveTagGroupId((current) => current === group.id ? null : group.id)
                setFocusedId(null)
              }}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface-50 px-2.5 text-[11px] font-semibold text-fg-secondary hover:bg-surface-200',
                activeTagGroupId === group.id && 'border-accent/35 bg-accent-subtle text-accent',
              )}
            >
              <FolderTree className="h-3 w-3" />
              {group.name}
              <span className="font-mono text-[10px] text-fg-subtle">{group.count}</span>
            </button>
          ))}
        </div>
      )}

      {mode === 'full' && active && (
        <div className="flex min-w-0 items-center gap-1.5 border-t border-line-soft pt-2">
          {values.length === 0 ? (
            <span className="px-1 text-[11px] text-fg-subtle">
              {t(`layoutChrome.bottomBar.${active}.empty`, {
                defaultValue: active === 'tags'
                  ? t('layoutChrome.bottomBar.tags.noValues')
                  : t('layoutChrome.bottomBar.tags.noValues'),
              })}
            </span>
          ) : (
            <div
              data-testid="viewer-perspective-values-strip"
              className="perspective-strip-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto overflow-y-hidden"
              onWheel={scrollStripHorizontally}
            >
              {valueButtons(false)}
            </div>
          )}
          {values.length > 0 && (
            <button
              type="button"
              onClick={() => setCatalogOpen((open) => !open)}
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line bg-surface-50 px-2.5 text-[11px] font-semibold text-fg-secondary hover:bg-surface-200"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
              {t('layoutChrome.bottomBar.tags.more')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
