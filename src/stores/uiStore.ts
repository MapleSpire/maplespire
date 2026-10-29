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

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { C4Type } from '../types'
import { accountStorageKey } from '../lib/auth/accountNamespace'

// AI Assist panel width — resizable (drag handle on the panel's right edge),
// persisted like every other manually-persisted setting ('maplespire:' key,
// see themeStore's workspaceRef-style convention).
const AI_ASSIST_WIDTH_KEY = 'maplespire:aiAssistWidth'
export const AI_ASSIST_DEFAULT_WIDTH = 312
export const AI_ASSIST_MIN_WIDTH = 280
export const AI_ASSIST_MAX_WIDTH = 560

function clampAiAssistWidth(width: number): number {
  return Math.min(AI_ASSIST_MAX_WIDTH, Math.max(AI_ASSIST_MIN_WIDTH, Math.round(width)))
}

function readPersistedAiAssistWidth(): number {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(AI_ASSIST_WIDTH_KEY) : null
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n)) return clampAiAssistWidth(n)
  } catch {
    /* localStorage unavailable (SSR / privacy mode) */
  }
  return AI_ASSIST_DEFAULT_WIDTH
}

type SidebarTab = 'view' | 'introduction' | 'details'
type PropertyTab = 'details' | 'connections'
type RightSidebarTab = 'properties' | 'comments'
export type BottomTab = 'tags' | 'technology' | 'status' | 'teams' | null
export type ManagedPerspective = 'technology' | 'status' | 'teams'
export interface ManagedPerspectiveInteractionState {
  hoveredId: string | null
  pinnedIds: string[]
  focusedId: string | null
  hiddenIds: string[]
}
type ToolMode = 'select' | 'connection' | 'pan'
export type CanvasViewMode = '2d' | '3d'
export type CanvasCameraPreset = 'tilt' | 'iso'

// Per-diagram memory of the 2D/3D view (a per-user VIEW preference — kept in
// localStorage, deliberately NOT synced into the shared diagram doc).
// Per user (accountNamespace.ts): names one account's diagrams.
const view3dKey = (diagramId: string) => accountStorageKey(`maplespire:view3d:${diagramId}`)

function readView3d(diagramId: string): { mode: CanvasViewMode; preset: CanvasCameraPreset } | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(view3dKey(diagramId)) : null
    if (!raw) return null
    const [mode, preset] = raw.split(':')
    if (mode !== '2d' && mode !== '3d') return null
    // Old sessions may have persisted the removed 'deep' preset — fall back to iso.
    const p: CanvasCameraPreset = preset === 'tilt' ? 'tilt' : 'iso'
    return { mode, preset: p }
  } catch {
    return null
  }
}

function writeView3d(diagramId: string, mode: CanvasViewMode, preset: CanvasCameraPreset) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(view3dKey(diagramId), `${mode}:${preset}`)
  } catch {
    /* localStorage unavailable */
  }
}
export type AppView = 'diagram' | 'model-objects' | 'model-viewer' | 'diagrams' | 'connections' | 'decision-records' | 'dependencies' | 'drafts'

/** Model Viewer display options (routing/density/… — the bottom-right "View" popover). */
export interface ModelViewerOptions {
  routing: 'curved' | 'orthogonal' | 'straight'
  density: 'comfortable' | 'compact'
  /** Hide descriptions/tech (name-only tiles). */
  minimal: boolean
  /** Show objects with no lower level. */
  showEmpty: boolean
  /** Drill-zoom speed multiplier (0.5–2). */
  speed: number
}

export interface ModelObjectsFilter {
  types: C4Type[]
  scope?: 'internal' | 'external'
  status?: 'live' | 'draft'
  statuses?: Array<'live' | 'draft' | 'down' | 'unstable'>
  tagIds: string[]
  technologyIds?: string[]
  teamIds?: string[]
  inDiagram?: boolean
  /** Resolves external on at least one diagram (per-diagram scope). */
  externalOnSomeDiagram?: boolean
  hasDescription?: boolean
}

