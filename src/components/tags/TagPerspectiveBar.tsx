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
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  Cloud,
  CloudOff,
  Code,
  Crosshair,
  EyeOff,
  FolderTree,
  GripVertical,
  Layers3,
  Loader2,
  Lock,
  MoreHorizontal,
  Pin,
  Plus,
  Tag as TagIcon,
  UsersRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from 'react-i18next'
import { effectiveSyncStatus, useAutomergeStatus } from '../../stores/automergeStatusStore'
import { useRoutedRetriesInFlight } from '../../lib/api/useRoutedRetries'
import { useAuthStore } from '../../stores/authStore'
import { getDiagramIndex, useModelStore } from '../../stores/modelStore'
import { useUIStore, type BottomTab, type ManagedPerspective } from '../../stores/uiStore'
import { useSkinStore } from '../../stores/skinStore'
import { useThemeStore } from '../../stores/themeStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { myOrgs } from '../../lib/auth/api'
import {
  createCatalogTag,
  createCatalogTagGroup,
  getTagSettings,
  listTagGroupPage,
  listTagPage,
  reorderCatalogTag,
  reorderCatalogTagGroup,
  type CatalogTag,
  type CatalogTagGroup,
  type TagSettings,
} from '../../lib/tags/api'
import { cn } from '../../lib/utils'
import { collectDiagramFacetValues } from '../../canvas/facetPerspective'
import { resolveStatusColor, resolveTeamColor, resolveTechnologyColor } from '../../canvas/bottomBarColors'
import { referencedTagSnapshots } from '../../lib/tags/assignments'
import { canonicalTagId } from '../../lib/tags/canonicalIds'
import { getTeams } from '../../lib/orgAdmin/api'
import { FloatingPicker } from '../ui/floating-picker'
import { TagCatalogPicker } from './TagCatalogPicker'
import { moveRelative, resolvePerspectiveBarLayout } from './tagPerspectiveUtils'

type BarMode = 'full' | 'line' | 'fab'
type PerspectiveCatalogGroup = CatalogTagGroup & {
  catalogBacked: boolean
  diagramTagCount: number
}
type PerspectiveCatalogTag = CatalogTag & { catalogBacked: boolean }

const PERSPECTIVES: Array<{ id: Exclude<BottomTab, null>; icon: typeof TagIcon }> = [
  { id: 'tags', icon: TagIcon },
  { id: 'technology', icon: Code },
  { id: 'status', icon: Activity },
  { id: 'teams', icon: UsersRound },
]
const EMPTY_OBJECT_IDS: readonly string[] = []

function mergeUnique<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const values = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) values.set(item.id, item)
  return [...values.values()]
}

function HorizontalVirtualStrip<T extends { id: string }>({
  items,
  estimateSize,
  children,
  onEndReached,
  testId,
}: {
  items: readonly T[]
  estimateSize: number
  children: (item: T, index: number) => ReactNode
  onEndReached?: () => void
  testId?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollMetrics, setScrollMetrics] = useState({
    clientWidth: 0,
    scrollLeft: 0,
    scrollWidth: 0,
  })
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 4,
    getItemKey: (index) => items[index]?.id ?? index,
  })
  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  const syncScrollMetrics = useCallback((element: HTMLDivElement) => {
    const next = {
      clientWidth: element.clientWidth,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
    }
    setScrollMetrics((current) => (
      current.clientWidth === next.clientWidth
      && current.scrollLeft === next.scrollLeft
      && current.scrollWidth === next.scrollWidth
        ? current
        : next
    ))
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    syncScrollMetrics(element)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => syncScrollMetrics(element))
    observer.observe(element)
    return () => observer.disconnect()
  }, [syncScrollMetrics, totalSize])

  const maxScrollLeft = Math.max(0, scrollMetrics.scrollWidth - scrollMetrics.clientWidth)
  const thumbWidth = maxScrollLeft > 0
    ? Math.max(24, scrollMetrics.clientWidth ** 2 / scrollMetrics.scrollWidth)
    : scrollMetrics.clientWidth
  const thumbOffset = maxScrollLeft > 0
    ? (scrollMetrics.scrollLeft / maxScrollLeft) * (scrollMetrics.clientWidth - thumbWidth)
    : 0

  return (
    <div className="relative min-w-0 flex-1">
      <div
        ref={scrollRef}
        data-testid={testId}
        role="list"
        className="perspective-strip-scrollbar h-8 w-full overflow-x-auto overflow-y-hidden overscroll-x-contain"
        onWheel={(event) => {
          const element = event.currentTarget
          if (element.scrollWidth <= element.clientWidth) return

          event.preventDefault()
          event.stopPropagation()

          const dominantDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY
          const deltaMultiplier = event.deltaMode === 1
            ? 16
            : event.deltaMode === 2 ? element.clientWidth : 1
          const maxScrollLeft = element.scrollWidth - element.clientWidth
          element.scrollLeft = Math.max(
            0,
            Math.min(maxScrollLeft, element.scrollLeft + dominantDelta * deltaMultiplier),
          )
          syncScrollMetrics(element)
        }}
        onScroll={(event) => {
          const element = event.currentTarget
          syncScrollMetrics(element)
          if (element.scrollLeft + element.clientWidth >= element.scrollWidth - estimateSize * 2) {
            onEndReached?.()
          }
        }}
      >
        <div className="relative h-8" style={{ width: totalSize }}>
          {virtualItems.map((virtualItem) => (
            <div
              key={items[virtualItem.index].id}
              role="listitem"
              className="absolute left-0 top-0 h-8 pr-1.5"
              style={{
                width: virtualItem.size,
                transform: `translateX(${virtualItem.start}px)`,
              }}
            >
              {children(items[virtualItem.index], virtualItem.index)}
            </div>
          ))}
        </div>
      </div>
      {maxScrollLeft > 0 && (
        <div
          data-testid={testId ? `${testId}-scroll-indicator` : undefined}
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-[9px] left-0 right-0 z-10 h-px overflow-hidden bg-line-soft"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-line-strong will-change-transform"
            style={{
              width: thumbWidth,
              transform: `translate3d(${thumbOffset}px, 0, 0)`,
            }}
          />
        </div>
      )}
    </div>
  )
}

