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

import { useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/shallow'
import { ZoomIn, ZoomOut, Maximize, Grid2x2, RotateCw, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CanvasEngine } from '../../canvas/engine/CanvasEngine'
import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import { getModelQuery } from '../../lib/modelQuery'
import { seedObjectForEdit } from '../../lib/automerge/bridge'
import { reloadWorkspace } from '../../lib/automerge/switchWorkspace'
import { useUIStore } from '../../stores/uiStore'
import { useSkinStore } from '../../stores/skinStore'
import { useThemeStore } from '../../stores/themeStore'
import { useAutomergeStatus } from '../../stores/automergeStatusStore'
import { takeInitialViewMode } from '../../lib/deepLinkView'
import { ExpandMenu } from './ExpandMenu'
import { Canvas3DView } from './Canvas3DView'
import { CanvasEmptyState } from './CanvasEmptyState'
import { CanvasToolbar } from '../comments/CanvasToolbar'
import { useDiagramReadyFit } from './useDiagramReadyFit'
import {
  expandDiagramsInline,
  GestureCutsLatch,
  modelCommentsToView,
  shiftPoint,
  unshiftBox,
  unshiftPoint,
  viewPlacementsToModel,
  viewWaypointsToModel,
  type MakeRoomCut,
} from '../../lib/diagrams/expandInline'
import { loadDiagramLayouts } from '../../lib/diagrams/duplicateSource'
import { collectRelatedDiagramObjectIds } from '../../canvas/relatedDiagramAffordances'
import { resolveParentNavigation } from '../../lib/diagrams/parentNavigation'
import { editorCanvasInsets, fitActiveCanvas, zoomActiveCanvas } from './canvasViewportControls'
import { usesMultiSelectMenu } from './contextMenuTarget'
import { DeleteCommandRows } from './DeleteCommandRows'
import { InlineTextEditor } from './InlineTextEditor'
import { resolveInlineEditSubject, type InlineEditSubject } from './groupInlineTextEdit'
import {
  captureGroupStyle,
  captureObjectStyle,
  isParentWrapper,
  planCopyWrites,
} from './copyStyle'
import type { CanvasViewportInsets, ObjectTextBand } from '../../canvas/engine/CanvasEngine'
import { publishDiagramCursor } from '../../lib/presence/diagramPresence'
import { RemoteCursorOverlay } from '../presence/RemoteCursorOverlay'

import { CommentDetail } from '../comments/CommentDetail'
import { CommentComposer } from '../comments/CommentComposer'
import type { C4Object, C4Type, Comment, Connection, Diagram, Group, SelectedItem } from '../../types'
import type { Scene3D } from '../../canvas3d'

// Filters objects/connections/groups down to the given diagram's composition and
// applies its `layouts` overrides (per-diagram position/size). Used by BOTH the
// engine-creation effect and the data-sync effect below — they must never diverge:
// if one path skipped the `layouts` merge and happened to make the last `setData`
// call (e.g. when `automergeReady` flips after the diagram's data settled), the
// canvas would show raw un-merged positions.
function filterAndMergeDiagramData(
  diagram: Diagram | undefined,
  objects: C4Object[],
  connections: Connection[],
  groups: Group[]
) {
  const diagramObjectIds = new Set(diagram?.objectIds ?? [])
  const diagramConnectionIds = new Set(diagram?.connectionIds ?? [])
  const diagramGroupIds = new Set(diagram?.groupIds ?? [])
  const filteredObjects = objects
    .filter((o) => diagramObjectIds.has(o.id))
    .map((o) => {
      const layout = diagram?.layouts?.[o.id]
      return layout ? { ...o, position: layout.position, size: layout.size } : o
    })
  const filteredConnections = connections.filter((c) => diagramConnectionIds.has(c.id))
  const filteredGroups = groups
    .filter((g) => diagramGroupIds.has(g.id))
    .map((g) => {
      const layout = diagram?.layouts?.[g.id]
      return layout ? { ...g, position: layout.position, size: layout.size } : g
    })
  return { filteredObjects, filteredConnections, filteredGroups }
}

/** A diagram's first fit: centre on the entity an "open in diagram" link asked
 *  for, else zoom-to-fit. The request is NOT consumed here — the DiagramDoc
 *  re-fit (useDiagramReadyFit) runs this again and must land on the same
 *  entity; CanvasView drops it once the user leaves that diagram. */
function fitOrFocusPending(engine: CanvasEngine, diagramId: string, insets: CanvasViewportInsets) {
  const focus = useUIStore.getState().pendingCanvasFocus
  if (focus && focus.diagramId === diagramId) {
    const focused = focus.kind === 'connection'
      ? engine.focusOnConnection(focus.id)
      : engine.focusOnObject(focus.id)
    if (focused) return
  }
  engine.zoomToFit(insets)
}

/** The zoom readout, the only part of the canvas chrome that changes per wheel tick. */
function ZoomPercent() {
  const zoom = useUIStore((s) => s.zoom)
  return <>{`${Math.round(zoom * 100)}%`}</>
}

export function CanvasView() {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<CanvasEngine | null>(null)
  // The engine's callbacks are captured once at construction; route the back
  // glyph through a ref so it always calls the current closure.
  const navigateToParentRef = useRef<(() => void) | null>(null)
  const scene3dRef = useRef<Scene3D | null>(null)
  const prevDiagramIdRef = useRef<string | null>(null)
  const fitFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const visualReady = useAutomergeStatus((s) => s.visualReady)
  const bridgeStatus = useAutomergeStatus((s) => s.status)
  const bridgeError = useAutomergeStatus((s) => s.error)
  /**
   * The boot ENDED, and it ended badly.
   *
   * A dead boot calls neither `markVisualReady()` nor `markEditReady()`, so
   * `!visualReady` alone has NO terminating condition: the loader would spin
   * forever, with the only trace a bottom-bar badge that is `sr-only` in
   * compact mode.
   *
   * `!visualReady` stays in the conjunction on purpose: a LATER error — a
   * socket drop mid-session — must never blank an editor that is already
   * painting. This is a boot state, not an error banner.
   */
  const bootFailed = bridgeStatus === 'error' && !visualReady
  const isLoading = !visualReady && !bootFailed

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    objectId: string | null
    groupId: string | null
    connectionId: string | null
    selectedItems: SelectedItem[]
  } | null>(null)
  const [inlineEdit, setInlineEdit] = useState<{
    connectionId: string
    x: number
    y: number
    width: number
    height: number
    scale: number
  } | null>(null)
  /** Inline title/description editor. Holds only WHICH run is open — the draft
   *  text lives inside the editor so a keystroke never touches the store. */
  const [textEdit, setTextEdit] = useState<
    { kind: 'object' | 'group'; id: string; band: ObjectTextBand } | null
  >(null)
  const [expandMenu, setExpandMenu] = useState<{
    object: C4Object
    x: number
    y: number
  } | null>(null)
  const [draftCommentPos, setDraftCommentPos] = useState<{ x: number; y: number } | null>(null)
  // Screen position of the open comment's detail box. Set in the pan effect
  // (after the viewport moves) so the box lands at the pin on first open, and
  // updated when the user drags the box header.
  const [commentBoxPos, setCommentBoxPos] = useState<{ x: number; y: number } | null>(null)

  // Narrow to the active diagram via the DiagramIndex — O(diagram size), not
  // O(whole model). An `s.objects.filter(...)` would scan every object/connection
  // (25k+) on EVERY store update, freezing the canvas at scale. Never fall back to
  // the full model when there's no active diagram: returning the whole 25k model to
  // the engine would freeze it — an empty canvas is correct (nothing to show).
  // useShallow gives array-content equality.
  const objects = useModelStore(
    useShallow((s) => {
      const d = s.diagrams.find((d) => d.id === s.currentDiagramId)
      if (!d) return [] as C4Object[]
      const idx = getDiagramIndex()
      return d.objectIds.map((id) => idx.objectById.get(id)).filter((o): o is C4Object => !!o)
    })
  )
  const connections = useModelStore(
    useShallow((s) => {
      const d = s.diagrams.find((d) => d.id === s.currentDiagramId)
      if (!d) return [] as Connection[]
      const idx = getDiagramIndex()
      return d.connectionIds.map((id) => idx.connectionById.get(id)).filter((c): c is Connection => !!c)
    })
  )
  const groups = useModelStore(
    useShallow((s) => {
      const d = s.diagrams.find((d) => d.id === s.currentDiagramId)
      if (!d) return [] as Group[]
      const idx = getDiagramIndex()
      return d.groupIds.map((id) => idx.groupById.get(id)).filter((g): g is Group => !!g)
    })
  )
  const diagrams = useModelStore((s) => s.diagrams)
  // Dedicated, narrowly-scoped subscription to JUST the active diagram's layout
  // overrides (position/size per entity) — belt-and-suspenders alongside the
  // `diagrams` dependency below. On a fresh page load straight into a diagram
  // URL, the active diagram's full doc (which carries `layouts`) can finish
  // attaching/projecting slightly after the first paint; when that happens the
  // data-sync effect's `diagrams`-array dependency has occasionally NOT re-run
  // the merge afterward (positions render from the stale `object.position`
  // instead of the diagram-specific override, and stay stuck that way until
  // the user switches diagrams away and back). Subscribing to the layouts
  // object directly guarantees the effect re-fires the moment it's populated.
  const activeDiagramLayouts = useModelStore(
    (s) => s.diagrams.find((d) => d.id === s.currentDiagramId)?.layouts
  )
  const flows = useModelStore((s) => s.flows)
  const tags = useModelStore((s) => s.tags)
  const selectedItems = useModelStore((s) => s.selectedItems)
  const selectObjects = useModelStore((s) => s.selectObjects)
  const selectConnection = useModelStore((s) => s.selectConnection)
  const selectGroup = useModelStore((s) => s.selectGroup)
  const toggleSelectItem = useModelStore((s) => s.toggleSelectItem)
  const clearSelection = useModelStore((s) => s.clearSelection)
  const updatePlacementsBatch = useModelStore((s) => s.updatePlacementsBatch)
  const addConnection = useModelStore((s) => s.addConnection)
  const updateConnection = useModelStore((s) => s.updateConnection)
  const addObjectToGroup = useModelStore((s) => s.addObjectToGroup)
  const removeObjectFromGroup = useModelStore((s) => s.removeObjectFromGroup)
  const deleteObject = useModelStore((s) => s.deleteObject)
  const deleteGroup = useModelStore((s) => s.deleteGroup)
  const deleteConnection = useModelStore((s) => s.deleteConnection)
  const deleteSelectedItems = useModelStore((s) => s.deleteSelectedItems)
  const removeObjectFromDiagram = useModelStore((s) => s.removeObjectFromDiagram)
  const removeObjectsFromDiagram = useModelStore((s) => s.removeObjectsFromDiagram)
  const removeConnectionFromDiagram = useModelStore((s) => s.removeConnectionFromDiagram)
  const removeGroupFromDiagram = useModelStore((s) => s.removeGroupFromDiagram)
  const updateComment = useModelStore((s) => s.updateComment)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const canvasObjectIdsKey = JSON.stringify(objects.map((object) => object.id))
  const setCurrentDiagram = useModelStore((s) => s.setCurrentDiagram)
  // A deep-link / stale link (e.g. a diagram that was deleted, or a URL from an older/reseeded
  // workspace) can point at a diagram id that no longer exists. Show a clear "not found" state
  // instead of a silently blank canvas. Gated on the registry being loaded so it can't flash during
  // boot, and only for a NON-EXISTENT id — a real, empty diagram still shows an (editable) blank.
  const diagramNotFound = diagrams.length > 0 && !!currentDiagramId && !diagrams.some((d) => d.id === currentDiagramId)
  const addDiagram = useModelStore((s) => s.addDiagram)

  const allGroups = useModelStore((s) => s.groups)

  const showGrid = useUIStore((s) => s.showGrid)
  const setZoom = useUIStore((s) => s.setZoom)
  const fitRequestId = useUIStore((s) => s.fitRequestId)
  const canvasViewMode = useUIStore((s) => s.canvasViewMode)
  const restoreCanvasViewFor = useUIStore((s) => s.restoreCanvasViewFor)
  const setCanvasViewMode = useUIStore((s) => s.setCanvasViewMode)
  // 2D↔3D morph state: the 3D overlay stays mounted through its exit
  // choreography, and the 2D canvas hides only while fully covered by it.
  // Render-phase adjustments (the React derived-state pattern), not effects.
  const [mounted3d, setMounted3d] = useState(canvasViewMode === '3d')
  const [covered3d, setCovered3d] = useState(false)
  if (canvasViewMode === '3d' && !mounted3d) setMounted3d(true)
  // A loading flip unmounts the overlay without its exit choreography — never
  // leave the 2D canvas hidden with nothing covering it.
  if (isLoading && covered3d) setCovered3d(false)
  const toolMode = useUIStore((s) => s.toolMode)
  const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen)
  const rightSidebarOpen = useUIStore((s) => s.rightSidebarOpen)
  const toggleGrid = useUIStore((s) => s.toggleGrid)
  const bottomTab = useUIStore((s) => s.bottomTab)
  const activeTagGroupId = useUIStore((s) => s.activeTagGroupId)
  const hoveredTagId = useUIStore((s) => s.hoveredTagId)
  const pinnedTagIds = useUIStore((s) => s.pinnedTagIds)
  const focusedTagId = useUIStore((s) => s.focusedTagId)
  const hiddenTagIds = useUIStore((s) => s.hiddenTagIds)
  const technologyPerspective = useUIStore((s) => s.managedPerspectiveInteractions.technology)
  const statusPerspective = useUIStore((s) => s.managedPerspectiveInteractions.status)
  const teamsPerspective = useUIStore((s) => s.managedPerspectiveInteractions.teams)
  const previousDiagramId = useUIStore((s) => s.previousDiagramId)
  const setPreviousDiagramId = useUIStore((s) => s.setPreviousDiagramId)
  const setZoomedFromObjectId = useUIStore((s) => s.setZoomedFromObjectId)
  const currentDiagram = useModelStore((s) => s.getCurrentDiagram())
  // Read-only when the DIAGRAM is marked readonly OR the whole workspace is
  // (View-grant session at AUTH stage 'on' — the server drops writes anyway;
  // this keeps the UI honest about it).
  const workspaceReadOnly = useModelStore((s) => s.workspaceReadOnly)
  const editReady = useAutomergeStatus((s) => s.editReady)
  const isReadonly = (currentDiagram?.readonly ?? false) || workspaceReadOnly || !editReady
  // Where the wrapper group's top-left back glyph goes. Derived from the model,
  // so it survives a reload and a deep link — gated on session history alone it
  // was drawn only right after a live drill-down.
  const parentNavigation = useMemo(
    () => {
      const idx = getDiagramIndex()
      return resolveParentNavigation({
        currentDiagram,
        diagramById: idx.diagramById,
        objectToDiagramIds: idx.objectToDiagramIds,
        previousDiagramId,
      })
    },
    // `diagrams` is the invalidation TRIGGER, not an input: the index
    // subscriber (registered at module load, so it runs before any component)
    // rebuilds diagramById from it. Dropping it, as the rule suggests, would
    // freeze this memo on a stale index — the same contract the render-body
    // getDiagramIndex() calls above already rely on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentDiagram, diagrams, previousDiagramId],
  )
  const connectionHighlightStyle = currentDiagram?.connectionHighlightStyle ?? 'traveling-dot'
  const connectionAnimationsEnabled = currentDiagram?.connectionAnimationsEnabled ?? true
  const comments = useModelStore((s) => s.comments)
  const diagramComments = comments.filter((c) => c.diagramId === currentDiagramId)
  const currentFlowId = useUIStore((s) => s.currentFlowId)
  const currentFlowStepIndex = useUIStore((s) => s.currentFlowStepIndex)
  const flowEditMode = useUIStore((s) => s.flowEditMode)
  // Subscribe to the app theme so the canvas re-resolves its skin variant (and
  // re-renders) the moment the user flips light/dark.
  const appTheme = useThemeStore((s) => s.resolved)
  const resolvedSkin = useSkinStore((s) => s.getResolvedSkin(currentDiagram?.skinId, appTheme))
  const nextFlowStep = useUIStore((s) => s.nextFlowStep)
  const prevFlowStep = useUIStore((s) => s.prevFlowStep)
  const setFlowStepIndex = useUIStore((s) => s.setFlowStepIndex)
  const setFlowEditMode = useUIStore((s) => s.setFlowEditMode)
  const commentMode = useUIStore((s) => s.commentMode)
  const toggleCommentMode = useUIStore((s) => s.toggleCommentMode)

  const viewportInsets = editorCanvasInsets(leftSidebarOpen, rightSidebarOpen)
  // The side panels overlay the canvas, so their open state only changes the
  // insets a FIT uses. Effects read them through this ref: depending on the two
  // flags made every panel toggle destroy and recreate the engine and re-fit the
  // view (the visibility observer re-subscribed and fired), throwing away the
  // user's zoom and pan.
  const viewportInsetsRef = useRef(viewportInsets)
  useLayoutEffect(() => {
    viewportInsetsRef.current = viewportInsets
  })
  const handleZoomIn = () => zoomActiveCanvas(canvasViewMode, 'in', engineRef.current, scene3dRef.current, setZoom)
  const handleZoomOut = () => zoomActiveCanvas(canvasViewMode, 'out', engineRef.current, scene3dRef.current, setZoom)
  const handleFitCanvas = () => fitActiveCanvas(
    canvasViewMode,
    engineRef.current,
    scene3dRef.current,
    viewportInsets,
    setZoom,
  )
  const openCommentId = useUIStore((s) => s.openCommentId)
  const setOpenCommentId = useUIStore((s) => s.setOpenCommentId)
  const addComment = useModelStore((s) => s.addComment)

  /**
   * The make-room steps of the inline expansions currently drawn (rule 5 in
   * `expandInline.ts`). The engine draws this diagram's own shapes, waypoints
   * and comment pins DISPLACED by them; everything it reports back is in those
   * view coordinates, and goes through `unshiftPoint` before it is written.
   * Empty with nothing expanded, which makes both maps the identity.
   */
  const viewCutsRef = useRef<MakeRoomCut[]>([])
  /** The cuts a drag or resize STARTED under, if the view was re-planned
   *  during it (see `GestureCutsLatch`). */
  const gestureCutsRef = useRef(new GestureCutsLatch())
  /** View point -> model point, through the cuts drawn right now. */
  const toModel = useCallback((point: { x: number; y: number }) => unshiftPoint(viewCutsRef.current, point), [])
  /**
   * What an inline expansion PULLED IN (shapes, its wrappers, edges): drawn
   * here, but not this diagram's to place. An edit of one is dropped rather
   * than written through this diagram's frame — in resident mode the store
   * holds those objects too, and the write would land.
   */
  const viewOnlyIdsRef = useRef<Set<string>>(new Set())
  const pushedCommentsEngineRef = useRef<unknown>(null)
  const pushComments = useCallback((comments: readonly Comment[], diagramId: string | null) => {
    pushedCommentsEngineRef.current = engineRef.current
    engineRef.current?.setComments(modelCommentsToView(
      viewCutsRef.current,
      comments.filter((comment) => comment.diagramId === diagramId),
    ))
  }, [])

  const handlePresencePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (canvasViewMode === '3d') {
      const point = scene3dRef.current?.presencePointAt(event.clientX, event.clientY)
      if (point) publishDiagramCursor({ ...point, view: '3d', visible: true })
      return
    }
    const canvas = canvasRef.current
    const engine = engineRef.current
    if (!canvas || !engine) return
    const rect = canvas.getBoundingClientRect()
    // Published in the MODEL frame: a peer has its own expansions, or none.
    const point = toModel(engine.screenToWorld(event.clientX - rect.left, event.clientY - rect.top))
    publishDiagramCursor({ x: point.x, y: point.y, view: '2d', visible: true })
  }, [canvasViewMode, toModel])

  const projectPresenceCursor = useCallback((cursor: { x: number; y: number }) => {
    if (canvasViewMode === '3d') return scene3dRef.current?.projectPresencePoint(cursor.x, cursor.y) ?? null
    const canvas = canvasRef.current
    const engine = engineRef.current
    if (!canvas || !engine) return null
    const drawn = shiftPoint(viewCutsRef.current, cursor)
    const point = engine.worldToScreen(drawn.x, drawn.y)
    return {
      x: point.x,
      y: point.y,
      visible: point.x >= -160 && point.y >= -80 && point.x <= canvas.clientWidth + 160 && point.y <= canvas.clientHeight + 80,
    }
  }, [canvasViewMode])

  // The server projection drives loading directly; DiagramDoc readiness remains
  // a separate write gate.
  useEffect(() => {
    if (editReady) useModelStore.getState().reconcileTags()
  }, [editReady])

  // Pushes the current diagram's filtered + layout-merged data into the engine, and
  // zoom-fits the viewport the first time this diagram is shown. Shared by the
  // engine-creation effect (below) and the data-sync effect (further down) — both
  // call this SAME function rather than each doing their own partial version of it:
  // with two copies, whichever effect called `engine.setData()` LAST silently wins,
  // so a copy missing the `diagram.layouts` merge renders moved shapes at their
  // pre-move position after a reload, and a copy missing the fit defers the first
  // zoom-to-fit (a render-side effect-ordering race, not a data bug).
  const syncEngineFromStore = useCallback(() => {
    const engine = engineRef.current
    if (!engine) return
    const store = useModelStore.getState()
    const diagram = store.getCurrentDiagram()
    const merged = filterAndMergeDiagramData(
      diagram,
      store.objects,
      store.connections,
      store.groups
    )
    // Shapes expanded in place: the linked diagram's contents are folded in on
    // the way to the ENGINE and never written to the model. See `expandInline`.
    const ui = useUIStore.getState()
    const index = getDiagramIndex()
    const expanded =
      expandDiagramsInline(
        {
          objects: merged.filteredObjects,
          connections: merged.filteredConnections,
          groups: merged.filteredGroups,
        },
        store.currentDiagramId,
        ui.inlineExpansionsDiagramId === store.currentDiagramId
          ? Object.entries(ui.inlineExpansions).map(([objectId, diagramId]) => ({ objectId, diagramId }))
          : [],
        {
          diagram: (id) => index.diagramById.get(id),
          // NOT the diagram index: the store is WINDOWED to the active diagram,
          // so another diagram's shapes are not in memory at all. They are
          // fetched through the ModelQuery seam into .
          object: (id) => expandedContentsRef.current.objects.get(id) ?? index.objectById.get(id),
          connection: (id) => expandedContentsRef.current.connections.get(id) ?? index.connectionById.get(id),
          // Nor the target's placement: `diagramById` holds a layout-less stub
          // for every diagram but the active one. Read from its document;
          // `undefined` until that read lands, so the expansion waits for it.
          layouts: (id) => expandedContentsRef.current.layouts.get(id),
          // Measured by the engine that will draw it, so the room made is exact.
          wrapperMinWidth: (wrapper) => engine.inlineWrapperMinWidth(wrapper),
        },
      )
    const cutsChanged = JSON.stringify(expanded.cuts) !== JSON.stringify(viewCutsRef.current)
    gestureCutsRef.current.replanned(viewCutsRef.current, engine.activePlacementGesture())
    viewCutsRef.current = expanded.cuts
    const ownIds = new Set<string>([
      ...merged.filteredObjects.map((o) => o.id),
      ...merged.filteredConnections.map((c) => c.id),
      ...merged.filteredGroups.map((g) => g.id),
    ])
    viewOnlyIdsRef.current = new Set(
      [...expanded.objects, ...expanded.connections, ...expanded.groups]
        .map((item) => item.id)
        .filter((id) => !ownIds.has(id)),
    )
    // The pins move with everything else past a cut; their own effect only
    // runs when the comments change. A recreated engine has none at all.
    if (cutsChanged || pushedCommentsEngineRef.current !== engine) {
      pushComments(store.comments, store.currentDiagramId)
    }
    const { objects: filteredObjects, connections: filteredConnections, groups: filteredGroups } = expanded
    const relatedDiagramObjectIds = collectRelatedDiagramObjectIds(
      filteredObjects,
      store.diagrams,
      store.currentDiagramId,
      getDiagramIndex().objectToDiagramIds,
    )
    engine.setData(
      filteredObjects,
      filteredConnections,
      filteredGroups,
      store.flows,
      store.tags,
      relatedDiagramObjectIds,
    )

    // Zoom-to-fit AFTER the new diagram's data (with layouts) is in the engine — once per diagram,
    // and ONLY once the projection is COMPLETE (every one of the diagram's objects is present).
    // Under boot-from-server a diagram switch is async: for one render the windowed store still
    // holds the PREVIOUS diagram's objects filtered by the NEW diagram's ids — a stale/partial set
    // that lands a frame before the real projection. Fitting on that set fit the canvas to the
    // wrong bounds, and the `prevDiagramIdRef` guard then blocked the real fit, so the new diagram
    // rendered scrolled off-screen until a reload. Gate on the full object count so the fit waits
    // for the complete projection. (In the resident/default mode the full set is always present, so
    // this is satisfied immediately — no behavior change there.)
    const diagramId = store.currentDiagramId
    const expectedCount = diagram?.objectIds.length ?? 0
    if (diagramId && prevDiagramIdRef.current !== diagramId && filteredObjects.length > 0) {
      const fit = () => {
        prevDiagramIdRef.current = diagramId
        if (fitFallbackRef.current) { clearTimeout(fitFallbackRef.current); fitFallbackRef.current = null }
        requestAnimationFrame(() => {
          fitOrFocusPending(engine, diagramId, viewportInsetsRef.current)
          setZoom(engine.getZoom())
        })
      }
      if (filteredObjects.length >= expectedCount) {
        // Projection complete — every one of the diagram's objects is present. Fit immediately.
        fit()
      } else {
        // Short of the registry count: usually the stale partial transient (the real projection lands
        // a frame later and re-runs this effect at the full count → fit() above). But a diagram whose
        // objectIds reference a now-DELETED object (a dangling registry ref left after deleting a
        // diagram member) can NEVER reach expectedCount — without this it would render scrolled
        // off-screen forever (fit never fires). Re-arm a settle timer on each render; once the
        // projection stops growing it fires and fits whatever rendered.
        // Re-arm on each render: the timer fires only once NO render has happened for 400ms (the
        // projection settled). A LATER complete projection re-runs this effect and either fit()s
        // (clearing the timer) or re-arms it, so the timer firing means the projection settled short.
        if (fitFallbackRef.current) clearTimeout(fitFallbackRef.current)
        fitFallbackRef.current = setTimeout(() => {
          fitFallbackRef.current = null
          const e = engineRef.current
          if (e && useModelStore.getState().currentDiagramId === diagramId && prevDiagramIdRef.current !== diagramId) {
            prevDiagramIdRef.current = diagramId
            fitOrFocusPending(e, diagramId, viewportInsetsRef.current)
            setZoom(e.getZoom())
          }
        }, 400)
      }
    }
  }, [setZoom, pushComments])

  useDiagramReadyFit(editReady, currentDiagramId, useCallback(() => {
    // The temporary server render may already have consumed the regular
    // per-diagram guard with pre-DiagramDoc coordinates. Re-arm it once the
    // draft document and its authoritative layouts are attached.
    prevDiagramIdRef.current = null
    syncEngineFromStore()
  }, [syncEngineFromStore]))

  // A pending "centre on this entity" request belongs to ONE diagram: drop it
  // when the canvas shows another, so returning later fits normally.
  // When it targets the diagram ALREADY fitted, no further fit will run to
  // consume it, so centre now.
  const pendingCanvasFocus = useUIStore((s) => s.pendingCanvasFocus)
  useEffect(() => {
    if (!pendingCanvasFocus) return
    if (pendingCanvasFocus.diagramId !== currentDiagramId) {
      useUIStore.getState().setPendingCanvasFocus(null)
      return
    }
    const engine = engineRef.current
    if (engine && prevDiagramIdRef.current === currentDiagramId) {
      fitOrFocusPending(engine, pendingCanvasFocus.diagramId, viewportInsetsRef.current)
      setZoom(engine.getZoom())
    }
  }, [pendingCanvasFocus, currentDiagramId, setZoom])

  // Restore the remembered 2D/3D view (per-user, per-diagram) when entering a
  // diagram — unless a `?view=` deep link is present on boot, which wins for the
  // first diagram opened and is persisted (see lib/deepLinkView).
  useEffect(() => {
    const id = useModelStore.getState().currentDiagramId
    if (!id) return
    const deep = takeInitialViewMode()
    if (deep) setCanvasViewMode(deep, id)
    else restoreCanvasViewFor(id)
  }, [currentDiagram?.id, restoreCanvasViewFor, setCanvasViewMode])

  // Initialize engine
  useEffect(() => {
    if (isLoading) return
    const canvas = canvasRef.current
    if (!canvas) return

    const engine = new CanvasEngine(canvas, {
      onObjectSelect: (id, multi) => {
        if (id === null) {
          clearSelection()
        } else if (multi) {
          toggleSelectItem({ id, type: 'object' })
        } else {
          const current = useModelStore.getState().selectedItems
          const alreadySelected = current.some((s) => s.type === 'object' && s.id === id)
          if (alreadySelected && current.filter((s) => s.type === 'object').length > 1) {
            // Keep multi-selection when clicking on an already-selected object
            // (allows dragging multiple selected objects)
          } else {
            selectObjects([id])
          }
        }
        engineRef.current?.setSelectedItems(useModelStore.getState().selectedItems)
      },
      onPlacementsCommit: ({ objects: objectUpdates, groups: groupUpdates }) => {
        const engine = engineRef.current
        const store = useModelStore.getState()
        const touchedIds = new Set([
          ...objectUpdates.map(({ id }) => id),
          ...groupUpdates.map(({ id }) => id),
        ])
        const connectionUpdates = engine
          ? store.connections.flatMap((connection) => {
              if (!connection.lockedToAnchors) return []
              if (!touchedIds.has(connection.fromId) && !touchedIds.has(connection.toId)) return []
              if (connection.fromAnchor !== undefined && connection.toAnchor !== undefined) return []
              const anchors = engine.computeConnectionAnchors(connection.id)
              if (!anchors) return []
              const data: Partial<Connection> = {}
              if (connection.fromAnchor === undefined && anchors.fromAnchor !== undefined) {
                data.fromAnchor = anchors.fromAnchor
              }
              if (connection.toAnchor === undefined && anchors.toAnchor !== undefined) {
                data.toAnchor = anchors.toAnchor
              }
              return Object.keys(data).length > 0 ? [{ id: connection.id, data }] : []
            })
          : []
        // The engine reports where it DRAWS them; with an expansion open that is
        // displaced from the model (`viewCutsRef`). Never write the displacement.
        const viewOnly = viewOnlyIdsRef.current
        const modelPlacements = viewPlacementsToModel(
          gestureCutsRef.current.forCommit(viewCutsRef.current, engineRef.current?.activePlacementGesture() ?? null),
          viewOnly,
          { objects: objectUpdates, groups: groupUpdates },
        )
        updatePlacementsBatch({
          ...modelPlacements,
          connections: connectionUpdates.filter((update) => !viewOnly.has(update.id)),
        })
      },
      onObjectDoubleClick: (id, band) => {
        // A miss on both runs still opens the title: the gesture should always
        // do something, and the title is the field a double-click most often
        // means. It also covers the low-zoom LOD, which paints no text to aim
        // at (the first click selects the shape, restoring the full renderer).
        setTextEdit({ kind: 'object', id, band: band ?? 'title' })
      },
      // No `?? 'title'` fallback here, unlike shapes: the engine only calls this
      // when the double-click landed ON a group's painted text, because the rest
      // of a group's box belongs to its members.
      onGroupDoubleClick: (id, band) => {
        setTextEdit({ kind: 'group', id, band })
      },
      onConnectionDoubleClick: (id, offsetX, offsetY) => {
        const engine = engineRef.current
        if (!engine) return
        const bounds = engine.getConnectionLabelBounds(id)
        if (bounds) {
          const screen = engine.worldToScreen(bounds.x, bounds.y)
          setInlineEdit({
            connectionId: id,
            x: screen.x,
            y: screen.y,
            width: bounds.width * engine.getZoom(),
            height: bounds.height * engine.getZoom(),
            scale: engine.getZoom(),
          })
        } else {
          // No label yet — position at click location with default size
          setInlineEdit({
            connectionId: id,
            x: offsetX,
            y: offsetY - 9,
            width: 80,
            height: 18,
            scale: engine.getZoom(),
          })
        }
      },
      onConnectionSelect: (id) => {
        if (id === null) {
          clearSelection()
        } else {
          selectConnection(id)
        }
        engineRef.current?.setSelectedItems(useModelStore.getState().selectedItems)
      },
      onConnectionStart: (fromId, fromType, fromAnchor) => {
        console.log('Connection start', fromId, fromType, fromAnchor)
      },
      onConnectionEnd: (toId, _toType, toAnchor) => {
        const engine = engineRef.current
        const fromId = engine?.['connectionFrom']
        const fromAnchor = engine?.['connectionFromAnchor']
        if (fromId && fromId !== toId) {
          // Lock to anchors only when both source and target anchors were explicitly chosen
          const lockedToAnchors = fromAnchor != null && toAnchor != null
          addConnection({
            fromId,
            toId,
            type: 'solid',
            fromAnchor: fromAnchor ?? undefined,
            toAnchor: toAnchor ?? undefined,
            lockedToAnchors,
          })
        }
      },
      onConnectionAnchorMove: (connId, end, targetId, anchorIndex) => {
        // A wrapper or a shape pulled in by an inline expansion exists only in
        // this view: an endpoint written onto one would dangle in the model.
        const viewOnly = viewOnlyIdsRef.current
        if (viewOnly.has(connId) || viewOnly.has(targetId)) return
        if (end === 'source') {
          updateConnection(connId, {
            fromId: targetId,
            fromAnchor: anchorIndex,
            lockedToAnchors: true,
          })
        } else {
          updateConnection(connId, {
            toId: targetId,
            toAnchor: anchorIndex,
            lockedToAnchors: true,
          })
        }
      },
      onConnectionLabelMove: (connId, position, offset) => {
        updateConnection(connId, { labelPosition: position, labelOffset: offset })
      },
      onConnectionWaypointsChange: (connId, waypoints) => {
        // A waypoint drag keeps its points in the frame it started in, like a
        // shape drag (`GestureCutsLatch`).
        const cuts = gestureCutsRef.current.forCommit(viewCutsRef.current, engineRef.current?.activePlacementGesture() ?? null)
        const modelWaypoints = viewWaypointsToModel(cuts, viewOnlyIdsRef.current, connId, waypoints)
        if (!modelWaypoints) return
        updateConnection(connId, { waypoints: modelWaypoints.length > 0 ? modelWaypoints : undefined })
      },
      onGroupSelect: (id) => {
        if (id === null) {
          clearSelection()
        } else {
          selectGroup(id)
        }
        engineRef.current?.setSelectedItems(useModelStore.getState().selectedItems)
      },
      // Applies to every target the click resolved to — one shape, or the whole
      // selection when the click landed inside a multi-selection.
      //
      // Returns whether ANY paste landed. `false` (nothing written) leaves the
      // engine armed, so a wholly refused click — a parent wrapper, whose paint
      // and geometry are both engine-owned — reads as "not a valid target"
      // instead of as a command that silently did nothing. A partial success
      // still counts as applied: one unstyleable shape caught in a selection
      // must not veto the rest.
      onCopyApply: (targets, mode, data) => {
        const store = useModelStore.getState()
        const writes = planCopyWrites(targets, mode, data, {
          group: (id) => store.groups.find((g) => g.id === id),
          // By id, NOT by handing the store's group to `getGroupBounds` — the
          // store's copy has create-time geometry, the engine's has the
          // diagram's layout merged in.
          // In the MODEL frame: the engine's box is displaced past a cut.
          groupBounds: (id) => {
            const bounds = engineRef.current?.getGroupBoundsById(id)
            return bounds ? unshiftBox(viewCutsRef.current, bounds) : null
          },
          objectExists: (id) => store.objects.some((o) => o.id === id),
        })
        if (writes.length === 0) return false
        // ONE transaction for the whole selection: a write per target means a
        // store notification per target, and each one re-runs the Automerge
        // bridge's whole-model `detectEdits()` sweep.
        store.updateEntitiesBatch({
          objects: writes.filter((w) => w.type === 'object').map((w) => ({ id: w.id, data: w.update })),
          groups: writes.filter((w) => w.type === 'group').map((w) => ({ id: w.id, data: w.update })),
        })
        return true
      },
      onZoom: (newZoom) => {
        setZoom(newZoom)
      },
      onCommentClick: (commentId) => {
        setOpenCommentId(commentId)
      },
      onCommentMove: (commentId, x, y) => {
        updateComment(commentId, { position: unshiftPoint(viewCutsRef.current, { x, y }) })
      },
      onContextMenu: (screenX, screenY, objectId, groupId, connectionId, selectedItems) => {
        setContextMenu({ x: screenX, y: screenY, objectId, groupId, connectionId: connectionId ?? null, selectedItems })
      },
      onExpandClick: (objectId, menuX, menuY) => {
        // A shape pulled in by an inline expansion is not in the windowed store
        // (that is why it was fetched), and it is expandable too — nesting.
        const obj = useModelStore.getState().objects.find((o) => o.id === objectId)
          ?? expandedContentsRef.current.objects.get(objectId)
        if (!obj) return
        setExpandMenu({ object: obj, x: menuX, y: menuY })
      },
      onGroupExpandClick: (objectId, menuX, menuY) => {
        // On an inline expansion the icon is the way back out — the host shape
        // is not in the diagram's objects while expanded, so opening the menu
        // here would find nothing and do nothing at all.
        const ui = useUIStore.getState()
        if (ui.inlineExpansions[objectId]) {
          ui.collapseInline(objectId)
          return
        }
        const obj = useModelStore.getState().objects.find((o) => o.id === objectId)
        if (!obj) return
        setExpandMenu({ object: obj, x: menuX, y: menuY })
      },
      onGroupNavigateUp: () => navigateToParentRef.current?.(),
      // The room made for an inline expansion was sized with the engine's
      // measurement at the time; re-plan when that measurement changes.
      onWrapperMetricsChanged: () => {
        if (Object.keys(useUIStore.getState().inlineExpansions).length > 0) syncEngineFromStore()
      },
    }, resolvedSkin)

    engineRef.current = engine
    engine.setResolvedTheme(useThemeStore.getState().resolved)
    // @ts-expect-error -- dev/debug-only global handle on window (used by E2E + console)
    window.__canvasEngine = engine

    // Seed readonly NOW from the live state. The dedicated setReadonly effect
    // below only pushes on a *value change*, so a freshly created engine (mount /
    // HMR / view switch / reload) would otherwise keep its default (editable)
    // even when the workspace is view-only — and whether that effect had already
    // fired depends on a boot race (workspace-access resolving before vs after
    // the engine is created), so the lock would be inconsistent across
    // reloads. Reading the store here makes engine creation authoritative.
    const store = useModelStore.getState()
    const diagram = store.getCurrentDiagram()
    engine.setReadonly(
      (diagram?.readonly ?? false)
      || store.workspaceReadOnly
      || !useAutomergeStatus.getState().editReady,
    )
    if (diagram) {
      // Apply the diagram's persisted connection-animation settings NOW. The
      // dedicated sync effects below only push on a *value change*, so a freshly
      // created engine (mount / HMR / view switch) would otherwise keep its
      // built-in defaults (traveling-dot, enabled) even when the diagram persists
      // a different style — e.g. a reloaded 'strands' diagram showed traveling-dot
      // until the user toggled it.
      engine.setConnectionHighlightStyle(diagram.connectionHighlightStyle ?? 'traveling-dot')
      engine.setConnectionAnimationsEnabled(diagram.connectionAnimationsEnabled ?? true)
    }
    // Seed data (+ fit-if-first-time-on-this-diagram) through the SAME path the
    // data-sync effect below uses — see syncEngineFromStore's comment for why
    // this must be shared rather than each effect doing its own partial version.
    syncEngineFromStore()
    // Same reason for the selection: the sync effect below only pushes on a
    // change, so a selection made BEFORE this engine existed (e.g. an "open in
    // diagram" link from the Model Objects page) would never be drawn.
    engine.setSelectedItems(store.selectedItems)
    // …and the current flow (an "open flow" link from the Details panel).
    const flowState = useUIStore.getState()
    engine.setFlowState(flowState.currentFlowId, flowState.currentFlowStepIndex)

    const resize = () => {
      const parent = canvas.parentElement
      if (parent) {
        engine.resize(parent.clientWidth, parent.clientHeight)
      }
    }
    resize()

    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement!)

    // Initial zoom-to-fit is handled by the data-sync effect once layouts are
    // applied (avoids fitting to stale/empty bounds).

    return () => {
      ro.disconnect()
      engine.destroy()
      engineRef.current = null
    }
  }, [isLoading, selectObjects, selectGroup, updatePlacementsBatch, addConnection, updateConnection, setZoom, syncEngineFromStore])

  // Sync lower connections whenever the current diagram changes
  useEffect(() => {
    if (currentDiagramId) {
      useModelStore.getState().syncLowerConnections(currentDiagramId)
    }
  }, [currentDiagramId])

  // Sync data to engine — filter to current diagram only. Delegates to
  // syncEngineFromStore (shared with the engine-creation effect above) so a
  // store update that arrives after the engine already exists re-applies the
  // exact same filter+merge+fit logic instead of a second, drift-prone copy.
  //  is read imperatively inside syncEngineFromStore, so it
  // has to be SUBSCRIBED here or expanding a shape would change nothing until
  // the next unrelated store write happened to re-run this.
  const inlineExpansions = useUIStore((s) => s.inlineExpansions)

  /**
   * The shapes of the diagrams currently expanded in place.
   *
   * They CANNOT come from the store or the diagram index: both are windowed to
   * the active diagram, so another diagram's shapes are simply not in memory
   * (every id would resolve to `undefined` and the planner would report the
   * expansion as empty). They come through the
   * ModelQuery seam instead, which reads the whole model on every backend.
   *
   * The same holds for each target's PLACEMENT, read from its own DiagramDoc
   * (`loadDiagramLayouts`); `null` there means it could not be read.
   *
   * Held in a ref as well as state: `syncEngineFromStore` reads it imperatively,
   * and the state copy is only there to re-run the sync once a load lands.
   */
  const expandedContentsRef = useRef<{
    objects: Map<string, C4Object>
    connections: Map<string, Connection>
    layouts: Map<string, NonNullable<Diagram['layouts']> | null>
  }>({ objects: new Map(), connections: new Map(), layouts: new Map() })
  const [expandedContentsVersion, setExpandedContentsVersion] = useState(0)

  useEffect(() => {
    const targets = [...new Set(Object.values(inlineExpansions))]
    const controller = new AbortController()
    void (async () => {
      const query = getModelQuery()
      // Rebuilt from scratch every time, so collapsing drops the contents
      // without a second code path that could forget to.
      const objects = new Map<string, C4Object>()
      const connections = new Map<string, Connection>()
      const layouts = new Map<string, NonNullable<Diagram['layouts']> | null>()
      for (const diagramId of targets) {
        const diagram = getDiagramIndex().diagramById.get(diagramId)
        if (!diagram) continue
        // Started first: the document read is the slow leg, and it does not
        // depend on the objects. A failed read is "unknown", never "pending".
        const placement = loadDiagramLayouts(diagramId).catch((error: unknown) => {
          console.warn(`inline expansion: placement of ${diagramId} unreadable`, error)
          return null
        })
        // One target failing must not hold back the others: a throw here used
        // to abandon the whole run, leaving every NEW expansion waiting forever.
        try {
          const resolved = await query.lookupMany(diagram.objectIds)
          for (const [id, entity] of resolved) {
            // `lookupMany` answers for objects AND groups; only a C4Object carries
            // a scope, which is also the field the expansion filters on.
            if (entity && 'scope' in entity) objects.set(id, entity as C4Object)
          }
          for (const connectionId of diagram.connectionIds) {
            const connection = await query.connection(connectionId)
            if (connection) connections.set(connectionId, connection)
          }
        } catch (error) {
          // Its shapes stay unresolved, so the planner reports it 'empty' and
          // the host stays a shape.
          console.warn(`inline expansion: contents of ${diagramId} unavailable`, error)
        }
        layouts.set(diagramId, await placement)
      }
      if (controller.signal.aborted) return
      expandedContentsRef.current = { objects, connections, layouts }
      setExpandedContentsVersion((version) => version + 1)
    })()
    return () => controller.abort()
  }, [inlineExpansions])

  useEffect(() => {
    syncEngineFromStore()
  }, [objects, connections, groups, diagrams, activeDiagramLayouts, flows, tags, currentDiagramId, inlineExpansions, expandedContentsVersion, setZoom, syncEngineFromStore])

  // The summary-registry boot path keeps only a bounded diagram window in
  // memory. Resolve all visible related-diagram affordances in one server query;
  // the paged query falls back to the local registry when offline.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !currentDiagramId) return
    const controller = new AbortController()
    // The shapes an inline expansion pulled in are on the canvas but not in the
    // store; without them this answer replaced the render path's and took their
    // ⤢ away, so a nested expansion could not even be started.
    const objectIds = [
      ...new Set([
        ...(JSON.parse(canvasObjectIdsKey) as string[]),
        ...expandedContentsRef.current.objects.keys(),
      ]),
    ]
    getModelQuery().relatedDiagramObjectIds(objectIds, { signal: controller.signal })
      .then((relatedObjectIds) => {
        if (
          !controller.signal.aborted
          && engineRef.current === engine
          && useModelStore.getState().currentDiagramId === currentDiagramId
        ) {
          engine.setRelatedDiagramObjectIds(new Set(relatedObjectIds))
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.warn('relatedDiagramObjectIds failed:', error)
      })
    return () => controller.abort()
  }, [canvasObjectIdsKey, currentDiagramId, diagrams, expandedContentsVersion])

  // Sync comments to engine
  useEffect(() => {
    pushComments(comments, currentDiagramId)
  }, [comments, currentDiagramId, pushComments])

  /**
   * Materialise `autoSize: false` into real geometry.
   *
   * The flag alone is INERT: `computeGroupBounds` only honours it when the group
   * also has a stored `position` AND `size`, otherwise it falls through and
   * derives the box from the members anyway. So a group switched to manual in
   * the properties panel would keep following its members — the switch would
   * look like it did nothing.
   *
   * The freeze has to happen here rather than in the panel because the box
   * depends on canvas text measurement (the header band is sized from the title,
   * `measureGroupTitleMinWidth`), which needs a 2D context.
   *
   * Self-healing rather than wired to the switch: "manual with no geometry" is
   * an invalid state whoever produced it, and the canvas owns geometry. It
   * converges — the write makes the state valid, so the effect does not re-fire.
   */
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || isReadonly) return
    const store = useModelStore.getState()
    for (const group of groups) {
      if (group.autoSize !== false) continue
      if (group.position && group.size) continue
      // A parent wrapper ignores the flag by design; a member-less group has no
      // member box to freeze. Both already fall back to stored geometry.
      if (group.parentObjectId || group.objectIds.length === 0) continue
      const drawn = engine.getGroupBounds?.(group)
      if (!drawn) continue
      // The engine's box is in the VIEW frame (displaced by an open expansion).
      const bounds = unshiftBox(viewCutsRef.current, drawn)
      store.updateGroup(group.id, {
        position: { x: bounds.x, y: bounds.y },
        size: { width: bounds.width, height: bounds.height },
      })
    }
  }, [groups, isReadonly])

  // Re-fit on demand (e.g. after the Auto-layout button re-optimizes the diagram).
  useEffect(() => {
    if (fitRequestId === 0) return
    const engine = engineRef.current
    if (!engine) return
    requestAnimationFrame(() => {
      engine.zoomToFit(viewportInsetsRef.current)
      setZoom(engine.getZoom())
    })
  }, [fitRequestId, setZoom])

  // Sync skin to engine
  useEffect(() => {
    engineRef.current?.setSkin(resolvedSkin)
  }, [resolvedSkin])

  useEffect(() => {
    engineRef.current?.setResolvedTheme(appTheme)
  }, [appTheme])

  // Dev hook to exercise the community theme sandbox.
  // Usage from the console: window.__themeSandbox.activate() / .deactivate()
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false
    void import('../../plugins/sandbox/sampleCommunityTheme').then(({ sampleCommunityTheme }) => {
      if (cancelled) return
      ;(window as unknown as Record<string, unknown>).__themeSandbox = {
        activate: () => engineRef.current?.activateCommunityTheme(sampleCommunityTheme),
        deactivate: () => engineRef.current?.deactivateCommunityTheme(),
        activateCode: (code: string) =>
          engineRef.current?.activateCommunityTheme({
            code,
            meta: { id: 'community:test', name: 'Test', version: '1.0.0', trust: 'community' },
          }),
      }
    })
    return () => { cancelled = true }
  }, [])

  // User-facing theme notices (unsupported browser / community theme failure).
  const [themeNotice, setThemeNotice] = useState<string | null>(null)
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setThemeNoticeHandler((msg) => {
      setThemeNotice(msg)
      window.setTimeout(() => setThemeNotice(null), 6000)
    })
    return () => engine.setThemeNoticeHandler(null)
  }, [])

  // Sync selection to engine
  useEffect(() => {
    engineRef.current?.setSelectedItems(selectedItems)
  }, [selectedItems])

  // Sync open comment to engine
  useEffect(() => {
    engineRef.current?.setOpenCommentId(openCommentId)
  }, [openCommentId])

  // Position the open comment's detail box. The canvas is only recentred when
  // the pin is OFF-SCREEN (e.g. the comment was opened from the comments panel);
  // clicking a pin that's already visible must NOT move the canvas. The box is
  // positioned after any pan so it lands against the pin on the first open.
  useEffect(() => {
    const engine = engineRef.current
    if (!openCommentId || !engine) {
      setCommentBoxPos(null)
      return
    }
    const comment = diagramComments.find((c) => c.id === openCommentId)
    if (!comment) {
      setCommentBoxPos(null)
      return
    }
    const vw = canvasRef.current?.clientWidth ?? 0
    const vh = canvasRef.current?.clientHeight ?? 0
    // Where the pin is DRAWN, which an open expansion may have displaced.
    const pin = engine.getCommentPosition(comment.id) ?? comment.position
    let screen = engine.worldToScreen(pin.x, pin.y)
    const margin = 48
    const onScreen =
      screen.x >= margin && screen.x <= vw - margin && screen.y >= margin && screen.y <= vh - margin
    if (!onScreen) {
      engine.panToWorld(pin.x, pin.y)
      screen = engine.worldToScreen(pin.x, pin.y)
    }
    // Keep the box on-canvas (it's 340px wide) so it stays reachable near edges.
    const boxW = 340
    const x = Math.max(8, Math.min(screen.x + 16, vw - boxW - 8))
    const y = Math.max(8, screen.y + 16)
    setCommentBoxPos({ x, y })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCommentId])

  // Sync grid to engine
  useEffect(() => {
    engineRef.current?.setShowGrid(showGrid)
  }, [showGrid])

  // Sync zoom from store to engine. A store subscription, not a `zoom` selector:
  // the engine reports its zoom on every wheel tick, and re-rendering this whole
  // view for each one doubled the non-paint main-thread cost of a wheel zoom in
  // a production build (60 real wheel ticks, CDP ScriptDuration minus engine
  // paint: 48–55 → 25–27 ms).
  // Only <ZoomPercent /> re-renders now.
  useEffect(() => {
    const push = (zoom: number) => {
      const engine = engineRef.current
      if (engine && Math.abs(engine.getZoom() - zoom) > 0.001) engine.setZoom(zoom)
    }
    push(useUIStore.getState().zoom)
    return useUIStore.subscribe((state, previous) => {
      if (state.zoom !== previous.zoom) push(state.zoom)
    })
  }, [])

  // Sync tool mode
  useEffect(() => {
    engineRef.current?.setToolMode(toolMode)
  }, [toolMode])

  // Sync bottom tab overlay
  useEffect(() => {
    engineRef.current?.setBottomTab(bottomTab)
  }, [bottomTab])

  useEffect(() => {
    engineRef.current?.setActiveTagGroup(activeTagGroupId)
  }, [activeTagGroupId])

  // Sync tag interactions
  useEffect(() => {
    engineRef.current?.setTagInteractions(hoveredTagId, pinnedTagIds, focusedTagId, hiddenTagIds)
  }, [hoveredTagId, pinnedTagIds, focusedTagId, hiddenTagIds])

  useEffect(() => {
    engineRef.current?.setManagedPerspectiveInteractions(
      'technology',
      technologyPerspective.hoveredId,
      technologyPerspective.pinnedIds,
      technologyPerspective.focusedId,
      technologyPerspective.hiddenIds,
    )
  }, [technologyPerspective])

  useEffect(() => {
    engineRef.current?.setManagedPerspectiveInteractions(
      'status',
      statusPerspective.hoveredId,
      statusPerspective.pinnedIds,
      statusPerspective.focusedId,
      statusPerspective.hiddenIds,
    )
  }, [statusPerspective])

  useEffect(() => {
    engineRef.current?.setManagedPerspectiveInteractions(
      'teams',
      teamsPerspective.hoveredId,
      teamsPerspective.pinnedIds,
      teamsPerspective.focusedId,
      teamsPerspective.hiddenIds,
    )
  }, [teamsPerspective])

  // Sync connection highlight style
  useEffect(() => {
    engineRef.current?.setConnectionHighlightStyle(connectionHighlightStyle)
  }, [connectionHighlightStyle, currentDiagramId])

  // Sync connection animations enabled
  useEffect(() => {
    engineRef.current?.setConnectionAnimationsEnabled(connectionAnimationsEnabled)
  }, [connectionAnimationsEnabled, currentDiagramId])

  // Sync readonly mode from the current diagram setting + workspace access
  useEffect(() => {
    engineRef.current?.setReadonly(isReadonly)
  }, [currentDiagramId, isReadonly])

  // Open the parent diagram and select the object this one details, so the user
  // lands looking at where they just were rather than at an unrelated corner.
  const navigateToParent = useCallback(() => {
    if (!parentNavigation) return
    setCurrentDiagram(parentNavigation.diagramId)
    setZoomedFromObjectId(null)
    setPreviousDiagramId(null)
    selectObjects([parentNavigation.objectId])
  }, [parentNavigation, setCurrentDiagram, setZoomedFromObjectId, setPreviousDiagramId, selectObjects])

  // The wrapper group draws its back glyph only when there is somewhere to go.
  useEffect(() => {
    navigateToParentRef.current = navigateToParent
    engineRef.current?.setCanNavigateUp(Boolean(parentNavigation))
  }, [navigateToParent, parentNavigation])

  // Sync flow state to engine
  useEffect(() => {
    engineRef.current?.setFlowState(currentFlowId, currentFlowStepIndex)
  }, [currentFlowId, currentFlowStepIndex])

  // Sync flow edit mode to engine
  useEffect(() => {
    engineRef.current?.setFlowEditMode(flowEditMode)
  }, [flowEditMode])

  // Focus canvas on flow step during play mode
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !currentFlowId || flowEditMode) return
    const flow = flows.find((f) => f.id === currentFlowId)
    if (flow) {
      engine.focusOnFlowStep(flow, currentFlowStepIndex)
    }
  }, [currentFlowId, currentFlowStepIndex, flowEditMode, flows])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Never steal keys from a field the user is typing in. Without this,
      // Escape inside the inline editor ALSO clears copy mode, closes an open
      // comment and kicks the user out of flow play; and while a flow is
      // playing, the arrow keys preventDefault and advance the flow instead of
      // moving the caret. `CreateShapePalette` guards the same way for the same
      // reason.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      if (e.key === 'Escape') {
        engineRef.current?.setCopyMode(null)
        if (commentMode) toggleCommentMode()
        if (openCommentId) setOpenCommentId(null)
        if (!flowEditMode && currentFlowId) {
          setFlowEditMode(true)
          setFlowStepIndex(0)
        }
      }
      if (currentFlowId && !flowEditMode) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          nextFlowStep()
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          prevFlowStep()
        }
      }
      if (!isReadonly && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        if (currentFlowId) {
          setFlowEditMode(!flowEditMode)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentFlowId, flowEditMode, commentMode, openCommentId, isReadonly, nextFlowStep, prevFlowStep, setFlowEditMode, setFlowStepIndex, toggleCommentMode, setOpenCommentId])

  // Comment mode: click on canvas to place comment
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isReadonly || !commentMode || !canvasRef.current || !engineRef.current) return
    setDraftCommentPos({ x: e.clientX, y: e.clientY })
  }

  // Watch for canvas becoming visible (e.g. when switching back from All Diagrams view)
  // and trigger resize + zoomToFit to ensure correct rendering
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const engine = engineRef.current
            if (!engine) continue
            const parent = canvas.parentElement
            if (parent && parent.clientWidth > 0 && parent.clientHeight > 0) {
              engine.resize(parent.clientWidth, parent.clientHeight)
              engine.zoomToFit(viewportInsetsRef.current)
              setZoom(engine.getZoom())
            }
          }
        }
      },
      { threshold: 0 }
    )

    observer.observe(canvas)
    return () => observer.disconnect()
  }, [setZoom])

  if (bootFailed) {
    return (
      <div
        data-testid="canvas-boot-error"
        role="alert"
        className="w-full h-full bg-surface-50 flex items-center justify-center px-6"
      >
        <div className="flex w-full max-w-[420px] flex-col items-center rounded-[18px] border border-line bg-surface-100 px-7 py-6 text-center shadow-xl">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-[14px] border border-line-soft bg-surface-50 text-error-text shadow-sm">
            <TriangleAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
            {t('canvasViewChrome.bootFailed.title')}
          </div>
          <div className="mt-1.5 text-[13px] leading-5 text-fg-secondary">
            {t('canvasViewChrome.bootFailed.body')}
          </div>
          {/* The bridge's message already names the document that failed. It is
              the only thing a user can quote and an operator can grep for, so
              it is shown verbatim rather than folded into generic prose. */}
          {bridgeError && (
            <div
              data-testid="canvas-boot-error-detail"
              className="mt-3 w-full break-all rounded-[10px] border border-line-soft bg-surface-50 px-3 py-2 text-left font-mono text-[11px] leading-4 text-fg-subtle"
            >
              {bridgeError}
            </div>
          )}
          <button
            type="button"
            data-testid="canvas-boot-error-retry"
            onClick={() => { void reloadWorkspace() }}
            className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-[10px] bg-accent px-4 text-[13px] font-semibold text-accent-text shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-100"
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            {t('canvasViewChrome.bootFailed.action')}
          </button>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="w-full h-full bg-surface-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-line border-t-accent rounded-full animate-spin" />
          <span className="text-[13px] text-fg-subtle">{t('common.loading')}</span>
        </div>
      </div>
    )
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    // dataTransfer + pointer coords are only valid during the synchronous event, so
    // read everything we need BEFORE any await below (off-window hydration).
    const data = e.dataTransfer.getData('application/json')
    if (!data) return
    try {
      const item = JSON.parse(data) as { type: 'existing' | 'new'; id?: string; c4Type?: C4Type | 'group' }
      const canvas = canvasRef.current
      const engine = engineRef.current
      if (!canvas || !engine) return

      const rect = canvas.getBoundingClientRect()
      const offsetX = e.clientX - rect.left
      const offsetY = e.clientY - rect.top
      // Model frame: with an expansion open the canvas is displaced past a cut.
      const worldPos = toModel(engine.screenToWorld(offsetX, offsetY))

      const diagram = useModelStore.getState().getCurrentDiagram()
      if (!diagram || isReadonly) return

      if (item.type === 'existing' && item.id) {
        const store = useModelStore.getState()
        let obj = store.objects.find((o) => o.id === item.id)
        const grp = store.groups.find((g) => g.id === item.id)
        // Boot-from-server windows the store, so an existing MODEL object dragged from
        // the left panel may not be resident — moveObject/addObjectToDiagram would then
        // silently no-op (the drop does nothing). Hydrate it from the seam first.
        if (!obj && !grp) {
          const fetched = await getModelQuery().object(item.id)
          if (fetched) {
            seedObjectForEdit(fetched)
            obj = useModelStore.getState().objects.find((o) => o.id === item.id)
          }
        }
        if (obj) {
          store.moveObject(item.id, {
            x: worldPos.x - obj.size.width / 2,
            y: worldPos.y - obj.size.height / 2,
          })
          if (!diagram.objectIds.includes(item.id)) {
            store.addObjectToDiagram(item.id)
          }
          store.selectObjects([item.id])
        } else if (grp) {
          const gw = grp.size?.width ?? 200
          const gh = grp.size?.height ?? 150
          // Pass BOTH position and size so the per-diagram layout is complete — a position-only
          // layout leaves size undefined, and an empty group (members on another diagram) then has
          // no computable box and vanishes.
          store.updateGroup(item.id, {
            position: { x: worldPos.x - gw / 2, y: worldPos.y - gh / 2 },
            size: grp.size ?? { width: gw, height: gh },
          })
          if (!diagram.groupIds.includes(item.id)) {
            store.addGroupToDiagram(item.id)
          }
          store.selectGroup(item.id)
        }
      } else if (item.type === 'new' && item.c4Type) {
        if (item.c4Type === 'group') {
          const id = useModelStore.getState().addGroup({
            name: 'New group',
            color: '#E0DBD2',
            objectIds: [],
            position: { x: worldPos.x - 100, y: worldPos.y - 75 },
            size: { width: 200, height: 150 },
          })
          useModelStore.getState().addGroupToDiagram(id)
          useModelStore.getState().selectGroup(id)
        } else {
          const id = useModelStore.getState().addObject({
            type: item.c4Type,
            name: `New ${item.c4Type}`,
            description: '',
            position: { x: worldPos.x - 80, y: worldPos.y - 50 },
            size: { width: 160, height: 100 },
            tagAssignments: {},
            tagOrder: [],
            links: [],
            scope: 'internal',
            status: 'draft',
            properties: {},
          })
          useModelStore.getState().selectObjects([id])
        }
      }
    } catch (err) {
      console.error('Drop error:', err)
    }
  }

  // What the inline editor is sitting on, or null when there is nothing it
  // could durably write to. The rule lives in `resolveInlineEditSubject`, which
  // is where the scope difference between the three lookups is explained and
  // tested; `objectById` is the model-wide index, so the wrapper lookup is O(1).
  const inlineEditSubject: InlineEditSubject | null = textEdit
    ? resolveInlineEditSubject(textEdit, {
        diagramObject: (id) => objects.find((o) => o.id === id),
        diagramGroup: (id) => groups.find((g) => g.id === id),
        modelObject: (id) => getDiagramIndex().objectById.get(id),
      })
    : null

  return (
    <div
      className="w-full h-full relative overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPointerMove={handlePresencePointerMove}
      onPointerLeave={() => publishDiagramCursor(null)}
    >
      <canvas
        ref={canvasRef}
        data-testid="canvas-2d"
        className={cn('block w-full h-full', covered3d && 'invisible')}
        style={{ touchAction: 'none', cursor: commentMode ? 'crosshair' : undefined }}
        onClick={(e) => {
          setContextMenu(null)
          if (commentMode) {
            handleCanvasClick(e)
          }
        }}
      />

      {/* The WebGL 3D board — overlays the (kept-alive) 2D canvas, which stays
          visible beneath the enter/exit crossfade morph and hides only while
          fully covered. The overlay outlives the mode flip to play its exit. */}
      {mounted3d && !isLoading && (
        <Canvas3DView
          readonly={isReadonly}
          active={canvasViewMode === '3d'}
          onCoveredChange={setCovered3d}
          onExited={() => {
            setMounted3d(false)
            setCovered3d(false)
          }}
          get2dViewport={() => engineRef.current?.getViewport() ?? null}
          set2dViewport={(v) => engineRef.current?.setViewport(v)}
          sharedSceneRef={scene3dRef}
        />
      )}

      <RemoteCursorOverlay project={projectPresenceCursor} />

      {themeNotice && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-3 py-2 rounded-md bg-warning text-on-inverse text-[13px] shadow-lg max-w-[90%] text-center">
          {themeNotice}
        </div>
      )}

      {/* Non-existent diagram (deleted, or a link from an older/reseeded workspace) — show a clear
          message instead of a silent blank canvas. */}
      {diagramNotFound && (
        <div
          data-testid="diagram-not-found"
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-surface-50/85 backdrop-blur-sm px-6 text-center"
        >
          <div className="text-[15px] font-semibold text-fg">{t('canvasViewChrome.diagramNotFound.title')}</div>
          <div className="text-[13px] text-fg-secondary max-w-sm">
            {t('canvasViewChrome.diagramNotFound.body')}
          </div>
          <button
            data-testid="diagram-not-found-go"
            onClick={() => {
              const first = diagrams.find((d) => d.objectIds.length > 0) ?? diagrams[0]
              if (first) setCurrentDiagram(first.id)
            }}
            className="mt-1 px-3 py-1.5 text-[13px] font-medium bg-accent text-accent-text rounded-md hover:bg-accent-hover transition-colors"
          >
            {t('canvasViewChrome.diagramNotFound.action')}
          </button>
        </div>
      )}

      {/* Workspace with ZERO diagrams (a new/foreign empty landscape or version) — the bare
          canvas LOOKS editable but every drop is unbound and would silently no-op. Offer the
          only meaningful action instead. New-landscape/new-version flows seed a starter
          diagram themselves (workspaceStore); this is the safety net for every other path.
          Unlike a modal, this stays below the editor chrome so workspace navigation remains
          usable even when diagram creation is temporarily unavailable. */}
      {!isLoading && !diagramNotFound && diagrams.length === 0 && (
        <CanvasEmptyState
          title={t('canvasViewChrome.noDiagrams.title')}
          body={t('canvasViewChrome.noDiagrams.body')}
          action={t('canvasViewChrome.noDiagrams.action')}
          onCreate={() => {
            const id = addDiagram({
              name: 'New context diagram',
              type: 'context',
              objectIds: [],
              connectionIds: [],
              groupIds: [],
            })
            setCurrentDiagram(id)
          }}
        />
      )}

      {/* Comment overlays */}
      {commentMode && (
        <div className="absolute inset-0 z-10 pointer-events-none">
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-inverse text-on-inverse rounded-full text-[11px] font-medium shadow-lg">
            {t('canvasViewChrome.comment.placeHint')}
          </div>
        </div>
      )}

      {/* Comment detail overlay (only when a comment is open and positioned) */}
      {openCommentId && commentBoxPos && (() => {
        const comment = diagramComments.find((c) => c.id === openCommentId)
        if (!comment) return null
        return (
          <CommentDetail
            key={comment.id}
            comment={comment}
            readonly={isReadonly}
            screenX={commentBoxPos.x}
            screenY={commentBoxPos.y}
            onMove={(x, y) => setCommentBoxPos({ x, y })}
            onClose={() => setOpenCommentId(null)}
          />
        )
      })()}

      {draftCommentPos && !isReadonly && (
        <CommentComposer
          x={draftCommentPos.x}
          y={draftCommentPos.y}
          onSubmit={(type, text) => {
            if (currentDiagramId && engineRef.current) {
              const worldPos = toModel(engineRef.current.screenToWorld(draftCommentPos.x, draftCommentPos.y))
              addComment({
                diagramId: currentDiagramId,
                type,
                text,
                position: worldPos,
                author: 'You',
                resolved: false,
                pinned: false,
                replies: [],
              })
            }
            setDraftCommentPos(null)
            if (commentMode) toggleCommentMode()
          }}
          onCancel={() => {
            setDraftCommentPos(null)
            if (commentMode) toggleCommentMode()
          }}
        />
      )}

      {expandMenu && (
        <ExpandMenu
          object={expandMenu.object}
          x={expandMenu.x}
          y={expandMenu.y}
          onClose={() => setExpandMenu(null)}
        />
      )}

      {contextMenu && !isReadonly && contextMenu.objectId
        && usesMultiSelectMenu(contextMenu.objectId, contextMenu.selectedItems) && (
        <MultiSelectContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedItems={contextMenu.selectedItems}
          currentDiagramId={currentDiagramId}
          onClose={() => setContextMenu(null)}
          onRemoveFromDiagram={() => {
            const objectIds = contextMenu.selectedItems.filter((s) => s.type === 'object').map((s) => s.id)
            removeObjectsFromDiagram(objectIds)
          }}
          onDeleteFromModel={() => deleteSelectedItems()}
          onCopySize={() => {
            // Engine, not `objects` — see the single-shape menu below.
            const bounds = engineRef.current?.getObjectSizeById(contextMenu.objectId!)
            if (bounds) {
              engineRef.current?.setCopyMode('size', { width: bounds.width, height: bounds.height })
            }
            setContextMenu(null)
          }}
          onCopyStyle={() => {
            const obj = objects.find((o) => o.id === contextMenu.objectId!)
            if (obj) {
              engineRef.current?.setCopyMode('style', captureObjectStyle(obj))
            }
            setContextMenu(null)
          }}
        />
      )}

      {/* The exact complement of the gate above, so the two can never both
        * render and never both stay hidden. A right-click on a shape OUTSIDE the
        * selection lands here — the single-shape menu, acting on the shape the
        * user actually pointed at. */}
      {contextMenu && !isReadonly && contextMenu.objectId
        && !usesMultiSelectMenu(contextMenu.objectId, contextMenu.selectedItems) && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          objectId={contextMenu.objectId}
          groups={allGroups}
          currentDiagramId={currentDiagramId}
          onClose={() => setContextMenu(null)}
          onAddToGroup={(groupId) => addObjectToGroup(contextMenu.objectId!, groupId)}
          onRemoveFromGroup={(groupId) => removeObjectFromGroup(contextMenu.objectId!, groupId)}
          onRemoveFromDiagram={() => removeObjectFromDiagram(contextMenu.objectId!)}
          onDeleteFromModel={() => deleteObject(contextMenu.objectId!)}
          onCopySize={() => {
            // `objects` is the STORE's list, whose `size` is the create-time
            // value: a resize on this diagram goes to `diagram.layouts[id]` and
            // never back to the object, so reading it would copy the create-time
            // size, not the one on screen. Same rule as the group menu below.
            const bounds = engineRef.current?.getObjectSizeById(contextMenu.objectId!)
            if (bounds) {
              engineRef.current?.setCopyMode('size', { width: bounds.width, height: bounds.height })
            }
            setContextMenu(null)
          }}
          onCopyStyle={() => {
            const obj = objects.find((o) => o.id === contextMenu.objectId!)
            if (obj) {
              engineRef.current?.setCopyMode('style', captureObjectStyle(obj))
            }
            setContextMenu(null)
          }}
        />
      )}

      {contextMenu && !isReadonly && contextMenu.groupId && !contextMenu.objectId && (
        <GroupContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          groupId={contextMenu.groupId}
          currentDiagramId={currentDiagramId}
          onClose={() => setContextMenu(null)}
          onRemoveFromDiagram={() => removeGroupFromDiagram(contextMenu.groupId!)}
          onDeleteFromModel={() => deleteGroup(contextMenu.groupId!)}
          onCopySize={() => {
            // Always the ENGINE's bounds: `groups` here is the store's list,
            // whose `size` is the create-time value, while the diagram's layout
            // override is merged in only on the way to the engine. Reading
            // `group.size` would copy a size the user is not looking at.
            const bounds = engineRef.current?.getGroupBoundsById(contextMenu.groupId!)
            if (bounds) {
              engineRef.current?.setCopyMode('size', { width: bounds.width, height: bounds.height })
            }
            setContextMenu(null)
          }}
          onCopyStyle={() => {
            const group = groups.find((g) => g.id === contextMenu.groupId!)
            const style = group ? captureGroupStyle(group) : null
            if (style) {
              engineRef.current?.setCopyMode('style', style)
            }
            setContextMenu(null)
          }}
        />
      )}

      {contextMenu && !isReadonly && contextMenu.connectionId && (
        <ConnectionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          connectionId={contextMenu.connectionId}
          currentDiagramId={currentDiagramId}
          onClose={() => setContextMenu(null)}
          onRemoveFromDiagram={() => removeConnectionFromDiagram(contextMenu.connectionId!)}
          onDeleteFromModel={() => deleteConnection(contextMenu.connectionId!)}
        />
      )}

      {/* Inline title/description editor. Keyed so switching runs or shapes
          remounts with a fresh draft rather than carrying the previous one. */}
      {textEdit && inlineEditSubject && !isReadonly && (
        <InlineTextEditor
          key={`${textEdit.kind}:${textEdit.id}:${textEdit.band}`}
          subject={inlineEditSubject}
          band={textEdit.band}
          engineRef={engineRef}
          onCommit={(write) => {
            const store = useModelStore.getState()
            if (write.target === 'object') store.updateObject(write.id, write.update)
            else store.updateGroup(write.id, write.update)
          }}
          onClose={() => setTextEdit(null)}
        />
      )}

      {inlineEdit && !isReadonly && (
        <textarea
          autoFocus
          value={connections.find((c) => c.id === inlineEdit.connectionId)?.label || ''}
          onChange={(e) => updateConnection(inlineEdit.connectionId, { label: e.target.value })}
          onBlur={() => setInlineEdit(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setInlineEdit(null)
            }
          }}
          style={{
            position: 'absolute',
            left: inlineEdit.x,
            top: inlineEdit.y,
            width: Math.max(inlineEdit.width, 80),
            height: Math.max(inlineEdit.height, 22),
            fontSize: `${Math.max(10 * inlineEdit.scale, 11)}px`,
            lineHeight: `${12 * inlineEdit.scale}px`,
          }}
          className="z-20 bg-surface-100 border border-line rounded px-2 py-1 text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent shadow-sm resize-none overflow-hidden"
        />
      )}

      {/* Zoom controls — floating at the bottom-right of the canvas (the convention
       * for canvas tools). Sized to match the bottom-left legend card (same height,
       * radius, shadow, and bottom offset) so the two floating cards read as a pair.
       * Offsets to clear the right sidebar when it's open. */}
      {/* z-30: above the 3D overlay AND the app BottomBar — at moderate widths
          the BottomBar pill can reach under this cluster and swallow its clicks
          (the grid toggle was unreachable). */}
      <div
        className={cn(
          'absolute bottom-3.5 z-30 flex items-center gap-0.5 rounded-[12px] border border-line bg-surface-100/95 backdrop-blur-sm p-1 shadow-lg select-none',
          rightSidebarOpen ? 'right-[338px]' : 'right-3'
        )}
      >
        <button
          data-testid="canvas-zoom-out"
          onClick={handleZoomOut}
          title={t('canvasViewChrome.zoom.zoomOut')}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-50"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          data-testid="canvas-zoom-fit"
          onClick={handleFitCanvas}
          title={t('canvasViewChrome.zoom.zoomToFit')}
          className="flex h-9 min-w-[46px] items-center justify-center rounded-lg px-1.5 text-[11px] font-medium tabular-nums text-fg-secondary hover:bg-surface-50"
        >
          {canvasViewMode === '3d' ? '3D' : <ZoomPercent />}
        </button>
        <button
          data-testid="canvas-zoom-in"
          onClick={handleZoomIn}
          title={t('canvasViewChrome.zoom.zoomIn')}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-50"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <div className="mx-0.5 h-5 w-px bg-line" />
        {/* Toggle the background dot grid — visual only (snapping uses gridSize and
            stays active). Dimmed when the grid is hidden. */}
        <button
          data-testid="toggle-grid"
          onClick={toggleGrid}
          title={showGrid ? t('canvasViewChrome.zoom.hideGrid') : t('canvasViewChrome.zoom.showGrid')}
          aria-pressed={!showGrid}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg hover:bg-surface-50',
            showGrid ? 'text-fg-secondary' : 'text-fg-subtle'
          )}
        >
          <Grid2x2 className="h-4 w-4" />
        </button>
        <button
          data-testid="canvas-fit-screen"
          onClick={handleFitCanvas}
          title={t('canvasViewChrome.zoom.fitToScreen')}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-50"
        >
          <Maximize className="h-4 w-4" />
        </button>
      </div>

      {/* Tool mode indicator */}
      {toolMode !== 'select' && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-inverse text-on-inverse rounded-full text-[11px] font-medium shadow-lg pointer-events-none">
          {toolMode === 'connection' ? t('canvasViewChrome.toolMode.connection') : t('canvasViewChrome.toolMode.pan')}
        </div>
      )}

      {/* Canvas toolbar */}
      {!isReadonly && (
        <CanvasToolbar leftSidebarOpen={leftSidebarOpen} />
      )}
    </div>
  )
}