interface UIState {
  // Sidebar states
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  /** The workspace pages' floating left NAV sidebar (WorkspaceShell) — independent
   * of the editor's Shapes panel (`leftSidebarOpen`) so collapsing one doesn't
   * collapse the other. */
  workspaceNavOpen: boolean
  leftSidebarTab: SidebarTab
  propertyTab: PropertyTab
  bottomTab: BottomTab

  // View switching
  currentView: AppView

  // Toolbar
  toolMode: ToolMode
  zoom: number
  showGrid: boolean
  /** Bumped to ask the canvas to zoom-to-fit (e.g. after Auto-layout). */
  fitRequestId: number

  // 2D/3D canvas view (per-user preference; remembered per diagram)
  canvasViewMode: CanvasViewMode
  cameraPreset: CanvasCameraPreset
  /** Bumped to ask the canvas to animate the camera back to its preset. */
  cameraResetRequestId: number

  // Modals
  searchOpen: boolean
  settingsOpen: boolean
  historyOpen: boolean
  shareOpen: boolean
  shareView: 'share' | 'manage'
  /** Top-level dialog tab: share links vs file export. */
  shareTab: 'share' | 'export'

  // Flow navigation
  currentFlowId: string | null
  currentFlowStepIndex: number
  flowEditMode: boolean

  // Comment mode
  commentMode: boolean
  openCommentId: string | null
  commentsDropdownOpen: boolean

  // AI assist panel (editor)
  aiAssistOpen: boolean
  /** Panel width in px, drag-resizable via a handle on its right edge. */
  aiAssistWidth: number

  // Floating "Create" shape palette (editor) — the relocated "Or create new".
  // Opened by the tool pill's + button; draggable + clamped over the canvas.
  createPaletteOpen: boolean
  /** Last position in the editor content region's coordinate space; null until
   * first opened (then computed to a safe top-left spot). Survives close/reopen. */
  createPalettePos: { x: number; y: number } | null

  // Theme shop modal (relocated out of the old TopBar)
  shopOpen: boolean

  // Draft changes review dropdown
  changesDropdownOpen: boolean
  // Merge-changes modal
  mergeModalOpen: boolean

  // Right sidebar tab
  rightSidebarTab: RightSidebarTab
  commentsFilter: 'all' | 'unresolved' | 'resolved'

  // Breadcrumb / navigation
  canGoBack: boolean
  canGoForward: boolean

  /**
   * Shapes expanded IN PLACE on the canvas: objectId -> the diagram whose
   * shapes are drawn inside it. A VIEW state, never persisted — see
   * `expandInline.ts`.
   *
   * `inlineExpansionsDiagramId` owns the map. An expansion means nothing on a
   * different diagram, and pairing the two lets a diagram switch drop them
   * without an effect that could fire a frame late.
   */
  inlineExpansions: Record<string, string>
  inlineExpansionsDiagramId: string | null

  // Zoom-in navigation
  zoomedFromObjectId: string | null
  previousDiagramId: string | null
  isTransitioning: boolean
  transitionDirection: 'in' | 'out' | null
  /** An entity to centre on when `diagramId` is next fitted on the canvas, set
   *  by "open in diagram" links (Details panel). The canvas consumes it in place
   *  of its first zoom-to-fit, so the switch lands on the entity. */
  pendingCanvasFocus: { diagramId: string; kind: 'object' | 'group' | 'connection'; id: string } | null

  // Decision records view state
  selectedADRId: string | null
  adrSearchQuery: string

  // Tag interactions
  hoveredTagId: string | null
  activeTagGroupId: string | null
  pinnedTagIds: string[]
  focusedTagId: string | null
  hiddenTagIds: string[]
  managedPerspectiveInteractions: Record<ManagedPerspective, ManagedPerspectiveInteractionState>

  // Model objects view state
  modelObjectsSearchQuery: string
  modelObjectsFilter: ModelObjectsFilter
  modelObjectsExpandedIds: string[]
  modelObjectsDomainId: string | null

  // Connections view state
  connectionsSearchQuery: string
  connectionsSortBy: 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows'
  connectionsSortAsc: boolean
  connectionsDomainId: string | null