function SyncState({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  // THE CANVAS BADGE. The canvas is where the routed read is retried during a
  // workspace move (`/api/model/diagram-render`), so this badge must apply the
  // same retry downgrade as `WorkspaceShell`'s copy — `workspaceReady.ts`
  // accepts either badge interchangeably, so e2e alone would not catch a gap.
  const durabilityStatus = useAutomergeStatus((state) => state.status)
  const status = effectiveSyncStatus(durabilityStatus, useRoutedRetriesInFlight())
  const error = useAutomergeStatus((state) => state.error)
  // Test hook only — see the note on WorkspaceShell's ws-sync-status. `status`
  // is a durability latch and never reaches 'ready' on a brand-new landscape;
  // `projectedWorkspace` is the signal that names the loaded workspace.
  const projectedWorkspace = useAutomergeStatus((state) => state.projectedWorkspace)
  // A cached-root fallback session serves LOCAL content — surface it as a title
  // detail rather than a bare "Synced".
  const bootFallbackActive = useAutomergeStatus((state) => state.bootFallbackActive)
  const Icon = status === 'connecting' || status === 'saving'
    ? Loader2
    : status === 'offline'
      ? CloudOff
      : status === 'error'
        ? AlertCircle
        : Cloud
  return (
    <span
      id="sync-status"
      data-status={status}
      data-projected-workspace={projectedWorkspace ?? ''}
      data-boot-fallback={bootFallbackActive ? 'true' : undefined}
      title={error ?? (bootFallbackActive ? t('layoutChrome.bottomBar.sync.localFallback') : undefined)}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-[11px] text-fg-subtle',
        (status === 'connecting' || status === 'saving') && 'text-accent',
        status === 'offline' && 'text-warning-text',
        status === 'error' && 'text-error-text',
      )}
    >
      <Icon
        className={cn('h-3 w-3', (status === 'connecting' || status === 'saving') && 'animate-spin')}
        aria-hidden="true"
      />
      {/* 'saving' MUST have its own label: with the durability journal holding
          unflushed work, falling through to "Synced" would be the exact false
          claim the journal exists to prevent. */}
      {/* 'error' is the ONE status a user must be able to READ. In compact
          mode every label is sr-only, so a boot that died on a document would
          leave nothing on screen; an error keeps its words at every width. */}
      <span className={compact && status !== 'error' ? 'sr-only' : undefined}>{status === 'connecting'
        ? t('layoutChrome.bottomBar.sync.connecting')
        : status === 'saving'
          ? t('layoutChrome.bottomBar.sync.saving')
          : status === 'offline'
            ? t('layoutChrome.bottomBar.sync.offline')
            : status === 'error'
              ? t('layoutChrome.bottomBar.sync.error')
              : t('layoutChrome.bottomBar.sync.synced')}</span>
    </span>
  )
}

interface ManagedValue {
  id: string
  label: string
  color: string
}

function ManagedPerspectiveStrip({
  kind,
  values,
}: {
  kind: ManagedPerspective
  values: readonly ManagedValue[]
}) {
  const { t } = useTranslation()
  const interaction = useUIStore((state) => state.managedPerspectiveInteractions[kind])
  const setHovered = useUIStore((state) => state.setHoveredManagedPerspective)
  const togglePinned = useUIStore((state) => state.togglePinnedManagedPerspective)
  const setFocused = useUIStore((state) => state.setFocusedManagedPerspective)
  const toggleHidden = useUIStore((state) => state.toggleHiddenManagedPerspective)
  const pinned = useMemo(() => new Set(interaction.pinnedIds), [interaction.pinnedIds])
  const hidden = useMemo(() => new Set(interaction.hiddenIds), [interaction.hiddenIds])

  if (values.length === 0) {
    return <span className="px-1 text-[12px] text-fg-subtle">{t(`layoutChrome.bottomBar.${kind}.empty`)}</span>
  }

  return (
    <HorizontalVirtualStrip items={values} estimateSize={190} testId={`${kind}-value-strip`}>
      {(value) => {
        const isPinned = pinned.has(value.id)
        const isFocused = interaction.focusedId === value.id
        const isHidden = hidden.has(value.id)
        const label = kind === 'status'
          ? t(`layoutChrome.bottomBar.status.values.${value.id}`, { defaultValue: value.label })
          : value.label
        return (
          <span className="group flex h-8 w-full items-center gap-1 rounded-full border border-line bg-surface-100 px-1 text-[11px] text-fg-secondary">
            <button
              type="button"
              data-testid={`${kind}-value-${value.id}`}
              aria-pressed={isPinned}
              title={isPinned
                ? t('layoutChrome.bottomBar.managed.unpin', { value: label })
                : t('layoutChrome.bottomBar.managed.pin', { value: label })}
              onMouseEnter={() => setHovered(kind, value.id)}
              onMouseLeave={() => setHovered(kind, null)}
              onFocus={() => setHovered(kind, value.id)}
              onBlur={() => setHovered(kind, null)}
              onClick={() => togglePinned(kind, value.id)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-1.5 py-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isPinned && 'font-semibold text-fg',
                isHidden && 'line-through opacity-65',
                interaction.hoveredId === value.id && 'bg-surface-hover',
              )}
              style={isPinned ? { outline: `1px dashed ${value.color}` } : undefined}
            >
              <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: value.color }} aria-hidden="true" />
              {isPinned && <Pin className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />}
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              aria-pressed={isFocused}
              title={isFocused
                ? t('layoutChrome.bottomBar.managed.unfocus', { value: label })
                : t('layoutChrome.bottomBar.managed.focus', { value: label })}
              aria-label={isFocused
                ? t('layoutChrome.bottomBar.managed.unfocus', { value: label })
                : t('layoutChrome.bottomBar.managed.focus', { value: label })}
              onClick={() => setFocused(kind, value.id)}
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-surface-200 hover:text-fg',
                isFocused && 'bg-accent-subtle text-accent',
              )}
            >
              <Crosshair className="h-3 w-3" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={isHidden}
              title={isHidden
                ? t('layoutChrome.bottomBar.managed.unhide', { value: label })
                : t('layoutChrome.bottomBar.managed.hide', { value: label })}
              aria-label={isHidden
                ? t('layoutChrome.bottomBar.managed.unhide', { value: label })
                : t('layoutChrome.bottomBar.managed.hide', { value: label })}
              onMouseEnter={() => setHovered(kind, value.id)}
              onMouseLeave={() => setHovered(kind, null)}
              onClick={() => toggleHidden(kind, value.id)}
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-surface-200 hover:text-fg',
                isHidden && 'bg-error-bg text-error-text',
              )}
            >
              <EyeOff className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        )
      }}
    </HorizontalVirtualStrip>
  )
}