/**
 * Keeps a context menu inside the viewport. The menu is measured after mount
 * and its position is nudged so it never overflows the right/bottom (or top/left)
 * edges of the window. Returns a ref to attach to the menu element and the
 * clamped left/top to apply.
 */
function useClampedMenuPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + width > vw - margin) left = Math.max(margin, vw - width - margin)
    if (top + height > vh - margin) top = Math.max(margin, vh - height - margin)
    setPos({ left, top })
  }, [x, y])

  return { ref, pos }
}

export function ConnectionContextMenu({
  x,
  y,
  connectionId,
  currentDiagramId,
  onClose,
  onRemoveFromDiagram,
  onDeleteFromModel,
}: {
  x: number
  y: number
  connectionId: string
  currentDiagramId: string | null
  onClose: () => void
  onRemoveFromDiagram: () => void
  onDeleteFromModel: () => void
}) {
  const { t } = useTranslation()
  const connections = useModelStore((s) => s.connections)
  const updateConnection = useModelStore((s) => s.updateConnection)
  const isConnectionOnlyInDiagram = useModelStore((s) => s.isConnectionOnlyInDiagram)
  const conn = connections.find((c) => c.id === connectionId)
  const { ref, pos } = useClampedMenuPosition(x, y)

  if (!conn) return null

  const isLocked = conn.lockedToAnchors
  const canDeleteFromModel = currentDiagramId ? isConnectionOnlyInDiagram(connectionId, currentDiagramId) : false

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide border-b border-line">
        {t('canvasViewChrome.contextMenu.connectionHeader')}
      </div>
      <button
        onClick={() => {
          updateConnection(connectionId, { lockedToAnchors: !isLocked })
          onClose()
        }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
      >
        {isLocked ? t('canvasViewChrome.contextMenu.unlockFromAnchors') : t('canvasViewChrome.contextMenu.lockToAnchors')}
      </button>
      <DeleteCommandRows
        scope="connection"
        canDeleteFromModel={canDeleteFromModel}
        onRemoveFromDiagram={onRemoveFromDiagram}
        onDeleteFromModel={onDeleteFromModel}
        onClose={onClose}
      />
    </div>
  )
}