  // Dependencies view state.
  // There is no per-direction search: the page had one per column until the
  // design-system pass (3b5cd3ef) rebuilt it as the kit's radial focus fan,
  // which has ONE centred pill. The seam still accepts a per-direction `search`
  // — it is implemented on all three backends — but nothing in the UI feeds it,
  // so state for it here would be unwritable by construction.
  dependenciesFocusId: string | null
  dependenciesGlobalSearch: string
  dependenciesDomainId: string | null

  // Model viewer view state
  /** Drill path of object ids from the root (empty = context level). Validated
   * against the live model on render (ids can vanish mid-session). */
  modelViewerPath: string[]
  modelViewerSearchQuery: string
  modelViewerDomainIds: string[]
  modelViewerOptions: ModelViewerOptions
  /** 2D grid vs the 3D board presentation of the same level. */
  modelViewerMode: '2d' | '3d'

  // Actions
  toggleLeftSidebar: () => void
  toggleRightSidebar: () => void
  setRightSidebarOpen: (open: boolean) => void
  setWorkspaceNavOpen: (open: boolean) => void
  setLeftSidebarTab: (tab: SidebarTab) => void
  setPropertyTab: (tab: PropertyTab) => void
  setBottomTab: (tab: BottomTab) => void
  setCurrentView: (view: AppView) => void
  setToolMode: (mode: ToolMode) => void
  setZoom: (zoom: number) => void
  zoomIn: () => void
  zoomOut: () => void
  zoomFit: () => void
  requestFit: () => void
  toggleGrid: () => void
  /** Switch 2D/3D; remembers per diagram when `diagramId` is given. */
  setCanvasViewMode: (mode: CanvasViewMode, diagramId?: string | null) => void
  setCameraPreset: (preset: CanvasCameraPreset, diagramId?: string | null) => void
  requestCameraReset: () => void
  /** Restore the remembered view mode + preset when entering a diagram. */
  restoreCanvasViewFor: (diagramId: string) => void
  setSearchOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setHistoryOpen: (open: boolean) => void
  setShareOpen: (open: boolean) => void
  setShareView: (view: 'share' | 'manage') => void
  setShareTab: (tab: 'share' | 'export') => void
  setCurrentFlow: (id: string | null) => void
  setFlowStepIndex: (index: number) => void
  nextFlowStep: () => void
  prevFlowStep: () => void
  resetFlowStep: () => void
  toggleFlowEditMode: () => void
  setFlowEditMode: (mode: boolean) => void
  toggleCommentMode: () => void
  setOpenCommentId: (id: string | null) => void
  setCommentsDropdownOpen: (open: boolean) => void
  toggleAIAssist: () => void
  setAIAssistOpen: (open: boolean) => void
  setAIAssistWidth: (width: number) => void
  setCreatePaletteOpen: (open: boolean) => void
  toggleCreatePalette: () => void
  setCreatePalettePos: (pos: { x: number; y: number }) => void
  setShopOpen: (open: boolean) => void
  setChangesDropdownOpen: (open: boolean) => void
  setMergeModalOpen: (open: boolean) => void
  setRightSidebarTab: (tab: RightSidebarTab) => void
  setCommentsFilter: (filter: 'all' | 'unresolved' | 'resolved') => void
  setHoveredTag: (id: string | null) => void
  setActiveTagGroup: (id: string | null) => void
  togglePinnedTag: (id: string) => void
  setFocusedTag: (id: string | null) => void
  toggleHiddenTag: (id: string) => void
  setHoveredManagedPerspective: (kind: ManagedPerspective, id: string | null) => void
  togglePinnedManagedPerspective: (kind: ManagedPerspective, id: string) => void
  setFocusedManagedPerspective: (kind: ManagedPerspective, id: string | null) => void
  toggleHiddenManagedPerspective: (kind: ManagedPerspective, id: string) => void
  setModelObjectsSearchQuery: (query: string) => void
  setModelObjectsFilter: (filter: Partial<ModelObjectsFilter>) => void
  toggleModelObjectsExpanded: (id: string) => void
  expandModelObjectsId: (id: string) => void
  setModelObjectsDomainId: (id: string | null) => void
  setConnectionsSearchQuery: (query: string) => void
  setConnectionsSortBy: (by: 'name' | 'sender' | 'receiver' | 'diagrams' | 'flows') => void
  setConnectionsSortAsc: (asc: boolean) => void
  setConnectionsDomainId: (id: string | null) => void
  setDependenciesFocusId: (id: string | null) => void
  setDependenciesGlobalSearch: (query: string) => void
  setDependenciesDomainId: (id: string | null) => void
  setModelViewerPath: (path: string[]) => void
  setModelViewerSearchQuery: (query: string) => void
  toggleModelViewerDomainId: (id: string) => void
  clearModelViewerDomainIds: () => void
  setModelViewerOptions: (patch: Partial<ModelViewerOptions>) => void
  setModelViewerMode: (mode: '2d' | '3d') => void