export function TagPerspectiveBar() {
  const { t } = useTranslation()
  const orgId = useAuthStore((state) => state.orgId)
  const user = useAuthStore((state) => state.user)
  const workspaceReadOnly = useModelStore((state) => state.workspaceReadOnly)
  const currentDiagram = useModelStore((state) => state.diagrams.find((diagram) => diagram.id === state.currentDiagramId))
  const allObjects = useModelStore((state) => state.objects)
  const allConnections = useModelStore((state) => state.connections)
  const allGroups = useModelStore((state) => state.groups)
  const tagSnapshots = useModelStore((state) => state.tags)
  const diagramObjects = useMemo(() => {
    const objectIds = currentDiagram?.objectIds ?? EMPTY_OBJECT_IDS
    if (objectIds.length === 0 || allObjects.length === 0) return []
    const index = getDiagramIndex()
    return objectIds.flatMap((id) => {
      const object = index.objectById.get(id)
      return object ? [object] : []
    })
  }, [allObjects, currentDiagram?.objectIds])
  const diagramGroups = useMemo(() => {
    const groupIds = currentDiagram?.groupIds ?? EMPTY_OBJECT_IDS
    if (groupIds.length === 0 || allGroups.length === 0) return []
    const index = getDiagramIndex()
    return groupIds.flatMap((id) => {
      const group = index.groupById.get(id)
      return group ? [group] : []
    })
  }, [allGroups, currentDiagram?.groupIds])
  const diagramConnections = useMemo(() => {
    const connectionIds = currentDiagram?.connectionIds ?? EMPTY_OBJECT_IDS
    if (connectionIds.length === 0 || allConnections.length === 0) return []
    const wanted = new Set(connectionIds)
    return allConnections.filter((connection) => wanted.has(connection.id))
  }, [allConnections, currentDiagram?.connectionIds])
  const diagramTagSnapshots = useMemo(
    () => referencedTagSnapshots([...diagramObjects, ...diagramConnections, ...diagramGroups], tagSnapshots),
    [diagramConnections, diagramGroups, diagramObjects, tagSnapshots],
  )
  const appTheme = useThemeStore((state) => state.resolved)
  const skin = useSkinStore((state) => state.getResolvedSkin(currentDiagram?.skinId, appTheme))
  const workspace = useWorkspaceStore((state) => state.ref)
  const leftSidebarOpen = useUIStore((state) => state.leftSidebarOpen)
  const rightSidebarOpen = useUIStore((state) => state.rightSidebarOpen)
  const canvasViewMode = useUIStore((state) => state.canvasViewMode)
  const bottomTab = useUIStore((state) => state.bottomTab)
  const setBottomTab = useUIStore((state) => state.setBottomTab)
  const activeTagGroupId = useUIStore((state) => state.activeTagGroupId)
  const setActiveTagGroup = useUIStore((state) => state.setActiveTagGroup)
  const hoveredTagId = useUIStore((state) => state.hoveredTagId)
  const setHoveredTag = useUIStore((state) => state.setHoveredTag)
  const pinnedTagIds = useUIStore((state) => state.pinnedTagIds)
  const togglePinnedTag = useUIStore((state) => state.togglePinnedTag)
  const focusedTagId = useUIStore((state) => state.focusedTagId)
  const setFocusedTag = useUIStore((state) => state.setFocusedTag)
  const hiddenTagIds = useUIStore((state) => state.hiddenTagIds)
  const toggleHiddenTag = useUIStore((state) => state.toggleHiddenTag)
  const managedInteractions = useUIStore((state) => state.managedPerspectiveInteractions)
  const setFocusedManaged = useUIStore((state) => state.setFocusedManagedPerspective)
  const toggleHiddenManaged = useUIStore((state) => state.toggleHiddenManagedPerspective)

  const [mode, setMode] = useState<BarMode>('full')
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1440 : window.innerWidth)
  const [groups, setGroups] = useState<CatalogTagGroup[]>([])
  const [groupCursor, setGroupCursor] = useState<string | null>(null)
  const [tags, setTags] = useState<CatalogTag[]>([])
  const [tagCursor, setTagCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<TagSettings | null>(null)
  const [orgRole, setOrgRole] = useState<'admin' | 'member' | null>(null)
  const [permissionReady, setPermissionReady] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newTagOpen, setNewTagOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [tagValue, setTagValue] = useState('')
  const [tagColor, setTagColor] = useState('#D97706')
  const [saving, setSaving] = useState(false)
  const [reorderingId, setReorderingId] = useState<string | null>(null)
  const [dragged, setDragged] = useState<{ kind: 'group' | 'tag'; id: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ kind: 'group' | 'tag'; id: string; before: boolean } | null>(null)
  const [teamNames, setTeamNames] = useState<Record<string, string>>({})

  const moreRef = useRef<HTMLButtonElement>(null)
  const newGroupRef = useRef<HTMLButtonElement>(null)
  const newTagRef = useRef<HTMLButtonElement>(null)

  const perspectiveGroups = useMemo((): PerspectiveCatalogGroup[] => {
    const diagramTagsByGroup = new Map<string, typeof diagramTagSnapshots>()
    for (const tag of diagramTagSnapshots) {
      const current = diagramTagsByGroup.get(tag.groupId) ?? []
      current.push(tag)
      diagramTagsByGroup.set(tag.groupId, current)
    }

    const catalogGroups = groups
      .filter((group) => diagramTagsByGroup.has(group.id))
      .map((group) => ({
        ...group,
        catalogBacked: true,
        diagramTagCount: diagramTagsByGroup.get(group.id)!.length,
      }))
    const loadedGroupIds = new Set(catalogGroups.map((group) => group.id))
    const snapshotGroups = [...diagramTagsByGroup.entries()]
      .filter(([groupId]) => !loadedGroupIds.has(groupId))
      .map(([groupId, diagramTags]) => ({
        id: groupId,
        orgId: orgId ?? '',
        name: diagramTags[0].groupName,
        description: null,
        iconKey: null,
        lifecycleStatus: 'active' as const,
        version: 0,
        createdAt: '',
        updatedAt: '',
        tagCount: diagramTags.length,
        catalogBacked: false,
        diagramTagCount: diagramTags.length,
      }))
    return [...catalogGroups, ...snapshotGroups]
  }, [diagramTagSnapshots, groups, orgId])
  const activeGroup = useMemo(
    () => perspectiveGroups.find((group) => group.id === activeTagGroupId) ?? null,
    [activeTagGroupId, perspectiveGroups],
  )
  const perspectiveTags = useMemo((): PerspectiveCatalogTag[] => {
    const visibleSnapshots = activeTagGroupId
      ? diagramTagSnapshots.filter((tag) => tag.groupId === activeTagGroupId)
      : diagramTagSnapshots
    const visibleSnapshotByCanonicalId = new Map(
      visibleSnapshots.map((snapshot) => [canonicalTagId(snapshot.tagId), snapshot]),
    )
    const catalogTags = tags
      .filter((tag) => visibleSnapshotByCanonicalId.has(canonicalTagId(tag.canonicalTagId || tag.id)))
      .map((tag) => ({ ...tag, catalogBacked: true }))
    const loadedCanonicalIds = new Set(
      catalogTags.map((tag) => canonicalTagId(tag.canonicalTagId || tag.id)),
    )
    const snapshotTags = visibleSnapshots
      .filter((snapshot) => !loadedCanonicalIds.has(canonicalTagId(snapshot.tagId)))
      .map((snapshot) => ({
        id: snapshot.tagId,
        orgId: orgId ?? '',
        groupId: snapshot.groupId,
        groupName: snapshot.groupName,
        value: snapshot.value,
        color: snapshot.color,
        lifecycleStatus: 'active' as const,
        canonicalTagId: snapshot.tagId,
        version: snapshot.catalogRevision,
        createdAt: '',
        updatedAt: '',
        catalogBacked: false,
      }))
    return [...catalogTags, ...snapshotTags]
  }, [activeTagGroupId, diagramTagSnapshots, orgId, tags])
  const pinned = useMemo(() => new Set(pinnedTagIds), [pinnedTagIds])
  const hidden = useMemo(() => new Set(hiddenTagIds), [hiddenTagIds])
  const barLayout = resolvePerspectiveBarLayout(
    viewportWidth,
    leftSidebarOpen,
    rightSidebarOpen,
    canvasViewMode,
  )
  const managedValues = useMemo(() => ({
    technology: collectDiagramFacetValues([...diagramObjects, ...diagramConnections], 'technology').map((value) => ({
      ...value,
      color: resolveTechnologyColor(value.label, skin),
    })),
    status: collectDiagramFacetValues([...diagramObjects, ...diagramConnections], 'status').map((value) => ({
      ...value,
      color: resolveStatusColor(value.id as 'live' | 'draft' | 'down' | 'unstable', skin),
    })),
    teams: collectDiagramFacetValues([...diagramObjects, ...diagramConnections], 'teams').map((value) => ({
      ...value,
      label: teamNames[value.id] ?? value.label,
      color: resolveTeamColor(value.id),
    })),
  }), [diagramConnections, diagramObjects, skin, teamNames])
  const activeManagedKind: ManagedPerspective | null = bottomTab === 'technology' || bottomTab === 'status' || bottomTab === 'teams'
    ? bottomTab
    : null
  const activeFocusedId = bottomTab === 'tags'
    ? focusedTagId
    : activeManagedKind ? managedInteractions[activeManagedKind].focusedId : null
  const activeHiddenIds = bottomTab === 'tags'
    ? hiddenTagIds
    : activeManagedKind ? managedInteractions[activeManagedKind].hiddenIds : []
  const hasExpandedContent = mode === 'full' && bottomTab !== null
  const barWidth = hasExpandedContent
    ? Math.min(720, barLayout.availableWidth)
    : 'fit-content'

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', update, { passive: true })
    return () => window.removeEventListener('resize', update)
  }, [])

  useEffect(() => {
    if (bottomTab !== 'teams' || !orgId) return
    const wanted = new Set(
      [...diagramObjects, ...diagramConnections].flatMap((entity) => entity.ownerTeamIds ?? []),
    )
    if (wanted.size === 0) return
    let cancelled = false
    void (async () => {
      const names: Record<string, string> = {}
      let after: string | null = null
      do {
        const page = await getTeams(orgId, { after, limit: 100 })
        for (const team of page.teams) {
          if (wanted.has(team.id)) names[team.id] = team.name
        }
        if ([...wanted].every((id) => names[id])) break
        after = page.nextCursor
      } while (after)
      if (!cancelled) setTeamNames((current) => ({ ...current, ...names }))
    })().catch(() => {
      // Persisted owner snapshots and stable team ids remain usable offline.
    })
    return () => {
      cancelled = true
    }
  }, [bottomTab, diagramConnections, diagramObjects, orgId])

  const canManageAsAdmin = Boolean(user?.isPlatformAdmin || orgRole === 'admin')
  const canCreateTag = Boolean(
    permissionReady && orgId && !workspaceReadOnly
      && (canManageAsAdmin || settings?.allowMemberTagCreation),
  )
  const canCreateGroup = Boolean(
    permissionReady && orgId && !workspaceReadOnly
      && (canManageAsAdmin || settings?.allowEditorTagGroupCreation),
  )

  useEffect(() => {
    if (!orgId) {
      setPermissionReady(true)
      return
    }
    const controller = new AbortController()
    setPermissionReady(false)
    Promise.all([
      getTagSettings(orgId, controller.signal).catch(() => null),
      myOrgs().catch(() => []),
    ]).then(([nextSettings, memberships]) => {
      if (controller.signal.aborted) return
      setSettings(nextSettings)
      setOrgRole(memberships.find((membership) => membership.id === orgId)?.role ?? null)
      setPermissionReady(true)
    })
    return () => controller.abort()
  }, [orgId])

  useEffect(() => {
    if (!orgId) {
      setGroups([])
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void listTagGroupPage(orgId, { status: 'active', limit: 50 }, controller.signal)
      .then((page) => {
        setGroups(page.items)
        setGroupCursor(page.nextCursor)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.loadFailed'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [orgId, t])

  useEffect(() => {
    if (bottomTab !== 'tags' || !activeTagGroupId) return
    if (!perspectiveGroups.some((group) => group.id === activeTagGroupId)) {
      setActiveTagGroup(null)
    }
  }, [activeTagGroupId, bottomTab, perspectiveGroups, setActiveTagGroup])

  useEffect(() => {
    if (!orgId || bottomTab !== 'tags' || !activeTagGroupId) {
      setTags([])
      setTagCursor(null)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void listTagPage(orgId, {
      groupIds: [activeTagGroupId],
      status: 'active',
      limit: 50,
    }, controller.signal)
      .then((page) => {
        setTags(page.items)
        setTagCursor(page.nextCursor)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.loadFailed'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [activeTagGroupId, bottomTab, orgId, t])

  const loadMoreGroups = useCallback(() => {
    if (!orgId || !groupCursor || loadingMore) return
    setLoadingMore(true)
    void listTagGroupPage(orgId, { status: 'active', after: groupCursor, limit: 50 })
      .then((page) => {
        setGroups((current) => mergeUnique(current, page.items))
        setGroupCursor(page.nextCursor)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.loadFailed')))
      .finally(() => setLoadingMore(false))
  }, [groupCursor, loadingMore, orgId, t])

  const loadMoreTags = useCallback(() => {
    if (!orgId || !activeTagGroupId || !tagCursor || loadingMore) return
    setLoadingMore(true)
    void listTagPage(orgId, {
      groupIds: [activeTagGroupId],
      status: 'active',
      after: tagCursor,
      limit: 50,
    })
      .then((page) => {
        setTags((current) => mergeUnique(current, page.items))
        setTagCursor(page.nextCursor)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.loadFailed')))
      .finally(() => setLoadingMore(false))
  }, [activeTagGroupId, loadingMore, orgId, t, tagCursor])

  const persistGroupMove = useCallback(async (sourceId: string, targetId: string, before: boolean) => {
    if (!orgId || !canManageAsAdmin || sourceId === targetId || reorderingId) return
    const source = groups.find((group) => group.id === sourceId)
    if (!source) return
    const previous = groups
    const next = moveRelative(previous, sourceId, targetId, before)
    if (next.every((item, index) => item.id === previous[index]?.id)) return
    setGroups(next)
    setReorderingId(sourceId)
    setError(null)
    try {
      const updated = await reorderCatalogTagGroup(
        orgId,
        source,
        before ? { beforeId: targetId } : { afterId: targetId },
      )
      setGroups((current) => current.map((group) => group.id === updated.id ? updated : group))
    } catch (cause) {
      setGroups(previous)
      setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.reorderFailed'))
    } finally {
      setReorderingId(null)
      setDragged(null)
      setDropTarget(null)
    }
  }, [canManageAsAdmin, groups, orgId, reorderingId, t])

  const persistTagMove = useCallback(async (sourceId: string, targetId: string, before: boolean) => {
    if (!orgId || !canManageAsAdmin || sourceId === targetId || reorderingId) return
    const source = tags.find((tag) => tag.id === sourceId)
    if (!source) return
    const previous = tags
    const next = moveRelative(previous, sourceId, targetId, before)
    if (next.every((item, index) => item.id === previous[index]?.id)) return
    setTags(next)
    setReorderingId(sourceId)
    setError(null)
    try {
      const updated = await reorderCatalogTag(
        orgId,
        source,
        before ? { beforeId: targetId } : { afterId: targetId },
      )
      setTags((current) => current.map((tag) => tag.id === updated.id ? updated : tag))
    } catch (cause) {
      setTags(previous)
      setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.reorderFailed'))
    } finally {
      setReorderingId(null)
      setDragged(null)
      setDropTarget(null)
    }
  }, [canManageAsAdmin, orgId, reorderingId, t, tags])

  const startDrag = (
    event: DragEvent<HTMLButtonElement>,
    kind: 'group' | 'tag',
    id: string,
  ) => {
    if (!canManageAsAdmin || reorderingId) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
    setDropTarget(null)
    setDragged({ kind, id })
  }

  const markDropTarget = (next: { kind: 'group' | 'tag'; id: string; before: boolean }) => {
    // dragover fires continuously. Preserve the same object identity until the
    // actual before/after target changes so the virtual strip does not flicker.
    setDropTarget((current) => current?.kind === next.kind
      && current.id === next.id
      && current.before === next.before
      ? current
      : next)
  }

  const submitGroup = async () => {
    if (!orgId || !groupName.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const group = await createCatalogTagGroup(orgId, {
        name: groupName.trim(),
        workspace,
      })
      setGroups((current) => mergeUnique(current, [group]))
      setActiveTagGroup(group.id)
      setBottomTab('tags')
      setGroupName('')
      setNewGroupOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  const submitTag = async () => {
    if (!orgId || !activeGroup || !tagValue.trim() || !/^#[0-9a-f]{6}$/i.test(tagColor) || saving) return
    setSaving(true)
    setError(null)
    try {
      const tag = await createCatalogTag(orgId, {
        groupId: activeGroup.id,
        value: tagValue.trim(),
        color: tagColor.toUpperCase(),
        workspace,
      })
      setTags((current) => mergeUnique(current, [tag]))
      setTagValue('')
      setNewTagOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('layoutChrome.bottomBar.tags.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (mode === 'fab' || barLayout.forcedFab) {
    return (
      <button
        type="button"
        data-testid="perspective-fab"
        aria-label={t('layoutChrome.bottomBar.showPerspectives')}
        title={t('layoutChrome.bottomBar.showPerspectives')}
        onClick={() => setMode('full')}
        style={{ left: barLayout.left, bottom: barLayout.bottom }}
        className="absolute z-20 flex h-[46px] w-[46px] items-center justify-center rounded-[15px] border border-line bg-surface-100 text-fg-secondary shadow-xl transition-[left,background-color,color] hover:bg-surface-50 hover:text-fg"
      >
        <Layers3 className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
    )
  }

  return (
    <>
      <section
        data-testid="tag-perspective-bar"
        aria-label={t('layoutChrome.bottomBar.perspectives')}
        style={{
          left: barLayout.left,
          bottom: barLayout.bottom,
          width: barWidth,
          maxWidth: barLayout.availableWidth,
        }}
        className="absolute z-20 flex min-w-0 flex-col gap-2 overflow-hidden rounded-[14px] border border-line bg-surface-100/95 p-2 pr-5 shadow-lg backdrop-blur-sm transition-[bottom,left,width,max-width] duration-300 ease-out"
      >
        <button
          type="button"
          onClick={() => setMode('fab')}
          aria-label={t('layoutChrome.bottomBar.collapseToButton')}
          title={t('layoutChrome.bottomBar.collapseToButton')}
          className="absolute bottom-0 right-0 top-0 flex w-4 items-center justify-center rounded-r-[13px] text-fg-subtle transition-colors hover:bg-accent-subtle hover:text-accent"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {PERSPECTIVES.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              data-testid={`bottom-tab-${id}`}
              aria-pressed={bottomTab === id}
              onClick={() => {
                if (mode === 'line') {
                  setMode('full')
                  if (bottomTab !== id) {
                    if (id === 'tags') setActiveTagGroup(null)
                    setBottomTab(id)
                  }
                  return
                }
                const nextTab = bottomTab === id ? null : id
                if (nextTab === 'tags') setActiveTagGroup(null)
                setBottomTab(nextTab)
              }}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg',
                bottomTab === id && 'bg-surface-200 text-fg',
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className={barLayout.compact && bottomTab !== id ? 'sr-only' : undefined}>
                {t(`layoutChrome.bottomBar.tabs.${id}`)}
              </span>
            </button>
          ))}
          <span className="min-w-2 flex-1" />
          {activeFocusedId && (
            <button
              type="button"
              onClick={() => activeManagedKind
                ? setFocusedManaged(activeManagedKind, null)
                : setFocusedTag(null)}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-accent-subtle px-2 text-[10px] font-semibold text-accent"
              title={t('layoutChrome.bottomBar.tags.clearFocus')}
            >
              <Crosshair className="h-2.5 w-2.5" aria-hidden="true" />
              <span className={barLayout.compact ? 'sr-only' : undefined}>{t('layoutChrome.bottomBar.tags.focusActive')}</span>
            </button>
          )}
          {activeHiddenIds.length > 0 && (
            <button
              type="button"
              onClick={() => activeHiddenIds.forEach((valueId) => activeManagedKind
                ? toggleHiddenManaged(activeManagedKind, valueId)
                : toggleHiddenTag(valueId))}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-error-bg px-2 text-[10px] font-semibold text-error-text"
              title={t('layoutChrome.bottomBar.tags.showAllHidden')}
            >
              <EyeOff className="h-2.5 w-2.5" aria-hidden="true" />
              <span className={barLayout.compact ? 'sr-only' : undefined}>{t('layoutChrome.bottomBar.tags.hiddenCount', { count: activeHiddenIds.length })}</span>
            </button>
          )}
          <SyncState compact={barLayout.compact} />
          {mode === 'full' && bottomTab && (
            <button
              type="button"
              data-testid="perspective-collapse-line"
              onClick={() => setMode('line')}
              aria-label={t('layoutChrome.bottomBar.collapseLine')}
              title={t('layoutChrome.bottomBar.collapseLine')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-200 hover:text-fg-secondary"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {mode === 'full' && bottomTab === 'tags' && (
          <>
            <div className="flex min-w-0 items-center gap-1.5 border-t border-line-soft pt-2">
              {loading && perspectiveGroups.length === 0 && diagramTagSnapshots.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-fg-subtle">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('layoutChrome.bottomBar.tags.loading')}
                </span>
              ) : perspectiveGroups.length === 0 ? (
                <span className="px-1 text-[12px] text-fg-subtle">{t('layoutChrome.bottomBar.tags.noGroups')}</span>
              ) : (
                <HorizontalVirtualStrip
                  items={perspectiveGroups}
                  estimateSize={150}
                  onEndReached={groupCursor ? loadMoreGroups : undefined}
                  testId="tag-group-strip"
                >
                  {(group, index) => (
                    <div
                      data-testid={`tag-group-${group.id}`}
                      onDragOver={(event) => {
                        if (group.catalogBacked && dragged?.kind === 'group' && dragged.id !== group.id) {
                          event.preventDefault()
                          const rect = event.currentTarget.getBoundingClientRect()
                          markDropTarget({ kind: 'group', id: group.id, before: event.clientX < rect.left + rect.width / 2 })
                        }
                      }}
                      onDrop={(event) => {
                        if (!group.catalogBacked || dragged?.kind !== 'group' || dragged.id === group.id) return
                        event.preventDefault()
                        const rect = event.currentTarget.getBoundingClientRect()
                        const before = event.clientX < rect.left + rect.width / 2
                        setDropTarget(null)
                        void persistGroupMove(dragged.id, group.id, before)
                      }}
                      className={cn(
                        'relative flex h-8 w-full items-center rounded-lg border border-line bg-surface-50 pl-0.5 pr-2 text-[12px] text-fg-secondary transition-colors hover:bg-surface-200',
                        activeTagGroupId === group.id && 'border-accent/35 bg-accent-subtle text-accent',
                        dragged?.kind === 'group' && dragged.id === group.id && 'opacity-55',
                      )}
                    >
                      {dropTarget?.kind === 'group' && dropTarget.id === group.id && (
                        <span
                          aria-hidden="true"
                          className={cn(
                            'pointer-events-none absolute bottom-1 top-1 z-10 w-0.5 rounded-full bg-accent shadow-[0_0_0_2px_var(--color-accent-subtle)]',
                            dropTarget.before ? '-left-1' : '-right-1',
                          )}
                        />
                      )}
                      {canManageAsAdmin && group.catalogBacked && (
                        <button
                          type="button"
                          draggable={!reorderingId}
                          onDragStart={(event) => startDrag(event, 'group', group.id)}
                          onDragEnd={() => { setDragged(null); setDropTarget(null) }}
                          onKeyDown={(event) => {
                            if (event.key === 'ArrowLeft' && index > 0) {
                              event.preventDefault()
                              void persistGroupMove(group.id, perspectiveGroups[index - 1].id, true)
                            } else if (event.key === 'ArrowRight' && index < perspectiveGroups.length - 1) {
                              event.preventDefault()
                              void persistGroupMove(group.id, perspectiveGroups[index + 1].id, false)
                            }
                          }}
                          aria-label={t('layoutChrome.bottomBar.tags.reorderGroup', { value: group.name })}
                          title={t('layoutChrome.bottomBar.tags.reorderHint')}
                          className="flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded text-fg-subtle hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
                        >
                          {reorderingId === group.id
                            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            : <GripVertical className="pointer-events-none h-3 w-3" aria-hidden="true" />}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-pressed={activeTagGroupId === group.id}
                        onClick={() => setActiveTagGroup(activeTagGroupId === group.id ? null : group.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <FolderTree className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate font-semibold">{group.name}</span>
                      </button>
                      <span className="font-mono text-[10px] text-fg-subtle">{group.diagramTagCount}</span>
                      {activeTagGroupId === group.id && <MoreHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />}
                    </div>
                  )}
                </HorizontalVirtualStrip>
              )}
              {canCreateGroup ? (
                <button
                  ref={newGroupRef}
                  type="button"
                  onClick={() => setNewGroupOpen(true)}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-dashed border-line-strong px-2.5 text-[12px] font-semibold text-fg-muted transition-colors hover:border-accent hover:text-accent"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  {t('layoutChrome.bottomBar.tags.newGroup')}
                </button>
              ) : (
                <span className="inline-flex h-8 shrink-0 items-center gap-1 px-2 text-[11px] text-fg-subtle">
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  {t('layoutChrome.bottomBar.tags.managed')}
                </span>
              )}
            </div>

            <div className="flex min-w-0 items-center gap-2 border-t border-line-soft pt-2">
              {perspectiveTags.length === 0 ? (
                <span className="px-1 text-[12px] text-fg-subtle">
                  {activeGroup ? t('layoutChrome.bottomBar.tags.noValues') : t('layoutChrome.bottomBar.tags.chooseGroup')}
                </span>
              ) : (
                <HorizontalVirtualStrip
                  items={perspectiveTags}
                  estimateSize={190}
                  onEndReached={tagCursor ? loadMoreTags : undefined}
                  testId="tag-value-strip"
                >
                  {(tag, index) => {
                    const isPinned = pinned.has(tag.id)
                    const isFocused = focusedTagId === tag.id
                    const isHidden = hidden.has(tag.id)
                    const tooltipValue = activeTagGroupId
                      ? tag.value
                      : `${tag.value} (${tag.groupName})`
                    return (
                      <span
                        onDragOver={(event) => {
                          if (tag.catalogBacked && dragged?.kind === 'tag' && dragged.id !== tag.id) {
                            event.preventDefault()
                            const rect = event.currentTarget.getBoundingClientRect()
                            markDropTarget({ kind: 'tag', id: tag.id, before: event.clientX < rect.left + rect.width / 2 })
                          }
                        }}
                        onDrop={(event) => {
                          if (!tag.catalogBacked || dragged?.kind !== 'tag' || dragged.id === tag.id) return
                          event.preventDefault()
                          const rect = event.currentTarget.getBoundingClientRect()
                          setDropTarget(null)
                          void persistTagMove(dragged.id, tag.id, event.clientX < rect.left + rect.width / 2)
                        }}
                        className={cn(
                          'group relative flex h-8 w-full items-center gap-1 rounded-full border border-line bg-surface-100 px-1 text-[11px] text-fg-secondary',
                          dragged?.kind === 'tag' && dragged.id === tag.id && 'opacity-55',
                        )}
                      >
                        {dropTarget?.kind === 'tag' && dropTarget.id === tag.id && (
                          <span
                            aria-hidden="true"
                            className={cn(
                              'pointer-events-none absolute bottom-1 top-1 z-10 w-0.5 rounded-full bg-accent shadow-[0_0_0_2px_var(--color-accent-subtle)]',
                              dropTarget.before ? '-left-1' : '-right-1',
                            )}
                          />
                        )}
                        {canManageAsAdmin && tag.catalogBacked && (
                          <button
                            type="button"
                            draggable={!reorderingId}
                            onDragStart={(event) => startDrag(event, 'tag', tag.id)}
                            onDragEnd={() => { setDragged(null); setDropTarget(null) }}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowLeft' && index > 0) {
                                event.preventDefault()
                                void persistTagMove(tag.id, perspectiveTags[index - 1].id, true)
                              } else if (event.key === 'ArrowRight' && index < perspectiveTags.length - 1) {
                                event.preventDefault()
                                void persistTagMove(tag.id, perspectiveTags[index + 1].id, false)
                              }
                            }}
                            aria-label={t('layoutChrome.bottomBar.tags.reorderTag', { value: tag.value })}
                            title={t('layoutChrome.bottomBar.tags.reorderHint')}
                            className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center rounded-full text-fg-subtle opacity-45 hover:bg-surface-hover group-hover:opacity-80 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
                          >
                            {reorderingId === tag.id
                              ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                              : <GripVertical className="pointer-events-none h-3 w-3" aria-hidden="true" />}
                          </button>
                        )}
                        <button
                          type="button"
                          data-testid={`tag-value-${tag.id}`}
                          aria-pressed={isPinned}
                          title={isPinned ? t('layoutChrome.bottomBar.tags.unpin', { value: tooltipValue }) : t('layoutChrome.bottomBar.tags.pin', { value: tooltipValue })}
                          onMouseEnter={() => setHoveredTag(tag.id)}
                          onMouseLeave={() => setHoveredTag(null)}
                          onFocus={() => setHoveredTag(tag.id)}
                          onBlur={() => setHoveredTag(null)}
                          onClick={() => togglePinnedTag(tag.id)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-1.5 py-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                            isPinned && 'font-semibold text-fg',
                            isHidden && 'line-through opacity-65',
                            hoveredTagId === tag.id && 'bg-surface-hover',
                          )}
                          style={isPinned ? { outline: `1px dashed ${tag.color}` } : undefined}
                        >
                          <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
                          {isPinned && <Pin className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />}
                          <span className="truncate">{tag.value}</span>
                        </button>
                        <button
                          type="button"
                          aria-pressed={isFocused}
                          title={isFocused ? t('layoutChrome.bottomBar.tags.unfocus', { value: tag.value }) : t('layoutChrome.bottomBar.tags.focus', { value: tag.value })}
                          aria-label={isFocused ? t('layoutChrome.bottomBar.tags.unfocus', { value: tag.value }) : t('layoutChrome.bottomBar.tags.focus', { value: tag.value })}
                          onClick={() => setFocusedTag(tag.id)}
                          className={cn(
                            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-surface-200 hover:text-fg',
                            isFocused && 'bg-accent-subtle text-accent',
                          )}
                        >
                          <Crosshair className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-pressed={isHidden}
                          title={isHidden ? t('layoutChrome.bottomBar.tags.unhide', { value: tag.value }) : t('layoutChrome.bottomBar.tags.hide', { value: tag.value })}
                          aria-label={isHidden ? t('layoutChrome.bottomBar.tags.unhide', { value: tag.value }) : t('layoutChrome.bottomBar.tags.hide', { value: tag.value })}
                          onMouseEnter={() => setHoveredTag(tag.id)}
                          onMouseLeave={() => setHoveredTag(null)}
                          onClick={() => toggleHiddenTag(tag.id)}
                          className={cn(
                            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-surface-200 hover:text-fg',
                            isHidden && 'bg-error-bg text-error-text',
                          )}
                        >
                          <EyeOff className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </span>
                    )
                  }}
                </HorizontalVirtualStrip>
              )}
              <button
                ref={moreRef}
                type="button"
                onClick={() => setCatalogOpen(true)}
                className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-line px-2.5 text-[11px] font-semibold text-fg-secondary hover:bg-surface-hover"
              >
                <MoreHorizontal className="h-3 w-3" aria-hidden="true" />
                {t('layoutChrome.bottomBar.tags.more')}
              </button>
              {activeGroup && canCreateTag && (
                <button
                  ref={newTagRef}
                  type="button"
                  onClick={() => setNewTagOpen(true)}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[11px] font-semibold text-fg-muted hover:border-accent hover:text-accent"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  {t('layoutChrome.bottomBar.tags.newTag')}
                </button>
              )}
            </div>
          </>
        )}

        {mode === 'full' && activeManagedKind && (
          <div className="flex min-w-0 items-center gap-2 border-t border-line-soft pt-2">
            <ManagedPerspectiveStrip kind={activeManagedKind} values={managedValues[activeManagedKind]} />
          </div>
        )}

        {error && <p role="alert" className="border-t border-line-soft px-1 pt-2 text-[11px] text-error-text">{error}</p>}
      </section>

      <TagCatalogPicker
        isOpen={catalogOpen}
        assignedTagIds={pinnedTagIds}
        initialGroupId={activeTagGroupId}
        triggerRef={moreRef}
        allowAssignedSelection
        onClose={() => setCatalogOpen(false)}
        onSelect={(snapshot, tag) => {
          setActiveTagGroup(tag.groupId)
          togglePinnedTag(snapshot.tagId)
        }}
      />

      <FloatingPicker
        isOpen={newGroupOpen}
        title={t('layoutChrome.bottomBar.tags.createGroup')}
        onClose={() => setNewGroupOpen(false)}
        triggerRef={newGroupRef}
        testId="perspective-new-group"
        className="w-[360px]"
      >
        <form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); void submitGroup() }}>
          <label className="block text-[11px] font-semibold text-fg-secondary">
            {t('layoutChrome.bottomBar.tags.groupName')}
            <input
              autoFocus
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setNewGroupOpen(false)} className="h-8 rounded-lg px-3 text-[11px] font-semibold text-fg-secondary hover:bg-surface-hover">{t('common.cancel')}</button>
            <button type="submit" disabled={!groupName.trim() || saving} className="h-8 rounded-lg bg-accent px-3 text-[11px] font-semibold text-accent-text disabled:opacity-45">{t('common.save')}</button>
          </div>
        </form>
      </FloatingPicker>

      <FloatingPicker
        isOpen={newTagOpen}
        title={t('layoutChrome.bottomBar.tags.createTag', { group: activeGroup?.name ?? '' })}
        onClose={() => setNewTagOpen(false)}
        triggerRef={newTagRef}
        testId="perspective-new-tag"
        className="w-[380px]"
      >
        <form className="space-y-3 p-4" onSubmit={(event) => { event.preventDefault(); void submitTag() }}>
          <label className="block text-[11px] font-semibold text-fg-secondary">
            {t('layoutChrome.bottomBar.tags.tagName')}
            <input
              autoFocus
              value={tagValue}
              onChange={(event) => setTagValue(event.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface-50 px-3 text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </label>
          <label className="block text-[11px] font-semibold text-fg-secondary">
            {t('layoutChrome.bottomBar.tags.color')}
            <span className="mt-1 flex items-center gap-2">
              <input type="color" value={tagColor} onChange={(event) => setTagColor(event.target.value)} className="h-9 w-11 rounded-lg border border-line bg-surface-50 p-1" />
              <input value={tagColor} onChange={(event) => setTagColor(event.target.value)} className="h-9 flex-1 rounded-lg border border-line bg-surface-50 px-3 font-mono text-[12px] text-fg outline-none focus:border-accent focus:ring-1 focus:ring-accent" />
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setNewTagOpen(false)} className="h-8 rounded-lg px-3 text-[11px] font-semibold text-fg-secondary hover:bg-surface-hover">{t('common.cancel')}</button>
            <button type="submit" disabled={!tagValue.trim() || !/^#[0-9a-f]{6}$/i.test(tagColor) || saving} className="h-8 rounded-lg bg-accent px-3 text-[11px] font-semibold text-accent-text disabled:opacity-45">{t('common.save')}</button>
          </div>
        </form>
      </FloatingPicker>
    </>
  )
}