export function CanvasContextMenu({
  x,
  y,
  objectId,
  groups,
  currentDiagramId,
  onClose,
  onAddToGroup,
  onRemoveFromGroup,
  onRemoveFromDiagram,
  onDeleteFromModel,
  onCopySize,
  onCopyStyle,
}: {
  x: number
  y: number
  objectId: string
  groups: Group[]
  currentDiagramId: string | null
  onClose: () => void
  onAddToGroup: (groupId: string) => void
  onRemoveFromGroup: (groupId: string) => void
  onRemoveFromDiagram: () => void
  onDeleteFromModel: () => void
  onCopySize: () => void
  onCopyStyle: () => void
}) {
  const { t } = useTranslation()
  const objects = useModelStore((s) => s.objects)
  const isObjectOnlyInDiagram = useModelStore((s) => s.isObjectOnlyInDiagram)
  const obj = objects.find((o) => o.id === objectId)
  const { ref, pos } = useClampedMenuPosition(x, y)

  if (!obj) return null

  const canDeleteFromModel = currentDiagramId ? isObjectOnlyInDiagram(objectId, currentDiagramId) : false
  const memberGroupIds = groups.filter((g) => g.objectIds.includes(objectId)).map((g) => g.id)
  const nonMemberGroups = groups.filter((g) => !g.objectIds.includes(objectId))

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{
        left: pos.left,
        top: pos.top,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => {
          onCopySize()
          onClose()
        }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="4" width="6" height="5" rx="0.5" />
          <path d="M3 4V2.5C3 1.94772 3.44772 1.5 4 1.5H9C9.55228 1.5 10 1.94772 10 2.5V7.5C10 8.05228 9.55228 8.5 9 8.5H7.5" />
        </svg>
        {t('canvasViewChrome.contextMenu.copySize')}
      </button>
      <button
        onClick={() => {
          onCopyStyle()
          onClose()
        }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 9.5C2 9.5 3.5 8.5 4.5 6.5C5.5 4.5 6 2 6 2C6 2 6.5 4.5 7.5 6.5C8.5 8.5 10 9.5 10 9.5" />
          <circle cx="6" cy="1.5" r="1" fill="currentColor" stroke="none" />
        </svg>
        {t('canvasViewChrome.contextMenu.copyStyle')}
      </button>
      <div className="my-1 border-t border-line" />
      <div className="px-3 py-1.5 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide border-b border-line">
        {t('canvasViewChrome.contextMenu.groups')}
      </div>
      {memberGroupIds.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] text-fg-subtle">{t('canvasViewChrome.contextMenu.removeFrom')}</div>
          {groups
            .filter((g) => memberGroupIds.includes(g.id))
            .map((g) => (
              <button
                key={g.id}
                onClick={() => {
                  onRemoveFromGroup(g.id)
                  onClose()
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-error hover:bg-error-bg"
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: g.color || 'var(--color-surface-400)' }}
                />
                {g.name}
              </button>
            ))}
        </>
      )}
      {nonMemberGroups.length > 0 && (
        <>
          <div className="px-3 py-1 text-[10px] text-fg-subtle">{t('canvasViewChrome.contextMenu.addTo')}</div>
          {nonMemberGroups.map((g) => (
            <button
              key={g.id}
              onClick={() => {
                onAddToGroup(g.id)
                onClose()
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: g.color || 'var(--color-surface-400)' }}
              />
              {g.name}
            </button>
          ))}
        </>
      )}
      {groups.length === 0 && (
        <div className="px-3 py-2 text-[12px] text-fg-subtle">{t('canvasViewChrome.contextMenu.noGroupsAvailable')}</div>
      )}
      {/* Delete goes LAST here, not next to Copy: placed there it would sit
          directly above the "remove from <group>" rows, which carry the same
          error colour — one row's overshoot from an irreversible model delete
          to a harmless un-grouping. */}
      <div className="my-1 border-t border-line" />
      <DeleteCommandRows
        scope="object"
        canDeleteFromModel={canDeleteFromModel}
        onRemoveFromDiagram={onRemoveFromDiagram}
        onDeleteFromModel={onDeleteFromModel}
        onClose={onClose}
      />
    </div>
  )
}