  // Zoom-in navigation actions
  expandInline: (diagramId: string, objectId: string, targetDiagramId: string) => void
  /** `nested`: entries left hostless by this collapse (`expansionsOrphanedByCollapse`). */
  collapseInline: (objectId: string, nested?: readonly string[]) => void
  /** Drop entries whose host is gone (`unreachableExpansions`). */
  dropInlineExpansions: (objectIds: readonly string[]) => void
  setZoomedFromObjectId: (id: string | null) => void
  setPendingCanvasFocus: (focus: UIState['pendingCanvasFocus']) => void
  setPreviousDiagramId: (id: string | null) => void
  setIsTransitioning: (value: boolean) => void
  setTransitionDirection: (dir: 'in' | 'out' | null) => void

  // Decision record actions
  setSelectedADRId: (id: string | null) => void
  setADRSearchQuery: (query: string) => void
}

export const useUIStore = create<UIState>()(
  immer((set) => ({
    leftSidebarOpen: true,
    rightSidebarOpen: true,
    workspaceNavOpen: true,
    leftSidebarTab: 'view',
    propertyTab: 'details',
    bottomTab: null,
    currentView: 'diagram',
    toolMode: 'select',
    zoom: 1,
    showGrid: true,
    fitRequestId: 0,
    canvasViewMode: '2d',
    cameraPreset: 'iso',
    cameraResetRequestId: 0,
    searchOpen: false,
    settingsOpen: false,
    historyOpen: false,
    shareOpen: false,
    shareTab: 'share',
    shareView: 'share',
    currentFlowId: null,
    currentFlowStepIndex: 0,
    flowEditMode: true,
    commentMode: false,
    openCommentId: null,
    commentsDropdownOpen: false,
    aiAssistOpen: false,
    aiAssistWidth: readPersistedAiAssistWidth(),
    createPaletteOpen: false,
    createPalettePos: null,
    shopOpen: false,
    changesDropdownOpen: false,
    mergeModalOpen: false,
    rightSidebarTab: 'properties',
    commentsFilter: 'all',
    canGoBack: false,
    canGoForward: false,

    inlineExpansions: {},
    inlineExpansionsDiagramId: null,
    zoomedFromObjectId: null,
    previousDiagramId: null,
    isTransitioning: false,
    transitionDirection: null,
    pendingCanvasFocus: null,

    selectedADRId: null,
    adrSearchQuery: '',

    hoveredTagId: null,
    activeTagGroupId: null,
    pinnedTagIds: [],
    focusedTagId: null,
    hiddenTagIds: [],
    managedPerspectiveInteractions: {
      technology: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
      status: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
      teams: { hoveredId: null, pinnedIds: [], focusedId: null, hiddenIds: [] },
    },
    modelObjectsSearchQuery: '',
    modelObjectsFilter: { types: [], tagIds: [] },
    modelObjectsExpandedIds: [],
    modelObjectsDomainId: null,
    connectionsSearchQuery: '',
    connectionsSortBy: 'name',
    connectionsSortAsc: true,
    connectionsDomainId: null,
    dependenciesFocusId: null,
    dependenciesGlobalSearch: '',
    dependenciesDomainId: null,
    modelViewerPath: [],
    modelViewerSearchQuery: '',
    modelViewerDomainIds: [],
    modelViewerOptions: { routing: 'curved', density: 'comfortable', minimal: false, showEmpty: true, speed: 1 },
    modelViewerMode: '2d',

    toggleLeftSidebar: () =>
      set((state) => {
        state.leftSidebarOpen = !state.leftSidebarOpen
      }),

    toggleRightSidebar: () =>
      set((state) => {
        state.rightSidebarOpen = !state.rightSidebarOpen
      }),
    setRightSidebarOpen: (open) =>
      set((state) => {
        state.rightSidebarOpen = open
      }),
    setWorkspaceNavOpen: (open) =>
      set((state) => {
        state.workspaceNavOpen = open
      }),

    setLeftSidebarTab: (tab) =>
      set((state) => {
        state.leftSidebarTab = tab
      }),

    setPropertyTab: (tab) =>
      set((state) => {
        state.propertyTab = tab
      }),

    setBottomTab: (tab) =>
      set((state) => {
        state.bottomTab = tab
      }),

    setCurrentView: (view) =>
      set((state) => {
        state.currentView = view
        // A canvas-centring request is for the NEXT canvas visit only; coming
        // back later through the nav must fit normally.
        if (view !== 'diagram') state.pendingCanvasFocus = null
      }),

    setToolMode: (mode) =>
      set((state) => {
        state.toolMode = mode
      }),

    setZoom: (zoom) =>
      set((state) => {
        state.zoom = Math.max(0.1, Math.min(4, zoom))
      }),

    zoomIn: () =>
      set((state) => {
        state.zoom = Math.min(4, state.zoom + 0.1)
      }),

    zoomOut: () =>
      set((state) => {
        state.zoom = Math.max(0.1, state.zoom - 0.1)
      }),

    zoomFit: () =>
      set((state) => {
        state.zoom = 1
      }),

    requestFit: () =>
      set((state) => {
        state.fitRequestId += 1
      }),

    toggleGrid: () =>
      set((state) => {
        state.showGrid = !state.showGrid
      }),

    setCanvasViewMode: (mode, diagramId) =>
      set((state) => {
        state.canvasViewMode = mode
        if (diagramId) writeView3d(diagramId, mode, state.cameraPreset)
      }),

    setCameraPreset: (preset, diagramId) =>
      set((state) => {
        state.cameraPreset = preset
        if (diagramId) writeView3d(diagramId, state.canvasViewMode, preset)
      }),

    requestCameraReset: () =>
      set((state) => {
        state.cameraResetRequestId += 1
      }),

    restoreCanvasViewFor: (diagramId) =>
      set((state) => {
        const saved = readView3d(diagramId)
        state.canvasViewMode = saved?.mode ?? '2d'
        state.cameraPreset = saved?.preset ?? 'iso'
      }),

    setSearchOpen: (open) =>
      set((state) => {
        state.searchOpen = open
      }),

    setSettingsOpen: (open) =>
      set((state) => {
        state.settingsOpen = open
      }),

    setHistoryOpen: (open) =>
      set((state) => {
        state.historyOpen = open
      }),

    setShareOpen: (open) =>
      set((state) => {
        state.shareOpen = open
        // Always reopen on the main share view, never the manage sub-view.
        if (!open) {
          state.shareView = 'share'
          state.shareTab = 'share'
        }
      }),

    setShareView: (view) =>
      set((state) => {
        state.shareView = view
      }),

    setShareTab: (tab) =>
      set((state) => {
        state.shareTab = tab
      }),

    setCurrentFlow: (id) =>
      set((state) => {
        state.currentFlowId = id
        state.currentFlowStepIndex = 0
      }),

    setFlowStepIndex: (index) =>
      set((state) => {
        state.currentFlowStepIndex = index
      }),

    nextFlowStep: () =>
      set((state) => {
        state.currentFlowStepIndex += 1
      }),

    prevFlowStep: () =>
      set((state) => {
        state.currentFlowStepIndex = Math.max(0, state.currentFlowStepIndex - 1)
      }),

    resetFlowStep: () =>
      set((state) => {
        state.currentFlowStepIndex = 0
      }),

    toggleFlowEditMode: () =>
      set((state) => {
        state.flowEditMode = !state.flowEditMode
      }),

    setFlowEditMode: (mode) =>
      set((state) => {
        state.flowEditMode = mode
      }),

    toggleCommentMode: () =>
      set((state) => {
        state.commentMode = !state.commentMode
      }),

    setOpenCommentId: (id) =>
      set((state) => {
        state.openCommentId = id
      }),

    setCommentsDropdownOpen: (open) =>
      set((state) => {
        state.commentsDropdownOpen = open
      }),
    toggleAIAssist: () =>
      set((state) => {
        state.aiAssistOpen = !state.aiAssistOpen
      }),
    setAIAssistOpen: (open) =>
      set((state) => {
        state.aiAssistOpen = open
      }),
    setAIAssistWidth: (width) =>
      set((state) => {
        const clamped = clampAiAssistWidth(width)
        state.aiAssistWidth = clamped
        try {
          localStorage.setItem(AI_ASSIST_WIDTH_KEY, String(clamped))
        } catch {
          /* private mode / quota — non-fatal, just no persistence */
        }
      }),
    setCreatePaletteOpen: (open) =>
      set((state) => {
        state.createPaletteOpen = open
      }),
    toggleCreatePalette: () =>
      set((state) => {
        state.createPaletteOpen = !state.createPaletteOpen
      }),
    setCreatePalettePos: (pos) =>
      set((state) => {
        state.createPalettePos = pos
      }),
    setShopOpen: (open) =>
      set((state) => {
        state.shopOpen = open
      }),
    setChangesDropdownOpen: (open) =>
      set((state) => {
        state.changesDropdownOpen = open
      }),
    setMergeModalOpen: (open) =>
      set((state) => {
        state.mergeModalOpen = open
      }),
    setRightSidebarTab: (tab) =>
      set((state) => {
        state.rightSidebarTab = tab
      }),
    setCommentsFilter: (filter) =>
      set((state) => {
        state.commentsFilter = filter
      }),

    setHoveredTag: (id) =>
      set((state) => {
        state.hoveredTagId = id
      }),

    setActiveTagGroup: (id) =>
      set((state) => {
        state.activeTagGroupId = id
      }),

    togglePinnedTag: (id) =>
      set((state) => {
        if (state.pinnedTagIds.includes(id)) {
          state.pinnedTagIds = state.pinnedTagIds.filter((t) => t !== id)
        } else {
          state.pinnedTagIds.push(id)
        }
      }),

    setFocusedTag: (id) =>
      set((state) => {
        state.focusedTagId = state.focusedTagId === id ? null : id
      }),

    toggleHiddenTag: (id) =>
      set((state) => {
        if (state.hiddenTagIds.includes(id)) {
          state.hiddenTagIds = state.hiddenTagIds.filter((t) => t !== id)
        } else {
          state.hiddenTagIds.push(id)
        }
      }),

    setHoveredManagedPerspective: (kind, id) =>
      set((state) => {
        state.managedPerspectiveInteractions[kind].hoveredId = id
      }),

    togglePinnedManagedPerspective: (kind, id) =>
      set((state) => {
        const interaction = state.managedPerspectiveInteractions[kind]
        interaction.pinnedIds = interaction.pinnedIds.includes(id)
          ? interaction.pinnedIds.filter((value) => value !== id)
          : [...interaction.pinnedIds, id]
      }),

    setFocusedManagedPerspective: (kind, id) =>
      set((state) => {
        const interaction = state.managedPerspectiveInteractions[kind]
        interaction.focusedId = interaction.focusedId === id ? null : id
      }),

    toggleHiddenManagedPerspective: (kind, id) =>
      set((state) => {
        const interaction = state.managedPerspectiveInteractions[kind]
        interaction.hiddenIds = interaction.hiddenIds.includes(id)
          ? interaction.hiddenIds.filter((value) => value !== id)
          : [...interaction.hiddenIds, id]
      }),

    setModelObjectsSearchQuery: (query) =>
      set((state) => {
        state.modelObjectsSearchQuery = query
      }),

    setModelObjectsFilter: (filter) =>
      set((state) => {
        state.modelObjectsFilter = { ...state.modelObjectsFilter, ...filter }
      }),

    toggleModelObjectsExpanded: (id) =>
      set((state) => {
        if (state.modelObjectsExpandedIds.includes(id)) {
          state.modelObjectsExpandedIds = state.modelObjectsExpandedIds.filter((eid) => eid !== id)
        } else {
          state.modelObjectsExpandedIds.push(id)
        }
      }),

    expandModelObjectsId: (id) =>
      set((state) => {
        if (!state.modelObjectsExpandedIds.includes(id)) {
          state.modelObjectsExpandedIds.push(id)
        }
      }),

    setModelObjectsDomainId: (id) =>
      set((state) => {
        state.modelObjectsDomainId = id
      }),

    setConnectionsSearchQuery: (query) =>
      set((state) => {
        state.connectionsSearchQuery = query
      }),

    setConnectionsSortBy: (by) =>
      set((state) => {
        state.connectionsSortBy = by
      }),

    setConnectionsSortAsc: (asc) =>
      set((state) => {
        state.connectionsSortAsc = asc
      }),

    setConnectionsDomainId: (id) =>
      set((state) => {
        state.connectionsDomainId = id
      }),

    setDependenciesFocusId: (id) =>
      set((state) => {
        state.dependenciesFocusId = id
      }),

    setDependenciesGlobalSearch: (query) =>
      set((state) => {
        state.dependenciesGlobalSearch = query
      }),

    setDependenciesDomainId: (id) =>
      set((state) => {
        state.dependenciesDomainId = id
      }),

    setModelViewerPath: (path) =>
      set((state) => {
        state.modelViewerPath = path
      }),
    setModelViewerSearchQuery: (query) =>
      set((state) => {
        state.modelViewerSearchQuery = query
      }),
    toggleModelViewerDomainId: (id) =>
      set((state) => {
        const i = state.modelViewerDomainIds.indexOf(id)
        if (i >= 0) state.modelViewerDomainIds.splice(i, 1)
        else state.modelViewerDomainIds.push(id)
      }),
    clearModelViewerDomainIds: () =>
      set((state) => {
        state.modelViewerDomainIds = []
      }),
    setModelViewerOptions: (patch) =>
      set((state) => {
        Object.assign(state.modelViewerOptions, patch)
      }),
    setModelViewerMode: (mode) =>
      set((state) => {
        state.modelViewerMode = mode
      }),

    expandInline: (diagramId, objectId, targetDiagramId) =>
      set((state) => {
        // Switching diagrams invalidates every expansion, so adopt the new
        // owner and start clean rather than carrying stale entries over.
        if (state.inlineExpansionsDiagramId !== diagramId) {
          state.inlineExpansionsDiagramId = diagramId
          state.inlineExpansions = {}
        }
        state.inlineExpansions[objectId] = targetDiagramId
      }),

    collapseInline: (objectId, nested = []) =>
      set((state) => {
        delete state.inlineExpansions[objectId]
        for (const id of nested) delete state.inlineExpansions[id]
      }),

    dropInlineExpansions: (objectIds) =>
      set((state) => {
        for (const id of objectIds) delete state.inlineExpansions[id]
      }),

    setZoomedFromObjectId: (id) =>
      set((state) => {
        state.zoomedFromObjectId = id
      }),

    setPendingCanvasFocus: (focus) =>
      set((state) => {
        state.pendingCanvasFocus = focus
      }),

    setPreviousDiagramId: (id) =>
      set((state) => {
        state.previousDiagramId = id
      }),

    setIsTransitioning: (value) =>
      set((state) => {
        state.isTransitioning = value
      }),

    setTransitionDirection: (dir) =>
      set((state) => {
        state.transitionDirection = dir
      }),

    setSelectedADRId: (id) =>
      set((state) => {
        state.selectedADRId = id
      }),

    setADRSearchQuery: (query) =>
      set((state) => {
        state.adrSearchQuery = query
      }),
  }))
)