export function GroupContextMenu({
  x,
  y,
  groupId,
  currentDiagramId,
  onClose,
  onRemoveFromDiagram,
  onDeleteFromModel,
  onCopySize,
  onCopyStyle,
}: {
  x: number
  y: number
  groupId: string
  currentDiagramId: string | null
  onClose: () => void
  onRemoveFromDiagram: () => void
  onDeleteFromModel: () => void
  onCopySize: () => void
  onCopyStyle: () => void
}) {
  const { t } = useTranslation()
  const groups = useModelStore((s) => s.groups)
  const isGroupOnlyInDiagram = useModelStore((s) => s.isGroupOnlyInDiagram)
  const group = groups.find((g) => g.id === groupId)
  const { ref, pos } = useClampedMenuPosition(x, y)

  if (!group) return null

  const canDeleteFromModel = currentDiagramId ? isGroupOnlyInDiagram(groupId, currentDiagramId) : false

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide border-b border-line">
        {group.name}
      </div>
      <button
        onClick={() => {
          onCopySize()
          onClose()
        }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="4" width="6" height="5" rx="0.5" />
          <path d="M3 4V2.5C3 1.94772 3.44772 1.5 4 1.5H9C9.55228 1.5 10 1.94772 10 2.5V7.5C10 8.05228 9.55228 8.5 9 8.5H7.5" />
        </svg>
        {t('canvasViewChrome.contextMenu.copySize')}
      </button>
      {/* A parent wrapper draws with engine-owned colours (`parentWrapperFill`,
          `navColor`, alpha 1, border 0), so it has no style to hand over and
          none it could display. Offering the command would only produce a paste
          that paints nothing. Same rule as the auto-size switch. */}
      {!isParentWrapper(group) && (
        <button
          data-testid="ctx-group-copy-style"
          onClick={() => {
            onCopyStyle()
            onClose()
          }}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 9.5C2 9.5 3.5 8.5 4.5 6.5C5.5 4.5 6 2 6 2C6 2 6.5 4.5 7.5 6.5C8.5 8.5 10 9.5 10 9.5" />
            <circle cx="6" cy="1.5" r="1" fill="currentColor" stroke="none" />
          </svg>
          {t('canvasViewChrome.contextMenu.copyStyle')}
        </button>
      )}
      <div className="my-1 border-t border-line" />
      <DeleteCommandRows
        scope="group"
        canDeleteFromModel={canDeleteFromModel}
        onRemoveFromDiagram={onRemoveFromDiagram}
        onDeleteFromModel={onDeleteFromModel}
        onClose={onClose}
      />
    </div>
  )
}


export function MultiSelectContextMenu({
  x,
  y,
  selectedItems,
  currentDiagramId,
  onClose,
  onRemoveFromDiagram,
  onDeleteFromModel,
  onCopySize,
  onCopyStyle,
}: {
  x: number
  y: number
  selectedItems: SelectedItem[]
  currentDiagramId: string | null
  onClose: () => void
  onRemoveFromDiagram: () => void
  onDeleteFromModel: () => void
  onCopySize: () => void
  onCopyStyle: () => void
}) {
  const { t } = useTranslation()
  const objectCount = selectedItems.filter((s) => s.type === 'object').length
  const isObjectOnlyInDiagram = useModelStore((s) => s.isObjectOnlyInDiagram)
  const { ref, pos } = useClampedMenuPosition(x, y)

  const selectedObjectIds = selectedItems.filter((s) => s.type === 'object').map((s) => s.id)
  const canDeleteFromModel = currentDiagramId
    ? selectedObjectIds.length > 0 && selectedObjectIds.every((id) => isObjectOnlyInDiagram(id, currentDiagramId))
    : false

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-surface-100 border border-line rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1.5 text-[11px] font-semibold text-fg-subtle uppercase tracking-wide border-b border-line">
        {t('canvasViewChrome.contextMenu.shapesSelected', { count: objectCount })}
      </div>
      {/* Copy FROM the shape the menu is anchored on — the one right-clicked —
          then click any shape in the selection to apply to all of it. This is
          the "make these all look like this one" direction; the other
          direction (source outside the selection) already works through the
          single-shape menu. */}
      <button
        data-testid="ctx-multi-copy-size"
        onClick={() => { onCopySize(); onClose() }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="4" width="6" height="5" rx="0.5" />
          <path d="M3 4V2.5C3 1.94772 3.44772 1.5 4 1.5H9C9.55228 1.5 10 1.94772 10 2.5V7.5C10 8.05228 9.55228 8.5 9 8.5H7.5" />
        </svg>
        {t('canvasViewChrome.contextMenu.copySize')}
      </button>
      <button
        data-testid="ctx-multi-copy-style"
        onClick={() => { onCopyStyle(); onClose() }}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-surface-50"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 9.5C2 9.5 3.5 8.5 4.5 6.5C5.5 4.5 6 2 6 2C6 2 6.5 4.5 7.5 6.5C8.5 8.5 10 9.5 10 9.5" />
          <circle cx="6" cy="1.5" r="1" fill="currentColor" stroke="none" />
        </svg>
        {t('canvasViewChrome.contextMenu.copyStyle')}
      </button>
      <div className="my-1 border-t border-line" />
      <DeleteCommandRows
        scope="multi"
        canDeleteFromModel={canDeleteFromModel}
        count={objectCount}
        onRemoveFromDiagram={onRemoveFromDiagram}
        onDeleteFromModel={onDeleteFromModel}
        onClose={onClose}
      />
    </div>
  )
}
